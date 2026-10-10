/**
 * Failures a connector reports, and how HTTP answers and network errors map
 * onto the engine's action outcomes.
 *
 * The outcome says what happened to the outside world, not what went wrong:
 *
 * - `retryable`: not applied, a transient problem. Safe to try again.
 * - `final`: not applied, and trying again will not help.
 * - `unknown`: may or may not have been applied (a timeout after sending a write).
 *
 * A handler that returns normally means "applied" (`ok`). A handler signals
 * anything else by throwing a {@link ConnectorError}.
 */

import { checkJson, type ActionOutcome, type ConnectRefusalCode, type JsonValue, type RateLimitBucket } from "@aaply/action-contract";
import { deepFreeze, frozenSet } from "@aaply/action-contract/internal";

export type FailureKind = "retryable" | "final" | "unknown";

/**
 * Where each refusal code of the contract (`CONNECT_REFUSALS`) may come from
 * (ADR-0009, amended by the verification of the 0.2 gaps):
 *
 * - `check`: only the kit's own checks, before an operation runs. Each judges
 *   the attempt as it was delivered (its envelope, version, proof, audience,
 *   times, review, input, person and declared use, and whether it was
 *   delivered before), so it says that nothing ran and, for a write that does
 *   not de-duplicate, that the replay guard was not claimed. The engine acts
 *   on that: after `connect/contract-unsupported` it sends the same attempt
 *   again.
 * - `call`: may also be found while a call runs, by the host's resolver,
 *   credential, signing or file-store hooks or by the kit's HTTP client (an
 *   account to reconnect or of another kind, a revoked connection, a policy,
 *   a destination no egress rule allows, a rate limit, a store that cannot
 *   answer). The engine reads these only as `final` or `retryable`, and the
 *   kit still answers `unknown` once a write may have been sent.
 *
 * A new refusal code does not compile until it is placed here.
 */
export const REFUSAL_ORIGINS = deepFreeze({
  "connect/contract-unsupported": "check",
  "connect/invalid-envelope": "check",
  "connect/expired": "check",
  "connect/wrong-audience": "check",
  "connect/proof-invalid": "check",
  "connect/replayed": "check",
  "connect/unknown-action": "check",
  "connect/contract-mismatch": "check",
  "connect/effect-mismatch": "check",
  "connect/idempotency-mismatch": "check",
  "connect/invalid-input": "check",
  "connect/no-subject": "check",
  "connect/approval-invalid": "check",
  "connect/late": "check",
  "connect/clock-skew": "check",
  "connect/no-connection": "call",
  "connect/not-own-connection": "call",
  "connect/environment-mismatch": "call",
  "connect/reconsent": "call",
  "connect/connection-revoked": "call",
  "connect/policy-denied": "call",
  "connect/egress-denied": "call",
  "connect/disabled": "call",
  "connect/rate-limited": "call",
  "connect/unavailable": "call",
} as const satisfies Readonly<Record<ConnectRefusalCode, "check" | "call">>);

/**
 * The codes only the kit's own checks answer, before an operation runs: the
 * `check` refusals of {@link REFUSAL_ORIGINS}, and the kit's
 * `connect/resolver-error` (the connection could not be looked up) and
 * `connect/invalid-connector` (the connector is not valid).
 */
export const CHECK_ONLY_CODES: ReadonlySet<string> = frozenSet([
  ...Object.entries(REFUSAL_ORIGINS)
    .filter(([, origin]) => origin === "check")
    .map(([code]) => code),
  "connect/resolver-error",
  "connect/invalid-connector",
]);

/**
 * Whether code that runs during or around a call (a handler, or the host's
 * resolver, credential, signing or file-store hooks) may not answer `code`:
 * one of the {@link CHECK_ONLY_CODES}, or any `flow/` code, which only the
 * engine records. The kit answers such a `ConnectorError` from a handler as
 * a fault of the handler (`connect/handler-error`), and one from the resolver
 * as `connect/resolver-error`, so a claim that nothing ran or was claimed
 * never comes from code that may have run.
 */
export function isCheckOnlyCode(code: string): boolean {
  return CHECK_ONLY_CODES.has(code) || code.startsWith("flow/");
}

const BRAND = Symbol.for("@aaply/connector-sdk/ConnectorError");
const MAX_CODE = 100;
const MAX_MESSAGE = 500;
const MAX_DETAIL = 2000;

/** Retry-After values are capped at a day. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ConnectorErrorOptions {
  /** Kept for local debugging; never sent to the engine. */
  cause?: unknown;
  /**
   * Internal detail for staff and logs, such as what the service answered.
   * Sent to the engine, which never shows it to the person. Capped at 2000 characters.
   */
  detail?: string;
}

/** What a retryable failure may add: when to try again, and which rate-limit bucket was hit. */
export interface RetryOptions {
  /** When to try again; capped at {@link MAX_RETRY_AFTER_MS}. */
  retryAfterMs?: number;
  /**
   * Which bucket a rate limit belongs to: `connection` (this one account, as
   * with a per-user quota) or `connector` (the whole service). With a store
   * that has fair lanes, `retryAfterMs` then pauses only that bucket.
   */
  limit?: RateLimitBucket;
}

/**
 * A failure with its outcome semantics. Throw one from a handler:
 *
 *   throw ConnectorError.final("notes/too-long", "The note is longer than the service allows.");
 *
 * `code` is stable and machine-readable; `message` is shown to people, so it
 * must not contain payload values or anything the service echoed back. Put
 * those in `detail`, which only staff see.
 */
export class ConnectorError extends Error {
  readonly kind: FailureKind;
  readonly code: string;
  readonly retryAfterMs?: number;
  /** For a retryable failure: the rate-limit bucket it hit, when known. */
  readonly limit?: RateLimitBucket;
  readonly detail?: string;

  constructor(kind: FailureKind, code: string, message: string, options: ConnectorErrorOptions & RetryOptions = {}) {
    super(message.slice(0, MAX_MESSAGE), options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ConnectorError";
    this.kind = kind;
    this.code = code.slice(0, MAX_CODE) || "connector/error";
    if (typeof options.detail === "string" && options.detail !== "") this.detail = options.detail.slice(0, MAX_DETAIL);
    if (kind === "retryable" && options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0) {
      this.retryAfterMs = Math.min(Math.round(options.retryAfterMs), MAX_RETRY_AFTER_MS);
    }
    if (kind === "retryable" && (options.limit === "connection" || options.limit === "connector")) this.limit = options.limit;
    Object.defineProperty(this, BRAND, { value: true });
  }

  /** Not applied; a transient problem. The engine may try again, after `retryAfterMs` when given; `limit` names the rate-limit bucket. */
  static retryable(code: string, message: string, options: ConnectorErrorOptions & RetryOptions = {}): ConnectorError {
    return new ConnectorError("retryable", code, message, options);
  }

  /** Not applied; trying again will not help (bad input, not found, forbidden). */
  static final(code: string, message: string, options: ConnectorErrorOptions = {}): ConnectorError {
    return new ConnectorError("final", code, message, options);
  }

  /** May or may not have been applied. Only meaningful for writes. */
  static unknown(code: string, message: string, options: ConnectorErrorOptions = {}): ConnectorError {
    return new ConnectorError("unknown", code, message, options);
  }

  /**
   * Recognises errors from any copy of this package, by a brand any value can
   * carry. Never throws. A value it recognises is someone's word: the kit
   * reads its fields once, through {@link adoptConnectorError}, and never
   * calls its methods.
   */
  static is(value: unknown): value is ConnectorError {
    try {
      return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
    } catch {
      // A proxy, or a getter that throws: not one.
      return false;
    }
  }

  /** The same failure with a different kind (used when a write may already have happened). */
  withKind(kind: FailureKind): ConnectorError {
    if (kind === this.kind) return this;
    return new ConnectorError(kind, this.code, this.message, {
      cause: this.cause,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.limit !== undefined ? { limit: this.limit } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    });
  }

  toOutcome(): ActionOutcome {
    const error = { code: this.code, message: this.message, ...(this.detail !== undefined ? { detail: this.detail } : {}) };
    switch (this.kind) {
      case "retryable":
        return { status: "retryable", error, ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}), ...(this.limit !== undefined ? { limit: this.limit } : {}) };
      case "final":
        return { status: "final", error };
      case "unknown":
        return { status: "unknown", error };
    }
  }
}

const FAILURE_KINDS: ReadonlySet<string> = new Set(["retryable", "final", "unknown"]);

/**
 * A `ConnectorError` of this copy of the kit, built from `value`'s plain
 * fields when it carries the brand ({@link ConnectorError.is}), or null when
 * it does not or a field is not what a `ConnectorError` holds (`kind` one of
 * the three, `code` and `message` strings, `retryAfterMs` a number,
 * `limit` a bucket, `detail` a string). Each field is read once and the copy
 * is all the kit uses, so a thrown value, whoever threw it (a handler, a
 * host's hook, another copy of the kit), cannot answer one thing to a check
 * and another to the outcome, and none of its methods is ever called. Never
 * throws.
 */
export function adoptConnectorError(value: unknown): ConnectorError | null {
  if (!ConnectorError.is(value)) return null;
  let fields: { kind: unknown; code: unknown; message: unknown; retryAfterMs: unknown; limit: unknown; detail: unknown };
  try {
    const v = value as unknown as Record<string, unknown>;
    fields = { kind: v.kind, code: v.code, message: v.message, retryAfterMs: v.retryAfterMs, limit: v.limit, detail: v.detail };
  } catch {
    return null;
  }
  const { kind, code, message, retryAfterMs, limit, detail } = fields;
  if (typeof kind !== "string" || !FAILURE_KINDS.has(kind) || typeof code !== "string" || typeof message !== "string") return null;
  if (retryAfterMs !== undefined && (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)) return null;
  if (limit !== undefined && limit !== "connection" && limit !== "connector") return null;
  if (detail !== undefined && typeof detail !== "string") return null;
  return new ConnectorError(kind as FailureKind, code, message, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
}

/** Statuses that mean "not done, try again later". */
export const RETRYABLE_STATUSES: ReadonlySet<number> = frozenSet([408, 425, 429, 500, 502, 503, 504]);

/**
 * Statuses after which an unsafe request (POST, PUT, PATCH, DELETE) has
 * certainly not been applied: the server refused it before acting. Any other
 * answer (2xx, 3xx, 500, 502, 504, ...) may mean it was.
 */
export function rejectedBeforeApplying(status: number): boolean {
  return (status >= 400 && status < 500) || status === 501 || status === 503;
}

/**
 * Milliseconds to wait from a Retry-After header: delay seconds or an HTTP
 * date. Capped at {@link MAX_RETRY_AFTER_MS}; `undefined` when absent or invalid.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  if (!/[a-z]/i.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

export interface HeadersLike {
  get(name: string): string | null;
}

/** What {@link httpOutcome} needs from a response. `ConnectorResponse` satisfies it. */
export interface ResponseLike {
  status: number;
  headers: HeadersLike;
  /** The body already read; needed only to produce an `ok` output. */
  body?: Uint8Array;
}

/**
 * The failure an HTTP status means, or `null` for 2xx. Codes are `http/<status>`.
 *
 * 408, 425, 429, 500, 502, 503 and 504 are retryable (honouring Retry-After);
 * every other status is final. Whether a write "may have happened" is decided
 * by the kit from the request method and status, not here: see the README.
 */
export function httpError(response: ResponseLike, now: number = Date.now()): ConnectorError | null {
  const status = response.status;
  if (status >= 200 && status < 300) return null;
  const code = `http/${status}`;
  if (RETRYABLE_STATUSES.has(status)) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
    return ConnectorError.retryable(code, status === 429 ? "The service is rate limiting requests." : `The service is unavailable right now (${status}).`, retryAfterMs !== undefined ? { retryAfterMs } : {});
  }
  if (status >= 400 && status < 500) return ConnectorError.final(code, `The service refused the request (${status}).`);
  return ConnectorError.final(code, `The service answered with an unexpected status (${status}).`);
}

const decoder = new TextDecoder();

/**
 * Maps an HTTP response to an action outcome. 2xx is `ok`, with the body as
 * output when it is JSON (otherwise `null`); everything else is mapped by
 * {@link httpError}.
 */
export function httpOutcome(response: ResponseLike, now: number = Date.now()): ActionOutcome {
  const failure = httpError(response, now);
  if (failure) return failure.toOutcome();
  const body = response.body;
  const type = response.headers.get("content-type") ?? "";
  if (!body || body.length === 0 || !/[/+]json\b/i.test(type)) return { status: "ok", output: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    return { status: "final", error: { code: "connect/bad-response", message: "The service answered with malformed JSON." } };
  }
  if (checkJson(parsed)) return { status: "final", error: { code: "connect/bad-response", message: "The service answered with JSON the kit does not accept." } };
  return { status: "ok", output: parsed as JsonValue };
}

/** Network error codes raised before a request could reach the server. */
const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_INVALID_ARG",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function errorCodes(error: unknown, depth = 0): string[] {
  if (depth > 4 || typeof error !== "object" || error === null) return [];
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown };
  const out: string[] = typeof e.code === "string" ? [e.code] : [];
  if (Array.isArray(e.errors)) for (const inner of e.errors) out.push(...errorCodes(inner, depth + 1));
  out.push(...errorCodes(e.cause, depth + 1));
  return out;
}

/**
 * Whether a rejected fetch certainly failed before any byte reached the
 * server (name resolution, connection refused, TLS setup). When unsure, the
 * answer is `false`: the request may have been sent.
 */
export function failedBeforeSending(error: unknown): boolean {
  const codes = errorCodes(error);
  return codes.length > 0 && codes.every((c) => PRE_SEND_CODES.has(c));
}

/**
 * Maps a rejected fetch to an outcome: retryable when nothing was sent or the
 * call was a read; unknown when a write may have reached the server.
 */
export function fetchErrorOutcome(error: unknown, effect: "read" | "write"): ActionOutcome {
  const timeout = typeof error === "object" && error !== null && ((error as { name?: unknown }).name === "AbortError" || (error as { name?: unknown }).name === "TimeoutError");
  const code = timeout ? "connect/timeout" : "connect/network";
  const message = timeout ? "The service did not answer in time." : "The service could not be reached.";
  if (effect === "write" && !failedBeforeSending(error)) return { status: "unknown", error: { code, message } };
  return { status: "retryable", error: { code, message } };
}
