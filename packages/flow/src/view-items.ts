/**
 * Views of collections: what a per-item step asks for, a settled
 * list as a summary shows it, and which reads of items would show a secret
 * field.
 */

import { splitTemplate, templateOf } from "./address.js";
import type { CompiledCollection, CompiledFlow } from "./compile.js";
import { fieldLocked, fieldState, itemLocked, readRows } from "./items.js";
import { own } from "./json.js";
import type { RunReader } from "./reader.js";
import { secretsOf } from "./secrets.js";
import { isTerminal, type ActorRef } from "./state.js";
import type { Ask, KnownFact, KnownItem } from "./view.js";

/** The question for one field of the step's item, or null once it is answered. */
export function fieldAsk(reader: RunReader, template: string, item: string): Ask | null {
  const t = splitTemplate(template);
  const field = t ? reader.flow.collections.get(t.collection)?.fields.get(t.field) : undefined;
  if (!t || !field) return null;
  const st = fieldState(reader.state, item, t.field);
  if (st && (st.status === "valid" || st.status === "declined")) return null;
  return {
    fact: template,
    item,
    ...(field.def.title !== undefined ? { title: field.def.title } : {}),
    ...(field.def.prompt !== undefined ? { prompt: field.def.prompt } : {}),
    status: st?.status ?? "missing",
    optional: field.def.optional === true,
    schema: field.schema,
    ...(st?.value !== undefined && !fieldSecret(reader.flow, t.collection, t.field) ? { previous: st.value } : {}),
    ...(st?.issues ? { issues: st.issues } : {}),
  };
}

/**
 * A settled list for the summary, or null while it is not settled. Each item
 * lists its valid, non-secret fields; what the viewer may edit, add or
 * remove follows the same gates as an item change they would submit.
 */
export function knownList(reader: RunReader, collection: CompiledCollection, who: ActorRef, locked: ReadonlySet<string>): KnownFact | null {
  const s = reader.state;
  const list = own(s.facts, collection.name);
  if (!list || list.status !== "valid") return null;
  const fact = reader.flow.facts.get(collection.name)!;
  const open = !isTerminal(s.status);
  const changeable = fact.userFillable && open && !locked.has(collection.name) && reader.directProblem(collection.name, who, false) === null;
  const ids = list.items ?? [];
  let total = 0;
  for (const name of reader.flow.collections.keys()) total += (own(s.facts, name)?.items ?? []).length;
  const items: KnownItem[] = [];
  for (const id of ids) {
    const item = own(s.items, id);
    if (!item) continue;
    const fields: KnownFact[] = [];
    let invalid = false;
    let confirming = false;
    let complete = true;
    for (const [name, field] of collection.fields) {
      const st = own(item.fields, name);
      if (st?.status === "invalid") invalid = true;
      if (st?.status === "needs_confirmation") confirming = true;
      if (!field.derive && st?.status !== "valid" && st?.status !== "declined") complete = false;
      if (!st || st.status !== "valid" || fieldSecret(reader.flow, collection.name, name)) continue;
      fields.push({
        fact: field.name,
        ...(field.def.title !== undefined ? { title: field.def.title } : {}),
        value: st.value ?? null,
        ...(st.provenance !== undefined ? { provenance: st.provenance } : {}),
        editable: field.userFillable && !field.derive && open && !fieldLocked(locked, collection.name, id, name) && reader.directProblem(field.name, who, false, undefined, id) === null,
      });
    }
    items.push({
      id,
      status: invalid ? "invalid" : confirming ? "needs_confirmation" : complete ? "complete" : "incomplete",
      fields,
      removable: fact.userFillable && open && !itemLocked(locked, collection, id) && reader.directProblem(collection.name, who, false, undefined, id) === null,
    });
  }
  return {
    fact: collection.name,
    ...(collection.def.title !== undefined ? { title: collection.def.title } : {}),
    value: readRows(s, collection),
    ...(list.provenance !== undefined ? { provenance: list.provenance } : {}),
    editable: changeable,
    items,
    addable: changeable && ids.length < collection.max && total < reader.flow.limits.maxItems,
  };
}

/** A secret field, or one derived from secret data ({@link secretsOf}). */
export function fieldSecret(flow: CompiledFlow, collection: string, field: string): boolean {
  return secretsOf(flow).secretIn(templateOf(collection, field)) !== null;
}
