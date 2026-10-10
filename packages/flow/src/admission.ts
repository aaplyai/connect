/**
 * Admission of actions: what the admission port is told about an action,
 * and how a deferral (`defer: true`) is bounded.
 *
 * A deferral hands the outbox item back unsent: no attempt is spent and the
 * core records nothing, so a host can pause a tenant or a flow without
 * failing anyone's write. A contract-version refusal waits the same way
 * (ADR-0009, amended). It is bounded by `maxDeferMs`, counted from when the
 * effect's first attempt was dispatched (the time of the event that
 * committed it), so the bound is a ceiling for the whole write, never one
 * each retry gets again. Past the bound the refusal is recorded as any
 * refusal is, so the core's retry and failure rules apply and nothing waits
 * forever unseen.
 */

import type { CompiledFlow } from "./compile.js";
import { committed } from "./migrate.js";
import type { AdmissionAction } from "./ports.js";
import { replay } from "./replay.js";
import type { ActionEffect, RunState, Scope } from "./state.js";
import type { RunStore } from "./store.js";
import { readStoredEvent } from "./stored-versions.js";

const DAY = 24 * 60 * 60 * 1000;

/** Default `RuntimeLimits.maxDeferMs`: a day. */
export const DEFAULT_MAX_DEFER_MS = DAY;
/**
 * The most `RuntimeLimits.maxDeferMs` may be: a week, as long as an action's
 * call may take. It is a ceiling for the whole write, counted from its first
 * attempt's dispatch: a retry never gets a bound of its own.
 */
export const MAX_DEFER_MS = 7 * DAY;
/** Most effects whose first dispatch a runtime keeps ({@link deferralSince}), the oldest dropped first. */
export const MAX_KEPT_DISPATCHES = 1000;
/** The wait a deferral without a usable `retryAfterMs` gets. */
export const DEFAULT_DEFER_RETRY_MS = 30_000;
/** Shortest wait a deferral gets, so a deferring port is not asked in a tight loop. */
export const MIN_DEFER_RETRY_MS = 1_000;
/** Longest wait one deferral gets, so a lifted pause is noticed within the hour. */
export const MAX_DEFER_RETRY_MS = 60 * 60 * 1000;

/** `maxDeferMs` as the runtime uses it: whole milliseconds from 0 (no deferral) to {@link MAX_DEFER_MS}; anything else is the default. */
export function clampMaxDefer(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_DEFER_MS;
  return Math.max(0, Math.min(Math.floor(value), MAX_DEFER_MS));
}

/**
 * When a deferred item may be claimed again, or null when the deferral is
 * over its bound and must be recorded as a refusal. `since` is when the
 * attempt was dispatched; `retryAfterMs` is the port's wait, clamped to
 * {@link MIN_DEFER_RETRY_MS}..{@link MAX_DEFER_RETRY_MS} ({@link DEFAULT_DEFER_RETRY_MS}
 * when it is not a number). The answer is never past `since + maxDeferMs`,
 * so the item comes back at the bound at the latest.
 */
export function deferUntil(o: { now: number; since: number; retryAfterMs: unknown; maxDeferMs: number }): number | null {
  const bound = o.since + o.maxDeferMs;
  if (!(o.now < bound)) return null;
  const wait = typeof o.retryAfterMs === "number" && Number.isFinite(o.retryAfterMs) ? Math.max(MIN_DEFER_RETRY_MS, Math.min(o.retryAfterMs, MAX_DEFER_RETRY_MS)) : DEFAULT_DEFER_RETRY_MS;
  return Math.min(o.now + wait, bound);
}

/** What the admission port is told about an action: the action, and the run, flow version, step and commit it is part of. */
export function admissionAction(flow: CompiledFlow, state: RunState | undefined, runId: string, effect: ActionEffect): AdmissionAction {
  const step = flow.actions.get(effect.name)?.stepId;
  return {
    id: effect.action,
    effect: effect.effect,
    purpose: effect.purpose,
    risk: effect.risk,
    runId,
    flowVersion: flow.version,
    ...(step !== undefined ? { step } : {}),
    ...(state ? { committed: committed(flow, state) } : {}),
  };
}

/**
 * When the attempt was dispatched: the time of the run's event at `revision`
 * (the event whose commit added the outbox item). Null when the log has no
 * such event (a row written before dispatch details were recorded).
 */
export async function dispatchedAt(store: RunStore, scope: Scope, runId: string, revision: number): Promise<number | null> {
  if (!Number.isInteger(revision) || revision < 1) return null;
  const events = await store.listEvents(scope, runId, { afterSeq: revision - 1, limit: 1 });
  const first = events[0];
  return first !== undefined && first.seq === revision && typeof first.event.at === "number" ? first.event.at : null;
}

/** Ends {@link firstDispatchedAt}'s walk once the dispatch is found. */
const FOUND: unique symbol = Symbol("found");

/**
 * When the first attempt of `effectId` was dispatched: the time of the event
 * whose step started it, found by stepping the run's log through the core,
 * as `replay` does, up to `upTo` (the later attempt's own dispatch revision,
 * when known). `resolve` gives each version the log names. Null when the log
 * never started that effect or cannot be stepped (a version that cannot be
 * resolved, or whose hash differs). A store or resolver that throws throws.
 */
export async function firstDispatchedAt(o: {
  store: RunStore;
  scope: Scope;
  runId: string;
  effectId: string;
  upTo?: number;
  resolve: (flowId: string, version: string) => Promise<CompiledFlow | null>;
}): Promise<number | null> {
  if (o.upTo !== undefined && !(Number.isInteger(o.upTo) && o.upTo >= 1)) return null;
  const events = (await o.store.listEvents(o.scope, o.runId, o.upTo !== undefined ? { limit: o.upTo } : {})).map((s) => s.event);
  // The versions the log names, loaded first: replay resolves them as it goes, synchronously.
  const flows = new Map<string, CompiledFlow | null>();
  let flowId: string | null = null;
  for (const raw of events) {
    let event: ReturnType<typeof readStoredEvent>;
    try {
      event = readStoredEvent(raw);
    } catch {
      return null;
    }
    if (event.type === "run.started") flowId = event.flowId;
    const version = event.type === "run.started" ? event.flowVersion : event.type === "run.migrated" ? event.to.version : null;
    if (flowId === null || version === null || flows.has(`${flowId}@${version}`)) continue;
    flows.set(`${flowId}@${version}`, await o.resolve(flowId, version));
  }
  let at: number | null = null;
  try {
    replay((id, version) => flows.get(`${id}@${version}`) ?? null, events, (event, result) => {
      if (!result.effects.some((f) => f.kind === "action" && f.effectId === o.effectId && f.attempt === 1)) return;
      at = typeof event.at === "number" ? event.at : null;
      throw FOUND;
    });
  } catch (error) {
    if (error === FOUND) return at;
  }
  return null;
}

/**
 * When an attempt's deferral bound starts: when its effect's first attempt
 * was dispatched. Attempt 1 reads the event at its own dispatch `revision`
 * ({@link dispatchedAt}); a later attempt, or a row written without dispatch
 * details (`revision` undefined), steps the run's log
 * ({@link firstDispatchedAt}), and that answer is kept in `kept` (at most
 * {@link MAX_KEPT_DISPATCHES} effects), so a log is stepped once per effect.
 * Null when it cannot be read: the caller then records the refusal.
 */
export async function deferralSince(o: {
  store: RunStore;
  scope: Scope;
  runId: string;
  effect: ActionEffect;
  /** The attempt's own dispatch revision, when its outbox row records one. */
  revision: number | undefined;
  resolve: (flowId: string, version: string) => Promise<CompiledFlow | null>;
  kept: Map<string, number>;
}): Promise<number | null> {
  if (o.effect.attempt === 1 && o.revision !== undefined) return dispatchedAt(o.store, o.scope, o.runId, o.revision);
  const key = JSON.stringify([o.scope.tenantId, o.scope.appId, o.scope.environmentId, o.runId, o.effect.effectId]);
  const known = o.kept.get(key);
  if (known !== undefined) return known;
  const at = await firstDispatchedAt({ store: o.store, scope: o.scope, runId: o.runId, effectId: o.effect.effectId, resolve: o.resolve, ...(o.revision !== undefined ? { upTo: o.revision } : {}) });
  if (at === null) return null;
  if (o.kept.size >= MAX_KEPT_DISPATCHES) {
    const oldest = o.kept.keys().next();
    if (!oldest.done) o.kept.delete(oldest.value);
  }
  o.kept.set(key, at);
  return at;
}
