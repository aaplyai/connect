/**
 * Rules that act on an item (core-items.ts): an item rule's gate and its
 * writes, and a list the server sent reconciled with the rows held.
 */

import { splitTemplate, fieldAddress, templateOf, keyOf } from "./address.js";
import type { CompiledRule, CompiledCollection } from "./compile.js";
import type { Node } from "./expr.js";
import { liveItem, fieldLocked, fieldState, liveItems } from "./items.js";
import { type JsonValue, own, isJsonObject } from "./json.js";
import type { Provenance } from "./state.js";
import { type ItemMachine, type FieldWrite, put, addItem, setFields, putField, putList, removeItem, settleList, checkFields, CLEAR_FIELD, setMembers } from "./core-items.js";

// --- rules ------------------------------------------------------------------------

/**
 * Applies the parts of a rule that act on an item or a list (the plain facts
 * are applied by the caller): it works out the item (the step's own, a new
 * one from `add`, or the one `item` names), writes its fields, declines,
 * clears, removes, replaces whole lists and settles them.
 */
export function applyItemRule(
  m: ItemMachine,
  rule: CompiledRule,
  payload: JsonValue,
  values: ReadonlyArray<readonly [string, JsonValue, Node]>,
  provenance: Provenance,
  item: string | undefined,
): void {
  const s = m.state;
  const fromView = m.event.type === "output";
  let target = item;
  const collection = rule.addresses !== undefined ? m.flow.collections.get(rule.addresses) : undefined;
  if (rule.item && collection) {
    const r = m.eval(rule.item, { payload });
    if (!r.known) m.refuse("flow/rule-incomplete", "It is not clear which item this is about.", r.missing.facts);
    if (!liveItem(s, collection.name, r.value)) m.refuse("flow/unknown-item", "That item is not in the list any more.", [collection.name]);
    target = r.value as string;
  }
  const fields: Record<string, FieldWrite> = {};
  const passThrough = new Set<string>();
  const lists: Array<[CompiledCollection, JsonValue, boolean]> = [];
  for (const [name, value, node] of values) {
    const t = splitTemplate(name);
    if (t) {
      put(fields, t.field, value);
      if (node.k === "payload") passThrough.add(t.field);
    } else lists.push([m.flow.collections.get(name)!, value, node.k === "payload"]);
  }
  const written: Array<[CompiledCollection, string, string[]]> = [];
  if (rule.add !== undefined) {
    const id = addItem(m, m.flow.collections.get(rule.add)!, provenance, "strict")!;
    target = id;
  }
  if (collection && target !== undefined && Object.keys(fields).length > 0) {
    const own_ = fromView ? passThrough : new Set<string>();
    // Fields the view gave exactly as they are need no new view instance.
    const given: Record<string, FieldWrite> = {};
    const other: Record<string, FieldWrite> = {};
    for (const [k, v] of Object.entries(fields)) put(own_.has(k) ? given : other, k, v);
    const names = [...setFields(m, collection, target, given, provenance, "strict", true), ...setFields(m, collection, target, other, provenance, "strict")];
    written.push([collection, target, names]);
  }
  const locked = m.lockedFacts();
  for (const name of rule.decline) {
    const t = splitTemplate(name);
    if (!t || !collection || target === undefined) continue;
    if (fieldLocked(locked, t.collection, target, t.field)) m.refuse("flow/locked", `"${name}" cannot be changed any more`, [fieldAddress(t.collection, target, t.field)]);
    putField(m, collection, target, t.field, { status: "declined", rev: m.rev, by: m.event.actor.id }, true);
  }
  for (const name of rule.clear) {
    const t = splitTemplate(name);
    if (t) {
      if (!collection || target === undefined) continue;
      if (fieldLocked(locked, t.collection, target, t.field)) m.refuse("flow/locked", `"${name}" cannot be changed any more`, [fieldAddress(t.collection, target, t.field)]);
      const prev = fieldState(s, target, t.field);
      if (prev && prev.status !== "missing") {
        putField(m, collection, target, t.field, { status: "stale", rev: m.rev, ...(prev.value !== undefined ? { value: prev.value } : {}) }, true);
        m.bumpFor(name, target);
      }
      continue;
    }
    const list = m.flow.collections.get(name);
    if (!list) continue;
    // Unsettling keeps the items; the list's step asks again with them.
    const prev = own(s.facts, name);
    if (prev && prev.status !== "missing" && prev.status !== "stale") {
      putList(m, name, { status: "stale", rev: m.rev, items: [...(prev.items ?? [])] });
      m.bumpFor(name);
    }
  }
  for (const [list, rows, given] of lists) reconcile(m, list, rows, provenance, fromView && given, written);
  if (rule.remove !== undefined && collection && target !== undefined) removeItem(m, collection, target);
  for (const name of rule.settle) settleList(m, m.flow.collections.get(name)!, provenance);
  for (const [c, id, names] of written) checkFields(m, c, id, names);
}

/**
 * Replaces a whole list with rows matched by `id` (FacetJS's row
 * reconciliation): a row with a live id updates the fields it carries, a row
 * without one (absent or null, as a Facet optional field) is added, a live id
 * missing from the rows is removed, the rows' order becomes the list's, and
 * the list is settled. A field given as null is cleared, as in a `set` op.
 */
export function reconcile(m: ItemMachine, collection: CompiledCollection, rows: JsonValue, provenance: Provenance, given: boolean, written: Array<[CompiledCollection, string, string[]]>): void {
  const s = m.state;
  const label = collection.def.title ?? collection.name;
  if (!Array.isArray(rows)) m.refuse("flow/items-invalid", `"${label}" must be given as a list of rows`, [collection.name]);
  const list = rows as JsonValue[];
  if (list.length > collection.max) m.refuse("flow/too-many-items", `"${label}" cannot have more than ${collection.max} items.`, [collection.name]);
  const seen = new Set<string>();
  for (const row of list) {
    if (!isJsonObject(row)) m.refuse("flow/items-invalid", `each row of "${label}" must be an object`, [collection.name]);
    const r = row as Record<string, JsonValue>;
    for (const key of Object.keys(r)) {
      if (key === "id") continue;
      const field = collection.fields.get(key);
      if (!field || field.derive) m.refuse("flow/items-invalid", `"${key}" is not a field of "${label}" that can be given`, [templateOf(collection.name, key)]);
    }
    if (r.id === undefined || r.id === null) continue;
    if (!liveItem(s, collection.name, r.id)) m.refuse("flow/unknown-item", "That item is not in the list any more.", [collection.name]);
    if (seen.has(r.id as string)) m.refuse("flow/duplicate-item", `an item of "${label}" appears twice`, [keyOf(collection.name, r.id as string)]);
    seen.add(r.id as string);
  }
  const before = liveItems(s, collection.name);
  for (const id of before) if (!seen.has(id)) removeItem(m, collection, id);
  const order: string[] = [];
  for (const row of list as Array<Record<string, JsonValue>>) {
    const id = row.id === undefined || row.id === null ? addItem(m, collection, provenance, "strict")! : (row.id as string);
    const fields: Record<string, FieldWrite> = {};
    for (const [k, v] of Object.entries(row)) if (k !== "id") put(fields, k, v === null ? CLEAR_FIELD : v);
    written.push([collection, id, setFields(m, collection, id, fields, provenance, "strict", given)]);
    order.push(id);
  }
  const now = liveItems(s, collection.name);
  if (now.length !== order.length || now.some((id, i) => id !== order[i])) {
    if (m.lockedFacts().has(collection.name)) m.refuse("flow/locked", `"${label}" cannot be changed any more`, [collection.name]);
    setMembers(m, collection, order);
  }
  settleList(m, collection, provenance);
}
