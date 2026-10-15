/**
 * The core machine's fact writes: rules, supplied input, invalidation of
 * what a change affects, and recomputing derived facts. Functions over
 * `this`, installed on Machine.
 */

import { keyOf, parseKey, templateOf } from "../address.js";
import { type CompiledStep, type CompiledRule, type CompiledAction, factNode } from "../compile.js";
import { suppliedItems, invalidateItems, recomputeField } from "../core-items-stale.js";
import { applyItemRule } from "../core-items-rules.js";
import { type Node } from "../expr.js";
import { isTooCostly } from "../expr-eval.js";
import { safeEqual } from "../hash.js";
import { type JsonValue, own, type JsonObject, jsonByteLength, formatPath, jsonEqual, cloneJson } from "../json.js";
import { checkIssue, confirmDigest, otherSchemas, readable, TOO_COSTLY_ISSUE, unchangedValid } from "../reader.js";
import { validateValue } from "../schema.js";
import { secretsOf } from "../secrets.js";
import type { Provenance, FactState, ActorRef } from "../state.js";
import { type Machine, Reject, type FactWrite, reject, payloadHas, CLEAR, bare } from "../core.js";

/**
 * Applies a rule a timer triggered (a wait timeout). Nobody can be told it
 * was refused, so a refusal leaves the facts as they were and ends the run
 * as failed instead of dropping it.
 */
export function systemRule(this: Machine, step: CompiledStep, rule: CompiledRule, payload: JsonValue): void {
  const snap = this.snapshot();
  try {
    this.applyRule(step, rule, payload, "external");
  } catch (error) {
    if (!(error instanceof Reject)) throw error;
    this.restore(snap);
    this.note("flow/rule-failed", "Something that happened outside could not be applied.", error.rejection.facts);
    this.beginEnd("failed", `rule:${error.rejection.code}`);
  }
}

// --- rules and facts ---------------------------------------------------------

/** `item`: the instance of a per-item step the rule belongs to. */
export function applyRule(this: Machine, step: CompiledStep, rule: CompiledRule, payload: JsonValue, provenance: Provenance, digest?: string, item?: string): void {
  const s = this.state;
  if (rule.cancel) {
    this.onCancel("cancelled");
    return;
  }
  const values: Array<[string, FactWrite]> = [];
  // Targets that are an item's field or a whole list.
  const itemValues: Array<[string, JsonValue, Node]> = [];
  for (const [fact, node] of rule.set) {
    // A secret only moves into a secret fact or field. The compiler refuses such a rule; this keeps it so for any flow.
    const secrets = secretsOf(this.flow);
    const source = secrets.secretRead(node, step.forEach ?? rule.addresses);
    if (source !== null && !secrets.holds(fact)) reject("flow/secret-exposed", `"${fact}" is not secret, so it cannot take the value of secret "${source}"`, [fact]);
    // A field the view did not send (a part that hides what is
    // already known) keeps its fact, rather than reading as null.
    if (node.k === "payload" && !payloadHas(payload, node.path)) continue;
    const r = this.eval(node, { payload }, item);
    if (isTooCostly(r)) reject("flow/expr-too-costly", `"${fact}" took too much work to work out`, [fact]);
    if (!r.known) reject("flow/rule-incomplete", `"${fact}" depends on something not known yet`, r.missing.facts);
    else if (fact.includes(".") || this.flow.collections.has(fact)) itemValues.push([fact, r.value, node]);
    else values.push([fact, r.value]);
  }
  const locked = this.lockedFacts();
  for (const name of [...rule.decline, ...rule.clear]) {
    if (locked.has(name)) reject("flow/locked", `"${name}" cannot be changed any more`, [name]);
  }
  if (values.length > 0) this.applyFacts(values, provenance, "strict");
  if (rule.addresses !== undefined || itemValues.length > 0 || rule.settle.length > 0 || rule.clear.some((c) => this.flow.collections.has(c))) {
    applyItemRule(this, rule, payload, itemValues, provenance, item);
  }
  for (const name of rule.decline) {
    if (name.includes(".")) continue;
    this.putFact(name, { status: "declined", rev: this.rev, by: this.event.actor.id });
  }
  for (const name of rule.clear) {
    if (name.includes(".") || this.flow.collections.has(name)) continue;
    const prev = own(s.facts, name);
    if (prev && prev.status !== "missing") {
      this.putFact(name, { status: "stale", rev: this.rev, ...(prev.value !== undefined ? { value: prev.value } : {}) });
      this.bumpFor(name);
    }
  }
  this.settleFacts();
  if (rule.retry && step.run !== undefined) {
    const res = this.currentResult(step.run, item);
    if (res && res.status === "failed") delete s.results[keyOf(step.run, item)];
  }
  if (rule.retry && step.call) this.retireCall(step);
  if (rule.confirm && step.run !== undefined) {
    const action = this.flow.actions.get(step.run)!;
    const input = this.currentInput(action, item);
    // A per-item action is confirmed for its item: the digest names it.
    const key = keyOf(action.name, item);
    if (!input.known) reject("flow/not-ready", "Some details are still missing.", input.missing.facts);
    else {
      const expected = confirmDigest(key, input.value as JsonObject, s.nonce);
      if (digest === undefined) reject("flow/confirm-needs-digest", "A confirmation must say what was reviewed.");
      else if (!safeEqual(expected, digest)) {
        reject("flow/confirm-stale", "The details changed since you reviewed them. Please review them again.");
      }
      if (action.risk === "approval") {
        // Someone else approves: not the person, not anyone acting for them, not whoever gave the details.
        const actor = this.event.actor;
        const hasRole = actor.roles.some((r) => action.approvalRoles.includes(r));
        if (!hasRole || this.isSubject(actor) || this.suppliedInput(action, item, actor.id)) reject("flow/forbidden", "This needs approval from someone else.");
      }
      const reviewer = this.event.actor;
      // Who reviewed and when (and when they signed in), and how long the review lasts.
      s.confirmations[key] = {
        digest: expected,
        by: reviewer.id,
        rev: this.rev,
        at: this.now,
        kind: reviewer.kind,
        roles: [...reviewer.roles],
        ...(action.reviewTtlMs !== undefined ? { notAfter: this.now + action.reviewTtlMs } : {}),
        ...(reviewer.authTime !== undefined ? { authTime: reviewer.authTime } : {}),
      };
    }
  }
}

/**
 * Whether `actorId` gave any input `action` reads (for a per-item action,
 * its `item`'s): a fact upstream of it, a value a call brought back from
 * them, or an item or item field.
 */
export function suppliedInput(this: Machine, action: CompiledAction, item: string | undefined, actorId: string): boolean {
  const upstream = this.flow.upstreamFacts.get(action.name) ?? new Set<string>();
  return (
    [...upstream].some((f) => own(this.state.facts, f)?.by === actorId) ||
    this.suppliedThroughCalls(upstream, actorId) ||
    (this.flow.collections.size > 0 && suppliedItems(this, action, item, actorId))
  );
}

/**
 * Sets facts. Strict mode rejects the whole event on any refusal; lenient
 * mode (model proposals) skips refused facts with a notice.
 */
export function applyFacts(this: Machine, values: Array<[string, FactWrite]>, provenance: Provenance, mode: "strict" | "lenient"): void {
  const s = this.state;
  const locked = this.lockedFacts();
  const refuse = (code: string, message: string, name: string) => {
    if (mode === "strict") reject(code, message, [name]);
    this.note("flow/fact-ignored", message, [name]);
  };
  const accepted: string[] = [];
  // The state each assistant's write replaced, put back exactly if the value fails the fact's checks.
  const replaced = new Map<string, FactState | undefined>();
  for (const [name, value] of values) {
    const fact = this.flow.facts.get(name);
    if (!fact) {
      refuse("flow/unknown-fact", `unknown fact "${name}"`, name);
      continue;
    }
    if (fact.derive) {
      refuse("flow/fact-not-allowed", `"${name}" is worked out automatically`, name);
      continue;
    }
    if (locked.has(name)) {
      refuse("flow/locked", `"${fact.def.title ?? name}" cannot be changed any more`, name);
      continue;
    }
    if (provenance === "model" && fact.def.userAsserted) {
      this.note("flow/needs-person", `"${fact.def.title ?? name}" must come from you directly.`, [name]);
      continue;
    }
    const prev = own(s.facts, name);
    if (value === CLEAR) {
      if (prev && prev.status !== "missing") {
        this.putFact(name, { status: "missing", rev: this.rev });
        this.bumpFor(name);
      }
      continue;
    }
    if (jsonByteLength(value) > this.flow.limits.maxFactBytes) {
      this.putFact(name, { status: "invalid", rev: this.rev, issues: [{ code: "too-large", message: "This is too large.", path: "" }], provenance, by: this.event.actor.id });
      accepted.push(name);
      continue;
    }
    const issues = validateValue(fact.schema, value, [], this.patternBudget).map((i) => ({ code: i.code, message: i.message, path: formatPath(i.path) }));
    const assisted = provenance === "model" ? this.assisting.get(name) : undefined;
    if (assisted !== undefined && issues.length > 0) {
      // An assistant's value that does not fit is not written; the person is told why.
      this.note("flow/assist-invalid", `"${fact.def.title ?? name}" was not filled: ${issues[0]!.message}`, [name]);
      continue;
    }
    const status = issues.length > 0 ? "invalid" : assisted ?? (provenance === "model" && fact.def.confirm ? "needs_confirmation" : "valid");
    const same = prev !== undefined && prev.value !== undefined && jsonEqual(prev.value, value);
    if (same && (prev.status === status || (prev.status === "valid" && status === "needs_confirmation"))) {
      // Unchanged: a model restating a valid answer does not reopen it, and a
      // restated fact is not cleared by what else changed in this event. A
      // person restating a model's value still counts as confirming it.
      this.restated.add(name);
      if (prev.provenance === "model" && provenance !== "model") this.putFact(name, { ...prev, provenance, by: this.event.actor.id });
      accepted.push(name);
      continue;
    }
    if (assisted !== undefined) replaced.set(name, prev);
    this.putFact(name, {
      status,
      value: cloneJson(value),
      provenance,
      rev: this.rev,
      by: this.event.actor.id,
      ...(issues.length > 0 ? { issues } : {}),
      // What an undo of this turn puts back, one step deep: never an earlier mark or suggestion.
      ...(assisted !== undefined ? { assist: { turn: this.event.id, before: prev ? bare(prev) : null } } : {}),
    });
    accepted.push(name);
  }
  // Cross-field checks run once every value of this event is in place.
  for (const name of accepted) {
    const fact = this.flow.facts.get(name)!;
    const current = s.facts[name]!;
    if (current.status !== "valid" && current.status !== "needs_confirmation") continue;
    const issues = [];
    for (const check of fact.checks) {
      const issue = checkIssue(this.eval(check.test, { value: current.value ?? null }), check);
      if (issue) issues.push(issue);
    }
    if (issues.length === 0) continue;
    if (replaced.has(name)) {
      // An assistant's value that fails the fact's checks is not written, as one of the wrong type is not.
      const prev = replaced.get(name);
      if (prev === undefined) delete s.facts[name];
      else Object.defineProperty(s.facts, name, { value: prev, enumerable: true, writable: true, configurable: true });
      this.fresh.delete(name);
      this.changed.delete(name);
      this.note("flow/assist-invalid", `"${fact.def.title ?? name}" was not filled: ${issues[0]!.message}`, [name]);
      continue;
    }
    this.putFact(name, { ...current, status: "invalid", issues });
  }
}

/** Replaces a fact's state and records whether its readable value changed. */
export function putFact(this: Machine, name: string, next: FactState): void {
  const s = this.state;
  const prev = own(s.facts, name);
  // Writing a fact settles any suggestion for it, and only this event's own assisted write stays marked.
  if (next.proposed !== undefined || (next.assist !== undefined && next.assist.turn !== this.event.id)) {
    const { proposed: _p, assist, ...rest } = next;
    next = assist !== undefined && assist.turn === this.event.id ? { ...rest, assist } : rest;
  }
  const before = readable(prev);
  const after = readable(next);
  Object.defineProperty(s.facts, name, { value: next, enumerable: true, writable: true, configurable: true });
  this.fresh.add(name);
  if (before.known !== after.known || (before.known && after.known && !jsonEqual(before.value, after.value))) this.changed.add(name);
}

/**
 * Marks facts downstream of `node` stale, keeping their values for prefill.
 * Stops at facts restated in this event (their own change propagates),
 * at derived facts (recomputed, and propagate only if their value changes)
 * and at actions (their dependents are cleared only if the output changes).
 */
export function invalidateFrom(this: Machine, start: string, item?: string): void {
  // With collections, the walk follows items as well (core-items.ts).
  if (this.flow.collections.size > 0) {
    invalidateItems(this, start, item);
    return;
  }
  const s = this.state;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of this.flow.dependents.get(node) ?? []) {
      if (seen.has(next) || !next.startsWith("f:")) continue;
      seen.add(next);
      const name = next.slice(2);
      if (this.fresh.has(name) || this.restated.has(name) || this.flow.facts.get(name)?.derive) continue;
      const st = own(s.facts, name);
      if (st && st.status !== "missing" && st.status !== "stale") {
        const stale: FactState = { status: "stale", rev: this.rev, ...(st.value !== undefined ? { value: st.value } : {}) };
        Object.defineProperty(s.facts, name, { value: stale, enumerable: true, writable: true, configurable: true });
        this.cleared.add(name);
        this.bumpFor(name);
      }
      queue.push(next);
    }
  }
}

/** Clears what depended on changed facts, then recomputes derived facts. */
export function settleFacts(this: Machine): void {
  const batch = [...this.changed];
  this.changed.clear();
  for (const name of batch) {
    // An item's field (`c[i].f`) starts from its template, for that item.
    const at = this.flow.collections.size > 0 ? parseKey(name) : null;
    if (at && at.item !== undefined && at.field !== undefined) this.invalidateFrom(factNode(templateOf(at.name, at.field)), at.item);
    else this.invalidateFrom(factNode(name));
  }
  this.recomputeDerived();
}

export function recomputeDerived(this: Machine): void {
  const s = this.state;
  for (const name of this.flow.derivedOrder) {
    if (name.includes(".")) {
      // A derived item field, once per live item.
      recomputeField(this, name);
      continue;
    }
    const fact = this.flow.facts.get(name)!;
    const r = this.eval(fact.derive!);
    const prev = own(s.facts, name);
    let next: FactState;
    // Too costly to work out is a failure, never a value and never "not known yet".
    if (isTooCostly(r)) next = { status: "invalid", issues: [{ ...TOO_COSTLY_ISSUE }], provenance: "derived", rev: this.rev };
    else if (!r.known) next = { status: "missing", rev: prev?.rev ?? 0 };
    else if (unchangedValid(prev, r.value, otherSchemas(this.flow, this.state, this.event))) continue;
    else if (jsonByteLength(r.value) > this.flow.limits.maxFactBytes) {
      next = { status: "invalid", issues: [{ code: "too-large", message: "This is too large.", path: "" }], provenance: "derived", rev: this.rev };
    } else {
      const issues = validateValue(fact.schema, r.value, [], this.patternBudget).map((i) => ({ code: i.code, message: i.message, path: formatPath(i.path) }));
      next = issues.length > 0 ? { status: "invalid", value: r.value, issues, provenance: "derived", rev: this.rev } : { status: "valid", value: r.value, provenance: "derived", rev: this.rev };
    }
    if (prev && prev.status === next.status && jsonEqual(prev.value, next.value)) continue;
    const before = readable(prev);
    const after = readable(next);
    Object.defineProperty(s.facts, name, { value: next, enumerable: true, writable: true, configurable: true });
    if (before.known !== after.known || (before.known && after.known && !jsonEqual(before.value, after.value))) {
      this.invalidateFrom(factNode(name));
    }
  }
}

/** Before the values are applied: whether some step that asks for `name` lets this actor answer. */
export function mayFill(this: Machine, name: string): boolean {
  const actor = this.event.actor;
  const asks = this.flow.askedBy.get(name) ?? [];
  if (this.flow.entry.has(name) && (this.event.type === "run.started" || asks.length === 0)) return this.canAnswerDefault(actor);
  return asks.some((a) => this.canAnswer(this.flow.stepById.get(a.stepId)!, actor));
}

/** The run's person (or anyone who may answer for them), or whoever may answer the current step. */
export function mayResume(this: Machine, actor: ActorRef): boolean {
  if (this.canAnswerDefault(actor)) return true;
  const current = this.state.current ? this.flow.stepById.get(this.state.current) : undefined;
  return current !== undefined && this.canAnswer(current, actor);
}

export function assertCanAnswer(this: Machine, step: CompiledStep): void {
  if (!this.canAnswer(step, this.event.actor)) reject("flow/forbidden", "You cannot answer this step.");
}
