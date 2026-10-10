/**
 * Test kit for connector authors: a mock `fetch`, a way to call operations
 * directly with the same checks production applies, and the conformance
 * cases every connector must pass. Framework-free: each case throws on
 * failure, so any test runner can run them:
 *
 *   for (const c of connectorConformanceCases(notes, samples)) it(c.name, c.run);
 *
 * Conformance cases replace `globalThis.fetch` while they run, so run them
 * one at a time (the default in most runners), not concurrently.
 */

import { canonicalJson, checkSchema, cloneJson, DiagnosticBag, operationDigest, validateValue, type ActionOutcome, type JsonObject, type JsonValue, type Scope } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, conformanceVerifier, draftApprovedAction, sealApprovedAction } from "@aaply/action-contract/conformance";
import type { BlobLimits, BlobStore } from "./blobs.js";
import { systemClock, type Clock } from "./clock.js";
import { compileConnector, manifestDigest, manifestOf, operationContractOf, validateConnector, validateManifest, type Connector } from "./definition.js";
import { SAFE_METHODS } from "./egress.js";
import { ConnectorError } from "./errors.js";
import { DEFAULT_HTTP_LIMITS, HttpSession, userAgentFor, type ConnectorResponse, type FetchLike, type HttpLimits, type HttpRequest } from "./http.js";
import { invokeOperation } from "./invoke.js";
import { createConnectorLog, type ConnectorLogRecord } from "./log.js";
import { createConnectorActionPort, memoryReplayGuard } from "./port.js";
import type { SignableRequest } from "./signing.js";

// ---------------------------------------------------------------------------
// mockFetch
// ---------------------------------------------------------------------------

/** A request as the mock saw it. Header names are lowercase. */
export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** The body as JSON; `null` when empty. */
  json(): JsonValue;
}

export type MockReply =
  /** A response. `json` sets the body and `content-type: application/json`. `delayMs` waits (abortably) first. */
  | { status?: number; headers?: Record<string, string>; json?: JsonValue; body?: string | Uint8Array; delayMs?: number }
  /** Fails like Node's fetch does, with this errno-style code as the cause (e.g. "ECONNREFUSED", "ECONNRESET"). */
  | { networkError: string }
  /** Never answers; rejects with an AbortError once the request is aborted. */
  | { hang: true };

export type MockResponder = MockReply | ((request: MockRequest) => MockReply | Response | Promise<MockReply | Response>);

/**
 * Routes keyed `"METHOD https://host/path"`; a key ending in `*` matches any
 * path with that prefix. The query string is ignored. First match wins.
 */
export type MockRoutes = Record<string, MockResponder>;

export interface MockFetch extends FetchLike {
  /** Every request, in order. */
  readonly calls: MockRequest[];
  /** Requests no route matched (answered 404). */
  readonly unmatched: MockRequest[];
  /** Adds or replaces a route. */
  on(route: string, responder: MockResponder): void;
  /** Recorded requests a route key matches. */
  callsTo(route: string): MockRequest[];
}

interface ParsedRoute {
  key: string;
  method: string;
  target: string;
  prefix: boolean;
}

function parseRoute(key: string): ParsedRoute {
  const match = /^([A-Z]+) (https?:\/\/\S+)$/.exec(key);
  if (!match) throw new Error(`mockFetch: route "${key}" must look like "GET https://api.example.com/v1/items"`);
  const prefix = match[2]!.endsWith("*");
  return { key, method: match[1]!, target: prefix ? match[2]!.slice(0, -1) : match[2]!, prefix };
}

function routeMatches(route: ParsedRoute, method: string, url: string): boolean {
  if (route.method !== method) return false;
  let bare: string;
  try {
    const u = new URL(url);
    bare = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return false;
  }
  return route.prefix ? bare.startsWith(route.target) : bare === route.target;
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function waitFor(ms: number | null, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = ms === null ? undefined : setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const textDecoder = new TextDecoder();

function bodyText(body: RequestInit["body"]): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return textDecoder.decode(body);
  if (body instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(body));
  return String(body);
}

/** A `fetch` that answers from routes and records every request. Makes no network calls. */
export function mockFetch(routes: MockRoutes = {}): MockFetch {
  const table: Array<{ route: ParsedRoute; responder: MockResponder }> = Object.entries(routes).map(([key, responder]) => ({ route: parseRoute(key), responder }));
  const calls: MockRequest[] = [];
  const unmatched: MockRequest[] = [];

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = bodyText(init.body);
    const request: MockRequest = {
      method,
      url: input,
      headers,
      body,
      json: () => (body === null || body === "" ? null : (JSON.parse(body) as JsonValue)),
    };
    calls.push(request);
    if (init.signal?.aborted) throw abortError();
    const hit = table.find((r) => routeMatches(r.route, method, input));
    if (!hit) {
      unmatched.push(request);
      return new Response(JSON.stringify({ error: "no mock route", method, url: input }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const reply = typeof hit.responder === "function" ? await hit.responder(request) : hit.responder;
    if (reply instanceof Response) return reply;
    if ("networkError" in reply) {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(`mock network error ${reply.networkError}`), { code: reply.networkError }) });
    }
    if ("hang" in reply) {
      await waitFor(null, init.signal);
      throw abortError();
    }
    if (reply.delayMs !== undefined) await waitFor(reply.delayMs, init.signal);
    const status = reply.status ?? 200;
    const responseHeaders = new Headers(reply.headers ?? {});
    let responseBody: string | Uint8Array | null = null;
    if (reply.json !== undefined) {
      responseBody = JSON.stringify(reply.json);
      if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json");
    } else if (reply.body !== undefined) responseBody = reply.body;
    if (NULL_BODY_STATUSES.has(status)) responseBody = null;
    return new Response(responseBody as ConstructorParameters<typeof Response>[0], { status, headers: responseHeaders });
  };

  return Object.assign(fetchImpl, {
    calls,
    unmatched,
    on(route: string, responder: MockResponder) {
      const parsed = parseRoute(route);
      const existing = table.findIndex((r) => r.route.key === route);
      if (existing >= 0) table[existing] = { route: parsed, responder };
      else table.push({ route: parsed, responder });
    },
    callsTo(route: string) {
      const parsed = parseRoute(route);
      return calls.filter((c) => routeMatches(parsed, c.method, c.url));
    },
  });
}

// ---------------------------------------------------------------------------
// testConnector
// ---------------------------------------------------------------------------

export interface TestConnectorOptions {
  /** The fetch handlers call through `ctx.http`. Default: `mockFetch(routes)`. */
  fetch?: FetchLike;
  /** Routes for the default mock fetch. */
  routes?: MockRoutes;
  /** Credential headers the kit injects. Default `{ authorization: "Bearer test-token" }`. */
  credentials?: Readonly<Record<string, string>>;
  /** Signs each credentialed request, as a host's `CredentialProvider.sign` would; called last, with the request exactly as sent. */
  sign?: (request: SignableRequest) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  connection?: { id?: string; role?: string | null };
  /** Per-call time limit. Default 15 seconds. */
  timeoutMs?: number;
  clock?: Clock;
  limits?: Partial<HttpLimits>;
  /** The file store behind `ctx.blobs` (`memoryBlobStore()` for tests). Without it, `ctx.blobs` throws `connect/blob-no-store`. */
  blobs?: BlobStore;
  blobLimits?: Partial<BlobLimits>;
  /** The scope calls run in: file references in inputs and outputs must be bound to it. Default {@link TEST_SCOPE}. */
  scope?: Scope;
}

/** The scope `testConnector` calls run in unless told otherwise. */
export const TEST_SCOPE: Readonly<Scope> = Object.freeze({ tenantId: "tenant-test", appId: "app-test", environmentId: "env-test" });

export interface CallOptions {
  idempotencyKey?: string;
  /** The engine's `traceparent`, as the port would pass it on (it is not checked here). */
  traceparent?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ConnectorTester {
  readonly connector: Connector;
  /** The default mock fetch, when `fetch` was not given. */
  readonly mock: MockFetch | undefined;
  /** Every log record, after redaction. */
  readonly logs: ConnectorLogRecord[];
  /** Handler invocations (the handler is not called when the input is refused). */
  readonly handlerCalls: Array<{ operation: string; input: JsonObject; idempotencyKey: string }>;
  /** Runs an operation exactly as the action port would, minus connection lookup. */
  call(operation: string, input: unknown, options?: CallOptions): Promise<ActionOutcome>;
  /** Runs an operation and returns its output; throws when the outcome is not `ok`. */
  run(operation: string, input: unknown, options?: CallOptions): Promise<JsonValue>;
  /** Makes one `ctx.http` call under an operation's egress rules, as its handler would. */
  http(operation: string, request: HttpRequest): Promise<ConnectorResponse>;
}

export const TEST_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({ authorization: "Bearer test-token" });

/** Calls a connector's operations directly, with input, egress and output checks as in production. */
export function testConnector(connector: Connector, options: TestConnectorOptions = {}): ConnectorTester {
  const compiled = compileConnector(connector);
  const mock = options.fetch ? undefined : mockFetch(options.routes ?? {});
  const fetchImpl: FetchLike = options.fetch ?? mock!;
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const credentials = options.credentials ?? TEST_CREDENTIALS;
  const signer = options.sign;
  const sign = signer !== undefined && compiled.connector.auth.kind !== "none" ? { sign: (request: SignableRequest) => Promise.resolve().then(() => signer(request)) } : {};
  const connection = { id: options.connection?.id ?? "conn-test", role: options.connection?.role === undefined ? "test" : options.connection.role };
  const logs: ConnectorLogRecord[] = [];
  const handlerCalls: ConnectorTester["handlerCalls"] = [];
  let counter = 0;

  const call = (operation: string, input: unknown, callOptions: CallOptions = {}): Promise<ActionOutcome> => {
    const idempotencyKey = callOptions.idempotencyKey ?? `test-key-${String(++counter).padStart(4, "0")}`;
    return invokeOperation(compiled.connector, operation, input, {
      fetch: fetchImpl,
      clock,
      ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      deadline: clock.now() + (callOptions.timeoutMs ?? timeoutMs),
      idempotencyKey,
      connection,
      credentials: async () => (compiled.connector.auth.kind === "none" ? {} : credentials),
      ...sign,
      ...(callOptions.traceparent !== undefined ? { traceparent: callOptions.traceparent } : {}),
      log: (record) => logs.push(record),
      ...(options.limits ? { limits: options.limits } : {}),
      onHandler: (handlerInput) => handlerCalls.push({ operation, input: cloneJson(handlerInput), idempotencyKey }),
      scope: options.scope ?? TEST_SCOPE,
      ...(options.blobs ? { blobs: options.blobs } : {}),
      ...(options.blobLimits ? { blobLimits: options.blobLimits } : {}),
    });
  };

  return {
    connector: compiled.connector,
    mock,
    logs,
    handlerCalls,
    call,
    async run(operation, input, callOptions) {
      const outcome = await call(operation, input, callOptions);
      if (outcome.status === "ok") return outcome.output;
      const detail = "error" in outcome ? ` ${outcome.error.code}: ${outcome.error.message}` : "";
      throw Object.assign(new Error(`${connector.id}.${operation} was ${outcome.status}:${detail}`), { outcome });
    },
    async http(operation, request) {
      const entry = compiled.operations.get(operation);
      if (!entry) throw new Error(`${connector.id} has no operation "${operation}"`);
      const controller = new AbortController();
      const session = new HttpSession({
        fetch: fetchImpl,
        rules: entry.rules,
        effect: entry.operation.effect,
        signal: controller.signal,
        deadline: clock.now() + timeoutMs,
        clock,
        credentials: async () => (compiled.connector.auth.kind === "none" ? {} : credentials),
        ...sign,
        credentialHosts: entry.credentialHosts,
        limits: { ...DEFAULT_HTTP_LIMITS, ...options.limits },
        userAgent: userAgentFor(connector),
        log: createConnectorLog((record) => logs.push(record), { connectorId: connector.id, operation, connectionId: connection.id }),
      });
      try {
        return await session.http(request);
      } finally {
        session.close();
        controller.abort();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

export interface ConnectorConformanceCase {
  name: string;
  run: () => Promise<void>;
}

/** A known-good call of one operation. */
export interface ConformanceSample {
  /** A valid input. */
  input: JsonObject;
  /** Mock routes that answer the operation's requests successfully. Must tolerate being called more than once. */
  routes: MockRoutes;
  /** An input the input schema rejects. Derived from the schema when omitted. */
  invalidInput?: JsonValue;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`connector conformance: ${message}`);
}

function describe(outcome: ActionOutcome): string {
  return "error" in outcome ? `${outcome.status} (${outcome.error.code}: ${outcome.error.message})` : outcome.status;
}

const UNDECLARED_HOST = "undeclared.conformance-check.invalid";
const CONFORMANCE_SCOPE: Scope = { tenantId: "tenant-conformance", appId: "app-conformance", environmentId: "env-conformance" };

function deriveInvalidInput(schema: { required?: string[]; additionalProperties?: unknown }): JsonValue {
  if (schema.required && schema.required.length > 0) return {};
  if (schema.additionalProperties === false) return { "x-conformance-unexpected": true };
  return "not an object";
}

function containsKey(request: MockRequest, key: string): boolean {
  return request.url.includes(key) || Object.values(request.headers).some((v) => v.includes(key)) || (request.body ?? "").includes(key);
}

async function withGlobalFetchTrap<T>(work: () => Promise<T>): Promise<{ result: T; bypassed: number }> {
  const original = globalThis.fetch;
  let bypassed = 0;
  globalThis.fetch = (async () => {
    bypassed++;
    throw new TypeError("connector conformance: global fetch is not available to handlers");
  }) as typeof globalThis.fetch;
  try {
    return { result: await work(), bypassed };
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Behaviour every connector must have, checked against the author's samples
 * (one per operation) with mock HTTP only. Requests carry the credential
 * {@link TEST_CREDENTIALS} (`authorization: Bearer test-token`).
 *
 * - the manifest is valid, plain JSON, and its digest is stable;
 * - every operation declares valid input and output schemas, and has a sample;
 * - writes declare undo semantics (idempotent, compensate or irreversible), and undo operations are idempotent writes;
 * - invalid input is refused without calling the handler;
 * - the sample succeeds through `ctx.http` alone (never the global fetch) and its output matches the schema;
 * - egress to an undeclared host, by request or by redirect, is refused and never reaches the network;
 * - a write passes the idempotency key through, unchanged across attempts of one effect.
 */
export function connectorConformanceCases(connector: Connector, samples: Readonly<Record<string, ConformanceSample>>): ConnectorConformanceCase[] {
  const cases: ConnectorConformanceCase[] = [];
  // Every case runs with the global fetch replaced, so a handler that bypasses ctx.http never reaches the network.
  const it = (name: string, run: () => Promise<void>) =>
    cases.push({
      name: `${connector.id}: ${name}`,
      run: async () => {
        const { bypassed } = await withGlobalFetchTrap(run);
        assert(bypassed === 0, "a handler called the global fetch; all network access must go through ctx.http");
      },
    });
  const compiled = compileConnector(connector);
  const c = compiled.connector;
  const opNames = [...compiled.operations.keys()];
  const sampleOf = (name: string): ConformanceSample => {
    const sample = Object.prototype.hasOwnProperty.call(samples, name) ? samples[name] : undefined;
    assert(sample, `no sample for operation "${name}"`);
    return sample;
  };

  it("manifest is valid and its digest is stable", async () => {
    const definitionErrors = validateConnector(c).filter((d) => d.severity === "error");
    assert(definitionErrors.length === 0, `definition has errors: ${definitionErrors.map((d) => `${d.code} at ${d.path}`).join("; ")}`);
    const manifest = manifestOf(c);
    const errors = validateManifest(manifest).filter((d) => d.severity === "error");
    assert(errors.length === 0, `manifest has errors: ${errors.map((d) => `${d.code} at ${d.path}`).join("; ")}`);
    const copy = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    assert(canonicalJson(copy as unknown as JsonValue) === canonicalJson(manifest as unknown as JsonValue), "manifest does not survive a JSON round trip");
    const digest = manifestDigest(manifest);
    assert(/^sha256:[0-9a-f]{64}$/.test(digest), `digest has the wrong shape: ${digest}`);
    assert(manifestDigest(copy) === digest && manifestDigest(manifestOf(c)) === digest, "digest is not stable");
    assert(Object.keys(manifest.operations).length === opNames.length, "manifest does not list every operation");
  });

  it("every operation declares valid input and output schemas", async () => {
    for (const [name, entry] of compiled.operations) {
      for (const key of ["input", "output"] as const) {
        const bag = new DiagnosticBag();
        checkSchema(entry.operation[key], [name, key], bag);
        assert(!bag.hasErrors, `${name}.${key} schema is invalid: ${bag.items.map((d) => d.message).join("; ")}`);
      }
      assert(entry.operation.input.type === "object", `${name}.input must be type "object"`);
    }
  });

  it("every operation has a valid sample", async () => {
    for (const name of opNames) {
      const sample = sampleOf(name);
      const issues = validateValue(compiled.operations.get(name)!.operation.input, sample.input);
      assert(issues.length === 0, `sample input for "${name}" is invalid at ${issues[0]?.path.join(".")}: ${issues[0]?.message}`);
    }
    for (const name of Object.keys(samples)) assert(compiled.operations.has(name), `sample for unknown operation "${name}"`);
  });

  it("writes declare undo semantics", async () => {
    for (const [name, entry] of compiled.operations) {
      const op = entry.operation;
      if (op.effect !== "write") continue;
      assert(op.idempotent || op.compensate !== undefined || op.irreversible, `write "${name}" declares neither idempotent, compensate nor irreversible`);
      if (op.compensate !== undefined) {
        const undo = compiled.operations.get(op.compensate)?.operation;
        assert(undo && undo.effect === "write", `"${name}" is undone by "${op.compensate}", which is not a write of this connector`);
        assert(undo.idempotent, `"${op.compensate}" undoes "${name}" but is not idempotent; the engine may send an undo more than once`);
      }
    }
  });

  for (const name of opNames) {
    const entry = compiled.operations.get(name)!;
    const op = entry.operation;

    it(`${name}: invalid input is refused without calling the handler`, async () => {
      const sample = sampleOf(name);
      const invalid = sample.invalidInput !== undefined ? sample.invalidInput : deriveInvalidInput(op.input);
      const isObject = typeof invalid === "object" && invalid !== null && !Array.isArray(invalid);
      assert(!isObject || validateValue(op.input, invalid).length > 0, `the invalid input given for "${name}" is valid under its input schema`);
      const tester = testConnector(c, { routes: sample.routes });
      const outcome = await tester.call(name, invalid);
      assert(outcome.status === "final" && outcome.error.code === "connect/invalid-input", `expected final connect/invalid-input, got ${describe(outcome)}`);
      assert(tester.handlerCalls.length === 0, "the handler ran on invalid input");
      assert(tester.mock!.calls.length === 0, "a request was made for invalid input");
    });

    it(`${name}: the sample succeeds through ctx.http alone and its output matches the schema`, async () => {
      const sample = sampleOf(name);
      const tester = testConnector(c, { routes: sample.routes });
      const { result: outcome, bypassed } = await withGlobalFetchTrap(() => tester.call(name, sample.input));
      assert(bypassed === 0, "the handler called the global fetch; all network access must go through ctx.http");
      const unmatched = tester.mock!.unmatched.map((r) => `${r.method} ${r.url}`);
      assert(outcome.status === "ok", `expected ok, got ${describe(outcome)}${unmatched.length ? `; unmatched requests: ${unmatched.join(", ")}` : ""}`);
      const issues = validateValue(op.output, outcome.output);
      assert(issues.length === 0, `output does not match the output schema at ${issues[0]?.path.join(".")}`);
    });

    it(`${name}: egress to an undeclared host is refused`, async () => {
      const sample = sampleOf(name);
      const rule = entry.rules[0];
      if (rule) {
        const tester = testConnector(c, { routes: sample.routes });
        const attempt = async (url: string): Promise<unknown> => {
          try {
            await tester.http(name, { method: rule.method, url });
            return null;
          } catch (error) {
            return error;
          }
        };
        const direct = await attempt(`https://${UNDECLARED_HOST}${rule.path}`);
        assert(ConnectorError.is(direct) && direct.code === "connect/egress-denied", "a request to an undeclared host was not refused");
        const plain = await attempt(`http://${rule.wildcard ? `x.${rule.host}` : rule.host}${rule.path}`);
        assert(ConnectorError.is(plain) && plain.code === "connect/egress-not-https", "a plain http request was not refused");
        assert(tester.mock!.calls.length === 0, "a refused request reached fetch");
      }
      // Every answer redirects to an undeclared host; the kit must not follow.
      const reached: string[] = [];
      const redirecting: FetchLike = async (url) => {
        reached.push(url);
        return new Response(null, { status: 307, headers: { location: `https://${UNDECLARED_HOST}/redirected` } });
      };
      const tester = testConnector(c, { fetch: redirecting });
      await tester.call(name, sample.input);
      assert(!reached.some((url) => new URL(url).hostname === UNDECLARED_HOST), "a redirect to an undeclared host was followed");
      if (reached.length > 0) assert(tester.logs.some((l) => l.event === "http.refused"), "the refused redirect was not logged");
    });

    if (op.effect === "write") {
      it(`${name}: the idempotency key is passed through, stable across attempts`, async () => {
        const sample = sampleOf(name);
        const attempt = async (attemptNo: number, effectId: string, key: string) => {
          const mock = mockFetch(sample.routes);
          const port = createConnectorActionPort({
            audience: CONFORMANCE_AUDIENCE,
            verifier: conformanceVerifier(),
            connectors: [c],
            connections: () => ({ connectionId: "conn-conformance", grantedScopes: c.auth.kind === "oauth2" ? [...c.auth.scopes] : [], subjectId: null }),
            credentials: { headers: () => TEST_CREDENTIALS },
            fetch: mock,
            // A write that does not de-duplicate needs one; each attempt here is a new envelope.
            replayGuard: memoryReplayGuard(),
          });
          // A pinned, reviewed, signed approved action, as the engine would send it.
          const approved = sealApprovedAction({
            ...draftApprovedAction({
              action: `${c.id}.${name}`,
              effect: "write",
              input: sample.input,
              now: Date.now(),
              scope: CONFORMANCE_SCOPE,
              environment: "production",
              effectId,
              attempt: attemptNo,
              role: "conformance",
              subject: null,
              idempotent: op.idempotent,
              risk: op.riskFloor,
              contract: operationDigest(operationContractOf(c, name)!),
              timeoutMs: 15_000,
            }),
            idempotencyKey: key,
          });
          const outcome = await port.run(approved, new AbortController().signal);
          assert(outcome.status === "ok", `attempt ${attemptNo} expected ok, got ${describe(outcome)}`);
          return mock.calls.filter((r) => !SAFE_METHODS.has(r.method));
        };
        const keyA = "idem-conformance-AAAAAAAAAAAA";
        const keyB = "idem-conformance-BBBBBBBBBBBB";
        const first = await attempt(1, "effect-a", keyA);
        const second = await attempt(2, "effect-a", keyA);
        const other = await attempt(1, "effect-b", keyB);
        const carriers = (calls: MockRequest[], key: string) => calls.filter((r) => containsKey(r, key)).length;
        assert(carriers(first, keyA) === carriers(second, keyA), "the idempotency key is not sent the same way on every attempt");
        assert(carriers(other, keyA) === 0, "a key from another effect was sent; the key must come from ctx.idempotencyKey");
        if (op.idempotent) {
          // POST and PATCH are not idempotent by themselves; the service needs the key.
          for (const r of [...first, ...second]) {
            if (r.method === "POST" || r.method === "PATCH") assert(containsKey(r, keyA), `${r.method} ${r.url} does not carry ctx.idempotencyKey`);
          }
          for (const r of other) {
            if (r.method === "POST" || r.method === "PATCH") assert(containsKey(r, keyB), `${r.method} ${r.url} does not carry ctx.idempotencyKey`);
          }
        }
      });
    }
  }

  return cases;
}
