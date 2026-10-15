import { MAX_ACTION_OUTPUT_BYTES, hmacSha256, safeEqual, toHex, hmacActionVerifier, operationDigest, sha256Digest, type ApprovedAction, type JsonObject } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, actionPortConformance, conformanceVerifier, draftApprovedAction, sealApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  createConnectorActionPort,
  defineConnector,
  deferredKey,
  handleWebhook,
  type WebhookRequest,
  manifestOf,
  memoryReplayGuard,
  operationContractOf,
  operationContracts,
  replayKey,
  type ConnectorActionPortOptions,
  type DeferredAction,
  type OperationContext,
  type ReplayGuard,
  validateConnector,
  validateManifest,
  type ConnectorDefinition,
} from "../src/index.js";
import { mockFetch, testConnector } from "../src/testing.js";
import { NOTES_API, exampleNotes } from "./fixtures/example-notes.js";
import { notesBackend } from "./fixtures/notes-backend.js";

const SCOPES = ["notes.read", "notes.write"];
const NOW = Date.UTC(2026, 9, 7);
const clock = { now: () => NOW };
/** The audience and verifier every port here is built with; drafts are signed for them. */
const TRUST = { audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() };

function notesPort(overrides: Partial<ConnectorActionPortOptions> = {}) {
  const backend = notesBackend();
  const port = createConnectorActionPort({
    ...TRUST,
    connectors: [exampleNotes],
    connections: () => ({ connectionId: "conn-notes", grantedScopes: SCOPES, subjectId: null }),
    credentials: { headers: () => ({ authorization: "Bearer test-token" }) },
    fetch: backend.fetch,
    clock,
    ...overrides,
  });
  return { backend, port };
}

const pin = (op: string) => operationDigest(operationContractOf(exampleNotes, op)!);
const envelope = (action: string, effect: "read" | "write", input: JsonObject, over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}): ApprovedAction =>
  draftApprovedAction({ action, effect, input, now: NOW, role: "notes", subject: null, ...(effect === "write" ? { idempotent: true } : {}), ...over });

describe("the connector kit's port and the approved-action contract", () => {
  it("passes the action port conformance suite", async () => {
    const { backend, port } = notesPort();
    const seeded = backend.seed("Hello");
    const cases = actionPortConformance(port, {
      read: { action: "example-notes.get", input: { id: seeded.id }, role: "notes", contract: pin("get") },
      write: { action: "example-notes.create", input: { title: "Hi" }, role: "notes", idempotent: true },
      performed: () => backend.fetch.calls.length,
      now: clock.now,
    });
    for (const c of cases) await c.run();
    // The well-formed read, the read with a malformed traceparent, and the read sent again after a version refusal.
    expect(backend.fetch.calls).toHaveLength(3);
  });

  it("performs a pinned, reviewed write and refuses a pin it does not serve", async () => {
    const { backend, port } = notesPort();
    const ok = await port.run(envelope("example-notes.create", "write", { title: "Pinned" }, { contract: pin("create") }));
    expect(ok).toMatchObject({ status: "ok", output: { title: "Pinned" } });
    const stale = await port.run(envelope("example-notes.create", "write", { title: "Stale" }, { contract: sha256Digest({ old: true }) }));
    expect(stale).toMatchObject({ status: "final", error: { code: "connect/contract-mismatch" } });
    expect(backend.fetch.calls).toHaveLength(1);
  });

  it("refuses a write whose review is below the operation's risk floor", async () => {
    const guarded = defineConnector({ ...exampleNotes, id: "guarded-notes", operations: { ...exampleNotes.operations, create: { ...exampleNotes.operations.create!, riskFloor: "approval" } } });
    const backend = notesBackend();
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [guarded],
      connections: () => ({ connectionId: "c", grantedScopes: SCOPES, subjectId: null }),
      credentials: { headers: () => ({ authorization: "Bearer test-token" }) },
      fetch: backend.fetch,
      clock,
    });
    for (const risk of ["none", "confirm"] as const) {
      expect(await port.run(envelope("guarded-notes.create", "write", { title: "x" }, { risk }))).toMatchObject({ status: "final", error: { code: "connect/approval-invalid" } });
    }
    expect(await port.run(envelope("guarded-notes.create", "write", { title: "x" }, { risk: "approval" }))).toMatchObject({ status: "ok" });
    expect(backend.fetch.calls).toHaveLength(1);
  });

  it("describes each operation as an operation contract", () => {
    const contracts = operationContracts([exampleNotes]);
    expect(Object.keys(contracts).sort()).toEqual(["example-notes.create", "example-notes.delete", "example-notes.get", "example-notes.list"]);
    expect(contracts["example-notes.create"]).toMatchObject({ effect: "write", idempotent: true, irreversible: false, compensate: "example-notes.delete", riskFloor: "none" });
    expect(operationContractOf(exampleNotes, "archive")).toBeNull();
    expect(pin("create")).toBe(operationDigest(contracts["example-notes.create"]!));
  });
});

// ---------------------------------------------------------------------------
// Undos and checks
// ---------------------------------------------------------------------------

describe("undos and checks", () => {
  // Payments: a payout someone else must approve, which does not de-duplicate, and a
  // refund that undoes a charge but is itself reviewed.
  const PAY = "https://api.pay.test/v1";
  const pay = defineConnector({
    id: "pay",
    version: "1.0.0",
    title: "Pay",
    auth: { kind: "none" },
    egress: [`POST api.pay.test/v1/*`, `GET api.pay.test/v1/*`],
    operations: {
      reserve: { title: "Reserve", effect: "write", compensate: "release", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/reservations` })).ensureOk().json() },
      release: { title: "Release", effect: "write", idempotent: true, input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/releases` })).ensureOk().json() },
      charge: { title: "Charge", effect: "write", compensate: "refund", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/charges` })).ensureOk().json() },
      refund: { title: "Refund", effect: "write", idempotent: true, riskFloor: "approval", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/refunds` })).ensureOk().json() },
      hold: { title: "Hold", effect: "write", compensate: "unhold", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/holds` })).ensureOk().json() },
      unhold: { title: "Unhold", effect: "write", irreversible: true, input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/unholds` })).ensureOk().json() },
      payout: { title: "Pay out", effect: "write", irreversible: true, riskFloor: "approval", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/payouts` })).ensureOk().json() },
      status: { title: "Status", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ url: `${PAY}/status` })).ensureOk().json() },
    },
  });
  const payPort = () => {
    const fetch = mockFetch({ [`POST ${PAY}/*`]: { json: { ok: true } }, [`GET ${PAY}/*`]: { json: { applied: false } } });
    const port = createConnectorActionPort({ ...TRUST, replayGuard: memoryReplayGuard(clock), connectors: [pay], connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }), credentials: { headers: () => ({}) }, fetch, clock });
    return { fetch, port };
  };
  // The write each undo is declared for; an operation no write declares is sent as the charge's.
  const UNDONE: Record<string, string> = { release: "pay.reserve", refund: "pay.charge", unhold: "pay.hold" };
  // As the engine sends an undo: unreviewed, marked as safe to send again, and naming the write it undoes.
  const undo = (op: string, over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}) =>
    envelope(`pay.${op}`, "write", {}, { role: null, purpose: "compensate", risk: "none", approval: null, idempotent: true, undoes: UNDONE[op] ?? "pay.charge", ...over });

  it("performs a declared undo that de-duplicates and needs no review", async () => {
    const { fetch, port } = payPort();
    expect(await port.run(undo("release"))).toMatchObject({ status: "ok" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("refuses an undo with an operation that is not one, does not de-duplicate, or needs a review, sending nothing", async () => {
    const { fetch, port } = payPort();
    expect(await port.run(undo("payout"))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await port.run(undo("reserve"))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await port.run(undo("unhold"))).toMatchObject({ status: "final", error: { code: "connect/idempotency-mismatch" } });
    expect(await port.run(undo("refund"))).toMatchObject({ status: "final", error: { code: "connect/approval-invalid" } });
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses a declared undo sent for a write that declares another, or for none", async () => {
    const { fetch, port } = payPort();
    // release is the reservation's undo, not the charge's (whose undo is refund).
    expect(await port.run(undo("release", { undoes: "pay.charge" }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await port.run(undo("release", { undoes: "pay.status" }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await port.run(undo("release", { undoes: "notes.create" }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(fetch.calls).toHaveLength(0);
    expect(await port.run(undo("release"))).toMatchObject({ status: "ok" });
  });

  it("refuses an undo whose envelope states a review or no de-duplication", async () => {
    const { fetch, port } = payPort();
    // What the engine states when it knows the undo's own contract.
    expect(await port.run(undo("refund", { risk: "approval" }))).toMatchObject({ status: "final", error: { code: "connect/approval-invalid" } });
    expect(await port.run(undo("unhold", { idempotent: false }))).toMatchObject({ status: "final", error: { code: "connect/idempotency-mismatch" } });
    expect(fetch.calls).toHaveLength(0);
  });

  it("passes the conformance suite's undo cases", async () => {
    const { fetch, port } = payPort();
    const cases = actionPortConformance(port, {
      read: { action: "pay.status", input: {}, role: null },
      undos: [
        { action: "pay.release", input: {}, role: null, undoes: "pay.reserve", undoOnly: false },
        { action: "pay.refund", input: {}, role: null, undoes: "pay.charge", risk: "approval", undoOnly: false },
        { action: "pay.unhold", input: {}, role: null, undoes: "pay.hold", idempotent: false, undoOnly: false },
      ],
      performed: () => fetch.calls.length,
      now: clock.now,
    });
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining(["refuses a declared undo that needs a review", "refuses a declared undo that does not de-duplicate", "refuses an undo sent for a write that does not declare it"]),
    );
    for (const c of cases) await c.run();
  });

  it("refuses a check that is a write, and an undo or check with no target", async () => {
    const { fetch, port } = payPort();
    expect(await port.run(envelope("pay.release", "read", {}, { role: null, purpose: "reconcile" }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await port.run(envelope("pay.release", "write", {}, { role: null, purpose: "reconcile", idempotent: true }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(await port.run(undo("release", { target: null }))).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
    expect(await port.run(envelope("pay.status", "read", {}, { role: null, purpose: "reconcile" }))).toMatchObject({ status: "ok" });
    expect(fetch.callsTo(`POST ${PAY}/*`)).toHaveLength(0);
  });
});

describe("an undo-only operation", () => {
  // A page store whose removeCreated trashes the page one create made: bound to that page only when it is create's undo.
  const PAGES = "https://api.pages.test/v1";
  const pages = (undoOnly: boolean) =>
    defineConnector({
      id: "pages",
      version: "1.0.0",
      title: "Pages",
      auth: { kind: "none" },
      egress: [`POST api.pages.test/v1/*`, `GET api.pages.test/v1/*`],
      operations: {
        create: { title: "Create", effect: "write", compensate: "removeCreated", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAGES}/pages` })).ensureOk().json() },
        removeCreated: {
          title: "Remove a created page",
          effect: "write",
          idempotent: true,
          undoOnly,
          input: { type: "object", required: ["pageId", "createdTime"], properties: { pageId: { type: "string" }, createdTime: { type: "string" } } },
          output: { type: "object" },
          handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${PAGES}/trash` })).ensureOk().json(),
        },
        get: { title: "Get", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ url: `${PAGES}/pages` })).ensureOk().json() },
      },
    });
  const pagesPort = (undoOnly = true) => {
    const fetch = mockFetch({ [`POST ${PAGES}/*`]: { json: { ok: true } }, [`GET ${PAGES}/*`]: { json: { id: "p-1" } } });
    const port = createConnectorActionPort({ ...TRUST, replayGuard: memoryReplayGuard(clock), connectors: [pages(undoOnly)], connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }), credentials: { headers: () => ({}) }, fetch, clock });
    return { fetch, port };
  };
  const input = { pageId: "p-1", createdTime: "2026-10-07T00:00:00.000Z" };

  it("is refused as a step, sending nothing, and performed as the undo of its write", async () => {
    const { fetch, port } = pagesPort();
    expect(await port.run(envelope("pages.removeCreated", "write", input, { role: null }))).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(fetch.calls).toHaveLength(0);
    expect(await port.run(envelope("pages.removeCreated", "write", input, { role: null, purpose: "compensate", risk: "none", approval: null, undoes: "pages.create" }))).toMatchObject({ status: "ok" });
    expect(fetch.callsTo(`POST ${PAGES}/trash`)).toHaveLength(1);
    // Without the marker the same operation is also a step, as before.
    const open = pagesPort(false);
    expect(await open.port.run(envelope("pages.removeCreated", "write", input, { role: null }))).toMatchObject({ status: "ok" });
  });

  it("carries the marker in its manifest and operation contract, and so in its pin", () => {
    expect(manifestOf(pages(true)).operations.removeCreated!.undoOnly).toBe(true);
    expect("undoOnly" in manifestOf(pages(false)).operations.removeCreated!).toBe(false);
    expect(operationContractOf(pages(true), "removeCreated")!.undoOnly).toBe(true);
    expect("undoOnly" in operationContractOf(pages(false), "removeCreated")!).toBe(false);
    expect(operationDigest(operationContractOf(pages(true), "removeCreated")!)).not.toBe(operationDigest(operationContractOf(pages(false), "removeCreated")!));
  });

  it("must be some operation's undo, and a write", () => {
    const codes = (ops: Record<string, unknown>) => validateConnector({ id: "x", version: "1.0.0", title: "X", auth: { kind: "none" }, egress: ["POST api.x.test/*"], operations: ops }).map((d) => `${d.severity}:${d.code}@${d.path}`);
    const h = async () => ({});
    const obj = { type: "object" };
    expect(codes({ trash: { title: "T", effect: "write", idempotent: true, undoOnly: true, input: obj, output: obj, handler: h } })).toEqual(["error:connector/undo-only-undeclared@operations.trash.undoOnly"]);
    expect(codes({ peek: { title: "P", effect: "read", undoOnly: true, input: obj, output: obj, handler: h } })).toEqual(["error:connector/read-with-write-option@operations.peek.undoOnly"]);
    expect(codes({ trash: { title: "T", effect: "write", idempotent: true, undoOnly: "yes", input: obj, output: obj, handler: h } })).toEqual(["error:connector/invalid-field@operations.trash.undoOnly"]);
    // An undo-only operation that cannot be an undo either is usable nowhere.
    const make = { title: "M", effect: "write", compensate: "trash", input: obj, output: obj, handler: h };
    expect(codes({ make, trash: { title: "T", effect: "write", irreversible: true, undoOnly: true, input: obj, output: obj, handler: h } })).toEqual(["error:connector/compensate-not-idempotent@operations.make.compensate"]);
    expect(codes({ make, trash: { title: "T", effect: "write", idempotent: true, riskFloor: "confirm", undoOnly: true, input: obj, output: obj, handler: h } })).toEqual(["error:connector/compensate-reviewed@operations.make.compensate"]);
  });

  it("passes the conformance suite's undo-only case", async () => {
    const { fetch, port } = pagesPort();
    const cases = actionPortConformance(port, {
      read: { action: "pages.get", input: {}, role: null },
      undos: [{ action: "pages.removeCreated", input, role: null, undoes: "pages.create", undoOnly: true }],
      performed: () => fetch.calls.length,
      now: clock.now,
    });
    expect(cases.map((c) => c.name)).toContain("refuses an undo-only operation sent as a step");
    for (const c of cases) await c.run();
  });
});

// ---------------------------------------------------------------------------
// ctx.defer
// ---------------------------------------------------------------------------

const JOBS = "https://api.example.com/v1/jobs";
let seen: OperationContext | null = null;
const jobs = defineConnector({
  id: "example-jobs",
  version: "1.0.0",
  title: "Example Jobs",
  auth: { kind: "none" },
  egress: ["POST api.example.com/v1/jobs", "GET api.example.com/v1/jobs/*"],
  operations: {
    start: {
      title: "Start a job",
      effect: "write",
      idempotent: true,
      input: { type: "object", properties: { swallow: { type: "boolean" }, ref: { type: "string" } } },
      output: { type: "object" },
      async handler(input: { swallow?: boolean; ref?: string }, ctx) {
        seen = ctx;
        const res = await ctx.http({ method: "POST", url: JOBS, headers: { "idempotency-key": ctx.idempotencyKey }, json: {} });
        const id = input.ref ?? String((res.ensureOk().json() as { id: string }).id);
        if (!input.swallow) ctx.defer(id);
        try {
          ctx.defer(id);
        } catch {
          // Catching the throw changes nothing: the call is pending.
        }
        return { ignored: true };
      },
    },
    report: {
      title: "Make a report",
      effect: "read",
      input: { type: "object" },
      output: { type: "object" },
      handler(_input, ctx) {
        return ctx.defer("report-1");
      },
    },
  },
});

function jobsPort(deferred?: ConnectorActionPortOptions["deferred"], errors: unknown[] = []) {
  const fetch = mockFetch({ [`POST ${JOBS}`]: { json: { id: "job-7" } } });
  const port = createConnectorActionPort({
    ...TRUST,
    connectors: [jobs],
    connections: () => ({ connectionId: "conn-jobs", grantedScopes: [], subjectId: null }),
    credentials: { headers: () => ({}) },
    fetch,
    clock,
    ...(deferred ? { deferred } : {}),
    observer: { error: (error) => errors.push(error) },
  });
  return { port, fetch };
}

describe("ctx.defer", () => {
  it("answers pending with the service's reference, and gives the host the completion token, never the handler", async () => {
    const got: DeferredAction[] = [];
    const { port } = jobsPort((d) => {
      got.push(d);
    });
    const a = envelope("example-jobs.start", "write", {}, { role: null });
    expect(await port.run(a)).toEqual({ status: "pending", ref: "job-7" });
    expect(got).toEqual([
      { scope: a.scope, runId: "run-conformance", effectId: a.effectId, attempt: 1, action: "example-jobs.start", purpose: "run", connector: "example-jobs", connectionId: "conn-jobs", ref: "job-7", token: a.completion!.token },
    ]);
    const token = got[0]!.token;
    expect(Object.keys(seen!).sort()).toEqual(["blobs", "connection", "deadline", "defer", "http", "idempotencyKey", "log", "signal"]);
    expect(JSON.stringify(seen)).not.toContain(token);
  });

  it("names the connection, so a report is matched to its own account's call, never by ref alone", async () => {
    // Two people, each with their own account at the same service, whose references collide.
    const held = new Map<string, DeferredAction>();
    const fetch = mockFetch({ [`POST ${JOBS}`]: { json: { id: "job-7" } } });
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [jobs],
      connections: (_scope, q) => ({ connectionId: `conn-${q.subjectId}`, grantedScopes: [], subjectId: q.subjectId }),
      credentials: { headers: () => ({}) },
      fetch,
      clock,
      deferred: (d) => {
        held.set(deferredKey(d), d);
      },
    });
    const ann = envelope("example-jobs.start", "write", {}, { role: null, actingFor: "endUser", subject: { domain: "visitor", id: "ann" } });
    const bob = envelope("example-jobs.start", "write", {}, { role: null, actingFor: "endUser", subject: { domain: "visitor", id: "bob" } });
    expect(await port.run(ann)).toEqual({ status: "pending", ref: "job-7" });
    expect(await port.run(bob)).toEqual({ status: "pending", ref: "job-7" });
    expect(held.size).toBe(2);
    // Bob's account reports job-7: only Bob's call is completed with it.
    const report = held.get(deferredKey({ scope: bob.scope, connector: "example-jobs", connectionId: "conn-visitor:bob", ref: "job-7" }))!;
    expect(report).toMatchObject({ connectionId: "conn-visitor:bob", effectId: bob.effectId, token: bob.completion!.token });
    expect(held.get(deferredKey({ scope: ann.scope, connector: "example-jobs", connectionId: "conn-visitor:ann", ref: "job-7" }))!.token).toBe(ann.completion!.token);
    // The key is scoped too.
    expect(deferredKey({ ...report, scope: { ...report.scope, tenantId: "other" } })).not.toBe(deferredKey(report));
  });

  it("stays pending when the handler swallows the throw", async () => {
    const { port } = jobsPort(() => undefined);
    expect(await port.run(envelope("example-jobs.start", "write", { swallow: true }, { role: null }))).toEqual({ status: "pending", ref: "job-7" });
  });

  it("answers unknown for a write and retryable for a read when nobody can complete it", async () => {
    const errors: unknown[] = [];
    const noSink = jobsPort();
    expect(await noSink.port.run(envelope("example-jobs.start", "write", {}, { role: null }))).toMatchObject({ status: "unknown", error: { code: "connect/no-completion" } });
    expect(await noSink.port.run(envelope("example-jobs.report", "read", {}, { role: null }))).toMatchObject({ status: "retryable", error: { code: "connect/no-completion" } });
    const failing = jobsPort(() => {
      throw new Error("queue down");
    }, errors);
    expect(await failing.port.run(envelope("example-jobs.start", "write", {}, { role: null }))).toMatchObject({ status: "unknown", error: { code: "connect/no-completion" } });
    expect(errors).toHaveLength(1);
  });

  it("treats a malformed reference as a handler failure", async () => {
    const { port } = jobsPort(() => undefined);
    expect(await port.run(envelope("example-jobs.start", "write", { ref: "has space" }, { role: null }))).toMatchObject({ status: "unknown", error: { code: "connect/handler-error" } });
  });

  it("shows up in the test kit as pending", async () => {
    const tester = testConnector(jobs, { routes: { [`POST ${JOBS}`]: { json: { id: "job-9" } } } });
    expect(await tester.call("start", {})).toEqual({ status: "pending", ref: "job-9" });
  });
});

describe("the notes service through the contract", () => {
  it("reads a note through an envelope", async () => {
    const { backend, port } = notesPort();
    const n = backend.seed("Hello", "World");
    expect(await port.run(envelope("example-notes.get", "read", { id: n.id }))).toMatchObject({ status: "ok", output: { id: n.id, title: "Hello" } });
    expect(backend.fetch.calls[0]!.url).toBe(`${NOTES_API}/${n.id}`);
  });
});

// ---------------------------------------------------------------------------
// Authentication, freshness and replay (the envelope is a grant)
// ---------------------------------------------------------------------------

describe("an envelope is a grant, so the port believes only a signed, fresh, first delivery", () => {
  const PAY = "https://api.pay.test/v1";
  const payments = defineConnector({
    id: "pay",
    version: "1.0.0",
    title: "Payments",
    auth: { kind: "apiKey" },
    egress: [`POST api.pay.test/v1/charges`, `POST api.pay.test/v1/refunds`],
    operations: {
      // A charge needs someone else's approval and does not de-duplicate.
      charge: {
        title: "Charge",
        effect: "write",
        irreversible: true,
        riskFloor: "approval",
        input: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } },
        output: { type: "object" },
        handler: async (input, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/charges`, json: input })).ensureOk().json(),
      },
      refund: {
        title: "Refund",
        effect: "write",
        idempotent: true,
        riskFloor: "approval",
        input: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } },
        output: { type: "object" },
        handler: async (input, ctx) => (await ctx.http({ method: "POST", url: `${PAY}/refunds`, json: input, headers: { "idempotency-key": ctx.idempotencyKey } })).ensureOk().json(),
      },
    },
  });
  function payPort(over: Partial<ConnectorActionPortOptions> = {}) {
    const fetch = mockFetch({ [`POST ${PAY}/charges`]: { json: { id: "ch-1" } }, [`POST ${PAY}/refunds`]: { json: { id: "re-1" } } });
    const tenants: string[] = [];
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [payments],
      connections: (scope) => (tenants.push(scope.tenantId), { connectionId: `conn-${scope.tenantId}`, grantedScopes: [], subjectId: null }),
      credentials: { headers: (r) => ({ authorization: `Bearer key-of-${r.connectionId}` }) },
      fetch,
      clock,
      replayGuard: memoryReplayGuard(clock),
      ...over,
    });
    return { fetch, port, tenants };
  }
  const charge = (over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}): ApprovedAction =>
    draftApprovedAction({ action: "pay.charge", effect: "write", input: { amount: 5000 }, now: NOW, risk: "approval", ...over });

  it("refuses evidence given for another action and run, whether or not the move was signed", async () => {
    const refund = draftApprovedAction({ action: "pay.refund", effect: "write", input: { amount: 5000 }, now: NOW, risk: "approval", idempotent: true });
    // The refund's evidence, on a charge of another run with equal input.
    const moved: ApprovedAction = { ...charge({ approval: refund.approval! }), origin: { ...refund.origin, runId: "another-run", name: "charge" } };
    const { fetch, port, tenants } = payPort();
    expect(await port.run(moved)).toMatchObject({ status: "final", error: { code: "connect/approval-invalid" } });
    // Even signed (an engine fooled into it), the evidence names what it covered.
    expect(await port.run(sealApprovedAction(moved))).toMatchObject({ status: "final", error: { code: "connect/approval-invalid" } });
    // Moving it with its own evidence to another run breaks the proof as well as the binding.
    const env = charge();
    expect(await port.run(sealApprovedAction({ ...env, origin: { ...env.origin, runId: "another-run" } }))).toMatchObject({ status: "final", error: { code: "connect/approval-invalid" } });
    expect(fetch.calls).toHaveLength(0);
    expect(tenants).toEqual([]);
  });

  it("refuses an envelope moved to another tenant or given a later deadline, before looking up any connection", async () => {
    const { fetch, port, tenants } = payPort();
    const env = charge();
    const tenYears = NOW + 10 * 365 * 24 * 3600_000;
    const rescoped: ApprovedAction = { ...env, scope: { tenantId: "tenant-b", appId: "app-b", environmentId: "env-b" }, environment: "production" };
    expect(await port.run(rescoped)).toMatchObject({ status: "final", error: { code: "connect/proof-invalid" } });
    const moved: ApprovedAction = { ...rescoped, deadline: tenYears };
    expect(await port.run(moved)).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
    // Signed by the engine's key, a deadline past its timeout is still not believed.
    expect(await port.run(sealApprovedAction(moved))).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
    expect(await port.run(sealApprovedAction({ ...moved, timeoutMs: tenYears - NOW }))).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
    expect(await port.run(sealApprovedAction({ ...moved, issuedAt: tenYears - env.timeoutMs }))).toMatchObject({ status: "retryable", error: { code: "connect/clock-skew" } });
    expect(fetch.calls).toHaveLength(0);
    expect(tenants).toEqual([]);
  });

  it("refuses an envelope for another performer, or signed under a key it does not hold", async () => {
    const { fetch, port } = payPort();
    expect(await port.run(charge({ audience: "another-performer" }))).toMatchObject({ status: "final", error: { code: "connect/wrong-audience" } });
    expect(await port.run(charge({ key: null }))).toMatchObject({ status: "final", error: { code: "connect/proof-invalid" } });
    const rotated = payPort({ verifier: hmacActionVerifier({ next: "n".repeat(32) }) });
    expect(await rotated.port.run(charge())).toMatchObject({ status: "final", error: { code: "connect/proof-invalid" } });
    expect(await rotated.port.run(charge({ key: { keyId: "next", secret: "n".repeat(32) } }))).toMatchObject({ status: "ok" });
    expect(fetch.calls).toHaveLength(0);
    // A verifier that cannot answer is not a reason to fail the action.
    const down = payPort({ verifier: { verify: () => Promise.reject(new Error("kms down")) } });
    expect(await down.port.run(charge())).toMatchObject({ status: "retryable", error: { code: "connect/unavailable" } });
    expect(down.fetch.calls).toHaveLength(0);
  });

  it("answers a missed deadline as retryable, apart from an expired approval", async () => {
    const { fetch, port } = payPort();
    expect(await port.run(charge({ now: NOW - 20_000, timeoutMs: 10_000 }))).toMatchObject({ status: "retryable", error: { code: "connect/late" } });
    const stale = charge({ approval: { ...charge().approval!, notAfter: NOW } });
    expect(await port.run(stale)).toMatchObject({ status: "final", error: { code: "connect/expired" } });
    expect(fetch.calls).toHaveLength(0);
  });

  it("performs one attempt of a write that does not de-duplicate once, however often it is delivered", async () => {
    const { fetch, port } = payPort({ replayGuard: memoryReplayGuard(clock) });
    const env = charge();
    expect(await port.run(env)).toMatchObject({ status: "ok" });
    // Final for this delivery; the engine records it for a write as unknown (handler-claims.test.ts).
    expect(await port.run(env)).toMatchObject({ status: "final", error: { code: "connect/replayed" } });
    // The next attempt is a new envelope, and is performed.
    expect(await port.run(charge({ attempt: 2 }))).toMatchObject({ status: "ok" });
    // The same effect id in another tenant is another effect.
    expect(await port.run(charge({ scope: { tenantId: "tenant-b", appId: "app-conformance", environmentId: "env-conformance" } }))).toMatchObject({ status: "ok" });
    expect(fetch.callsTo(`POST ${PAY}/charges`)).toHaveLength(3);
  });

  it("claims only writes that do not de-duplicate, last, with the deadline as the claim's end", async () => {
    const claims: Array<[string, number]> = [];
    const guard: ReplayGuard = { claim: (key, until) => (claims.push([key, until]), true) };
    const { port } = payPort({ replayGuard: guard });
    const refund = draftApprovedAction({ action: "pay.refund", effect: "write", input: { amount: 1 }, now: NOW, risk: "approval", idempotent: true });
    expect(await port.run(refund)).toMatchObject({ status: "ok" });
    expect(await port.run(refund)).toMatchObject({ status: "ok" });
    // A refusal before the claim leaves nothing claimed.
    expect(await port.run(charge({ input: { amount: "lots" } as unknown as JsonObject }))).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    expect(claims).toEqual([]);
    const env = charge();
    expect(await port.run(env)).toMatchObject({ status: "ok" });
    expect(claims).toEqual([[replayKey(env.scope, env.effectId, 1), env.deadline]]);
  });

  it("refuses, as retryable and sending nothing, when the replay guard cannot answer", async () => {
    const errors: unknown[] = [];
    const { fetch, port } = payPort({ replayGuard: { claim: () => Promise.reject(new Error("redis down")) }, observer: { error: (e) => errors.push(e) } });
    expect(await port.run(charge())).toMatchObject({ status: "retryable", error: { code: "connect/unavailable" } });
    expect(fetch.calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    // Anything but true is a replay.
    const odd = payPort({ replayGuard: { claim: () => "yes" as unknown as boolean } });
    expect(await odd.port.run(charge())).toMatchObject({ status: "final", error: { code: "connect/replayed" } });
    expect(odd.fetch.calls).toHaveLength(0);
  });

  it("a memory guard forgets a claim once its deadline has passed", () => {
    let now = 0;
    const guard = memoryReplayGuard({ now: () => now });
    expect(guard.claim("k", 10)).toBe(true);
    expect(guard.claim("k", 10)).toBe(false);
    now = 10;
    expect(guard.claim("k", 20)).toBe(true);
    // Expired keys are dropped as the map grows.
    for (let i = 0; i < 2000; i++) guard.claim(`x${i}`, now + 1);
    now = 100;
    expect(guard.claim("x0", 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Output size
// ---------------------------------------------------------------------------

describe("output size", () => {
  const MAIL = "https://api.mail.test/v1";
  const page = "y".repeat(4 * 1024 * 1024);
  const mail = defineConnector({
    id: "mail",
    version: "1.0.0",
    title: "Mail",
    auth: { kind: "none" },
    egress: ["GET api.mail.test/v1/messages", "POST api.mail.test/v1/drafts"],
    operations: {
      // Pages through the mailbox, keeping every page.
      list: {
        title: "List",
        effect: "read",
        input: { type: "object", properties: { pages: { type: "integer" } } },
        output: { type: "object" },
        async handler(input: { pages?: number }, ctx) {
          const pages: string[] = [];
          for (let i = 0; i < (input.pages ?? 6); i++) pages.push(((await ctx.http({ url: `${MAIL}/messages` })).ensureOk().json() as { page: string }).page.slice(0, 10));
          return { pages };
        },
      },
      dump: { title: "Dump", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: () => ({ raw: "z".repeat(MAX_ACTION_OUTPUT_BYTES) }) },
      draft: {
        title: "Draft",
        effect: "write",
        idempotent: true,
        input: { type: "object" },
        output: { type: "object" },
        async handler(_input, ctx) {
          await ctx.http({ method: "POST", url: `${MAIL}/drafts`, headers: { "idempotency-key": ctx.idempotencyKey } });
          return { raw: "z".repeat(MAX_ACTION_OUTPUT_BYTES) };
        },
      },
    },
  });
  function mailPort(over: Partial<ConnectorActionPortOptions> = {}) {
    const fetch = mockFetch({ [`GET ${MAIL}/messages`]: { json: { page } }, [`POST ${MAIL}/drafts`]: { json: { id: "d-1" } } });
    const logs: Array<{ event: string; fields: unknown }> = [];
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [mail],
      connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }),
      credentials: { headers: () => ({}) },
      fetch,
      clock,
      replayGuard: memoryReplayGuard(clock),
      log: (record) => {
        logs.push({ event: record.event, fields: record.fields });
      },
      ...over,
    });
    return { fetch, port, logs };
  }
  const call = (op: string, effect: "read" | "write", input: JsonObject = {}) => envelope(`mail.${op}`, effect, input, { role: null, ...(effect === "write" ? { idempotent: true } : {}) });

  it("bounds what one call reads in all, however many pages a handler asks for", async () => {
    const { fetch, port } = mailPort();
    expect(await port.run(call("list", "read", { pages: 3 }))).toMatchObject({ status: "ok" });
    // Each page is just over 4 MiB, so the fourth goes past the 16 MiB a call may read, and is never read whole.
    expect(await port.run(call("list", "read"))).toMatchObject({ status: "final", error: { code: "connect/response-too-large" } });
    expect(fetch.calls).toHaveLength(3 + 4);
    const lower = mailPort({ limits: { maxTotalResponseBytes: 5 * 1024 * 1024 } });
    expect(await lower.port.run(call("list", "read", { pages: 2 }))).toMatchObject({ status: "final", error: { code: "connect/response-too-large", message: expect.stringContaining("in all") } });
  });

  it("fails a read whose output is over the cap, and withholds a write's output, which stays applied, with a log record", async () => {
    const { fetch, port, logs } = mailPort();
    expect(await port.run(call("dump", "read"))).toMatchObject({ status: "final", error: { code: "connect/output-too-large" } });
    const bytes = JSON.stringify({ raw: "z".repeat(MAX_ACTION_OUTPUT_BYTES) }).length;
    expect(await port.run(call("draft", "write"))).toEqual({ status: "ok", output: null, withheld: { bytes } });
    expect(fetch.callsTo(`POST ${MAIL}/drafts`)).toHaveLength(1);
    expect(logs.filter((l) => l.event === "output.withheld")).toHaveLength(2);
    // A host may keep less.
    const small = mailPort({ maxOutputBytes: 30 });
    expect(await small.port.run(call("list", "read", { pages: 1 }))).toMatchObject({ status: "ok" });
    expect(await small.port.run(call("list", "read", { pages: 2 }))).toMatchObject({ status: "final", error: { code: "connect/output-too-large" } });
  });
});

// ---------------------------------------------------------------------------
// Rate limits name their bucket
// ---------------------------------------------------------------------------

describe("rate limits name their bucket", () => {
  const INBOX = "https://api.inbox.test/v1";
  const inbox = defineConnector({
    id: "inbox",
    version: "1.0.0",
    title: "Inbox",
    auth: { kind: "none" },
    egress: ["GET api.inbox.test/v1/*", "POST api.inbox.test/v1/*"],
    operations: {
      list: { title: "List", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ url: `${INBOX}/messages` })).ensureOk().json() },
      // The service says which quota it was: the whole app's.
      search: {
        title: "Search",
        effect: "read",
        input: { type: "object" },
        output: { type: "object" },
        async handler(_i, ctx) {
          const res = await ctx.http({ url: `${INBOX}/search` });
          if (res.status === 429) throw ConnectorError.retryable("inbox/app-quota", "The app's quota is used up.", { retryAfterMs: 60_000, limit: "connector" });
          return res.json();
        },
      },
      send: { title: "Send", effect: "write", irreversible: true, input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${INBOX}/send` })).ensureOk().json() },
    },
  });
  const limited = { status: 429, headers: { "retry-after": "30" } };
  function inboxPort() {
    const fetch = mockFetch({ [`GET ${INBOX}/*`]: limited, [`POST ${INBOX}/*`]: { status: 500 } });
    const port = createConnectorActionPort({
      ...TRUST,
      connectors: [inbox],
      connections: (_scope, q) => ({ connectionId: "c", grantedScopes: [], subjectId: q.actingFor === "endUser" ? q.subjectId : null }),
      credentials: { headers: () => ({}) },
      fetch,
      clock,
      replayGuard: memoryReplayGuard(clock),
    });
    return { fetch, port };
  }
  const forPerson = { role: null, actingFor: "endUser" as const, subject: { domain: "member", id: "m-1" } };

  it("pauses only a person's own connection on a 429, and leaves a business call's bucket to the lane", async () => {
    const { port } = inboxPort();
    expect(await port.run(envelope("inbox.list", "read", {}, forPerson))).toEqual({
      status: "retryable",
      error: { code: "http/429", message: "The service is rate limiting requests." },
      retryAfterMs: 30_000,
      limit: "connection",
    });
    const business = await port.run(envelope("inbox.list", "read", {}, { role: null }));
    expect(business).toMatchObject({ status: "retryable", error: { code: "http/429" }, retryAfterMs: 30_000 });
    expect(business).not.toHaveProperty("limit");
  });

  it("keeps the bucket a handler names, and names none for a write that may have happened", async () => {
    const { port } = inboxPort();
    expect(await port.run(envelope("inbox.search", "read", {}, forPerson))).toMatchObject({ status: "retryable", limit: "connector", retryAfterMs: 60_000 });
    const sent = await port.run(envelope("inbox.send", "write", {}, { ...forPerson, idempotent: false }));
    expect(sent).toMatchObject({ status: "unknown" });
    expect(sent).not.toHaveProperty("limit");
  });

  it("carries the bucket through ConnectorError, and only on a retryable failure", () => {
    const quota = ConnectorError.retryable("gmail/quota", "Per-user quota.", { retryAfterMs: 30_000, limit: "connection" });
    expect(quota.toOutcome()).toMatchObject({ status: "retryable", retryAfterMs: 30_000, limit: "connection" });
    expect(quota.withKind("unknown").toOutcome()).toEqual({ status: "unknown", error: { code: "gmail/quota", message: "Per-user quota." } });
    expect(new ConnectorError("final", "x/no", "No.", { limit: "connection" }).toOutcome()).toEqual({ status: "final", error: { code: "x/no", message: "No." } });
    expect(ConnectorError.retryable("x/slow", "Slow.", { limit: "everyone" as never }).toOutcome()).toEqual({ status: "retryable", error: { code: "x/slow", message: "Slow." } });
  });
});

describe("a connection's credential goes only to the hosts its connector names", () => {
  /** A notes service whose pages link to files on a storage host; the handler forgets `auth: false` for the file. */
  function notesWithFiles(auth: ConnectorDefinition["auth"]): ConnectorDefinition {
    return {
      id: "notes",
      version: "1.0.0",
      title: "Notes",
      auth,
      egress: ["GET api.notes.test/v1/pages/*", "GET files.storage.test/b/*"],
      operations: {
        attachment: {
          title: "Attachment",
          effect: "read",
          input: { type: "object", required: ["page"], properties: { page: { type: "string" } } },
          output: { type: "object" },
          async handler(input: { page: string }, ctx) {
            const page = (await ctx.http({ url: `https://api.notes.test/v1/pages/${input.page}` })).ensureOk().json() as { file: string };
            const file = await ctx.http({ url: page.file });
            return { size: file.body.length };
          },
        },
      },
    } as ConnectorDefinition;
  }
  const files = () =>
    mockFetch({
      "GET https://api.notes.test/v1/pages/*": { json: { file: "https://files.storage.test/b/abc?sig=1" } },
      "GET https://files.storage.test/b/*": { body: "PDF..." },
    });
  const codes = (def: unknown) => validateConnector(def).map((d) => `${d.severity}:${d.code}@${d.path}`);

  it("is refused when the egress names several hosts and the definition does not say which get it", () => {
    expect(() => defineConnector(notesWithFiles({ kind: "oauth2", scopes: ["read"] }))).toThrow(/invalid/);
    expect(codes(notesWithFiles({ kind: "oauth2", scopes: ["read"] }))).toEqual(["error:connector/auth-hosts-required@auth"]);
    expect(codes(notesWithFiles({ kind: "apiKey" }))).toEqual(["error:connector/auth-hosts-required@auth"]);
    // A connector that sends no credential has nothing to say.
    expect(codes(notesWithFiles({ kind: "none" }))).toEqual([]);
  });

  it("never sends the user's token to the file host, even when a handler forgets auth: false", async () => {
    const fetch = files();
    const t = testConnector(defineConnector(notesWithFiles({ kind: "oauth2", scopes: ["read"], hosts: ["api.notes.test"] })), { fetch, credentials: { authorization: "Bearer USER-OAUTH-TOKEN" } });
    expect(await t.call("attachment", { page: "p1" })).toEqual({ status: "ok", output: { size: 6 } });
    expect(fetch.callsTo("GET https://api.notes.test/v1/pages/*")[0]!.headers.authorization).toBe("Bearer USER-OAUTH-TOKEN");
    expect(fetch.callsTo("GET https://files.storage.test/b/*")[0]!.headers.authorization).toBeUndefined();
    expect(t.logs.filter((l) => l.event === "http.no-credential").map((l) => l.fields)).toEqual([{ host: "files.storage.test" }]);
  });

  it("takes the one host a single-host egress names, and only that host", async () => {
    const one = defineConnector({ ...notesWithFiles({ kind: "apiKey" }), egress: ["GET api.notes.test/v1/pages/*"] });
    const fetch = mockFetch({ "GET https://api.notes.test/v1/pages/*": { json: { file: "https://api.notes.test/v1/pages/f" } } });
    const t = testConnector(one, { fetch, credentials: { "x-api-key": "k" } });
    await t.call("attachment", { page: "p1" });
    expect(fetch.calls.map((c) => c.headers["x-api-key"])).toEqual(["k", "k"]);
    // A single wildcard host is not implied: it must be named.
    expect(codes({ ...notesWithFiles({ kind: "apiKey" }), egress: ["GET *.notes.test/v1/pages/*"] })).toEqual(["error:connector/auth-hosts-required@auth"]);
  });

  it("matches a wildcard host on its subdomains only", async () => {
    const def = { ...notesWithFiles({ kind: "apiKey", hosts: ["*.notes.test"] }), egress: ["GET *.notes.test/v1/pages/*", "GET files.storage.test/b/*"] };
    expect(codes(def)).toEqual([]);
    const fetch = mockFetch({ "GET https://eu.notes.test/v1/pages/*": { json: { file: "https://files.storage.test/b/x" } }, "GET https://files.storage.test/b/*": { body: "x" } });
    const connector = defineConnector({
      ...def,
      operations: {
        attachment: {
          ...def.operations.attachment!,
          async handler(_input, ctx) {
            const page = (await ctx.http({ url: "https://eu.notes.test/v1/pages/p" })).json() as { file: string };
            return { size: (await ctx.http({ url: page.file })).body.length };
          },
        },
      },
    });
    const t = testConnector(connector, { fetch, credentials: { "x-api-key": "k" } });
    await t.call("attachment", { page: "p" });
    expect(fetch.calls.map((c) => [new URL(c.url).hostname, c.headers["x-api-key"]])).toEqual([
      ["eu.notes.test", "k"],
      ["files.storage.test", undefined],
    ]);
  });

  it("checks each host: well formed, listed once, and allowed by the egress", () => {
    const at = (hosts: unknown) => codes({ ...notesWithFiles({ kind: "apiKey" }), auth: { kind: "apiKey", hosts } });
    expect(at(["files.storage.test", "api.notes.test"])).toEqual([]);
    expect(at(["api.other.test"])).toEqual(["error:connector/auth-host-not-in-egress@auth.hosts[0]"]);
    expect(at(["*.notes.test"])).toEqual(["error:connector/auth-host-not-in-egress@auth.hosts[0]"]);
    for (const bad of ["https://api.notes.test", "api.notes.test:443", "api.notes.test/v1", "API.notes.test", "127.0.0.1", "localhost", "", "*.test", "a b.test", 7]) {
      expect(at([bad])).toEqual(["error:connector/invalid-auth@auth.hosts[0]"]);
    }
    expect(at(["api.notes.test", "api.notes.test"])).toEqual(["error:connector/invalid-auth@auth.hosts[1]"]);
    for (const list of [[], "api.notes.test", Array.from({ length: 21 }, (_, i) => `h${i}.notes.test`)]) expect(at(list)).toEqual(["error:connector/invalid-auth@auth.hosts"]);
    expect(codes({ ...notesWithFiles({ kind: "none" }), auth: { kind: "none", hosts: ["api.notes.test"] } })).toEqual(["error:connector/unknown-field@auth.hosts"]);
  });

  it("is part of the manifest when declared, and checked there too", () => {
    const declared = manifestOf(defineConnector(notesWithFiles({ kind: "oauth2", scopes: ["read"], hosts: ["api.notes.test"] })));
    expect(declared.auth).toEqual({ kind: "oauth2", scopes: ["read"], hosts: ["api.notes.test"] });
    expect(validateManifest(declared)).toEqual([]);
    const { hosts: _hosts, ...without } = declared.auth as { hosts: string[] };
    expect(validateManifest({ ...declared, auth: without }).map((d) => d.code)).toEqual(["connector/auth-hosts-required"]);
    // Left out on a single-host connector, the manifest is as before.
    expect(manifestOf(defineConnector({ ...notesWithFiles({ kind: "apiKey" }), egress: ["GET api.notes.test/v1/pages/*"] })).auth).toEqual({ kind: "apiKey" });
  });
});

describe("an expired token is refreshed once", () => {
  const API = "https://api.notes.test/v1/notes";
  /** A notes service that accepts only `Bearer fresh`; a write that is not idempotent, so a replay would be visible. */
  const notes = defineConnector({
    id: "notes",
    version: "1.0.0",
    title: "Notes",
    auth: { kind: "oauth2", scopes: ["notes"] },
    egress: ["GET api.notes.test/v1/notes", "POST api.notes.test/v1/notes"],
    operations: {
      list: { title: "List", effect: "read", input: { type: "object" }, output: {}, handler: async (_i, ctx) => (await ctx.http({ url: API })).ensureOk().json() },
      add: { title: "Add", effect: "write", irreversible: true, input: { type: "object" }, output: {}, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: API, json: { t: 1 } })).ensureOk().json() },
      twice: {
        title: "Twice",
        effect: "read",
        input: { type: "object" },
        output: {},
        async handler(_i, ctx) {
          const first = await ctx.http({ url: API });
          const second = await ctx.http({ url: API });
          return [first.status, second.status];
        },
      },
    },
  });
  function refreshingPort(options: { refreshTo?: string; refresh?: boolean; failRefresh?: unknown } = {}) {
    const accepted = (r: { headers: Record<string, string> }) => r.headers.authorization === "Bearer fresh";
    const fetch = mockFetch({
      [`GET ${API}`]: (r) => (accepted(r) ? { json: ["n1"] } : { status: 401 }),
      [`POST ${API}`]: (r) => (accepted(r) ? { json: { id: "n2" } } : { status: 401 }),
    });
    let refreshes = 0;
    const credentials = {
      headers: () => ({ authorization: "Bearer stale" }),
      ...(options.refresh === false
        ? {}
        : {
            refresh: () => {
              refreshes++;
              if (options.failRefresh !== undefined) throw options.failRefresh;
              return { authorization: `Bearer ${options.refreshTo ?? "fresh"}` };
            },
          }),
    };
    const port = createConnectorActionPort({ ...TRUST, connectors: [notes], connections: () => ({ connectionId: "c", grantedScopes: ["notes"], subjectId: null }), credentials, fetch, clock, replayGuard: memoryReplayGuard(clock) });
    return { port, fetch, refreshes: () => refreshes };
  }
  const call = (action: string, effect: "read" | "write") => envelope(`notes.${action}`, effect, {}, { role: null, ...(effect === "write" ? { idempotent: false } : {}) });

  it("on a 401, then sends the request once more with the new token", async () => {
    const t = refreshingPort();
    expect(await t.port.run(call("list", "read"))).toEqual({ status: "ok", output: ["n1"] });
    expect(t.refreshes()).toBe(1);
    expect(t.fetch.calls.map((c) => c.headers.authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("sends a write again after a 401, which was not applied, and only once", async () => {
    const t = refreshingPort();
    expect(await t.port.run(call("add", "write"))).toEqual({ status: "ok", output: { id: "n2" } });
    expect(t.fetch.calls.map((c) => `${c.method} ${c.headers.authorization}`)).toEqual(["POST Bearer stale", "POST Bearer fresh"]);
  });

  it("answers a second 401 as final, and never refreshes twice in one call", async () => {
    const t = refreshingPort({ refreshTo: "still-wrong" });
    expect(await t.port.run(call("add", "write"))).toMatchObject({ status: "final", error: { code: "http/401" } });
    expect(t.refreshes()).toBe(1);
    expect(t.fetch.calls).toHaveLength(2);
    // A later request in the same call uses the refreshed token, without refreshing again.
    const again = refreshingPort({ refreshTo: "still-wrong" });
    expect(await again.port.run(call("twice", "read"))).toEqual({ status: "ok", output: [401, 401] });
    expect(again.refreshes()).toBe(1);
    expect(again.fetch.calls.map((c) => c.headers.authorization)).toEqual(["Bearer stale", "Bearer still-wrong", "Bearer still-wrong"]);
  });

  it("is a plain 401 without refresh, and a refresh that fails is the credential's failure", async () => {
    const plain = refreshingPort({ refresh: false });
    expect(await plain.port.run(call("list", "read"))).toMatchObject({ status: "final", error: { code: "http/401" } });
    expect(plain.fetch.calls).toHaveLength(1);
    const revoked = refreshingPort({ failRefresh: ConnectorError.final("connect/reconsent", "Connect the account again.") });
    expect(await revoked.port.run(call("add", "write"))).toMatchObject({ status: "final", error: { code: "connect/reconsent" } });
    const down = refreshingPort({ failRefresh: new Error("token endpoint down") });
    expect(await down.port.run(call("list", "read"))).toMatchObject({ status: "retryable", error: { code: "connect/credential-unavailable" } });
    expect(down.fetch.calls).toHaveLength(1);
  });
});

describe("an operation may need only some of its connector's scopes", () => {
  const API = "https://api.mail.test/v1";
  function mail(sendScopes?: string[]): ConnectorDefinition {
    return {
      id: "mail",
      version: "1.1.0",
      title: "Mail",
      auth: { kind: "oauth2", scopes: ["mail.read", "mail.send"] },
      egress: ["GET api.mail.test/v1/*", "POST api.mail.test/v1/*"],
      operations: {
        list: { title: "List", effect: "read", scopes: ["mail.read"], input: { type: "object" }, output: {}, handler: async (_i, ctx) => (await ctx.http({ url: `${API}/messages` })).ensureOk().json() },
        send: {
          title: "Send",
          effect: "write",
          irreversible: true,
          ...(sendScopes !== undefined ? { scopes: sendScopes } : {}),
          input: { type: "object" },
          output: {},
          handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${API}/send` })).ensureOk().json(),
        },
      },
    } as ConnectorDefinition;
  }
  function mailPort(granted: string[], sendScopes?: string[]) {
    const fetch = mockFetch({ [`GET ${API}/messages`]: { json: [] }, [`POST ${API}/send`]: { json: { id: "m1" } } });
    const port = createConnectorActionPort({ ...TRUST, connectors: [defineConnector(mail(sendScopes))], connections: () => ({ connectionId: "c", grantedScopes: granted, subjectId: null }), credentials: { headers: () => ({ authorization: "Bearer t" }) }, fetch, clock, replayGuard: memoryReplayGuard(clock) });
    return { port, fetch };
  }
  const list = () => envelope("mail.list", "read", {}, { role: null });
  const send = () => envelope("mail.send", "write", {}, { role: null, idempotent: false });

  it("checks a connection for that operation's scopes alone", async () => {
    // Consented to reading only, before sending was added: reading still works.
    const reader = mailPort(["mail.read"]);
    expect(await reader.port.run(list())).toEqual({ status: "ok", output: [] });
    // An operation that declares none needs every scope.
    expect(await reader.port.run(send())).toMatchObject({ status: "final", error: { code: "connect/reconsent", message: expect.stringContaining("mail.send") } });
    expect(reader.fetch.calls).toHaveLength(1);
    const narrow = mailPort(["mail.read"], ["mail.send"]);
    expect(await narrow.port.run(send())).toMatchObject({ status: "final", error: { code: "connect/reconsent" } });
    expect(await mailPort(["mail.send"], ["mail.send"]).port.run(send())).toEqual({ status: "ok", output: { id: "m1" } });
  });

  it("must name scopes the connector lists, on an oauth2 connector only", () => {
    const codes = (def: unknown) => validateConnector(def).map((d) => `${d.code}@${d.path}`);
    expect(codes(mail(["mail.send"]))).toEqual([]);
    expect(codes(mail(["mail.delete"]))).toEqual(["connector/scope-not-declared@operations.send.scopes[0]"]);
    expect(codes(mail(["mail.send", "mail.send"]))).toEqual(["connector/invalid-field@operations.send.scopes[1]"]);
    expect(codes(mail(["has space"]))).toEqual(["connector/invalid-field@operations.send.scopes[0]"]);
    expect(codes({ ...mail(), operations: { ...mail().operations, send: { ...mail().operations.send!, scopes: "mail.send" } } })).toEqual(["connector/invalid-field@operations.send.scopes"]);
    expect(codes({ ...mail(), auth: { kind: "apiKey" } })).toEqual(["connector/invalid-field@operations.list.scopes"]);
    // Kept in the manifest when declared, so a manifest says what each operation needs.
    const manifest = manifestOf(defineConnector(mail()));
    expect(manifest.operations.list!.scopes).toEqual(["mail.read"]);
    expect("scopes" in manifest.operations.send!).toBe(false);
    expect(validateManifest(manifest)).toEqual([]);
  });
});

describe("webhooks", () => {
  const encoder = new TextEncoder();
  const SECRET = "whsec-connection-1";
  const sign = (body: string, secret = SECRET) => toHex(hmacSha256(encoder.encode(secret), encoder.encode(body)));
  /** A payments service that pushes `payment.completed`, signed with the connection's secret. */
  const payments = (hooks?: Partial<NonNullable<ConnectorDefinition["webhooks"]>>) =>
    defineConnector({
      id: "payments",
      version: "1.0.0",
      title: "Payments",
      auth: { kind: "apiKey" },
      egress: ["GET api.pay.test/v1/*"],
      operations: { get: { title: "Get", effect: "read", input: { type: "object" }, output: {}, handler: () => null } },
      webhooks: {
        verify: (request, ctx) => ctx.secret !== null && safeEqual(request.headers["x-signature"] ?? "", sign(new TextDecoder().decode(request.body), ctx.secret)),
        parse: (request) => {
          const body = JSON.parse(new TextDecoder().decode(request.body)) as { id: string; type: string; data: { reference: string; amount: number } };
          if (body.type !== "payment.completed") return [];
          return [{ event: "payment.completed", correlation: body.data.reference, payload: { amount: body.data.amount }, dedupeKey: body.id }];
        },
        ...hooks,
      },
    });
  const request = (body: string, signature = sign(body)): WebhookRequest => ({ method: "post", url: "https://hooks.host.test/c/conn-1", headers: { "X-Signature": signature }, body: encoder.encode(body) });
  const event = JSON.stringify({ id: "evt_1", type: "payment.completed", data: { reference: "P-1", amount: 900 } });

  it("verifies a request, then parses it into the events the engine delivers", async () => {
    const result = await handleWebhook(payments(), request(event), { connectionId: "conn-1", subjectId: null, secret: SECRET });
    expect(result).toEqual({
      ok: true,
      deliveries: [{ event: "payment.completed", correlation: "P-1", payload: { amount: 900 }, dedupeKey: "evt_1", connection: { id: "conn-1", subjectId: null } }],
    });
    // A request it has nothing for is acknowledged with none.
    const ping = JSON.stringify({ id: "evt_2", type: "ping", data: { reference: "x", amount: 0 } });
    expect(await handleWebhook(payments(), request(ping), { connectionId: "conn-1", subjectId: null, secret: SECRET })).toEqual({ ok: true, deliveries: [] });
  });

  it("names the connection and its owner on every delivery, whatever parse said, and reads nothing without an owner", async () => {
    let parsed = 0;
    const forging = payments({
      parse: () => (parsed++, [{ event: "payment.completed", correlation: "P-1", payload: {}, connection: { id: "conn-9", subjectId: "member:mallory" } }]),
    });
    const result = await handleWebhook(forging, request(event), { connectionId: "conn-1", subjectId: "member:ann", secret: SECRET });
    expect(result).toEqual({ ok: true, deliveries: [{ event: "payment.completed", correlation: "P-1", payload: {}, connection: { id: "conn-1", subjectId: "member:ann" } }] });
    const errors: string[] = [];
    for (const subjectId of [undefined, "", "ann", 7]) {
      const refused = await handleWebhook(forging, request(event), { connectionId: "conn-1", subjectId: subjectId as never, secret: SECRET, onError: (_e, where) => errors.push(where) });
      expect(refused).toMatchObject({ ok: false, code: "connect/webhook-unavailable", status: 503 });
    }
    expect(await handleWebhook(forging, request(event), { connectionId: "", subjectId: null, secret: SECRET })).toMatchObject({ ok: false, code: "connect/webhook-unavailable" });
    expect(parsed).toBe(1);
    expect(errors).toEqual(Array(4).fill("connector:payments.webhooks"));
  });

  it("never parses a request that does not verify", async () => {
    let parsed = 0;
    const counting = payments({ parse: () => (parsed++, []) });
    expect(await handleWebhook(counting, request(event, sign(event, "another-secret")), { connectionId: "conn-1", subjectId: null, secret: SECRET })).toMatchObject({ ok: false, code: "connect/webhook-unverified", status: 401 });
    expect(await handleWebhook(counting, request(event), { connectionId: "conn-1", subjectId: null })).toMatchObject({ ok: false, code: "connect/webhook-unverified", status: 401 });
    const truthy = payments({ verify: () => "yes" as unknown as boolean, parse: () => (parsed++, []) });
    expect(await handleWebhook(truthy, request(event), { connectionId: "conn-1", subjectId: null, secret: SECRET })).toMatchObject({ code: "connect/webhook-unverified" });
    expect(parsed).toBe(0);
  });

  it("asks for the request again when a hook fails unexpectedly, and refuses what parse cannot read", async () => {
    const errors: string[] = [];
    const onError = (_e: unknown, where: string) => errors.push(where);
    const broken = payments({
      verify: () => {
        throw new Error("secret store down");
      },
    });
    expect(await handleWebhook(broken, request(event), { connectionId: "conn-1", subjectId: null, secret: SECRET, onError })).toMatchObject({ ok: false, code: "connect/webhook-unavailable", status: 503 });
    const refusing = payments({
      parse: () => {
        throw ConnectorError.final("payments/bad-event", "Not an event.");
      },
    });
    expect(await handleWebhook(refusing, request(event), { connectionId: "conn-1", subjectId: null, secret: SECRET, onError })).toEqual({ ok: false, code: "connect/webhook-invalid", status: 400, message: "Not an event." });
    for (const answer of [
      [{ event: "Payment Completed", correlation: "P-1", payload: {} }],
      [{ event: "payment.completed", correlation: "P-1", payload: {}, extra: 1 }],
      [{ event: "payment.completed", correlation: "P-1" }],
      [{ event: "payment.completed", correlation: "P-1", payload: {}, dedupeKey: "../x" }],
      [{ event: "payment.completed", correlation: "P-1", payload: { n: Number.NaN } }],
      Array.from({ length: 101 }, () => ({ event: "payment.completed", correlation: "P-1", payload: {} })),
      { event: "payment.completed", correlation: "P-1", payload: {} },
    ]) {
      expect(await handleWebhook(payments({ parse: () => answer as never }), request(event), { connectionId: "conn-1", subjectId: null, secret: SECRET, onError })).toMatchObject({ ok: false, code: "connect/webhook-invalid", status: 400 });
    }
    expect(errors[0]).toBe("connector:payments.webhooks.verify");
    expect(errors.slice(1).every((w) => w === "connector:payments.webhooks.parse")).toBe(true);
  });

  it("is declared with both hooks, shows in the manifest, and is refused for a connector without", async () => {
    const plain = defineConnector({ id: "plain", version: "1.0.0", title: "Plain", auth: { kind: "none" }, egress: ["GET api.pay.test/v1/*"], operations: { get: { title: "Get", effect: "read", input: { type: "object" }, output: {}, handler: () => null } } });
    expect(await handleWebhook(plain, request(event), { connectionId: "conn-1", subjectId: null })).toMatchObject({ ok: false, code: "connect/no-webhooks", status: 404 });
    expect(manifestOf(payments()).webhooks).toBe(true);
    expect("webhooks" in manifestOf(plain)).toBe(false);
    expect(validateManifest(manifestOf(payments()))).toEqual([]);
    expect(validateManifest({ ...manifestOf(payments()), webhooks: { verify: true } }).map((d) => d.code)).toEqual(["connector/invalid-field"]);
    const halfHooked = { ...manifestOf(plain), manifestVersion: undefined, operations: { get: { title: "Get", effect: "read", input: { type: "object" }, output: {}, handler: () => null } }, webhooks: { verify: () => true } };
    delete (halfHooked as Record<string, unknown>).manifestVersion;
    expect(validateConnector(halfHooked).map((d) => `${d.code}@${d.path}`)).toEqual(["connector/invalid-field@webhooks"]);
  });
});
