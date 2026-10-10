/**
 * Read-only evaluation over a run's state: what is known, which inputs are
 * current, which facts are locked, and where each step stands. Shared by the
 * step function and by view rendering so both always agree.
 */

import { fieldAddress, itemOfKey, keyOf, nameOfKey, splitTemplate } from "./address.js";
import { actionNode, factNode, type CompiledAction, type CompiledFlow, type CompiledStep } from "./compile.js";
import { evaluate, evaluateRecord, truthy, type EvalEnv, type Evaluated, type Missing, type Read } from "./expr-eval.js";
import { fingerprint } from "./hash.js";
import { fieldState, isLiveItem, readList, readRows, readSelf } from "./items.js";
import { canonicalJson, jsonEqual, own, type JsonObject, type JsonValue } from "./json.js";
import type { ActionError, ActorRef, CallState, FactState, ResultState, RunState } from "./state.js";

export type StepStatus =
  | { kind: "blocked"; missing: Missing }
  | { kind: "complete" }
  | { kind: "ask" }
  | { kind: "confirm"; action: CompiledAction; input: JsonObject; digest: string }
  | { kind: "run"; action: CompiledAction; input: JsonObject; fingerprint: string }
  | { kind: "working"; action?: CompiledAction }
  | { kind: "wait"; key: string }
  /** `action` is absent when a call failed. */
  | { kind: "failed"; action?: CompiledAction; error: ActionError }
  | { kind: "attention"; action: CompiledAction }
  /** A call step whose child should be started now. */
  | { kind: "call"; input: JsonObject; fingerprint: string }
  /** A call step waiting for its child run. */
  | { kind: "calling"; callId: string; call: CallState };

const ACTIVE_RESULT = new Set(["inflight", "retry_wait", "pending", "reconciling"]);
/** Calls whose child exists or may be created: their inputs are locked. */
const LIVE_CALL = new Set(["starting", "retry_wait", "running"]);

/** What a call that did not complete tells the person. */
export function callError(call: CallState): ActionError {
  const end = call.end;
  if (end?.error) return end.error;
  if (call.cancelReason === "timeout") return { code: "flow/timeout", message: "This took too long." };
  if (end?.kind === "cancelled") return { code: "flow/call-cancelled", message: "This was cancelled." };
  if (end?.kind === "expired") return { code: "flow/call-expired", message: "This expired." };
  return { code: "flow/call-failed", message: "That did not work. Please try again." };
}

/** The call number of a call id (`${runId}.${n}`), for ordering. */
function callSeq(callId: string): number {
  return Number(callId.slice(callId.lastIndexOf(".") + 1)) || 0;
}

/** A result still being worked on, or one whose outcome nobody knows yet. */
export function isBusy(res: ResultState | undefined): boolean {
  return res !== undefined && (ACTIVE_RESULT.has(res.status) || res.status === "in_doubt");
}

/**
 * Digest of exactly what a person confirms: the action and its input. The
 * run's nonce salts it, so a digest seen by a client cannot be used to guess
 * low-entropy inputs offline.
 */
export function confirmDigest(actionName: string, input: JsonObject, nonce?: string): string {
  return fingerprint(nonce === undefined ? { action: actionName, input } : { action: actionName, input, nonce });
}

/**
 * The error as a person may see it. `message` is written for people (the
 * connector kit's contract); `detail` may carry internal text and is for
 * staff only.
 */
export function publicError(error: ActionError): ActionError {
  return { code: error.code, message: error.message || "That did not work. Please try again." };
}

export function readable(fact: FactState | undefined): Read {
  if (!fact) return { known: false };
  if (fact.status === "valid") return { known: true, value: fact.value ?? null };
  if (fact.status === "declined") return { known: true, value: null };
  return { known: false };
}

export class RunReader {
  readonly flow: CompiledFlow;
  state: RunState;
  now: number;
  /** A call whose end rule is being applied: its own fills are not locked yet. */
  protected settlingCall: string | null = null;

  constructor(flow: CompiledFlow, state: RunState, now: number) {
    this.flow = flow;
    this.state = state;
    this.now = now;
  }

  /**
   * `item`: the item the expression belongs to (a per-item step, action or
   * field), read as `item.<field>`; a per-item action's result is then that
   * item's.
   */
  env(extra: { payload?: JsonValue; value?: JsonValue; resource?: JsonValue } = {}, item?: string): EvalEnv {
    const s = this.state;
    const of = (name: string) => (item !== undefined && this.flow.actions.get(name)?.forEach !== undefined ? item : undefined);
    const env: EvalEnv = {
      fact: (name) => readable(own(s.facts, name)),
      isKnown: (name) => own(s.facts, name)?.status === "valid",
      result: (name) => {
        const res = this.currentResult(name, of(name));
        return res && res.status === "ok" ? { known: true, value: res.output ?? null } : { known: false };
      },
      isFailed: (name) => this.currentResult(name, of(name))?.status === "failed",
      env: (name) => s.env[name],
      now: this.now,
      ...extra,
    };
    if (this.flow.collections.size > 0) {
      env.collection = (name, fields) => {
        const c = this.flow.collections.get(name);
        return c ? readList(s, c, fields) : { known: false };
      };
      env.self = (field) => (item === undefined ? { known: false } : readSelf(s, item, field));
      env.items = (name) => {
        const c = this.flow.collections.get(name);
        return c ? readRows(s, c) : [];
      };
    }
    return env;
  }

  eval(node: Parameters<typeof evaluate>[0], extra?: { payload?: JsonValue; value?: JsonValue; resource?: JsonValue }, item?: string): Evaluated {
    return evaluate(node, this.env(extra, item));
  }

  /** The action's input as it would be sent now (for a per-item action, for `item`). */
  currentInput(action: CompiledAction, item?: string): Evaluated {
    return evaluateRecord(action.call.input, this.env({}, item));
  }

  /** The action's latest result (`name[item]` for a per-item action) if it was produced from the current input. */
  currentResult(name: string, item?: string): ResultState | undefined {
    const res = own(this.state.results, keyOf(name, item));
    const action = this.flow.actions.get(name);
    if (!res || !action) return undefined;
    const input = this.currentInput(action, item);
    if (!input.known) return undefined;
    return fingerprint(input.value) === res.fingerprint ? res : undefined;
  }

  /**
   * Facts that may not change now: they feed a write in flight or one already
   * committed. With collections the set holds addresses: a collection's name
   * locks its membership, `c.f` that field of every item, `c[i].f` one
   * item's field and `c[i]` the item itself. A per-item write locks the
   * fields it reads of its own item, and the item.
   */
  lockedFacts(): Set<string> {
    const locked = new Set<string>();
    const lock = (actionName: string, item?: string) => {
      const ownFields = item === undefined ? undefined : this.flow.upstreamOwn.get(actionName);
      for (const f of this.flow.upstreamFacts.get(actionName) ?? []) {
        const t = ownFields?.has(f) ? splitTemplate(f) : null;
        locked.add(t ? fieldAddress(t.collection, item!, t.field) : f);
      }
      const collection = item === undefined ? undefined : this.flow.actions.get(actionName)?.forEach;
      if (collection !== undefined) locked.add(keyOf(collection, item));
    };
    for (const [key, res] of Object.entries(this.state.results)) {
      const name = nameOfKey(key);
      const action = this.flow.actions.get(name);
      if (!action || action.def.effect !== "write") continue;
      const item = action.forEach !== undefined ? itemOfKey(key) : undefined;
      if (isBusy(res)) lock(name, item);
      else if (res.status === "ok" && action.commitPoint) lock(name, item);
    }
    for (const res of Object.values(this.state.resources)) {
      if (res.status === "committed") lock(res.action, res.item);
    }
    // A live call's inputs; a committed call's inputs and answers, for good.
    for (const [callId, call] of Object.entries(this.state.calls ?? {})) {
      if (call.retired) continue;
      const committed = call.status === "ended" && call.end?.committed === true;
      if (!LIVE_CALL.has(call.status) && !committed) continue;
      for (const f of this.flow.callUpstream.get(call.key) ?? []) locked.add(f);
      if (committed && callId !== this.settlingCall) for (const f of this.flow.stepById.get(call.key)?.fills ?? []) locked.add(f);
    }
    return locked;
  }

  /** Whether the action's result is still being worked on; for a per-item action, any item's. */
  anyBusy(name: string): boolean {
    if (this.flow.actions.get(name)?.forEach === undefined) return isBusy(own(this.state.results, name));
    const prefix = `${name}[`;
    return Object.entries(this.state.results).some(([key, res]) => key.startsWith(prefix) && isBusy(res));
  }

  writesInFlight(): boolean {
    for (const effect of Object.values(this.state.inflight)) {
      if (effect.purpose === "compensate") return true;
      const action = this.flow.actions.get(effect.action);
      if (action?.def.effect === "write") return true;
    }
    // A release still waiting for room under the in-flight cap is a write to come.
    return this.releasesQueued();
  }

  /** Whether a release waits for room under the in-flight cap. */
  releasesQueued(): boolean {
    return Object.values(this.state.resources).some((r) => r.releaseQueued === true);
  }

  /** Whether `when` holds: true, false or unknown (with what is missing). `item`: the instance of a per-item step. */
  applies(step: CompiledStep, item?: string): Evaluated {
    return step.when ? this.eval(step.when, undefined, item) : { known: true, value: true };
  }

  /**
   * The state of a fact a step names in `needs` or `fills`: a fact, a list,
   * or (in a per-item step) `collection.field` of the step's item.
   */
  private named(name: string, item: string | undefined): FactState | undefined {
    if (item === undefined || !name.includes(".")) return own(this.state.facts, name);
    return fieldState(this.state, item, splitTemplate(name)?.field ?? "");
  }

  /** Where the step stands; for a per-item step, its instance for `item`. */
  stepStatus(step: CompiledStep, item?: string): StepStatus {
    const s = this.state;
    const missingNeeds = step.needs.filter((n) => !readable(this.named(n, item)).known);
    if (missingNeeds.length > 0) {
      const facts = item === undefined ? missingNeeds : missingNeeds.map((n) => (n.includes(".") ? fieldAddress(step.forEach!, item, splitTemplate(n)!.field) : n));
      return { kind: "blocked", missing: { facts, results: [] } };
    }
    const fillsDone = step.fills.every((f) => {
      const st = this.named(f, item)?.status;
      return st === "valid" || st === "declined";
    });
    if (step.wait) {
      if (fillsDone) return { kind: "complete" };
      const key = this.eval(step.wait.correlate);
      if (!key.known) return { kind: "blocked", missing: key.missing };
      return { kind: "wait", key: canonicalJson(key.value) };
    }
    if (step.call) {
      if (fillsDone) return { kind: "complete" };
      const input = this.callInput(step);
      if (!input.known) return { kind: "blocked", missing: input.missing };
      const fp = fingerprint(input.value);
      const latest = this.latestCall(step.id);
      if (latest && latest[1].fingerprint === fp && latest[1].epoch === (own(s.epochs, step.id) ?? 0)) {
        const [callId, call] = latest;
        if (call.status !== "ended") return { kind: "calling", callId, call };
        if (call.end?.kind === "completed") return { kind: "failed", error: { code: "flow/call-output-invalid", message: "The answer could not be used." } };
        return { kind: "failed", error: callError(call) };
      }
      return { kind: "call", input: input.value as JsonObject, fingerprint: fp };
    }
    if (step.run !== undefined) {
      const action = this.flow.actions.get(step.run)!;
      if (!fillsDone) return { kind: "ask" };
      const input = this.currentInput(action, item);
      if (!input.known) return { kind: "blocked", missing: input.missing };
      const fp = fingerprint(input.value);
      const key = keyOf(action.name, item);
      const res = own(s.results, key);
      if (res && res.fingerprint === fp) {
        if (res.status === "ok") return { kind: "complete" };
        if (res.status === "failed") return { kind: "failed", action, error: res.error ?? { code: "failed", message: "The action failed." } };
        if (res.status === "in_doubt") return { kind: "attention", action };
        return { kind: "working", action };
      }
      if (res && action.def.effect === "write" && isBusy(res)) {
        return res.status === "in_doubt" ? { kind: "attention", action } : { kind: "working", action };
      }
      const inputObj = input.value as JsonObject;
      if (action.risk !== "none") {
        // A per-item action's digest names its item, so one item's confirmation never covers another's.
        const digest = confirmDigest(key, inputObj, s.nonce);
        const conf = own(s.confirmations, key);
        // A review past its time to live no longer covers a new dispatch: ask again.
        if (!conf || conf.digest !== digest || (conf.notAfter !== undefined && conf.notAfter <= this.now)) return { kind: "confirm", action, input: inputObj, digest };
      }
      return { kind: "run", action, input: inputObj, fingerprint: fp };
    }
    return fillsDone ? { kind: "complete" } : { kind: "ask" };
  }

  /** A call step's input as it would be sent now. */
  callInput(step: CompiledStep): Evaluated {
    return evaluateRecord(step.call!.input, this.env());
  }

  /** The newest call of a step that is still its own (not retired). */
  latestCall(stepId: string): [string, CallState] | undefined {
    let best: [string, CallState] | undefined;
    for (const [callId, call] of Object.entries(this.state.calls ?? {})) {
      if (call.key !== stepId || call.retired) continue;
      if (!best || callSeq(callId) > callSeq(best[0])) best = [callId, call];
    }
    return best;
  }

  /** A call whose child is running: cancelling the run means cancelling the child first. */
  callRunning(): boolean {
    return Object.values(this.state.calls ?? {}).some((c) => c.status === "running");
  }

  /**
   * The run committed: a commit-point write applied, a hold became final, or
   * a child run committed. What it did stays done, so it cannot be cancelled.
   */
  isCommitted(): boolean {
    if (Object.values(this.state.resources).some((r) => r.status === "committed")) return true;
    return this.passedCommitPoint();
  }

  /**
   * A commit point the run passed, or a call it made that committed: what a
   * child reports to its caller as `committed`. Holds made final do not count.
   */
  passedCommitPoint(): boolean {
    const s = this.state;
    // A per-item action's results are keyed `name[item]`.
    for (const [key, res] of Object.entries(s.results)) {
      if (res.status === "ok" && this.flow.actions.get(nameOfKey(key))?.commitPoint) return true;
    }
    return Object.values(s.calls ?? {}).some((c) => c.end?.committed === true);
  }

  /** Why `actor` may not cancel the run now, or null when they may. */
  cancelProblem(actor: ActorRef): [string, string] | null {
    const isStaff = actor.roles.some((r) => this.flow.staffRoles.includes(r));
    if (actor.kind !== "system" && actor.kind !== "workload" && !isStaff && this.state.subject && !this.isSubject(actor)) {
      return ["flow/forbidden", "Only the person this belongs to can cancel it."];
    }
    if (this.isCommitted()) return ["flow/committed", "This can no longer be cancelled."];
    if (this.commitBusy()) return ["flow/busy", "This is being completed right now and cannot be cancelled."];
    return null;
  }

  /** Without step rules: the run's own person, staff, or a trusted workload. */
  canAnswerDefault(actor: ActorRef): boolean {
    const subject = this.state.subject;
    if (actor.kind === "system" || actor.kind === "workload") return true;
    if (subject === null || subject.id === actor.id || actor.for === subject.id) return true;
    return actor.roles.some((r) => this.flow.staffRoles.includes(r));
  }

  /** The actor is the run's person, or acts on their behalf. */
  isSubject(actor: ActorRef): boolean {
    const subject = this.state.subject;
    return subject !== null && (subject.id === actor.id || actor.for === subject.id);
  }

  /**
   * A commit-point write is under way or its outcome is unknown: the run must
   * not end or change course. A write waiting to retry that certainly was not
   * applied does not count; ending drops it unsent.
   */
  commitBusy(): boolean {
    for (const [key, res] of Object.entries(this.state.results)) {
      if (!this.flow.actions.get(nameOfKey(key))?.commitPoint || !isBusy(res)) continue;
      if (res.status === "retry_wait" && !res.maybeApplied) continue;
      return true;
    }
    return false;
  }

  /** The run is paused because holds lapsed while its person was away. */
  paused(): boolean {
    return (this.state.lapsed?.length ?? 0) > 0;
  }

  canAnswer(step: CompiledStep, actor: ActorRef): boolean {
    if (!step.actor) return this.canAnswerDefault(actor);
    if (step.actor.roles.length > 0 && !actor.roles.some((r) => step.actor!.roles.includes(r))) return false;
    if (step.actor.notSubject && this.isSubject(actor)) return false;
    return true;
  }

  /**
   * Why `actor` may not give `name` directly (rather than through a step's
   * output), or null when they may. Some step that asks for it must let this
   * actor answer, apply now, and be current if it names roles; when that
   * step's rules set only fixed values, `value` must be one of them. Entry
   * facts are exempt when starting, and whenever no step asks for them.
   */
  directProblem(name: string, actor: ActorRef, starting: boolean, value?: Read, item?: string): [string, string] | null {
    const t = name.includes(".") ? splitTemplate(name) : null;
    const fact = t ? this.flow.collections.get(t.collection)?.fields.get(t.field) : this.flow.facts.get(name);
    const title = fact?.def.title ?? name;
    if (!fact || fact.derive) return ["flow/fact-not-allowed", `"${title}" cannot be given directly`];
    const asks = this.flow.askedBy.get(name) ?? [];
    // An item's fields belong to the list given at the start, when the list is an entry fact.
    if (this.flow.entry.has(t ? t.collection : name) && (starting || asks.length === 0)) {
      return this.canAnswerDefault(actor) ? null : ["flow/forbidden", `you cannot answer "${title}"`];
    }
    let problem: [string, string] = ["flow/fact-not-allowed", `"${title}" cannot be given directly`];
    for (const ask of asks) {
      const step = this.flow.stepById.get(ask.stepId)!;
      if (!this.canAnswer(step, actor)) {
        problem = ["flow/forbidden", `you cannot answer "${title}"`];
        continue;
      }
      // The asking step's instance for the item (a per-item step), or the step itself.
      const at = step.forEach !== undefined ? item : undefined;
      if (step.forEach !== undefined && (at === undefined || !isLiveItem(this.state, step.forEach, at))) {
        problem = ["flow/step-not-active", `"${title}" is not asked for here.`];
        continue;
      }
      if (step.actor && step.actor.roles.length > 0 && !this.isCurrent(step, at)) {
        problem = ["flow/step-not-active", `"${title}" can only be answered at its own step.`];
        continue;
      }
      const applies = this.applies(step, at);
      if (!applies.known || !truthy(applies.value)) {
        problem = ["flow/step-not-active", `"${title}" is not asked for here.`];
        continue;
      }
      if (value && ask.values && !(value.known && ask.values.some((v) => jsonEqual(v, value.value)))) {
        problem = ["flow/fact-not-allowed", `"${title}" cannot take that value here.`];
        continue;
      }
      return null;
    }
    return problem;
  }

  /** The step (for a per-item step, its instance for `item`) is the current one. */
  isCurrent(step: CompiledStep, item?: string): boolean {
    return this.state.current === step.id && (step.forEach === undefined || this.state.currentItem === item);
  }

  /**
   * A step may be answered when it is current, or when it was answered
   * before (to change an earlier answer) and still applies with its needs known.
   * A per-item step is answered for one item at a time.
   */
  isAnswerable(step: CompiledStep, item?: string): boolean {
    if (this.isCurrent(step, item)) return true;
    const w = this.applies(step, item);
    if (!w.known || !truthy(w.value)) return false;
    if (!step.needs.every((n) => readable(this.named(n, item)).known)) return false;
    if (step.fills.some((f) => (this.named(f, item)?.status ?? "missing") !== "missing")) return true;
    return this.stepStatus(step, item).kind === "complete";
  }

  /** Facts downstream of a node, following fact-to-fact edges and, when asked, through actions. */
  factsDownstream(start: string, throughActions: boolean): Set<string> {
    const out = new Set<string>();
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const next of this.flow.dependents.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (next.startsWith("f:")) {
          out.add(next.slice(2));
          queue.push(next);
        } else if (throughActions) queue.push(next);
      }
    }
    return out;
  }
}

export { actionNode, factNode };
