/**
 * The persisted state of one run, and the events that change it.
 *
 * A run is one execution of one flow version for one person (its subject)
 * inside one tenant scope. Its state is plain JSON, so any store can keep it,
 * and it is a pure function of its events: replaying the recorded events
 * through `step` rebuilds it exactly.
 */

import type { ActionError, ActionOutcome, ActorKind, EnvironmentKind, Scope } from "@aaply/action-contract";
import type { EndKind, Risk } from "./definition.js";
import type { JsonObject, JsonValue } from "./json.js";

// Shared with whatever performs actions; defined in @aaply/action-contract.
export type { ActionError, ActionOutcome, ActorKind, Scope };

/** Who caused an event. Built by the runtime from the trusted context. */
export interface ActorRef {
  kind: ActorKind;
  id: string;
  /** App roles held at the time of the event. */
  roles: string[];
  /** Set when the actor acts on behalf of someone else (staff for a member): that person's id. */
  for?: string;
  /**
   * When the actor last signed in (epoch ms), from the trusted context of the
   * request that caused the event, when it said. Passed through to the
   * envelope's `actor` and a review's `approval.by`; the engine never acts on
   * it. Absent on every event recorded before it existed.
   */
  authTime?: number;
}

export type FactStatus = "missing" | "valid" | "invalid" | "needs_confirmation" | "stale" | "declined";
export type Provenance = "user" | "model" | "entry" | "external" | "derived";

/** How a decider knows a value: the person said it, or the model guessed it from context. */
export type AssistBasis = "stated" | "inferred";
/** How far a model's value may go without the person: from never written to written as valid. */
export type FillMode = "never" | "suggest" | "confirm" | "auto";

/**
 * How the runtime judged one value of a model's `facts.input`.
 * Recorded with the event, so replay never re-reads text or a clock.
 */
export interface AssistMark {
  basis: AssistBasis;
  /** `correct`: the person asked to change a value they gave. Default `set`. */
  op?: "set" | "correct";
  /** The tenant's policy caps the fact's fill mode at this (the tighter wins). */
  cap?: FillMode;
}

export interface FactIssue {
  code: string;
  message: string;
  path: string;
}

export interface FactState {
  status: FactStatus;
  /** valid: the value. invalid, stale, needs_confirmation: the candidate or previous value, for prefill. */
  value?: JsonValue;
  provenance?: Provenance;
  issues?: FactIssue[];
  /** Revision of the last change. */
  rev: number;
  /** Actor id that supplied the value. */
  by?: string;
  /**
   * The assistant wrote this value in the decision turn
   * `turn` (the id of its `facts.input` event), replacing `before` (null when
   * the fact had no state). Gone once anyone else writes the fact, so an undo
   * never touches a value the person changed since. `before` never holds an
   * `assist` or a `proposed` of its own: a chain of fills keeps one step.
   */
  assist?: { turn: string; before: FactState | null };
  /**
   * A value the assistant offered but did not write (it was
   * inferred, the fact's fill mode is `suggest`, or the person's own value is
   * there). Never applied by itself; the person accepts or dismisses it.
   */
  proposed?: { value: JsonValue; basis: AssistBasis; turn: string };
  /**
   * Collections only: the live item ids in list order, whatever the list's
   * status. The list's own status says whether it is settled: valid (within
   * min and max), invalid (out of range), needs_confirmation (settled by a
   * model), stale (unsettled; the items stay) or missing (a draft).
   */
  items?: string[];
}

/** One item of a collection. Its id is its key in `RunState.items`. */
export interface ItemState {
  collection: string;
  /** Each field's state, like a fact's. A field never given is absent. */
  fields: Record<string, FactState>;
  /** Revision of the event that added the item. */
  rev: number;
  /** Actor id that added the item. */
  by?: string;
  provenance?: Provenance;
}

export type ResultStatus = "inflight" | "retry_wait" | "pending" | "reconciling" | "ok" | "failed" | "in_doubt";

/** Latest attempt to run one action. Current while its fingerprint matches the action's input. */
export interface ResultState {
  effectId: string;
  fingerprint: string;
  input: JsonObject;
  status: ResultStatus;
  attempt: number;
  output?: JsonValue;
  error?: ActionError;
  rev: number;
  /** A write whose outcome was unknown at least once: it may have been applied. */
  maybeApplied?: boolean;
  /**
   * The person whose event dispatched its first attempt, or null
   * when the engine did. Every later attempt, and its undo and check, carry
   * it (the approved action's `origin.causedBy`).
   */
  causedBy?: CauseRef | null;
  /**
   * The `traceparent` of the event that dispatched its first attempt, when
   * it had one (any format). Every later attempt, and its undo and check,
   * carry it on the envelope.
   */
  traceparent?: string;
}

/** Who set an effect in motion: the kind and engine id (`domain:id`) of a person's actor. */
export interface CauseRef {
  kind: ActorKind;
  id: string;
}

export type ResourceStatus = "held" | "committed" | "releasing" | "released" | "expired" | "in_doubt";

/** Something a successful compensable write created in an outside system. */
export interface ResourceState {
  action: string;
  status: ResourceStatus;
  fingerprint: string;
  input: JsonObject;
  output: JsonValue;
  rev: number;
  expiresAt?: number;
  /** When the hold was taken or last renewed. */
  heldAt?: number;
  /** The hold expired while nobody was there to renew it; renewed when the person comes back. */
  lapsed?: boolean;
  releaseEffectId?: string;
  /** Who caused the write that holds it (its result's `causedBy`), carried by its undo. */
  causedBy?: CauseRef | null;
  /** The `traceparent` of the write that holds it (its result's), carried by its undo. */
  traceparent?: string;
  /**
   * Its release waits for room under the in-flight cap (status
   * `releasing`, no `releaseEffectId` yet; `rev` is when it was asked for).
   * Queued releases go out first asked for first, before anything new starts;
   * the run does not end, and does not move, before they have gone out.
   */
  releaseQueued?: true;
  error?: ActionError;
  /** The item of the per-item write that created it; released once the item is gone. */
  item?: string;
}

export type EffectPurpose = "run" | "compensate" | "reconcile";

export interface InflightEffect {
  purpose: EffectPurpose;
  /** Flow action name. */
  action: string;
  /** For compensate: the resource (its creating effect id). For reconcile: the effect being checked. */
  target?: string;
  attempt: number;
  waiting: boolean;
  /** The backend accepted the effect and will settle it later. */
  pending?: boolean;
  /** The item a per-item action's effect belongs to. */
  item?: string;
}

export interface Confirmation {
  digest: string;
  by: string;
  rev: number;
  /** When it was given, and the reviewer's kind and roles at that time. */
  at?: number;
  kind?: ActorKind;
  roles?: string[];
  /** When it stops covering a new dispatch, when the flow declares a time to live. */
  notAfter?: number;
  /** When the reviewer last signed in (epoch ms), when their request said; the approval's `by.authTime`. */
  authTime?: number;
}

export interface OpenWait {
  event: string;
  key: string;
}

export interface Notice {
  code: string;
  message: string;
  facts?: string[];
  action?: string;
}

export type RunStatus = "active" | "cancelling" | "completed" | "cancelled" | "failed" | "expired";

/** Why a caller stopped waiting for a child run. */
export type CallCancelReason = "parent-ended" | "superseded" | "timeout";

/** How a child run ended, as its caller records it. */
export interface CallEnd {
  kind: EndKind;
  reason?: string;
  /** The child's interface output (only when it completed); unknown values are null. */
  output?: JsonObject;
  /** An explicit commit point of the child applied: what it did stays done. */
  committed: boolean;
  /** Why it did not complete, as a person may see it. */
  error?: ActionError;
  /** The person's latest input in the child. */
  lastInputAt: number;
  /** The highest run a cancellation of this tree reaches (see `RunCancelledEvent.cascade`). */
  cascade?: string;
  /** Actor ids that supplied the facts behind the output; `"*"` stands for more than the cap. */
  contributors?: string[];
}

/** Where one call stands: starting its child, waiting to retry the start, running, being cancelled, or ended. */
export type CallStatus = "starting" | "retry_wait" | "running" | "cancelling" | "ended";

/** One call a run made: a child run of another flow. Keyed by its call id (an effect id). */
export interface CallState {
  /** The call step's id. */
  key: string;
  /** The child run's id. */
  runId: string;
  flowId: string;
  /** The version asked for, then the one that was started. */
  flowVersion: string;
  flowHash?: string;
  /** Fingerprint of the input; with the step's epoch, what the call answers. */
  fingerprint: string;
  input: JsonObject;
  epoch: number;
  status: CallStatus;
  attempt: number;
  rev: number;
  cancelReason?: CallCancelReason;
  /** Abandoned or retried: no longer the step's call. */
  retired?: boolean;
  end?: CallEnd;
}

/** A child run's link to the run that called it. */
export interface ParentLink {
  runId: string;
  /** The caller's call id. */
  callId: string;
  /** The run at the top of the tree. */
  rootRunId: string;
  /** 1 for a child of a run nobody called. */
  depth: number;
  /** Flow ids of every ancestor, the root first. */
  chain: string[];
  /** Actor ids that supplied the caller's facts behind the input; `"*"` stands for more than the cap. */
  contributors: string[];
}

/**
 * A flow version a run moved from or to. The hash pins the exact definition,
 * so replay resolves the same one.
 */
export interface VersionRef {
  version: string;
  hash: string;
}

/**
 * What changed under the person since they last acted: the run moved to a
 * newer version, or its version was withdrawn. Shown until their next input,
 * unlike notices, which the next event replaces.
 */
export interface RunUpdate {
  kind: "migrated" | "revoked";
  /** The version the run was on. */
  from: string;
  /** The version it moved to (moves only). */
  to?: string;
  at: number;
  /** Facts the person is asked for again (names only). */
  facts: string[];
  /** Shown to the person; at most 500 characters. */
  message?: string;
}

/** Where a run's time zone came from: the call, the app's policy, the engine's default, or UTC. */
export type ZoneSource = "context" | "app" | "engine" | "utc";

export interface RunEnv {
  locale: string;
  timezone: string;
  /** Format 0.3: which source the time zone came from. Absent: the trusted context (as before 0.3). */
  timezoneSource?: ZoneSource;
  environment: EnvironmentKind;
}

export const RUN_STATE_VERSION = 1 as const;
/** Version of the core's transition rules. Stamped on each run so replays can tell old behaviour apart. */
export const CORE_VERSION = 2 as const;

export interface RunState {
  v: typeof RUN_STATE_VERSION;
  runId: string;
  flowId: string;
  flowVersion: string;
  flowHash: string;
  scope: Scope;
  /** The person the run belongs to; null for runs started by a workload for nobody in particular. */
  subject: { id: string } | null;
  env: RunEnv;
  status: RunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastInputAt: number;
  turns: number;
  effectSeq: number;
  facts: Record<string, FactState>;
  results: Record<string, ResultState>;
  /** Fingerprint of each action's last successful output, to notice when choices change. */
  outputs: Record<string, string>;
  resources: Record<string, ResourceState>;
  inflight: Record<string, InflightEffect>;
  confirmations: Record<string, Confirmation>;
  /** Timer id to its live generation. A firing with any other generation is ignored. */
  timers: Record<string, number>;
  waits: Record<string, OpenWait>;
  /** Step id to its view epoch; bumped when its answers are cleared from elsewhere. */
  epochs: Record<string, number>;
  current: string | null;
  notices: Notice[];
  /** Recent request ids, for de-duplicating retried submissions. */
  recent: string[];
  /** Effects that need a person to settle them (outcome unknown, cannot be checked). */
  attention: string[];
  /** `cascade`: the highest run of a tree cancellation that reached this one (child runs only). */
  end?: { kind: EndKind; at: number; reason?: string; cascade?: string };
  /** An end that waits for a write already sent (and maybe applied) to settle. */
  pendingEnd?: { kind: EndKind; at: number; reason?: string; cascade?: string };
  /** Resources whose holds lapsed while the person was away; the run is paused until they return. */
  lapsed?: string[];
  /** Random value fixed at start; salts digests shown to clients. */
  nonce?: string;
  /** CORE_VERSION that created the run: always this engine's. */
  core?: number;
  /** The items of every collection, by id. */
  items?: Record<string, ItemState>;
  /** The last item number minted; ids are `i<n>` and never reused within a run. */
  itemSeq?: number;
  /** The item of the current step, when it runs once per item. */
  currentItem?: string;
  /** Calls to other flows, by call id. */
  calls?: Record<string, CallState>;
  /** Calls started so far, re-calls included. */
  callCount?: number;
  /** Set on a child run: the run that called it. */
  parent?: ParentLink;
  /** The last move or revocation, until the person's next input. */
  update?: RunUpdate;
  /** How many times the run moved to another version. */
  migrated?: number;
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "expired";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EVENT_VERSION = 1 as const;

export interface EventBase {
  v: typeof EVENT_VERSION;
  id: string;
  at: number;
  actor: ActorRef;
  /** Caller's request id; a repeat within a run is ignored. */
  requestId?: string;
  /**
   * The W3C `traceparent` of the request that caused the event, when it
   * carried a well-formed one. Recorded with the write the event sets in
   * motion.
   */
  traceparent?: string;
}

export interface RunStartedEvent extends EventBase {
  type: "run.started";
  runId: string;
  flowId: string;
  flowVersion: string;
  flowHash: string;
  scope: Scope;
  subject: { id: string } | null;
  env: RunEnv;
  facts: Record<string, JsonValue>;
  /** call: a caller's input to a child run, sent by the runtime. */
  source: "entry" | "model" | "call";
  /** Set when another run called this one. */
  parent?: ParentLink;
  /** Random value chosen by the runtime; salts the digests a client sees. */
  nonce?: string;
  /** CORE_VERSION whose rules the run starts under (absent: this engine's). Any other is refused. */
  core?: number;
  /** Items to start with (`add` and `settle` only), for lists that may be given at the start as facts may. */
  items?: ItemOp[];
  /** Source model only: how the runtime judged each fact; a fact without a mark counts as stated. */
  marks?: Record<string, AssistMark>;
}

/** A typed output from the step's view (a Facet output, a button, a form). */
export interface OutputEvent extends EventBase {
  type: "output";
  stepId: string;
  name: string;
  payload: JsonValue;
  /** Required for confirm rules: the digest of the input the person reviewed. */
  digest?: string;
  /** The item the view showed: required for a step that runs once per item, refused otherwise. */
  item?: string;
  /**
   * The step epoch of the view the output came from. When present it must be
   * the step's current epoch, or the output is refused (`flow/stale-view`):
   * the view changed under the person, for example after a move to a newer
   * version. Absent from clients that do not send it.
   */
  epoch?: number;
}

/**
 * One change to a collection. Ids are minted by the core (`add`); every id
 * given must name a live item of that collection.
 */
export type ItemOp =
  /** Adds an item, with any fields given. */
  | { op: "add"; collection: string; fields?: Record<string, JsonValue> }
  /** Sets fields of an item; null clears one (people only). */
  | { op: "set"; collection: string; id: string; fields: Record<string, JsonValue | null> }
  /** Removes an item (people only). */
  | { op: "remove"; collection: string; id: string }
  /** States the list is complete as it stands; a model's settle waits for the person. */
  | { op: "settle"; collection: string };

/** Facts stated directly (a summary edit, typed text) or proposed by a decision model. */
export interface FactsInputEvent extends EventBase {
  type: "facts.input";
  /** null clears the fact (people only). */
  facts: Record<string, JsonValue | null>;
  source: "user" | "model";
  /** Changes to collections, applied in order after `facts`; at most 100. */
  items?: ItemOp[];
  /**
   * Model only: how the runtime judged each value in `facts` (a value
   * without a mark counts as stated). Every model's input goes through the
   * fill policy (ADR 0012), with or without marks.
   */
  marks?: Record<string, AssistMark>;
  /**
   * People only: take these facts' suggestions, or confirm the
   * assistant's values waiting for a yes, as the person's own. An entry that
   * names the assistant's `turn` takes only a value from that turn, and is
   * refused (`flow/accept-stale`) when the value now there came from another.
   */
  accept?: AcceptEntry[];
  /** People only: drop these facts' suggestions. */
  dismiss?: string[];
  /**
   * People only: restore what the assistant's turn (its event
   * id) replaced; with `facts`, only those facts of that turn.
   */
  undo?: UndoRequest;
}

/** One fact a person accepts: its name alone, or with the assistant's turn whose value they saw. */
export type AcceptEntry = string | { fact: string; turn?: string };

/** What a person's undo takes back: the assistant's turn, and optionally only some of its facts. */
export interface UndoRequest {
  turn: string;
  facts?: string[];
}

export interface ActionSettledEvent extends EventBase {
  type: "action.settled";
  effectId: string;
  attempt: number;
  outcome: ActionOutcome;
  /**
   * System only: the port's own answer for an attempt that an outside
   * completion had already settled (it arrived before "pending" was
   * recorded), disagreeing with it. The first outcome stands; this one is
   * kept in the log, and the effect needs a person (`attention`).
   */
  disputed?: true;
  /**
   * Outside callers only, set by the runtime: a completion with a valid token
   * that arrived after the engine had put its effect in doubt (its pending
   * timed out, say). The performer's report is recorded: it settles the
   * effect when it says what happened, and is kept for staff otherwise.
   */
  late?: true;
  /**
   * System only, on a `pending` outcome: how long to wait for its completion
   * (ms from this event), the operation's declared completion window, which
   * the runtime read from its operation registry. The pending timer then runs
   * for it instead of the call's `timeoutMs`.
   */
  windowMs?: number;
}

export interface TimerFiredEvent extends EventBase {
  type: "timer.fired";
  timerId: string;
  generation: number;
}

export interface ExternalEvent extends EventBase {
  type: "external";
  event: string;
  key: string;
  payload: JsonValue;
}

export interface RunCancelledEvent extends EventBase {
  type: "run.cancelled";
  reason?: string;
  /**
   * System only: a cancellation routed to the deepest run of a tree. Names the
   * run that was asked to cancel; the ends travel up and stop there.
   */
  cascade?: string;
  /**
   * System only: the person's data is being erased (`eraseSubject`). The run
   * ends whatever it committed: what it committed stays done (a committed
   * run ends `expired`), every other hold is released, and its live calls
   * are cancelled through their callers' usual path. Applied at a tree's root.
   */
  erase?: true;
}

/** The runtime's answer to `call.start`: the child run exists, or why not. On the caller. */
export interface CallStartedEvent extends EventBase {
  type: "call.started";
  callId: string;
  attempt: number;
  outcome:
    | { status: "ok"; flowVersion: string; flowHash: string }
    | { status: "retryable"; error: ActionError; retryAfterMs?: number }
    | { status: "final"; error: ActionError };
}

/** A child run ended. On the caller, sent by the runtime. */
export interface CallSettledEvent extends EventBase {
  type: "call.settled";
  callId: string;
  childRunId: string;
  end: CallEnd;
}

/** The caller no longer waits. On the child, sent by the runtime. */
export interface CallCancelledEvent extends EventBase {
  type: "call.cancelled";
  reason: CallCancelReason;
}

/** A person settles an effect whose outcome could not be determined. */
export interface EffectResolvedEvent extends EventBase {
  type: "effect.resolved";
  effectId: string;
  applied: boolean;
  output?: JsonValue;
}

/** The person came back to a run paused because its holds lapsed; the engine takes them again. */
export interface RunResumedEvent extends EventBase {
  type: "run.resumed";
}

/**
 * The run moves to another version of its flow. The new state is a pure
 * function of the old state, both definitions and this event; the core
 * recomputes the plan and refuses the event unless its fingerprint matches
 * `planHash`. Applied with `migrateStep`, never with `step`.
 */
export interface RunMigratedEvent extends EventBase {
  type: "run.migrated";
  from: VersionRef;
  to: VersionRef;
  /** Why the run moved: the target's publish policy, a revocation, or staff overriding a pinned run. */
  cause: "onNextTurn" | "forced" | "revoked" | "override";
  /** Fingerprint of the migration plan the runtime saw. */
  planHash: string;
  /** Core rules from here on: absent, or this engine's CORE_VERSION. */
  core?: number;
  /** The two people who approved a forced move. */
  approval?: { requestedBy: string; approvedBy: string };
  /** Shown to the person; at most 500 characters. */
  message?: string;
}

/** The run's version was withdrawn and the run could not move: it ends `failed` with reason `revoked`. */
export interface RunRevokedEvent extends EventBase {
  type: "run.revoked";
  version: string;
  hash: string;
  /** Shown to the person; at most 500 characters. */
  message?: string;
}

export type FlowEvent =
  | RunStartedEvent
  | RunResumedEvent
  | OutputEvent
  | FactsInputEvent
  | ActionSettledEvent
  | TimerFiredEvent
  | ExternalEvent
  | RunCancelledEvent
  | EffectResolvedEvent
  | RunMigratedEvent
  | RunRevokedEvent
  | CallStartedEvent
  | CallSettledEvent
  | CallCancelledEvent;

export type FlowEventType = FlowEvent["type"];

// ---------------------------------------------------------------------------
// Effects: what the engine asks the outside world to do
// ---------------------------------------------------------------------------

export interface ActionEffect {
  kind: "action";
  effectId: string;
  attempt: number;
  purpose: EffectPurpose;
  /** Flow action name. */
  name: string;
  /** Connector action id. */
  action: string;
  connection?: string;
  actingFor: "business" | "endUser";
  effect: "read" | "write";
  input: JsonObject;
  /** The backend may receive this effect more than once; it must de-duplicate on the key. */
  idempotent: boolean;
  timeoutMs: number;
  /** The action's declared risk, for admission policy. */
  risk: Risk;
  /** For reconcile and compensate: the effect id of the original write. */
  target?: string;
  /** The item a per-item action works on. For observability only; the idempotency key does not use it. */
  item?: string;
}

export interface TimerEffect {
  kind: "timer";
  timerId: string;
  generation: number;
  dueAt: number;
}

export interface TimerCancelEffect {
  kind: "timer.cancel";
  timerId: string;
}

export interface WaitEffect {
  kind: "wait.open" | "wait.close";
  stepId: string;
  event: string;
  key: string;
}

/** Starts, stops or answers a child run. Performed by the runtime, never by the action port. */
export type CallEffect =
  | {
      kind: "call.start";
      callId: string;
      attempt: number;
      childRunId: string;
      flowId: string;
      version: string;
      upgrade: "exact" | "compatible";
      input: JsonObject;
      parent: ParentLink;
    }
  | { kind: "call.cancel"; callId: string; childRunId: string; reason: CallCancelReason }
  | { kind: "call.return"; parentRunId: string; callId: string; childRunId: string; end: CallEnd };

export type FlowEffect = ActionEffect | TimerEffect | TimerCancelEffect | WaitEffect | CallEffect;
