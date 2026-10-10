/**
 * The memory store's runs and workspaces: loading, committing a batch,
 * finding a waiting run, the reads, and the health counts.
 */

import { type CommitBatch, type CommitResult, scopeKey } from "../store.js";
import { healthCap, type StoreHealth } from "../health.js";
import { type MemoryContext, runKey, clone, wsKey, timerKey, waitKey, namedBlobs } from "./context.js";
import { applySignals, isDue } from "./lanes.js";
import type { MemoryRunStore } from "../memory-store.js";

/** The store's runs and workspaces: loading them, committing a batch and finding a waiting run. */
export function runOps(m: MemoryContext): Pick<MemoryRunStore, "loadRun" | "loadWorkspace" | "commit" | "findWaiting"> {
  const { fair, runs, outbox, timers, waits, workspaces, subjects } = m;
  return {
    async loadRun(scope, runId) {
      const record = runs.get(runKey(scope, runId));
      return record ? clone(record.state) : null;
    },

    async loadWorkspace(scope, workspaceId) {
      const ws = workspaces.get(wsKey(scope, workspaceId));
      return ws ? clone(ws) : null;
    },

    async commit(batch: CommitBatch): Promise<CommitResult> {
      // Validate every precondition before changing anything.
      for (const write of batch.runs) {
        if (scopeKey(write.state.scope) !== scopeKey(batch.scope)) throw new Error("run write outside the batch scope");
        const existing = runs.get(runKey(batch.scope, write.runId));
        const stored = existing ? existing.state.revision : 0;
        if ((write.expectedRevision === 0 && existing) || stored !== write.expectedRevision) return { ok: false, conflict: "run", id: write.runId };
      }
      if (batch.workspace) {
        const existing = workspaces.get(wsKey(batch.scope, batch.workspace.state.id));
        const stored = existing ? existing.revision : 0;
        if ((batch.workspace.expectedRevision === 0 && existing) || stored !== batch.workspace.expectedRevision) {
          return { ok: false, conflict: "workspace", id: batch.workspace.state.id };
        }
      }
      for (const lease of batch.outbox?.taken ?? []) {
        const item = outbox.get(`${scopeKey(batch.scope)}|${lease.id}`);
        if (!item || item.leaseOwner !== lease.owner || item.leaseUntil !== lease.until) return { ok: false, conflict: "outbox", id: lease.id };
      }
      for (const write of batch.runs) {
        const key = runKey(batch.scope, write.runId);
        const record = runs.get(key) ?? { state: write.state, events: [] };
        let seq = write.expectedRevision;
        for (const event of write.events) record.events.push({ runId: write.runId, seq: ++seq, event: clone(event) });
        record.state = clone(write.state);
        runs.set(key, record);
        if (write.state.subject) {
          const sk = `${scopeKey(batch.scope)}|${write.state.subject.id}`;
          let set = subjects.get(sk);
          if (!set) subjects.set(sk, (set = new Set()));
          set.add(write.runId);
        }
      }
      if (batch.workspace) workspaces.set(wsKey(batch.scope, batch.workspace.state.id), clone(batch.workspace.state));
      for (const id of [...(batch.outbox?.done ?? []), ...(batch.outbox?.taken ?? []).map((l) => l.id)]) outbox.delete(`${scopeKey(batch.scope)}|${id}`);
      for (const item of batch.outbox?.add ?? []) {
        // An existing id is kept as it is, with its claims and lease.
        const key = `${scopeKey(batch.scope)}|${item.id}`;
        if (!outbox.has(key)) {
          const { probe: _probe, ...stored } = item;
          outbox.set(key, clone(stored));
        }
      }
      for (const done of batch.timers?.done ?? []) {
        const key = timerKey(batch.scope, done.runId, done.timerId);
        if (timers.get(key)?.generation === done.generation) timers.delete(key);
      }
      for (const timer of batch.timers?.set ?? []) {
        const { leaseOwner: _o, leaseUntil: _u, ...rest } = timer;
        timers.set(timerKey(batch.scope, timer.runId, timer.timerId), clone(rest));
      }
      for (const cancel of batch.timers?.cancel ?? []) timers.delete(timerKey(batch.scope, cancel.runId, cancel.timerId));
      for (const close of batch.waits?.close ?? []) waits.delete(waitKey(batch.scope, close.runId, close.stepId));
      for (const open of batch.waits?.open ?? []) waits.set(waitKey(batch.scope, open.runId, open.stepId), clone(open));
      if (fair && batch.lanes) applySignals(m, batch.scope, batch.lanes.signals, batch.lanes.now);
      return { ok: true };
    },

    async findWaiting(scope, event, key) {
      const out: Array<{ runId: string; stepId: string }> = [];
      const prefix = scopeKey(scope);
      for (const wait of waits.values()) {
        if (scopeKey(wait.scope) === prefix && wait.event === event && wait.key === key) out.push({ runId: wait.runId, stepId: wait.stepId });
      }
      return out;
    },
  };
}

/** The store's reads: events, live runs, runs on a version or of a subject, files in use. */
export function readOps(m: MemoryContext): Pick<MemoryRunStore, "listEvents" | "listLiveRuns" | "hasRunOnVersion" | "listRunsBySubject" | "blobsInUse"> {
  const { runs, subjects } = m;
  return {
    async listEvents(scope, runId, options = {}) {
      const record = runs.get(runKey(scope, runId));
      if (!record) return [];
      const after = options.afterSeq ?? 0;
      return record.events.filter((e) => e.seq > after).slice(0, options.limit ?? Number.POSITIVE_INFINITY).map(clone);
    },

    async listLiveRuns(scope, query) {
      const prefix = `${scopeKey(scope)}|`;
      const out: Array<{ runId: string; flowVersion: string }> = [];
      for (const [key, record] of runs) {
        const st = record.state;
        if (!key.startsWith(prefix) || st.flowId !== query.flowId || (st.status !== "active" && st.status !== "cancelling")) continue;
        if (query.version !== undefined && st.flowVersion !== query.version) continue;
        if (query.after !== undefined && !(st.runId > query.after)) continue;
        out.push({ runId: st.runId, flowVersion: st.flowVersion });
      }
      out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
      return out.slice(0, Math.max(0, query.limit));
    },

    async hasRunOnVersion(scope, query) {
      const prefix = `${scopeKey(scope)}|`;
      for (const [key, record] of runs) {
        if (key.startsWith(prefix) && record.state.flowId === query.flowId && record.state.flowVersion === query.version) return true;
      }
      return false;
    },

    async listRunsBySubject(scope, subjectId) {
      return [...(subjects.get(`${scopeKey(scope)}|${subjectId}`) ?? [])].filter((runId) => runs.has(runKey(scope, runId)));
    },

    async blobsInUse(scope, blobIds) {
      const named = namedBlobs(m, scope);
      return [...new Set(blobIds)].filter((id) => named.has(id));
    },
  };
}

/** The store's health counts. */
export function healthOps(m: MemoryContext): Pick<MemoryRunStore, "health"> {
  const { fair, runs, outbox, laneStates, timers } = m;
  return {
    async health(o) {
      const cap = healthCap(o.cap);
      const backlog = (due: number[]) => ({ due: Math.min(due.length, cap), capped: due.length > cap, oldestDueAt: due.length > 0 ? Math.min(...due) : null });
      const outboxDue = [...outbox.values()].filter((i) => isDue(i, o.now)).map((i) => Math.max(i.availableAt, i.leaseUntil ?? Number.NEGATIVE_INFINITY));
      const timersDue = [...timers.values()].map((t) => Math.max(t.dueAt, t.leaseUntil ?? Number.NEGATIVE_INFINITY)).filter((due) => due <= o.now);
      let effects = 0;
      let held = 0;
      for (const { state } of runs.values()) {
        if (state.attention.length === 0) continue;
        held += 1;
        effects += state.attention.length;
      }
      const out: StoreHealth = {
        outbox: backlog(outboxDue),
        timers: backlog(timersDue),
        inDoubt: { effects, runs: Math.min(held, cap), capped: held > cap },
        // The memory store sets nothing aside: every item it holds opens.
        deadOutbox: 0,
      };
      if (fair) {
        let paused = 0;
        let open = 0;
        for (const st of laneStates.values()) {
          if (st.pausedUntil > o.now) paused += 1;
          if (st.breaker !== "closed") open += 1;
        }
        out.lanes = { paused: Math.min(paused, cap), open: Math.min(open, cap), capped: paused > cap || open > cap };
      }
      return out;
    },
  };
}
