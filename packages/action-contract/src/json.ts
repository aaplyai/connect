/**
 * Plain JSON values and the helpers the engine needs to treat them safely:
 * canonical serialisation (stable key order, used for digests and
 * fingerprints), structural equality, cloning and size checks.
 *
 * Everything that crosses an engine boundary (facts, action input and
 * output, view input, events) is plain JSON. Values that are not plain JSON
 * (functions, `undefined`, `NaN`, class instances, cycles, `__proto__` keys)
 * are rejected at the boundary instead of being coerced.
 */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;
/** Any plain JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
/** A plain JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** One step of a path into a JSON value: an object key or an array index. */
export type PathSegment = string | number;

/** Hard ceiling on nesting so hostile input cannot exhaust the stack. */
export const MAX_JSON_DEPTH = 64;

/** True for a plain object (prototype `Object.prototype` or `null`), not an array or class instance. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Own-property lookup that never reaches the prototype chain. */
export function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Own-property test that never reaches the prototype chain. */
export function hasOwn(record: object | undefined, key: string): boolean {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
}

/** Where and why a value is not plain JSON. */
export interface JsonCheckIssue {
  path: PathSegment[];
  message: string;
}

/**
 * Checks that `value` is plain JSON: finite numbers, plain objects, arrays,
 * no cycles, no `__proto__` keys and nesting within {@link MAX_JSON_DEPTH}.
 * Returns the first problem found, or `null`.
 */
export function checkJson(value: unknown, maxDepth = MAX_JSON_DEPTH): JsonCheckIssue | null {
  // Objects on the current path (cycles), and the height of every subtree
  // already checked, so a value shared in many places is walked only once.
  const active = new Set<object>();
  const heights = new Map<object, number>();
  const walk = (v: unknown, path: PathSegment[], depth: number): JsonCheckIssue | number => {
    if (depth > maxDepth) return { path, message: `nesting deeper than ${maxDepth}` };
    if (v === null) return 0;
    switch (typeof v) {
      case "string":
      case "boolean":
        return 0;
      case "number":
        return Number.isFinite(v) ? 0 : { path, message: "number is not finite" };
      case "object": {
        const known = heights.get(v);
        if (known !== undefined) return depth + known > maxDepth ? { path, message: `nesting deeper than ${maxDepth}` } : known;
        if (active.has(v)) return { path, message: "value contains a cycle" };
        active.add(v);
        let height = 0;
        const child = (c: unknown, key: PathSegment): JsonCheckIssue | null => {
          const r = walk(c, [...path, key], depth + 1);
          if (typeof r !== "number") return r;
          height = Math.max(height, r + 1);
          return null;
        };
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            const issue = child(v[i], i);
            if (issue) return issue;
          }
        } else {
          if (!isJsonObject(v)) return { path, message: "value is not a plain object" };
          for (const key of Object.keys(v)) {
            if (key === "__proto__") return { path: [...path, key], message: "key __proto__ is not allowed" };
            const issue = child(v[key], key);
            if (issue) return issue;
          }
        }
        active.delete(v);
        heights.set(v, height);
        return height;
      }
      default:
        return { path, message: `${typeof v} is not a JSON value` };
    }
  };
  const result = walk(value, [], 0);
  return typeof result === "number" ? null : result;
}

/** True when {@link checkJson} finds no problem. */
export function isJsonValue(value: unknown): value is JsonValue {
  return checkJson(value) === null;
}

/**
 * Serialises with object keys sorted by UTF-16 code unit order and no
 * whitespace. Two values are structurally equal exactly when their canonical
 * forms are equal. Object properties whose value is `undefined` are skipped,
 * matching `JSON.stringify`.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      // JSON.stringify(-0) is "0", so -0 and 0 canonicalise identically.
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Structural equality of two JSON values; `undefined` equals only `undefined`. */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === b) return true;
  // Two different strings, or a string and anything else, never write out the same; nor do
  // a list or object and a value that is neither. Neither is written out to find that.
  if (typeof a === "string" || typeof b === "string") return false;
  if ((typeof a === "object" && a !== null) !== (typeof b === "object" && b !== null)) return false;
  return canonicalJson(a) === canonicalJson(b);
}

/** Deep copy of a JSON value. Keys are copied with define semantics. */
export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const item = (value as JsonObject)[key];
    if (item === undefined) continue;
    Object.defineProperty(out, key, { value: cloneJson(item), enumerable: true, writable: true, configurable: true });
  }
  return out as T;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** UTF-8 byte length of the canonical form. */
export function jsonByteLength(value: JsonValue): number {
  return utf8Length(canonicalJson(value));
}

/**
 * Reads `path` inside `value`. Missing keys, out-of-range indexes and paths
 * through primitives all yield `null`, so expressions stay total.
 */
export function getPath(value: JsonValue, path: readonly PathSegment[]): JsonValue {
  let current: JsonValue = value;
  for (const seg of path) {
    if (current === null || typeof current !== "object") return null;
    if (Array.isArray(current)) {
      if (typeof seg !== "number" || !Number.isInteger(seg) || seg < 0 || seg >= current.length) return null;
      current = current[seg] ?? null;
    } else {
      if (typeof seg !== "string") return null;
      const next = own(current, seg);
      if (next === undefined) return null;
      current = next;
    }
  }
  return current;
}

/** Formats a path for messages (`a.b[2]["odd key"]`, or `(root)`). */
export function formatPath(path: readonly PathSegment[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out === "" ? "(root)" : out;
}

/**
 * The RFC 6901 JSON Pointer for a path (`/steps/2/run`); `""` is the whole
 * document. A `~` in a key is written `~0` and a `/` is written `~1`.
 */
export function jsonPointer(path: readonly PathSegment[]): string {
  let out = "";
  for (const seg of path) out += `/${String(seg).replace(/~/g, "~0").replace(/\//g, "~1")}`;
  return out;
}
