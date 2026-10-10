/**
 * What the memory store's functions share: the context `createMemoryStore`
 * builds (its maps, the blob ledger, the privacy log, the lane state and the
 * claim cursors), row keys and orderings.
 */

import { readScope, heldBlobRefs } from "../blob-guard.js";
import { createMemoryBlobLedger } from "../blob-ledger.js";
import { type LaneLimit, type LaneClass, type LaneState, DEFAULT_LANE_VISIT } from "../lanes.js";
import { type StoredEvent, type WorkspaceState, type OutboxItem, type TimerItem, type WaitItem, scopeKey } from "../store.js";
import type { RunState, Scope } from "../state.js";
import type { HoldRow, LegalHold, PrivacyRecord } from "../privacy.js";
import type { MemoryStoreOptions } from "../memory-store.js";

export interface RunRecord {
  state: RunState;
  events: StoredEvent[];
}

export const clone = <T>(value: T): T => structuredClone(value);

/** State of one lane class: its token bucket and a connector-wide pause. */
export interface ClassState {
  tokens: number | null;
  tokensAt: number;
  pausedUntil: number;
}

/** What the store's functions share: its maps, the blob ledger, the privacy log, the lane state and the claim cursors. */
export function memoryContext(options: MemoryStoreOptions): MemoryContext {
  const runs = new Map<string, RunRecord>();
  const workspaces = new Map<string, WorkspaceState>();
  const outbox = new Map<string, OutboxItem>();
  const timers = new Map<string, TimerItem>();
  const waits = new Map<string, WaitItem>();
  const subjects = new Map<string, Set<string>>();
  /** Legal holds by tenant and id, with the columns that place them and the scope that placed them (the only one that releases them). */
  const holds = new Map<string, { row: HoldRow; hold: LegalHold; placedIn: Scope }>();
  // A release stays unlisted while a run of its scope names the file (ADR-0008, amended by the verification round).
  const ledger = createMemoryBlobLedger({ inUse: (scope) => namedBlobs(m, scope) });
  /** The privacy log, by scope. */
  const records = new Map<string, PrivacyRecord[]>();
  const fair = options.lanes;
  let limitRows: LaneLimit[] = [];
  let classRows = new Map<string, LaneClass>();
  const laneStates = new Map<string, LaneState>();
  const classStates = new Map<string, ClassState>();
  /** Connection pauses by lane key and connection key. */
  const connectionPauses = new Map<string, number>();
  const storeVisit = Math.max(1, Math.floor(fair?.visit ?? DEFAULT_LANE_VISIT));
  let outboxCursor: string[] | null = null;
  let timerCursor: string | null = null;
  /** Each tenant's turn: the lane (app, environment, lane) its next visit starts after. */
  const tenantTurns = new Map<string, string[]>();
  const m: MemoryContext = { options, runs, workspaces, outbox, timers, waits, subjects, holds, ledger, records, fair, limitRows, classRows, laneStates, classStates, connectionPauses, storeVisit, outboxCursor, timerCursor, tenantTurns };
  return m;
}

/** The context the store's functions share (see memoryContext). */
export interface MemoryContext {
  readonly options: MemoryStoreOptions;
  readonly runs: Map<string, RunRecord>;
  readonly workspaces: Map<string, WorkspaceState>;
  readonly outbox: Map<string, OutboxItem>;
  readonly timers: Map<string, TimerItem>;
  readonly waits: Map<string, WaitItem>;
  readonly subjects: Map<string, Set<string>>;
  /** Legal holds by tenant and id, with the columns that place them and the scope that placed them (the only one that releases them). */
  readonly holds: Map<string, { row: HoldRow; hold: LegalHold; placedIn: Scope }>;
  readonly ledger: ReturnType<typeof createMemoryBlobLedger>;
  /** The privacy log, by scope. */
  readonly records: Map<string, PrivacyRecord[]>;
  readonly fair: MemoryStoreOptions["lanes"];
  limitRows: LaneLimit[];
  classRows: Map<string, LaneClass>;
  readonly laneStates: Map<string, LaneState>;
  readonly classStates: Map<string, ClassState>;
  /** Connection pauses by lane key and connection key. */
  readonly connectionPauses: Map<string, number>;
  readonly storeVisit: number;
  outboxCursor: string[] | null;
  timerCursor: string | null;
  /** Each tenant's turn: the lane (app, environment, lane) its next visit starts after. */
  readonly tenantTurns: Map<string, string[]>;
}

/** The ids of the file references bound to `scope` that its runs name, in their states and events. */
export function namedBlobs(m: MemoryContext, scope: Scope): Set<string> {
  const { runs } = m;
  const bound = readScope(scope);
  const named = new Set<string>();
  if (bound === null) return named;
  const prefix = `${scopeKey(bound)}|`;
  for (const [key, record] of runs) {
    if (!key.startsWith(prefix)) continue;
    for (const id of heldBlobRefs(record.state, bound).keys()) named.add(id);
    for (const stored of record.events) for (const id of heldBlobRefs(stored.event, bound).keys()) named.add(id);
  }
  return named;
}

export function runKey(scope: Scope, runId: string) {
  return `${scopeKey(scope)}|${runId}`;
}

export function wsKey(scope: Scope, id: string) {
  return `${scopeKey(scope)}|${id}`;
}

export function timerKey(scope: Scope, runId: string, timerId: string) {
  return `${scopeKey(scope)}|${runId}|${timerId}`;
}

export function waitKey(scope: Scope, runId: string, stepId: string) {
  return `${scopeKey(scope)}|${runId}|${stepId}`;
}

/** A limit read like `slice(0, limit)` reads a sensible one: fractions dropped, NaN and <= 0 give nothing. */
export function sliceLimit(limit: number): number {
  if (limit === Number.POSITIVE_INFINITY) return limit;
  return limit > 0 ? Math.floor(limit) : 0;
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Items due at the same time in one lane: shorter ids first, then by code
 * unit. One run's rows of one commit (`<runId>.<n>#<attempt>`, a per-item
 * step's fan-out) then go in the order the run wrote them, also past `.9`;
 * the Postgres claim orders by `length(id), id COLLATE "C"` alike.
 */
export function compareItemIds(a: string, b: string): number {
  return a.length - b.length || compareText(a, b);
}

export function compareTuples(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareText(a[i] ?? "", b[i] ?? "");
    if (c !== 0) return c;
  }
  return 0;
}
