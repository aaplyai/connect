/**
 * The runtime's side of legal holds and the privacy log (ADR-0010): managing
 * holds for `holdRoles`, checking a person's erasure against them before it
 * starts, erasing run by run until a store refuses (each erasure recording
 * the file references it releases, `blob-release.ts`), and recording a
 * value-free receipt of every export and erasure. `runtime.ts` delegates
 * here; identity and authorization of the caller are decided there, from the
 * trusted context.
 */

import type { BlobRef } from "@aaply/action-contract";
import { asReleases, freedOf, readHoldings, releasesOf } from "./blob-release.js";
import { FlowError } from "./errors.js";
import { fingerprint } from "./hash.js";
import type { JsonValue } from "./json.js";
import type { Clock, Observer, TrustedContext } from "./ports.js";
import { holdProblems, isErasureHeld, type HoldTarget, type LegalHold, type PrivacyRecord } from "./privacy.js";
import type { RunStatus, Scope } from "./state.js";
import type { RunStore } from "./store.js";

/** What the runtime lends this module. */
export interface PrivacyDeps {
  store: RunStore;
  clock: Clock;
  observer: Observer;
}

/** Who did it, as a record names them: `domain:id`, its kind, and the person it acted for. */
export type PrivacyActor = PrivacyRecord["actor"];

/** A hold to place, as `runtime.placeHold` takes it. */
export interface PlaceHoldInput {
  target: HoldTarget;
  /** Why (at most 500 characters): the host's words, never a person's data. */
  reason: string;
  /** When it lapses on its own (after now); absent: until released. */
  until?: number;
}

/** Which holds `runtime.listHolds` lists. */
export interface ListHoldsInput {
  /** Also released and lapsed ones. */
  ended?: boolean;
}

/** `runtime.placeHold`. Retried with the same request id, it returns the hold the first try placed. */
export async function placeHold(deps: PrivacyDeps, ctx: TrustedContext, by: string, input: PlaceHoldInput): Promise<LegalHold> {
  const ops = privacyOf(deps.store);
  if (input === null || typeof input !== "object") throw new FlowError("invalid", "A hold names its target and reason.");
  const at = deps.clock.now();
  // The id is the request's: a retried placement finds the hold the first one placed.
  const id = `hold-${fingerprint(["hold", ctx.actor.kind, ctx.actor.domain, ctx.actor.id, ctx.requestId])}`;
  const hold = { id, target: input.target, reason: input.reason, by, at, ...(input.until !== undefined ? { until: input.until } : {}) };
  const problems = holdProblems(hold);
  if (problems.length > 0) throw new FlowError("invalid", `Bad hold: ${problems.join("; ")}.`);
  const target = input.target;
  const clean: HoldTarget =
    target.kind === "subject" ? { kind: "subject", subjectId: target.subjectId } : target.kind === "run" ? { kind: "run", runId: target.runId } : { kind: target.kind };
  try {
    return await ops.placeHold(ctx.scope, { ...hold, target: clean });
  } catch (error) {
    deps.observer.error?.(error, "hold");
    throw new FlowError("unavailable", "The hold could not be placed.");
  }
}

/** `runtime.releaseHold`: `not_found` when the scope placed no such hold (a tenant hold is released from the scope that placed it). */
export async function releaseHold(deps: PrivacyDeps, ctx: TrustedContext, by: string, holdId: string, reason: string | undefined): Promise<LegalHold> {
  const ops = privacyOf(deps.store);
  if (typeof holdId !== "string" || holdId.length === 0 || holdId.length > 400) throw new FlowError("invalid", "Bad hold id.");
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0 || reason.length > 500)) throw new FlowError("invalid", "A release reason is 1 to 500 characters.");
  let released: LegalHold | null;
  try {
    released = await ops.releaseHold(ctx.scope, holdId, { by, at: deps.clock.now(), ...(reason !== undefined ? { reason } : {}) });
  } catch (error) {
    deps.observer.error?.(error, "hold");
    throw new FlowError("unavailable", "The hold could not be released.");
  }
  if (!released) throw new FlowError("not_found", "Not found.");
  return released;
}

/** `runtime.listHolds`: the holds visible from the scope, in force unless `ended`. */
export async function listHolds(deps: PrivacyDeps, ctx: TrustedContext, input: ListHoldsInput): Promise<LegalHold[]> {
  const ops = privacyOf(deps.store);
  return ops.listHolds(ctx.scope, { now: deps.clock.now(), ...(input.ended === true ? { ended: true } : {}) });
}

/**
 * The holds in force covering a person's erasure: the tenant, the scope, the
 * person, or one of their runs. None for a store without holds.
 */
export async function holdsOnSubject(deps: PrivacyDeps, scope: Scope, subjectId: string, runIds: string[], now: number): Promise<LegalHold[]> {
  const ops = deps.store.privacy;
  if (!ops) return [];
  return ops.listHolds(scope, { now, covering: { subjectId, runIds } });
}

/** What erasing a person's runs and workspaces did. */
export interface ErasedData {
  /** Runs erased, in the order given. */
  runs: string[];
  workspaces: string[];
  /** The holds of a store's refusal, which stopped the erasure there. */
  heldBy?: string[];
  /** The file references what was erased released (unique by id), each recorded with its erasure, that no stored run names any more. */
  released: BlobRef[];
}

/**
 * Erases the runs, then the person's workspaces, as the store allows: a
 * refusal (a hold placed while the erasure was under way) stops it, and what
 * was erased before is said. What every run and the workspaces hold is read
 * first; each run's erasure is then given the references it held, but those
 * the workspaces hold (theirs are released with them), and the store records
 * them with it, so nothing a refusal kept, or a failure left, is recorded.
 * The ledger lists each once no stored run names it (ADR-0008, amended by the
 * verification round), and `released` names those none names when the
 * erasure is done. A store that cannot say which files its runs name is
 * given no releases. When asking it fails after the erasure, `released` is
 * empty, the failure goes to `observer.error` as `erase`, and the ledger
 * still lists them.
 */
export async function eraseData(deps: PrivacyDeps, scope: Scope, subjectId: string, runIds: string[], now: number): Promise<ErasedData> {
  const holdings = readHoldings(deps.store, scope);
  const runs: string[] = [];
  const recorded: BlobRef[] = [];
  const freed = async (): Promise<BlobRef[]> => {
    try {
      return await freedOf(deps.store, scope, recorded);
    } catch (error) {
      deps.observer.error?.(error, "erase");
      return [];
    }
  };
  const stopped = async (heldBy: string[]): Promise<ErasedData> => ({ runs, workspaces: [], heldBy, released: await freed() });
  for (const runId of runIds) {
    const refs = await releasesOf(deps.store, holdings, await holdings.run(runId), subjectId);
    const outcome = await deps.store.eraseRun(scope, runId, { now, releases: asReleases(refs, runId, now) });
    if (isErasureHeld(outcome)) return stopped(outcome.holds.map((h) => h.id));
    runs.push(runId);
    recorded.push(...refs);
  }
  // A store without holds answers nothing: its workspace ids are read first, for the receipt.
  const before = deps.store.privacy ? null : (await deps.store.listWorkspacesByOwner(scope, subjectId)).map((w) => w.id);
  const refs = await releasesOf(deps.store, holdings, await holdings.workspaces(subjectId), null);
  const outcome = await deps.store.eraseWorkspaces(scope, subjectId, { now, releases: asReleases(refs, null, now) });
  if (isErasureHeld(outcome)) return stopped(outcome.holds.map((h) => h.id));
  recorded.push(...refs);
  return { runs, workspaces: outcome && Array.isArray(outcome.workspaces) ? [...outcome.workspaces] : (before ?? []), released: await freed() };
}

/** A value-free receipt of an erasure (`PrivacyRecord`). */
export function erasureReceipt(
  ctx: TrustedContext,
  actor: PrivacyActor,
  subjectId: string,
  at: number,
  data: Omit<ErasedData, "released">,
  abandoned: Array<{ runId: string; status: RunStatus }>,
  released: readonly BlobRef[],
): PrivacyRecord {
  return withId({
    kind: "erase",
    subjectId,
    at,
    actor,
    requestId: ctx.requestId,
    runs: [...data.runs],
    workspaces: [...data.workspaces],
    ...(data.heldBy && data.heldBy.length > 0 ? { heldBy: [...data.heldBy] } : {}),
    ...(abandoned.length > 0 ? { abandoned: abandoned.map((a) => ({ runId: a.runId, status: a.status })) } : {}),
    // Ids only, as the blob ledger keeps them: the receipt outlives the runs, and a name or digest is the person's.
    ...(released.length > 0 ? { released: released.map((r) => r.id) } : {}),
  });
}

/** A value-free record of an export. */
export function exportRecord(ctx: TrustedContext, actor: PrivacyActor, subjectId: string, at: number, runs: string[], workspaces: string[], secrets: "mask" | "include"): PrivacyRecord {
  return withId({ kind: "export", subjectId, at, actor, requestId: ctx.requestId, runs, workspaces, secrets });
}

/**
 * A record's id is the digest of what it says, so recording takes no id from
 * the runtime's id source (whose sequence runs and replays depend on), and the
 * same record written twice is kept once. A request retried later (another
 * `at`) is recorded again: it is another export or erasure.
 */
function withId(record: Omit<PrivacyRecord, "id">): PrivacyRecord {
  return { id: `${record.kind}-${fingerprint(record as unknown as JsonValue)}`, ...record };
}

/**
 * Records an erasure's receipt after its deletes. A failure is reported to
 * `observer.error` as `erase` and does not undo the erasure: the caller's
 * answer still carries the receipt.
 */
export async function recordErasure(deps: PrivacyDeps, scope: Scope, receipt: PrivacyRecord): Promise<void> {
  if (!deps.store.privacy) return;
  try {
    await deps.store.privacy.record(scope, receipt);
  } catch (error) {
    deps.observer.error?.(error, "erase");
  }
}

/** Records an export before it is handed out: a failure fails the export (`unavailable`). */
export async function recordExport(deps: PrivacyDeps, scope: Scope, record: PrivacyRecord): Promise<void> {
  if (!deps.store.privacy) return;
  try {
    await deps.store.privacy.record(scope, record);
  } catch (error) {
    deps.observer.error?.(error, "export");
    throw new FlowError("unavailable", "The export could not be recorded, so it was not handed out.");
  }
}

function privacyOf(store: RunStore): NonNullable<RunStore["privacy"]> {
  if (!store.privacy) throw new FlowError("unavailable", "This store keeps no legal holds.");
  return store.privacy;
}
