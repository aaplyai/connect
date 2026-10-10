/**
 * Views: what a channel should show for a run right now.
 *
 * A view is channel-neutral. It names the current step's section and its
 * input, the facts still being asked for, what is already known (for an
 * editable summary), any confirmation the person must give, and notices.
 * Web and native render it through Facet; a text channel can render the
 * same view as a question.
 */

import { keyOf } from "./address.js";
import { CALL_END_RULES, type CompiledFlow, type CompiledStep } from "./compile.js";
import { displayValue } from "./display.js";
import type { EndKind } from "./definition.js";
import { type Node } from "./expr.js";
import { evaluate } from "./expr-eval.js";
import { liveItems } from "./items.js";
import { own, type JsonObject, type JsonValue } from "./json.js";
import type { BusyReason } from "./lanes.js";
import { publicError, RunReader, type StepStatus } from "./reader.js";
import { fieldAsk, knownList } from "./view-items.js";
import { secretsOf } from "./secrets.js";
import type { JsonSchema } from "./schema.js";
import { isTerminal, type ActionError, type ActorRef, type AssistBasis, type FactIssue, type FactStatus, type Notice, type Provenance, type RunState, type RunStatus, type RunUpdate } from "./state.js";

/** `calling`: the current step waits for a child run, whose view the runtime nests as `call`. */
export type ViewStatus = "asking" | "confirming" | "working" | "waiting" | "paused" | "failed" | "attention" | "blocked" | "ended" | "calling";

/** Shown in place of values that come from secret facts. */
export const REDACTED = "••••••";

export interface Ask {
  /** The fact, the list, or (in a per-item step) the item's field as `collection.field`. */
  fact: string;
  /** The item whose field this is (per-item steps only). */
  item?: string;
  title?: string;
  prompt?: string;
  status: FactStatus;
  optional: boolean;
  schema: JsonSchema;
  /** A previous or proposed value to prefill (never for secret facts). */
  previous?: JsonValue;
  issues?: FactIssue[];
  /** The assistant wrote `previous` in this turn; the person's submit confirms it, or an undo of the turn restores what was there. */
  assisted?: { turn: string };
  /** A value the assistant offered but did not write (never for secret facts). */
  proposed?: { value: JsonValue; basis: AssistBasis; turn: string };
}

/** A value the assistant offered for a fact, waiting for the person to accept or dismiss it. */
export interface ViewSuggestion {
  fact: string;
  /** The section's key for the fact. */
  key: string;
  value: JsonValue;
  display: string;
  basis: AssistBasis;
  /** The assistant's turn that offered it. */
  turn: string;
}

/**
 * One field of a step, for a section that shows only what is missing and
 * shows known values as text (ADR 0012): the engine, not the section, says
 * what is known.
 */
export interface ViewField {
  fact: string;
  /** The section's key for it (the view's `fields` mapping, or the fact's name). */
  key: string;
  title?: string;
  /**
   * `missing`: ask for it. `known`: show it as text. `assisted`: the
   * assistant filled it; show the input, filled and marked. `invalid`: ask
   * again, with `issues`. `confirm`: a value waiting for the person's yes.
   */
  state: "missing" | "known" | "assisted" | "invalid" | "confirm";
  /** The value (masked when secret): the known, assisted, or previous one. */
  value?: JsonValue;
  /** The value as text in the run's locale and time zone. */
  display?: string;
  provenance?: Provenance;
  optional: boolean;
  /** The person may change it here. */
  editable: boolean;
  issues?: FactIssue[];
  /** The assistant's turn that wrote it, while it is marked. */
  turn?: string;
  /**
   * An assistant's value still waiting for the person's yes
   * (`needs_confirmation`): the run does not move on until the person
   * confirms it (submits it, accepts it, or says yes) or changes it.
   */
  waiting?: true;
}

export interface KnownFact {
  fact: string;
  title?: string;
  value: JsonValue;
  provenance?: Provenance;
  /** The assistant wrote it as valid (`fill: auto`) and nobody has changed it since. */
  assisted?: { turn: string };
  /** The person may change it from a summary. */
  editable: boolean;
  /**
   * A settled list: its items in order, each with the fields known
   * so far (secret fields left out), and what the person may do from a
   * summary. Change them with item ops in a `facts` submission.
   */
  items?: KnownItem[];
  /** An item may be added from a summary. */
  addable?: boolean;
}

/** One item of a settled list, as a summary shows it. */
export interface KnownItem {
  id: string;
  /** From its fields: complete when every field a person gives is valid or declined. */
  status: "complete" | "incomplete" | "invalid" | "needs_confirmation";
  /** Its known fields; each `fact` is `collection.field`. */
  fields: KnownFact[];
  /** It may be removed from a summary. */
  removable: boolean;
}

export interface ViewStep {
  id: string;
  title?: string;
  section?: string;
  input: JsonObject;
  /** Stable while the step's answers stand; changes when they are cleared from elsewhere. */
  instanceKey: string;
  epoch: number;
  /**
   * The item a per-item step is asking about. `index` and `count` are for
   * display only ("2 of 3"); outputs send `id` back as their `item`.
   */
  item?: { collection: string; id: string; index: number; count: number };
  outputs: string[];
  /** The outputs that confirm the pending action (send `confirm.digest` with them). */
  confirmOutputs: string[];
  asks: Ask[];
  /**
   * Every fact the step fills, with what is known about it (a submit that
   * leaves out a key keeps its fact). Never for a per-item step.
   */
  fields?: ViewField[];
  /** The assistant's latest turn that still marks values in this step, for one announcement and one undo. */
  assist?: { turn: string; facts: string[] };
  /** Values the assistant offered for this step's facts, for the person to accept or dismiss. */
  suggestions?: ViewSuggestion[];
  /**
   * Present when the person must confirm exactly this input before it is
   * sent. Values from secret facts are replaced with {@link REDACTED}; the
   * digest still covers the real values.
   */
  confirm?: { action: string; digest: string; input: JsonObject };
  error?: ActionError;
  deviceCapabilities: string[];
  /** The child run a calling step waits for. */
  call?: { runId: string; flowId: string };
}

export interface FlowView {
  runId: string;
  flowId: string;
  flowVersion: string;
  revision: number;
  run: RunStatus;
  status: ViewStatus;
  step: ViewStep | null;
  end?: { kind: EndKind; reason?: string; section?: string; input?: JsonObject; instanceKey: string };
  known: KnownFact[];
  notices: Notice[];
  /**
   * What changed since the person last acted: the run moved to another
   * version (and which answers it needs again), or its version was withdrawn.
   * Shown until the person's next input.
   */
  update?: RunUpdate;
  /** Facts nothing can provide (only when blocked). */
  needs?: string[];
  /** The viewer may answer the current step. */
  canAct: boolean;
  /**
   * Set on the response to a call whose effect could not start now (its lane
   * is full, out of tokens, paused or unavailable). The input was kept and
   * the effect waits its turn; show a busy screen, not an error.
   */
  busy?: { reason: BusyReason; retryAfterMs?: number };
  /** The child run's own view, nested by the runtime while the current step calls it (when the viewer may see it). */
  call?: FlowView;
  /** Set on a child run: the run that called it, and the top of the tree. */
  parent?: { runId: string; rootRunId: string };
}

/** `runId:stepId:epoch`, or `runId:stepId[item]:epoch` for an instance of a per-item step. */
export function instanceKey(runId: string, stepId: string, epoch: number, item?: string): string {
  return `${runId}:${keyOf(stepId, item)}:${epoch}`;
}

/** Renders the view of a run for `viewer` (defaults to the run's own person); `extra.busy` comes from the runtime. */
export function renderView(flow: CompiledFlow, state: RunState, viewer?: ActorRef, extra?: { busy?: FlowView["busy"] }): FlowView {
  const reader = new RunReader(flow, state, state.updatedAt);
  const who: ActorRef = viewer ?? { kind: "visitor", id: state.subject?.id ?? "", roles: [] };
  const locked = reader.lockedFacts();
  const secret = secretReader(flow);
  const known: KnownFact[] = [];
  for (const [name, fact] of flow.facts) {
    if (fact.list) {
      const list = knownList(reader, fact.list, who, locked);
      if (list) known.push(list);
      continue;
    }
    const st = own(state.facts, name);
    // A fact derived from a secret one is as secret as its source.
    if (!st || st.status !== "valid" || secret({ k: "fact", name })) continue;
    known.push({
      fact: name,
      ...(fact.def.title !== undefined ? { title: fact.def.title } : {}),
      value: st.value ?? null,
      ...(st.provenance !== undefined ? { provenance: st.provenance } : {}),
      ...(st.assist !== undefined ? { assisted: { turn: st.assist.turn } } : {}),
      editable: fact.userFillable && !fact.derive && !locked.has(name) && !isTerminal(state.status) && reader.directProblem(name, who, false) === null,
    });
  }
  const base = {
    runId: state.runId,
    flowId: state.flowId,
    flowVersion: state.flowVersion,
    revision: state.revision,
    run: state.status,
    known,
    notices: state.notices,
    ...(extra?.busy ? { busy: extra.busy } : {}),
    ...(state.parent ? { parent: { runId: state.parent.runId, rootRunId: state.parent.rootRunId } } : {}),
    ...(state.update !== undefined ? { update: state.update } : {}),
  };

  if (isTerminal(state.status) && state.end) {
    const endView = flow.ends.get(state.end.kind);
    const end: NonNullable<FlowView["end"]> = {
      kind: state.end.kind,
      ...(state.end.reason !== undefined ? { reason: state.end.reason } : {}),
      instanceKey: `${state.runId}:end:${state.end.kind}`,
    };
    if (endView) {
      end.section = endView.section;
      end.input = evalInput(reader, endView.input);
    }
    return { ...base, status: "ended", step: null, end, canAct: false };
  }
  if (state.status === "cancelling") return { ...base, status: "working", step: null, canAct: false };

  const stepId = state.current;
  const step = stepId ? flow.stepById.get(stepId) : undefined;
  if (!step) {
    const working = Object.keys(state.inflight).length > 0;
    const needs = working ? [] : missingFacts(reader);
    return { ...base, status: working ? "working" : "blocked", step: null, canAct: false, ...(needs.length > 0 ? { needs } : {}) };
  }
  // A per-item step is shown for its current item.
  const item = step.forEach !== undefined ? state.currentItem : undefined;
  const status = reader.stepStatus(step, item);
  // A call step shows its view only when the call failed (to offer another try).
  const shown = step.view && (!step.call || status.kind === "failed") ? step.view : undefined;
  const canAct = reader.canAnswer(step, who) && (!step.call || shown !== undefined);
  const isStaff = who.roles.some((r) => flow.staffRoles.includes(r));
  const epoch = own(state.epochs, keyOf(step.id, item)) ?? 0;
  const asks: Ask[] = [];
  for (const name of step.fills) {
    if (item !== undefined && name.includes(".")) {
      // A per-item step asks for its item's fields.
      const ask = fieldAsk(reader, name, item);
      if (ask) asks.push(ask);
      continue;
    }
    const st = own(state.facts, name);
    if (st && (st.status === "valid" || st.status === "declined")) continue;
    const fact = flow.facts.get(name)!;
    asks.push({
      fact: name,
      ...(fact.def.title !== undefined ? { title: fact.def.title } : {}),
      ...(fact.def.prompt !== undefined ? { prompt: fact.def.prompt } : {}),
      status: st?.status ?? "missing",
      optional: fact.def.optional === true,
      schema: fact.schema,
      ...(st?.value !== undefined && fact.sensitivity !== "secret" ? { previous: st.value } : {}),
      ...(st?.issues ? { issues: st.issues } : {}),
      ...(st?.assist !== undefined ? { assisted: { turn: st.assist.turn } } : {}),
      ...(st?.proposed !== undefined && fact.sensitivity !== "secret" ? { proposed: st.proposed } : {}),
    });
  }
  const detail = !step.call && item === undefined ? stepFields(reader, step, who, locked, secret) : { fields: [], suggestions: [] };
  const ids = step.forEach !== undefined ? liveItems(state, step.forEach) : [];
  const viewStep: ViewStep = {
    id: step.id,
    ...(step.def.title !== undefined ? { title: step.def.title } : {}),
    ...(shown ? { section: shown.section } : {}),
    input: shown ? evalInput(reader, shown.input, item) : {},
    instanceKey: instanceKey(state.runId, step.id, epoch, item),
    epoch,
    ...(step.forEach !== undefined && item !== undefined ? { item: { collection: step.forEach, id: item, index: ids.indexOf(item), count: ids.length } } : {}),
    outputs: shown ? [...step.rules.keys()].filter((name) => (!step.wait || (name !== step.wait.event && name !== "timeout")) && (!step.call || !CALL_END_RULES.has(name))) : [],
    confirmOutputs: shown ? [...step.rules.values()].filter((r) => r.confirm).map((r) => r.name) : [],
    asks: step.call ? [] : asks,
    ...(detail.fields.length > 0 ? { fields: detail.fields } : {}),
    ...(detail.assist ? { assist: detail.assist } : {}),
    ...(detail.suggestions.length > 0 ? { suggestions: detail.suggestions } : {}),
    deviceCapabilities: step.call && !shown ? [] : step.deviceCapabilities,
  };
  if (status.kind === "calling") viewStep.call = { runId: status.call.runId, flowId: status.call.flowId };
  if (status.kind === "confirm") viewStep.confirm = { action: status.action.name, digest: status.digest, input: redactInput(flow, status.action.call.input, status.input, status.action.forEach) };
  if (status.kind === "failed") viewStep.error = isStaff ? status.error : publicError(status.error);
  return { ...base, status: viewStatus(status, canAct, reader.paused()), step: viewStep, canAct };
}

/** A step's fields, its latest assist turn and its suggestions. */
function stepFields(
  reader: RunReader,
  step: CompiledStep,
  who: ActorRef,
  locked: Set<string>,
  secret: (node: unknown) => boolean,
): { fields: ViewField[]; assist?: { turn: string; facts: string[] }; suggestions: ViewSuggestion[] } {
  const { flow, state } = reader;
  const keys = step.view?.fields ?? {};
  const fields: ViewField[] = [];
  const suggestions: ViewSuggestion[] = [];
  let latest: { turn: string; rev: number } | null = null;
  for (const name of step.fills) {
    if (name.includes(".")) continue;
    const fact = flow.facts.get(name);
    if (!fact || fact.list) continue;
    const st = own(state.facts, name);
    const hidden = secret({ k: "fact", name });
    const key = own(keys, name) ?? name;
    const status = st?.status ?? "missing";
    const kind: ViewField["state"] =
      st?.assist !== undefined && (status === "needs_confirmation" || status === "valid")
        ? "assisted"
        : status === "valid" || status === "declined"
          ? "known"
          : status === "invalid"
            ? "invalid"
            : status === "needs_confirmation"
              ? "confirm"
              : "missing";
    const value = status === "declined" ? null : st?.value;
    const field: ViewField = {
      fact: name,
      key,
      ...(fact.def.title !== undefined ? { title: fact.def.title } : {}),
      state: kind,
      ...(value !== undefined ? { value: hidden ? REDACTED : value, display: hidden ? REDACTED : displayValue(value, fact.schema, state.env) } : {}),
      ...(st?.provenance !== undefined ? { provenance: st.provenance } : {}),
      optional: fact.def.optional === true,
      editable: fact.userFillable && !fact.derive && !locked.has(name) && !isTerminal(state.status) && reader.directProblem(name, who, false) === null,
      ...(st?.issues ? { issues: st.issues } : {}),
      ...(st?.assist !== undefined ? { turn: st.assist.turn } : {}),
      ...(status === "needs_confirmation" && st?.provenance === "model" ? { waiting: true as const } : {}),
    };
    fields.push(field);
    if (st?.assist !== undefined && (latest === null || st.rev > latest.rev)) latest = { turn: st.assist.turn, rev: st.rev };
    if (st?.proposed !== undefined && !hidden) {
      suggestions.push({ fact: name, key, value: st.proposed.value, display: displayValue(st.proposed.value, fact.schema, state.env), basis: st.proposed.basis, turn: st.proposed.turn });
    }
  }
  const turn = latest?.turn;
  return {
    fields,
    ...(turn !== undefined ? { assist: { turn, facts: fields.filter((f) => f.turn === turn).map((f) => f.fact) } } : {}),
    suggestions,
  };
}

function viewStatus(status: StepStatus, canAct: boolean, paused: boolean): ViewStatus {
  // Paused: the next action waits for the person to come back.
  if (paused && status.kind === "run") return "paused";
  switch (status.kind) {
    case "ask":
      return canAct ? "asking" : "waiting";
    case "confirm":
      return canAct ? "confirming" : "waiting";
    case "failed":
      return "failed";
    case "attention":
      return "attention";
    case "wait":
      return "waiting";
    case "blocked":
      return "blocked";
    case "calling":
      return "calling";
    default:
      return "working";
  }
}

/** Replaces the values of input entries that read secret facts, directly or through derived facts. */
function redactInput(flow: CompiledFlow, entries: ReadonlyArray<readonly [string, Parameters<typeof evaluate>[0]]>, input: JsonObject, itemOf?: string): JsonObject {
  const out: JsonObject = { ...input };
  const secret = secretReader(flow, itemOf);
  for (const [key, node] of entries) {
    if (secret(node) && own(out, key) !== undefined) Object.defineProperty(out, key, { value: REDACTED, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Whether an expression carries secret data ({@link secretsOf}), of the item `itemOf` when it belongs to one. */
function secretReader(flow: CompiledFlow, itemOf?: string): (node: unknown) => boolean {
  const tracer = secretsOf(flow);
  return (node) => tracer.secretRead(node as Node, itemOf) !== null;
}

function evalInput(reader: RunReader, entries: ReadonlyArray<readonly [string, Parameters<typeof evaluate>[0]]>, item?: string): JsonObject {
  const out: JsonObject = {};
  const env = reader.env({}, item);
  for (const [key, node] of entries) {
    const r = evaluate(node, env);
    Object.defineProperty(out, key, { value: r.known ? r.value : null, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function missingFacts(reader: RunReader): string[] {
  const missing = new Set<string>();
  for (const step of reader.flow.steps) {
    for (const item of step.forEach === undefined ? [undefined] : liveItems(reader.state, step.forEach)) {
      const applies = reader.applies(step, item);
      if (!applies.known) applies.missing.facts.forEach((f) => missing.add(f));
      const st = reader.stepStatus(step, item);
      if (st.kind === "blocked") st.missing.facts.forEach((f) => missing.add(f));
    }
  }
  return [...missing].filter((f) => own(reader.state.facts, f)?.status !== "valid");
}
