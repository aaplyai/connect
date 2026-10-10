/**
 * The keys of every object in the definition format, as data: for each key,
 * whether a definition must give it (`required`).
 *
 * The compiler reads its lists of allowed keys from here (`keysOf`), so the
 * keys it accepts and the keys this table lists cannot drift apart, and the
 * authoring toolkit generates the format's JSON Schema from it. The table is
 * type-checked against definition.ts in both directions: a key added to a
 * type there and not here, or listed here and not there, or a `required`
 * that disagrees with the type's optionality, fails the typecheck. It is
 * deep-frozen, so nothing can widen what the compiler accepts at run time.
 *
 * A definition's reply views (`replies`) are compiled as views
 * (`compileView`), so they take the `view` row, `fields` included;
 * `ReplyViewDef` (reply.ts) types only the keys a decision
 * policy's reply views take. Pure data: only type imports.
 */

import type { FlowDefinition } from "./definition.js";

/** Every object of the definition format whose keys the compiler checks. */
export type DefinitionObject =
  | "definition"
  | "goal"
  | "fact"
  | "check"
  | "collection"
  | "itemField"
  | "actionCall"
  | "action"
  | "approval"
  | "hold"
  | "retry"
  | "view"
  | "step"
  | "rule"
  | "wait"
  | "actor"
  | "call"
  | "limits"
  | "interface"
  | "migration"
  | "ends";

/** What the table says about one key. */
export interface KeyInfo {
  /** Whether a definition must give the key wherever the object appears. */
  readonly required: boolean;
}

type Defined<T> = Exclude<T, undefined>;
type FactDef = Defined<FlowDefinition["facts"][string]>;
type CollectionDef = Defined<Defined<FlowDefinition["collections"]>[string]>;
type ActionDef = Defined<Defined<FlowDefinition["actions"]>[string]>;
type StepDef = FlowDefinition["steps"][number];

/** The keys of `T` the table lists: every key but the `x-*` extensions. */
type Keys<T> = Exclude<keyof T & string, `x-${string}`>;
/** `true` when `K` is optional in `T`. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
/** One row: exactly the keys of `T`, each with `required` set by `T`'s optionality. */
type Row<T> = { readonly [K in Keys<T>]-?: { readonly required: IsOptional<T, K> extends true ? false : true } };

/**
 * The type the table must satisfy: for each object, a row whose keys are
 * exactly the keys its type in definition.ts declares. Exported so a test
 * can show that a missing or an extra key does not type-check.
 */
export interface DefinitionKeyShapes {
  definition: Row<FlowDefinition>;
  goal: Row<Defined<FlowDefinition["goal"]>>;
  fact: Row<FactDef>;
  check: Row<Defined<FactDef["checks"]>[number]>;
  collection: Row<CollectionDef>;
  itemField: Row<CollectionDef["fields"][string]>;
  actionCall: Row<Defined<ActionDef["compensate"]>>;
  action: Row<ActionDef>;
  approval: Row<Defined<ActionDef["approval"]>>;
  hold: Row<Defined<ActionDef["hold"]>>;
  retry: Row<Defined<ActionDef["retry"]>>;
  view: Row<Defined<StepDef["view"]>>;
  step: Row<StepDef>;
  rule: Row<Defined<StepDef["on"]>[string]>;
  wait: Row<Defined<StepDef["wait"]>>;
  actor: Row<Defined<StepDef["actor"]>>;
  call: Row<Defined<StepDef["call"]>>;
  limits: Row<Defined<FlowDefinition["limits"]>>;
  interface: Row<Defined<FlowDefinition["interface"]>>;
  migration: Row<Defined<FlowDefinition["migrations"]>[number]>;
  ends: Row<Defined<FlowDefinition["ends"]>>;
}

/** Recursively freezes a plain value and returns it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const opt = { required: false } as const;
const req = { required: true } as const;

/**
 * Every key of every definition object, and whether it is required. `x-*` keys are allowed on every object and
 * are not listed. Deep-frozen.
 */
export const DEFINITION_KEYS = deepFreeze({
  definition: {
    schemaVersion: req,
    id: req,
    version: req,
    title: req,
    description: opt,
    goal: opt,
    staffRoles: opt,
    startRoles: opt,
    entry: opt,
    facts: req,
    actions: opt,
    steps: req,
    completeWhen: req,
    ends: opt,
    limits: opt,
    collections: opt,
    interface: opt,
    migrations: opt,
    replies: opt,
  },
  goal: { description: opt, phrases: opt, names: opt },
  fact: { type: req, title: opt, prompt: opt, sensitivity: opt, userAsserted: opt, confirm: opt, optional: opt, parameter: opt, derive: opt, dependsOn: opt, checks: opt, fill: opt },
  check: { test: req, message: req, code: opt },
  collection: { title: opt, prompt: opt, min: opt, max: req, fields: req, dependsOn: opt },
  itemField: { type: req, title: opt, prompt: opt, sensitivity: opt, userAsserted: opt, confirm: opt, optional: opt, derive: opt, dependsOn: opt, checks: opt, fill: opt },
  actionCall: { action: req, connection: opt, input: req, timeoutMs: opt, contract: opt },
  action: {
    action: req,
    connection: opt,
    input: req,
    timeoutMs: opt,
    contract: opt,
    effect: req,
    inputSchema: opt,
    outputSchema: opt,
    risk: opt,
    approval: opt,
    actingFor: opt,
    idempotent: opt,
    compensate: opt,
    reconcile: opt,
    irreversible: opt,
    commit: opt,
    hold: opt,
    retry: opt,
  },
  approval: { roles: req, ttlMs: opt },
  hold: { ttlMs: req },
  retry: { max: opt, baseMs: opt, maxMs: opt },
  view: { section: req, input: opt, fields: opt },
  step: { id: req, title: opt, when: opt, needs: opt, fills: opt, view: opt, on: opt, run: opt, wait: opt, call: opt, actor: opt, deviceCapabilities: opt, forEach: opt, fanOut: opt },
  rule: { set: opt, confirm: opt, decline: opt, clear: opt, retry: opt, cancel: opt, item: opt, add: opt, remove: opt, settle: opt },
  wait: { event: req, correlate: req, accept: opt, timeoutMs: opt },
  actor: { roles: opt, notSubject: opt },
  call: { flow: req, upgrade: opt, input: req, timeoutMs: opt },
  limits: { maxLifetimeMs: opt, idleTimeoutMs: opt, maxTurns: opt, maxEvents: opt, maxFactBytes: opt, maxCalls: opt, maxItems: opt, maxCollectionBytes: opt, confirmTtlMs: opt },
  interface: { input: opt, output: opt, callableOnly: opt },
  migration: { from: req, rename: opt, reask: opt, drop: opt },
  ends: { completed: opt, cancelled: opt, failed: opt, expired: opt },
} as const satisfies DefinitionKeyShapes);

const KEY_LISTS: ReadonlyMap<DefinitionObject, readonly string[]> = new Map(
  (Object.keys(DEFINITION_KEYS) as DefinitionObject[]).map((object) => [object, Object.freeze(Object.keys(DEFINITION_KEYS[object]))]),
);

/** The keys `object` allows, besides `x-*` extensions, in table order (frozen). */
export function keysOf(object: DefinitionObject): readonly string[] {
  return KEY_LISTS.get(object) ?? [];
}
