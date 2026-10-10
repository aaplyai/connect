/**
 * Evaluation of the flow expression language (expr.ts): three-valued, total
 * and bounded. A read of something not yet known yields unknown, with what is
 * missing; work on lists and the size of built values are capped.
 */

import { type JsonValue, jsonEqual, canonicalJson, getPath, isJsonObject, type JsonObject } from "./json.js";
import { timestampMs } from "./schema.js";
import { type EnvName, type Cmp, type Node, nodeChildren, type ListOp } from "./expr.js";

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What a read of a fact or result produced; `missing` says what is not known yet, when it is more than the name read. */
export type Read = { known: true; value: JsonValue } | { known: false; missing?: Missing };

export interface EvalEnv {
  fact(name: string): Read;
  /** A collection read as `[{id, ...fields}]`, needing `fields` known on every item. */
  collection?(name: string, fields: readonly string[] | "*"): Read;
  /** A field (or `id`) of the item the expression belongs to. */
  self?(field: string): Read;
  /** A collection's rows as they stand (always known). */
  items?(name: string): JsonValue;
  /** True when the fact's value is known and valid. */
  isKnown(name: string): boolean;
  result(name: string): Read;
  /** True when the action's current result is a final failure. */
  isFailed(name: string): boolean;
  env(name: EnvName): JsonValue;
  now: number;
  payload?: JsonValue;
  value?: JsonValue;
  resource?: JsonValue;
}

/** A missing input that made an evaluation unknown. */
export interface Missing {
  facts: string[];
  results: string[];
}

export type Evaluated = { known: true; value: JsonValue } | { known: false; missing: Missing };

export const UNKNOWN_EMPTY: Missing = { facts: [], results: [] };

/**
 * Work one evaluation may spend on list operations: one unit per element and
 * per node evaluated for it, plus the data compared or built there (a unit per
 * 64 bytes). A list operation that would go past it gives null.
 */
export const MAX_LIST_WORK = 100_000;

/**
 * Largest value an expression builds: text from `concat` (in characters) and
 * lists and objects from `list`, `obj` and `map` (in approximate JSON bytes).
 * Anything larger evaluates to null.
 */
export const MAX_BUILT_SIZE = 1024 * 1024;

export function unknown(missing: Missing = UNKNOWN_EMPTY): Evaluated {
  return { known: false, missing };
}

export function val(value: JsonValue): Evaluated {
  return { known: true, value };
}

export function joinMissing(list: Missing[]): Missing {
  const facts = new Set<string>();
  const results = new Set<string>();
  for (const m of list) {
    for (const f of m.facts) facts.add(f);
    for (const r of m.results) results.add(r);
  }
  return { facts: [...facts], results: [...results] };
}

/** Falsy values are false, null, 0 and the empty string. */
export function truthy(value: JsonValue): boolean {
  return !(value === null || value === false || value === 0 || value === "");
}

export function compare(op: Cmp, a: JsonValue, b: JsonValue): boolean {
  if (op === "eq") return jsonEqual(a, b);
  if (op === "ne") return !jsonEqual(a, b);
  if (typeof a === "number" && typeof b === "number") {
    return op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : a >= b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : a >= b;
  }
  return false;
}

export function toMs(value: JsonValue): JsonValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" ? timestampMs(value) : null;
}

export function toText(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalJson(value);
}

export function finite(n: number): JsonValue {
  return Number.isFinite(n) ? n : null;
}

/** One evaluation's state: the elements list operations are visiting, the work spent and cached reads and sizes. */
export interface Ctx {
  env: EvalEnv;
  items: JsonValue[];
  work: number;
  reads: Map<string, Read | boolean>;
  sizes: WeakMap<object, number>;
}

/**
 * Approximate JSON size in bytes, counted up to just past `cap`. Containers
 * fully measured are remembered for the rest of the evaluation.
 */
export function sizeOf(value: JsonValue, c: Ctx, cap = MAX_BUILT_SIZE): number {
  if (value === null) return 4;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 5;
  const known = c.sizes.get(value);
  if (known !== undefined) return known;
  let n = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      n += sizeOf(item, c, cap - n) + 1;
      if (n > cap) return n;
    }
  } else {
    for (const key of Object.keys(value)) {
      n += key.length + 4 + sizeOf(value[key]!, c, cap - n);
      if (n > cap) return n;
    }
  }
  c.sizes.set(value, n);
  return n;
}

/** Charges data work while a list operation is running (outside lists, the node limit bounds evaluation). */
export function charge(c: Ctx, bytes: number): void {
  if (c.items.length > 0) c.work += bytes >> 6;
}

export function memo<T extends Read | boolean>(c: Ctx, key: string, read: () => T): T {
  const hit = c.reads.get(key);
  if (hit !== undefined) return hit as T;
  const r = read();
  c.reads.set(key, r);
  return r;
}

/** Evaluates a compiled expression. Never throws for well-formed nodes. */
export function evaluate(node: Node, env: EvalEnv): Evaluated {
  return ev(node, { env, items: [], work: 0, reads: new Map(), sizes: new WeakMap() });
}

export function ev(node: Node, c: Ctx): Evaluated {
  c.work++;
  const env = c.env;
  switch (node.k) {
    case "lit":
      return val(node.v);
    case "fact": {
      const fields = node.fields;
      if (fields !== undefined && env.collection) {
        const r = memo(c, `c:${node.name}:${fields === "*" ? "*" : fields.join(",")}`, () => env.collection!(node.name, fields));
        return r.known ? val(getPath(r.value, node.path)) : unknown(r.missing ?? { facts: [node.name], results: [] });
      }
      const r = memo(c, `f:${node.name}`, () => env.fact(node.name));
      return r.known ? val(getPath(r.value, node.path)) : unknown(r.missing ?? { facts: [node.name], results: [] });
    }
    case "self": {
      const field = String(node.path[0] ?? "");
      const r: Read = memo(c, `s:${field}`, () => (env.self ? env.self(field) : { known: false }));
      return r.known ? val(getPath(r.value, node.path.slice(1))) : unknown(r.missing ?? UNKNOWN_EMPTY);
    }
    case "items":
      return val(env.items ? env.items(node.name) : []);
    case "result": {
      const r = memo(c, `r:${node.name}`, () => env.result(node.name));
      return r.known ? val(getPath(r.value, node.path)) : unknown({ facts: [], results: [node.name] });
    }
    case "payload":
      return val(getPath(env.payload ?? null, node.path));
    case "value":
      return val(getPath(env.value ?? null, node.path));
    case "resource":
      return val(getPath(env.resource ?? null, node.path));
    case "item":
      return val(getPath(c.items[c.items.length - 1] ?? null, node.path));
    case "env":
      return val(env.env(node.name));
    case "now":
      return val(env.now);
    case "known":
      return val(memo(c, `k:${node.name}`, () => env.isKnown(node.name)));
    case "failed":
      return val(memo(c, `x:${node.name}`, () => env.isFailed(node.name)));
    case "not": {
      const a = ev(node.a, c);
      return a.known ? val(!truthy(a.value)) : a;
    }
    case "and":
    case "or": {
      const stop = node.k === "or";
      const missing: Missing[] = [];
      for (const item of node.items) {
        const r = ev(item, c);
        if (r.known) {
          if (truthy(r.value) === stop) return val(stop);
        } else missing.push(r.missing);
      }
      return missing.length > 0 ? unknown(joinMissing(missing)) : val(!stop);
    }
    case "if": {
      const cond = ev(node.c, c);
      if (!cond.known) return cond;
      return ev(truthy(cond.value) ? node.t : node.e, c);
    }
    case "coalesce": {
      // The first item that is known and not null; an unknown item counts as missing.
      const missing: Missing[] = [];
      for (const item of node.items) {
        const r = ev(item, c);
        if (!r.known) missing.push(r.missing);
        else if (r.value !== null) return r;
      }
      return missing.length > 0 ? unknown(joinMissing(missing)) : val(null);
    }
    case "map":
    case "filter":
    case "some":
    case "every":
      return evList(node, c);
    default:
      break;
  }
  // Strict operators: unknown if any operand is unknown.
  const operands = nodeChildren(node);
  const values: JsonValue[] = [];
  const missing: Missing[] = [];
  for (const operand of operands) {
    const r = ev(operand, c);
    if (r.known) values.push(r.value);
    else missing.push(r.missing);
  }
  if (missing.length > 0) return unknown(joinMissing(missing));
  const [a = null, b = null] = values;
  switch (node.k) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (c.items.length > 0) charge(c, sizeOf(a, c) + sizeOf(b, c));
      return val(compare(node.k, a, b));
    case "in": {
      if (Array.isArray(b)) {
        if (c.items.length > 0) charge(c, sizeOf(b, c) + sizeOf(a, c));
        if (a === null || typeof a !== "object") return val(b.includes(a));
        const key = canonicalJson(a);
        return val(b.some((item) => item !== null && typeof item === "object" && canonicalJson(item) === key));
      }
      if (typeof b === "string" && typeof a === "string") {
        charge(c, b.length);
        return val(b.includes(a));
      }
      return val(false);
    }
    case "len": {
      if (typeof a === "string") {
        charge(c, a.length * 4);
        return val([...a].length);
      }
      if (Array.isArray(a)) return val(a.length);
      if (isJsonObject(a)) {
        if (c.items.length > 0) charge(c, sizeOf(a, c));
        return val(Object.keys(a).length);
      }
      return val(null);
    }
    case "sum": {
      if (!Array.isArray(a)) return val(null);
      c.work += a.length;
      let total = 0;
      for (const n of a) {
        if (typeof n !== "number") return val(null);
        total += n;
      }
      return val(finite(total));
    }
    case "add":
    case "mul": {
      if (!values.every((v) => typeof v === "number")) return val(null);
      const nums = values as number[];
      return val(finite(node.k === "add" ? nums.reduce((x, y) => x + y, 0) : nums.reduce((x, y) => x * y, 1)));
    }
    case "sub":
    case "div": {
      if (typeof a !== "number" || typeof b !== "number") return val(null);
      if (node.k === "div" && b === 0) return val(null);
      return val(finite(node.k === "sub" ? a - b : a / b));
    }
    case "concat": {
      const parts: string[] = [];
      let length = 0;
      for (const v of values) {
        if (v !== null && typeof v === "object" && sizeOf(v, c) > MAX_BUILT_SIZE) return val(null);
        const text = toText(v);
        length += text.length;
        if (length > MAX_BUILT_SIZE) return val(null);
        parts.push(text);
      }
      charge(c, length);
      return val(parts.join(""));
    }
    case "lower":
      if (typeof a === "string") charge(c, a.length);
      return val(typeof a === "string" ? a.toLowerCase() : null);
    case "trim":
      if (typeof a === "string") charge(c, a.length);
      return val(typeof a === "string" ? a.trim() : null);
    case "ms":
      return val(toMs(a));
    case "list":
      return built(values, values, c);
    case "obj": {
      const out: JsonObject = {};
      node.entries.forEach(([key], i) => {
        Object.defineProperty(out, key, { value: values[i] ?? null, enumerable: true, writable: true, configurable: true });
      });
      return built(out, values, c);
    }
    default:
      return val(null);
  }
}

/** A list or object an expression built: null when it would be larger than {@link MAX_BUILT_SIZE}. */
export function built(value: JsonValue[] | JsonObject, parts: JsonValue[], c: Ctx): Evaluated {
  let size = 2;
  for (const part of parts) {
    size += sizeOf(part, c, MAX_BUILT_SIZE - size) + 8;
    if (size > MAX_BUILT_SIZE) return val(null);
  }
  c.sizes.set(value, size);
  return val(value);
}

export function evList(node: Extract<Node, { k: ListOp }>, c: Ctx): Evaluated {
  const list = ev(node.a, c);
  if (!list.known) return list;
  const test = node.k === "some" || node.k === "every";
  if (!Array.isArray(list.value)) return val(test ? false : null);
  const out: JsonValue[] = [];
  const missing: Missing[] = [];
  let size = 2;
  for (const element of list.value) {
    if (++c.work > MAX_LIST_WORK) return val(null);
    c.items.push(element);
    const r = ev(node.b, c);
    c.items.pop();
    if (c.work > MAX_LIST_WORK) return val(null);
    if (!r.known) {
      missing.push(r.missing);
      continue;
    }
    const yes = truthy(r.value);
    if (node.k === "some" && yes) return val(true);
    if (node.k === "every" && !yes) return val(false);
    if (node.k === "filter" && yes) out.push(element);
    if (node.k === "map") {
      const s = sizeOf(r.value, c, MAX_BUILT_SIZE - size);
      size += s + 1;
      c.work += s >> 6;
      if (size > MAX_BUILT_SIZE) return val(null);
      out.push(r.value);
    }
  }
  if (missing.length > 0) return unknown(joinMissing(missing));
  if (test) return val(node.k === "every");
  if (node.k === "map") c.sizes.set(out, size);
  return val(out);
}

/** Evaluates a map of named expressions into an object. */
export function evaluateRecord(nodes: ReadonlyArray<readonly [string, Node]>, env: EvalEnv): Evaluated {
  const out: JsonObject = {};
  const missing: Missing[] = [];
  for (const [key, node] of nodes) {
    const r = evaluate(node, env);
    if (r.known) Object.defineProperty(out, key, { value: r.value, enumerable: true, writable: true, configurable: true });
    else missing.push(r.missing);
  }
  return missing.length > 0 ? unknown(joinMissing(missing)) : { known: true, value: out };
}
