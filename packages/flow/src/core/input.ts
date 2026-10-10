/**
 * The core machine's handling of people's input: outputs, facts, assisted
 * filling and its answers, undo, and the gates a value passes. Functions over
 * `this`, installed on Machine.
 */

import { keyOf } from "../address.js";
import { CALL_END_RULES } from "../compile.js";
import { checkInputOps, applyItemOps, itemGateProblems } from "../core-items.js";
import { outputItem } from "../core-items-stale.js";
import { truthy } from "../expr-eval.js";
import { own, type JsonValue, jsonEqual, jsonByteLength, cloneJson, hasOwn } from "../json.js";
import { readable } from "../reader.js";
import { validateValue } from "../schema.js";
import { fillModeOf, personOwned } from "../fill.js";
import { type RunState, type OutputEvent, isTerminal, type FactsInputEvent, type AssistMark, type AssistBasis, type FactState, type Provenance, type ItemOp } from "../state.js";
import { reject, type Machine, MAX_DIGEST_LENGTH, type FactWrite, CLEAR, bare } from "../core.js";

export interface Snapshot {
  state: RunState;
  effects: number;
  notices: number;
  sets: string[][];
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A person's `accept` as `{fact, turn?}` entries: at most 100, each fact once. */
export function acceptEntries(list: unknown): Array<{ fact: string; turn?: string }> {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 100) reject("flow/invalid-event", "accept is a list of at most 100 facts");
  const out: Array<{ fact: string; turn?: string }> = [];
  const seen = new Set<string>();
  for (const entry of list as unknown[]) {
    const parsed =
      typeof entry === "string"
        ? { fact: entry }
        : isPlainObject(entry) && typeof entry.fact === "string" && (entry.turn === undefined || (typeof entry.turn === "string" && entry.turn.length > 0 && entry.turn.length <= 128))
          ? { fact: entry.fact, ...(typeof entry.turn === "string" ? { turn: entry.turn } : {}) }
          : reject("flow/invalid-event", "accept lists fact names or {fact, turn}");
    if (seen.has(parsed.fact)) {
      // The same fact twice is one answer only when both say the same.
      if (out.some((o) => o.fact === parsed.fact && o.turn === parsed.turn)) continue;
      reject("flow/invalid-event", `"${parsed.fact}" is accepted twice`, [parsed.fact]);
    }
    seen.add(parsed.fact);
    out.push(parsed);
  }
  return out;
}

// --- person events ---------------------------------------------------------

export function onOutput(this: Machine, ev: OutputEvent): void {
  const step = this.flow.stepById.get(ev.stepId) ?? reject("flow/unknown-step", `unknown step "${ev.stepId}"`);
  if (!step.view) reject("flow/unknown-output", `step "${step.id}" has no outputs`);
  // A wait step's event and timeout rules are for the outside world, not the view; so are a call step's end rules.
  const reserved = (step.wait !== undefined && (ev.name === step.wait.event || ev.name === "timeout")) || (step.call !== undefined && CALL_END_RULES.has(ev.name));
  const rule = (reserved ? undefined : step.rules.get(ev.name)) ?? reject("flow/unknown-output", `step "${step.id}" has no output "${ev.name}"`);
  if (step.call && this.stepStatus(step).kind === "calling") reject("flow/step-not-active", "This is still in progress.");
  if (ev.digest !== undefined && (typeof ev.digest !== "string" || ev.digest.length > MAX_DIGEST_LENGTH)) {
    reject("flow/bad-digest", "That confirmation is not valid.");
  }
  const item = outputItem(this, step, ev);
  this.assertCanAnswer(step);
  // An output from a view the step has since replaced (a move, an answer cleared elsewhere) is not
  // read under rules its view never showed. Outputs without an epoch (the field is optional) are unchecked,
  // and cancelling is always allowed. A per-item view has its own epoch, at `step[item]`.
  if (ev.epoch !== undefined && !rule.cancel && ev.epoch !== (own(this.state.epochs, keyOf(step.id, item)) ?? 0)) {
    reject("flow/stale-view", "This changed while you were looking at it. Please look again.");
  }
  if (!this.isAnswerable(step, item)) reject("flow/step-not-active", "That question is not open right now.");
  this.applyRule(step, rule, ev.payload, "user", ev.digest, item);
  // A submit that left the assistant's values waiting for a yes does not move the
  // run on; the notice names them, so a shell can say why.
  if (item === undefined && !isTerminal(this.state.status)) {
    const waiting = step.fills.filter((name) => {
      const st = name.includes(".") ? undefined : own(this.state.facts, name);
      return st?.status === "needs_confirmation" && st.provenance === "model";
    });
    if (waiting.length > 0) this.note("flow/assist-waiting", "Some details the assistant filled are waiting for your yes.", waiting);
  }
}

export function onInput(this: Machine, ev: FactsInputEvent): boolean {
  const model = ev.source === "model";
  const answers = ev.accept !== undefined || ev.dismiss !== undefined || ev.undo !== undefined;
  if (model && answers) reject("flow/fact-not-allowed", "a model cannot accept, dismiss or undo");
  if (!model && ev.marks !== undefined) reject("flow/invalid-event", "only a model's input carries assist marks");
  if (answers) this.onAnswers(ev);
  const values: Array<[string, FactWrite]> = [];
  for (const [name, value] of Object.entries(ev.facts)) {
    const fact = this.flow.facts.get(name);
    const problem = !fact
      ? ["flow/unknown-fact", `unknown fact "${name}"`]
      : fact.list
        ? ["flow/collection-needs-items", `"${name}" is a list: change it with item changes`]
        : !fact.userFillable
        ? ["flow/fact-not-allowed", `"${name}" cannot be given directly`]
        : !this.mayFill(name)
          ? ["flow/forbidden", `you cannot answer "${name}"`]
          : model && value === null
            ? ["flow/fact-not-allowed", "a model cannot clear facts"]
            : null;
    if (problem) {
      if (model) {
        this.note("flow/fact-ignored", `"${name}" was not used.`, [name]);
        continue;
      }
      reject(problem[0]!, problem[1]!, [name]);
    }
    values.push([name, value === null ? CLEAR : value]);
  }
  const ops = ev.items !== undefined ? checkInputOps(this, ev.items, model, false) : [];
  // Every model's value goes through the fill policy, marked or not (a value without a mark counts as stated).
  const writes = model ? this.fillPolicy(values, ev.marks ?? {}) : [...values, ...this.accepted];
  this.applyGated(writes, model ? "model" : "user", model ? "lenient" : "strict", ops);
  return this.fresh.size > 0 || this.notices.length > 0 || this.assistChanged;
}

// --- assisted filling (ADR 0012) ---------------------------------

/**
 * Splits a model's values by the fill policy. Values it may write are
 * returned, each to be written with the status `assisting` records; the
 * rest become suggestions or are dropped with a notice.
 */
export function fillPolicy(this: Machine, values: Array<[string, FactWrite]>, marks: Record<string, AssistMark>): Array<[string, FactWrite]> {
  const writes: Array<[string, FactWrite]> = [];
  for (const [name, value] of values) {
    // A model never clears: refused before this point.
    if (value === CLEAR) continue;
    const fact = this.flow.facts.get(name)!;
    const mark = own(marks, name) ?? { basis: "stated" as const };
    const mode = fillModeOf(fact, mark.cap);
    if (mode === "never") {
      this.note("flow/needs-person", `"${fact.def.title ?? name}" must come from you directly.`, [name]);
      continue;
    }
    const prev = own(this.state.facts, name);
    if (mode === "suggest" || mark.basis === "inferred" || (personOwned(prev) && mark.op !== "correct")) {
      this.propose(name, value, mark.basis);
      continue;
    }
    // A value the fact's own rules mark for confirmation stays so, even in `auto`.
    this.assisting.set(name, mode === "auto" && !fact.def.confirm ? "valid" : "needs_confirmation");
    writes.push([name, value]);
  }
  return writes;
}

/** Keeps a model's value as a suggestion on the fact. Never writes the fact's value. */
export function propose(this: Machine, name: string, value: JsonValue, basis: AssistBasis): void {
  const fact = this.flow.facts.get(name)!;
  const prev = own(this.state.facts, name) ?? { status: "missing" as const, rev: 0 };
  if (prev.status === "valid" && jsonEqual(prev.value, value)) return;
  const fails = (): boolean =>
    fact.checks.some((check) => {
      const r = this.eval(check.test, { value });
      return r.known && !truthy(r.value);
    });
  if (jsonByteLength(value) > this.flow.limits.maxFactBytes || validateValue(fact.schema, value).length > 0 || fails()) {
    // A guess that does not even fit the fact is not worth offering.
    if (basis === "stated") this.note("flow/assist-invalid", `"${fact.def.title ?? name}" was not filled: what was heard does not fit.`, [name]);
    return;
  }
  if (prev.proposed && jsonEqual(prev.proposed.value, value) && prev.proposed.basis === basis) return;
  const next: FactState = { ...prev, proposed: { value: cloneJson(value), basis, turn: this.event.id } };
  Object.defineProperty(this.state.facts, name, { value: next, enumerable: true, writable: true, configurable: true });
  this.assistChanged = true;
}

/**
 * A person's answers to the assistant: suggestions dismissed, a turn undone,
 * and values accepted (queued in `accepted` and written as the person's with
 * the event's other facts).
 */
export function onAnswers(this: Machine, ev: FactsInputEvent): void {
  const names = (list: unknown, what: string): string[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 100 || !list.every((n) => typeof n === "string")) reject("flow/invalid-event", `${what} is a list of at most 100 fact names`);
    return [...new Set(list as string[])];
  };
  const accept = acceptEntries(ev.accept);
  const dismiss = names(ev.dismiss, "dismiss");
  const check = (name: string): void => {
    const fact = this.flow.facts.get(name);
    if (!fact || fact.list) reject("flow/unknown-fact", `unknown fact "${name}"`, [name]);
    if (!fact!.userFillable) reject("flow/fact-not-allowed", `"${name}" cannot be given directly`, [name]);
    if (!this.mayFill(name)) reject("flow/forbidden", `you cannot answer "${name}"`, [name]);
    if (hasOwn(ev.facts, name)) reject("flow/invalid-event", `"${name}" is both given and answered`, [name]);
  };
  for (const name of [...accept.map((a) => a.fact), ...dismiss]) check(name);
  if (ev.undo !== undefined) {
    const undo = ev.undo as unknown;
    if (!isPlainObject(undo) || typeof undo.turn !== "string" || undo.turn.length === 0 || undo.turn.length > 128) reject("flow/invalid-event", "undo names the assistant's turn: {turn, facts?}");
    const only = (undo as { facts?: unknown }).facts === undefined ? undefined : new Set(names((undo as { facts?: unknown }).facts, "undo.facts"));
    this.undoTurn((undo as { turn: string }).turn, only);
  }
  for (const name of dismiss) {
    const st = own(this.state.facts, name);
    if (!st?.proposed) continue;
    const { proposed: _dropped, ...rest } = st;
    Object.defineProperty(this.state.facts, name, { value: rest, enumerable: true, writable: true, configurable: true });
    this.assistChanged = true;
  }
  for (const { fact: name, turn } of accept) {
    const st = own(this.state.facts, name);
    // A model's value waiting for the person's yes, marked or not (a move keeps such a value waiting and drops its mark).
    const waiting = st !== undefined && st.status === "needs_confirmation" && st.provenance === "model" && st.value !== undefined ? st : undefined;
    const proposed = st?.proposed;
    if (!waiting && !proposed) {
      this.note("flow/accept-nothing", `There was nothing to accept for "${this.title(name)}".`, [name]);
      continue;
    }
    if (turn !== undefined) {
      // The person accepts what they saw: the value from that turn, or nothing.
      if (waiting && waiting.assist?.turn === turn) this.accepted.push([name, cloneJson(waiting.value!)]);
      else if (proposed && proposed.turn === turn) this.accepted.push([name, cloneJson(proposed.value)]);
      else reject("flow/accept-stale", `"${this.title(name)}" changed since you saw it. Please look again.`, [name]);
      continue;
    }
    // Without a turn: a suggestion first (a chip names its fact), else the waiting value.
    if (proposed) this.accepted.push([name, cloneJson(proposed.value)]);
    else this.accepted.push([name, cloneJson(waiting!.value!)]);
  }
}

/**
 * Restores every fact the assistant's turn `turn` wrote (or, with `only`,
 * those of them), and drops that turn's suggestions for them. A suggestion
 * a later turn made stays: an undo never brings back an old one.
 */
export function undoTurn(this: Machine, turn: string, only?: ReadonlySet<string>): void {
  const locked = this.lockedFacts();
  let undone = 0;
  for (const [name, st] of Object.entries(this.state.facts)) {
    if (only !== undefined && !only.has(name)) continue;
    if (st.proposed?.turn === turn) {
      const { proposed: _dropped, ...rest } = st;
      Object.defineProperty(this.state.facts, name, { value: rest, enumerable: true, writable: true, configurable: true });
      this.assistChanged = true;
      undone++;
    }
    const current = own(this.state.facts, name)!;
    if (current.assist?.turn !== turn) continue;
    if (locked.has(name)) {
      this.note("flow/locked", `"${this.title(name)}" cannot be changed any more`, [name]);
      continue;
    }
    if (!this.mayFill(name)) reject("flow/forbidden", `you cannot answer "${name}"`, [name]);
    const before: FactState = current.assist.before ? bare(current.assist.before) : { status: "missing", rev: this.rev };
    this.restoreFact(name, current.proposed !== undefined ? { ...before, proposed: cloneJson(current.proposed as unknown as JsonValue) as unknown as NonNullable<FactState["proposed"]> } : before);
    undone++;
  }
  if (undone === 0) this.note("flow/undo-nothing", "There was nothing to undo.");
}

/** Puts back a fact's earlier state exactly, and clears what depended on its value if that changed. */
export function restoreFact(this: Machine, name: string, before: FactState): void {
  const prev = own(this.state.facts, name);
  const was = readable(prev);
  const now = readable(before);
  Object.defineProperty(this.state.facts, name, { value: before, enumerable: true, writable: true, configurable: true });
  this.fresh.add(name);
  this.assistChanged = true;
  if (was.known !== now.known || (was.known && now.known && !jsonEqual(was.value, now.value))) this.changed.add(name);
}

/**
 * Applies facts given directly rather than through a step's output. Each
 * must belong to a step that applies once all of the event's values are in
 * place, and a fact of a role-gated step is accepted only while that step is
 * current. Entry facts are exempt: the flow lets the starter supply them.
 * Strict mode rejects the event; lenient mode drops the refused facts.
 */
export function applyGated(this: Machine, values: Array<[string, FactWrite]>, provenance: Provenance, mode: "strict" | "lenient", ops: readonly ItemOp[] = []): void {
  let pending = values;
  // Item changes are gated the same way, after the event's plain facts.
  let pendingOps = ops;
  for (let round = 0; pending.length > 0 || pendingOps.length > 0; round++) {
    const snap = mode === "lenient" ? this.snapshot() : null;
    this.applyFacts(pending, provenance, mode);
    const applied = pendingOps.length > 0 ? applyItemOps(this, pendingOps, provenance, mode) : [];
    this.settleFacts();
    const refused = pending.filter(([name, value]) => value !== CLEAR && this.gateProblem(name) !== null);
    const refusedOps = applied.length > 0 ? itemGateProblems(this, applied, this.event.type === "run.started") : new Map<number, [string, string, string]>();
    if (refused.length === 0 && refusedOps.size === 0) return;
    if (!snap) {
      if (refused.length === 0) {
        const [code, message, name] = [...refusedOps.values()][0]!;
        reject(code, message, [name]);
      }
      const name = refused[0]![0];
      const [code, message] = this.gateProblem(name)!;
      reject(code, message, [name]);
    }
    this.restore(snap!);
    for (const [name] of refused) this.note("flow/fact-ignored", `"${this.title(name)}" was not used.`, [name]);
    for (const [, , name] of refusedOps.values()) this.note("flow/item-ignored", `A change to "${name}" was not used.`, [name]);
    const drop = new Set(refused.map(([name]) => name));
    // Dropping a fact can close another fact's step; give up after a few rounds.
    pending = round < 2 ? pending.filter(([name]) => !drop.has(name)) : [];
    pendingOps = round < 2 ? pendingOps.filter((_, i) => !refusedOps.has(i)) : [];
  }
}

export function gateProblem(this: Machine, name: string): [string, string] | null {
  return this.directProblem(name, this.event.actor, this.event.type === "run.started", readable(own(this.state.facts, name)));
}

export function title(this: Machine, name: string): string {
  return this.flow.facts.get(name)?.def.title ?? name;
}

export function snapshot(this: Machine): Snapshot {
  return {
    state: structuredClone(this.state),
    effects: this.effects.length,
    notices: this.notices.length,
    sets: this.trackers().map((set) => [...set]),
  };
}

export function restore(this: Machine, snap: Snapshot): void {
  this.state = snap.state;
  this.effects.length = snap.effects;
  this.notices.length = snap.notices;
  this.trackers().forEach((set, i) => {
    set.clear();
    for (const v of snap.sets[i]!) set.add(v);
  });
}

export function trackers(this: Machine): Array<Set<string>> {
  return [this.changed, this.fresh, this.cleared, this.restated, this.bumped, this.rows, this.ownRows];
}
