/**
 * The engine's side of the approved-action contract: what the runtime
 * captures when it commits an action effect, the checks it runs before
 * sending one, and the envelope it hands the action port.
 *
 * Provenance (the revision, the actor and the review that covered the input)
 * is captured by the runtime when the effect is committed, next to the
 * effect in its outbox row, and never in the effect itself: effects are part
 * of what replays compare, and a run must replay exactly.
 *
 * The envelope is a grant, so the runtime signs it for one performer with
 * the host's {@link EnvelopeSigning} just before sending. The key is the
 * engine's own: it holds no credential of any service.
 */

import {
  ACTION_CONTRACT_VERSION,
  approvalBinding,
  approvedActionSigningBytes,
  formatPath,
  isActionProof,
  isOperationContract,
  isSha256Digest,
  safeEqual,
  sha256Digest,
  validateValue,
  type ActionOutcome,
  type ActionProof,
  type ApprovalEvidence,
  type ApprovedAction,
  type ApprovedActionSigner,
  type ActorKind,
  type IdentityRef,
  type OperationContract,
  type Scope,
} from "@aaply/action-contract";
import { keyOf } from "./address.js";
import { unboundUndoFields, type OperationContracts } from "./bindings.js";
import type { CompiledFlow } from "./compile.js";
import { own } from "./json.js";
import type { KeyMinter } from "./ports.js";
import { confirmDigest } from "./reader.js";
import type { ActionEffect, ActorRef, CauseRef, RunState } from "./state.js";

/** What the runtime records about an action effect when it commits it. Optional on outbox rows, so older rows still run. */
export interface ActionDispatch {
  /** The run revision that dispatched the effect. */
  revision: number;
  /** Who caused that event, with when they last signed in when their request said; null when the engine did (a timer, a retry). */
  actor: (IdentityRef & { kind: ActorKind; authTime?: number }) | null;
  /**
   * Who set the effect in motion: the person whose event dispatched the
   * write's first attempt, for every attempt and for the write's undo and
   * check; null when no person did. Absent on rows written before it existed.
   */
  causedBy?: (IdentityRef & { kind: ActorKind }) | null;
  /** The review that covered the input when the effect was dispatched. */
  approval?: ApprovalEvidence;
  /** An earlier attempt of this write may have been applied. */
  maybeApplied?: true;
  /**
   * The `traceparent` of the request that set the effect in motion: the one
   * recorded with the write (and its hold) for every attempt, undo and check,
   * else the dispatching event's own. Absent when there was none.
   */
  traceparent?: string;
}

/** Splits an engine identity (`domain:id`) into its parts. */
export function identityOf(id: string): IdentityRef {
  const colon = id.indexOf(":");
  return colon > 0 ? { domain: id.slice(0, colon), id: id.slice(colon + 1) } : { domain: "unknown", id };
}

function actorOf(actor: { kind: ActorKind; id: string; authTime?: number }, withAuthTime = false): ActionDispatch["actor"] {
  if (actor.kind === "system") return null;
  return { ...identityOf(actor.id), kind: actor.kind, ...(withAuthTime && actor.authTime !== undefined ? { authTime: actor.authTime } : {}) };
}

/**
 * Who set an effect in motion. A run records it with the write
 * (`causedBy` on its result, and on the hold its undo releases), so every
 * attempt, undo and check carries the person who caused the write. Where
 * nothing is recorded, the event's own person stands in (null for a timer
 * or a retry).
 */
function causeOf(state: RunState, actor: ActorRef, effect: ActionEffect): ActionDispatch["actor"] {
  let recorded: CauseRef | null | undefined;
  if (effect.purpose === "compensate") recorded = own(state.resources, effect.target ?? "")?.causedBy;
  else {
    const res = own(state.results, keyOf(effect.name, effect.item));
    const original = effect.purpose === "run" ? effect.effectId : effect.target;
    if (res !== undefined && res.effectId === original) recorded = res.causedBy;
  }
  if (recorded === undefined) return actorOf(actor);
  return recorded === null ? null : actorOf(recorded);
}

/**
 * The `traceparent` an effect carries: the one recorded with the write it
 * belongs to (its result, or the hold an undo releases), as `causeOf` reads
 * `causedBy`; the dispatching event's own when no record is found.
 */
function traceOf(state: RunState, effect: ActionEffect, eventTrace: string | undefined): string | undefined {
  if (effect.purpose === "compensate") {
    const resource = own(state.resources, effect.target ?? "");
    if (resource !== undefined) return resource.traceparent;
  } else {
    const res = own(state.results, keyOf(effect.name, effect.item));
    const original = effect.purpose === "run" ? effect.effectId : effect.target;
    if (res !== undefined && res.effectId === original) return res.traceparent;
  }
  return eventTrace;
}

/**
 * The review that covers an effect: only for the step's own call (`run`) of
 * an action that needs one, and only when the confirmation on record is for
 * exactly this input. A per-item action's review is its item's
 * (`name[item]`), so one item's review never covers another's call.
 */
export function approvalFor(state: RunState, effect: ActionEffect): ApprovalEvidence | undefined {
  if (effect.purpose !== "run" || effect.risk === "none") return undefined;
  const key = keyOf(effect.name, effect.item);
  const conf = own(state.confirmations, key);
  if (!conf || !safeEqual(conf.digest, confirmDigest(key, effect.input, state.nonce))) return undefined;
  const by = identityOf(conf.by);
  const inputDigest = sha256Digest(effect.input);
  return {
    kind: effect.risk === "approval" ? "approval" : "confirm",
    by: { ...by, ...(conf.kind !== undefined ? { kind: conf.kind } : {}), ...(conf.roles !== undefined ? { roles: [...conf.roles] } : {}), ...(conf.authTime !== undefined ? { authTime: conf.authTime } : {}) },
    inputDigest,
    rev: conf.rev,
    ...(conf.at !== undefined ? { at: conf.at } : {}),
    ...(conf.notAfter !== undefined ? { notAfter: conf.notAfter } : {}),
    binding: bindingOf(state.runId, effect, inputDigest),
  };
}

/** `approval.binding` for an effect of a run: what its review covered. */
function bindingOf(runId: string, effect: ActionEffect, inputDigest: ApprovalEvidence["inputDigest"]): ApprovalEvidence["binding"] {
  return approvalBinding({ action: effect.action, runId, name: effect.name, ...(effect.item !== undefined ? { item: effect.item } : {}), inputDigest });
}

/**
 * What the runtime records with an action effect it commits, from the state
 * of that commit and the actor (and `traceparent`) of its event.
 */
export function dispatchFor(state: RunState, actor: ActorRef, effect: ActionEffect, eventTrace?: string): ActionDispatch {
  const approval = approvalFor(state, effect);
  const res = effect.purpose === "run" ? own(state.results, keyOf(effect.name, effect.item)) : undefined;
  const traceparent = traceOf(state, effect, eventTrace);
  return {
    revision: state.revision,
    actor: actorOf(actor, true),
    causedBy: causeOf(state, actor, effect),
    ...(approval ? { approval } : {}),
    ...(res?.effectId === effect.effectId && res.maybeApplied ? { maybeApplied: true as const } : {}),
    ...(traceparent !== undefined ? { traceparent } : {}),
  };
}

/**
 * The checks the engine runs before sending, apart from admission. Returns
 * the outcome to record instead of sending, or null to send:
 * - the input must match the action's `inputSchema` (`flow/action-input-invalid`, `final`);
 * - a review with a time to live must not have expired (`flow/approval-expired`: `final`,
 *   or `unknown` when an earlier attempt of the write may have been applied);
 * - an undo with an operation that `operations` marks undo-only must take every field from
 *   the output of the write it undoes (`flow/undo-unbound`, `final`: its effect is put in
 *   doubt). Publish refuses such a flow (`connector/flow-undo-unbound`); this holds for one
 *   published without the check.
 */
export function refuseBeforeSending(flow: CompiledFlow, effect: ActionEffect, dispatch: ActionDispatch, now: number, operations?: OperationContracts): ActionOutcome | null {
  const action = flow.actions.get(effect.name);
  if (effect.purpose === "compensate" && contractOf(operations, effect.action)?.undoOnly === true) {
    const unbound = action?.compensate ? unboundUndoFields(action.compensate.input) : ["*"];
    if (unbound.length > 0) {
      return {
        status: "final",
        error: { code: "flow/undo-unbound", message: "This could not be undone automatically.", detail: `${effect.action} undoes only what its write made; ${unbound.join(", ")} must read the write's output` },
      };
    }
  }
  const schema = effect.purpose === "run" ? action?.def.inputSchema : undefined;
  if (schema) {
    const issues = validateValue(schema, effect.input);
    if (issues.length > 0) {
      const first = issues[0]!;
      return {
        status: "final",
        error: { code: "flow/action-input-invalid", message: "Some details are not in a form this can use.", detail: `input at ${formatPath(first.path)}: ${first.message}` },
      };
    }
  }
  const notAfter = dispatch.approval?.notAfter;
  if (notAfter !== undefined && notAfter <= now) {
    const error = { code: "flow/approval-expired", message: "The review of this has expired. Please review it again." };
    return dispatch.maybeApplied ? { status: "unknown", error } : { status: "final", error };
  }
  return null;
}

/**
 * What the runtime records for the port's answer to a later attempt of a
 * write an earlier attempt of which may have been applied. A `final` answer
 * (a refusal, or the service saying no) is about this attempt: it was not
 * applied. It says nothing about the earlier one, so recording it as `final`
 * would mark a write failed that may have happened, and a person's retry
 * would send it again under a new key. It is recorded as `unknown`, with
 * the same error, so the write is retried, checked or left to a person as in
 * doubt, never failed.
 *
 * `connect/replayed` on a write is the same case for this very attempt: the
 * performer was sent it before (a transport retry after a lost answer), and
 * that delivery may have been performed. It too is recorded as `unknown`.
 */
export function answerAfterMaybeApplied(outcome: ActionOutcome, dispatch: ActionDispatch, write: boolean): ActionOutcome {
  if (outcome.status !== "final") return outcome;
  return dispatch.maybeApplied || (write && outcome.error.code === "connect/replayed") ? { status: "unknown", error: outcome.error } : outcome;
}

/**
 * The token that lets a performer complete one attempt of one effect: an
 * HMAC under the idempotency secret of the scope, run, effect and attempt.
 * The connection slot holds a value no connection role can take, so a
 * token never equals an idempotency key.
 */
export function completionToken(keys: KeyMinter, parts: { scope: Scope; runId: string; effectId: string; attempt: number }): string {
  return keys.idempotencyKey({ scope: parts.scope, connection: "#complete", action: "flow.complete", effectId: JSON.stringify([parts.runId, parts.effectId, parts.attempt]) });
}

/**
 * How the runtime signs the approved actions it sends
 * (`RuntimeOptions.envelopes`): for which performer, and with which key.
 * Every envelope is signed for `audience`, the audience the performer is
 * configured with. The signer may be asynchronous (a KMS); one that throws,
 * answers a malformed proof or is still signing when the call's time is up
 * leaves the attempt unsent and retryable (`flow/sign-failed`).
 */
export interface EnvelopeSigning {
  audience: string;
  signer: ApprovedActionSigner;
}

/**
 * The audience of an envelope from a runtime given no {@link EnvelopeSigning}.
 * Such envelopes carry the unsigned `none` proof, which every verifier
 * refuses: they reach only a port that does not verify (a test fake in the
 * same process).
 */
export const UNSIGNED_AUDIENCE = "unsigned";

/**
 * Whether a completion of this attempt arrives late: the engine has put its
 * effect in doubt (a write whose pending timed out, or an undo that could
 * not be confirmed) and a person must otherwise settle it. The runtime marks
 * such a completion `late`, and the core records it.
 */
export function completesLate(state: RunState, effectId: string, attempt: number): boolean {
  if (!state.attention.includes(effectId)) return false;
  if (Object.values(state.results).some((r) => r.effectId === effectId && r.status === "in_doubt" && attempt <= r.attempt)) return true;
  return Object.values(state.resources).some((r) => r.releaseEffectId === effectId && r.status === "in_doubt");
}

/** Everything {@link buildApprovedAction} needs. */
export interface ApprovedActionParts {
  flow: CompiledFlow;
  /** The performer the envelope is for. */
  audience: string;
  /** When it is built (epoch ms); the deadline is at most `issuedAt + timeoutMs`. */
  issuedAt: number;
  scope: Scope;
  environment: ApprovedAction["environment"];
  runId: string;
  /** The run's person as `domain:id`, or null. */
  subjectId: string | null;
  effect: ActionEffect;
  dispatch: ActionDispatch;
  idempotencyKey: string;
  completionToken: string;
  timeoutMs: number;
  deadline: number;
  policy?: { version: string };
  /**
   * The envelope version to build, as the runtime negotiated it with the
   * action port (`ContractNegotiator`); contract 1 when absent.
   */
  contract?: ApprovedAction["contract"];
  /**
   * The operation contracts the host gave the runtime (`RuntimeOptions.operations`).
   * An undo's envelope states its operation's own risk floor and idempotency
   * from them.
   */
  operations?: OperationContracts;
}

/** The contract of `action` in `contracts`, or null when it is not there or is not one. */
function contractOf(contracts: OperationContracts | undefined, action: string): OperationContract | null {
  if (!contracts) return null;
  const found: unknown = contracts instanceof Map ? contracts.get(action) : own(contracts as Readonly<Record<string, OperationContract>>, action);
  return isOperationContract(found) ? found : null;
}

/**
 * The envelope for one attempt of one effect, before it is signed (see
 * {@link attachProof}). Review evidence recorded before evidence was
 * bound is bound here, from the effect it was recorded with.
 *
 * An undo (`compensate`) names the write it undoes (`undoes`, the flow
 * action's own call), and states its operation's own risk floor and
 * idempotency when `operations` has its contract, where the effect says
 * `none` and `true` (how the engine sends every undo): the performer then
 * refuses an undo that needs a review or does not de-duplicate on what the
 * envelope says. Built here, not in the effect, so replays are unchanged.
 */
export function buildApprovedAction(parts: ApprovedActionParts): Omit<ApprovedAction, "proof"> {
  const { flow, effect, dispatch } = parts;
  const action = flow.actions.get(effect.name);
  const call = action ? (effect.purpose === "run" ? action.call : effect.purpose === "compensate" ? action.compensate : action.reconcile) : undefined;
  const pin = call?.contract;
  const undo = effect.purpose === "compensate" ? contractOf(parts.operations, effect.action) : null;
  const approval = dispatch.approval ? { ...dispatch.approval, binding: dispatch.approval.binding ?? bindingOf(parts.runId, effect, dispatch.approval.inputDigest) } : undefined;
  return {
    contract: parts.contract ?? ACTION_CONTRACT_VERSION,
    audience: parts.audience,
    issuedAt: parts.issuedAt,
    scope: { tenantId: parts.scope.tenantId, appId: parts.scope.appId, environmentId: parts.scope.environmentId },
    environment: parts.environment,
    effectId: effect.effectId,
    attempt: effect.attempt,
    purpose: effect.purpose,
    ...(effect.target !== undefined ? { target: effect.target } : {}),
    ...(effect.purpose === "compensate" && action ? { undoes: action.call.action } : {}),
    idempotencyKey: parts.idempotencyKey,
    action: {
      id: effect.action,
      effect: effect.effect,
      idempotent: undo ? undo.idempotent : effect.idempotent,
      risk: undo ? undo.riskFloor : effect.risk,
      ...(pin !== undefined && isSha256Digest(pin) ? { contract: pin } : {}),
    },
    connection: { role: effect.connection ?? null, actingFor: effect.actingFor },
    input: effect.input,
    inputDigest: sha256Digest(effect.input),
    origin: {
      runId: parts.runId,
      flowId: flow.id,
      flowVersion: flow.version,
      flowHash: flow.hash,
      stepId: action?.stepId || "-",
      name: effect.name,
      revision: dispatch.revision,
      ...(effect.item !== undefined ? { item: effect.item } : {}),
      causedBy: dispatch.causedBy !== undefined ? dispatch.causedBy : dispatch.actor,
    },
    actor: dispatch.actor,
    subject: parts.subjectId === null ? null : identityOf(parts.subjectId),
    ...(approval ? { approval } : {}),
    ...(parts.policy ? { policy: { version: parts.policy.version } } : {}),
    deadline: parts.deadline,
    timeoutMs: parts.timeoutMs,
    completion: { token: parts.completionToken },
    ...(dispatch.traceparent !== undefined ? { traceparent: dispatch.traceparent } : {}),
  };
}

/** The envelope with its proof, or null when `proof` is not one (a signer that answered something else). */
export function attachProof(unsigned: Omit<ApprovedAction, "proof">, proof: unknown): ApprovedAction | null {
  if (!isActionProof(proof)) return null;
  const sealed: ActionProof = { alg: proof.alg, keyId: proof.keyId, sig: proof.sig };
  return { ...unsigned, proof: sealed };
}

/** What a signer signs for an envelope: its bytes, and the audience and scope it is for. */
export function signingInput(unsigned: Omit<ApprovedAction, "proof">): { bytes: Uint8Array; context: { audience: string; scope: Scope } } {
  return { bytes: approvedActionSigningBytes(unsigned), context: { audience: unsigned.audience, scope: { ...unsigned.scope } } };
}
