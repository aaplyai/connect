/**
 * A small, closed subset of JSON Schema used to type facts, action input and
 * output, and Facet section contracts.
 *
 * Closed means unknown keywords are rejected, so a schema never silently
 * means less than its author thinks. The subset is deliberately the part of
 * JSON Schema that has one obvious meaning: types, enums, string, number,
 * object and array constraints, a handful of formats, and `anyOf`.
 *
 * Patterns are tenant-authored regular expressions, so they run on a
 * linear-time matcher (`pattern.ts`), never on the backtracking engine, and
 * only against bounded input.
 */

import { BLOB_REF_SCHEMA, blobConstraintCovers, blobConstraintProblem, blobValueProblem, type BlobConstraint } from "./blob.js";
import { DiagnosticBag } from "./diagnostics.js";
import { compilePattern, patternMatches, type CompiledPattern, type PatternBudget } from "./pattern.js";
import { canonicalJson, checkJson, hasOwn, isJsonObject, jsonEqual, own, type JsonValue, type PathSegment } from "./json.js";

/** The JSON types the schema subset can name. */
export type JsonType = "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";

/** The string formats the schema subset checks. */
export type StringFormat = "date" | "date-time" | "time" | "email" | "uri" | "uuid" | "phone";

/** The supported JSON Schema subset (see docs/authoring.md). */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  enum?: JsonValue[];
  const?: JsonValue;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: StringFormat;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  anyOf?: JsonSchema[];
  /**
   * The value is a blob reference (`BlobRef`), optionally of some media
   * types and at most some size. Stands alone: beside it only annotations
   * and `x-*` keys are allowed.
   */
  blob?: true | BlobConstraint;
  title?: string;
  description?: string;
  examples?: JsonValue[];
  default?: JsonValue;
  $comment?: string;
}

/** Where a value or schema failed a check, and why. */
export interface SchemaIssue {
  path: PathSegment[];
  code: string;
  message: string;
}

/** The JSON types the schema subset can name (frozen). */
export const JSON_TYPES = Object.freeze(["string", "number", "integer", "boolean", "null", "object", "array"] as const) satisfies readonly JsonType[];
/** The string formats the schema subset checks (frozen). */
export const STRING_FORMATS = Object.freeze(["date", "date-time", "time", "email", "uri", "uuid", "phone"] as const) satisfies readonly StringFormat[];
/** Keywords the subset allows and never checks, whatever their value (frozen). */
export const SCHEMA_ANNOTATIONS = Object.freeze(["title", "description", "examples", "default", "$comment"] as const) satisfies ReadonlyArray<keyof JsonSchema>;
/** The keywords the subset checks (frozen); a schema may hold these, the annotations and `x-*` keys, nothing else. */
export const SCHEMA_KEYWORDS = Object.freeze([
  "type",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "blob",
] as const) satisfies ReadonlyArray<keyof JsonSchema>;
const FORMATS = STRING_FORMATS;
const ANNOTATIONS = new Set<string>(SCHEMA_ANNOTATIONS);
const KEYWORDS = new Set<string>(SCHEMA_KEYWORDS);

/** Strings longer than this are never matched against a pattern. */
export const MAX_PATTERN_SUBJECT = 10_000;
/** Longest `pattern` the subset accepts. */
export const MAX_PATTERN_LENGTH = 256;
const MAX_SCHEMA_DEPTH = 32;
const MAX_ISSUES = 50;

/**
 * Checks a tenant-authored pattern: it must compile with the `u` flag, be at
 * most {@link MAX_PATTERN_LENGTH} characters, and fit the subset the
 * linear-time matcher runs (see `pattern.ts`): no backreferences, lookahead
 * or lookbehind, and at most `MAX_PATTERN_STATES` states once its
 * counts are expanded. Patterns never run on the backtracking engine, so no
 * shape is refused for being slow.
 */
export function checkPattern(pattern: string): string | null {
  const compiled = compiledPattern(pattern);
  return typeof compiled === "string" ? compiled : null;
}

const patternCache = new Map<string, CompiledPattern | string>();

function compiledPattern(pattern: string): CompiledPattern | string {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    compiled = compileChecked(pattern);
    if (patternCache.size > 500) patternCache.clear();
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

function compileChecked(pattern: string): CompiledPattern | string {
  if (pattern.length > MAX_PATTERN_LENGTH) return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  try {
    // Compiled to check its syntax, never run.
    new RegExp(pattern, "u");
  } catch (error) {
    return `pattern does not compile: ${(error as Error).message}`;
  }
  return compilePattern(pattern);
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Validates a schema document against the supported subset. */
export function checkSchema(schema: unknown, path: PathSegment[], bag: DiagnosticBag, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    bag.error("flow/schema-too-deep", path, `schema nesting is deeper than ${MAX_SCHEMA_DEPTH}`);
    return;
  }
  if (!isJsonObject(schema)) {
    bag.error("flow/schema-invalid", path, "schema must be an object");
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key) && !key.startsWith("x-")) {
      bag.error("flow/schema-unknown-keyword", [...path, key], `unsupported schema keyword "${key}"`);
    }
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0) bag.error("flow/schema-invalid", [...path, "type"], "type list is empty");
    for (const t of types) {
      if (typeof t !== "string" || !JSON_TYPES.includes(t as JsonType)) {
        bag.error("flow/schema-invalid", [...path, "type"], `unknown type ${JSON.stringify(t)}`);
      }
    }
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length === 0) bag.error("flow/schema-invalid", [...path, "enum"], "enum must be a non-empty array");
    else if (checkJson(s.enum)) bag.error("flow/schema-invalid", [...path, "enum"], "enum must contain JSON values");
  }
  if (s.const !== undefined && checkJson(s.const)) bag.error("flow/schema-invalid", [...path, "const"], "const must be a JSON value");
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (s[key] !== undefined && !isNonNegativeInt(s[key])) bag.error("flow/schema-invalid", [...path, key], `${key} must be a non-negative integer`);
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (s[key] !== undefined && (typeof s[key] !== "number" || !Number.isFinite(s[key]))) {
      bag.error("flow/schema-invalid", [...path, key], `${key} must be a finite number`);
    }
  }
  if (s.multipleOf !== undefined && (typeof s.multipleOf !== "number" || !(s.multipleOf > 0))) {
    bag.error("flow/schema-invalid", [...path, "multipleOf"], "multipleOf must be a positive number");
  }
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string") bag.error("flow/schema-invalid", [...path, "pattern"], "pattern must be a string");
    else {
      const problem = checkPattern(s.pattern);
      if (problem) bag.error("flow/schema-unsafe-pattern", [...path, "pattern"], problem);
    }
  }
  if (s.format !== undefined && (typeof s.format !== "string" || !FORMATS.includes(s.format as StringFormat))) {
    bag.error("flow/schema-invalid", [...path, "format"], `unsupported format ${JSON.stringify(s.format)}`);
  }
  if (s.uniqueItems !== undefined && typeof s.uniqueItems !== "boolean") {
    bag.error("flow/schema-invalid", [...path, "uniqueItems"], "uniqueItems must be a boolean");
  }
  if (s.properties !== undefined) {
    if (!isJsonObject(s.properties)) bag.error("flow/schema-invalid", [...path, "properties"], "properties must be an object");
    else for (const [name, sub] of Object.entries(s.properties)) checkSchema(sub, [...path, "properties", name], bag, depth + 1);
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string")) {
      bag.error("flow/schema-invalid", [...path, "required"], "required must be an array of strings");
    }
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
    checkSchema(s.additionalProperties, [...path, "additionalProperties"], bag, depth + 1);
  }
  if (s.items !== undefined) checkSchema(s.items, [...path, "items"], bag, depth + 1);
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) bag.error("flow/schema-invalid", [...path, "anyOf"], "anyOf must be a non-empty array");
    else s.anyOf.forEach((sub, i) => checkSchema(sub, [...path, "anyOf", i], bag, depth + 1));
  }
  if (s.blob !== undefined) {
    const problem = blobConstraintProblem(s.blob);
    if (problem) bag.error("flow/schema-invalid", [...path, "blob"], problem);
    // One obvious meaning: a reference, narrowed only by its own options.
    const beside = Object.keys(s).find((key) => key !== "blob" && KEYWORDS.has(key));
    if (beside !== undefined) bag.error("flow/schema-invalid", [...path, beside], `"${beside}" cannot sit beside "blob": a blob schema stands alone`);
  }
}

function typeOf(value: JsonValue): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value as "string" | "boolean" | "object";
}

function typeMatches(value: JsonValue, type: JsonType): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (any year, unlike Date.UTC for years below 100). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(?:\.(\d{1,9}))?(?:([Zz])|([+-])([01]\d|2[0-3]):([0-5]\d))$/;

/** Epoch ms of midnight UTC on a `date` string, or null when it is not one. */
export function dateMs(value: string): number | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidDate(y, mo, d) ? daysFromCivil(y, mo, d) * DAY_MS : null;
}

/** Epoch ms of a `date-time` string (RFC 3339: `T`, `t` or a space; `Z`, `z` or an offset), or null when it is not one. */
export function dateTimeMs(value: string): number | null {
  const m = DATE_TIME_RE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidDate(y, mo, d)) return null;
  const fraction = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0").slice(0, 3));
  const offsetMin = m[8] !== undefined ? 0 : (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11]));
  const time = ((Number(m[4]) * 60 + Number(m[5]) - offsetMin) * 60 + Number(m[6])) * 1000 + fraction;
  return daysFromCivil(y, mo, d) * DAY_MS + time;
}

/** A `date` or `date-time` string as epoch ms; the one parser behind those formats and the `ms` expression. */
export function timestampMs(value: string): number | null {
  return dateMs(value) ?? dateTimeMs(value);
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d|60)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/i;
const EMAIL_RE = /^[^\s@"(),:;<>[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/** True when `value` satisfies the string `format`. */
export function checkFormat(format: StringFormat, value: string): boolean {
  switch (format) {
    case "date":
      return dateMs(value) !== null;
    case "date-time":
      return dateTimeMs(value) !== null;
    case "time":
      return TIME_RE.test(value);
    case "email":
      return value.length <= 254 && EMAIL_RE.test(value);
    case "uri": {
      if (value.length > 2048) return false;
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" || url.protocol === "tel:";
      } catch {
        return false;
      }
    }
    case "uuid":
      return UUID_RE.test(value);
    case "phone":
      return PHONE_RE.test(value);
  }
}

function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/**
 * Pattern work one {@link validateValue} call may spend, across every value it
 * matches (see `patternMatches`): a few tens of milliseconds. An ordinary form
 * uses a small fraction; a value it runs out on is reported, not matched.
 */
export const MAX_PATTERN_WORK = 2_000_000;

/** Validates `value` against `schema`. Returns at most 50 issues. */
export function validateValue(schema: JsonSchema, value: JsonValue, path: PathSegment[] = []): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateInto(schema, value, path, issues, { left: MAX_PATTERN_WORK });
  return issues;
}

function push(issues: SchemaIssue[], path: PathSegment[], code: string, message: string): void {
  if (issues.length < MAX_ISSUES) issues.push({ path, code, message });
}

function validateInto(schema: JsonSchema, value: JsonValue, path: PathSegment[], issues: SchemaIssue[], budget: PatternBudget): void {
  if (issues.length >= MAX_ISSUES) return;
  if (schema.blob !== undefined) {
    const problem = blobValueProblem(schema.blob, value);
    if (problem) push(issues, path, "blob", problem);
    return;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((branch) => {
      const branchIssues: SchemaIssue[] = [];
      validateInto(branch, value, path, branchIssues, budget);
      return branchIssues.length === 0;
    });
    if (!ok) push(issues, path, "anyOf", "value does not match any allowed shape");
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      push(issues, path, "type", `expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) push(issues, path, "const", "value is not the allowed constant");
  if (schema.enum !== undefined && !schema.enum.some((option) => jsonEqual(option, value))) {
    push(issues, path, "enum", "value is not one of the allowed options");
  }
  if (typeof value === "string") {
    const length = codePointLength(value);
    if (schema.minLength !== undefined && length < schema.minLength) push(issues, path, "minLength", `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) push(issues, path, "maxLength", `must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined) {
      if (value.length > MAX_PATTERN_SUBJECT) push(issues, path, "pattern", "value is too long to check");
      else {
        // A schema stored before the subset narrowed is reported here, never run.
        const compiled = compiledPattern(schema.pattern);
        if (typeof compiled === "string") push(issues, path, "pattern", "pattern cannot be matched");
        else {
          const matched = patternMatches(compiled, value, budget);
          if (matched === null) push(issues, path, "pattern", "value is too costly to check against this pattern");
          else if (!matched) push(issues, path, "pattern", "value has the wrong shape");
        }
      }
    }
    if (schema.format !== undefined && !checkFormat(schema.format, value)) push(issues, path, "format", `must be a valid ${schema.format}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) push(issues, path, "minimum", `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) push(issues, path, "maximum", `must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) push(issues, path, "exclusiveMinimum", `must be more than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) push(issues, path, "exclusiveMaximum", `must be less than ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined) {
      const q = value / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) push(issues, path, "multipleOf", `must be a multiple of ${schema.multipleOf}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) push(issues, path, "minItems", `must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push(issues, path, "maxItems", `must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = canonicalJson(item);
        if (seen.has(key)) {
          push(issues, path, "uniqueItems", "items must be unique");
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items) value.forEach((item, i) => validateInto(schema.items!, item, [...path, i], issues, budget));
  }
  if (isJsonObject(value)) {
    for (const name of schema.required ?? []) {
      if (!hasOwn(value, name)) push(issues, [...path, name], "required", "is required");
    }
    for (const [name, item] of Object.entries(value)) {
      const propSchema = own(schema.properties, name);
      if (propSchema) validateInto(propSchema, item, [...path, name], issues, budget);
      else if (schema.additionalProperties === false) push(issues, [...path, name], "additionalProperties", "is not an allowed field");
      else if (isJsonObject(schema.additionalProperties)) validateInto(schema.additionalProperties, item, [...path, name], issues, budget);
    }
  }
}

// ---------------------------------------------------------------------------
// Assignability
// ---------------------------------------------------------------------------

function typeSet(schema: JsonSchema): Set<JsonType> | null {
  if (schema.const !== undefined) return new Set([typeOf(schema.const)]);
  if (schema.enum !== undefined) return new Set(schema.enum.map(typeOf));
  if (schema.type === undefined) return null;
  return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
}

function typeCovered(from: JsonType, to: Set<JsonType>): boolean {
  if (to.has(from)) return true;
  if (from === "integer" && to.has("number")) return true;
  return false;
}

/**
 * Conservative check that every value valid under `from` is also valid
 * under `to`. A `true` answer is reliable; some assignable pairs are
 * reported as not assignable (for example differing regex patterns).
 * Returns the reasons it could not prove assignability.
 */
export function assignabilityProblems(from: JsonSchema, to: JsonSchema, path: PathSegment[] = []): SchemaIssue[] {
  const problems: SchemaIssue[] = [];
  assign(from, to, path, problems, 0);
  return problems;
}

/** True when every value of `from` is provably a value of `to`. */
export function isAssignable(from: JsonSchema, to: JsonSchema): boolean {
  return assignabilityProblems(from, to).length === 0;
}

function assign(from: JsonSchema, to: JsonSchema, path: PathSegment[], out: SchemaIssue[], depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH || out.length >= MAX_ISSUES) return;
  if (from.anyOf) {
    for (const branch of from.anyOf) assign({ ...stripAnyOf(from), ...branch }, to, path, out, depth + 1);
    return;
  }
  if (to.anyOf) {
    const base = stripAnyOf(to);
    const ok = to.anyOf.some((branch) => assignabilityProblems(from, { ...base, ...branch }, path).length === 0);
    if (!ok) out.push({ path, code: "anyOf", message: "value does not fit any allowed shape on the receiving side" });
    return;
  }
  // A file reference: covered by another blob schema, or read as the reference's own shape.
  if (to.blob !== undefined) {
    const types = from.blob === undefined ? typeSet(from) : null;
    // A sending side that never sends an object never sends a reference: a type error, not a narrowing.
    if (types !== null && !types.has("object")) out.push({ path, code: "type", message: `sends ${[...types].join(" or ")}; receiving side expects a file reference` });
    else {
      const problem = from.blob === undefined ? "receiving side takes a file reference; sending side does not guarantee one" : blobConstraintCovers(from.blob, to.blob);
      if (problem) out.push({ path, code: "blob", message: problem });
    }
    return;
  }
  if (from.blob !== undefined) {
    assign(BLOB_REF_SCHEMA, to, path, out, depth + 1);
    return;
  }
  // Finite value sets are checked by validating each value.
  const finite = from.const !== undefined ? [from.const] : from.enum;
  if (finite !== undefined) {
    for (const value of finite) {
      if (validateValue(to, value, path).length > 0) {
        out.push({ path, code: "enum", message: `value ${canonicalJson(value)} is not accepted by the receiving side` });
      }
    }
    return;
  }
  if (to.const !== undefined || to.enum !== undefined) {
    out.push({ path, code: "enum", message: "receiving side accepts a fixed set of values; sending side is open" });
    return;
  }
  const toTypes = typeSet(to);
  const fromTypes = typeSet(from);
  if (toTypes) {
    if (!fromTypes) {
      out.push({ path, code: "type", message: `sending side is untyped; receiving side expects ${[...toTypes].join(" or ")}` });
      return;
    }
    for (const t of fromTypes) {
      if (!typeCovered(t, toTypes)) out.push({ path, code: "type", message: `sends ${t}; receiving side expects ${[...toTypes].join(" or ")}` });
    }
  }
  const lower = (key: "minLength" | "minItems" | "minimum") => {
    const want = to[key];
    if (want === undefined) return;
    const have = from[key];
    if (have === undefined || have < want) out.push({ path, code: key, message: `receiving side requires ${key} ${want}` });
  };
  const upper = (key: "maxLength" | "maxItems" | "maximum") => {
    const want = to[key];
    if (want === undefined) return;
    const have = from[key];
    if (have === undefined || have > want) out.push({ path, code: key, message: `receiving side requires ${key} ${want}` });
  };
  const may = (t: JsonType) => !fromTypes || fromTypes.has(t) || (t === "number" && fromTypes.has("integer"));
  if (may("string")) {
    lower("minLength");
    upper("maxLength");
    if (to.pattern !== undefined && from.pattern !== to.pattern) out.push({ path, code: "pattern", message: "receiving side requires a pattern the sending side does not guarantee" });
    if (to.format !== undefined && from.format !== to.format) out.push({ path, code: "format", message: `receiving side requires format ${to.format}` });
  }
  if (may("number") || may("integer")) {
    lower("minimum");
    upper("maximum");
    if (to.exclusiveMinimum !== undefined) {
      const ok =
        (from.exclusiveMinimum !== undefined && from.exclusiveMinimum >= to.exclusiveMinimum) ||
        (from.minimum !== undefined && from.minimum > to.exclusiveMinimum);
      if (!ok) out.push({ path, code: "exclusiveMinimum", message: `receiving side requires values above ${to.exclusiveMinimum}` });
    }
    if (to.exclusiveMaximum !== undefined) {
      const ok =
        (from.exclusiveMaximum !== undefined && from.exclusiveMaximum <= to.exclusiveMaximum) ||
        (from.maximum !== undefined && from.maximum < to.exclusiveMaximum);
      if (!ok) out.push({ path, code: "exclusiveMaximum", message: `receiving side requires values below ${to.exclusiveMaximum}` });
    }
    if (to.multipleOf !== undefined) {
      const ok = from.multipleOf !== undefined && Math.abs(from.multipleOf / to.multipleOf - Math.round(from.multipleOf / to.multipleOf)) < 1e-9;
      if (!ok) out.push({ path, code: "multipleOf", message: `receiving side requires multiples of ${to.multipleOf}` });
    }
  }
  if (may("array")) {
    lower("minItems");
    upper("maxItems");
    if (to.uniqueItems && !from.uniqueItems) out.push({ path, code: "uniqueItems", message: "receiving side requires unique items" });
    if (to.items) assign(from.items ?? {}, to.items, [...path, "items"], out, depth + 1);
  }
  if (may("object")) {
    const fromRequired = new Set(from.required ?? []);
    for (const name of to.required ?? []) {
      if (!fromRequired.has(name)) out.push({ path: [...path, name], code: "required", message: "receiving side requires this field; sending side may omit it" });
    }
    const toProps = to.properties ?? {};
    const fromProps = from.properties ?? {};
    for (const [name, toProp] of Object.entries(toProps)) {
      const fromProp = own(fromProps, name);
      if (fromProp) assign(fromProp, toProp, [...path, name], out, depth + 1);
      else if (from.additionalProperties === false) continue;
      else if (isJsonObject(from.additionalProperties)) assign(from.additionalProperties, toProp, [...path, name], out, depth + 1);
      else assign({}, toProp, [...path, name], out, depth + 1);
    }
    if (to.additionalProperties === false) {
      if (from.additionalProperties !== false) out.push({ path, code: "additionalProperties", message: "receiving side forbids extra fields; sending side allows them" });
      for (const name of Object.keys(fromProps)) {
        if (!hasOwn(toProps, name)) out.push({ path: [...path, name], code: "additionalProperties", message: "receiving side does not accept this field" });
      }
    } else if (isJsonObject(to.additionalProperties)) {
      for (const [name, fromProp] of Object.entries(fromProps)) {
        if (!hasOwn(toProps, name)) assign(fromProp, to.additionalProperties, [...path, name], out, depth + 1);
      }
      if (from.additionalProperties !== false) {
        assign(isJsonObject(from.additionalProperties) ? from.additionalProperties : {}, to.additionalProperties, [...path, "*"], out, depth + 1);
      }
    }
  }
}

function stripAnyOf(schema: JsonSchema): JsonSchema {
  const { anyOf: _anyOf, ...rest } = schema;
  return rest;
}

/** The schema of a value known only by its JSON type, for reporting. */
export function describeType(value: JsonValue): JsonType {
  return typeOf(value);
}
