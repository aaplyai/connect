/**
 * The core machine's advance: running every step that can run, starting
 * and releasing effects, holds and commits, and winding a run down to its
 * end. Functions over `this`, installed on Machine.
 */

import { keyOf } from "../address.js";
import { MAX_INFLIGHT } from "../collections-compile.js";
import { type CompiledStep, type CompiledAction, actionNode } from "../compile.js";
import { truthy, type Missing, evaluateRecord } from "../expr-eval.js";
import { fingerprint } from "../hash.js";
import { own, type JsonObject, cloneJson } from "../json.js";
import { liveItems } from "../items.js";
import type { StepStatus } from "../reader.js";
import { isTerminal, type CauseRef, type EffectPurpose, type ActionEffect, type ResourceState } from "../state.js";
import type { EndKind } from "../definition.js";
import { type Machine, NO_ITEM, traceOf, effectNumber, MAX_ENDED_RESOURCES } from "../core.js";

// --- the next move ----------------------------------------------------------

export function advance(this: Machine): void {
  const s = this.state;
  this.sendQueuedReleases();
  if (s.status === "cancelling" || isTerminal(s.status)) {
    this.windDown();
    return;
  }
  this.expireHolds();
  this.releaseStale();
  this.releaseStaleCalls();
  const done = this.eval(this.flow.completeWhen);
  const goalMet = done.known && truthy(done.value);
  if (goalMet && !this.writesInFlight()) {
    // A run never ends with a live child: stop them, and complete once they have answered.
    if (this.endCalls("parent-ended")) return;
    this.complete();
    return;
  }
  if (s.pendingEnd) {
    // The goal is met: let the writes in flight settle, then complete instead of ending.
    if (goalMet) return;
    // An end is waiting for a commit to settle; start nothing new meanwhile.
    if (this.commitBusy()) return;
    const end = s.pendingEnd;
    delete s.pendingEnd;
    // Chosen again now that the commit settled: one that went through makes a cancelled end `expired`,
    // as for a run that had committed before its end began.
    const kind = end.kind === "cancelled" && this.isCommitted() ? "expired" : end.kind;
    this.beginEnd(kind, end.reason ?? end.kind, end.cascade);
    return;
  }
  const paused = this.paused();
  let current: { step: CompiledStep; status: StepStatus; item?: string } | null = null;
  const missing: Missing = { facts: [], results: [] };
  let prefetch = 4;
  // With collections a per-item step has one instance per live item, in list order,
  // and a run has at most MAX_INFLIGHT effects in flight.
  const items = this.flow.collections.size > 0;
  let room = items ? MAX_INFLIGHT - Object.keys(s.inflight).length : Infinity;
  let reserved = false;
  /** A per-item step's instances run side by side up to its fanOut (each one started is in flight). */
  const fanRoom = (step: CompiledStep): boolean => {
    if (step.forEach === undefined) return true;
    let busy = 0;
    for (const f of Object.values(s.inflight)) if (f.purpose === "run" && f.action === step.run) busy++;
    return busy < step.fanOut;
  };
  const early = (status: Extract<StepStatus, { kind: "run" }>, item: string | undefined) => {
    room--;
    this.startRun(status.action, status.input, status.fingerprint, item);
  };
  for (const step of this.flow.steps) {
    // Once the current step is found, only early starts remain; stop when none can happen.
    if (items && current && ((prefetch === 0 && current.step !== step) || room <= 0)) break;
    for (const item of step.forEach === undefined ? NO_ITEM : liveItems(s, step.forEach)) {
      const applies = this.applies(step, item);
      if (!applies.known) {
        missing.facts.push(...applies.missing.facts);
        continue;
      }
      if (!truthy(applies.value)) continue;
      const status = this.stepStatus(step, item);
      if (status.kind === "complete") continue;
      if (status.kind === "blocked") {
        missing.facts.push(...status.missing.facts);
        missing.results.push(...status.missing.results);
        continue;
      }
      if (!current) {
        current = { step, status, ...(item !== undefined ? { item } : {}) };
        // The current step's own effect is never crowded out by early starts.
        if (status.kind === "run" && !paused && room > 0) {
          room--;
          reserved = true;
          // With collections it starts first, so a step's instances start in list order.
          if (items) {
            this.startRun(status.action, status.input, status.fingerprint, item);
            reserved = false;
          }
        }
        continue;
      }
      if (status.kind !== "run" || paused || room <= 0) continue;
      // More instances of the current per-item step, when it may run several at once.
      if (current.step === step && step.fanOut > 1 && fanRoom(step)) {
        early(status, item);
        continue;
      }
      // Reads that are ready further on are fetched early; they change nothing.
      if (status.action.def.effect === "read" && !step.view && prefetch > 0 && fanRoom(step)) {
        prefetch--;
        early(status, item);
      }
    }
  }
  for (const [stepId, wait] of Object.entries(s.waits)) {
    if (current?.step.id !== stepId || (current.status.kind === "wait" && current.status.key !== wait.key)) this.closeWait(stepId);
  }
  if (!current) {
    s.current = null;
    delete s.currentItem;
    if (Object.keys(s.inflight).length === 0 && !this.callLive()) {
      // Sorted: the definition's key order is not part of its hash, so it must not reach the state.
      const facts = [...new Set(missing.facts)].sort();
      this.note("flow/stuck", "This cannot continue: something it needs cannot be provided.", facts);
    }
    return;
  }
  s.current = current.step.id;
  if (current.item !== undefined) s.currentItem = current.item;
  else delete s.currentItem;
  const st = current.status;
  // While paused, nothing is sent until the person comes back.
  if (st.kind === "run" && reserved) this.startRun(st.action, st.input, st.fingerprint, current.item);
  else if (st.kind === "wait" && !own(s.waits, current.step.id)) this.openWait(current.step, st.key);
  else if (st.kind === "call" && !paused) this.startCall(current.step, st.input, st.fingerprint);
}

export function startRun(this: Machine, action: CompiledAction, input: JsonObject, fp: string, item?: string): void {
  const s = this.state;
  const effectId = this.nextEffectId();
  s.results[keyOf(action.name, item)] = { effectId, fingerprint: fp, input: cloneJson(input), status: "inflight", attempt: 1, rev: this.rev, ...this.causeOfEvent(), ...traceOf(this.event) };
  this.startEffect("run", action, input, 1, effectId, undefined, item);
}

/** Who set a new write in motion: the event's person, or null for the engine. */
export function causeOfEvent(this: Machine): { causedBy?: CauseRef | null } {
  const actor = this.event.actor;
  return { causedBy: actor.kind === "system" ? null : { kind: actor.kind, id: actor.id } };
}

/** `item`: the item of a per-item action; a run effect's in-flight record keeps it, so its result's key can be found. */
export function startEffect(this: Machine, purpose: EffectPurpose, action: CompiledAction, input: JsonObject, attempt: number, effectId?: string, target?: string, item?: string): void {
  const id = effectId ?? this.nextEffectId();
  const call = purpose === "run" ? action.call : purpose === "compensate" ? action.compensate! : action.reconcile!;
  const effect: ActionEffect = {
    kind: "action",
    effectId: id,
    attempt,
    purpose,
    name: action.name,
    action: call.action,
    ...(call.connection !== undefined ? { connection: call.connection } : {}),
    actingFor: action.def.actingFor ?? "business",
    effect: purpose === "reconcile" ? "read" : purpose === "compensate" ? "write" : action.def.effect,
    input: cloneJson(input),
    idempotent: purpose === "run" ? action.def.effect === "read" || action.idempotent : true,
    timeoutMs: call.timeoutMs,
    risk: purpose === "run" ? action.risk : "none",
    ...(target !== undefined ? { target } : {}),
    ...(item !== undefined ? { item } : {}),
  };
  this.state.inflight[id] = { purpose, action: action.name, attempt, waiting: false, ...(target !== undefined ? { target } : {}), ...(item !== undefined && purpose === "run" ? { item } : {}) };
  this.effects.push(effect);
}

export function frozenInput(this: Machine, entries: CompiledAction["call"]["input"], resource: JsonObject): JsonObject {
  const r = evaluateRecord(entries, this.env({ resource }));
  return r.known ? (r.value as JsonObject) : {};
}

/** Releases holds whose input changed or whose step no longer applies. */
export function releaseStale(this: Machine): void {
  const s = this.state;
  for (const [resourceId, resource] of Object.entries(s.resources)) {
    if (resource.status !== "held") continue;
    const action = this.flow.actions.get(resource.action);
    if (!action) continue;
    const step = this.flow.stepById.get(action.stepId);
    // A per-item hold is wanted only while its item is live.
    const gone = resource.item !== undefined && !liveItems(s, action.forEach ?? "").includes(resource.item);
    const applies = step ? this.applies(step, resource.item) : { known: true as const, value: true };
    const input = this.currentInput(action, resource.item);
    const stillWanted = !gone && (!applies.known || truthy(applies.value)) && input.known && fingerprint(input.value) === resource.fingerprint;
    if (!stillWanted) this.release(resourceId, resource);
  }
}

export function release(this: Machine, resourceId: string, resource: ResourceState): void {
  const s = this.state;
  const action = this.flow.actions.get(resource.action)!;
  this.cancelTimer(`hold:${resourceId}`);
  const key = keyOf(resource.action, resource.item);
  const res = own(s.results, key);
  if (res && res.effectId === resourceId && !isTerminal(s.status)) delete s.results[key];
  // A review or approval covered the write that is now undone; doing it again needs a new one.
  delete s.confirmations[key];
  if (!action.compensate) {
    resource.status = "released";
    resource.rev = this.rev;
    return;
  }
  resource.status = "releasing";
  resource.rev = this.rev;
  // With collections at most MAX_INFLIGHT effects are in flight, releases included: past the cap a
  // release waits its turn behind those already waiting (its `rev` says when it was asked for), and
  // goes out before anything new starts (sendQueuedReleases).
  if (this.flow.collections.size > 0 && (Object.keys(s.inflight).length >= MAX_INFLIGHT || this.releasesQueued())) {
    resource.releaseQueued = true;
    return;
  }
  this.sendRelease(resourceId, resource, action);
}

/** Sends the compensation that releases a hold. */
export function sendRelease(this: Machine, resourceId: string, resource: ResourceState, action: CompiledAction): void {
  const effectId = this.nextEffectId();
  delete resource.releaseQueued;
  resource.releaseEffectId = effectId;
  this.startEffect("compensate", action, this.frozenInput(action.compensate!.input, { input: resource.input, output: resource.output }), 1, effectId, resourceId, resource.item);
}

/**
 * Sends the releases waiting under the in-flight cap while there is room,
 * first asked for first (by `rev`, then the oldest hold), before anything
 * new starts. Nothing new starts while one waits, so each goes out after at
 * most the releases queued ahead of it, as effects in flight settle.
 */
export function sendQueuedReleases(this: Machine): void {
  const s = this.state;
  if (this.flow.collections.size === 0) return;
  const queued = Object.entries(s.resources).filter(([, r]) => r.releaseQueued === true);
  if (queued.length === 0) return;
  queued.sort(([a, ra], [b, rb]) => ra.rev - rb.rev || effectNumber(a) - effectNumber(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const [resourceId, resource] of queued) {
    if (Object.keys(s.inflight).length >= MAX_INFLIGHT) return;
    this.sendRelease(resourceId, resource, this.flow.actions.get(resource.action)!);
  }
}

/** `item`: a per-item commit point makes that item's holds final, and the run's own, but not other items'. */
export function commitHolds(this: Machine, item?: string): void {
  for (const [resourceId, resource] of Object.entries(this.state.resources)) {
    if (resource.status !== "held") continue;
    if (item !== undefined && resource.item !== undefined && resource.item !== item) continue;
    resource.status = "committed";
    resource.rev = this.rev;
    this.cancelTimer(`hold:${resourceId}`);
  }
}

export function complete(this: Machine): void {
  const s = this.state;
  // Completing is an implicit commit: what the run did stays done.
  this.commitHolds();
  this.dropReads();
  delete s.pendingEnd;
  s.status = "completed";
  s.end = { kind: "completed", at: this.now };
  s.current = null;
  delete s.currentItem;
  this.closeAll();
}

/**
 * Starts ending the run: releases holds, then settles into `kind`. An end
 * already under way is kept. While a commit write is in flight or its
 * outcome is unknown the end waits, because releasing what the commit relies
 * on could undo half of something that went through.
 */
export function beginEnd(this: Machine, kind: EndKind, reason: string, cascade?: string): void {
  const s = this.state;
  if (s.status !== "active") return;
  if (this.commitBusy()) {
    s.pendingEnd ??= { kind, at: this.now, reason, ...(cascade !== undefined ? { cascade } : {}) };
    return;
  }
  delete s.pendingEnd;
  s.end = { kind, at: this.now, reason, ...(cascade !== undefined ? { cascade } : {}) };
  s.status = "cancelling";
  s.current = null;
  delete s.currentItem;
  for (const stepId of Object.keys(s.waits)) this.closeWait(stepId);
  this.dropReads();
  this.dropUnsentWrites();
  this.endCalls("parent-ended");
  this.windDown();
}

/** Writes waiting to be retried that certainly did not apply are not sent again. */
export function dropUnsentWrites(this: Machine): void {
  const s = this.state;
  for (const [effectId, inflight] of Object.entries(s.inflight)) {
    if (inflight.purpose !== "run" || !inflight.waiting) continue;
    if (this.flow.actions.get(inflight.action)?.def.effect !== "write") continue;
    const key = keyOf(inflight.action, inflight.item);
    const res = own(s.results, key);
    if (res && res.effectId === effectId && res.maybeApplied) continue;
    delete s.inflight[effectId];
    this.cancelTimer(`retry:${effectId}`);
    if (res && res.effectId === effectId) delete s.results[key];
  }
}

/**
 * Expires holds whose time is up, unless a write that relies on them is
 * still in flight or in doubt (it settles first). A hold that ran out while
 * the person was away pauses the run instead of being taken again at once,
 * so an abandoned run does not keep re-holding until it expires.
 */
export function expireHolds(this: Machine): void {
  const s = this.state;
  for (const [resourceId, resource] of Object.entries(s.resources)) {
    if (resource.status !== "held" || resource.expiresAt === undefined || resource.expiresAt > this.now) continue;
    if (own(s.timers, `hold:${resourceId}`) !== undefined || this.feedsBusyWrite(resource.action)) continue;
    resource.status = "expired";
    resource.rev = this.rev;
    const key = keyOf(resource.action, resource.item);
    const res = own(s.results, key);
    if (res && res.effectId === resourceId) delete s.results[key];
    const away = resource.heldAt === undefined || s.lastInputAt < resource.heldAt;
    if (away) {
      resource.lapsed = true;
      s.lapsed = [...(s.lapsed ?? []), resourceId];
      this.note("flow/hold-lapsed", "Your hold ran out. Continue when you are ready and we will try again.", undefined, resource.action);
    } else {
      this.note("flow/hold-expired", "Your hold ran out, so we will try again.", undefined, resource.action);
    }
  }
  this.pruneResources();
}

/** Whether a write that reads this action's result (directly or through facts) is busy. */
export function feedsBusyWrite(this: Machine, actionName: string): boolean {
  const start = actionNode(actionName);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of this.flow.dependents.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      if (!next.startsWith("a:")) continue;
      const name = next.slice(2);
      if (this.flow.actions.get(name)?.def.effect === "write" && this.anyBusy(name)) return true;
    }
  }
  return false;
}

/** Keeps only the most recent released or expired resources. */
export function pruneResources(this: Machine): void {
  const s = this.state;
  const lapsed = new Set(s.lapsed ?? []);
  const ended = Object.entries(s.resources).filter(
    ([id, r]) => (r.status === "released" || r.status === "expired") && !lapsed.has(id) && (r.releaseEffectId === undefined || !own(s.inflight, r.releaseEffectId)),
  );
  if (ended.length <= MAX_ENDED_RESOURCES) return;
  ended.sort((a, b) => a[1].rev - b[1].rev);
  for (const [id] of ended.slice(0, ended.length - MAX_ENDED_RESOURCES)) delete s.resources[id];
}

export function windDown(this: Machine): void {
  const s = this.state;
  const ending = s.end?.kind ?? "cancelled";
  for (const [resourceId, resource] of Object.entries(s.resources)) {
    if (resource.status !== "held") continue;
    if (s.status === "completed") {
      resource.status = "committed";
      resource.rev = this.rev;
    } else this.release(resourceId, resource);
  }
  if (s.status === "cancelling" && !this.writesInFlight() && !this.callsCancelling()) {
    s.status = ending;
    s.end = { ...(s.end ?? { kind: ending, at: this.now }), at: this.now };
    this.closeAll();
  }
}

export function dropReads(this: Machine): void {
  const s = this.state;
  for (const [effectId, inflight] of Object.entries(s.inflight)) {
    if (inflight.purpose !== "run") continue;
    const action = this.flow.actions.get(inflight.action);
    if (action?.def.effect !== "read") continue;
    delete s.inflight[effectId];
    this.cancelTimer(`retry:${effectId}`);
    this.cancelTimer(`timeout:${effectId}`);
    const key = keyOf(inflight.action, inflight.item);
    const res = own(s.results, key);
    if (res && res.effectId === effectId) delete s.results[key];
  }
}

/** Closes waits and timers that only matter while the run is open. */
export function closeAll(this: Machine): void {
  const s = this.state;
  for (const stepId of Object.keys(s.waits)) this.closeWait(stepId);
  for (const timerId of Object.keys(s.timers)) {
    const keep = (timerId.startsWith("retry:") || timerId.startsWith("timeout:")) && own(s.inflight, timerId.slice(timerId.indexOf(":") + 1));
    if (!keep) this.cancelTimer(timerId);
  }
}
