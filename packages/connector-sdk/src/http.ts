/**
 * `ctx.http`: the only network access a handler has.
 *
 * Every request, and every redirect hop, is checked against the operation's
 * declared egress before it is sent. Redirects are followed by hand so each
 * hop can be checked, and the credential is dropped when a hop leaves the
 * first request's origin. The connection's credential is added as headers
 * by the host's `CredentialProvider`, so handler code never sees a token.
 * Each call is bounded in time (by the operation's deadline and an optional
 * per-call timeout), in response size, and in count per operation call.
 *
 * Failures are thrown as `ConnectorError`s with outcome semantics already
 * applied: once an unsafe request (POST, PUT, PATCH, DELETE) may have
 * reached the service, a failure of a write operation is `unknown`, because
 * the change may have happened.
 */

import { checkJson, type JsonValue } from "@aaply/action-contract";
import type { Clock } from "./clock.js";
import { EGRESS_METHODS, SAFE_METHODS, checkEgress, hostMatches, type EgressRule, type HostPattern } from "./egress.js";
import { ConnectorError, adoptConnectorError, failedBeforeSending, httpError, rejectedBeforeApplying, type FailureKind } from "./errors.js";
import { safe, type ConnectorLog } from "./log.js";
import { PLATFORM_HEADERS, signatureHeaders, type RequestSigner, type SignableRequest } from "./signing.js";

/** The subset of `fetch` the kit uses. Injectable for tests and for hosts that route through a proxy. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpLimits {
  /** Largest response body read, in bytes. */
  maxResponseBytes: number;
  /** Largest total of response bodies one operation call reads, across every request (pages included), in bytes. Default 16 MiB. */
  maxTotalResponseBytes?: number;
  /** Largest request body sent, in bytes. */
  maxRequestBytes: number;
  /** Redirect hops followed per call. */
  maxRedirects: number;
  /** Calls one operation call may make (bounds pagination loops). */
  maxRequestsPerCall: number;
}

export const DEFAULT_HTTP_LIMITS: Readonly<Required<HttpLimits>> = Object.freeze({
  maxResponseBytes: 5 * 1024 * 1024,
  maxTotalResponseBytes: 16 * 1024 * 1024,
  maxRequestBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  maxRequestsPerCall: 50,
});

export interface HttpRequest {
  /** Default GET. */
  method?: string;
  /** Absolute https URL. */
  url: string;
  /** Appended to the URL's query; `undefined` and `null` values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  /** Sent as JSON with `content-type: application/json`. */
  json?: JsonValue;
  body?: string | Uint8Array;
  /** Per-call timeout; the operation's deadline always applies too. */
  timeoutMs?: number;
  /** Lower the response size cap for this call. */
  maxResponseBytes?: number;
  /** Send the connection's credential (default true). Turn off for pre-signed URLs. */
  auth?: boolean;
}

/** A response whose body has already been read (within the size cap). */
export interface ConnectorResponse {
  readonly status: number;
  /** 2xx. */
  readonly ok: boolean;
  readonly headers: Headers;
  /** The URL that answered, after redirects. */
  readonly url: string;
  readonly redirects: number;
  readonly body: Uint8Array;
  text(): string;
  /** The body as JSON; `null` when empty. Throws a `ConnectorError` when it is not JSON. */
  json(): JsonValue;
  /** Returns the response when 2xx; otherwise throws the `ConnectorError` its status means. */
  ensureOk(): ConnectorResponse;
}

export type ConnectorHttp = (request: HttpRequest) => Promise<ConnectorResponse>;

/** The User-Agent sent unless a handler sets its own. */
export function userAgentFor(connector: { id: string; version: string }): string {
  return `aaply-connector (${connector.id}/${connector.version})`;
}

/** Headers the platform controls; a handler setting one is refused. */
const FORBIDDEN_HEADERS = PLATFORM_HEADERS;
/** Removed when a redirect leaves the first request's origin. */
const ORIGIN_BOUND_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function byteLength(body: string | Uint8Array): number {
  return typeof body === "string" ? encoder.encode(body).length : body.byteLength;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed.
  }
}

async function readCapped(response: Response, max: number): Promise<Uint8Array | "too-large"> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    await discard(response);
    return "too-large";
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface HttpSessionOptions {
  fetch: FetchLike;
  rules: readonly EgressRule[];
  effect: "read" | "write";
  /** The operation call's signal. */
  signal: AbortSignal;
  /** The operation call's deadline, on `clock`. */
  deadline: number;
  clock: Clock;
  /** The connection's credential headers; called lazily, at most as often as requests are made. */
  credentials: () => Promise<Readonly<Record<string, string>>>;
  /**
   * The only hosts the credential is sent to (the connector's `auth.hosts`,
   * resolved). Left out, it goes to the first request's origin only.
   */
  credentialHosts?: readonly HostPattern[];
  /**
   * Fresh credential headers after a 401 (the host's `CredentialProvider.refresh`).
   * Called at most once per operation call; the request that got the 401 is
   * sent once more with them. Left out, a 401 is returned as it is.
   */
  refreshCredentials?: () => Promise<Readonly<Record<string, string>>>;
  /**
   * Signs each credentialed request, last, after its body and credential
   * headers are final (the host's `CredentialProvider.sign`, bound to the
   * call): the headers to add. Each same-origin redirect hop and the resend
   * after a refresh is signed afresh. See `signing.ts`.
   */
  sign?: RequestSigner;
  /** Sent as the `traceparent` header on every request the handler does not set it on (a connector with `propagateTrace`). */
  traceparent?: string;
  limits: HttpLimits;
  userAgent: string;
  log: ConnectorLog;
}

/**
 * Internal: the http client of one operation call, and what it knows about
 * whether that call may already have changed something.
 */
export class HttpSession {
  readonly http: ConnectorHttp;
  private readonly options: HttpSessionOptions;
  private requests = 0;
  /** Response bytes read so far in this call. */
  private received = 0;
  private applied = false;
  private unsafeInFlight = 0;
  private closed = false;
  /** The refreshed credential, once a 401 asked for one (at most once per call). */
  private refreshed: Promise<Readonly<Record<string, string>>> | null = null;

  constructor(options: HttpSessionOptions) {
    this.options = options;
    this.http = (request) => this.request(request);
  }

  /** An unsafe request may have reached the service (and was not plainly refused by it). */
  get mayHaveApplied(): boolean {
    return this.applied || this.unsafeInFlight > 0;
  }

  /** Refuses further calls; the operation call is over. */
  close(): void {
    this.closed = true;
  }

  /** A write's failure is `unknown` once something may have been applied. */
  settle(error: ConnectorError): ConnectorError {
    if (this.options.effect === "write" && this.mayHaveApplied && error.kind !== "unknown") return error.withKind("unknown");
    return error;
  }

  private fail(kind: FailureKind, code: string, message: string, cause?: unknown): ConnectorError {
    return this.settle(new ConnectorError(kind, code, message, cause !== undefined ? { cause } : {}));
  }

  private async request(req: HttpRequest): Promise<ConnectorResponse> {
    const o = this.options;
    if (this.closed) throw this.fail("final", "connect/closed", "The operation call has finished; its http client is closed.");
    if (++this.requests > o.limits.maxRequestsPerCall) {
      throw this.fail("final", "connect/too-many-requests", `An operation call may make at most ${o.limits.maxRequestsPerCall} requests.`);
    }
    if (typeof req !== "object" || req === null || typeof req.url !== "string") throw this.fail("final", "connect/bad-request", "A request needs a url.");
    const method = typeof req.method === "string" ? req.method.toUpperCase() : req.method === undefined ? "GET" : "";
    if (!(EGRESS_METHODS as readonly string[]).includes(method)) throw this.fail("final", "connect/bad-request", `Method must be one of ${EGRESS_METHODS.join(", ")}.`);

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw this.fail("final", "connect/bad-request", "The URL is not valid.");
    }
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
      }
    }

    let headers: Headers;
    try {
      headers = new Headers(req.headers ?? {});
    } catch {
      throw this.fail("final", "connect/bad-request", "A header name or value is not valid.");
    }
    for (const name of FORBIDDEN_HEADERS) {
      if (headers.has(name)) throw this.fail("final", "connect/bad-request", `The ${name} header is set by the platform.`);
    }

    let body: string | Uint8Array | undefined;
    if (req.json !== undefined && req.body !== undefined) throw this.fail("final", "connect/bad-request", "Send json or body, not both.");
    if (req.json !== undefined) {
      if (checkJson(req.json)) throw this.fail("final", "connect/bad-request", "The json body is not plain JSON.");
      body = JSON.stringify(req.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (req.body !== undefined) {
      if (typeof req.body !== "string" && !(req.body instanceof Uint8Array)) throw this.fail("final", "connect/bad-request", "The body must be a string or bytes.");
      body = req.body;
    }
    if (body !== undefined && SAFE_METHODS.has(method)) throw this.fail("final", "connect/bad-request", `${method} requests have no body.`);
    if (body !== undefined && byteLength(body) > o.limits.maxRequestBytes) {
      throw this.fail("final", "connect/request-too-large", `The request body is larger than ${o.limits.maxRequestBytes} bytes.`);
    }
    // The body is fixed here: a handler that changes its buffer afterwards changes nothing that is sent.
    if (body instanceof Uint8Array) body = new Uint8Array(body);
    else if (typeof body === "string" && o.sign !== undefined) {
      // A signed request sends the very bytes it signed, keeping the type fetch gives a string body.
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
      body = encoder.encode(body);
    }
    if (!headers.has("user-agent")) headers.set("user-agent", o.userAgent);
    if (o.traceparent !== undefined && !headers.has("traceparent")) headers.set("traceparent", o.traceparent);

    const maxBytes =
      typeof req.maxResponseBytes === "number" && Number.isInteger(req.maxResponseBytes) && req.maxResponseBytes > 0
        ? Math.min(req.maxResponseBytes, o.limits.maxResponseBytes)
        : o.limits.maxResponseBytes;
    const perCall = typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : Number.POSITIVE_INFINITY;
    const budget = Math.min(o.deadline - o.clock.now(), perCall);
    if (o.signal.aborted) throw this.fail("retryable", "connect/cancelled", "The operation call was cancelled.");
    if (!(budget > 0)) throw this.fail("retryable", "connect/timeout", "No time was left to call the service.");

    const controller = new AbortController();
    const state = { timedOut: false };
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, Math.min(budget, 2_147_483_647));
    const onAbort = () => controller.abort();
    o.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.follow(method, url, headers, body, req.auth !== false, maxBytes, controller.signal, state);
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The headers the host's signer adds to one request. The signer gets a copy
   * of the body's bytes; the bytes themselves are what is sent.
   */
  private async signature(sign: RequestSigner, method: string, url: URL, headers: Headers, body: string | Uint8Array | undefined): Promise<Array<[string, string]>> {
    const request: SignableRequest = {
      method,
      url: url.href,
      headers: Object.fromEntries(headers.entries()),
      body: body === undefined ? null : typeof body === "string" ? encoder.encode(body) : new Uint8Array(body),
    };
    let answer: unknown;
    try {
      answer = await sign(request);
    } catch (error) {
      // A host's own refusal, by its fields only (never its methods).
      const failure = adoptConnectorError(error);
      if (failure) throw this.settle(failure);
      throw this.fail("retryable", "connect/sign-failed", "The request could not be signed right now.", error);
    }
    const added = signatureHeaders(answer);
    if (added instanceof ConnectorError) throw this.settle(added);
    return added;
  }

  private abortFailure(state: { timedOut: boolean }, cause?: unknown): ConnectorError {
    return state.timedOut
      ? this.fail("retryable", "connect/timeout", "The service did not answer in time.", cause)
      : this.fail("retryable", "connect/cancelled", "The operation call was cancelled.", cause);
  }

  private async follow(
    firstMethod: string,
    firstUrl: URL,
    headers: Headers,
    firstBody: string | Uint8Array | undefined,
    auth: boolean,
    maxBytes: number,
    signal: AbortSignal,
    state: { timedOut: boolean },
  ): Promise<ConnectorResponse> {
    const o = this.options;
    const origin = firstUrl.origin;
    let method = firstMethod;
    let body = firstBody;
    let target: URL = firstUrl;
    for (let hop = 0; ; hop++) {
      const check = checkEgress(o.rules, method, target);
      if (!check.ok) {
        o.log.warn("http.refused", { method: safe(method), host: safe(target.hostname), code: safe(check.code), hop: safe(hop) });
        throw this.fail("final", check.code, check.message);
      }
      const url = check.url;
      const sameOrigin = url.origin === origin;
      const hopHeaders = new Headers(headers);
      if (!sameOrigin) for (const name of ORIGIN_BOUND_HEADERS) hopHeaders.delete(name);
      const credentialHost = o.credentialHosts === undefined || o.credentialHosts.some((pattern) => hostMatches(pattern, url.hostname));
      if (auth && sameOrigin && !credentialHost && hop === 0) o.log.debug("http.no-credential", { host: safe(url.hostname) });
      const credentialed = auth && sameOrigin && credentialHost;
      if (credentialed) {
        let credential: Readonly<Record<string, string>>;
        try {
          credential = await (this.refreshed ?? o.credentials());
        } catch (error) {
          const failure = adoptConnectorError(error);
          if (failure) throw this.settle(failure);
          throw this.fail("retryable", "connect/credential-unavailable", "The connection's credential is not available right now.", error);
        }
        try {
          for (const [name, value] of Object.entries(credential)) hopHeaders.set(name, value);
        } catch (error) {
          throw this.fail("final", "connect/credential-invalid", "The connection's credential cannot be sent as a header.", error);
        }
        // Last: the signature covers the request exactly as it is sent.
        if (o.sign !== undefined) for (const [name, value] of await this.signature(o.sign, method, url, hopHeaders, body)) hopHeaders.set(name, value);
      }
      if (signal.aborted) throw this.abortFailure(state);

      const unsafe = !SAFE_METHODS.has(method);
      const started = Date.now();
      let response: Response;
      if (unsafe) this.unsafeInFlight++;
      try {
        response = await o.fetch(url.href, { method, headers: hopHeaders, redirect: "manual", signal, ...(body !== undefined ? { body } : {}) });
      } catch (error) {
        if (unsafe) {
          this.unsafeInFlight--;
          if (!failedBeforeSending(error)) this.applied = true;
        }
        const failure = signal.aborted ? this.abortFailure(state, error) : this.fail("retryable", "connect/network", "The service could not be reached.", error);
        o.log.warn("http.failed", { method: safe(method), host: safe(url.hostname), code: safe(failure.code) });
        throw failure;
      }
      if (unsafe) {
        this.unsafeInFlight--;
        if (!rejectedBeforeApplying(response.status)) this.applied = true;
      }
      o.log.debug("http.response", { method: safe(method), host: safe(url.hostname), status: safe(response.status), ms: safe(Date.now() - started) });

      // A 401 on a credentialed request: the token may have expired. Refresh it once per call and send
      // this request once more (a 401 was not applied); after that a 401 is the answer.
      if (response.status === 401 && credentialed && o.refreshCredentials !== undefined && this.refreshed === null) {
        await discard(response);
        const refresh = o.refreshCredentials;
        this.refreshed = Promise.resolve().then(() => refresh());
        o.log.info("http.credential-refresh", { host: safe(url.hostname) });
        hop--;
        continue;
      }

      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        await discard(response);
        if (hop + 1 > o.limits.maxRedirects) throw this.fail("final", "connect/too-many-redirects", `The service redirected more than ${o.limits.maxRedirects} times.`);
        try {
          target = new URL(location, url);
        } catch {
          throw this.fail("final", "connect/bad-response", "The service redirected to an invalid URL.");
        }
        // Fetch semantics: 303 turns into GET; 301 and 302 turn POST into GET.
        if ((response.status === 303 && method !== "HEAD") || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
        }
        continue;
      }

      // A page may be no larger than what is left of the call's total.
      const total = o.limits.maxTotalResponseBytes ?? DEFAULT_HTTP_LIMITS.maxTotalResponseBytes;
      const left = total - this.received;
      let bytes: Uint8Array | "too-large";
      try {
        bytes = await readCapped(response, Math.max(0, Math.min(maxBytes, left)));
      } catch (error) {
        throw signal.aborted ? this.abortFailure(state, error) : this.fail("retryable", "connect/network", "The connection was lost while reading the answer.", error);
      }
      if (bytes === "too-large") {
        throw left < maxBytes
          ? this.fail("final", "connect/response-too-large", `The answers to this operation call are larger than ${total} bytes in all.`)
          : this.fail("final", "connect/response-too-large", `The answer is larger than ${maxBytes} bytes.`);
      }
      this.received += bytes.byteLength;
      return this.wrap(response, url, hop, bytes);
    }
  }

  private wrap(response: Response, url: URL, redirects: number, bytes: Uint8Array): ConnectorResponse {
    let text: string | undefined;
    const result: ConnectorResponse = Object.freeze({
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: new Headers(response.headers),
      url: url.href,
      redirects,
      body: bytes,
      text: () => (text ??= decoder.decode(bytes)),
      json: (): JsonValue => {
        const raw = result.text();
        if (raw.trim() === "") return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw this.fail("final", "connect/bad-response", "The service answered with malformed JSON.", error);
        }
        if (checkJson(parsed)) throw this.fail("final", "connect/bad-response", "The service answered with JSON the kit does not accept.");
        return parsed as JsonValue;
      },
      ensureOk: (): ConnectorResponse => {
        const failure = httpError(result);
        if (failure) throw this.settle(failure);
        return result;
      },
    });
    return result;
  }
}
