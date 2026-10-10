/**
 * The flow definition format: plain JSON, versioned, validated before use.
 *
 * A flow declares the facts it needs, the actions it may call, and ordered
 * steps that ask for facts, call actions or wait for outside events. The
 * engine works out which step comes next from what is already known, so a
 * person who gives everything up front skips straight to the first gap, and
 * a changed answer clears only what depended on it.
 *
 * The format knows nothing about any business, app, channel or vendor.
 */

import type { Risk } from "@aaply/action-contract";
import type { Expr } from "./expr.js";
import type { JsonValue } from "./json.js";
import type { JsonSchema } from "./schema.js";
import type { ReplyViews } from "./reply.js";
import type { FillMode } from "./state.js";

export type { FillMode };

/**
 * The definition format. Pre-1.0 there is exactly one: a definition must
 * declare `schemaVersion: 3`, and anything else is refused
 * (`flow/schema-version`). The number stays in every definition so an engine
 * refuses a format it does not know instead of misreading it.
 */
export const FLOW_SCHEMA_VERSION = 3 as const;
/** The definition format: only {@link FLOW_SCHEMA_VERSION}. */
export type FlowSchemaVersion = typeof FLOW_SCHEMA_VERSION;

/**
 * `x-*` keys: extension data (tool hints, editor state) that the engine
 * allows on every definition object and ignores. They must be plain JSON.
 */
export interface Extensions {
  [key: `x-${string}`]: JsonValue;
}

export interface FlowDefinition extends Extensions {
  schemaVersion: FlowSchemaVersion;
  /** Stable id within an app, e.g. "book-appointment". */
  id: string;
  /** Immutable published version, e.g. "3" or "1.2.0". */
  version: string;
  title: string;
  description?: string;
  /**
   * Helps a decision model recognise when a person wants this flow. `names`
   * are exact names the runtime matches without a model: at most
   * 10, of at most 80 characters.
   */
  goal?: { description?: string; phrases?: string[]; names?: string[] } & Extensions;
  /** App roles allowed to act on runs they did not start (staff, approvers). */
  staffRoles?: string[];
  /** When set, only actors holding one of these app roles may start the flow. */
  startRoles?: string[];
  /** Facts that may be supplied when a run starts (deep links, a switch). */
  entry?: string[];
  facts: Record<string, FactDef>;
  actions?: Record<string, ActionDef>;
  steps: StepDef[];
  /** The run completes as soon as this is true. */
  completeWhen: Expr;
  /** Views shown once a run has ended. */
  ends?: Partial<Record<EndKind, ViewDef>> & Extensions;
  /**
   * Sections that present `turn`'s text replies while this flow is
   * active, by reply kind or `default`. Inputs read the reply as
   * `{"payload": [...]}` and may read non-secret facts.
   */
  replies?: ReplyViews & Extensions;
  limits?: FlowLimits;
  /** Makes the flow callable from another flow's `call` step. */
  interface?: InterfaceDef;
  /**
   * Lists of items with stable ids, each item holding typed fields.
   * They share the fact namespace: `{"fact": "attendees"}` reads one.
   */
  collections?: Record<string, CollectionDef>;
  /**
   * The earlier versions whose live runs may move to this one, and how their
   * facts carry over. A version not listed is never migrated from.
   */
  migrations?: MigrationDef[];
}

/**
 * How runs of earlier versions move to this one. Same-named facts carry over
 * when their values still pass this version's rules; the lists say what else
 * happens.
 */
export interface MigrationDef extends Extensions {
  /** The versions this entry accepts runs from. */
  from: string | string[];
  /** Old fact name to the new one; the value, its provenance and who gave it carry over. */
  rename?: Record<string, string>;
  /** Facts (new names) asked again, with the old value as prefill. */
  reask?: string[];
  /** Facts (new names) that carry nothing over, not even a prefill. */
  drop?: string[];
}

/**
 * What a flow offers to callers. Only a flow with an interface can
 * be called; its input and output are facts it declares.
 */
export interface InterfaceDef extends Extensions {
  /** Facts a caller supplies when the call starts the run. Never derived. */
  input?: string[];
  /** Facts returned to the caller when the run completes. */
  output?: string[];
  /** Only another flow may start it: left out of discovery and refused by `start`. */
  callableOnly?: boolean;
}

/** A step that runs another flow as a child run and waits for its end. */
export interface CallDef extends Extensions {
  /** The child flow, always pinned: "id@version". */
  flow: string;
  /** compatible: the child's current version when its interface hash equals the pinned one's. Default exact. */
  upgrade?: "exact" | "compatible";
  /** Child interface input fact to an expression over the caller's facts and results. */
  input: Record<string, Expr>;
  /** The child is cancelled when it has not ended this long after the call started. */
  timeoutMs?: number;
}

export type EndKind = "completed" | "cancelled" | "failed" | "expired";

export interface FlowLimits extends Extensions {
  /** A run expires this long after it starts. Default 30 days. */
  maxLifetimeMs?: number;
  /** A run expires after this long without a person's input. Default 7 days. */
  idleTimeoutMs?: number;
  /** Most inputs a person may send to one run. Default 500. */
  maxTurns?: number;
  /** Most recorded events in one run. Default 5000. */
  maxEvents?: number;
  /** Largest value one fact may hold, in UTF-8 bytes. Default 64 KiB. */
  maxFactBytes?: number;
  /** Most live items across the run's collections. Default 200, at most 2000. */
  maxItems?: number;
  /** Largest total of one collection's field values, in UTF-8 bytes. Default 256 KiB, at most 2 MiB. */
  maxCollectionBytes?: number;
  /** Most child runs one run may start, re-calls included. Default 20. */
  maxCalls?: number;
  /**
   * How long a confirmation or approval covers a new dispatch, for
   * every action that does not set its own `approval.ttlMs`. No default:
   * without it, a review lasts until its input changes.
   */
  confirmTtlMs?: number;
}

export type Sensitivity = "none" | "personal" | "secret";

export interface FactDef extends Extensions {
  type: JsonSchema;
  title?: string;
  /** How to ask for this fact in text channels. */
  prompt?: string;
  /** personal: redacted from traces. secret: also never shown back in views. Default personal. */
  sensitivity?: Sensitivity;
  /** Only the person may state this; a model's extraction is never accepted. */
  userAsserted?: boolean;
  /** A value a model extracted must be confirmed by the person before use. */
  confirm?: boolean;
  /**
   * How far an assistant's value may go without the person (ADR
   * 0008). `never`: not taken; `suggest`: offered, never written; `confirm`
   * (the default): written and marked, the person's submit confirms it;
   * `auto`: written as valid. A tenant's policy can only tighten it.
   */
  fill?: FillMode;
  /** The person may decline to give it. Declined facts read as null. */
  optional?: boolean;
  /** Computed from other facts and results; never asked for. */
  derive?: Expr;
  /** Extra facts whose change should clear this one. */
  dependsOn?: string[];
  /**
   * A setting a step's rules change to steer what the step shows, such as a
   * page number or a search filter. It does not depend on the results shown
   * in the step that sets it, and never counts towards a step's fills.
   */
  parameter?: boolean;
  /** Further rules; `{"value": []}` is the candidate value. Each test must be true. */
  checks?: FactCheck[];
}

/**
 * A list of items. Each item has an id the engine mints and the
 * fields declared here; each field keeps a fact's state (status, provenance,
 * issues). The list itself is an answer too: it is complete once someone
 * settles it (`settle`), and it reads as known only then.
 */
export interface CollectionDef extends Extensions {
  title?: string;
  /** How to ask for the list in text channels. */
  prompt?: string;
  /** Fewest items a settled list may have. Default 0. */
  min?: number;
  /** Most items the list may have: 1 to 500. */
  max: number;
  /** The fields of each item, 1 to 50. `id` is reserved. */
  fields: Record<string, ItemFieldDef>;
  /** Facts whose change unsettles the list (its items are kept). */
  dependsOn?: string[];
}

/**
 * A field of every item. Like a fact, without `parameter`. Its `derive`,
 * `checks` and `dependsOn` read the same item's fields as `item.<field>`
 * (`dependsOn` names them `collection.field`).
 */
export type ItemFieldDef = Omit<FactDef, "parameter">;

export interface FactCheck extends Extensions {
  test: Expr;
  message: string;
  code?: string;
}

export type EffectKind = "read" | "write";
// The review an action needs; shared with performers through @aaply/action-contract.
export type { Risk };

export interface ActionCall extends Extensions {
  /** Action id in the connector catalog, e.g. "calendar.findSlots". */
  action: string;
  /** Connection role the app binds to a real account, e.g. "businessCalendar". */
  connection?: string;
  input: Record<string, Expr>;
  timeoutMs?: number;
  /**
   * The operation-contract digest (`sha256:<hex>`) this call was
   * published against (`pinActionContracts`). The performer refuses the call
   * when it no longer serves that contract.
   */
  contract?: string;
}

export interface ActionDef extends ActionCall {
  effect: EffectKind;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** confirm: the person reviews the exact input first. approval: someone holding approval.roles does. */
  risk?: Risk;
  /**
   * Who may approve, for risk `approval`. `ttlMs`: how long a
   * confirmation or approval of this action covers a new dispatch (it
   * overrides `limits.confirmTtlMs`); past it, the person is asked again.
   */
  approval?: { roles: string[]; ttlMs?: number } & Extensions;
  /** Whose authority the call uses. Default business. */
  actingFor?: "business" | "endUser";
  /** The backend de-duplicates on the idempotency key, so the write may be retried. */
  idempotent?: boolean;
  /** Undoes a successful write; `{"resource": ["input"|"output", ...]}` reads what was written. */
  compensate?: ActionCall;
  /** A read that reports whether an uncertain write happened: `{applied: boolean, output?}`. */
  reconcile?: ActionCall;
  /** Cannot be undone. Required for writes without `compensate`. */
  irreversible?: boolean;
  /** Commit point: earlier holds become final and the inputs that led here are locked. */
  commit?: boolean;
  /** The write holds something temporarily (a slot, a seat, stock). */
  hold?: { ttlMs: number } & Extensions;
  retry?: { max?: number; baseMs?: number; maxMs?: number } & Extensions;
}

export interface ViewDef extends Extensions {
  /** Facet section reference, e.g. "option-list@4". */
  section: string;
  input?: Record<string, Expr>;
  /**
   * The section's key for each fact the step fills, where it is
   * not the fact's own name (`{"when": "date"}`). An assistant's fills and
   * the `fields` slot use these keys.
   */
  fields?: Record<string, string>;
}

export interface Rule extends Extensions {
  /**
   * Facts to set; `{"payload": [...]}` reads the output's payload. A key
   * `collection.field` sets a field of the item the rule acts on, and a key
   * naming a collection replaces the whole list (rows matched by `id`).
   */
  set?: Record<string, Expr>;
  /** Confirms this step's action with the exact input the person saw. */
  confirm?: boolean;
  /** Optional facts the person declines to give (or `collection.field` of the item the rule acts on). */
  decline?: string[];
  /**
   * Facts to clear (for example to go back and choose again). A collection
   * name unsettles the list and keeps its items; `collection.field` clears a
   * field of the item the rule acts on.
   */
  clear?: string[];
  /** Tries this step's failed action again. */
  retry?: boolean;
  /** Cancels the run. */
  cancel?: boolean;
  /**
   * The item the rule acts on: an expression giving a live item
   * id, usually from the payload. Not allowed in a `forEach` step, which acts
   * on its own item.
   */
  item?: Expr;
  /** Adds an item to this collection and acts on it. */
  add?: string;
  /** Removes the item the rule acts on from this collection. */
  remove?: string;
  /** States that these collections are complete as they stand. */
  settle?: string[];
}

export interface WaitDef extends Extensions {
  /** Name of the outside event, e.g. "payment.completed". */
  event: string;
  /** Value an incoming event must carry to reach this run. */
  correlate: Expr;
  /** The event applies only when this is true; `{"payload": [...]}` reads the event's payload. */
  accept?: Expr;
  timeoutMs?: number;
}

export interface StepDef extends Extensions {
  id: string;
  title?: string;
  /** The step applies only when this is true. */
  when?: Expr;
  /** Facts that must be known before the step starts. */
  needs?: string[];
  /** Facts this step is responsible for. Inferred from `on` when omitted. */
  fills?: string[];
  view?: ViewDef;
  /**
   * Output name to rule. A wait step also has a rule named after its event, and may have one for
   * "timeout". A call step answers its child's end with rules named completed, failed, cancelled,
   * expired and timeout.
   */
  on?: Record<string, Rule>;
  /** Action this step calls. */
  run?: string;
  wait?: WaitDef;
  /** Another flow this step runs as a child; its end is answered by rules named after the end. */
  call?: CallDef;
  /**
   * Who may answer this step. Default: the person the run belongs to (and
   * staff). A step running an approval action defaults to its approval roles,
   * excluding the run's own person.
   */
  actor?: { roles?: string[]; notSubject?: boolean } & Extensions;
  /** Device features the section may use through Host.runAction (device.* only). */
  deviceCapabilities?: string[];
  /**
   * Runs the step once per item of this collection, in list order.
   * Its `when`, view, rules and action read the item as `item.<field>`, and
   * its rules set the item's fields as `collection.field`.
   */
  forEach?: string;
  /** How many items a per-item `run` step works on at once: 1 (default) to 16. */
  fanOut?: number;
}
