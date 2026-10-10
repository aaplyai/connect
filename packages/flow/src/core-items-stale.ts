/**
 * What depends on one item (core-items.ts): clearing it when an item changes,
 * recomputing derived fields, new view instances for rows the server changed,
 * and the items a step or an action supplies.
 */

import { splitTemplate, fieldAddress, parseKey, templateOf, keyOf } from "./address.js";
import { type CompiledCollection, factNode, type CompiledStep, type CompiledAction } from "./compile.js";
import { liveItems, fieldState, liveItem } from "./items.js";
import { own, jsonByteLength, formatPath, jsonEqual } from "./json.js";
import { readable } from "./reader.js";
import { validateValue } from "./schema.js";
import type { FactState, OutputEvent, RunState } from "./state.js";
import { type ItemMachine, put, putField, checkFields } from "./core-items.js";

// --- invalidation, derived fields and view instances -------------------------------

/**
 * Marks what depends on `start` stale, walking (node, item) pairs: an edge
 * that stays within one item keeps the item, any other edge into an item
 * field reaches every live item, and other nodes are the run's own. Stops
 * where the plain walk stops (facts written or restated in this event,
 * derived facts and fields, actions).
 */
export function invalidateItems(m: ItemMachine, start: string, startItem: string | undefined): void {
  const s = m.state;
  const seen = new Set<string>([`${start}|${startItem ?? ""}`]);
  const queue: Array<[string, string | undefined]> = [[start, startItem]];
  while (queue.length > 0) {
    const [node, item] = queue.shift()!;
    for (const next of m.flow.dependents.get(node) ?? []) {
      if (!next.startsWith("f:")) continue;
      const name = next.slice(2);
      const t = splitTemplate(name);
      const nextItem = t === null ? undefined : item !== undefined && item !== "*" && m.flow.sameItem.has(`${node}>${next}`) ? item : "*";
      const key = `${next}|${nextItem ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (t === null) staleFact(m, name);
      else {
        const collection = m.flow.collections.get(t.collection)!;
        for (const id of nextItem === "*" ? liveItems(s, t.collection) : [nextItem!]) staleField(m, collection, id, t.field);
      }
      queue.push([next, nextItem]);
    }
  }
}

export function staleFact(m: ItemMachine, name: string): void {
  if (m.fresh.has(name) || m.restated.has(name) || m.flow.facts.get(name)?.derive) return;
  const st = own(m.state.facts, name);
  if (!st || st.status === "missing" || st.status === "stale") return;
  // A list goes back to being a draft with its items.
  put(m.state.facts, name, { status: "stale", rev: m.rev, ...(st.value !== undefined ? { value: st.value } : {}), ...(st.items !== undefined ? { items: st.items } : {}) });
  m.cleared.add(name);
  m.bumpFor(name);
}

export function staleField(m: ItemMachine, collection: CompiledCollection, id: string, field: string): void {
  const address = fieldAddress(collection.name, id, field);
  const def = collection.fields.get(field);
  if (!def || def.derive || m.fresh.has(address) || m.restated.has(address) || !own(m.state.items, id)) return;
  const st = fieldState(m.state, id, field);
  if (!st || st.status === "missing" || st.status === "stale") return;
  putField(m, collection, id, field, { status: "stale", rev: m.rev, ...(st.value !== undefined ? { value: st.value } : {}) }, false);
  m.cleared.add(address);
  m.bumpFor(def.name, id);
}

/** Recomputes a derived field on every live item; a changed value clears what depends on it within that item. */
export function recomputeField(m: ItemMachine, template: string): void {
  const s = m.state;
  const t = splitTemplate(template)!;
  const collection = m.flow.collections.get(t.collection)!;
  const field = collection.fields.get(t.field)!;
  for (const id of liveItems(s, t.collection)) {
    const r = m.eval(field.derive!, undefined, id);
    const prev = fieldState(s, id, t.field);
    let next: FactState;
    if (!r.known) next = { status: "missing", rev: prev?.rev ?? 0 };
    else if (jsonByteLength(r.value) > m.flow.limits.maxFactBytes) {
      next = { status: "invalid", issues: [{ code: "too-large", message: "This is too large.", path: "" }], provenance: "derived", rev: m.rev };
    } else {
      const issues = validateValue(field.schema, r.value).map((i) => ({ code: i.code, message: i.message, path: formatPath(i.path) }));
      next = issues.length > 0 ? { status: "invalid", value: r.value, issues, provenance: "derived", rev: m.rev } : { status: "valid", value: r.value, provenance: "derived", rev: m.rev };
    }
    if (prev ? prev.status === next.status && jsonEqual(prev.value, next.value) : next.status === "missing") continue;
    const before = readable(prev);
    putField(m, collection, id, t.field, next, false);
    const after = readable(next);
    if (before.known !== after.known || (before.known && after.known && !jsonEqual(before.value, after.value))) m.invalidateFrom(factNode(template), id);
  }
}

/**
 * Gives views that show a changed field of an existing item a new instance
 * (FacetJS SPEC 3.4): a mounted section owns the row keys its controls bind,
 * so a host cannot overwrite them, and only a new instance key reseeds them.
 * Which keys a section binds is the section's to know, so every view that
 * shows the field counts. Left alone: the view whose output's own rule wrote
 * the value exactly as it sent it (it holds that value already), and an item
 * added in this event (a row-reconciled list appends it seeded from the
 * slot, and its own view has never been mounted). A change of membership or
 * order needs no new instance either: FacetJS appends, drops and reorders
 * rows by id.
 */
export function bumpRows(m: ItemMachine): void {
  const s = m.state;
  const ev = m.event;
  for (const address of m.rows) {
    const at = parseKey(address);
    if (!at || at.item === undefined || at.field === undefined) continue;
    if (own(s.items, at.item)?.rev === m.rev) continue;
    for (const binder of m.flow.rowBinders.get(templateOf(at.name, at.field)) ?? []) {
      const ownView = ev.type === "output" && ev.stepId === binder.stepId && (!binder.sameItem || (ev as OutputEvent).item === at.item) && m.ownRows.has(address);
      if (ownView) continue;
      // A per-item step that shows the list's rows has an instance, and an epoch, per item of its own.
      const forEach = binder.sameItem ? undefined : m.flow.stepById.get(binder.stepId)?.forEach;
      const keys = binder.sameItem ? [keyOf(binder.stepId, at.item)] : forEach !== undefined ? liveItems(s, forEach).map((id) => keyOf(binder.stepId, id)) : [binder.stepId];
      for (const key of keys) {
        if (m.bumped.has(key)) continue;
        m.bumped.add(key);
        put(s.epochs, key, (own(s.epochs, key) ?? 0) + 1);
      }
    }
  }
}

/**
 * After a move between versions: runs the checks of carried item fields
 * (addresses `c[i].f`) once every carried value is in place, as the move
 * does for carried facts. Anything that is not a field address is skipped.
 */
export function checkCarriedFields(m: ItemMachine, addresses: readonly string[]): void {
  for (const address of addresses) {
    const at = parseKey(address);
    if (!at || at.item === undefined || at.field === undefined) continue;
    const collection = m.flow.collections.get(at.name);
    if (collection) checkFields(m, collection, at.item, [at.field]);
  }
}

/** The item an output answers for: required, and live, for a per-item step; refused for any other. */
export function outputItem(m: ItemMachine, step: CompiledStep, ev: OutputEvent): string | undefined {
  if (step.forEach === undefined) {
    if (ev.item !== undefined) m.refuse("flow/item-not-allowed", "This question is not about one item.");
    return undefined;
  }
  if (ev.item === undefined) m.refuse("flow/item-required", "Say which item this answer is for.");
  if (!liveItem(m.state, step.forEach, ev.item)) m.refuse("flow/unknown-item", "That item is not in the list any more.");
  return ev.item;
}

/**
 * Who supplied each of `names` (facts and field templates, as an upstream set
 * holds them), as actor ids in a fixed order: a fact's `by`; for a collection,
 * the list's and each live item's (adding an item is supplying it); for a
 * template `c.f`, that field's `by` on every live item. Without collections
 * this is each fact's `by`, as before.
 */
export function suppliersOf(state: RunState, collections: ReadonlyMap<string, CompiledCollection>, names: Iterable<string>): string[] {
  const out: string[] = [];
  const push = (by: string | undefined) => {
    if (by !== undefined) out.push(by);
  };
  for (const name of names) {
    const t = collections.size > 0 ? splitTemplate(name) : null;
    if (t && collections.has(t.collection)) {
      for (const id of liveItems(state, t.collection)) push(fieldState(state, id, t.field)?.by);
      continue;
    }
    push(own(state.facts, name)?.by);
    if (collections.has(name)) for (const id of liveItems(state, name)) push(own(state.items, id)?.by);
  }
  return out;
}

/**
 * Whether `actorId` supplied any item input of the action: a field it reads
 * (of `item` alone where it reads only its own item's), or an item of a list
 * it reads (adding one is supplying it). An approver must not have.
 */
export function suppliedItems(m: ItemMachine, action: CompiledAction, item: string | undefined, actorId: string): boolean {
  const s = m.state;
  const ownFields = item !== undefined ? m.flow.upstreamOwn.get(action.name) : undefined;
  for (const f of m.flow.upstreamFacts.get(action.name) ?? []) {
    const t = splitTemplate(f);
    if (t) {
      const ids = ownFields?.has(f) ? [item!] : liveItems(s, t.collection);
      if (ids.some((id) => fieldState(s, id, t.field)?.by === actorId)) return true;
    } else if (m.flow.collections.has(f) && liveItems(s, f).some((id) => own(s.items, id)?.by === actorId)) return true;
  }
  return item !== undefined && own(s.items, item)?.by === actorId;
}
