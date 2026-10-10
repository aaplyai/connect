/**
 * Authoring helpers. Flows are plain JSON; these helpers only make that JSON
 * pleasant to write in TypeScript and validate it on the spot.
 *
 *   const flow = defineFlow({
 *     schemaVersion: 3, id: "contact", version: "1", title: "Contact us",
 *     facts: { email: { type: { type: "string", format: "email" } } },
 *     steps: [{ id: "ask", view: { section: "email-form@1" },
 *               on: { submit: { set: { email: e.payload("email") } } } }],
 *     completeWhen: e.known("email"),
 *   });
 */

import { deepFreeze } from "@aaply/action-contract/internal";
import { mustCompileFlow, type CompiledFlow } from "./compile.js";
import type { FlowDefinition } from "./definition.js";
import type { EnvName, Expr } from "./expr.js";
import type { JsonValue, PathSegment } from "./json.js";

/** Validates a definition and returns it unchanged; throws with diagnostics when invalid. */
export function defineFlow(definition: FlowDefinition): FlowDefinition {
  mustCompileFlow(definition);
  return definition;
}

/** Validates and compiles in one go. */
export function buildFlow(definition: FlowDefinition): CompiledFlow {
  return mustCompileFlow(definition);
}

const withPath = <K extends "fact" | "result">(key: K, name: string, path: PathSegment[]) =>
  (path.length > 0 ? { [key]: name, path } : { [key]: name }) as K extends "fact" ? { fact: string; path?: PathSegment[] } : { result: string; path?: PathSegment[] };

/** Expression builders. */
export const e = deepFreeze({
  lit: (value: JsonValue): Expr => ({ lit: value }),
  /** An expression in Facet's text syntax, e.g. e.x("fact.count >= 1 && fact.email | known"). */
  x: (text: string): Expr => ({ expr: text }),
  fact: (name: string, ...path: PathSegment[]): Expr => withPath("fact", name, path),
  result: (name: string, ...path: PathSegment[]): Expr => withPath("result", name, path),
  payload: (...path: PathSegment[]): Expr => ({ payload: path }),
  value: (...path: PathSegment[]): Expr => ({ value: path }),
  resource: (...path: PathSegment[]): Expr => ({ resource: path }),
  env: (name: EnvName): Expr => ({ env: name }),
  now: (): Expr => ({ now: true }),
  known: (fact: string): Expr => ({ known: fact }),
  failed: (action: string): Expr => ({ failed: action }),
  not: (a: Expr): Expr => ({ not: a }),
  and: (...items: Expr[]): Expr => ({ and: items }),
  or: (...items: Expr[]): Expr => ({ or: items }),
  eq: (a: Expr, b: Expr): Expr => ({ eq: [a, b] }),
  ne: (a: Expr, b: Expr): Expr => ({ ne: [a, b] }),
  lt: (a: Expr, b: Expr): Expr => ({ lt: [a, b] }),
  lte: (a: Expr, b: Expr): Expr => ({ lte: [a, b] }),
  gt: (a: Expr, b: Expr): Expr => ({ gt: [a, b] }),
  gte: (a: Expr, b: Expr): Expr => ({ gte: [a, b] }),
  in: (needle: Expr, haystack: Expr): Expr => ({ in: [needle, haystack] }),
  if: (condition: Expr, then: Expr, otherwise: Expr): Expr => ({ if: [condition, then, otherwise] }),
  coalesce: (...items: Expr[]): Expr => ({ coalesce: items }),
  len: (a: Expr): Expr => ({ len: a }),
  add: (...items: Expr[]): Expr => ({ add: items }),
  mul: (...items: Expr[]): Expr => ({ mul: items }),
  sub: (a: Expr, b: Expr): Expr => ({ sub: [a, b] }),
  div: (a: Expr, b: Expr): Expr => ({ div: [a, b] }),
  concat: (...items: Expr[]): Expr => ({ concat: items }),
  lower: (a: Expr): Expr => ({ lower: a }),
  trim: (a: Expr): Expr => ({ trim: a }),
  ms: (a: Expr): Expr => ({ ms: a }),
  obj: (entries: Record<string, Expr>): Expr => ({ obj: entries }),
  list: (...items: Expr[]): Expr => ({ list: items }),
  /** Each element of `list` through `each`, which reads the element with e.item(). */
  map: (list: Expr, each: Expr): Expr => ({ map: [list, each] }),
  /** The elements of `list` for which `test` is true. */
  filter: (list: Expr, test: Expr): Expr => ({ filter: [list, test] }),
  /** Whether `test` is true for some element. */
  some: (list: Expr, test: Expr): Expr => ({ some: [list, test] }),
  /** Whether `test` is true for every element. */
  every: (list: Expr, test: Expr): Expr => ({ every: [list, test] }),
  /** The total of a list of numbers; null if any item is not a number. */
  sum: (list: Expr): Expr => ({ sum: list }),
  /**
   * The current element inside map, filter, some or every, or a path into it.
   * Outside them, where an expression belongs to one item, that item's field.
   */
  item: (...path: PathSegment[]): Expr => ({ item: path }),
  /** A collection's rows as they stand, valid values only (views only). */
  items: (collection: string): Expr => ({ items: collection }),
  /** One field of every item of a settled collection: `map(fact.c, item.field)`. */
  each: (collection: string, field: string): Expr => ({ map: [{ fact: collection }, { item: [field] }] }),
  /** How many items a settled collection has. */
  count: (collection: string): Expr => ({ len: { fact: collection } }),
});
