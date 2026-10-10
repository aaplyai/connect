/**
 * Compiling collections: the `collections` map, the fields of
 * their items, and which actions run once per item.
 *
 * A collection shares the fact namespace: the compiled flow keeps it in
 * `facts` (with `list` set and a synthesized array schema), so everything
 * that names a fact (`needs`, `fills`, `known`, `entry`) can name a list.
 * Its fields are compiled like facts, keyed `collection.field`; their
 * `derive`, `checks` and `dependsOn` belong to one item and read its other
 * fields as `item.<field>`.
 */

import type { CompiledFact } from "./compile.js";
import type { CollectionDef, FactDef } from "./definition.js";
import { keysOf } from "./definition-keys.js";
import type { DiagnosticBag } from "./diagnostics.js";
import { emptyReads, mergeReads, parseExpr, type ExprScope, type Node, type Reads } from "./expr.js";
import { isJsonObject, type PathSegment } from "./json.js";
import type { JsonSchema } from "./schema.js";
import { checkSchema } from "./schema.js";
import { templateOf } from "./address.js";
import { FILL_MODES } from "./fill.js";
import type { FillMode } from "./state.js";

/** Most items one collection may declare as `max`. */
export const MAX_COLLECTION_ITEMS = 500;
/** Most fields an item may have. */
export const MAX_ITEM_FIELDS = 50;
/** Most collections one flow may declare. */
export const MAX_COLLECTIONS = 50;
/** Most steps that run once per item in one flow. */
export const MAX_FOR_EACH_STEPS = 50;
/** Highest `fanOut` a per-item step may declare. */
export const MAX_FAN_OUT = 16;
/** Most item changes one event may carry. */
export const MAX_ITEM_OPS = 100;
/** Most per-run effects in flight at once in a flow with collections. */
export const MAX_INFLIGHT = 32;

/** Default `limits.maxItems` and `limits.maxCollectionBytes` (frozen). */
export const COLLECTION_LIMITS = Object.freeze({ maxItems: 200, maxCollectionBytes: 256 * 1024 } as const);
/** The highest values a definition may set for those limits (frozen). */
export const COLLECTION_LIMIT_CEILINGS = Object.freeze({ maxItems: 2000, maxCollectionBytes: 2 * 1024 * 1024 } as const);

/** A collection as compiled. */
export interface CompiledCollection {
  name: string;
  /** The definition as written. */
  def: CollectionDef;
  /** Fewest items a settled list may have (0 when not given). */
  min: number;
  /** Most items the list may have. */
  max: number;
  /** Field name to its compiled form; each one's `name` is the template address `collection.field`. */
  fields: Map<string, CompiledFact>;
  /** The schema of the list as a value: `[{id, ...fields}]`. */
  schema: JsonSchema;
  /** Facts whose change unsettles the list. */
  dependsOn: string[];
}

/** What the rest of the compiler needs to know about collections before it parses any expression. */
export interface CollectionPlan {
  /** Collection to its field names, for the expression parser. */
  shapes: Map<string, Set<string>>;
  /** Action run by a per-item step, to that step's collection. */
  perItem: Map<string, string>;
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Collects collection and field names, and which actions per-item steps run. Reports nothing; the full pass does. */
export function planCollections(raw: Record<string, unknown>): CollectionPlan {
  const shapes = new Map<string, Set<string>>();
  if (isJsonObject(raw.collections)) {
    for (const [name, def] of Object.entries(raw.collections)) {
      if (!NAME_RE.test(name) || !isJsonObject(def)) continue;
      shapes.set(name, new Set(isJsonObject(def.fields) ? Object.keys(def.fields).filter((f) => NAME_RE.test(f) && f !== "id") : []));
    }
  }
  const perItem = new Map<string, string>();
  if (Array.isArray(raw.steps)) {
    for (const step of raw.steps) {
      if (!isJsonObject(step) || typeof step.forEach !== "string" || typeof step.run !== "string") continue;
      if (shapes.has(step.forEach) && !perItem.has(step.run)) perItem.set(step.run, step.forEach);
    }
  }
  return { shapes, perItem };
}

/** The reads of one field's `derive`, `checks` and `dependsOn`, keyed by template address. */
export interface CompiledCollections {
  collections: Map<string, CompiledCollection>;
  fieldReads: Map<string, Reads>;
}

function optionalText(obj: Record<string, unknown>, key: string, path: PathSegment[], bag: DiagnosticBag, max: number): void {
  const v = obj[key];
  if (v !== undefined && (typeof v !== "string" || v.length > max)) bag.error("flow/invalid-field", [...path, key], `${key} must be a string of at most ${max} characters`);
}

/** Validates and compiles every collection and its fields. */
export function compileCollections(raw: Record<string, unknown>, plan: CollectionPlan, bag: DiagnosticBag, checkKeys: (obj: Record<string, unknown>, allowed: readonly string[], path: PathSegment[]) => void): CompiledCollections {
  const collections = new Map<string, CompiledCollection>();
  const fieldReads = new Map<string, Reads>();
  if (raw.collections === undefined) return { collections, fieldReads };
  if (!isJsonObject(raw.collections)) {
    bag.error("flow/invalid-shape", ["collections"], "collections must be an object");
    return { collections, fieldReads };
  }
  const entries = Object.entries(raw.collections);
  if (entries.length > MAX_COLLECTIONS) bag.error("flow/too-large", ["collections"], `at most ${MAX_COLLECTIONS} collections`);
  for (const [name, rawColl] of entries) {
    const path: PathSegment[] = ["collections", name];
    if (!NAME_RE.test(name)) {
      bag.error("flow/invalid-name", path, "collection names are letters, digits and underscores, starting with a letter");
      continue;
    }
    if (!isJsonObject(rawColl)) {
      bag.error("flow/invalid-shape", path, "a collection must be an object");
      continue;
    }
    checkKeys(rawColl, keysOf("collection"), path);
    optionalText(rawColl, "title", path, bag, 200);
    optionalText(rawColl, "prompt", path, bag, 1000);
    const max = rawColl.max;
    const maxOk = typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= MAX_COLLECTION_ITEMS;
    if (!maxOk) bag.error("flow/collection-invalid", [...path, "max"], `max is required: a whole number from 1 to ${MAX_COLLECTION_ITEMS}`);
    const min = rawColl.min ?? 0;
    const minOk = typeof min === "number" && Number.isInteger(min) && min >= 0 && (!maxOk || min <= (max as number));
    if (!minOk) bag.error("flow/collection-invalid", [...path, "min"], "min must be a whole number from 0 to max");
    let dependsOn: string[] = [];
    if (rawColl.dependsOn !== undefined) {
      if (!isStringArray(rawColl.dependsOn)) bag.error("flow/invalid-field", [...path, "dependsOn"], "dependsOn must be a list of fact names");
      else dependsOn = [...new Set(rawColl.dependsOn)];
    }
    const fields = new Map<string, CompiledFact>();
    if (!isJsonObject(rawColl.fields) || Object.keys(rawColl.fields).length === 0 || Object.keys(rawColl.fields).length > MAX_ITEM_FIELDS) {
      bag.error("flow/collection-invalid", [...path, "fields"], `fields must declare 1 to ${MAX_ITEM_FIELDS} item fields`);
    } else {
      for (const [field, rawField] of Object.entries(rawColl.fields)) {
        const fpath: PathSegment[] = [...path, "fields", field];
        if (!NAME_RE.test(field) || field === "id") {
          bag.error("flow/collection-invalid", fpath, 'field names are letters, digits and underscores, starting with a letter; "id" is the item\'s own');
          continue;
        }
        const compiled = compileField(name, field, rawField, fpath, plan, bag, checkKeys);
        if (!compiled) continue;
        fields.set(field, compiled.fact);
        fieldReads.set(templateOf(name, field), compiled.reads);
      }
    }
    if (!maxOk || !minOk) continue;
    const properties: Record<string, JsonSchema> = { id: { type: "string" } };
    for (const [field, fact] of fields) properties[field] = fact.schema;
    collections.set(name, {
      name,
      def: rawColl as unknown as CollectionDef,
      min: min as number,
      max: max as number,
      fields,
      schema: {
        type: "array",
        minItems: min as number,
        maxItems: max as number,
        items: { type: "object", properties, required: ["id"], additionalProperties: false },
      },
      dependsOn,
    });
  }
  return { collections, fieldReads };
}

function compileField(
  collection: string,
  field: string,
  rawField: unknown,
  path: PathSegment[],
  plan: CollectionPlan,
  bag: DiagnosticBag,
  checkKeys: (obj: Record<string, unknown>, allowed: readonly string[], path: PathSegment[]) => void,
): { fact: CompiledFact; reads: Reads } | null {
  if (!isJsonObject(rawField)) {
    bag.error("flow/invalid-shape", path, "a field must be an object");
    return null;
  }
  checkKeys(rawField, keysOf("itemField"), path);
  // How far an assistant's value may go, as for a fact (ADR 0012).
  if (rawField.fill !== undefined) {
    if (!FILL_MODES.includes(rawField.fill as FillMode)) bag.error("flow/invalid-field", [...path, "fill"], "fill is never, suggest, confirm or auto");
    else if (rawField.derive !== undefined) bag.error("flow/derived-fact-flags", [...path, "fill"], "a derived field is never filled");
  }
  if (rawField.type === undefined) bag.error("flow/invalid-shape", [...path, "type"], "a field needs a type (a JSON schema)");
  else checkSchema(rawField.type, [...path, "type"], bag);
  optionalText(rawField, "title", path, bag, 200);
  optionalText(rawField, "prompt", path, bag, 1000);
  const sensitivity = rawField.sensitivity ?? "personal";
  if (sensitivity !== "none" && sensitivity !== "personal" && sensitivity !== "secret") bag.error("flow/invalid-field", [...path, "sensitivity"], "sensitivity is none, personal or secret");
  for (const flag of ["userAsserted", "confirm", "optional"] as const) {
    if (rawField[flag] !== undefined && typeof rawField[flag] !== "boolean") bag.error("flow/invalid-field", [...path, flag], `${flag} must be a boolean`);
  }
  const options = { collections: plan.shapes, itemOf: collection };
  const reads = emptyReads();
  let derive: Node | undefined;
  if (rawField.derive !== undefined) {
    const parsed = parseExpr(rawField.derive, [...path, "derive"], bag, { ...options, allowNow: false });
    if (parsed) {
      derive = parsed.node;
      mergeReads(reads, parsed.reads);
    }
    if (rawField.userAsserted || rawField.confirm || rawField.optional) bag.error("flow/derived-fact-flags", path, "a derived field cannot be userAsserted, confirm or optional");
  }
  if (rawField.dependsOn !== undefined) {
    if (!isStringArray(rawField.dependsOn)) bag.error("flow/invalid-field", [...path, "dependsOn"], "dependsOn must be a list of fact names, or this collection's fields as collection.field");
    else
      for (const dep of rawField.dependsOn) {
        const dot = dep.indexOf(".");
        if (dot === -1) reads.facts.add(dep);
        else if (dep.slice(0, dot) === collection && plan.shapes.get(collection)?.has(dep.slice(dot + 1))) (reads.self ??= new Set()).add(dep.slice(dot + 1));
        else bag.error("flow/unknown-fact", [...path, "dependsOn"], `"${dep}" is not a fact or a field of "${collection}"`);
      }
  }
  const checks: CompiledFact["checks"] = [];
  if (rawField.checks !== undefined) {
    if (!Array.isArray(rawField.checks) || rawField.checks.length > 20) bag.error("flow/invalid-field", [...path, "checks"], "checks must be a list of at most 20 rules");
    else
      rawField.checks.forEach((check, i) => {
        const cpath = [...path, "checks", i];
        if (!isJsonObject(check) || typeof check.message !== "string" || check.message.length > 500) {
          bag.error("flow/invalid-field", cpath, "a check is {test, message, code?}");
          return;
        }
        checkKeys(check, keysOf("check"), cpath);
        if (check.code !== undefined && (typeof check.code !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(check.code))) bag.error("flow/invalid-field", [...cpath, "code"], "code must be a short identifier");
        const parsed = parseExpr(check.test, [...cpath, "test"], bag, { ...options, scopes: new Set<ExprScope>(["value"]) });
        if (parsed) {
          mergeReads(reads, parsed.reads);
          checks.push({ test: parsed.node, message: check.message, code: typeof check.code === "string" ? check.code : "check" });
        }
      });
  }
  const fact: CompiledFact = {
    name: templateOf(collection, field),
    def: rawField as unknown as FactDef,
    schema: (isJsonObject(rawField.type) ? rawField.type : {}) as JsonSchema,
    sensitivity: sensitivity as CompiledFact["sensitivity"],
    ...(derive ? { derive } : {}),
    checks,
    userFillable: false,
    parameter: false,
    collection,
    field,
  };
  return { fact, reads };
}

/** The fact entry a collection has in `CompiledFlow.facts`. */
export function listFact(collection: CompiledCollection): CompiledFact {
  const def: FactDef = { type: collection.schema };
  if (collection.def.title !== undefined) def.title = collection.def.title;
  if (collection.def.prompt !== undefined) def.prompt = collection.def.prompt;
  return { name: collection.name, def, schema: collection.schema, sensitivity: "personal", checks: [], userFillable: false, parameter: false, list: collection };
}
