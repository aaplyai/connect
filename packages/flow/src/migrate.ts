/**
 * Moving a live run to another version of its flow. Pure and deterministic.
 *
 * A move is one recorded event, `run.migrated`. The new state is a function
 * of the old state, the two compiled definitions and the event (its time and
 * message), so replay crosses versions through a resolver. The planner works
 * the move out by running it on a copy; `migrateStep` runs it again and
 * refuses the event unless the plan's fingerprint is the one the runtime
 * recorded (`planHash`).
 *
 * What carries over, in short (docs/runtime.md has the full rules):
 * - Facts by name, or through `rename`; each value is checked again under
 *   the new version's type, size limit and checks, and must have come the
 *   way the new version still lets the fact be set (the provenance rule).
 *   `reask` asks again with a prefill, `drop` carries nothing, and a secret
 *   never carries into a fact that is not secret.
 * - Results, holds and confirmations only while their action keeps its
 *   identity; a confirmation also only for the exact input it covered.
 * - Waits stay open, deadlines follow the new limits, and every step gets a
 *   new view epoch (a per-item step, one per item).
 * - Collections by name, item by item, each field under the fact rules at its
 *   own address (`migrate-items.ts`); what is keyed by an item carries only
 *   with its item.
 *
 * A run moves only when nothing is half done: no write in flight or in
 * doubt, nothing committed, no end under way, no live call.
 */

import { deepFreeze, frozenSet } from "@aaply/action-contract/internal";
import { nameOfKey } from "./address.js";
import { actionNode, CALL_END_RULES, type CompiledFlow, type CompiledStep } from "./compile.js";
import { MAX_UPDATE_MESSAGE, settleMove, type MoveInput, type Rejection, type StepAccepted, type StepResult, type StepTrace } from "./core.js";
import type { Diagnostic } from "./diagnostics.js";
import { eventShapeProblem } from "./event-shape.js";
import { fingerprint } from "./hash.js";
import { canonicalJson, cloneJson, formatPath, jsonByteLength, jsonEqual, jsonPointer, own, type JsonValue, type PathSegment } from "./json.js";
import { carriedKey, carryItems, listsAskedAgain, staleTemplate, TOO_LARGE, type CarriedItems } from "./migrate-items.js";
import type { CompiledMigration } from "./migration-def.js";
import { readable, RunReader } from "./reader.js";
import { validateValue } from "./schema.js";
import { CORE_VERSION, EVENT_VERSION, isTerminal, RUN_STATE_VERSION, type Confirmation, type FactState, type Provenance, type RunMigratedEvent, type RunState, type RunStatus, type VersionRef } from "./state.js";

/** Most moves one run may make; also stops a rollback and roll-forward from bouncing a run. */
export const MAX_MOVES_PER_RUN = 16;

/** Blockers that may clear as the run moves on: a sweep retries them later. */
export const TEMPORARY_BLOCKERS: ReadonlySet<string> = frozenSet([
  "flow/migrate-busy",
  "flow/migrate-in-doubt",
  "flow/migrate-ending",
  "flow/migrate-holds",
  "flow/migrate-waiting",
  "flow/migrate-child",
]);

/** The error code of the outcome recorded for an effect a revoked version's run never sent. */
export const REVOKED_CODE = "flow/version-revoked";

/** Whether a blocker may clear by itself (a write settling, a hold released); the others never will. */
export function isTemporaryBlocker(code: string): boolean {
  return TEMPORARY_BLOCKERS.has(code);
}

/** What happened to one fact of the target version. */
export type FactOutcome = "kept" | "renamed" | "reasked" | "dropped" | "invalid" | "derived" | "new";

/** A move worked out in full, before it is made: what blocks it, or what it would keep, change and start. */
export interface MigrationPlan {
  flowId: string;
  from: VersionRef;
  to: VersionRef;
  /** Empty when the run may move. */
  blockers: Array<{ code: string; detail: string }>;
  /** Every fact of the target, then the source's facts that have no place in it; each part by name. */
  facts: Array<{ fact: string; from?: string; outcome: FactOutcome; reason?: string }>;
  results: { kept: string[]; dropped: string[] };
  confirmations: { kept: string[]; cancelled: string[] };
  resources: { kept: string[] };
  waits: { kept: string[] };
  /**
   * Collections (present only when either version has them): the
   * items kept and dropped (`c[i]`), and the item fields not carried as they
   * were (`c[i].f`, with the outcome and reason a fact would have).
   */
  items?: CarriedItems["plan"];
  /**
   * Where the run would stand right after the move, and what it would start
   * (actions by name, calls as `call:<step>`) or release.
   */
  after: { current: string | null; status: RunStatus; starts: string[]; releases: string[] };
}

/** How each run state field crosses a move. */
export type CarryRule =
  /** Copied as it is. */
  | "keep"
  /** Taken from the event (core, update, move count). */
  | "event"
  /** Taken from the target version. */
  | "target"
  /** Worked out by the planner. */
  | "plan"
  /** Copied, then set again by the core as the run moves on (status, current step, revision). */
  | "recompute";

/**
 * Every field of `RunState` and how it crosses a move. A field added to
 * `RunState` without a rule here does not compile, so nothing is carried (or
 * lost) by accident. Collections cross item by item (`migrate-items.ts`).
 * Sub-flow fields cross only once every call has ended (a live call blocks a
 * move; see `liveCall`).
 */
export const CARRY = deepFreeze({
  v: "keep",
  runId: "keep",
  flowId: "keep",
  flowVersion: "target",
  flowHash: "target",
  scope: "keep",
  subject: "keep",
  env: "keep",
  status: "recompute",
  revision: "recompute",
  createdAt: "keep",
  updatedAt: "recompute",
  lastInputAt: "keep",
  turns: "keep",
  effectSeq: "keep",
  facts: "plan",
  results: "plan",
  outputs: "plan",
  resources: "plan",
  inflight: "plan",
  // Only for the same action and the exact digest; field by field, see CONFIRMATION_CARRY.
  confirmations: "plan",
  timers: "plan",
  waits: "keep",
  epochs: "plan",
  current: "recompute",
  notices: "recompute",
  recent: "keep",
  attention: "keep",
  end: "keep",
  pendingEnd: "keep",
  lapsed: "keep",
  nonce: "keep",
  core: "event",
  update: "event",
  migrated: "event",
  // Collections: by name, item by item, under the fact rules per address (migrate-items.ts).
  items: "plan",
  // Ids are never reused, across a move too.
  itemSeq: "keep",
  currentItem: "recompute",
  // A move is refused while any call is live, at either end (`liveCall`), so only ended calls
  // cross, as history: their commitment still counts (`committed`), and their ids stay taken.
  calls: "keep",
  callCount: "keep",
  // Only a run whose call ended can move: a child that is still running never does.
  parent: "keep",
} as const satisfies Record<keyof Required<RunState>, CarryRule>);

/**
 * How each field of a carried confirmation crosses a move. A confirmation is
 * carried at all only while its action keeps its identity and its input the
 * exact digest. It keeps who gave it and when; its expiry is worked out again
 * from that time and the target's review time to live, and never moves later,
 * so a move never extends a review (one recorded without its time is asked
 * again where the target has a time to live). A field added to `Confirmation`
 * without a rule here does not compile.
 */
export const CONFIRMATION_CARRY = deepFreeze({
  digest: "keep",
  by: "keep",
  rev: "keep",
  at: "keep",
  kind: "keep",
  roles: "keep",
  notAfter: "plan",
  authTime: "keep",
} as const satisfies Record<keyof Required<Confirmation>, CarryRule>);

/**
 * A run with a live call, or a run that is itself a live call's child, cannot
 * move (`flow/migrate-child`), at either end: the caller's call
 * step and the child's interface are what the two runs agreed on, and a move
 * on either side could change them under the other. A call is live until it
 * has ended (a call being cancelled is still live). A child that has not
 * ended is its call's live end.
 */
function liveCall(state: RunState): string | null {
  for (const [callId, call] of Object.entries(state.calls ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (call.status !== "ended") return `call ${callId} to ${call.flowId}@${call.flowVersion} at step ${call.key} is ${call.status}`;
  }
  if (state.parent && !isTerminal(state.status)) return `the run was called by another run (call ${state.parent.callId}) and has not ended`;
  return null;
}

const SYSTEM_PLANNER = { kind: "system" as const, id: "system:planner", roles: [] };

/**
 * Works out moving `state` from `from` to `to` at time `at`, without making
 * the move. A plan with blockers would be refused; otherwise its fingerprint
 * is the `planHash` the move must be recorded with.
 */
export function planMigration(from: CompiledFlow, to: CompiledFlow, state: RunState, at: number): MigrationPlan {
  const event: RunMigratedEvent = { v: EVENT_VERSION, type: "run.migrated", id: "plan", at, actor: SYSTEM_PLANNER, from: refOf(from), to: refOf(to), cause: "override", planHash: "" };
  return transition(from, to, state, event).plan;
}

/** The fingerprint a `run.migrated` event carries for `plan`. */
export function planHash(plan: MigrationPlan): string {
  return fingerprint(plan as unknown as JsonValue);
}

/** The version reference of a compiled flow. */
export function refOf(flow: CompiledFlow): VersionRef {
  return { version: flow.version, hash: flow.hash };
}

const CAUSES = new Set(["onNextTurn", "forced", "revoked", "override"]);
const MAX_ID = 256;

/**
 * Applies a `run.migrated` event: moves `state` from `from` to `to`. Pure.
 * Refused unless the state is on `from`, the event names both versions
 * exactly, the run may move (no blockers), and the recomputed plan has the
 * event's `planHash`. A forced move must carry two different approvers.
 */
export function migrateStep(from: CompiledFlow, to: CompiledFlow, state: RunState | null, ev: RunMigratedEvent): StepResult {
  const before = state?.current ?? null;
  const trace: StepTrace = { event: "run.migrated", before, after: before, factsChanged: [], factsCleared: [], effects: [] };
  const refuse = (code: string, message: string): StepResult => {
    const rejection: Rejection = { code, message };
    return { accepted: false, state, changed: false, rejection, effects: [], notices: [], trace: { ...trace, rejected: code } };
  };
  const malformed = eventShapeProblem(ev);
  if (malformed !== null) return refuse("flow/invalid-event", malformed);
  if (ev.v !== EVENT_VERSION) return refuse("flow/event-version", `unsupported event version ${String(ev.v)}`);
  if (ev.type !== "run.migrated") return refuse("flow/unknown-event", "not a move between versions");
  if (!state) return refuse("flow/not-started", "the run has not started");
  if (state.v !== RUN_STATE_VERSION) return refuse("flow/state-version", `unsupported run state version ${String(state.v)}`);
  if (state.core !== undefined && state.core !== CORE_VERSION) return refuse("flow/core-version", `the run's core rules are ${String(state.core)}, not this engine's ${CORE_VERSION}`);
  if (state.flowId !== from.id || state.flowVersion !== from.version || state.flowHash !== from.hash) {
    return refuse("flow/version-mismatch", `run uses ${state.flowId}@${state.flowVersion}, not ${from.id}@${from.version}`);
  }
  if (to.id !== from.id) return refuse("flow/version-mismatch", "a run moves only between versions of its own flow");
  if (!isRef(ev.from) || !isRef(ev.to) || ev.from.version !== from.version || ev.from.hash !== from.hash || ev.to.version !== to.version || ev.to.hash !== to.hash) {
    return refuse("flow/version-mismatch", "the move names other versions");
  }
  if (ev.core !== undefined && ev.core !== CORE_VERSION) return refuse("flow/core-version", `a move keeps the run under core rules ${CORE_VERSION}`);
  if (typeof ev.cause !== "string" || !CAUSES.has(ev.cause)) return refuse("flow/invalid-event", "unknown cause");
  if (ev.message !== undefined && (typeof ev.message !== "string" || ev.message.length > MAX_UPDATE_MESSAGE)) return refuse("flow/invalid-event", "The message is too long.");
  if (typeof ev.planHash !== "string" || ev.planHash.length === 0 || ev.planHash.length > MAX_ID) return refuse("flow/migration-plan-mismatch", "the move carries no plan");
  // People, models and deciders never move a run: the engine does, or staff overriding a pinned run.
  const actor = ev.actor;
  if (actor.kind !== "system" && !(ev.cause === "override" && (actor.kind === "staff" || actor.kind === "member"))) return refuse("flow/forbidden", "Only the engine or staff move a run.");
  if (ev.approval !== undefined && !isApproval(ev.approval)) return refuse("flow/forbidden", "A forced move needs approval from two different people.");
  if (ev.cause === "forced" && ev.approval === undefined) return refuse("flow/forbidden", "A forced move needs approval from two different people.");
  if (ev.requestId !== undefined && state.recent.includes(ev.requestId)) return { state, accepted: true, changed: false, effects: [], notices: [], trace };
  const { plan, result } = transition(from, to, state, ev);
  const blocker = plan.blockers[0];
  if (blocker) return refuse(blocker.code, blocker.detail);
  if (planHash(plan) !== ev.planHash) return refuse("flow/migration-plan-mismatch", "The run changed since the move was planned.");
  return result!;
}

function isRef(ref: unknown): ref is VersionRef {
  return typeof ref === "object" && ref !== null && typeof (ref as VersionRef).version === "string" && typeof (ref as VersionRef).hash === "string";
}

function isApproval(a: unknown): a is { requestedBy: string; approvedBy: string } {
  if (typeof a !== "object" || a === null) return false;
  const { requestedBy, approvedBy } = a as Record<string, unknown>;
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
  return id(requestedBy) && id(approvedBy) && requestedBy !== approvedBy;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

interface Sources {
  /** Facts a person may set: targets of a view's rules (declines included), and entry facts. */
  person: Set<string>;
  /** Facts the engine sets from outside the run: targets of a wait's event and timeout rules, and of a call step's end rules. */
  external: Set<string>;
}

const sourcesCache = new WeakMap<CompiledFlow, Sources>();

function sourcesOf(flow: CompiledFlow): Sources {
  const cached = sourcesCache.get(flow);
  if (cached) return cached;
  const person = new Set<string>(flow.entry);
  const external = new Set<string>();
  for (const step of flow.steps) {
    for (const rule of step.rules.values()) {
      // A call's end is answered like an outside event: by the engine, with provenance "external".
      const eventRule = (step.wait !== undefined && (rule.name === step.wait.event || rule.name === "timeout")) || (step.call !== undefined && CALL_END_RULES.has(rule.name));
      const targets = [...rule.set.map(([f]) => f), ...(eventRule ? [] : rule.decline)];
      if (eventRule) for (const f of targets) external.add(f);
      else if (step.view) for (const f of targets) person.add(f);
    }
  }
  const out = { person, external };
  sourcesCache.set(flow, out);
  return out;
}

/** Whether `to` still lets `fact` be set the way its value was set. */
function provenanceAllowed(to: CompiledFlow, fact: string, provenance: Provenance | undefined): boolean {
  const compiled = to.facts.get(fact);
  if (!compiled) return false;
  const sources = sourcesOf(to);
  switch (provenance) {
    case "user":
      return sources.person.has(fact);
    case "model":
      return compiled.userFillable;
    case "entry":
      return to.entry.has(fact) || compiled.userFillable;
    case "external":
      return sources.external.has(fact);
    default:
      return false;
  }
}

interface Classified {
  facts: Record<string, FactState>;
  outcomes: Map<string, { from?: string; outcome: FactOutcome; reason?: string }>;
  /** New fact name to its source name (absent: no source). */
  source: Map<string, string>;
  changed: string[];
  check: string[];
  removed: string[];
}

/** Places each fact of `to` per the carry rules (see the module comment). */
function classifyFacts(from: CompiledFlow, to: CompiledFlow, migration: CompiledMigration | undefined, state: RunState, rev: number): Classified {
  const facts: Record<string, FactState> = {};
  const outcomes: Classified["outcomes"] = new Map();
  const source = new Map<string, string>();
  const check: string[] = [];
  const renamedAway = new Set(migration?.rename.keys() ?? []);
  for (const [name, fact] of to.facts) {
    // Lists are carried by carryItems.
    if (fact.list) continue;
    const src = migration?.renamedFrom.get(name) ?? (renamedAway.has(name) ? undefined : name);
    const old = src !== undefined ? own(state.facts, src) : undefined;
    const oldDef = src !== undefined ? from.facts.get(src) : undefined;
    if (src !== undefined && oldDef) source.set(name, src);
    const kept = src !== undefined && src !== name ? "renamed" : "kept";
    const via = src !== undefined && src !== name ? { from: src } : {};
    const put = (next: FactState, outcome: FactOutcome, reason?: string) => {
      facts[name] = next;
      outcomes.set(name, { ...via, outcome, ...(reason !== undefined ? { reason } : {}) });
    };
    const missing = (): FactState => ({ status: "missing", rev: old && old.status !== "missing" ? rev : (old?.rev ?? 0) });
    if (fact.derive) {
      // Worked out again under the new definition; starting from the old value means only a real
      // change clears what depends on it.
      put(!old || old.status === "missing" ? { status: "missing", rev: old?.rev ?? 0 } : { status: old.status, ...(old.value !== undefined ? { value: cloneJson(old.value) } : {}), ...(old.issues ? { issues: old.issues } : {}), provenance: "derived", rev: old.rev }, "derived");
      continue;
    }
    if (!old || !oldDef || oldDef.list) {
      put({ status: "missing", rev: 0 }, "new");
      continue;
    }
    if (migration?.drop.has(name)) {
      put(missing(), "dropped", "drop");
      continue;
    }
    // A computed value never becomes a given one.
    if (oldDef.derive) {
      put(missing(), "dropped", "derived");
      continue;
    }
    if (old.status === "missing") {
      put({ status: "missing", rev: old.rev }, kept);
      continue;
    }
    // A secret never carries into a fact that is not secret, not even as a prefill: views would show it.
    if (oldDef.sensitivity === "secret" && fact.sensitivity !== "secret") {
      put(missing(), "dropped", "sensitivity");
      continue;
    }
    const fits = (value: JsonValue): boolean => jsonByteLength(value) <= to.limits.maxFactBytes && validateValue(fact.schema, value).length === 0;
    const stale = (value: JsonValue | undefined): FactState => {
      const keep = value !== undefined && fits(value);
      return { status: "stale", rev: old.status === "stale" && keep === (old.value !== undefined) ? old.rev : rev, ...(keep ? { value: cloneJson(value) } : {}) };
    };
    if (migration?.reask.has(name)) {
      put(stale(old.value), "reasked", "reask");
      continue;
    }
    if (old.status === "declined") {
      if (fact.def.optional) {
        // A move voids every suggestion and undo: they described the old version's facts.
        const { proposed: _p, assist: _a, ...declined } = old;
        put(declined, kept);
      }
      else put(missing(), "dropped", "required");
      continue;
    }
    if (old.status === "stale") {
      put(stale(old.value), kept);
      continue;
    }
    // valid, invalid or needs_confirmation: the value must have come the way the new version
    // still lets the fact be set, and must pass its rules.
    if (!provenanceAllowed(to, name, old.provenance)) {
      put(missing(), "dropped", "provenance");
      continue;
    }
    if (old.provenance === "model" && fact.def.userAsserted) {
      put(missing(), "dropped", "userAsserted");
      continue;
    }
    // Refused as too large where it was given, so there is no value to carry: never a null in its
    // place. Like a value too large for the target, it blocks the move (`flow/migrate-limits`).
    if (old.value === undefined) {
      put({ ...old, status: "invalid", issues: old.issues ?? [TOO_LARGE] }, "invalid", "too-large");
      continue;
    }
    const value = old.value;
    let next: FactState;
    let outcome: FactOutcome = kept;
    let reason: string | undefined;
    if (jsonByteLength(value) > to.limits.maxFactBytes) {
      next = { status: "invalid", value: cloneJson(value), issues: [TOO_LARGE], rev };
      outcome = "invalid";
      reason = "too-large";
    } else {
      const issues = validateValue(fact.schema, value).map((i) => ({ code: i.code, message: i.message, path: formatPath(i.path) }));
      // An assistant's value the person has not confirmed yet stays unconfirmed: a move never says yes for them.
      const unconfirmed = old.status === "needs_confirmation" && old.assist !== undefined;
      const status = issues.length > 0 ? "invalid" : old.provenance === "model" && (fact.def.confirm || unconfirmed) ? "needs_confirmation" : "valid";
      next = { status, value: cloneJson(value), rev, ...(issues.length > 0 ? { issues } : {}) };
      if (issues.length > 0) {
        outcome = "invalid";
        reason = "type";
      } else if (status === "needs_confirmation" && old.status !== "needs_confirmation") reason = "confirm";
      if (status !== "invalid" && fact.checks.length > 0) check.push(name);
    }
    if (old.provenance !== undefined) next.provenance = old.provenance;
    if (old.by !== undefined) next.by = old.by;
    // Unchanged facts keep their revision.
    if (canonicalJson(withoutRev(next)) === canonicalJson(withoutRev(old))) next.rev = old.rev;
    put(next, outcome, reason);
  }
  const changed: string[] = [];
  for (const [name, next] of Object.entries(facts)) {
    if (to.facts.get(name)?.derive) continue;
    const src = source.get(name);
    const before = readable(src !== undefined ? own(state.facts, src) : undefined);
    const after = readable(next);
    if (before.known !== after.known || (before.known && after.known && !jsonEqual(before.value, after.value))) changed.push(name);
  }
  const carriedFrom = new Set(source.values());
  const removed = [...from.facts.keys()].filter((f) => !carriedFrom.has(f) && !to.facts.has(f));
  return { facts, outcomes, source, changed, check, removed };
}

const withoutRev = (f: FactState): JsonValue => {
  const { rev: _rev, ...rest } = f;
  return rest as unknown as JsonValue;
};

/**
 * `isCommitted`, read without a core machine: a committed hold, a commit
 * point that succeeded, or a call whose child committed.
 */
export function committed(flow: CompiledFlow, state: RunState): boolean {
  if (Object.values(state.resources).some((r) => r.status === "committed")) return true;
  if (Object.values(state.calls ?? {}).some((c) => c.end?.committed === true)) return true;
  return Object.entries(state.results).some(([key, res]) => res.status === "ok" && flow.actions.get(nameOfKey(key))?.commitPoint === true);
}

/** A write in both versions, run the same way (once, or once per item of the same list): a failed result of it is kept. */
function sameWrite(from: CompiledFlow, to: CompiledFlow, name: string): boolean {
  const a = from.actions.get(name);
  const b = to.actions.get(name);
  return a !== undefined && b !== undefined && a.def.effect === "write" && b.def.effect === "write" && a.forEach === b.forEach;
}

function sameIdentity(from: CompiledFlow, to: CompiledFlow, name: string): boolean {
  const a = from.actions.get(name);
  const b = to.actions.get(name);
  // Run once per item over another collection, or no longer per item, is another action: its results are keyed differently.
  return a !== undefined && b !== undefined && a.identity === b.identity && a.forEach === b.forEach;
}

function blockersBefore(from: CompiledFlow, to: CompiledFlow, migration: CompiledMigration | undefined, state: RunState, at: number): MigrationPlan["blockers"] {
  const out: MigrationPlan["blockers"] = [];
  const block = (code: string, detail: string) => out.push({ code, detail });
  if (to.id !== from.id || state.flowId !== to.id) block("flow/migrate-undeclared", "a run moves only between versions of its own flow");
  else if (!migration || to.version === from.version) block("flow/migrate-undeclared", `version ${to.version} does not accept runs from version ${from.version}`);
  if (isTerminal(state.status)) block("flow/migrate-ended", `the run has ended (${state.status})`);
  else if (state.status === "cancelling" || state.pendingEnd) block("flow/migrate-ending", "the run is ending");
  if ((state.migrated ?? 0) >= MAX_MOVES_PER_RUN) block("flow/limit", `the run has moved ${MAX_MOVES_PER_RUN} times`);
  if (committed(from, state)) block("flow/migrate-committed", "the run passed a commit point");
  for (const [effectId, inflight] of Object.entries(state.inflight)) {
    const read = inflight.purpose === "run" && from.actions.get(inflight.action)?.def.effect === "read";
    if (!read) block("flow/migrate-busy", `${inflight.purpose} of action ${inflight.action} (${effectId}) is under way`);
  }
  const doubtful = state.attention.length > 0 || Object.values(state.results).some((r) => r.status === "in_doubt") || Object.values(state.resources).some((r) => r.status === "in_doubt");
  if (doubtful) block("flow/migrate-in-doubt", "an outcome is not known yet");
  for (const [resourceId, resource] of Object.entries(state.resources)) {
    if (resource.status === "held" && !sameIdentity(from, to, resource.action)) block("flow/migrate-holds", `hold ${resourceId} of action ${resource.action} must be released by the definition that took it`);
    if (resource.releaseQueued === true) block("flow/migrate-busy", `the release of hold ${resourceId} of action ${resource.action} is waiting to go out`);
  }
  // An open wait stays open across a move only where the target waits for the same thing in the
  // same step; otherwise a delivery could arrive for a wait nobody has any more.
  for (const [stepId, wait] of Object.entries(state.waits)) {
    const a = from.stepById.get(stepId);
    const b = to.stepById.get(stepId);
    if (!a || !b || !sameWait(a, b)) block("flow/migrate-waiting", `the run waits for ${wait.event} at step ${stepId}, which the target does not wait for in the same way`);
  }
  const call = liveCall(state);
  if (call !== null) block("flow/migrate-child", call);
  // A move never expires a run on arrival.
  if (state.status === "active") {
    if (state.createdAt + to.limits.maxLifetimeMs <= at) block("flow/migrate-expires", "the target's lifetime limit has already passed");
    if (state.lastInputAt + to.limits.idleTimeoutMs <= at) block("flow/migrate-expires", "the target's idle limit has already passed");
  }
  return out;
}

/**
 * What the run would carry past the target's limits (`flow/migrate-limits`). A move never drops,
 * cuts or nulls what was given to make it fit: a value larger than the target's `maxFactBytes`, or
 * one refused as too large where it was given (there is no value to carry); a list longer than its
 * `max`, more items than `maxItems`, a list over `maxCollectionBytes`; more inputs, events or calls
 * than the target allows. Each clears only when what was given changes, so none is temporary.
 */
function limitBlockers(to: CompiledFlow, state: RunState, outcomes: ReadonlyMap<string, { reason?: string }>, carried: CarriedItems | null): MigrationPlan["blockers"] {
  const out: MigrationPlan["blockers"] = [];
  const block = (detail: string) => out.push({ code: "flow/migrate-limits", detail });
  const tooLarge = [...outcomes].filter(([, o]) => o.reason === "too-large").map(([name]) => name);
  for (const f of carried?.plan.fields ?? []) if (f.reason === "too-large") tooLarge.push(f.field);
  for (const name of tooLarge.sort()) block(`"${name}" is too large for version ${to.version}`);
  if (carried) {
    let total = 0;
    for (const c of [...to.collections.keys()].sort()) {
      const ids = carried.lists[c]?.items ?? [];
      total += ids.length;
      if (ids.length > to.collections.get(c)!.max) block(`"${c}" has ${ids.length} items; version ${to.version} allows ${to.collections.get(c)!.max}`);
      let bytes = 0;
      for (const id of ids) for (const field of Object.values(own(carried.items, id)?.fields ?? {})) if (field.value !== undefined) bytes += jsonByteLength(field.value);
      if (bytes > to.limits.maxCollectionBytes) block(`"${c}" is larger than version ${to.version} allows`);
    }
    if (total > to.limits.maxItems) block(`the run has ${total} items; version ${to.version} allows ${to.limits.maxItems}`);
  }
  if (state.turns > to.limits.maxTurns) block(`the run has had more inputs than version ${to.version} allows`);
  if (state.revision > to.limits.maxEvents) block(`the run has more events than version ${to.version} allows`);
  if ((state.callCount ?? 0) > to.limits.maxCalls) block(`the run has made more calls than version ${to.version} allows`);
  return out;
}

/** Runs the move on a copy: the plan, and the result when nothing blocks it. */
function transition(from: CompiledFlow, to: CompiledFlow, state: RunState, ev: RunMigratedEvent): { plan: MigrationPlan; result: StepAccepted | null } {
  const at = ev.at;
  const migration = to.version === from.version ? undefined : to.migrations.get(from.version);
  const rev = state.revision + 1;
  const plan: MigrationPlan = {
    flowId: from.id,
    from: refOf(from),
    to: refOf(to),
    blockers: blockersBefore(from, to, migration, state, at),
    facts: [],
    results: { kept: [], dropped: [] },
    confirmations: { kept: [], cancelled: [] },
    resources: { kept: [] },
    waits: { kept: [] },
    after: { current: state.current, status: state.status, starts: [], releases: [] },
  };
  const classified = classifyFacts(from, to, migration, state, rev);
  const carried = from.collections.size > 0 || to.collections.size > 0 ? carryItems(from, to, migration, state, rev) : null;
  if (carried) {
    for (const [name, list] of Object.entries(carried.lists)) {
      classified.facts[name] = list;
      classified.outcomes.set(name, carried.outcomes.get(name)!);
      if (from.collections.has(name)) classified.source.set(name, name);
    }
    classified.changed.push(...carried.changed);
    classified.check.push(...carried.check);
    plan.items = carried.plan;
  }
  plan.blockers.push(...limitBlockers(to, state, classified.outcomes, carried));
  // By name, never in the definition's key order: copies of one version with the same hash plan alike.
  const listFacts = (final?: Record<string, FactState>) => {
    plan.facts = [...to.facts.keys()].sort().map((name) => {
      let entry = classified.outcomes.get(name)!;
      const after = final ? own(final, name) : undefined;
      if (after && (entry.outcome === "kept" || entry.outcome === "renamed")) {
        if (after.status === "stale" && facts[name]?.status !== "stale") entry = { ...entry, outcome: "reasked", reason: "upstream" };
        else if (after.status === "invalid" && facts[name]?.status !== "invalid") entry = { ...entry, outcome: "invalid", reason: "checks" };
      }
      return { fact: name, ...entry };
    });
    for (const name of [...classified.removed].sort()) plan.facts.push({ fact: name, outcome: "dropped", reason: "removed" });
  };
  const facts = classified.facts;
  if (plan.blockers.length > 0) {
    listFacts();
    return { plan, result: null };
  }

  // Facts downstream of an action the source never had were given without its result: ask again.
  const changed = new Set(classified.changed);
  const fresh = new Set<string>();
  for (const name of to.actions.keys()) {
    if (from.actions.has(name)) continue;
    const reader = new RunReader(to, { ...state, facts }, at);
    for (const f of reader.factsDownstream(actionNode(name), false)) {
      if (carried && f.includes(".")) {
        for (const address of staleTemplate(to, carried.items, f, rev)) changed.add(address);
        continue;
      }
      const st = facts[f];
      if (!st || to.facts.get(f)?.derive || st.status === "missing" || st.status === "stale" || fresh.has(f)) continue;
      facts[f] = { status: "stale", rev, ...(st.value !== undefined ? { value: st.value } : {}), ...(st.items !== undefined ? { items: st.items } : {}) };
      classified.outcomes.set(f, { ...(classified.source.get(f) !== f && classified.source.has(f) ? { from: classified.source.get(f)! } : {}), outcome: "reasked", reason: "new-action" });
      changed.add(f);
      fresh.add(f);
    }
  }

  // Results: settled ones are kept only while the action keeps its identity. A failed write is kept
  // whenever the target still has it as a write, even changed, and the core makes it stand for the
  // target's input: a move never sends a write again by itself, and the person still decides to
  // retry. Reads in flight are dropped, with their timers; their outbox rows are discarded because
  // nothing awaits them any more. A result the revoked version recorded for what it never sent is
  // not a failure of the action: it is dropped, so the target starts the action again.
  const results: RunState["results"] = {};
  // A key with an item (`name[i]`) carries only with its item, and only to an action run per item over the same list.
  const owner = (entry: { forEach?: string } | undefined) => (entry === undefined ? undefined : (entry.forEach ?? null));
  const actionOwner = (side: "from" | "to", name: string) => owner((side === "from" ? from : to).actions.get(name));
  const stepOwner = (side: "from" | "to", name: string) => owner((side === "from" ? from : to).stepById.get(name));
  const items = carried?.items ?? {};
  const perItem = (key: string, of: typeof actionOwner) => !key.includes("[") || carriedKey(key, of, items);
  for (const [name, res] of Object.entries(state.results)) {
    const readInFlight = own(state.inflight, res.effectId) !== undefined;
    const neverSent = res.status === "failed" && res.error?.code === REVOKED_CODE;
    const failedWrite = res.status === "failed" && sameWrite(from, to, nameOfKey(name));
    if ((res.status === "ok" || res.status === "failed") && !neverSent && !readInFlight && (sameIdentity(from, to, nameOfKey(name)) || failedWrite) && perItem(name, actionOwner)) {
      results[name] = cloneJson(res as unknown as JsonValue) as unknown as typeof res;
      plan.results.kept.push(name);
    } else plan.results.dropped.push(name);
  }
  const cancelTimers: string[] = [];
  for (const effectId of Object.keys(state.inflight)) {
    for (const timerId of [`retry:${effectId}`, `timeout:${effectId}`]) if (own(state.timers, timerId) !== undefined) cancelTimers.push(timerId);
  }
  const outputs: RunState["outputs"] = {};
  for (const [name, fp] of Object.entries(state.outputs)) if (name.includes("[") ? perItem(name, actionOwner) : to.actions.has(name)) outputs[name] = fp;
  const epochs: RunState["epochs"] = {};
  for (const [stepId, epoch] of Object.entries(state.epochs)) if (stepId.includes("[") ? perItem(stepId, stepOwner) : to.stepById.has(stepId)) epochs[stepId] = epoch;
  // Deadlines follow the target's limits; unchanged ones are left alone.
  const rearm: Array<[string, number]> = [];
  if (to.limits.maxLifetimeMs !== from.limits.maxLifetimeMs) rearm.push(["lifetime", state.createdAt + to.limits.maxLifetimeMs]);
  if (to.limits.idleTimeoutMs !== from.limits.idleTimeoutMs) rearm.push(["idle", state.lastInputAt + to.limits.idleTimeoutMs]);

  const computed: Partial<RunState> = {
    flowVersion: to.version,
    flowHash: to.hash,
    facts,
    results,
    outputs,
    resources: cloneJson(state.resources as unknown as JsonValue) as unknown as RunState["resources"],
    inflight: {},
    confirmations: cloneJson(state.confirmations as unknown as JsonValue) as unknown as RunState["confirmations"],
    timers: { ...state.timers },
    epochs,
    update: { kind: "migrated", from: from.version, to: to.version, at, facts: [], ...(ev.message !== undefined ? { message: ev.message } : {}) },
    migrated: (state.migrated ?? 0) + 1,
    ...(carried ? { items: carried.items } : {}),
  };
  computed.core = CORE_VERSION;
  const moved = {} as Record<string, unknown>;
  for (const key of Object.keys(CARRY) as Array<keyof typeof CARRY>) {
    const rule: CarryRule = CARRY[key];
    const value = rule === "keep" || rule === "recompute" ? state[key] : computed[key];
    if (value !== undefined) moved[key] = rule === "keep" || rule === "recompute" ? structuredClone(value) : value;
  }
  const move: MoveInput = {
    before: state.current,
    changed: [...changed],
    check: classified.check,
    sameAction: (name) => sameIdentity(from, to, name),
    cancelTimers,
    rearm,
    notice: { code: "flow/migrated", message: ev.message ?? "This was updated to a newer version." },
  };
  const settled = settleMove(to, moved as unknown as RunState, ev, move);
  if (!settled.accepted) {
    plan.blockers.push({ code: settled.rejection.code, detail: settled.rejection.message });
    listFacts();
    return { plan, result: null };
  }
  const result = settled;
  const next = result.state;

  // Post-checks: a move never closes an open wait (a delivery arriving after it would be lost),
  // and never leaves a run with nothing to do.
  for (const effect of result.effects) {
    if (effect.kind === "wait.close" && own(state.waits, effect.stepId)) plan.blockers.push({ code: "flow/migrate-waiting", detail: `the run waits for ${effect.event} at step ${effect.stepId}, which the target does not wait for in the same way` });
  }
  if (next.status === "active" && next.current === null && Object.keys(next.inflight).length === 0) plan.blockers.push({ code: "flow/migrate-stuck", detail: "the run would have no step to continue with" });

  listFacts(next.facts);
  plan.confirmations.kept = Object.keys(state.confirmations).filter((n) => own(next.confirmations, n) !== undefined);
  plan.confirmations.cancelled = Object.keys(state.confirmations).filter((n) => own(next.confirmations, n) === undefined);
  plan.resources.kept = Object.keys(state.resources).filter((id) => own(next.resources, id) !== undefined);
  plan.waits.kept = Object.keys(state.waits).filter((id) => own(next.waits, id) !== undefined);
  plan.after = {
    current: next.current,
    status: next.status,
    starts: result.effects.flatMap((e) => (e.kind === "action" && e.purpose === "run" ? [e.name] : e.kind === "call.start" ? [`call:${own(next.calls ?? {}, e.callId)?.key ?? e.callId}`] : [])),
    releases: result.effects.filter((e) => e.kind === "action" && e.purpose === "compensate").map((e) => (e.kind === "action" ? (e.target ?? "") : "")),
  };
  for (const list of [plan.results.kept, plan.results.dropped, plan.confirmations.kept, plan.confirmations.cancelled, plan.resources.kept, plan.waits.kept]) list.sort();
  if (plan.blockers.length > 0) return { plan, result: null };

  // The person is told which answers they need to give again.
  next.update = {
    ...next.update!,
    facts: [...to.facts.keys()].filter((name) => {
      if (to.facts.get(name)?.derive) return false;
      const src = classified.source.get(name);
      return readable(src !== undefined ? own(state.facts, src) : undefined).known && !readable(own(next.facts, name)).known;
    }),
  };
  // A list whose items or given fields did not all carry is asked for again, by its name.
  if (carried) for (const c of listsAskedAgain(to, state, next)) if (!next.update!.facts.includes(c)) next.update!.facts.push(c);
  next.update!.facts.sort();
  return { plan, result };
}

// ---------------------------------------------------------------------------
// Publish-time checks
// ---------------------------------------------------------------------------

/**
 * Checks a version's `migrations` entry for an earlier published version
 * before the new version is published. Errors refuse the publish; warnings
 * say what runs that move will meet.
 */
export function checkMigration(from: CompiledFlow, to: CompiledFlow): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (severity: Diagnostic["severity"], code: string, path: PathSegment[], message: string) => out.push({ code, severity, path: formatPath(path), pointer: jsonPointer(path), message });
  const migration = to.id === from.id && to.version !== from.version ? to.migrations.get(from.version) : undefined;
  if (!migration) {
    add("error", "flow/migrate-undeclared", ["migrations"], `${to.id}@${to.version} does not accept runs from ${from.id}@${from.version}`);
    return out;
  }
  const base: PathSegment[] = ["migrations", migration.index];
  for (const oldName of migration.rename.keys()) {
    if (!from.facts.has(oldName)) add("error", "flow/migration-unknown-source-fact", [...base, "rename", oldName], `version ${from.version} has no fact "${oldName}"`);
    else if (from.collections.has(oldName)) add("error", "flow/migration-collection", [...base, "rename", oldName], `"${oldName}" is a collection in version ${from.version}: it carries over by name, with its items, and cannot be renamed`);
  }
  const renamedAway = new Set(migration.rename.keys());
  for (const [name, fact] of to.facts) {
    const src = migration.renamedFrom.get(name) ?? (renamedAway.has(name) ? undefined : name);
    const old = src !== undefined ? from.facts.get(src) : undefined;
    if (!old || fact.derive || old.derive || migration.drop.has(name)) continue;
    if (canonicalJson(old.schema as JsonValue) !== canonicalJson(fact.schema as JsonValue)) {
      add("warning", "flow/migration-type-changed", ["facts", name, "type"], `"${name}" has a different type than "${src!}" in version ${from.version}; values that no longer fit are asked again`);
    }
    const rank = { none: 0, personal: 1, secret: 2 } as const;
    if (rank[fact.sensitivity] < rank[old.sensitivity]) {
      const what = old.sensitivity === "secret" ? "its values are not carried over" : "its values become less protected";
      add("warning", "flow/migration-sensitivity-lowered", ["facts", name, "sensitivity"], `"${name}" is less sensitive than "${src!}" in version ${from.version}: ${what}`);
    }
  }
  for (const [name, action] of to.actions) {
    const old = from.actions.get(name);
    if (old && (old.identity !== action.identity || old.forEach !== action.forEach)) {
      add("warning", "flow/migration-action-changed", ["actions", name], `action "${name}" is not the same action as in version ${from.version}: its results (but a failed write's, which waits for a retry) and confirmations are not carried over, and runs holding something it took wait until the hold is released`);
    }
    if (!old && action.def.effect === "write") add("warning", "flow/migration-new-write", ["actions", name], `write "${name}" is new: runs that move may make it`);
  }
  for (const step of from.steps) {
    if (!step.wait) continue;
    const next = to.stepById.get(step.id);
    if (!next || !sameWait(step, next)) {
      add("warning", "flow/migration-wait-changed", next ? ["steps", next.index, "wait"] : ["steps"], `runs waiting at step "${step.id}" do not move until the wait is over: the target ${next ? "waits differently there" : "has no such step"}`);
    }
  }
  return out;
}

/** The same wait: event, correlation, acceptance test and timeout (the rules that apply a delivery may differ). */
function sameWait(a: CompiledStep, b: CompiledStep): boolean {
  return a.def.wait !== undefined && canonicalJson(a.def.wait as unknown as JsonValue) === canonicalJson((b.def.wait ?? null) as unknown as JsonValue);
}
