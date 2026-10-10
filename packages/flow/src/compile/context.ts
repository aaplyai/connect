/**
 * What the compiler's section compilers share while one definition compiles,
 * and what each section hands the ones after it.
 */

import type { CollectionPlan, compileCollections } from "../collections-compile.js";
import type { DiagnosticBag } from "../diagnostics.js";
import type { Reads, Node } from "../expr.js";
import type { CompiledFact, CompiledAction, CompiledStep } from "../compile.js";

/** What the section compilers share while one definition compiles. */
export interface CompileContext {
  readonly bag: DiagnosticBag;
  /** The private copy being compiled. */
  readonly raw: Record<string, unknown>;
  readonly plan: CollectionPlan;
  readonly collections: ReturnType<typeof compileCollections>["collections"];
  readonly fieldReads: ReturnType<typeof compileCollections>["fieldReads"];
  /** Parse options every expression of the flow shares: the collections and their fields. */
  readonly shared: { collections: CollectionPlan["shapes"] };
  /** What a derivation, rule or step that did not compile may fill; `mayFillAny` when that cannot be told. */
  readonly mayFill: Set<string>;
  mayFillAny: boolean;
}

/** The facts section, compiled: the facts and collections by name, and what each reads. */
export interface FactsSection {
  facts: Map<string, CompiledFact>;
  factReads: Map<string, Reads>;
  deriveReads: Map<string, Reads>;
  /** A fact, a collection, or an item field by its template address `collection.field`. */
  factOrField: (name: string) => CompiledFact | undefined;
  /** A fact, a collection or an item field the definition declares, that failed its own check. */
  declaredBroken: (name: string) => boolean;
}

/** The actions section, compiled, and the definition's own `actions` as given. */
export interface ActionsSection {
  actions: Map<string, CompiledAction>;
  rawActions: unknown;
}

/** The steps, compiled, and what each reads, shows, asks and could not compile. */
export interface StepsSection {
  steps: CompiledStep[];
  stepById: Map<string, CompiledStep>;
  /** Reads the step's fills depend on: when, needs, rules, the wait's correlate and accept. */
  stepFillReads: Map<string, Reads>;
  /** Results the step's view shows: the choices offered, so a pick depends on them. */
  stepShownResults: Map<string, Set<string>>;
  /** Facts set by rules a view output (a person) triggers, with what each expression reads. */
  stepPersonSets: Map<string, Array<[string, Reads, Node]>>;
  /** Collections a view step's own rules add to, remove from or settle. */
  stepListAsks: Map<string, Set<string>>;
  correlateReads: Map<string, Reads>;
  /** What decides whether a call step's call is still wanted: its when, needs and input. */
  callStartReads: Map<string, Reads>;
  /** What a step's own faults leave unknown, so the checks that depend on it stay quiet (one fault, one diagnostic). */
  stepFaults: Map<string, StepFaults>;
}

/** Where a rule is compiled: the definition's collections and the step's own collection. */
export interface RuleContext {
  shapes: ReadonlyMap<string, ReadonlySet<string>>;
  forEach?: string;
}

/** What one step's own faults leave unknown, so the checks that depend on it stay quiet. */
export interface StepFaults {
  /** Rules that did not compile whole, by output name; "all" when `on` itself did not. */
  rules: Set<string> | "all";
  /** What the step fills cannot be told. */
  fills: boolean;
  /** Its view did not compile. */
  view: boolean;
  /** Its wait or call did not compile. */
  shape: boolean;
}
