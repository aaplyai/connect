/**
 * Legal holds and the privacy log (ADR-0010): the store's side.
 *
 * A legal hold keeps what it covers from being erased until it is released
 * or lapses. The privacy log records every export and erasure of a person's
 * data, without a value of theirs in it. A store offers both through
 * `RunStore.privacy`; the rules every store follows are here as pure
 * functions, so the memory store applies them directly and the Postgres
 * store states the same predicate in SQL (both are held to it by
 * `storeConformanceCases`).
 */

import type { ActorKind, RunStatus, Scope } from "./state.js";

/**
 * What a hold covers:
 * - `tenant`: everything of the tenant, in every app and environment;
 * - `scope`: everything in this app and environment;
 * - `subject`: one person in this scope (their runs and their workspaces);
 * - `run`: one run in this scope.
 */
export type HoldTarget = { kind: "tenant" } | { kind: "scope" } | { kind: "subject"; subjectId: string } | { kind: "run"; runId: string };

/** A legal hold, as a store lists it. Released and lapsed holds are kept, as the record. */
export interface LegalHold {
  id: string;
  target: HoldTarget;
  /** Why it was placed (at most `MAX_HOLD_REASON` characters). The host's words, never a person's data. */
  reason: string;
  /** Who placed it (`domain:id`), and when. */
  placedBy: string;
  placedAt: number;
  /** When it lapses on its own; absent: it lasts until released. */
  until?: number;
  /** Set once it was released: by whom, when and why. A released hold covers nothing. */
  released?: { by: string; at: number; reason?: string };
}

/** A hold to place. The id is the caller's (the runtime derives it from the request, so a retry finds it), unique within the tenant. */
export interface NewHold {
  id: string;
  target: HoldTarget;
  reason: string;
  /** Who places it (`domain:id`). */
  by: string;
  at: number;
  until?: number;
}

/** Releasing a hold. */
export interface HoldRelease {
  by: string;
  at: number;
  reason?: string;
}

/**
 * Which holds `listHolds` lists: those visible from the scope (the tenant's
 * `tenant` holds and the scope's own), in force at `now` unless `ended`, and
 * with `covering`, only those covering the tenant, the scope, the person
 * `subjectId`, or one of `runIds`.
 */
export interface HoldQuery {
  now: number;
  /** Also list released and lapsed holds. */
  ended?: boolean;
  covering?: { subjectId?: string | null; runIds?: string[] };
}

/** A store's refusal to erase what a hold in force covers. Nothing was changed. */
export interface ErasureHeld {
  erased: false;
  code: "flow/erasure-held";
  holds: LegalHold[];
}

/** What `RunStore.eraseRun` did, from a store with `privacy`. */
export type RunErasure = { erased: true } | ErasureHeld;

/** What `RunStore.eraseWorkspaces` did, from a store with `privacy`: the ids it erased. */
export type WorkspaceErasure = { erased: true; workspaces: string[] } | ErasureHeld;

/**
 * One export or erasure of a person's data, as recorded (ADR-0010). Ids,
 * times and names only: never a fact value. It keeps the subject id, since
 * a receipt that does not say whose data it was proves nothing.
 */
export interface PrivacyRecord {
  /** Unique per record. */
  id: string;
  kind: "export" | "erase";
  subjectId: string;
  at: number;
  /** Who asked: `domain:id`, its kind, and the person it acted for, if any. */
  actor: { kind: ActorKind; id: string; for?: string };
  /** The request that did it. */
  requestId: string;
  /** Runs exported or erased (children included), oldest first. */
  runs: string[];
  /** Workspaces exported or erased. */
  workspaces: string[];
  /** Export only: how secrets were treated. */
  secrets?: "mask" | "include";
  /**
   * Erase only: the holds that refused the erasure (nothing was erased) or
   * stopped it part way (`runs` names what was erased before).
   */
  heldBy?: string[];
  /** Erase only: runs erased while still letting go of something at a service; what they held may remain there. */
  abandoned?: Array<{ runId: string; status: RunStatus }>;
  /**
   * Erase only: the ids of the file references the erasure released (its
   * answer's `released`, as the store's blob ledger records them). Ids only:
   * never a name or a digest, which are the person's.
   */
  released?: string[];
}

/** A page of the privacy log starts after this record (`listRecords`). */
export interface RecordCursor {
  at: number;
  id: string;
}

/** Legal holds and the privacy log: optional on a store (`RunStore.privacy`), implemented by both stores here. */
export interface PrivacyOps {
  /**
   * Places a hold. Placing an id that already exists in the tenant changes
   * nothing and returns the stored hold (a retried placement). Throws on a
   * malformed hold (`holdProblems`).
   */
  placeHold(scope: Scope, hold: NewHold): Promise<LegalHold>;
  /**
   * Releases a hold visible from the scope, and returns it as released; a
   * hold released before is returned as it was (the first release stands).
   * Null when no such hold is visible.
   */
  releaseHold(scope: Scope, id: string, release: HoldRelease): Promise<LegalHold | null>;
  /** Holds visible from the scope (see `HoldQuery`), ordered by `placedAt`, then id. */
  listHolds(scope: Scope, query: HoldQuery): Promise<LegalHold[]>;
  /** Appends a record. A record whose id exists changes nothing. Throws on a malformed one (`recordProblems`). */
  record(scope: Scope, record: PrivacyRecord): Promise<void>;
  /** Records of the scope, oldest first (by `at`, then id in byte order), optionally of one person, after `after`. */
  listRecords(scope: Scope, query: { subjectId?: string; after?: RecordCursor; limit: number }): Promise<PrivacyRecord[]>;
}

/** Longest hold reason. */
export const MAX_HOLD_REASON = 500;
/** Longest hold or record id, person id or actor id a store accepts. */
export const MAX_PRIVACY_ID = 400;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** What is wrong with a hold to place (empty when nothing is). */
export function holdProblems(hold: NewHold): string[] {
  const out: string[] = [];
  if (hold === null || typeof hold !== "object") return ["a hold is an object"];
  if (!text(hold.id, MAX_PRIVACY_ID)) out.push("id is a non-empty string");
  if (!text(hold.reason, MAX_HOLD_REASON)) out.push(`reason is a non-empty string of at most ${MAX_HOLD_REASON} characters`);
  if (!text(hold.by, MAX_PRIVACY_ID)) out.push("by is a non-empty string");
  if (!time(hold.at)) out.push("at is a finite time");
  if (hold.until !== undefined && (!time(hold.until) || !(hold.until > hold.at))) out.push("until is a finite time after at");
  const t = hold.target as HoldTarget | null | undefined;
  if (t === null || typeof t !== "object") out.push("target is an object");
  else if (t.kind === "subject") {
    if (!text(t.subjectId, MAX_PRIVACY_ID)) out.push("a subject hold names its subjectId");
  } else if (t.kind === "run") {
    if (!text(t.runId, MAX_PRIVACY_ID)) out.push("a run hold names its runId");
  } else if (t.kind !== "tenant" && t.kind !== "scope") out.push("target.kind is tenant, scope, subject or run");
  return out;
}

/** What is wrong with a privacy record (empty when nothing is). */
export function recordProblems(record: PrivacyRecord): string[] {
  const out: string[] = [];
  if (record === null || typeof record !== "object") return ["a record is an object"];
  if (!text(record.id, MAX_PRIVACY_ID)) out.push("id is a non-empty string");
  if (record.kind !== "export" && record.kind !== "erase") out.push("kind is export or erase");
  if (!text(record.subjectId, MAX_PRIVACY_ID)) out.push("subjectId is a non-empty string");
  if (!time(record.at)) out.push("at is a finite time");
  if (record.actor === null || typeof record.actor !== "object" || !text(record.actor.id, MAX_PRIVACY_ID) || typeof record.actor.kind !== "string") out.push("actor names its kind and id");
  if (!text(record.requestId, MAX_PRIVACY_ID)) out.push("requestId is a non-empty string");
  const ids = (v: unknown) => Array.isArray(v) && v.every((x) => text(x, MAX_PRIVACY_ID));
  if (!ids(record.runs)) out.push("runs is a list of ids");
  if (!ids(record.workspaces)) out.push("workspaces is a list of ids");
  if (record.heldBy !== undefined && !ids(record.heldBy)) out.push("heldBy is a list of ids");
  if (record.released !== undefined && !ids(record.released)) out.push("released is a list of ids");
  return out;
}

/**
 * A hold as the columns that place it: the tenant always, the app and
 * environment for all but a `tenant` hold, and the person or the run. Null
 * stands for "any", as in the Postgres `legal_holds` table.
 */
export interface HoldRow {
  tenantId: string;
  appId: string | null;
  environmentId: string | null;
  subjectId: string | null;
  runId: string | null;
}

/** The columns of a hold placed from `scope` on `target`. */
export function holdRowOf(scope: Scope, target: HoldTarget): HoldRow {
  const tenant = { tenantId: scope.tenantId, appId: null, environmentId: null, subjectId: null, runId: null };
  if (target.kind === "tenant") return tenant;
  const scoped = { ...tenant, appId: scope.appId, environmentId: scope.environmentId };
  if (target.kind === "subject") return { ...scoped, subjectId: target.subjectId };
  if (target.kind === "run") return { ...scoped, runId: target.runId };
  return scoped;
}

/**
 * The target a row states. A row placed by hand in another shape reads as
 * the narrowest target that covers at least as much: a run, else a person,
 * else the scope when it names an app and environment, else the tenant.
 */
export function targetOfRow(row: HoldRow): HoldTarget {
  if (row.runId !== null) return { kind: "run", runId: row.runId };
  if (row.subjectId !== null) return { kind: "subject", subjectId: row.subjectId };
  if (row.appId !== null && row.environmentId !== null) return { kind: "scope" };
  return { kind: "tenant" };
}

/** Whether a row is visible from `scope`: a null column matches any value (row-level security in Postgres). */
export function rowVisible(row: HoldRow, scope: Scope): boolean {
  return row.tenantId === scope.tenantId && (row.appId === null || row.appId === scope.appId) && (row.environmentId === null || row.environmentId === scope.environmentId);
}

/** Whether a hold is in force at `now`: not released, and not past its `until`. */
export function holdInForce(hold: LegalHold, now: number): boolean {
  return hold.released === undefined && (hold.until === undefined || hold.until > now);
}

/**
 * The coverage rule (the Postgres predicate `holdCoversSql` states the same):
 * a row visible from the scope covers what it names, a null column matching
 * anything. With `covering`, a row naming a person covers only that person,
 * and one naming a run only one of `runIds`.
 */
export function rowCovers(row: HoldRow, scope: Scope, covering: NonNullable<HoldQuery["covering"]>): boolean {
  if (!rowVisible(row, scope)) return false;
  if (row.runId !== null && !(covering.runIds ?? []).includes(row.runId)) return false;
  if (row.subjectId !== null && row.subjectId !== (covering.subjectId ?? null)) return false;
  return true;
}

/** Whether an erase method's answer is a refusal (`void` and `{ erased: true }` are not). */
export function isErasureHeld(outcome: unknown): outcome is ErasureHeld {
  return outcome !== null && typeof outcome === "object" && (outcome as { erased?: unknown }).erased === false && (outcome as { code?: unknown }).code === "flow/erasure-held";
}

/** Holds by placement time, then id in byte order. */
export function compareHolds(a: LegalHold, b: LegalHold): number {
  return a.placedAt - b.placedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Records by time, then id in byte order. */
export function compareRecords(a: { at: number; id: string }, b: { at: number; id: string }): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
