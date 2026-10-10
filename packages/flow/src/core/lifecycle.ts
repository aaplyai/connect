/**
 * The core machine's run lifecycle: resuming, cancelling, erasing,
 * revoking and moving a run to another version; timers and outside events
 * and the waits and timers they answer. Functions over `this`, installed on
 * Machine.
 */

import { keyOf, parseKey } from "../address.js";
import type { CompiledStep } from "../compile.js";
import { checkCarriedFields } from "../core-items-stale.js";
import { truthy } from "../expr-eval.js";
import { fingerprint, safeEqual } from "../hash.js";
import { own, type JsonObject } from "../json.js";
import { liveItems, liveItem } from "../items.js";
import { confirmDigest } from "../reader.js";
import { type RunRevokedEvent, type TimerFiredEvent, type ActionOutcome, type ActionSettledEvent, EVENT_VERSION, type ExternalEvent } from "../state.js";
import { type Machine, reject, MAX_UPDATE_MESSAGE, type MoveInput, type StepAccepted } from "../core.js";

export function resume(this: Machine): void {
  delete this.state.lapsed;
}

export function onCancel(this: Machine, reason: string, cascade?: string): void {
  const actor = this.event.actor;
  const problem = this.cancelProblem(actor);
  if (problem) reject(problem[0], problem[1]);
  // The child must go first: the runtime routes the cancellation to the deepest run (cancelTree).
  if (this.callRunning()) reject("flow/call-running", "Something this is waiting for must be cancelled first.");
  if (cascade !== undefined && (actor.kind !== "system" || typeof cascade !== "string" || cascade.length === 0 || cascade.length > 256)) {
    reject("flow/forbidden", "Only the runtime can cancel a chain of runs.");
  }
  this.beginEnd("cancelled", reason, cascade !== undefined && cascade !== this.state.runId ? cascade : undefined);
}

/**
 * The person's data is being erased: the run ends whatever it committed,
 * so nothing it holds is left behind with nobody to release it. What it
 * committed stays done (a committed run ends `expired`, as a committed
 * child does when its caller ends); every other hold is released, and live
 * calls are cancelled through the usual path, each child releasing its own.
 */
export function onErase(this: Machine, erase: unknown): void {
  if (this.event.actor.kind !== "system" || erase !== true) reject("flow/forbidden", "Only the engine erases a run.");
  this.beginEnd(this.isCommitted() ? "expired" : "cancelled", "erasure");
}

/**
 * The run's version was withdrawn and the runtime could not move the run.
 * It ends `failed` with reason `revoked`; an end waits for a commit in
 * flight, and holds are released by the definition that took them. A run
 * that already moved or ended is not affected, so repeated sweeps are safe.
 */
export function onRevoked(this: Machine, ev: RunRevokedEvent): boolean {
  const s = this.state;
  if (ev.actor.kind !== "system") reject("flow/forbidden", "Only the engine ends a run whose version was withdrawn.");
  if (ev.message !== undefined && (typeof ev.message !== "string" || ev.message.length > MAX_UPDATE_MESSAGE)) reject("flow/invalid-event", "The message is too long.");
  // An end already under way (waiting for a commit to settle) stands: a repeat, or a revocation after another end, changes nothing.
  if (ev.version !== s.flowVersion || ev.hash !== s.flowHash || s.status !== "active" || s.pendingEnd !== undefined) return false;
  s.update = { kind: "revoked", from: s.flowVersion, at: this.now, facts: [], ...(ev.message !== undefined ? { message: ev.message } : {}) };
  this.note("flow/version-revoked", ev.message ?? "This is no longer available.");
  this.beginEnd("failed", "revoked");
  return true;
}

// --- moves between versions --------------------------------------------------

/** See {@link settleMove}. */
export function moved(this: Machine, move: MoveInput): StepAccepted {
  const s = this.state;
  for (const timerId of move.cancelTimers) this.cancelTimer(timerId);
  for (const [timerId, dueAt] of move.rearm) this.setTimer(timerId, dueAt);
  // Every step gets a new view instance (a per-item step, one per item); nothing bumps one twice.
  for (const st of this.flow.steps) {
    for (const key of st.forEach === undefined ? [st.id] : liveItems(s, st.forEach).map((id) => keyOf(st.id, id))) {
      const was = own(s.epochs, key) ?? 0;
      s.epochs[key] = was + 1;
      this.bumped.add(key);
      // The step's ended call still answers for it under the new epoch, as a carried failed result
      // does for a write: the step waits for the person's retry, and a move never starts a child by itself.
      const latest = st.call ? this.latestCall(st.id) : undefined;
      if (latest && latest[1].status === "ended" && latest[1].epoch === was) s.calls![latest[0]] = { ...latest[1], epoch: was + 1 };
    }
  }
  for (const name of move.changed) this.changed.add(name);
  this.settleFacts();
  // Cross-field checks see every carried value, under the new rules.
  for (const name of move.check) {
    const fact = this.flow.facts.get(name);
    const current = own(s.facts, name);
    if (!fact || !current || (current.status !== "valid" && current.status !== "needs_confirmation")) continue;
    const issues = [];
    for (const check of fact.checks) {
      const r = this.eval(check.test, { value: current.value ?? null });
      if (r.known && !truthy(r.value)) issues.push({ code: check.code, message: check.message, path: "" });
    }
    if (issues.length > 0) this.putFact(name, { ...current, status: "invalid", issues, rev: this.rev });
  }
  if (this.flow.collections.size > 0) checkCarriedFields(this, move.check);
  this.settleFacts();
  // A carried failed write stands for what the target's action would send now, so its step waits
  // for the person's retry: a move never sends a write again by itself, whatever it changed.
  for (const [key, res] of Object.entries(s.results)) {
    const at = res.status === "failed" ? parseKey(key) : null;
    const action = at ? this.flow.actions.get(at.name) : undefined;
    if (!action || action.def.effect !== "write") continue;
    const input = this.currentInput(action, at!.item);
    if (input.known) s.results[key] = { ...res, fingerprint: fingerprint(input.value) };
  }
  // A confirmation covers one action and its exact input: a changed action, or any change to
  // what it would send, cancels it. A per-item action's (`name[item]`) covers its item's input.
  for (const [name, conf] of Object.entries(s.confirmations)) {
    const at = parseKey(name);
    const action = at ? this.flow.actions.get(at.name) : undefined;
    const item = at?.item;
    const live = item === undefined ? action?.forEach === undefined : action?.forEach !== undefined && liveItem(s, action.forEach, item) !== undefined;
    const input = action && live && move.sameAction(action.name) ? this.currentInput(action, item) : null;
    if (!input || !input.known || !safeEqual(confirmDigest(name, input.value as JsonObject, s.nonce), conf.digest)) {
      delete s.confirmations[name];
      continue;
    }
    // An approval is checked again against what the target's action reads: the same input may now
    // come from facts its approver gave, and an approver never approves what they supplied.
    if (action!.risk === "approval" && this.suppliedInput(action!, item, conf.by)) {
      delete s.confirmations[name];
      continue;
    }
    // It keeps the time it was given: the target's time to live counts from then, and a move never
    // extends a review. One recorded without its time cannot be measured, so it is asked again.
    const ttl = action!.reviewTtlMs;
    if (ttl === undefined) continue;
    if (conf.at === undefined) delete s.confirmations[name];
    else if (conf.notAfter === undefined || conf.at + ttl < conf.notAfter) s.confirmations[name] = { ...conf, notAfter: conf.at + ttl };
  }
  this.note(move.notice.code, move.notice.message, move.notice.facts);
  this.advance();
  return this.finish(move.before);
}

export function onTimer(this: Machine, ev: TimerFiredEvent): boolean {
  const s = this.state;
  if (own(s.timers, ev.timerId) !== ev.generation) return false;
  delete s.timers[ev.timerId];
  const [kind, ...rest] = ev.timerId.split(":");
  const target = rest.join(":");
  switch (kind) {
    case "lifetime":
    case "idle":
      if (s.status !== "active") return true;
      // While a child runs, the person is there (the child has its own idle limit).
      if (kind === "idle" && this.callLive()) {
        this.setTimer("idle", ev.at + this.flow.limits.idleTimeoutMs);
        return true;
      }
      if (!this.commitBusy()) this.note("flow/expired", "This has expired.");
      this.beginEnd("expired", kind);
      return true;
    case "retry":
      if (s.calls && own(s.calls, target)) return this.resendCall(target);
      return this.resend(target);
    case "call":
      return this.onCallTimeout(target);
    case "timeout": {
      // A pending effect that never reported back: its outcome is unknown.
      const inflight = own(s.inflight, target);
      const action = inflight ? this.flow.actions.get(inflight.action) : undefined;
      if (!inflight || !action || inflight.waiting || !inflight.pending) return true;
      const outcome: ActionOutcome = { status: "unknown", error: { code: "flow/timeout", message: "No answer in time." } };
      if (inflight.purpose === "run") {
        const res = own(s.results, keyOf(action.name, inflight.item));
        if (!res || res.effectId !== target) {
          // A superseded read; nobody is waiting for it any more.
          delete s.inflight[target];
          return true;
        }
        this.settleRun(action, target, inflight.attempt, outcome);
        return true;
      }
      const settled: ActionSettledEvent = { v: EVENT_VERSION, id: ev.id, at: ev.at, actor: ev.actor, type: "action.settled", effectId: target, attempt: inflight.attempt, outcome };
      return inflight.purpose === "compensate" ? this.settleCompensation(settled, action, inflight.target ?? "") : this.settleReconcile(settled, action, inflight.target ?? "");
    }
    case "hold": {
      // Expiry itself happens in advance(), once nothing in flight still relies on the hold.
      const resource = own(s.resources, target);
      if (resource && resource.status === "held") resource.expiresAt = Math.min(resource.expiresAt ?? this.now, this.now);
      return true;
    }
    case "wait": {
      const step = this.flow.stepById.get(target);
      if (!step || !own(s.waits, target)) return true;
      this.closeWait(target);
      if (s.status !== "active") return true;
      const rule = step.rules.get("timeout");
      if (rule) this.systemRule(step, rule, null);
      else this.beginEnd("failed", "wait-timeout");
      return true;
    }
    default:
      return true;
  }
}

/** Sends a waiting effect again with the next attempt number and the same effect id. */
export function resend(this: Machine, effectId: string): boolean {
  const s = this.state;
  const inflight = own(s.inflight, effectId);
  if (!inflight || !inflight.waiting) return true;
  const action = this.flow.actions.get(inflight.action);
  if (!action) return true;
  const attempt = inflight.attempt + 1;
  if (inflight.purpose === "run") {
    const key = keyOf(action.name, inflight.item);
    const res = own(s.results, key);
    if (!res || res.effectId !== effectId) {
      delete s.inflight[effectId];
      return true;
    }
    if (s.status !== "active" && action.def.effect === "write" && !res.maybeApplied) {
      // The run is ending and nothing was applied: do not send it again.
      delete s.inflight[effectId];
      delete s.results[key];
      return true;
    }
    res.status = "inflight";
    res.attempt = attempt;
    res.rev = this.rev;
    this.startEffect("run", action, res.input, attempt, effectId, undefined, inflight.item);
    return true;
  }
  if (inflight.purpose === "compensate") {
    const resource = own(s.resources, inflight.target ?? "");
    if (!resource || resource.releaseEffectId !== effectId) {
      delete s.inflight[effectId];
      return true;
    }
    this.startEffect("compensate", action, this.frozenInput(action.compensate!.input, { input: resource.input, output: resource.output }), attempt, effectId, inflight.target, resource.item);
    return true;
  }
  const item = own(s.inflight, inflight.target ?? "")?.item;
  const res = own(s.results, keyOf(action.name, item));
  if (!res || res.effectId !== inflight.target) {
    delete s.inflight[effectId];
    return true;
  }
  this.startEffect("reconcile", action, this.frozenInput(action.reconcile!.input, { input: res.input }), attempt, effectId, inflight.target, item);
  return true;
}

export function onExternal(this: Machine, ev: ExternalEvent): boolean {
  const s = this.state;
  if (s.status !== "active") return false;
  const match = Object.entries(s.waits).find(([, w]) => w.event === ev.event && w.key === ev.key);
  if (!match) return false;
  const step = this.flow.stepById.get(match[0]);
  const rule = step?.rules.get(ev.event);
  if (!step || !rule) return false;
  const accept = step.wait?.accept;
  if (accept) {
    // Events the step does not accept are ignored and the wait stays open.
    const ok = this.eval(accept, { payload: ev.payload });
    if (!ok.known || !truthy(ok.value)) return false;
  }
  this.closeWait(step.id);
  // The sender is told when the rule refuses the event, so it can fix it and deliver again;
  // the run keeps waiting.
  this.applyRule(step, rule, ev.payload, "external");
  return true;
}

// --- waits, timers, ids, notices ---------------------------------------------

export function openWait(this: Machine, step: CompiledStep, key: string): void {
  const event = step.wait!.event;
  this.state.waits[step.id] = { event, key };
  this.effects.push({ kind: "wait.open", stepId: step.id, event, key });
  if (step.wait!.timeoutMs !== undefined) this.setTimer(`wait:${step.id}`, this.now + step.wait!.timeoutMs);
}

export function closeWait(this: Machine, stepId: string): void {
  const wait = own(this.state.waits, stepId);
  if (!wait) return;
  delete this.state.waits[stepId];
  this.effects.push({ kind: "wait.close", stepId, event: wait.event, key: wait.key });
  this.cancelTimer(`wait:${stepId}`);
}

export function setTimer(this: Machine, timerId: string, dueAt: number): void {
  const generation = ++this.state.effectSeq;
  this.state.timers[timerId] = generation;
  this.effects.push({ kind: "timer", timerId, generation, dueAt });
}

export function cancelTimer(this: Machine, timerId: string): void {
  if (own(this.state.timers, timerId) === undefined) return;
  delete this.state.timers[timerId];
  this.effects.push({ kind: "timer.cancel", timerId });
}
