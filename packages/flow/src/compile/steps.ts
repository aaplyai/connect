/**
 * Compiles the steps: each step's needs, view, wait, call, rules, actor, run
 * and fills.
 */

import { splitTemplate } from "../address.js";
import { MAX_FOR_EACH_STEPS, MAX_FAN_OUT } from "../collections-compile.js";
import type { DiagnosticBag } from "../diagnostics.js";
import type { StepDef } from "../definition.js";
import { keysOf } from "../definition-keys.js";
import { type Reads, type Node, emptyReads, parseExpr, mergeReads, type ExprScope, type ParseOptions } from "../expr.js";
import { isJsonObject, hasOwn, type PathSegment, type JsonValue } from "../json.js";
import type { CompileContext, FactsSection, StepsSection, StepFaults } from "./context.js";
import { compileRule } from "./rules.js";
import { type CompiledStep, isStringArray, MAX_STEPS, checkKeys, NAME_RE, optionalString, positiveInt, type CompiledView, compileView, CALL_END_RULES, DEVICE_CAPABILITY_RE, EVENT_RE, DAY, type CompiledRule, MAX_RULES_PER_STEP, OUTPUT_RE, ROLE_RE, quoted, type CompiledCallStep, parseFlowRef } from "../compile.js";

// --- steps -------------------------------------------------------------

export function compileSteps(cx: CompileContext, f: FactsSection): StepsSection | null {
  const { bag, raw, mayFill } = cx;
  const steps: CompiledStep[] = [];
  const stepById = new Map<string, CompiledStep>();
  /** Reads the step's fills depend on: when, needs, rules, the wait's correlate and accept. */
  const stepFillReads = new Map<string, Reads>();
  /** Results the step's view shows: the choices offered, so a pick depends on them. */
  const stepShownResults = new Map<string, Set<string>>();
  /** Facts set by rules a view output (a person) triggers, with what each expression reads. */
  const stepPersonSets = new Map<string, Array<[string, Reads, Node]>>();
  /** Collections a view step's own rules add to, remove from or settle. */
  const stepListAsks = new Map<string, Set<string>>();
  const correlateReads = new Map<string, Reads>();
  /** What decides whether a call step's call is still wanted: its when, needs and input. */
  const callStartReads = new Map<string, Reads>();
  /** What a step's own faults leave unknown, so the checks that depend on it stay quiet (one fault, one diagnostic). */
  const stepFaults = new Map<string, StepFaults>();
  /** A step that is not compiled at all: what its rules would set, as far as can be told. */
  const brokenStep = (rawStep: unknown) => {
    if (!isJsonObject(rawStep) || hasOwn(rawStep, "include")) {
      cx.mayFillAny = true;
      return;
    }
    if (rawStep.on === undefined) return;
    if (!isJsonObject(rawStep.on)) {
      cx.mayFillAny = true;
      return;
    }
    for (const rawRule of Object.values(rawStep.on)) {
      if (!isJsonObject(rawRule) || (rawRule.set !== undefined && !isJsonObject(rawRule.set)) || (rawRule.settle !== undefined && !isStringArray(rawRule.settle))) {
        cx.mayFillAny = true;
        continue;
      }
      if (isJsonObject(rawRule.set)) for (const target of Object.keys(rawRule.set)) mayFill.add(target);
      if (typeof rawRule.add === "string") mayFill.add(rawRule.add);
      if (isStringArray(rawRule.settle)) for (const c of rawRule.settle) mayFill.add(c);
    }
  };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    bag.error("flow/invalid-shape", ["steps"], "steps must be a non-empty list");
    return null;
  }
  if (raw.steps.length > MAX_STEPS) bag.error("flow/too-large", ["steps"], `at most ${MAX_STEPS} steps`);
  const s: StepsSection = { steps, stepById, stepFillReads, stepShownResults, stepPersonSets, stepListAsks, correlateReads, callStartReads, stepFaults };
  raw.steps.forEach((rawStep, index) => compileStep(cx, f, s, brokenStep, rawStep, index));
  if (steps.filter((st) => st.forEach !== undefined).length > MAX_FOR_EACH_STEPS) bag.error("flow/too-large", ["steps"], `at most ${MAX_FOR_EACH_STEPS} steps run once per item`);
  return s;
}

/** One step: what it needs, shows, waits for, calls, runs and fills. */
export function compileStep(cx: CompileContext, f: FactsSection, s: StepsSection, brokenStep: (rawStep: unknown) => void, rawStep: unknown, index: number): void {
  const { bag, plan, shared } = cx;
  const { stepById, stepFaults, callStartReads, steps, stepFillReads, stepShownResults, stepPersonSets, stepListAsks } = s;
  const path: PathSegment[] = ["steps", index];
  if (!isJsonObject(rawStep)) {
    bag.error("flow/invalid-shape", path, "step must be an object");
    brokenStep(rawStep);
    return;
  }
  if (hasOwn(rawStep, "include")) {
    bag.error("flow/include-unexpanded", path, "an include is expanded at publish (expandFlow); a definition cannot contain one");
    brokenStep(rawStep);
    return;
  }
  checkKeys(rawStep, keysOf("step"), path, bag);
  const id = rawStep.id;
  if (typeof id !== "string" || !NAME_RE.test(id)) {
    bag.error("flow/invalid-name", [...path, "id"], "step ids are letters, digits and underscores, starting with a letter");
    brokenStep(rawStep);
    return;
  }
  if (stepById.has(id)) {
    bag.error("flow/duplicate-step", [...path, "id"], `step "${id}" is defined twice`);
    brokenStep(rawStep);
    return;
  }
  const faults: StepFaults = { rules: new Set(), fills: false, view: false, shape: false };
  stepFaults.set(id, faults);
  optionalString(rawStep, "title", path, bag, 200);
  let forEach: string | undefined;
  if (rawStep.forEach !== undefined) {
    if (typeof rawStep.forEach !== "string" || !plan.shapes.has(rawStep.forEach)) bag.error("flow/foreach-invalid", [...path, "forEach"], "forEach must name a collection");
    else forEach = rawStep.forEach;
    if (rawStep.wait !== undefined) bag.error("flow/foreach-invalid", [...path, "wait"], "a step that runs once per item cannot wait for an outside event");
  }
  let fanOut = 1;
  if (rawStep.fanOut !== undefined) {
    if (!positiveInt(rawStep.fanOut, MAX_FAN_OUT)) bag.error("flow/fan-out", [...path, "fanOut"], `fanOut is a whole number from 1 to ${MAX_FAN_OUT}`);
    else if (rawStep.forEach === undefined || rawStep.run === undefined || rawStep.view !== undefined) {
      bag.error("flow/fan-out", [...path, "fanOut"], "fanOut applies only to a per-item step (forEach) that runs an action and shows no view");
    } else fanOut = rawStep.fanOut;
  }
  /** Where the step's expressions belong to one item. */
  const inItem = { ...shared, ...(forEach !== undefined ? { itemOf: forEach } : {}) };
  const fillReads = emptyReads();
  const startReads = emptyReads();
  let when: Node | undefined;
  if (rawStep.when !== undefined) {
    const parsed = parseExpr(rawStep.when, [...path, "when"], bag, inItem);
    if (parsed) {
      when = parsed.node;
      mergeReads(fillReads, parsed.reads);
      mergeReads(startReads, parsed.reads);
    }
  }
  let needs: string[] = [];
  if (rawStep.needs !== undefined) {
    if (!isStringArray(rawStep.needs)) bag.error("flow/invalid-field", [...path, "needs"], "needs must be a list of fact names");
    else needs = [...new Set(rawStep.needs)];
  }
  for (const n of needs) {
    // `collection.field` in a per-item step: that field of the step's own item.
    const t = splitTemplate(n);
    if (!t) fillReads.facts.add(n);
    else if (t.collection === forEach && plan.shapes.get(forEach)?.has(t.field)) (fillReads.self ??= new Set()).add(t.field);
    else bag.error("flow/item-target", [...path, "needs"], `"${n}" is a field of an item; only a step that runs once per item of "${t.collection}" may need it`);
  }
  let view: CompiledView | undefined;
  const shown = new Set<string>();
  if (rawStep.view !== undefined) {
    const v = compileView(cx, rawStep.view, [...path, "view"], true, forEach);
    if (v) {
      view = v;
      for (const r of v.reads.results) shown.add(r);
    } else faults.view = true;
  }
  // A wait step may also show a view (such as "check your email"); its rules for the event and "timeout" stay the event's.
  const isWait = rawStep.wait !== undefined;
  const isCall = rawStep.call !== undefined;
  const waitEvent = isJsonObject(rawStep.wait) && typeof rawStep.wait.event === "string" ? rawStep.wait.event : undefined;
  // A call step's end rules, like a wait step's event rules, answer the outside world, not the view.
  const isEventRule = (name: string) => (isWait && (name === waitEvent || name === "timeout")) || (isCall && CALL_END_RULES.has(name));
  const wait = compileWait(cx, rawStep, path, id, faults, fillReads, s.correlateReads);
  const call = isCall ? compileCallStep(rawStep, path, bag, fillReads, inItem) : undefined;
  if (isCall && !call) faults.shape = true;
  if (call) {
    for (const n of needs) startReads.facts.add(n);
    callStartReads.set(id, mergeReads(startReads, call.reads));
  }
  const { rules, personSets, listAsks } = compileStepRules(cx, rawStep, path, faults, fillReads, forEach, view, isEventRule);
  const actor = compileActor(bag, rawStep, path);
  let deviceCapabilities: string[] = [];
  if (rawStep.deviceCapabilities !== undefined) {
    if (!isStringArray(rawStep.deviceCapabilities) || rawStep.deviceCapabilities.some((c) => !DEVICE_CAPABILITY_RE.test(c))) {
      bag.error("flow/invalid-capability", [...path, "deviceCapabilities"], 'device capabilities are names such as "device.camera"');
    } else deviceCapabilities = [...rawStep.deviceCapabilities];
    if (!view) bag.error("flow/invalid-capability", [...path, "deviceCapabilities"], "device capabilities need a view");
  }
  let run: string | undefined;
  if (rawStep.run !== undefined) {
    if (typeof rawStep.run !== "string") bag.error("flow/invalid-field", [...path, "run"], "run must name an action");
    else run = rawStep.run;
  }
  const fills = stepFills(bag, f, rawStep, path, forEach, rules, isCall, isWait, isEventRule);
  const step: CompiledStep = {
    index,
    id,
    def: rawStep as unknown as StepDef,
    ...(when ? { when } : {}),
    needs,
    fills,
    ...(view ? { view } : {}),
    rules,
    ...(run !== undefined ? { run } : {}),
    ...(wait ? { wait } : {}),
    ...(call ? { call } : {}),
    ...(actor ? { actor } : {}),
    deviceCapabilities,
    ...(forEach !== undefined ? { forEach } : {}),
    fanOut,
  };
  steps.push(step);
  stepById.set(id, step);
  stepFillReads.set(id, fillReads);
  stepShownResults.set(id, shown);
  stepPersonSets.set(id, personSets);
  stepListAsks.set(id, listAsks);
}

/** A wait step's `wait`: the event, its correlation key and what it accepts. */
export function compileWait(cx: CompileContext, rawStep: Record<string, JsonValue>, path: PathSegment[], id: string, faults: StepFaults, fillReads: Reads, correlateReads: Map<string, Reads>): CompiledStep["wait"] {
  const { bag, shared } = cx;
  let wait: CompiledStep["wait"];
  if (rawStep.wait !== undefined) {
    const w = rawStep.wait;
    if (!isJsonObject(w)) {
      bag.error("flow/invalid-shape", [...path, "wait"], "wait must be an object");
      faults.shape = true;
    } else {
      checkKeys(w, keysOf("wait"), [...path, "wait"], bag);
      if (typeof w.event !== "string" || !EVENT_RE.test(w.event)) {
        bag.error("flow/invalid-event", [...path, "wait", "event"], "event must be an event name such as payment.completed");
        faults.shape = true;
      }
      if (w.timeoutMs !== undefined && !positiveInt(w.timeoutMs, 366 * DAY)) bag.error("flow/invalid-field", [...path, "wait", "timeoutMs"], "timeoutMs must be a positive integer");
      const parsed = parseExpr(w.correlate, [...path, "wait", "correlate"], bag, { ...shared, allowNow: false });
      let accept: Node | undefined;
      if (w.accept !== undefined) {
        const a = parseExpr(w.accept, [...path, "wait", "accept"], bag, { ...shared, scopes: new Set<ExprScope>(["payload"]) });
        if (a) {
          accept = a.node;
          mergeReads(fillReads, a.reads);
        }
      }
      if (!parsed) faults.shape = true;
      else {
        mergeReads(fillReads, parsed.reads);
        correlateReads.set(String(id), parsed.reads);
        wait = {
          event: typeof w.event === "string" ? w.event : "",
          correlate: parsed.node,
          ...(typeof w.timeoutMs === "number" ? { timeoutMs: w.timeoutMs } : {}),
          ...(accept ? { accept } : {}),
        };
      }
    }
    if (rawStep.run !== undefined) bag.error("flow/wait-with-run", [...path, "wait"], "a wait step cannot also run an action");
  }
  return wait;
}

/** A step's rules, by output name, with what a person sets and asks of a list through them. */
export function compileStepRules(
  cx: CompileContext,
  rawStep: Record<string, JsonValue>,
  path: PathSegment[],
  faults: StepFaults,
  fillReads: Reads,
  forEach: string | undefined,
  view: CompiledView | undefined,
  isEventRule: (name: string) => boolean,
): { rules: Map<string, CompiledRule>; personSets: Array<[string, Reads, Node]>; listAsks: Set<string> } {
  const { bag, plan, mayFill } = cx;
  const rules = new Map<string, CompiledRule>();
  const personSets: Array<[string, Reads, Node]> = [];
  const listAsks = new Set<string>();
  if (rawStep.on !== undefined) {
    if (!isJsonObject(rawStep.on)) {
      bag.error("flow/invalid-shape", [...path, "on"], "on must map output names to rules");
      faults.rules = "all";
      faults.fills = true;
      cx.mayFillAny = true;
    } else {
      const entries = Object.entries(rawStep.on);
      if (entries.length > MAX_RULES_PER_STEP) bag.error("flow/too-large", [...path, "on"], `at most ${MAX_RULES_PER_STEP} rules per step`);
      for (const [outputName, rawRule] of entries) {
        const rpath: PathSegment[] = [...path, "on", outputName];
        if (!OUTPUT_RE.test(outputName)) bag.error("flow/invalid-output", rpath, "output names are letters, digits, dot, dash and underscore");
        const compiled = compileRule(outputName, rawRule, rpath, bag, fillReads, { shapes: plan.shapes, ...(forEach !== undefined ? { forEach } : {}) });
        if (!compiled || compiled.faulty) {
          // A rule that did not compile, or not whole, may have done anything: what depends on it stays quiet.
          if (faults.rules !== "all") faults.rules.add(outputName);
          faults.fills = true;
          if (!compiled || compiled.unknownTargets) cx.mayFillAny = true;
        }
        if (!compiled) continue;
        for (const target of compiled.broken) mayFill.add(target);
        rules.set(outputName, compiled.rule);
        if (view && !isEventRule(outputName)) {
          personSets.push(...compiled.setReads);
          // A person adds to, removes from or settles a list right here.
          for (const c of [compiled.rule.add, compiled.rule.remove, ...compiled.rule.settle]) if (c !== undefined) listAsks.add(c);
        }
      }
    }
  }
  return { rules, personSets, listAsks };
}

/** Who may answer a step. */
export function compileActor(bag: DiagnosticBag, rawStep: Record<string, JsonValue>, path: PathSegment[]): CompiledStep["actor"] {
  let actor: CompiledStep["actor"];
  if (rawStep.actor !== undefined) {
    const a = rawStep.actor;
    if (!isJsonObject(a)) bag.error("flow/invalid-shape", [...path, "actor"], "actor must be an object");
    else {
      checkKeys(a, keysOf("actor"), [...path, "actor"], bag);
      const roles = a.roles ?? [];
      if (!isStringArray(roles) || roles.some((r) => !ROLE_RE.test(r))) bag.error("flow/invalid-role", [...path, "actor", "roles"], "roles must be role names");
      if (a.notSubject !== undefined && typeof a.notSubject !== "boolean") bag.error("flow/invalid-field", [...path, "actor", "notSubject"], "notSubject must be a boolean");
      actor = { roles: isStringArray(roles) ? [...roles] : [], notSubject: a.notSubject === true };
      if (actor.notSubject && actor.roles.length === 0) bag.error("flow/invalid-role", [...path, "actor"], "a step that the run's own person may not answer must name the roles that may");
    }
  }
  return actor;
}

/** What a step fills: declared, or inferred from its answering rules. */
export function stepFills(
  bag: DiagnosticBag,
  f: FactsSection,
  rawStep: Record<string, JsonValue>,
  path: PathSegment[],
  forEach: string | undefined,
  rules: Map<string, CompiledRule>,
  isCall: boolean,
  isWait: boolean,
  isEventRule: (name: string) => boolean,
): string[] {
  const { facts } = f;
  // Fills: declared, or the facts every answering rule provides. A wait step is
  // answered by its event (or timeout); setting only parameters is not answering.
  let fills: string[];
  if (rawStep.fills !== undefined) {
    if (!isStringArray(rawStep.fills)) {
      bag.error("flow/invalid-field", [...path, "fills"], "fills must be a list of fact names");
      fills = [];
    } else fills = [...new Set(rawStep.fills)];
  } else {
    const isParameter = (f: string) => facts.get(f)?.parameter === true;
    // Outside a per-item step, an item's fields are no step's answer: the list is (once settled).
    const counts = (f: string) => forEach !== undefined || !f.includes(".");
    const sets = [...rules.values()]
      .filter((r) => (isCall ? r.name === "completed" : !isWait || isEventRule(r.name)))
      .map((r) => new Set([...r.set.map(([f]) => f).filter((f) => !isParameter(f) && counts(f)), ...r.decline.filter(counts), ...r.settle]))
      .filter((set) => set.size > 0);
    fills = sets.length === 0 ? [] : [...sets[0]!].filter((f) => sets.every((set) => set.has(f)));
    const dropped = new Set(sets.flatMap((set) => [...set].filter((f) => !fills.includes(f))));
    if (dropped.size > 0) {
      bag.warn(
        "flow/fills-inferred",
        [...path, "on"],
        `fills is inferred as [${fills.join(", ")}], the facts every answering rule sets, so the step can be complete without ${quoted(dropped)}; list what the step is responsible for in "fills"`,
      );
    }
  }
  return fills;
}

/**
 * A call step's `call`: the pinned child flow and its input.
 * `scope` is the step's expression scope (its collections, and its item when
 * it runs per item), so a call refused for its `forEach` is one fault, not
 * one more for each `item.f` its input reads.
 */
export function compileCallStep(rawStep: Record<string, JsonValue>, path: PathSegment[], bag: DiagnosticBag, fillReads: Reads, scope: ParseOptions): CompiledCallStep | undefined {
  const cpath: PathSegment[] = [...path, "call"];
  if (hasOwn(rawStep, "forEach")) bag.error("flow/call-for-each", cpath, "a call cannot run per item yet; call from a step without forEach");
  if (rawStep.run !== undefined || rawStep.wait !== undefined) bag.error("flow/call-with-run", cpath, "a call step cannot also run an action or wait for an event");
  const raw = rawStep.call;
  if (!isJsonObject(raw)) {
    bag.error("flow/invalid-shape", cpath, "call must be an object");
    return undefined;
  }
  checkKeys(raw, keysOf("call"), cpath, bag);
  let ref: { flowId: string; version: string } | null = null;
  if (typeof raw.flow === "string" && !raw.flow.includes("@")) {
    bag.error("flow/call-unpinned", [...cpath, "flow"], `pin the child flow's version, as in "${raw.flow.slice(0, 64)}@1"`);
  } else {
    ref = parseFlowRef(raw.flow);
    if (!ref) bag.error("flow/call-invalid-ref", [...cpath, "flow"], 'flow names the child flow and its version, as in "email-otp@3"');
  }
  if (raw.upgrade !== undefined && raw.upgrade !== "exact" && raw.upgrade !== "compatible") bag.error("flow/invalid-field", [...cpath, "upgrade"], "upgrade is exact or compatible");
  if (raw.timeoutMs !== undefined && !positiveInt(raw.timeoutMs, 366 * DAY)) bag.error("flow/invalid-field", [...cpath, "timeoutMs"], "timeoutMs must be a positive integer");
  const input: [string, Node][] = [];
  const reads = emptyReads();
  if (!isJsonObject(raw.input)) bag.error("flow/invalid-shape", [...cpath, "input"], "input must map the child's input facts to expressions");
  else {
    for (const [key, expr] of Object.entries(raw.input)) {
      if (!NAME_RE.test(key)) {
        bag.error("flow/invalid-name", [...cpath, "input", key], "input keys are the child's fact names");
        continue;
      }
      const parsed = parseExpr(expr, [...cpath, "input", key], bag, { ...scope, allowNow: false });
      if (parsed) {
        input.push([key, parsed.node]);
        mergeReads(reads, parsed.reads);
      }
    }
  }
  mergeReads(fillReads, reads);
  if (!ref) return undefined;
  return {
    flowId: ref.flowId,
    version: ref.version,
    upgrade: raw.upgrade === "compatible" ? "compatible" : "exact",
    input,
    reads,
    ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
  };
}
