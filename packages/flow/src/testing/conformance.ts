/**
 * Behaviour every RunStore must have. Framework-free: each case throws on
 * failure, so any test runner can run them:
 *
 *   for (const c of storeConformanceCases(() => makeStore())) it(c.name, c.run);
 */

import type { ActionEffect, CallEffect, FlowEvent, RunState, Scope } from "../state.js";
import { canonicalJson, type JsonValue } from "../json.js";
import { isErasureHeld, type LegalHold, type NewHold, type PrivacyRecord } from "../privacy.js";
import type { OutboxItem, RunStore, WorkspaceState } from "../store.js";

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`store conformance: ${message}`);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`store conformance: ${message}\n  expected ${b}\n  got      ${a}`);
}

const SCOPE: Scope = { tenantId: "t-1", appId: "a-1", environmentId: "e-1" };
const OTHER: Scope = { tenantId: "t-2", appId: "a-1", environmentId: "e-1" };
/** Another app of SCOPE's tenant. */
const SIBLING: Scope = { tenantId: "t-1", appId: "a-2", environmentId: "e-1" };

async function rejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

/** A run state the conformance cases store (also used by the blob ledger's cases). */
export function conformanceRunState(runId: string, revision: number, scope: Scope = SCOPE, subject = "visitor:s-1"): RunState {
  return {
    v: 1,
    runId,
    flowId: "f",
    flowVersion: "1",
    flowHash: "h",
    scope,
    subject: { id: subject },
    env: { locale: "en", timezone: "UTC", environment: "production" },
    status: "active",
    revision,
    createdAt: 1,
    updatedAt: 1,
    lastInputAt: 1,
    turns: 0,
    effectSeq: 0,
    facts: { name: { status: "valid", value: `rev-${revision}`, rev: revision } },
    results: {},
    outputs: {},
    resources: {},
    inflight: {},
    confirmations: {},
    timers: {},
    waits: {},
    epochs: {},
    current: null,
    notices: [],
    recent: [],
    attention: [],
  };
}

function event(id: string): FlowEvent {
  return { v: 1, type: "run.cancelled", id, at: 1, actor: { kind: "system", id: "system", roles: [] } };
}

function effect(effectId: string): ActionEffect {
  return { kind: "action", effectId, attempt: 1, purpose: "run", name: "n", action: "svc.op", actingFor: "business", effect: "read", input: { a: 1 }, idempotent: true, timeoutMs: 1000, risk: "none" };
}

function outboxItem(runId: string, effectId: string, availableAt = 0, scope: Scope = SCOPE): OutboxItem {
  return { id: `${effectId}#1`, scope, runId, effect: effect(effectId), context: { subjectId: null, environment: "production" }, availableAt, claims: 0 };
}

/** A workspace the conformance cases store (also used by the blob ledger's cases). */
export function conformanceWorkspace(id: string, revision: number, owner = "visitor:s-1", scope: Scope = SCOPE): WorkspaceState {
  return { v: 2, id, scope, owner, revision, active: null, parked: [], pending: null, offer: null, createdAt: 1, updatedAt: 1 };
}

const runState = conformanceRunState;
const workspace = conformanceWorkspace;
const createRun = (runId: string) => ({ runId, expectedRevision: 0, state: runState(runId, 1), events: [event(`${runId}-e1`)] });

export function storeConformanceCases(makeStore: () => RunStore | Promise<RunStore>): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const it = (name: string, run: (store: RunStore) => Promise<void>) => cases.push({ name, run: async () => run(await makeStore()) });

  it("returns null for a missing run", async (store) => {
    eq(await store.loadRun(SCOPE, "nope"), null, "missing run");
  });

  it("stores a new run and its events", async (store) => {
    const r = await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }] });
    eq(r, { ok: true }, "commit ok");
    eq((await store.loadRun(SCOPE, "r1"))?.facts, runState("r1", 1).facts, "state round-trips");
    const events = await store.listEvents(SCOPE, "r1");
    eq(events.map((e) => [e.seq, e.event.id]), [[1, "e1"]], "events numbered from 1");
  });

  it("refuses a second create with the same id", async (store) => {
    await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }] });
    const r = await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e2")] }] });
    assert(!r.ok, "duplicate create conflicts");
  });

  it("applies optimistic concurrency and stores nothing on conflict", async (store) => {
    await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }] });
    const ok = await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("e2")] }] });
    eq(ok, { ok: true }, "matching revision commits");
    const stale = await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("e3")] }],
      outbox: { add: [outboxItem("r1", "x1")] },
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 0 }] },
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: "k" }] },
    });
    assert(!stale.ok && stale.conflict === "run", "stale revision conflicts");
    eq((await store.loadRun(SCOPE, "r1"))?.revision, 2, "state unchanged");
    eq((await store.listEvents(SCOPE, "r1")).length, 2, "no event appended");
    eq((await store.claimOutbox({ owner: "w", now: 10, limit: 10, leaseMs: 100 })).length, 0, "no outbox item stored");
    eq((await store.claimTimers({ owner: "w", now: 10, limit: 10, leaseMs: 100 })).length, 0, "no timer stored");
    eq(await store.findWaiting(SCOPE, "ev", "k"), [], "no wait stored");
  });

  it("commits several runs atomically", async (store) => {
    await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }] });
    const r = await store.commit({
      scope: SCOPE,
      runs: [
        { runId: "r2", expectedRevision: 0, state: runState("r2", 1), events: [event("e2")] },
        { runId: "r1", expectedRevision: 5, state: runState("r1", 6), events: [event("e3")] },
      ],
    });
    assert(!r.ok, "conflict");
    eq(await store.loadRun(SCOPE, "r2"), null, "first run not stored");
  });

  // Sub-flows: a caller and its child are written in one commit, and call effects ride the outbox.
  const link = { runId: "r1", callId: "r1.1", rootRunId: "r1", depth: 1, chain: ["f"], contributors: ["visitor:s-1"] };
  const child = (revision: number): RunState => ({ ...runState("c1", revision), parent: link });

  it("commits a caller and its new child together, or neither", async (store) => {
    await store.commit({ scope: SCOPE, runs: [createRun("r1")] });
    const stale = await store.commit({
      scope: SCOPE,
      runs: [
        { runId: "r1", expectedRevision: 7, state: runState("r1", 8), events: [event("e2")] },
        { runId: "c1", expectedRevision: 0, state: child(1), events: [event("c-e1")] },
      ],
    });
    assert(!stale.ok, "a stale caller conflicts");
    eq(await store.loadRun(SCOPE, "c1"), null, "no child without its caller's record");
    const ok = await store.commit({
      scope: SCOPE,
      runs: [
        { runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("e2")] },
        { runId: "c1", expectedRevision: 0, state: child(1), events: [event("c-e1")] },
      ],
    });
    eq(ok, { ok: true }, "caller and child commit");
    eq((await store.loadRun(SCOPE, "c1"))?.parent, link, "the parent link round-trips");
    eq((await store.loadRun(SCOPE, "r1"))?.revision, 2, "caller written");
    eq(await store.loadRun(OTHER, "c1"), null, "the child stays in its scope");
  });

  it("refuses re-creating an existing child, and the caller's write with it", async (store) => {
    await store.commit({ scope: SCOPE, runs: [createRun("r1"), { runId: "c1", expectedRevision: 0, state: child(1), events: [event("c-e1")] }] });
    const again = await store.commit({
      scope: SCOPE,
      runs: [
        { runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("e2")] },
        { runId: "c1", expectedRevision: 0, state: child(1), events: [event("c-e2")] },
      ],
    });
    assert(!again.ok, "a second create of the child conflicts");
    eq((await store.loadRun(SCOPE, "r1"))?.revision, 1, "caller unchanged");
    eq((await store.listEvents(SCOPE, "c1")).map((e) => e.event.id), ["c-e1"], "child unchanged");
  });

  it("round-trips call effects through the outbox", async (store) => {
    const start: CallEffect = { kind: "call.start", callId: "r1.1", attempt: 1, childRunId: "c1", flowId: "g", version: "2", upgrade: "exact", input: { email: "a@example.com" }, parent: link };
    const back: CallEffect = { kind: "call.return", parentRunId: "r1", callId: "r1.1", childRunId: "c1", end: { kind: "completed", committed: true, lastInputAt: 5, output: { id: "x" }, contributors: ["visitor:s-1"] } };
    const cancel: CallEffect = { kind: "call.cancel", callId: "r1.1", childRunId: "c1", reason: "superseded" };
    const item = (id: string, runId: string, effect: CallEffect, availableAt: number): OutboxItem => ({ id, scope: SCOPE, runId, effect, context: { subjectId: "visitor:s-1", environment: "production" }, availableAt, claims: 0 });
    await store.commit({
      scope: SCOPE,
      runs: [createRun("r1"), { runId: "c1", expectedRevision: 0, state: child(1), events: [event("c-e1")] }],
      outbox: { add: [item("r1.1#1", "r1", start, 1), item("r1.1#cancel", "r1", cancel, 2), item("c1#return", "c1", back, 3)] },
    });
    const claimed = await store.claimOutbox({ owner: "w", now: 10, limit: 10, leaseMs: 100 });
    eq(
      claimed.map((i) => [i.id, i.runId, i.effect]),
      [
        ["r1.1#1", "r1", start],
        ["r1.1#cancel", "r1", cancel],
        ["c1#return", "c1", back],
      ],
      "call effects round-trip",
    );
  });

  it("isolates tenants", async (store) => {
    await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }],
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: "k" }] },
    });
    eq(await store.loadRun(OTHER, "r1"), null, "other tenant cannot load");
    eq(await store.listEvents(OTHER, "r1"), [], "other tenant cannot list events");
    eq(await store.findWaiting(OTHER, "ev", "k"), [], "other tenant cannot find waits");
    eq(await store.listRunsBySubject(OTHER, "visitor:s-1"), [], "other tenant cannot list subject runs");
    eq(await store.loadRun({ ...SCOPE, environmentId: "e-2" }, "r1"), null, "other environment cannot load");
  });

  it("leases outbox items to one owner at a time", async (store) => {
    await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }],
      outbox: { add: [outboxItem("r1", "x1", 0), outboxItem("r1", "x2", 1000)] },
    });
    const first = await store.claimOutbox({ owner: "a", now: 10, limit: 10, leaseMs: 100 });
    eq(first.map((i) => [i.id, i.claims]), [["x1#1", 1]], "only due items, first claim");
    eq((await store.claimOutbox({ owner: "b", now: 50, limit: 10, leaseMs: 100 })).length, 0, "leased item not handed out");
    const again = await store.claimOutbox({ owner: "b", now: 200, limit: 10, leaseMs: 100 });
    eq(again.map((i) => [i.id, i.claims, i.leaseOwner]), [["x1#1", 2, "b"]], "expired lease is reclaimed and counted");
    await store.commit({ scope: SCOPE, runs: [], outbox: { done: ["x1#1"] } });
    eq((await store.claimOutbox({ owner: "c", now: 500, limit: 10, leaseMs: 100 })).map((i) => i.id), [], "done removes the item and the later one is not due yet");
    eq((await store.claimOutbox({ owner: "c", now: 1000, limit: 10, leaseMs: 100 })).map((i) => i.id), ["x2#1"], "the later item becomes due");
  });

  it("renews a lease only for the owner that still holds it", async (store) => {
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], outbox: { add: [outboxItem("r1", "x1", 0)] } });
    const [held] = await store.claimOutbox({ owner: "a", now: 10, limit: 10, leaseMs: 100 });
    assert(held?.leaseUntil === 110, "claimed with a lease to 110");
    eq(await store.renewOutbox(SCOPE, { id: "x1#1", owner: "b", until: 110 }, 500), false, "another owner cannot renew it");
    eq(await store.renewOutbox(SCOPE, { id: "x1#1", owner: "a", until: 999 }, 500), false, "a lease the owner no longer holds is not renewed");
    eq(await store.renewOutbox(OTHER, { id: "x1#1", owner: "a", until: 110 }, 500), false, "another tenant cannot renew it");
    eq(await store.renewOutbox(SCOPE, { id: "x1#1", owner: "a", until: 110 }, 400), true, "the holder renews it");
    eq((await store.claimOutbox({ owner: "b", now: 300, limit: 10, leaseMs: 100 })).length, 0, "a renewed lease keeps the item from other owners");
    const taken = await store.claimOutbox({ owner: "b", now: 400, limit: 10, leaseMs: 100 });
    eq(taken.map((i) => [i.id, i.claims, i.leaseOwner]), [["x1#1", 2, "b"]], "claimable again when the renewed lease ends");
    eq(await store.renewOutbox(SCOPE, { id: "x1#1", owner: "a", until: 400 }, 900), false, "the old owner's lease is gone once another owner took the item");
    await store.commit({ scope: SCOPE, runs: [], outbox: { done: ["x1#1"] } });
    eq(await store.renewOutbox(SCOPE, { id: "x1#1", owner: "b", until: 500 }, 900), false, "a done item is not renewed");
  });

  it("releases a held item with its claim taken back", async (store) => {
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], outbox: { add: [{ ...outboxItem("r1", "x1", 0), claims: 1, leaseOwner: "inline", leaseUntil: 100 }] } });
    eq(await store.releaseOutbox(SCOPE, { id: "x1#1", owner: "w", until: 100 }, 20), false, "another owner cannot release it");
    eq(await store.releaseOutbox(OTHER, { id: "x1#1", owner: "inline", until: 100 }, 20), false, "another tenant cannot release it");
    eq(await store.releaseOutbox(SCOPE, { id: "x1#1", owner: "inline", until: 100 }, 20), true, "the holder releases it");
    eq((await store.claimOutbox({ owner: "w", now: 19, limit: 10, leaseMs: 100 })).length, 0, "not claimable before the release says");
    const first = await store.claimOutbox({ owner: "w", now: 20, limit: 10, leaseMs: 100 });
    eq(first.map((i) => [i.id, i.claims, i.leaseOwner]), [["x1#1", 1, "w"]], "claimable again, and the released claim does not count");
    eq(await store.releaseOutbox(SCOPE, { id: "x1#1", owner: "inline", until: 100 }, 20), false, "a lease released once is not released again");
    eq(await store.releaseOutbox(SCOPE, { id: "x1#1", owner: "w", until: 120 }, 0), true, "released again by its new holder");
    eq((await store.claimOutbox({ owner: "v", now: 20, limit: 10, leaseMs: 100 })).map((i) => [i.id, i.claims]), [["x1#1", 1]], "an earlier availableAt never brings it forward, and claims never go below the claims taken");
  });

  it("keeps timers by generation", async (store) => {
    await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }],
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 100 }] },
    });
    eq((await store.claimTimers({ owner: "w", now: 50, limit: 10, leaseMs: 10 })).length, 0, "not due yet");
    await store.commit({ scope: SCOPE, runs: [], timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 2, dueAt: 100 }] } });
    await store.commit({ scope: SCOPE, runs: [], timers: { done: [{ runId: "r1", timerId: "t", generation: 1 }] } });
    const due = await store.claimTimers({ owner: "w", now: 150, limit: 10, leaseMs: 10 });
    eq(due.map((t) => [t.timerId, t.generation]), [["t", 2]], "done with an old generation keeps the new timer");
    eq((await store.claimTimers({ owner: "w2", now: 155, limit: 10, leaseMs: 10 })).length, 0, "leased timer not handed out");
    await store.commit({ scope: SCOPE, runs: [], timers: { done: [{ runId: "r1", timerId: "t", generation: 2 }] } });
    eq((await store.claimTimers({ owner: "w", now: 1000, limit: 10, leaseMs: 10 })).length, 0, "done removes");
    await store.commit({ scope: SCOPE, runs: [], timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "u", generation: 3, dueAt: 0 }] } });
    await store.commit({ scope: SCOPE, runs: [], timers: { cancel: [{ runId: "r1", timerId: "u" }] } });
    eq((await store.claimTimers({ owner: "w", now: 1000, limit: 10, leaseMs: 10 })).length, 0, "cancel removes");
  });

  it("indexes waits by event and key", async (store) => {
    await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }],
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: '"k1"' }] },
    });
    eq(await store.findWaiting(SCOPE, "ev", '"k1"'), [{ runId: "r1", stepId: "s" }], "found");
    eq(await store.findWaiting(SCOPE, "ev", '"k2"'), [], "other key not found");
    await store.commit({ scope: SCOPE, runs: [], waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: '"k2"' }] } });
    eq(await store.findWaiting(SCOPE, "ev", '"k1"'), [], "re-opened wait replaces the old key");
    await store.commit({ scope: SCOPE, runs: [], waits: { close: [{ runId: "r1", stepId: "s" }] } });
    eq(await store.findWaiting(SCOPE, "ev", '"k2"'), [], "closed");
  });

  it("versions workspaces", async (store) => {
    eq(await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } }), { ok: true }, "create");
    const stale = await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } });
    assert(!stale.ok && stale.conflict === "workspace", "second create conflicts");
    eq(await store.commit({ scope: SCOPE, runs: [], workspace: { state: { ...workspace("w1", 2), active: "r9" }, expectedRevision: 1 } }), { ok: true }, "update");
    eq((await store.loadWorkspace(SCOPE, "w1"))?.active, "r9", "loads latest");
    eq(await store.loadWorkspace(OTHER, "w1"), null, "other tenant cannot load");
  });

  it("keeps a workspace's open offer and its pending question, and their absence", async (store) => {
    const same = (actual: unknown, expected: unknown, message: string) => eq(canonicalJson(actual as JsonValue), canonicalJson(expected as JsonValue), message);
    const plain = workspace("w-plain", 1);
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: plain, expectedRevision: 0 } });
    const loaded = await store.loadWorkspace(SCOPE, "w-plain");
    same(loaded, plain, "a workspace without an offer round-trips");
    assert(loaded !== null && loaded.offer === null, "no offer appears");
    const offered: WorkspaceState = {
      ...workspace("w-offer", 1),
      offer: {
        id: "offer-1",
        turnId: "turn-1",
        askedAt: 1_000,
        expiresAt: 601_000,
        options: [
          { id: "1", flowId: "orders", title: "Track an order", description: "Where is it", runId: "r1" },
          { id: "2", flowId: "returns", title: "Return an item", facts: { item: "shoes", count: 2, gift: false, note: null } },
        ],
      },
    };
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: offered, expectedRevision: 0 } });
    same(await store.loadWorkspace(SCOPE, "w-offer"), offered, "an offer round-trips");
    const asked: WorkspaceState = { ...offered, revision: 2, offer: null, pending: { kind: "switch", flowId: "orders", askedAt: 2_000, basis: "pick", turnId: "turn-1" } };
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: asked, expectedRevision: 1 } });
    const after = await store.loadWorkspace(SCOPE, "w-offer");
    same(after, asked, "a cleared offer stays cleared; the question round-trips");
    assert(after !== null && after.offer === null, "the offer is gone");
  });

  it("lists events after a sequence number", async (store) => {
    await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 2), events: [event("e1"), event("e2")] }] });
    await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 2, state: runState("r1", 3), events: [event("e3")] }] });
    eq((await store.listEvents(SCOPE, "r1", { afterSeq: 1 })).map((e) => e.seq), [2, 3], "after");
    eq((await store.listEvents(SCOPE, "r1", { afterSeq: 1, limit: 1 })).map((e) => e.seq), [2], "limit");
  });

  it("finds runs by subject and erases them completely", async (store) => {
    await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 0, state: runState("r1", 1), events: [event("e1")] }],
      outbox: { add: [outboxItem("r1", "x1")] },
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 0 }] },
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: "k" }] },
    });
    await store.commit({ scope: SCOPE, runs: [{ runId: "r2", expectedRevision: 0, state: runState("r2", 1, SCOPE, "visitor:other"), events: [event("e2")] }] });
    eq(await store.listRunsBySubject(SCOPE, "visitor:s-1"), ["r1"], "by subject");
    await store.eraseRun(SCOPE, "r1");
    eq(await store.loadRun(SCOPE, "r1"), null, "state erased");
    eq(await store.listEvents(SCOPE, "r1"), [], "events erased");
    eq(await store.listRunsBySubject(SCOPE, "visitor:s-1"), [], "subject index erased");
    eq((await store.claimOutbox({ owner: "w", now: 10, limit: 10, leaseMs: 10 })).length, 0, "outbox erased");
    eq((await store.claimTimers({ owner: "w", now: 10, limit: 10, leaseMs: 10 })).length, 0, "timers erased");
    eq(await store.findWaiting(SCOPE, "ev", "k"), [], "waits erased");
    assert((await store.loadRun(SCOPE, "r2")) !== null, "other runs kept");
  });

  it("hands each outbox item to one of several concurrent claimers", async (store) => {
    const items = Array.from({ length: 20 }, (_, i) => outboxItem("r1", `x${i}`));
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], outbox: { add: items } });
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => store.claimOutbox({ owner: `w${i}`, now: 10, limit: 8, leaseMs: 100 })));
    const ids = claims.flat().map((i) => i.id);
    eq(ids.length, new Set(ids).size, "no item handed to two claimers");
    assert(claims.flat().every((i) => i.claims === 1), "each item claimed once");
    const rest = await store.claimOutbox({ owner: "late", now: 10, limit: 50, leaseMs: 100 });
    eq([...ids, ...rest.map((i) => i.id)].sort(), items.map((i) => i.id).sort(), "every item claimed exactly once overall");
    await store.commit({ scope: SCOPE, runs: [], outbox: { done: items.slice(1).map((i) => i.id) } });
    const single = await Promise.all(Array.from({ length: 6 }, (_, i) => store.claimOutbox({ owner: `v${i}`, now: 200, limit: 5, leaseMs: 100 })));
    eq(single.flat().map((i) => [i.id, i.claims]), [["x0#1", 2]], "after the lease, the item again goes to one claimer");
  });

  it("keeps the lease an outbox item was added with", async (store) => {
    const leased: OutboxItem = { ...outboxItem("r1", "x1"), claims: 1, leaseOwner: "inline", leaseUntil: 1000 };
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], outbox: { add: [leased] } });
    eq((await store.claimOutbox({ owner: "w", now: 999, limit: 10, leaseMs: 100 })).length, 0, "not claimable while the lease lasts");
    const later = await store.claimOutbox({ owner: "w", now: 1000, limit: 10, leaseMs: 100 });
    eq(later.map((i) => [i.id, i.claims, i.leaseOwner, i.leaseUntil]), [["x1#1", 2, "w", 1100]], "claimable when it ends, counting the first claim");
  });

  it("never replaces an outbox item that already exists", async (store) => {
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], outbox: { add: [outboxItem("r1", "x1")] } });
    eq((await store.claimOutbox({ owner: "a", now: 10, limit: 10, leaseMs: 100 })).map((i) => i.claims), [1], "claimed");
    const again = await store.commit({ scope: SCOPE, runs: [], outbox: { add: [{ ...outboxItem("r1", "x1"), effect: { ...effect("x1"), input: { a: 2 } } }] } });
    eq(again, { ok: true }, "adding an existing id is not an error");
    eq((await store.claimOutbox({ owner: "b", now: 50, limit: 10, leaseMs: 100 })).length, 0, "the lease is kept");
    const reclaimed = await store.claimOutbox({ owner: "b", now: 200, limit: 10, leaseMs: 100 });
    eq(reclaimed.map((i) => [i.id, i.claims, (i.effect as ActionEffect).input]), [["x1#1", 2, { a: 1 }]], "the claim count and content are kept");
  });

  it("reclaims a timer whose lease expired", async (store) => {
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 0 }] } });
    eq((await store.claimTimers({ owner: "a", now: 10, limit: 10, leaseMs: 100 })).map((t) => t.leaseOwner), ["a"], "claimed");
    eq((await store.claimTimers({ owner: "b", now: 109, limit: 10, leaseMs: 100 })).length, 0, "leased");
    eq((await store.claimTimers({ owner: "b", now: 110, limit: 10, leaseMs: 100 })).map((t) => [t.timerId, t.leaseOwner, t.leaseUntil]), [["t", "b", 210]], "reclaimed after the lease");
  });

  it("stores nothing of a batch whose workspace conflicts", async (store) => {
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } });
    const r = await store.commit({
      scope: SCOPE,
      runs: [createRun("r1")],
      workspace: { state: { ...workspace("w1", 1), active: "r1" }, expectedRevision: 0 },
      outbox: { add: [outboxItem("r1", "x1")] },
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 0 }] },
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: "k" }] },
    });
    assert(!r.ok && r.conflict === "workspace", "workspace conflict reported");
    eq(await store.loadRun(SCOPE, "r1"), null, "run not stored");
    eq(await store.listEvents(SCOPE, "r1"), [], "no events stored");
    eq(await store.listRunsBySubject(SCOPE, "visitor:s-1"), [], "subject not indexed");
    eq((await store.claimOutbox({ owner: "w", now: 10, limit: 10, leaseMs: 100 })).length, 0, "no outbox item stored");
    eq((await store.claimTimers({ owner: "w", now: 10, limit: 10, leaseMs: 100 })).length, 0, "no timer stored");
    eq(await store.findWaiting(SCOPE, "ev", "k"), [], "no wait stored");
    eq((await store.loadWorkspace(SCOPE, "w1"))?.active, null, "workspace unchanged");
  });

  it("lets exactly one of several concurrent commits at one revision win", async (store) => {
    const creates = await Promise.all(Array.from({ length: 5 }, (_, i) => store.commit({ scope: SCOPE, runs: [{ ...createRun("r1"), events: [event(`c${i}`)] }] })));
    eq(creates.filter((r) => r.ok).length, 1, "one create wins");
    const updates = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 1, state: { ...runState("r1", 2), current: `u${i}` }, events: [event(`u${i}`)] }] }),
      ),
    );
    eq(updates.filter((r) => r.ok).length, 1, "one update wins");
    const winner = updates.findIndex((r) => r.ok);
    const events = await store.listEvents(SCOPE, "r1");
    eq(events.map((e) => [e.seq, e.event.id]), [[1, `c${creates.findIndex((r) => r.ok)}`], [2, `u${winner}`]], "only the winners' events, numbered in order");
    eq((await store.loadRun(SCOPE, "r1"))?.current, `u${winner}`, "the winner's state");
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } });
    const ws = await Promise.all(Array.from({ length: 5 }, (_, i) => store.commit({ scope: SCOPE, runs: [], workspace: { state: { ...workspace("w1", 2), active: `a${i}` }, expectedRevision: 1 } })));
    eq(ws.filter((r) => r.ok).length, 1, "one workspace update wins");
  });

  it("erases a person's workspaces and no one else's", async (store) => {
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w2", 1), expectedRevision: 0 } });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w3", 1, "visitor:other"), expectedRevision: 0 } });
    await store.commit({ scope: OTHER, runs: [], workspace: { state: workspace("w1", 1, "visitor:s-1", OTHER), expectedRevision: 0 } });
    await store.eraseWorkspaces(SCOPE, "visitor:s-1");
    eq(await store.loadWorkspace(SCOPE, "w1"), null, "first erased");
    eq(await store.loadWorkspace(SCOPE, "w2"), null, "second erased");
    eq((await store.loadWorkspace(SCOPE, "w3"))?.owner, "visitor:other", "another person's kept");
    eq((await store.loadWorkspace(OTHER, "w1"))?.owner, "visitor:s-1", "another tenant's kept");
    await store.eraseWorkspaces(SCOPE, "visitor:nobody");
  });

  it("lists a person's workspaces, as stored, and no one else's", async (store) => {
    const offered: WorkspaceState = {
      ...workspace("w2", 1),
      offer: { id: "offer-1", turnId: "turn-1", askedAt: 1, expiresAt: 2, options: [{ id: "1", flowId: "returns", title: "Return an item", facts: { item: "shoes" } }] },
    };
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: offered, expectedRevision: 0 } });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w3", 1, "visitor:other"), expectedRevision: 0 } });
    await store.commit({ scope: OTHER, runs: [], workspace: { state: workspace("w4", 1, "visitor:s-1", OTHER), expectedRevision: 0 } });
    const listed = await store.listWorkspacesByOwner(SCOPE, "visitor:s-1");
    eq(
      listed.map((w) => w.id),
      ["w1", "w2"],
      "this person's, in this scope, by id",
    );
    eq(canonicalJson(listed[1] as unknown as JsonValue), canonicalJson(offered as unknown as JsonValue), "with the open offer and its facts");
    eq(await store.listWorkspacesByOwner(SCOPE, "visitor:nobody"), [], "none for someone without one");
    await store.eraseWorkspaces(SCOPE, "visitor:s-1");
    eq(await store.listWorkspacesByOwner(SCOPE, "visitor:s-1"), [], "none after erasure");
  });


  // Legal holds and the privacy log (ADR-0010): stores with `privacy` only.

  const hold = (id: string, target: NewHold["target"], at = 10, extra: Partial<NewHold> = {}): NewHold => ({ id, target, reason: `reason ${id}`, by: "staff:legal-1", at, ...extra });
  const holdIds = (holds: LegalHold[]) => holds.map((h) => h.id);
  const heldIds = (outcome: unknown) => (isErasureHeld(outcome) ? holdIds(outcome.holds) : null);
  const createFor = (store: RunStore, scope: Scope, runId: string, subject = "visitor:s-1") =>
    store.commit({ scope, runs: [{ runId, expectedRevision: 0, state: runState(runId, 1, scope, subject), events: [event(`${runId}-e1`)] }] });

  it("places, lists and releases legal holds, within the tenant", async (store) => {
    const p = store.privacy;
    if (!p) return;
    const placed = await p.placeHold(SCOPE, hold("h-tenant", { kind: "tenant" }, 10));
    eq(placed, { id: "h-tenant", target: { kind: "tenant" }, reason: "reason h-tenant", placedBy: "staff:legal-1", placedAt: 10 }, "a placed hold reads back");
    await p.placeHold(SCOPE, hold("h-run", { kind: "run", runId: "r1" }, 20, { until: 1_000 }));
    await p.placeHold(SCOPE, hold("h-person", { kind: "subject", subjectId: "visitor:s-1" }, 25));
    await p.placeHold(SIBLING, hold("h-sibling", { kind: "scope" }, 30));
    eq(holdIds(await p.listHolds(SCOPE, { now: 50 })), ["h-tenant", "h-run", "h-person"], "the scope's own holds and the tenant's, by placement");
    eq((await p.listHolds(SCOPE, { now: 50 }))[1], { id: "h-run", target: { kind: "run", runId: "r1" }, reason: "reason h-run", placedBy: "staff:legal-1", placedAt: 20, until: 1_000 }, "with its until");
    eq(holdIds(await p.listHolds(SIBLING, { now: 50 })), ["h-tenant", "h-sibling"], "a tenant hold is seen from every scope of its tenant");
    eq(await p.listHolds(OTHER, { now: 50 }), [], "another tenant sees none");
    eq(holdIds(await p.listHolds(SCOPE, { now: 50, covering: { subjectId: "visitor:s-2", runIds: ["r1"] } })), ["h-tenant", "h-run"], "covering: the tenant and the run, not another person");
    eq(holdIds(await p.listHolds(SCOPE, { now: 50, covering: { subjectId: "visitor:s-1", runIds: [] } })), ["h-tenant", "h-person"], "covering: the person");
    eq(await p.releaseHold(OTHER, "h-tenant", { by: "staff:x", at: 55 }), null, "another tenant cannot release a hold");
    eq(await p.releaseHold(SCOPE, "h-sibling", { by: "staff:x", at: 55 }), null, "nor another scope's own one");
    eq(await p.releaseHold(SCOPE, "nope", { by: "staff:x", at: 55 }), null, "an unknown hold is not released");
    const released = await p.releaseHold(SCOPE, "h-run", { by: "staff:legal-2", at: 60, reason: "Settled" });
    eq(released?.released, { by: "staff:legal-2", at: 60, reason: "Settled" }, "a release is recorded on the hold");
    eq((await p.releaseHold(SCOPE, "h-run", { by: "staff:x", at: 70 }))?.released, { by: "staff:legal-2", at: 60, reason: "Settled" }, "the first release stands");
    eq(holdIds(await p.listHolds(SCOPE, { now: 80 })), ["h-tenant", "h-person"], "a released hold is no longer in force");
    eq(holdIds(await p.listHolds(SCOPE, { now: 80, ended: true })), ["h-tenant", "h-run", "h-person"], "but it is kept");
    eq(await p.placeHold(SCOPE, hold("h-tenant", { kind: "scope" }, 90)), placed, "placing an id again changes nothing");
    await rejects(() => p.placeHold(SCOPE, hold("h-sibling", { kind: "scope" }, 90)), "an id in use in another scope of the tenant is refused");
    eq((await p.placeHold(OTHER, hold("h-tenant", { kind: "scope" }, 90))).target, { kind: "scope" }, "ids are per tenant");
    await rejects(() => p.placeHold(SCOPE, { ...hold("h-bad", { kind: "scope" }), reason: "" }), "a hold without a reason is refused");
    await rejects(() => p.placeHold(SCOPE, { ...hold("h-bad", { kind: "scope" }), until: 5 }), "a hold that lapses before it is placed is refused");
  });

  it("refuses to erase a run a hold covers, changing nothing, and erases it once released", async (store) => {
    const p = store.privacy;
    if (!p) return;
    await store.commit({
      scope: SCOPE,
      runs: [createRun("r1")],
      outbox: { add: [outboxItem("r1", "x1", 1_000)] },
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 1_000 }] },
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: "k" }] },
    });
    await store.commit({ scope: SCOPE, runs: [{ runId: "r2", expectedRevision: 0, state: runState("r2", 1), events: [event("r2-e1")] }] });
    await p.placeHold(SCOPE, hold("h-r1", { kind: "run", runId: "r1" }, 10));
    eq(heldIds(await store.eraseRun(SCOPE, "r1", { now: 20 })), ["h-r1"], "refused, naming the hold");
    eq((await store.loadRun(SCOPE, "r1"))?.facts, runState("r1", 1).facts, "the run is kept and still reads");
    eq((await store.listEvents(SCOPE, "r1")).map((e) => e.event.id), ["r1-e1"], "its events are kept");
    eq(await store.listRunsBySubject(SCOPE, "visitor:s-1"), ["r1", "r2"], "it is still listed for its person");
    eq(await store.findWaiting(SCOPE, "ev", "k"), [{ runId: "r1", stepId: "s" }], "its wait is kept");
    eq((await store.claimTimers({ owner: "w", now: 1_000, limit: 10, leaseMs: 10 })).map((t) => t.runId), ["r1"], "its timer is kept");
    eq((await store.claimOutbox({ owner: "w", now: 1_000, limit: 10, leaseMs: 10 })).map((i) => i.id), ["x1#1"], "its outbox item is kept");
    const committed = await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("r1-e2")] }] });
    eq(committed, { ok: true }, "a held run still takes commits");
    eq(await store.eraseRun(SCOPE, "r2", { now: 20 }), { erased: true }, "a run the hold does not name is erased");
    await p.releaseHold(SCOPE, "h-r1", { by: "staff:legal-2", at: 30 });
    eq(await store.eraseRun(SCOPE, "r1", { now: 40 }), { erased: true }, "erased once the hold is released");
    eq(await store.loadRun(SCOPE, "r1"), null, "gone");
    eq(await store.listEvents(SCOPE, "r1"), [], "with its events");
  });

  it("lets a hold lapse at its until", async (store) => {
    const p = store.privacy;
    if (!p) return;
    await store.commit({ scope: SCOPE, runs: [createRun("r1")] });
    await p.placeHold(SCOPE, hold("h-1", { kind: "scope" }, 10, { until: 100 }));
    eq(holdIds(await p.listHolds(SCOPE, { now: 99 })), ["h-1"], "in force before its until");
    eq(heldIds(await store.eraseRun(SCOPE, "r1", { now: 99 })), ["h-1"], "and it covers the scope's runs");
    eq(await p.listHolds(SCOPE, { now: 100 }), [], "lapsed at its until");
    eq(holdIds(await p.listHolds(SCOPE, { now: 100, ended: true })), ["h-1"], "and kept");
    eq(await store.eraseRun(SCOPE, "r1", { now: 100 }), { erased: true }, "a lapsed hold covers nothing");
  });

  it("covers a person's runs and workspaces with a hold on them, and no one else's", async (store) => {
    const p = store.privacy;
    if (!p) return;
    await createFor(store, SCOPE, "r1", "visitor:s-1");
    await createFor(store, SCOPE, "r2", "visitor:other");
    await createFor(store, SIBLING, "r3", "visitor:s-1");
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w1", 1), expectedRevision: 0 } });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w2", 1), expectedRevision: 0 } });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: workspace("w3", 1, "visitor:other"), expectedRevision: 0 } });
    await p.placeHold(SCOPE, hold("h-person", { kind: "subject", subjectId: "visitor:s-1" }, 10));
    eq(heldIds(await store.eraseRun(SCOPE, "r1", { now: 20 })), ["h-person"], "the person's run is held");
    eq(heldIds(await store.eraseWorkspaces(SCOPE, "visitor:s-1", { now: 20 })), ["h-person"], "so are their workspaces");
    eq((await store.loadWorkspace(SCOPE, "w1"))?.owner, "visitor:s-1", "which are kept");
    eq(await store.eraseRun(SCOPE, "r2", { now: 20 }), { erased: true }, "another person's run is not held");
    eq(await store.eraseWorkspaces(SCOPE, "visitor:other", { now: 20 }), { erased: true, workspaces: ["w3"] }, "nor are their workspaces, and the ids erased are named");
    eq(await store.eraseRun(SIBLING, "r3", { now: 20 }), { erased: true }, "a hold on a person covers them in its own scope only");
    await p.releaseHold(SCOPE, "h-person", { by: "staff:legal-2", at: 30 });
    eq(await store.eraseWorkspaces(SCOPE, "visitor:s-1", { now: 40 }), { erased: true, workspaces: ["w1", "w2"] }, "erased once released");
  });

  it("covers every scope of its tenant with a tenant hold, and its own scope with a scope hold", async (store) => {
    const p = store.privacy;
    if (!p) return;
    await createFor(store, SCOPE, "r1");
    await createFor(store, SIBLING, "r2");
    await createFor(store, OTHER, "r3");
    await p.placeHold(SIBLING, hold("h-tenant", { kind: "tenant" }, 10));
    eq(heldIds(await store.eraseRun(SCOPE, "r1", { now: 20 })), ["h-tenant"], "a tenant hold placed from one app covers another");
    eq(heldIds(await store.eraseWorkspaces(SCOPE, "visitor:s-1", { now: 20 })), ["h-tenant"], "and the workspaces in it");
    eq(await store.eraseRun(OTHER, "r3", { now: 20 }), { erased: true }, "it covers nothing of another tenant");
    eq(await p.releaseHold(SCOPE, "h-tenant", { by: "staff:legal-2", at: 30 }), null, "it is not released from another scope of the tenant, which only sees it");
    eq(heldIds(await store.eraseRun(SCOPE, "r1", { now: 30 })), ["h-tenant"], "so it still holds");
    eq((await p.releaseHold(SIBLING, "h-tenant", { by: "staff:legal-2", at: 30 }))?.released?.by, "staff:legal-2", "it is released from the scope that placed it");
    await p.placeHold(SCOPE, hold("h-scope", { kind: "scope" }, 40));
    eq(heldIds(await store.eraseRun(SCOPE, "r1", { now: 50 })), ["h-scope"], "a scope hold covers its scope");
    eq(await store.eraseRun(SIBLING, "r2", { now: 50 }), { erased: true }, "and not another app of the tenant");
  });

  it("keeps the privacy log in order, per scope, across erasure", async (store) => {
    const p = store.privacy;
    if (!p) return;
    const rec = (id: string, at: number, subjectId: string, extra: Partial<PrivacyRecord> = {}): PrivacyRecord => ({
      id,
      kind: "erase",
      subjectId,
      at,
      actor: { kind: "staff", id: "staff:dpo-1" },
      requestId: `req-${id}`,
      runs: ["r1"],
      workspaces: [],
      ...extra,
    });
    const full = rec("rec-3", 20, "visitor:s-1", {
      actor: { kind: "staff", id: "staff:dpo-1", for: "visitor:s-1" },
      workspaces: ["w1"],
      heldBy: ["h-1"],
      abandoned: [{ runId: "r1", status: "cancelling" }],
      released: ["blob-1"],
    });
    await store.commit({ scope: SCOPE, runs: [createRun("r1")] });
    await p.record(SCOPE, rec("rec-1", 10, "visitor:s-1", { kind: "export", secrets: "mask" }));
    await p.record(SCOPE, full);
    await p.record(SCOPE, rec("rec-2", 20, "visitor:s-2"));
    await p.record(OTHER, rec("rec-9", 5, "visitor:s-1"));
    await p.record(SCOPE, rec("rec-1", 99, "visitor:changed"));
    eq((await p.listRecords(SCOPE, { limit: 10 })).map((r) => r.id), ["rec-1", "rec-2", "rec-3"], "oldest first, then by id");
    eq(canonicalJson((await p.listRecords(SCOPE, { limit: 10 }))[2] as unknown as JsonValue), canonicalJson(full as unknown as JsonValue), "a record reads back as written");
    eq((await p.listRecords(SCOPE, { limit: 10 }))[0]?.subjectId, "visitor:s-1", "a repeated id changes nothing");
    eq((await p.listRecords(SCOPE, { subjectId: "visitor:s-1", limit: 10 })).map((r) => r.id), ["rec-1", "rec-3"], "one person's");
    eq((await p.listRecords(SCOPE, { after: { at: 20, id: "rec-2" }, limit: 10 })).map((r) => r.id), ["rec-3"], "after a cursor");
    eq((await p.listRecords(SCOPE, { limit: 1 })).map((r) => r.id), ["rec-1"], "a page");
    eq((await p.listRecords(OTHER, { limit: 10 })).map((r) => r.id), ["rec-9"], "another tenant's are its own");
    await store.eraseRun(SCOPE, "r1", { now: 30 });
    eq((await p.listRecords(SCOPE, { limit: 10 })).length, 3, "erasure keeps the log");
    await rejects(() => p.record(SCOPE, { ...rec("rec-bad", 1, "visitor:s-1"), runs: [""] }), "a malformed record is refused");
  });

  it("counts the backlog and the effects waiting for a person, across tenants", async (store) => {
    if (!store.health) return;
    const attention = (runId: string, scope: Scope, revision: number, ids: string[]): RunState => ({ ...runState(runId, revision, scope), attention: ids });
    await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 0, state: attention("r1", SCOPE, 1, ["e1", "e2"]), events: [event("r1-e1")] }],
      outbox: { add: [outboxItem("r1", "x1", 5), outboxItem("r1", "x2", 1_000), { ...outboxItem("r1", "x3", 0), claims: 1, leaseOwner: "inline", leaseUntil: 2_000 }] },
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t1", generation: 1, dueAt: 7 }, { scope: SCOPE, runId: "r1", timerId: "t2", generation: 1, dueAt: 5_000 }] },
    });
    await store.commit({ scope: OTHER, runs: [{ runId: "r2", expectedRevision: 0, state: attention("r2", OTHER, 1, ["e3"]), events: [event("r2-e1")] }], outbox: { add: [outboxItem("r2", "y1", 3, OTHER)] } });
    await store.commit({ scope: SCOPE, runs: [createRun("r3")] });
    const h = await store.health({ now: 100 });
    eq(h.outbox, { due: 2, capped: false, oldestDueAt: 3 }, "due outbox items across tenants, not the leased or later ones");
    eq(h.timers, { due: 1, capped: false, oldestDueAt: 7 }, "due timers");
    eq(h.inDoubt, { effects: 3, runs: 2, capped: false }, "effects waiting for a person, and their runs");
    eq((await store.health({ now: 100, cap: 1 })).outbox, { due: 1, capped: true, oldestDueAt: 3 }, "counts stop at the cap");
    await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 1, state: attention("r1", SCOPE, 2, []), events: [event("r1-e2")] }] });
    eq((await store.health({ now: 100 })).inDoubt, { effects: 1, runs: 1, capped: false }, "a commit that settles them takes them off");
    await store.eraseRun(OTHER, "r2", { now: 100 });
    eq((await store.health({ now: 100 })).inDoubt, { effects: 0, runs: 0, capped: false }, "so does erasure");
    eq((await store.health({ now: 2_000 })).outbox?.due, 3, "a lease that ran out is backlog again");
  });

  // Optional members: a store without them skips these cases (the runtime then answers
  // "unavailable" for what needs them).

  it("lists a flow's live runs by run id in byte order, a page at a time, in its own scope only", async (store) => {
    if (!store.listLiveRuns) return;
    const put = (scope: Scope, runId: string, flowId: string, flowVersion: string, status: RunState["status"]) =>
      store.commit({ scope, runs: [{ runId, expectedRevision: 0, state: { ...runState(runId, 1, scope), flowId, flowVersion, status }, events: [event(`${runId}-e1`)] }] });
    await put(SCOPE, "r-a", "f", "1", "active");
    await put(SCOPE, "r-B", "f", "2", "active");
    await put(SCOPE, "r-C", "f", "1", "cancelling");
    await put(SCOPE, "r-d", "f", "1", "completed");
    await put(SCOPE, "r-e", "g", "1", "active");
    await put(OTHER, "r-x", "f", "1", "active");
    // Byte order: upper case sorts before lower case, whatever the database's collation says.
    eq(await store.listLiveRuns(SCOPE, { flowId: "f", limit: 10 }), [
      { runId: "r-B", flowVersion: "2" },
      { runId: "r-C", flowVersion: "1" },
      { runId: "r-a", flowVersion: "1" },
    ], "live runs of the flow, ordered");
    eq((await store.listLiveRuns(SCOPE, { flowId: "f", limit: 2 })).map((r) => r.runId), ["r-B", "r-C"], "first page");
    eq((await store.listLiveRuns(SCOPE, { flowId: "f", after: "r-C", limit: 2 })).map((r) => r.runId), ["r-a"], "next page");
    eq(await store.listLiveRuns(SCOPE, { flowId: "f", after: "r-a", limit: 2 }), [], "past the end");
    eq((await store.listLiveRuns(SCOPE, { flowId: "f", version: "1", limit: 10 })).map((r) => r.runId), ["r-C", "r-a"], "one version");
    eq((await store.listLiveRuns(OTHER, { flowId: "f", limit: 10 })).map((r) => r.runId), ["r-x"], "another tenant sees only its own");
    await store.commit({ scope: SCOPE, runs: [{ runId: "r-a", expectedRevision: 1, state: { ...runState("r-a", 2), flowVersion: "1", status: "completed" }, events: [event("r-a-e2")] }] });
    eq((await store.listLiveRuns(SCOPE, { flowId: "f", limit: 10 })).map((r) => r.runId), ["r-B", "r-C"], "an ended run is no longer listed");
    await store.eraseRun(SCOPE, "r-B");
    eq((await store.listLiveRuns(SCOPE, { flowId: "f", limit: 10 })).map((r) => r.runId), ["r-C"], "an erased run is gone");
  });

  it("takes back only an item never sent, due or not, and leaves it as it was when the lease ends", async (store) => {
    if (!store.takeOutbox) return;
    await store.commit({
      scope: SCOPE,
      runs: [createRun("r1")],
      outbox: {
        add: [
          outboxItem("r1", "x1", 50),
          outboxItem("r1", "x2", 0),
          { ...outboxItem("r1", "x3", 0), claims: 1 },
          { ...outboxItem("r1", "x4", 0), leaseOwner: "inline", leaseUntil: 100 },
          outboxItem("r1", "x5", 0),
        ],
      },
    });
    const take = (scope: Scope, id: string, owner: string, now: number) => store.takeOutbox!(scope, id, { owner, now, leaseMs: 100 });
    const ids = (items: OutboxItem[]) => items.map((i) => [i.id, i.claims]).sort();
    eq(await take(OTHER, "x1#1", "t", 10), false, "another tenant cannot take it");
    eq(await take(SCOPE, "nope#1", "t", 10), false, "an unknown id is not taken");
    eq(await take(SCOPE, "x3#1", "t", 10), false, "an item a claim counts is not taken");
    eq(await take(SCOPE, "x4#1", "t", 10), false, "an item a lease holds is not taken");
    eq(await take(SCOPE, "x1#1", "t", 10), true, "an item never sent is taken before it is due");
    eq(await take(SCOPE, "x2#1", "t", 10), true, "and when it is due");
    eq(await take(SCOPE, "x1#1", "u", 20), false, "not taken again while the lease holds");
    eq(ids(await store.claimOutbox({ owner: "w", now: 60, limit: 10, leaseMs: 1000 })), [["x3#1", 2], ["x5#1", 1]], "a taken item is not claimed while its lease holds");
    eq(await store.releaseOutbox(SCOPE, { id: "x2#1", owner: "t", until: 110 }, 0), true, "its taker can hand it back");
    eq(ids(await store.claimOutbox({ owner: "w", now: 110, limit: 10, leaseMs: 1000 })), [["x1#1", 1], ["x2#1", 1], ["x4#1", 1]], "claimable again with no claim spent, once handed back or the lease ends");
    await store.commit({ scope: SCOPE, runs: [createRun("r2")], outbox: { add: [outboxItem("r2", "y1", 0)] } });
    const [claimed, taken] = await Promise.all([store.claimOutbox({ owner: "w", now: 2000, limit: 10, leaseMs: 100 }), take(SCOPE, "y1#1", "t", 2000)]);
    eq(claimed.filter((i) => i.id === "y1#1").length + (taken ? 1 : 0), 1, "of a claim and a take at once, exactly one gets the item");
  });

  it("removes a taken item in a commit only while its lease holds, and stores nothing of the batch otherwise", async (store) => {
    if (!store.takeOutbox) return;
    await store.commit({ scope: SCOPE, runs: [createRun("r1")], outbox: { add: [outboxItem("r1", "x1", 0), outboxItem("r1", "x2", 0)] } });
    eq(await store.takeOutbox(SCOPE, "x1#1", { owner: "t1", now: 10, leaseMs: 1000 }), true, "x1 taken");
    eq(await store.takeOutbox(SCOPE, "x2#1", { owner: "t2", now: 10, leaseMs: 100 }), true, "x2 taken");
    // x2's taker outlives its lease, and a worker claims it meanwhile.
    eq((await store.claimOutbox({ owner: "w", now: 110, limit: 10, leaseMs: 5000 })).map((i) => i.id), ["x2#1"], "the worker claims x2 once its lease ends");
    const lease = (id: string, owner: string, until: number) => ({ id, owner, until });
    const both = await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("r1-e2")] }],
      outbox: { add: [outboxItem("r1", "x3", 0)], done: ["x1#1", "x2#1"], taken: [lease("x1#1", "t1", 1010), lease("x2#1", "t2", 110)] },
      timers: { set: [{ scope: SCOPE, runId: "r1", timerId: "t", generation: 1, dueAt: 0 }] },
      waits: { open: [{ scope: SCOPE, runId: "r1", stepId: "s", event: "ev", key: "k" }] },
    });
    eq(both, { ok: false, conflict: "outbox", id: "x2#1" }, "a lease that no longer holds conflicts, with the item's id");
    eq((await store.loadRun(SCOPE, "r1"))?.revision, 1, "run not written");
    eq((await store.listEvents(SCOPE, "r1")).length, 1, "no event stored");
    eq(await store.findWaiting(SCOPE, "ev", "k"), [], "no wait stored");
    eq((await store.claimTimers({ owner: "w", now: 120, limit: 10, leaseMs: 100 })).length, 0, "no timer stored");
    eq(await store.renewOutbox(SCOPE, lease("x2#1", "w", 5110), 5200), true, "the worker still holds x2");
    eq(await store.renewOutbox(SCOPE, lease("x1#1", "t1", 1010), 1010), true, "x1 is still there, still taken");
    const one = await store.commit({
      scope: SCOPE,
      runs: [{ runId: "r1", expectedRevision: 1, state: runState("r1", 2), events: [event("r1-e2")] }],
      outbox: { done: ["x1#1"], taken: [lease("x1#1", "t1", 1010)] },
    });
    eq(one, { ok: true }, "a lease that holds commits");
    eq((await store.claimOutbox({ owner: "w2", now: 99_999, limit: 10, leaseMs: 100 })).map((i) => i.id), ["x2#1"], "x1 is gone, x2 is not");
    const again = await store.commit({ scope: SCOPE, runs: [{ runId: "r1", expectedRevision: 2, state: runState("r1", 3), events: [event("r1-e3")] }], outbox: { taken: [lease("x1#1", "t1", 1010)] } });
    eq(again, { ok: false, conflict: "outbox", id: "x1#1" }, "an item that is gone conflicts");
    await store.commit({ scope: SCOPE, runs: [createRun("r2")], outbox: { add: [outboxItem("r2", "y1", 0)] } });
    eq(await store.takeOutbox(SCOPE, "y1#1", { owner: "t", now: 200_000, leaseMs: 100 }), true, "y1 taken");
    const [claimed, committed] = await Promise.all([
      store.claimOutbox({ owner: "w3", now: 200_100, limit: 10, leaseMs: 100 }),
      store.commit({ scope: SCOPE, runs: [{ runId: "r2", expectedRevision: 1, state: runState("r2", 2), events: [event("r2-e2")] }], outbox: { done: ["y1#1"], taken: [lease("y1#1", "t", 200_100)] } }),
    ]);
    eq(claimed.filter((i) => i.id === "y1#1").length + (committed.ok ? 1 : 0), 1, "of a claim and a commit at once, exactly one gets the item");
  });

  it("says whether a stored run is on a version, ended runs included, in its own scope only", async (store) => {
    if (!store.hasRunOnVersion) return;
    const on = (scope: Scope, flowId: string, version: string) => store.hasRunOnVersion!(scope, { flowId, version });
    const put = (scope: Scope, runId: string, flowId: string, flowVersion: string, status: RunState["status"]) =>
      store.commit({ scope, runs: [{ runId, expectedRevision: 0, state: { ...runState(runId, 1, scope), flowId, flowVersion, status }, events: [event(`${runId}-e1`)] }] });
    eq(await on(SCOPE, "f", "1"), false, "an empty store has a run on a version");
    await put(SCOPE, "r-a", "f", "1", "completed");
    await put(SCOPE, "r-b", "f", "2", "active");
    await put(SCOPE, "r-c", "g", "3", "cancelled");
    await put(OTHER, "r-x", "f", "4", "active");
    eq(await on(SCOPE, "f", "1"), true, "a run that ended does not keep its version");
    eq(await on(SCOPE, "f", "2"), true, "a live run does not keep its version");
    eq(await on(SCOPE, "g", "3"), true, "a cancelled run of another flow does not keep its version");
    eq([await on(SCOPE, "f", "3"), await on(SCOPE, "g", "1")], [false, false], "a run of one flow keeps a version of another");
    eq([await on(SCOPE, "f", "4"), await on(SIBLING, "f", "1")], [false, false], "a run of another tenant or app keeps a version here");
    eq(await on(OTHER, "f", "4"), true, "another tenant's run does not keep its own version there");
    // A run that moves to another version is no longer on the one it left (its replay still needs it: the catalog asks about that).
    await store.commit({ scope: SCOPE, runs: [{ runId: "r-b", expectedRevision: 1, state: { ...runState("r-b", 2), flowVersion: "5" }, events: [event("r-b-e2")] }] });
    eq([await on(SCOPE, "f", "2"), await on(SCOPE, "f", "5")], [false, true], "a run is not on the version it now has");
    await store.eraseRun(SCOPE, "r-a");
    eq(await on(SCOPE, "f", "1"), false, "an erased run still keeps its version");
  });

  return cases;
}
