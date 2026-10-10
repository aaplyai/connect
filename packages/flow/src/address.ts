/**
 * Addresses of per-item state.
 *
 * A collection's items have ids the core mints (`i1`, `i2`, ...), never a
 * person, a model or a host. Everything that exists once per item is keyed
 * by its name and the item id: results, outputs and confirmations of a
 * per-item action (`quote[i3]`), view epochs of a per-item step
 * (`details[i3]`). A field of one item is addressed `attendees[i3].age`, and
 * the field's template, shared by every item, `attendees.age`.
 *
 * Names never contain `.`, `[` or `]` (NAME_RE), so none of these forms can
 * be mistaken for a plain name, and a key without an item is the plain name.
 */

import { fixedPattern } from "@aaply/action-contract/internal";

/** Item ids: `i` and a positive integer of at most ten digits. */
export const ITEM_ID_RE = fixedPattern(/^i[1-9][0-9]{0,9}$/);

/** True for a well-formed item id. Says nothing about whether the item is live. */
export function isItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_RE.test(value);
}

/** The key of something that exists once per item: `name[item]`, or `name` when there is no item. */
export function keyOf(name: string, item?: string): string {
  return item === undefined ? name : `${name}[${item}]`;
}

/** The address of one item's field: `collection[item].field`. */
export function fieldAddress(collection: string, item: string, field: string): string {
  return `${collection}[${item}].${field}`;
}

/** The template address of a field, shared by every item: `collection.field`. */
export function templateOf(collection: string, field: string): string {
  return `${collection}.${field}`;
}

/** Splits a template address `collection.field`; null for anything else. */
export function splitTemplate(address: string): { collection: string; field: string } | null {
  const dot = address.indexOf(".");
  if (dot <= 0 || dot === address.length - 1 || address.indexOf(".", dot + 1) !== -1 || address.includes("[")) return null;
  return { collection: address.slice(0, dot), field: address.slice(dot + 1) };
}

const KEY_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\[(i[1-9][0-9]{0,9})\])?(?:\.([A-Za-z][A-Za-z0-9_]*))?$/;

/**
 * Parses a key or an address: `name`, `name[i3]`, `name.field` or
 * `name[i3].field`. Returns null for anything else.
 */
export function parseKey(key: string): { name: string; item?: string; field?: string } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { name: m[1]!, ...(m[2] !== undefined ? { item: m[2] } : {}), ...(m[3] !== undefined ? { field: m[3] } : {}) };
}

/** The name part of a key (`quote[i3]` gives `quote`). */
export function nameOfKey(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/** The item part of a key (`quote[i3]` gives `i3`), or undefined. */
export function itemOfKey(key: string): string | undefined {
  const open = key.indexOf("[");
  if (open === -1) return undefined;
  const close = key.indexOf("]", open);
  return close === -1 ? undefined : key.slice(open + 1, close);
}
