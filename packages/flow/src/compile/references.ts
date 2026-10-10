/**
 * Checks every reference a compiled definition makes: to facts, results,
 * item fields and secrets, what each step fills, sets and runs, and that
 * everything read can be obtained.
 */

import { splitTemplate } from "../address.js";
import type { EndKind } from "../definition.js";
import type { Reads, Node, parseExpr } from "../expr.js";
import { type PathSegment, isJsonObject, hasOwn, jsonEqual } from "../json.js";
import { type ReplyViewKey, isReplyViewKey, REPLY_SCOPES, checkReplyScope } from "../reply.js";
import { secretTracer, secretSources } from "../secrets.js";
import type { CompileContext, FactsSection, ActionsSection, StepsSection, StepFaults } from "./context.js";
import { type CompiledView, type CompiledFact, type CompiledFlow, valueReads, compileView, type CompiledStep, quoted, CALL_END_RULES } from "../compile.js";

// --- references ----------------------------------------------------------

/** The checks every reference to a fact, a result, a field or a secret goes through, and what they gather. */
export interface ReferenceChecks {
  checkFact: (name: string, path: PathSegment[]) => boolean;
  checkResult: (name: string, path: PathSegment[]) => boolean;
  checkReads: (reads: Reads, path: PathSegment[], itemOf?: string) => void;
  checkSecrets: (view: CompiledView, path: PathSegment[], itemOf?: string, code?: string) => void;
  checkSecretSet: (target: string, node: Node, path: PathSegment[], itemOf?: string) => void;
  checkField: (target: string, path: PathSegment[], what: "set" | "decline" | "clear") => CompiledFact | null;
  /** Collections read anywhere as a list (a value, `known` or `needs`), which must then be settleable. */
  readCollections: Set<string>;
  tracer: ReturnType<typeof secretTracer>;
  /** Rules that add to (or replace) and that settle (or replace) each collection. */
  listAdders: Set<string>;
  listSettlers: Set<string>;
  filledBy: Map<string, string>;
  askedBy: CompiledFlow["askedBy"];
  runBy: Map<string, string>;
}

export function referenceChecks(cx: CompileContext, f: FactsSection, a: ActionsSection, s: StepsSection): ReferenceChecks {
  const { bag, plan, collections } = cx;
  const { facts, factOrField, declaredBroken } = f;
  const { actions, rawActions } = a;
  const { steps } = s;
  const checkFact = (name: string, path: PathSegment[]): boolean => {
    if (!facts.has(name)) {
      if (!declaredBroken(name)) bag.error("flow/unknown-fact", path, `unknown fact "${name}"`);
      return false;
    }
    return true;
  };
  const checkResult = (name: string, path: PathSegment[]): boolean => {
    if (!actions.has(name) && !(isJsonObject(rawActions) && hasOwn(rawActions, name))) {
      bag.error("flow/unknown-action", path, `unknown action "${name}"`);
      return false;
    }
    return true;
  };
  /** Collections read anywhere as a list (a value, `known` or `needs`), which must then be settleable. */
  const readCollections = new Set<string>();
  /** `itemOf`: the collection whose item the expression belongs to, if any. */
  const checkReads = (reads: Reads, path: PathSegment[], itemOf?: string) => {
    for (const f of reads.facts) {
      if (checkFact(f, path) && collections.has(f)) readCollections.add(f);
    }
    for (const r of reads.results) {
      if (!checkResult(r, path)) continue;
      // A per-item action has one result per item, read only inside that item.
      const of = plan.perItem.get(r);
      if (of !== undefined && of !== itemOf) bag.error("flow/item-result", path, `"${r}" runs once per item of "${of}", so its result can only be read inside one of those items`);
    }
  };
  // Views go to clients, so a secret's value must never be part of one, directly or through a derived fact.
  const tracer = secretTracer(factOrField, collections, secretSources(facts, collections, steps, actions));
  const { secretIn, secretInItems, secretRead, holds: holdsSecret } = tracer;
  const checkSecrets = (view: CompiledView, path: PathSegment[], itemOf?: string, code = "flow/secret-exposed") => {
    for (const [key, node] of view.input) {
      for (const f of valueReads(node)) {
        const source = secretIn(f);
        if (source === null) continue;
        const what = source === f ? `secret fact "${f}"` : `"${f}", which is derived from secret fact "${source}"`;
        bag.error(code, [...path, "input", key], `the view would show ${what}; secret values never reach a client`);
      }
      const field = secretInItems(node, itemOf);
      if (field !== null) bag.error(code, [...path, "input", key], `the view would show secret item field "${field}"; secret values never reach a client`);
      // An action's output a secret is set or derived from is the secret's value, wherever else it is read.
      const source = [...valueReads(node)].some((f) => secretIn(f) !== null) || field !== null ? null : secretRead(node, itemOf);
      if (source !== null) bag.error(code, [...path, "input", key], `the view would show "${source}", which a secret is set or derived from; secret values never reach a client`);
    }
  };
  // A rule copies a value into its target, so a secret it reads may only land in a secret fact or field.
  const checkSecretSet = (target: string, node: Node, path: PathSegment[], itemOf?: string) => {
    const source = secretRead(node, itemOf);
    if (source === null || holdsSecret(target)) return;
    bag.error("flow/secret-exposed", path, `the rule would copy secret "${source}" into "${target}", which is not secret; a secret's value only moves into a secret fact`);
  };
  /** Checks a `collection.field` target of a rule: the field exists, and is neither derived nor (for decline) required. */
  const checkField = (target: string, path: PathSegment[], what: "set" | "decline" | "clear"): CompiledFact | null => {
    const field = factOrField(target);
    if (!field) {
      if (!declaredBroken(target)) bag.error("flow/unknown-fact", path, `unknown item field "${target}"`);
      return null;
    }
    if (field.derive) bag.error("flow/derived-fact-set", path, `derived field "${target}" cannot be ${what === "set" ? "set" : what === "clear" ? "cleared" : "declined"}`);
    else if (what === "decline" && !field.def.optional) bag.error("flow/decline-required", path, `"${target}" is not optional, so it cannot be declined`);
    return field;
  };
  /** Rules that add to (or replace) and that settle (or replace) each collection. */
  const listAdders = new Set<string>();
  const listSettlers = new Set<string>();

  const filledBy = new Map<string, string>();
  const askedBy: CompiledFlow["askedBy"] = new Map();
  const runBy = new Map<string, string>();
  return { checkFact, checkResult, checkReads, checkSecrets, checkSecretSet, checkField, readCollections, tracer, listAdders, listSettlers, filledBy, askedBy, runBy };
}

/** Checks what facts, fields, actions, completeWhen and ends read, and the reply views and entry; returns the reply views. */
export function checkReferences(cx: CompileContext, f: FactsSection, a: ActionsSection, refs: ReferenceChecks, ends: Map<EndKind, CompiledView>, entry: Set<string>, completeParsed: ReturnType<typeof parseExpr> | null): Map<ReplyViewKey, CompiledView> {
  const { bag, raw, fieldReads } = cx;
  const { facts, factReads } = f;
  const { actions } = a;
  const { checkReads, checkFact, checkSecrets } = refs;
  for (const [name, reads] of factReads) checkReads(reads, facts.get(name)?.list ? ["collections", name, "dependsOn"] : ["facts", name]);
  for (const [template, reads] of fieldReads) {
    const t = splitTemplate(template)!;
    checkReads(reads, ["collections", t.collection, "fields", t.field], t.collection);
  }
  for (const action of actions.values()) checkReads(action.reads, ["actions", action.name, "input"], action.forEach);
  if (completeParsed) checkReads(completeParsed.reads, ["completeWhen"]);
  for (const [kind, v] of ends) checkReads(v.reads, ["ends", kind]);
  // Reply views: they read the reply as the payload, and non-secret facts.
  const replies = new Map<ReplyViewKey, CompiledView>();
  if (raw.replies !== undefined) {
    if (!isJsonObject(raw.replies)) bag.error("flow/invalid-shape", ["replies"], "replies must be an object of reply views");
    else
      for (const [kind, rawView] of Object.entries(raw.replies)) {
        if (kind.startsWith("x-")) continue;
        if (!isReplyViewKey(kind)) {
          bag.error("flow/reply-unknown-kind", ["replies", kind], `reply kinds are answer, nomatch, clarify, consent, suggest and default, not "${kind}"`);
          continue;
        }
        const v = compileView(cx, rawView, ["replies", kind], true, undefined, REPLY_SCOPES);
        if (!v) continue;
        checkReplyScope(v, ["replies", kind], bag, true);
        for (const f of v.reads.facts) checkFact(f, ["replies", kind]);
        checkSecrets(v, ["replies", kind], undefined, "flow/reply-reads-secret");
        replies.set(kind, v);
      }
  }
  for (const f of entry) {
    if (f.includes(".")) bag.error("flow/item-target", ["entry"], `"${f}" is a field of an item; list the collection in entry to start with items`);
    else if (checkFact(f, ["entry"]) && facts.get(f)!.derive) bag.error("flow/derived-fact-set", ["entry"], `derived fact "${f}" cannot be supplied`);
  }
  return replies;
}

/** Checks one step's references: what it reads, fills, sets and runs, and what its shape allows. */
export function checkStepReferences(cx: CompileContext, f: FactsSection, a: ActionsSection, s: StepsSection, refs: ReferenceChecks, step: CompiledStep): void {
  const { collections } = cx;
  const { stepFaults, stepFillReads } = s;
  const { checkReads, checkFact, checkSecrets, readCollections } = refs;
  const path: PathSegment[] = ["steps", step.index];
  const faults = stepFaults.get(step.id)!;
  const ruleFaulty = (name: string) => faults.rules === "all" || faults.rules.has(name);
  const reads = stepFillReads.get(step.id)!;
  // Needs and a call's input are checked where they are written, so each unknown name is reported once.
  const elsewhere = new Set([...step.needs, ...(step.call?.reads.facts ?? [])]);
  checkReads({ ...reads, facts: new Set([...reads.facts].filter((f) => !elsewhere.has(f))) }, path, step.forEach);
  if (step.view) checkReads(step.view.reads, [...path, "view"], step.forEach);
  for (const n of step.needs) if (!n.includes(".") && checkFact(n, [...path, "needs"]) && collections.has(n)) readCollections.add(n);
  checkStepFills(cx, f, refs, step, path, faults);
  checkStepRules(cx, f, refs, step, path);
  checkStepRun(cx, a, refs, step, path, faults);
  checkStepShape(cx, refs, step, path, faults, ruleFaulty);
  if (step.view) checkSecrets(step.view, [...path, "view"], step.forEach);
  markAsked(f, s, refs, step);
}

export function checkStepFills(cx: CompileContext, f: FactsSection, refs: ReferenceChecks, step: CompiledStep, path: PathSegment[], faults: StepFaults): void {
  const { bag } = cx;
  const { facts, factOrField, declaredBroken } = f;
  const { checkFact } = refs;
  // Fills inferred from the rules name only what the rules set, and each rule's target is checked there.
  const inferred = step.def.fills === undefined;
  for (const f of step.fills) {
    if (f.includes(".")) {
      // A per-item step answers for its own item's fields; no other step can.
      const t = splitTemplate(f);
      if (step.forEach === undefined || t?.collection !== step.forEach) {
        bag.error(step.forEach === undefined ? "flow/item-target" : "flow/foreach-invalid", [...path, "fills"], `"${f}" is a field of an item; only a step that runs once per item of its collection fills it`);
        continue;
      }
      if (!factOrField(f)) {
        if (!inferred && !declaredBroken(f)) bag.error("flow/unknown-fact", [...path, "fills"], `unknown item field "${f}"`);
        continue;
      }
    } else if (inferred && !facts.has(f)) continue;
    else if (!checkFact(f, [...path, "fills"])) continue;
    else if (step.forEach !== undefined) {
      bag.error("flow/foreach-invalid", [...path, "fills"], `a step that runs once per item fills only its item's fields, not "${f}"`);
      continue;
    }
    const settable = [...step.rules.values()].some((r) => r.set.some(([t]) => t === f) || r.decline.includes(f) || r.settle.includes(f));
    if (!settable && !faults.fills) bag.error("flow/fill-not-set", [...path, "fills"], `no rule in this step sets "${f}"`);
  }
}

export function checkStepRules(cx: CompileContext, f: FactsSection, refs: ReferenceChecks, step: CompiledStep, path: PathSegment[]): void {
  const { bag } = cx;
  const { facts } = f;
  const { checkField, checkFact, checkSecretSet, filledBy, listAdders, listSettlers } = refs;
  for (const rule of step.rules.values()) {
    const rpath: PathSegment[] = [...path, "on", rule.name];
    for (const [target, node] of rule.set) {
      if (target.includes(".")) {
        const field = checkField(target, [...rpath, "set", target], "set");
        if (field && !filledBy.has(target)) filledBy.set(target, step.id);
        if (field && !field.derive) checkSecretSet(target, node, [...rpath, "set", target], step.forEach ?? rule.addresses);
        continue;
      }
      if (!checkFact(target, [...rpath, "set", target])) continue;
      const fact = facts.get(target)!;
      if (fact.derive) bag.error("flow/derived-fact-set", [...rpath, "set", target], `derived fact "${target}" cannot be set`);
      else checkSecretSet(target, node, [...rpath, "set", target], step.forEach ?? rule.addresses);
      if (!filledBy.has(target)) filledBy.set(target, step.id);
      if (fact.list) {
        listAdders.add(target);
        listSettlers.add(target);
      }
    }
    for (const d of rule.decline) {
      if (d.includes(".")) checkField(d, [...rpath, "decline"], "decline");
      else if (checkFact(d, [...rpath, "decline"]) && !facts.get(d)!.def.optional) bag.error("flow/decline-required", [...rpath, "decline"], `"${d}" is not optional, so it cannot be declined`);
    }
    for (const c of rule.clear) {
      if (c.includes(".")) checkField(c, [...rpath, "clear"], "clear");
      else if (checkFact(c, [...rpath, "clear"]) && facts.get(c)!.derive) bag.error("flow/derived-fact-set", [...rpath, "clear"], `derived fact "${c}" cannot be cleared`);
    }
    for (const c of rule.settle) {
      listSettlers.add(c);
      if (!filledBy.has(c)) filledBy.set(c, step.id);
    }
    if (rule.add !== undefined) {
      listAdders.add(rule.add);
      if (!filledBy.has(rule.add)) filledBy.set(rule.add, step.id);
    }
    if ((rule.confirm || rule.retry) && step.run === undefined && !(rule.retry && !rule.confirm && step.call)) {
      bag.error("flow/rule-needs-run", rpath, `${rule.confirm ? "confirm" : "retry"} only applies in a step that runs an action${rule.confirm ? "" : " or calls a flow"}`);
    }
  }
}

export function checkStepRun(cx: CompileContext, a: ActionsSection, refs: ReferenceChecks, step: CompiledStep, path: PathSegment[], faults: StepFaults): void {
  const { bag } = cx;
  const { actions } = a;
  const { checkResult, runBy } = refs;
  if (step.run !== undefined) {
    if (checkResult(step.run, [...path, "run"])) {
      const prior = runBy.get(step.run);
      if (prior) bag.error("flow/action-run-twice", [...path, "run"], `action "${step.run}" is already run by step "${prior}"`);
      else runBy.set(step.run, step.id);
      const action = actions.get(step.run);
      if (action) {
        action.stepId = step.id;
        if (action.risk !== "none") {
          const confirmable = [...step.rules.values()].some((r) => r.confirm);
          const unknown = faults.view || faults.rules === "all" || faults.rules.size > 0;
          if ((!confirmable || !step.view) && !unknown) bag.error("flow/confirm-missing", [...path], `action "${step.run}" needs review, so this step needs a view and a rule with confirm: true`);
        }
        // Only an approver may answer an approval step, never the run's own person.
        if (action.risk === "approval" && action.approvalRoles.length > 0) {
          if (!step.actor) step.actor = { roles: [...action.approvalRoles], notSubject: true };
          else if (!step.actor.roles.some((r) => action.approvalRoles.includes(r))) {
            bag.error("flow/approval-actor", [...path, "actor"], `"${step.run}" is approved by ${quoted(action.approvalRoles)}, but this step's actor names none of those roles`);
          }
        }
      }
    }
  }
}

export function checkStepShape(cx: CompileContext, refs: ReferenceChecks, step: CompiledStep, path: PathSegment[], faults: StepFaults, ruleFaulty: (name: string) => boolean): void {
  const { bag } = cx;
  const { checkReads } = refs;
  if (faults.shape) {
    // A wait or call that did not compile: what its rules answer, and what the step fills, cannot be told.
  } else if (step.wait) {
    if (!step.view && !faults.view) {
      for (const name of step.rules.keys()) {
        if (name !== step.wait.event && name !== "timeout") bag.error("flow/wait-rules", [...path, "on", name], `a wait step without a view only has rules for "${step.wait.event}" and "timeout"`);
      }
    }
    if (!step.rules.has(step.wait.event) && !ruleFaulty(step.wait.event)) bag.error("flow/wait-rules", [...path, "on"], `a wait step needs a rule for "${step.wait.event}"`);
    if (step.fills.length === 0 && !faults.fills) bag.error("flow/step-never-completes", path, "a wait step must fill at least one fact");
  } else if (step.call) {
    checkReads(step.call.reads, [...path, "call", "input"]);
    if (!step.rules.has("completed") && !ruleFaulty("completed")) bag.error("flow/call-rules", [...path, "on"], 'a call step needs a rule for "completed" that maps the child\'s output');
    if (!step.view && !faults.view) {
      for (const name of step.rules.keys()) {
        if (!CALL_END_RULES.has(name)) bag.error("flow/call-rules", [...path, "on", name], `a call step without a view only has rules for ${quoted(CALL_END_RULES)}`);
      }
    }
    const unhandled = ["failed", "expired", ...(step.call.timeoutMs !== undefined ? ["timeout"] : [])].filter((n) => !step.rules.has(n));
    const retryable = step.view !== undefined && [...step.rules.values()].some((r) => r.retry && !CALL_END_RULES.has(r.name));
    if (unhandled.length > 0 && !retryable && !faults.view && !faults.fills) {
      bag.warn("flow/call-unhandled-end", [...path, "on"], `nothing answers a child that ends ${unhandled.join(" or ")}, so the run would stop at this step; add rules for them or a view with a retry rule`);
    }
  } else if (step.rules.size > 0 && !step.view && !faults.view) {
    bag.error("flow/rules-without-view", [...path, "on"], "rules need a view (or a wait) that can produce outputs");
  }
  // A wait step has its own (above).
  if (step.fills.length === 0 && step.run === undefined && !step.wait && !faults.fills && !faults.shape) {
    bag.error("flow/step-never-completes", path, "the step neither fills a fact nor runs an action, so it can never finish");
  }
}

/** Marks what a person may give at a step: facts its view's rules take from the output alone, and lists they change. */
export function markAsked(f: FactsSection, s: StepsSection, refs: ReferenceChecks, step: CompiledStep): void {
  const { facts, factOrField } = f;
  const { stepPersonSets, stepListAsks } = s;
  const { askedBy } = refs;
  // A person may give a fact directly only where a view's rule takes it from the output alone,
  // and only a value that rule could set.
  for (const [target, r, node] of stepPersonSets.get(step.id) ?? []) {
    const fact = factOrField(target);
    if (!fact || fact.derive || r.facts.size > 0 || r.results.size > 0 || (r.self?.size ?? 0) > 0) continue;
    fact.userFillable = true;
    const asks = askedBy.get(target) ?? [];
    let ask = asks.find((a) => a.stepId === step.id);
    if (!ask) {
      ask = { stepId: step.id, values: [] };
      asks.push(ask);
      askedBy.set(target, asks);
    }
    if (node.k !== "lit") ask.values = null;
    else if (ask.values && !ask.values.some((v) => jsonEqual(v, node.v))) ask.values.push(node.v);
  }
  // Adding to, removing from or settling a list is asked at the view steps whose rules do it.
  for (const c of stepListAsks.get(step.id) ?? []) {
    const fact = facts.get(c);
    if (!fact?.list) continue;
    fact.userFillable = true;
    const asks = askedBy.get(c) ?? [];
    const ask = asks.find((a) => a.stepId === step.id);
    if (ask) ask.values = null;
    else askedBy.set(c, [...asks, { stepId: step.id, values: null }]);
  }
}

/** Checks that every fact read can be obtained and every list given and settled, and that every action runs. */
export function checkObtainable(cx: CompileContext, f: FactsSection, a: ActionsSection, refs: ReferenceChecks, ends: Map<EndKind, CompiledView>, entry: Set<string>, iface: { input: string[] } | undefined): void {
  const { bag, collections, mayFill } = cx;
  const { facts } = f;
  const { actions } = a;
  const { checkSecrets, filledBy, listAdders, listSettlers, readCollections } = refs;
  for (const [kind, v] of ends) checkSecrets(v, ["ends", kind]);
  for (const f of entry) {
    const fact = facts.get(f);
    if (fact && !fact.derive) fact.userFillable = true;
    // A list given at the start comes with its items' fields.
    if (fact?.list) for (const field of fact.list.fields.values()) if (!field.derive) field.userFillable = true;
  }
  for (const action of actions.values()) {
    if (!action.stepId) bag.warn("flow/unused-action", ["actions", action.name], `action "${action.name}" is never run`);
  }

  // Every fact that is read must be obtainable (unless a rule or step that did not compile may set it).
  const mayBeFilled = (name: string) => cx.mayFillAny || mayFill.has(name);
  for (const fact of facts.values()) {
    if (fact.list || mayBeFilled(fact.name)) continue;
    const obtainable = fact.derive !== undefined || filledBy.has(fact.name) || entry.has(fact.name) || iface?.input.includes(fact.name) === true;
    if (!obtainable) bag.error("flow/unfillable-fact", ["facts", fact.name], `nothing fills "${fact.name}": add it to a step's rules, to entry, or derive it`);
  }
  // A list needs a way to get items, and, when it is read as a list, a way to be settled; every field a way to be given.
  for (const collection of collections.values()) {
    const path: PathSegment[] = ["collections", collection.name];
    const given = entry.has(collection.name) || mayBeFilled(collection.name);
    if (!given && !listAdders.has(collection.name)) bag.error("flow/unfillable-fact", path, `nothing adds items to "${collection.name}": add a rule with "add", one that sets the whole list, or list it in entry`);
    else if (!given && readCollections.has(collection.name) && !listSettlers.has(collection.name)) {
      bag.error("flow/unfillable-fact", path, `"${collection.name}" is read as a list, so something must settle it: a rule with "settle", one that sets the whole list, or entry`);
    }
    for (const field of collection.fields.values()) {
      if (!given && !field.derive && !filledBy.has(field.name) && !mayBeFilled(field.name)) bag.error("flow/unfillable-fact", [...path, "fields", field.field!], `nothing sets "${field.name}": set it in a rule that acts on an item, or derive it`);
    }
  }
}
