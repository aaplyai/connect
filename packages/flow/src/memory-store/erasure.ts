/**
 * The memory store's legal holds and privacy log, and erasure: a run, or a
 * person's workspaces, removed unless a hold in force covers it.
 */

import { sameScope, scopeKey } from "../store.js";
import type { Scope } from "../state.js";
import { type PrivacyOps, holdProblems, rowVisible, type LegalHold, holdRowOf, recordProblems, compareRecords, type HoldQuery, rowCovers, holdInForce, compareHolds } from "../privacy.js";
import { type MemoryContext, clone, sliceLimit, runKey, compareText } from "./context.js";
import type { MemoryRunStore } from "../memory-store.js";

/** Legal holds and the privacy log. */
export function privacyOps(m: MemoryContext): PrivacyOps {
  const { holds, records } = m;
  return {
    async placeHold(scope, hold) {
      const problems = holdProblems(hold);
      if (problems.length > 0) throw new Error(`placeHold: ${problems.join("; ")}`);
      const key = `${scope.tenantId}|${hold.id}`;
      const existing = holds.get(key);
      if (existing) {
        if (!rowVisible(existing.row, scope)) throw new Error("placeHold: the hold id is in use in another scope of the tenant");
        return clone(existing.hold);
      }
      const stored: LegalHold = { id: hold.id, target: clone(hold.target), reason: hold.reason, placedBy: hold.by, placedAt: hold.at, ...(hold.until !== undefined ? { until: hold.until } : {}) };
      holds.set(key, { row: holdRowOf(scope, hold.target), hold: stored, placedIn: { ...scope } });
      return clone(stored);
    },
    async releaseHold(scope, id, release) {
      const entry = holds.get(`${scope.tenantId}|${id}`);
      if (!entry || !rowVisible(entry.row, scope) || !sameScope(entry.placedIn, scope)) return null;
      if (!entry.hold.released) entry.hold.released = { by: release.by, at: release.at, ...(release.reason !== undefined ? { reason: release.reason } : {}) };
      return clone(entry.hold);
    },
    async listHolds(scope, query) {
      return holdsFor(m, scope, query);
    },
    async record(scope, record) {
      const problems = recordProblems(record);
      if (problems.length > 0) throw new Error(`record: ${problems.join("; ")}`);
      const list = records.get(scopeKey(scope)) ?? [];
      records.set(scopeKey(scope), list);
      if (!list.some((r) => r.id === record.id)) list.push(clone(record));
    },
    async listRecords(scope, query) {
      const limit = sliceLimit(query.limit);
      if (limit === 0) return [];
      return (records.get(scopeKey(scope)) ?? [])
        .filter((r) => (query.subjectId === undefined || r.subjectId === query.subjectId) && (query.after === undefined || compareRecords(r, query.after) > 0))
        .sort(compareRecords)
        .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
        .map(clone);
    },
  };
}

/** Erasure: a run, or a person's workspaces, removed unless a legal hold covers it. */
export function erasureOps(m: MemoryContext): Pick<MemoryRunStore, "eraseRun" | "listWorkspacesByOwner" | "eraseWorkspaces"> {
  const { runs, ledger, outbox, timers, waits, workspaces, subjects } = m;
  return {
    async eraseRun(scope, runId, options = {}) {
      const record = runs.get(runKey(scope, runId));
      // Checked and deleted with no await in between: a hold placed meanwhile is either seen here or placed after.
      const held = holdsFor(m, scope, { now: options.now ?? Date.now(), covering: { subjectId: record?.state.subject?.id ?? null, runIds: [runId] } });
      if (held.length > 0) return { erased: false, code: "flow/erasure-held", holds: held };
      runs.delete(runKey(scope, runId));
      const prefix = scopeKey(scope);
      for (const [key, item] of outbox) if (item.runId === runId && scopeKey(item.scope) === prefix) outbox.delete(key);
      for (const [key, t] of timers) if (t.runId === runId && scopeKey(t.scope) === prefix) timers.delete(key);
      for (const [key, w] of waits) if (w.runId === runId && scopeKey(w.scope) === prefix) waits.delete(key);
      if (record?.state.subject) subjects.get(`${prefix}|${record.state.subject.id}`)?.delete(runId);
      // In the same step as the delete: what it releases is listed exactly when it is gone.
      ledger.recordNow(scope, options.releases ?? []);
      return { erased: true };
    },

    async listWorkspacesByOwner(scope, owner) {
      const prefix = scopeKey(scope);
      return [...workspaces.values()]
        .filter((ws) => ws.owner === owner && scopeKey(ws.scope) === prefix)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((ws) => clone(ws));
    },

    async eraseWorkspaces(scope, owner, options = {}) {
      const held = holdsFor(m, scope, { now: options.now ?? Date.now(), covering: { subjectId: owner, runIds: [] } });
      if (held.length > 0) return { erased: false, code: "flow/erasure-held", holds: held };
      const prefix = scopeKey(scope);
      const erased: string[] = [];
      for (const [key, ws] of workspaces) {
        if (ws.owner === owner && scopeKey(ws.scope) === prefix) {
          workspaces.delete(key);
          erased.push(ws.id);
        }
      }
      ledger.recordNow(scope, options.releases ?? []);
      return { erased: true, workspaces: erased.sort(compareText) };
    },
  };
}

/** Holds in force at `now` covering what `covering` names, from `scope` (`HoldQuery`). */
export function holdsFor(m: MemoryContext, scope: Scope, query: HoldQuery): LegalHold[] {
  const { holds } = m;
  return [...holds.values()]
    .filter(({ row, hold }) => (query.covering ? rowCovers(row, scope, query.covering) : rowVisible(row, scope)) && (query.ended === true || holdInForce(hold, query.now)))
    .map(({ hold }) => clone(hold))
    .sort(compareHolds);
}
