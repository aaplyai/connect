/**
 * When the runtime moves a live run to another version of its flow: the
 * trigger table, as a pure function of what the catalog says about the
 * run's version and the current one (docs/runtime.md, "Moving runs between
 * versions").
 *
 * | Trigger | pinned | onNextTurn | forced | revoked |
 * | --- | --- | --- | --- | --- |
 * | a person's call | – | after it | after it | before it |
 * | a system event | – | – | after it | after it |
 * | a sweep (`migrateAll`) | – | – | yes | yes |
 * | staff (`migrate`) | with `override` | yes | yes | yes |
 *
 * A run only ever moves to the current version, and only when that version
 * accepts runs from the run's version (its `migrations`); the planner
 * refuses anything else. A revoked version's runs move where they can and
 * otherwise end.
 */

import type { CompiledFlow } from "./compile.js";
import type { MigrationApproval, Revocation, VersionStatus } from "./ports.js";
import { isTerminal, type RunState } from "./state.js";

/** What prompted the runtime to look. */
export type MoveTrigger = "person" | "system" | "sweep" | "staff";

/** What the runtime should do about one run. */
export type MoveDecision =
  | { kind: "stay" }
  /** A forced policy without a valid two-person approval: nothing moves. */
  | { kind: "denied"; reason: string }
  | { kind: "move"; cause: "onNextTurn" | "forced" | "revoked"; to: CompiledFlow; message?: string; approval?: { requestedBy: string; approvedBy: string } }
  /** The run's version was revoked and there is nowhere to move it. */
  | { kind: "end"; message: string };

const MAX_APPROVER_ID = 256;

/**
 * A version's revocation, or undefined when it was not revoked. A missing
 * status, and a `revoked` that is absent or `null` (a host catalog may pass a
 * database NULL through), are all "not revoked": every place that asks reads
 * it here, so a person's call, a worker and a move never disagree.
 */
export function revokedOf(status: VersionStatus | null | undefined): Revocation | undefined {
  const revoked = status?.revoked as Revocation | null | undefined;
  return revoked === null || revoked === undefined ? undefined : revoked;
}

/** Two different, non-empty approvers. Checked again each time a forced policy is used. */
export function validApproval(approval: MigrationApproval | undefined): approval is MigrationApproval {
  if (typeof approval !== "object" || approval === null) return false;
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_APPROVER_ID;
  return id(approval.requestedBy) && id(approval.approvedBy) && approval.requestedBy !== approval.approvedBy && typeof approval.approvedAt === "number";
}

/**
 * Decides, from the statuses of the run's version (`here`) and of the
 * current version, whether `state` should move now. `current` is the
 * compiled current version (null when the flow has none).
 */
export function decideMove(
  state: RunState,
  here: VersionStatus | null,
  current: CompiledFlow | null,
  currentStatus: VersionStatus | null,
  trigger: MoveTrigger,
): MoveDecision {
  if (isTerminal(state.status)) return { kind: "stay" };
  const target = current !== null && current.id === state.flowId && current.version !== state.flowVersion && currentStatus !== null && !revokedOf(currentStatus) ? current : null;
  const revoked = revokedOf(here);
  if (here && revoked && here.version === state.flowVersion && here.hash === state.flowHash) {
    const { then, message } = revoked;
    if (then === "migrate" && target) return { kind: "move", cause: "revoked", to: target, message };
    return { kind: "end", message };
  }
  if (!target || !currentStatus) return { kind: "stay" };
  const policy = currentStatus.policy;
  if (policy.mode === "pinned") return { kind: "stay" };
  if (policy.from !== undefined && !policy.from.includes(state.flowVersion)) return { kind: "stay" };
  const message = policy.message !== undefined ? { message: policy.message } : {};
  if (policy.mode === "onNextTurn") return trigger === "person" || trigger === "staff" ? { kind: "move", cause: "onNextTurn", to: target, ...message } : { kind: "stay" };
  // A policy this engine does not know keeps runs where they are.
  if (policy.mode !== "forced") return { kind: "stay" };
  if (!validApproval(policy.approval)) return { kind: "denied", reason: "A forced move needs approval from two different people." };
  return { kind: "move", cause: "forced", to: target, ...message, approval: { requestedBy: policy.approval.requestedBy, approvedBy: policy.approval.approvedBy } };
}
