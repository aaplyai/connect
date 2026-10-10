/**
 * Privacy: exporting and erasing a subject's data, and legal holds.
 */

import type { BlobRef } from "@aaply/action-contract";
import type { CompiledFlow } from "../compile.js";
import type { TrustedContext } from "../ports.js";
import type { WorkspaceState } from "../store.js";
import { type Scope, type RunState, isTerminal, EVENT_VERSION } from "../state.js";
import { maskSecrets, type ExportedRun, versionsOf } from "../export-mask.js";
import type { FlowResolver } from "../replay.js";
import { FlowError } from "../errors.js";
import type { LegalHold, PrivacyRecord } from "../privacy.js";
import * as privacy from "../privacy-runtime.js";
import { RuntimeContext, type Applied, SYSTEM_ACTOR } from "./context.js";
import { authorizePrivacy, authorizeHolds } from "./admission.js";
import { type SubjectExportOptions, type SubjectExport, type EraseResult, type ErasureRun } from "../runtime.js";
import { checkContext, actorRef, isNotFound } from "./helpers.js";
import { shownPending } from "./views.js";
import { isLive } from "./workspace.js";
import { apply, newChain } from "./apply.js";
import { versionLoads } from "./migrate.js";

export async function exportSubject(rt: RuntimeContext, ctx: TrustedContext, subjectId: string, options: SubjectExportOptions = {}): Promise<SubjectExport> {
  checkContext(ctx);
  const secrets = options?.secrets ?? "mask";
  if (secrets !== "mask" && secrets !== "include") throw new FlowError("invalid", "secrets is mask or include.");
  authorizePrivacy(rt, ctx, subjectId);
  const runs: SubjectExport["runs"] = [];
  for (const runId of await rt.store.listRunsBySubject(ctx.scope, subjectId)) {
    const state = await rt.store.loadRun(ctx.scope, runId);
    if (state) runs.push({ state, events: await rt.store.listEvents(ctx.scope, runId) });
  }
  const workspaces: WorkspaceState[] = [];
  for (const w of await rt.store.listWorkspacesByOwner(ctx.scope, subjectId)) workspaces.push({ ...w, pending: await shownPending(rt, ctx, w.pending) });
  const exported = secrets === "include" ? { runs, workspaces } : { runs: maskSecrets(runs, await exportResolver(rt, ctx.scope, runs)), workspaces };
  // Recorded before it is handed out (ADR-0010): an export the log cannot hold fails.
  const record = privacy.exportRecord(ctx, privacyActor(ctx), subjectId, rt.clock.now(), runs.map((r) => r.state.runId), workspaces.map((w) => w.id), secrets);
  await privacy.recordExport(rt.privacyDeps, ctx.scope, record);
  return exported;
}

/** The definitions an export's runs ran under, loaded first so their secrets can be found by replay. */
export async function exportResolver(rt: RuntimeContext, scope: Scope, runs: readonly ExportedRun[]): Promise<FlowResolver> {
  const loaded = new Map<string, CompiledFlow | null>();
  for (const run of runs) {
    for (const { flowId, version, hash } of versionsOf(run)) {
      const key = `${flowId}@${version}#${hash}`;
      if (loaded.has(key)) continue;
      let flow: CompiledFlow | null = null;
      try {
        flow = await rt.catalog.get(scope, flowId, version);
      } catch (error) {
        // Masked whole, never left unmasked.
        rt.observer.error?.(error, "export");
      }
      loaded.set(key, flow && flow.hash === hash ? flow : null);
    }
  }
  return (flowId, version, hash) => loaded.get(`${flowId}@${version}#${hash}`) ?? null;
}

export async function eraseSubject(rt: RuntimeContext, ctx: TrustedContext, subjectId: string): Promise<EraseResult> {
  checkContext(ctx);
  authorizePrivacy(rt, ctx, subjectId);
  const scope = ctx.scope;
  const runIds = await rt.store.listRunsBySubject(scope, subjectId);
  // A legal hold on the tenant, the scope, the person or any of their runs refuses the whole erasure, before anything is ended.
  const held = await privacy.holdsOnSubject(rt.privacyDeps, scope, subjectId, runIds, rt.clock.now());
  if (held.length > 0) return erasureDone(rt, ctx, subjectId, { runs: [], workspaces: [], heldBy: held.map((h) => h.id) }, []);
  // Erasing a run that still holds something would leave the hold behind with nobody to release
  // it. Each live tree is ended from its root, whatever it committed (`erase`): the end cancels
  // its live calls through the usual path, and each run releases its own holds.
  const unended = new Set<string>();
  const unloadable = new Set<string>();
  const end = async (runId: string): Promise<void> => {
    const outcome = await endForErasure(rt, scope, runId);
    if (outcome === "unavailable") unended.add(runId);
    else if (outcome === "unloadable") {
      unended.add(runId);
      unloadable.add(runId);
    }
  };
  const children: RunState[] = [];
  for (const runId of runIds) {
    const state = await rt.store.loadRun(scope, runId);
    if (!state || isTerminal(state.status)) continue;
    if (state.parent && (await isLive(rt, scope, state.parent.runId))) children.push(state);
    else await end(runId);
  }
  // A child whose tree could not be ended (its root's flow does not load) is ended on its own.
  for (const child of children) {
    if (unended.has(child.parent!.rootRunId) || unended.has(child.parent!.runId)) await end(child.runId);
  }
  // What is still letting go of something of its own (an effect in flight, a hold not yet
  // released) is waited for, from when its tree's end began, up to eraseWaitMs. A run whose flow
  // version no longer loads can never let go, and is not waited for; nor is one that only waits
  // for its calls, which hold nothing themselves.
  const now = rt.clock.now();
  const releasing: ErasureRun[] = [];
  const waiting: ErasureRun[] = [];
  const abandoned: ErasureRun[] = [];
  for (const runId of runIds) {
    const state = await rt.store.loadRun(scope, runId);
    if (!state || isTerminal(state.status)) continue;
    const entry: ErasureRun = { runId, status: state.status };
    if (!holdsAnything(state)) {
      waiting.push(entry);
      continue;
    }
    if (unloadable.has(runId) || (!unended.has(runId) && (await versionLoads(rt, scope, state)) === "unloadable")) {
      abandoned.push(entry);
      continue;
    }
    const rootId = state.parent?.rootRunId ?? runId;
    const root = rootId === runId ? state : await rt.store.loadRun(scope, rootId);
    const since = root?.end?.at ?? root?.pendingEnd?.at ?? state.end?.at ?? state.pendingEnd?.at;
    if (since !== undefined && now - since >= rt.limits.eraseWaitMs) abandoned.push(entry);
    else releasing.push(entry);
  }
  if (releasing.length > 0) {
    const order = new Map(runIds.map((id, i) => [id, i]));
    const named = [...releasing, ...waiting].sort((a, b) => order.get(a.runId)! - order.get(b.runId)!);
    return { erased: 0, releasing: named, retryAfterMs: ERASE_RETRY_MS };
  }
  for (const run of abandoned) {
    rt.observer.error?.(new FlowError("unavailable", `Erased run ${run.runId} while it was still ${run.status}: what it held may remain at the service.`), "erase");
  }
  // Runs, then the workspaces (they hold the person's id and the facts of any open question), until a store refuses.
  // Each erasure records the file references it releases with it, so what a refusal kept is never released.
  const data = await privacy.eraseData(rt.privacyDeps, scope, subjectId, runIds, rt.clock.now());
  return erasureDone(rt, ctx, subjectId, data, abandoned, data.released);
}

/** Records an erasure's receipt (after its deletes, or for a refusal) and answers with it. */
export async function erasureDone(rt: RuntimeContext, ctx: TrustedContext, subjectId: string, data: Omit<privacy.ErasedData, "released">, abandoned: ErasureRun[], released: BlobRef[] = []): Promise<EraseResult> {
  const erased = abandoned.filter((a) => data.runs.includes(a.runId));
  const receipt = privacy.erasureReceipt(ctx, privacyActor(ctx), subjectId, rt.clock.now(), data, erased, released);
  await privacy.recordErasure(rt.privacyDeps, ctx.scope, receipt);
  const files = released.length > 0 ? { released } : {};
  if (data.heldBy) return { erased: data.runs.length, code: "flow/erasure-held", held: data.heldBy, ...files, receipt };
  return { erased: data.runs.length, ...(erased.length > 0 ? { abandoned: erased } : {}), ...files, receipt };
}

export async function placeHold(rt: RuntimeContext, ctx: TrustedContext, input: privacy.PlaceHoldInput): Promise<LegalHold> {
  checkContext(ctx);
  authorizeHolds(rt, ctx);
  return privacy.placeHold(rt.privacyDeps, ctx, actorRef(ctx).id, input);
}

export async function releaseHold(rt: RuntimeContext, ctx: TrustedContext, holdId: string, input: { reason?: string } = {}): Promise<LegalHold> {
  checkContext(ctx);
  authorizeHolds(rt, ctx);
  return privacy.releaseHold(rt.privacyDeps, ctx, actorRef(ctx).id, holdId, input?.reason);
}

export async function listHolds(rt: RuntimeContext, ctx: TrustedContext, input: privacy.ListHoldsInput = {}): Promise<LegalHold[]> {
  checkContext(ctx);
  authorizeHolds(rt, ctx);
  return privacy.listHolds(rt.privacyDeps, ctx, input ?? {});
}

/**
 * Ends a live run for erasure (`run.cancelled` with `erase`), unless its end
 * is already under way. `unavailable` when its flow could not be read now,
 * `unloadable` when its version no longer loads (it never will).
 */
export async function endForErasure(rt: RuntimeContext, scope: Scope, runId: string): Promise<"ended" | "unavailable" | "unloadable"> {
  const state = await rt.store.loadRun(scope, runId);
  if (!state || state.status !== "active" || state.pendingEnd) return "ended";
  const loads = await versionLoads(rt, scope, state);
  if (loads !== "loads") return loads;
  let applied: Applied;
  try {
    applied = await apply(rt, scope, runId, {
      build: (latest) =>
        latest.status !== "active" || latest.pendingEnd
          ? null
          : { v: EVENT_VERSION, type: "run.cancelled", id: rt.ids.newId(), at: rt.clock.now(), actor: SYSTEM_ACTOR, reason: "erasure", erase: true },
      chain: newChain(rt),
    });
  } catch (error) {
    if (isNotFound(error)) return "ended";
    rt.observer.error?.(error, "erase");
    return "unavailable";
  }
  // The core refuses this end only for a run it cannot step at all (a state from a newer engine, say).
  if (applied.result && !applied.result.accepted) {
    rt.observer.error?.(new FlowError("unavailable", `Run ${runId} could not be ended for erasure (${applied.result.rejection.code}).`), "erase");
    return "unloadable";
  }
  return "ended";
}

/** How long `eraseSubject` asks its caller to wait before calling again while runs let go. */
export const ERASE_RETRY_MS = 30_000;

/**
 * Whether a run still has something of its own to let go of: an effect in
 * flight (a release among them) or a hold not yet released. A committed hold
 * stays done, and one in doubt waits for a person; neither is waited for.
 */
export function holdsAnything(state: RunState): boolean {
  return Object.keys(state.inflight).length > 0 || Object.values(state.resources).some((r) => r.status === "held" || r.status === "releasing");
}

/** The actor as a privacy record names them: no roles. */
export function privacyActor(ctx: TrustedContext): PrivacyRecord["actor"] {
  const { kind, id, for: onBehalf } = actorRef(ctx);
  return { kind, id, ...(onBehalf !== undefined ? { for: onBehalf } : {}) };
}
