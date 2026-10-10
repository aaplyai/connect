/**
 * Pure helpers for routing a person's turn: ids, offers, the policy a
 * decider sees, and the basis recorded on every transition. The runtime
 * (`turn`, `choose`) does the I/O; nothing here reads a store or a clock.
 */

import type { CompiledFlow } from "./compile.js";
import type { DecisionGoal, DecisionProposal, DecisionRequest, DecisionUpdate, RequestPolicy, StageTrace, SuggestOption } from "./decision.js";
import { fingerprint } from "./hash.js";
import { checkJson, own, type JsonValue } from "./json.js";
import type { ResolvedPolicy } from "./policy.js";
import type { TraceBasis } from "./ports.js";
import type { ReplyOption } from "./reply.js";
import type { FlowEvent, RunState, RunUpdate, Scope } from "./state.js";
import { scopeKey, type PendingOffer, type WorkspaceState } from "./store.js";

/** Why the runtime applies an event, when the event alone does not say (a turn's). */
export interface Why {
  /** The producer the transition rests on. */
  basis: TraceBasis;
  /** The turn it rests on, for a turn's transition. */
  turnId?: string;
}

/** Where a person's workspace is stored: derived from its owner and the caller's name for it, so two people never share one. */
export function workspaceKey(owner: string, workspaceId: string): string {
  return `ws-${fingerprint([owner, workspaceId])}`;
}

/** A turn's id: stable for retries of one request, so a retried turn makes the same offer. */
export function turnIdOf(scope: Scope, requestKey: string, workspaceId: string): string {
  return `turn-${fingerprint([scopeKey(scope), requestKey, workspaceId])}`;
}

/** The id of the offer a turn makes: one per turn, so a retried turn makes the same offer. */
export function offerIdOf(turnId: string): string {
  return `offer-${fingerprint([turnId])}`;
}

/** The workspace's offer, unless there is none or it has expired. */
export function liveOffer(ws: WorkspaceState, now: number): PendingOffer | null {
  const offer = ws.offer ?? null;
  return offer && offer.expiresAt > now ? offer : null;
}

/** An offer's options as a person sees them: no facts, no run ids. */
export function offerOptions(offer: PendingOffer): ReplyOption[] {
  return offer.options.map((o) => ({ id: o.id, title: o.title, ...(o.description !== undefined ? { description: o.description } : {}), resumes: o.runId !== undefined }));
}

/**
 * The options of an offer, from what a decider suggested: only goals of this
 * request, each once, in order, without the active flow, at most `max`. A
 * flow with a parked live run becomes an option to resume it (and loses the
 * suggested facts, which a resume does not take).
 */
export function buildOfferOptions(input: {
  options: readonly SuggestOption[];
  goals: readonly DecisionGoal[];
  activeFlowId?: string | undefined;
  parked: ReadonlyArray<{ runId: string; flowId: string }>;
  max: number;
}): PendingOffer["options"] {
  const out: PendingOffer["options"] = [];
  const seen = new Set<string>();
  for (const option of input.options) {
    if (out.length >= input.max) break;
    if (seen.has(option.flowId)) continue;
    seen.add(option.flowId);
    const goal = input.goals.find((g) => g.flowId === option.flowId);
    if (!goal || goal.flowId === input.activeFlowId) continue;
    const parked = input.parked.find((p) => p.flowId === goal.flowId);
    out.push({
      id: String(out.length + 1),
      flowId: goal.flowId,
      title: goal.title,
      ...(goal.description !== undefined ? { description: goal.description } : {}),
      ...(parked ? { runId: parked.runId } : {}),
      ...(option.facts && !parked ? { facts: option.facts } : {}),
    });
  }
  return out;
}

/**
 * The facts of an offer option that may wait in a workspace: declared by the
 * flow, not derived, not secret. A secret value a model extracted is never
 * stored for later.
 */
export function offerFacts(flow: CompiledFlow | null, facts: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined {
  if (!flow || !facts) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(facts)) {
    const fact = flow.facts.get(name);
    if (!fact || fact.derive || fact.sensitivity === "secret" || checkJson(value) !== null) continue;
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A run's version move as a decider sees it: no time, the facts by name only. */
export function decisionUpdateOf(update: RunUpdate): DecisionUpdate {
  return {
    kind: update.kind,
    from: update.from,
    ...(update.to !== undefined ? { to: update.to } : {}),
    facts: [...update.facts],
    ...(update.message !== undefined ? { message: update.message } : {}),
  };
}

/** The part of the policy a decider sees. */
export function requestPolicyOf(policy: ResolvedPolicy): RequestPolicy {
  return {
    mode: policy.mode,
    ...(policy.version !== undefined ? { version: policy.version } : {}),
    ...(policy.stages !== undefined ? { stages: [...policy.stages] } : {}),
    shadow: [...policy.shadow],
    platformFallback: policy.platformFallback,
    thresholds: { ...policy.thresholds },
    maxOptions: policy.maxOptions,
    maxRoutingText: policy.maxRoutingText,
  };
}

/**
 * Why an accepted event was accepted, for its trace. A turn says so itself
 * (`why`); otherwise the event says: a section output is its step's rule, a
 * person's facts and controls are the flow's rules, an outside event is its
 * wait step's rule, and everything else is the engine's own work.
 */
export function basisOf(state: RunState | null, event: FlowEvent, why?: Why): { basis: TraceBasis; rule?: { step: string; output: string }; turnId?: string } {
  const turn = why?.turnId !== undefined ? { turnId: why.turnId } : {};
  switch (event.type) {
    case "output":
      return { basis: why?.basis ?? "rule", rule: { step: event.stepId, output: event.name }, ...turn };
    case "facts.input":
      return { basis: why?.basis ?? (event.source === "model" ? "model" : "rule"), ...turn };
    case "run.started":
      // A child run is started by the engine, performing its caller's call step.
      return { basis: why?.basis ?? (event.source === "model" ? "model" : event.source === "call" ? "system" : "rule"), ...turn };
    case "external": {
      const step = state ? Object.entries(state.waits).find(([, w]) => w.event === event.event)?.[0] : undefined;
      return { basis: why?.basis ?? "rule", ...(step !== undefined ? { rule: { step, output: event.event } } : {}), ...turn };
    }
    case "run.cancelled":
      return { basis: why?.basis ?? (event.actor.kind === "system" ? "system" : "rule"), ...turn };
    case "run.resumed":
      return { basis: why?.basis ?? "rule", ...turn };
    case "action.settled":
    case "timer.fired":
    case "effect.resolved":
    // A move or a revocation follows the catalog's policy for the version, never a person's text.
    case "run.migrated":
    case "run.revoked":
    // A call's start, end and cancellation are the engine carrying a call step out.
    case "call.started":
    case "call.settled":
    case "call.cancelled":
      return { basis: why?.basis ?? "system", ...turn };
  }
}

/** Facts a proposal writes that changed after `revision`, or every one when the run's flow moved. */
export function staleFacts(state: RunState, names: readonly string[], seen: { revision: number; flowHash: string }): string[] {
  if (state.flowHash !== seen.flowHash) return [...names];
  return names.filter((name) => (own(state.facts, name)?.rev ?? 0) > seen.revision);
}

/**
 * What a proposal would write, each part counted as one input of a person's:
 * a `continue`'s or `switch`'s facts and its item changes, and each
 * option's facts. The runtime holds every part to the checks a person's
 * input gets (`maxInputBytes`), and treats a proposal over them as
 * malformed.
 */
export function proposalInputs(proposal: DecisionProposal): JsonValue[] {
  const parts: Array<JsonValue | undefined> = [];
  switch (proposal.kind) {
    case "continue":
    case "switch":
      parts.push(proposal.facts, proposal.items as JsonValue | undefined);
      break;
    case "suggest":
      for (const o of proposal.options) parts.push(o.facts);
      break;
    default:
      break;
  }
  return parts.filter((p): p is JsonValue => p !== undefined);
}

/**
 * Stage traces with every id a stage proposed kept only when the request
 * offered it (a goal's flow id, a parked run's id): an id a model made up,
 * which may carry what the person typed, is never recorded.
 */
export function scrubTraces(stages: readonly StageTrace[], request: Pick<DecisionRequest, "goals" | "parked">): StageTrace[] {
  return stages.map((stage) => {
    const p = stage.proposed;
    if (!p || (p.flowId === undefined && p.runId === undefined)) return stage;
    const flowOk = p.flowId !== undefined && request.goals.some((g) => g.flowId === p.flowId);
    const runOk = p.runId !== undefined && request.parked.some((r) => r.runId === p.runId);
    return { ...stage, proposed: { kind: p.kind, ...(flowOk ? { flowId: p.flowId } : {}), ...(runOk ? { runId: p.runId } : {}) } };
  });
}
