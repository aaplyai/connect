/**
 * Rebuilding a run's state from its recorded events.
 *
 * A run that never moved replays against its one flow. A run that moved
 * between versions replays through a resolver that returns each version it
 * used, pinned by hash: `run.started` names the first, and each
 * `run.migrated` the next, which `migrateStep` applies with both definitions.
 * Stored events are read as they are, never rewritten.
 */

import type { CompiledFlow } from "./compile.js";
import { step, type StepResult } from "./core.js";
import { migrateStep } from "./migrate.js";
import type { FlowEvent, RunState } from "./state.js";
import { readStoredEvent } from "./stored-versions.js";

/** Returns the compiled definition of one published version, or null when it is not available. */
export type FlowResolver = (flowId: string, version: string, hash: string) => CompiledFlow | null;

/**
 * Rebuilds a run's state from its recorded events. With a compiled flow, a
 * move between versions cannot be replayed that way and throws.
 * With a resolver, the flows are resolved by id, version and hash; a flow
 * that cannot be resolved or whose hash differs throws, as does any event
 * the core rejects. `visit`, when given, sees each event with
 * its result, in order: the effects each one started, for example.
 */
export function replay(source: CompiledFlow | FlowResolver, events: readonly FlowEvent[], visit?: (event: FlowEvent, result: StepResult, index: number) => void): RunState | null {
  let state: RunState | null = null;
  let flow: CompiledFlow | null = typeof source === "function" ? null : source;
  const resolve = (flowId: string, version: string, hash: string): CompiledFlow => {
    if (typeof source !== "function") throw new Error("replaying a move between versions needs a resolver");
    const found = source(flowId, version, hash);
    if (!found) throw new Error(`replay cannot resolve ${flowId}@${version}`);
    if (found.hash !== hash) throw new Error(`replay resolved ${flowId}@${version} with hash ${found.hash}, not the recorded ${hash}`);
    return found;
  };
  for (const [index, stored] of events.entries()) {
    const event = readStoredEvent(stored);
    let result: StepResult;
    if (event.type === "run.started" && typeof source === "function") flow = resolve(event.flowId, event.flowVersion, event.flowHash);
    if (event.type === "run.migrated") {
      if (!state || !flow) throw new Error(`replay rejected event ${event.id} (${event.type}): flow/not-started`);
      const to = resolve(state.flowId, event.to.version, event.to.hash);
      result = migrateStep(flow, to, state, event);
      if (result.accepted) flow = to;
    } else {
      if (!flow) throw new Error(`replay rejected event ${event.id} (${event.type}): flow/not-started`);
      result = step(flow, state, event);
    }
    if (!result.accepted) throw new Error(`replay rejected event ${event.id} (${event.type}): ${result.rejection.code}`);
    visit?.(event, result, index);
    state = result.state;
  }
  return state;
}
