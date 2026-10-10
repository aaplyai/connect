/**
 * Health counts for operators (`runtime.health()`, ADR-0010): whether the
 * store answers, how far behind workers are, which lanes are held back, how
 * many effects wait for a person, and how many outbox items were set aside. Across every tenant, counts only: no
 * id, name or value of anyone's leaves here.
 */

import type { Clock } from "./ports.js";
import type { RunStore } from "./store.js";

/** Due work nobody holds a lease on. */
export interface Backlog {
  /** How many items are due now and not leased, up to the cap. */
  due: number;
  /** True when `due` stopped counting at the cap: there are at least that many. */
  capped: boolean;
  /** The time the longest-waiting one became due; null when none is. */
  oldestDueAt: number | null;
}

/** What `RunStore.health` reports. A part a store cannot tell is absent. */
export interface StoreHealth {
  /** Outbox items due and not leased (the workers' backlog). */
  outbox?: Backlog;
  /** Timers due and not leased. */
  timers?: Backlog;
  /** Stores with lanes: lanes paused by a Retry-After now, and lanes whose breaker is not closed. */
  lanes?: { paused: number; open: number; capped: boolean };
  /**
   * Effects (and calls) whose outcome needs a person (`RunState.attention`:
   * in doubt, disputed, or a late report that did not settle), and the runs
   * holding them. When `capped`, both are lower bounds.
   */
  inDoubt?: { effects: number; runs: number; capped: boolean };
  /**
   * Outbox items set aside as dead (a payload that no longer opens, say):
   * never due, so never in `outbox`, and they wait for an operator.
   */
  deadOutbox?: number;
}

/** Options of `RunStore.health`. */
export interface StoreHealthOptions {
  now: number;
  /** Where counts stop (default `HEALTH_COUNT_CAP`). */
  cap?: number;
}

/** What `runtime.health()` answers. */
export interface RuntimeHealth extends StoreHealth {
  /** The runtime clock's time of the check. */
  at: number;
  store: {
    /** Whether the store answered; null for a store without `health`, which cannot be asked. */
    reachable: boolean | null;
    /** How long the store took to answer, in wall-clock milliseconds. */
    latencyMs: number;
    /** The failure's code or name, never its message (which may quote what it failed on). */
    error?: string;
  };
}

/** Where health counts stop by default. */
export const HEALTH_COUNT_CAP = 10_000;

/** The cap as a store should use it: a whole number from 1 to 1,000,000. */
export function healthCap(cap: number | undefined): number {
  if (cap === undefined || !Number.isFinite(cap)) return HEALTH_COUNT_CAP;
  return Math.min(1_000_000, Math.max(1, Math.floor(cap)));
}

/**
 * Asks the store for its counts and times it. Never throws: a store that
 * fails is reported unreachable, with the error's code or name.
 */
export async function runtimeHealth(store: RunStore, clock: Clock, options: { cap?: number } = {}): Promise<RuntimeHealth> {
  const at = clock.now();
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
  if (typeof store.health !== "function") return { at, store: { reachable: null, latencyMs: 0 } };
  try {
    const counts = await store.health({ now: at, ...(options.cap !== undefined ? { cap: options.cap } : {}) });
    return { at, store: { reachable: true, latencyMs: elapsed() }, ...pick(counts) };
  } catch (error) {
    return { at, store: { reachable: false, latencyMs: elapsed(), error: errorLabel(error) } };
  }
}

/** Only the parts `StoreHealth` names, so a store cannot pass anything else through. */
function pick(counts: StoreHealth | null | undefined): StoreHealth {
  if (!counts || typeof counts !== "object") return {};
  const out: StoreHealth = {};
  if (counts.outbox) out.outbox = { due: counts.outbox.due, capped: counts.outbox.capped, oldestDueAt: counts.outbox.oldestDueAt };
  if (counts.timers) out.timers = { due: counts.timers.due, capped: counts.timers.capped, oldestDueAt: counts.timers.oldestDueAt };
  if (counts.lanes) out.lanes = { paused: counts.lanes.paused, open: counts.lanes.open, capped: counts.lanes.capped };
  if (counts.inDoubt) out.inDoubt = { effects: counts.inDoubt.effects, runs: counts.inDoubt.runs, capped: counts.inDoubt.capped };
  if (typeof counts.deadOutbox === "number") out.deadOutbox = counts.deadOutbox;
  return out;
}

function errorLabel(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 64) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length <= 64) return name;
  }
  return "error";
}
