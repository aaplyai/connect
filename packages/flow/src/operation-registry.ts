/**
 * What the runtime knows of the operations its flows call: the registry the
 * host gives it (`RuntimeOptions.operations`), which is the same table
 * publish pins against (`pinActionContracts`, `checkActionBindings`).
 *
 * The runtime reads it at send time, never the core, so replays never depend
 * on it:
 * - an undo's envelope states its operation's own risk floor and idempotency
 *   (`buildApprovedAction`);
 * - a `pending` answer is waited for as long as its operation's declared
 *   completion window, recorded on the event;
 * - the pins of a flow version that the registry cannot see are reported,
 *   once per flow version, through `observer.contract`. Dispatch is never
 *   refused for one: the performer serves or refuses a pin.
 *
 * A contract is relied on only when it is the one the call pinned, or the
 * call pins none.
 */

import { isOperationContract, isSha256Digest, operationDigest, type ActionPurpose, type OperationContract, type Scope, type Sha256Digest } from "@aaply/action-contract";
import type { OperationContracts } from "./bindings.js";
import type { CompiledCall, CompiledFlow } from "./compile.js";
import { own } from "./json.js";
import type { ActionEffect } from "./state.js";

/**
 * Why the runtime cannot see the contract a call pins: it was given no
 * registry, the registry has no such operation, its entry is not an
 * operation contract, or its contract has another digest (the operation
 * changed since the flow was published).
 */
export type UnseenContractReason = "no-registry" | "unknown-operation" | "invalid-contract" | "other-digest";

/** One call that a flow version pins to an operation contract the runtime's registry cannot see. */
export interface UnseenContract {
  reason: UnseenContractReason;
  flowId: string;
  flowVersion: string;
  flowHash: string;
  /** The flow's name for the action. */
  name: string;
  /** Which of its calls: the step's own (`run`), its undo (`compensate`) or its check (`reconcile`). */
  purpose: ActionPurpose;
  /** The operation's action id (`<connectorId>.<operation>`). */
  operation: string;
  /** The digest the call pins. */
  pinned: Sha256Digest;
}

/** What `observer.contract` receives: an unseen pin, with the scope of the run whose action was being sent when it was found. */
export interface ContractRecord extends UnseenContract {
  scope: Scope;
}

/** The compiled call of an action for one purpose. */
function callOf(flow: CompiledFlow, name: string, purpose: ActionPurpose): CompiledCall | undefined {
  const action = flow.actions.get(name);
  if (!action) return undefined;
  return purpose === "run" ? action.call : purpose === "compensate" ? action.compensate : action.reconcile;
}

/** The registry's entry for an action id; undefined when it has none or reading it throws. */
function entryOf(operations: OperationContracts, id: string): unknown {
  try {
    return operations instanceof Map ? operations.get(id) : own(operations as Readonly<Record<string, OperationContract>>, id);
  } catch {
    return undefined;
  }
}

const digests = new WeakMap<object, Sha256Digest>();

/** `operationDigest`, computed once per contract object (the registry's contracts are not changed after they are given). */
function digestOf(contract: OperationContract): Sha256Digest {
  let digest = digests.get(contract);
  if (digest === undefined) {
    digest = operationDigest(contract);
    digests.set(contract, digest);
  }
  return digest;
}

/** Why `operations` cannot see the contract `pinned` for `operation`, or null when it can. */
function unseenReason(operations: OperationContracts | undefined, operation: string, pinned: Sha256Digest): UnseenContractReason | null {
  if (operations === undefined) return "no-registry";
  const entry = entryOf(operations, operation);
  if (entry === undefined) return "unknown-operation";
  if (!isOperationContract(entry)) return "invalid-contract";
  return digestOf(entry) === pinned ? null : "other-digest";
}

/**
 * Every call of `flow` (an action's own, its undo and its check) pinned to
 * an operation contract that `operations` cannot see, in the flow's order.
 * Empty when the flow pins nothing or the registry has every
 * pinned contract. A host runs it over its catalog before it rolls out a
 * runtime, so a flow published against contracts the runtime does not know
 * is found before its actions are sent. Never throws on a malformed entry.
 */
export function unseenContracts(flow: CompiledFlow, operations: OperationContracts | undefined): UnseenContract[] {
  const out: UnseenContract[] = [];
  for (const action of flow.actions.values()) {
    for (const purpose of ["run", "compensate", "reconcile"] as const) {
      const call = callOf(flow, action.name, purpose);
      if (!call || !isSha256Digest(call.contract)) continue;
      const reason = unseenReason(operations, call.action, call.contract);
      if (reason !== null) {
        out.push({ reason, flowId: flow.id, flowVersion: flow.version, flowHash: flow.hash, name: action.name, purpose, operation: call.action, pinned: call.contract });
      }
    }
  }
  return out;
}

/**
 * The operation contract the runtime may rely on for one effect: the
 * registry's contract for the effect's operation, when the call pins that
 * contract's digest or pins none. Null otherwise.
 */
export function contractForEffect(flow: CompiledFlow, effect: ActionEffect, operations: OperationContracts | undefined): OperationContract | null {
  if (operations === undefined) return null;
  const entry = entryOf(operations, effect.action);
  if (!isOperationContract(entry)) return null;
  const pinned = callOf(flow, effect.name, effect.purpose)?.contract;
  if (pinned !== undefined && digestOf(entry) !== pinned) return null;
  return entry;
}

/**
 * How long a `pending` answer to `effect` is waited for: its operation's
 * declared completion window (`completion.windowMs`), when the registry has
 * the contract the call relies on. Undefined otherwise: the core then waits
 * for the call's `timeoutMs`.
 */
export function completionWindowFor(flow: CompiledFlow, effect: ActionEffect, operations: OperationContracts | undefined): number | undefined {
  return contractForEffect(flow, effect, operations)?.completion?.windowMs;
}

/** Flow versions checked before a reporter forgets them all (and may report them again). */
const MAX_CHECKED = 4096;

/**
 * Reports, once per flow version (by hash) and process, the pins of a flow
 * the registry cannot see. The runtime runs it each time it sends an action.
 */
export class UnseenContractReporter {
  private readonly checked = new Set<string>();

  constructor(
    private readonly operations: OperationContracts | undefined,
    private readonly report: (record: ContractRecord) => void,
  ) {}

  /** Checks `flow` the first time it is seen; never throws. */
  check(scope: Scope, flow: CompiledFlow): void {
    if (this.checked.has(flow.hash)) return;
    if (this.checked.size >= MAX_CHECKED) this.checked.clear();
    this.checked.add(flow.hash);
    let unseen: UnseenContract[];
    try {
      unseen = unseenContracts(flow, this.operations);
    } catch {
      return;
    }
    for (const record of unseen) {
      try {
        this.report({ ...record, scope: { tenantId: scope.tenantId, appId: scope.appId, environmentId: scope.environmentId } });
      } catch {
        // Reporting must not break a send.
      }
    }
  }
}
