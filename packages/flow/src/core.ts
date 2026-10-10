/**
 * The pure core: `step(flow, state, event)` returns the next state, the
 * effects to perform and any notices, without I/O, clocks or randomness.
 * Time comes from the event, ids are derived from the state, and action
 * results arrive as recorded events, so replaying a run's events rebuilds
 * its state exactly.
 *
 * Rejected events leave the state untouched and say why. Events that change
 * nothing (a duplicate result, a stale timer) are accepted as no-ops so
 * retries are always safe.
 */

import { keyOf } from "./address.js";
import { isParentLink } from "./calls.js";
import { type CompiledFlow } from "./compile.js";
import { checkInputOps, startCollections } from "./core-items.js";
import { bumpRows } from "./core-items-stale.js";
import { fingerprint } from "./hash.js";
import { cloneJson, hasOwn, own, type JsonValue } from "./json.js";
import { callError, RunReader } from "./reader.js";
import { eventShapeProblem } from "./event-shape.js";
import {
  CORE_VERSION,
  EVENT_VERSION,
  isTerminal,
  RUN_STATE_VERSION,
  type ActionSettledEvent,
  type CallState,
  type FactState,
  type FlowEffect,
  type FlowEvent,
  type FlowEventType,
  type Notice,
  type RunMigratedEvent,
  type RunStartedEvent,
  type RunState,
} from "./state.js";
import { acceptCallInput, callLive, callsCancelling, startCall, sendCallStart, onCallStarted, resendCall, onCallTimeout, onCallSettled, onCallCancelled, retireCall, releaseStaleCalls, endCalls, abandonCall, pruneCalls, contributorsOf, inheritedContributors, suppliedThroughCalls, emitReturn } from "./core/calls.js";
import { advance, startRun, causeOfEvent, startEffect, frozenInput, releaseStale, release, sendRelease, sendQueuedReleases, commitHolds, complete, beginEnd, dropUnsentWrites, expireHolds, feedsBusyWrite, pruneResources, windDown, dropReads, closeAll } from "./core/advance.js";
import { systemRule, applyRule, suppliedInput, applyFacts, putFact, invalidateFrom, settleFacts, recomputeDerived, mayFill, mayResume, assertCanAnswer } from "./core/facts.js";
import { onSettled, onDisputed, onLate, lateReport, settleRun, reconcileOrDoubt, dropReconcile, retryOrFail, failResult, markInDoubt, settleReconcile, settleCompensation, onResolved } from "./core/settle.js";
import { onOutput, onInput, fillPolicy, propose, onAnswers, undoTurn, restoreFact, applyGated, gateProblem, title, snapshot, restore, trackers } from "./core/input.js";
import { resume, onCancel, onErase, onRevoked, moved, onTimer, resend, onExternal, openWait, closeWait, setTimer, cancelTimer } from "./core/lifecycle.js";

export interface Rejection {
  code: string;
  message: string;
  facts?: string[];
}

export interface StepTrace {
  event: FlowEventType;
  before: string | null;
  after: string | null;
  factsChanged: string[];
  factsCleared: string[];
  effects: string[];
  rejected?: string;
}

export interface StepAccepted {
  accepted: true;
  /** The next state; the input state itself when nothing changed. */
  state: RunState;
  /** Whether the state changed and must be stored with the event. */
  changed: boolean;
  effects: FlowEffect[];
  notices: Notice[];
  trace: StepTrace;
}

export interface StepRejected {
  accepted: false;
  /** The unchanged input state (null when a start was refused). */
  state: RunState | null;
  changed: false;
  rejection: Rejection;
  effects: [];
  notices: [];
  trace: StepTrace;
}

export type StepResult = StepAccepted | StepRejected;

const RECENT_REQUESTS = 32;
const MAX_NOTICES = 20;
/** Released and expired resources kept for the record; older ones are dropped. */
export const MAX_ENDED_RESOURCES = 8;
/** Abandoned calls kept for the record; older ones are dropped. */
export const MAX_ENDED_CALLS = 8;
export const MAX_DIGEST_LENGTH = 256;
const MAX_NONCE_LENGTH = 128;
/** Longest message a move or a revocation shows the person. */
export const MAX_UPDATE_MESSAGE = 500;
/** Settlements and timers may exceed maxEvents by this much before the run is failed. */
const SYSTEM_EVENT_SLACK = 1000;

export class Reject extends Error {
  readonly rejection: Rejection;
  constructor(code: string, message: string, facts?: string[]) {
    super(message);
    this.rejection = { code, message, ...(facts && facts.length > 0 ? { facts } : {}) };
  }
}

export const reject = (code: string, message: string, facts?: string[]): never => {
  throw new Reject(code, message, facts);
};

/** Advances a run by one event. Pure and deterministic. */
export function step(flow: CompiledFlow, state: RunState | null, event: FlowEvent): StepResult {
  const before = state?.current ?? null;
  // A malformed event is refused below; its trace names what type it claims, if any.
  const baseTrace: StepTrace = { event: (event as Partial<FlowEvent> | null)?.type as FlowEvent["type"], before, after: before, factsChanged: [], factsCleared: [], effects: [] };
  try {
    const malformed = eventShapeProblem(event);
    if (malformed !== null) reject("flow/invalid-event", malformed);
    if (event.v !== EVENT_VERSION) reject("flow/event-version", `unsupported event version ${String(event.v)}`);
    if (event.type === "run.started") {
      if (state) reject("flow/already-started", "the run has already started");
      if (event.core !== undefined && event.core !== CORE_VERSION) reject("flow/core-version", `the run must start under core rules ${CORE_VERSION}, the only rules this engine has`);
      const machine = new Machine(flow, initialState(flow, event), event);
      machine.start(event);
      return machine.finish(before);
    }
    if (!state) return reject("flow/not-started", "the run has not started");
    if (state.v !== RUN_STATE_VERSION) reject("flow/state-version", `unsupported run state version ${String(state.v)}`);
    if (state.core !== undefined && state.core !== CORE_VERSION) reject("flow/core-version", `the run's core rules are ${String(state.core)}, not this engine's ${CORE_VERSION}`);
    if (state.flowId !== flow.id || state.flowVersion !== flow.version) {
      reject("flow/version-mismatch", `run uses ${state.flowId}@${state.flowVersion}, not ${flow.id}@${flow.version}`);
    }
    if (event.requestId !== undefined && state.recent.includes(event.requestId)) {
      return { state, accepted: true, changed: false, effects: [], notices: [], trace: baseTrace };
    }
    const machine = new Machine(flow, structuredClone(state), event);
    const handled = machine.handle();
    if (!handled) return { state, accepted: true, changed: false, effects: [], notices: [], trace: baseTrace };
    return machine.finish(before);
  } catch (error) {
    if (error instanceof Reject) {
      return {
        state,
        accepted: false,
        changed: false,
        rejection: error.rejection,
        effects: [],
        notices: [],
        trace: { ...baseTrace, rejected: error.rejection.code },
      };
    }
    throw error;
  }
}

/** The sequence number in an effect id (`${runId}.${n}`), for ordering effects by when they began. */
export function effectNumber(effectId: string): number {
  const n = Number(effectId.slice(effectId.lastIndexOf(".") + 1));
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

function initialState(flow: CompiledFlow, event: RunStartedEvent): RunState {
  const state: RunState = {
    v: RUN_STATE_VERSION,
    runId: event.runId,
    flowId: event.flowId,
    flowVersion: event.flowVersion,
    flowHash: event.flowHash,
    scope: { ...event.scope },
    subject: event.subject ? { id: event.subject.id } : null,
    env: { ...event.env },
    status: "active",
    revision: 0,
    createdAt: event.at,
    updatedAt: event.at,
    lastInputAt: event.at,
    turns: 0,
    effectSeq: 0,
    facts: Object.fromEntries([...flow.facts.keys()].map((name) => [name, { status: "missing", rev: 0 } satisfies FactState])),
    results: {},
    outputs: {},
    resources: {},
    inflight: {},
    confirmations: {},
    timers: {},
    waits: {},
    epochs: {},
    current: null,
    notices: [],
    recent: [],
    attention: [],
    core: CORE_VERSION,
    ...(typeof event.nonce === "string" && event.nonce.length > 0 && event.nonce.length <= MAX_NONCE_LENGTH ? { nonce: event.nonce } : {}),
    // Checked in start(); a run with a malformed link is refused there.
    ...(event.parent !== undefined && isParentLink(event.parent) ? { parent: structuredClone(event.parent) } : {}),
  };
  if (flow.collections.size > 0) startCollections(flow, state);
  return state;
}

const PERSON_EVENTS = new Set<FlowEventType>(["output", "facts.input", "run.cancelled", "run.resumed"]);

/** The single instance of a step that does not run once per item. */
export const NO_ITEM: readonly undefined[] = [undefined];

/** Marks a fact to be cleared (as opposed to set to the JSON value null). */
export const CLEAR: unique symbol = Symbol("clear");
export type FactWrite = JsonValue | typeof CLEAR;

export { fillModeOf } from "./fill.js";

/**
 * Whether `path` names a value present in `payload`: a missing key does not,
 * and null counts as present, at the end or on the way (`{c: null}` sends
 * `c.nick` as null, so a rule that reads it clears its fact).
 */
export function payloadHas(payload: JsonValue, path: readonly (string | number)[]): boolean {
  let at: JsonValue | undefined = payload;
  for (const seg of path) {
    if (at === null) return true;
    if (typeof at !== "object") return false;
    if (Array.isArray(at)) {
      if (typeof seg !== "number" || seg < 0 || seg >= at.length) return false;
      at = at[seg];
    } else {
      if (!hasOwn(at, String(seg))) return false;
      at = (at as Record<string, JsonValue>)[String(seg)];
    }
  }
  return at !== undefined;
}

/** A fact's state as an undo puts it back: without the assistant's mark or suggestion of its own. */
export function bare(st: FactState): FactState {
  const { assist: _a, proposed: _p, ...rest } = cloneJson(st as unknown as JsonValue) as unknown as FactState;
  return rest;
}

export class Machine extends RunReader {
  readonly event: FlowEvent;
  readonly effects: FlowEffect[] = [];
  readonly notices: Notice[] = [];
  // Facts are named by their address: a fact, a list, or an item's field (`c[i].f`).
  /** Facts whose readable value changed in this event. */
  readonly changed = new Set<string>();
  /** Facts set by this event; never cleared by its own invalidation. */
  readonly fresh = new Set<string>();
  readonly cleared = new Set<string>();
  /** Facts a person or model restated unchanged in this event; never cleared by its invalidation. */
  readonly restated = new Set<string>();
  /** Steps (`step[item]` for a per-item step) whose view epoch this event already bumped. */
  readonly bumped = new Set<string>();
  /** Item fields whose shown value changed in this event. */
  readonly rows = new Set<string>();
  /** Item fields an output's own rule wrote exactly as its view gave them. */
  readonly ownRows = new Set<string>();
  readonly rev: number;
  /** the status each value the fill policy let through is written with. */
  readonly assisting = new Map<string, "valid" | "needs_confirmation">();
  /** values a person accepted, written as theirs with the event's facts. */
  readonly accepted: Array<[string, FactWrite]> = [];
  /** a suggestion or an undo changed the state without writing a value. */
  assistChanged = false;
  /** The run was live before this event: a child reports its end when it stops being live. */
  readonly wasLive: boolean;

  constructor(flow: CompiledFlow, state: RunState, event: FlowEvent) {
    super(flow, state, event.at);
    this.event = event;
    this.rev = state.revision + 1;
    this.wasLive = !isTerminal(state.status);
  }

  /**
   * Answers a call's end. A tree cancellation travels up to the run it names;
   * otherwise the step's rule for the end applies (completed, timeout, or the
   * end's kind). Without one, a cancelled child cancels its caller (the
   * person asked for that) and any other end leaves the step failed, so its
   * view can offer to try again.
   */
  callEnded(callId: string, call: CallState): void {
    const s = this.state;
    const end = call.end!;
    const output = end.output;
    delete end.output; // it lives in the call.settled event, not the state
    if (end.cascade !== undefined && end.kind === "cancelled" && !this.isCommitted()) {
      this.beginEnd("cancelled", "cascade", end.cascade !== s.runId ? end.cascade : undefined);
      return;
    }
    if (end.committed && end.kind !== "completed" && call.cancelReason === "timeout") {
      // The caller stopped waiting, but a commit in flight went through: no `timeout` rule undoes what stays done.
      if (!s.attention.includes(callId)) s.attention.push(callId);
      this.note("flow/call-orphaned-commit", "Something finished after it was no longer needed. Someone will check.");
      this.pruneCalls();
      return;
    }
    const step = this.flow.stepById.get(call.key);
    const name = end.kind === "completed" ? "completed" : call.cancelReason === "timeout" ? "timeout" : end.kind;
    const rule = step?.rules.get(name);
    if (step && rule) {
      const payload: JsonValue = end.kind === "completed" ? (output ?? {}) : { kind: end.kind, ...(end.reason !== undefined ? { reason: end.reason } : {}) };
      this.settlingCall = callId;
      try {
        this.systemRule(step, rule, payload);
      } finally {
        this.settlingCall = null;
      }
      this.pruneCalls();
      return;
    }
    if (end.kind === "cancelled" && call.cancelReason !== "timeout" && !this.isCommitted()) {
      this.beginEnd("cancelled", "call-cancelled");
      return;
    }
    this.note("flow/call-failed", callError(call).message);
    this.pruneCalls();
  }
}

/**
 * The machine's methods: functions over `this`, grouped by what they handle, and installed on
 * its prototype as class methods are (not enumerable).
 */
export interface Machine {
  start: typeof start;
  handle: typeof handle;
  finish: typeof finish;
  onOutput: typeof onOutput;
  onInput: typeof onInput;
  fillPolicy: typeof fillPolicy;
  propose: typeof propose;
  onAnswers: typeof onAnswers;
  undoTurn: typeof undoTurn;
  restoreFact: typeof restoreFact;
  applyGated: typeof applyGated;
  gateProblem: typeof gateProblem;
  title: typeof title;
  snapshot: typeof snapshot;
  restore: typeof restore;
  trackers: typeof trackers;
  resume: typeof resume;
  onCancel: typeof onCancel;
  onErase: typeof onErase;
  onRevoked: typeof onRevoked;
  moved: typeof moved;
  onSettled: typeof onSettled;
  onDisputed: typeof onDisputed;
  onLate: typeof onLate;
  lateReport: typeof lateReport;
  settleRun: typeof settleRun;
  reconcileOrDoubt: typeof reconcileOrDoubt;
  dropReconcile: typeof dropReconcile;
  retryOrFail: typeof retryOrFail;
  failResult: typeof failResult;
  markInDoubt: typeof markInDoubt;
  settleReconcile: typeof settleReconcile;
  settleCompensation: typeof settleCompensation;
  onTimer: typeof onTimer;
  resend: typeof resend;
  onExternal: typeof onExternal;
  systemRule: typeof systemRule;
  onResolved: typeof onResolved;
  applyRule: typeof applyRule;
  suppliedInput: typeof suppliedInput;
  applyFacts: typeof applyFacts;
  putFact: typeof putFact;
  invalidateFrom: typeof invalidateFrom;
  settleFacts: typeof settleFacts;
  recomputeDerived: typeof recomputeDerived;
  mayFill: typeof mayFill;
  mayResume: typeof mayResume;
  assertCanAnswer: typeof assertCanAnswer;
  advance: typeof advance;
  startRun: typeof startRun;
  causeOfEvent: typeof causeOfEvent;
  startEffect: typeof startEffect;
  frozenInput: typeof frozenInput;
  releaseStale: typeof releaseStale;
  release: typeof release;
  sendRelease: typeof sendRelease;
  sendQueuedReleases: typeof sendQueuedReleases;
  commitHolds: typeof commitHolds;
  complete: typeof complete;
  beginEnd: typeof beginEnd;
  dropUnsentWrites: typeof dropUnsentWrites;
  expireHolds: typeof expireHolds;
  feedsBusyWrite: typeof feedsBusyWrite;
  pruneResources: typeof pruneResources;
  windDown: typeof windDown;
  dropReads: typeof dropReads;
  closeAll: typeof closeAll;
  acceptCallInput: typeof acceptCallInput;
  callLive: typeof callLive;
  callsCancelling: typeof callsCancelling;
  startCall: typeof startCall;
  sendCallStart: typeof sendCallStart;
  onCallStarted: typeof onCallStarted;
  resendCall: typeof resendCall;
  onCallTimeout: typeof onCallTimeout;
  onCallSettled: typeof onCallSettled;
  onCallCancelled: typeof onCallCancelled;
  retireCall: typeof retireCall;
  releaseStaleCalls: typeof releaseStaleCalls;
  endCalls: typeof endCalls;
  abandonCall: typeof abandonCall;
  pruneCalls: typeof pruneCalls;
  contributorsOf: typeof contributorsOf;
  inheritedContributors: typeof inheritedContributors;
  suppliedThroughCalls: typeof suppliedThroughCalls;
  emitReturn: typeof emitReturn;
  openWait: typeof openWait;
  closeWait: typeof closeWait;
  setTimer: typeof setTimer;
  cancelTimer: typeof cancelTimer;
  bumpFor: typeof bumpFor;
  nextEffectId: typeof nextEffectId;
  refuse: typeof refuse;
  note: typeof note;
}

installMethods(Machine.prototype, { start, handle, finish, onOutput, onInput, fillPolicy, propose, onAnswers, undoTurn, restoreFact, applyGated, gateProblem, title, snapshot, restore, trackers, resume, onCancel, onErase, onRevoked, moved, onSettled, onDisputed, onLate, lateReport, settleRun, reconcileOrDoubt, dropReconcile, retryOrFail, failResult, markInDoubt, settleReconcile, settleCompensation, onTimer, resend, onExternal, systemRule, onResolved, applyRule, suppliedInput, applyFacts, putFact, invalidateFrom, settleFacts, recomputeDerived, mayFill, mayResume, assertCanAnswer, advance, startRun, causeOfEvent, startEffect, frozenInput, releaseStale, release, sendRelease, sendQueuedReleases, commitHolds, complete, beginEnd, dropUnsentWrites, expireHolds, feedsBusyWrite, pruneResources, windDown, dropReads, closeAll, acceptCallInput, callLive, callsCancelling, startCall, sendCallStart, onCallStarted, resendCall, onCallTimeout, onCallSettled, onCallCancelled, retireCall, releaseStaleCalls, endCalls, abandonCall, pruneCalls, contributorsOf, inheritedContributors, suppliedThroughCalls, emitReturn, openWait, closeWait, setTimer, cancelTimer, bumpFor, nextEffectId, refuse, note });

/** Defines each of `methods` on `proto` the way a class body does: writable, configurable, not enumerable. */
function installMethods(proto: object, methods: Record<string, (...args: never[]) => unknown>): void {
  for (const [name, value] of Object.entries(methods)) Object.defineProperty(proto, name, { value, writable: true, configurable: true, enumerable: false });
}

// --- entry points ----------------------------------------------------------

function start(this: Machine, event: RunStartedEvent): void {
  if (event.flowId !== this.flow.id || event.flowVersion !== this.flow.version) {
    reject("flow/version-mismatch", "start event names a different flow version");
  }
  this.setTimer("lifetime", event.at + this.flow.limits.maxLifetimeMs);
  this.setTimer("idle", event.at + this.flow.limits.idleTimeoutMs);
  const entries = Object.entries(event.facts);
  const called = event.source === "call" || event.parent !== undefined;
  const model = event.source === "model";
  // A called run starts from its interface's inputs only: its caller gives no item changes.
  if (called && event.items !== undefined) reject("flow/items-invalid", "A called run starts from its inputs only.");
  if (event.marks !== undefined && !model) reject("flow/invalid-event", "only a model's start carries assist marks");
  const ops = event.items !== undefined ? checkInputOps(this, event.items, model, true) : [];
  if (called) this.acceptCallInput(event, entries);
  else if (entries.length > 0 || ops.length > 0) {
    const values: Array<[string, FactWrite]> = [];
    for (const [name, value] of entries) {
      if (this.flow.facts.get(name)?.list) {
        if (!model) reject("flow/collection-needs-items", `"${name}" is a list: start it with items`, [name]);
        this.note("flow/fact-ignored", `"${name}" was not used.`, [name]);
        continue;
      }
      const allowed = (this.flow.entry.has(name) || this.flow.facts.get(name)?.userFillable === true) && this.mayFill(name);
      if (!allowed) {
        if (event.source === "entry") reject("flow/fact-not-allowed", `"${name}" cannot be supplied when starting`, [name]);
        this.note("flow/fact-ignored", `"${name}" was not used.`, [name]);
        continue;
      }
      values.push([name, value]);
    }
    // A model's facts that start a run go through the fill policy too (ADR 0012).
    const writes = model ? this.fillPolicy(values, event.marks ?? {}) : values;
    this.applyGated(writes, event.source === "model" ? "model" : "entry", event.source === "model" ? "lenient" : "strict", ops);
  }
  // A lenient restore replaces the state object, so write to the current one.
  this.state.lastInputAt = event.at;
  this.settleFacts();
  this.advance();
}

/** Returns false when the event changes nothing. */
function handle(this: Machine): boolean {
  const s = this.state;
  const ev = this.event;
  const person = PERSON_EVENTS.has(ev.type);
  if (isTerminal(s.status) || s.status === "cancelling") {
    if (person) reject("flow/run-ended", s.status === "cancelling" ? "This is being cancelled." : "This has already finished.");
  }
  // Cancelling is always allowed, so a person can let go of what they hold.
  const cancels = ev.type === "run.cancelled" || (ev.type === "output" && this.flow.stepById.get(ev.stepId)?.rules.get(ev.name)?.cancel === true);
  const counted = person && !cancels;
  if (counted) {
    if (s.pendingEnd) reject("flow/run-ending", "This is finishing now.");
    if (s.turns + 1 > this.flow.limits.maxTurns) reject("flow/limit", "Too many inputs for this run.");
    if (s.revision + 1 > this.flow.limits.maxEvents) reject("flow/limit", "This run has too many events.");
  }
  if (ev.type === "run.resumed" && !this.mayResume(ev.actor)) reject("flow/forbidden", "You cannot continue this run.");
  // A person coming back to a paused run picks it up again.
  const resumed = counted && this.paused();
  if (resumed) this.resume();
  let changed: boolean;
  switch (ev.type) {
    case "output":
      this.onOutput(ev);
      changed = true;
      break;
    case "facts.input":
      changed = this.onInput(ev);
      break;
    case "action.settled":
      changed = this.onSettled(ev);
      break;
    case "timer.fired":
      changed = this.onTimer(ev);
      break;
    case "external":
      changed = this.onExternal(ev);
      break;
    case "run.cancelled":
      if (ev.erase !== undefined) this.onErase(ev.erase);
      else this.onCancel(ev.reason ?? "cancelled", ev.cascade);
      changed = true;
      break;
    case "effect.resolved":
      changed = this.onResolved(ev);
      break;
    case "call.started":
      changed = this.onCallStarted(ev);
      break;
    case "call.settled":
      changed = this.onCallSettled(ev);
      break;
    case "call.cancelled":
      changed = this.onCallCancelled(ev);
      break;
    case "run.resumed":
      changed = resumed;
      break;
    case "run.revoked":
      changed = this.onRevoked(ev);
      break;
    case "run.migrated":
      return reject("flow/migration-step", "A move to another version is applied with migrateStep, which needs both versions.");
    default:
      return reject("flow/unknown-event", "unknown event type");
  }
  if (!changed && !resumed) return false;
  // A lenient restore may have replaced the state object; count against the current one.
  const after = this.state;
  if (person) {
    after.turns += 1;
    after.lastInputAt = ev.at;
    // The person has seen what a move or a revocation changed.
    if (after.update !== undefined) delete after.update;
    if (!isTerminal(after.status)) this.setTimer("idle", ev.at + this.flow.limits.idleTimeoutMs);
  }
  if (!person && after.revision + 1 > this.flow.limits.maxEvents + SYSTEM_EVENT_SLACK && !isTerminal(after.status)) {
    this.beginEnd("failed", "event-limit");
  }
  this.settleFacts();
  this.advance();
  return true;
}

function finish(this: Machine, before: string | null): StepAccepted {
  const s = this.state;
  if (this.rows.size > 0) bumpRows(this);
  // A child tells its caller exactly once, when it stops being live.
  if (s.parent && this.wasLive && isTerminal(s.status)) this.emitReturn();
  s.revision = this.rev;
  s.updatedAt = this.event.at;
  s.notices = this.notices.slice(0, MAX_NOTICES);
  if (this.event.requestId !== undefined) {
    s.recent = [...s.recent, this.event.requestId].slice(-RECENT_REQUESTS);
  }
  return {
    state: s,
    accepted: true,
    changed: true,
    effects: this.effects,
    notices: s.notices,
    trace: {
      event: this.event.type,
      before,
      after: s.current,
      factsChanged: [...this.fresh],
      factsCleared: [...this.cleared],
      effects: this.effects.map((e) => (e.kind === "action" ? `action:${e.purpose}:${e.name}` : e.kind.startsWith("call.") ? `call:${e.kind.slice(5)}` : e.kind)),
    },
  };
}

/**
 * Gives the step that fills `fact` a new view instance, once per event. For
 * an item's field (`fact` is `c.f`, with `item`) filled by a per-item step,
 * that is the step's instance for the item, keyed `step[item]`.
 */
function bumpFor(this: Machine, fact: string, item?: string): void {
  const stepId = this.flow.filledBy.get(fact);
  if (stepId === undefined) return;
  const key = item !== undefined && this.flow.stepById.get(stepId)?.forEach !== undefined ? keyOf(stepId, item) : stepId;
  if (this.bumped.has(key)) return;
  this.bumped.add(key);
  this.state.epochs[key] = (own(this.state.epochs, key) ?? 0) + 1;
}

function nextEffectId(this: Machine): string {
  return `${this.state.runId}.${++this.state.effectSeq}`;
}

/** Refuses the event (for the collection helpers in core-items.ts). */
function refuse(this: Machine, code: string, message: string, facts?: string[]): never {
  return reject(code, message, facts);
}

function note(this: Machine, code: string, message: string, facts?: string[], action?: string): void {
  if (this.notices.length >= MAX_NOTICES) return;
  this.notices.push({ code, message, ...(facts && facts.length > 0 ? { facts } : {}), ...(action !== undefined ? { action } : {}) });
}

/** What the migration planner hands the core to finish a move (see {@link settleMove}). */
export interface MoveInput {
  /** The current step before the move, for the trace. */
  before: string | null;
  /** Facts whose readable value differs from the value they carried over from. */
  changed: readonly string[];
  /** Facts whose cross-field checks run once every value is in place. */
  check: readonly string[];
  /** Whether an action kept its identity across the move. */
  sameAction(name: string): boolean;
  /** Timers of effects the move dropped. */
  cancelTimers: readonly string[];
  /** Deadlines the target's limits move. */
  rearm: ReadonlyArray<readonly [string, number]>;
  notice: Notice;
}

/**
 * Internal (for `migrate.ts`): finishes a move on a state the planner has
 * already carried over to `to` (its facts, results, outputs, resources,
 * inflight effects and confirmations as the plan keeps them, and its version,
 * hash, core, update and move count set). It gives every step a new view
 * epoch, clears what depended on the changed facts and recomputes derived
 * facts, runs the carried facts' checks, keeps only confirmations whose
 * action and exact input are unchanged, and moves the run on under `to`.
 */
export function settleMove(to: CompiledFlow, carried: RunState, event: RunMigratedEvent, move: MoveInput): StepResult {
  try {
    return new Machine(to, carried, event).moved(move);
  } catch (error) {
    if (!(error instanceof Reject)) throw error;
    const trace: StepTrace = { event: event.type, before: move.before, after: move.before, factsChanged: [], factsCleared: [], effects: [], rejected: error.rejection.code };
    return { state: carried, accepted: false, changed: false, rejection: error.rejection, effects: [], notices: [], trace };
  }
}

/** The event's `traceparent`, to record with the write it sets in motion (an optional field). */
export function traceOf(event: FlowEvent): { traceparent?: string } {
  return event.traceparent !== undefined ? { traceparent: event.traceparent } : {};
}

/**
 * The completion window the runtime recorded with a `pending` answer from the
 * action port (an optional event field), or undefined:
 * the pending timer then runs for the call's own `timeoutMs`.
 */
export function windowOf(ev: ActionSettledEvent): number | undefined {
  return ev.actor.kind === "system" && ev.outcome.status === "pending" ? ev.windowMs : undefined;
}

/** Exponential backoff with deterministic jitter derived from the effect id. */
export function backoff(retry: { baseMs: number; maxMs: number }, attempt: number, effectId: string, retryAfterMs?: number): number {
  const exp = Math.min(retry.maxMs, retry.baseMs * 2 ** Math.max(0, attempt - 1));
  const seed = fingerprint(`${effectId}#${attempt}`).charCodeAt(0);
  const jittered = Math.round(exp * (0.5 + (seed % 64) / 128));
  const wanted = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? Math.max(jittered, Math.min(retryAfterMs, 24 * 60 * 60 * 1000)) : jittered;
  return Math.max(1, wanted);
}
