/**
 * Where a secret's value can reach: the one taint function every check and
 * every mask uses (the compiler's views, rules, waits and calls, the view's
 * redaction, the export's masking and its hashes, and the toolkit's diff),
 * so none of them keeps a partial version of its own.
 *
 * Secret data has three sources: a fact or item field declared `secret`;
 * the parts of an action's output that a secret is set or derived from (a
 * rule that sets a secret from `result a.p`, or a secret fact derived from
 * it, makes `a.p` secret wherever else it is read); and, in an undo's or a
 * check's input, the part of its resource that holds either. An expression
 * carries a secret when it reads one of these, directly or through any fact
 * or field derived from one, transitively. A fact or field holds a secret
 * when it is `secret` itself, or derived from an expression that carries one.
 */

import { splitTemplate, templateOf } from "./address.js";
import type { CompiledCollection } from "./collections-compile.js";
import type { CompiledFact, CompiledFlow, NodeEntries } from "./compile.js";
import { nodeChildren, type Node } from "./expr.js";
import type { PathSegment } from "./json.js";

/** Answers where secrets are, for one definition. Each answer is worked out once. */
export interface SecretTracer {
  /** The secret fact or field `name` holds (itself, or the source of what it is derived from), or null. */
  secretIn(name: string): string | null;
  /**
   * The secret item field an expression reads, if any: `item.f` of its own
   * item `itemOf`, or a field a collection read needs (every field for a
   * whole read). `items` leaves secret fields out, so it reads none.
   */
  secretInItems(node: Node, itemOf: string | undefined): string | null;
  /**
   * The secret an expression's value carries, or null for none: through the
   * facts, the item fields and the action outputs it reads, following derived
   * facts and fields transitively. `resourceOf` names the action whose
   * resource an undo's or a check's input reads.
   */
  secretRead(node: Node, itemOf?: string, resourceOf?: string): string | null;
  /**
   * Everything an expression's value is made from, transitively through
   * derived facts and fields: fact names, item fields (`collection.field`),
   * and action outputs as `result:<action>` followed by `/<segment>` per
   * path segment.
   */
  reads(node: Node, itemOf?: string, resourceOf?: string): ReadonlySet<string>;
  /**
   * Every secret source an expression's value carries (as {@link reads} names
   * them): each declared secret fact or field, and each secret output path,
   * it reaches. Empty when it carries none.
   */
  secretSourcesRead(node: Node, itemOf?: string, resourceOf?: string): ReadonlySet<string>;
  /** The paths of an action's output that hold secret data (an empty path: all of it). */
  secretResults(action: string): readonly PathSegment[][];
  /**
   * Whether a rule's target may take a secret's value: a secret fact or item
   * field, or a list whose every field is secret. A rule never copies a
   * secret anywhere else (`flow/secret-exposed`).
   */
  holds(target: string): boolean;
}

/** What a tracer needs of a definition beyond looking a fact up: every fact and field, every rule's targets, every action. */
export interface SecretSources {
  /** Every fact and item field (by template name `collection.field`). */
  facts(): Iterable<CompiledFact>;
  /** Every rule's `set`, as target and expression. */
  rules(): Iterable<readonly [string, Node]>;
  /** An action's input and the collection it runs once per item of, if any. */
  action(name: string): { input: NodeEntries; forEach?: string } | undefined;
}

/** How a result read is named in {@link SecretTracer.reads}. */
export function resultReadName(action: string, path: readonly PathSegment[]): string {
  return `result:${action}${path.map((p) => `/${String(p)}`).join("")}`;
}

/** Whether one path is a prefix of the other: a read of either reaches the other. */
function overlaps(a: readonly PathSegment[], b: readonly PathSegment[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Reach {
  names: Set<string>;
  results: Array<readonly [string, readonly PathSegment[]]>;
}

/**
 * A tracer over a definition: `factOrField` resolves a fact name or a field
 * template `c.f`. Without `sources` (a definition still being parsed), no
 * action output counts as secret.
 */
export function secretTracer(factOrField: (name: string) => CompiledFact | undefined, collections: ReadonlyMap<string, CompiledCollection>, sources?: SecretSources): SecretTracer {
  // What each fact or field is made from, transitively; null while it is being worked out (a cycle reads nothing more).
  const factReach = new Map<string, Reach | null>();
  const reachOfFact = (name: string): Reach => {
    const known = factReach.get(name);
    if (known !== undefined) return known ?? { names: new Set([name]), results: [] };
    factReach.set(name, null);
    const out: Reach = { names: new Set([name]), results: [] };
    const fact = factOrField(name);
    if (fact?.derive) {
      // A derived item field may read any field of its own item through `item.f`.
      const r = reach(fact.derive, fact.collection);
      for (const n of r.names) out.names.add(n);
      out.results.push(...r.results);
    }
    factReach.set(name, out);
    return out;
  };
  const reach = (node: Node, itemOf?: string, resourceOf?: string): Reach => {
    const out: Reach = { names: new Set(), results: [] };
    const add = (r: Reach) => {
      for (const n of r.names) out.names.add(n);
      out.results.push(...r.results);
    };
    const walk = (n: Node): void => {
      if (n.k === "fact") {
        const coll = collections.get(n.name);
        if (coll) {
          // A list read takes the fields it names (every field when it names none).
          out.names.add(n.name);
          for (const f of n.fields === "*" || n.fields === undefined ? [...coll.fields.keys()] : n.fields) if (coll.fields.has(f)) add(reachOfFact(templateOf(n.name, f)));
        } else add(reachOfFact(n.name));
      } else if (n.k === "self" && itemOf !== undefined && typeof n.path[0] === "string" && n.path[0] !== "id") {
        if (collections.get(itemOf)?.fields.has(n.path[0])) add(reachOfFact(templateOf(itemOf, n.path[0])));
      } else if (n.k === "result") {
        out.results.push([n.name, n.path]);
      } else if (n.k === "resource" && resourceOf !== undefined) {
        // The resource is the write's input and output: `["output", ...p]` reads its output at p, `["input", k, ...]` its input key k.
        const [part, key] = n.path;
        if (part === undefined || part === "output") out.results.push([resourceOf, n.path.slice(1)]);
        const action = part === undefined || part === "input" ? sources?.action(resourceOf) : undefined;
        if (action) for (const [k, input] of action.input) if (key === undefined || part === undefined || k === key) add(reach(input, action.forEach));
      }
      for (const child of nodeChildren(n)) walk(child);
    };
    walk(node);
    return out;
  };

  // The output paths secret data comes from: those a rule reads into a secret target, and those a secret fact or field derives from.
  let secretPaths: Map<string, PathSegment[][]> | null = null;
  const declaredSecret = (target: string): boolean => {
    const list = collections.get(target);
    if (list) return [...list.fields.values()].some((f) => f.sensitivity === "secret");
    return factOrField(target)?.sensitivity === "secret";
  };
  const resultPaths = (): Map<string, PathSegment[][]> => {
    if (secretPaths) return secretPaths;
    const paths = new Map<string, PathSegment[][]>();
    secretPaths = paths;
    if (!sources) return paths;
    const keep = (r: Reach) => {
      for (const [action, path] of r.results) paths.set(action, [...(paths.get(action) ?? []), [...path]]);
    };
    for (const fact of sources.facts()) if (fact.sensitivity === "secret" && fact.derive) keep(reachOfFact(fact.name));
    for (const [target, node] of sources.rules()) {
      if (!declaredSecret(target)) continue;
      const t = splitTemplate(target);
      keep(reach(node, t?.collection ?? (collections.has(target) ? target : undefined)));
    }
    return paths;
  };
  const secretResults = (action: string): readonly PathSegment[][] => resultPaths().get(action) ?? [];
  const secretResult = (action: string, path: readonly PathSegment[]): boolean => secretResults(action).some((p) => overlaps(p, path));

  /** The secret sources among what `r` reaches: declared secrets, and secret output paths. */
  const sourcesIn = (r: Reach): string[] => [
    ...[...r.names].filter((n) => factOrField(n)?.sensitivity === "secret"),
    ...r.results.filter(([action, path]) => secretResult(action, path)).map(([action, path]) => resultReadName(action, path)),
  ];
  const sourceIn = (r: Reach): string | null => sourcesIn(r)[0] ?? null;
  const secretIn = (name: string): string | null => sourceIn(reachOfFact(name));
  const secretInItems = (node: Node, itemOf: string | undefined): string | null => {
    if (collections.size === 0) return null;
    let found: string | null = null;
    const field = (c: string, f: string): void => {
      if (found === null && collections.get(c)?.fields.has(f)) found = secretIn(templateOf(c, f));
    };
    const walk = (n: Node) => {
      if (n.k === "self" && itemOf !== undefined && typeof n.path[0] === "string" && n.path[0] !== "id") field(itemOf, n.path[0]);
      else if (n.k === "fact" && n.fields !== undefined) {
        const coll = collections.get(n.name);
        for (const f of n.fields === "*" ? [...(coll?.fields.keys() ?? [])] : n.fields) field(n.name, f);
      }
      for (const child of nodeChildren(n)) walk(child);
    };
    walk(node);
    return found;
  };
  const secretRead = (node: Node, itemOf?: string, resourceOf?: string): string | null => sourceIn(reach(node, itemOf, resourceOf));
  const secretSourcesRead = (node: Node, itemOf?: string, resourceOf?: string): ReadonlySet<string> => new Set(sourcesIn(reach(node, itemOf, resourceOf)));
  const reads = (node: Node, itemOf?: string, resourceOf?: string): ReadonlySet<string> => {
    const r = reach(node, itemOf, resourceOf);
    return new Set([...r.names, ...r.results.map(([a, p]) => resultReadName(a, p))]);
  };
  const holds = (target: string): boolean => {
    const list = collections.get(target);
    if (list) return list.fields.size > 0 && [...list.fields.values()].every((f) => f.sensitivity === "secret");
    return factOrField(target)?.sensitivity === "secret";
  };
  return { secretIn, secretInItems, secretRead, reads, secretSourcesRead, secretResults, holds };
}

const compiledTracers = new WeakMap<CompiledFlow, SecretTracer>();

/** The {@link SecretSources} of a compiled flow, or of one being compiled from its parts. */
export function secretSources(facts: ReadonlyMap<string, CompiledFact>, collections: ReadonlyMap<string, CompiledCollection>, steps: Iterable<{ rules: ReadonlyMap<string, { set: NodeEntries }> }>, actions: ReadonlyMap<string, { call: { input: NodeEntries }; forEach?: string }>): SecretSources {
  return {
    *facts() {
      for (const fact of facts.values()) yield fact;
      for (const list of collections.values()) yield* list.fields.values();
    },
    *rules() {
      for (const st of steps) for (const rule of st.rules.values()) yield* rule.set;
    },
    action(name) {
      const a = actions.get(name);
      return a ? { input: a.call.input, ...(a.forEach !== undefined ? { forEach: a.forEach } : {}) } : undefined;
    },
  };
}

/** The tracer of a compiled flow, kept with it. */
export function secretsOf(flow: CompiledFlow): SecretTracer {
  let tracer = compiledTracers.get(flow);
  if (!tracer) {
    const factOrField = (name: string): CompiledFact | undefined => {
      const fact = flow.facts.get(name);
      if (fact) return fact;
      const t = splitTemplate(name);
      return t ? flow.collections.get(t.collection)?.fields.get(t.field) : undefined;
    };
    tracer = secretTracer(factOrField, flow.collections, secretSources(flow.facts, flow.collections, flow.steps, flow.actions));
    compiledTracers.set(flow, tracer);
  }
  return tracer;
}
