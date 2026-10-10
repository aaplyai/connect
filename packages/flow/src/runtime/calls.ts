/**
 * Calls between flows: starting, cancelling and returning from child runs,
 * and taking back writes nobody has sent.
 */

import { CALL_ACTOR, checkChain, checkCallPair, MAX_CALL_DEPTH } from "../calls.js";
import type { CompiledFlow } from "../compile.js";
import { step, type StepResult, type Rejection } from "../core.js";
import { own } from "../json.js";
import type { Why } from "../routing.js";
import type { Admission, TrustedContext } from "../ports.js";
import { RunReader } from "../reader.js";
import type { OutboxItem, CommitBatch } from "../store.js";
import { EVENT_VERSION, type FlowEvent, type Scope, type RunState, type CallState, type CallStartedEvent, type RunStartedEvent, CORE_VERSION, type ActorRef } from "../state.js";
import { FlowError } from "../errors.js";
import { stepWithdrawals, leftOutError, type TakenWrite, unsentWrites, type UnsentWrite, withdrawnOutcome } from "../withdraw.js";
import { RuntimeContext, type CallItem, type Chain, type Applied, type CallStartEffect, SYSTEM_ACTOR } from "./context.js";
import { afterSystem, isRevoked, startRevoked } from "./migrate.js";
import { isNotFound, pause, deeper, actorRef } from "./helpers.js";
import { newNonce } from "./start.js";
import { flowFor, load, loadFor } from "./views.js";
import { apply, commitHousekeeping, trace, canInline, batchFor } from "./apply.js";
import { runInline } from "./work.js";

// --- calls: child runs ---------------------------------------------------------

/**
 * Performs a call item: starts a child, stops one, or brings its end back to
 * its caller. Each is a system event for the run it lands on, so a forced or
 * revoked version's run moves (or ends) after it, as after any other.
 */
export async function performCallItem(rt: RuntimeContext, item: CallItem, chain: Chain): Promise<Applied | null> {
  const effect = item.effect;
  const scope = item.scope;
  const done = { outboxDone: [item.id] };
  const at = () => rt.clock.now();
  let applied: Applied | null;
  try {
    switch (effect.kind) {
      case "call.start":
        applied = await performCall(rt, item, effect, chain);
        break;
      case "call.cancel":
        applied = await apply(rt, scope, effect.childRunId, {
          build: (state) => (state.parent?.callId === effect.callId ? { v: EVENT_VERSION, type: "call.cancelled", id: rt.ids.newId(), at: at(), actor: CALL_ACTOR, reason: effect.reason } : null),
          housekeeping: done,
          chain,
        });
        break;
      case "call.return":
        applied = await apply(rt, scope, effect.parentRunId, {
          build: () => ({ v: EVENT_VERSION, type: "call.settled", id: rt.ids.newId(), at: at(), actor: CALL_ACTOR, callId: effect.callId, childRunId: effect.childRunId, end: effect.end }),
          housekeeping: done,
          chain,
        });
        break;
    }
  } catch (error) {
    // The run it goes to is gone (erased): nothing waits for this any more.
    if (isNotFound(error)) return null;
    throw error;
  }
  if (applied) await afterSystem(rt, scope, applied);
  return applied;
}

/**
 * Starts a child run exactly once. The child's first state and the caller's
 * `call.started` are committed together, with the outbox row, so a child
 * exists if and only if its caller recorded it. A caller that changed
 * meanwhile is read again: if it no longer starts this attempt, the item is
 * dropped and no child is made.
 */
export async function performCall(rt: RuntimeContext, item: CallItem, effect: CallStartEffect, chain: Chain): Promise<Applied | null> {
  const scope = item.scope;
  for (let attempt = 0; ; attempt++) {
    const parent = await rt.store.loadRun(scope, item.runId);
    if (!parent) {
      await commitHousekeeping(rt, scope, item.runId, { outboxDone: [item.id] });
      return null;
    }
    const flow = await flowFor(rt, scope, parent);
    const call = own(parent.calls ?? {}, effect.callId);
    if (!call || call.status !== "starting" || call.attempt !== effect.attempt || parent.status !== "active") {
      await commitHousekeeping(rt, scope, parent.runId, { outboxDone: [item.id] });
      return { state: parent, flow, result: null };
    }
    const started = rt.clock.now();
    const prepared = await prepareChild(rt, scope, parent, flow, call, effect);
    const event: FlowEvent = { v: EVENT_VERSION, type: "call.started", id: rt.ids.newId(), at: rt.clock.now(), actor: CALL_ACTOR, callId: effect.callId, attempt: effect.attempt, outcome: prepared.outcome };
    const result = step(flow, parent, event);
    if (!result.accepted || !result.changed) {
      await commitHousekeeping(rt, scope, parent.runId, { outboxDone: [item.id] });
      trace(rt, parent, parent, flow, event, result, started);
      return { state: parent, flow, result };
    }
    const inline = canInline(rt, chain);
    const { batch, inlineItems } = batchFor(rt, scope, parent.revision, result.state, event, result.effects, { outboxDone: [item.id] }, inline);
    let childInline: OutboxItem[] = [];
    if (prepared.child) {
      const c = prepared.child;
      const childBatch = batchFor(rt, scope, 0, c.result.state, c.event, c.result.effects, {}, inline);
      mergeBatch(batch, childBatch.batch);
      childInline = childBatch.inlineItems;
    }
    const committed = await rt.store.commit(batch);
    if (!committed.ok) {
      // Another worker started it, or the caller moved on: read the caller again.
      if (attempt >= rt.limits.conflictRetries) throw new FlowError("conflict", "Too much happening at once.");
      await pause(attempt);
      continue;
    }
    trace(rt, parent, result.state, flow, event, result, started);
    if (prepared.child) trace(rt, null, prepared.child.result.state, prepared.child.flow, prepared.child.event, prepared.child.result, started);
    const next = deeper(chain);
    let latest: Applied = { state: result.state, flow, result };
    if (prepared.child && childInline.length > 0) await runInline(rt, scope, prepared.child.result.state, prepared.child.flow, childInline, next);
    if (inlineItems.length > 0) latest = (await runInline(rt, scope, result.state, flow, inlineItems, next)) ?? latest;
    return latest;
  }
}

/**
 * Admits, resolves and checks a call, and steps the child's start. The
 * outcome is what the caller records: `ok` with the child to create, or
 * why not (a transient reason is tried again, any other is final).
 */
export async function prepareChild(rt: RuntimeContext, scope: Scope, parent: RunState, parentFlow: CompiledFlow, call: CallState, effect: CallStartEffect): Promise<{ outcome: CallStartedEvent["outcome"]; child?: { flow: CompiledFlow; event: RunStartedEvent; result: StepResult & { state: RunState } } }> {
  const final = (code: string, detail: string): { outcome: CallStartedEvent["outcome"] } => ({ outcome: { status: "final", error: { code, message: "This could not be started.", detail } } });
  const admitted = await Promise.resolve()
    .then(() => rt.admission.admit({ scope, op: "call", flowId: effect.flowId, ...(parent.subject ? { actorId: parent.subject.id } : {}) }))
    .catch((error: unknown): Admission => {
      // Fail closed: a child is started later, never unchecked, when admission cannot answer.
      rt.observer.error?.(error, "admission");
      return { ok: false, code: "flow/admission-unavailable" };
    });
  if (!admitted.ok) {
    return { outcome: { status: "retryable", error: { code: admitted.code, message: "Rate limited." }, ...(admitted.retryAfterMs !== undefined ? { retryAfterMs: admitted.retryAfterMs } : {}) } };
  }
  let child: CompiledFlow | null;
  try {
    // Within the caller's own scope only: a call cannot reach another tenant, app or environment.
    child = await rt.catalog.get(scope, effect.flowId, effect.version);
    if (child && effect.upgrade === "compatible") {
      const current = await rt.catalog.get(scope, effect.flowId);
      // The current version stands in only with an equal interface; otherwise the pinned one runs.
      if (current && current.version !== child.version && current.interface !== undefined && current.interface.hash === child.interface?.hash) child = current;
    }
  } catch (error) {
    rt.observer.error?.(error, "call");
    return { outcome: { status: "retryable", error: { code: "flow/call-unavailable", message: "This is not available right now." } } };
  }
  if (!child) return final("flow/call-unavailable", `${effect.flowId}@${effect.version} is not published`);
  // A revoked version starts nothing new: no child for a revoked caller, and none on a revoked child version.
  let revoked: boolean;
  try {
    revoked = (await isRevoked(rt, scope, parent)) || (await startRevoked(rt, scope, child));
  } catch (error) {
    rt.observer.error?.(error, "call");
    return { outcome: { status: "retryable", error: { code: "flow/call-unavailable", message: "This is not available right now." } } };
  }
  if (revoked) return final("flow/version-revoked", `${child.id}@${child.version} or its caller's version was withdrawn`);
  const callStep = parentFlow.stepById.get(call.key);
  if (!callStep?.call) return final("flow/call-unavailable", `step "${call.key}" no longer calls a flow`);
  const problem = checkChain(child.id, effect.parent, rt.limits.maxCallDepth) ?? checkCallPair(parentFlow, callStep, child)[0] ?? null;
  if (problem) return final(problem.code, problem.message);
  const event: RunStartedEvent = {
    v: EVENT_VERSION,
    type: "run.started",
    id: rt.ids.newId(),
    at: rt.clock.now(),
    actor: CALL_ACTOR,
    runId: effect.childRunId,
    flowId: child.id,
    flowVersion: child.version,
    flowHash: child.hash,
    // The child is its caller's: same scope, person and environment, and nothing else.
    scope: { ...parent.scope },
    subject: parent.subject ? { id: parent.subject.id } : null,
    env: { ...parent.env },
    facts: effect.input,
    source: "call",
    parent: effect.parent,
    nonce: newNonce(rt),
    core: CORE_VERSION,
  };
  const result = step(child, null, event);
  if (!result.accepted || !result.state) return final(result.accepted ? "flow/call-failed" : result.rejection.code, result.accepted ? "the child did not start" : result.rejection.message);
  return { outcome: { status: "ok", flowVersion: child.version, flowHash: child.hash }, child: { flow: child, event, result: result as StepResult & { state: RunState } } };
}

/**
 * Cancels run `rootId` and everything it is waiting for. The cancellation is
 * applied at the deepest live run, after checking every run on the way for
 * what would refuse it (committed, or committing now), and the ends travel
 * up, stopping at `rootId`. The deepest run's writes nobody sent are taken
 * and recorded withdrawn in its cancel's commit, or handed back; a run
 * above it waits for a call, so its steps (run in order) have none.
 * Returns the refusal, or null when it went ahead.
 */
export async function cancelTree(rt: RuntimeContext, scope: Scope, rootId: string, actor: ActorRef, reason: string, chain: Chain, why?: Why): Promise<Rejection | null> {
  for (let attempt = 0; attempt <= rt.limits.conflictRetries; attempt++) {
    let { state, flow } = await load(rt, scope, rootId);
    if (state.status !== "active") return { code: "flow/run-ended", message: "This has already finished." };
    let at = actor;
    for (let depth = 0; depth < MAX_CALL_DEPTH; depth++) {
      const running = Object.values(state.calls ?? {}).find((c) => c.status === "running");
      if (!running) break;
      const problem = new RunReader(flow, state, rt.clock.now()).cancelProblem(at);
      if (problem) return { code: problem[0], message: problem[1] };
      const child = await load(rt, scope, running.runId);
      // The child ended (or is ending) and its report to this run has not arrived yet: the run
      // is still live, and its cancellation waits for that report.
      if (child.state.status !== "active") return { code: "flow/busy", message: "Part of this has just finished and is being recorded. Please try again in a moment." };
      ({ state, flow } = child);
      at = SYSTEM_ACTOR;
    }
    const leaf = state.runId;
    const taken = await takeUnsent(rt, scope, state, flow, at);
    const pre = stepWithdrawals(flow, state, taken, (w) => withdrawal(rt, w));
    const problem = new RunReader(flow, pre.state, rt.clock.now()).cancelProblem(at);
    if (problem) {
      if (pre.leftOut.length > 0) rt.observer.error?.(leftOutError(leaf, pre.leftOut), "withdraw");
      await handBack(rt, scope, taken);
      return { code: problem[0], message: problem[1] };
    }
    const applied = await applyWithdrawing(rt, scope, leaf, taken, {
      build: () => ({
        v: EVENT_VERSION,
        type: "run.cancelled",
        id: rt.ids.newId(),
        at: rt.clock.now(),
        // At a child the runtime cancels, for the run that was asked to.
        actor: leaf === rootId ? actor : SYSTEM_ACTOR,
        reason,
        ...(leaf !== rootId ? { cascade: rootId } : {}),
      }),
      chain,
      // What the cancellation rests on (a person's consent to a model's proposal, say).
      ...(why ? { why } : {}),
    });
    const result = applied.result;
    // A child started meanwhile: walk down again.
    if (result && !result.accepted && result.rejection.code === "flow/call-running") continue;
    return result && !result.accepted ? result.rejection : null;
  }
  return { code: "flow/busy", message: "Too much is happening at once. Please try again." };
}

/** Before a person's cancel: takes what nobody has sent, once the caller may see the run. Never throws: the cancel reports what is wrong. */
export async function takeFor(rt: RuntimeContext, ctx: TrustedContext, runId: string): Promise<TakenWrite[]> {
  try {
    const { state, flow } = await loadFor(rt, ctx, runId);
    return await takeUnsent(rt, ctx.scope, state, flow, actorRef(ctx));
  } catch (error) {
    if (!(error instanceof FlowError)) rt.observer.error?.(error, "withdraw");
    return [];
  }
}

/**
 * Takes the run's writes nobody has sent, before a cancel by `actor`
 * (ADR-0009, amended): only while the run is active and `actor` may cancel
 * it, or is refused only `flow/busy`. Each is leased with `takeOutbox`
 * (never one a claim counts or a lease holds, so never one being sent); the
 * cancel's own commit records it withdrawn, or it is handed back
 * (`handBack`). A store without `takeOutbox` takes nothing.
 */
export async function takeUnsent(rt: RuntimeContext, scope: Scope, state: RunState, flow: CompiledFlow, actor: ActorRef): Promise<TakenWrite[]> {
  if (!rt.store.takeOutbox || state.status !== "active") return [];
  const problem = new RunReader(flow, state, rt.clock.now()).cancelProblem(actor);
  if (problem !== null && problem[0] !== "flow/busy") return [];
  const taken: TakenWrite[] = [];
  for (const unsent of unsentWrites(flow, state)) {
    const now = rt.clock.now();
    const owner = `${rt.workerId}:withdraw:${++rt.withdrawals}`;
    try {
      if (await rt.store.takeOutbox(scope, unsent.id, { owner, now, leaseMs: rt.limits.leaseMs })) taken.push({ ...unsent, runId: state.runId, lease: { id: unsent.id, owner, until: now + rt.limits.leaseMs } });
    } catch (error) {
      rt.observer.error?.(error, "withdraw");
    }
  }
  return taken;
}

/** Hands back taken writes unsent and unrecorded: taking one counted no claim, so it goes out as it would have. */
export async function handBack(rt: RuntimeContext, scope: Scope, taken: readonly TakenWrite[]): Promise<void> {
  for (const t of taken) await rt.store.releaseOutbox(scope, t.lease, rt.clock.now()).catch((error: unknown) => rt.observer.error?.(error, "lease"));
}

/** `apply`, with `taken` recorded withdrawn in the event's own commit or handed back. */
export async function applyWithdrawing(rt: RuntimeContext, scope: Scope, runId: string, taken: readonly TakenWrite[], options: Parameters<typeof apply>[3]): Promise<Applied> {
  let recorded: readonly string[] = [];
  try {
    const applied = await apply(rt, scope, runId, taken.length > 0 ? { ...options, withdraw: taken } : options);
    recorded = applied.withdrawn ?? [];
    return applied;
  } finally {
    if (taken.length > 0) await handBack(rt, scope, taken.filter((t) => !recorded.includes(t.id)));
  }
}

/** The event that records `write` withdrawn, unsent, ahead of a cancel. */
export function withdrawal(rt: RuntimeContext, write: UnsentWrite): FlowEvent {
  return { v: EVENT_VERSION, type: "action.settled", id: rt.ids.newId(), at: rt.clock.now(), actor: SYSTEM_ACTOR, effectId: write.effectId, attempt: write.attempt, outcome: withdrawnOutcome("retryable") };
}

/** Adds another run's write to a batch, so both commit atomically (a child and its caller). */
export function mergeBatch(into: CommitBatch, from: CommitBatch): void {
  into.runs.push(...from.runs);
  into.outbox = { add: [...(into.outbox?.add ?? []), ...(from.outbox?.add ?? [])], done: [...(into.outbox?.done ?? []), ...(from.outbox?.done ?? [])] };
  into.timers = {
    done: [...(into.timers?.done ?? []), ...(from.timers?.done ?? [])],
    set: [...(into.timers?.set ?? []), ...(from.timers?.set ?? [])],
    cancel: [...(into.timers?.cancel ?? []), ...(from.timers?.cancel ?? [])],
  };
  into.waits = { open: [...(into.waits?.open ?? []), ...(from.waits?.open ?? [])], close: [...(into.waits?.close ?? []), ...(from.waits?.close ?? [])] };
  if (from.lanes?.signals.length) into.lanes = { now: into.lanes?.now ?? from.lanes.now, signals: [...(into.lanes?.signals ?? []), ...from.lanes.signals] };
}
