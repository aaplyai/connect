/**
 * Author-time reuse: `include` brings a versioned fragment (facts, actions
 * and steps) into a flow, expanded at publish into a plain definition.
 *
 * A source's step list may hold `{"include": "postal-address@2", "as": "ship"}`
 * elements. `expandFlow` resolves each through a `FragmentProvider`, renames
 * every name the fragment declares to `ship_<name>`, replaces its `param`
 * expressions with the include's `with` bindings, and puts the result in
 * place. The output is an ordinary definition with its provenance
 * under `x-includes`; only that flat result is compiled, hashed and stored,
 * so a run never depends on a fragment, and a fragment published again
 * cannot change a published flow.
 *
 * A fragment can name only what it declares and its parameters: it cannot
 * set, clear, decline or derive a host fact, run a host action, use a role
 * the include did not grant or a connection the include did not map (every
 * action names one), or declare anything flow-wide (start roles, entry,
 * completion, limits). It declares no collections, so nothing in it runs per
 * item or touches a list, and it asks for no device capabilities.
 */

import type { DirectPolicy } from "./catalog.js";
import { FLOW_ID_RE, NAME_RE, ROLE_RE, VERSION_RE } from "./compile.js";
import type { ActionDef, Extensions, FactDef, FlowDefinition, StepDef } from "./definition.js";
import { DiagnosticBag, DiagnosticsError, type Diagnostic } from "./diagnostics.js";
import { normaliseExpr, type Expr } from "./expr.js";
import { fingerprint } from "./hash.js";
import { withHints } from "./hints.js";
import { checkJson, cloneJson, hasOwn, isJsonObject, type JsonObject, type JsonValue, type PathSegment } from "./json.js";
import { checkSchema, validateValue, type JsonSchema } from "./schema.js";
import type { Scope } from "./state.js";
import { scopeKey } from "./store.js";

/** One include in a source's (or a fragment's) step list. Only in sources: `compileFlow` refuses it. */
export interface IncludeDef extends Extensions {
  /** The fragment, always pinned: "postal-address@2". */
  include: string;
  /** Prefix for every name the fragment declares: `ship` turns `line1` into `ship_line1`. At most 24 characters. */
  as: string;
  /** The fragment's parameters, as expressions over this flow's facts, results, `env` and literals. */
  with?: Record<string, Expr>;
  /** ANDed into the `when` of every step the fragment brings. */
  when?: Expr;
  /** Roles the fragment's steps and approvals may name. Default none. */
  roles?: string[];
  /** The fragment's connection names to this flow's. */
  connections?: Record<string, string>;
}

/** A parameter a fragment takes. A missing optional one reads as null. */
export interface FragmentParam extends Extensions {
  /** Its type: a literal binding is checked against it at expansion, any other where it is used. */
  type: JsonSchema;
  /** True when an include may leave it out. */
  optional?: boolean;
}

/** Reusable facts, actions and steps. It cannot run on its own, so it is not a flow and not in the flow catalog. */
export interface FragmentDefinition extends Extensions {
  /** The fragment format; only 1 exists. */
  schemaVersion: 1;
  /** Stable id, like a flow id: "postal-address". */
  fragment: string;
  /** Immutable published version. */
  version: string;
  /** What authors see when they pick it. */
  title: string;
  /** What it is for, for authors. */
  description?: string;
  /** The values each include passes in `with`, by name; a step reads one as a `param` expression. */
  params?: Record<string, FragmentParam>;
  /** Connection names its actions use; each include maps them to the host's. */
  connections?: string[];
  /** Facts it declares, renamed with the include's `as` prefix. */
  facts?: Record<string, FactDef>;
  /** Actions it declares, renamed likewise. */
  actions?: Record<string, ActionDef>;
  /** Its steps, put in place of the include; they may include other fragments. */
  steps?: Array<StepDef | IncludeDef>;
}

/** Where `expandFlow` finds fragments, within one scope. Used at publish only. */
export interface FragmentProvider {
  /** The fragment `id` at exactly `version` in `scope`, or null when there is none. */
  get(scope: Scope, id: string, version: string): Promise<FragmentDefinition | null>;
}

/** An in-memory fragment store, for tests and small hosts. */
export interface MemoryFragments extends FragmentProvider {
  /** Publishes a fragment version. The same version again must be identical. */
  publish(scope: Scope, fragment: FragmentDefinition): void;
}

/** One included fragment, recorded under `x-includes` in the expanded definition. */
export interface IncludeRecord {
  /** The full prefix of its names (nested includes join theirs with `_`). */
  as: string;
  /** "id@version". */
  fragment: string;
  /** Fingerprint of the fragment as it was resolved. */
  hash: string;
}

/** What `expandFlow` answers. */
export interface ExpandResult {
  /** The expanded definition, or null when an include could not be expanded. */
  definition: FlowDefinition | null;
  /** Every problem with the source's includes and the fragments they name; errors leave `definition` null. */
  diagnostics: Diagnostic[];
}

/** How deep includes may nest: a source's include is 1. */
export const MAX_INCLUDE_DEPTH = 4;
/** Longest `as` prefix. */
export const MAX_INCLUDE_PREFIX = 24;
/** Most includes one expansion resolves, nested ones counted. */
export const MAX_INCLUDES = 64;

const INCLUDE_KEYS = ["include", "as", "with", "when", "roles", "connections"] as const;
const FRAGMENT_KEYS = ["schemaVersion", "fragment", "version", "title", "description", "params", "connections", "facts", "actions", "steps"] as const;
const PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;
/** References a binding may not make: it is evaluated where the fragment's step is, not where it was written. */
const BINDING_FORBIDDEN = new Set(["payload", "value", "resource", "now"]);

/** A provider with no fragments: every include is unresolved. */
const NO_FRAGMENTS: FragmentProvider = { get: async () => null };

/**
 * An empty in-memory `FragmentProvider` that fragments are published into
 * (`publish`), for tests and small hosts. A fragment must be plain JSON with
 * a valid id and version, and a published version is immutable: publishing
 * it again with other content throws.
 */
export function createMemoryFragments(): MemoryFragments {
  const fragments = new Map<string, FragmentDefinition>();
  const key = (scope: Scope, id: string, version: string) => `${scopeKey(scope)}|${id}|${version}`;
  return {
    publish(scope, fragment) {
      const issue = checkJson(fragment);
      if (issue) throw new DiagnosticsError("fragment is not plain JSON", withHints([{ code: "flow/not-json", severity: "error", path: "", pointer: "", message: issue.message }]));
      if (typeof fragment.fragment !== "string" || !FLOW_ID_RE.test(fragment.fragment) || typeof fragment.version !== "string" || !VERSION_RE.test(fragment.version)) {
        throw new DiagnosticsError("fragment is invalid", withHints([{ code: "flow/invalid-id", severity: "error", path: "fragment", pointer: "/fragment", message: "a fragment needs an id and a version, like a flow" }]));
      }
      const k = key(scope, fragment.fragment, fragment.version);
      const existing = fragments.get(k);
      if (existing && fingerprint(existing as unknown as JsonValue) !== fingerprint(fragment as unknown as JsonValue)) {
        throw new DiagnosticsError(
          "fragment version already published",
          withHints([{ code: "flow/version-exists", severity: "error", path: "version", pointer: "/version", message: `${fragment.fragment}@${fragment.version} is already published with different content` }]),
        );
      }
      fragments.set(k, cloneJson(fragment as unknown as JsonValue) as unknown as FragmentDefinition);
    },
    async get(scope, id, version) {
      const found = fragments.get(key(scope, id, version));
      return found ? (cloneJson(found as unknown as JsonValue) as unknown as FragmentDefinition) : null;
    },
  };
}

/** Flat content in one namespace: what an include contributes to the level that includes it. */
interface Flat {
  facts: JsonObject;
  actions: JsonObject;
  steps: JsonValue[];
  records: IncludeRecord[];
}

/** What the level that includes a fragment grants it. */
interface Grant {
  /** Roles it may name; null at the flow itself (any role it has). */
  roles: Set<string> | null;
  /** Connection names it may map to; null at the flow itself (any name). */
  connections: Set<string> | null;
  /** True inside a fragment, where a binding may read the fragment's own parameters. */
  nested: boolean;
}

interface Expansion {
  scope: Scope;
  fragments: FragmentProvider;
  bag: DiagnosticBag;
  count: number;
}

/**
 * Expands every include in a flow source into a plain definition (see the
 * module comment). A source without includes comes back unchanged, so its
 * hash does not move. Deterministic for the same fragments.
 */
export async function expandFlow(source: unknown, options: { scope: Scope; fragments?: FragmentProvider }): Promise<ExpandResult> {
  const bag = new DiagnosticBag();
  const issue = checkJson(source);
  if (issue) {
    bag.error("flow/not-json", issue.path, `definition must be plain JSON: ${issue.message}`);
    return { definition: null, diagnostics: withHints(bag.items) };
  }
  if (!isJsonObject(source as JsonValue)) return { definition: source as FlowDefinition, diagnostics: [] };
  const out = cloneJson(source as JsonObject);
  const rawSteps = out.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.some(isInclude)) return { definition: out as unknown as FlowDefinition, diagnostics: [] };

  const ctx: Expansion = { scope: options.scope, fragments: options.fragments ?? NO_FRAGMENTS, bag, count: 0 };
  const facts = objectAt(out, "facts", [], bag);
  const actions = objectAt(out, "actions", [], bag);
  const steps: JsonValue[] = [];
  const records: IncludeRecord[] = [];
  const prefixes = new Set<string>();
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i]!;
    if (!isInclude(raw)) {
      steps.push(raw);
      continue;
    }
    const path: PathSegment[] = ["steps", i];
    const flat = await expandInclude(ctx, raw, path, [], 1, { roles: null, connections: null, nested: false }, prefixes);
    if (!flat) continue;
    merge({ facts, actions, steps }, flat, path, bag);
    records.push(...flat.records);
  }
  if (bag.hasErrors) return { definition: null, diagnostics: withHints(bag.items) };
  out.facts = facts;
  if (Object.keys(actions).length > 0 || out.actions !== undefined) out.actions = actions;
  out.steps = steps;
  out["x-includes"] = records as unknown as JsonValue;
  return { definition: out as unknown as FlowDefinition, diagnostics: withHints(bag.items) };
}

/** A value for a message: a string as it is, anything else as short JSON (never through its own `toString`). */
function shown(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 64);
  try {
    return (JSON.stringify(v) ?? typeof v).slice(0, 64);
  } catch {
    return typeof v;
  }
}

function isInclude(v: JsonValue): v is JsonObject {
  return isJsonObject(v) && hasOwn(v, "include");
}

function objectAt(obj: JsonObject, key: string, path: PathSegment[], bag: DiagnosticBag): JsonObject {
  const v = obj[key];
  if (v === undefined) return {};
  if (!isJsonObject(v)) {
    bag.error("flow/invalid-shape", [...path, key], `${key} must be an object`);
    return {};
  }
  return v;
}

/** Adds flat content to a level, reporting every name already there. */
function merge(into: { facts: JsonObject; actions: JsonObject; steps: JsonValue[] }, flat: Flat, path: PathSegment[], bag: DiagnosticBag): void {
  for (const [name, def] of Object.entries(flat.facts)) {
    if (hasOwn(into.facts, name)) bag.error("flow/include-collision", path, `the fact "${name}" is already declared`);
    else into.facts[name] = def;
  }
  for (const [name, def] of Object.entries(flat.actions)) {
    if (hasOwn(into.actions, name)) bag.error("flow/include-collision", path, `the action "${name}" is already declared`);
    else into.actions[name] = def;
  }
  const ids = new Set(into.steps.map((s) => (isJsonObject(s) && typeof s.id === "string" ? s.id : null)));
  for (const step of flat.steps) {
    const id = isJsonObject(step) && typeof step.id === "string" ? step.id : null;
    if (id !== null && ids.has(id)) bag.error("flow/include-collision", path, `the step "${id}" already exists`);
    into.steps.push(step);
  }
}

/**
 * Resolves one include and returns its content in the including level's
 * namespace: names prefixed, parameters bound, `when` joined, roles and
 * connections checked. Null when it could not be expanded (reported).
 */
async function expandInclude(ctx: Expansion, inc: JsonObject, path: PathSegment[], chain: string[], depth: number, grant: Grant, prefixes: Set<string>): Promise<Flat | null> {
  const bag = ctx.bag;
  const errorsBefore = bag.items.filter((d) => d.severity === "error").length;
  for (const key of Object.keys(inc)) {
    if (!(INCLUDE_KEYS as readonly string[]).includes(key) && !key.startsWith("x-")) bag.error("flow/unknown-field", [...path, key], `unknown field "${key}"`);
  }
  // The reference: pinned, well formed.
  const ref = inc.include;
  if (typeof ref !== "string" || !ref.includes("@")) {
    bag.error("flow/include-unpinned", [...path, "include"], `pin the fragment's version, as in "${typeof ref === "string" ? ref.slice(0, 64) : "postal-address"}@1"`);
    return null;
  }
  const at = ref.lastIndexOf("@");
  const id = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (!FLOW_ID_RE.test(id) || !VERSION_RE.test(version)) {
    bag.error("flow/include-unresolved", [...path, "include"], 'include names a fragment and its version, as in "postal-address@2"');
    return null;
  }
  // The prefix: short, a name, unique at its level.
  const as = inc.as;
  if (typeof as !== "string" || !PREFIX_RE.test(as)) {
    bag.error("flow/invalid-field", [...path, "as"], `as is a name of at most ${MAX_INCLUDE_PREFIX} letters, digits and underscores`);
    return null;
  }
  if (prefixes.has(as)) {
    bag.error("flow/include-collision", [...path, "as"], `another include already uses the prefix "${as}"`);
    return null;
  }
  prefixes.add(as);
  if (depth > MAX_INCLUDE_DEPTH) {
    bag.error("flow/include-depth", [...path, "include"], `includes nest at most ${MAX_INCLUDE_DEPTH} deep`);
    return null;
  }
  if (chain.includes(id)) {
    bag.error("flow/include-cycle", [...path, "include"], `${id} includes itself (${[...chain, id].join(" -> ")})`);
    return null;
  }
  if (++ctx.count > MAX_INCLUDES) {
    if (ctx.count === MAX_INCLUDES + 1) bag.error("flow/too-large", [...path, "include"], `at most ${MAX_INCLUDES} includes in one flow`);
    return null;
  }

  // What this include grants: roles, connections.
  const roles = new Set<string>();
  if (inc.roles !== undefined) {
    if (!Array.isArray(inc.roles) || !inc.roles.every((r) => typeof r === "string" && ROLE_RE.test(r))) bag.error("flow/invalid-field", [...path, "roles"], "roles must be a list of role names");
    else
      for (const role of inc.roles as string[]) {
        if (grant.roles && !grant.roles.has(role)) bag.error("flow/include-role", [...path, "roles"], `the role "${role}" was not granted to the fragment that includes this one`);
        roles.add(role);
      }
  }
  const connectionMap = new Map<string, string>();
  if (inc.connections !== undefined) {
    if (!isJsonObject(inc.connections)) bag.error("flow/invalid-field", [...path, "connections"], "connections maps the fragment's connection names to this flow's");
    else
      for (const [from, to] of Object.entries(inc.connections)) {
        if (typeof to !== "string" || !NAME_RE.test(to)) {
          bag.error("flow/invalid-field", [...path, "connections", from], "a connection maps to a connection name");
          continue;
        }
        if (grant.connections && !grant.connections.has(to)) bag.error("flow/include-connection", [...path, "connections", from], `"${to}" is not a connection of the fragment that includes this one`);
        connectionMap.set(from, to);
      }
  }

  // The fragment.
  let fragment: FragmentDefinition | null;
  try {
    fragment = await ctx.fragments.get(ctx.scope, id, version);
  } catch (error) {
    bag.error("flow/include-unresolved", [...path, "include"], `${ref} could not be read (${error instanceof Error ? error.message.slice(0, 200) : "error"})`);
    return null;
  }
  if (!fragment) {
    bag.error("flow/include-unresolved", [...path, "include"], `${ref} is not published`);
    return null;
  }
  const raw = fragment as unknown as JsonValue;
  const fpath: PathSegment[] = [...path, ref];
  if (checkJson(raw) || !isJsonObject(raw)) {
    bag.error("flow/include-unresolved", [...path, "include"], `${ref} is not a fragment`);
    return null;
  }
  if (raw.fragment !== id || raw.version !== version) {
    bag.error("flow/include-unresolved", [...path, "include"], `the provider answered ${shown(raw.fragment)}@${shown(raw.version)} for ${ref}`);
    return null;
  }
  if (raw.schemaVersion !== 1) bag.error("flow/schema-version", [...fpath, "schemaVersion"], "a fragment declares schemaVersion 1");
  for (const key of Object.keys(raw)) {
    // Anything flow-wide (start roles, entry, completion, limits, an interface) is the flow's alone.
    if (!(FRAGMENT_KEYS as readonly string[]).includes(key) && !key.startsWith("x-")) bag.error("flow/unknown-field", [...fpath, key], `a fragment cannot declare "${key}"`);
  }
  const hash = fingerprint(raw);
  const local = cloneJson(raw);

  // Its parameters and their bindings.
  const params = objectAt(local, "params", fpath, bag);
  const bindings = new Map<string, JsonValue>();
  const given = inc.with === undefined ? {} : isJsonObject(inc.with) ? inc.with : null;
  if (!given) bag.error("flow/invalid-field", [...path, "with"], "with maps the fragment's parameters to expressions");
  for (const [name, value] of Object.entries(given ?? {})) {
    if (!hasOwn(params, name)) {
      bag.error("flow/include-param", [...path, "with", name], `${ref} has no parameter "${name}"`);
      continue;
    }
    const binding = normaliseExpr(cloneJson(value));
    const problem = bindingProblem(binding, grant.nested);
    if (problem) {
      bag.error("flow/include-param", [...path, "with", name], problem);
      continue;
    }
    bindings.set(name, binding);
  }
  for (const [name, rawParam] of Object.entries(params)) {
    if (!isJsonObject(rawParam) || !isJsonObject(rawParam.type)) {
      bag.error("flow/include-param", [...fpath, "params", name], "a parameter declares its type");
      continue;
    }
    const before = bag.items.length;
    checkSchema(rawParam.type, [...fpath, "params", name, "type"], bag);
    if (bag.items.length > before) continue;
    const binding = bindings.get(name);
    if (binding === undefined) {
      // A binding that was given but refused is already reported.
      if (given && hasOwn(given, name)) continue;
      if (rawParam.optional === true) bindings.set(name, { lit: null });
      else if (given) bag.error("flow/include-param", [...path, "with"], `${ref} needs the parameter "${name}"`);
      continue;
    }
    // A literal is checked against the parameter's type here; anything else, where it is used.
    const literal = isJsonObject(binding) ? (hasOwn(binding, "lit") && Object.keys(binding).length === 1 ? binding.lit! : undefined) : binding;
    if (literal !== undefined) {
      const issues = validateValue(rawParam.type as unknown as JsonSchema, literal);
      if (issues.length > 0) bag.error("flow/include-param", [...path, "with", name], `not a valid "${name}": ${issues[0]!.message}`);
    }
  }

  // What the fragment may use: its declared connections, mapped by this include.
  const declared = new Set<string>();
  if (local.connections !== undefined) {
    if (!Array.isArray(local.connections) || !local.connections.every((c) => typeof c === "string" && NAME_RE.test(c))) {
      bag.error("flow/invalid-field", [...fpath, "connections"], "connections must be a list of connection names");
    } else for (const c of local.connections as string[]) declared.add(c);
  }
  for (const from of connectionMap.keys()) {
    if (!declared.has(from)) bag.error("flow/include-connection", [...path, "connections", from], `${ref} declares no connection "${from}"`);
  }

  // Nested includes first, into the fragment's own namespace.
  const facts = objectAt(local, "facts", fpath, bag);
  const actions = objectAt(local, "actions", fpath, bag);
  const steps: JsonValue[] = [];
  const records: IncludeRecord[] = [];
  const rawSteps = local.steps === undefined ? [] : Array.isArray(local.steps) ? local.steps : null;
  if (!rawSteps) bag.error("flow/invalid-shape", [...fpath, "steps"], "steps must be a list");
  const nestedPrefixes = new Set<string>();
  for (let j = 0; j < (rawSteps ?? []).length; j++) {
    const step = rawSteps![j]!;
    if (!isInclude(step)) {
      steps.push(step);
      continue;
    }
    const nested = await expandInclude(ctx, step, [...fpath, "steps", j], [...chain, id], depth + 1, { roles, connections: declared, nested: true }, nestedPrefixes);
    if (!nested) continue;
    merge({ facts, actions, steps }, nested, [...fpath, "steps", j], bag);
    records.push(...nested.records);
  }
  if (bag.items.filter((d) => d.severity === "error").length > errorsBefore) return null;

  // Then everything into the including level's namespace.
  const rename = new Renamer(as, facts, actions, bindings, fpath, bag);
  const out: Flat = { facts: {}, actions: {}, steps: [], records: [{ as, fragment: ref, hash }, ...records.map((r) => ({ ...r, as: `${as}_${r.as}` }))] };
  for (const [name, def] of Object.entries(facts)) {
    const fact = rename.fact(name, ["facts", name]);
    if (fact !== null) out.facts[fact] = rename.factDef(def, [...fpath, "facts", name]);
  }
  for (const [name, def] of Object.entries(actions)) {
    const action = rename.action(name, ["actions", name]);
    if (action !== null) out.actions[action] = rename.actionDef(def, [...fpath, "actions", name], roles, connectionMap, declared);
  }
  const stepIds = new Set<string>();
  for (let j = 0; j < steps.length; j++) {
    const step = rename.stepDef(steps[j]!, [...fpath, "steps", j], roles, inc.when);
    const stepId = isJsonObject(step) && typeof step.id === "string" ? step.id : null;
    if (stepId !== null && stepIds.has(stepId)) bag.error("flow/include-collision", [...fpath, "steps", j], `the step "${stepId}" already exists`);
    if (stepId !== null) stepIds.add(stepId);
    out.steps.push(step);
  }
  if (bag.items.filter((d) => d.severity === "error").length > errorsBefore) return null;
  return out;
}

/** Why a binding cannot stand in for a parameter, or null. */
function bindingProblem(binding: JsonValue, nested: boolean): string | null {
  let problem: string | null = null;
  walkExpr(binding, (op) => {
    if (problem) return;
    if (BINDING_FORBIDDEN.has(op)) problem = `a parameter cannot read "${op}": bind it to facts, results, env or a literal`;
    else if (op === "param" && !nested) problem = '"param" is only available inside a fragment';
    else if (op === "expr") problem = "the expression is not valid";
  });
  return problem;
}

/** Calls `visit` with every operator in a JSON expression, outside literals. */
function walkExpr(raw: JsonValue, visit: (op: string) => void): void {
  if (Array.isArray(raw)) {
    for (const item of raw) walkExpr(item, visit);
    return;
  }
  if (!isJsonObject(raw)) return;
  for (const [op, arg] of Object.entries(raw)) {
    if (op === "path") continue;
    visit(op);
    if (op === "lit") continue;
    if (op === "obj" && isJsonObject(arg)) for (const v of Object.values(arg)) walkExpr(v, visit);
    else walkExpr(arg, visit);
  }
}

/** Renames one fragment's names into the including level's namespace, and binds its parameters. */
class Renamer {
  constructor(
    private readonly as: string,
    private readonly facts: JsonObject,
    private readonly actions: JsonObject,
    private readonly bindings: Map<string, JsonValue>,
    private readonly path: PathSegment[],
    private readonly bag: DiagnosticBag,
  ) {}

  private prefixed(name: string, kind: string, path: PathSegment[]): string | null {
    const full = `${this.as}_${name}`;
    if (!NAME_RE.test(full)) {
      this.bag.error("flow/include-collision", [...this.path, ...path], `the ${kind} "${full}" is longer than 64 characters; use a shorter prefix`);
      return null;
    }
    return full;
  }

  fact(name: string, path: PathSegment[]): string | null {
    if (!hasOwn(this.facts, name)) {
      this.bag.error("flow/include-unresolved", [...this.path, ...path], `the fragment names the fact "${name}", which it does not declare`);
      return null;
    }
    return this.prefixed(name, "fact", path);
  }

  action(name: string, path: PathSegment[]): string | null {
    if (!hasOwn(this.actions, name)) {
      this.bag.error("flow/include-unresolved", [...this.path, ...path], `the fragment names the action "${name}", which it does not declare`);
      return null;
    }
    return this.prefixed(name, "action", path);
  }

  /** An expression, renamed and with its parameters bound. Bindings are taken as written. */
  expr(raw: JsonValue, path: PathSegment[]): JsonValue {
    const node = normaliseExpr(raw);
    if (Array.isArray(node)) return node.map((item, i) => this.expr(item, [...path, i]));
    if (!isJsonObject(node)) return node;
    if (hasOwn(node, "fact") || hasOwn(node, "result")) {
      const isFact = hasOwn(node, "fact");
      const name = isFact ? node.fact : node.result;
      if (typeof name !== "string") return node;
      const renamed = isFact ? this.fact(name, path) : this.action(name, path);
      return renamed === null ? node : { ...node, [isFact ? "fact" : "result"]: renamed };
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) return node;
    const op = keys[0]!;
    const arg = node[op]!;
    switch (op) {
      case "lit":
      case "payload":
      case "value":
      case "resource":
      case "env":
      case "now":
      case "item":
        return node;
      case "known":
        return typeof arg === "string" ? { known: this.fact(arg, path) ?? arg } : node;
      case "failed":
        return typeof arg === "string" ? { failed: this.action(arg, path) ?? arg } : node;
      case "items":
        this.bag.error("flow/include-collection", [...this.path, ...path], "a fragment declares no collections, so it cannot show a list's rows");
        return node;
      case "param": {
        const bound = typeof arg === "string" ? this.bindings.get(arg) : undefined;
        if (bound === undefined) {
          this.bag.error("flow/include-param", [...this.path, ...path], `the fragment reads the parameter "${shown(arg)}", which it does not declare`);
          return node;
        }
        return cloneJson(bound);
      }
      case "expr":
        this.bag.error("flow/expr-invalid", [...this.path, ...path], "this text expression does not compile");
        return node;
      case "obj":
        if (!isJsonObject(arg)) return node;
        return { obj: Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, this.expr(v, [...path, "obj", k])])) };
      default:
        return { [op]: Array.isArray(arg) ? arg.map((item, i) => this.expr(item, [...path, op, i])) : this.expr(arg, [...path, op]) };
    }
  }

  private exprRecord(raw: JsonValue | undefined, path: PathSegment[]): JsonValue | undefined {
    if (!isJsonObject(raw)) return raw;
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, this.expr(v, [...path, k])]));
  }

  private factList(raw: JsonValue | undefined, path: PathSegment[]): JsonValue | undefined {
    if (!Array.isArray(raw)) return raw;
    return raw.map((n, i) => (typeof n === "string" ? (this.fact(n, [...path, i]) ?? n) : n));
  }

  private checkRoles(raw: JsonValue | undefined, granted: Set<string>, path: PathSegment[]): void {
    if (!Array.isArray(raw)) return;
    for (const role of raw) {
      if (typeof role === "string" && !granted.has(role)) this.bag.error("flow/include-role", [...this.path, ...path], `the role "${role}" was not granted by the include`);
    }
  }

  factDef(raw: JsonValue, path: PathSegment[]): JsonValue {
    if (!isJsonObject(raw)) return raw;
    const out: JsonObject = { ...raw };
    if (raw.derive !== undefined) out.derive = this.expr(raw.derive, ["facts", ...path.slice(-1), "derive"]);
    if (Array.isArray(raw.checks)) out.checks = raw.checks.map((c, i) => (isJsonObject(c) && c.test !== undefined ? { ...c, test: this.expr(c.test, ["facts", ...path.slice(-1), "checks", i, "test"]) } : c));
    if (raw.dependsOn !== undefined) out.dependsOn = this.factList(raw.dependsOn, ["facts", ...path.slice(-1), "dependsOn"])!;
    return out;
  }

  private call(raw: JsonValue | undefined, path: PathSegment[], connections: Map<string, string>, declared: Set<string>): JsonValue | undefined {
    if (!isJsonObject(raw)) return raw;
    const out: JsonObject = { ...raw };
    if (raw.input !== undefined) out.input = this.exprRecord(raw.input, [...path, "input"])!;
    if (raw.connection === undefined) {
      // Without one it would reach whatever the including flow's host binds by default.
      this.bag.error("flow/include-connection", [...this.path, ...path], "a fragment's action names one of the fragment's connections, mapped by the include");
    } else {
      const from = raw.connection;
      const to = typeof from === "string" ? connections.get(from) : undefined;
      if (typeof from !== "string" || !declared.has(from) || to === undefined) {
        this.bag.error("flow/include-connection", [...this.path, ...path, "connection"], `the connection "${shown(from)}" is not declared by the fragment and mapped by the include`);
      } else out.connection = to;
    }
    return out;
  }

  actionDef(raw: JsonValue, path: PathSegment[], roles: Set<string>, connections: Map<string, string>, declared: Set<string>): JsonValue {
    const rel = ["actions", ...path.slice(-1)];
    if (!isJsonObject(raw)) return raw;
    const out = this.call(raw, rel, connections, declared) as JsonObject;
    if (raw.compensate !== undefined) out.compensate = this.call(raw.compensate, [...rel, "compensate"], connections, declared)!;
    if (raw.reconcile !== undefined) out.reconcile = this.call(raw.reconcile, [...rel, "reconcile"], connections, declared)!;
    if (isJsonObject(raw.approval)) this.checkRoles(raw.approval.roles, roles, [...rel, "approval", "roles"]);
    return out;
  }

  stepDef(raw: JsonValue, path: PathSegment[], roles: Set<string>, when: JsonValue | undefined): JsonValue {
    if (!isJsonObject(raw)) return raw;
    const rel = path.slice(this.path.length);
    const out: JsonObject = { ...raw };
    if (typeof raw.id === "string") out.id = this.prefixed(raw.id, "step", [...rel, "id"]) ?? raw.id;
    const own = raw.when === undefined ? undefined : this.expr(raw.when, [...rel, "when"]);
    // The include's own condition, as written by the includer, guards every step it brings.
    const outer = when === undefined ? undefined : normaliseExpr(cloneJson(when));
    if (own !== undefined || outer !== undefined) out.when = own === undefined ? outer! : outer === undefined ? own : { and: [outer, own] };
    // A fragment declares no collections: anything per item, or on a list, could only be the including flow's.
    for (const key of ["forEach", "fanOut"] as const) {
      if (raw[key] !== undefined) this.bag.error("flow/include-collection", [...this.path, ...rel, key], `a fragment declares no collections, so its steps cannot use "${key}"`);
    }
    if (raw.deviceCapabilities !== undefined) {
      this.bag.error("flow/include-capability", [...this.path, ...rel, "deviceCapabilities"], "a fragment's steps cannot ask for device capabilities; only the including flow's own steps can");
    }
    if (raw.needs !== undefined) out.needs = this.factList(raw.needs, [...rel, "needs"])!;
    if (raw.fills !== undefined) out.fills = this.factList(raw.fills, [...rel, "fills"])!;
    if (typeof raw.run === "string") out.run = this.action(raw.run, [...rel, "run"]) ?? raw.run;
    if (isJsonObject(raw.view)) out.view = { ...raw.view, ...(raw.view.input !== undefined ? { input: this.exprRecord(raw.view.input, [...rel, "view", "input"])! } : {}) };
    if (isJsonObject(raw.on)) {
      const on: JsonObject = {};
      for (const [name, rule] of Object.entries(raw.on)) {
        if (!isJsonObject(rule)) {
          on[name] = rule;
          continue;
        }
        const r: JsonObject = { ...rule };
        const rpath = [...rel, "on", name];
        for (const key of ["add", "remove", "settle", "item"] as const) {
          if (rule[key] !== undefined) this.bag.error("flow/include-collection", [...this.path, ...rpath, key], `a fragment declares no collections, so its rules cannot use "${key}"`);
        }
        if (isJsonObject(rule.set)) {
          const set: JsonObject = {};
          for (const [target, value] of Object.entries(rule.set)) set[this.fact(target, [...rpath, "set", target]) ?? target] = this.expr(value, [...rpath, "set", target]);
          r.set = set;
        }
        if (rule.decline !== undefined) r.decline = this.factList(rule.decline, [...rpath, "decline"])!;
        if (rule.clear !== undefined) r.clear = this.factList(rule.clear, [...rpath, "clear"])!;
        on[name] = r;
      }
      out.on = on;
    }
    if (isJsonObject(raw.wait)) {
      const w: JsonObject = { ...raw.wait };
      if (raw.wait.correlate !== undefined) w.correlate = this.expr(raw.wait.correlate, [...rel, "wait", "correlate"]);
      if (raw.wait.accept !== undefined) w.accept = this.expr(raw.wait.accept, [...rel, "wait", "accept"]);
      out.wait = w;
    }
    // A call's input keys are the child's fact names: only the expressions are this fragment's.
    if (isJsonObject(raw.call)) out.call = { ...raw.call, ...(raw.call.input !== undefined ? { input: this.exprRecord(raw.call.input, [...rel, "call", "input"])! } : {}) };
    if (isJsonObject(raw.actor)) this.checkRoles(raw.actor.roles, roles, [...rel, "actor", "roles"]);
    return out;
  }
}

/** Options for `MemoryCatalog.publishSource`. */
export interface PublishSourceOptions {
  /** Where includes are resolved. Without it, any include is unresolved. */
  fragments?: FragmentProvider;
  /** Check the flow's calls against the catalog (default true). */
  checkCalls?: boolean;
  /** The runtime's `maxCallDepth`, for the call check. Default 3. */
  maxCallDepth?: number;
  /** As for `publish`. */
  makeCurrent?: boolean;
  /** As for `publish`: how the version treats live runs of older ones (default `pinned`). */
  policy?: DirectPolicy;
}

/** Throws {@link DiagnosticsError} when an expansion failed; returns the definition otherwise. */
export function mustExpand(result: ExpandResult): FlowDefinition {
  if (!result.definition) throw new DiagnosticsError("flow source could not be expanded", result.diagnostics);
  return result.definition;
}
