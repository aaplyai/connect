/**
 * The kit's side of the Connect context (ADR-0002, amended): completion
 * windows, request signing, the environment kind, contract-version discovery
 * and the traceparent.
 */
import { createHash } from "node:crypto";
import { ENVIRONMENT_KINDS, operationDigest, type ApprovedAction, type EnvironmentKind, type JsonObject } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, actionPortConformance, conformanceVerifier, draftApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  createConnectorActionPort,
  defineConnector,
  manifestDigest,
  manifestOf,
  operationContractOf,
  validateConnector,
  validateManifest,
  type ConnectionQuery,
  type ConnectorActionPortOptions,
  type ConnectorDefinition,
  type CredentialRequest,
  type DeferredAction,
  type FetchLike,
  type SignRequest,
} from "../src/index.js";
import { mockFetch, testConnector } from "../src/testing.js";
import { exampleNotes } from "./fixtures/example-notes.js";
import { notesBackend } from "./fixtures/notes-backend.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7);
const clock = { now: () => NOW };
const TRUST = { audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() };
const JOBS = "https://api.example.com/v1/jobs";

const envelope = (action: string, effect: "read" | "write", input: JsonObject, over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}): ApprovedAction =>
  draftApprovedAction({ action, effect, input, now: NOW, role: null, subject: null, ...(effect === "write" ? { idempotent: true } : {}), ...over });

/** A service that finishes its jobs later; `start` declares how long it may take when `windowMs` is given. */
function jobsDefinition(windowMs?: unknown): ConnectorDefinition {
  return {
    id: "example-jobs",
    version: "1.0.0",
    title: "Example Jobs",
    auth: { kind: "none" },
    egress: ["POST api.example.com/v1/jobs"],
    operations: {
      start: {
        title: "Start a job",
        effect: "write",
        idempotent: true,
        input: { type: "object" },
        output: { type: "object" },
        ...(windowMs !== undefined ? { completion: { windowMs } as { windowMs: number } } : {}),
        async handler(_input, ctx) {
          const res = await ctx.http({ method: "POST", url: JOBS, json: {} });
          return ctx.defer(String((res.ensureOk().json() as { id: string }).id));
        },
      },
    },
  };
}

function jobsPort(windowMs: number | undefined, deferred: NonNullable<ConnectorActionPortOptions["deferred"]>) {
  return createConnectorActionPort({
    ...TRUST,
    connectors: [defineConnector(jobsDefinition(windowMs))],
    connections: () => ({ connectionId: "conn-jobs", grantedScopes: [], subjectId: null }),
    credentials: { headers: () => ({}) },
    fetch: mockFetch({ [`POST ${JOBS}`]: { json: { id: "job-7" } } }),
    clock,
    deferred,
  });
}

describe("a declared completion window", () => {
  it("leaves every existing manifest and operation digest as it was", () => {
    expect(manifestDigest(manifestOf(exampleNotes))).toBe("sha256:587bc3933f41254a228fe10bf74cea1155310ed9111ff1b59dc3d4170f67b6e8");
    const digests = Object.fromEntries(["list", "get", "create", "delete"].map((op) => [op, operationDigest(operationContractOf(exampleNotes, op)!)]));
    expect(digests).toEqual({
      list: "sha256:3b6961cefbc71f0d8fee72aab295b2254292b2bc43518122f0d816c11629ece4",
      get: "sha256:3cd8ef2d0c864cafd71cf331a802126ddc467f2a539d2c9d97ddb6e6bb23871b",
      create: "sha256:bcbb9f602f181e96c304e2d25035c79aa7242f8c2ab411f409948b7e6ad54829",
      delete: "sha256:0d3781485bf2c7d505ef7b88270b909fbcd2f1054f5887b07895a17f0833b6c5",
    });
  });

  it("is carried in the manifest and the operation contract only when declared", () => {
    const plain = defineConnector(jobsDefinition());
    const windowed = defineConnector(jobsDefinition(DAY));
    expect(manifestOf(plain).operations.start).not.toHaveProperty("completion");
    expect(operationContractOf(plain, "start")).not.toHaveProperty("completion");
    expect(manifestOf(windowed).operations.start!.completion).toEqual({ windowMs: DAY });
    expect(operationContractOf(windowed, "start")!.completion).toEqual({ windowMs: DAY });
    expect(operationDigest(operationContractOf(windowed, "start")!)).not.toBe(operationDigest(operationContractOf(plain, "start")!));
    expect(Object.isFrozen(windowed.operations.start!.completion)).toBe(true);
  });

  it("is refused when it is not a whole number of milliseconds up to 30 days", () => {
    for (const windowMs of [0, -5, 1.5, 30 * DAY + 1, "1d"]) {
      const found = validateConnector(jobsDefinition(windowMs)).map((d) => `${d.code}@${d.path}`);
      expect(found).toEqual(["connector/invalid-field@operations.start.completion"]);
    }
    expect(validateConnector(jobsDefinition(30 * DAY))).toEqual([]);
    expect(validateConnector(jobsDefinition(0))[0]).toMatchObject({ pointer: "/operations/start/completion", hint: expect.stringContaining("windowMs") });
  });

  it("is given to the host's deferred sink, which keeps the deferral that long", async () => {
    for (const windowMs of [undefined, DAY]) {
      const got: DeferredAction[] = [];
      const port = jobsPort(windowMs, (d) => void got.push(d));
      expect(await port.run(envelope("example-jobs.start", "write", {}))).toEqual({ status: "pending", ref: "job-7" });
      if (windowMs === undefined) expect(got[0]).not.toHaveProperty("windowMs");
      else expect(got[0]!.windowMs).toBe(DAY);
    }
  });
});

// ---------------------------------------------------------------------------
// The request-signing hook
// ---------------------------------------------------------------------------

const STORE = "https://store.example.com";
const hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** What the service received: method, url, headers and the exact body bytes. */
interface Received {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/** A service that checks each request's signature over what it received, and answers per path. */
function signedService(answer: (r: Received, n: number) => { status: number; headers?: Record<string, string>; json?: unknown } = () => ({ status: 200, json: { ok: true } })) {
  const received: Received[] = [];
  const fetch: FetchLike = async (url, init) => {
    const raw = init.body;
    const body = raw === undefined || raw === null ? null : raw instanceof Uint8Array ? new Uint8Array(raw) : new TextEncoder().encode(String(raw));
    const r: Received = { method: init.method ?? "GET", url, headers: Object.fromEntries(new Headers(init.headers).entries()), body };
    received.push(r);
    const a = answer(r, received.length);
    return new Response(a.json !== undefined ? JSON.stringify(a.json) : null, { status: a.status, headers: { ...(a.json !== undefined ? { "content-type": "application/json" } : {}), ...a.headers } });
  };
  return { fetch, received };
}

/** The signature this test's signer computes: over method, url, the signed headers and the body. */
function signatureOf(method: string, url: string, headers: Readonly<Record<string, string>>, body: Uint8Array | null): string {
  const signed = Object.keys(headers).filter((name) => name !== "x-test-signature").sort();
  const lines = [method, url, ...signed.map((name) => `${name}:${headers[name]}`), body === null ? "-" : hex(body)];
  return hex(lines.join("\n"));
}

/** True when what the service received carries a signature over exactly what it received. */
function verifies(r: Received): boolean {
  const { "x-test-signature": signature, ...rest } = r.headers;
  // Only the headers the signer saw are signed: the ones fetch adds itself are not (none here).
  return signature === signatureOf(r.method, r.url, rest, r.body);
}

const objects = defineConnector({
  id: "example-store",
  version: "1.0.0",
  title: "Example Store",
  auth: { kind: "apiKey", hosts: ["store.example.com"] },
  egress: ["PUT store.example.com/objects/*", "GET store.example.com/objects/*", "GET elsewhere.example.com/*"],
  operations: {
    put: {
      title: "Put an object",
      effect: "write",
      idempotent: true,
      input: { type: "object", properties: { text: { type: "string" }, bytes: { type: "boolean" } }, required: ["text"] },
      output: { type: "object" },
      async handler(input: { text: string; bytes?: boolean }, ctx) {
        if (!input.bytes) return (await ctx.http({ method: "PUT", url: `${STORE}/objects/a`, body: input.text })).ensureOk().json() as JsonObject;
        const buffer = new TextEncoder().encode(input.text);
        const sending = ctx.http({ method: "PUT", url: `${STORE}/objects/a`, headers: { "content-type": "application/octet-stream" }, body: buffer });
        // The handler changes its buffer once the request is made: nothing sent changes.
        buffer.fill(0x21);
        return (await sending).ensureOk().json() as JsonObject;
      },
    },
    get: {
      title: "Get an object",
      effect: "read",
      input: { type: "object" },
      output: { type: "object" },
      async handler(_input, ctx) {
        return (await ctx.http({ url: `${STORE}/objects/a?v=1` })).ensureOk().json() as JsonObject;
      },
    },
  },
});

function storePort(service: ReturnType<typeof signedService>, sign: (request: SignRequest) => unknown, refresh?: () => Record<string, string>) {
  const seen: SignRequest[] = [];
  const port = createConnectorActionPort({
    ...TRUST,
    connectors: [objects],
    connections: () => ({ connectionId: "conn-store", grantedScopes: [], subjectId: null }),
    credentials: {
      headers: () => ({ "x-access-key": "AKID-1" }),
      ...(refresh ? { refresh } : {}),
      sign: (request) => {
        seen.push(request);
        return sign(request) as Record<string, string>;
      },
    },
    fetch: service.fetch,
    clock,
  });
  return { port, seen };
}

const honest = (request: SignRequest) => ({ "x-test-signature": signatureOf(request.method, request.url, request.headers, request.body) });

describe("the request-signing hook", () => {
  it("signs the exact bytes that are sent, after the body and the credential are final", async () => {
    for (const bytes of [false, true]) {
      const service = signedService();
      const { port, seen } = storePort(service, honest);
      expect(await port.run(envelope("example-store.put", "write", { text: "héllo, wörld", bytes }))).toMatchObject({ status: "ok" });
      expect(service.received).toHaveLength(1);
      const [r] = service.received;
      expect(verifies(r!)).toBe(true);
      // The body sent is the handler's bytes as they were when it made the request.
      expect(new TextDecoder().decode(r!.body!)).toBe("héllo, wörld");
      expect(r!.headers["x-access-key"]).toBe("AKID-1");
      expect(r!.headers["content-type"]).toBe(bytes ? "application/octet-stream" : "text/plain;charset=UTF-8");
      // The signer saw whose credential and the request as sent.
      expect(seen[0]).toMatchObject({ scope: expect.any(Object), connectorId: "example-store", connectionId: "conn-store", auth: { kind: "apiKey", hosts: ["store.example.com"] }, method: "PUT", url: `${STORE}/objects/a` });
      expect(seen[0]!.headers["x-access-key"]).toBe("AKID-1");
    }
  });

  it("sends the bytes it signed even when the signer changes its copy", async () => {
    const service = signedService();
    const { port } = storePort(service, (request) => {
      const headers = honest(request);
      request.body!.fill(0);
      return headers;
    });
    expect(await port.run(envelope("example-store.put", "write", { text: "abc", bytes: true }))).toMatchObject({ status: "ok" });
    expect(verifies(service.received[0]!)).toBe(true);
    expect(new TextDecoder().decode(service.received[0]!.body!)).toBe("abc");
  });

  it("signs the resend after a refresh afresh, with the refreshed credential", async () => {
    const service = signedService((_r, n) => (n === 1 ? { status: 401 } : { status: 200, json: { ok: true } }));
    const { port, seen } = storePort(service, honest, () => ({ "x-access-key": "AKID-2" }));
    expect(await port.run(envelope("example-store.get", "read", {}))).toMatchObject({ status: "ok" });
    expect(seen.map((s) => s.headers["x-access-key"])).toEqual(["AKID-1", "AKID-2"]);
    expect(service.received.map(verifies)).toEqual([true, true]);
    expect(service.received[1]!.headers["x-access-key"]).toBe("AKID-2");
  });

  it("signs each same-origin redirect hop afresh, and never sends a signature to another origin", async () => {
    const service = signedService((r) =>
      r.url.endsWith("/objects/a?v=1")
        ? { status: 302, headers: { location: `${STORE}/objects/b` } }
        : r.url.endsWith("/objects/b")
          ? { status: 302, headers: { location: "https://elsewhere.example.com/x" } }
          : { status: 200, json: { ok: true } },
    );
    const { port, seen } = storePort(service, honest);
    expect(await port.run(envelope("example-store.get", "read", {}))).toMatchObject({ status: "ok" });
    expect(seen.map((s) => s.url)).toEqual([`${STORE}/objects/a?v=1`, `${STORE}/objects/b`]);
    expect(service.received.map((r) => r.url)).toEqual([`${STORE}/objects/a?v=1`, `${STORE}/objects/b`, "https://elsewhere.example.com/x"]);
    expect(service.received.slice(0, 2).map(verifies)).toEqual([true, true]);
    expect(service.received[2]!.headers).not.toHaveProperty("x-test-signature");
    expect(service.received[2]!.headers).not.toHaveProperty("x-access-key");
  });

  it("answers with the signer's ConnectorError, and sign-failed for anything else it throws", async () => {
    const cases: Array<[() => never, object]> = [
      [() => { throw ConnectorError.final("store/no-key", "The signing key was revoked."); }, { status: "final", error: { code: "store/no-key" } }],
      [() => { throw new Error("kms down"); }, { status: "retryable", error: { code: "connect/sign-failed" } }],
    ];
    for (const [sign, expected] of cases) {
      const service = signedService();
      const { port } = storePort(service, sign);
      expect(await port.run(envelope("example-store.get", "read", {}))).toMatchObject(expected);
      expect(service.received).toEqual([]);
    }
  });

  it("refuses headers that are not strings or that the platform sets, and sends nothing", async () => {
    for (const answer of [null, "sig", [["a", "b"]], { "x-test-signature": 5 }, { Host: "evil.example.com" }, { "content-length": "1" }, { "bad header": "x" }]) {
      const service = signedService();
      const { port } = storePort(service, () => answer);
      expect(await port.run(envelope("example-store.get", "read", {}))).toMatchObject({ status: "final", error: { code: "connect/credential-invalid" } });
      expect(service.received).toEqual([]);
    }
  });

  it("is not called for a connector with no credential, nor for a request sent without one", async () => {
    const service = signedService();
    let calls = 0;
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [defineConnector(jobsDefinition())],
      connections: () => ({ connectionId: "conn-jobs", grantedScopes: [], subjectId: null }),
      credentials: { headers: () => ({}), sign: () => (calls++, {}) },
      fetch: async () => new Response(JSON.stringify({ id: "job-1" }), { status: 200, headers: { "content-type": "application/json" } }),
      clock,
      deferred: () => undefined,
    });
    expect(await port.run(envelope("example-jobs.start", "write", {}))).toMatchObject({ status: "pending" });
    expect(calls).toBe(0);
    expect(service.received).toEqual([]);
  });

  it("is available to connector tests through testConnector", async () => {
    const service = signedService();
    const tester = testConnector(objects, { fetch: service.fetch, credentials: { "x-access-key": "AKID-T" }, sign: (request) => honest({ ...request } as SignRequest) });
    expect(await tester.call("put", { text: "x" })).toMatchObject({ status: "ok" });
    expect(verifies(service.received[0]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The environment kind reaches the connection
// ---------------------------------------------------------------------------

describe("the environment kind", () => {
  const SCOPES = ["notes.read", "notes.write"];
  /** A notes port whose one connection declares `kind` (undefined: declares none). */
  function notesPort(kind: EnvironmentKind | undefined | "staging") {
    const backend = notesBackend();
    const queries: ConnectionQuery[] = [];
    const credentialRequests: CredentialRequest[] = [];
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [exampleNotes],
      connections: (_scope, q) => {
        queries.push(q);
        return { connectionId: "conn-notes", grantedScopes: SCOPES, subjectId: null, ...(kind !== undefined ? { environment: kind as EnvironmentKind } : {}) };
      },
      credentials: {
        headers: (r) => {
          credentialRequests.push(r);
          return { authorization: "Bearer test-token" };
        },
      },
      fetch: backend.fetch,
      clock,
    });
    return { backend, port, queries, credentialRequests };
  }
  const list = (environment: EnvironmentKind) => envelope("example-notes.list", "read", {}, { role: "notes", environment });

  it("is in the resolver's query and the credential request", async () => {
    for (const kind of ENVIRONMENT_KINDS) {
      const t = notesPort(kind);
      expect(await t.port.run(list(kind))).toMatchObject({ status: "ok" });
      expect(t.queries[0]!.environment).toBe(kind);
      expect(t.credentialRequests[0]!.environment).toBe(kind);
    }
  });

  it("refuses a connection of another kind before anything is sent, and an undeclared one is production", async () => {
    for (const declared of [...ENVIRONMENT_KINDS, undefined]) {
      for (const call of ENVIRONMENT_KINDS) {
        const t = notesPort(declared);
        const outcome = await t.port.run(list(call));
        if (call === (declared ?? "production")) expect(outcome).toMatchObject({ status: "ok" });
        else {
          expect(outcome).toMatchObject({ status: "final", error: { code: "connect/environment-mismatch" } });
          expect(t.backend.fetch.calls).toHaveLength(0);
          expect(t.credentialRequests).toHaveLength(0);
        }
      }
    }
  });

  it("finds no usable connection when the resolver answers a kind that is not one", async () => {
    const t = notesPort("staging");
    expect(await t.port.run(list("production"))).toMatchObject({ status: "final", error: { code: "connect/no-connection" } });
  });

  it("passes the conformance case for a port whose connections are preview ones", async () => {
    const t = notesPort("preview");
    const seeded = t.backend.seed("Hello");
    const cases = actionPortConformance(t.port, { read: { action: "example-notes.get", input: { id: seeded.id }, role: "notes" }, environment: "preview", performed: () => t.backend.fetch.calls.length, now: clock.now });
    const env = cases.find((c) => c.name === "refuses a connection that serves another kind of environment")!;
    await env.run();
    for (const c of cases) await c.run();
  });
});

describe("contract-version discovery", () => {
  it("describes the versions the kit's port serves", () => {
    const port = createConnectorActionPort({ ...TRUST, connectors: [exampleNotes], connections: () => null, credentials: { headers: () => ({}) }, fetch: mockFetch(), clock });
    expect(port.describe()).toEqual({ contracts: [1] });
    expect(actionPortConformance(port, { read: { action: "example-notes.list", input: {} } }).map((c) => c.name)).toContain("describes the contract versions it serves, and refuses one it does not");
  });
});

// ---------------------------------------------------------------------------
// The traceparent
// ---------------------------------------------------------------------------

describe("the traceparent", () => {
  const T1 = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const PING = "https://api.example.com/v1/ping";
  const MINE = "00-11111111111111111111111111111111-2222222222222222-01";

  /** A connector whose handler reports what it was given and calls its service; `own` sets the header itself. */
  function tracedDefinition(propagateTrace?: unknown): ConnectorDefinition {
    return {
      id: "example-traced",
      version: "1.0.0",
      title: "Example Traced",
      auth: { kind: "none" },
      egress: ["GET api.example.com/v1/ping"],
      ...(propagateTrace !== undefined ? { propagateTrace: propagateTrace as boolean } : {}),
      operations: {
        ping: {
          title: "Ping",
          effect: "read",
          input: { type: "object", properties: { own: { type: "boolean" } } },
          output: { type: "object" },
          async handler(input: { own?: boolean }, ctx) {
            await ctx.http({ url: PING, ...(input.own ? { headers: { traceparent: MINE } } : {}) });
            return { trace: ctx.traceparent ?? null, keys: Object.keys(ctx).sort() };
          },
        },
      },
    };
  }
  function tracedPort(propagateTrace?: boolean) {
    const service = signedService();
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [defineConnector(tracedDefinition(propagateTrace))],
      connections: () => ({ connectionId: "conn-traced", grantedScopes: [], subjectId: null }),
      credentials: { headers: () => ({}) },
      fetch: service.fetch,
      clock,
    });
    return { port, service };
  }
  const ping = (traceparent?: unknown, input: JsonObject = {}) =>
    envelope("example-traced.ping", "read", input, traceparent !== undefined ? { traceparent: traceparent as string } : {});
  const outputOf = (outcome: unknown) => (outcome as { status: "ok"; output: { trace: string | null; keys: string[] } }).output;

  it("reaches the handler as ctx.traceparent only when the envelope carries a well-formed one", async () => {
    const { port } = tracedPort();
    const plain = outputOf(await port.run(ping()));
    expect(plain.trace).toBeNull();
    expect(plain.keys).not.toContain("traceparent");
    expect(outputOf(await port.run(ping(T1)))).toEqual({ trace: T1, keys: [...plain.keys, "traceparent"].sort() });
    // A malformed one is ignored, never refused: the handler sees exactly what it sees without one.
    for (const bad of ["nope", T1.toUpperCase(), `ff${T1.slice(2)}`, 7]) expect(outputOf(await port.run(ping(bad)))).toEqual(plain);
  });

  it("is sent to the service only by a connector that opts in, and a handler's own header wins", async () => {
    for (const propagateTrace of [undefined, false]) {
      const { port, service } = tracedPort(propagateTrace);
      await port.run(ping(T1));
      expect(service.received[0]!.headers).not.toHaveProperty("traceparent");
    }
    const { port, service } = tracedPort(true);
    await port.run(ping(T1));
    await port.run(ping());
    await port.run(ping("nope"));
    await port.run(ping(T1, { own: true }));
    expect(service.received.map((r) => r.headers.traceparent ?? null)).toEqual([T1, null, null, MINE]);
  });

  it("is carried in the manifest only when true, so every existing manifest is unchanged", () => {
    const plain = manifestOf(defineConnector(tracedDefinition()));
    expect(plain).not.toHaveProperty("propagateTrace");
    expect(manifestOf(defineConnector(tracedDefinition(false)))).toEqual(plain);
    expect(defineConnector(tracedDefinition(false))).not.toHaveProperty("propagateTrace");
    const opted = manifestOf(defineConnector(tracedDefinition(true)));
    expect(opted.propagateTrace).toBe(true);
    expect(manifestDigest(opted)).not.toBe(manifestDigest(plain));
    expect(validateManifest(opted)).toEqual([]);
    expect(validateManifest(plain)).toEqual([]);
    const fault = (found: { code: string; path: string }[]) => found.map((d) => `${d.code}@${d.path}`);
    for (const bad of ["yes", 1, null]) {
      expect(fault(validateConnector(tracedDefinition(bad)))).toEqual(["connector/invalid-field@propagateTrace"]);
      expect(fault(validateManifest({ ...plain, propagateTrace: bad }))).toEqual(["connector/invalid-field@propagateTrace"]);
    }
    // A manifest says it only when true.
    expect(fault(validateManifest({ ...plain, propagateTrace: false }))).toEqual(["connector/invalid-field@propagateTrace"]);
    // Located, with the mechanical fix.
    expect(validateConnector(tracedDefinition("yes"))).toEqual([
      { code: "connector/invalid-field", severity: "error", path: "propagateTrace", pointer: "/propagateTrace", message: "propagateTrace is true or false", hint: "Set `propagateTrace` to `true` or `false`, or remove it." },
    ]);
  });

  it("is signed with the request when a signer is configured", async () => {
    const service = signedService();
    const seen: SignRequest[] = [];
    const traced = defineConnector({ ...tracedDefinition(true), auth: { kind: "apiKey", hosts: ["api.example.com"] } });
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [traced],
      connections: () => ({ connectionId: "conn-traced", grantedScopes: [], subjectId: null }),
      credentials: { headers: () => ({ "x-access-key": "AKID-1" }), sign: (request) => (seen.push(request), honest(request)) },
      fetch: service.fetch,
      clock,
    });
    expect(await port.run(ping(T1))).toMatchObject({ status: "ok" });
    expect(seen[0]!.headers.traceparent).toBe(T1);
    expect(verifies(service.received[0]!)).toBe(true);
  });

  it("reaches the handler from testConnector", async () => {
    const tester = testConnector(defineConnector(tracedDefinition(true)), { routes: { [`GET ${PING}`]: { json: {} } } });
    expect(await tester.run("ping", {}, { traceparent: T1 })).toMatchObject({ trace: T1 });
    expect(await tester.run("ping", {})).toMatchObject({ trace: null });
    expect(tester.mock!.calls.map((c) => c.headers.traceparent ?? null)).toEqual([T1, null]);
  });
});
