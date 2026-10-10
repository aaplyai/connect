/**
 * The storage port. A store keeps run state, the event log, the effect
 * outbox, durable timers and wait correlations, and commits them together.
 *
 * Contract (every implementation must pass `storeConformanceCases` from `@aaply/flow/testing`):
 * - `commit` is atomic: all of a batch is stored, or none of it.
 * - Optimistic concurrency: a run write applies only if the stored revision
 *   equals `expectedRevision` (0 means "must not exist yet"). Otherwise the
 *   commit stores nothing (no run, workspace, event, outbox item, timer or
 *   wait of the batch) and reports a conflict. Same for workspaces. Of
 *   several concurrent commits at one revision, exactly one wins.
 * - Everything is keyed by scope; a load or lookup with another tenant's
 *   scope finds nothing.
 * - `claimOutbox` and `claimTimers` hand each due item to one owner at a
 *   time (a lease), also under concurrent claims; an expired lease makes the
 *   item claimable again.
 * - An outbox item is stored as given, with its `claims` and lease: an item
 *   added with a lease (an effect performed inline) is not claimable until
 *   the lease ends. Adding an id that already exists changes nothing, so a
 *   repeat can never reset the claim count that keeps an interrupted
 *   non-idempotent write from being sent again. `done` applies before `add`.
 * - `renewOutbox` and `releaseOutbox` change an item only while it is still
 *   leased to the given owner until the given time: an owner whose lease ran
 *   out (and may now be another owner's) changes nothing.
 * - `takeOutbox` (optional) leases an item only while no claim counts it and
 *   no lease holds it, atomically against `claimOutbox`. A store with it
 *   honours `outbox.taken` in `commit`: the batch applies only while each
 *   lease there still holds its item (same owner, same end); otherwise the
 *   commit stores nothing and reports conflict `outbox`.
 *
 * Lanes (optional, `RunStore.lanes`; cases in `laneConformanceCases`):
 * - `claimOutbox` takes items round-robin across tenants, then across each
 *   tenant's lanes from one claim to the next; interactive items go first
 *   within a tenant's round, never ahead of another tenant's turn. It never
 *   grants past a lane's cap, reserve, tokens, pause or breaker, also under
 *   concurrent claimers. In flight is derived from leases. An item without
 *   lane fields is in lane `"-"`, background, which is never limited.
 *   `claimTimers` goes round-robin across tenants. Both do work whenever
 *   work is due, however many lanes or tenants hold only work that is not.
 * - `commit` applies `lanes.signals` atomically with the batch.
 *
 * Holds (optional, `RunStore.privacy`; ADR-0010):
 * - A hold in force covers what it names; `eraseRun` and `eraseWorkspaces`
 *   refuse what one covers, checking atomically with the delete, and a hold
 *   placed concurrently with an erasure either is seen by it or waits until
 *   that erasure has completed.
 * - A hold is released only from the scope that placed it.
 * - The privacy log is append-only and survives the erasure it records.
 *
 * Blob ledger (optional, `RunStore.blobs`; ADR-0008, cases in
 * `blobLedgerConformanceCases`): `eraseRun` and `eraseWorkspaces` record
 * the `releases` they are given atomically with the erasure, and none when
 * they refuse it; `listReleases` lists a release only once its erasure has
 * completed and no run stored in its scope names its file (`blobsInUse`,
 * which a store with a ledger has).
 */

import type { EnvironmentKind } from "@aaply/action-contract";
import type { ActionDispatch } from "./approved.js";
import type { StoreHealth, StoreHealthOptions } from "./health.js";
import type { BlobLedger, BlobRelease } from "./blob-ledger.js";
import type { JsonValue } from "./json.js";
import type { BusyReason, LaneSignal, LaneStats, Priority } from "./lanes.js";
import type { PrivacyOps, RunErasure, WorkspaceErasure } from "./privacy.js";
import type { ActionEffect, CallEffect, FlowEvent, ItemOp, RunState, Scope } from "./state.js";

export interface OutboxItem {
  /**
   * `${effectId}#${attempt}` for an action. For a call: `${callId}#${attempt}`
   * (start), `${callId}#cancel` and `${childRunId}#return`.
   */
  id: string;
  scope: Scope;
  /** The run whose commit added it: the caller for a call's start or cancel, the child for its return. */
  runId: string;
  effect: ActionEffect | CallEffect;
  /**
   * Facts about the run the action port needs, captured at commit time.
   * `dispatch` (who and what approved the effect) is absent on rows written
   * before it existed; the runtime then reads it from the run.
   */
  context: { subjectId: string | null; environment: EnvironmentKind; dispatch?: ActionDispatch };
  availableAt: number;
  /** How many times the item has been leased. Above 1 means an earlier attempt was interrupted. */
  claims: number;
  leaseOwner?: string;
  leaseUntil?: number;
  /** The item's lane name; absent means `"-"`, the lane that is never limited. */
  lane?: string;
  /** The lane class (the connector), for platform-wide ceilings. Absent means `"-"`. */
  laneClass?: string;
  /** Absent means background. */
  priority?: Priority;
  /** Set on a claimed item that is its half-open lane's probe; its outcome closes or reopens the breaker. */
  probe?: boolean;
  /** The end user's connection (an opaque key), for a Retry-After that pauses only that connection. */
  connectionKey?: string;
}

/** A lease an owner holds on an outbox item: as its claim (or the commit that added it leased) gave it. */
export interface OutboxLease {
  id: string;
  owner: string;
  /** The lease's end, as the item carries it (`leaseUntil`). */
  until: number;
}

export interface TimerItem {
  scope: Scope;
  runId: string;
  timerId: string;
  generation: number;
  dueAt: number;
  leaseOwner?: string;
  leaseUntil?: number;
}

export interface WaitItem {
  scope: Scope;
  runId: string;
  stepId: string;
  event: string;
  key: string;
}

export interface PendingConsent {
  kind: "switch" | "cancel";
  flowId?: string;
  facts?: Record<string, JsonValue>;
  /** Items a model proposed for the new run's lists: adds only, never a secret field. */
  items?: ItemOp[];
  runId?: string;
  askedAt: number;
  /** What proposed it: an exact name, a person's pick, or a model. */
  basis: "exact" | "pick" | "model";
  /** The turn that asked: an answer must name it. */
  turnId: string;
}

/**
 * Options offered to a person after a turn, waiting for them to pick one
 * (`FlowRuntime.choose`). Options name flows from the catalog at the time,
 * and start whatever version is current when picked.
 */
export interface PendingOffer {
  id: string;
  /** The turn that made the offer. */
  turnId: string;
  askedAt: number;
  /** After this, the offer reads as gone. */
  expiresAt: number;
  options: Array<{
    /** Positional: "1" is the first option. */
    id: string;
    flowId: string;
    title: string;
    description?: string;
    /** Set when picking it brings back this parked run. */
    runId?: string;
    /** Facts a model extracted, applied as a model's when the run starts. Never secret ones. */
    facts?: Record<string, JsonValue>;
  }>;
}

/** One person's stage in one app: the run in front of them and the ones set aside. */
export interface WorkspaceState {
  /** The workspace format (`WORKSPACE_VERSION`); the runtime refuses any other. */
  v: 2;
  id: string;
  scope: Scope;
  owner: string;
  revision: number;
  active: string | null;
  parked: string[];
  pending: PendingConsent | null;
  /** An open offer, or null. At most one of `pending` and `offer` is set. */
  offer: PendingOffer | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunWrite {
  runId: string;
  /** Stored revision this write was computed from; 0 for a new run. */
  expectedRevision: number;
  state: RunState;
  /** Appended in order; their sequence numbers follow `expectedRevision`. */
  events: FlowEvent[];
}

/**
 * One atomic write. Within it, outbox `done` is applied before `add`, timer
 * `done` before `set` before `cancel`, and wait `close` before `open`, so an
 * effect id or wait that is finished and started again in one batch ends up
 * started.
 */
export interface CommitBatch {
  scope: Scope;
  runs: RunWrite[];
  workspace?: { state: WorkspaceState; expectedRevision: number };
  outbox?: {
    add?: OutboxItem[];
    done?: string[];
    /**
     * Leases the batch holds on items it settles (a cancel's withdrawals,
     * taken with `takeOutbox`; the runtime lists their ids in `done` too).
     * The batch applies only while each is still leased to that owner until
     * that time, checked atomically with the commit: otherwise the commit
     * stores nothing and reports conflict `outbox` with the item's id (its
     * lease ran out and another owner may hold it, and be sending it). A
     * store without `takeOutbox` is never given any.
     */
    taken?: OutboxLease[];
  };
  timers?: {
    /** Removes the timer only if it still has this generation. Applied first. */
    done?: Array<{ runId: string; timerId: string; generation: number }>;
    /** Upserts by (runId, timerId). */
    set?: TimerItem[];
    cancel?: Array<{ runId: string; timerId: string }>;
  };
  waits?: { open?: WaitItem[]; close?: Array<{ runId: string; stepId: string }> };
  /** Lane signals from the outcomes this batch records, applied atomically with it (stores with `lanes`). */
  lanes?: { now: number; signals: LaneSignal[] };
}

/** A commit's answer: on a conflict, which run, workspace or taken outbox item (`outbox.taken`) it was. */
export type CommitResult = { ok: true } | { ok: false; conflict: "run" | "workspace" | "outbox"; id: string };

export interface ClaimOptions {
  owner: string;
  now: number;
  limit: number;
  leaseMs: number;
}

export interface StoredEvent {
  runId: string;
  seq: number;
  event: FlowEvent;
}

/** What `claimInline` decided for each reserved item. */
export interface InlineGrant {
  /** Leased for inline work: perform these now. */
  granted: OutboxItem[];
  /**
   * Not leased: the lane is full, out of tokens, paused or open (the item
   * is now claimable by workers, with its claims unchanged), or the item is
   * no longer a reservation of this owner (`taken`).
   */
  refused: Array<{ id: string; reason: BusyReason | "taken"; retryAfterMs?: number }>;
}

/** Lane operations of a store with fair lanes. */
export interface LaneOps {
  /**
   * Leases these just-added items (reservations: claims 0, leased by `owner`
   * for a short grace) for inline work, as far as their lanes admit them, in
   * the order given. Granted items get one claim and a `leaseMs` lease;
   * refused ones become claimable now. Scoped: ids of another scope match nothing.
   */
  claimInline(scope: Scope, ids: string[], options: { owner: string; now: number; leaseMs: number }): Promise<InlineGrant>;
  /** Lanes with queued or in-flight items or with state, for operators. */
  stats(options: { now: number; scope?: Scope; limit?: number }): Promise<LaneStats[]>;
}

/** Options of `RunStore.eraseRun` and `eraseWorkspaces`. */
export interface EraseOptions {
  /** The time holds are checked at (default: the store's own clock). */
  now?: number;
  /**
   * File references this erasure releases (ADR-0008): a store with `blobs`
   * records them in its ledger atomically with the erasure, and records
   * nothing when it refuses. Another run may still name one: the ledger
   * lists it once none does. Ignored by a store without a ledger.
   */
  releases?: readonly BlobRelease[];
}

export interface RunStore {
  /** Present when the store has fair lanes; the runtime then reserves inline work and sends lane signals. */
  lanes?: LaneOps;
  /** Present when the store keeps the blob ledger: erasure records the file references it released there first (ADR-0008). */
  blobs?: BlobLedger;
  loadRun(scope: Scope, runId: string): Promise<RunState | null>;
  loadWorkspace(scope: Scope, workspaceId: string): Promise<WorkspaceState | null>;
  commit(batch: CommitBatch): Promise<CommitResult>;
  /** Runs in `scope` waiting for `event` with correlation `key`. */
  findWaiting(scope: Scope, event: string, key: string): Promise<Array<{ runId: string; stepId: string }>>;
  /** Leases due outbox items across all tenants (for workers). */
  claimOutbox(options: ClaimOptions): Promise<OutboxItem[]>;
  /**
   * Extends a lease the owner still holds to `leaseUntil` (before an item is
   * sent, and before its outcome is recorded). False when it does not hold
   * that lease any more: the lease ran out and the item may be another
   * owner's, or the item is done. The owner must then not send the item.
   */
  renewOutbox(scope: Scope, lease: OutboxLease, leaseUntil: number): Promise<boolean>;
  /**
   * Hands back an item the owner holds without having sent it: the claim its
   * lease counted is taken back, the lease is cleared, and the item is
   * claimable again from `availableAt` (or its own `availableAt`, if later).
   * Conditional like `renewOutbox`; false when it changed nothing.
   */
  releaseOutbox(scope: Scope, lease: OutboxLease, availableAt: number): Promise<boolean>;
  /**
   * Leases one item that was never sent, so its run can take it back (a
   * cancel withdraws a write nobody sent; ADR-0009, amended): only an item
   * no claim counts (`claims` 0: never claimed, or handed back unsent by
   * `releaseOutbox`) and no lease holds at `now`, due or not, and never one
   * set aside as dead. The lease is `owner`'s until `now + leaseMs`; `claims`
   * and `availableAt` are unchanged, so a lease that simply ends leaves the
   * item as it was. True when it leased the item; false for any other item,
   * an unknown id, or another scope's. Atomic against `claimOutbox`: of the
   * two, one gets the item. Optional: without it, a cancel meets a write
   * waiting in the outbox as in flight.
   */
  takeOutbox?(scope: Scope, id: string, options: { owner: string; now: number; leaseMs: number }): Promise<boolean>;
  /** Leases due timers across all tenants (for workers). */
  claimTimers(options: ClaimOptions): Promise<TimerItem[]>;
  listEvents(scope: Scope, runId: string, options?: { afterSeq?: number; limit?: number }): Promise<StoredEvent[]>;
  /**
   * Live runs (`active` or `cancelling`) of one flow in the scope, optionally
   * of one version, ordered by run id in byte order and starting after
   * `after`, at most `limit`. Optional: sweeps that move runs between
   * versions (`migrateAll`) need it.
   */
  listLiveRuns?(scope: Scope, query: { flowId: string; version?: string; after?: string; limit: number }): Promise<Array<{ runId: string; flowVersion: string }>>;
  /**
   * Whether any run stored in the scope is on `flowId@version` now, whatever
   * its status: ended runs count (their replay and export need the version),
   * a run being erased does not. Optional: `storedRunsUse`, the guard a
   * memory catalog's `remove` asks, needs it.
   */
  hasRunOnVersion?(scope: Scope, query: { flowId: string; version: string }): Promise<boolean>;
  /** Run ids of one person in the scope, oldest first. */
  listRunsBySubject(scope: Scope, subjectId: string): Promise<string[]>;
  /**
   * The ids of `blobIds` that some run stored in `scope` names: a file
   * reference bound to the scope, in the run's state or any of its events
   * (archived ones included). Each once, in any order. A run names its files
   * until its erasure deletes it (one marked `erasing` still does), and no
   * run of another scope counts. Optional, and a store with `blobs` has it
   * (ADR-0008, amended by the verification round): its ledger lists a
   * release only once no stored run names the file. Without it the runtime
   * gives erasures no `releases` and answers none, since it cannot tell a
   * file nobody names from one another run still does. A host asks it again
   * before deleting a released file, once it stopped vouching it.
   */
  blobsInUse?(scope: Scope, blobIds: readonly string[]): Promise<string[]>;
  /**
   * Permanently removes a run: state, events, outbox, timers and waits. A
   * store with `privacy` first checks, atomically with the delete, the holds
   * in force at `now` (default: its own clock) covering the run (its tenant,
   * its scope, its person or itself), and while there is one changes nothing
   * and answers `{ erased: false, code: "flow/erasure-held", holds }`.
   * Nothing (`void`) reads as erased, from a store without holds. A store
   * with `blobs` records `releases` in its ledger atomically with the
   * erasure (never when it refuses), and lists them once the erasure has
   * completed and no stored run names them (`blobsInUse`).
   */
  eraseRun(scope: Scope, runId: string, options?: EraseOptions): Promise<RunErasure | void>;
  /**
   * Every workspace in `scope` that belongs to `owner`, by id, as stored (a
   * person's export: open questions and offers hold facts they or a model
   * gave). None in other scopes, and none of other owners.
   */
  listWorkspacesByOwner(scope: Scope, owner: string): Promise<WorkspaceState[]>;
  /**
   * Permanently removes every workspace in `scope` that belongs to `owner` (a
   * person's erasure). A store with `privacy` refuses while a hold covers the
   * owner (as `eraseRun` does) and otherwise names the ids it erased. A store
   * with `blobs` records `releases` as `eraseRun` does.
   */
  eraseWorkspaces(scope: Scope, owner: string, options?: EraseOptions): Promise<WorkspaceErasure | void>;
  /**
   * Legal holds and the privacy log (ADR-0010). Optional: without it the
   * runtime checks no holds and keeps no log; `eraseSubject` still answers
   * its receipt.
   */
  privacy?: PrivacyOps;
  /**
   * Cheap counts across every tenant for operators (`runtime.health()`):
   * the outbox and timer backlog, lanes held back, effects waiting for a
   * person. Counts stop at `cap`. Optional.
   */
  health?(options: StoreHealthOptions): Promise<StoreHealth>;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.tenantId === b.tenantId && a.appId === b.appId && a.environmentId === b.environmentId;
}

export function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.tenantId, scope.appId, scope.environmentId]);
}
