/**
 * Compiles the actions section: each action's call, effect, risk, approval,
 * undo, hold and retry.
 */

import type { ActionDef } from "../definition.js";
import { keysOf } from "../definition-keys.js";
import { type Reads, type Node, parseExpr, type ExprScope, mergeReads, emptyReads } from "../expr.js";
import { type PathSegment, isJsonObject } from "../json.js";
import { actionIdentity } from "../migration-def.js";
import { checkSchema } from "../schema.js";
import type { CompileContext, ActionsSection } from "./context.js";
import { type CompiledCall, checkKeys, CONNECTOR_ACTION_RE, NAME_RE, positiveInt, MAX_ACTION_TIMEOUT_MS, CONTRACT_DIGEST_RE, DEFAULT_ACTION_TIMEOUT_MS, type CompiledAction, MAX_ACTIONS, MAX_REVIEW_TTL_MS, isStringArray, ROLE_RE, DAY, DEFAULT_RETRY } from "../compile.js";

// --- actions -----------------------------------------------------------

/** One action's call, or a compensation or reconciliation call ("frozen": it reads only the resource). */
export function compileCall(cx: CompileContext, callReads: Map<string, Reads>, rawCall: unknown, path: PathSegment[], mode: "main" | "frozen", itemOf?: string): CompiledCall | null {
  const { bag, shared } = cx;
  if (!isJsonObject(rawCall)) {
    bag.error("flow/invalid-shape", path, "expected an object");
    return null;
  }
  // The action's own fields are checked with the action.
  if (mode === "frozen") checkKeys(rawCall, keysOf("actionCall"), path, bag);
  if (typeof rawCall.action !== "string" || !CONNECTOR_ACTION_RE.test(rawCall.action)) {
    bag.error("flow/invalid-action-id", [...path, "action"], 'action must be a connector action id such as "calendar.findSlots"');
  }
  if (rawCall.connection !== undefined && (typeof rawCall.connection !== "string" || !NAME_RE.test(rawCall.connection))) {
    bag.error("flow/invalid-field", [...path, "connection"], "connection must name a connection role");
  }
  if (rawCall.timeoutMs !== undefined && !positiveInt(rawCall.timeoutMs, MAX_ACTION_TIMEOUT_MS)) {
    bag.error("flow/invalid-field", [...path, "timeoutMs"], "timeoutMs must be a positive integer up to 7 days");
  }
  if (rawCall.contract !== undefined && (typeof rawCall.contract !== "string" || !CONTRACT_DIGEST_RE.test(rawCall.contract))) {
    bag.error("flow/invalid-field", [...path, "contract"], 'contract must be an operation-contract digest, "sha256:" and 64 lower-case hex digits');
  }
  const inputs: [string, Node][] = [];
  if (!isJsonObject(rawCall.input)) bag.error("flow/invalid-shape", [...path, "input"], "input must be an object of expressions");
  else {
    for (const [key, expr] of Object.entries(rawCall.input)) {
      if (key === "__proto__") continue;
      const parsed = parseExpr(
        expr,
        [...path, "input", key],
        bag,
        mode === "frozen" ? { allowState: false, allowNow: false, scopes: new Set<ExprScope>(["resource"]) } : { ...shared, allowNow: false, ...(itemOf !== undefined ? { itemOf } : {}) },
      );
      if (parsed) {
        inputs.push([key, parsed.node]);
        if (mode === "main") callReads.set(path.join("/"), mergeReads(callReads.get(path.join("/")) ?? emptyReads(), parsed.reads));
      }
    }
  }
  return {
    // Refused above unless a string; a value that is not one must never be turned into text here.
    action: typeof rawCall.action === "string" ? rawCall.action : "",
    ...(typeof rawCall.connection === "string" ? { connection: rawCall.connection } : {}),
    input: inputs,
    timeoutMs: typeof rawCall.timeoutMs === "number" ? rawCall.timeoutMs : DEFAULT_ACTION_TIMEOUT_MS,
    ...(typeof rawCall.contract === "string" ? { contract: rawCall.contract } : {}),
  };
}

export function compileActions(cx: CompileContext): ActionsSection {
  const { bag, raw, plan } = cx;
  const actions = new Map<string, CompiledAction>();
  const rawActions = raw.actions ?? {};
  if (!isJsonObject(rawActions)) bag.error("flow/invalid-shape", ["actions"], "actions must be an object");
  const actionEntries = isJsonObject(rawActions) ? Object.entries(rawActions) : [];
  if (actionEntries.length > MAX_ACTIONS) bag.error("flow/too-large", ["actions"], `at most ${MAX_ACTIONS} actions`);
  const callReads = new Map<string, Reads>();
  for (const [name, rawAction] of actionEntries) {
    const path: PathSegment[] = ["actions", name];
    if (!NAME_RE.test(name)) bag.error("flow/invalid-name", path, "action names are letters, digits and underscores, starting with a letter");
    if (!isJsonObject(rawAction)) {
      bag.error("flow/invalid-shape", path, "action must be an object");
      continue;
    }
    checkKeys(rawAction, keysOf("action"), path, bag);
    const call = compileCall(cx, callReads, rawAction, path, "main", plan.perItem.get(name));
    const effect = rawAction.effect;
    if (effect !== "read" && effect !== "write") bag.error("flow/invalid-field", [...path, "effect"], "effect is read or write");
    if (rawAction.inputSchema !== undefined) checkSchema(rawAction.inputSchema, [...path, "inputSchema"], bag);
    if (rawAction.outputSchema !== undefined) checkSchema(rawAction.outputSchema, [...path, "outputSchema"], bag);
    const risk = rawAction.risk ?? "none";
    if (risk !== "none" && risk !== "confirm" && risk !== "approval") bag.error("flow/invalid-field", [...path, "risk"], "risk is none, confirm or approval");
    let approvalRoles: string[] = [];
    let approvalTtlMs: number | undefined;
    if (rawAction.approval !== undefined) {
      if (isJsonObject(rawAction.approval)) {
        checkKeys(rawAction.approval, keysOf("approval"), [...path, "approval"], bag);
        const ttl = rawAction.approval.ttlMs;
        if (ttl !== undefined) {
          if (!positiveInt(ttl, MAX_REVIEW_TTL_MS)) bag.error("flow/invalid-field", [...path, "approval", "ttlMs"], "approval.ttlMs must be a positive integer up to 366 days");
          else approvalTtlMs = ttl;
        }
      }
      const roles = isJsonObject(rawAction.approval) ? rawAction.approval.roles : undefined;
      if (!isStringArray(roles) || roles.length === 0 || roles.some((r) => !ROLE_RE.test(r))) bag.error("flow/invalid-role", [...path, "approval", "roles"], "approval.roles must list role names");
      else approvalRoles = [...roles];
    }
    if (risk === "approval" && approvalRoles.length === 0) bag.error("flow/approval-roles", [...path, "approval"], "an approval action needs approval.roles");
    if (risk !== "approval" && rawAction.approval !== undefined) bag.error("flow/approval-roles", [...path, "approval"], 'approval is only used with risk "approval"');
    if (rawAction.actingFor !== undefined && rawAction.actingFor !== "business" && rawAction.actingFor !== "endUser") {
      bag.error("flow/invalid-field", [...path, "actingFor"], "actingFor is business or endUser");
    }
    for (const flag of ["idempotent", "irreversible", "commit"] as const) {
      if (rawAction[flag] !== undefined && typeof rawAction[flag] !== "boolean") bag.error("flow/invalid-field", [...path, flag], `${flag} must be a boolean`);
    }
    const compensate = rawAction.compensate !== undefined ? compileCall(cx, callReads, rawAction.compensate, [...path, "compensate"], "frozen") : null;
    const reconcile = rawAction.reconcile !== undefined ? compileCall(cx, callReads, rawAction.reconcile, [...path, "reconcile"], "frozen") : null;
    if (effect === "read") {
      for (const key of ["compensate", "reconcile", "irreversible", "commit", "hold"] as const) {
        if (rawAction[key] !== undefined) bag.error("flow/read-with-write-option", [...path, key], `${key} only applies to writes`);
      }
      if (risk !== "none") bag.error("flow/read-with-write-option", [...path, "risk"], "reads do not need confirmation");
    }
    if (effect === "write") {
      if (!compensate && rawAction.irreversible !== true) {
        bag.error("flow/write-needs-undo", path, "a write needs compensate (how to undo it) or irreversible: true");
      }
      if (compensate && rawAction.irreversible === true) bag.error("flow/write-needs-undo", path, "a write cannot be both compensable and irreversible");
    }
    let holdTtlMs: number | undefined;
    if (rawAction.hold !== undefined) {
      if (isJsonObject(rawAction.hold)) checkKeys(rawAction.hold, keysOf("hold"), [...path, "hold"], bag);
      const ttl = isJsonObject(rawAction.hold) ? rawAction.hold.ttlMs : undefined;
      if (!positiveInt(ttl, 366 * DAY)) bag.error("flow/invalid-field", [...path, "hold", "ttlMs"], "hold.ttlMs must be a positive integer");
      else holdTtlMs = ttl;
      if (!compensate) bag.error("flow/hold-needs-compensate", [...path, "hold"], "a hold must say how to release it (compensate)");
    }
    const retry: { max: number; baseMs: number; maxMs: number } = { ...DEFAULT_RETRY };
    if (rawAction.retry !== undefined) {
      if (!isJsonObject(rawAction.retry)) bag.error("flow/invalid-field", [...path, "retry"], "retry must be an object");
      else {
        checkKeys(rawAction.retry, keysOf("retry"), [...path, "retry"], bag);
        const r = rawAction.retry;
        if (r.max !== undefined) {
          if (typeof r.max !== "number" || !Number.isInteger(r.max) || r.max < 0 || r.max > 20) bag.error("flow/invalid-field", [...path, "retry", "max"], "retry.max is 0-20");
          else retry.max = r.max;
        }
        for (const key of ["baseMs", "maxMs"] as const) {
          if (r[key] !== undefined) {
            if (!positiveInt(r[key], DAY)) bag.error("flow/invalid-field", [...path, "retry", key], `retry.${key} must be a positive integer up to a day`);
            else retry[key] = r[key];
          }
        }
      }
    }
    if (!call || (effect !== "read" && effect !== "write")) continue;
    actions.set(name, {
      name,
      def: rawAction as unknown as ActionDef,
      call,
      reads: callReads.get(path.join("/")) ?? emptyReads(),
      risk: risk as CompiledAction["risk"],
      approvalRoles,
      idempotent: rawAction.idempotent === true,
      commitPoint: effect === "write" && (rawAction.commit === true || rawAction.irreversible === true),
      ...(compensate ? { compensate } : {}),
      ...(reconcile ? { reconcile } : {}),
      ...(holdTtlMs !== undefined ? { holdTtlMs } : {}),
      ...(approvalTtlMs !== undefined ? { reviewTtlMs: approvalTtlMs } : {}),
      retry,
      stepId: "",
      ...(plan.perItem.has(name) ? { forEach: plan.perItem.get(name)! } : {}),
      identity: actionIdentity(rawAction),
    });
  }
  return { actions, rawActions };
}
