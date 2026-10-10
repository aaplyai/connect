/**
 * Behaviour every RunStore with fair lanes (`store.lanes`) must have, on top
 * of `storeConformanceCases`. Framework-free: each case throws on failure.
 *
 *   for (const c of laneConformanceCases((config) => makeStore(config))) it(c.name, c.run);
 *
 * `makeStore` gets the lane limits and classes to configure and must return
 * an empty store.
 */

import type { LaneClass, LaneLimit, LaneSignal, Priority } from "../lanes.js";
import type { ActionEffect, Scope } from "../state.js";
import type { LaneOps, OutboxItem, RunStore } from "../store.js";
import type { ConformanceCase } from "./conformance.js";

/** What a lane case needs configured before it starts. */
export interface LaneConfig {
  limits: LaneLimit[];
  classes: LaneClass[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`lane conformance: ${message}`);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`lane conformance: ${message}\n  expected ${b}\n  got      ${a}`);
}

const A: Scope = { tenantId: "t-a", appId: "app", environmentId: "env" };
const B: Scope = { tenantId: "t-b", appId: "app", environmentId: "env" };
const C: Scope = { tenantId: "t-c", appId: "app", environmentId: "env" };

function effect(effectId: string, actingFor: "business" | "endUser" = "business"): ActionEffect {
  return { kind: "action", effectId, attempt: 1, purpose: "run", name: "n", action: "mail.send", actingFor, effect: "read", input: {}, idempotent: true, timeoutMs: 1000, risk: "none" };
}

interface ItemOptions {
  scope?: Scope;
  lane?: string;
  laneClass?: string;
  priority?: Priority;
  availableAt?: number;
  connectionKey?: string;
  /** A reservation: claims 0, leased to `owner` until `until`. */
  reserved?: { owner: string; until: number };
  /** Written with no lane fields at all, as by a store or runtime that knows nothing of lanes. */
  laneless?: boolean;
}

function item(id: string, o: ItemOptions = {}): OutboxItem {
  const scope = o.scope ?? A;
  return {
    id,
    scope,
    runId: `run-${id}`,
    effect: effect(id),
    context: { subjectId: null, environment: "production" },
    availableAt: o.availableAt ?? 0,
    claims: 0,
    ...(o.reserved ? { leaseOwner: o.reserved.owner, leaseUntil: o.reserved.until } : {}),
    ...(o.laneless ? {} : { lane: o.lane ?? "mail", laneClass: o.laneClass ?? "mail", priority: o.priority ?? "background" }),
    ...(o.connectionKey !== undefined ? { connectionKey: o.connectionKey } : {}),
  };
}

const ids = (items: OutboxItem[]) => items.map((i) => i.id).sort();
const LEASE = 10_000;

export function laneConformanceCases(makeStore: (config: LaneConfig) => RunStore | Promise<RunStore>): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const it = (name: string, config: Partial<LaneConfig>, run: (store: RunStore, lanes: LaneOps) => Promise<void>) =>
    cases.push({
      name: `lanes: ${name}`,
      run: async () => {
        const store = await makeStore({ limits: config.limits ?? [], classes: config.classes ?? [] });
        assert(store.lanes, "the store has lane operations");
        await run(store, store.lanes);
      },
    });
  const add = async (store: RunStore, scope: Scope, items: OutboxItem[]) => eq(await store.commit({ scope, runs: [], outbox: { add: items } }), { ok: true }, "items added");
  const claim = (store: RunStore, now: number, limit = 100, owner = "w") => store.claimOutbox({ owner, now, limit, leaseMs: LEASE });
  const done = (store: RunStore, scope: Scope, idList: string[]) => store.commit({ scope, runs: [], outbox: { done: idList } });
  const signal = (store: RunStore, scope: Scope, now: number, signals: LaneSignal[]) => store.commit({ scope, runs: [], lanes: { now, signals } });
  const laneRow = (scope: Scope, lane: string, limits: Partial<LaneLimit>): LaneLimit => ({ tenantId: scope.tenantId, appId: scope.appId, environmentId: scope.environmentId, lane, ...limits });

  it("takes items round-robin across lanes", {}, async (store) => {
    await add(store, A, Array.from({ length: 10 }, (_, i) => item(`a${i}`, { lane: "busy", availableAt: i })));
    await add(store, A, [item("b0", { lane: "quiet", availableAt: 50 })]);
    eq(ids(await claim(store, 100, 2)), ["a0", "b0"], "one of each lane, however many the other has");
  });

  it("gives a lone lane the whole limit, earliest first", {}, async (store) => {
    await add(store, A, Array.from({ length: 6 }, (_, i) => item(`a${i}`, { availableAt: 10 - i })));
    eq(ids(await claim(store, 100, 4)), ["a2", "a3", "a4", "a5"], "work-conserving");
  });

  it("takes one run's items in the order the run wrote them, within a lane", {}, async (store) => {
    // A per-item step writes one row per item in one commit: same lane, same due time, effect ids
    // `<runId>.<n>`. They go in that order, also past `.9` and `.99`, however they were added.
    const seqs = [12, 3, 100, 9, 1, 10, 2, 11, 99];
    await add(store, A, seqs.map((n) => ({ ...item(`r.${n}#1`), runId: "r" })));
    const order: string[] = [];
    for (let i = 0; i < seqs.length; i++) order.push(...(await claim(store, 100, 1)).map((x) => x.id));
    eq(order, [...seqs].sort((a, b) => a - b).map((n) => `r.${n}#1`), "per-run FIFO inside the lane");
  });

  it("goes round-robin across tenants, not only lanes", {}, async (store) => {
    await add(store, A, Array.from({ length: 8 }, (_, i) => item(`a${i}`)));
    await add(store, B, [item("b0", { scope: B })]);
    await add(store, C, [item("c0", { scope: C })]);
    const first = await claim(store, 100, 3);
    eq(first.map((i) => i.scope.tenantId).sort(), ["t-a", "t-b", "t-c"], "every tenant's lane gets a turn");
  });

  it("claims due work behind 200 tenants holding only work that is not due", {}, async (store) => {
    for (let t = 0; t < 200; t++) {
      const scope = { ...A, tenantId: `a-${String(t).padStart(3, "0")}` };
      await add(store, scope, [item(`later${t}`, { scope, availableAt: 60_000 })]);
    }
    const z = { ...A, tenantId: "z" };
    await add(store, z, [item("due", { scope: z })]);
    eq(ids(await claim(store, 100, 10)), ["due"], "the first claim finds it");
    eq(ids(await claim(store, 100, 10)), [], "and nothing else is due");
  });

  it("claims due work behind 200 lanes of one tenant holding only work that is not due", {}, async (store) => {
    await add(store, A, Array.from({ length: 200 }, (_, i) => item(`later${i}`, { lane: `l-${String(i).padStart(3, "0")}`, availableAt: 60_000 })));
    await add(store, A, [item("due", { lane: "z" })]);
    eq(ids(await claim(store, 100, 10)), ["due"], "the first claim finds it");
  });

  it("claims a due timer behind 200 tenants whose timers are not due", {}, async (store) => {
    for (let t = 0; t < 200; t++) {
      const scope = { ...A, tenantId: `a-${String(t).padStart(3, "0")}` };
      await store.commit({ scope, runs: [], timers: { set: [{ scope, runId: "r", timerId: "later", generation: 1, dueAt: 86_400_000 }] } });
    }
    const z = { ...A, tenantId: "z" };
    await store.commit({ scope: z, runs: [], timers: { set: [{ scope: z, runId: "r", timerId: "due", generation: 1, dueAt: 99 }] } });
    const got = await store.claimTimers({ owner: "w", now: 100, limit: 10, leaseMs: LEASE });
    eq(got.map((t) => `${t.scope.tenantId}/${t.timerId}`), ["z/due"], "the first claim finds it");
  });

  it("ranks priority within a round: one tenant's interactive burst never holds back another's background item", {}, async (store) => {
    await add(store, B, [item("b-old", { scope: B, availableAt: 0 })]);
    await add(store, A, Array.from({ length: 100 }, (_, i) => item(`burst${i}`, { priority: "interactive", availableAt: 50 })));
    // The old ranking (interactive first across every lane) gave all 10 to the burst, pass after pass.
    const got = await claim(store, 100, 10);
    assert(ids(got).includes("b-old"), `B's item in the first claim (got ${ids(got).join(", ")})`);
    eq(got.filter((i) => i.scope.tenantId === A.tenantId).length, 9, "the burst takes the rest");
    // A claim of one: tenants still take turns.
    await add(store, B, [item("b-next", { scope: B, availableAt: 0 })]);
    const turns: string[] = [];
    for (let i = 0; i < 4; i++) turns.push(...(await claim(store, 200, 1)).map((x) => x.scope.tenantId));
    eq(turns, ["t-b", "t-a", "t-a", "t-a"], "B's turn comes after A's, interactive or not; then the burst alone");
  });

  it("keeps the interactive reserve and order within a tenant", { limits: [{ tenantId: A.tenantId, cap: 4, reserve: 0.25 }] }, async (store) => {
    await add(store, A, Array.from({ length: 6 }, (_, i) => item(`bg${i}`, { availableAt: i })));
    await add(store, A, [item("i0", { lane: "chat", priority: "interactive", availableAt: 50 })]);
    eq(ids(await claim(store, 100, 1)), ["i0"], "within a round of A's lanes, interactive first");
    eq(ids(await claim(store, 100, 4)), ["bg0", "bg1", "bg2"], "mail's background stops at its reserve (cap 4, reserve 1)");
    eq(ids(await claim(store, 100, 1)), [], "the reserved slot stays for interactive work");
  });

  it("is fair per tenant first: a tenant with 100 apps takes half the claims from a tenant with one", {}, async (store) => {
    for (let a = 0; a < 100; a++) {
      const scope = { ...A, appId: `app-${String(a).padStart(3, "0")}` };
      await add(store, scope, Array.from({ length: 5 }, (_, i) => item(`a${a}-${i}`, { scope })));
    }
    await add(store, B, Array.from({ length: 50 }, (_, i) => item(`b${i}`, { scope: B })));
    const got: OutboxItem[] = [];
    for (let pass = 0; pass < 10; pass++) got.push(...(await claim(store, 100 + pass, 10)));
    eq(got.filter((i) => i.scope.tenantId === B.tenantId).length, 50, "B: half of 100 claims");
    const apps = got.filter((i) => i.scope.tenantId === A.tenantId).map((i) => i.scope.appId);
    eq([apps.length, new Set(apps).size], [50, 50], "A: the other half, one from each of 50 apps in turn");
  });

  it("goes round-robin across a tenant's lanes from one claim to the next", {}, async (store) => {
    await add(store, A, ["l1", "l2", "l3"].flatMap((lane) => Array.from({ length: 3 }, (_, i) => item(`${lane}-${i}`, { lane, availableAt: i }))));
    await add(store, B, Array.from({ length: 6 }, (_, i) => item(`b${i}`, { scope: B, availableAt: i })));
    const order: string[] = [];
    for (let i = 0; i < 8; i++) order.push(...(await claim(store, 100, 1)).map((x) => x.id));
    eq(order, ["l1-0", "b0", "l2-0", "b1", "l3-0", "b2", "l1-1", "b3"], "tenants alternate, and A's lanes take turns across claims");
  });

  it("never grants past a lane's cap; done and lease expiry free slots", { limits: [{ tenantId: A.tenantId, cap: 2, reserve: 0 }] }, async (store) => {
    await add(store, A, Array.from({ length: 5 }, (_, i) => item(`a${i}`, { availableAt: i })));
    eq(ids(await claim(store, 100)), ["a0", "a1"], "cap 2");
    eq(ids(await claim(store, 200)), [], "full while both are in flight");
    await done(store, A, ["a0"]);
    eq(ids(await claim(store, 300)), ["a2"], "a done frees one slot");
    // a1's lease (from 100) ends at 100 + LEASE; a2's (from 300) is still running. An item whose
    // lease ended is due again from that time, so a3 (due at 3) goes before it.
    eq(ids(await claim(store, 100 + LEASE)), ["a3"], "an expired lease frees its slot");
    eq(ids(await claim(store, 300 + LEASE)), ["a4"], "and the next one");
  });

  it("keeps the reserve for interactive work", { limits: [{ tenantId: A.tenantId, cap: 4, reserve: 0.25 }] }, async (store) => {
    await add(store, A, Array.from({ length: 6 }, (_, i) => item(`bg${i}`, { availableAt: i })));
    eq((await claim(store, 100)).length, 3, "background stops at floor(4 * 0.75)");
    await add(store, A, [item("i0", { priority: "interactive", availableAt: 200 }), item("i1", { priority: "interactive", availableAt: 201 })]);
    eq(ids(await claim(store, 300)), ["i0"], "interactive takes the reserved slot, and no more than the cap");
  });

  it("claims interactive items before background ones", { limits: [{ tenantId: A.tenantId, cap: 2, reserve: 0 }] }, async (store) => {
    await add(store, A, [item("bg", { availableAt: 0 }), item("i0", { priority: "interactive", availableAt: 50 }), item("i1", { priority: "interactive", availableAt: 60 })]);
    await add(store, B, [item("b-bg", { scope: B, availableAt: 0 }), item("b-i", { scope: B, priority: "interactive", availableAt: 70 })]);
    const got = await claim(store, 100, 3);
    eq(ids(got), ["b-i", "i0", "i1"], "interactive first within each tenant's round");
  });

  it("spends and refills a lane's token bucket, keeping reserve tokens", { limits: [laneRow(A, "mail", { ratePerSec: 4, burst: 4, reserve: 0.25 })] }, async (store) => {
    await add(store, A, Array.from({ length: 10 }, (_, i) => item(`bg${i}`, { availableAt: i })));
    eq((await claim(store, 1000)).length, 3, "background leaves reserve * burst = 1 token");
    await add(store, A, [item("i0", { priority: "interactive" }), item("i1", { priority: "interactive" })]);
    eq(ids(await claim(store, 1000)), ["i0"], "interactive may take the last token");
    eq((await claim(store, 1100)).length, 0, "0.4 tokens after 100 ms");
    eq(ids(await claim(store, 1250)), ["i1"], "1 token after 250 ms, interactive first");
    eq((await claim(store, 2250)).length, 3, "refilled to the burst (4), background leaves 1");
  });

  // Claimers' clocks differ. A bucket stamped with a claimer's time that is behind the last stamp
  // would refill the same interval twice; here a replica 1 s behind takes turns with one on time.
  it("never refills a bucket twice when claimers' clocks differ", { limits: [laneRow(A, "mail", { ratePerSec: 5, burst: 5, reserve: 0 })] }, async (store) => {
    await add(store, A, Array.from({ length: 40 }, (_, i) => item(`a${i}`)));
    let granted = 0;
    for (let i = 0; i < 30; i++) {
      granted += (await claim(store, 10_000 + 2 * i, 1, "on-time")).length;
      granted += (await claim(store, 9_000 + 2 * i + 1, 1, "behind")).length;
    }
    eq(granted, 5, "the burst and 60 ms of refill at 5/s: 5 grants");
  });

  it("never refills a lane class's bucket twice when claimers' clocks differ", { classes: [{ laneClass: "mail", ratePerSec: 5, burst: 5, reserve: 0 }] }, async (store) => {
    await add(store, A, Array.from({ length: 20 }, (_, i) => item(`a${i}`)));
    await add(store, B, Array.from({ length: 20 }, (_, i) => item(`b${i}`, { scope: B })));
    let granted = 0;
    for (let i = 0; i < 30; i++) {
      granted += (await claim(store, 10_000 + 2 * i, 1, "on-time")).length;
      granted += (await claim(store, 9_000 + 2 * i + 1, 1, "behind")).length;
    }
    eq(granted, 5, "one bucket shared by both tenants: 5 grants");
  });

  // A per-item step's later rows are background once nobody has given input for a while; a reserve
  // that took a small lane's only slot or token would hold them, and their run, for ever.
  it("never lets the reserve take a lane's last slot: background moves at cap 1", { limits: [{ tenantId: A.tenantId, cap: 1, reserve: 0.25 }] }, async (store) => {
    await add(store, A, [item("bg0", { availableAt: 0 }), item("bg1", { availableAt: 1 })]);
    eq(ids(await claim(store, 100)), ["bg0"], "one background item in flight");
    eq(ids(await claim(store, 200)), [], "and no more than the cap");
    await done(store, A, ["bg0"]);
    eq(ids(await claim(store, 300)), ["bg1"], "the next once it is done");
  });

  it("never lets the reserve take a bucket's last token: background moves at burst 1", { limits: [laneRow(A, "mail", { ratePerSec: 1, burst: 1, reserve: 0.25 })], classes: [{ laneClass: "mail", ratePerSec: 1, burst: 1, reserve: 0.5 }] }, async (store) => {
    await add(store, A, [item("bg0", { availableAt: 0 }), item("bg1", { availableAt: 1 })]);
    eq(ids(await claim(store, 1000)), ["bg0"], "a full bucket of one token serves background");
    eq(ids(await claim(store, 1500)), [], "half a token");
    eq(ids(await claim(store, 2000)), ["bg1"], "refilled");
  });

  it("pauses only the lane a Retry-After names, for at most maxPauseMs", { limits: [{ tenantId: A.tenantId, maxPauseMs: 5_000 }] }, async (store) => {
    await add(store, A, [item("m0", { lane: "mail" }), item("m1", { lane: "mail" }), item("c0", { lane: "crm" })]);
    eq(await signal(store, A, 100, [{ lane: "mail", laneClass: "mail", kind: "rate_limited", retryAfterMs: 86_400_000 }]), { ok: true }, "signal committed");
    eq(ids(await claim(store, 200)), ["c0"], "the other lane goes on");
    eq(ids(await claim(store, 5_099)), [], "paused until now + maxPauseMs");
    eq(ids(await claim(store, 5_100)), ["m0", "m1"], "the pause ends");
  });

  it("pauses one end user's connection, not the lane", {}, async (store) => {
    await add(store, A, [item("u1a", { connectionKey: "k1" }), item("u1b", { connectionKey: "k1" }), item("u2", { connectionKey: "k2" }), item("biz")]);
    await signal(store, A, 100, [{ lane: "mail", laneClass: "mail", connectionKey: "k1", kind: "rate_limited", retryAfterMs: 1_000, bucket: "connection" }]);
    eq(ids(await claim(store, 200)), ["biz", "u2"], "only k1's items wait");
    eq(ids(await claim(store, 1_100)), ["u1a", "u1b"], "and come back after the pause");
  });

  it("pauses a whole lane class for a connector limit, across tenants", {}, async (store) => {
    await add(store, A, [item("a-mail", { lane: "mail", laneClass: "mail" }), item("a-crm", { lane: "crm", laneClass: "crm" })]);
    await add(store, B, [item("b-mail", { scope: B, lane: "biz", laneClass: "mail" })]);
    await signal(store, A, 100, [{ lane: "mail", laneClass: "mail", kind: "rate_limited", retryAfterMs: 1_000, bucket: "connector" }]);
    eq(ids(await claim(store, 200)), ["a-crm"], "every lane of the class waits");
    eq(ids(await claim(store, 1_100)), ["a-mail", "b-mail"], "until the pause ends");
  });

  it("shares a lane class's token bucket across tenants", { classes: [{ laneClass: "mail", ratePerSec: 1, burst: 2, reserve: 0 }] }, async (store) => {
    await add(store, A, [item("a0"), item("a1")]);
    await add(store, B, [item("b0", { scope: B }), item("b1", { scope: B })]);
    const first = await claim(store, 1000);
    eq(first.length, 2, "two tokens for both tenants together");
    eq(first.map((i) => i.scope.tenantId).sort(), ["t-a", "t-b"], "round-robin within the class budget");
    eq((await claim(store, 1500)).length, 0, "half a token");
    eq((await claim(store, 2000)).length, 1, "one more token");
  });

  it(
    "opens the breaker on enough failures that are also a share of the claims, sends one probe at a time, reopens with a doubled period and closes on success",
    { limits: [laneRow(A, "mail", { cap: 10, reserve: 0, breakerFailures: 2, breakerRatio: 0.5, breakerWindowMs: 10_000, openMs: 1_000, maxOpenMs: 4_000 })] },
    async (store, lanes) => {
      await add(store, A, Array.from({ length: 4 }, (_, i) => item(`a${i}`)));
      eq((await claim(store, 100)).length, 4, "all four claimed while closed");
      await done(store, A, ["a0", "a1", "a2", "a3"]);
      await signal(store, A, 200, [{ lane: "mail", kind: "failure" }]);
      await add(store, A, [item("x0"), item("x1"), item("x2"), item("x3")]);
      eq((await claim(store, 300, 1)).length, 1, "one failure (below the minimum of 2) keeps it closed");
      await done(store, A, ["x0"]);
      await signal(store, A, 400, [{ lane: "mail", kind: "failure" }]);
      eq((await claim(store, 450, 1)).length, 1, "two failures in five claims (below 50%) keep it closed");
      await done(store, A, ["x1"]);
      await signal(store, A, 500, [{ lane: "mail", kind: "failure" }]);
      eq((await claim(store, 550)).length, 0, "three failures in six claims open it");
      await add(store, A, [item("r0", { reserved: { owner: "api", until: 5_000 } })]);
      const refused = await lanes.claimInline(A, ["r0"], { owner: "api", now: 700, leaseMs: LEASE });
      eq(refused.refused.map((r) => [r.id, r.reason, r.retryAfterMs]), [["r0", "unavailable", 800]], "inline refused while open, with the time left");
      eq((await claim(store, 1_499)).length, 0, "still open");
      const probe = await claim(store, 1_500);
      eq(probe.map((i) => i.probe === true), [true], "one probe after the open period");
      eq((await claim(store, 1_500)).length, 0, "only one probe at a time");
      eq((await lanes.claimInline(A, ["r0"], { owner: "api", now: 1_500, leaseMs: LEASE })).refused.map((r) => r.reason), ["unavailable"], "inline waits for the probe too");
      await done(store, A, [probe[0]!.id]);
      await signal(store, A, 1_600, [{ lane: "mail", kind: "failure", probe: true }]);
      eq((await claim(store, 3_599)).length, 0, "a failed probe reopens it for twice as long");
      const second = await claim(store, 3_600);
      eq(second.map((i) => i.probe === true), [true], "the next probe");
      await done(store, A, [second[0]!.id]);
      await signal(store, A, 3_700, [{ lane: "mail", kind: "success", probe: true }]);
      const rest = await claim(store, 3_800);
      eq([rest.length, rest.some((i) => i.probe === true)], [1, false], "closed again: what is left is claimed, not as a probe");
    },
  );

  it("refuses an inline reservation the lane cannot take, and makes it claimable now", { limits: [{ tenantId: A.tenantId, cap: 1, reserve: 0 }] }, async (store, lanes) => {
    await add(store, A, [item("w0")]);
    eq(ids(await claim(store, 100)), ["w0"], "a worker fills the lane");
    await add(store, A, [item("r0", { priority: "interactive", reserved: { owner: "api", until: 5_100 } })]);
    const grant = await lanes.claimInline(A, ["r0"], { owner: "api", now: 200, leaseMs: LEASE });
    eq(grant.granted, [], "nothing granted");
    eq(grant.refused.map((r) => [r.id, r.reason]), [["r0", "capacity"]], "refused for capacity");
    await done(store, A, ["w0"]);
    eq((await claim(store, 200)).map((i) => [i.id, i.claims]), [["r0", 1]], "claimable at once, its first claim");
  });

  it("grants inline reservations up to the cap, in order, and reports a taken item", { limits: [{ tenantId: A.tenantId, cap: 2, reserve: 0 }] }, async (store, lanes) => {
    await add(store, A, ["r0", "r1", "r2"].map((id) => item(id, { priority: "interactive", reserved: { owner: "api", until: 5_000 } })));
    const grant = await lanes.claimInline(A, ["r0", "r1", "r2", "nope"], { owner: "api", now: 100, leaseMs: LEASE });
    eq(grant.granted.map((i) => [i.id, i.claims, i.leaseOwner, i.leaseUntil]), [["r0", 1, "api", 100 + LEASE], ["r1", 1, "api", 100 + LEASE]], "two granted, leased");
    eq(grant.refused.map((r) => [r.id, r.reason]), [["r2", "capacity"], ["nope", "taken"]], "the third refused, an unknown id taken");
    const again = await lanes.claimInline(A, ["r0"], { owner: "api", now: 100, leaseMs: LEASE });
    eq(again.refused.map((r) => [r.id, r.reason]), [["r0", "taken"]], "a granted item is not granted twice");
    const other = await lanes.claimInline(B, ["r2"], { owner: "api", now: 100, leaseMs: LEASE });
    eq(other.refused.map((r) => [r.id, r.reason]), [["r2", "taken"]], "another scope's ids match nothing");
  });

  it("counts an item a worker holds as in flight, even when its id is in the inline request", { limits: [{ tenantId: A.tenantId, cap: 1, reserve: 0 }] }, async (store, lanes) => {
    await add(store, A, [item("w0")]);
    eq(ids(await claim(store, 100)), ["w0"], "a worker holds the only slot");
    await add(store, A, [item("r0", { priority: "interactive", reserved: { owner: "api", until: 5_100 } })]);
    const grant = await lanes.claimInline(A, ["r0", "w0"], { owner: "api", now: 200, leaseMs: LEASE });
    eq(grant.granted, [], "nothing granted");
    eq(grant.refused.map((r) => [r.id, r.reason]), [["r0", "capacity"], ["w0", "taken"]], "the reservation refused for capacity, the worker's item taken");
  });

  it("does not let workers take a reservation until its grace ends, then claims it once", {}, async (store) => {
    await add(store, A, [item("r0", { reserved: { owner: "api", until: 5_000 } })]);
    eq(await claim(store, 4_999), [], "reserved");
    eq((await claim(store, 5_000)).map((i) => [i.id, i.claims]), [["r0", 1]], "a worker sends it with claims 1");
  });

  it("counts reservations as in flight for workers", { limits: [{ tenantId: A.tenantId, cap: 1, reserve: 0 }] }, async (store) => {
    await add(store, A, [item("r0", { reserved: { owner: "api", until: 5_000 } }), item("w0")]);
    eq(await claim(store, 100), [], "the reservation holds the only slot");
    eq((await claim(store, 5_000)).length, 1, "and frees it when its grace ends");
  });

  it("keeps lane \"-\" and items without lane fields unlimited", { limits: [{ cap: 1, ratePerSec: 1, burst: 1, capMax: 1 }, { tenantId: A.tenantId, cap: 1 }] }, async (store, lanes) => {
    await add(store, A, [item("call0", { lane: "-", laneClass: "-" }), item("call1", { lane: "-", laneClass: "-" }), item("old0", { laneless: true }), item("old1", { laneless: true })]);
    eq(ids(await claim(store, 100)), ["call0", "call1", "old0", "old1"], "no cap, rate or ceiling");
    await signal(store, A, 150, [{ lane: "-", kind: "rate_limited", retryAfterMs: 60_000 }, { lane: "-", kind: "failure" }]);
    await add(store, A, [item("call2", { lane: "-", laneClass: "-", reserved: { owner: "api", until: 5_000 } }), item("call3", { lane: "-", laneClass: "-" })]);
    eq((await lanes.claimInline(A, ["call2"], { owner: "api", now: 200, leaseMs: LEASE })).granted.map((i) => i.id), ["call2"], "granted inline");
    eq(ids(await claim(store, 200)), ["call3"], "signals on lane \"-\" change nothing");
  });

  it("clamps a tenant's cap and rate by the platform ceilings", { limits: [{ capMax: 2, rateMax: 1000, reserve: 0 }, { tenantId: A.tenantId, cap: 50 }] }, async (store) => {
    await add(store, A, Array.from({ length: 5 }, (_, i) => item(`a${i}`)));
    eq((await claim(store, 100)).length, 2, "capMax 2");
  });

  it("resolves the most specific limit per field", { limits: [{ cap: 10, reserve: 0 }, { tenantId: A.tenantId, cap: 3 }, laneRow(A, "mail", { reserve: 0.5 }), { tenantId: B.tenantId, cap: 1 }] }, async (store) => {
    await add(store, A, Array.from({ length: 5 }, (_, i) => item(`m${i}`)));
    await add(store, A, Array.from({ length: 5 }, (_, i) => item(`c${i}`, { lane: "crm" })));
    const got = await claim(store, 100);
    eq(got.filter((i) => i.lane === "mail").length, 1, "mail: tenant cap 3, lane reserve 0.5: background floor(1.5)");
    eq(got.filter((i) => i.lane === "crm").length, 3, "crm: tenant cap 3, platform reserve 0");
  });

  it("keeps every lane within its cap under concurrent claimers and inline callers", { limits: [{ tenantId: A.tenantId, cap: 2, reserve: 0 }] }, async (store, lanes) => {
    const lanesNames = ["l0", "l1", "l2"];
    await add(store, A, lanesNames.flatMap((lane) => Array.from({ length: 12 }, (_, i) => item(`${lane}-${i}`, { lane }))));
    await add(store, A, lanesNames.flatMap((lane) => Array.from({ length: 3 }, (_, i) => item(`${lane}-r${i}`, { lane, priority: "interactive", reserved: { owner: `api-${i}`, until: 5_000 } }))));
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, w) => claim(store, 100, 5, `w${w}`)),
      ...lanesNames.flatMap((lane) => Array.from({ length: 3 }, (_, i) => lanes.claimInline(A, [`${lane}-r${i}`], { owner: `api-${i}`, now: 100, leaseMs: LEASE }).then((g) => g.granted))),
    ]);
    const all = results.flat();
    eq(all.length, new Set(all.map((i) => i.id)).size, "no item granted twice");
    for (const lane of lanesNames) assert(all.filter((i) => i.lane === lane).length <= 2, `lane ${lane} within its cap of 2 (got ${all.filter((i) => i.lane === lane).length})`);
    // A lane another claimer is deciding on is skipped for that round (a worker skips it, an inline caller
    // waits a moment and is refused), so one contended round may leave a lane short. The next round fills it.
    const next = await claim(store, 100, 100, "w-next");
    const total = [...all, ...next];
    eq(total.length, new Set(total.map((i) => i.id)).size, "no item granted twice across rounds");
    for (const lane of lanesNames) eq(total.filter((i) => i.lane === lane).length, 2, `lane ${lane} full after the next round, never past its cap`);
  });

  it("goes round-robin across tenants for timers", {}, async (store) => {
    await store.commit({ scope: A, runs: [], timers: { set: Array.from({ length: 10 }, (_, i) => ({ scope: A, runId: "r", timerId: `t${i}`, generation: 1, dueAt: i })) } });
    await store.commit({ scope: B, runs: [], timers: { set: [{ scope: B, runId: "r", timerId: "late", generation: 1, dueAt: 50 }] } });
    const first = await store.claimTimers({ owner: "w", now: 100, limit: 2, leaseMs: LEASE });
    eq(first.map((t) => `${t.scope.tenantId}/${t.timerId}`).sort(), ["t-a/t0", "t-b/late"], "one per tenant, each tenant's earliest first");
  });

  it("does not apply the signals of a conflicting commit", { limits: [{ tenantId: A.tenantId, maxPauseMs: 60_000 }] }, async (store) => {
    await add(store, A, [item("m0")]);
    const stale = await store.commit({
      scope: A,
      runs: [{ runId: "missing", expectedRevision: 3, state: runStateFor(A, "missing"), events: [] }],
      lanes: { now: 100, signals: [{ lane: "mail", kind: "rate_limited", retryAfterMs: 30_000 }] },
    });
    assert(!stale.ok, "the commit conflicts");
    eq(ids(await claim(store, 200)), ["m0"], "the lane was not paused");
  });

  it(
    "counts paused lanes and lanes whose breaker is not closed, for health",
    { limits: [{ tenantId: A.tenantId, maxPauseMs: 5_000 }, laneRow(B, "mail", { cap: 10, reserve: 0, breakerFailures: 1, breakerRatio: 0.5, breakerWindowMs: 10_000, openMs: 1_000, maxOpenMs: 4_000 })] },
    async (store) => {
      if (!store.health) return;
      eq((await store.health({ now: 100 })).lanes, { paused: 0, open: 0, capped: false }, "none at first");
      await add(store, A, [item("m0")]);
      await signal(store, A, 100, [{ lane: "mail", laneClass: "mail", kind: "rate_limited", retryAfterMs: 2_000 }]);
      await add(store, B, [item("b0", { scope: B })]);
      eq(ids(await claim(store, 150)), ["b0"], "B's item claimed while A's lane waits");
      await done(store, B, ["b0"]);
      await signal(store, B, 200, [{ lane: "mail", kind: "failure" }]);
      eq((await store.health({ now: 300 })).lanes, { paused: 1, open: 1, capped: false }, "A's lane paused, B's breaker open");
      eq((await store.health({ now: 300, cap: 1 })).lanes?.capped, false, "one of each is within a cap of one");
      eq((await store.health({ now: 2_100 })).lanes?.paused, 0, "the pause ended");
    },
  );

  it("reports lane stats", { limits: [{ tenantId: A.tenantId, cap: 3 }] }, async (store, lanes) => {
    await add(store, A, [item("a0", { availableAt: 5 }), item("a1", { availableAt: 7 }), item("a2", { availableAt: 500 })]);
    await add(store, B, [item("b0", { scope: B, lane: "crm" })]);
    eq(ids(await claim(store, 100, 1)), ["a0"], "one claimed");
    const stats = await lanes.stats({ now: 100 });
    const a = stats.find((s) => s.scope.tenantId === A.tenantId && s.lane === "mail");
    assert(a, "lane of tenant A listed");
    eq([a.inFlight, a.queued, a.cap, a.breaker, a.oldestDueAt], [1, 1, 3, "closed", 7], "A's mail lane");
    eq((await lanes.stats({ now: 100, scope: B })).map((s) => [s.scope.tenantId, s.lane, s.queued]), [["t-b", "crm", 1]], "scoped to one tenant");
  });

  return cases;
}

function runStateFor(scope: Scope, runId: string) {
  return {
    v: 1 as const,
    runId,
    flowId: "f",
    flowVersion: "1",
    flowHash: "h",
    scope,
    subject: null,
    env: { locale: "en", timezone: "UTC", environment: "production" as const },
    status: "active" as const,
    revision: 4,
    createdAt: 1,
    updatedAt: 1,
    lastInputAt: 1,
    turns: 0,
    effectSeq: 0,
    facts: {},
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
