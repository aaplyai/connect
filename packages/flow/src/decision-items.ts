/**
 * Collections for a decision model. Pure.
 *
 * A decider is told each list the person may change now
 * (`DecisionFact.collection`): whether it may add items, the fields it may
 * give and the items as they stand, by id. A secret field is never named and
 * its values never go along; nor are fields a model may never give (derived,
 * `userAsserted`, or not the person's to answer). What it proposes comes back
 * as item changes on `continue` and `switch` (`add` and `set` only), cut down
 * here to what it was offered, and is then applied as a model's under the
 * core's own guards: a `userAsserted` field is never a model's, a `confirm`
 * field waits for the person, and a model never removes an item, clears a
 * field or settles a list.
 */

import { fieldAddress, keyOf, templateOf } from "./address.js";
import type { CompiledFact, CompiledFlow } from "./compile.js";
import type { DecisionFact, DecisionField, ProposedItemOp } from "./decision.js";
import { liveItems, fieldState } from "./items.js";
import { own, type JsonValue } from "./json.js";
import type { RunReader } from "./reader.js";
import type { JsonSchema } from "./schema.js";
import type { ActorRef, ItemOp, RunState } from "./state.js";

/**
 * The lists of `flow` a decider may change for `viewer`, as decision facts
 * with `collection` set. `asked` holds what the current step asks for;
 * `shares` says whether a value of that sensitivity may go along.
 */
export function decisionCollections(
  flow: CompiledFlow,
  state: RunState,
  reader: RunReader,
  viewer: ActorRef,
  asked: ReadonlySet<string>,
  shares: (sensitivity: CompiledFact["sensitivity"]) => boolean,
): DecisionFact[] {
  if (flow.collections.size === 0) return [];
  const locked = reader.lockedFacts();
  const out: DecisionFact[] = [];
  for (const [name, collection] of flow.collections) {
    const list = flow.facts.get(name);
    if (!list || locked.has(name)) continue;
    const ids = liveItems(state, name).filter((id) => !locked.has(keyOf(name, id)));
    const add = list.userFillable && reader.directProblem(name, viewer, false) === null;
    const fields: Array<[string, CompiledFact]> = [];
    for (const [f, field] of collection.fields) {
      if (field.sensitivity === "secret" || field.derive || !field.userFillable || field.def.userAsserted) continue;
      // Given at the start or by a plain step, or for one of the items by a per-item step.
      const template = templateOf(name, f);
      const may = (item?: string) => reader.directProblem(template, viewer, false, undefined, item) === null;
      if (may() || ids.some((id) => may(id))) fields.push([f, field]);
    }
    if (!add && fields.length === 0) continue;
    const offered: DecisionField[] = fields.map(([f, field]) => ({
      name: f,
      ...(field.def.title !== undefined ? { title: field.def.title } : {}),
      ...(field.def.prompt !== undefined ? { prompt: field.def.prompt } : {}),
      schema: field.schema,
    }));
    const items = ids.map((id) => {
      const values: Record<string, JsonValue> = {};
      for (const [f, field] of fields) {
        const st = fieldState(state, id, f);
        if (st?.status === "valid" && shares(field.sensitivity)) values[f] = st.value ?? null;
      }
      return { id, fields: values };
    });
    out.push({
      name,
      ...(collection.def.title !== undefined ? { title: collection.def.title } : {}),
      ...(collection.def.prompt !== undefined ? { prompt: collection.def.prompt } : {}),
      schema: rowsSchema(collection.max, fields),
      asked: asked.has(name) || fields.some(([f]) => asked.has(templateOf(name, f))),
      collection: { add, max: collection.max, fields: offered, items },
    });
  }
  return out;
}

/** The rows a decider sees: each item's id and its offered fields. */
function rowsSchema(max: number, fields: ReadonlyArray<[string, CompiledFact]>): JsonSchema {
  const properties: Record<string, JsonSchema> = { id: { type: "string" } };
  for (const [f, field] of fields) Object.defineProperty(properties, f, { value: field.schema, enumerable: true, writable: true, configurable: true });
  return { type: "array", maxItems: max, items: { type: "object", properties, required: ["id"], additionalProperties: false } };
}

/**
 * A proposal's item changes, cut down to what the decider was offered: lists
 * in `offered`, adds only where adding was offered, sets only on the items
 * listed, and only the fields offered. A set left with no field is dropped;
 * so is anything but `add` and `set`.
 */
export function offeredItemOps(offered: readonly DecisionFact[], ops: readonly ProposedItemOp[] | undefined): ItemOp[] {
  const lists = new Map(offered.flatMap((f) => (f.collection ? [[f.name, f.collection] as const] : [])));
  const out: ItemOp[] = [];
  for (const op of ops ?? []) {
    const list = lists.get(op.collection);
    if (!list) continue;
    const names = new Set(list.fields.map((f) => f.name));
    const fields: Record<string, JsonValue> = {};
    for (const [f, value] of Object.entries(op.fields ?? {})) if (names.has(f)) fields[f] = value;
    const given = Object.keys(fields).length > 0;
    if (op.op === "add" && list.add) out.push({ op: "add", collection: op.collection, ...(given ? { fields } : {}) });
    else if (op.op === "set" && given && list.items.some((item) => item.id === op.id)) out.push({ op: "set", collection: op.collection, id: op.id, fields });
  }
  return out;
}

/**
 * What item changes would write that changed after `seen.revision`, or all of
 * it when the run's flow moved: a list an add joins (`name`), and each field a
 * set writes (`name[i].f`).
 */
export function staleItems(state: RunState, ops: readonly ItemOp[], seen: { revision: number; flowHash: string }): string[] {
  const out: string[] = [];
  const moved = state.flowHash !== seen.flowHash;
  const after = (rev: number | undefined) => moved || (rev ?? 0) > seen.revision;
  for (const op of ops) {
    if (op.op === "add") {
      if (after(own(state.facts, op.collection)?.rev)) out.push(op.collection);
    } else if (op.op === "set") {
      for (const f of Object.keys(op.fields)) if (after(fieldState(state, op.id, f)?.rev)) out.push(fieldAddress(op.collection, op.id, f));
    }
  }
  return out;
}

/**
 * The item changes of a proposal to start `flow` (a `switch`), as a run may
 * start with them or a question may hold them in a workspace: adds to lists
 * the flow declares, with fields it declares that are neither derived nor
 * secret (a decider is never asked for a secret, and one is never stored for
 * later). A run starts with items added only, so sets are dropped. Undefined
 * when nothing is left.
 */
export function startItems(flow: CompiledFlow | null, ops: readonly ProposedItemOp[] | undefined): ItemOp[] | undefined {
  if (!flow || !ops) return undefined;
  const out: ItemOp[] = [];
  for (const op of ops) {
    const collection = flow.collections.get(op.collection);
    if (op.op !== "add" || !collection) continue;
    const fields: Record<string, JsonValue> = {};
    for (const [f, value] of Object.entries(op.fields ?? {})) {
      const field = collection.fields.get(f);
      if (field && !field.derive && field.sensitivity !== "secret") fields[f] = value;
    }
    out.push({ op: "add", collection: op.collection, ...(Object.keys(fields).length > 0 ? { fields } : {}) });
  }
  return out.length > 0 ? out : undefined;
}
