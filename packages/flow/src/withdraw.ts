/**
 * Writes nobody sent are not sent once their run is ending (ADR-0009,
 * amended by the review of the 0.2 gaps and by its verification).
 *
 * The core cannot tell an attempt waiting in the outbox (deferred, or queued
 * for a worker) from one being performed, so it keeps both in flight: a
 * commit point refuses a cancel `flow/busy`, and any other write keeps a
 * cancelled run `cancelling` until it has gone out. The runtime can tell,
 * through the store: an item no claim counts and no lease holds was never
 * sent (`RunStore.takeOutbox`). So, with existing events only:
 * - before a cancel, the runtime takes such writes ({@link TakenWrite}) and
 *   records each `retryable` ({@link withdrawnOutcome}) in the cancel's own
 *   commit, ahead of the cancel ({@link stepWithdrawals}): the cancel then
 *   drops them, as it drops any write waiting to be retried that certainly
 *   did not apply. A write a withdrawal dispatches (the next item of a
 *   fan-out, once a last attempt fails) is withdrawn in that commit too, so
 *   none is left in flight. A cancel that is refused records none of them,
 *   and they are handed back unsent, with no attempt spent; and since both
 *   are one commit, no retry timer can fire between them;
 * - a worker that claims a write of a run already ending, on its first
 *   claim ({@link withdrawsOnEnd}), records it `final` instead of asking
 *   admission or sending it: the run's end is already decided.
 * Undos and checks are never withdrawn, and neither is a write an earlier
 * attempt may have applied: it is still followed up.
 */

import { keyOf } from "./address.js";
import type { CompiledFlow } from "./compile.js";
import { step, type StepAccepted } from "./core.js";
import { FlowError } from "./errors.js";
import { own } from "./json.js";
import type { ActionOutcome, FlowEffect, FlowEvent, RunState } from "./state.js";
import type { OutboxItem, OutboxLease } from "./store.js";

/** The code of an attempt taken back unsent because its run is ending. */
export const WITHDRAWN_CODE = "flow/withdrawn";

/**
 * The outcome recorded for a write taken back unsent, code {@link WITHDRAWN_CODE}:
 * `retryable` in a cancel's own commit, ahead of it (the cancel then drops
 * it), `final` for a run whose end is already decided. A fresh object each time.
 */
export function withdrawnOutcome(status: "retryable" | "final"): ActionOutcome {
  return { status, error: { code: WITHDRAWN_CODE, message: "This was not done, because this is ending." } };
}

/** A write of the run that may be waiting in the outbox, never sent: its outbox item id, effect and attempt. */
export interface UnsentWrite {
  /** `${effectId}#${attempt}`, the item's id. */
  id: string;
  effectId: string;
  attempt: number;
}

/**
 * The run's own writes that may be waiting in the outbox unsent, as far as
 * the run can tell: in flight for the run itself (`purpose: "run"`), not
 * waiting to be retried or reconciled (those have no item), not answered
 * `pending` (that was sent), and not possibly applied by an earlier attempt.
 * Whether one was really never sent is the store's to say (`takeOutbox`).
 */
export function unsentWrites(flow: CompiledFlow, state: RunState): UnsentWrite[] {
  const out: UnsentWrite[] = [];
  for (const [effectId, inflight] of Object.entries(state.inflight)) {
    if (inflight.purpose !== "run" || inflight.waiting || inflight.pending === true) continue;
    if (flow.actions.get(inflight.action)?.def.effect !== "write") continue;
    const result = own(state.results, keyOf(inflight.action, inflight.item));
    if (result?.effectId !== effectId || result.maybeApplied === true) continue;
    out.push({ id: `${effectId}#${inflight.attempt}`, effectId, attempt: inflight.attempt });
  }
  return out;
}

/**
 * Whether a worker withdraws `item` instead of sending it: a write of the
 * run itself, claimed for the first time (no earlier claim may have sent
 * it), which no earlier attempt may have applied, of a run that is ending
 * (`cancelling`, or with an end waiting on a commit).
 */
export function withdrawsOnEnd(state: RunState | undefined, item: OutboxItem): boolean {
  if (state === undefined || (state.status !== "cancelling" && state.pendingEnd === undefined)) return false;
  const effect = item.effect;
  if (effect.kind !== "action" || effect.purpose !== "run" || effect.effect !== "write" || item.claims > 1) return false;
  const result = own(state.results, keyOf(effect.name, effect.item));
  return !(result?.effectId === effect.effectId && result.maybeApplied === true);
}

/** Whether `unsent`'s attempt still waits for its outcome in `state` (in flight at that attempt, not waiting to be retried). */
export function stillUnsent(state: RunState, unsent: UnsentWrite): boolean {
  const inflight = own(state.inflight, unsent.effectId);
  return inflight !== undefined && inflight.attempt === unsent.attempt && !inflight.waiting;
}

/** A write a cancel took from the outbox (`RunStore.takeOutbox`) and has not recorded: its run, and the lease that hands it back, which the commit that records it must still hold. */
export interface TakenWrite extends UnsentWrite {
  runId: string;
  lease: OutboxLease;
}

/** The withdrawals {@link stepWithdrawals} recorded, to commit ahead of a cancel. */
export interface WithdrawalSteps {
  /** The run after them. */
  state: RunState;
  /** Each withdrawal's event, the run before it and the core's answer, in order. */
  steps: Array<{ before: RunState; event: FlowEvent; result: StepAccepted }>;
  /**
   * Their effects, in order (a retry timer, an undo, a read of a later
   * step), less the writes they dispatched, which are withdrawn too. Send
   * only those the run still waits for once the cancel is applied
   * ({@link stillAwaited}).
   */
  effects: FlowEffect[];
  /** The leases of the outbox items they settle: the commit removes each only while it still holds (`CommitBatch.outbox.taken`). */
  done: OutboxLease[];
  /** The taken writes still unsent that could not be withdrawn, because that would end the run (or the core refused it): they are handed back. */
  leftOut: string[];
}

/**
 * Steps the withdrawal of each write in `taken` that `state` still waits for
 * ({@link stillUnsent}) through the core, as `event` builds it, for the
 * cancel's own commit. A withdrawal that frees room for another write of
 * the run (the next item of a fan-out, once a last attempt fails) dispatches
 * it; that write was never sent either, so it is withdrawn in the same
 * commit too, and so on to a fixed point, bounded by the run's writes (one
 * per write action and item, {@link withdrawalBound}). A withdrawal is left
 * out, with what it dispatched (`leftOut`), when the core refuses it, when
 * it or one after it would end the run (its goal met once the write has
 * failed: the cancel decides the end), or past the bound: that write stays
 * taken and unrecorded, and the caller hands it back. `bound` is the most
 * withdrawals in all ({@link withdrawalBound} by default). Pure.
 */
export function stepWithdrawals(flow: CompiledFlow, state: RunState, taken: readonly TakenWrite[], event: (write: UnsentWrite) => FlowEvent, bound = withdrawalBound(flow, state)): WithdrawalSteps {
  const out: WithdrawalSteps = { state, steps: [], effects: [], done: [], leftOut: [] };
  for (const write of taken) {
    if (write.runId !== state.runId || !stillUnsent(out.state, write)) continue;
    const unit = withdrawOne(flow, out.state, write, event, bound - out.steps.length);
    if (!unit) {
      out.leftOut.push(write.id);
      continue;
    }
    out.steps.push(...unit.steps);
    out.effects.push(...unit.effects);
    out.done.push(write.lease);
    out.state = unit.state;
  }
  return out;
}

/**
 * The most withdrawals one cancel records for `state`: one per write action
 * of the flow and item of the run (or none), the most writes it can have
 * dispatched. Withdrawals add no items, and a failed write is not sent again
 * without new input, so the fixed point comes well within it.
 */
export function withdrawalBound(flow: CompiledFlow, state: RunState): number {
  let writes = 0;
  for (const action of flow.actions.values()) if (action.def.effect === "write") writes++;
  return writes * (Object.keys(state.items ?? {}).length + 1);
}

/** `write`'s withdrawal and those of the writes it dispatches, in order, within `budget` steps; null when it is left out. */
function withdrawOne(flow: CompiledFlow, state: RunState, write: UnsentWrite, event: (write: UnsentWrite) => FlowEvent, budget: number): Pick<WithdrawalSteps, "state" | "steps" | "effects"> | null {
  const unit: Pick<WithdrawalSteps, "state" | "steps" | "effects"> = { state, steps: [], effects: [] };
  const queue: UnsentWrite[] = [write];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (unit.steps.length >= budget) return null;
    const ev = event(next);
    const result = step(flow, unit.state, ev);
    if (!result.accepted || !result.changed || result.state.status !== "active") return null;
    for (const effect of result.effects) {
      if (effect.kind === "action" && effect.purpose === "run" && effect.effect === "write") queue.push({ id: `${effect.effectId}#${effect.attempt}`, effectId: effect.effectId, attempt: effect.attempt });
      else unit.effects.push(effect);
    }
    unit.steps.push({ before: unit.state, event: ev, result });
    unit.state = result.state;
  }
  return unit;
}

/**
 * Whether the run, in `state` (after the cancel), still waits for `effect`,
 * one of {@link WithdrawalSteps.effects}: an action in flight at that
 * attempt (an undo, say), and not one the cancel dropped (a read of a later
 * step). Anything else is kept: a timer or a wait the cancel's own effects
 * close, a call's start that a worker drops once the call no longer starts.
 */
export function stillAwaited(state: RunState, effect: FlowEffect): boolean {
  return effect.kind !== "action" || own(state.inflight, effect.effectId)?.attempt === effect.attempt;
}

/**
 * What a cancel reports (`Observer.error`, where `"withdraw"`) for the writes
 * it took and could not withdraw ({@link WithdrawalSteps.leftOut}): they go
 * back to the outbox unsent, and the cancel waits for them (`cancelling`) or,
 * for a commit point, is refused `flow/busy` until they are sent.
 */
export function leftOutError(runId: string, leftOut: readonly string[]): FlowError {
  return new FlowError("conflict", `The cancel of run ${runId} could not withdraw ${leftOut.join(", ")}: recording them not done would end the run (or was refused). They wait to be sent.`);
}
