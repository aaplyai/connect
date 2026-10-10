/**
 * Usage from the event log: what a ledger records for each committed event
 * of a run, exactly once.
 *
 * The observer's traces are in process and at most once; the event log is
 * durable, append-only and numbered per run. A ledger keyed by
 * (scope, runId, seq) and filled from `usageEntries` over a run's log is
 * therefore exact however often it is filled again. The log does not say
 * which action an outcome belongs to, so the log is stepped through the core,
 * as `replay` does, and each event's dispatched actions are read from its
 * result: an `action.settled` names the `effectId` and `attempt` one of them
 * dispatched.
 */

import type { CompiledFlow } from "./compile.js";
import { replay, type FlowResolver } from "./replay.js";
import type { StoredEvent } from "./store.js";
import type { ActionOutcome, EffectPurpose, FlowEventType, RunStatus } from "./state.js";

/** An action attempt an event dispatched. */
export interface UsageDispatch {
  effectId: string;
  attempt: number;
  /** The connector action id, such as `calendar.findSlots`. */
  action: string;
  /** The flow's name for the action. */
  name: string;
  purpose: EffectPurpose;
  effect: "read" | "write";
  connection?: string;
}

/** One committed event, as a ledger records it: ids, names, codes and numbers, never a value. */
export interface UsageEntry {
  seq: number;
  eventId: string;
  at: number;
  type: FlowEventType;
  /** The run's status after the event. */
  status: RunStatus;
  /** Action attempts the event dispatched. */
  dispatched: UsageDispatch[];
  /**
   * For `action.settled`: the attempt it settles, the outcome's status and
   * error code. An outcome the engine recorded without calling the port (an
   * admission refusal, an interrupted or expired attempt) carries the
   * admission's code or a `flow/...` code.
   */
  settled?: { effectId: string; attempt: number; status: ActionOutcome["status"]; code?: string };
}

/**
 * The usage entries of one run's whole log, in order (`events` as
 * `RunStore.listEvents` returns them, from seq 1). The source is the run's
 * compiled flow, or a resolver for a run that moved between versions, as for
 * `replay`; a log that does not replay throws. Record each entry under
 * (scope, runId, seq): a repeat then changes nothing.
 */
export function usageEntries(source: CompiledFlow | FlowResolver, events: readonly StoredEvent[]): UsageEntry[] {
  const out: UsageEntry[] = [];
  replay(
    source,
    events.map((e) => e.event),
    (event, result, index) => {
      // Replay throws on a refused event, so every event here was accepted.
      if (!result.accepted) return;
      const dispatched: UsageDispatch[] = [];
      for (const effect of result.effects) {
        if (effect.kind !== "action") continue;
        dispatched.push({
          effectId: effect.effectId,
          attempt: effect.attempt,
          action: effect.action,
          name: effect.name,
          purpose: effect.purpose,
          effect: effect.effect,
          ...(effect.connection !== undefined ? { connection: effect.connection } : {}),
        });
      }
      const outcome = event.type === "action.settled" ? event.outcome : undefined;
      const code = outcome && "error" in outcome && typeof outcome.error?.code === "string" ? outcome.error.code : undefined;
      out.push({
        seq: events[index]!.seq,
        eventId: event.id,
        at: event.at,
        type: event.type,
        status: result.state.status,
        dispatched,
        ...(event.type === "action.settled" ? { settled: { effectId: event.effectId, attempt: event.attempt, status: event.outcome.status, ...(code !== undefined ? { code } : {}) } } : {}),
      });
    },
  );
  return out;
}
