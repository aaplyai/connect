/**
 * Admission and access: who may act on a run or on privacy and holds, the
 * admission port, and the size and shape of what a caller sends.
 */

import { hasBlobRefs } from "@aaply/action-contract";
import type { CompiledFlow } from "../compile.js";
import type { DecisionProposal } from "../decision.js";
import { parseItemOps } from "../items.js";
import { checkJson, jsonByteLength, type JsonValue } from "../json.js";
import { proposalInputs } from "../routing.js";
import type { TrustedContext, AdmissionOp, AdmissionPort } from "../ports.js";
import type { RunState, ItemOp, ActorRef } from "../state.js";
import { FlowError } from "../errors.js";
import { RuntimeContext } from "./context.js";
import { isOwner, actorRef, portFailure } from "./helpers.js";
import { RunReader } from "../reader.js";

/** Who may touch a run: its person, staff, a channel acting for its person, or a participant it currently involves. */
export function authorize(ctx: TrustedContext, state: RunState, flow: CompiledFlow, staffOnly = false): void {
  const roles = ctx.appRoles;
  const staff = roles.some((r) => flow.staffRoles.includes(r));
  if (staffOnly) {
    if (!staff) throw new FlowError("not_found", "Not found.");
    return;
  }
  if (staff || isOwner(ctx, state)) return;
  if (participates(flow, state, actorRef(ctx))) return;
  throw new FlowError("not_found", "Not found.");
}

/** Export and erasure: the person themselves, or someone holding a privacy role. Acting for someone is not enough. */
/** Legal holds: `holdRoles` only, whoever the caller acts for. */
export function authorizeHolds(rt: RuntimeContext, ctx: TrustedContext): void {
  if (!ctx.appRoles.some((r) => rt.holdRoles.includes(r))) throw new FlowError("forbidden", "You cannot manage legal holds.");
}

export function authorizePrivacy(rt: RuntimeContext, ctx: TrustedContext, subjectId: string): void {
  if (typeof subjectId !== "string" || subjectId.length === 0 || subjectId.length > 400) throw new FlowError("invalid", "Bad subject.");
  if (ctx.appRoles.some((r) => rt.privacyRoles.includes(r))) return;
  if (ctx.actor.kind !== "workload" && actorRef(ctx).id === subjectId) return;
  throw new FlowError("forbidden", "You cannot access this person's data.");
}

/** Admission for a person's or service's request. A port that fails refuses it as `unavailable`, never with its own error. */
export async function admit(rt: RuntimeContext, ctx: TrustedContext, op: AdmissionOp, flowId?: string): Promise<void> {
  let admission: Awaited<ReturnType<AdmissionPort["admit"]>>;
  try {
    admission = await rt.admission.admit({ scope: ctx.scope, actorId: actorRef(ctx).id, op, ...(flowId !== undefined ? { flowId } : {}) });
  } catch (error) {
    throw portFailure(error, "admission");
  }
  if (!admission.ok) throw new FlowError("rate_limited", "Too many requests. Please try again later.", admission.retryAfterMs);
}

export function checkInput(rt: RuntimeContext, value: unknown): void {
  const issue = checkJson(value);
  if (issue) throw new FlowError("invalid", `Input must be plain JSON (${issue.message}).`);
  if (jsonByteLength(value as JsonValue) > rt.limits.maxInputBytes) throw new FlowError("invalid", "Input is too large.");
}

/** Whether every part a proposal would write passes `checkInput`, as a person's input must. */
export function fitsInput(rt: RuntimeContext, proposal: DecisionProposal): boolean {
  try {
    for (const part of proposalInputs(proposal)) {
      checkInput(rt, part);
      // A model never gives a file reference: an id it names must not grant access (ADR-0008).
      if (hasBlobRefs(part)) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof FlowError && error.code === "invalid") return false;
    throw error;
  }
}

/** Item changes: plain JSON within the input size, at most 100, each well formed (the core checks the rest). */
export function checkItems(rt: RuntimeContext, value: unknown): ItemOp[] {
  checkInput(rt, value);
  const parsed = parseItemOps(value);
  if (!parsed.ok) throw new FlowError("invalid", parsed.message);
  return parsed.ops;
}

/**
 * A participant who is not the run's person (an approver, say) sees the run
 * while its current step asks for one of their roles (to answer it or to
 * approve its action), and once they have acted on it.
 */
export function participates(flow: CompiledFlow, state: RunState, actor: ActorRef): boolean {
  if (actor.roles.length > 0 && state.current) {
    const step = flow.stepById.get(state.current);
    if (step?.actor?.roles.some((r) => actor.roles.includes(r))) return true;
    const action = step?.run !== undefined ? flow.actions.get(step.run) : undefined;
    if (step && action?.approvalRoles.some((r) => actor.roles.includes(r)) && new RunReader(flow, state, state.updatedAt).stepStatus(step, state.currentItem).kind === "confirm") return true;
  }
  return (
    Object.values(state.facts).some((f) => f.by === actor.id) ||
    Object.values(state.confirmations).some((c) => c.by === actor.id) ||
    // An item added, or a field of one given.
    Object.values(state.items ?? {}).some((item) => item.by === actor.id || Object.values(item.fields).some((f) => f.by === actor.id))
  );
}
