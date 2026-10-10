/**
 * Replay corpora: recorded runs the engine must replay exactly.
 *
 * A corpus case holds the definitions a run used, its stored events (the
 * bytes a store kept) and what replaying
 * them produced when they were recorded: per event the fingerprint of the
 * state and of the effects, and the final state and views. A later engine
 * that changes any of these for an old run has changed what old runs mean,
 * which only a breaking release may do.
 *
 * Everything here is pure: it takes parsed JSON and reports divergences, so
 * a host can keep a private corpus of its own real runs (`exportCorpusCase`)
 * and replay it in its CI.
 */

import { compileFlow, type CompiledFlow } from "../compile.js";
import { step, type StepResult } from "../core.js";
import { fingerprint } from "../hash.js";
import { canonicalJson, isJsonObject, type JsonValue } from "../json.js";
import { type ActorRef, type FlowEvent, type FlowEventType, type RunState } from "../state.js";
import { migrateStep } from "../migrate.js";
import { readStoredEvent } from "../stored-versions.js";
import { renderView, type FlowView } from "../view.js";

/** What one event produced when the case was recorded. */
export interface CorpusStep {
  event: FlowEventType;
  /** Fingerprint of the state after the event. */
  stateHash: string;
  /** Fingerprint of the effects the event asked for. */
  effectsHash: string;
  /** Effect kinds, for people reading a diff; not compared. */
  effects?: string[];
}

/** The views a case checks: for the run's own person, and for staff when the flow has staff roles. */
export interface CorpusViews {
  subject: FlowView;
  staff?: FlowView;
}

/** What a case's recording produced: each event's step, the final state and the views. */
export interface CorpusExpected {
  steps: CorpusStep[];
  state: RunState;
  views: CorpusViews;
}

/** One recorded run of the replay corpus: the definitions it used, its stored events and what they produced. */
export interface CorpusCase {
  id: string;
  /** Every definition the run used, as published (normalised) JSON. */
  flows: unknown[];
  /** The stored events, oldest first, as JSON. */
  events: unknown[];
  expected: CorpusExpected;
}

/** Which part of a replay differs from its recording. */
export type CorpusDivergenceKind = "definition" | "event" | "rejected" | "state" | "effects" | "final-state" | "view";

/** One way a replay differs from its recording. */
export interface CorpusDivergence {
  caseId: string;
  kind: CorpusDivergenceKind;
  /** Index of the event concerned, when there is one. */
  index?: number;
  /** RFC 6901 pointer to the first difference, for final states and views. */
  pointer?: string;
  message: string;
}

/** The staff viewer a corpus renders staff views for: the flow's staff roles, nothing else. */
export function corpusStaffViewer(flow: CompiledFlow): ActorRef {
  return { kind: "staff", id: "staff:corpus", roles: [...flow.staffRoles] };
}

/** The views a corpus records for a run's final state. */
export function corpusViews(flow: CompiledFlow, state: RunState): CorpusViews {
  const subject = renderView(flow, state);
  return flow.staffRoles.length > 0 ? { subject, staff: renderView(flow, state, corpusStaffViewer(flow)) } : { subject };
}

/** Advances a run by one stored event, switching flows when it moves to another version. */
function stepStored(byHash: Map<string, CompiledFlow>, flow: CompiledFlow | null, state: RunState | null, event: FlowEvent): { result: StepResult; flow: CompiledFlow | null } {
  if (event.type === "run.started") {
    const start = byHash.get(event.flowHash) ?? null;
    if (!start) throw new Error(`no definition with hash ${event.flowHash}`);
    return { result: step(start, state, event), flow: start };
  }
  if (!flow) throw new Error("the run has not started");
  if (event.type === "run.migrated") {
    const to = byHash.get(event.to.hash) ?? null;
    if (!to) throw new Error(`no definition with hash ${event.to.hash}`);
    const result = migrateStep(flow, to, state, event);
    return { result, flow: result.accepted ? to : flow };
  }
  return { result: step(flow, state, event), flow };
}

function compileAll(caseId: string, flows: unknown[], out: CorpusDivergence[]): Map<string, CompiledFlow> {
  const byHash = new Map<string, CompiledFlow>();
  flows.forEach((definition, i) => {
    const { flow, diagnostics } = compileFlow(definition);
    if (!flow) {
      const first = diagnostics.find((d) => d.severity === "error");
      out.push({ caseId, kind: "definition", index: i, message: `definition ${i} no longer compiles: ${first?.code ?? "?"} ${first?.message ?? ""}` });
      return;
    }
    byHash.set(flow.hash, flow);
  });
  return byHash;
}

/**
 * Replays a case and lists every way it differs from its recording; an empty
 * list means the engine still gives the run exactly the meaning it had.
 * Definitions must recompile to the hash the run recorded, so a change to
 * how definitions are compiled or hashed shows up here too.
 */
export function replayCorpusCase(c: CorpusCase): CorpusDivergence[] {
  const out: CorpusDivergence[] = [];
  const byHash = compileAll(c.id, c.flows, out);
  let flow: CompiledFlow | null = null;
  let state: RunState | null = null;
  for (let index = 0; index < c.events.length; index++) {
    let event: FlowEvent;
    try {
      event = readStoredEvent(c.events[index]);
    } catch (error) {
      out.push({ caseId: c.id, kind: "event", index, message: `event cannot be read: ${(error as Error).message}` });
      return out;
    }
    let stepped: { result: StepResult; flow: CompiledFlow | null };
    try {
      stepped = stepStored(byHash, flow, state, event);
    } catch (error) {
      out.push({ caseId: c.id, kind: "rejected", index, message: (error as Error).message });
      return out;
    }
    const { result } = stepped;
    if (!result.accepted || !result.changed) {
      out.push({ caseId: c.id, kind: "rejected", index, message: result.accepted ? `${event.type} changed nothing` : `${event.type} rejected: ${result.rejection.code}` });
      return out;
    }
    flow = stepped.flow;
    state = result.state;
    const expected = c.expected.steps[index];
    if (!expected) {
      out.push({ caseId: c.id, kind: "state", index, message: "more events than recorded steps" });
      return out;
    }
    const stateHash = fingerprint(state as unknown as JsonValue);
    if (stateHash !== expected.stateHash) out.push({ caseId: c.id, kind: "state", index, message: `state after ${event.type} differs` });
    if (fingerprint(result.effects as unknown as JsonValue) !== expected.effectsHash) out.push({ caseId: c.id, kind: "effects", index, message: `effects of ${event.type} differ` });
  }
  if (c.expected.steps.length !== c.events.length) out.push({ caseId: c.id, kind: "state", message: `${c.expected.steps.length} recorded steps for ${c.events.length} events` });
  if (!state || !flow) {
    out.push({ caseId: c.id, kind: "rejected", message: "no events" });
    return out;
  }
  const pointer = firstDifference(c.expected.state as unknown as JsonValue, state as unknown as JsonValue);
  if (pointer !== null) out.push({ caseId: c.id, kind: "final-state", index: c.events.length - 1, pointer, message: `final state differs at ${pointer || "/"}` });
  const views = corpusViews(flow, state);
  for (const who of ["subject", "staff"] as const) {
    const want = c.expected.views[who] as unknown as JsonValue | undefined;
    const got = views[who] as unknown as JsonValue | undefined;
    if (want === undefined && got === undefined) continue;
    const at = want === undefined || got === undefined ? "" : firstDifference(want, got);
    if (at !== null) out.push({ caseId: c.id, kind: "view", pointer: at, message: `${who} view differs at ${at || "/"}` });
  }
  return out;
}

/**
 * Builds a corpus case from a run's definitions and stored events with the
 * running engine, for a host's own corpus of real runs. Refuses a run this
 * engine cannot replay.
 */
export function exportCorpusCase(input: { id: string; flows: CompiledFlow[]; events: readonly unknown[] }): CorpusCase {
  const byHash = new Map(input.flows.map((f) => [f.hash, f]));
  const steps: CorpusStep[] = [];
  let flow: CompiledFlow | null = null;
  let state: RunState | null = null;
  input.events.forEach((raw, index) => {
    const event = readStoredEvent(raw);
    const stepped = stepStored(byHash, flow, state, event);
    if (!stepped.result.accepted || !stepped.result.changed) throw new Error(`event ${index} (${event.type}) does not replay`);
    flow = stepped.flow;
    state = stepped.result.state;
    steps.push({
      event: event.type,
      stateHash: fingerprint(state as unknown as JsonValue),
      effectsHash: fingerprint(stepped.result.effects as unknown as JsonValue),
      effects: stepped.result.effects.map((e) => (e.kind === "action" ? `action:${e.purpose}:${e.effect}` : e.kind)),
    });
  });
  if (!state || !flow) throw new Error("a corpus case needs at least the run.started event");
  return {
    id: input.id,
    flows: input.flows.map((f) => JSON.parse(JSON.stringify(f.definition)) as unknown),
    events: input.events.map((e) => JSON.parse(JSON.stringify(e)) as unknown),
    expected: { steps, state, views: corpusViews(flow, state) },
  };
}

const escapePointer = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * The RFC 6901 pointer to the first place two JSON values differ ("" for the
 * whole value), or null when they are equal. Object keys are compared in
 * sorted order, so the answer does not depend on key order.
 */
export function firstDifference(a: JsonValue, b: JsonValue, at = ""): string | null {
  if (canonicalJson(a) === canonicalJson(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const found = firstDifference(a[i]!, b[i]!, `${at}/${i}`);
      if (found !== null) return found;
    }
    return `${at}/${Math.min(a.length, b.length)}`;
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const x = a[key];
      const y = b[key];
      if (x === undefined && y === undefined) continue;
      if (x === undefined || y === undefined) return `${at}/${escapePointer(key)}`;
      const found = firstDifference(x, y, `${at}/${escapePointer(key)}`);
      if (found !== null) return found;
    }
  }
  return at;
}
