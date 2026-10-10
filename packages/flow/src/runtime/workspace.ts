/**
 * Workspaces: loading, saving and updating one, parking its active run, and
 * the view a caller gets of it.
 */

import type { CompiledFlow } from "../compile.js";
import { workspaceKey, liveOffer, offerOptions } from "../routing.js";
import type { TrustedContext } from "../ports.js";
import type { WorkspaceState } from "../store.js";
import { type Scope, isTerminal, type RunState } from "../state.js";
import { WORKSPACE_VERSION } from "../stored-versions.js";
import type { FlowView } from "../view.js";
import { FlowError } from "../errors.js";
import { RuntimeContext, type Busy } from "./context.js";
import { type WorkspaceView } from "../runtime.js";
import { checkContext, checkId, subjectOf, pause } from "./helpers.js";
import { tryLoadFor, nestedView, shownPending } from "./views.js";

// --- workspace -----------------------------------------------------------------

export async function workspace(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string): Promise<WorkspaceView> {
  checkContext(ctx);
  return workspaceView(rt, ctx, await loadWorkspace(rt, ctx, workspaceId), workspaceId);
}

/** The workspace after a call that met a busy refusal on `busy.runId`. */
export async function workspaceAfter(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, busy: { runId: string; busy: Busy } | undefined): Promise<WorkspaceView> {
  return workspaceView(rt, ctx, await loadWorkspace(rt, ctx, workspaceId), workspaceId, busy);
}

/**
 * A person's workspace. Stored under an id derived from its owner and the
 * caller's name for it, so two people never share (or block) one by
 * choosing the same name.
 */
export async function loadWorkspace(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string): Promise<WorkspaceState> {
  checkId(workspaceId);
  const owner = subjectOf(ctx);
  if (owner === null) throw new FlowError("forbidden", "A workspace belongs to a person.");
  const id = workspaceKey(owner, workspaceId);
  const ws = await rt.store.loadWorkspace(ctx.scope, id);
  if (ws) {
    if (ws.owner !== owner) throw new FlowError("not_found", "Not found.");
    return ws;
  }
  const now = rt.clock.now();
  return { v: WORKSPACE_VERSION, id, scope: { ...ctx.scope }, owner, revision: 0, active: null, parked: [], pending: null, offer: null, createdAt: now, updatedAt: now };
}

/** Saves a change to the workspace as loaded; a concurrent change makes it fail with `conflict`. */
export async function saveWorkspace(rt: RuntimeContext, scope: Scope, ws: WorkspaceState, change: (ws: WorkspaceState) => void | Promise<void>): Promise<void> {
  const expectedRevision = ws.revision;
  await change(ws);
  ws.revision += 1;
  ws.updatedAt = rt.clock.now();
  const committed = await rt.store.commit({ scope, runs: [], workspace: { state: ws, expectedRevision } });
  if (!committed.ok) throw new FlowError("conflict", "Please try again.");
}

/**
 * Changes the latest workspace, retrying on conflicts against fresh state.
 * `change` decides on what it sees each time; false leaves the workspace as
 * it is and returns null.
 */
export async function updateWorkspace(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, change: (ws: WorkspaceState) => boolean | Promise<boolean>): Promise<WorkspaceState | null> {
  for (let attempt = 0; ; attempt++) {
    const ws = await loadWorkspace(rt, ctx, workspaceId);
    const expectedRevision = ws.revision;
    if (!(await change(ws))) return null;
    ws.revision += 1;
    ws.updatedAt = rt.clock.now();
    const committed = await rt.store.commit({ scope: ctx.scope, runs: [], workspace: { state: ws, expectedRevision } });
    if (committed.ok) return ws;
    if (attempt >= rt.limits.conflictRetries) throw new FlowError("conflict", "Please try again.");
    await pause(attempt);
  }
}

/**
 * Sets the active run aside. A run that has ended is dropped, never parked.
 * At the limit, ended runs make room first; a live run is never dropped to
 * make room: the switch is refused instead, and the person can finish or
 * cancel something first.
 */
export async function parkActive(rt: RuntimeContext, scope: Scope, ws: WorkspaceState): Promise<void> {
  const active = ws.active;
  ws.active = null;
  if (!active || ws.parked.includes(active) || !(await isLive(rt, scope, active))) return;
  let parked = [active, ...ws.parked];
  if (parked.length > rt.limits.maxParked) {
    const live: string[] = [];
    for (const runId of ws.parked) if (await isLive(rt, scope, runId)) live.push(runId);
    parked = [active, ...live];
    if (parked.length > rt.limits.maxParked) {
      throw new FlowError("denied", `Only ${rt.limits.maxParked} things can be set aside at once. Please finish or cancel one first.`);
    }
  }
  ws.parked = parked;
}

export async function isLive(rt: RuntimeContext, scope: Scope, runId: string): Promise<boolean> {
  const state = await rt.store.loadRun(scope, runId);
  return state !== null && !isTerminal(state.status);
}

export async function activeRun(rt: RuntimeContext, ctx: TrustedContext, ws: WorkspaceState): Promise<{ state: RunState; flow: CompiledFlow } | null> {
  if (!ws.active) return null;
  const loaded = await tryLoadFor(rt, ctx, ws.active);
  if (!loaded || isTerminal(loaded.state.status)) return null;
  return loaded;
}

export async function workspaceView(rt: RuntimeContext, ctx: TrustedContext, ws: WorkspaceState, workspaceId: string, busy?: { runId: string; busy: Busy }): Promise<WorkspaceView> {
  let active: FlowView | null = null;
  if (ws.active) {
    const loaded = await tryLoadFor(rt, ctx, ws.active);
    // A run waiting for a child shows it nested, so the person sees where they are.
    if (loaded) {
      const view = await nestedView(rt, ctx, loaded.state, loaded.flow, loaded.state.parent?.depth ?? 0);
      active = busy?.runId === ws.active ? { ...view, busy: busy.busy } : view;
    }
  }
  const parked: WorkspaceView["parked"] = [];
  for (const runId of ws.parked) {
    const loaded = await tryLoadFor(rt, ctx, runId);
    if (loaded && !isTerminal(loaded.state.status)) parked.push({ runId, flowId: loaded.flow.id, title: loaded.flow.definition.title, status: loaded.state.status });
  }
  const offer = liveOffer(ws, rt.clock.now());
  const pending = await shownPending(rt, ctx, ws.pending);
  return { id: workspaceId, active, parked, pending, ...(offer ? { offer: { id: offer.id, expiresAt: offer.expiresAt, options: offerOptions(offer) } } : {}) };
}
