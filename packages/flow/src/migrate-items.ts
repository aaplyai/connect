/**
 * Collections across a move between versions. Pure.
 *
 * A collection carries over by name, and only into a collection of the same
 * name: nothing inside an item is renamed. Each item keeps its id (ids are
 * never reused, so `itemSeq` is kept as it is), and each field crosses under
 * the same rules as a fact, at its own address `c[i].f`: it is checked
 * again under the new type and size limit, a secret never carries into a
 * field that is not secret, a computed value never becomes a given one, and
 * the value must have come the way the new version still lets the field be
 * set (the provenance rule). The provenance rule applies to the item itself
 * too, at `c[i]`: an item added in a way the new version no longer allows
 * is dropped with its fields.
 *
 * A settled list stays settled only while every one of its items carried and
 * its settling is still allowed; otherwise it goes back to a draft with the
 * items it kept (`stale`), and the person settles it again. Its bounds are
 * checked again under the new version. `drop` on a collection carries none of
 * its items; `reask` keeps them and asks for the list again.
 *
 * Everything keyed by an item (results, outputs, confirmations, epochs) is
 * carried by `migrate.ts` only while its item carried; see {@link carriedKey}.
 */

import { fieldAddress, keyOf, parseKey, splitTemplate } from "./address.js";
import { CALL_END_RULES, type CompiledFact, type CompiledFlow } from "./compile.js";
import { settled } from "./core-items.js";
import { canonicalJson, cloneJson, formatPath, jsonByteLength, jsonEqual, own, type JsonValue } from "./json.js";
import type { CompiledMigration } from "./migration-def.js";
import type { FactOutcome } from "./migrate.js";
import { readable } from "./reader.js";
import { validateValue } from "./schema.js";
import type { FactState, ItemState, Provenance, RunState } from "./state.js";

/** The issue a value too large to keep carries. */
export const TOO_LARGE = { code: "too-large", message: "This is too large.", path: "" } as const;

/** What a move does to the collections of a run. */
export interface CarriedItems {
  /** The list state of every collection of the target, by name. */
  lists: Record<string, FactState>;
  /** The items carried, by id. */
  items: Record<string, ItemState>;
  /** Each target collection's outcome, as a fact's. */
  outcomes: Map<string, { outcome: FactOutcome; reason?: string }>;
  /** For the plan: item keys (`c[i]`) kept and dropped, and fields not carried as they were. */
  plan: { kept: string[]; dropped: string[]; fields: Array<{ field: string; outcome: FactOutcome; reason?: string }> };
  /** Lists whose settled membership reads differently, and field addresses whose value does. */
  changed: string[];
  /** Field addresses whose checks run once every value is in place. */
  check: string[];
}

interface ListSources {
  /** Lists and field templates a person may set: view rules' targets, adds, removals, settles, declines, and lists in `entry`. */
  person: Set<string>;
  /** Lists and field templates the engine sets from outside the run: a wait's event and timeout rules, and a call step's end rules. */
  external: Set<string>;
}

const sourcesCache = new WeakMap<CompiledFlow, ListSources>();

/** Where each list and field of `flow` may be set from. */
function sourcesOf(flow: CompiledFlow): ListSources {
  const cached = sourcesCache.get(flow);
  if (cached) return cached;
  const person = new Set<string>();
  const external = new Set<string>();
  const addList = (into: Set<string>, c: string) => {
    const collection = flow.collections.get(c);
    if (!collection) return;
    into.add(c);
    for (const field of collection.fields.values()) into.add(field.name);
  };
  for (const c of flow.entry) addList(person, c);
  for (const step of flow.steps) {
    for (const rule of step.rules.values()) {
      // A call's end is answered like an outside event, with provenance "external" (as in migrate.ts).
      const eventRule = (step.wait !== undefined && (rule.name === step.wait.event || rule.name === "timeout")) || (step.call !== undefined && CALL_END_RULES.has(rule.name));
      if (!eventRule && !step.view) continue;
      const into = eventRule ? external : person;
      for (const [target] of rule.set) {
        // A whole list sent back sets its membership and every field.
        if (flow.collections.has(target)) addList(into, target);
        else if (splitTemplate(target)) into.add(target);
      }
      if (!eventRule) for (const target of rule.decline) if (splitTemplate(target)) into.add(target);
      for (const c of [rule.add, rule.remove, ...rule.settle]) if (c !== undefined && flow.collections.has(c)) into.add(c);
    }
  }
  const out = { person, external };
  sourcesCache.set(flow, out);
  return out;
}

/** Whether `to` still lets a list (`c`) or a field template (`c.f`) be set the way it was. */
function allowed(to: CompiledFlow, address: string, compiled: CompiledFact, collection: string, provenance: Provenance | undefined): boolean {
  const sources = sourcesOf(to);
  switch (provenance) {
    case "user":
      return sources.person.has(address);
    case "model":
      return compiled.userFillable;
    case "entry":
      return to.entry.has(collection) || compiled.userFillable;
    case "external":
      return sources.external.has(address);
    default:
      return false;
  }
}

const withoutRev = (f: FactState): JsonValue => {
  const { rev: _rev, ...rest } = f;
  return rest as unknown as JsonValue;
};

const shownChanged = (before: FactState | undefined, after: FactState | undefined): boolean => {
  const a = readable(before);
  const b = readable(after);
  return a.known !== b.known || (a.known && b.known && !jsonEqual(a.value, b.value));
};

/** One field of one carried item; undefined leaves it absent (never given). */
function carryField(
  to: CompiledFlow,
  collection: string,
  field: CompiledFact,
  oldDef: CompiledFact | undefined,
  old: FactState | undefined,
  rev: number,
  check: (address: string) => void,
  address: string,
): { next: FactState | undefined; outcome: FactOutcome; reason?: string } {
  if (field.derive) {
    // Worked out again under the new definition, from the old value, so only a real change clears what depends on it.
    if (!old) return { next: undefined, outcome: "derived" };
    const next: FactState = old.status === "missing" ? { status: "missing", rev: old.rev } : { status: old.status, ...(old.value !== undefined ? { value: cloneJson(old.value) } : {}), ...(old.issues ? { issues: old.issues } : {}), provenance: "derived", rev: old.rev };
    return { next, outcome: "derived" };
  }
  if (!old || !oldDef) return { next: undefined, outcome: "new" };
  const missing = (): FactState => ({ status: "missing", rev: old.status !== "missing" ? rev : old.rev });
  if (oldDef.derive) return { next: missing(), outcome: "dropped", reason: "derived" };
  if (old.status === "missing") return { next: { status: "missing", rev: old.rev }, outcome: "kept" };
  if (oldDef.sensitivity === "secret" && field.sensitivity !== "secret") return { next: missing(), outcome: "dropped", reason: "sensitivity" };
  const fits = (value: JsonValue): boolean => jsonByteLength(value) <= to.limits.maxFactBytes && validateValue(field.schema, value).length === 0;
  if (old.status === "declined") return field.def.optional ? { next: { ...old }, outcome: "kept" } : { next: missing(), outcome: "dropped", reason: "required" };
  if (old.status === "stale") {
    const keep = old.value !== undefined && fits(old.value);
    return { next: { status: "stale", rev: keep === (old.value !== undefined) ? old.rev : rev, ...(keep ? { value: cloneJson(old.value!) } : {}) }, outcome: "kept" };
  }
  if (!allowed(to, field.name, field, collection, old.provenance)) return { next: missing(), outcome: "dropped", reason: "provenance" };
  if (old.provenance === "model" && field.def.userAsserted) return { next: missing(), outcome: "dropped", reason: "userAsserted" };
  // Refused as too large where it was given: never a null in its place; the move is blocked.
  if (old.value === undefined) return { next: { ...old, status: "invalid", issues: old.issues ?? [TOO_LARGE] }, outcome: "invalid", reason: "too-large" };
  const value = old.value;
  let next: FactState;
  let outcome: FactOutcome = "kept";
  let reason: string | undefined;
  if (jsonByteLength(value) > to.limits.maxFactBytes) {
    next = { status: "invalid", value: cloneJson(value), issues: [TOO_LARGE], rev };
    outcome = "invalid";
    reason = "too-large";
  } else {
    const issues = validateValue(field.schema, value).map((i) => ({ code: i.code, message: i.message, path: formatPath(i.path) }));
    const status = issues.length > 0 ? "invalid" : old.provenance === "model" && field.def.confirm ? "needs_confirmation" : "valid";
    next = { status, value: cloneJson(value), rev, ...(issues.length > 0 ? { issues } : {}) };
    if (issues.length > 0) {
      outcome = "invalid";
      reason = "type";
    } else if (status === "needs_confirmation" && old.status !== "needs_confirmation") reason = "confirm";
    if (status !== "invalid" && field.checks.length > 0) check(address);
  }
  if (old.provenance !== undefined) next.provenance = old.provenance;
  if (old.by !== undefined) next.by = old.by;
  if (canonicalJson(withoutRev(next)) === canonicalJson(withoutRev(old))) next.rev = old.rev;
  return { next, outcome, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * Carries the collections of `state` from `from` to `to` (see the module
 * comment). Lists of the target that the source does not have start empty.
 */
export function carryItems(from: CompiledFlow, to: CompiledFlow, migration: CompiledMigration | undefined, state: RunState, rev: number): CarriedItems {
  const out: CarriedItems = { lists: {}, items: {}, outcomes: new Map(), plan: { kept: [], dropped: [], fields: [] }, changed: [], check: [] };
  const put = <T>(record: Record<string, T>, key: string, value: T) => Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
  for (const [c, collection] of to.collections) {
    const source = from.collections.get(c);
    const old = own(state.facts, c);
    if (!source || !old) {
      put(out.lists, c, { status: "missing", rev: 0, items: [] });
      out.outcomes.set(c, { outcome: "new" });
      continue;
    }
    const listFact = to.facts.get(c)!;
    const oldIds = old.items ?? [];
    if (migration?.drop.has(c)) {
      for (const id of oldIds) out.plan.dropped.push(keyOf(c, id));
      put(out.lists, c, { status: "missing", rev: oldIds.length > 0 || old.status !== "missing" ? rev : old.rev, items: [] });
      out.outcomes.set(c, { outcome: "dropped", reason: "drop" });
      if (listShownOf(old) !== null) out.changed.push(c);
      continue;
    }
    const ids: string[] = [];
    for (const id of oldIds) {
      const item = own(state.items, id);
      if (!item) continue;
      // The provenance rule at the item's own address: an item added in a way the target no longer allows does not carry.
      if (!allowed(to, c, listFact, c, item.provenance)) {
        out.plan.dropped.push(keyOf(c, id));
        continue;
      }
      const fields: Record<string, FactState> = {};
      for (const [name, field] of collection.fields) {
        const address = fieldAddress(c, id, name);
        const prev = own(item.fields, name);
        const r = carryField(to, c, field, source.fields.get(name), prev, rev, (a) => out.check.push(a), address);
        if (r.next !== undefined) put(fields, name, r.next);
        if (r.outcome !== "kept" && r.outcome !== "new" && r.outcome !== "derived") out.plan.fields.push({ field: address, outcome: r.outcome, ...(r.reason !== undefined ? { reason: r.reason } : {}) });
        if (!field.derive && shownChanged(prev, r.next)) out.changed.push(address);
      }
      put(out.items, id, { collection: c, fields, rev: item.rev, ...(item.by !== undefined ? { by: item.by } : {}), ...(item.provenance !== undefined ? { provenance: item.provenance } : {}) });
      ids.push(id);
      out.plan.kept.push(keyOf(c, id));
    }
    const dropped = ids.length !== oldIds.length;
    let next: FactState;
    let outcome: { outcome: FactOutcome; reason?: string } = { outcome: "kept" };
    const draft = (status: "missing" | "stale"): FactState => ({ status, rev: dropped || old.status !== status ? rev : old.rev, items: ids });
    if (migration?.reask.has(c)) {
      next = draft("stale");
      outcome = { outcome: "reasked", reason: "reask" };
    } else if (old.status === "missing" || old.status === "stale") {
      next = draft(old.status);
    } else if (old.status === "valid" || old.status === "invalid" || old.status === "needs_confirmation") {
      if (dropped) {
        // The settling covered items that are gone: the person settles the list again.
        next = draft("stale");
        outcome = { outcome: "reasked", reason: "items" };
      } else if (!allowed(to, c, listFact, c, old.provenance)) {
        next = draft("stale");
        outcome = { outcome: "reasked", reason: "provenance" };
      } else {
        const provenance = old.provenance ?? "user";
        next = settled(collection, ids, provenance === "model" ? "needs_confirmation" : "valid", rev, provenance, old.by ?? "");
        if (old.by === undefined) delete next.by;
        if (next.status === "invalid") outcome = { outcome: "invalid", reason: "bounds" };
        if (canonicalJson(withoutRev(next)) === canonicalJson(withoutRev(old))) next.rev = old.rev;
      }
    } else next = draft("stale");
    put(out.lists, c, next);
    out.outcomes.set(c, outcome);
    if (listShownOf(old) !== listShownOf(next)) out.changed.push(c);
  }
  out.plan.kept.sort();
  out.plan.dropped.sort();
  out.plan.fields.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return out;
}

/** What a list reads as while settled and valid (its ids), else null. */
function listShownOf(list: FactState | undefined): string | null {
  return list !== undefined && list.status === "valid" ? JSON.stringify(list.items ?? []) : null;
}

/**
 * Whether something keyed `name[item]` in the source (a result, an output, a
 * confirmation, an epoch) has a place in the target: its owner (an action or
 * a step) must run per item over the same collection on both sides, and its
 * item must have carried. A key without an item needs its owner to run once
 * per run on both sides. `owner` says how each side's owner runs: undefined
 * when it is missing, null when it runs once per run, else its collection.
 */
export function carriedKey(key: string, owner: (side: "from" | "to", name: string) => string | null | undefined, items: Readonly<Record<string, ItemState>>): boolean {
  const at = parseKey(key);
  if (!at || at.field !== undefined) return false;
  const a = owner("from", at.name);
  const b = owner("to", at.name);
  if (a === undefined || b === undefined || a !== b) return false;
  if (at.item === undefined) return b === null;
  return b !== null && own(items, at.item)?.collection === b;
}

/**
 * Item fields downstream of an action the source never had were given
 * without its result: each carried item's field goes stale, as such a fact
 * does. Returns the addresses it changed.
 */
export function staleTemplate(to: CompiledFlow, items: Record<string, ItemState>, template: string, rev: number): string[] {
  const t = splitTemplate(template);
  const field = t ? to.collections.get(t.collection)?.fields.get(t.field) : undefined;
  if (!t || !field || field.derive) return [];
  const changed: string[] = [];
  for (const [id, item] of Object.entries(items)) {
    if (item.collection !== t.collection) continue;
    const st = own(item.fields, t.field);
    if (!st || st.status === "missing" || st.status === "stale") continue;
    Object.defineProperty(item.fields, t.field, { value: { status: "stale", rev, ...(st.value !== undefined ? { value: st.value } : {}) }, enumerable: true, writable: true, configurable: true });
    changed.push(fieldAddress(t.collection, id, t.field));
  }
  return changed;
}

/**
 * The lists of `to` the person is asked for again after a move: one of their
 * items did not carry, or a field they had given no longer reads. Named by
 * the list, so the notice stays short however many items it has.
 */
export function listsAskedAgain(to: CompiledFlow, before: RunState, after: RunState): string[] {
  const out: string[] = [];
  for (const c of to.collections.keys()) {
    const ids = own(before.facts, c)?.items ?? [];
    const lost = ids.some((id) => {
      const was = own(before.items, id);
      const now = own(after.items, id);
      if (!was || was.collection !== c) return false;
      if (!now) return true;
      const collection = to.collections.get(c)!;
      return Object.keys(was.fields).some((f) => {
        const field = collection.fields.get(f);
        return field !== undefined && field.derive === undefined && readable(own(was.fields, f)).known && !readable(own(now.fields, f)).known;
      });
    });
    if (lost) out.push(c);
  }
  return out;
}
