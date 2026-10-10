/**
 * Moves between flow versions: migrating runs one at a time or in a sweep,
 * and what a revoked version's run does before it is heard.
 */

import { type CompiledFlow, FLOW_ID_RE } from "../compile.js";
import type { Rejection } from "../core.js";
import { planMigration, type MigrationPlan, refOf, planHash, isTemporaryBlocker } from "../migrate.js";
import type { TrustedContext } from "../ports.js";
import { sameScope } from "../store.js";
import { type Scope, type RunState, isTerminal, type ActorRef, EVENT_VERSION, CORE_VERSION } from "../state.js";
import { revokedOf, validApproval, type MoveTrigger, type MoveDecision, decideMove } from "../versions.js";
import { renderView } from "../view.js";
import { FlowError } from "../errors.js";
import { RuntimeContext, type MoveRequest, SYSTEM_ACTOR, MAX_SWEEP, NO_INLINE, type Moved, type Chain, type Applied } from "./context.js";
import { type MigrateResponse, type SweepResponse, type RunResponse } from "../runtime.js";
import { checkContext, checkId, actorRef, isNotFound } from "./helpers.js";
import { flowFor, load, flowForCaller, tryLoadFor } from "./views.js";
import { newChain, apply } from "./apply.js";

/** Whether a run's flow version loads as it stands: `unavailable` when the catalog could not be read now. */
export async function versionLoads(rt: RuntimeContext, scope: Scope, state: RunState): Promise<"loads" | "unavailable" | "unloadable"> {
  try {
    const flow = await rt.catalog.get(scope, state.flowId, state.flowVersion);
    return flow && flow.hash === state.flowHash ? "loads" : "unloadable";
  } catch (error) {
    rt.observer.error?.(error, "erase");
    return "unavailable";
  }
}

// --- moving runs between versions -------------------------------------------------

export async function migrate(rt: RuntimeContext, ctx: TrustedContext, runId: string, options: { dryRun?: boolean; override?: boolean } = {}): Promise<MigrateResponse> {
  checkContext(ctx);
  checkId(runId);
  const admin = ctx.appRoles.some((r) => rt.migrationRoles.includes(r));
  const state = await rt.store.loadRun(ctx.scope, runId);
  if (!state) throw new FlowError("not_found", "Not found.");
  let flow: CompiledFlow;
  try {
    flow = await flowFor(rt, ctx.scope, state);
  } catch (error) {
    if (admin) throw error;
    throw new FlowError("not_found", "Not found.");
  }
  if (!admin && !ctx.appRoles.some((r) => flow.staffRoles.includes(r))) throw new FlowError("not_found", "Not found.");
  const override = options.override === true;
  if (override && (!admin || (ctx.actor.kind !== "member" && ctx.actor.kind !== "staff"))) throw new FlowError("forbidden", "Only a person with a migration role can override a pinned version.");
  const view = (s: RunState, f: CompiledFlow) => renderView(f, s, actorRef(ctx));
  const current = await rt.catalog.get(ctx.scope, flow.id);
  if (!current || current.version === flow.version) return { migrated: false, plan: null, view: view(state, flow) };
  const decision = await moveDecision(rt, ctx.scope, state, "staff");
  if (decision.kind === "denied") throw new FlowError("denied", decision.reason);
  if (decision.kind === "end") {
    // A revoked version with nowhere to go: there is no move to plan, only an end.
    if (options.dryRun === true) return { migrated: false, plan: null, view: view(state, flow) };
    const ended = await endRevoked(rt, ctx.scope, runId, decision.message, newChain(rt));
    return { migrated: false, plan: null, view: ended ? view(ended.state, ended.flow) : view(state, flow) };
  }
  let request: MoveRequest;
  if (decision.kind === "stay") {
    const status = rt.catalog.status ? await rt.catalog.status(ctx.scope, current.id, current.version) : null;
    if (revokedOf(status)) throw new FlowError("invalid", "The current version is revoked; runs cannot move to it.");
    if (options.dryRun === true) return { migrated: false, plan: planMigration(flow, current, state, rt.clock.now()), view: view(state, flow) };
    if (!override) throw new FlowError("denied", "Runs of this version stay on it. Override to move this one anyway.");
    // Recorded with the person who overrode the policy.
    request = { cause: "override", to: current };
  } else {
    if (options.dryRun === true) return { migrated: false, plan: planMigration(flow, decision.to, state, rt.clock.now()), view: view(state, flow) };
    request = decision;
  }
  const moved = await executeMove(rt, ctx.scope, runId, request, request.cause === "override" ? actorRef(ctx) : SYSTEM_ACTOR, newChain(rt));
  const latest = moved.applied ?? (await load(rt, ctx.scope, runId));
  return { migrated: moved.outcome === "moved", plan: moved.plan, view: view(latest.state, latest.flow) };
}

export async function migrateAll(rt: RuntimeContext, ctx: TrustedContext, input: { flowId: string; cursor?: string; limit?: number }): Promise<SweepResponse> {
  checkContext(ctx);
  if (!ctx.appRoles.some((r) => rt.migrationRoles.includes(r))) throw new FlowError("forbidden", "You cannot move runs between versions.");
  if (typeof input?.flowId !== "string" || !FLOW_ID_RE.test(input.flowId)) throw new FlowError("invalid", "Bad flow id.");
  if (input.cursor !== undefined) checkId(input.cursor);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SWEEP) throw new FlowError("invalid", `limit is 1 to ${MAX_SWEEP}.`);
  if (!rt.store.listLiveRuns) throw new FlowError("unavailable", "This store cannot list live runs.");
  const out: SweepResponse = { migrated: 0, ended: 0, waiting: [], cursor: null };
  // A forced policy without its two approvals is refused before anything moves.
  const current = await rt.catalog.get(ctx.scope, input.flowId);
  const currentStatus = current && rt.catalog.status ? await rt.catalog.status(ctx.scope, current.id, current.version) : null;
  if (currentStatus?.policy.mode === "forced" && !validApproval(currentStatus.policy.approval)) throw new FlowError("denied", "A forced move needs approval from two different people.");
  const page = await rt.store.listLiveRuns(ctx.scope, { flowId: input.flowId, ...(input.cursor !== undefined ? { after: input.cursor } : {}), limit });
  out.cursor = page.length >= limit ? page[page.length - 1]!.runId : null;
  if (!rt.catalog.status) return out;
  for (const row of page) {
    if (current && row.flowVersion === current.version) continue;
    let state: RunState;
    try {
      state = (await load(rt, ctx.scope, row.runId)).state;
    } catch (error) {
      if (isNotFound(error)) continue;
      rt.observer.error?.(error, "migrate");
      out.waiting.push({ runId: row.runId, code: "flow/unavailable" });
      continue;
    }
    const decision = await moveDecision(rt, ctx.scope, state, "sweep");
    if (decision.kind === "denied") throw new FlowError("denied", decision.reason);
    if (decision.kind === "stay") continue;
    // Effects a move starts go to workers: a sweep never waits on them.
    const moved = decision.kind === "end" ? await endRevoked(rt, ctx.scope, row.runId, decision.message, NO_INLINE).then((a): Moved => ({ outcome: a ? "ended" : "none", plan: null, applied: a })) : await executeMove(rt, ctx.scope, row.runId, decision, SYSTEM_ACTOR, NO_INLINE);
    if (moved.outcome === "moved") out.migrated++;
    else if (moved.outcome === "ended") out.ended++;
    else if (moved.outcome === "blocked") out.waiting.push({ runId: row.runId, code: moved.code ?? "flow/migrate-busy" });
  }
  return out;
}

/** What the catalog says should happen to `state` now (see `versions.ts`). */
export async function moveDecision(rt: RuntimeContext, scope: Scope, state: RunState, trigger: MoveTrigger): Promise<MoveDecision> {
  if (!rt.catalog.status || isTerminal(state.status)) return { kind: "stay" };
  const here = await rt.catalog.status(scope, state.flowId, state.flowVersion);
  const current = await rt.catalog.get(scope, state.flowId);
  const currentStatus = current && current.version !== state.flowVersion ? await rt.catalog.status(scope, current.id, current.version) : null;
  return decideMove(state, here, current, currentStatus, trigger);
}

/**
 * Moves the run as `decision` says, planning against the latest state on
 * each try. A revoked version's run that can never move (a permanent
 * blocker) is ended instead; a temporary blocker leaves it for later.
 */
export async function executeMove(rt: RuntimeContext, scope: Scope, runId: string, decision: MoveRequest, actor: ActorRef, chain: Chain): Promise<Moved> {
  const to = decision.to;
  let plan: MigrationPlan | null = null;
  const applied = await apply(rt, scope, runId, {
    build: (state, flow) => {
      plan = null;
      // Already moved (or ended) by someone else: nothing to do.
      if (isTerminal(state.status) || state.flowVersion === to.version) return null;
      const at = rt.clock.now();
      plan = planMigration(flow, to, state, at);
      if (plan.blockers.length > 0) return null;
      return {
        v: EVENT_VERSION,
        type: "run.migrated",
        id: rt.ids.newId(),
        at,
        actor,
        from: refOf(flow),
        to: refOf(to),
        cause: decision.cause,
        planHash: planHash(plan),
        core: CORE_VERSION,
        ...(decision.approval ? { approval: decision.approval } : {}),
        ...(decision.message !== undefined ? { message: decision.message } : {}),
      };
    },
    to,
    chain,
  });
  const made = plan as MigrationPlan | null;
  if (applied.result?.accepted && applied.result.changed) return { outcome: "moved", plan: made, applied };
  const blocker = made?.blockers[0]?.code ?? (applied.result && !applied.result.accepted ? applied.result.rejection.code : undefined);
  if (blocker === undefined) return { outcome: "none", plan: made, applied: null };
  traceBlocked(rt, applied.state, applied.flow, blocker);
  if (decision.cause === "revoked" && !isTemporaryBlocker(blocker)) {
    const ended = await endRevoked(rt, scope, runId, decision.message ?? "This is no longer available.", chain);
    return { outcome: ended ? "ended" : "none", plan: made, applied: ended };
  }
  return { outcome: "blocked", plan: made, applied: null, code: blocker };
}

/** Ends a revoked version's run (`run.revoked`); null when it had already moved or ended. */
export async function endRevoked(rt: RuntimeContext, scope: Scope, runId: string, message: string, chain: Chain): Promise<Applied | null> {
  const applied = await apply(rt, scope, runId, {
    build: (state) =>
      state.status !== "active" ? null : { v: EVENT_VERSION, type: "run.revoked", id: rt.ids.newId(), at: rt.clock.now(), actor: SYSTEM_ACTOR, version: state.flowVersion, hash: state.flowHash, message },
    chain,
  });
  return applied.result?.accepted && applied.result.changed ? applied : null;
}

/**
 * Before a person's call: a run of a revoked version moves or ends first,
 * so nothing more happens under a version that is no longer trusted. Only
 * someone allowed to act on the run sets that off. A response when the
 * person's call must not go ahead.
 *
 * A move that is blocked for now (a hold only the old version can release,
 * a live child, a write settling) can wait for what the person does next:
 * with `whileBlocked: "proceed"` the call goes ahead (a turn, which may
 * cancel, switch away or answer the live child, but gives the revoked run
 * no facts; see `revokedRefusal`).
 */
export async function beforePerson(rt: RuntimeContext, ctx: TrustedContext, runId: string, options: { whileBlocked?: "refuse" | "proceed" } = {}): Promise<RunResponse | null> {
  if (!rt.catalog.status) return null;
  const state = await rt.store.loadRun(ctx.scope, runId);
  if (!state || isTerminal(state.status) || !sameScope(ctx.scope, state.scope)) return null;
  const revoked = revokedOf(await rt.catalog.status(ctx.scope, state.flowId, state.flowVersion));
  if (!revoked) return null;
  const flow = await flowForCaller(rt, { ctx }, state);
  const decision = await moveDecision(rt, ctx.scope, state, "person");
  let latest: Applied = { state, flow, result: null };
  if (decision.kind === "move") {
    const moved = await executeMove(rt, ctx.scope, runId, decision, SYSTEM_ACTOR, newChain(rt));
    // Moved: the person's call goes ahead on the new version.
    if (moved.outcome === "moved") return null;
    if (moved.outcome === "blocked" && options.whileBlocked === "proceed") return null;
    if (moved.applied) latest = moved.applied;
  } else if (decision.kind === "end") {
    latest = (await endRevoked(rt, ctx.scope, runId, decision.message, newChain(rt))) ?? latest;
  }
  return { runId, view: renderView(latest.flow, latest.state, actorRef(ctx)), accepted: false, rejection: { code: "flow/version-revoked", message: revoked.message }, notices: [] };
}

/**
 * Before a turn reads the active run: the move its version's policy makes
 * on a person's call (onNextTurn, forced) is made first, so the decision
 * request names the version the run will be on and a model's facts are
 * read under that version's rules. Never throws; a blocked move is traced
 * and the turn goes on with the run where it is.
 */
export async function moveBeforeTurn(rt: RuntimeContext, ctx: TrustedContext, runId: string): Promise<void> {
  if (!rt.catalog.status) return;
  const loaded = await tryLoadFor(rt, ctx, runId);
  if (!loaded || isTerminal(loaded.state.status)) return;
  await maybeMigrate(rt, ctx.scope, loaded.state, "person");
}

/** After a person's accepted call: the run moves if its version's policy says so (onNextTurn, forced). */
export async function afterPerson(rt: RuntimeContext, scope: Scope, applied: Applied): Promise<Applied> {
  if (!applied.result?.accepted || isTerminal(applied.state.status)) return applied;
  const moved = await maybeMigrate(rt, scope, applied.state, "person");
  return moved ? { ...moved, result: applied.result } : applied;
}

/** After a system event was recorded: forced and revoked versions' runs move (or end). */
export async function afterSystem(rt: RuntimeContext, scope: Scope, applied: Applied): Promise<void> {
  if (!applied.result?.accepted || !applied.result.changed || isTerminal(applied.state.status)) return;
  await maybeMigrate(rt, scope, applied.state, "system");
}

/**
 * Moves or ends the run if the catalog says so for `trigger`. Never throws:
 * a move that cannot be made now is traced, and the next trigger tries again.
 */
export async function maybeMigrate(rt: RuntimeContext, scope: Scope, state: RunState, trigger: MoveTrigger): Promise<Applied | null> {
  if (!rt.catalog.status) return null;
  try {
    const decision = await moveDecision(rt, scope, state, trigger);
    switch (decision.kind) {
      case "stay":
        return null;
      case "denied":
        rt.observer.error?.(new FlowError("denied", decision.reason), "migrate");
        return null;
      case "end":
        return await endRevoked(rt, scope, state.runId, decision.message, newChain(rt));
      case "move": {
        const moved = await executeMove(rt, scope, state.runId, decision, SYSTEM_ACTOR, newChain(rt));
        return moved.outcome === "moved" || moved.outcome === "ended" ? moved.applied : null;
      }
    }
  } catch (error) {
    if (!isNotFound(error)) rt.observer.error?.(error, "migrate");
    return null;
  }
}

/** Nothing new starts on a revoked version, nor while the current version is revoked; either looks like a missing flow. */
export async function refuseRevoked(rt: RuntimeContext, scope: Scope, flow: CompiledFlow): Promise<void> {
  if (await startRevoked(rt, scope, flow)) throw new FlowError("not_found", "No such flow.");
}

/** Whether nothing may start on `flow`: its version is revoked, or the flow's current version is. */
export async function startRevoked(rt: RuntimeContext, scope: Scope, flow: CompiledFlow): Promise<boolean> {
  if (!rt.catalog.status) return false;
  const here = await rt.catalog.status(scope, flow.id, flow.version);
  if (revokedOf(here)) return true;
  if (here?.current) return false;
  const current = await rt.catalog.get(scope, flow.id);
  return current !== null && current.version !== flow.version && revokedOf(await rt.catalog.status(scope, current.id, current.version)) !== undefined;
}

/** The refusal for a person's input to a run whose version was revoked, or null. */
export async function revokedRefusal(rt: RuntimeContext, scope: Scope, state: RunState): Promise<Rejection | null> {
  if (!rt.catalog.status) return null;
  const revoked = revokedOf(await rt.catalog.status(scope, state.flowId, state.flowVersion));
  return revoked ? { code: "flow/version-revoked", message: revoked.message } : null;
}

/** Whether the run's version was revoked (workers then send nothing new for it). */
export async function isRevoked(rt: RuntimeContext, scope: Scope, state: RunState): Promise<boolean> {
  if (!rt.catalog.status) return false;
  return revokedOf(await rt.catalog.status(scope, state.flowId, state.flowVersion)) !== undefined;
}

/** A move that is blocked is traced by its blocker's code (names only). */
export function traceBlocked(rt: RuntimeContext, state: RunState, flow: CompiledFlow, code: string): void {
  if (!rt.observer.trace) return;
  try {
    rt.observer.trace({
      scope: state.scope,
      runId: state.runId,
      flowId: flow.id,
      flowVersion: flow.version,
      revision: state.revision,
      event: "run.migrated",
      before: state.current,
      after: state.current,
      factsChanged: [],
      factsCleared: [],
      effects: [],
      rejected: code,
      durationMs: 0,
      basis: "system",
    });
  } catch (error) {
    rt.observer.error?.(error, "trace");
  }
}
