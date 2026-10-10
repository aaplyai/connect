/**
 * What every runtime module shares: the context one runtime instance is
 * built from (its ports, limits and counters), and the internal shapes the
 * modules pass between them. Internal: nothing here is exported from an entry.
 */

import type { EnvelopeSigning } from "../approved.js";
import type { OperationContracts } from "../bindings.js";
import { clampMaxDefer } from "../admission.js";
import { DEFAULT_MAX_CALL_DEPTH, MAX_CALL_DEPTH } from "../calls.js";
import type { CompiledFlow } from "../compile.js";
import type { StepResult } from "../core.js";
import type { MigrationPlan } from "../migrate.js";
import type { DecisionGoal, DecisionPort } from "../decision.js";
import type { LaneSignal } from "../lanes.js";
import type { ResolvedPolicy } from "../policy.js";
import { type TrustedContext, type TurnRecord, type FlowCatalog, type ActionPort, type KeyMinter, type Clock, type IdSource, type AdmissionPort, type Observer, type LanePolicy, systemClock, uuidv7Ids, allowAll, type VersionStatus } from "../ports.js";
import { UnseenContractReporter } from "../operation-registry.js";
import { ContractNegotiator } from "../contract-versions.js";
import { RequestFields } from "../request-fields.js";
import type { OutboxLease, WorkspaceState, PendingOffer, OutboxItem, RunStore } from "../store.js";
import type { ActorRef, RunState, ActionEffect, CallEffect, RunMigratedEvent, ActionOutcome, Scope } from "../state.js";
import type { NormaliseContext } from "../assist/normalise.js";
import { versionCheckedStore } from "../stored-versions.js";
import { type InputVouch, inputVouch } from "../runtime-blobs.js";
import type { FlowView } from "../view.js";
import * as privacy from "../privacy-runtime.js";
import { type RuntimeOptions, type RuntimeLimits, DEFAULT_RUNTIME_LIMITS } from "../runtime.js";
import { portFailure } from "./helpers.js";
import { revokedOf } from "../versions.js";

export const SYSTEM_ACTOR: ActorRef = { kind: "system", id: "system:runtime", roles: [] };

/** What a decision port that did not answer in time resolves to. */
export const TIMED_OUT: unique symbol = Symbol("timed-out");

export interface Chain {
  depth: number;
  deadline: number;
  /** Shared by every round of one request: the first busy refusal it met, for its response. */
  busy?: { value?: Busy };
}

export type Busy = NonNullable<FlowView["busy"]>;

/** For effects settled after the request answered: anything they cause goes to workers. */
export const NO_INLINE: Chain = { depth: Number.POSITIVE_INFINITY, deadline: 0 };

export interface Housekeeping {
  outboxDone?: string[];
  /** Leases on items of `outboxDone` the commit removes only while they hold (a cancel's withdrawals). */
  outboxTaken?: OutboxLease[];
  timerDone?: { timerId: string; generation: number };
  /** Lane signals of the outcome being recorded; they ride in its commit. */
  signals?: LaneSignal[];
}

export interface Applied {
  state: RunState;
  flow: CompiledFlow;
  result: StepResult | null;
  /** The taken writes (`withdraw`) recorded withdrawn in the event's commit, by outbox item id. */
  withdrawn?: readonly string[];
}

export type Loaded = { state: RunState; flow: CompiledFlow };

export type Goal = DecisionGoal;

/** One turn in progress: what it saw, and the record it will emit. */
export interface Turn {
  ctx: TrustedContext;
  workspaceId: string;
  /** The workspace as loaded; changes saved through it keep it current. */
  ws: WorkspaceState;
  policy: ResolvedPolicy;
  /** The workspace's active run: what a switch sets aside and a cancel ends. */
  root: Loaded | null;
  /** The deepest live run under `root` (`root` itself when it calls nothing): what the person's words are about. */
  active: Loaded | null;
  offer: PendingOffer | null;
  turnId: string;
  now: number;
  record: TurnRecord;
  /** The workspace was written apart from `ws`, so views must load it again. */
  touched: boolean;
  parked?: Array<{ runId: string; flowId: string; title: string }>;
}

/** An outbox item for the action port. */
export type ActionItem = OutboxItem & { effect: ActionEffect };

/** An outbox item the runtime performs itself: a call's start, cancel or return. */
export type CallItem = OutboxItem & { effect: CallEffect };

export type CallStartEffect = Extract<CallEffect, { kind: "call.start" }>;

export const isActionItem = (item: OutboxItem): item is ActionItem => item.effect.kind === "action";

/** What one attempt to move a run did. */
export interface Moved {
  outcome: "moved" | "ended" | "blocked" | "none";
  plan: MigrationPlan | null;
  applied: Applied | null;
  /** The first blocker, when blocked. */
  code?: string;
}

/** A move to make: why, where to, and what the person is told. */
export interface MoveRequest {
  cause: RunMigratedEvent["cause"];
  to: CompiledFlow;
  message?: string;
  approval?: { requestedBy: string; approvedBy: string };
}

/** Most runs one `migrateAll` call looks at. */
export const MAX_SWEEP = 500;

/** The outcome recorded for an effect a revoked version's run never sent. */
export const REVOKED_OUTCOME: ActionOutcome = { status: "final", error: { code: "flow/version-revoked", message: "This version was withdrawn, so this was not done." } };

/** Who is asking, for calls that act on a run for a caller. */
export interface Access {
  ctx: TrustedContext;
  staffOnly?: boolean;
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export const DIGEST_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Largest view epoch an output may name. */
export const MAX_EPOCH = 1_000_000_000;

/** What every runtime module shares: the ports, the limits and the per-instance counters. */
export class RuntimeContext {
  readonly catalog: FlowCatalog;
  readonly store: RunStore;
  readonly actions: ActionPort;
  readonly keys: KeyMinter;
  readonly envelopes: EnvelopeSigning | undefined;
  readonly operations: OperationContracts | undefined;
  /** Reports the pins of each flow version that `operations` cannot see, once. */
  readonly unseen: UnseenContractReporter;
  /** The envelope version the action port serves. */
  readonly contracts: ContractNegotiator;
  /** When effects' first attempts were dispatched, as found by stepping their logs (`deferralSince`). */
  readonly firstDispatches = new Map<string, number>();
  /** Requests' `traceparent`, malformed ones reported. */
  readonly requests: RequestFields;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly decide: DecisionPort | undefined;
  readonly policy: RuntimeOptions["policy"];
  readonly admission: AdmissionPort;
  readonly observer: Observer;
  /** The host's vouch for the file references a caller gives, asked after the request's own checks (ADR-0008 §4). */
  readonly vouch: InputVouch;
  readonly workerId: string;
  /** Inline calls this instance has reserved for: each call's reservations get an owner of their own. */
  inlineCalls = 0;
  withdrawals = 0;
  readonly privacyRoles: string[];
  readonly holdRoles: string[];
  readonly privacyDeps: privacy.PrivacyDeps;
  readonly migrationRoles: string[];
  readonly limits: RuntimeLimits;
  readonly lanePolicy: LanePolicy;
  readonly defaultTimezone: string | undefined;
  readonly normaliser: Pick<NormaliseContext, "custom">;
  readonly randomBytes: (out: Uint8Array) => void;

  constructor(options: RuntimeOptions) {
    this.catalog = typedCatalog(options.catalog);
    // A workspace of an unknown version (a newer engine's) is refused as it loads.
    this.store = versionCheckedStore(options.store);
    this.actions = options.actions;
    this.keys = options.keys;
    this.envelopes = options.envelopes;
    this.operations = options.operations;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? uuidv7Ids(this.clock);
    this.decide = options.decide;
    this.policy = options.policy;
    this.admission = options.admission ?? allowAll;
    this.observer = options.observer ?? {};
    this.vouch = inputVouch(options.blobs, this.observer);
    this.unseen = new UnseenContractReporter(this.operations, (record) => this.observer.contract?.(record));
    this.contracts = new ContractNegotiator(this.actions, this.clock, (error, where) => this.observer.error?.(error, where));
    this.requests = new RequestFields((error, where) => this.observer.error?.(error, where));
    this.workerId = options.workerId ?? `worker-${this.ids.newId()}`;
    this.privacyRoles = options.privacyRoles ?? ["privacy"];
    this.holdRoles = options.holdRoles ?? ["legal-hold"];
    this.privacyDeps = { store: this.store, clock: this.clock, observer: this.observer };
    this.migrationRoles = options.migrationRoles ?? ["flow-admin"];
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...options.limits };
    this.lanePolicy = options.lanes ?? {};
    this.limits.maxCallDepth = Math.max(1, Math.min(Math.floor(this.limits.maxCallDepth) || DEFAULT_MAX_CALL_DEPTH, MAX_CALL_DEPTH));
    this.limits.maxDeferMs = clampMaxDefer(this.limits.maxDeferMs);
    this.defaultTimezone = options.defaultTimezone;
    this.normaliser = options.normalise !== undefined ? { custom: options.normalise } : {};
    this.randomBytes = options.randomBytes ?? ((out) => void globalThis.crypto.getRandomValues(out));
  }
}

/**
 * The catalog, with its errors typed (`portFailure`). Each call reads the
 * host's catalog at the time, so a method the host replaces or adds later is
 * the one used, and an optional one stays absent while the host has none.
 */
export function typedCatalog(inner: FlowCatalog): FlowCatalog {
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw portFailure(error, "catalog");
    }
  };
  const typed: FlowCatalog = {
    get: (scope, flowId, version) => guard(() => inner.get(scope, flowId, version)),
    list: (scope, viewer) => guard(() => (viewer === undefined ? inner.list(scope) : inner.list(scope, viewer))),
  };
  // Optional methods are read when used: absent (undefined) while the host's catalog has none.
  Object.defineProperties(typed, {
    status: {
      enumerable: true,
      get: () => {
        const status = inner.status;
        return status ? (scope: Scope, flowId: string, version: string) => guard(async () => normalStatus(await status.call(inner, scope, flowId, version))) : undefined;
      },
    },
    versions: {
      enumerable: true,
      get: () => {
        const versions = inner.versions;
        return versions ? (scope: Scope, flowId: string) => guard(async () => (await versions.call(inner, scope, flowId)).map((v) => normalStatus(v))) : undefined;
      },
    },
  });
  return typed;
}

/**
 * A host catalog's status as the runtime reads it: a `revoked` that is
 * `null` (a database NULL passed through) is left out, so it means "not
 * revoked" wherever a status is read (see `revokedOf`).
 */
export function normalStatus<T extends VersionStatus | null>(status: T): T {
  if (status === null || typeof status !== "object" || !Object.prototype.hasOwnProperty.call(status, "revoked") || revokedOf(status) !== undefined) return status;
  const copy = { ...status };
  delete copy.revoked;
  return copy;
}
