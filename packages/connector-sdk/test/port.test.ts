import type { ActingFor, ApprovedAction, JsonObject, Risk, Scope } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, CONFORMANCE_KEY, conformanceVerifier, draftApprovedAction, sealApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  createConnectorActionPort,
  defineConnector,
  memoryReplayGuard,
  type ConnectionQuery,
  type ConnectorActionPortOptions,
  type CredentialRequest,
  type ResolvedConnection,
} from "../src/index.js";
import { mockFetch } from "../src/testing.js";
import { exampleNotes } from "./fixtures/example-notes.js";
import { notesBackend, type NotesBackend } from "./fixtures/notes-backend.js";

const SCOPES = ["notes.read", "notes.write"];
const TRUST = { audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() };
const testScope = (): Scope => ({ tenantId: "tenant-a", appId: "app-1", environmentId: "env-prod" });

interface Setup {
  backend: NotesBackend;
  queries: Array<{ scope: Scope; query: ConnectionQuery }>;
  credentialRequests: CredentialRequest[];
  port: ReturnType<typeof createConnectorActionPort>;
}

function setup(overrides: Partial<ConnectorActionPortOptions> & { resolve?: (query: ConnectionQuery) => ResolvedConnection | null } = {}): Setup {
  const backend = notesBackend();
  const queries: Setup["queries"] = [];
  const credentialRequests: CredentialRequest[] = [];
  const { resolve, ...rest } = overrides;
  const port = createConnectorActionPort({
    ...TRUST,
    connectors: [exampleNotes],
    connections: (scope, query) => {
      queries.push({ scope, query });
      return resolve ? resolve(query) : { connectionId: "conn-business-notes", grantedScopes: SCOPES, subjectId: null };
    },
    credentials: {
      headers: (request) => {
        credentialRequests.push(request);
        return { authorization: "Bearer test-token" };
      },
    },
    fetch: backend.fetch,
    ...rest,
  });
  return { backend, queries, credentialRequests, port };
}

/** What a test varies about a call: who it is for and when it ends. */
interface CallContext {
  scope: Scope;
  /** The run's person as `domain:id`. */
  subjectId: string | null;
  actingFor: ActingFor;
  deadline: number;
}

/** What a test varies about the action itself. */
interface CallRequest {
  purpose: "run" | "compensate" | "reconcile";
  action: string;
  connection: string;
  effect: "read" | "write";
  input: JsonObject;
  idempotent: boolean;
  timeoutMs: number;
  risk: Risk;
}

function context(overrides: Partial<CallContext> = {}): CallContext {
  return { scope: testScope(), subjectId: "visitor:v-1", actingFor: "business", deadline: Date.now() + 10_000, ...overrides };
}

function request(action: string, input: JsonObject, overrides: Partial<CallRequest> = {}): CallRequest {
  const write = action.endsWith(".create") || action.endsWith(".delete");
  return { purpose: "run", action, connection: "notes", effect: write ? "write" : "read", input, idempotent: write, timeoutMs: 5000, risk: "none", ...overrides };
}

/** The signed envelope of a call, its effect `eff-1` and idempotency key `key-eff-1`. */
function envelope(ctx: CallContext, req: CallRequest): ApprovedAction {
  const colon = ctx.subjectId?.indexOf(":") ?? -1;
  const subject = ctx.subjectId === null ? null : { domain: ctx.subjectId.slice(0, colon), id: ctx.subjectId.slice(colon + 1) };
  const draft = draftApprovedAction({
    action: req.action,
    effect: req.effect,
    input: req.input,
    now: ctx.deadline - req.timeoutMs,
    timeoutMs: req.timeoutMs,
    purpose: req.purpose,
    risk: req.risk,
    idempotent: req.idempotent,
    role: req.connection,
    actingFor: ctx.actingFor,
    subject,
    scope: ctx.scope,
    effectId: "eff-1",
    runId: "run-1",
    approval: null,
    key: null,
  });
  const { proof: _proof, ...unsigned } = { ...draft, idempotencyKey: "key-eff-1" };
  return sealApprovedAction(unsigned, CONFORMANCE_KEY);
}

/** Sends a call to a port as its signed envelope. */
function call(port: { run(approved: ApprovedAction): Promise<unknown> }, ctx: CallContext, req: CallRequest) {
  return port.run(envelope(ctx, req));
}

describe("createConnectorActionPort", () => {
  it("runs an operation and passes the connection, key and credential through", async () => {
    const s = setup();
    const outcome = await call(s.port, context(), request("example-notes.create", { title: "Hello", body: "World" }));
    expect(outcome).toEqual({ status: "ok", output: expect.objectContaining({ id: "n-0001", title: "Hello", body: "World" }) });
    expect(s.queries).toEqual([{ scope: testScope(), query: { role: "notes", actingFor: "business", subjectId: "visitor:v-1", connectorId: "example-notes", environment: "production" } }]);
    expect(s.credentialRequests).toEqual([expect.objectContaining({ scope: testScope(), connectorId: "example-notes", connectionId: "conn-business-notes", auth: exampleNotes.auth })]);
    expect(s.backend.fetch.calls[0]!.headers).toMatchObject({ authorization: "Bearer test-token", "idempotency-key": "key-eff-1" });
  });

  it.each([
    ["an unknown connector", "other.create"],
    ["an unknown operation", "example-notes.archive"],
    ["no operation", "example-notes"],
  ])("refuses %s as final", async (_name, action) => {
    const s = setup();
    expect(await call(s.port, context(), request(action, {}))).toMatchObject({ status: "final", error: { code: "connect/unknown-action" } });
    expect(s.queries).toHaveLength(0);
  });

  it("refuses a write the flow declares as a read, and a false idempotency claim", async () => {
    const s = setup();
    expect(await call(s.port, context(), request("example-notes.create", { title: "x" }, { effect: "read" }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await call(s.port, context(), request("example-notes.get", { id: "n-1" }, { purpose: "compensate", effect: "write", idempotent: true }))).toMatchObject({
      status: "final",
      error: { code: "connect/effect-mismatch" },
    });
    const once = defineConnector({ ...exampleNotes, id: "notes-once", operations: { ...exampleNotes.operations, create: { ...exampleNotes.operations.create!, idempotent: false } } });
    const port = createConnectorActionPort({ ...TRUST, connectors: [once], connections: () => ({ connectionId: "c", grantedScopes: SCOPES }), credentials: { headers: () => ({}) }, fetch: mockFetch(), replayGuard: memoryReplayGuard() });
    expect(await call(port, context(), request("notes-once.create", { title: "x" }, { idempotent: true }))).toMatchObject({ status: "final", error: { code: "connect/idempotency-mismatch" } });
    expect(s.backend.fetch.calls).toHaveLength(0);
  });

  it("refuses invalid input before looking up a connection", async () => {
    const s = setup();
    expect(await call(s.port, context(), request("example-notes.create", { title: 5 }))).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    expect(s.queries).toHaveLength(0);
  });

  describe("connections", () => {
    it("refuses when no connection is bound to the role", async () => {
      const s = setup({ resolve: () => null });
      expect(await call(s.port, context(), request("example-notes.get", { id: "n-1" }))).toEqual({
        status: "final",
        error: { code: "connect/no-connection", message: 'No Example Notes connection is set up for "notes".' },
      });
      expect(s.backend.fetch.calls).toHaveLength(0);
    });

    it("asks for consent again when a required scope is missing", async () => {
      const s = setup({ resolve: () => ({ connectionId: "conn-old", grantedScopes: ["notes.read"], subjectId: null }) });
      expect(await call(s.port, context(), request("example-notes.get", { id: "n-1" }))).toEqual({
        status: "final",
        error: { code: "connect/reconsent", message: "The Example Notes connection must be authorised again to allow: notes.write." },
      });
      expect(s.credentialRequests).toHaveLength(0);
      expect(s.backend.fetch.calls).toHaveLength(0);
    });

    it("binds endUser actions to the person's own connection", async () => {
      const s = setup({ resolve: (q) => (q.subjectId ? { connectionId: `conn-${q.subjectId}`, grantedScopes: SCOPES, subjectId: q.subjectId } : null) });
      s.backend.seed("Mine");
      const outcome = await call(s.port, context({ actingFor: "endUser", subjectId: "member:m-7" }), request("example-notes.get", { id: "n-0001" }));
      expect(outcome).toMatchObject({ status: "ok", output: { title: "Mine" } });
      expect(s.queries[0]!.query).toEqual({ role: "notes", actingFor: "endUser", subjectId: "member:m-7", connectorId: "example-notes", environment: "production" });
      expect(s.credentialRequests[0]!.connectionId).toBe("conn-member:m-7");
    });

    it("refuses an endUser action without a person, or with someone else's connection", async () => {
      const someoneElse = setup({ resolve: () => ({ connectionId: "conn-x", grantedScopes: SCOPES, subjectId: "member:other" }) });
      expect(await call(someoneElse.port, context({ actingFor: "endUser", subjectId: null }), request("example-notes.get", { id: "n-1" }))).toMatchObject({
        status: "final",
        error: { code: "connect/no-subject" },
      });
      expect(someoneElse.queries).toHaveLength(0);
      expect(await call(someoneElse.port, context({ actingFor: "endUser", subjectId: "member:m-7" }), request("example-notes.get", { id: "n-1" }))).toMatchObject({
        status: "final",
        error: { code: "connect/not-own-connection" },
      });
      const unowned = setup({ resolve: () => ({ connectionId: "conn-x", grantedScopes: SCOPES }) });
      expect(await call(unowned.port, context({ actingFor: "endUser", subjectId: "member:m-7" }), request("example-notes.get", { id: "n-1" }))).toMatchObject({
        status: "final",
        error: { code: "connect/not-own-connection" },
      });
    });

    it("refuses a business action on a person's connection", async () => {
      const s = setup({ resolve: () => ({ connectionId: "conn-x", grantedScopes: SCOPES, subjectId: "member:m-7" }) });
      expect(await call(s.port, context(), request("example-notes.get", { id: "n-1" }))).toMatchObject({ status: "final", error: { code: "connect/not-own-connection" } });
    });

    it("treats resolver and credential failures as not applied", async () => {
      const errors: string[] = [];
      const broken = setup({
        resolve: () => {
          throw new Error("db down");
        },
        observer: { error: (_e, where) => errors.push(where) },
      });
      expect(await call(broken.port, context(), request("example-notes.create", { title: "x" }))).toMatchObject({ status: "retryable", error: { code: "connect/resolver-error" } });
      expect(errors).toEqual(["connector-port:connections"]);

      const expired = setup({
        credentials: {
          headers: () => {
            throw ConnectorError.final("connect/reauthorize", "The account must be connected again.");
          },
        },
      });
      expect(await call(expired.port, context(), request("example-notes.create", { title: "x" }))).toMatchObject({ status: "final", error: { code: "connect/reauthorize" } });
      const flaky = setup({
        credentials: {
          headers: async () => {
            throw new Error("vault timeout");
          },
        },
      });
      expect(await call(flaky.port, context(), request("example-notes.create", { title: "x" }))).toMatchObject({ status: "retryable", error: { code: "connect/credential-unavailable" } });
      expect(flaky.backend.fetch.calls).toHaveLength(0);
    });

    it("rejects a malformed resolver answer", async () => {
      const s = setup({ resolve: () => ({ connectionId: "", grantedScopes: "all" }) as unknown as ResolvedConnection });
      expect(await call(s.port, context(), request("example-notes.get", { id: "n-1" }))).toMatchObject({ status: "final", error: { code: "connect/no-connection" } });
    });
  });

  it("never throws", async () => {
    const s = setup({
      clock: {
        now: () => {
          throw new Error("clock broke");
        },
      },
    });
    await expect(call(s.port, context(), request("example-notes.create", { title: "x" }))).resolves.toMatchObject({ status: "unknown", error: { code: "connect/internal" } });
    await expect(call(s.port, context(), request("example-notes.get", { id: "n-1" }))).resolves.toMatchObject({ status: "retryable", error: { code: "connect/internal" } });
    await expect(s.port.run(null as unknown as ApprovedAction)).resolves.toMatchObject({ status: "unknown" });
  });

  it("measures the deadline on the given clock", async () => {
    let now = 11_000;
    const s = setup({ clock: { now: () => now } });
    expect(await call(s.port, context({ deadline: 10_000 }), request("example-notes.list", {}))).toMatchObject({ status: "retryable", error: { code: "connect/late" } });
    now = 5_000;
    expect(await call(s.port, context({ deadline: 10_000 }), request("example-notes.list", {}))).toMatchObject({ status: "ok" });
  });

  it("refuses to be built with an invalid or duplicated connector", () => {
    const options = { ...TRUST, connections: () => null, credentials: { headers: () => ({}) } };
    expect(() => createConnectorActionPort({ ...options, connectors: [exampleNotes, exampleNotes] })).toThrow(/listed twice/);
    expect(() => createConnectorActionPort({ ...options, connectors: [{ ...exampleNotes, id: "Bad" }] })).toThrow(/invalid-id/);
    // Nor without knowing whom it serves and whose envelopes to believe.
    expect(() => createConnectorActionPort({ ...options, audience: "", connectors: [exampleNotes] })).toThrow(/audience/);
    expect(() => createConnectorActionPort({ ...options, verifier: undefined as never, connectors: [exampleNotes] })).toThrow(/verifier/);
  });

  it("refuses to serve a write that does not de-duplicate without a replay guard, unless told it is unsafe", async () => {
    const options = { ...TRUST, connections: () => ({ connectionId: "c", grantedScopes: SCOPES, subjectId: null }), credentials: { headers: () => ({}) } };
    const once = defineConnector({ ...exampleNotes, id: "notes-once", operations: { ...exampleNotes.operations, create: { ...exampleNotes.operations.create!, idempotent: false } } });
    expect(() => createConnectorActionPort({ ...options, connectors: [exampleNotes, once] })).toThrow(/needs a replayGuard: "notes-once.create"/);
    expect(() => createConnectorActionPort({ ...options, connectors: [once], unsafeAllowReplays: false })).toThrow(/replayGuard/);
    // Every write de-duplicates: nothing to guard.
    expect(() => createConnectorActionPort({ ...options, connectors: [exampleNotes] })).not.toThrow();
    expect(() => createConnectorActionPort({ ...options, connectors: [once], replayGuard: memoryReplayGuard() })).not.toThrow();
    // The opt-out does what it says: a replayed envelope is performed again.
    const backend = notesBackend();
    const port = createConnectorActionPort({ ...options, credentials: { headers: () => ({ authorization: "Bearer test-token" }) }, connectors: [once], fetch: backend.fetch, unsafeAllowReplays: true });
    const env = draftApprovedAction({ action: "notes-once.create", effect: "write", input: { title: "Twice" }, now: Date.now(), role: "notes", subject: null });
    expect(await port.run(env)).toMatchObject({ status: "ok" });
    expect(await port.run(env)).toMatchObject({ status: "ok" });
    // Sent to the service twice (this service happens to de-duplicate on the key; one that does not would act twice).
    expect(backend.fetch.calls).toHaveLength(2);
  });
});
