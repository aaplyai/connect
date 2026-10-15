/**
 * The core's handling of collections: item changes, rules that act
 * on an item, clearing what depends on one item, and new view instances for
 * rows the server changed.
 *
 * Every change to a list reduces to the item ops of `ItemOp`: `add` mints an
 * id (`i<n>`, from `state.itemSeq`), `set` writes fields of a live item,
 * `remove` deletes an item with everything keyed by it, and `settle` states
 * the list is complete. A field keeps a fact's state, so a field is checked,
 * confirmed, locked and invalidated like a fact, one item at a time.
 *
 * core.ts calls into this module only for flows that declare collections, so
 * a flow without them runs exactly the code it ran before.
 */

import { fieldAddress, keyOf, templateOf } from "./address.js";
import { type CompiledCollection, type CompiledFact, type CompiledFlow, type CompiledStep } from "./compile.js";
import { type Node } from "./expr.js";
import { type Evaluated, type Read } from "./expr-eval.js";
import { fieldLocked, fieldState, itemLocked, liveItem, liveItems, listShown, parseItemOps } from "./items.js";
import { cloneJson, formatPath, jsonByteLength, jsonEqual, own, type JsonValue } from "./json.js";
import { checkIssue, readable } from "./reader.js";
import { validateValue, type PatternBudget } from "./schema.js";
import type { ActorRef, AssistMark, FactState, FlowEvent, ItemOp, Provenance, RunState } from "./state.js";
import { fillModeOf, personOwned } from "./fill.js";

/** What this module needs of the step function's machine. */
export interface ItemMachine {
  readonly flow: CompiledFlow;
  state: RunState;
  readonly event: FlowEvent;
  readonly rev: number;
  readonly changed: Set<string>;
  readonly fresh: Set<string>;
  readonly cleared: Set<string>;
  readonly restated: Set<string>;
  readonly bumped: Set<string>;
  /** Item fields whose shown value changed in this event. */
  readonly rows: Set<string>;
  /** Item fields an output's own rule wrote exactly as the view gave them. */
  readonly ownRows: Set<string>;
  /** Pattern work every value this event validates draws on. */
  readonly patternBudget: PatternBudget;
  lockedFacts(): Set<string>;
  eval(node: Node, extra?: { payload?: JsonValue; value?: JsonValue }, item?: string): Evaluated;
  note(code: string, message: string, facts?: string[], action?: string): void;
  bumpFor(fact: string, item?: string): void;
  invalidateFrom(start: string, item?: string): void;
  cancelTimer(timerId: string): void;
  refuse(code: string, message: string, facts?: string[]): never;
  directProblem(name: string, actor: ActorRef, starting: boolean, value?: Read, item?: string): [string, string] | null;
  canAnswer(step: CompiledStep, actor: ActorRef): boolean;
  canAnswerDefault(actor: ActorRef): boolean;
}

/** Marks a field to be cleared (as opposed to set to the JSON value null). */
export const CLEAR_FIELD: unique symbol = Symbol("clear field");
export type FieldWrite = JsonValue | typeof CLEAR_FIELD;

/** An item op as it was applied, for checking afterwards who may give it. */
export interface AppliedOp {
  /** Its position in the event's `items`. */
  index: number;
  op: ItemOp["op"];
  collection: string;
  /** The item it acted on (the new one for `add`). */
  id?: string;
  /** Fields it gave a value (not cleared). */
  fields: string[];
}

type Mode = "strict" | "lenient";

/** Gives a new run its empty lists. */
export function startCollections(flow: CompiledFlow, state: RunState): void {
  state.items = {};
  state.itemSeq = 0;
  for (const name of flow.collections.keys()) state.facts[name] = { status: "missing", rev: 0, items: [] };
}

export function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

function title(field: CompiledFact, fallback: string): string {
  return field.def.title ?? fallback;
}

// --- reading and writing fields and lists -------------------------------------

/** Replaces a list's own state and records whether what it reads as changed. */
export function putList(m: ItemMachine, name: string, next: FactState): void {
  const prev = own(m.state.facts, name);
  put(m.state.facts, name, next);
  m.fresh.add(name);
  if (listShown(prev) !== listShown(next)) m.changed.add(name);
}

/** Replaces one field's state; `fresh` marks a write of this event (not a recomputation or a clearing). */
export function putField(m: ItemMachine, collection: CompiledCollection, id: string, field: string, next: FactState, fresh: boolean): void {
  const item = own(m.state.items, id)!;
  const prev = own(item.fields, field);
  put(item.fields, field, next);
  const address = fieldAddress(collection.name, id, field);
  if (fresh) m.fresh.add(address);
  const before = readable(prev);
  const after = readable(next);
  const shown = before.known !== after.known || (before.known && after.known && !jsonEqual(before.value, after.value));
  if (!shown) return;
  if (fresh) m.changed.add(address);
  m.rows.add(address);
}

/** A settled list's status for its current length: out of range is invalid, whoever settled it. */
export function settled(collection: CompiledCollection, ids: string[], wanted: "valid" | "needs_confirmation", rev: number, provenance: Provenance, by: string): FactState {
  const n = ids.length;
  const base = { rev, items: ids, provenance, by };
  if (n < collection.min) return { ...base, status: "invalid", issues: [{ code: "too-few", message: `At least ${collection.min} needed.`, path: "" }] };
  if (n > collection.max) return { ...base, status: "invalid", issues: [{ code: "too-many", message: `At most ${collection.max} allowed.`, path: "" }] };
  return { ...base, status: wanted };
}

/** New membership for a list: a settled list stays settled and is checked against its bounds again. */
export function setMembers(m: ItemMachine, collection: CompiledCollection, ids: string[]): void {
  const list = own(m.state.facts, collection.name) ?? { status: "missing" as const, rev: 0 };
  const by = m.event.actor.id;
  if (list.status === "valid" || list.status === "invalid" || list.status === "needs_confirmation") {
    const provenance = list.provenance ?? "user";
    putList(m, collection.name, settled(collection, ids, provenance === "model" ? "needs_confirmation" : "valid", m.rev, provenance, list.by ?? by));
    return;
  }
  putList(m, collection.name, { ...list, items: ids, rev: m.rev });
}

/** States that the list is complete as it stands. A model's settle waits for the person. */
export function settleList(m: ItemMachine, collection: CompiledCollection, provenance: Provenance): void {
  const list = own(m.state.facts, collection.name);
  const ids = [...(list?.items ?? [])];
  // A model restating a list the person settled does not reopen it.
  if (provenance === "model" && list?.status === "valid") {
    m.restated.add(collection.name);
    return;
  }
  const next = settled(collection, ids, provenance === "model" ? "needs_confirmation" : "valid", m.rev, provenance, m.event.actor.id);
  if (list && list.status === next.status && list.provenance === next.provenance && listShown(list) === listShown(next)) {
    m.restated.add(collection.name);
    return;
  }
  putList(m, collection.name, next);
}

/** Total size of a collection's field values, in UTF-8 bytes. */
function collectionBytes(state: RunState, collection: CompiledCollection): number {
  let total = 0;
  for (const id of liveItems(state, collection.name)) {
    for (const fs of Object.values(own(state.items, id)?.fields ?? {})) if (fs.value !== undefined) total += jsonByteLength(fs.value);
  }
  return total;
}

// --- item ops -------------------------------------------------------------------

/** Refuses in strict mode; in lenient mode notes the refusal and goes on. */
function refuseOr(m: ItemMachine, mode: Mode, code: string, message: string, facts: string[]): void {
  if (mode === "strict") m.refuse(code, message, facts);
  m.note(code === "flow/needs-person" ? code : "flow/item-ignored", message, facts);
}

/**
 * Writes fields of a live item, in the collection's declared order (never the
 * order of the keys given, which a store need not keep). Returns the fields
 * given a value.
 */
export function setFields(m: ItemMachine, collection: CompiledCollection, id: string, values: Record<string, FieldWrite>, provenance: Provenance, mode: Mode, own_?: boolean): string[] {
  const s = m.state;
  const locked = m.lockedFacts();
  const accepted: string[] = [];
  for (const key of Object.keys(values)) {
    if (!collection.fields.has(key)) refuseOr(m, mode, "flow/unknown-fact", `unknown field "${key}" of "${collection.name}"`, [fieldAddress(collection.name, id, key)]);
  }
  for (const [name, field] of collection.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    const value = values[name]!;
    const address = fieldAddress(collection.name, id, name);
    const label = title(field, name);
    if (field.derive) {
      refuseOr(m, mode, "flow/fact-not-allowed", `"${label}" is worked out automatically`, [address]);
      continue;
    }
    if (fieldLocked(locked, collection.name, id, name)) {
      refuseOr(m, mode, "flow/locked", `"${label}" cannot be changed any more`, [address]);
      continue;
    }
    if (provenance === "model" && field.def.userAsserted) {
      m.note("flow/needs-person", `"${label}" must come from you directly.`, [address]);
      continue;
    }
    const prev = fieldState(s, id, name);
    if (value === CLEAR_FIELD) {
      if (prev && prev.status !== "missing") {
        putField(m, collection, id, name, { status: "missing", rev: m.rev }, true);
        // A view that sent null shows the cleared field as it now reads; a clear from elsewhere asks again.
        if (own_) m.ownRows.add(address);
        else m.bumpFor(field.name, id);
      }
      continue;
    }
    // A model's item field goes through the fill policy, as a fact does (ADR 0012).
    // An item field has no suggestion and no undo in 0.3: what is not written is said in a notice.
    let assisted: "valid" | "needs_confirmation" | undefined;
    if (provenance === "model") {
      const mark = markOf(m.event, field.name);
      const mode = fillModeOf(field, mark?.cap);
      if (mode === "never") {
        m.note("flow/needs-person", `"${label}" must come from you directly.`, [address]);
        continue;
      }
      if (mode === "suggest" || mark?.basis === "inferred") {
        m.note("flow/item-ignored", `"${label}" was not filled: the assistant may only suggest it.`, [address]);
        continue;
      }
      if (personOwned(prev) && mark?.op !== "correct") {
        // Restating the person's own value changes nothing and says nothing.
        if (prev!.value === undefined || !jsonEqual(prev!.value, value)) m.note("flow/item-ignored", `"${label}" keeps the value you gave.`, [address]);
        continue;
      }
      assisted = mode === "auto" && !field.def.confirm ? "valid" : "needs_confirmation";
    }
    const bytes = jsonByteLength(value);
    if (bytes > m.flow.limits.maxFactBytes) {
      if (assisted !== undefined) {
        m.note("flow/assist-invalid", `"${label}" was not filled: it is too large.`, [address]);
        continue;
      }
      putField(m, collection, id, name, { status: "invalid", rev: m.rev, issues: [{ code: "too-large", message: "This is too large.", path: "" }], provenance, by: m.event.actor.id }, true);
      accepted.push(name);
      continue;
    }
    const total = collectionBytes(s, collection) - (prev?.value !== undefined ? jsonByteLength(prev.value) : 0) + bytes;
    if (total > m.flow.limits.maxCollectionBytes) {
      refuseOr(m, mode, "flow/limit", `"${collection.def.title ?? collection.name}" is too large.`, [address]);
      continue;
    }
    const issues = validateValue(field.schema, value, [], m.patternBudget).map((i) => ({ code: i.code, message: i.message, path: formatPath(i.path) }));
    if (assisted !== undefined && issues.length > 0) {
      // An assistant's value that does not fit is not written; the person is told why.
      m.note("flow/assist-invalid", `"${label}" was not filled: ${issues[0]!.message}`, [address]);
      continue;
    }
    const status = issues.length > 0 ? "invalid" : assisted ?? (provenance === "model" && field.def.confirm ? "needs_confirmation" : "valid");
    if (own_) m.ownRows.add(address);
    const same = prev !== undefined && prev.value !== undefined && jsonEqual(prev.value, value);
    if (same && (prev.status === status || (prev.status === "valid" && status === "needs_confirmation"))) {
      m.restated.add(address);
      if (prev.provenance === "model" && provenance !== "model") putField(m, collection, id, name, { ...prev, provenance, by: m.event.actor.id }, true);
      accepted.push(name);
      continue;
    }
    if (assisted !== undefined) replacedOf(m).set(address, prev);
    putField(m, collection, id, name, { status, value: cloneJson(value), provenance, rev: m.rev, by: m.event.actor.id, ...(issues.length > 0 ? { issues } : {}) }, true);
    accepted.push(name);
  }
  return accepted;
}

/** The mark the runtime recorded for a model's item field (`collection.field`), if any. */
function markOf(event: FlowEvent, template: string): AssistMark | undefined {
  const marks = event.type === "facts.input" || event.type === "run.started" ? event.marks : undefined;
  return marks !== undefined ? own(marks, template) : undefined;
}

/** Per event: the state each assistant's item field write replaced, put back if the value fails the field's checks. */
const REPLACED = new WeakMap<ItemMachine, Map<string, FactState | undefined>>();
function replacedOf(m: ItemMachine): Map<string, FactState | undefined> {
  let map = REPLACED.get(m);
  if (!map) REPLACED.set(m, (map = new Map()));
  return map;
}

/** Runs the field checks of what was just given, once every value of the event is in place. */
export function checkFields(m: ItemMachine, collection: CompiledCollection, id: string, names: readonly string[]): void {
  if (!own(m.state.items, id)) return;
  for (const name of names) {
    const field = collection.fields.get(name)!;
    const current = fieldState(m.state, id, name);
    if (!current || (current.status !== "valid" && current.status !== "needs_confirmation") || field.checks.length === 0) continue;
    const issues = [];
    for (const check of field.checks) {
      const issue = checkIssue(m.eval(check.test, { value: current.value ?? null }, id), check);
      if (issue) issues.push(issue);
    }
    if (issues.length === 0) continue;
    const address = fieldAddress(collection.name, id, name);
    const replaced = REPLACED.get(m);
    if (replaced?.has(address)) {
      // An assistant's value that fails the field's checks is not written.
      const prev = replaced.get(address);
      const fields = own(m.state.items, id)!.fields;
      if (prev === undefined) delete fields[name];
      else put(fields, name, prev);
      m.fresh.delete(address);
      m.changed.delete(address);
      m.rows.delete(address);
      m.note("flow/assist-invalid", `"${title(field, name)}" was not filled: ${issues[0]!.message}`, [address]);
      continue;
    }
    putField(m, collection, id, name, { ...current, status: "invalid", issues }, true);
  }
}

/** Mints an item and adds it to the end of its list. Refuses past the list's `max` or the run's `maxItems`. */
export function addItem(m: ItemMachine, collection: CompiledCollection, provenance: Provenance, mode: Mode): string | undefined {
  const s = m.state;
  if (m.lockedFacts().has(collection.name)) {
    refuseOr(m, mode, "flow/locked", `"${collection.def.title ?? collection.name}" cannot be changed any more`, [collection.name]);
    return undefined;
  }
  const ids = liveItems(s, collection.name);
  let total = 0;
  for (const name of m.flow.collections.keys()) total += liveItems(s, name).length;
  if (ids.length >= collection.max || total >= m.flow.limits.maxItems) {
    refuseOr(m, mode, "flow/too-many-items", `"${collection.def.title ?? collection.name}" cannot have more items.`, [collection.name]);
    return undefined;
  }
  s.itemSeq = (s.itemSeq ?? 0) + 1;
  const id = `i${s.itemSeq}`;
  s.items ??= {};
  put(s.items, id, { collection: collection.name, fields: {}, rev: m.rev, by: m.event.actor.id, provenance });
  setMembers(m, collection, [...ids, id]);
  return id;
}

/**
 * Removes an item: refused while a write in flight or a committed one relies
 * on it; its reads in flight are dropped (a late answer is then ignored) and
 * everything keyed by it goes. A hold it made is released by the next
 * `advance`, from its frozen input.
 */
export function removeItem(m: ItemMachine, collection: CompiledCollection, id: string): void {
  const s = m.state;
  if (itemLocked(m.lockedFacts(), collection, id)) m.refuse("flow/locked", "That can no longer be removed.", [keyOf(collection.name, id)]);
  for (const [effectId, inflight] of Object.entries(s.inflight)) {
    if (inflight.item !== id || inflight.purpose !== "run") continue;
    delete s.inflight[effectId];
    m.cancelTimer(`retry:${effectId}`);
    m.cancelTimer(`timeout:${effectId}`);
  }
  delete s.items![id];
  const suffix = `[${id}]`;
  for (const record of [s.results, s.outputs, s.confirmations, s.epochs] as Array<Record<string, unknown>>) {
    for (const key of Object.keys(record)) if (key.endsWith(suffix)) delete record[key];
  }
  setMembers(
    m,
    collection,
    liveItems(s, collection.name).filter((x) => x !== id),
  );
}

/**
 * Checks item ops from a `facts.input` or a start before they are applied:
 * the collection, the fields and whether this actor may give them at all.
 * A model's removals and clears are dropped with a notice; anything else a
 * model may not do is dropped too, while a person's event is refused.
 */
export function checkInputOps(m: ItemMachine, raw: unknown, model: boolean, starting: boolean): ItemOp[] {
  const parsed = parseItemOps(raw);
  if (!parsed.ok) {
    if (!model) m.refuse(parsed.code, parsed.message);
    m.note("flow/item-ignored", "Some changes to a list were not used.");
    return [];
  }
  const actor = m.event.actor;
  const mayFill = (name: string, collection: string): boolean => {
    const asks = m.flow.askedBy.get(name) ?? [];
    if (m.flow.entry.has(collection) && (starting || asks.length === 0)) return m.canAnswerDefault(actor);
    return asks.some((a) => m.canAnswer(m.flow.stepById.get(a.stepId)!, actor));
  };
  const out: ItemOp[] = [];
  const drop = (code: string, message: string, facts: string[]): void => {
    if (!model) m.refuse(code, message, facts);
    m.note("flow/item-ignored", message, facts);
  };
  for (const op of parsed.ops) {
    const collection = m.flow.collections.get(op.collection);
    if (!collection) {
      drop("flow/unknown-fact", `unknown collection "${op.collection}"`, [op.collection]);
      continue;
    }
    const label = collection.def.title ?? collection.name;
    if (starting && op.op !== "add" && op.op !== "settle") {
      drop("flow/items-invalid", "A run starts with items added and lists settled only.", [op.collection]);
      continue;
    }
    if (model && op.op === "remove") {
      m.note("flow/item-ignored", `Only you can remove an item from "${label}".`, [keyOf(op.collection, op.id)]);
      continue;
    }
    if (op.op !== "set") {
      // Adding, removing and settling are the list's own answers.
      if (!m.flow.facts.get(op.collection)?.userFillable) {
        drop("flow/fact-not-allowed", `"${label}" cannot be changed directly`, [op.collection]);
        continue;
      }
      if (!mayFill(op.collection, op.collection)) {
        drop("flow/forbidden", `you cannot change "${label}"`, [op.collection]);
        continue;
      }
    }
    if (op.op === "remove" || op.op === "settle") {
      out.push(op);
      continue;
    }
    const fields: Record<string, JsonValue> = {};
    for (const [name, value] of Object.entries(op.fields ?? {})) {
      const field = collection.fields.get(name);
      const template = templateOf(op.collection, name);
      const problem = !field
        ? ["flow/unknown-fact", `unknown field "${name}" of "${label}"`]
        : !field.userFillable
          ? ["flow/fact-not-allowed", `"${title(field, name)}" cannot be given directly`]
          : !mayFill(template, op.collection)
            ? ["flow/forbidden", `you cannot answer "${title(field, name)}"`]
            : model && value === null
              ? ["flow/item-ignored", "a model cannot clear fields"]
              : null;
      if (problem) {
        drop(problem[0]!, problem[1]!, [template]);
        continue;
      }
      put(fields, name, value);
    }
    out.push(op.op === "add" ? { op: "add", collection: op.collection, ...(Object.keys(fields).length > 0 ? { fields } : {}) } : { op: "set", collection: op.collection, id: op.id, fields });
  }
  return out;
}

/**
 * Applies item ops in order (after the event's plain facts), then the field
 * checks of every value given. In `set` from outside, null clears a field.
 */
export function applyItemOps(m: ItemMachine, ops: readonly ItemOp[], provenance: Provenance, mode: Mode): AppliedOp[] {
  const applied: AppliedOp[] = [];
  ops.forEach((op, index) => {
    const collection = m.flow.collections.get(op.collection);
    if (!collection) {
      refuseOr(m, mode, "flow/unknown-fact", `unknown collection "${op.collection}"`, [op.collection]);
      return;
    }
    const writes = (fields: Record<string, JsonValue | null> | undefined): Record<string, FieldWrite> => {
      const out: Record<string, FieldWrite> = {};
      for (const [k, v] of Object.entries(fields ?? {})) put(out, k, v === null ? CLEAR_FIELD : v);
      return out;
    };
    switch (op.op) {
      case "add": {
        const id = addItem(m, collection, provenance, mode);
        if (id === undefined) return;
        applied.push({ index, op: "add", collection: op.collection, id, fields: setFields(m, collection, id, writes(op.fields), provenance, mode) });
        return;
      }
      case "set": {
        if (!liveItem(m.state, op.collection, op.id)) {
          refuseOr(m, mode, "flow/unknown-item", "That item is not in the list any more.", [keyOf(op.collection, op.id)]);
          return;
        }
        applied.push({ index, op: "set", collection: op.collection, id: op.id, fields: setFields(m, collection, op.id, writes(op.fields), provenance, mode) });
        return;
      }
      case "remove": {
        if (!liveItem(m.state, op.collection, op.id)) {
          refuseOr(m, mode, "flow/unknown-item", "That item is not in the list any more.", [keyOf(op.collection, op.id)]);
          return;
        }
        // Whether the item may be removed here is asked while it is still there.
        const problem = m.directProblem(op.collection, m.event.actor, m.event.type === "run.started", undefined, op.id);
        if (problem) {
          refuseOr(m, mode, problem[0], problem[1], [keyOf(op.collection, op.id)]);
          return;
        }
        removeItem(m, collection, op.id);
        applied.push({ index, op: "remove", collection: op.collection, id: op.id, fields: [] });
        return;
      }
      case "settle": {
        const list = own(m.state.facts, op.collection);
        if (list?.status !== "valid" && m.lockedFacts().has(op.collection)) {
          refuseOr(m, mode, "flow/locked", `"${collection.def.title ?? collection.name}" cannot be changed any more`, [op.collection]);
          return;
        }
        settleList(m, collection, provenance);
        applied.push({ index, op: "settle", collection: op.collection, fields: [] });
        return;
      }
    }
  });
  for (const a of applied) if (a.id !== undefined && a.fields.length > 0) checkFields(m, m.flow.collections.get(a.collection)!, a.id, a.fields);
  return applied;
}

/**
 * After the ops are in place: which of them this actor may not give here
 * (by position), and why. Each must belong to a step that applies (for a
 * per-item step, its instance for the item), as for facts given directly.
 * A removal was checked before it was made.
 */
export function itemGateProblems(m: ItemMachine, applied: readonly AppliedOp[], starting: boolean): Map<number, [string, string, string]> {
  const problems = new Map<number, [string, string, string]>();
  const actor = m.event.actor;
  for (const a of applied) {
    if (a.op === "add" || a.op === "settle") {
      const p = m.directProblem(a.collection, actor, starting);
      if (p) {
        problems.set(a.index, [...p, a.collection]);
        continue;
      }
    }
    for (const name of a.fields) {
      const template = templateOf(a.collection, name);
      const p = m.directProblem(template, actor, starting, readable(fieldState(m.state, a.id!, name)), a.id);
      if (p) {
        problems.set(a.index, [...p, template]);
        break;
      }
    }
  }
  return problems;
}
