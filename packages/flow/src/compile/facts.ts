/**
 * Compiles the facts section: each fact's type, flags, derivation and checks,
 * and the collections read as facts.
 */

import { splitTemplate } from "../address.js";
import { listFact } from "../collections-compile.js";
import type { FactDef } from "../definition.js";
import { keysOf } from "../definition-keys.js";
import { type Reads, emptyReads, type Node, parseExpr, mergeReads, type ExprScope } from "../expr.js";
import { isJsonObject, type PathSegment, hasOwn } from "../json.js";
import { checkSchema, type JsonSchema } from "../schema.js";
import { FILL_MODES } from "../fill.js";
import type { FillMode } from "../state.js";
import type { CompileContext, FactsSection } from "./context.js";
import { type CompiledFact, MAX_FACTS, NAME_RE, checkKeys, optionalString, isStringArray, OUTPUT_RE } from "../compile.js";

// --- facts -------------------------------------------------------------

export function compileFacts(cx: CompileContext): FactsSection | null {
  const { bag, raw, collections, shared, mayFill } = cx;
  const facts = new Map<string, CompiledFact>();
  const factReads = new Map<string, Reads>();
  const deriveReads = new Map<string, Reads>();
  if (!isJsonObject(raw.facts)) {
    bag.error("flow/invalid-shape", ["facts"], "facts must be an object");
    return null;
  }
  const factEntries = Object.entries(raw.facts);
  if (factEntries.length > MAX_FACTS) bag.error("flow/too-large", ["facts"], `at most ${MAX_FACTS} facts`);
  for (const [name, rawFact] of factEntries) {
    const path: PathSegment[] = ["facts", name];
    if (!NAME_RE.test(name)) bag.error("flow/invalid-name", path, "fact names are letters, digits and underscores, starting with a letter");
    if (!isJsonObject(rawFact)) {
      bag.error("flow/invalid-shape", path, "fact must be an object");
      continue;
    }
    checkKeys(rawFact, keysOf("fact"), path, bag);
    if (rawFact.fill !== undefined) {
      if (!FILL_MODES.includes(rawFact.fill as FillMode)) bag.error("flow/invalid-field", [...path, "fill"], "fill is never, suggest, confirm or auto");
      else if (rawFact.derive !== undefined) bag.error("flow/derived-fact-flags", [...path, "fill"], "a derived fact is never filled");
    }
    if (rawFact.type === undefined) bag.error("flow/invalid-shape", [...path, "type"], "fact needs a type (a JSON schema)");
    else checkSchema(rawFact.type, [...path, "type"], bag);
    optionalString(rawFact, "title", path, bag, 200);
    optionalString(rawFact, "prompt", path, bag, 1000);
    const sensitivity = rawFact.sensitivity ?? "personal";
    if (sensitivity !== "none" && sensitivity !== "personal" && sensitivity !== "secret") bag.error("flow/invalid-field", [...path, "sensitivity"], "sensitivity is none, personal or secret");
    for (const flag of ["userAsserted", "confirm", "optional", "parameter"] as const) {
      if (rawFact[flag] !== undefined && typeof rawFact[flag] !== "boolean") bag.error("flow/invalid-field", [...path, flag], `${flag} must be a boolean`);
    }
    const reads = emptyReads();
    let derive: Node | undefined;
    if (rawFact.derive !== undefined) {
      const parsed = parseExpr(rawFact.derive, [...path, "derive"], bag, { ...shared, allowNow: false });
      if (parsed) {
        derive = parsed.node;
        mergeReads(reads, parsed.reads);
        deriveReads.set(name, parsed.reads);
      } else mayFill.add(name);
      if (rawFact.userAsserted || rawFact.confirm || rawFact.optional || rawFact.parameter) {
        bag.error("flow/derived-fact-flags", path, "a derived fact cannot be userAsserted, confirm, optional or a parameter");
      }
    }
    if (rawFact.dependsOn !== undefined) {
      if (!isStringArray(rawFact.dependsOn)) bag.error("flow/invalid-field", [...path, "dependsOn"], "dependsOn must be a list of fact names");
      else for (const dep of rawFact.dependsOn) reads.facts.add(dep);
    }
    const checks: CompiledFact["checks"] = [];
    if (rawFact.checks !== undefined) {
      if (!Array.isArray(rawFact.checks) || rawFact.checks.length > 20) bag.error("flow/invalid-field", [...path, "checks"], "checks must be a list of at most 20 rules");
      else {
        rawFact.checks.forEach((check, i) => {
          const cpath = [...path, "checks", i];
          if (!isJsonObject(check) || typeof check.message !== "string" || check.message.length > 500) {
            bag.error("flow/invalid-field", cpath, "a check is {test, message, code?}");
            return;
          }
          checkKeys(check, keysOf("check"), cpath, bag);
          if (check.code !== undefined && (typeof check.code !== "string" || !OUTPUT_RE.test(check.code))) bag.error("flow/invalid-field", [...cpath, "code"], "code must be a short identifier");
          const parsed = parseExpr(check.test, [...cpath, "test"], bag, { ...shared, scopes: new Set<ExprScope>(["value"]) });
          if (parsed) {
            mergeReads(reads, parsed.reads);
            checks.push({ test: parsed.node, message: check.message, code: typeof check.code === "string" ? check.code : "check" });
          }
        });
      }
    }
    facts.set(name, {
      name,
      def: rawFact as unknown as FactDef,
      schema: (isJsonObject(rawFact.type) ? rawFact.type : {}) as JsonSchema,
      sensitivity: sensitivity as CompiledFact["sensitivity"],
      ...(derive ? { derive } : {}),
      checks,
      userFillable: false,
      parameter: rawFact.parameter === true,
    });
    factReads.set(name, reads);
  }
  // A collection is read as a fact, so it lives in the same namespace.
  for (const collection of collections.values()) {
    if (facts.has(collection.name)) {
      bag.error("flow/collection-invalid", ["collections", collection.name], `"${collection.name}" is already a fact`);
      continue;
    }
    facts.set(collection.name, listFact(collection));
    const reads = emptyReads();
    for (const dep of collection.dependsOn) reads.facts.add(dep);
    factReads.set(collection.name, reads);
  }
  /** A fact, a collection, or an item field by its template address `collection.field`. */
  const factOrField = (name: string): CompiledFact | undefined => {
    const fact = facts.get(name);
    if (fact) return fact;
    const t = splitTemplate(name);
    return t ? collections.get(t.collection)?.fields.get(t.field) : undefined;
  };
  /**
   * A fact, a collection or an item field the definition declares, that failed its own check: that
   * check reported it, so its uses are left alone (one fault, one diagnostic).
   */
  const rawCollections = isJsonObject(raw.collections) ? raw.collections : {};
  const declaredBroken = (name: string): boolean => {
    if (factOrField(name)) return false;
    const t = splitTemplate(name);
    if (!t) return hasOwn(raw.facts as Record<string, unknown>, name) || hasOwn(rawCollections, name);
    if (!hasOwn(rawCollections, t.collection)) return false;
    const rawFields = (rawCollections[t.collection] as Record<string, unknown> | undefined)?.fields;
    return !collections.has(t.collection) || (isJsonObject(rawFields) && hasOwn(rawFields, t.field));
  };
  return { facts, factReads, deriveReads, factOrField, declaredBroken };
}
