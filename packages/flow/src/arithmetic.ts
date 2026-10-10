/**
 * Arithmetic that reaches a write: `flow/arithmetic-into-write`, a warning.
 *
 * Expressions have `add`, `sub`, `mul`, `div` and `sum` for counts and
 * comparisons. An amount a write sends (a price, a total, a refund) is the
 * host's to compute: binary floating point cannot hold most decimal amounts,
 * and the flow's arithmetic is not the business's pricing. So when a write's
 * input, its undo's, or a call step's input (which the child flow may send
 * on) takes its value from arithmetic, directly or through a fact (derived,
 * or set by a rule), an item field or a list's fields, the compiler says so
 * once per input key. Only value positions are followed: arithmetic in a
 * condition, a filter's or quantifier's predicate, a comparison or a count
 * decides which value is used, and never becomes it. It never refuses: a
 * count or an index may be what the author meant.
 */

import type { CompiledCall, CompiledFlow } from "./compile.js";
import type { DiagnosticBag } from "./diagnostics.js";
import { nodeChildren, type Node } from "./expr.js";
import type { PathSegment } from "./json.js";

const ARITHMETIC: ReadonlySet<string> = new Set(["add", "sub", "mul", "div", "sum"]);

/**
 * Operators whose value is a truth value or a count, never an operand's
 * value: arithmetic under them (`gt(sum(...), 100)`, `len(...)`) chooses,
 * it is not passed on.
 */
const NO_VALUE: ReadonlySet<string> = new Set(["not", "and", "or", "eq", "ne", "lt", "lte", "gt", "gte", "in", "len", "some", "every", "known", "failed"]);

/** The sub-expressions whose value can become `node`'s: an `if`'s branches, a `filter`'s list, every operand of the rest. */
function valueChildren(node: Node): Node[] {
  if (NO_VALUE.has(node.k)) return [];
  if (node.k === "if") return [node.t, node.e];
  if (node.k === "filter") return [node.a];
  return nodeChildren(node);
}

/** The fields of its element a `map`'s expression passes on (`item.<field>` in value positions), or `"*"` for the whole element. */
function elementFields(body: Node): Set<string> | "*" {
  const out = new Set<string>();
  let whole = false;
  const walk = (n: Node): void => {
    if (n.k === "item") {
      const field = n.path[0];
      if (typeof field !== "string") whole = true;
      else if (field !== "id") out.add(field);
      return;
    }
    // A nested map's own expression reads its own element; only its list can be ours.
    if (n.k === "map") return walk(n.a);
    for (const child of valueChildren(n)) walk(child);
  };
  walk(body);
  return whole ? "*" : out;
}

/** Where an expression's value comes from arithmetic: `"here"`, the fact or item field it was computed in, or null when it does not. */
type Source = string | null;

/** Warns, once per input key, where a write's input or its undo's is computed with arithmetic. */
export function checkArithmetic(flow: CompiledFlow, bag: DiagnosticBag): void {
  // Every expression that gives a fact, item field or whole list its value, with the item `self` reads in it.
  const givers = new Map<string, Array<{ node: Node; item: string | undefined }>>();
  const give = (target: string, node: Node, item: string | undefined) => {
    const list = givers.get(target) ?? [];
    list.push({ node, item });
    givers.set(target, list);
  };
  for (const fact of flow.facts.values()) if (fact.derive && fact.collection === undefined) give(fact.name, fact.derive, undefined);
  for (const collection of flow.collections.values()) for (const field of collection.fields.values()) if (field.derive) give(field.name, field.derive, collection.name);
  for (const step of flow.steps) for (const rule of step.rules.values()) for (const [target, node] of rule.set) give(target, node, rule.addresses ?? step.forEach);

  const memo = new Map<string, Source>();
  const visiting = new Set<string>();
  // Targets at which a walk met itself. Facts that depend on each other are refused before this
  // runs (`flow/dependency-cycle`), but a rule may set a fact from itself (a counter).
  const cuts: string[] = [];
  /** Whether `target` (a fact, a list, or `list.field`) is given a value computed with arithmetic, and where. */
  const computed = (target: string): Source => {
    const known = memo.get(target);
    if (known !== undefined) return known;
    if (visiting.has(target)) {
      cuts.push(target);
      return null;
    }
    visiting.add(target);
    const before = cuts.length;
    let found: Source = null;
    for (const { node, item } of givers.get(target) ?? []) {
      if (sourceOf(node, item) !== null) {
        found = target;
        break;
      }
    }
    visiting.delete(target);
    // A walk cut at `target` itself adds nothing; one cut further up may yet be a "yes", so a "no" is kept only without such cuts.
    const open = cuts.splice(before).filter((t) => t !== target);
    cuts.push(...open);
    if (found !== null || open.length === 0) memo.set(target, found);
    return found;
  };
  const sourceOf = (node: Node, item: string | undefined): Source => {
    if (ARITHMETIC.has(node.k)) return "here";
    if (node.k === "fact") {
      const whole = computed(node.name);
      if (whole !== null) return whole;
      const collection = flow.collections.get(node.name);
      if (collection && node.fields !== undefined) {
        const names = node.fields === "*" ? [...collection.fields.keys()] : node.fields;
        for (const field of names) {
          const found = computed(`${collection.name}.${field}`);
          if (found !== null) return found;
        }
      }
      return null;
    }
    if (node.k === "self") {
      const field = node.path[0];
      return item !== undefined && typeof field === "string" ? computed(`${item}.${field}`) : null;
    }
    if (node.k === "map") {
      // Over a list, filtered or not: only the fields the expression passes on, never those a filter tested.
      let list = node.a;
      while (list.k === "filter") list = list.a;
      const collection = list.k === "fact" && list.path.length === 0 ? flow.collections.get(list.name) : undefined;
      if (collection) {
        const whole = computed(collection.name);
        if (whole !== null) return whole;
        const fields = elementFields(node.b);
        for (const field of fields === "*" ? collection.fields.keys() : fields) {
          const found = computed(`${collection.name}.${field}`);
          if (found !== null) return found;
        }
        return sourceOf(node.b, item);
      }
    }
    for (const child of valueChildren(node)) {
      const found = sourceOf(child, item);
      if (found !== null) return found;
    }
    return null;
  };

  const check = (input: CompiledCall["input"], item: string | undefined, path: PathSegment[], write: string) => {
    for (const [key, node] of input) {
      const found = sourceOf(node, item);
      if (found === null) continue;
      const via = found === "here" ? "" : ` (through "${found}")`;
      bag.warn("flow/arithmetic-into-write", [...path, "input", key], `input "${key}" of ${write} is computed with arithmetic${via}; an amount a write sends is the host's to compute`);
    }
  };
  for (const action of flow.actions.values()) {
    if (action.def.effect !== "write") continue;
    check(action.call.input, action.forEach, ["actions", action.name], `write "${action.name}"`);
    if (action.compensate) check(action.compensate.input, action.forEach, ["actions", action.name, "compensate"], `the undo of "${action.name}"`);
  }
  // A child flow may send what it is given: its inputs are checked as a write's are.
  for (const step of flow.steps) {
    if (step.call) check(step.call.input, step.forEach, ["steps", step.index, "call"], `the call to "${step.call.flowId}@${step.call.version}"`);
  }
}
