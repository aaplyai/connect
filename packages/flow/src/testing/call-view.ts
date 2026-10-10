/**
 * A flat view of an approved action, for the fake action port's handlers:
 * the call's context and its request, without the approval, origin and
 * proof. Tests read what a port was sent through it.
 */

import { isTraceparent, type ActingFor, type ActionEffectKind, type ActionPurpose, type ApprovedAction, type EnvironmentKind, type JsonValue, type Risk, type Scope } from "@aaply/action-contract";

/** The call context of an approved action, flattened for a fake port's handlers. */
export interface ActionContext {
  scope: Scope;
  environment: EnvironmentKind;
  runId: string;
  /** The run's person as `domain:id`; needed when the action acts for the end user. */
  subjectId: string | null;
  actingFor: ActingFor;
  signal: AbortSignal;
  deadline: number;
  /** The envelope's `traceparent`, when it carries a well-formed one. */
  traceparent?: string;
}

/** The request of an approved action, flattened for a fake port's handlers. */
export interface ActionRequest {
  effectId: string;
  attempt: number;
  purpose: ActionPurpose;
  action: string;
  connection?: string;
  effect: ActionEffectKind;
  input: Record<string, JsonValue>;
  /** Stable for every attempt of one effect; pass it to the backend. */
  idempotencyKey: string;
  idempotent: boolean;
  timeoutMs: number;
  /** The flow action's declared risk (`none` for reconciles; for compensations, the envelope's `action.risk`), for policy. */
  risk: Risk;
  /** For compensate and reconcile: the effect id of the original write. */
  target?: string;
  /** The collection item a per-item action works on (`origin.item`). Informational: the idempotency key does not use it. */
  item?: string;
  /**
   * The approved action's `completion`: the token the engine's
   * `completeAction` needs to settle this attempt when it answers `pending`.
   * Give it only to whatever reports the result; it completes this attempt
   * and nothing else.
   */
  completion?: { token: string };
}

/** Splits an envelope into a flat context and request, for test handlers. The approval, origin and proof are dropped; the completion token is kept. */
export function callView(action: ApprovedAction, signal: AbortSignal): { context: ActionContext; request: ActionRequest } {
  return {
    context: {
      scope: action.scope,
      environment: action.environment,
      runId: action.origin.runId,
      subjectId: action.subject ? `${action.subject.domain}:${action.subject.id}` : null,
      actingFor: action.connection.actingFor,
      signal,
      deadline: action.deadline,
      ...(isTraceparent(action.traceparent) ? { traceparent: action.traceparent } : {}),
    },
    request: {
      effectId: action.effectId,
      attempt: action.attempt,
      purpose: action.purpose,
      action: action.action.id,
      ...(action.connection.role !== null ? { connection: action.connection.role } : {}),
      effect: action.action.effect,
      input: action.input,
      idempotencyKey: action.idempotencyKey,
      idempotent: action.action.idempotent,
      timeoutMs: action.timeoutMs,
      risk: action.action.risk,
      ...(action.target !== undefined ? { target: action.target } : {}),
      ...(action.origin.item !== undefined ? { item: action.origin.item } : {}),
      ...(action.completion !== undefined ? { completion: { token: action.completion.token } } : {}),
    },
  };
}
