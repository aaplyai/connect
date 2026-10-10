/**
 * Fair lanes: how workers share effect capacity between tenants.
 *
 * Every outbox item belongs to a lane: (scope, lane name), where the lane
 * name defaults to the effect's connection role, else its connector id. A
 * lane can have a durable cap on effects in flight, a token bucket that
 * honours Retry-After, and a breaker. Claims go round-robin across lanes, so
 * one tenant's burst cannot starve the others, and interactive work keeps a
 * reserve that background work cannot take.
 *
 * Lane `"-"` ({@link NO_LANE}) is the lane of everything that is not a
 * connector action, and of items written without lane fields (by stores
 * and runtimes that know nothing of lanes). It is never capped,
 * paused or broken.
 *
 * This module holds the shared rules: limit resolution, the token bucket
 * and the breaker, as pure functions. The memory store uses them directly;
 * the Postgres store implements the same rules in SQL and is held to them by
 * the lane conformance cases.
 */

import { fixedPattern } from "@aaply/action-contract/internal";
import type { Scope } from "./state.js";

/** The lane of effects that are not connector actions, and of items without lane fields. Uncapped. */
export const NO_LANE = "-";

/** Lane and lane class names: like ids, so they never carry a fact value or odd text. `"-"` is reserved. */
export const LANE_NAME_RE = fixedPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);

/** Interactive work keeps headroom; background work is deferred first. */
export type Priority = "interactive" | "background";

/** Why an effect could not start now. Shown to people as a busy view; the input is kept. */
export type BusyReason = "capacity" | "rate" | "paused" | "unavailable";

export type BreakerState = "closed" | "open" | "half_open";

/**
 * Which bucket a Retry-After pauses. `lane` is the default; `connection`
 * pauses only one end user's connection (an item's `connectionKey`), so one
 * person's limit never pauses a whole lane; `connector` pauses the lane
 * class (every lane of that connector), for a limit on the connector itself.
 */
export type PauseBucket = "lane" | "connection" | "connector";

/**
 * What an action's outcome says about its lane. It rides in the commit that
 * records the outcome (`CommitBatch.lanes`), so it is atomic with it.
 */
export type LaneSignal = {
  lane: string;
  laneClass?: string;
  /** The end user's connection, for a `connection` pause. */
  connectionKey?: string;
  /** The item was the half-open breaker's probe. */
  probe?: boolean;
} & ({ kind: "rate_limited"; retryAfterMs: number; bucket?: PauseBucket } | { kind: "failure" } | { kind: "success" });

/**
 * One row of lane limits. The scope fields and `lane` select what it applies
 * to, in four shapes only: the platform row (none set: defaults and
 * ceilings), a tenant row (`tenantId`), an environment row (`tenantId`,
 * `appId`, `environmentId`) and a lane row (all four). For each field, the
 * most specific non-null value wins; `capMax` and `rateMax` (platform row
 * only) then clamp the result.
 */
export interface LaneLimit {
  tenantId?: string | null;
  appId?: string | null;
  environmentId?: string | null;
  lane?: string | null;
  /** Most effects in flight at once. Null: unlimited. */
  cap?: number | null;
  /** Share of the cap (and of the token bucket) kept for interactive work, in [0, 1). */
  reserve?: number | null;
  /** Token bucket rate, in grants per second. Null: no rate limit. */
  ratePerSec?: number | null;
  /** Token bucket size; defaults to the rate (at least 1). */
  burst?: number | null;
  /** The breaker opens on at least this many failures in the window... */
  breakerFailures?: number | null;
  /** ...that are also at least this share of the window's claims. */
  breakerRatio?: number | null;
  breakerWindowMs?: number | null;
  /** First open period; it doubles on each failed probe, up to `maxOpenMs`. */
  openMs?: number | null;
  maxOpenMs?: number | null;
  /** Longest pause a Retry-After can cause. */
  maxPauseMs?: number | null;
  /** Platform row only: the highest cap any tenant can have. */
  capMax?: number | null;
  /** Platform row only: the highest rate any tenant can have. */
  rateMax?: number | null;
}

/** Platform ceilings shared by every lane of one connector across tenants (for example one OAuth client's quota). */
export interface LaneClass {
  laneClass: string;
  ratePerSec?: number | null;
  burst?: number | null;
  reserve?: number | null;
}

/** A lane's limits after resolution. */
export interface LaneLimits {
  cap: number | null;
  reserve: number;
  ratePerSec: number | null;
  burst: number | null;
  breakerFailures: number;
  breakerRatio: number;
  breakerWindowMs: number;
  openMs: number;
  maxOpenMs: number;
  maxPauseMs: number;
}

/** The defaults, seeded into the Postgres platform row (a test holds the two together). */
export const LANE_DEFAULTS: Readonly<LaneLimits> = Object.freeze({
  cap: null,
  reserve: 0.25,
  ratePerSec: null,
  burst: null,
  breakerFailures: 5,
  breakerRatio: 0.5,
  breakerWindowMs: 30_000,
  openMs: 15_000,
  maxOpenMs: 300_000,
  maxPauseMs: 600_000,
});

/**
 * The slowest token rate a limit may set: one grant a day. Lower rates mean
 * waits no Retry-After or person would sit through, and their arithmetic
 * (milliseconds until the next token) leaves any integer range.
 */
export const MIN_LANE_RATE = 1 / 86_400;
/** The fastest token rate a limit may set, in grants per second; beyond it a bucket limits nothing. */
export const MAX_LANE_RATE = 1_000_000;
/** The largest token bucket a limit may set. */
export const MAX_LANE_BURST = 1_000_000;

/**
 * Lanes with due work a claim visits at most, tenant by tenant after the
 * claimer's cursor, and at most `min(visit, limit)` of them in one tenant.
 */
export const DEFAULT_LANE_VISIT = 128;

/**
 * Lanes (for timers, tenants) a claim examines at most while looking for due
 * work, as a multiple of its visit. A claim that examined this many without
 * finding any takes the lane (or tenant) of the earliest due row instead, so
 * it does work whenever work is due however many lanes hold only work that
 * is not due; its cursor still moves past what it examined.
 */
export const LANE_SCAN_FACTOR = 4;

/**
 * Lanes (for timers, tenants) with due work a claim visits at most per item
 * it may take: a claim visits `min(visit, LANE_VISIT_PER_ITEM * limit)`, so a
 * small claim does not pay for a wide visit it cannot use.
 */
export const LANE_VISIT_PER_ITEM = 4;

/** The visit of one claim: `visit`, narrowed to `LANE_VISIT_PER_ITEM` lanes per item of its limit. */
export function claimVisit(visit: number, limit: number): number {
  return Math.max(1, Math.min(visit, LANE_VISIT_PER_ITEM * limit));
}

/** The durable state of one lane. In flight is not here: it is derived from leases. */
export interface LaneState {
  /** Tokens at `tokensAt`; null means a full bucket. */
  tokens: number | null;
  tokensAt: number;
  pausedUntil: number;
  breaker: BreakerState;
  /** While open: when a probe may go. */
  openUntil: number;
  /** The current open period (0 while closed). */
  openMs: number;
  windowStart: number;
  windowClaims: number;
  windowFailures: number;
}

export const NEW_LANE_STATE: Readonly<LaneState> = Object.freeze({
  tokens: null,
  tokensAt: 0,
  pausedUntil: 0,
  breaker: "closed",
  openUntil: 0,
  openMs: 0,
  windowStart: 0,
  windowClaims: 0,
  windowFailures: 0,
});

/** A lane's state for operators (`RunStore.lanes.stats`). */
export interface LaneStats {
  scope: Scope;
  lane: string;
  inFlight: number;
  /** Items due now and not leased. */
  queued: number;
  cap: number | null;
  tokens: number | null;
  pausedUntil: number | null;
  breaker: BreakerState;
  openUntil: number | null;
  /** The earliest due time of a queued item. */
  oldestDueAt: number | null;
}

/** Names only, never values: what happened on a lane, for metrics. */
export interface LaneRecord {
  scope: Scope;
  lane: string;
  laneClass?: string;
  /**
   * `claimed`: a worker pass took items (`count`, the longest `waitMs` since due).
   * `busy`: an inline effect was refused (`reason`). `deferred`: a lane with due
   * items granted nothing (`reason`). `paused`: a Retry-After paused a bucket.
   * `breaker`: the breaker changed state.
   */
  kind: "claimed" | "busy" | "deferred" | "paused" | "breaker";
  priority?: Priority;
  count?: number;
  waitMs?: number;
  reason?: BusyReason;
  breaker?: { from: BreakerState; to: BreakerState };
  retryAfterMs?: number;
  bucket?: PauseBucket;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The connector of a connector action id: the part before the first dot. */
export function connectorOf(action: string): string {
  const dot = action.indexOf(".");
  return dot < 0 ? action : action.slice(0, dot);
}

/**
 * The default lane of an effect: its connection role, else its connector,
 * with the connector as lane class. Anything that is not a connector action
 * (for example a sub-flow call) goes in {@link NO_LANE}.
 */
export function defaultLaneOf(effect: { kind: string; action?: string; connection?: string }): { lane: string; laneClass: string } {
  if (effect.kind !== "action" || typeof effect.action !== "string") return { lane: NO_LANE, laneClass: NO_LANE };
  const connector = connectorOf(effect.action);
  const lane = effect.connection ?? connector;
  if (!isLaneName(lane) || !isLaneName(connector)) return { lane: NO_LANE, laneClass: NO_LANE };
  return { lane, laneClass: connector };
}

/** A lane or lane class name a host or a definition may use (not the reserved `"-"`). */
export function isLaneName(value: unknown): value is string {
  return typeof value === "string" && LANE_NAME_RE.test(value);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const LIMIT_FIELDS = ["cap", "reserve", "ratePerSec", "burst", "breakerFailures", "breakerRatio", "breakerWindowMs", "openMs", "maxOpenMs", "maxPauseMs", "capMax", "rateMax"] as const;

type LimitField = (typeof LIMIT_FIELDS)[number];

const rateOk = (n: number) => Number.isFinite(n) && n >= MIN_LANE_RATE && n <= MAX_LANE_RATE;
const burstOk = (n: number) => Number.isFinite(n) && n >= 1 && n <= MAX_LANE_BURST;
const RATE_RANGE = `between ${MIN_LANE_RATE} (one a day) and ${MAX_LANE_RATE} per second`;
const BURST_RANGE = `between 1 and ${MAX_LANE_BURST}`;

/** Problems with a limits row, or [] when it is well formed. */
export function laneLimitProblems(row: LaneLimit): string[] {
  const problems: string[] = [];
  const set = (v: unknown) => v !== undefined && v !== null;
  const scoped = [row.tenantId, row.appId, row.environmentId, row.lane].map(set);
  const shape = scoped.join(",");
  if (!["false,false,false,false", "true,false,false,false", "true,true,true,false", "true,true,true,true"].includes(shape)) {
    problems.push("a limits row is for the platform, a tenant, a tenant's app and environment, or one lane of those");
  }
  for (const key of ["tenantId", "appId", "environmentId"] as const) {
    const v = row[key];
    if (set(v) && (typeof v !== "string" || v.length === 0 || v.length > 128)) problems.push(`${key} must be a non-empty string`);
  }
  if (set(row.lane) && !isLaneName(row.lane)) problems.push("lane must be a lane name (lane \"-\" is never limited)");
  const num = (key: LimitField, ok: (n: number) => boolean, what: string) => {
    const v = row[key];
    if (set(v) && (typeof v !== "number" || !Number.isFinite(v) || !ok(v))) problems.push(`${key} must be ${what}`);
  };
  const int = (n: number) => Number.isSafeInteger(n);
  num("cap", (n) => int(n) && n >= 0, "a whole number >= 0");
  num("reserve", (n) => n >= 0 && n < 1, "in [0, 1)");
  num("ratePerSec", rateOk, RATE_RANGE);
  num("burst", burstOk, BURST_RANGE);
  num("breakerFailures", (n) => int(n) && n >= 1, "a whole number >= 1");
  num("breakerRatio", (n) => n > 0 && n <= 1, "in (0, 1]");
  num("breakerWindowMs", (n) => int(n) && n >= 1, "a whole number of milliseconds >= 1");
  num("openMs", (n) => int(n) && n >= 1, "a whole number of milliseconds >= 1");
  num("maxOpenMs", (n) => int(n) && n >= 1, "a whole number of milliseconds >= 1");
  num("maxPauseMs", (n) => int(n) && n >= 0, "a whole number of milliseconds >= 0");
  num("capMax", (n) => int(n) && n >= 0, "a whole number >= 0");
  num("rateMax", rateOk, RATE_RANGE);
  if ((set(row.capMax) || set(row.rateMax)) && shape !== "false,false,false,false") problems.push("capMax and rateMax belong on the platform row");
  return problems;
}

/** Problems with a lane class row, or []. */
export function laneClassProblems(row: LaneClass): string[] {
  const problems: string[] = [];
  if (!isLaneName(row.laneClass)) problems.push("laneClass must be a lane name");
  const v = (x: unknown) => x !== undefined && x !== null;
  if (v(row.ratePerSec) && !(typeof row.ratePerSec === "number" && rateOk(row.ratePerSec))) problems.push(`ratePerSec must be ${RATE_RANGE}`);
  if (v(row.burst) && !(typeof row.burst === "number" && burstOk(row.burst))) problems.push(`burst must be ${BURST_RANGE}`);
  if (v(row.reserve) && !(typeof row.reserve === "number" && row.reserve >= 0 && row.reserve < 1)) problems.push("reserve must be in [0, 1)");
  return problems;
}

/** The identity of a limits row: which of the four shapes, for what. */
export function laneLimitKey(row: LaneLimit): string {
  return JSON.stringify([row.tenantId ?? null, row.appId ?? null, row.environmentId ?? null, row.lane ?? null]);
}

/**
 * Resolves a lane's limits from the rows: per field, the most specific
 * non-null value (lane, then environment, then tenant, then platform, then
 * {@link LANE_DEFAULTS}), clamped by the platform's `capMax` and `rateMax`.
 * Lane {@link NO_LANE} has no limits at all.
 */
export function resolveLaneLimits(rows: readonly LaneLimit[], scope: Scope, lane: string): LaneLimits | null {
  if (lane === NO_LANE) return null;
  const specificity = (row: LaneLimit): number => {
    if (row.lane != null) return row.tenantId === scope.tenantId && row.appId === scope.appId && row.environmentId === scope.environmentId && row.lane === lane ? 3 : -1;
    if (row.appId != null) return row.tenantId === scope.tenantId && row.appId === scope.appId && row.environmentId === scope.environmentId ? 2 : -1;
    if (row.tenantId != null) return row.tenantId === scope.tenantId ? 1 : -1;
    return 0;
  };
  const matching = rows
    .map((row) => ({ row, s: specificity(row) }))
    .filter((m) => m.s >= 0)
    .sort((a, b) => b.s - a.s);
  const pick = (key: LimitField): number | null => {
    for (const { row } of matching) {
      const v = row[key];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
  const capMax = matching.find((m) => m.s === 0)?.row.capMax ?? null;
  const rateMax = matching.find((m) => m.s === 0)?.row.rateMax ?? null;
  let cap = pick("cap") ?? LANE_DEFAULTS.cap;
  if (capMax !== null) cap = cap === null ? capMax : Math.min(cap, capMax);
  let ratePerSec = pick("ratePerSec") ?? LANE_DEFAULTS.ratePerSec;
  if (rateMax !== null) ratePerSec = ratePerSec === null ? rateMax : Math.min(ratePerSec, rateMax);
  const burst = ratePerSec === null ? null : (pick("burst") ?? Math.max(1, ratePerSec));
  return {
    cap,
    reserve: pick("reserve") ?? LANE_DEFAULTS.reserve,
    ratePerSec,
    burst,
    breakerFailures: pick("breakerFailures") ?? LANE_DEFAULTS.breakerFailures,
    breakerRatio: pick("breakerRatio") ?? LANE_DEFAULTS.breakerRatio,
    breakerWindowMs: pick("breakerWindowMs") ?? LANE_DEFAULTS.breakerWindowMs,
    openMs: pick("openMs") ?? LANE_DEFAULTS.openMs,
    maxOpenMs: pick("maxOpenMs") ?? LANE_DEFAULTS.maxOpenMs,
    maxPauseMs: pick("maxPauseMs") ?? LANE_DEFAULTS.maxPauseMs,
  };
}

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

/** Tolerance for whole-token comparisons, so 2.9999999 tokens count as 3. */
const EPSILON = 1e-9;

/** Tokens in a bucket at `now`: refilled at `rate` per second up to `burst`. Infinity without a rate. */
export function tokensAt(tokens: number | null, at: number, now: number, rate: number | null, burst: number | null): number {
  if (rate === null || burst === null) return Number.POSITIVE_INFINITY;
  if (tokens === null) return burst;
  return Math.min(burst, tokens + (Math.max(0, now - at) * rate) / 1000);
}

/**
 * Whole grants a bucket allows: interactive ones may use every token,
 * background ones leave `reserve * burst`, but never the bucket's last whole
 * token (at most `burst - 1`), so background work in a bucket of one still
 * moves when it is full.
 */
export function tokenGrants(tokens: number, reserve: number, burst: number | null, priority: Priority): number {
  if (tokens === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const floor = priority === "interactive" ? 0 : Math.min(reserve * (burst ?? 0), Math.max(0, (burst ?? 0) - 1));
  return Math.max(0, Math.floor(tokens - floor + EPSILON));
}

/**
 * The most items in flight background work may hold in a lane with `cap`:
 * `floor(cap * (1 - reserve))`, but at least 1 when the cap is not 0. The
 * reserve never takes a lane's only slot: a run's background work (a
 * per-item step's later rows, a timer's effect) would otherwise wait for
 * ever in a lane of cap 1.
 */
export function backgroundCap(cap: number, reserve: number): number {
  return cap <= 0 ? 0 : Math.max(1, Math.floor(cap * (1 - reserve) + EPSILON));
}

/** Longest wait {@link msUntilToken} reports (and the SQL casts): well inside a bigint and a safe integer. */
const MAX_WAIT_MS = 9e15;

/** Milliseconds until a bucket holds one whole token. */
export function msUntilToken(tokens: number, rate: number | null): number {
  if (rate === null || tokens >= 1 - EPSILON) return 0;
  return Math.ceil(Math.min(((1 - tokens) * 1000) / rate, MAX_WAIT_MS));
}

// ---------------------------------------------------------------------------
// Quotas and the breaker
// ---------------------------------------------------------------------------

/** What a lane may grant now, given its effects in flight. */
export interface LaneQuota {
  /** Grants an interactive item may count up to (its rank in the lane, from 1). */
  interactive: number;
  /** Grants a background item may count up to. */
  background: number;
  /** The breaker is half-open: the grant is a probe. */
  probe: boolean;
  /** Set when the lane grants nothing for a reason a person should hear. */
  blocked?: { reason: BusyReason; retryAfterMs?: number };
  /** The breaker moved from open to half-open (applied by the claim). */
  halfOpen: boolean;
}

/**
 * The quota of one lane at `now`. Paused and open lanes grant nothing; a
 * half-open lane grants one probe at a time. In flight counts every item
 * whose lease has not ended (reservations too). Background grants stop at
 * `backgroundCap(cap, reserve)` and leave the tokens `tokenGrants` keeps.
 */
export function laneQuota(limits: LaneLimits | null, state: LaneState | undefined, inFlight: number, now: number): LaneQuota {
  if (!isControlled(limits, state) || limits === null) return { interactive: Number.POSITIVE_INFINITY, background: Number.POSITIVE_INFINITY, probe: false, halfOpen: false };
  const s = state ?? NEW_LANE_STATE;
  if (s.pausedUntil > now) return { interactive: 0, background: 0, probe: false, halfOpen: false, blocked: { reason: "paused", retryAfterMs: s.pausedUntil - now } };
  let probe = false;
  let halfOpen = false;
  if (s.breaker === "open") {
    if (s.openUntil > now) return { interactive: 0, background: 0, probe: false, halfOpen: false, blocked: { reason: "unavailable", retryAfterMs: s.openUntil - now } };
    probe = true;
    halfOpen = true;
  } else if (s.breaker === "half_open") {
    probe = true;
  }
  let interactive = Number.POSITIVE_INFINITY;
  let background = Number.POSITIVE_INFINITY;
  if (probe) {
    interactive = background = Math.max(0, 1 - inFlight);
  } else if (limits.cap !== null) {
    interactive = Math.max(0, limits.cap - inFlight);
    background = Math.max(0, backgroundCap(limits.cap, limits.reserve) - inFlight);
  }
  let blocked: LaneQuota["blocked"];
  if (interactive === 0) blocked = { reason: probe ? "unavailable" : "capacity" };
  const tokens = tokensAt(s.tokens, s.tokensAt, now, limits.ratePerSec, limits.burst);
  if (tokens !== Number.POSITIVE_INFINITY) {
    interactive = Math.min(interactive, tokenGrants(tokens, limits.reserve, limits.burst, "interactive"));
    background = Math.min(background, tokenGrants(tokens, limits.reserve, limits.burst, "background"));
    if (interactive === 0 && !blocked) blocked = { reason: "rate", retryAfterMs: msUntilToken(tokens, limits.ratePerSec) };
  }
  return { interactive, background, probe, halfOpen, ...(blocked ? { blocked } : {}) };
}

/**
 * The lane state after a claim granted `granted` items at `now` (tokens
 * spent, window counted). `tokensAt` never moves back: claimers' clocks
 * differ, and a bucket stamped with an earlier time would refill the same
 * interval twice.
 */
export function afterGrant(limits: LaneLimits, state: LaneState | undefined, granted: number, now: number, halfOpen: boolean): LaneState {
  const s = { ...(state ?? NEW_LANE_STATE) };
  if (halfOpen) s.breaker = "half_open";
  if (granted === 0) return s;
  if (limits.ratePerSec !== null) {
    s.tokens = tokensAt(s.tokens, s.tokensAt, now, limits.ratePerSec, limits.burst) - granted;
    s.tokensAt = Math.max(s.tokensAt, now);
  }
  rollWindow(s, limits, now);
  s.windowClaims += granted;
  return s;
}

/**
 * Starts a new breaker window once the current one has run its length. A
 * time before the window's start (a claimer whose clock is behind) counts in
 * the current window: neither times nor windows ever move back.
 */
function rollWindow(s: LaneState, limits: LaneLimits, now: number): void {
  if (now - s.windowStart >= limits.breakerWindowMs) {
    s.windowStart = now;
    s.windowClaims = 0;
    s.windowFailures = 0;
  }
}

/**
 * Applies one signal to a lane's state. A Retry-After (`lane` bucket)
 * pauses the lane until `now + min(retryAfterMs, maxPauseMs)` and empties
 * its bucket. A failure counts in the window and opens the breaker at
 * `breakerFailures` that are also `breakerRatio` of the window's claims; a
 * failed probe reopens it with the open period doubled (up to `maxOpenMs`);
 * a successful probe closes it. Connection and connector pauses are kept
 * elsewhere and leave the lane as it is.
 */
export function applyLaneSignal(limits: LaneLimits, state: LaneState | undefined, signal: LaneSignal, now: number): LaneState {
  const s = { ...(state ?? NEW_LANE_STATE) };
  switch (signal.kind) {
    case "rate_limited": {
      if ((signal.bucket ?? "lane") !== "lane") return s;
      s.pausedUntil = Math.max(s.pausedUntil, now + clampPause(signal.retryAfterMs, limits.maxPauseMs));
      if (limits.ratePerSec !== null) {
        s.tokens = 0;
        s.tokensAt = Math.max(s.tokensAt, now);
      }
      return s;
    }
    case "failure": {
      rollWindow(s, limits, now);
      s.windowFailures += 1;
      if (s.breaker === "half_open" && signal.probe) {
        s.openMs = Math.min(Math.max(s.openMs * 2, limits.openMs), limits.maxOpenMs);
        s.breaker = "open";
        s.openUntil = now + s.openMs;
      } else if (s.breaker === "closed" && s.windowFailures >= limits.breakerFailures && s.windowFailures >= limits.breakerRatio * s.windowClaims - EPSILON) {
        s.openMs = Math.min(limits.openMs, limits.maxOpenMs);
        s.breaker = "open";
        s.openUntil = now + s.openMs;
      }
      return s;
    }
    case "success": {
      if (s.breaker === "half_open" && signal.probe) {
        s.breaker = "closed";
        s.openMs = 0;
        s.openUntil = 0;
        s.windowStart = Math.max(s.windowStart, now);
        s.windowClaims = 0;
        s.windowFailures = 0;
      }
      return s;
    }
  }
}

/** A Retry-After as a pause: at least 0, at most `maxPauseMs`, whole milliseconds. */
export function clampPause(retryAfterMs: number, maxPauseMs: number): number {
  if (typeof retryAfterMs !== "number" || Number.isNaN(retryAfterMs)) return 0;
  return Math.floor(Math.max(0, Math.min(retryAfterMs, maxPauseMs)));
}

/** True when the state needs no row: a lane that never paused, failed or spent a token. */
export function isPristine(state: LaneState | undefined): boolean {
  return (
    state === undefined ||
    (state.tokens === null && state.pausedUntil === 0 && state.breaker === "closed" && state.openMs === 0 && state.windowFailures === 0 && state.windowClaims === 0)
  );
}

/**
 * Whether a claim must lock and count a lane: it has a cap or a rate, or a
 * state that is not pristine (it paused or failed once). Healthy unlimited
 * lanes are neither locked nor written, so their claims are not counted
 * until their first failure; from then on the breaker's ratio has them.
 */
export function isControlled(limits: LaneLimits | null, state: LaneState | undefined): boolean {
  return limits !== null && (limits.cap !== null || limits.ratePerSec !== null || !isPristine(state));
}
