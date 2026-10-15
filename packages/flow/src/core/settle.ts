/**
 * The core machine's handling of action outcomes: settling, retrying,
 * reconciling and compensating effects, and late or disputed results.
 * Functions over `this`, installed on Machine.
 */

import { keyOf, nameOfKey, itemOfKey } from "../address.js";
import { type CompiledAction, actionNode } from "../compile.js";
import { fingerprint } from "../hash.js";
import { own, jsonEqual, type JsonValue, cloneJson, formatPath, type JsonObject } from "../json.js";
import { publicError } from "../reader.js";
import { validateValue } from "../schema.js";
import type { ActionSettledEvent, ActionError, ActionOutcome, ResourceState, EffectResolvedEvent } from "../state.js";
import { type Machine, reject, windowOf, backoff } from "../core.js";
import { unsentError } from "./advance.js";

// --- system events ---------------------------------------------------------

export function onSettled(this: Machine, ev: ActionSettledEvent): boolean {
  const s = this.state;
  if (ev.disputed !== undefined) return this.onDisputed(ev);
  if (ev.late !== undefined) return this.onLate(ev);
  const inflight = own(s.inflight, ev.effectId);
  if (!inflight || inflight.attempt !== ev.attempt) return false;
  // Outside callers may complete an attempt that was sent and has not answered (its completion
  // can arrive before the port's own "pending" is recorded), or one that answered "pending";
  // not one that answered otherwise and now waits to be sent again or reconciled.
  if (ev.actor.kind !== "system" && inflight.waiting && !inflight.pending) reject("flow/not-pending", "Only an action that is waiting for its result can be completed.");
  // ...with its result: saying "still pending" again would keep it alive past its timeout.
  if (ev.actor.kind !== "system" && ev.outcome.status === "pending") reject("flow/not-pending", "Complete the action with its result.");
  // A repeated "pending" (an attempt claimed again, say) changes nothing: the attempt's timeout runs
  // from the first, so a performer cannot postpone it forever.
  if (ev.outcome.status === "pending" && inflight.pending === true) return false;
  const action = this.flow.actions.get(inflight.action);
  if (!action) return false;
  if (inflight.waiting) {
    // The original answer to a write being reconciled arrived late: it settles the question.
    const res = own(s.results, keyOf(action.name, inflight.item));
    if (inflight.purpose !== "run" || ev.outcome.status !== "ok" || res?.effectId !== ev.effectId || res.status !== "reconciling") return false;
    this.dropReconcile(ev.effectId);
    s.inflight[ev.effectId] = { ...inflight, waiting: false };
    this.settleRun(action, ev.effectId, ev.attempt, ev.outcome);
    return true;
  }
  if (inflight.purpose === "compensate") return this.settleCompensation(ev, action, inflight.target ?? "");
  if (inflight.purpose === "reconcile") return this.settleReconcile(ev, action, inflight.target ?? "");
  const res = own(s.results, keyOf(action.name, inflight.item));
  if (!res || res.effectId !== ev.effectId) {
    // A superseded read; its result is no longer wanted.
    delete s.inflight[ev.effectId];
    return true;
  }
  this.settleRun(action, ev.effectId, ev.attempt, ev.outcome, windowOf(ev));
  return true;
}

/**
 * The port answered an attempt that an outside completion had already
 * settled, and disagrees with it (the runtime compares them). The first
 * outcome stands; this one stays in the log, and a person must check the
 * effect, as one in doubt (`attention`, cleared by `effect.resolved`).
 */
export function onDisputed(this: Machine, ev: ActionSettledEvent): boolean {
  const s = this.state;
  if (ev.actor.kind !== "system" || ev.disputed !== true) reject("flow/forbidden", "Only the engine records a disputed outcome.");
  if (s.attention.includes(ev.effectId)) return false;
  s.attention.push(ev.effectId);
  const key = Object.entries(s.results).find(([, r]) => r.effectId === ev.effectId)?.[0];
  this.note("flow/outcome-disputed", "Two different answers came back for something done for you. Someone will check.", undefined, key !== undefined ? nameOfKey(key) : undefined);
  return true;
}

/**
 * A completion that arrived after the engine put its effect in doubt (its
 * pending timed out): the performer's token-bound report of what happened
 * (an optional event field). A report that says what
 * happened settles the effect as staff would (`effect.resolved`): `ok`,
 * for any attempt of it, applied it; `final` or `retryable` for its last
 * attempt did not, when no earlier attempt may have applied it before (the
 * first attempt, or a write that does not de-duplicate, which is only sent
 * again once known not applied). Any other report is kept on the effect,
 * which stays in doubt for staff. An undo is settled only by `ok`.
 */
export function onLate(this: Machine, ev: ActionSettledEvent): boolean {
  const s = this.state;
  if (ev.actor.kind === "system" || ev.late !== true) reject("flow/forbidden", "Only a completion from outside arrives late.");
  if (ev.outcome.status === "pending") reject("flow/not-pending", "Complete the action with its result.");
  if (!s.attention.includes(ev.effectId)) return false;
  const outcome = ev.outcome;
  const settles = (alone: boolean) => outcome.status === "ok" || ((outcome.status === "final" || outcome.status === "retryable") && alone);
  for (const [key, res] of Object.entries(s.results)) {
    if (res.effectId !== ev.effectId || res.status !== "in_doubt" || ev.attempt > res.attempt) continue;
    const name = nameOfKey(key);
    const action = this.flow.actions.get(name)!;
    if (!settles(ev.attempt === res.attempt && (ev.attempt === 1 || !action.idempotent))) return this.lateReport(res, "error" in outcome ? outcome.error : undefined, name);
    s.attention = s.attention.filter((id) => id !== ev.effectId);
    const item = action.forEach !== undefined ? itemOfKey(key) : undefined;
    s.inflight[ev.effectId] = { purpose: "run", action: name, attempt: res.attempt, waiting: false, ...(item !== undefined ? { item } : {}) };
    if (outcome.status === "ok") this.settleRun(action, ev.effectId, res.attempt, outcome);
    else this.failResult(action, ev.effectId, "error" in outcome ? outcome.error : { code: "flow/not-applied", message: "It did not go through. You can try again." });
    return true;
  }
  for (const resource of Object.values(s.resources)) {
    if (resource.releaseEffectId !== ev.effectId || resource.status !== "in_doubt") continue;
    // Only "it was undone" settles an undo: sending it again on a "not undone" could undo twice
    // (an earlier attempt may have gone through), so that is kept for staff.
    if (outcome.status !== "ok") return this.lateReport(resource, "error" in outcome ? outcome.error : undefined, resource.action);
    s.attention = s.attention.filter((id) => id !== ev.effectId);
    delete resource.error;
    resource.status = "released";
    resource.rev = this.rev;
    return true;
  }
  return false;
}

/** A late report that does not settle its effect: kept on it for staff (a repeat changes nothing). */
export function lateReport(this: Machine, target: { error?: ActionError; rev: number }, error: ActionError | undefined, action: string): boolean {
  if (error === undefined || (target.error !== undefined && jsonEqual(target.error as unknown as JsonValue, error as unknown as JsonValue))) return false;
  target.error = { ...error };
  target.rev = this.rev;
  this.note("flow/late-report", "A late report came in for something that could not be confirmed. Someone will check.", undefined, action);
  return true;
}

/** `windowMs`: how long a `pending` answer is waited for, when its operation declares a completion window. */
export function settleRun(this: Machine, action: CompiledAction, effectId: string, attempt: number, outcome: ActionOutcome, windowMs?: number): void {
  const s = this.state;
  // A per-item action's result is keyed by its item (`name[item]`).
  const item = own(s.inflight, effectId)?.item;
  const key = keyOf(action.name, item);
  const res = s.results[key]!;
  const isWrite = action.def.effect === "write";
  this.cancelTimer(`timeout:${effectId}`);
  switch (outcome.status) {
    case "ok": {
      if (outcome.withheld !== undefined) {
        // The output was too large to keep (an optional outcome field).
        const error = { code: isWrite ? "flow/output-withheld" : "flow/output-too-large", message: isWrite ? "It went through, but its result was too large to keep." : "The answer was too large to use.", detail: `${outcome.withheld.bytes} bytes` };
        if (!isWrite) return this.failResult(action, effectId, error);
        // Applied, but without its output nothing can use or undo it safely.
        if (action.compensate || action.def.outputSchema) return this.markInDoubt(action, effectId, error);
        this.note("flow/output-withheld", `${action.name} went through, but its result was too large to keep.`, undefined, action.name);
      }
      const output = cloneJson(outcome.output);
      if (action.def.outputSchema) {
        const issues = validateValue(action.def.outputSchema, output);
        if (issues.length > 0) {
          // The path names the service's own fields, so it is staff detail.
          const detail = `unexpected output at ${formatPath(issues[0]!.path)}: ${issues[0]!.message}`;
          if (!isWrite) {
            this.failResult(action, effectId, { code: "flow/bad-output", message: "The service answered in a way this cannot use.", detail });
            return;
          }
          // The write happened; keep it so it can be undone, but flag it.
          this.note("flow/bad-output", `${action.name} returned an unexpected output.`, undefined, action.name);
        }
      }
      delete s.inflight[effectId];
      s.results[key] = { ...res, status: "ok", output, rev: this.rev };
      delete s.results[key]!.error;
      delete s.results[key]!.maybeApplied;
      const outFp = fingerprint(output);
      const previous = own(s.outputs, key);
      s.outputs[key] = outFp;
      if (previous !== undefined && previous !== outFp) this.invalidateFrom(actionNode(action.name), item);
      if (isWrite && action.compensate) {
        const resource: ResourceState = { action: action.name, status: "held", fingerprint: res.fingerprint, input: res.input, output, rev: this.rev, heldAt: this.now };
        if (res.causedBy !== undefined) resource.causedBy = res.causedBy;
        if (res.traceparent !== undefined) resource.traceparent = res.traceparent;
        if (item !== undefined) resource.item = item;
        if (action.holdTtlMs !== undefined) {
          resource.expiresAt = this.now + action.holdTtlMs;
          this.setTimer(`hold:${effectId}`, resource.expiresAt);
        }
        s.resources[effectId] = resource;
      }
      if (action.commitPoint) this.commitHolds(item);
      return;
    }
    case "pending": {
      res.status = "pending";
      res.rev = this.rev;
      s.inflight[effectId] = { ...s.inflight[effectId]!, pending: true };
      this.setTimer(`timeout:${effectId}`, this.now + (windowMs ?? action.call.timeoutMs));
      return;
    }
    case "retryable":
      this.retryOrFail(action, effectId, attempt, outcome.error, outcome.retryAfterMs);
      return;
    case "final":
      this.failResult(action, effectId, outcome.error);
      return;
    case "unknown": {
      if (isWrite) res.maybeApplied = true;
      // Reads, and writes the backend de-duplicates, are safe to send again.
      if (!isWrite || action.idempotent) {
        this.retryOrFail(action, effectId, attempt, outcome.error);
        return;
      }
      this.reconcileOrDoubt(action, effectId, outcome.error);
      return;
    }
  }
}

/** A write that may have been applied: ask the backend, or a person when it cannot be asked. */
export function reconcileOrDoubt(this: Machine, action: CompiledAction, effectId: string, error: ActionError): void {
  const s = this.state;
  const item = own(s.inflight, effectId)?.item;
  const res = s.results[keyOf(action.name, item)]!;
  const input = action.reconcile ? this.frozenInput(action.reconcile.input, { input: res.input }) : null;
  if (input && !input.known) {
    this.markInDoubt(action, effectId, unsentError(input));
    return;
  }
  if (action.reconcile && input) {
    res.status = "reconciling";
    res.error = error;
    res.rev = this.rev;
    s.inflight[effectId] = { ...s.inflight[effectId]!, waiting: true };
    this.startEffect("reconcile", action, input.value as JsonObject, 1, undefined, effectId, item);
    return;
  }
  this.markInDoubt(action, effectId, error);
}

export function dropReconcile(this: Machine, originalId: string): void {
  const s = this.state;
  for (const [effectId, inflight] of Object.entries(s.inflight)) {
    if (inflight.purpose !== "reconcile" || inflight.target !== originalId) continue;
    delete s.inflight[effectId];
    this.cancelTimer(`retry:${effectId}`);
    this.cancelTimer(`timeout:${effectId}`);
  }
}

export function retryOrFail(this: Machine, action: CompiledAction, effectId: string, attempt: number, error: ActionError, retryAfterMs?: number): void {
  const s = this.state;
  const res = s.results[keyOf(action.name, own(s.inflight, effectId)?.item)]!;
  if (attempt <= action.retry.max) {
    res.status = "retry_wait";
    res.error = error;
    res.rev = this.rev;
    s.inflight[effectId] = { ...s.inflight[effectId]!, waiting: true };
    this.setTimer(`retry:${effectId}`, this.now + backoff(action.retry, attempt, effectId, retryAfterMs));
    return;
  }
  // Out of attempts, but an earlier attempt may have gone through.
  if (action.def.effect === "write" && res.maybeApplied) {
    this.reconcileOrDoubt(action, effectId, error);
    return;
  }
  this.failResult(action, effectId, error);
}

export function failResult(this: Machine, action: CompiledAction, effectId: string, error: ActionError): void {
  const s = this.state;
  const key = keyOf(action.name, own(s.inflight, effectId)?.item);
  delete s.inflight[effectId];
  const res = s.results[key]!;
  s.results[key] = { ...res, status: "failed", error, rev: this.rev };
  this.note("flow/action-failed", publicError(error).message || `${action.name} did not work.`, undefined, action.name);
}

export function markInDoubt(this: Machine, action: CompiledAction, effectId: string, error: ActionError): void {
  const s = this.state;
  const key = keyOf(action.name, own(s.inflight, effectId)?.item);
  delete s.inflight[effectId];
  const res = s.results[key]!;
  s.results[key] = { ...res, status: "in_doubt", error, rev: this.rev };
  if (!s.attention.includes(effectId)) s.attention.push(effectId);
  this.note("flow/in-doubt", "We could not confirm whether this went through. Someone will check.", undefined, action.name);
}

export function settleReconcile(this: Machine, ev: ActionSettledEvent, action: CompiledAction, originalId: string): boolean {
  const s = this.state;
  delete s.inflight[ev.effectId];
  this.cancelTimer(`timeout:${ev.effectId}`);
  const original = own(s.inflight, originalId);
  const res = own(s.results, keyOf(action.name, original?.item));
  if (!res || res.effectId !== originalId || !original) return true;
  const outcome = ev.outcome;
  if (outcome.status === "ok") {
    const report = outcome.output;
    const applied = report !== null && typeof report === "object" && !Array.isArray(report) ? report.applied : undefined;
    if (applied === true) {
      s.inflight[originalId] = { ...original, waiting: false };
      const out = (report as JsonObject).output;
      if (out === undefined && (action.compensate || action.def.outputSchema)) {
        // Applied, but without its output nothing can use or undo it safely.
        this.markInDoubt(action, originalId, { code: "flow/output-unknown", message: "It went through, but its result is not known." });
        return true;
      }
      this.settleRun(action, originalId, original.attempt, { status: "ok", output: out === undefined ? null : out });
      return true;
    }
    if (applied === false) {
      // Definitely not applied, so it is safe to send again.
      s.inflight[originalId] = { ...original, waiting: false };
      delete res.maybeApplied;
      this.retryOrFail(action, originalId, original.attempt, res.error ?? { code: "flow/not-applied", message: "The change was not applied." });
      return true;
    }
  }
  // A reconcile is a read, so an unknown outcome is safe to ask again.
  if ((outcome.status === "retryable" || outcome.status === "unknown") && ev.attempt <= action.retry.max) {
    s.inflight[ev.effectId] = { purpose: "reconcile", action: action.name, target: originalId, attempt: ev.attempt, waiting: true };
    const retryAfter = outcome.status === "retryable" ? outcome.retryAfterMs : undefined;
    this.setTimer(`retry:${ev.effectId}`, this.now + backoff(action.retry, ev.attempt, ev.effectId, retryAfter));
    return true;
  }
  if (outcome.status === "pending") {
    s.inflight[ev.effectId] = { purpose: "reconcile", action: action.name, target: originalId, attempt: ev.attempt, waiting: false, pending: true };
    this.setTimer(`timeout:${ev.effectId}`, this.now + (windowOf(ev) ?? action.reconcile!.timeoutMs));
    return true;
  }
  s.inflight[originalId] = { ...original, waiting: false };
  this.markInDoubt(action, originalId, res.error ?? { code: "flow/unknown", message: "The outcome is unknown." });
  return true;
}

export function settleCompensation(this: Machine, ev: ActionSettledEvent, action: CompiledAction, resourceId: string): boolean {
  const s = this.state;
  const resource = own(s.resources, resourceId);
  delete s.inflight[ev.effectId];
  this.cancelTimer(`timeout:${ev.effectId}`);
  if (!resource || resource.releaseEffectId !== ev.effectId) return true;
  const outcome = ev.outcome;
  if (outcome.status === "ok") {
    resource.status = resource.status === "expired" ? "expired" : "released";
    resource.rev = this.rev;
    return true;
  }
  if (outcome.status === "pending") {
    s.inflight[ev.effectId] = { purpose: "compensate", action: action.name, target: resourceId, attempt: ev.attempt, waiting: false, pending: true };
    this.setTimer(`timeout:${ev.effectId}`, this.now + (windowOf(ev) ?? action.compensate!.timeoutMs));
    return true;
  }
  if ((outcome.status === "retryable" || outcome.status === "unknown") && ev.attempt <= Math.max(5, action.retry.max)) {
    s.inflight[ev.effectId] = { purpose: "compensate", action: action.name, target: resourceId, attempt: ev.attempt, waiting: true };
    const retryAfter = outcome.status === "retryable" ? outcome.retryAfterMs : undefined;
    this.setTimer(`retry:${ev.effectId}`, this.now + backoff(action.retry, ev.attempt, ev.effectId, retryAfter));
    return true;
  }
  undoInDoubt(this, resource, ev.effectId, action.name, "error" in outcome ? outcome.error : { code: "flow/unknown", message: "Undo failed." });
  return true;
}

/** An undo that failed, or could not be sent: the hold is in doubt until someone checks it (`effect.resolved` for `effectId`). */
export function undoInDoubt(m: Machine, resource: ResourceState, effectId: string, action: string, error: ActionError): void {
  const s = m.state;
  resource.status = "in_doubt";
  resource.error = error;
  resource.rev = m.rev;
  if (!s.attention.includes(effectId)) s.attention.push(effectId);
  m.note("flow/undo-failed", "Something could not be undone automatically. Someone will check.", undefined, action);
}

export function onResolved(this: Machine, ev: EffectResolvedEvent): boolean {
  const s = this.state;
  const actor = ev.actor;
  if (actor.kind !== "system" && !actor.roles.some((r) => this.flow.staffRoles.includes(r))) {
    reject("flow/forbidden", "Only staff can settle this.");
  }
  if (!s.attention.includes(ev.effectId)) return false;
  s.attention = s.attention.filter((id) => id !== ev.effectId);
  for (const [key, res] of Object.entries(s.results)) {
    if (res.effectId !== ev.effectId || res.status !== "in_doubt") continue;
    const name = nameOfKey(key);
    const action = this.flow.actions.get(name)!;
    if (ev.applied && ev.output === undefined && (action.compensate || action.def.outputSchema)) {
      // Without its output nothing can use or undo it safely.
      reject("flow/output-needed", "Give the output it returned, so it can be used and undone.");
    }
    const item = action.forEach !== undefined ? itemOfKey(key) : undefined;
    s.inflight[ev.effectId] = { purpose: "run", action: name, attempt: res.attempt, waiting: false, ...(item !== undefined ? { item } : {}) };
    if (ev.applied) this.settleRun(action, ev.effectId, res.attempt, { status: "ok", output: ev.output ?? null });
    else this.failResult(action, ev.effectId, { code: "flow/not-applied", message: "It did not go through. You can try again." });
    return true;
  }
  for (const [resourceId, resource] of Object.entries(s.resources)) {
    if (resource.releaseEffectId !== ev.effectId || resource.status !== "in_doubt") continue;
    delete resource.error;
    if (ev.applied) {
      resource.status = "released";
      resource.rev = this.rev;
    } else {
      // It still exists out there and nobody wants it: undo it again.
      resource.status = "held";
      this.release(resourceId, resource);
    }
    return true;
  }
  return true;
}
