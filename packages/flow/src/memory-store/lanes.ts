/**
 * The memory store's fair lanes (ADR 0007): limits and classes, lane state
 * and signals, inline reservations, the lane stats and the fair outbox claim.
 */

import { type BusyReason, isControlled, laneQuota, afterGrant, NO_LANE, type LaneStats, tokensAt, type LaneLimit, laneLimitProblems, laneLimitKey, type LaneClass, laneClassProblems, type Priority, type LaneLimits, resolveLaneLimits, type LaneRecord, type LaneState, LANE_DEFAULTS, tokenGrants, msUntilToken, type LaneSignal, isLaneName, clampPause, applyLaneSignal, claimVisit, LANE_SCAN_FACTOR } from "../lanes.js";
import { type LaneOps, type InlineGrant, type OutboxItem, scopeKey } from "../store.js";
import type { Scope } from "../state.js";
import { type MemoryContext, clone, compareTuples, compareText, compareItemIds } from "./context.js";

/** The fair lanes' operations: inline reservations and the lane stats. */
export function laneOps(m: MemoryContext): LaneOps {
  const { outbox, connectionPauses, laneStates } = m;
  return {
    async claimInline(scope: Scope, ids: string[], o: { owner: string; now: number; leaseMs: number }): Promise<InlineGrant> {
      const out: InlineGrant = { granted: [], refused: [] };
      const sk = scopeKey(scope);
      const isReservation = (item: OutboxItem | undefined): item is OutboxItem =>
        item !== undefined && item.claims === 0 && (item.leaseOwner === o.owner || item.leaseUntil === undefined || item.leaseUntil <= o.now);
      // Reservations still being decided: their own short leases do not count against each other.
      const deciding = new Set(ids.filter((id) => isReservation(outbox.get(`${sk}|${id}`))));
      for (const id of ids) {
        const item = outbox.get(`${sk}|${id}`);
        if (!isReservation(item) || !deciding.has(id)) {
          out.refused.push({ id, reason: "taken" });
          deciding.delete(id);
          continue;
        }
        const lane = laneOf(item);
        const cls = classOf(item);
        const key = laneKeyOf(scope, lane);
        const priority = priorityOf(item);
        const refuse = (reason: BusyReason, retryAfterMs?: number) => {
          item.leaseUntil = o.now;
          delete item.leaseOwner;
          deciding.delete(id);
          out.refused.push({ id, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
        };
        if (connectionPaused(m, item, o.now)) {
          refuse("paused", (connectionPauses.get(`${key}|${item.connectionKey}`) ?? o.now) - o.now);
          continue;
        }
        const limits = limitsFor(m, scope, lane);
        const state = laneStates.get(key);
        const controlled = isControlled(limits, state);
        const quota = laneQuota(limits, state, controlled ? inFlightOf(m, scope, lane, o.now, deciding) : 0, o.now);
        if (1 > (priority === "interactive" ? quota.interactive : quota.background)) {
          if (quota.halfOpen && limits) setLaneState(m, scope, lane, state, afterGrant(limits, state, 0, o.now, true));
          refuse(quota.blocked?.reason ?? "capacity", quota.blocked?.retryAfterMs);
          continue;
        }
        if (cls !== NO_LANE) {
          const budget = classBudget(m, cls, o.now);
          if (budget.pausedUntil > o.now) {
            refuse("paused", budget.pausedUntil - o.now);
            continue;
          }
          if (1 > (priority === "interactive" ? budget.interactive : budget.background)) {
            refuse("rate", budget.retryAfterMs);
            continue;
          }
          spendClass(m, cls, 1, o.now);
        }
        if (limits && controlled) setLaneState(m, scope, lane, state, afterGrant(limits, state, 1, o.now, quota.halfOpen));
        deciding.delete(id);
        item.claims += 1;
        item.leaseOwner = o.owner;
        item.leaseUntil = o.now + o.leaseMs;
        const granted = clone(item);
        if (quota.probe) granted.probe = true;
        out.granted.push(granted);
      }
      return out;
    },

    async stats(o: { now: number; scope?: Scope; limit?: number }): Promise<LaneStats[]> {
      const lanes = new Map<string, { scope: Scope; lane: string }>();
      for (const item of outbox.values()) lanes.set(laneKeyOf(item.scope, laneOf(item)), { scope: item.scope, lane: laneOf(item) });
      for (const key of laneStates.keys()) {
        const [tenantId, appId, environmentId, lane] = JSON.parse(key) as string[];
        lanes.set(key, { scope: { tenantId: tenantId!, appId: appId!, environmentId: environmentId! }, lane: lane! });
      }
      const out: LaneStats[] = [];
      const sorted = [...lanes.values()].sort((a, b) => compareTuples(laneTuple(a.scope, a.lane), laneTuple(b.scope, b.lane)));
      for (const { scope, lane } of sorted) {
        if (o.scope && scopeKey(o.scope) !== scopeKey(scope)) continue;
        const limits = limitsFor(m, scope, lane);
        const state = laneStates.get(laneKeyOf(scope, lane));
        const items = [...outbox.values()].filter((i) => laneOf(i) === lane && scopeKey(i.scope) === scopeKey(scope));
        const queued = items.filter((i) => isDue(i, o.now));
        const tokens = limits ? tokensAt(state?.tokens ?? null, state?.tokensAt ?? 0, o.now, limits.ratePerSec, limits.burst) : Number.POSITIVE_INFINITY;
        out.push({
          scope: { ...scope },
          lane,
          inFlight: items.filter((i) => i.leaseUntil !== undefined && i.leaseUntil > o.now).length,
          queued: queued.length,
          cap: limits?.cap ?? null,
          tokens: tokens === Number.POSITIVE_INFINITY ? null : tokens,
          pausedUntil: state && state.pausedUntil > o.now ? state.pausedUntil : null,
          breaker: state?.breaker ?? "closed",
          openUntil: state && state.breaker !== "closed" ? state.openUntil : null,
          oldestDueAt: queued.length > 0 ? Math.min(...queued.map((i) => i.availableAt)) : null,
        });
        if (o.limit !== undefined && out.length >= o.limit) break;
      }
      return out;
    },
  };
}

export function setLimits(m: MemoryContext, rows: LaneLimit[]) {
  const byKey = new Map<string, LaneLimit>();
  for (const row of rows) {
    const problems = laneLimitProblems(row);
    if (problems.length > 0) throw new Error(`lane limits: ${problems.join("; ")}`);
    byKey.set(laneLimitKey(row), { ...row });
  }
  m.limitRows = [...byKey.values()];
}

export function setClasses(m: MemoryContext, rows: LaneClass[]) {
  const next = new Map<string, LaneClass>();
  for (const row of rows) {
    const problems = laneClassProblems(row);
    if (problems.length > 0) throw new Error(`lane classes: ${problems.join("; ")}`);
    next.set(row.laneClass, { ...row });
  }
  m.classRows = next;
}

export function laneOf(item: OutboxItem) {
  return item.lane ?? NO_LANE;
}

export function classOf(item: OutboxItem) {
  return item.laneClass ?? NO_LANE;
}

export function priorityOf(item: OutboxItem): Priority {
  return item.priority ?? "background";
}

/** Lane keys sort like the Postgres index: (tenant, app, environment, lane). */
export function laneTuple(scope: Scope, lane: string) {
  return [scope.tenantId, scope.appId, scope.environmentId, lane];
}

export function laneKeyOf(scope: Scope, lane: string) {
  return JSON.stringify(laneTuple(scope, lane));
}

export function limitsFor(m: MemoryContext, scope: Scope, lane: string): LaneLimits | null {
  const { fair } = m;
  return (fair ? resolveLaneLimits(m.limitRows, scope, lane) : null);
}

export function claimableAt(item: OutboxItem) {
  return Math.max(item.availableAt, item.leaseUntil ?? Number.NEGATIVE_INFINITY);
}

export function isDue(item: OutboxItem, now: number) {
  return item.availableAt <= now && (item.leaseUntil === undefined || item.leaseUntil <= now);
}

export function inFlightOf(m: MemoryContext, scope: Scope, lane: string, now: number, except?: Set<string>) {
  const { outbox } = m;
  const sk = scopeKey(scope);
  let n = 0;
  for (const item of outbox.values()) {
    if (laneOf(item) === lane && scopeKey(item.scope) === sk && item.leaseUntil !== undefined && item.leaseUntil > now && !except?.has(item.id)) n++;
  }
  return n;
}

export function report(m: MemoryContext, record: LaneRecord) {
  const { fair } = m;
  try {
    fair?.onLane?.(record);
  } catch {
    // An observer must not break a claim or a commit.
  }
}

export function setLaneState(m: MemoryContext, scope: Scope, lane: string, before: LaneState | undefined, after: LaneState) {
  const { laneStates } = m;
  laneStates.set(laneKeyOf(scope, lane), after);
  if ((before?.breaker ?? "closed") !== after.breaker) report(m, { scope, lane, kind: "breaker", breaker: { from: before?.breaker ?? "closed", to: after.breaker } });
}

/** A lane class's whole grants per priority, its pause, and how long until it has a token. */
export function classBudget(m: MemoryContext, laneClass: string, now: number): { interactive: number; background: number; pausedUntil: number; retryAfterMs: number } {
  const { classStates } = m;
  const row = m.classRows.get(laneClass);
  const st = classStates.get(laneClass);
  const pausedUntil = st?.pausedUntil ?? 0;
  if (pausedUntil > now) return { interactive: 0, background: 0, pausedUntil, retryAfterMs: pausedUntil - now };
  if (!row || row.ratePerSec == null) return { interactive: Number.POSITIVE_INFINITY, background: Number.POSITIVE_INFINITY, pausedUntil, retryAfterMs: 0 };
  const burst = row.burst ?? Math.max(1, row.ratePerSec);
  const tokens = tokensAt(st?.tokens ?? null, st?.tokensAt ?? 0, now, row.ratePerSec, burst);
  const reserve = row.reserve ?? LANE_DEFAULTS.reserve;
  return {
    interactive: tokenGrants(tokens, reserve, burst, "interactive"),
    background: tokenGrants(tokens, reserve, burst, "background"),
    pausedUntil,
    retryAfterMs: msUntilToken(tokens, row.ratePerSec),
  };
}

export function spendClass(m: MemoryContext, laneClass: string, n: number, now: number) {
  const { classStates } = m;
  const row = m.classRows.get(laneClass);
  if (n === 0 || !row || row.ratePerSec == null) return;
  const st = classStates.get(laneClass) ?? { tokens: null, tokensAt: 0, pausedUntil: 0 };
  const burst = row.burst ?? Math.max(1, row.ratePerSec);
  classStates.set(laneClass, { ...st, tokens: tokensAt(st.tokens, st.tokensAt, now, row.ratePerSec, burst) - n, tokensAt: Math.max(st.tokensAt, now) });
}

export function connectionPaused(m: MemoryContext, item: OutboxItem, now: number) {
  const { connectionPauses } = m;
  return item.connectionKey !== undefined && (connectionPauses.get(`${laneKeyOf(item.scope, laneOf(item))}|${item.connectionKey}`) ?? 0) > now;
}

export function applySignals(m: MemoryContext, scope: Scope, signals: LaneSignal[], now: number) {
  const { connectionPauses, classStates, laneStates } = m;
  for (const signal of signals) {
    if (!isLaneName(signal.lane)) continue;
    const limits = limitsFor(m, scope, signal.lane);
    if (!limits) continue;
    if (signal.kind === "rate_limited" && signal.bucket === "connection" && signal.connectionKey !== undefined) {
      const key = `${laneKeyOf(scope, signal.lane)}|${signal.connectionKey}`;
      connectionPauses.set(key, Math.max(connectionPauses.get(key) ?? 0, now + clampPause(signal.retryAfterMs, limits.maxPauseMs)));
      continue;
    }
    if (signal.kind === "rate_limited" && signal.bucket === "connector" && signal.laneClass !== undefined && isLaneName(signal.laneClass)) {
      const st = classStates.get(signal.laneClass) ?? { tokens: null, tokensAt: 0, pausedUntil: 0 };
      classStates.set(signal.laneClass, { ...st, pausedUntil: Math.max(st.pausedUntil, now + clampPause(signal.retryAfterMs, limits.maxPauseMs)) });
      continue;
    }
    const key = laneKeyOf(scope, signal.lane);
    const before = laneStates.get(key);
    const lane = signal.kind === "rate_limited" ? { ...signal, bucket: "lane" as const } : signal;
    setLaneState(m, scope, signal.lane, before, applyLaneSignal(limits, before, lane, now));
  }
}

/**
 * Due items, round-robin across tenants from the cursor and across each
 * tenant's lanes from its turn, within the lanes' quotas: the same visit,
 * ranking and turns as Postgres's `claim_outbox`.
 */
export function pickOutbox(m: MemoryContext, now: number, limit: number): Array<{ item: OutboxItem; probe: boolean }> {
  const { outbox, storeVisit, tenantTurns, laneStates } = m;
  interface Lane {
    scope: Scope;
    lane: string;
    key: string;
    tuple: string[];
    due: OutboxItem[];
  }
  const lanes = new Map<string, Lane>();
  for (const item of outbox.values()) {
    const key = laneKeyOf(item.scope, laneOf(item));
    let entry = lanes.get(key);
    if (!entry) lanes.set(key, (entry = { scope: item.scope, lane: laneOf(item), key, tuple: laneTuple(item.scope, laneOf(item)), due: [] }));
    if (isDue(item, now)) entry.due.push(item);
  }
  // 1. Nothing due: nothing to visit, and the cursor stays.
  if (![...lanes.values()].some((l) => l.due.length > 0)) return [];
  const byTenant = new Map<string, Lane[]>();
  for (const entry of lanes.values()) {
    const list = byTenant.get(entry.scope.tenantId) ?? [];
    list.push(entry);
    byTenant.set(entry.scope.tenantId, list);
  }
  for (const list of byTenant.values()) list.sort((a, b) => compareTuples(a.tuple, b.tuple));
  const tenants = [...byTenant.keys()].sort(compareText);
  const after = m.outboxCursor?.[0];
  const tenantOrder = after === undefined ? tenants : [...tenants.filter((t) => compareText(t, after) > 0), ...tenants.filter((t) => compareText(t, after) <= 0)];
  // 2. Tenants after the cursor's (its own last); in each, its lanes after its turn. At most
  //    min(visit, limit) lanes with due items in one tenant, visit in all, scanning at most
  //    LANE_SCAN_FACTOR * visit lanes; the visit narrowed to the claim's limit (claimVisit).
  const visit = claimVisit(storeVisit, limit);
  const perTenant = Math.max(1, Math.min(visit, limit));
  const scanBudget = LANE_SCAN_FACTOR * visit;
  let scanned = 0;
  const visited: Array<Lane & { tpos: number }> = [];
  const examined: Array<{ tenant: string; tpos: number; last: Lane | undefined }> = [];
  let lastExamined: Lane | undefined;
  for (const tenant of tenantOrder) {
    if (visited.length >= visit || scanned >= scanBudget) break;
    const list = byTenant.get(tenant)!;
    const turn = tenantTurns.get(tenant);
    const start = turn ? list.findIndex((l) => compareTuples(l.tuple.slice(1), turn) > 0) : 0;
    const rotation = start <= 0 ? list : [...list.slice(start), ...list.slice(0, start)];
    const record = { tenant, tpos: examined.length + 1, last: undefined as Lane | undefined };
    examined.push(record);
    let found = 0;
    for (const entry of rotation) {
      if (found >= perTenant || visited.length >= visit || scanned >= scanBudget) break;
      scanned += 1;
      record.last = entry;
      lastExamined = entry;
      if (entry.due.length > 0) {
        visited.push({ ...entry, tpos: record.tpos });
        found += 1;
      }
    }
  }
  // None found within the budget: the lane of the earliest due row (a tenant of its own, whose turn stays).
  let fallback = false;
  if (visited.length === 0) {
    let earliest: Lane | undefined;
    let at = Number.POSITIVE_INFINITY;
    for (const entry of lanes.values()) {
      for (const item of entry.due) {
        const t = claimableAt(item);
        if (t < at || (t === at && earliest && compareTuples(entry.tuple, earliest.tuple) < 0)) [earliest, at] = [entry, t];
      }
    }
    if (earliest) {
      visited.push({ ...earliest, tpos: examined.length + 1 });
      fallback = true;
    }
  }
  // 3-5. Quotas; candidates ranked within a tenant by (lane round, priority, lane position), then by (tenant round, tenant position).
  interface Candidate {
    item: OutboxItem;
    priority: number;
    round: number;
    position: number;
    tpos: number;
    probe: boolean;
    laneKey: string;
  }
  const byTpos = new Map<number, Candidate[]>();
  const halfOpened: Array<{ scope: Scope; lane: string }> = [];
  visited.forEach((entry, position) => {
    const limits = limitsFor(m, entry.scope, entry.lane);
    const state = laneStates.get(entry.key);
    const controlled = isControlled(limits, state);
    const quota = laneQuota(limits, state, controlled ? inFlightOf(m, entry.scope, entry.lane, now) : 0, now);
    if (quota.halfOpen) halfOpened.push(entry);
    const ready = entry.due
      .filter((item) => !connectionPaused(m, item, now))
      .sort((a, b) => rank(priorityOf(a)) - rank(priorityOf(b)) || claimableAt(a) - claimableAt(b) || compareItemIds(a.id, b.id));
    const list = byTpos.get(entry.tpos) ?? [];
    byTpos.set(entry.tpos, list);
    let taken = 0;
    for (const item of ready) {
      const k = taken + 1;
      if (k > (priorityOf(item) === "interactive" ? quota.interactive : quota.background)) break;
      list.push({ item, priority: rank(priorityOf(item)), round: k, position, tpos: entry.tpos, probe: quota.probe, laneKey: entry.key });
      taken = k;
      if (taken >= limit) break;
    }
    if (taken === 0 && ready.length > 0 && quota.blocked) report(m, { scope: entry.scope, lane: entry.lane, kind: "deferred", reason: quota.blocked.reason, ...(quota.blocked.retryAfterMs !== undefined ? { retryAfterMs: quota.blocked.retryAfterMs } : {}) });
  });
  const ranked: Array<Candidate & { tround: number }> = [];
  for (const list of byTpos.values()) {
    list.sort((a, b) => a.round - b.round || a.priority - b.priority || a.position - b.position);
    list.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit).forEach((c, i) => ranked.push({ ...c, tround: i + 1 }));
  }
  ranked.sort((a, b) => a.tround - b.tround || a.tpos - b.tpos);
  const budgets = new Map<string, { interactive: number; background: number; used: number }>();
  const picked: Candidate[] = [];
  const lastPicked = new Map<number, Candidate>();
  const left = new Set<number>();
  for (const c of ranked) {
    if (picked.length >= limit) {
      // Left for want of room: its tenant's turn stays before it.
      left.add(c.tpos);
      continue;
    }
    const cls = classOf(c.item);
    let budget = budgets.get(cls);
    if (!budget) budgets.set(cls, (budget = { ...(cls === NO_LANE ? { interactive: Infinity, background: Infinity } : classBudget(m, cls, now)), used: 0 }));
    // A lane class's tokens are shared by its lanes across tenants; background leaves its reserve.
    if (budget.used + 1 > (c.priority === 0 ? budget.interactive : budget.background)) continue;
    budget.used += 1;
    picked.push(c);
    lastPicked.set(c.tpos, c);
  }
  // 6. State changes: open -> half-open on the first claim after the open period, tokens and window.
  const grants = new Map<string, number>();
  for (const p of picked) grants.set(p.laneKey, (grants.get(p.laneKey) ?? 0) + 1);
  for (const entry of visited) {
    const limits = limitsFor(m, entry.scope, entry.lane);
    const before = laneStates.get(entry.key);
    if (!limits || !isControlled(limits, before)) continue;
    const half = halfOpened.some((h) => laneKeyOf(h.scope, h.lane) === entry.key);
    const granted = grants.get(entry.key) ?? 0;
    if (granted > 0 || half) setLaneState(m, entry.scope, entry.lane, before, afterGrant(limits, before, granted, now, half));
  }
  for (const [cls, budget] of budgets) if (cls !== NO_LANE) spendClass(m, cls, budget.used, now);
  // 7. Turns: to the lane of a tenant's last item taken; with none taken and none left, past every lane examined.
  for (const record of examined) {
    const last = lastPicked.get(record.tpos);
    const lane = last ? visited[last.position]! : left.has(record.tpos) ? undefined : record.last;
    if (lane) tenantTurns.set(record.tenant, lane.tuple.slice(1));
  }
  // The next claim starts after the lane of the last item taken (in rank order), or after the last lane examined.
  const last = picked[picked.length - 1];
  const cursorLane = last && !fallback ? visited[last.position] : lastExamined;
  if (cursorLane) m.outboxCursor = cursorLane.tuple;
  return picked;
}

export const rank = (p: Priority) => (p === "interactive" ? 0 : 1);
