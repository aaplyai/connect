/**
 * Outcomes from outside: deliveries of correlated events, completions of
 * deferred actions, and effects resolved by staff.
 */

import { type DeliverRequest, type DeliverResult, isDeliverConnection, type CompletionResult, isActionOutcome, normalizeOutcome } from "@aaply/action-contract";
import { completionToken, completesLate } from "../approved.js";
import { EVENT_RE } from "../compile.js";
import { safeEqual } from "../hash.js";
import { canonicalJson, type JsonValue } from "../json.js";
import type { TrustedContext } from "../ports.js";
import { type Scope, EVENT_VERSION, type ActionOutcome } from "../state.js";
import { guardBlobOutcome } from "../blob-guard.js";
import { FlowError } from "../errors.js";
import { RuntimeContext } from "./context.js";
import { admit, checkInput } from "./admission.js";
import { afterSystem } from "./migrate.js";
import { type RunResponse } from "../runtime.js";
import { checkContext, checkId, subjectOf, actorRef, requestKey } from "./helpers.js";
import { loadFor, respond } from "./views.js";
import { apply, newChain } from "./apply.js";

// --- workloads and staff -----------------------------------------------------------

/** The runs among `runIds` that belong to `subjectId`. */
export async function runsOf(rt: RuntimeContext, scope: Scope, runIds: string[], subjectId: string): Promise<string[]> {
  const owned: string[] = [];
  for (const runId of runIds) {
    const state = await rt.store.loadRun(scope, runId);
    if (state?.subject?.id === subjectId) owned.push(runId);
  }
  return owned;
}

export async function deliver(rt: RuntimeContext, ctx: TrustedContext, input: DeliverRequest): Promise<DeliverResult> {
  checkContext(ctx);
  if (ctx.actor.kind !== "workload") throw new FlowError("forbidden", "Only services can deliver events.");
  await admit(rt, ctx, "deliver");
  if (typeof input?.event !== "string" || !EVENT_RE.test(input.event)) throw new FlowError("invalid", "Bad event name.");
  if (input.dedupeKey !== undefined) checkId(input.dedupeKey);
  const connection = input.connection;
  if (connection !== undefined) {
    if (!isDeliverConnection(connection)) throw new FlowError("invalid", "Bad connection.");
    // The owner is the context's subject; the event's connection must say the same.
    if (connection.subjectId !== subjectOf(ctx)) throw new FlowError("invalid", "The event's connection does not belong to the context's subject.");
  }
  checkInput(rt, input.payload);
  checkInput(rt, input.correlation);
  const key = canonicalJson(input.correlation);
  const targets = await rt.store.findWaiting(ctx.scope, input.event, key);
  let runIds = [...new Set(targets.map((t) => t.runId))];
  // A person's own account names things uniquely only within itself (a Gmail thread id), so
  // its event wakes only that person's run. The business's own connection's references are
  // the tenant's, and wake a run of anyone.
  const owner = connection !== undefined ? subjectOf(ctx) : null;
  if (owner !== null) runIds = await runsOf(rt, ctx.scope, runIds, owner);
  if (runIds.length === 0) return { delivered: 0 };
  // A correlation names one run. Several matches are a clash (or someone reusing another's
  // reference), so the event goes to none of them.
  if (runIds.length > 1) throw new FlowError("conflict", "More than one run is waiting for this event; it was not delivered.");
  await rt.vouch(ctx, input, { via: "deliver", runId: runIds[0]! });
  let applied: Awaited<ReturnType<typeof apply>>;
  try {
    applied = await apply(rt, ctx.scope, runIds[0]!, {
      build: () => ({
        v: EVENT_VERSION,
        type: "external",
        id: rt.ids.newId(),
        at: rt.clock.now(),
        actor: actorRef(ctx),
        // A sender's key is unique only among its own events of one name (and, with a connection, of that connection).
        ...(input.dedupeKey !== undefined
          ? { requestId: JSON.stringify(["deliver", ctx.actor.domain, ctx.actor.id, input.event, input.dedupeKey, ...(connection !== undefined ? [connection.id] : [])]) }
          : {}),
        event: input.event,
        key,
        payload: input.payload,
      }),
      chain: newChain(rt),
      traceCtx: ctx,
    });
  } catch (error) {
    // A run erased since the lookup no longer wants the event.
    if (error instanceof FlowError && error.code === "not_found") return { delivered: 0 };
    // Anything else must not look like "nobody was waiting", or the sender would drop the event.
    rt.observer.error?.(error, "deliver");
    throw new FlowError("unavailable", "The event could not be recorded. Please deliver it again.");
  }
  // A refused event (a payload the flow cannot use) is the sender's to fix; the run keeps waiting.
  if (applied.result && !applied.result.accepted) throw new FlowError("invalid", `The event was refused (${applied.result.rejection.code}): ${applied.result.rejection.message}`);
  await afterSystem(rt, ctx.scope, applied);
  return { delivered: applied.result?.accepted && applied.result.changed ? 1 : 0 };
}

export async function completeAction(rt: RuntimeContext, ctx: TrustedContext, input: { runId: string; effectId: string; attempt: number; outcome: ActionOutcome; token: string }): Promise<CompletionResult> {
  checkContext(ctx);
  checkId(input?.runId);
  checkId(input.effectId);
  if (ctx.actor.kind !== "workload") throw new FlowError("forbidden", "Only services can complete actions.");
  if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 1000) throw new FlowError("invalid", "Bad attempt.");
  // The token binds the completion to this scope, run, effect and attempt; nothing else can settle it.
  const expected = completionToken(rt.keys, { scope: ctx.scope, runId: input.runId, effectId: input.effectId, attempt: input.attempt });
  if (typeof input.token !== "string" || !safeEqual(input.token, expected)) throw new FlowError("forbidden", "That completion is not valid.");
  // Recording a malformed one as "unknown" would put a write in doubt for a caller's mistake: refuse it.
  if (!isActionOutcome(input.outcome)) throw new FlowError("invalid", "That is not an action outcome.");
  const outcome = guardBlobOutcome(normalizeOutcome(input.outcome, "write"), "write", ctx.scope);
  // A completion for an effect already put in doubt is recorded as late, for the core to settle or keep for staff.
  let late = false;
  const applied = await apply(rt, ctx.scope, input.runId, {
    build: (state) => {
      late = completesLate(state, input.effectId, input.attempt);
      return { v: EVENT_VERSION, type: "action.settled", id: rt.ids.newId(), at: rt.clock.now(), actor: actorRef(ctx), effectId: input.effectId, attempt: input.attempt, outcome, ...(late ? { late: true as const } : {}) };
    },
    chain: newChain(rt),
    traceCtx: ctx,
  });
  // For example an attempt that answered "retryable" and waits to be sent again.
  if (applied.result && !applied.result.accepted) throw new FlowError("conflict", applied.result.rejection.message);
  if (applied.result?.changed) {
    await afterSystem(rt, ctx.scope, applied);
    return { settled: late ? "late" : "now" };
  }
  // Nothing changed: an identical earlier completion is acknowledged again, a different one is a conflict.
  const earlier = await earlierCompletion(rt, ctx.scope, input.runId, input.effectId, input.attempt);
  if (earlier === null) return { settled: "stale" };
  if (canonicalJson(earlier as unknown as JsonValue) !== canonicalJson(outcome as unknown as JsonValue)) throw new FlowError("conflict", "This action was already completed with another result.");
  return { settled: "already" };
}

/** The outcome an outside caller last completed an attempt with, if one was recorded (a late report may be followed by one that settles it). */
export async function earlierCompletion(rt: RuntimeContext, scope: Scope, runId: string, effectId: string, attempt: number): Promise<ActionOutcome | null> {
  let afterSeq = 0;
  let last: ActionOutcome | null = null;
  for (;;) {
    const page = await rt.store.listEvents(scope, runId, { afterSeq, limit: 500 });
    for (const { event } of page) {
      if (event.type === "action.settled" && event.actor.kind !== "system" && event.effectId === effectId && event.attempt === attempt) last = event.outcome;
    }
    if (page.length < 500) return last;
    afterSeq = page[page.length - 1]!.seq;
  }
}

export async function resolveEffect(rt: RuntimeContext, ctx: TrustedContext, runId: string, input: { effectId: string; applied: boolean; output?: JsonValue }): Promise<RunResponse> {
  checkContext(ctx);
  checkId(runId);
  checkId(input?.effectId);
  if (input.output !== undefined) checkInput(rt, input.output);
  await rt.vouch(ctx, input, { via: "resolve", runId }, () => loadFor(rt, ctx, runId, true));
  const chain = newChain(rt);
  const applied = await apply(rt, ctx.scope, runId, {
    build: () => ({
      v: EVENT_VERSION,
      type: "effect.resolved",
      id: rt.ids.newId(),
      at: rt.clock.now(),
      actor: actorRef(ctx),
      requestId: requestKey(ctx),
      effectId: input.effectId,
      applied: input.applied === true,
      ...(input.output !== undefined ? { output: input.output } : {}),
    }),
    access: { ctx, staffOnly: true },
    chain,
  });
  return respond(ctx, runId, applied, chain);
}
