/**
 * The approved-action envelope: everything whoever performs an action needs
 * to perform it, and to check again that it may.
 *
 * The engine approves a named action (its rules ran, its input is valid, any
 * confirmation or approval covers exactly this input) and hands it over as an
 * {@link ApprovedAction}. The performer (Aaply Connect, the connector kit)
 * checks it again, binds the connection role to a real account, and performs
 * it. The envelope never carries an account, a credential or a secret.
 *
 * The envelope is a grant: whoever holds a valid one can have the action
 * performed, once per attempt and before its deadline. So it is signed. The
 * engine's host signs it for one performer (`audience`), over every field
 * (see `approvedActionSigningBytes`), and the performer verifies the proof
 * before anything else ({@link verifyApprovedAction}); the channel's own
 * authentication of the engine is a second line, not the only one.
 */

import { isSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
import { checkJson, cloneJson, isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type { ActionOutcome } from "./outcome.js";
import { CONTRACT_UNSUPPORTED_RETRY_MS, refuse } from "./refusals.js";
import { approvalBinding, approvedActionSigningBytes, isActionProof, type ActionProof, type ApprovedActionVerifier } from "./signing.js";
import type { ActionPortDescription } from "./contract-versions.js";
import { isEnvironmentKind } from "./environment.js";
import { isRisk, type ActingFor, type ActionEffectKind, type ActionPurpose, type ActorKind, type EnvironmentKind, type Risk, type Scope } from "./scope.js";

/** The envelope version. An integer, versioned apart from the packages; additive optional fields do not bump it. */
export const ACTION_CONTRACT_VERSION = 1 as const;

/** Longest `timeoutMs` an envelope may carry: 7 days, the longest an effect may take. */
export const MAX_ACTION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** How far the performer's clock may be behind the engine's before an envelope's times are not believed. */
export const DEFAULT_CLOCK_SKEW_MS = 30_000;

/** An identity, as `domain` plus an id unique within it. */
export interface IdentityRef {
  domain: string;
  id: string;
}

/** Who reviewed the input: the person's confirmation, or someone else's approval. */
export interface ApprovalEvidence {
  /** `confirm` for an action of risk `confirm`, `approval` for risk `approval`. */
  kind: "confirm" | "approval";
  /**
   * The reviewer, with `kind` and `roles` (the roles held when they
   * reviewed). `authTime` is when the reviewer last
   * signed in (epoch ms), from the trusted context of the request that
   * recorded the review, when it said.
   */
  by: IdentityRef & { kind?: ActorKind; roles?: string[]; authTime?: number };
  /** {@link sha256Digest} of the input reviewed; equal to the envelope's `inputDigest` when it covers this call. */
  inputDigest: Sha256Digest;
  /** The run revision the review was recorded at. */
  rev: number;
  /** When it was given (epoch ms). */
  at?: number;
  /** When it stops covering a new dispatch (epoch ms), when the flow declares a time to live. */
  notAfter?: number;
  /** `approvalBinding` of the action id, run, name, item and input digest the review covered. */
  binding: Sha256Digest;
}

/** Where an approved action comes from. */
export interface ActionOrigin {
  runId: string;
  flowId: string;
  flowVersion: string;
  flowHash: string;
  /** The step the action belongs to. */
  stepId: string;
  /** The flow's name for the action. */
  name: string;
  /** The run revision that dispatched it. */
  revision: number;
  /** The collection item it acts on, for per-item actions. */
  item?: string;
  /**
   * Who set it in motion: the person whose event dispatched the write's first
   * attempt. Every retry, timer-driven attempt, undo and check of that write
   * carries the same person, where `actor` is null. Null only when no person
   * caused it (the engine dispatched the first attempt on its own).
   */
  causedBy: (IdentityRef & { kind: ActorKind }) | null;
}

/** One action the engine approved, ready to perform. Plain JSON. */
export interface ApprovedAction {
  contract: typeof ACTION_CONTRACT_VERSION;
  /** The performer it is for (its configured audience). Any other refuses it. */
  audience: string;
  /** When the engine built it (epoch ms, on the engine's clock). */
  issuedAt: number;
  scope: Scope;
  environment: EnvironmentKind;
  effectId: string;
  /** 1 for the first send; the same effect is sent again with the next attempt. */
  attempt: number;
  purpose: ActionPurpose;
  /** For `compensate` and `reconcile` (required there): the effect id (or held resource) of the original write. */
  target?: string;
  /**
   * For `compensate` only, and required there: the action id
   * (`<connectorId>.<operation>`) of the write this undoes. The performer
   * runs the undo only when that write's operation declares this action as
   * its undo, so a flow cannot name another write's undo (a purge of
   * everything, say) to undo a narrower one.
   */
  undoes?: string;
  /** Stable across every attempt of one effect: pass it to services that de-duplicate. */
  idempotencyKey: string;
  action: {
    /** `<connectorId>.<operation>`. */
    id: string;
    effect: ActionEffectKind;
    /**
     * The performer may receive this effect more than once and must
     * de-duplicate on the key. For a `compensate`, the undo operation's own
     * idempotency when the engine knows its contract, and `true` otherwise
     * (the engine sends an undo again after an unknown answer); `false` is
     * refused.
     */
    idempotent: boolean;
    /**
     * The flow's declared review (`none` for reconciles). For a `compensate`,
     * the undo operation's own risk floor when the engine knows its contract,
     * and `none` otherwise (nobody reviews an undo); anything but `none` is
     * refused.
     */
    risk: Risk;
    /** The operation-contract digest the flow pinned at publish, when it pinned one. */
    contract?: Sha256Digest;
  };
  /** The flow's connection role. Never an account or a credential: the performer binds the role. */
  connection: { role: string | null; actingFor: ActingFor };
  /** Already valid against the action's input schema. */
  input: JsonObject;
  inputDigest: Sha256Digest;
  origin: ActionOrigin;
  /**
   * Who caused the event that dispatched this attempt; null when the engine
   * did (a timer, a retry). See `origin.causedBy`. `authTime` is when that
   * actor last signed in (epoch ms), from the trusted context of their
   * request, when it said: passed through for a performer's policy (a
   * recent sign-in), never checked by the engine.
   */
  actor: (IdentityRef & { kind: ActorKind; authTime?: number }) | null;
  /** The run's person; null for runs that are for nobody in particular. */
  subject: IdentityRef | null;
  /** Present for `run` purposes of an action of risk `confirm` or `approval`. */
  approval?: ApprovalEvidence;
  /** The admission policy's version at dispatch, when it reported one. */
  policy?: { version: string };
  /** Epoch ms by which the call must be finished. */
  deadline: number;
  timeoutMs: number;
  /** What completes the effect later if the performer answers `pending` (see `CompletionRequest`). Keep it from handler code. */
  completion?: { token: string };
  /**
   * The W3C `traceparent` of the request that set this work in motion, the
   * same on every attempt, undo and check of it (as `origin.causedBy` is),
   * for correlation only. Never a reason to refuse: use it only when
   * `isTraceparent` accepts it. Absent when no request carried one.
   */
  traceparent?: string;
  /** The engine's signature over every other field (`approvedActionSigningBytes`). */
  proof: ActionProof;
}

/** Performs approved actions. Implemented by Aaply Connect, the connector kit's port, or a test fake. Never throws. */
export interface ActionPort {
  run(action: ApprovedAction, signal: AbortSignal): Promise<ActionOutcome>;
  /**
   * Optional: the envelope versions this port serves. The engine asks before
   * sending (and caches the answer for a minute), and sends the highest
   * version both sides know. A port without it is sent contract 1. See
   * `contract-versions.ts`.
   */
  describe?(): ActionPortDescription | Promise<ActionPortDescription>;
}

/** The result of {@link checkApprovedAction}. */
export type ApprovedActionCheck = { ok: true; action: ApprovedAction } | { ok: false; outcome: ActionOutcome };

const SCOPE_KEYS = ["tenantId", "appId", "environmentId"] as const;
const PURPOSES = new Set(["run", "compensate", "reconcile"]);
const ACTOR_KINDS = new Set(["visitor", "member", "staff", "workload", "system"]);

const str = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const optionalTime = (v: unknown): boolean => v === undefined || time(v);
const obj = (v: unknown): v is Record<string, unknown> => isJsonObject(v as JsonValue);
const identity = (v: unknown): v is IdentityRef => obj(v) && str(v.domain, 64) && str(v.id, 256);

/** The first field of an envelope that is malformed, or null. Unknown fields are allowed. */
function shapeProblem(e: Record<string, unknown>): string | null {
  if (!str(e.audience, 256)) return "audience";
  if (!time(e.issuedAt)) return "issuedAt";
  if (!isActionProof(e.proof)) return "proof";
  if (!obj(e.scope) || !SCOPE_KEYS.every((k) => str((e.scope as Record<string, unknown>)[k], 256))) return "scope";
  if (!isEnvironmentKind(e.environment)) return "environment";
  if (!str(e.effectId, 256)) return "effectId";
  if (!int(e.attempt, 1, 1000)) return "attempt";
  if (!PURPOSES.has(e.purpose as string)) return "purpose";
  if (e.target !== undefined && !str(e.target, 256)) return "target";
  // An undo or a check names the write it is about.
  if (e.purpose !== "run" && e.target === undefined) return "target";
  // An undo names the write it undoes; nothing else does.
  if (e.purpose === "compensate" ? !str(e.undoes, 256) : e.undoes !== undefined) return "undoes";
  if (!str(e.idempotencyKey, 256)) return "idempotencyKey";
  const a = e.action;
  if (!obj(a) || !str(a.id, 256) || (a.effect !== "read" && a.effect !== "write") || typeof a.idempotent !== "boolean" || !isRisk(a.risk)) return "action";
  if (a.contract !== undefined && !isSha256Digest(a.contract)) return "action.contract";
  const c = e.connection;
  if (!obj(c) || (c.role !== null && !str(c.role, 64)) || (c.actingFor !== "business" && c.actingFor !== "endUser")) return "connection";
  if (!obj(e.input)) return "input";
  if (!isSha256Digest(e.inputDigest)) return "inputDigest";
  const o = e.origin;
  if (!obj(o) || !str(o.runId, 256) || !str(o.flowId, 256) || !str(o.flowVersion, 256) || !str(o.flowHash, 256) || !str(o.stepId, 256) || !str(o.name, 256) || !int(o.revision, 0, Number.MAX_SAFE_INTEGER)) {
    return "origin";
  }
  if (o.item !== undefined && !str(o.item, 256)) return "origin.item";
  if (o.causedBy !== null && !(identity(o.causedBy) && ACTOR_KINDS.has((o.causedBy as unknown as Record<string, unknown>).kind as string))) return "origin.causedBy";
  if (e.actor !== null && !(identity(e.actor) && ACTOR_KINDS.has((e.actor as unknown as Record<string, unknown>).kind as string))) return "actor";
  if (e.actor !== null && !optionalTime((e.actor as unknown as Record<string, unknown>).authTime)) return "actor.authTime";
  if (e.subject !== null && !identity(e.subject)) return "subject";
  if (e.approval !== undefined) {
    const p = e.approval;
    if (!obj(p) || (p.kind !== "confirm" && p.kind !== "approval") || !identity(p.by) || !isSha256Digest(p.inputDigest) || !int(p.rev, 0, Number.MAX_SAFE_INTEGER) || !isSha256Digest(p.binding)) return "approval";
    const by = p.by as unknown as Record<string, unknown>;
    if (by.kind !== undefined && !ACTOR_KINDS.has(by.kind as string)) return "approval.by";
    if (by.roles !== undefined && !(Array.isArray(by.roles) && by.roles.every((r) => str(r, 128)))) return "approval.by";
    if (!optionalTime(by.authTime)) return "approval.by.authTime";
    if ((p.at !== undefined && !time(p.at)) || (p.notAfter !== undefined && !time(p.notAfter))) return "approval";
  }
  if (e.policy !== undefined && !(obj(e.policy) && str(e.policy.version, 256))) return "policy";
  if (!time(e.deadline)) return "deadline";
  if (!int(e.timeoutMs, 1, MAX_ACTION_TIMEOUT_MS)) return "timeoutMs";
  if (e.completion !== undefined && !(obj(e.completion) && str(e.completion.token, 512))) return "completion";
  return null;
}

/** Options of {@link checkApprovedAction}. */
export interface ApprovedActionCheckOptions {
  /** Epoch ms on the performer's clock. */
  now: number;
  /** How far behind the engine's clock this one may be. Default {@link DEFAULT_CLOCK_SKEW_MS}. */
  skewMs?: number;
}

/**
 * What every performer checks before anything else, in this order:
 *
 * 1. the contract version;
 * 2. that the envelope is well-formed plain JSON (a `compensate` or
 *    `reconcile` names its `target`, a `compensate` the write it `undoes`;
 *    `timeoutMs` is at most 7 days);
 * 3. that a `reconcile` is a read and a `compensate` a write (`connect/effect-mismatch`),
 *    and that a `compensate` needs no review (`connect/approval-invalid`) and
 *    de-duplicates (`connect/idempotency-mismatch`): the engine sends an undo
 *    unreviewed, and again after an unknown answer;
 * 4. that its times are believable: the deadline is no later than
 *    `issuedAt + timeoutMs` (`connect/invalid-envelope`), and it was not
 *    issued in the future nor is due later than `now + timeoutMs`, give or
 *    take `skewMs` (`connect/clock-skew`, retryable);
 * 5. that the deadline has not passed (`connect/late`, retryable: a later
 *    attempt gets a new envelope) and that any approval's `notAfter` has not
 *    (`connect/expired`, final: the review must be given again);
 * 6. that the input matches its digest;
 * 7. that review evidence is bound (`approval.binding`) to exactly this
 *    action, run, name, item and input, and, for a `run` of an action of
 *    risk `confirm` or `approval`, that evidence of the matching kind is
 *    there and an approval was not given by the person the run is for.
 *
 * It does not check the audience or the proof: {@link verifyApprovedAction}
 * does, after this, and a performer runs that. Never throws. A refusal is
 * `final` or `retryable` (see {@link refuse}). The action it returns is a
 * detached copy of the value checked.
 */
export function checkApprovedAction(value: unknown, options: ApprovedActionCheckOptions): ApprovedActionCheck {
  try {
    return checkEnvelope(value, options.now, options.skewMs ?? DEFAULT_CLOCK_SKEW_MS);
  } catch {
    // A hostile value (a throwing getter, a proxy) is not an envelope.
    return { ok: false, outcome: refuse("connect/invalid-envelope", "The action could not be read.", { detail: "the envelope could not be read" }) };
  }
}

function checkEnvelope(value: unknown, now: number, skewMs: number): ApprovedActionCheck {
  const no = (outcome: ActionOutcome): ApprovedActionCheck => ({ ok: false, outcome });
  if (!obj(value)) return no(refuse("connect/invalid-envelope", "The action could not be read.", { detail: "the envelope is not a plain object" }));
  const e = value;
  if (typeof e.contract !== "number") return no(refuse("connect/invalid-envelope", "The action could not be read.", { detail: "contract is missing" }));
  if (e.contract !== ACTION_CONTRACT_VERSION) {
    return no(refuse("connect/contract-unsupported", "This action was sent in a form that is not supported.", { detail: `contract ${String(e.contract)} is not served`, retryAfterMs: CONTRACT_UNSUPPORTED_RETRY_MS }));
  }
  const issue = checkJson(e);
  if (issue) return no(refuse("connect/invalid-envelope", "The action could not be read.", { detail: `not plain JSON: ${issue.message}` }));
  // Everything below reads one detached copy, so what was checked is what is returned.
  const copy = cloneJson(e as JsonObject);
  const problem = shapeProblem(copy);
  if (problem) return no(refuse("connect/invalid-envelope", "The action could not be read.", { detail: `malformed ${problem}` }));
  const action = copy as unknown as ApprovedAction;
  // A check of a write only reads; an undo is a write.
  if (action.purpose === "reconcile" && action.action.effect !== "read") {
    return no(refuse("connect/effect-mismatch", "This action was sent in a form that is not supported.", { detail: "a reconcile must be a read" }));
  }
  if (action.purpose === "compensate" && action.action.effect !== "write") {
    return no(refuse("connect/effect-mismatch", "This action was sent in a form that is not supported.", { detail: "a compensate must be a write" }));
  }
  // An undo runs with nobody to review it, and is sent again after an unknown answer.
  if (action.purpose === "compensate" && action.action.risk !== "none") {
    return no(refuse("connect/approval-invalid", "This undo needs a review, which nobody can give to an undo.", { detail: `a compensate of risk ${action.action.risk}` }));
  }
  if (action.purpose === "compensate" && !action.action.idempotent) {
    return no(refuse("connect/idempotency-mismatch", "This undo cannot be sent again safely.", { detail: "a compensate that does not de-duplicate" }));
  }
  if (action.deadline > action.issuedAt + action.timeoutMs) {
    return no(refuse("connect/invalid-envelope", "The action could not be read.", { detail: "the deadline is later than issuedAt + timeoutMs" }));
  }
  if (action.issuedAt > now + skewMs || action.deadline > now + action.timeoutMs + skewMs) {
    return no(refuse("connect/clock-skew", "This action could not be checked right now.", { detail: "issued in the future, or due later than its timeout allows, on this performer's clock" }));
  }
  if (action.deadline <= now) return no(refuse("connect/late", "This action arrived too late.", { detail: "the deadline has passed" }));
  if (action.approval?.notAfter !== undefined && action.approval.notAfter <= now) {
    return no(refuse("connect/expired", "The approval for this action has expired.", { detail: "approval.notAfter has passed" }));
  }
  if (sha256Digest(action.input) !== action.inputDigest) {
    return no(refuse("connect/invalid-input", "The action's details do not match.", { detail: "inputDigest does not match the input" }));
  }
  const approval = action.approval;
  if (approval) {
    const bound = approvalBinding({ action: action.action.id, runId: action.origin.runId, name: action.origin.name, ...(action.origin.item !== undefined ? { item: action.origin.item } : {}), inputDigest: approval.inputDigest });
    if (approval.binding !== bound) {
      return no(refuse("connect/approval-invalid", "This action needs a review first.", { detail: "approval.binding is for another action, run, item or input" }));
    }
  }
  if (action.purpose === "run" && action.action.risk !== "none") {
    const wanted = action.action.risk === "approval" ? "approval" : "confirm";
    if (!approval) return no(refuse("connect/approval-invalid", "This action needs a review first.", { detail: `risk ${action.action.risk} without approval evidence` }));
    if (approval.kind !== wanted) return no(refuse("connect/approval-invalid", "This action needs a review first.", { detail: `risk ${action.action.risk} with ${approval.kind} evidence` }));
    if (approval.inputDigest !== action.inputDigest) {
      return no(refuse("connect/approval-invalid", "The details changed since they were reviewed.", { detail: "approval.inputDigest does not match the input" }));
    }
    const subject = action.subject;
    if (wanted === "approval" && subject !== null && subject.domain === approval.by.domain && subject.id === approval.by.id) {
      return no(refuse("connect/approval-invalid", "This needs approval from someone else.", { detail: "approved by the run's own person" }));
    }
  }
  return { ok: true, action };
}

/** Options of {@link verifyApprovedAction}. */
export interface ApprovedActionVerifyOptions extends ApprovedActionCheckOptions {
  /** This performer's audience: an envelope for any other is refused. */
  audience: string;
  verifier: ApprovedActionVerifier;
}

/**
 * {@link checkApprovedAction}, then that the envelope is for this performer
 * (`connect/wrong-audience`) and that its proof verifies
 * (`connect/proof-invalid`; an unsigned `none` proof never does). A verifier
 * that throws or rejects answers `connect/unavailable` (retryable): the
 * action could not be checked, which is not a reason to fail it. Never
 * throws; resolves to the checked, detached copy.
 */
export async function verifyApprovedAction(value: unknown, options: ApprovedActionVerifyOptions): Promise<ApprovedActionCheck> {
  const checked = checkApprovedAction(value, options);
  if (!checked.ok) return checked;
  const action = checked.action;
  if (action.audience !== options.audience) {
    return { ok: false, outcome: refuse("connect/wrong-audience", "This action was not meant for this service.", { detail: `audience ${action.audience}` }) };
  }
  const invalid = (detail: string): ApprovedActionCheck => ({ ok: false, outcome: refuse("connect/proof-invalid", "This action could not be verified.", { detail }) });
  if (action.proof.alg === "none") return invalid("the envelope is unsigned");
  let verified: unknown;
  try {
    verified = await options.verifier.verify(approvedActionSigningBytes(action), { ...action.proof }, { audience: action.audience, scope: { ...action.scope } });
  } catch {
    return { ok: false, outcome: refuse("connect/unavailable", "This action could not be checked right now.", { detail: "the verifier failed" }) };
  }
  return verified === true ? checked : invalid(`no valid ${action.proof.alg} proof under key ${action.proof.keyId}`);
}
