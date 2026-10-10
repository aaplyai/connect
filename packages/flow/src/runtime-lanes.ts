/**
 * The runtime's side of fair lanes (stores with `RunStore.lanes`): which
 * lane and priority a new outbox item gets, which items a reservation grant
 * lets run inline, what an outcome signals to its lane, and the lane records
 * an observer sees. Kept apart from the runtime so the request path stays
 * readable; every function here is pure apart from calling the host's
 * `classify` and the key minter.
 */

import { defaultLaneOf, isLaneName, NO_LANE, type BusyReason, type LaneRecord, type LaneSignal, type PauseBucket, type Priority } from "./lanes.js";
import type { KeyMinter, LanePolicy } from "./ports.js";
import { scopeKey, type InlineGrant, type OutboxItem } from "./store.js";
import type { ActionEffect, ActionOutcome, FlowEvent, RunState, Scope } from "./state.js";

/** An action's outcome, and whether it came from the action port (and so says something about its lane). */
export interface Performed {
  outcome: ActionOutcome;
  fromPort: boolean;
  /** On a `pending` answer from the port: the operation's declared completion window, recorded on the event. */
  windowMs?: number;
  /** How long the port took, from building the envelope (from the port only). */
  latencyMs?: number;
}

export const DEFAULT_INTERACTIVE_WINDOW_MS = 60_000;
export const DEFAULT_INLINE_GRACE_MS = 5_000;

/**
 * Lane fields of a new outbox item. A connector action goes in its lane
 * (the policy's `classify`, else its connection role or connector); any
 * other effect goes in lane `"-"`, which is never limited, with the run's
 * priority. Priority is interactive when a person caused the event or gave
 * input within `interactiveWindowMs`, else background. An action acting for
 * the end user also gets its connection's key, a keyed digest of the
 * connection role and the person, so a Retry-After for that connection
 * pauses only it.
 */
export function laneFields(o: {
  policy: LanePolicy;
  keys: KeyMinter;
  onError: (error: unknown, where: string) => void;
  scope: Scope;
  state: RunState;
  event: FlowEvent;
  effect: { kind: string };
  now: number;
}): Pick<OutboxItem, "lane" | "laneClass" | "priority" | "connectionKey"> {
  const { policy, scope, state, event, effect, now } = o;
  const person = event.actor.kind === "visitor" || event.actor.kind === "member" || event.actor.kind === "staff";
  const priority: Priority = person || now - state.lastInputAt <= (policy.interactiveWindowMs ?? DEFAULT_INTERACTIVE_WINDOW_MS) ? "interactive" : "background";
  if (effect.kind !== "action") return { lane: NO_LANE, laneClass: NO_LANE, priority };
  const action = effect as ActionEffect;
  let lane = defaultLaneOf(action);
  if (policy.classify) {
    try {
      const chosen = policy.classify(scope, action);
      if (!chosen || !isLaneName(chosen.lane) || (chosen.laneClass !== undefined && !isLaneName(chosen.laneClass))) {
        throw new Error("flow: lanes.classify must return lane names (LANE_NAME_RE); the default lane was used");
      }
      lane = { lane: chosen.lane, laneClass: chosen.laneClass ?? lane.laneClass };
    } catch (error) {
      o.onError(error, "lanes:classify");
    }
  }
  const connectionKey =
    action.actingFor === "endUser" && state.subject
      ? o.keys.idempotencyKey({ scope, ...(action.connection !== undefined ? { connection: action.connection } : {}), action: "flow.connection", effectId: state.subject.id })
      : undefined;
  return { ...lane, priority, ...(connectionKey !== undefined ? { connectionKey } : {}) };
}

/**
 * What an outcome says about its lane: a Retry-After pauses a bucket (the
 * lane; one end user's connection with `limit: "connection"`; the lane
 * class with `limit: "connector"`), any other retryable or unknown outcome
 * from the port is a failure for the breaker, and a probe that did not fail
 * closes it. Outcomes the engine made itself (an interrupted write, an
 * admission refusal, a dead letter) say nothing, and lane `"-"` never hears.
 */
export function laneSignal(item: OutboxItem, performed: Performed): LaneSignal | null {
  const lane = item.lane ?? NO_LANE;
  if (!performed.fromPort || lane === NO_LANE) return null;
  const base = {
    lane,
    ...(item.laneClass !== undefined ? { laneClass: item.laneClass } : {}),
    ...(item.connectionKey !== undefined ? { connectionKey: item.connectionKey } : {}),
    ...(item.probe ? { probe: true } : {}),
  };
  const o = performed.outcome;
  if (o.status === "retryable" && o.retryAfterMs !== undefined) {
    const bucket: PauseBucket = o.limit === "connector" && item.laneClass !== undefined && item.laneClass !== NO_LANE ? "connector" : o.limit === "connection" && item.connectionKey !== undefined ? "connection" : "lane";
    return { ...base, kind: "rate_limited", retryAfterMs: o.retryAfterMs, bucket };
  }
  if (o.status === "retryable" || o.status === "unknown") return { ...base, kind: "failure" };
  return item.probe ? { ...base, kind: "success" } : null;
}

/** The record an observer gets for a signal that pauses something. */
export function pausedRecord(item: OutboxItem, signal: LaneSignal): LaneRecord | null {
  if (signal.kind !== "rate_limited") return null;
  return { scope: item.scope, lane: signal.lane, ...(item.laneClass !== undefined ? { laneClass: item.laneClass } : {}), kind: "paused", bucket: signal.bucket ?? "lane", retryAfterMs: signal.retryAfterMs };
}

/** The reserved items a grant lets run inline, in the order they were added, with their new claims and leases. */
export function grantedItems(reserved: OutboxItem[], grant: InlineGrant): OutboxItem[] {
  const granted = new Map(grant.granted.map((g) => [g.id, g]));
  return reserved.flatMap((item) => {
    const g = granted.get(item.id);
    if (!g) return [];
    return [{ ...item, claims: g.claims, ...(g.leaseOwner !== undefined ? { leaseOwner: g.leaseOwner } : {}), ...(g.leaseUntil !== undefined ? { leaseUntil: g.leaseUntil } : {}), ...(g.probe ? { probe: true } : {}) }];
  });
}

/** The busy refusals of a grant (not `taken`), with the records an observer gets. */
export function refusals(scope: Scope, reserved: OutboxItem[], grant: InlineGrant): Array<{ busy: { reason: BusyReason; retryAfterMs?: number }; record: LaneRecord }> {
  const out: Array<{ busy: { reason: BusyReason; retryAfterMs?: number }; record: LaneRecord }> = [];
  for (const refused of grant.refused) {
    if (refused.reason === "taken") continue;
    const item = reserved.find((i) => i.id === refused.id);
    const busy = { reason: refused.reason, ...(refused.retryAfterMs !== undefined ? { retryAfterMs: refused.retryAfterMs } : {}) };
    out.push({
      busy,
      record: { scope, lane: item?.lane ?? NO_LANE, ...(item?.laneClass !== undefined ? { laneClass: item.laneClass } : {}), kind: "busy", ...busy, ...(item?.priority ? { priority: item.priority } : {}) },
    });
  }
  return out;
}

/** One `claimed` record per lane of a worker pass: how many, and the longest wait since due. */
export function claimRecords(items: OutboxItem[], now: number): LaneRecord[] {
  const byLane = new Map<string, { item: OutboxItem; count: number; waitMs: number }>();
  for (const item of items) {
    const key = `${scopeKey(item.scope)}|${item.lane ?? NO_LANE}`;
    const entry = byLane.get(key) ?? { item, count: 0, waitMs: 0 };
    entry.count += 1;
    entry.waitMs = Math.max(entry.waitMs, now - item.availableAt);
    byLane.set(key, entry);
  }
  return [...byLane.values()].map(({ item, count, waitMs }) => ({
    scope: item.scope,
    lane: item.lane ?? NO_LANE,
    ...(item.laneClass !== undefined ? { laneClass: item.laneClass } : {}),
    kind: "claimed" as const,
    count,
    waitMs,
  }));
}
