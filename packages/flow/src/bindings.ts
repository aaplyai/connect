/**
 * Static checks between a flow and the operation contracts its actions name,
 * run when a flow is published. The engine sees only `effect`, `idempotent`
 * and the call itself at run time, so what an operation declares about risk
 * and undo is enforced here:
 *
 * - the operation exists,
 * - a write is declared as a write, and only an idempotent operation is marked idempotent,
 * - the flow's `risk` is at least the operation's `riskFloor`,
 * - an irreversible operation is not given a `compensate`, and a compensate or
 *   reconcile call names a write or a read respectively,
 * - a compensate call names the undo the write's own operation declares (a
 *   warning names the gap when the write's connector has no contracts here),
 *   which de-duplicates and has risk floor `none`: the engine sends an undo
 *   unreviewed and again after an unknown answer,
 * - each call's pinned contract digest is the operation's current one,
 *   and, when publishing to production, every call is pinned.
 *
 * Contracts are keyed by action id (`<connectorId>.<operation>`). A call whose
 * connector has no contract in the table is not checked; an action id whose
 * connector is there but whose operation is not is an unknown operation.
 *
 * `pinActionContracts` writes the pins: the publish pipeline runs it, then
 * compiles, then `checkActionBindings` for the target environment.
 */

import { DiagnosticBag, cloneJson, isJsonObject, isOperationContract, operationDigest, riskAtLeast, type Diagnostic, type JsonObject, type JsonValue, type EnvironmentKind, type OperationContract, type PathSegment, type Risk } from "@aaply/action-contract";
import type { CompiledFlow } from "./compile.js";
import type { FlowDefinition } from "./definition.js";

/** Operation contracts by action id: a map, or a plain record. */
export type OperationContracts = ReadonlyMap<string, OperationContract> | Readonly<Record<string, OperationContract>>;

/** Options for {@link checkActionBindings}. */
export interface ActionBindingOptions {
  /** Where the flow is being published. In production every call must be pinned; in `preview` and `test` an unpinned call is a warning. */
  environment?: EnvironmentKind;
}

type Lookup = { known: false } | { known: true; id: string; contract: OperationContract | null };

function table(contracts: OperationContracts, bag: DiagnosticBag): { get(action: unknown): Lookup; isUndo(id: string): boolean } {
  const entries: Array<[string, unknown]> = contracts instanceof Map ? [...contracts.entries()] : Object.entries(contracts as Record<string, unknown>);
  const byId = new Map<string, OperationContract>();
  const connectors = new Set<string>();
  // Operations some operation declares as its undo.
  const undos = new Set<string>();
  for (const [id, contract] of entries) {
    const dot = id.indexOf(".");
    if (dot <= 0 || !isOperationContract(contract)) {
      bag.error("flow/contract-invalid", [], `the operation contract given for "${id}" is not valid`);
      continue;
    }
    byId.set(id, contract);
    connectors.add(id.slice(0, dot));
    if (contract.compensate !== undefined) undos.add(contract.compensate);
  }
  return {
    isUndo: (id) => undos.has(id),
    get(action) {
      if (typeof action !== "string") return { known: false };
      const dot = action.indexOf(".");
      if (dot <= 0 || !connectors.has(action.slice(0, dot))) return { known: false };
      return { known: true, id: action, contract: byId.get(action) ?? null };
    },
  };
}

function definitionOf(flow: unknown): Record<string, unknown> | null {
  if (typeof flow === "object" && flow !== null && "definition" in flow && (flow as CompiledFlow).actions instanceof Map) {
    return (flow as CompiledFlow).definition as unknown as Record<string, unknown>;
  }
  return isJsonObject(flow as JsonValue) ? (flow as Record<string, unknown>) : null;
}

const CALLS = ["compensate", "reconcile"] as const;

/**
 * Checks a flow (its definition, or the compiled flow) against operation
 * contracts. Codes: `connector/flow-unknown-operation`, `connector/flow-effect-mismatch`,
 * `connector/flow-idempotency-mismatch`, `connector/flow-risk-below-floor`,
 * `connector/flow-undo-mismatch`, `connector/flow-undo-undeclared`,
 * `connector/flow-undo-unpaired`, `connector/flow-undo-not-idempotent`, `connector/flow-undo-reviewed`,
 * `flow/contract-mismatch`, `flow/contract-unpinned` and `flow/contract-invalid`.
 */
export function checkActionBindings(flow: unknown, contracts: OperationContracts, options: ActionBindingOptions = {}): Diagnostic[] {
  const bag = new DiagnosticBag();
  const lookup = table(contracts, bag);
  const definition = definitionOf(flow);
  const actions = definition?.actions;
  if (!definition || !isJsonObject(actions as JsonValue)) return bag.items;
  const production = options.environment === "production";

  const checkPin = (call: Record<string, unknown>, target: Lookup, path: PathSegment[]): void => {
    if (!target.known || !target.contract) return;
    const pinned = call.contract;
    if (pinned !== undefined) {
      const current = operationDigest(target.contract);
      if (pinned !== current) bag.error("flow/contract-mismatch", [...path, "contract"], `"${target.id}" no longer has the contract this flow was published against; review the change and pin it again`);
      return;
    }
    if (!production) {
      bag.warn("flow/contract-unpinned", path, `"${target.id}" is not pinned to its operation contract; pin it before publishing to production`);
      return;
    }
    bag.error("flow/contract-unpinned", path, `"${target.id}" must be pinned to its operation contract to publish to production (pinActionContracts)`);
  };

  for (const [name, raw] of Object.entries(actions as Record<string, unknown>)) {
    if (!isJsonObject(raw as JsonValue)) continue;
    const def = raw as Record<string, unknown>;
    const path: PathSegment[] = ["actions", name];
    const main = lookup.get(def.action);
    if (main.known) {
      const op = main.contract;
      if (!op) bag.error("connector/flow-unknown-operation", [...path, "action"], `"${main.id}" is not an operation of its connector`);
      else {
        if (def.effect === "read" && op.effect === "write") bag.error("connector/flow-effect-mismatch", [...path, "effect"], `"${main.id}" is a write`);
        if (def.effect === "write" && op.effect === "read") bag.warn("connector/flow-effect-mismatch", [...path, "effect"], `"${main.id}" is a read; declaring it a write only adds caution`);
        if (def.effect === "write" && def.idempotent === true && !op.idempotent) {
          bag.error("connector/flow-idempotency-mismatch", [...path, "idempotent"], `"${main.id}" does not de-duplicate, so the flow must not mark it idempotent`);
        }
        const risk = (def.risk ?? "none") as Risk;
        if (def.effect === "write" && op.effect === "write" && (risk === "none" || risk === "confirm" || risk === "approval") && !riskAtLeast(risk, op.riskFloor)) {
          bag.error("connector/flow-risk-below-floor", [...path, "risk"], `"${main.id}" needs risk "${op.riskFloor}" or higher`);
        }
        if (op.irreversible && def.compensate !== undefined) {
          bag.error("connector/flow-undo-mismatch", [...path, "compensate"], `"${main.id}" cannot be undone`);
        }
        if (def.effect === "write" && op.compensate !== undefined && def.compensate === undefined && def.irreversible !== true) {
          bag.warn("connector/flow-undo-mismatch", path, `"${main.id}" can be undone with "${op.compensate}"; consider declaring compensate`);
        }
        checkPin(def, main, path);
      }
    }
    for (const key of CALLS) {
      const call = def[key];
      if (!isJsonObject(call as JsonValue)) continue;
      const target = lookup.get((call as Record<string, unknown>).action);
      if (!target.known) continue;
      if (!target.contract) bag.error("connector/flow-unknown-operation", [...path, key, "action"], `"${target.id}" is not an operation of its connector`);
      else {
        if (key === "compensate" && target.contract.effect !== "write") bag.error("connector/flow-effect-mismatch", [...path, key, "action"], `"${target.id}" is a read and cannot undo anything`);
        else if (key === "reconcile" && target.contract.effect !== "read") bag.error("connector/flow-effect-mismatch", [...path, key, "action"], `"${target.id}" is a write; reconcile must be a read`);
        else if (key === "compensate") {
          // The engine sends an undo unreviewed, and again after an unknown answer (the performer refuses anything else).
          // It must be the undo the write's own operation declares: another write's undo (a purge of everything) is not one.
          const own = main.known ? main.contract : null;
          if (!lookup.isUndo(target.id)) {
            const declared = own?.compensate !== undefined ? `; "${main.known ? main.id : ""}" declares "${own.compensate}"` : "";
            bag.error("connector/flow-undo-undeclared", [...path, key, "action"], `"${target.id}" is not declared as the undo of any operation${declared}`);
          } else if (own && !own.irreversible && own.compensate !== target.id) {
            const declared = own.compensate !== undefined ? `its undo is "${own.compensate}"` : "it declares none";
            bag.error("connector/flow-undo-unpaired", [...path, key, "action"], `"${target.id}" is another operation's undo, not the undo of "${main.known ? main.id : ""}" (${declared})`);
          } else if (!main.known) {
            bag.warn("connector/flow-undo-unpaired", [...path, key, "action"], `"${String(def.action)}" has no operation contract, so whether "${target.id}" is its undo is not checked`);
          }
          if (!target.contract.idempotent) bag.error("connector/flow-undo-not-idempotent", [...path, key, "action"], `"${target.id}" does not de-duplicate, and an undo may be sent more than once`);
          if (target.contract.riskFloor !== "none") bag.error("connector/flow-undo-reviewed", [...path, key, "action"], `"${target.id}" needs risk "${target.contract.riskFloor}", and nobody reviews an undo`);
        }
        checkPin(call as Record<string, unknown>, target, [...path, key]);
      }
    }
  }
  return bag.items;
}

/**
 * Pins every action call (main, compensate and reconcile) whose operation is
 * in `contracts` to its operation-contract digest, in a copy of the
 * definition. A pin that no longer
 * matches is not overwritten (`flow/contract-mismatch`): accepting a changed
 * contract is a decision, made by removing the old pin. A call whose
 * operation has no contract is left unpinned (`flow/contract-unknown`, a warning).
 */
export function pinActionContracts(definition: FlowDefinition, contracts: OperationContracts): { definition: FlowDefinition; diagnostics: Diagnostic[] } {
  const bag = new DiagnosticBag();
  if (!isJsonObject(definition as unknown as JsonValue)) {
    bag.error("flow/invalid-shape", [], "a flow definition must be an object");
    return { definition, diagnostics: bag.items };
  }
  const lookup = table(contracts, bag);
  const copy = cloneJson(definition as unknown as JsonObject);
  const actions = copy.actions;
  if (!isJsonObject(actions as JsonValue)) return { definition: copy as unknown as FlowDefinition, diagnostics: bag.items };
  const pin = (call: JsonObject, path: PathSegment[]): void => {
    const target = lookup.get(call.action);
    if (!target.known || !target.contract) {
      bag.warn("flow/contract-unknown", [...path, "action"], `no operation contract for "${String(call.action)}"; this call is not pinned`);
      return;
    }
    const digest = operationDigest(target.contract);
    if (call.contract !== undefined && call.contract !== digest) {
      bag.error("flow/contract-mismatch", [...path, "contract"], `"${target.id}" changed its contract since it was pinned; review the change, then remove the old pin to accept it`);
      return;
    }
    call.contract = digest;
  };
  for (const [name, raw] of Object.entries(actions as JsonObject)) {
    if (!isJsonObject(raw)) continue;
    pin(raw, ["actions", name]);
    for (const key of CALLS) {
      const call = raw[key];
      if (isJsonObject(call as JsonValue)) pin(call as JsonObject, ["actions", name, key]);
    }
  }
  return { definition: copy as unknown as FlowDefinition, diagnostics: bag.items };
}
