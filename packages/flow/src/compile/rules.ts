/**
 * Compiles a step's rules: what each sets, declines, clears, settles, adds
 * and removes, and which item it acts on.
 */

import { splitTemplate } from "../address.js";
import type { DiagnosticBag } from "../diagnostics.js";
import { keysOf } from "../definition-keys.js";
import { type Reads, type Node, parseExpr, type ExprScope, mergeReads } from "../expr.js";
import { type PathSegment, isJsonObject } from "../json.js";
import type { RuleContext } from "./context.js";
import { type CompiledRule, checkKeys, isStringArray } from "../compile.js";

export function compileRule(
  name: string,
  rawRule: unknown,
  path: PathSegment[],
  bag: DiagnosticBag,
  fillReads: Reads,
  ctx: RuleContext,
): { rule: CompiledRule; setReads: Array<[string, Reads, Node]>; broken: string[]; faulty: boolean; unknownTargets: boolean } | null {
  if (!isJsonObject(rawRule)) {
    bag.error("flow/invalid-shape", path, "rule must be an object");
    return null;
  }
  // Parts that failed their own check: the rule did something there, and what cannot be told.
  let faulty = 0;
  let unknownTargets = false;
  const broken: string[] = [];
  checkKeys(rawRule, keysOf("rule"), path, bag);
  const options = { collections: ctx.shapes, ...(ctx.forEach !== undefined ? { itemOf: ctx.forEach } : {}) };
  const set: [string, Node][] = [];
  const setReads: Array<[string, Reads, Node]> = [];
  if (rawRule.set !== undefined) {
    if (!isJsonObject(rawRule.set)) {
      bag.error("flow/invalid-shape", [...path, "set"], "set must map fact names to expressions");
      faulty++;
      unknownTargets = true;
    } else
      for (const [fact, expr] of Object.entries(rawRule.set)) {
        const parsed = parseExpr(expr, [...path, "set", fact], bag, { ...options, scopes: new Set<ExprScope>(["payload"]) });
        if (parsed) {
          set.push([fact, parsed.node]);
          setReads.push([fact, parsed.reads, parsed.node]);
          mergeReads(fillReads, parsed.reads);
        } else {
          faulty++;
          broken.push(fact);
        }
      }
  }
  const list = (key: "decline" | "clear" | "settle"): string[] => {
    const v = rawRule[key];
    if (v === undefined) return [];
    if (!isStringArray(v)) {
      bag.error("flow/invalid-field", [...path, key], `${key} must be a list of ${key === "settle" ? "collection" : "fact"} names`);
      faulty++;
      if (key === "settle") unknownTargets = true;
      return [];
    }
    return [...new Set(v)];
  };
  const flag = (key: "confirm" | "retry" | "cancel"): boolean => {
    const v = rawRule[key];
    if (v !== undefined && typeof v !== "boolean") {
      bag.error("flow/invalid-field", [...path, key], `${key} must be a boolean`);
      faulty++;
    }
    return v === true;
  };
  const collection = (key: "add" | "remove"): string | undefined => {
    const v = rawRule[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !ctx.shapes.has(v)) {
      bag.error("flow/unknown-fact", [...path, key], `${key} must name a collection`);
      faulty++;
      return undefined;
    }
    return v;
  };
  let item: Node | undefined;
  if (rawRule.item !== undefined) {
    // Which item, never what to write into it: read from the payload (or facts), never `item.` itself.
    const parsed = parseExpr(rawRule.item, [...path, "item"], bag, { collections: ctx.shapes, scopes: new Set<ExprScope>(["payload"]) });
    if (parsed) {
      item = parsed.node;
      mergeReads(fillReads, parsed.reads);
    } else faulty++;
  }
  const add = collection("add");
  const remove = collection("remove");
  const settle = list("settle");
  for (const c of settle) if (!ctx.shapes.has(c)) bag.error("flow/unknown-fact", [...path, "settle"], `settle names collections; "${c}" is not one`);
  const rule: CompiledRule = {
    name,
    set,
    confirm: flag("confirm"),
    decline: list("decline"),
    clear: list("clear"),
    retry: flag("retry"),
    cancel: flag("cancel"),
    ...(item ? { item } : {}),
    ...(add !== undefined ? { add } : {}),
    ...(remove !== undefined ? { remove } : {}),
    settle,
  };
  const does =
    rule.set.length + rule.decline.length + rule.clear.length + (rule.confirm ? 1 : 0) + (rule.retry ? 1 : 0) + (rule.cancel ? 1 : 0) + (add !== undefined ? 1 : 0) + (remove !== undefined ? 1 : 0) + settle.length;
  if (does + faulty === 0) bag.error("flow/rule-empty", path, "the rule does nothing");
  if (rule.cancel && does > 1) bag.error("flow/rule-cancel-alone", path, "cancel cannot be combined with other effects");
  if (ctx.shapes.size > 0 || rawRule.item !== undefined || rawRule.add !== undefined || rawRule.remove !== undefined) addressItem(rule, rawRule, path, bag, ctx);
  return { rule, setReads, broken, faulty: faulty > 0, unknownTargets };
}

/**
 * Works out which item a rule acts on and checks that it acts on at most one,
 * of one collection: its per-item step's own item, the item `add` creates, or
 * the one `item` names. Field targets (`collection.field`) and `remove` need
 * one; a whole-list `set` (reconcile) never mixes with one.
 */
export function addressItem(rule: CompiledRule, rawRule: Record<string, unknown>, path: PathSegment[], bag: DiagnosticBag, ctx: RuleContext): void {
  const touched = new Set<string>();
  const kinds: Array<{ target: string; key: "set" | "decline" | "clear"; kind: "field" | "list" | "fact"; collection?: string }> = [];
  const classify = (target: string, key: "set" | "decline" | "clear") => {
    const t = splitTemplate(target);
    if (t) {
      if (!ctx.shapes.has(t.collection)) {
        bag.error("flow/unknown-fact", [...path, key, ...(key === "set" ? [target] : [])], `"${target}" names no collection's field`);
        return;
      }
      touched.add(t.collection);
      kinds.push({ target, key, kind: "field", collection: t.collection });
    } else if (ctx.shapes.has(target)) kinds.push({ target, key, kind: "list", collection: target });
    else kinds.push({ target, key, kind: "fact" });
  };
  for (const [target] of rule.set) classify(target, "set");
  for (const d of rule.decline) classify(d, "decline");
  for (const c of rule.clear) classify(c, "clear");
  if (rule.add !== undefined) touched.add(rule.add);
  if (rule.remove !== undefined) touched.add(rule.remove);
  for (const k of kinds) {
    if (k.kind === "list" && k.key === "decline") bag.error("flow/decline-required", [...path, "decline"], `a list cannot be declined; settle "${k.target}" empty instead`);
  }
  if (ctx.forEach !== undefined) {
    const own = ctx.forEach;
    if (rawRule.item !== undefined || rule.add !== undefined) bag.error("flow/foreach-invalid", path, "a step that runs once per item acts on its own item: item and add are not allowed here");
    if (rule.settle.length > 0) bag.error("flow/foreach-invalid", [...path, "settle"], "a step that runs once per item cannot settle a list");
    if (rule.remove !== undefined && rule.remove !== own) bag.error("flow/foreach-invalid", [...path, "remove"], `this step's items are "${own}"'s`);
    for (const k of kinds) {
      if (k.kind !== "field" || k.collection !== own) {
        bag.error("flow/foreach-invalid", [...path, k.key, ...(k.key === "set" ? [k.target] : [])], `a step that runs once per item of "${own}" changes only that item's fields ("${own}.<field>"), not "${k.target}"`);
      }
    }
    rule.addresses = own;
    return;
  }
  if (touched.size > 1) bag.error("flow/item-target", path, `a rule acts on at most one item, of one collection; this one names ${[...touched].map((c) => `"${c}"`).join(", ")}`);
  if (rawRule.item !== undefined && rule.add !== undefined) bag.error("flow/item-target", path, "item and add both say which item the rule acts on; use one");
  if (rule.add !== undefined && rule.remove !== undefined) bag.error("flow/item-target", path, "a rule cannot add an item and remove one");
  if (touched.size === 1 && rawRule.item === undefined && rule.add === undefined) {
    bag.error("flow/item-target", path, `the rule changes an item of "${[...touched][0]}", so it needs "item" (or "add") to say which`);
  }
  if (rawRule.item !== undefined && touched.size === 0) bag.error("flow/item-target", [...path, "item"], "item names the item to act on, but the rule changes no item");
  for (const k of kinds) {
    if (k.kind === "list" && k.key === "set" && touched.has(k.target)) bag.error("flow/item-target", [...path, "set", k.target], `a rule either replaces the whole of "${k.target}" or acts on one of its items, not both`);
  }
  if (touched.size === 1) rule.addresses = [...touched][0]!;
}
