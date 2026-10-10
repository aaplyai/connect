/**
 * Validates a flow definition and compiles it into the form the core runs.
 *
 * Validation is strict and total: every problem is reported with a stable
 * code and a path, so tools (and agents) can repair a flow without guessing.
 * Compilation parses every expression once, infers each step's fills and
 * builds the dependency graph used to clear only what a change affects.
 *
 * The compiler works on its own deep copy of the definition in which every
 * text expression is replaced by its JSON tree. That copy is what the
 * compiled flow keeps and hashes, and it is frozen: a published version can
 * change neither through the caller's object nor through a later change to
 * the text grammar.
 */

import { fixedPattern } from "@aaply/action-contract/internal";
import {
  COLLECTION_LIMIT_CEILINGS,
  COLLECTION_LIMITS,
  compileCollections,
  planCollections,
  type CollectionPlan,
  type CompiledCollection,
} from "./collections-compile.js";
import { checkArithmetic } from "./arithmetic.js";
import { DiagnosticBag, DiagnosticsError, type Diagnostic } from "./diagnostics.js";
import { withHints } from "./hints.js";
import { FLOW_SCHEMA_VERSION, type ActionDef, type EndKind, type FactDef, type FlowDefinition, type StepDef } from "./definition.js";
import { keysOf } from "./definition-keys.js";
import { emptyReads, mergeReads, nodeChildren, normaliseExpr, parseExpr, type ExprScope, type Node, type Reads } from "./expr.js";
import { checkJson, cloneJson, hasOwn, isJsonObject, jsonByteLength, type JsonValue, type PathSegment } from "./json.js";
import { fingerprint } from "./hash.js";
import { compileMigrations, type CompiledMigration } from "./migration-def.js";
import { type JsonSchema } from "./schema.js";
import { MAX_GOAL_NAME_LENGTH, MAX_GOAL_NAMES, normaliseName } from "./exact.js";
import { type ReplyViewKey } from "./reply.js";
import { FILL_MODES } from "./fill.js";
import type { CompileContext } from "./compile/context.js";
import { compileFacts } from "./compile/facts.js";
import { compileActions } from "./compile/actions.js";
import { compileSteps } from "./compile/steps.js";
import { referenceChecks, checkReferences, checkStepReferences, checkObtainable } from "./compile/references.js";
import { compileGraph } from "./compile/graph.js";

export type { CompiledCollection } from "./collections-compile.js";

export const NAME_RE = fixedPattern(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
export const FLOW_ID_RE = fixedPattern(/^[a-z][a-z0-9-]{0,63}$/);
export const VERSION_RE = fixedPattern(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/);
export const OUTPUT_RE = fixedPattern(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
export const CONNECTOR_ACTION_RE = fixedPattern(/^[a-z][a-z0-9-]{0,63}(\.[a-zA-Z][a-zA-Z0-9_-]{0,63}){1,4}$/);
export const ROLE_RE = fixedPattern(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/);
export const EVENT_RE = fixedPattern(/^[a-z][a-zA-Z0-9_.-]{0,127}$/);
export const SECTION_RE = fixedPattern(/^[a-z0-9][a-z0-9._/-]{0,127}(@[0-9A-Za-z.+-]{1,32})?$/);
export const DEVICE_CAPABILITY_RE = fixedPattern(/^device\.[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);

export const MAX_FACTS = 500;
export const MAX_ACTIONS = 200;
export const MAX_STEPS = 300;
export const MAX_RULES_PER_STEP = 50;
export const MAX_DEFINITION_BYTES = 512 * 1024;

export const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_LIMITS = Object.freeze({
  maxLifetimeMs: 30 * DAY,
  idleTimeoutMs: 7 * DAY,
  maxTurns: 500,
  maxEvents: 5000,
  maxFactBytes: 64 * 1024,
  maxCalls: 20,
} as const);

const LIMIT_CEILINGS = {
  maxLifetimeMs: 366 * DAY,
  idleTimeoutMs: 366 * DAY,
  maxTurns: 10_000,
  maxEvents: 100_000,
  maxFactBytes: 1024 * 1024,
  maxCalls: 1000,
} as const;

const CALL_END_RULE_NAMES: readonly string[] = Object.freeze(["completed", "failed", "cancelled", "expired", "timeout"]);
/**
 * Rules of a call step that answer its child's end; the others answer its
 * view. Read with `has`, or listed; frozen, and not a `Set`, whose entries
 * freezing would not hold.
 */
export const CALL_END_RULES: { has(name: string): boolean; [Symbol.iterator](): Iterator<string> } = Object.freeze({
  has: (name: string): boolean => CALL_END_RULE_NAMES.includes(name),
  [Symbol.iterator]: (): Iterator<string> => CALL_END_RULE_NAMES[Symbol.iterator](),
});

export const DEFAULT_RETRY = Object.freeze({ max: 3, baseMs: 500, maxMs: 30_000 } as const);
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const MAX_ACTION_TIMEOUT_MS = 7 * DAY;
export const MAX_REVIEW_TTL_MS = 366 * DAY;
/** An operation-contract digest, as pinned on an action call. */
export const CONTRACT_DIGEST_RE = fixedPattern(/^sha256:[0-9a-f]{64}$/);

export type NodeEntries = ReadonlyArray<readonly [string, Node]>;

export { FILL_MODES };
/** Most facts a view maps to section keys. */
const MAX_VIEW_FIELDS = 200;
/**
 * A section key: a dotted path of up to five names, none of them one that
 * walks an object's prototype where a shell writes the key (`__proto__`,
 * `constructor`, `prototype`).
 */
const FIELD_KEY_RE = /^(?!(?:.*\.)?(?:__proto__|constructor|prototype)(?:\.|$))[a-zA-Z][a-zA-Z0-9_]{0,63}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,63}){0,4}$/;

export interface CompiledFact {
  name: string;
  def: FactDef;
  schema: JsonSchema;
  sensitivity: "none" | "personal" | "secret";
  derive?: Node;
  checks: Array<{ test: Node; message: string; code: string }>;
  /**
   * A person may provide it directly: an entry fact, or one a view step's rule
   * sets from the output alone (reading no facts or results).
   */
  userFillable: boolean;
  /** Steers what a step shows (a page, a filter); never part of inferred fills. */
  parameter: boolean;
  /** Set on a collection's entry in `facts`: the list it is. */
  list?: CompiledCollection;
  /** Set on an item field (whose `name` is `collection.field`): its collection. */
  collection?: string;
  /** Set on an item field: its name within the item. */
  field?: string;
}

export interface CompiledCall {
  action: string;
  connection?: string;
  input: NodeEntries;
  timeoutMs: number;
  /** The pinned operation-contract digest. */
  contract?: string;
}

export interface CompiledAction {
  name: string;
  def: ActionDef;
  call: CompiledCall;
  reads: Reads;
  risk: "none" | "confirm" | "approval";
  approvalRoles: string[];
  idempotent: boolean;
  /** Success makes holds final and locks the inputs that led here. */
  commitPoint: boolean;
  compensate?: CompiledCall;
  reconcile?: CompiledCall;
  holdTtlMs?: number;
  /** How long a confirmation or approval covers a new dispatch (`approval.ttlMs`, else `limits.confirmTtlMs`). */
  reviewTtlMs?: number;
  retry: { max: number; baseMs: number; maxMs: number };
  /** The step that runs it. */
  stepId: string;
  /** Set when a per-item step runs it: the collection whose items it runs for, keyed `name[item]`. */
  forEach?: string;
  /**
   * What the action is, apart from how it is fed and retried (see
   * `actionIdentity`). A move to another version keeps the action's result,
   * holds and confirmations only while this is unchanged.
   */
  identity: string;
}

export interface CompiledRule {
  name: string;
  /** Targets as written: a fact, `collection.field` (of the addressed item) or a collection (the whole list). */
  set: NodeEntries;
  confirm: boolean;
  decline: string[];
  clear: string[];
  retry: boolean;
  cancel: boolean;
  /** Gives the id of the item the rule acts on. */
  item?: Node;
  /** Adds an item to this collection and acts on it. */
  add?: string;
  /** Removes the addressed item from this collection. */
  remove?: string;
  /** Collections the rule settles. */
  settle: string[];
  /** The collection whose item the rule acts on (its step's, its `add`'s or its `item`'s). */
  addresses?: string;
}

export interface CompiledView {
  section: string;
  input: NodeEntries;
  reads: Reads;
  /** The section's key of each fact whose key is not its own name. */
  fields?: Readonly<Record<string, string>>;
}

/** A call step's child flow and input. */
export interface CompiledCallStep {
  flowId: string;
  version: string;
  upgrade: "exact" | "compatible";
  input: NodeEntries;
  reads: Reads;
  timeoutMs?: number;
}

/** What a flow offers callers. */
export interface CompiledInterface {
  input: string[];
  output: string[];
  callableOnly: boolean;
  /** Inputs no step of the flow fills: a caller must supply them. */
  required: string[];
  /** Fingerprint of the interface facts' types and flags; equal hashes are compatible. */
  hash: string;
  /** Facts the outputs depend on, the outputs included. */
  upstream: Set<string>;
}

export interface CompiledStep {
  index: number;
  id: string;
  def: StepDef;
  when?: Node;
  needs: string[];
  fills: string[];
  view?: CompiledView;
  rules: Map<string, CompiledRule>;
  run?: string;
  /** `accept`, when set, must be true (with the event's payload) for the event to apply. */
  wait?: { event: string; correlate: Node; timeoutMs?: number; accept?: Node };
  call?: CompiledCallStep;
  actor?: { roles: string[]; notSubject: boolean };
  deviceCapabilities: string[];
  /** The collection whose items the step runs once each for. */
  forEach?: string;
  /** Instances of a per-item `run` step worked on at once. 1 for every other step. */
  fanOut: number;
}

export interface CompiledFlow {
  id: string;
  version: string;
  /** Fingerprint of the canonical definition. */
  hash: string;
  definition: FlowDefinition;
  facts: Map<string, CompiledFact>;
  actions: Map<string, CompiledAction>;
  steps: CompiledStep[];
  stepById: Map<string, CompiledStep>;
  completeWhen: Node;
  ends: Map<EndKind, CompiledView>;
  /** Reply views by kind; empty when the flow names none. */
  replies: Map<ReplyViewKey, CompiledView>;
  limits: { maxLifetimeMs: number; idleTimeoutMs: number; maxTurns: number; maxEvents: number; maxFactBytes: number; maxItems: number; maxCollectionBytes: number; maxCalls: number; confirmTtlMs?: number };
  staffRoles: string[];
  startRoles: string[];
  entry: Set<string>;
  /** Derived facts in evaluation order. */
  derivedOrder: string[];
  /** Graph node ("f:name" or "a:name") to the nodes that depend on it directly. */
  dependents: Map<string, Set<string>>;
  /** Action to every fact whose change would change its input. */
  upstreamFacts: Map<string, Set<string>>;
  /** Fact to the step whose rules fill it (first such step). */
  filledBy: Map<string, string>;
  /**
   * Fact to the view steps at which a person may give it directly: a rule of
   * the step sets it from the output alone. `values` lists the fixed values
   * the step's rules set, or is null when a rule takes it from the payload.
   */
  askedBy: Map<string, Array<{ stepId: string; values: JsonValue[] | null }>>;
  /** Collections by name (also present in `facts` with `list` set). Empty for flows without collections. */
  collections: Map<string, CompiledCollection>;
  /**
   * Graph edges (`"from>to"`) that stay within one item: a field read as
   * `item.f`, or a per-item result read inside its own item. Every other edge
   * into an item field reaches every item.
   */
  sameItem: Set<string>;
  /**
   * Per-item action to the field templates upstream of it only through
   * same-item edges: a write in flight locks those fields of its own item,
   * and everything else upstream for every item.
   */
  upstreamOwn: Map<string, Set<string>>;
  /**
   * Field template to the steps whose view shows it: per item (`sameItem`, a
   * per-item step showing `item.f`) or as a row of the list. Only fields a
   * person gives (not derived, not secret). A change the view did not make
   * itself gives those views a new instance, because a mounted section's
   * bound row values cannot be overwritten by its host.
   */
  rowBinders: Map<string, Array<{ stepId: string; sameItem: boolean }>>;
  /** Set when the flow declares an interface (it can be called). */
  interface?: CompiledInterface;
  /** Call step to every fact whose change would change or stop its call: input, when and needs, transitively. */
  callUpstream: Map<string, Set<string>>;
  /** The `migrations` entries, by the source version each accepts runs from. */
  migrations: Map<string, CompiledMigration>;
}

export interface CompileResult {
  flow: CompiledFlow | null;
  diagnostics: Diagnostic[];
}

export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export const factNode = (name: string): string => `f:${name}`;
export const actionNode = (name: string): string => `a:${name}`;

/** Validates without keeping the compiled form. */
export function validateFlow(input: unknown): Diagnostic[] {
  return compileFlow(input).diagnostics;
}

/** Compiles or throws {@link DiagnosticsError} listing every problem. */
export function mustCompileFlow(input: unknown): CompiledFlow {
  const { flow, diagnostics } = compileFlow(input);
  if (!flow) throw new DiagnosticsError("flow definition is invalid", diagnostics);
  return flow;
}

export function compileFlow(input: unknown): CompileResult {
  const bag = new DiagnosticBag();
  const flow = compileInto(input, bag);
  if (flow && !bag.hasErrors) checkArithmetic(flow, bag);
  return { flow: bag.hasErrors ? null : flow, diagnostics: withHints(onePerPlace(bag.items)) };
}

/** The first diagnostic of each code at each path: the same report twice at one place is a cascade. */
function onePerPlace(items: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((d) => {
    const key = `${d.code}\u0000${d.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Unknown fields are errors, except `x-*` extensions, which are kept and ignored. */
export function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: PathSegment[], bag: DiagnosticBag): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key) && !key.startsWith("x-")) bag.error("flow/unknown-field", [...path, key], `unknown field "${key}"`);
  }
}

/** Every expression position of a definition, normalised in place (see {@link normaliseExpr}). */
function normaliseExpressions(def: Record<string, JsonValue>): void {
  const at = (obj: JsonValue | undefined, key: string) => {
    if (isJsonObject(obj) && hasOwn(obj, key)) obj[key] = normaliseExpr(obj[key]!);
  };
  const record = (obj: JsonValue | undefined) => {
    if (isJsonObject(obj)) for (const key of Object.keys(obj)) obj[key] = normaliseExpr(obj[key]!);
  };
  const each = (obj: JsonValue | undefined): JsonValue[] => (Array.isArray(obj) ? obj : isJsonObject(obj) ? Object.values(obj) : []);
  for (const fact of each(def.facts)) {
    if (!isJsonObject(fact)) continue;
    at(fact, "derive");
    if (Array.isArray(fact.checks)) for (const check of fact.checks) at(check, "test");
  }
  for (const action of each(def.actions)) {
    if (!isJsonObject(action)) continue;
    record(action.input);
    if (isJsonObject(action.compensate)) record(action.compensate.input);
    if (isJsonObject(action.reconcile)) record(action.reconcile.input);
  }
  for (const collection of each(def.collections)) {
    if (!isJsonObject(collection)) continue;
    for (const field of each(collection.fields)) {
      if (!isJsonObject(field)) continue;
      at(field, "derive");
      if (Array.isArray(field.checks)) for (const check of field.checks) at(check, "test");
    }
  }
  for (const step of each(def.steps)) {
    if (!isJsonObject(step)) continue;
    at(step, "when");
    if (isJsonObject(step.view)) record(step.view.input);
    for (const rule of each(step.on)) {
      if (!isJsonObject(rule)) continue;
      record(rule.set);
      at(rule, "item");
    }
    at(step.wait, "correlate");
    at(step.wait, "accept");
    if (isJsonObject(step.call)) record(step.call.input);
  }
  at(def, "completeWhen");
  for (const view of each(def.ends)) if (isJsonObject(view)) record(view.input);
  for (const view of each(def.replies)) if (isJsonObject(view)) record(view.input);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Facts whose values an expression reads (not merely whether they are known). */
export function valueReads(node: Node, out = new Set<string>()): Set<string> {
  if (node.k === "fact") out.add(node.name);
  for (const child of nodeChildren(node)) valueReads(child, out);
  return out;
}

export const describeNode = (node: string): string => `${node.startsWith("f:") ? "fact" : "action"} ${node.slice(2)}`;
export const quoted = (names: Iterable<string>): string => [...names].map((n) => `"${n}"`).join(", ");

export function optionalString(obj: Record<string, unknown>, key: string, path: PathSegment[], bag: DiagnosticBag, max = 2000): void {
  const v = obj[key];
  if (v !== undefined && (typeof v !== "string" || v.length > max)) bag.error("flow/invalid-field", [...path, key], `${key} must be a string of at most ${max} characters`);
}

export function positiveInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max;
}

/** The definition's private copy, with text expressions as trees, or null when it is not one that can compile. */
function readDefinition(input: unknown, bag: DiagnosticBag): Record<string, JsonValue> | null {
  const jsonIssue = checkJson(input);
  if (jsonIssue) {
    bag.error("flow/not-json", jsonIssue.path, `definition must be plain JSON: ${jsonIssue.message}`);
    return null;
  }
  if (!isJsonObject(input)) {
    bag.error("flow/invalid-shape", [], "definition must be an object");
    return null;
  }
  if (jsonByteLength(input) > MAX_DEFINITION_BYTES) {
    bag.error("flow/too-large", [], `definition is larger than ${MAX_DEFINITION_BYTES} bytes`);
    return null;
  }
  // A private copy with text expressions as trees: what is compiled, stored and hashed.
  const def = cloneJson(input);
  normaliseExpressions(def);
  if (jsonByteLength(def) > MAX_DEFINITION_BYTES) {
    bag.error("flow/too-large", [], `definition is larger than ${MAX_DEFINITION_BYTES} bytes once its text expressions are compiled`);
    return null;
  }
  return def;
}

/** The definition's id, version, title, description and goal. */
function checkHeader(raw: Record<string, unknown>, bag: DiagnosticBag): void {
  if (typeof raw.id !== "string" || !FLOW_ID_RE.test(raw.id)) bag.error("flow/invalid-id", ["id"], "id must be lowercase letters, digits and dashes, starting with a letter");
  if (typeof raw.version !== "string" || !VERSION_RE.test(raw.version)) bag.error("flow/invalid-version", ["version"], "version must be 1-32 letters, digits, dots, plus or dash");
  if (typeof raw.title !== "string" || raw.title.trim() === "" || raw.title.length > 200) bag.error("flow/invalid-field", ["title"], "title must be a non-empty string of at most 200 characters");
  optionalString(raw, "description", [], bag);
  if (raw.goal !== undefined) {
    if (!isJsonObject(raw.goal)) bag.error("flow/invalid-field", ["goal"], "goal must be an object");
    else {
      checkKeys(raw.goal, keysOf("goal"), ["goal"], bag);
      optionalString(raw.goal, "description", ["goal"], bag);
      const phrases = raw.goal.phrases;
      if (phrases !== undefined && (!isStringArray(phrases) || phrases.length > 50 || phrases.some((p) => p.length > 200))) {
        bag.error("flow/invalid-field", ["goal", "phrases"], "phrases must be at most 50 strings of at most 200 characters");
      }
      const names = raw.goal.names;
      if (names !== undefined && (!isStringArray(names) || names.length > MAX_GOAL_NAMES || names.some((n) => n.length > MAX_GOAL_NAME_LENGTH || normaliseName(n) === ""))) {
        bag.error("flow/goal-name-invalid", ["goal", "names"], `names must be at most ${MAX_GOAL_NAMES} non-empty names of at most ${MAX_GOAL_NAME_LENGTH} characters`);
      }
    }
  }
}

function compileInto(input: unknown, bag: DiagnosticBag): CompiledFlow | null {
  const def = readDefinition(input, bag);
  if (!def) return null;
  const raw = def as unknown as Record<string, unknown>;
  checkKeys(raw, keysOf("definition"), [], bag);
  if (raw.schemaVersion !== FLOW_SCHEMA_VERSION) {
    bag.error("flow/schema-version", ["schemaVersion"], `pre-1.0: only format ${FLOW_SCHEMA_VERSION} is accepted (schemaVersion must be ${FLOW_SCHEMA_VERSION})`);
    return null;
  }
  checkHeader(raw, bag);
  const roleList = (key: "staffRoles" | "startRoles"): string[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!isStringArray(v) || v.some((r) => !ROLE_RE.test(r))) {
      bag.error("flow/invalid-role", [key], `${key} must be a list of role names`);
      return [];
    }
    return [...v];
  };
  const staffRoles = roleList("staffRoles");
  const startRoles = roleList("startRoles");

  // --- collections ------------------------------------------------
  const plan: CollectionPlan = planCollections(raw);
  const { collections, fieldReads } = compileCollections(raw, plan, bag, (obj, allowed, path) => checkKeys(obj, allowed, path, bag));
  /** Parse options every expression of the flow shares: the collections and their fields. */
  const shared = { collections: plan.shapes };
  const cx: CompileContext = { bag, raw, plan, collections, fieldReads, shared, mayFill: new Set<string>(), mayFillAny: false };

  const f = compileFacts(cx);
  if (!f) return null;
  const a = compileActions(cx);
  const s = compileSteps(cx, f);
  if (!s) return null;
  const { facts } = f;
  const { actions } = a;
  const { steps, stepById } = s;

  // --- completion, ends, entry, limits -------------------------------------
  const completeParsed = raw.completeWhen === undefined ? null : parseExpr(raw.completeWhen, ["completeWhen"], bag, shared);
  if (raw.completeWhen === undefined) bag.error("flow/invalid-shape", ["completeWhen"], "completeWhen is required");
  const ends = new Map<EndKind, CompiledView>();
  if (raw.ends !== undefined) {
    if (!isJsonObject(raw.ends)) bag.error("flow/invalid-shape", ["ends"], "ends must be an object");
    else
      for (const [kind, rawView] of Object.entries(raw.ends)) {
        if (kind.startsWith("x-")) continue;
        if (!keysOf("ends").includes(kind)) {
          bag.error("flow/unknown-field", ["ends", kind], "ends keys are completed, cancelled, failed and expired");
          continue;
        }
        const v = compileView(cx, rawView, ["ends", kind], false);
        if (v) ends.set(kind as EndKind, v);
      }
  }
  const entry = new Set<string>();
  if (raw.entry !== undefined) {
    if (!isStringArray(raw.entry)) bag.error("flow/invalid-field", ["entry"], "entry must be a list of fact names");
    else for (const f of raw.entry) entry.add(f);
  }
  const limits = compileLimits(cx, actions);
  const migrations = compileMigrations(
    raw.migrations,
    {
      version: raw.version,
      facts: new Map([...facts.values()].map((f) => [f.name, { derived: f.derive !== undefined, ...(f.list ? { list: true } : {}) }])),
      versionPattern: VERSION_RE,
      namePattern: NAME_RE,
      maxFacts: MAX_FACTS,
    },
    bag,
  );
  const iface = compileInterfaceDecl(cx, facts);

  const refs = referenceChecks(cx, f, a, s);
  const replies = checkReferences(cx, f, a, refs, ends, entry, completeParsed);
  for (const step of steps) checkStepReferences(cx, f, a, s, refs, step);
  checkObtainable(cx, f, a, refs, ends, entry, iface);
  const { filledBy, askedBy } = refs;

  if (bag.hasErrors || !completeParsed) return null;

  const graph = compileGraph(cx, f, a, s, refs, completeParsed, iface);
  if (!graph) return null;
  const { dependents, derivedOrder, upstreamFacts, sameItem, upstreamOwn, rowBinders, callUpstream, compiledInterface } = graph;

  const definition = deepFreeze(def) as unknown as FlowDefinition;
  return {
    id: definition.id,
    version: definition.version,
    hash: fingerprint(def),
    definition,
    facts,
    actions,
    steps,
    stepById,
    completeWhen: completeParsed.node,
    ends,
    replies,
    limits,
    staffRoles,
    startRoles,
    entry,
    derivedOrder,
    dependents,
    upstreamFacts,
    filledBy,
    askedBy,
    collections,
    sameItem,
    upstreamOwn,
    rowBinders,
    ...(compiledInterface ? { interface: compiledInterface } : {}),
    callUpstream,
    migrations,
  };
}

export function compileView(cx: CompileContext, rawView: unknown, path: PathSegment[], allowNow: boolean, itemOf?: string, scopes?: ReadonlySet<ExprScope>): CompiledView | null {
  const { bag, raw, shared } = cx;
  if (!isJsonObject(rawView)) {
    bag.error("flow/invalid-shape", path, "view must be an object");
    return null;
  }
  checkKeys(rawView, keysOf("view"), path, bag);
  if (typeof rawView.section !== "string" || !SECTION_RE.test(rawView.section)) {
    bag.error("flow/invalid-section", [...path, "section"], 'section must be a section reference such as "option-list@4"');
  } else if (!rawView.section.includes("@")) {
    bag.warn("flow/section-unversioned", [...path, "section"], `section "${rawView.section}" names no version, so it can change under a published flow; pin one, as in "${rawView.section}@1"`);
  }
  const inputs: [string, Node][] = [];
  const reads = emptyReads();
  if (rawView.input !== undefined) {
    if (!isJsonObject(rawView.input)) bag.error("flow/invalid-shape", [...path, "input"], "view input must be an object of expressions");
    else
      for (const [key, expr] of Object.entries(rawView.input)) {
        const parsed = parseExpr(expr, [...path, "input", key], bag, { ...shared, allowNow, allowItems: true, ...(itemOf !== undefined ? { itemOf } : {}), ...(scopes ? { scopes } : {}) });
        if (parsed) {
          inputs.push([key, parsed.node]);
          mergeReads(reads, parsed.reads);
        }
      }
  }
  let fields: Record<string, string> | undefined;
  if (rawView.fields !== undefined) {
    if (!isJsonObject(rawView.fields) || Object.keys(rawView.fields).length > MAX_VIEW_FIELDS) bag.error("flow/invalid-shape", [...path, "fields"], `view fields map at most ${MAX_VIEW_FIELDS} facts to section keys`);
    else {
      fields = {};
      const keys = new Set<string>();
      for (const [fact, key] of Object.entries(rawView.fields)) {
        const fpath = [...path, "fields", fact];
        if (!isJsonObject(raw.facts) || !Object.hasOwn(raw.facts, fact)) bag.error("flow/unknown-fact", fpath, `unknown fact "${fact}"`);
        else if (typeof key !== "string" || !FIELD_KEY_RE.test(key)) bag.error("flow/invalid-field", fpath, "a section key is a dotted path of names, such as \"contact.phone\"");
        else if (keys.has(key)) bag.error("flow/invalid-field", fpath, `two facts use the section key "${key}"`);
        else {
          keys.add(key);
          Object.defineProperty(fields, fact, { value: key, enumerable: true, writable: true, configurable: true });
        }
      }
    }
  }
  return { section: typeof rawView.section === "string" ? rawView.section : "", input: inputs, reads, ...(fields ? { fields } : {}) };
}

// --- limits and interface ------------------------------------------------

function compileLimits(cx: CompileContext, actions: Map<string, CompiledAction>): CompiledFlow["limits"] {
  const { bag, raw } = cx;
  const limits = { ...DEFAULT_LIMITS, ...COLLECTION_LIMITS } as CompiledFlow["limits"];
  if (raw.limits !== undefined) {
    if (!isJsonObject(raw.limits)) bag.error("flow/invalid-shape", ["limits"], "limits must be an object");
    else {
      checkKeys(raw.limits, keysOf("limits"), ["limits"], bag);
      for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>) {
        const v = raw.limits[key];
        if (v === undefined) continue;
        if (!positiveInt(v, LIMIT_CEILINGS[key])) bag.error("flow/invalid-limit", ["limits", key], `${key} must be a positive integer up to ${LIMIT_CEILINGS[key]}`);
        else limits[key] = v;
      }
      for (const key of Object.keys(COLLECTION_LIMITS) as Array<keyof typeof COLLECTION_LIMITS>) {
        const v = raw.limits[key];
        if (v === undefined) continue;
        if (!positiveInt(v, COLLECTION_LIMIT_CEILINGS[key])) bag.error("flow/invalid-limit", ["limits", key], `${key} must be a positive integer up to ${COLLECTION_LIMIT_CEILINGS[key]}`);
        else limits[key] = v;
      }
      const confirmTtl = raw.limits.confirmTtlMs;
      if (confirmTtl !== undefined) {
        if (!positiveInt(confirmTtl, MAX_REVIEW_TTL_MS)) bag.error("flow/invalid-limit", ["limits", "confirmTtlMs"], `confirmTtlMs must be a positive integer up to ${MAX_REVIEW_TTL_MS}`);
        else limits.confirmTtlMs = confirmTtl;
      }
    }
  }
  // A review lasts for the action's own time to live, else the flow's.
  if (limits.confirmTtlMs !== undefined) {
    for (const action of actions.values()) if (action.risk !== "none" && action.reviewTtlMs === undefined) action.reviewTtlMs = limits.confirmTtlMs;
  }
  return limits;
}

function compileInterfaceDecl(cx: CompileContext, facts: Map<string, CompiledFact>): { input: string[]; output: string[]; callableOnly: boolean } | undefined {
  const { bag, raw } = cx;
  let iface: { input: string[]; output: string[]; callableOnly: boolean } | undefined;
  if (raw.interface !== undefined) {
    const rawIface = raw.interface;
    if (!isJsonObject(rawIface)) bag.error("flow/invalid-shape", ["interface"], "interface must be an object");
    else {
      checkKeys(rawIface, keysOf("interface"), ["interface"], bag);
      const names = (key: "input" | "output"): string[] => {
        const v = rawIface[key];
        if (v === undefined) return [];
        if (!isStringArray(v) || v.length > MAX_FACTS) {
          bag.error("flow/invalid-field", ["interface", key], `interface.${key} must be a list of fact names`);
          return [];
        }
        return [...new Set(v)];
      };
      const input = names("input");
      const output = names("output");
      // A list is not a fact a call can carry: its items' ids are the engine's, minted in one run.
      const listCrossing = (name: string, key: "input" | "output") =>
        bag.error("flow/interface-collection", ["interface", key], `"${name}" is a collection, and a call carries facts only: ${key === "input" ? "take the rows as a plain array fact" : "return a fact derived from the list"}`);
      for (const name of input) {
        const fact = facts.get(name);
        if (!fact) bag.error("flow/interface-input", ["interface", "input"], `unknown fact "${name}"`);
        else if (fact.list) listCrossing(name, "input");
        else if (fact.derive) bag.error("flow/interface-input", ["interface", "input"], `derived fact "${name}" cannot be supplied by a caller`);
      }
      for (const name of output) {
        const fact = facts.get(name);
        if (!fact) bag.error("flow/interface-output", ["interface", "output"], `unknown fact "${name}"`);
        else if (fact.list) listCrossing(name, "output");
      }
      if (rawIface.callableOnly !== undefined && typeof rawIface.callableOnly !== "boolean") bag.error("flow/invalid-field", ["interface", "callableOnly"], "callableOnly must be a boolean");
      iface = { input, output, callableOnly: rawIface.callableOnly === true };
    }
  }
  return iface;
}

/** Splits a pinned flow reference, "id@version". Null when it is not one. */
export function parseFlowRef(ref: unknown): { flowId: string; version: string } | null {
  if (typeof ref !== "string") return null;
  const at = ref.indexOf("@");
  if (at < 0) return null;
  const flowId = ref.slice(0, at);
  const version = ref.slice(at + 1);
  return FLOW_ID_RE.test(flowId) && VERSION_RE.test(version) ? { flowId, version } : null;
}

/**
 * Fingerprint of an interface: each fact's type, sensitivity and flags, and
 * which inputs are required. Two versions with equal hashes can stand in for
 * each other under `upgrade: "compatible"`.
 */
export function interfaceHash(facts: Map<string, CompiledFact>, input: string[], output: string[], required: string[]): string {
  const describe = (name: string) => {
    const fact = facts.get(name)!;
    return { name, type: fact.schema as unknown as JsonValue, sensitivity: fact.sensitivity, userAsserted: fact.def.userAsserted === true, optional: fact.def.optional === true };
  };
  return fingerprint({
    input: [...input].sort().map((name) => ({ ...describe(name), required: required.includes(name) })),
    output: [...output].sort().map(describe),
  });
}

/** Every node reachable from `start` (not including it). */
export function downstream(flow: CompiledFlow, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.pop()!;
    for (const next of flow.dependents.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
