/**
 * The core machine's handling of calls between flows: starting a child,
 * hearing that it started, timed out, settled or was cancelled, and what a
 * child returns to its caller. Functions over `this`, installed on Machine.
 */

import { isParentLink, childRunId, CALL_START_RETRIES, readCallEnd, CALL_ACTOR, capContributors, isContributor, MAX_CALL_OUTPUT_BYTES } from "../calls.js";
import { type CompiledStep, DEFAULT_RETRY } from "../compile.js";
import { suppliersOf } from "../core-items-stale.js";
import { truthy } from "../expr-eval.js";
import { type JsonValue, hasOwn, own, type JsonObject, cloneJson, jsonByteLength } from "../json.js";
import { publicError, readable } from "../reader.js";
import type { RunStartedEvent, CallState, CallStartedEvent, CallSettledEvent, CallCancelledEvent, CallCancelReason, CallEnd } from "../state.js";
import { type Machine, reject, type FactWrite, backoff, MAX_ENDED_CALLS } from "../core.js";

// --- calls: child runs ---------------------------------------------------------

/**
 * A caller's input to a child run. Only the runtime starts one, with only
 * the facts the flow's interface takes, each checked like any other value;
 * a person's gating does not apply, because no person is answering.
 */
export function acceptCallInput(this: Machine, event: RunStartedEvent, entries: Array<[string, JsonValue]>): void {
  if (event.actor.kind !== "system") reject("flow/forbidden", "Only the runtime can start a called run.");
  if (event.source !== "call" || !isParentLink(event.parent) || !this.state.parent) reject("flow/call-invalid", "A called run needs its caller's link.");
  const iface = this.flow.interface ?? reject("flow/call-not-callable", "This flow cannot be called.");
  const values: Array<[string, FactWrite]> = [];
  for (const [name, value] of entries) {
    if (!iface.input.includes(name)) reject("flow/fact-not-allowed", `"${name}" is not an input of this flow`, [name]);
    values.push([name, value]);
  }
  const missing = iface.required.filter((name) => !hasOwn(event.facts, name));
  if (missing.length > 0) reject("flow/call-input-missing", "Some of the input is missing.", missing);
  this.applyFacts(values, "entry", "strict");
  const invalid = values.map(([name]) => name).filter((name) => own(this.state.facts, name)?.status === "invalid");
  if (invalid.length > 0) reject("flow/call-input-invalid", "The input does not fit this flow.", invalid);
}

/** Any call not over yet (its child exists, may be created, or is being cancelled). */
export function callLive(this: Machine): boolean {
  return Object.values(this.state.calls ?? {}).some((c) => c.status !== "ended");
}

export function callsCancelling(this: Machine): boolean {
  return Object.values(this.state.calls ?? {}).some((c) => c.status === "cancelling");
}

/** Starts the step's child, one call at a time, at most `maxCalls` per run. */
export function startCall(this: Machine, step: CompiledStep, input: JsonObject, fp: string): void {
  const s = this.state;
  if (this.callLive()) return;
  const target = step.call!;
  const callId = this.nextEffectId();
  const calls = (s.calls ??= {});
  const base = { key: step.id, runId: childRunId(s.nonce ?? s.runId, callId), flowId: target.flowId, flowVersion: target.version, fingerprint: fp, input: cloneJson(input), epoch: own(s.epochs, step.id) ?? 0, attempt: 1, rev: this.rev };
  if ((s.callCount ?? 0) >= this.flow.limits.maxCalls) {
    const error = { code: "flow/limit", message: "This was tried too many times." };
    calls[callId] = { ...base, status: "ended", end: { kind: "failed", committed: false, error, lastInputAt: s.lastInputAt } };
    this.note("flow/limit", error.message);
    this.pruneCalls();
    return;
  }
  s.callCount = (s.callCount ?? 0) + 1;
  calls[callId] = { ...base, status: "starting" };
  this.sendCallStart(callId, calls[callId]!);
  if (target.timeoutMs !== undefined) this.setTimer(`call:${callId}`, this.now + target.timeoutMs);
}

export function sendCallStart(this: Machine, callId: string, call: CallState): void {
  const s = this.state;
  const step = this.flow.stepById.get(call.key)!;
  this.effects.push({
    kind: "call.start",
    callId,
    attempt: call.attempt,
    childRunId: call.runId,
    flowId: call.flowId,
    version: step.call!.version,
    upgrade: step.call!.upgrade,
    input: cloneJson(call.input),
    parent: {
      runId: s.runId,
      callId,
      rootRunId: s.parent?.rootRunId ?? s.runId,
      depth: (s.parent?.depth ?? 0) + 1,
      chain: [...(s.parent?.chain ?? []), this.flow.id],
      contributors: this.contributorsOf(this.flow.callUpstream.get(call.key) ?? []),
    },
  });
}

/** The runtime's answer to a start: the child exists, will be tried again, or cannot be started. */
export function onCallStarted(this: Machine, ev: CallStartedEvent): boolean {
  if (ev.actor.kind !== "system") reject("flow/forbidden", "Only the runtime can start a call.");
  const s = this.state;
  const call = own(s.calls ?? {}, ev.callId);
  if (!call || call.status !== "starting" || call.attempt !== ev.attempt) return false;
  const outcome = ev.outcome;
  call.rev = this.rev;
  if (outcome.status === "ok" && typeof outcome.flowVersion === "string" && typeof outcome.flowHash === "string") {
    call.status = "running";
    call.flowVersion = outcome.flowVersion;
    call.flowHash = outcome.flowHash;
    return true;
  }
  if (outcome.status === "retryable" && ev.attempt <= CALL_START_RETRIES) {
    call.status = "retry_wait";
    this.setTimer(`retry:${ev.callId}`, this.now + backoff(DEFAULT_RETRY, ev.attempt, ev.callId, outcome.retryAfterMs));
    return true;
  }
  this.cancelTimer(`call:${ev.callId}`);
  const error = outcome.status === "ok" ? undefined : outcome.error;
  call.status = "ended";
  call.end = { kind: "failed", committed: false, error: publicError(error ?? { code: "flow/call-failed", message: "" }), lastInputAt: s.lastInputAt };
  this.callEnded(ev.callId, call);
  return true;
}

/** Tries a start again after a transient refusal, with the same child id. */
export function resendCall(this: Machine, callId: string): boolean {
  const s = this.state;
  const call = s.calls![callId]!;
  if (call.status !== "retry_wait" || s.status !== "active") return true;
  call.status = "starting";
  call.attempt += 1;
  call.rev = this.rev;
  this.sendCallStart(callId, call);
  return true;
}

/** The call took too long: stop the child, or give up on a start that has not happened. */
export function onCallTimeout(this: Machine, callId: string): boolean {
  const s = this.state;
  const call = own(s.calls ?? {}, callId);
  if (!call || s.status !== "active" || call.retired) return true;
  if (call.status === "running") {
    call.status = "cancelling";
    call.cancelReason = "timeout";
    call.rev = this.rev;
    this.effects.push({ kind: "call.cancel", callId, childRunId: call.runId, reason: "timeout" });
    return true;
  }
  if (call.status !== "starting" && call.status !== "retry_wait") return true;
  this.cancelTimer(`retry:${callId}`);
  call.status = "ended";
  call.cancelReason = "timeout";
  call.end = { kind: "cancelled", committed: false, lastInputAt: s.lastInputAt };
  call.rev = this.rev;
  this.callEnded(callId, call);
  return true;
}

/** A child ended. Recorded always; answered by the step's rules while the call is still the step's. */
export function onCallSettled(this: Machine, ev: CallSettledEvent): boolean {
  if (ev.actor.kind !== "system") reject("flow/forbidden", "Only the runtime can end a call.");
  const s = this.state;
  const call = own(s.calls ?? {}, ev.callId);
  if (!call || call.runId !== ev.childRunId || (call.status !== "running" && call.status !== "cancelling")) return false;
  const end = readCallEnd(ev.end, s.lastInputAt);
  this.cancelTimer(`call:${ev.callId}`);
  call.status = "ended";
  call.end = end;
  call.rev = this.rev;
  // The person was active in the child.
  if (end.lastInputAt > s.lastInputAt) {
    s.lastInputAt = end.lastInputAt;
    if (this.paused()) this.resume();
  }
  if (s.status !== "active") return true;
  this.setTimer("idle", this.now + this.flow.limits.idleTimeoutMs);
  if (call.retired) {
    // Nobody wanted it any more, but what it did stays done: someone has to look.
    if (end.committed) {
      if (!s.attention.includes(ev.callId)) s.attention.push(ev.callId);
      this.note("flow/call-orphaned-commit", "Something finished after it was no longer needed. Someone will check.");
    }
    delete end.output;
    this.pruneCalls();
    return true;
  }
  this.callEnded(ev.callId, call);
  return true;
}

/** The caller no longer waits: end, keeping what was committed (then the end is `expired`). */
export function onCallCancelled(this: Machine, ev: CallCancelledEvent): boolean {
  if (ev.actor.kind !== "system") reject("flow/forbidden", "Only the runtime can stop a called run.");
  const s = this.state;
  if (!s.parent || s.status !== "active" || s.pendingEnd) return false;
  const reason: CallCancelReason = ev.reason === "superseded" || ev.reason === "timeout" ? ev.reason : "parent-ended";
  this.beginEnd(this.isCommitted() ? "expired" : "cancelled", `caller:${reason}`);
  return true;
}

/** A `retry` rule: the step's ended call stops being its answer, so a new child is called. */
export function retireCall(this: Machine, step: CompiledStep): void {
  const latest = this.latestCall(step.id);
  if (!latest || latest[1].status !== "ended") return;
  // A child that committed did something that stays done; doing it again is not a retry.
  if (latest[1].end?.committed) reject("flow/committed", "This can no longer be tried again.");
  latest[1].retired = true;
  latest[1].rev = this.rev;
}

/** Abandons live calls whose step no longer applies or whose input or epoch moved on. */
export function releaseStaleCalls(this: Machine): void {
  const s = this.state;
  if (!s.calls) return;
  for (const [callId, call] of Object.entries(s.calls)) {
    if (call.retired || (call.status !== "starting" && call.status !== "retry_wait" && call.status !== "running")) continue;
    const step = this.flow.stepById.get(call.key);
    let wanted = false;
    if (step?.call) {
      const applies = this.applies(step);
      const status = this.stepStatus(step);
      wanted = (!applies.known || truthy(applies.value)) && status.kind === "calling" && status.callId === callId;
    }
    if (!wanted) this.abandonCall(callId, call, "superseded");
  }
}

/** Ends every live call; returns whether any child is still being cancelled. */
export function endCalls(this: Machine, reason: CallCancelReason): boolean {
  const s = this.state;
  if (!s.calls) return false;
  for (const [callId, call] of Object.entries(s.calls)) {
    if (call.status === "starting" || call.status === "retry_wait" || call.status === "running") this.abandonCall(callId, call, reason);
  }
  return this.callsCancelling();
}

/** A call nobody waits for: a child is cancelled; a start that has not happened simply ends. */
export function abandonCall(this: Machine, callId: string, call: CallState, reason: CallCancelReason): void {
  call.retired = true;
  call.cancelReason = reason;
  call.rev = this.rev;
  this.cancelTimer(`call:${callId}`);
  if (call.status === "running") {
    call.status = "cancelling";
    this.effects.push({ kind: "call.cancel", callId, childRunId: call.runId, reason });
    return;
  }
  this.cancelTimer(`retry:${callId}`);
  call.status = "ended";
  call.end = { kind: "cancelled", committed: false, lastInputAt: this.state.lastInputAt };
}

/** Keeps the record of abandoned calls short; the step's own and committed ones are kept. */
export function pruneCalls(this: Machine): void {
  const s = this.state;
  if (!s.calls) return;
  const done = Object.entries(s.calls).filter(([id, c]) => c.status === "ended" && c.retired && !c.end?.committed && !s.attention.includes(id));
  if (done.length <= MAX_ENDED_CALLS) return;
  done.sort((a, b) => a[1].rev - b[1].rev);
  for (const [id] of done.slice(0, done.length - MAX_ENDED_CALLS)) delete s.calls[id];
}

/**
 * Who supplied the facts behind something: their actor ids, without the
 * engine's own. Facts that came from a call (its input in a child, its
 * output in a caller) carry whoever supplied those, across the boundary.
 * Item fields and items count as facts do (`suppliersOf`).
 */
export function contributorsOf(this: Machine, facts: Iterable<string>): string[] {
  const s = this.state;
  const ids = new Set<string>();
  let inherited = false;
  for (const by of suppliersOf(s, this.flow.collections, facts)) {
    if (by === CALL_ACTOR.id) inherited = true;
    else if (!by.startsWith("system:")) ids.add(by);
  }
  if (inherited) for (const id of this.inheritedContributors()) ids.add(id);
  return capContributors(ids);
}

export function inheritedContributors(this: Machine): string[] {
  const s = this.state;
  return [...(s.parent?.contributors ?? []), ...Object.values(s.calls ?? {}).flatMap((c) => c.end?.contributors ?? [])];
}

/** An approver supplied, through a call, a fact behind what they approve. */
export function suppliedThroughCalls(this: Machine, facts: Iterable<string>, actorId: string): boolean {
  const s = this.state;
  if (!s.parent && !s.calls) return false;
  if (!suppliersOf(s, this.flow.collections, facts).includes(CALL_ACTOR.id)) return false;
  return isContributor(this.inheritedContributors(), actorId);
}

/** A child's one report to its caller, when it stops being live. */
export function emitReturn(this: Machine): void {
  const s = this.state;
  const link = s.parent!;
  const kind = s.end?.kind ?? "failed";
  // A commit point the child passed, or a committed grandchild, commits the call. Holds that its
  // completion made final do not: they are the child's to keep, not a reason to lock its caller.
  const committed = this.passedCommitPoint();
  let end: CallEnd = {
    kind,
    ...(s.end?.reason !== undefined ? { reason: s.end.reason } : {}),
    committed,
    lastInputAt: s.lastInputAt,
    ...(s.end?.cascade !== undefined ? { cascade: s.end.cascade } : {}),
  };
  if (kind === "completed") {
    const iface = this.flow.interface;
    const output: JsonObject = {};
    for (const name of iface?.output ?? []) {
      const r = readable(own(s.facts, name));
      Object.defineProperty(output, name, { value: r.known ? r.value : null, enumerable: true, writable: true, configurable: true });
    }
    if (jsonByteLength(output) > MAX_CALL_OUTPUT_BYTES) {
      end = { ...end, kind: "failed", error: { code: "flow/call-output-too-large", message: "The answer was too large to use." } };
    } else {
      end.output = output;
      const contributors = this.contributorsOf(iface?.upstream ?? []);
      if (contributors.length > 0) end.contributors = contributors;
    }
  }
  this.effects.push({ kind: "call.return", parentRunId: link.runId, callId: link.callId, childRunId: s.runId, end });
}
