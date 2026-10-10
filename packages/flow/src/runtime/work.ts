/**
 * Work: performing outbox items and firing timers, inline after a commit or
 * by a worker claiming them, and recording what each attempt did.
 */

import { CONTRACT_UNSUPPORTED_RETRY_MS, MAX_ACTION_TIMEOUT_MS, UNSIGNED_PROOF, normalizeOutcome, type ApprovedAction } from "@aaply/action-contract";
import { dispatchFor, refuseBeforeSending, answerAfterMaybeApplied, type ActionDispatch, buildApprovedAction, UNSIGNED_AUDIENCE, completionToken, type EnvelopeSigning, signingInput, attachProof } from "../approved.js";
import { admissionAction, deferralSince, deferUntil } from "../admission.js";
import { CALL_ACTOR } from "../calls.js";
import type { CompiledFlow } from "../compile.js";
import { own, type JsonValue, canonicalJson } from "../json.js";
import type { LaneSignal, LaneRecord } from "../lanes.js";
import type { Admission } from "../ports.js";
import { claimRecords, refusals, grantedItems, type Performed, laneSignal, pausedRecord } from "../runtime-lanes.js";
import { completionWindowFor } from "../operation-registry.js";
import { noCommonContract, refusedForVersion, type ContractVersion } from "../contract-versions.js";
import { type TimerItem, type OutboxItem, type InlineGrant, scopeKey } from "../store.js";
import { EVENT_VERSION, type Scope, type RunState, type ActionOutcome, type FlowEvent, type ActionEffect } from "../state.js";
import { reportLateBlobs, guardBlobOutcome } from "../blob-guard.js";
import { FlowError } from "../errors.js";
import { withdrawsOnEnd, withdrawnOutcome } from "../withdraw.js";
import { RuntimeContext, SYSTEM_ACTOR, type Chain, type Applied, isActionItem, type CallItem, type ActionItem, NO_INLINE, REVOKED_OUTCOME, type Housekeeping } from "./context.js";
import { afterSystem, isRevoked, maybeMigrate } from "./migrate.js";
import { performCallItem } from "./calls.js";
import { earlierCompletion } from "./deliver.js";
import { isNotFound, deeper, within, policyVersion } from "./helpers.js";
import { load } from "./views.js";
import { apply, newChain, commitHousekeeping } from "./apply.js";
import { keyOf } from "../address.js";

export async function work(rt: RuntimeContext, options: { limit?: number; only?: "actions" | "timers" } = {}): Promise<{ actions: number; timers: number }> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  if (options.only === "actions") return { actions: await workActions(rt, limit), timers: 0 };
  if (options.only === "timers") return { actions: 0, timers: await workTimers(rt, limit) };
  // Timers are claimed and fired beside the actions, never behind them: one slow call
  // (up to a lease) would otherwise hold back every due timer this worker could fire.
  // Both settle before work() answers; a failed claim is thrown as before, and a second failure reported.
  const [actions, timers] = await Promise.allSettled([workActions(rt, limit), workTimers(rt, limit)]);
  if (actions.status === "rejected") {
    if (timers.status === "rejected") rt.observer.error?.(timers.reason, "work:timer");
    throw actions.reason;
  }
  if (timers.status === "rejected") throw timers.reason;
  return { actions: actions.value, timers: timers.value };
}

export async function workActions(rt: RuntimeContext, limit: number): Promise<number> {
  const claimedAt = rt.clock.now();
  const items = await rt.store.claimOutbox({ owner: rt.workerId, now: claimedAt, limit, leaseMs: rt.limits.leaseMs });
  if (rt.observer.lane) for (const record of claimRecords(items, claimedAt)) laneRecord(rt, record);
  // One run's items are recorded one after another, so they do not compete for its revision;
  // different runs go in parallel.
  await Promise.all([...groupByRun(items).values()].map((group) => workRun(rt, group).catch((error: unknown) => rt.observer.error?.(error, "work:action"))));
  return items.length;
}

export async function workTimers(rt: RuntimeContext, limit: number): Promise<number> {
  const timers = await rt.store.claimTimers({ owner: rt.workerId, now: rt.clock.now(), limit, leaseMs: rt.limits.leaseMs });
  // As with actions: one run's timers fire in order, different runs in parallel.
  const fire = async (group: readonly TimerItem[]): Promise<void> => {
    for (const timer of group) {
      try {
        const applied = await apply(rt, timer.scope, timer.runId, {
          build: () => ({ v: EVENT_VERSION, type: "timer.fired", id: rt.ids.newId(), at: rt.clock.now(), actor: SYSTEM_ACTOR, timerId: timer.timerId, generation: timer.generation }),
          housekeeping: { timerDone: { timerId: timer.timerId, generation: timer.generation } },
          chain: newChain(rt),
        });
        await afterSystem(rt, timer.scope, applied);
      } catch (error) {
        if (!isNotFound(error)) rt.observer.error?.(error, "work:timer");
      }
    }
  };
  await Promise.all([...groupByRun(timers).values()].map(fire));
  return timers.length;
}

/**
 * Performs effects inline and records their outcomes, within the request's
 * time budget. Out of time, it returns null (the caller shows the run as
 * working) and the calls finish and are recorded in the background, still
 * under their leases. An outbox row goes only with the commit that records
 * its outcome, so if this process dies first, a worker takes it over when
 * the lease ends.
 */
export async function runInline(rt: RuntimeContext, scope: Scope, state: RunState, flow: CompiledFlow, all: OutboxItem[], chain: Chain): Promise<Applied | null> {
  const runId = state.runId;
  // Calls are the runtime's own work: done first, one at a time, each with its own commits.
  let fromCalls: Applied | null = null;
  for (const item of all) {
    if (isActionItem(item)) continue;
    try {
      const applied = await performCallItem(rt, item as CallItem, deeper(chain));
      if (applied?.state.runId === runId) fromCalls = applied;
    } catch (error) {
      // The row stays leased; when the lease ends a worker performs it instead.
      rt.observer.error?.(error, "inline");
    }
  }
  const reserved = all.filter(isActionItem);
  if (reserved.length === 0) return fromCalls;
  let revoked: boolean;
  try {
    revoked = await isRevoked(rt, scope, state);
  } catch (error) {
    // Nothing is sent unchecked, and nothing was sent: the rows go back to the outbox with their
    // claims taken back, so a worker sends them rather than taking them for interrupted.
    rt.observer.error?.(error, "inline");
    await release(rt, reserved, rt.clock.now());
    return fromCalls;
  }
  let items = reserved;
  if (revoked) {
    // A revoked version sends nothing new. What it never sent goes to a worker, which leaves it
    // to the run's move (that starts it again under the new version), or records it as not done.
    const leave = items.filter((item) => suppressed(state, item));
    await release(rt, leave, rt.clock.now());
    items = items.filter((item) => !leave.includes(item));
    if (items.length === 0) return fromCalls;
  }
  // With fair lanes, the items were committed as reservations; only those their lanes admit run here.
  if (rt.store.lanes) items = (await claimInline(rt, scope, items, chain)) as ActionItem[];
  if (items.length === 0) return fromCalls;
  const calls = items.map((item) => execute(rt, item, flow, state));
  const record = async (next: Chain): Promise<Applied | null> => {
    let latest: Applied | null = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const performed = await calls[i]!;
      // Not sent: the lease was lost, and whoever holds the row now sends and records it.
      if (performed === null) continue;
      await renew(rt, item);
      try {
        latest = await recordOutcome(rt, item, performed, next);
      } catch (error) {
        // The row stays leased; when the lease ends a worker settles it instead.
        rt.observer.error?.(error, "inline");
      }
    }
    // Recorded after the request answered: nobody else moves the run if its version says so.
    if (next === NO_INLINE && latest) await afterSystem(rt, scope, latest);
    return latest;
  };
  if (await within(Promise.all(calls), chain.deadline - rt.clock.now())) return record(deeper(chain));
  void record(NO_INLINE).catch((error: unknown) => rt.observer.error?.(error, "inline"));
  return null;
}

/**
 * Turns reservations into inline leases as far as their lanes admit them.
 * A refused item is claimable by workers at once (claims unchanged), and
 * the request's response says why (`busy`). If the store cannot answer,
 * nothing runs inline: the reservations end after the grace period and
 * workers take the items then. An answer lost after the store granted
 * (a dropped connection) is handed back: the lease the call gave is
 * released with its claim, so a worker sends the item as never sent
 * rather than as interrupted.
 */
export async function claimInline(rt: RuntimeContext, scope: Scope, reserved: OutboxItem[], chain: Chain): Promise<OutboxItem[]> {
  let grant: InlineGrant;
  const now = rt.clock.now();
  // The reservations of one commit share an owner of their own (see batchFor), never this worker's.
  const owner = reserved[0]?.leaseOwner ?? rt.workerId;
  try {
    grant = await rt.store.lanes!.claimInline(scope, reserved.map((i) => i.id), { owner, now, leaseMs: rt.limits.leaseMs });
  } catch (error) {
    rt.observer.error?.(error, "lanes:claimInline");
    // Conditional on the exact lease a grant of this call carries (this call's owner), so it changes nothing otherwise.
    await release(rt, reserved.map((item) => ({ ...item, leaseOwner: owner, leaseUntil: now + rt.limits.leaseMs })), now);
    return [];
  }
  for (const { busy, record } of refusals(scope, reserved, grant)) {
    laneRecord(rt, record);
    if (chain.busy && !chain.busy.value) chain.busy.value = busy;
  }
  return grantedItems(reserved, grant);
}

/** The lane signal of a recorded outcome, as housekeeping for its commit. */
export function signalsOf(rt: RuntimeContext, item: OutboxItem, performed: Performed): { signals?: LaneSignal[] } {
  const signal = rt.store.lanes ? laneSignal(item, performed) : null;
  if (!signal) return {};
  const paused = pausedRecord(item, signal);
  if (paused) laneRecord(rt, paused);
  return { signals: [signal] };
}

export function laneRecord(rt: RuntimeContext, record: LaneRecord): void {
  try {
    rt.observer.lane?.(record);
  } catch (error) {
    rt.observer.error?.(error, "lanes:observer");
  }
}

/**
 * Performs one run's claimed items. Nothing is sent unless the run still
 * waits for it: items of a run that is gone, ended or past that attempt are
 * dropped. An item leased more than `maxClaims` times is given up on.
 */
export async function workRun(rt: RuntimeContext, items: OutboxItem[]): Promise<void> {
  const { scope, runId } = items[0]!;
  const drop = async (dropped: OutboxItem[]) => {
    if (dropped.length === 0) return;
    await commitHousekeeping(rt, scope, runId, { outboxDone: dropped.map((i) => i.id) }).catch((error: unknown) => rt.observer.error?.(error, "work:action"));
  };
  let state: RunState;
  let flow: CompiledFlow;
  let revoked: boolean;
  try {
    ({ state, flow } = await load(rt, scope, runId));
    revoked = await isRevoked(rt, scope, state);
  } catch (error) {
    if (isNotFound(error)) return drop(items);
    // The flow (or the store) cannot be read. Nothing is sent, and nothing is given up on while
    // the run cannot be told: the items go back with their claims taken back, to try again a
    // lease later. One leased too often is given up on (and its run told) once the flow loads.
    rt.observer.error?.(error, "work:action");
    await release(rt, items, rt.clock.now() + rt.limits.leaseMs);
    return;
  }
  let live: ActionItem[] = [];
  const dead: OutboxItem[] = [];
  const stale: OutboxItem[] = [];
  const calls: CallItem[] = [];
  for (const item of items) {
    if (!awaits(state, item)) stale.push(item);
    else if (item.claims > rt.limits.maxClaims) dead.push(item);
    else if (isActionItem(item)) live.push(item);
    else calls.push(item as CallItem);
  }
  await drop(stale);
  for (const item of calls) await performCallItem(rt, item, newChain(rt)).catch((error: unknown) => rt.observer.error?.(error, "work:call"));
  if (revoked && live.some((item) => suppressed(state, item))) {
    // A revoked version starts nothing new. What it never sent is left to the run's move, which
    // starts it again under the version the run moves to (or ends the run); only a run that
    // cannot move yet records it as not done.
    const moved = await maybeMigrate(rt, scope, state, "system");
    if (moved) {
      ({ state, flow } = moved);
      const now = state;
      await drop(live.filter((item) => !awaits(now, item)));
      live = live.filter((item) => awaits(now, item));
      revoked = await isRevoked(rt, scope, state).catch(() => true);
    }
  }
  // What may already have happened is still followed up.
  const outcomes = live.map((item): Promise<Performed | null> => (revoked && suppressed(state, item) ? Promise.resolve({ outcome: REVOKED_OUTCOME, fromPort: false }) : execute(rt, item, flow, state)));
  for (let i = 0; i < live.length; i++) {
    const performed = await outcomes[i]!;
    // Not sent: the lease was lost, and whoever holds the row now sends and records it.
    if (performed !== null) await record(rt, live[i]!, performed, "work:action");
  }
  for (const item of dead) {
    // Leased again and again without an outcome: stop, and let the run treat it as unknown
    // (a write is then reconciled or flagged for attention, never blindly sent again). Until
    // that is recorded the row stays, and comes back after its lease.
    rt.observer.error?.(deadLetter(item), "work:dead-letter");
    if (!isActionItem(item)) {
      await deadCall(rt, item as CallItem);
      continue;
    }
    await record(rt, item, { outcome: deadOutcome(item), fromPort: false }, "work:dead-letter");
  }
}

/**
 * A call item leased again and again without being done. A start is given
 * up on (the caller's call fails, so its rules can answer); a cancel or a
 * return must arrive, so it is reported and performed again.
 */
export async function deadCall(rt: RuntimeContext, item: CallItem): Promise<void> {
  const effect = item.effect;
  try {
    if (effect.kind !== "call.start") {
      await performCallItem(rt, item, newChain(rt));
      return;
    }
    const applied = await apply(rt, item.scope, item.runId, {
      build: (state) => {
        const call = own(state.calls ?? {}, effect.callId);
        if (!call || call.status !== "starting" || call.attempt !== effect.attempt) return null;
        return { v: EVENT_VERSION, type: "call.started", id: rt.ids.newId(), at: rt.clock.now(), actor: CALL_ACTOR, callId: effect.callId, attempt: effect.attempt, outcome: { status: "final", error: { code: "flow/gave-up", message: "This could not be started." } } };
      },
      housekeeping: { outboxDone: [item.id] },
      chain: newChain(rt),
    });
    await afterSystem(rt, item.scope, applied);
  } catch (error) {
    if (!isNotFound(error)) rt.observer.error?.(error, "work:dead-letter");
  }
}

/** Records an outcome; the outbox row (and any lane signal) goes in the same commit. False when that failed. */
export async function record(rt: RuntimeContext, item: ActionItem, performed: Performed, where: string): Promise<boolean> {
  // Kept from other workers while it is recorded (if it was lost, the outcome is recorded all the same).
  await renew(rt, item);
  try {
    const applied = await recordOutcome(rt, item, performed, newChain(rt));
    await afterSystem(rt, item.scope, applied);
    return true;
  } catch (error) {
    if (!isNotFound(error)) rt.observer.error?.(error, where);
    return false;
  }
}

/**
 * Records the port's outcome for an item; the outbox row goes in the same
 * commit. An outside completion may have settled the attempt already (it
 * arrived before "pending" was recorded): the port's answer is then a
 * repeat or a stale one, and changes nothing. One that disagrees with that
 * completion is recorded as disputed, so neither outcome is lost and a
 * person checks the effect.
 */
export async function recordOutcome(rt: RuntimeContext, item: ActionItem, performed: Performed, chain: Chain): Promise<Applied> {
  const outcome = performed.outcome;
  // The lane signal is about the service's answer, so it rides along however the run takes it.
  const done: Housekeeping = { outboxDone: [item.id], ...signalsOf(rt, item, performed) };
  // A repeated "pending" for an attempt already waiting is not recorded, so it never moves the
  // attempt's timeout, whatever the run's format.
  const repeat = (state: RunState) => outcome.status === "pending" && own(state.inflight, item.effect.effectId)?.attempt === item.effect.attempt && own(state.inflight, item.effect.effectId)?.pending === true;
  const timed = performed.latencyMs !== undefined ? { latencyMs: performed.latencyMs } : {};
  const applied = await apply(rt, item.scope, item.runId, { build: (state) => (repeat(state) ? null : settled(rt, item, outcome, performed.windowMs)), housekeeping: done, chain, deferHousekeeping: true, ...timed });
  if (!applied.result?.accepted || applied.result.changed) return applied;
  const effect = item.effect;
  const first = claimOf(outcome, effect.effect) !== null ? await earlierCompletion(rt, item.scope, item.runId, effect.effectId, effect.attempt) : null;
  if (first === null || !disagree(first, outcome, effect.effect)) {
    await commitHousekeeping(rt, item.scope, item.runId, done);
    return applied;
  }
  rt.observer.error?.(new FlowError("conflict", `The action port answered ${outcome.status} for ${item.id} of run ${item.runId}, which a completion had settled as ${first.status}; the first stands and the effect needs attention.`), "action:disputed");
  return apply(rt, item.scope, item.runId, { build: () => ({ ...settled(rt, item, outcome), disputed: true }), housekeeping: done, chain, ...timed });
}

/**
 * Extends the lease on an item this runtime holds, from now. False when it
 * no longer holds it (the lease ran out, and the item may be another
 * owner's) or the store could not say.
 */
export async function renew(rt: RuntimeContext, item: OutboxItem): Promise<boolean> {
  if (item.leaseOwner === undefined || item.leaseUntil === undefined) return true;
  const until = rt.clock.now() + rt.limits.leaseMs;
  try {
    if (!(await rt.store.renewOutbox(item.scope, { id: item.id, owner: item.leaseOwner, until: item.leaseUntil }, until))) return false;
  } catch (error) {
    rt.observer.error?.(error, "lease");
    return false;
  }
  item.leaseUntil = until;
  return true;
}

/** Hands items this runtime holds back unsent: their claims taken back, claimable again from `availableAt`. */
export async function release(rt: RuntimeContext, items: OutboxItem[], availableAt: number): Promise<void> {
  for (const item of items) {
    if (item.leaseOwner === undefined || item.leaseUntil === undefined) continue;
    await rt.store.releaseOutbox(item.scope, { id: item.id, owner: item.leaseOwner, until: item.leaseUntil }, availableAt).catch((error: unknown) => rt.observer.error?.(error, "lease"));
  }
}

/** `windowMs`, the operation's completion window, is recorded only with a `pending` outcome. */
export function settled(rt: RuntimeContext, item: ActionItem, outcome: ActionOutcome, windowMs?: number): FlowEvent {
  const window = outcome.status === "pending" && windowMs !== undefined ? { windowMs } : {};
  return { v: EVENT_VERSION, type: "action.settled", id: rt.ids.newId(), at: rt.clock.now(), actor: SYSTEM_ACTOR, effectId: item.effect.effectId, attempt: item.effect.attempt, outcome, ...window };
}

/**
 * Runs one outbox item through the action port. Never throws. `state` is
 * the run as loaded by a worker, for rows written before dispatch details
 * were recorded with them. Null when nothing was sent because the item's
 * lease was lost (another owner may hold it): there is nothing to record.
 */
export async function execute(rt: RuntimeContext, item: ActionItem, flow: CompiledFlow, state?: RunState): Promise<Performed | null> {
  const effect = item.effect;
  if (item.claims > 1 && effect.effect === "write" && !effect.idempotent) {
    // An earlier attempt was interrupted mid-call; sending again could apply it twice.
    return { outcome: { status: "unknown", error: { code: "flow/interrupted", message: "An earlier attempt was interrupted." } }, fromPort: false };
  }
  // A run that is ending sends no write nobody has sent (ADR-0009, amended).
  if (withdrawsOnEnd(state, item)) return { outcome: withdrawnOutcome("final"), fromPort: false };
  const dispatch = item.context.dispatch ?? (state ? dispatchFor(state, SYSTEM_ACTOR, effect) : { revision: 0, actor: null });
  const revision = item.context.dispatch?.revision;
  // The input must be what the action accepts, and a review must still be current: otherwise nothing is sent.
  const refused = refuseBeforeSending(flow, effect, dispatch, rt.clock.now());
  if (refused) return { outcome: refused, fromPort: false };
  const admitted = await Promise.resolve()
    .then(() =>
      rt.admission.admit({
        scope: item.scope,
        op: "action",
        flowId: flow.id,
        ...(item.context.subjectId ? { actorId: item.context.subjectId } : {}),
        action: admissionAction(flow, state, item.runId, effect),
      }),
    )
    .catch((error: unknown): Admission => {
      // Fail closed: an action is delayed, never run unchecked, when admission cannot answer.
      rt.observer.error?.(error, "admission");
      return { ok: false, code: "flow/admission-unavailable" };
    });
  if (!admitted.ok) {
    // Deferred: handed back unsent, with no attempt spent and nothing recorded, within its bound.
    if (admitted.defer === true && (await deferAction(rt, item, revision, admitted.retryAfterMs))) return null;
    const outcome: ActionOutcome = { status: "retryable", error: { code: admitted.code, message: "Rate limited." }, ...(admitted.retryAfterMs !== undefined ? { retryAfterMs: admitted.retryAfterMs } : {}) };
    return { outcome, fromPort: false };
  }
  // An envelope version the port serves; with none in common nothing is sent, and it waits like a deferral.
  const contract = await rt.contracts.version();
  if (contract === null) return (await deferAction(rt, item, revision, CONTRACT_UNSUPPORTED_RETRY_MS)) ? null : { outcome: noCommonContract(), fromPort: false };
  // The lease is renewed just before sending, so it outlasts the call's timeout, measured from here.
  if (!(await renew(rt, item))) return null;
  const sentAt = rt.clock.now();
  const answer = await call(rt, item, flow, dispatch, admitted, contract);
  const latencyMs = rt.clock.now() - sentAt;
  const outcome = answerAfterMaybeApplied(answer, dispatch, effect.effect === "write");
  rt.contracts.answered(outcome);
  // Refused for its version, before the performer did anything: it waits like a deferral, as the same attempt.
  if (refusedForVersion(outcome) && (await deferAction(rt, item, revision, outcome.retryAfterMs))) return null;
  const windowMs = outcome.status === "pending" ? completionWindowFor(flow, effect, rt.operations) : undefined;
  return { outcome, fromPort: true, latencyMs, ...(windowMs !== undefined ? { windowMs } : {}) };
}

/**
 * Hands a deferred item back to the outbox, to be claimed again when
 * `deferUntil` says. False when the deferral is past `limits.maxDeferMs`
 * from the dispatch of the effect's first attempt, or that time cannot be
 * read: the caller then records the refusal as any other. `revision` is the
 * attempt's own dispatch revision, when its row records one.
 */
export async function deferAction(rt: RuntimeContext, item: ActionItem, revision: number | undefined, retryAfterMs: unknown): Promise<boolean> {
  if (rt.limits.maxDeferMs === 0) return false;
  let since: number | null;
  try {
    since = await deferralSince({
      store: rt.store,
      scope: item.scope,
      runId: item.runId,
      effect: item.effect,
      revision,
      resolve: (flowId, version) => rt.catalog.get(item.scope, flowId, version),
      kept: rt.firstDispatches,
    });
  } catch (error) {
    rt.observer.error?.(error, "admission");
    return false;
  }
  if (since === null) return false;
  const until = deferUntil({ now: rt.clock.now(), since, retryAfterMs, maxDeferMs: rt.limits.maxDeferMs });
  if (until === null) return false;
  await release(rt, [item], until);
  return true;
}

/** The action port call itself, cut off at the effect's timeout. Never throws. */
export async function call(rt: RuntimeContext, item: ActionItem, flow: CompiledFlow, dispatch: ActionDispatch, admitted: Extract<Admission, { ok: true }>, contract: ContractVersion): Promise<ActionOutcome> {
  const effect = item.effect;
  rt.unseen.check(item.scope, flow);
  const timeoutMs = Math.max(1, Math.min(effect.timeoutMs, rt.limits.leaseMs - 1000, MAX_ACTION_TIMEOUT_MS));
  const controller = new AbortController();
  const issuedAt = rt.clock.now();
  const deadline = issuedAt + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The approved action: what to do, under which review, and how to complete it later.
    const unsigned = buildApprovedAction({
      flow,
      audience: rt.envelopes?.audience ?? UNSIGNED_AUDIENCE,
      issuedAt,
      scope: item.scope,
      environment: item.context.environment,
      runId: item.runId,
      subjectId: item.context.subjectId,
      effect,
      dispatch,
      idempotencyKey: rt.keys.idempotencyKey({ scope: item.scope, ...(effect.connection !== undefined ? { connection: effect.connection } : {}), action: effect.action, effectId: effect.effectId }),
      completionToken: completionToken(rt.keys, { scope: item.scope, runId: item.runId, effectId: effect.effectId, attempt: effect.attempt }),
      timeoutMs,
      deadline,
      ...(policyVersion(admitted.policy) ? { policy: { version: admitted.policy!.version } } : {}),
      ...(rt.operations ? { operations: rt.operations } : {}),
      contract,
    });
    const approved = rt.envelopes ? await sign(rt, unsigned, rt.envelopes, deadline, effect.action) : { ...unsigned, proof: { ...UNSIGNED_PROOF } };
    // Nothing was sent: the next attempt is signed afresh.
    if (!approved) return { status: "retryable", error: { code: "flow/sign-failed", message: "The action could not be prepared. It will be tried again." } };
    const call = rt.actions.run(approved, controller.signal);
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, deadline - rt.clock.now()));
    });
    const raced = await Promise.race([call, timeout]);
    if (raced === "timeout") {
      controller.abort();
      reportLateBlobs(call, item.scope, approved.input, (error) => rt.observer.error?.(error, "blob-late"));
      return effect.effect === "read" ? { status: "retryable", error: { code: "flow/timeout", message: "No answer in time." } } : { status: "unknown", error: { code: "flow/timeout", message: "No answer in time." } };
    }
    return guardBlobOutcome(normalizeOutcome(raced, effect.effect), effect.effect, item.scope);
  } catch (error) {
    rt.observer.error?.(error, `action:${effect.action}`);
    return effect.effect === "read" ? { status: "retryable", error: { code: "flow/action-error", message: "The service had a problem." } } : { status: "unknown", error: { code: "flow/action-error", message: "The service had a problem." } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Signs an envelope with the host's signer, before its deadline. Null, with
 * the error reported, when the signer throws, answers a malformed proof or
 * is still signing at the deadline. Never throws. A synchronous signer is
 * not awaited.
 */
export async function sign(rt: RuntimeContext, unsigned: Omit<ApprovedAction, "proof">, envelopes: EnvelopeSigning, deadline: number, action: string): Promise<ApprovedAction | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { bytes, context } = signingInput(unsigned);
    let proof: unknown = envelopes.signer.sign(bytes, context);
    if (proof instanceof Promise) {
      const late = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(1, deadline - rt.clock.now()));
      });
      proof = await Promise.race([proof, late]);
      if (proof === "timeout") throw new Error("the envelope signer did not answer before the deadline");
    }
    const sealed = attachProof(unsigned, proof);
    if (!sealed) throw new Error("the envelope signer answered a malformed proof");
    return sealed;
  } catch (error) {
    rt.observer.error?.(error, `sign:${action}`);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether the run still waits for this outbox item. Anything else (a run that
 * ended, a dropped read, an older attempt) would be sent for nothing.
 */
export function awaits(state: RunState, item: OutboxItem): boolean {
  const effect = item.effect;
  switch (effect.kind) {
    case "action": {
      const inflight = own(state.inflight, effect.effectId);
      return inflight !== undefined && inflight.attempt === effect.attempt && !inflight.waiting;
    }
    case "call.start": {
      const call = own(state.calls ?? {}, effect.callId);
      return call !== undefined && call.status === "starting" && call.attempt === effect.attempt;
    }
    default:
      // A cancel or a return must arrive; the run it goes to ignores a repeat.
      return true;
  }
}

/**
 * Whether a revoked version's run skips this item: anything new it would
 * start. A write that may already have been applied (an earlier attempt's
 * outcome was unknown, or this item was claimed before) is still followed
 * up, as are compensations and checks.
 */
export function suppressed(state: RunState, item: ActionItem): boolean {
  const effect = item.effect;
  if (effect.purpose !== "run") return false;
  if (effect.effect === "read") return true;
  const result = own(state.results, keyOf(effect.name, effect.item));
  return item.claims <= 1 && !(result?.effectId === effect.effectId && result.maybeApplied === true);
}

export function deadLetter(item: OutboxItem): FlowError {
  const what = item.effect.kind === "action" ? item.effect.action : item.effect.kind;
  return new FlowError("unavailable", `Gave up on outbox item ${item.id} (${what}) of run ${item.runId} after ${item.claims} leases without an outcome.`);
}

/**
 * What an outcome says happened: done (with its output), not done, or
 * nothing (`unknown`, `pending`, or a read's `retryable`, which is also how
 * the runtime reports a read that timed out).
 */
export function claimOf(outcome: ActionOutcome, effect: ActionEffect["effect"]): { done: true; output: JsonValue } | { done: false } | null {
  switch (outcome.status) {
    case "ok":
      return { done: true, output: outcome.output };
    case "final":
      return { done: false };
    case "retryable":
      return effect === "write" ? { done: false } : null;
    default:
      return null;
  }
}

/** Two outcomes for one attempt disagree when both say what happened and say different things. */
export function disagree(first: ActionOutcome, second: ActionOutcome, effect: ActionEffect["effect"]): boolean {
  const a = claimOf(first, effect);
  const b = claimOf(second, effect);
  if (a === null || b === null) return false;
  if (!a.done || !b.done) return a.done !== b.done;
  return canonicalJson(a.output) !== canonicalJson(b.output);
}

export function deadOutcome(item: ActionItem): ActionOutcome {
  const error = { code: "flow/gave-up", message: "This could not be completed." };
  return item.effect.effect === "write" ? { status: "unknown", error } : { status: "final", error };
}

/** Claimed work grouped by run, so one run's items can be taken in order. */
export function groupByRun<T extends { scope: Scope; runId: string }>(items: readonly T[]): Map<string, T[]> {
  const byRun = new Map<string, T[]>();
  for (const item of items) {
    const key = `${scopeKey(item.scope)}|${item.runId}`;
    byRun.set(key, [...(byRun.get(key) ?? []), item]);
  }
  return byRun;
}
