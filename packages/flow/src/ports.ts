/**
 * Ports: everything the runtime needs from the outside world. The engine
 * never imports a framework, a database driver or a vendor SDK; hosts plug
 * those in here.
 */

import { deepFreeze } from "@aaply/action-contract/internal";
import type { ActionPort, EnvironmentKind } from "@aaply/action-contract";
import type { CompiledFlow } from "./compile.js";
import type { EndKind, Risk } from "./definition.js";
import type { StageTrace } from "./decision.js";
import type { RoutingMode } from "./policy.js";
import { hmacSha256, toBase64Url } from "./hash.js";
import type { LaneRecord } from "./lanes.js";
import type { ContractRecord } from "./operation-registry.js";
import type { ActionEffect, ActionOutcome, ActorKind, EffectPurpose, RunStatus, Scope } from "./state.js";

// The action port is part of the contract with performers (@aaply/action-contract).
export type { ActionPort };

/**
 * Who is calling, built by the host from its own authentication and server
 * records. Never from a request body, a section output or a model.
 */
export interface TrustedContext {
  scope: Scope;
  /** `production`, `preview`, or `test` (automated runs). It reaches the performer, which uses only a connection of the same kind. */
  environmentKind: EnvironmentKind;
  actor: {
    /**
     * Identity domain, e.g. "visitor" or "member"; ids are unique within it.
     * "system" is reserved for the engine's own actors and refused (`invalid`).
     */
    domain: string;
    kind: Exclude<ActorKind, "system">;
    id: string;
    authTime?: number;
    grantVersion?: number;
  };
  /** The person the call is for, when the actor is acting for someone else (staff, a channel). */
  subject?: { domain: string; id: string };
  /** The channel or service the call came through. */
  via?: { kind: string; id: string };
  appRoles: string[];
  placement?: { region: string; cell?: string; epoch?: number };
  locale: string;
  /**
   * The person's IANA time zone. Optional since 0.3: without it, or when it
   * is not a zone this runtime knows, the app's policy `timezone`, then the
   * runtime's `defaultTimezone`, then UTC is used, and the run records which.
   */
  timezone?: string;
  requestId: string;
  /**
   * The W3C `traceparent` of the request, for correlation only (no tracer
   * runs here). A well-formed one goes on the events the request causes, and
   * on every envelope of the work it sets in motion, retries, timers and
   * undos included. A malformed one is dropped and reported to
   * `observer.error` as `traceparent`; it never refuses the call.
   */
  traceparent?: string;
}

/** Whose discovery a catalog's `list` serves: the app roles from their trusted context. */
export interface CatalogViewer {
  appRoles: string[];
}

/** Published flows for an app and environment. Versions are immutable. */
export interface FlowCatalog {
  /**
   * A specific version, or the current published version when `version` is
   * omitted. Revoked versions are still returned: their runs must load.
   */
  get(scope: Scope, flowId: string, version?: string): Promise<CompiledFlow | null>;
  /**
   * Published flows, for discovery: `turn` offers them, matches their
   * `names` exactly and sends them to a decider as goals, and
   * `runtime.goals` lists them. `viewer` (absent when a host calls it
   * without one) says whose discovery it is: a catalog may then also list
   * flows with `startRoles` the viewer holds one of. Without a viewer, list
   * only flows anybody may start. The runtime reads each listed flow with
   * `get` and leaves out those only another flow may call
   * (`interface.callableOnly`) and those the viewer may not start, whatever
   * the catalog lists, so `get` should be cheap (cached).
   * `createMemoryCatalog` lists flows with `startRoles` only for a viewer
   * holding one of them.
   */
  list(scope: Scope, viewer?: CatalogViewer): Promise<Array<{ flowId: string; version: string; title: string; description?: string; phrases?: string[]; names?: string[] }>>;
  /**
   * How one published version treats live runs: its migration policy, and
   * whether it was revoked. Optional: a catalog without it keeps every run on
   * its own version and revokes nothing.
   */
  status?(scope: Scope, flowId: string, version: string): Promise<VersionStatus | null>;
  /** Every published version of a flow, oldest first. Optional, like `status`. */
  versions?(scope: Scope, flowId: string): Promise<VersionStatus[]>;
}

/**
 * How runs of earlier versions come to a version, set by the host per
 * environment (operational, not part of the definition's hash). A run moves
 * only to the current version, and only when that version lists the run's
 * version in its `migrations`.
 * - `pinned` (the default): runs stay on the version they started with.
 * - `onNextTurn`: a run moves after the person's next input, once it is idle.
 * - `forced`: runs also move after system events and in `migrateAll` sweeps,
 *   once two different people approved it.
 * `from` narrows the policy to some source versions.
 */
export type MigrationPolicy =
  | { mode: "pinned" }
  | { mode: "onNextTurn"; from?: string[]; message?: string }
  | { mode: "forced"; from?: string[]; message?: string; approval: MigrationApproval };

/**
 * Two people's approval of a forced move. Built by the catalog from each
 * person's `TrustedContext` (`domain:id`), never from a request body: one
 * person asks, a different one approves.
 */
export interface MigrationApproval {
  requestedBy: string;
  approvedBy: string;
  approvedAt: number;
}

/**
 * A version withdrawn because it must not keep running (a defect, a legal
 * change). Its runs move to the current version (`then: "migrate"`) where
 * they can, and otherwise end `failed` with reason `revoked`. Nothing new
 * starts on it.
 */
export interface Revocation {
  at: number;
  /** Who revoked it (`domain:id` from their `TrustedContext`). */
  by: string;
  then: "migrate" | "end";
  /** Shown to the people whose runs it affects (at most 500 characters). */
  message: string;
}

/** One published version's place in the catalog. */
export interface VersionStatus {
  flowId: string;
  version: string;
  hash: string;
  publishedAt: number;
  current: boolean;
  policy: MigrationPolicy;
  revoked?: Revocation;
}

export interface Clock {
  now(): number;
}

export interface IdSource {
  newId(): string;
}

export interface KeyMinter {
  idempotencyKey(parts: { scope: Scope; connection?: string; action: string; effectId: string }): string;
}

/** `call`: a run starting a child run (every attempt). */
export type AdmissionOp = "start" | "submit" | "turn" | "decide" | "deliver" | "action" | "call";

/**
 * An admission answer. An `ok` for an action may name the policy `version`
 * it was judged under; the approved action carries it to the performer.
 *
 * A refusal with `defer: true` (op `action` only) means "not now, ask again
 * after `retryAfterMs`": the action is not sent, no attempt is spent and
 * nothing is recorded, within `limits.maxDeferMs` of the attempt's dispatch;
 * past it, it is recorded as a refusal like any other (see
 * `RuntimeLimits.maxDeferMs`). For any other op it is a refusal.
 */
export type Admission = { ok: true; policy?: { version: string } } | { ok: false; code: string; retryAfterMs?: number; defer?: boolean };

/**
 * What admission is told about an action it admits (op `action`). The run
 * fields say what it is part of, so a host can pause new writes of a tenant
 * or a flow (answering `defer`) while undos (`purpose: "compensate"`) and
 * checks (`"reconcile"`) go through. They are absent only for an outbox row
 * whose run could not be read with it.
 */
export interface AdmissionAction {
  id: string;
  effect: "read" | "write";
  purpose: "run" | "compensate" | "reconcile";
  risk: Risk;
  /** The run the action is for. */
  runId?: string;
  /** The version of the run's flow (the flow id is the context's `flowId`). */
  flowVersion?: string;
  /** The step that runs the action. */
  step?: string;
  /** Whether the run has passed a commit point: what it did then stays done, whatever happens next. */
  committed?: boolean;
}

/**
 * Quotas, rate limits and budgets (including model spend). `stage` names a
 * decider stage, for hosts that budget each stage (see the chain's
 * `beforeStage`); `action` describes the action admitted (op `action`,
 * whose `flowId` is the run's flow).
 */
export interface AdmissionPort {
  admit(context: { scope: Scope; actorId?: string; op: AdmissionOp; flowId?: string; stage?: string; action?: AdmissionAction }): Promise<Admission>;
}

/**
 * Why the engine accepted a transition. Every accepted event has one:
 * - `rule`: a rule the flow's pinned version publishes (a step's output rule,
 *   a wait's event rule, a fact a step asks for, the flow's entry facts) or
 *   one of the person's own controls (cancel, resume);
 * - `exact`: an exact published name, or a reserved `open` output, in a turn;
 * - `pick`: a person picked an offered option or answered yes or no;
 * - `model`: a decider's proposal in a turn (checked like any other input);
 * - `system`: the engine's own work (an action's outcome, a timer, staff
 *   settling an effect, erasure, a move to another version or a revocation
 *   under the catalog's policy).
 */
export type TraceBasis = "rule" | "exact" | "pick" | "model" | "system";

/** An action's outcome as a trace records it: ids, its status and error code, never its output or message. */
export interface TraceSettled {
  effectId: string;
  attempt: number;
  status: ActionOutcome["status"];
  /** The outcome's error code, when it has one. */
  code?: string;
  /** The flow's name for the action, and what the effect was for (`compensate` is an undo, `reconcile` a check). */
  action?: string;
  purpose?: EffectPurpose;
  /** How long the action port took to answer, from building the envelope (on the runtime clock); absent for a completion or an outcome the engine made itself. */
  latencyMs?: number;
}

/**
 * One transition, for an `Observer`: names, ids, codes and numbers, never a
 * value. The observer hears it in process, at most once, after the commit:
 * a crash loses it, and instances do not order theirs. Build anything that
 * must be exact (usage, billing) from the event log, matching by `seq`.
 */
export interface TraceRecord {
  scope: Scope;
  runId: string;
  flowId: string;
  flowVersion: string;
  revision: number;
  event: string;
  before: string | null;
  after: string | null;
  /** Names only, never values. */
  factsChanged: string[];
  factsCleared: string[];
  effects: string[];
  rejected?: string;
  durationMs: number;
  /** Why the transition was accepted. */
  basis: TraceBasis;
  /** For `rule` from a step's output: the step and output names. */
  rule?: { step: string; output: string };
  /** For `exact`, `pick` and `model`: the turn that caused it (see `Observer.turn`). */
  turnId?: string;
  /** Set for a child run: its caller, the top of its tree, and how deep it is (1 for a root's child). */
  parentRunId?: string;
  rootRunId?: string;
  depth?: number;
  /** When the event happened: its `at`, epoch milliseconds on the runtime clock. Absent on a blocked move's record, which has no event. */
  at?: number;
  /** The event's id. */
  eventId?: string;
  /** The event's sequence number in the run's log (`StoredEvent.seq`): present only when the event was committed. */
  seq?: number;
  /** The run's status after the event. */
  status?: RunStatus;
  /** Once the run's end has begun: how it ends, and the reason code. */
  end?: { kind: EndKind; reason?: string };
  /** For an `action.settled` event: the outcome, and how long the port took. */
  settled?: TraceSettled;
}

/** What one turn decided: ids, probabilities and timings, never the text or a fact's value. */
export interface TurnRecord {
  scope: Scope;
  turnId: string;
  at: number;
  mode: RoutingMode;
  /** What decided: an exact name, a pick, a model, or nothing (no decider, or it failed). */
  basis: "exact" | "model" | "pick" | "none";
  outcome: TurnOutcome;
  /** A `flow/...` code when the turn did not do what was asked, or was answered by a fallback. */
  reason?: string;
  activeFlowId?: string;
  /** The flow, run or offer the outcome is about. */
  chosen?: { flowId?: string; runId?: string; offerId?: string };
  stages: StageTrace[];
  /** `auto` was configured without matching calibration, so the turn ran as `suggest`. */
  downgraded?: boolean;
  textLength: number;
  locale: string;
  channel?: string;
  policyVersion?: string;
  /** Free text, or a reserved `open` output from a section. */
  input: "text" | "open";
  /** 0.3: how many of a decider's values were judged stated, inferred (suggested only) and unclear (asked again). Counts only. */
  assist?: { stated: number; inferred: number; unclear: number };
}

/** What a turn did, as its `TurnRecord` says. */
export type TurnOutcome = "opened" | "resumed" | "filled" | "offered" | "consent" | "answered" | "clarify" | "nomatch" | "unchanged";

/** A person picked from (or dismissed) an offer. With `TurnRecord`s, labels for learning: turn id to flow. */
export interface PickRecord {
  scope: Scope;
  turnId: string;
  offerId: string;
  at: number;
  /** The flow picked, or null when the offer was dismissed. */
  picked: string | null;
  /** Its position in the offer (1-based), or null. */
  position: number | null;
}

export interface Observer {
  trace?(record: TraceRecord): void;
  error?(error: unknown, where: string): void;
  /** Lane activity (names only): claims, busy refusals, pauses. */
  lane?(record: LaneRecord): void;
  /** One record per turn. Hosts that keep them should partition them by time. */
  turn?(record: TurnRecord): void;
  pick?(record: PickRecord): void;
  /**
   * A call of a flow version pinned to an operation contract the runtime's
   * registry (`RuntimeOptions.operations`) cannot see: reported once per flow
   * version and process, the first time an action of that version is sent.
   * Dispatch is never refused for it.
   */
  contract?(record: ContractRecord): void;
}

/**
 * How the runtime puts effects in lanes, for stores with fair lanes
 * (`RunStore.lanes`). Without such a store it is not used.
 */
export interface LanePolicy {
  /**
   * The lane (and lane class) of a connector action. Default: its connection
   * role, else its connector, with the connector as class. A name that is
   * not a lane name (`LANE_NAME_RE`), or a throw, falls back to the default
   * and is reported. Effects that are not connector actions are always in lane `"-"`.
   */
  classify?: (scope: Scope, effect: ActionEffect) => { lane: string; laneClass?: string };
  /** A run with input from a person this recently counts as interactive. Default 60 s. */
  interactiveWindowMs?: number;
  /** How long an inline effect is reserved (claims 0) before workers may take it. Default 5 s. */
  inlineGraceMs?: number;
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

export const systemClock: Clock = deepFreeze({ now: () => Date.now() });

/** UUIDv7 ids: time-ordered, so new rows land together in indexes. */
export function uuidv7Ids(clock: Clock = systemClock): IdSource {
  return {
    newId() {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      const ms = clock.now();
      bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
      bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
      bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
      bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
      bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
      bytes[5] = ms & 0xff;
      bytes[6] = (bytes[6]! & 0x0f) | 0x70;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}

/**
 * Idempotency keys as HMAC(secret, tenant|app|environment|connection|action|effect).
 * The secret must be the same on every runtime instance so a retry from any
 * worker produces the same key, and must stay private so keys cannot be
 * forged for another tenant.
 */
const LONE_SURROGATE = /\p{Cs}/u;

export function hmacKeyMinter(secret: string | Uint8Array): KeyMinter {
  const material = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  if (material.length < 16) throw new Error("idempotency secret must be at least 16 bytes");
  return {
    idempotencyKey({ scope, connection, action, effectId }) {
      const parts = [scope.tenantId, scope.appId, scope.environmentId, connection ?? "", action, effectId];
      // A lone surrogate would encode as U+FFFD and collide with another id.
      if (parts.some((p) => typeof p !== "string" || LONE_SURROGATE.test(p))) throw new Error("idempotency key parts must be well-formed strings");
      // Length-prefixed parts, so no two different part lists encode the same message.
      const message = parts.map((p) => `${p.length}:${p}`).join("|");
      return toBase64Url(hmacSha256(material, message));
    },
  };
}

export const allowAll: AdmissionPort = deepFreeze({ admit: async () => ({ ok: true }) });
