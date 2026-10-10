/**
 * Reads: loading runs and their flows for a caller, and the views and
 * responses built from them.
 */

import { MAX_CALL_DEPTH } from "../calls.js";
import type { CompiledFlow } from "../compile.js";
import type { Rejection } from "../core.js";
import type { JsonValue } from "../json.js";
import { offerFacts } from "../routing.js";
import type { TrustedContext } from "../ports.js";
import { type StoredEvent, sameScope, type PendingConsent } from "../store.js";
import { type RunState, type Scope, isTerminal } from "../state.js";
import { type FlowView, renderView } from "../view.js";
import { FlowError } from "../errors.js";
import { type RuntimeHealth, runtimeHealth } from "../health.js";
import { RuntimeContext, type Access, type Applied, type Chain, type Busy } from "./context.js";
import { authorize } from "./admission.js";
import { type RunResponse } from "../runtime.js";
import { checkContext, checkId, isNotFound, isOwner, actorRef, withBusy } from "./helpers.js";

export async function view(rt: RuntimeContext, ctx: TrustedContext, runId: string): Promise<FlowView> {
  checkContext(ctx);
  checkId(runId);
  const { state, flow } = await loadFor(rt, ctx, runId);
  return nestedView(rt, ctx, state, flow, state.parent?.depth ?? 0);
}

export async function inspect(rt: RuntimeContext, ctx: TrustedContext, runId: string): Promise<{ state: RunState; events: StoredEvent[] }> {
  checkContext(ctx);
  checkId(runId);
  const { state } = await loadFor(rt, ctx, runId, true);
  const events = await rt.store.listEvents(ctx.scope, runId);
  return { state, events };
}

export function health(rt: RuntimeContext, options: { cap?: number } = {}): Promise<RuntimeHealth> {
  return runtimeHealth(rt.store, rt.clock, options ?? {});
}

/** Loads a run and its flow for the runtime itself (workers). */
export async function load(rt: RuntimeContext, scope: Scope, runId: string): Promise<{ state: RunState; flow: CompiledFlow }> {
  const state = await rt.store.loadRun(scope, runId);
  if (!state) throw new FlowError("not_found", "Not found.");
  return { state, flow: await flowFor(rt, scope, state) };
}

/** Loads a run for a caller, who must be allowed to see it. */
export async function loadFor(rt: RuntimeContext, ctx: TrustedContext, runId: string, staffOnly = false): Promise<{ state: RunState; flow: CompiledFlow }> {
  const state = await rt.store.loadRun(ctx.scope, runId);
  if (!state) throw new FlowError("not_found", "Not found.");
  return { state, flow: await flowForCaller(rt, { ctx, staffOnly }, state) };
}

export async function tryLoadFor(rt: RuntimeContext, ctx: TrustedContext, runId: string): Promise<{ state: RunState; flow: CompiledFlow } | null> {
  try {
    return await loadFor(rt, ctx, runId);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The run's flow, for a caller, who is then authorized. Only the run's own
 * person hears that its flow cannot be loaded; anyone else gets not_found,
 * so nothing about a run (or its flow) can be probed before authorization.
 */
export async function flowForCaller(rt: RuntimeContext, access: Access, state: RunState): Promise<CompiledFlow> {
  const { ctx, staffOnly = false } = access;
  let flow: CompiledFlow;
  try {
    flow = await flowFor(rt, ctx.scope, state);
  } catch (error) {
    if (!staffOnly && isOwner(ctx, state)) throw error;
    if (!isNotFound(error)) rt.observer.error?.(error, "load");
    throw new FlowError("not_found", "Not found.");
  }
  authorize(ctx, state, flow, staffOnly);
  return flow;
}

export async function flowFor(rt: RuntimeContext, scope: Scope, state: RunState): Promise<CompiledFlow> {
  if (!sameScope(scope, state.scope)) throw new FlowError("not_found", "Not found.");
  const flow = await rt.catalog.get(scope, state.flowId, state.flowVersion);
  if (!flow) throw new FlowError("unavailable", "This flow version is no longer available.");
  if (flow.hash !== state.flowHash) throw new FlowError("unavailable", "This flow version was changed after publishing.");
  return flow;
}

export function respond(ctx: TrustedContext, runId: string, applied: Applied, chain?: Chain): RunResponse {
  const result = applied.result;
  const view = renderView(applied.flow, applied.state, actorRef(ctx), chain ? busyOf(chain) : undefined);
  if (result && !result.accepted) return { runId, view, accepted: false, rejection: result.rejection, notices: [] };
  return { runId, view, accepted: true, notices: result?.notices ?? [] };
}

/**
 * The facts a question may carry to a person: those its flow declares, not
 * derived and not secret (`offerFacts`). A question was filtered when it
 * was asked, and is filtered again before it is shown or acted on, against
 * the flow as it is then.
 */
export async function safeFacts(rt: RuntimeContext, ctx: TrustedContext, flowId: string | undefined, facts: Record<string, JsonValue> | undefined): Promise<Record<string, JsonValue> | undefined> {
  if (flowId === undefined || facts === undefined) return undefined;
  const flow = await rt.catalog.get(ctx.scope, flowId).catch(() => null);
  return offerFacts(flow, facts);
}

/** An open question as a person's view and export show it: its facts filtered (`safeFacts`). */
export async function shownPending(rt: RuntimeContext, ctx: TrustedContext, pending: PendingConsent | null): Promise<PendingConsent | null> {
  if (!pending?.facts) return pending;
  const shown: PendingConsent = { ...pending };
  delete shown.facts;
  const facts = await safeFacts(rt, ctx, pending.flowId, pending.facts);
  return facts ? { ...shown, facts } : shown;
}

/**
 * The response to a run in a tree: the topmost run the caller may see, with
 * the children it waits for nested in it. `runId` stays the one asked for.
 */
export async function respondTree(rt: RuntimeContext, ctx: TrustedContext, runId: string, applied: Applied, refused?: Rejection | null, chain?: Chain): Promise<RunResponse> {
  const base = respond(ctx, runId, applied, chain);
  const response: RunResponse = refused ? { runId, view: base.view, accepted: false, rejection: refused, notices: [] } : base;
  if (!applied.state.parent && !applied.state.calls) return response;
  let top: { state: RunState; flow: CompiledFlow } = { state: applied.state, flow: applied.flow };
  for (let i = 0; i < MAX_CALL_DEPTH && top.state.parent; i++) {
    const up = await tryLoadFor(rt, ctx, top.state.parent.runId).catch(() => null);
    if (!up) break;
    top = up;
  }
  // A busy refusal anywhere in the tree is the response's: it goes on the top view the shell shows.
  return { ...response, view: withBusy(await nestedView(rt, ctx, top.state, top.flow, top.state.parent?.depth ?? 0), chain) };
}

/**
 * A run's view with the child it waits for nested as `call`, down to
 * `maxCallDepth`. A child the viewer may not see shows as waiting.
 */
export async function nestedView(rt: RuntimeContext, ctx: TrustedContext, state: RunState, flow: CompiledFlow, depth: number): Promise<FlowView> {
  const view = renderView(flow, state, actorRef(ctx));
  const childId = view.status === "calling" ? view.step?.call?.runId : undefined;
  if (childId === undefined) return view;
  const child = depth < rt.limits.maxCallDepth ? await tryLoadFor(rt, ctx, childId).catch(() => null) : null;
  if (!child) return { ...view, status: "waiting" };
  return { ...view, call: await nestedView(rt, ctx, child.state, child.flow, depth + 1) };
}

/** The deepest live run under `root` that the caller may see: where what the person says belongs. */
export async function leafOf(rt: RuntimeContext, ctx: TrustedContext, root: { state: RunState; flow: CompiledFlow }): Promise<{ state: RunState; flow: CompiledFlow }> {
  let leaf = root;
  for (let depth = 0; depth < rt.limits.maxCallDepth; depth++) {
    const running = Object.values(leaf.state.calls ?? {}).find((c) => c.status === "running");
    if (!running) break;
    const child = await tryLoadFor(rt, ctx, running.runId).catch(() => null);
    if (!child || isTerminal(child.state.status)) break;
    leaf = child;
  }
  return leaf;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The busy refusal a request met, for its view. */
export function busyOf(chain: Chain): { busy?: Busy } | undefined {
  return chain.busy?.value ? { busy: chain.busy.value } : undefined;
}
