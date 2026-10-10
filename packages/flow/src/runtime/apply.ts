/**
 * Applying an event: stepping the pure core, committing state, event and
 * effects in one batch, and tracing what was applied.
 */

import { dispatchFor } from "../approved.js";
import type { CompiledFlow } from "../compile.js";
import { step, type StepResult } from "../core.js";
import { migrateStep } from "../migrate.js";
import { type Why, basisOf } from "../routing.js";
import type { TrustedContext } from "../ports.js";
import { traceFields } from "../trace-fields.js";
import { DEFAULT_INLINE_GRACE_MS, laneFields } from "../runtime-lanes.js";
import type { CommitBatch, OutboxItem, TimerItem, WaitItem } from "../store.js";
import type { Scope, RunState, FlowEvent, FlowEffect } from "../state.js";
import { FlowError } from "../errors.js";
import { type TakenWrite, stepWithdrawals, leftOutError, stillAwaited } from "../withdraw.js";
import { RuntimeContext, type Access, type Housekeeping, type Chain, type Applied } from "./context.js";
import { withdrawal } from "./calls.js";
import { runInline } from "./work.js";
import { pause } from "./helpers.js";
import { flowForCaller, flowFor } from "./views.js";

// --- internals ------------------------------------------------------------------

export async function apply(rt: RuntimeContext, scope: Scope, runId: string, options: {
      build: (state: RunState, flow: CompiledFlow) => FlowEvent | null;
      access?: Access;
      housekeeping?: Housekeeping;
      chain: Chain;
      why?: Why;
      /** The version a `run.migrated` event moves the run to. */
      to?: CompiledFlow;
      /** On an accepted event that changed nothing, leave `housekeeping` to the caller, which may record something else first. */
      deferHousekeeping?: boolean;
      /** The request whose `traceparent` and `authTime` a person's event carries, when it is not `access.ctx`. */
      traceCtx?: TrustedContext;
      /** For an action's outcome: how long the port took, for its trace. */
      latencyMs?: number;
      /** Writes a cancel took back: recorded withdrawn in the event's own commit, ahead of it, or not at all (`stepWithdrawals`). */
      withdraw?: readonly TakenWrite[];
    }): Promise<Applied> {
  const housekeeping = options.housekeeping ?? {};
  const traced = options.access?.ctx ?? options.traceCtx;
  let withdraw = options.withdraw;
  let reported = false;
  for (let attempt = 0; ; attempt++) {
    const state = await rt.store.loadRun(scope, runId);
    if (!state) {
      await commitHousekeeping(rt, scope, runId, housekeeping);
      throw new FlowError("not_found", "Not found.");
    }
    let flow = options.access ? await flowForCaller(rt, options.access, state) : await flowFor(rt, scope, state);
    const event = options.build(state, flow);
    if (!event) {
      await commitHousekeeping(rt, scope, runId, housekeeping);
      return { state, flow, result: null };
    }
    rt.requests.stamp(event, traced);
    const started = rt.clock.now();
    const pre = withdraw ? stepWithdrawals(flow, state, withdraw, (w) => withdrawal(rt, w)) : null;
    if (pre && pre.leftOut.length > 0 && !reported) {
      reported = true;
      rt.observer.error?.(leftOutError(runId, pre.leftOut), "withdraw");
    }
    const base = pre?.state ?? state;
    const result = event.type === "run.migrated" && options.to ? migrateStep(flow, options.to, base, event) : step(flow, base, event);
    if (result.accepted && result.changed && event.type === "run.migrated" && options.to) flow = options.to;
    if (!result.accepted || !result.changed) {
      if (!(options.deferHousekeeping === true && result.accepted)) await commitHousekeeping(rt, scope, runId, housekeeping);
      trace(rt, state, state, flow, event, result, started, options.why, options.latencyMs);
      return { state, flow, result };
    }
    const done = pre ? { ...housekeeping, outboxDone: [...(housekeeping.outboxDone ?? []), ...pre.done.map((l) => l.id)], outboxTaken: pre.done } : housekeeping;
    const { batch, inlineItems } = batchFor(rt, scope, state.revision, result.state, event, pre ? [...pre.effects.filter((e) => stillAwaited(result.state, e)), ...result.effects] : result.effects, done, canInline(rt, options.chain), pre?.steps.map((p) => p.event));
    const committed = await rt.store.commit(batch);
    if (!committed.ok) {
      // The cancel outlived a taken write's lease, and another owner holds it now (sending it): decide again without it.
      if (committed.conflict === "outbox" && withdraw?.some((t) => t.id === committed.id)) {
        withdraw = withdraw.filter((t) => t.id !== committed.id);
        attempt -= 1;
        continue;
      }
      if (attempt >= rt.limits.conflictRetries) throw new FlowError("conflict", "Too much happening at once. Please try again.");
      await pause(attempt);
      continue;
    }
    for (const p of pre?.steps ?? []) trace(rt, p.before, p.result.state, flow, p.event, p.result, started);
    trace(rt, base, result.state, flow, event, result, started, options.why, options.latencyMs);
    const withdrawn = pre ? { withdrawn: pre.done.map((l) => l.id) } : {};
    if (inlineItems.length > 0) {
      const latest = await runInline(rt, scope, result.state, flow, inlineItems, options.chain);
      if (latest) return { state: latest.state, flow: latest.flow, result, ...withdrawn };
    }
    return { state: result.state, flow, result, ...withdrawn };
  }
}

export function batchFor(rt: RuntimeContext, scope: Scope, prevRevision: number, state: RunState, event: FlowEvent, effects: FlowEffect[], housekeeping: Housekeeping, inline: boolean, before: FlowEvent[] = []): { batch: CommitBatch; inlineItems: OutboxItem[] } {
  const now = rt.clock.now();
  const add: OutboxItem[] = [];
  const inlineItems: OutboxItem[] = [];
  // With fair lanes, this commit's inline items are reserved for an owner of their own: a lease of this
  // worker's loop on the same item can then never be taken for this call's when its answer is lost.
  let reservedFor: string | undefined;
  const timerOps = new Map<string, TimerItem | null>();
  const waitOps = new Map<string, WaitItem | null>();
  for (const effect of effects) {
    switch (effect.kind) {
      case "action": {
        // With fair lanes, an inline item is a reservation (no claim yet, a short lease) until `claimInline`.
        const reserve = inline && rt.store.lanes !== undefined;
        const item: OutboxItem = {
          id: `${effect.effectId}#${effect.attempt}`,
          scope,
          runId: state.runId,
          effect,
          context: { subjectId: state.subject?.id ?? null, environment: state.env.environment, dispatch: dispatchFor(state, event.actor, effect, event.traceparent) },
          availableAt: now,
          claims: inline && !reserve ? 1 : 0,
          ...(inline
            ? reserve
              ? { leaseOwner: (reservedFor ??= `${rt.workerId}:inline:${++rt.inlineCalls}`), leaseUntil: now + (rt.lanePolicy.inlineGraceMs ?? DEFAULT_INLINE_GRACE_MS) }
              : { leaseOwner: rt.workerId, leaseUntil: now + rt.limits.leaseMs }
            : {}),
          ...(rt.store.lanes ? laneFields({ policy: rt.lanePolicy, keys: rt.keys, onError: (e, w) => rt.observer.error?.(e, w), scope, state, event, effect, now }) : {}),
        };
        add.push(item);
        if (inline) inlineItems.push(item);
        break;
      }
      case "timer":
        timerOps.set(effect.timerId, { scope, runId: state.runId, timerId: effect.timerId, generation: effect.generation, dueAt: effect.dueAt });
        break;
      case "timer.cancel":
        timerOps.set(effect.timerId, null);
        break;
      case "wait.open":
        waitOps.set(effect.stepId, { scope, runId: state.runId, stepId: effect.stepId, event: effect.event, key: effect.key });
        break;
      case "wait.close":
        waitOps.set(effect.stepId, null);
        break;
      case "call.start":
      case "call.cancel":
      case "call.return": {
        const id = effect.kind === "call.start" ? `${effect.callId}#${effect.attempt}` : effect.kind === "call.cancel" ? `${effect.callId}#cancel` : `${effect.childRunId}#return`;
        const item: OutboxItem = {
          id,
          scope,
          runId: state.runId,
          effect,
          context: { subjectId: state.subject?.id ?? null, environment: state.env.environment },
          availableAt: now,
          claims: inline ? 1 : 0,
          ...(inline ? { leaseOwner: rt.workerId, leaseUntil: now + rt.limits.leaseMs } : {}),
          // Lane "-", never limited, with the run's priority: a call is the runtime's own work, so it is
          // claimed at once rather than reserved, and only the child's own actions meet their lanes.
          ...(rt.store.lanes ? laneFields({ policy: rt.lanePolicy, keys: rt.keys, onError: (e, w) => rt.observer.error?.(e, w), scope, state, event, effect, now }) : {}),
        };
        add.push(item);
        if (inline) inlineItems.push(item);
        break;
      }
    }
  }
  const batch: CommitBatch = {
    scope,
    runs: [{ runId: state.runId, expectedRevision: prevRevision, state, events: [...before, event] }],
    outbox: { add, done: housekeeping.outboxDone ?? [], ...(housekeeping.outboxTaken?.length ? { taken: housekeeping.outboxTaken } : {}) },
    timers: {
      done: housekeeping.timerDone ? [{ runId: state.runId, ...housekeeping.timerDone }] : [],
      set: [...timerOps.values()].filter((t): t is TimerItem => t !== null),
      cancel: [...timerOps.entries()].filter(([, t]) => t === null).map(([timerId]) => ({ runId: state.runId, timerId })),
    },
    waits: {
      open: [...waitOps.values()].filter((w): w is WaitItem => w !== null),
      close: [...waitOps.entries()].filter(([, w]) => w === null).map(([stepId]) => ({ runId: state.runId, stepId })),
    },
    ...(housekeeping.signals?.length ? { lanes: { now, signals: housekeeping.signals } } : {}),
  };
  return { batch, inlineItems };
}

export async function commitHousekeeping(rt: RuntimeContext, scope: Scope, runId: string, housekeeping: Housekeeping): Promise<void> {
  if (!housekeeping.outboxDone?.length && !housekeeping.timerDone && !housekeeping.signals?.length) return;
  await rt.store.commit({
    scope,
    runs: [],
    outbox: { done: housekeeping.outboxDone ?? [] },
    timers: { done: housekeeping.timerDone ? [{ runId, ...housekeeping.timerDone }] : [] },
    ...(housekeeping.signals?.length ? { lanes: { now: rt.clock.now(), signals: housekeeping.signals } } : {}),
  });
}

export function newChain(rt: RuntimeContext): Chain {
  return { depth: 0, deadline: rt.clock.now() + rt.limits.inlineBudgetMs, busy: {} };
}

export function canInline(rt: RuntimeContext, chain: Chain): boolean {
  return rt.limits.inline && chain.depth < rt.limits.maxInlineChain && rt.clock.now() < chain.deadline;
}

/** Traces one applied event, with the basis it was accepted on (`before` is the state it met). */
export function trace(rt: RuntimeContext, before: RunState | null, state: RunState, flow: CompiledFlow, event: FlowEvent, result: StepResult, started: number, why?: Why, latencyMs?: number): void {
  if (!rt.observer.trace) return;
  try {
    const basis = basisOf(before, event, why);
    rt.observer.trace({
      scope: state.scope,
      runId: state.runId,
      flowId: flow.id,
      flowVersion: flow.version,
      revision: state.revision,
      event: result.trace.event,
      before: result.trace.before,
      after: result.trace.after,
      factsChanged: result.trace.factsChanged,
      factsCleared: result.trace.factsCleared,
      effects: result.trace.effects,
      ...(result.trace.rejected !== undefined ? { rejected: result.trace.rejected } : {}),
      durationMs: rt.clock.now() - started,
      basis: basis.basis,
      ...(basis.rule ? { rule: basis.rule } : {}),
      ...(basis.turnId !== undefined ? { turnId: basis.turnId } : {}),
      ...(state.parent ? { parentRunId: state.parent.runId, rootRunId: state.parent.rootRunId, depth: state.parent.depth } : {}),
      ...traceFields(before, state, event, result, latencyMs),
    });
  } catch (error) {
    rt.observer.error?.(error, "trace");
  }
}
