/**
 * Masking secrets in a person's data export (`exportSubject`).
 *
 * A secret (`sensitivity: "secret"`, or a fact or field derived from one)
 * never reaches a view, a trace or a decider, but its value is in the run's
 * state, and in the events it came from: the output whose payload set it, a
 * call's input, an action's input and output. An export goes to a person or
 * a privacy team, so by default every value a secret held is replaced with
 * {@link REDACTED}, wherever it appears in the run's state and events.
 *
 * Which values those are is found by provenance, not by value (ADR 0014):
 * the run is replayed through the definitions it ran under, and a value is
 * masked whole where they say a secret reaches it, however an expression
 * changed it: a secret fact's or item field's value; an input key of an
 * action, a hold or a call whose expression reads a secret; the part of a
 * payload or an output a secret is set or derived from. As a backstop, any
 * value equal to a whole value a secret held is masked anywhere in the
 * export. A run whose definitions cannot be loaded, or whose events do not
 * replay, cannot say which of its values are secret: every value it carries
 * is masked instead. A hash over secret data (an input's or an output's
 * fingerprint, a confirmation's digest) is masked with it, since a short
 * secret is found again by hashing every candidate.
 */

import { nameOfKey, templateOf } from "./address.js";
import type { CompiledFlow, NodeEntries } from "./compile.js";
import { step, type StepResult } from "./core.js";
import { nodeChildren, type Node } from "./expr.js";
import { canonicalJson, isJsonObject, type JsonObject, type JsonValue, type PathSegment } from "./json.js";
import { migrateStep } from "./migrate.js";
import type { FlowResolver } from "./replay.js";
import { secretsOf } from "./secrets.js";
import type { FlowEvent, RunState } from "./state.js";
import type { StoredEvent } from "./store.js";
import { readStoredEvent } from "./stored-versions.js";
import { REDACTED } from "./view.js";

/** One run of an export: its state and its events as stored. */
export interface ExportedRun {
  state: RunState;
  events: StoredEvent[];
}

/** The definitions a run ran under, by `flowId@version` and hash, as `replay` takes them. */
export function versionsOf(run: ExportedRun): Array<{ flowId: string; version: string; hash: string }> {
  const out: Array<{ flowId: string; version: string; hash: string }> = [];
  for (const stored of run.events) {
    const ev = stored.event as Partial<FlowEvent> & { type?: string };
    if (ev.type === "run.started") {
      const started = ev as Extract<FlowEvent, { type: "run.started" }>;
      out.push({ flowId: started.flowId, version: started.flowVersion, hash: started.flowHash });
    } else if (ev.type === "run.migrated") {
      const moved = ev as Extract<FlowEvent, { type: "run.migrated" }>;
      out.push({ flowId: run.state.flowId, version: moved.to.version, hash: moved.to.hash });
    }
  }
  return out;
}

/**
 * What replaying a run tells about its secrets: every value a secret fact or
 * item field held, and every value sent in an input key that reads secret
 * data, as canonical JSON (null and booleans left out: they say
 * nothing a secret hides, and would mask every flag in the export); the
 * definitions it ran under; and, for each event that settles an effect (by
 * its index), the action the effect belongs to. `texts` holds each string
 * and number inside those values, as text, to find inside a longer string.
 */
export interface RunSecrets {
  values: Set<string>;
  texts: Set<string>;
  flows: CompiledFlow[];
  effectActions: Map<number, string>;
}

/** The flow action an effect belongs to, in the state before its event. */
function actionOfEffect(state: RunState | null, effectId: string): string | undefined {
  if (!state) return undefined;
  const inflight = Object.hasOwn(state.inflight, effectId) ? state.inflight[effectId] : undefined;
  if (inflight) return inflight.action;
  for (const [key, res] of Object.entries(state.results)) if (res.effectId === effectId) return nameOfKey(key);
  for (const [id, held] of Object.entries(state.resources)) if (id === effectId || held.releaseEffectId === effectId) return held.action;
  return undefined;
}

/** Replays a run through its definitions ({@link RunSecrets}); null when its definitions or events cannot tell (then the run is masked whole). */
export function runSecretsOf(resolve: FlowResolver, events: readonly StoredEvent[]): RunSecrets | null {
  const values = new Set<string>();
  const texts = new Set<string>();
  const flows: CompiledFlow[] = [];
  const effectActions = new Map<number, string>();
  const leaves = (value: JsonValue): void => {
    if (typeof value === "string" && value.length > 0) texts.add(value);
    else if (typeof value === "number") texts.add(String(value));
    else if (Array.isArray(value)) value.forEach(leaves);
    else if (isJsonObject(value)) Object.values(value).forEach(leaves);
  };
  const keep = (value: JsonValue | undefined): void => {
    if (value === undefined || value === null || typeof value === "boolean") return;
    values.add(canonicalJson(value));
    leaves(value);
  };
  let state: RunState | null = null;
  let flow: CompiledFlow | null = null;
  try {
    for (const [index, stored] of events.entries()) {
      const event = readStoredEvent(stored.event);
      let result: StepResult;
      if (event.type === "run.started") {
        flow = resolve(event.flowId, event.flowVersion, event.flowHash);
        if (!flow || flow.hash !== event.flowHash) return null;
        if (!flows.includes(flow)) flows.push(flow);
      }
      if (!flow) return null;
      if (event.type === "action.settled" || event.type === "effect.resolved") {
        const action = actionOfEffect(state, event.effectId);
        if (action !== undefined) effectActions.set(index, action);
      }
      if (event.type === "run.migrated") {
        if (!state) return null;
        const to = resolve(state.flowId, event.to.version, event.to.hash);
        if (!to || to.hash !== event.to.hash) return null;
        result = migrateStep(flow, to, state, event);
        if (result.accepted) {
          flow = to;
          if (!flows.includes(to)) flows.push(to);
        }
      } else {
        result = step(flow, state, event);
      }
      if (!result.accepted) return null;
      state = result.state;
      const secrets = secretsOf(flow);
      for (const [name, fact] of Object.entries(state.facts)) {
        if (secrets.secretIn(name) === null) continue;
        keep(fact.value);
        // 0.3: a value only ever offered, or one an assistant's fill replaced, was the secret's too.
        keep(fact.proposed?.value);
        keep(fact.assist?.before?.value);
      }
      for (const item of Object.values(state.items ?? {})) {
        for (const [field, fact] of Object.entries(item.fields)) if (secrets.secretIn(templateOf(item.collection, field)) !== null) keep(fact.value);
      }
      // A value computed from a secret and sent is the secret's too: a service may answer it back ("Bearer " and a token).
      const sent = (input: JsonObject, entries: NodeEntries | undefined, itemOf?: string): void => {
        for (const [k, node] of entries ?? []) if (Object.hasOwn(input, k) && secrets.secretRead(node, itemOf) !== null) keep(input[k]);
      };
      for (const [key, res] of Object.entries(state.results)) {
        const action = flow.actions.get(nameOfKey(key));
        sent(res.input, action?.call.input, action?.forEach);
      }
      for (const held of Object.values(state.resources)) {
        const action = flow.actions.get(held.action);
        sent(held.input, action?.call.input, action?.forEach);
      }
      for (const call of Object.values(state.calls ?? {})) sent(call.input, flow.stepById.get(call.key)?.call?.input);
    }
  } catch {
    return null;
  }
  return { values, texts, flows, effectActions };
}

/** Every value a secret fact or item field of the run held ({@link runSecretsOf}), or null when the run cannot tell. */
export function secretValuesOf(resolve: FlowResolver, events: readonly StoredEvent[]): Set<string> | null {
  return runSecretsOf(resolve, events)?.values ?? null;
}

/** The paths of an expression's payload reads. */
function payloadReads(node: Node, out: PathSegment[][]): void {
  if (node.k === "payload") out.push(node.path);
  for (const child of nodeChildren(node)) payloadReads(child, out);
}

/**
 * The payload paths a definition's rules read into a secret: the parts of an
 * output's, an outside event's or a call's payload that are secret. Every
 * other question (which input keys, which output paths) is the tracer's
 * ({@link secretsOf}).
 */
const payloadPlans = new WeakMap<CompiledFlow, Map<string, PathSegment[][]>>();

function payloadsOf(flow: CompiledFlow): Map<string, PathSegment[][]> {
  let plan = payloadPlans.get(flow);
  if (plan) return plan;
  const secrets = secretsOf(flow);
  const holdsSecret = (target: string): boolean => {
    const list = flow.collections.get(target);
    if (list) return [...list.fields.keys()].some((f) => secrets.secretIn(templateOf(target, f)) !== null);
    return secrets.secretIn(target) !== null;
  };
  plan = new Map();
  for (const st of flow.steps) {
    for (const [ruleName, rule] of st.rules) {
      const reads: PathSegment[][] = [];
      for (const [target, node] of rule.set) if (holdsSecret(target)) payloadReads(node, reads);
      if (reads.length > 0) plan.set(`${st.id}\u0000${ruleName}`, reads);
    }
  }
  payloadPlans.set(flow, plan);
  return plan;
}

/** `value` with the part at `path` masked whole; a path that is not there masks nothing. */
function maskAt(value: JsonValue, path: readonly PathSegment[]): JsonValue {
  if (value === null) return null;
  if (path.length === 0) return REDACTED;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    if (typeof head !== "number" || head < 0 || head >= value.length) return value;
    return value.map((v, i) => (i === head ? maskAt(v, rest) : v));
  }
  if (isJsonObject(value) && typeof head === "string" && Object.hasOwn(value, head)) return { ...value, [head]: maskAt(value[head]!, rest) };
  return value;
}

const maskPaths = (value: JsonValue, paths: readonly PathSegment[][]): JsonValue => paths.reduce(maskAt, value);

/**
 * A copy of the run with every value masked whose provenance is a secret,
 * by the definitions it ran under (any of them saying so is enough): a
 * secret fact's or item field's value wherever it is given or held; an input
 * key of an action, a hold or a call whose expression reads a secret, however
 * it changed it; the parts of a payload or an output a secret is set or
 * derived from. Each is masked whole. What no definition can place (an
 * action, a step or a child flow none of them names) is masked whole too.
 */
function maskByProvenance(run: ExportedRun, found: RunSecrets, resolve: FlowResolver): ExportedRun {
  const all = found.flows.map((flow) => ({ flow, secrets: secretsOf(flow), payloads: payloadsOf(flow) }));
  const secretName = (name: string): boolean => all.some((x) => x.secrets.secretIn(name) !== null);
  const hide = (v: JsonValue): JsonValue => (v === null ? null : REDACTED);
  const facts = <T extends Record<string, JsonValue | null>>(record: T, field: (k: string) => string = (k) => k): T =>
    isJsonObject(record as JsonValue) ? (Object.fromEntries(Object.entries(record).map(([k, v]) => [k, secretName(field(k)) ? hide(v as JsonValue) : v])) as T) : record;
  const itemOps = (ops: unknown): unknown =>
    Array.isArray(ops)
      ? ops.map((op: unknown) => {
          if (!isJsonObject(op as JsonValue) || !isJsonObject((op as { fields?: JsonValue }).fields ?? null)) return op;
          const o = op as { collection: string; fields: JsonObject };
          return { ...o, fields: facts(o.fields, (f) => templateOf(o.collection, f)) };
        })
      : ops;
  /** An action's or a call's input, a key at a time: masked where its expression reads a secret, whole where nothing names it. */
  const input = (record: JsonObject, entries: (x: (typeof all)[number]) => { input: NodeEntries; itemOf?: string } | undefined): JsonObject => {
    const known = all.map((x) => ({ x, call: entries(x) })).filter((c) => c.call !== undefined);
    if (known.length === 0) return Object.fromEntries(Object.keys(record).map((k) => [k, hide(record[k]!)]));
    return Object.fromEntries(
      Object.entries(record).map(([k, v]) => {
        const nodes = known.map(({ x, call }) => [x, call!.input.find(([key]) => key === k)?.[1], call!.itemOf] as const);
        const secret = nodes.some(([x, node, itemOf]) => node === undefined || x.secrets.secretRead(node, itemOf) !== null);
        return [k, secret ? hide(v) : v];
      }),
    );
  };
  const actionInput = (name: string, record: JsonObject): JsonObject =>
    input(record, (x) => {
      const action = x.flow.actions.get(name);
      return action ? { input: action.call.input, ...(action.forEach !== undefined ? { itemOf: action.forEach } : {}) } : undefined;
    });
  const callInput = (stepId: string, record: JsonObject): JsonObject =>
    input(record, (x) => {
      const call = x.flow.stepById.get(stepId)?.call;
      return call ? { input: call.input } : undefined;
    });
  /** An action whose input reads a secret in any definition, or that none of them names: a digest over its input is masked. */
  const inputReadsSecret = (name: string): boolean => {
    const known = all.filter((x) => x.flow.actions.has(name));
    return known.length === 0 || known.some((x) => x.flow.actions.get(name)!.call.input.some(([, node]) => x.secrets.secretRead(node, x.flow.actions.get(name)!.forEach) !== null));
  };
  /** An action whose output holds secret data in any definition, or whose input reads it (an output may echo it), or that none of them names. */
  const outputHoldsSecret = (name: string): boolean => inputReadsSecret(name) || all.some((x) => x.secrets.secretResults(name).length > 0);
  /**
   * A secret echoed inside a longer string: every secret value of the run,
   * and every value an input key carrying secret data was sent, as text,
   * replaced wherever it appears (ignoring case) in a string of an answer to
   * an action whose input reads secret data. Longest first, so a value never
   * leaves part of a longer one behind.
   */
  const needles = [...found.texts].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const pattern = needles.length === 0 ? null : new RegExp(needles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  const scrubText = (text: string): string => (pattern === null ? text : text.replace(pattern, REDACTED));
  const scrub = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return scrubText(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    return value;
  };
  /** An answer's error: its text scrubbed when it answers an action that read secret data; whole when nothing can say which action it answers. */
  const scrubError = <E extends { message: string; detail?: string }>(error: E, reads: boolean | null): E => {
    if (reads === false) return error;
    const text = (t: string): string => (reads === null ? REDACTED : scrubText(t));
    return { ...error, message: text(error.message), ...(error.detail !== undefined ? { detail: text(error.detail) } : {}) };
  };
  /** Whether an action's answers may echo secret data: true or false, or null when no definition names the action. */
  const answersSecret = (name: string | undefined): boolean | null => (name === undefined || !all.some((x) => x.flow.actions.has(name)) ? null : inputReadsSecret(name));
  /** An action's answer (an output) scrubbed when the action read secret data. */
  const scrubOutput = (name: string | undefined, output: JsonValue): JsonValue => (answersSecret(name) === false ? output : scrub(output));
  /** A call step whose input reads a secret in any definition, or that none of them names. */
  const callReadsSecret = (stepId: string): boolean => {
    const known = all.flatMap((x) => {
      const call = x.flow.stepById.get(stepId)?.call;
      return call ? [{ x, call }] : [];
    });
    return known.length === 0 || known.some(({ x, call }) => call.input.some(([, node]) => x.secrets.secretRead(node) !== null));
  };
  const actionOutput = (name: string | undefined, output: JsonValue): JsonValue => {
    if (name === undefined || !all.some((x) => x.flow.actions.has(name))) return hide(output);
    return maskPaths(output, all.flatMap((x) => x.secrets.secretResults(name)));
  };
  const payload = (stepIds: readonly string[], rule: string, value: JsonValue): JsonValue =>
    maskPaths(value, all.flatMap((x) => stepIds.flatMap((id) => x.payloads.get(`${id}\u0000${rule}`) ?? [])));
  const stepsWithRule = (rule: string): string[] => [...new Set(all.flatMap((x) => x.flow.steps.filter((st) => st.rules.has(rule)).map((st) => st.id)))];
  /** A child's output, a key at a time: masked where the child holds a secret under that name, or where the caller's rules read it into one; whole when the child does not load. */
  const callOutput = (call: { key: string; flowId: string; flowVersion: string; flowHash?: string } | undefined, output: JsonObject): JsonObject => {
    const child = call?.flowHash !== undefined ? resolve(call.flowId, call.flowVersion, call.flowHash) : null;
    if (!call || !child || child.hash !== call.flowHash) return Object.fromEntries(Object.keys(output).map((k) => [k, hide(output[k]!)]));
    const childSecrets = secretsOf(child);
    const byChild = Object.fromEntries(Object.entries(output).map(([k, v]) => [k, childSecrets.secretIn(k) !== null ? hide(v) : v]));
    return payload([call.key], "completed", byChild) as JsonObject;
  };

  const state = structuredClone(run.state);
  for (const [name, fact] of Object.entries(state.facts)) {
    if (!secretName(name)) continue;
    if (fact.value !== undefined) fact.value = hide(fact.value);
    if (fact.proposed !== undefined) fact.proposed.value = hide(fact.proposed.value);
    if (fact.assist?.before?.value !== undefined) fact.assist.before.value = hide(fact.assist.before.value);
  }
  for (const item of Object.values(state.items ?? {})) {
    for (const [f, field] of Object.entries(item.fields)) if (field.value !== undefined && secretName(templateOf(item.collection, f))) field.value = hide(field.value);
  }
  for (const [key, res] of Object.entries(state.results)) {
    const name = nameOfKey(key);
    res.input = actionInput(name, res.input);
    if (res.output !== undefined) res.output = scrubOutput(name, actionOutput(name, res.output));
    if (res.error !== undefined) res.error = scrubError(res.error, answersSecret(name));
  }
  for (const held of Object.values(state.resources)) {
    held.input = actionInput(held.action, held.input);
    if (held.output !== undefined) held.output = scrubOutput(held.action, actionOutput(held.action, held.output));
    if (held.error !== undefined) held.error = scrubError(held.error, answersSecret(held.action));
  }
  // A notice about an action may repeat its error's text.
  state.notices = state.notices.map((n) => (n.action === undefined ? n : scrubError(n, answersSecret(nameOfKey(n.action)))));
  for (const call of Object.values(state.calls ?? {})) {
    call.input = callInput(call.key, call.input);
    const reads = callReadsSecret(call.key);
    if (call.end?.output !== undefined) call.end.output = callOutput(call, call.end.output);
    if (call.end?.output !== undefined && reads) call.end.output = scrub(call.end.output) as JsonObject;
    if (call.end?.error !== undefined) call.end.error = scrubError(call.end.error, reads);
  }
  // Every hash over secret data is masked by where its value comes from, whatever it holds now: a fingerprint is an unsalted
  // SHA-256, and a digest is salted only with the run's nonce, which the export carries, so either gives a short secret back.
  for (const [key, res] of Object.entries(state.results)) if (inputReadsSecret(nameOfKey(key))) res.fingerprint = REDACTED;
  for (const key of Object.keys(state.outputs)) if (outputHoldsSecret(nameOfKey(key))) state.outputs[key] = REDACTED;
  for (const held of Object.values(state.resources)) if (inputReadsSecret(held.action)) held.fingerprint = REDACTED;
  for (const call of Object.values(state.calls ?? {})) if (callReadsSecret(call.key)) call.fingerprint = REDACTED;
  for (const [key, conf] of Object.entries(state.confirmations)) if (inputReadsSecret(nameOfKey(key))) conf.digest = REDACTED;
  const calls = run.state.calls ?? {};
  const events = run.events.map((stored, index) => {
    const ev = structuredClone(stored.event) as unknown as Record<string, unknown>;
    switch (ev.type) {
      case "run.started":
      case "facts.input":
        ev.facts = facts(ev.facts as Record<string, JsonValue>);
        if (ev.items !== undefined) ev.items = itemOps(ev.items);
        break;
      case "output": {
        ev.payload = payload([ev.stepId as string], ev.name as string, ev.payload as JsonValue);
        if (ev.digest !== undefined) {
          const runs = all.flatMap((x) => x.flow.stepById.get(ev.stepId as string)?.run ?? []);
          if (runs.length === 0 || runs.some(inputReadsSecret)) ev.digest = REDACTED;
        }
        break;
      }
      case "external":
        ev.payload = payload(stepsWithRule(ev.event as string), ev.event as string, ev.payload as JsonValue);
        break;
      case "action.settled": {
        const name = found.effectActions.get(index);
        const outcome = ev.outcome as { output?: JsonValue; error?: { message: string; detail?: string } };
        if (isJsonObject(outcome as JsonValue)) {
          ev.outcome = {
            ...outcome,
            ...(outcome.output !== undefined ? { output: scrubOutput(name, actionOutput(name, outcome.output)) } : {}),
            ...(isJsonObject((outcome.error ?? null) as JsonValue) ? { error: scrubError(outcome.error!, answersSecret(name)) } : {}),
          };
        }
        break;
      }
      case "effect.resolved": {
        const name = found.effectActions.get(index);
        if (ev.output !== undefined) ev.output = scrubOutput(name, actionOutput(name, ev.output as JsonValue));
        break;
      }
      case "call.settled": {
        const call = Object.hasOwn(calls, ev.callId as string) ? calls[ev.callId as string] : undefined;
        const reads = call === undefined ? null : callReadsSecret(call.key);
        const end = ev.end as { output?: JsonValue; error?: { message: string; detail?: string } };
        if (isJsonObject(end as JsonValue)) {
          const output = isJsonObject(end.output ?? null) ? callOutput(call, end.output as JsonObject) : undefined;
          ev.end = {
            ...end,
            ...(output !== undefined ? { output: reads === false ? output : scrub(output) } : {}),
            ...(isJsonObject((end.error ?? null) as JsonValue) ? { error: scrubError(end.error!, reads) } : {}),
          };
        }
        break;
      }
    }
    return { ...stored, event: ev as unknown as FlowEvent };
  });
  return { state, events };
}

/** A copy of `value` with every part equal to one of `secrets` replaced. */
export function maskValues<T>(value: T, secrets: ReadonlySet<string>): T {
  if (secrets.size === 0) return structuredClone(value);
  // A list or an object is compared whole only when a secret is one.
  const composite = [...secrets].some((s) => s.startsWith("{") || s.startsWith("["));
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if ((typeof v === "string" || typeof v === "number" || (composite && typeof v === "object")) && secrets.has(canonicalJson(v as JsonValue))) return REDACTED;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * A copy of the run with `f` applied to every value it carries, and to
 * nothing else: facts' and item fields' values (offered and replaced ones
 * too), payloads, the inputs of actions, holds and calls, and what each gave
 * back. A record of values (facts given at once, an input, a call's output)
 * is passed one key at a time.
 */
function atValues(run: ExportedRun, f: (value: JsonValue) => JsonValue): ExportedRun {
  const each = <T>(record: T): T => (isJsonObject(record as JsonValue) ? (Object.fromEntries(Object.entries(record as JsonObject).map(([k, v]) => [k, f(v)])) as T) : record);
  const itemOps = (ops: unknown): unknown =>
    Array.isArray(ops) ? ops.map((op: unknown) => (isJsonObject(op as JsonValue) && isJsonObject((op as { fields?: JsonValue }).fields ?? null) ? { ...(op as object), fields: each((op as { fields: JsonObject }).fields) } : op)) : ops;
  const state = structuredClone(run.state);
  for (const fact of Object.values(state.facts)) {
    if (fact.value !== undefined) fact.value = f(fact.value);
    if (fact.proposed !== undefined) fact.proposed.value = f(fact.proposed.value);
    if (fact.assist?.before?.value !== undefined) fact.assist.before.value = f(fact.assist.before.value);
  }
  for (const item of Object.values(state.items ?? {})) for (const field of Object.values(item.fields)) if (field.value !== undefined) field.value = f(field.value);
  for (const res of Object.values(state.results)) {
    res.input = each(res.input);
    if (res.output !== undefined) res.output = f(res.output);
  }
  for (const held of Object.values(state.resources)) {
    held.input = each(held.input);
    if (held.output !== undefined) held.output = f(held.output);
  }
  for (const call of Object.values(state.calls ?? {})) {
    call.input = each(call.input);
    if (call.end?.output !== undefined) call.end.output = each(call.end.output);
  }
  const events = run.events.map((stored) => {
    const ev = structuredClone(stored.event) as unknown as Record<string, unknown>;
    switch (ev.type) {
      case "run.started":
      case "facts.input":
        ev.facts = each(ev.facts);
        if (ev.items !== undefined) ev.items = itemOps(ev.items);
        break;
      case "output":
      case "external":
        if (ev.payload !== undefined) ev.payload = f(ev.payload as JsonValue);
        break;
      case "action.settled":
        if (isJsonObject(ev.outcome as JsonValue) && (ev.outcome as { output?: JsonValue }).output !== undefined) ev.outcome = { ...(ev.outcome as object), output: f((ev.outcome as { output: JsonValue }).output) };
        break;
      case "effect.resolved":
        if (ev.output !== undefined) ev.output = f(ev.output as JsonValue);
        break;
      case "call.settled":
        if (isJsonObject(ev.end as JsonValue) && isJsonObject((ev.end as { output?: JsonValue }).output ?? null)) ev.end = { ...(ev.end as object), output: each((ev.end as { output: JsonObject }).output) };
        break;
    }
    return { ...stored, event: ev as unknown as FlowEvent };
  });
  return { state, events };
}

/** A run masked whole: every value it carries ({@link atValues}), in its state and events; a null value stays null. */
export function maskWhole(run: ExportedRun): ExportedRun {
  const masked = atValues(run, (v) => (v === null ? null : REDACTED));
  // Nothing says which hashes are over a secret: every one is masked.
  for (const res of Object.values(masked.state.results)) res.fingerprint = REDACTED;
  for (const key of Object.keys(masked.state.outputs)) masked.state.outputs[key] = REDACTED;
  for (const held of Object.values(masked.state.resources)) held.fingerprint = REDACTED;
  for (const call of Object.values(masked.state.calls ?? {})) call.fingerprint = REDACTED;
  for (const conf of Object.values(masked.state.confirmations)) conf.digest = REDACTED;
  // A correlation key is a value too (a definition that loads never correlates on a secret: `flow/secret-correlate`).
  for (const wait of Object.values(masked.state.waits)) wait.key = REDACTED;
  for (const stored of masked.events) {
    if (stored.event.type === "output" && stored.event.digest !== undefined) stored.event.digest = REDACTED;
    if (stored.event.type === "external") stored.event.key = REDACTED;
  }
  return masked;
}

/**
 * The backstop for hashes: `masked` with every hash over a value that was
 * masked (by provenance or by the whole-value backstop) masked too, against
 * the run as stored. An input's fingerprint (a result's, a hold's, a call's),
 * an output's fingerprint and a confirmation's digest become
 * {@link REDACTED} wherever any part of what they hash was masked.
 * Provenance already masks each hash whose action reads or returns secret
 * data, whatever it holds now ({@link maskByProvenance}).
 */
function maskHashes(stored: ExportedRun, masked: ExportedRun): ExportedRun {
  const changed = (a: JsonValue | undefined, b: JsonValue | undefined): boolean => a !== undefined && (b === undefined || canonicalJson(a) !== canonicalJson(b));
  const state = masked.state;
  const digests = new Set<string>();
  for (const [key, res] of Object.entries(state.results)) {
    const was = Object.hasOwn(stored.state.results, key) ? stored.state.results[key] : undefined;
    if (!was) continue;
    if (changed(was.input, res.input)) {
      res.fingerprint = REDACTED;
      const conf = Object.hasOwn(state.confirmations, key) ? state.confirmations[key] : undefined;
      if (conf) conf.digest = REDACTED;
    }
    if (changed(was.output, res.output) && Object.hasOwn(state.outputs, key)) state.outputs[key] = REDACTED;
  }
  for (const [id, held] of Object.entries(state.resources)) {
    const was = Object.hasOwn(stored.state.resources, id) ? stored.state.resources[id] : undefined;
    if (was && changed(was.input, held.input)) held.fingerprint = REDACTED;
  }
  for (const [id, call] of Object.entries(state.calls ?? {})) {
    const was = stored.state.calls && Object.hasOwn(stored.state.calls, id) ? stored.state.calls[id] : undefined;
    if (was && changed(was.input, call.input)) call.fingerprint = REDACTED;
  }
  for (const [key, conf] of Object.entries(stored.state.confirmations)) {
    if (Object.hasOwn(state.confirmations, key) && state.confirmations[key]!.digest === REDACTED) digests.add(conf.digest);
  }
  const events = masked.events.map((x) => {
    const ev = x.event;
    return ev.type === "output" && ev.digest !== undefined && digests.has(ev.digest) ? { ...x, event: { ...ev, digest: REDACTED } } : x;
  });
  return { state, events };
}

/**
 * The runs of an export with their secrets masked. Each run is masked by
 * provenance ({@link maskByProvenance}); then, as a backstop, any value equal
 * to a whole value a secret held is masked wherever it appears in any run of
 * the export (a value is the person's secret whichever run held it). A run
 * that cannot be replayed is masked whole. Last, every hash over a value
 * that was masked is masked too ({@link maskHashes}).
 */
export function maskSecrets(runs: readonly ExportedRun[], resolve: FlowResolver): ExportedRun[] {
  const secrets = new Set<string>();
  const found = runs.map((run) => runSecretsOf(resolve, run.events));
  for (const f of found) if (f) for (const v of f.values) secrets.add(v);
  return runs.map((run, i) => {
    const f = found[i];
    const masked = f ? maskByProvenance(run, f, resolve) : maskWhole(run);
    return maskHashes(run, { state: maskValues(masked.state, secrets), events: masked.events.map((stored) => ({ ...stored, event: maskValues(stored.event, secrets) })) });
  });
}
