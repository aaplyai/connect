/**
 * Collections at run time: reading lists and items from a run's
 * state, and checking the shape of item changes that arrive from outside.
 *
 * A list's own state is `state.facts[c]`: its status says whether it is
 * settled, and `items` holds the live ids in list order. Each item lives in
 * `state.items[id]` with one fact state per field. Everything here follows a
 * list's order, never `Object.keys(state.items)`, so a run replays exactly.
 */

import { fieldAddress, isItemId, keyOf, templateOf } from "./address.js";
import type { CompiledCollection } from "./compile.js";
import { MAX_ITEM_OPS } from "./collections-compile.js";
import type { Read } from "./expr-eval.js";
import { checkJson, isJsonObject, own, type JsonObject, type JsonValue } from "./json.js";
import { readable, readFor, wasTooCostly } from "./reader.js";
import type { FactState, ItemOp, ItemState, RunState } from "./state.js";

/** The live item ids of a collection, in list order. */
export function liveItems(state: RunState, collection: string): readonly string[] {
  return own(state.facts, collection)?.items ?? [];
}

/** The item when `id` is a live item of `collection`; undefined for anything else, malformed ids included. */
export function liveItem(state: RunState, collection: string, id: unknown): ItemState | undefined {
  if (!isItemId(id)) return undefined;
  const item = own(state.items, id);
  return item !== undefined && item.collection === collection ? item : undefined;
}

/** Whether `id` names a live item of `collection`. */
export function isLiveItem(state: RunState, collection: string, id: unknown): boolean {
  return liveItem(state, collection, id) !== undefined;
}

/** One field of one item, or undefined when it was never given (or the item is gone). */
export function fieldState(state: RunState, id: string, field: string): FactState | undefined {
  return own(own(state.items, id)?.fields, field);
}

/**
 * A collection read as a value: `[{id, ...fields}]` with the fields the read
 * needs. Known once the list is settled within its bounds and each of those
 * fields is known on every item; otherwise `missing` names the list, or the
 * addresses of the fields that are not (`attendees[i3].age`).
 */
export function readList(state: RunState, collection: CompiledCollection, fields: readonly string[] | "*"): Read {
  const list = own(state.facts, collection.name);
  if (!list || list.status !== "valid") return { known: false, missing: { facts: [collection.name], results: [] } };
  const names = fields === "*" ? [...collection.fields.keys()] : fields.filter((f) => collection.fields.has(f));
  const rows: JsonValue[] = [];
  const missing: string[] = [];
  let costly: true | undefined;
  for (const id of list.items ?? []) {
    const row: JsonObject = { id };
    for (const f of names) {
      const field = fieldState(state, id, f);
      const r = readable(field);
      if (r.known) row[f] = r.value;
      else missing.push(fieldAddress(collection.name, id, f));
      if (!r.known && wasTooCostly(field)) costly = true;
    }
    rows.push(row);
  }
  if (missing.length > 0) return { known: false, missing: costly ? { facts: missing, results: [], costly } : { facts: missing, results: [] } };
  return { known: true, value: rows };
}

/**
 * A list's rows as they stand, for views: every live item in order, each
 * field's valid value or null. Secret fields are left out, as `known` leaves
 * out secret facts.
 */
export function readRows(state: RunState, collection: CompiledCollection): JsonValue {
  const rows: JsonValue[] = [];
  for (const id of liveItems(state, collection.name)) {
    const row: JsonObject = { id };
    for (const [f, field] of collection.fields) {
      if (field.sensitivity === "secret") continue;
      const r = readable(fieldState(state, id, f));
      row[f] = r.known ? r.value : null;
    }
    rows.push(row);
  }
  return rows;
}

/** `item.<field>` of the item an expression belongs to; `id` is always known. */
export function readSelf(state: RunState, id: string, field: string): Read {
  const item = own(state.items, id);
  if (!item) return { known: false };
  if (field === "id") return { known: true, value: id };
  const address = fieldAddress(item.collection, id, field);
  const r = readFor(own(item.fields, field), address);
  return r.known || r.missing ? r : { known: false, missing: { facts: [address], results: [] } };
}

/** What a list reads as, for telling whether a change is visible: its ids while settled and valid, null otherwise. */
export function listShown(list: FactState | undefined): string | null {
  return list !== undefined && list.status === "valid" ? JSON.stringify(list.items ?? []) : null;
}

/** Whether a lock (see `RunReader.lockedFacts`) covers one item's field. */
export function fieldLocked(locked: ReadonlySet<string>, collection: string, id: string, field: string): boolean {
  return locked.has(templateOf(collection, field)) || locked.has(fieldAddress(collection, id, field));
}

/** Whether removing the item would change something a write in flight or a committed one relies on. */
export function itemLocked(locked: ReadonlySet<string>, collection: CompiledCollection, id: string): boolean {
  if (locked.has(collection.name) || locked.has(keyOf(collection.name, id))) return true;
  for (const field of collection.fields.keys()) if (fieldLocked(locked, collection.name, id, field)) return true;
  return false;
}

const OP_KEYS: Record<ItemOp["op"], readonly string[]> = {
  add: ["op", "collection", "fields"],
  set: ["op", "collection", "id", "fields"],
  remove: ["op", "collection", "id"],
  settle: ["op", "collection"],
};

const COLLECTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/**
 * Checks the shape of item changes given from outside (a submission, a start,
 * a model's proposal): a list of at most {@link MAX_ITEM_OPS} ops, each with
 * only its own keys, ids of the form the core mints, and plain JSON fields.
 * Whether the collection, the item and the fields exist is for the core to
 * say. Returns the ops (copied) or why they were refused.
 */
export function parseItemOps(raw: unknown): { ok: true; ops: ItemOp[] } | { ok: false; code: string; message: string } {
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  if (!Array.isArray(raw)) return fail("flow/items-invalid", "items must be a list of item changes");
  if (raw.length > MAX_ITEM_OPS) return fail("flow/limit", `at most ${MAX_ITEM_OPS} item changes at once`);
  const ops: ItemOp[] = [];
  for (const [i, op] of raw.entries()) {
    const where = `item change ${i + 1}`;
    if (!isJsonObject(op) || typeof op.op !== "string" || !Object.prototype.hasOwnProperty.call(OP_KEYS, op.op)) {
      return fail("flow/items-invalid", `${where} must be {op: "add" | "set" | "remove" | "settle", collection, ...}`);
    }
    const kind = op.op as ItemOp["op"];
    const extra = Object.keys(op).find((k) => !OP_KEYS[kind].includes(k));
    if (extra !== undefined) return fail("flow/items-invalid", `${where} has an unknown key "${extra}"`);
    if (typeof op.collection !== "string" || !COLLECTION_NAME_RE.test(op.collection)) return fail("flow/items-invalid", `${where} must name a collection`);
    if ((kind === "set" || kind === "remove") && !isItemId(op.id)) return fail("flow/unknown-item", `${where} names no item`);
    if (kind === "set" || (kind === "add" && op.fields !== undefined)) {
      if (!isJsonObject(op.fields) || checkJson(op.fields) !== null) return fail("flow/items-invalid", `${where}: fields must be an object of JSON values`);
      if (Object.keys(op.fields).some((k) => k === "__proto__")) return fail("flow/items-invalid", `${where}: fields must be an object of JSON values`);
    }
    const fields = op.fields as Record<string, JsonValue> | undefined;
    switch (kind) {
      case "add":
        ops.push({ op: "add", collection: op.collection, ...(fields !== undefined ? { fields: { ...fields } } : {}) });
        break;
      case "set":
        ops.push({ op: "set", collection: op.collection, id: op.id as string, fields: { ...fields! } });
        break;
      case "remove":
        ops.push({ op: "remove", collection: op.collection, id: op.id as string });
        break;
      case "settle":
        ops.push({ op: "settle", collection: op.collection });
        break;
    }
  }
  return { ok: true, ops };
}
