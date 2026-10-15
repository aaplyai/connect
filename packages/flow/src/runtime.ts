/**
 * The runtime: loads a run, applies one event with the pure core, commits
 * the new state, its event and its effects in one atomic store write, and
 * then performs the effects (inline when it can, otherwise through workers
 * claiming the outbox). Stateless: any instance can serve any request.
 */

import { type BlobRef, type CompletionResult, type DeliverRequest, type DeliverResult } from "@aaply/action-contract";
import { deepFreeze } from "@aaply/action-contract/internal";
import {
  type EnvelopeSigning,
} from "./approved.js";
import type { OperationContracts } from "./bindings.js";
import { DEFAULT_MAX_DEFER_MS } from "./admission.js";
import { DEFAULT_MAX_CALL_DEPTH } from "./calls.js";
import type { Rejection } from "./core.js";
import { type MigrationPlan } from "./migrate.js";
import { type DecisionGoal, type DecisionPort } from "./decision.js";
import { type JsonValue } from "./json.js";
import { MAX_OPTIONS_CAP, type DecisionPolicy } from "./policy.js";
import { type Reply, type ReplyOption } from "./reply.js";
import {
  type ActionPort,
  type AdmissionPort,
  type Clock,
  type FlowCatalog,
  type IdSource,
  type KeyMinter,
  type LanePolicy,
  type Observer,
  type TrustedContext,
} from "./ports.js";
import {
  type PendingConsent,
  type RunStore,
  type StoredEvent,
  type WorkspaceState,
} from "./store.js";
import {
  type ActionOutcome,
  type AcceptEntry,
  type ItemOp,
  type UndoRequest,
  type Notice,
  type RunState,
} from "./state.js";
import type { NormaliseContext } from "./assist/normalise.js";
import { type BlobHost } from "./blob-guard.js";
import { withBlobs } from "./runtime-blobs.js";
import { type FlowView } from "./view.js";
import { type RuntimeHealth } from "./health.js";
import type { LegalHold, PrivacyRecord } from "./privacy.js";
import * as privacy from "./privacy-runtime.js";
import { RuntimeContext } from "./runtime/context.js";
import { exportSubject, eraseSubject, placeHold, releaseHold, listHolds } from "./runtime/privacy.js";
import { migrate, migrateAll } from "./runtime/migrate.js";
import { deliver, completeAction, resolveEffect } from "./runtime/deliver.js";
import { drain, work } from "./runtime/work.js";
import { workspace } from "./runtime/workspace.js";
import { view, inspect, health } from "./runtime/views.js";
import { start, submit } from "./runtime/start.js";
import { goals, turn, consent, choose, resume } from "./runtime/turns.js";

export { FlowError, type FlowErrorCode } from "./errors.js";

export interface RuntimeLimits {
  /** Largest payload or fact set a person may submit, in UTF-8 bytes. */
  maxInputBytes: number;
  /** Longest free text accepted by `turn`. */
  maxTextLength: number;
  /**
   * Perform effects right after committing, instead of leaving them all to
   * workers. Default `true`. A runtime that a separate worker drives
   * (`work()`, as `createWorker` in `@aaply/flow-host` does) should set it
   * `false`: otherwise firing a timer performs the action it causes inside
   * the timer loop, and a slow call holds the next timers back. With it off
   * that action goes to the outbox for a worker slot. A runtime that serves
   * requests may set it `false` too, so a request only commits and answers.
   */
  inline: boolean;
  /** Most effect rounds one request performs inline. */
  maxInlineChain: number;
  /**
   * Time one request waits for its inline effects. Effects still running then
   * finish and are recorded in the background, under their leases.
   */
  inlineBudgetMs: number;
  /** Outbox and timer lease length; actions are cut off a second before it ends. */
  leaseMs: number;
  /** Times a conflicting commit is retried against fresh state. */
  conflictRetries: number;
  /** Time allowed for a decision model to answer. */
  decisionTimeoutMs: number;
  /** Most runs kept parked in one workspace. */
  maxParked: number;
  /** Times an outbox item may be leased without settling before it is given up on. */
  maxClaims: number;
  /**
   * How long `eraseSubject` waits for a run it ended to let go of what it
   * holds, counted from when the end began. Past it, erasure goes ahead as
   * things stand (and reports what it left).
   */
  eraseWaitMs: number;
  /** Most published flows a decider is offered; past it, none are, so no stage chooses from part of the catalog. */
  maxGoals: number;
  /** Most options an offer holds, whatever the policy says. */
  maxOptionsCap: number;
  /** How deep calls may nest: a root's child is 1. At most 8. */
  maxCallDepth: number;
  /**
   * How long admission may defer an action attempt (`defer: true`), counted
   * from when it was dispatched. Within it a deferral spends no attempt;
   * past it, the refusal is recorded like any other. 0 turns deferral off.
   * At most 7 days.
   */
  maxDeferMs: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = deepFreeze({
  maxInputBytes: 64 * 1024,
  maxTextLength: 4000,
  inline: true,
  maxInlineChain: 8,
  inlineBudgetMs: 10_000,
  leaseMs: 120_000,
  conflictRetries: 5,
  decisionTimeoutMs: 15_000,
  maxParked: 10,
  maxClaims: 10,
  eraseWaitMs: 24 * 60 * 60 * 1000,
  maxGoals: 200,
  maxOptionsCap: MAX_OPTIONS_CAP,
  maxCallDepth: DEFAULT_MAX_CALL_DEPTH,
  maxDeferMs: DEFAULT_MAX_DEFER_MS,
});

export interface RuntimeOptions {
  catalog: FlowCatalog;
  store: RunStore;
  actions: ActionPort;
  keys: KeyMinter;
  /**
   * Signs every approved action for the performer behind `actions`. Give it
   * whenever that performer verifies envelopes (the connector kit, Aaply
   * Connect): without it envelopes carry the unsigned `none` proof, which
   * every verifier refuses, so only a port that does not verify accepts them.
   */
  envelopes?: EnvelopeSigning;
  /**
   * The operation contracts of the actions this runtime sends, by action id:
   * pass the same table publish checks flows against
   * (`operationContracts(connectors)` from the connector kit). Read for three
   * things:
   * - an undo's envelope states its operation's own risk floor and
   *   idempotency, so the performer refuses an undo that needs a review or
   *   does not de-duplicate. Without it an undo states `none` and `true`
   *   (how the engine sends it), and only publish and the performer's own
   *   contract stand behind those;
   * - a `pending` answer is waited for as long as the operation's declared
   *   completion window (`completion.windowMs`), instead of the call's
   *   `timeoutMs`, when the contract here is the one the call pins (or the
   *   call pins none);
   * - a flow version that pins contracts this table cannot see is reported
   *   once through `observer.contract`. Dispatch is never refused for it.
   * Optional for now; it should become required for a runtime given
   * `envelopes` in the next breaking release (ADR-0002, G1 amendment).
   */
  operations?: OperationContracts;
  clock?: Clock;
  ids?: IdSource;
  decide?: DecisionPort;
  /**
   * The tenant's decision policy, read per turn (so a change applies at
   * once). Without it, routing is `off` (`NO_POLICY`): exact published
   * names, open offers and questions work, and no text reaches a model. A
   * policy that throws or does not parse also makes routing `off` for that
   * turn, and is reported.
   */
  policy?: (ctx: TrustedContext) => DecisionPolicy | Promise<DecisionPolicy>;
  admission?: AdmissionPort;
  observer?: Observer;
  /** Identifies this instance in leases. */
  workerId?: string;
  /** App roles allowed to export and erase any person's runs. */
  privacyRoles?: string[];
  /**
   * App roles allowed to place, list and release legal holds (ADR-0010).
   * Default `["legal-hold"]`; keep them apart from `privacyRoles`, so whoever
   * handles erasure requests cannot lift the hold that blocks one.
   */
  holdRoles?: string[];
  /** App roles allowed to sweep runs between versions (`migrateAll`) and to override a pinned version. Default `["flow-admin"]`. */
  migrationRoles?: string[];
  limits?: Partial<RuntimeLimits>;
  /** Lanes for stores with fair lanes (`store.lanes`): classification, priority, inline reservations. */
  lanes?: LanePolicy;
  /**
   * The time zone (an IANA name, usually the server's) for a run whose caller
   * gives none and whose app's policy names none (ADR 0012). Default UTC.
   */
  defaultTimezone?: string;
  /**
   * Reads values in languages or forms the built-in reader does not (ADR
   * 0008), such as Hinglish "kal shaam 5 baje". Tried first for every value a
   * decider proposes and for its quote; `undefined` (or a throw) falls back
   * to the built-in reader, and the result is still checked against the
   * fact's schema.
   */
  normalise?: NormaliseContext["custom"];
  /**
   * The host's file store (ADR-0008): vouches for the file references callers
   * give, and resolves the URLs views show. Without it, every reference a
   * caller gives is refused (`flow/blob-unvouched`) and every `url` is null.
   */
  blobs?: BlobHost;
  /**
   * Fills `out` with random bytes, for each run's nonce (it salts confirm
   * digests and names child runs). Default `crypto.getRandomValues`. Give a
   * seeded generator only to make test runs repeatable (`createHarness`'s
   * `seed`): in production a predictable nonce lets a caller guess a child
   * run's id.
   */
  randomBytes?: (out: Uint8Array) => void;
}

export type SubmitInput =
  /**
   * `epoch` is the step's view epoch the person saw (`ViewStep.epoch`): an
   * output from a view the run has since replaced (a move to another version,
   * say) is refused with `flow/stale-view`. Clients should always send it.
   * `item`: the item the view showed, for a step that runs once per item (`view.step.item.id`).
   */
  | { kind: "output"; stepId: string; name: string; payload?: JsonValue; digest?: string; epoch?: number; item?: string }
  /**
   * Facts given directly, and changes to lists (`items`, applied after the
   * facts). 0.3: `accept` takes the assistant's suggestions or confirms its
   * values waiting for a yes as the person's own (name the `turn` whose value
   * the person saw, and a value from another turn is refused with
   * `flow/accept-stale`), `dismiss` drops suggestions, and `undo`
   * (`{turn: ViewStep.assist.turn, facts?}`) restores what an assistant's
   * turn wrote: every fact of it, or only `facts`.
   */
  | { kind: "facts"; facts?: Record<string, JsonValue | null>; items?: ItemOp[]; accept?: AcceptEntry[]; dismiss?: string[]; undo?: UndoRequest }
  | { kind: "cancel"; reason?: string }
  /** The person is back on a run that was paused while they were away. */
  | { kind: "resume" };

export interface RunResponse {
  runId: string;
  view: FlowView;
  accepted: boolean;
  rejection?: Rejection;
  notices: Notice[];
}

/** An open offer, as the person sees it. */
export interface OfferView {
  id: string;
  expiresAt: number;
  options: ReplyOption[];
}

export interface WorkspaceView {
  id: string;
  active: FlowView | null;
  parked: Array<{ runId: string; flowId: string; title: string; status: RunState["status"] }>;
  /**
   * The open yes-or-no question; null when there is none. Its facts are only
   * those its flow declares, not derived and not secret. Answer it with
   * `consent`, naming its `turnId`.
   */
  pending: PendingConsent | null;
  /** The open offer; absent when there is none. */
  offer?: OfferView;
}

/** How `exportSubject` treats secrets. */
export interface SubjectExportOptions {
  /**
   * `mask` (the default) replaces every value a secret fact or field held,
   * wherever it appears in a run's state and events, with `REDACTED`.
   * `include` leaves them, for a host with a legal reason to hand them over.
   */
  secrets?: "mask" | "include";
}

/** A person's data (`exportSubject`). */
export interface SubjectExport {
  /** Their runs, oldest first, each with its events as stored. */
  runs: Array<{ state: RunState; events: StoredEvent[] }>;
  /** Their workspaces, including an open question's or offer's facts (never a secret one). */
  workspaces: WorkspaceState[];
  /** The file references the export holds (unique by id, bound to the scope), so the host can add their content. Absent when it holds none. */
  blobs?: BlobRef[];
}

/** A run erasure is waiting for, or went ahead without. */
export interface ErasureRun {
  runId: string;
  /** `active` when its end waits for a write to settle or its flow to load; `cancelling` while it releases what it holds. */
  status: RunState["status"];
}

/** What `eraseSubject` did. */
export type EraseResult =
  /**
   * Every run of the person (children included) and their workspaces are
   * gone. `abandoned`: runs erased while still letting go of something,
   * past `limits.eraseWaitMs` or with a flow version that no longer loads;
   * what they held may remain at the service (each is reported to
   * `observer.error` as `erase`). `receipt`: the value-free record of the
   * erasure, also kept in the store's privacy log when it has one.
   */
  | {
      erased: number;
      releasing?: undefined;
      code?: undefined;
      abandoned?: ErasureRun[];
      /** The file references the erased runs and workspaces held: delete their content (the store's blob ledger recorded each with its erasure). Absent when there were none. */
      released?: BlobRef[];
      receipt: PrivacyRecord;
    }
  /**
   * Nothing was erased yet: these runs are still letting go of what they
   * hold. Call again after `retryAfterMs`; a later call erases once nothing
   * is held.
   */
  | { erased: 0; releasing: ErasureRun[]; retryAfterMs: number; code?: undefined }
  /**
   * A legal hold in force covers the tenant, the scope, the person or one of
   * their runs (`held`: the holds' ids). Checked first, it refuses the whole
   * erasure: nothing was ended or erased (`erased: 0`). A hold placed while
   * the erasure was under way stops it where the store refused: `erased`
   * runs were erased before, and the workspaces only if the receipt names
   * them; `released` names only the file references nothing kept holds. The
   * refusal is recorded too.
   */
  | { erased: number; releasing?: undefined; code: "flow/erasure-held"; held: string[]; released?: BlobRef[]; receipt: PrivacyRecord };

/** What `migrate` did, or would do (`dryRun`). */
export interface MigrateResponse {
  migrated: boolean;
  /** The move worked out against the run as it was; null when there is no other version to move to. */
  plan: MigrationPlan | null;
  view: FlowView;
}

/** One page of a sweep (`migrateAll`). */
export interface SweepResponse {
  migrated: number;
  /** Runs of a revoked version that could not move and were ended. */
  ended: number;
  /** Runs that cannot move yet, with the blocker. Sweep again later. */
  waiting: Array<{ runId: string; code: string }>;
  /** Pass to the next call; null when the sweep is done. */
  cursor: string | null;
}

/**
 * Free text, or a reserved `open` output from a section naming a published
 * flow by id (it goes through the same exact stage as a typed name).
 */
export type TurnInput = { text: string; open?: undefined } | { open: string; text?: undefined };

/**
 * What `turn`, `consent` and `choose` answer. `turnId` names the turn (see
 * `Observer.turn`); `reply` is the text answer as channel-neutral data, with
 * a Facet section to present it when the flow or the policy names one. A
 * `nomatch` is an `answer` whose `reply.kind` is `"nomatch"`.
 */
export type TurnResponse =
  | { kind: "run"; workspace: WorkspaceView; accepted: boolean; rejection?: Rejection; notices: Notice[]; turnId?: string }
  | { kind: "answer"; text: string; workspace: WorkspaceView; turnId?: string; reply?: Reply }
  /** A yes-or-no question. `turnId` is the turn that asked it: pass it back to `consent` to answer this question only. */
  | { kind: "consent"; question: string; workspace: WorkspaceView; turnId?: string; reply?: Reply }
  | { kind: "clarify"; question: string; workspace: WorkspaceView; turnId?: string; reply?: Reply }
  /** Options for the person to pick from with `choose` (or by typing a number or a title). */
  | { kind: "suggest"; question: string; offerId: string; options: ReplyOption[]; workspace: WorkspaceView; turnId: string; reply: Reply };

export interface FlowRuntime {
  /**
   * Starts a run. Idempotent on the request id: a retried start (same caller,
   * person, flow and `requestId`) returns the run the first try made.
   */
  start(ctx: TrustedContext, input: { flowId: string; version?: string; facts?: Record<string, JsonValue>; items?: ItemOp[]; workspaceId?: string }): Promise<RunResponse>;
  submit(ctx: TrustedContext, runId: string, input: SubmitInput): Promise<RunResponse>;
  view(ctx: TrustedContext, runId: string): Promise<FlowView>;
  /**
   * The flows this person may start, as goals (for a menu or a launcher): the
   * catalog's list filtered by their roles, without `callableOnly` flows. The
   * same list a decider is offered, exact names match and `open` names.
   */
  goals(ctx: TrustedContext): Promise<DecisionGoal[]>;
  inspect(ctx: TrustedContext, runId: string): Promise<{ state: RunState; events: StoredEvent[] }>;
  workspace(ctx: TrustedContext, workspaceId: string): Promise<WorkspaceView>;
  /**
   * Free text, routed: an open question answered by a digit, a title or a
   * yes or no word; an exact published name (or a reserved `open` output);
   * then the decision port, under the tenant's policy.
   */
  turn(ctx: TrustedContext, workspaceId: string, input: TurnInput): Promise<TurnResponse>;
  /**
   * Answers the open yes-or-no question. Pass `question.turnId`, the
   * `turnId` of the `consent` response that showed it: the answer applies
   * only to that question. An answer that names another question (one
   * replaced meanwhile, on another device, say) or names none is refused
   * with a `clarify` whose `reply.reason` is `flow/question-stale`, and
   * nothing changes.
   */
  consent(ctx: TrustedContext, workspaceId: string, accept: boolean, question?: { turnId?: string }): Promise<TurnResponse>;
  /**
   * Picks an option of the open offer, or dismisses it (`option: null`).
   * Compare-and-clear: only the call that takes this exact offer acts on it;
   * a stale, expired or unknown pick is answered with a clarifying reply.
   */
  choose(ctx: TrustedContext, workspaceId: string, input: { offerId: string; option: string | null }): Promise<TurnResponse>;
  resume(ctx: TrustedContext, workspaceId: string, runId: string): Promise<WorkspaceView>;
  /**
   * An outside event (webhook, email) for the run waiting on it. Workloads only.
   *
   * Throws `unavailable` when the event could not be recorded: do not
   * acknowledge it to the sender, deliver it again. Pass the sender's event id
   * as `dedupeKey`, so a run that already took the event ignores the repeat
   * and redelivery is always safe. A correlation that matches several runs is
   * refused with `conflict` and delivered to none.
   *
   * An event that names its `connection` (as the connector kit's
   * `handleWebhook` does) goes only to a run bound to it: the context's
   * subject must be the connection's owner (`invalid` otherwise; none for
   * the business's own connection), and an event from a person's own
   * connection wakes only a run whose subject is that person.
   */
  deliver(ctx: TrustedContext, input: DeliverRequest): Promise<DeliverResult>;
  /**
   * The final outcome of an action that answered "pending", or that was sent
   * and has not answered yet (the completion can arrive before the port's
   * "pending" is recorded; the port's later answer is then a repeat, stale,
   * or recorded as disputed for staff). Workloads only, with the
   * `completion.token` of the attempt's approved action (refused with
   * `forbidden` otherwise). An identical repeat answers `already`; one that
   * disagrees with the recorded outcome, and a completion for an attempt that
   * answered otherwise and waits to be sent again, is a `conflict`. One for
   * an effect the engine already put in doubt is recorded and answers `late`.
   */
  completeAction(ctx: TrustedContext, input: { runId: string; effectId: string; attempt: number; outcome: ActionOutcome; token: string }): Promise<CompletionResult>;
  /** Staff settle an effect whose outcome could not be determined. */
  resolveEffect(ctx: TrustedContext, runId: string, input: { effectId: string; applied: boolean; output?: JsonValue }): Promise<RunResponse>;
  /**
   * One worker pass: perform due effects and fire due timers. `only` claims
   * one kind alone, so a host can keep timers on a loop of their own that a
   * slow action call never holds back.
   */
  work(options?: { limit?: number; only?: "actions" | "timers" }): Promise<{ actions: number; timers: number }>;
  /**
   * Waits for the outcomes this instance is still recording after their
   * requests answered (an inline call that outlived `inlineBudgetMs`).
   * A host shutting down stops taking requests, then awaits this, so a call
   * that completed is recorded rather than left to a worker as interrupted.
   * Never throws.
   */
  drain(): Promise<void>;
  /**
   * A person's data: their runs with their events, and their workspaces
   * (with any open question or offer, and the facts it holds). The person
   * themself, or `privacyRoles`. Secrets are masked unless `secrets` is
   * `include`.
   */
  exportSubject(ctx: TrustedContext, subjectId: string, options?: SubjectExportOptions): Promise<SubjectExport>;
  /**
   * Erases a person's runs and workspaces, the person themself or
   * `privacyRoles`. Each live tree is ended first from its root, whatever it
   * committed: what it committed stays done, and every other hold is
   * released through the usual compensation path. While that is under way
   * the answer names the runs still releasing, and nothing is erased; a
   * later call erases once nothing is held, or once `limits.eraseWaitMs` has
   * passed, so erasure always completes.
   */
  eraseSubject(ctx: TrustedContext, subjectId: string): Promise<EraseResult>;
  /**
   * Places a legal hold (`holdRoles`): until it is released or lapses
   * (`until`), erasure refuses what it covers, a tenant, this scope, a
   * person or a run. Who placed it and when come from the context. A retry
   * with the same request id returns the hold the first try placed. Needs a
   * store with holds (`unavailable` otherwise).
   */
  placeHold(ctx: TrustedContext, input: privacy.PlaceHoldInput): Promise<LegalHold>;
  /** Releases a hold the scope placed (`holdRoles`); the first release stands. `not_found` when there is none. */
  releaseHold(ctx: TrustedContext, holdId: string, input?: { reason?: string }): Promise<LegalHold>;
  /** The holds visible from the scope (`holdRoles`): in force, or also released and lapsed ones with `ended`. */
  listHolds(ctx: TrustedContext, input?: privacy.ListHoldsInput): Promise<LegalHold[]>;
  /**
   * For operators, across every tenant, counts only: whether the store
   * answers, the outbox and timer backlog, paused lanes, effects waiting for
   * a person and dead outbox items. Never throws: an unreachable store is
   * reported as such.
   */
  health(options?: { cap?: number }): Promise<RuntimeHealth>;
  /**
   * Moves one run to its flow's current version, as the catalog's policy for
   * that version allows (staff of the flow, or `migrationRoles`). `dryRun`
   * returns the plan without moving. A pinned version's run moves only with
   * `override`, which needs `migrationRoles` and records the caller. A plan
   * with blockers moves nothing.
   */
  migrate(ctx: TrustedContext, runId: string, options?: { dryRun?: boolean; override?: boolean }): Promise<MigrateResponse>;
  /**
   * One page of a sweep over a flow's live runs in `ctx.scope`
   * (`migrationRoles`): runs of a forced or revoked version move; runs of a
   * revoked version that cannot move are ended; the rest are listed as
   * waiting. Idempotent and resumable through `cursor`. Needs the store's
   * `listLiveRuns` (`unavailable` otherwise).
   */
  migrateAll(ctx: TrustedContext, input: { flowId: string; cursor?: string; limit?: number }): Promise<SweepResponse>;
}

export function createFlowRuntime(options: RuntimeOptions): FlowRuntime {
  return withBlobs(new Runtime(options), { ...(options.blobs ? { blobs: options.blobs } : {}), ...(options.observer ? { observer: options.observer } : {}) });
}

class Runtime implements FlowRuntime {
  private readonly rt: RuntimeContext;

  constructor(options: RuntimeOptions) {
    this.rt = new RuntimeContext(options);
  }

  start(ctx: TrustedContext, input: { flowId: string; version?: string; facts?: Record<string, JsonValue>; workspaceId?: string }): Promise<RunResponse> {
    return start(this.rt, ctx, input);
  }

  submit(ctx: TrustedContext, runId: string, input: SubmitInput): Promise<RunResponse> {
    return submit(this.rt, ctx, runId, input);
  }

  goals(ctx: TrustedContext): Promise<DecisionGoal[]> {
    return goals(this.rt, ctx);
  }

  view(ctx: TrustedContext, runId: string): Promise<FlowView> {
    return view(this.rt, ctx, runId);
  }

  inspect(ctx: TrustedContext, runId: string): Promise<{ state: RunState; events: StoredEvent[] }> {
    return inspect(this.rt, ctx, runId);
  }

  workspace(ctx: TrustedContext, workspaceId: string): Promise<WorkspaceView> {
    return workspace(this.rt, ctx, workspaceId);
  }

  turn(ctx: TrustedContext, workspaceId: string, input: TurnInput): Promise<TurnResponse> {
    return turn(this.rt, ctx, workspaceId, input);
  }

  consent(ctx: TrustedContext, workspaceId: string, accept: boolean, question?: { turnId?: string }): Promise<TurnResponse> {
    return consent(this.rt, ctx, workspaceId, accept, question);
  }

  choose(ctx: TrustedContext, workspaceId: string, input: { offerId: string; option: string | null }): Promise<TurnResponse> {
    return choose(this.rt, ctx, workspaceId, input);
  }

  resume(ctx: TrustedContext, workspaceId: string, runId: string): Promise<WorkspaceView> {
    return resume(this.rt, ctx, workspaceId, runId);
  }

  deliver(ctx: TrustedContext, input: DeliverRequest): Promise<DeliverResult> {
    return deliver(this.rt, ctx, input);
  }

  completeAction(ctx: TrustedContext, input: { runId: string; effectId: string; attempt: number; outcome: ActionOutcome; token: string }): Promise<CompletionResult> {
    return completeAction(this.rt, ctx, input);
  }

  resolveEffect(ctx: TrustedContext, runId: string, input: { effectId: string; applied: boolean; output?: JsonValue }): Promise<RunResponse> {
    return resolveEffect(this.rt, ctx, runId, input);
  }

  work(options?: { limit?: number; only?: "actions" | "timers" }): Promise<{ actions: number; timers: number }> {
    return work(this.rt, options);
  }

  drain(): Promise<void> {
    return drain(this.rt);
  }

  exportSubject(ctx: TrustedContext, subjectId: string, options?: SubjectExportOptions): Promise<SubjectExport> {
    return exportSubject(this.rt, ctx, subjectId, options);
  }

  eraseSubject(ctx: TrustedContext, subjectId: string): Promise<EraseResult> {
    return eraseSubject(this.rt, ctx, subjectId);
  }

  placeHold(ctx: TrustedContext, input: privacy.PlaceHoldInput): Promise<LegalHold> {
    return placeHold(this.rt, ctx, input);
  }

  releaseHold(ctx: TrustedContext, holdId: string, input?: { reason?: string }): Promise<LegalHold> {
    return releaseHold(this.rt, ctx, holdId, input);
  }

  listHolds(ctx: TrustedContext, input?: privacy.ListHoldsInput): Promise<LegalHold[]> {
    return listHolds(this.rt, ctx, input);
  }

  health(options?: { cap?: number }): Promise<RuntimeHealth> {
    return health(this.rt, options);
  }

  migrate(ctx: TrustedContext, runId: string, options?: { dryRun?: boolean; override?: boolean }): Promise<MigrateResponse> {
    return migrate(this.rt, ctx, runId, options);
  }

  migrateAll(ctx: TrustedContext, input: { flowId: string; cursor?: string; limit?: number }): Promise<SweepResponse> {
    return migrateAll(this.rt, ctx, input);
  }
}
