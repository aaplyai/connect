/**
 * Builds the dependency graph of a compiled definition and reads from it:
 * the derived order, what is upstream of each action and call, the row
 * binders, and the completion and correlation checks.
 */

import { templateOf, splitTemplate } from "../address.js";
import { type parseExpr, type Reads, type Node, nodeChildren, emptyReads } from "../expr.js";
import type { CompileContext, FactsSection, ActionsSection, StepsSection } from "./context.js";
import type { ReferenceChecks } from "./references.js";
import { describeNode, factNode, actionNode, type CompiledAction, type CompiledFlow, type CompiledInterface, interfaceHash } from "../compile.js";

// --- dependency graph ------------------------------------------------------

/** The dependency graph and what is read from it, or null when it has a cycle. */
export function compileGraph(
  cx: CompileContext,
  f: FactsSection,
  a: ActionsSection,
  s: StepsSection,
  refs: ReferenceChecks,
  completeParsed: NonNullable<ReturnType<typeof parseExpr>>,
  iface: { input: string[]; output: string[]; callableOnly: boolean } | undefined,
) {
  const { bag, collections } = cx;
  const { facts, factOrField } = f;
  const { dependents, sameItem } = dependencyEdges(cx, f, a, s);
  const cycle = findCycle(dependents);
  if (cycle) {
    const hint = cycle.some((n) => n.startsWith("a:")) ? ' (a fact a step sets to steer what it shows, such as a page or a filter, can be marked "parameter": true)' : "";
    bag.error("flow/dependency-cycle", ["facts"], `dependency cycle: ${cycle.map(describeNode).join(" -> ")}${hint}`);
    return null;
  }
  const derivedOrder = topoOrder(dependents).filter((n) => n.startsWith("f:") && factOrField(n.slice(2))?.derive).map((n) => n.slice(2));
  for (const fact of facts.values()) if (fact.derive && !derivedOrder.includes(fact.name)) derivedOrder.push(fact.name);
  for (const collection of collections.values()) for (const field of collection.fields.values()) if (field.derive && !derivedOrder.includes(field.name)) derivedOrder.push(field.name);

  const reverse = new Map<string, Set<string>>();
  for (const [from, tos] of dependents) for (const to of tos) {
    let set = reverse.get(to);
    if (!set) reverse.set(to, (set = new Set()));
    set.add(from);
  }
  const { upstreamFacts, upstreamOwn } = upstreams(a.actions, reverse, sameItem);
  const rowBinders = rowBindersOf(cx, f, s);
  const callUpstream = callUpstreams(cx, s, reverse);
  const compiledInterface = checkCompletion(cx, f, s, refs, reverse, completeParsed, iface);
  checkCorrelation(cx, f, s, refs);
  return { dependents, derivedOrder, upstreamFacts, sameItem, upstreamOwn, rowBinders, callUpstream, compiledInterface };
}

/**
 * The graph's edges. Nodes are facts ("f:name"), collections ("f:list", their membership),
 * item field templates ("f:list.field") and actions ("a:name"). An edge into
 * a template reaches every item unless it is marked same-item.
 */
export function dependencyEdges(cx: CompileContext, f: FactsSection, a: ActionsSection, s: StepsSection): { dependents: Map<string, Set<string>>; sameItem: Set<string> } {
  const { plan, collections, fieldReads } = cx;
  const { facts, factReads } = f;
  const { actions } = a;
  const { steps, stepFillReads, stepShownResults } = s;
  const dependents = new Map<string, Set<string>>();
  const sameItemEdges = new Set<string>();
  const everyItemEdges = new Set<string>();
  const addEdge = (from: string, to: string, same = false) => {
    if (from === to) return;
    let set = dependents.get(from);
    if (!set) dependents.set(from, (set = new Set()));
    set.add(to);
    if (collections.size > 0) (same ? sameItemEdges : everyItemEdges).add(`${from}>${to}`);
  };
  /** A per-item result read inside its own item stays within the item. */
  const sameItemResult = (result: string, itemOf: string | undefined) => itemOf !== undefined && plan.perItem.get(result) === itemOf;
  /** Edges for `item.f` reads (same item) and for the fields collection reads need (every item). */
  const itemEdges = (reads: Reads, to: string, itemOf: string | undefined, skip?: (from: string) => boolean) => {
    if (itemOf !== undefined) for (const f of reads.self ?? []) addEdge(factNode(templateOf(itemOf, f)), to, true);
    for (const [c, fields] of reads.lists ?? []) {
      for (const f of fields === "*" ? [...(collections.get(c)?.fields.keys() ?? [])] : fields) {
        const from = factNode(templateOf(c, f));
        if (!skip?.(from)) addEdge(from, to);
      }
    }
  };
  for (const [name, reads] of factReads) {
    for (const f of reads.facts) addEdge(factNode(f), factNode(name));
    for (const r of reads.results) addEdge(actionNode(r), factNode(name));
    itemEdges(reads, factNode(name), undefined);
  }
  for (const [template, reads] of fieldReads) {
    const of = splitTemplate(template)!.collection;
    for (const f of reads.facts) addEdge(factNode(f), factNode(template));
    for (const r of reads.results) addEdge(actionNode(r), factNode(template), sameItemResult(r, of));
    itemEdges(reads, factNode(template), of);
  }
  for (const action of actions.values()) {
    for (const f of action.reads.facts) addEdge(factNode(f), actionNode(action.name));
    for (const r of action.reads.results) addEdge(actionNode(r), actionNode(action.name), sameItemResult(r, action.forEach));
    itemEdges(action.reads, actionNode(action.name), action.forEach);
  }
  for (const step of steps) {
    const reads = stepFillReads.get(step.id)!;
    const shown = stepShownResults.get(step.id)!;
    const targets = new Set<string>(step.fills);
    for (const rule of step.rules.values()) {
      for (const [t] of rule.set) targets.add(t);
      for (const c of rule.settle) targets.add(c);
    }
    for (const t of targets) {
      // A step's answers about a list (its items' fields, its settling) do not depend on that same list:
      // adding an item must not clear the others, nor a per-item step's `needs` its own item.
      const own = splitTemplate(t)?.collection ?? (collections.has(t) ? t : undefined);
      const skip = (from: string) => own !== undefined && (from === factNode(own) || from.startsWith(`${factNode(own)}.`));
      for (const f of reads.facts) if (!skip(factNode(f))) addEdge(factNode(f), factNode(t));
      for (const r of reads.results) addEdge(actionNode(r), factNode(t), sameItemResult(r, step.forEach));
      itemEdges(reads, factNode(t), step.forEach, skip);
      // A pick depends on the choices shown; a parameter steers them instead.
      if (!facts.get(t)?.parameter) for (const r of shown) addEdge(actionNode(r), factNode(t), sameItemResult(r, step.forEach));
    }
  }
  // An edge that also reaches every item is not a same-item edge.
  const sameItem = new Set([...sameItemEdges].filter((edge) => !everyItemEdges.has(edge)));
  return { dependents, sameItem };
}

/** What each action depends on upstream, and for a per-item action, the item templates that are its own item's. */
export function upstreams(actions: Map<string, CompiledAction>, reverse: Map<string, Set<string>>, sameItem: Set<string>): { upstreamFacts: Map<string, Set<string>>; upstreamOwn: Map<string, Set<string>> } {
  const upstreamFacts = new Map<string, Set<string>>();
  for (const action of actions.values()) {
    const seen = new Set<string>();
    const queue = [actionNode(action.name)];
    while (queue.length > 0) {
      const node = queue.pop()!;
      for (const prev of reverse.get(node) ?? []) {
        if (seen.has(prev)) continue;
        seen.add(prev);
        queue.push(prev);
      }
    }
    upstreamFacts.set(action.name, new Set([...seen].filter((n) => n.startsWith("f:")).map((n) => n.slice(2))));
  }
  // Per-item actions: the templates upstream only through same-item edges are that item's own;
  // anything reached through an edge that spans items belongs to every item.
  const upstreamOwn = new Map<string, Set<string>>();
  for (const action of actions.values()) {
    if (action.forEach === undefined) continue;
    const own = new Set<string>();
    const every = new Set<string>();
    const queue: Array<[string, boolean]> = [[actionNode(action.name), true]];
    while (queue.length > 0) {
      const [node, ownPath] = queue.pop()!;
      for (const prev of reverse.get(node) ?? []) {
        const stillOwn = ownPath && sameItem.has(`${prev}>${node}`);
        const set = stillOwn ? own : every;
        if (set.has(prev)) continue;
        set.add(prev);
        queue.push([prev, stillOwn]);
      }
    }
    upstreamOwn.set(action.name, new Set([...own].filter((n) => !every.has(n) && n.includes(".")).map((n) => n.slice(2))));
  }
  return { upstreamFacts, upstreamOwn };
}

/** Views that show an item field: per item (`item.f` in a per-item view) or as rows of the list. */
export function rowBindersOf(cx: CompileContext, f: FactsSection, s: StepsSection): CompiledFlow["rowBinders"] {
  const { collections } = cx;
  const { factOrField } = f;
  const { steps } = s;
  // Views that show an item field: per item (`item.f` in a per-item view) or as rows of the list.
  // Only fields a person can give count: a derived or secret field is never a control's value.
  const rowBinders: CompiledFlow["rowBinders"] = new Map();
  const bind = (template: string, stepId: string, same: boolean) => {
    const field = factOrField(template);
    if (!field || field.derive || field.sensitivity === "secret") return;
    const list = rowBinders.get(template) ?? [];
    if (!list.some((b) => b.stepId === stepId && b.sameItem === same)) list.push({ stepId, sameItem: same });
    rowBinders.set(template, list);
  };
  for (const step of steps) {
    if (!step.view || collections.size === 0) continue;
    if (step.forEach !== undefined) for (const f of step.view.reads.self ?? []) bind(templateOf(step.forEach, f), step.id, true);
    for (const [c, fields] of step.view.reads.lists ?? []) {
      for (const f of fields === "*" ? [...(collections.get(c)?.fields.keys() ?? [])] : fields) bind(templateOf(c, f), step.id, false);
    }
    const rows = (n: Node) => {
      if (n.k === "items") for (const field of collections.get(n.name)?.fields.values() ?? []) bind(field.name, step.id, false);
      for (const child of nodeChildren(n)) rows(child);
    };
    for (const [, node] of step.view.input) rows(node);
  }
  return rowBinders;
}

/** The facts upstream of `start`: every fact node it is reached from. */
export function upstreamOf(reverse: Map<string, Set<string>>, start: Iterable<string>): Set<string> {
  const seen = new Set<string>(start);
  const queue = [...seen];
  while (queue.length > 0) {
    for (const prev of reverse.get(queue.pop()!) ?? []) {
      if (seen.has(prev)) continue;
      seen.add(prev);
      queue.push(prev);
    }
  }
  return new Set([...seen].filter((n) => n.startsWith("f:")).map((n) => n.slice(2)));
}

/** Each call step's upstream facts: what decides whether its call is still wanted. */
export function callUpstreams(cx: CompileContext, s: StepsSection, reverse: Map<string, Set<string>>): Map<string, Set<string>> {
  const { collections } = cx;
  const { callStartReads } = s;
  // A call's inputs include the item fields it reads of a list (a call step is never per item,
  // so `item.f` never reaches here): those fields of every item, as a whole-list read locks them.
  const callUpstream = new Map<string, Set<string>>();
  for (const [stepId, reads] of callStartReads) {
    const start = [...[...reads.facts].map(factNode), ...[...reads.results].map(actionNode)];
    for (const [c, fields] of reads.lists ?? []) {
      for (const f of fields === "*" ? [...(collections.get(c)?.fields.keys() ?? [])] : fields) start.push(factNode(templateOf(c, f)));
    }
    callUpstream.set(stepId, upstreamOf(reverse, start));
  }
  return callUpstream;
}

/** Warns of steps and interface outputs completeWhen does not depend on; returns the compiled interface. */
export function checkCompletion(
  cx: CompileContext,
  f: FactsSection,
  s: StepsSection,
  refs: ReferenceChecks,
  reverse: Map<string, Set<string>>,
  completeParsed: NonNullable<ReturnType<typeof parseExpr>>,
  iface: { input: string[]; output: string[]; callableOnly: boolean } | undefined,
): CompiledInterface | undefined {
  const { bag } = cx;
  const { facts } = f;
  const { steps } = s;
  const { filledBy } = refs;
  // A step nothing in completeWhen depends on may never happen: the run can complete first.
  const feedsCompletion = new Set<string>([...[...completeParsed.reads.facts].map(factNode), ...[...completeParsed.reads.results].map(actionNode)]);
  const queue = [...feedsCompletion];
  while (queue.length > 0) {
    for (const prev of reverse.get(queue.pop()!) ?? []) {
      if (feedsCompletion.has(prev)) continue;
      feedsCompletion.add(prev);
      queue.push(prev);
    }
  }
  for (const step of steps) {
    const feeds = step.fills.some((f) => feedsCompletion.has(factNode(f))) || (step.run !== undefined && feedsCompletion.has(actionNode(step.run)));
    if (!feeds) bag.warn("flow/after-completion", ["steps", step.index], `completeWhen depends on nothing step "${step.id}" fills or runs, so the run may complete before the step happens`);
  }
  let compiledInterface: CompiledInterface | undefined;
  if (iface) {
    for (const name of iface.output) {
      if (!feedsCompletion.has(factNode(name))) {
        bag.warn("flow/interface-output-unsettled", ["interface", "output"], `completeWhen does not depend on "${name}", so the run may complete and return it as null`);
      }
    }
    const required = iface.input.filter((name) => !filledBy.has(name));
    compiledInterface = { ...iface, required, hash: interfaceHash(facts, iface.input, iface.output, required), upstream: upstreamOf(reverse, iface.output.map(factNode)) };
  }
  return compiledInterface;
}

/** Correlation keys: never a secret, and warned of when a person controls them. */
export function checkCorrelation(cx: CompileContext, f: FactsSection, s: StepsSection, refs: ReferenceChecks): void {
  const { bag } = cx;
  const { facts, deriveReads } = f;
  const { steps, correlateReads } = s;
  const { tracer } = refs;
  // A correlation key a person controls lets them choose which outside event reaches the run.
  const personControlled = (name: string, seen: Set<string>): boolean => {
    const fact = facts.get(name);
    if (!fact) return false;
    if (fact.userFillable) return true;
    if (!fact.derive || seen.has(name)) return false;
    seen.add(name);
    const r = deriveReads.get(name) ?? emptyReads();
    return r.results.size === 0 && [...r.facts].every((f) => personControlled(f, seen));
  };
  for (const step of steps) {
    // A correlation key is an identifier: it is stored with the wait, carried by the outside event and matched in the clear, so it may never carry a secret.
    const correlated = step.wait ? tracer.secretRead(step.wait.correlate, step.forEach) : null;
    if (correlated !== null) {
      bag.error("flow/secret-correlate", ["steps", step.index, "wait", "correlate"], `the correlation key reads secret "${correlated}"; a key is stored and matched in the clear, so correlate on a value that is not secret`);
    }
    const r = step.wait ? correlateReads.get(step.id) : undefined;
    if (r && r.results.size === 0 && [...r.facts].every((f) => personControlled(f, new Set()))) {
      bag.warn(
        "flow/correlate-user-fillable",
        ["steps", step.index, "wait", "correlate"],
        "the correlation key comes only from facts a person can give, so they could steer which outside event reaches this run; correlate on a value an action returned (a result, or a fact derived from one)",
      );
    }
  }
}

export function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const s = state.get(next);
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (s === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

export function topoOrder(graph: Map<string, Set<string>>): string[] {
  const nodes = new Set<string>();
  for (const [from, tos] of graph) {
    nodes.add(from);
    for (const t of tos) nodes.add(t);
  }
  const indegree = new Map<string, number>();
  for (const n of nodes) indegree.set(n, 0);
  for (const tos of graph.values()) for (const t of tos) indegree.set(t, (indegree.get(t) ?? 0) + 1);
  const queue = [...nodes].filter((n) => indegree.get(n) === 0).sort();
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const t of [...(graph.get(n) ?? [])].sort()) {
      const d = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  return out;
}
