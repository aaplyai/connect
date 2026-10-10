/**
 * The fields of a `TraceRecord` that place it in the run's history: when,
 * which event, where in the log, the run's status and end after it, and for
 * an action's outcome what it was and how long the port took. Names, codes,
 * ids and numbers only, never a value.
 *
 * The observer that receives them is in process and at most once (see
 * `Observer`): these fields let a host match a trace to the event log, which
 * is where an exactly-once ledger is built from.
 *
 * The end's reason is the engine's own code. A person may cancel with words
 * of their own (`submit`'s `reason`), which the run keeps and shows them; a
 * trace names that reason `person`, never the words.
 */

import type { StepResult } from "./core.js";
import type { TraceRecord, TraceSettled } from "./ports.js";
import { own } from "./json.js";
import type { FlowEvent, RunState } from "./state.js";

/** The placing fields of the trace of `event`, applied to `before` with `result`; `state` is the run after it. */
export function traceFields(before: RunState | null, state: RunState, event: FlowEvent, result: StepResult, latencyMs?: number): Pick<TraceRecord, "at" | "eventId" | "seq" | "status" | "end" | "settled"> {
  const committed = result.accepted && result.changed;
  return {
    ...(typeof event.at === "number" ? { at: event.at } : {}),
    ...(typeof event.id === "string" ? { eventId: event.id } : {}),
    // A committed event is the run's latest: its sequence number is the run's new revision.
    ...(committed ? { seq: state.revision } : {}),
    status: state.status,
    ...(state.end ? { end: { kind: state.end.kind, ...(state.end.reason !== undefined ? { reason: traceReason(state.end.reason) } : {}) } } : {}),
    ...(event.type === "action.settled" ? { settled: settledOf(before, event, latencyMs) } : {}),
  };
}

/**
 * The reasons the engine itself ends a run with (`RunState.end.reason`): an
 * end kind standing in for a missing reason, a cancel through a turn
 * (`person`), the engine's own ends, and a child's end for its caller.
 */
const ENGINE_END_REASONS: ReadonlySet<string> = new Set([
  "cancelled",
  "failed",
  "expired",
  "person",
  "event-limit",
  "erasure",
  "revoked",
  "lifetime",
  "idle",
  "wait-timeout",
  "cascade",
  "call-cancelled",
  "caller:parent-ended",
  "caller:superseded",
  "caller:timeout",
]);

/** A rule an outside event set off failed: `rule:` and the refusal's code. */
const RULE_REASON = /^rule:flow\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What a trace says for an end's reason: the engine's own code as it is, anything else (a person's words) as `person`. */
export function traceReason(reason: string): string {
  return ENGINE_END_REASONS.has(reason) || RULE_REASON.test(reason) ? reason : "person";
}

function settledOf(before: RunState | null, event: Extract<FlowEvent, { type: "action.settled" }>, latencyMs: number | undefined): TraceSettled {
  const outcome = event.outcome;
  const inflight = before ? own(before.inflight, event.effectId) : undefined;
  const code = outcome !== null && typeof outcome === "object" && "error" in outcome && typeof outcome.error?.code === "string" ? outcome.error.code : undefined;
  return {
    effectId: event.effectId,
    attempt: event.attempt,
    status: outcome.status,
    ...(code !== undefined ? { code } : {}),
    ...(inflight ? { action: inflight.action, purpose: inflight.purpose } : {}),
    ...(latencyMs !== undefined && Number.isFinite(latencyMs) ? { latencyMs: Math.max(0, latencyMs) } : {}),
  };
}
