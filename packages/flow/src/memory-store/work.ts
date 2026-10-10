/**
 * The memory store's claims: the outbox (claim, renew, release, take) and
 * timers, round-robin across tenants.
 */

import { claimVisit, LANE_SCAN_FACTOR } from "../lanes.js";
import { type ClaimOptions, type OutboxItem, type TimerItem, scopeKey } from "../store.js";
import { type MemoryContext, sliceLimit, clone, compareText } from "./context.js";
import { pickOutbox } from "./lanes.js";
import type { MemoryRunStore } from "../memory-store.js";

/** Claims: the outbox (claim, renew, release, take) and timers. */
export function workOps(m: MemoryContext): Pick<MemoryRunStore, "claimOutbox" | "renewOutbox" | "releaseOutbox" | "takeOutbox" | "claimTimers"> {
  const { outbox, timers, storeVisit } = m;
  return {
    async claimOutbox(options: ClaimOptions) {
      const limit = sliceLimit(options.limit);
      if (limit === 0) return [];
      const picked = pickOutbox(m, options.now, limit);
      const out: OutboxItem[] = [];
      for (const { item, probe } of picked) {
        item.claims += 1;
        item.leaseOwner = options.owner;
        item.leaseUntil = options.now + options.leaseMs;
        const claimed = clone(item);
        if (probe) claimed.probe = true;
        out.push(claimed);
      }
      return out.sort((a, b) => a.availableAt - b.availableAt || compareText(a.id, b.id));
    },

    async renewOutbox(scope, lease, leaseUntil) {
      const item = outbox.get(`${scopeKey(scope)}|${lease.id}`);
      if (!item || item.leaseOwner !== lease.owner || item.leaseUntil !== lease.until) return false;
      item.leaseUntil = leaseUntil;
      return true;
    },

    async releaseOutbox(scope, lease, availableAt) {
      const item = outbox.get(`${scopeKey(scope)}|${lease.id}`);
      if (!item || item.leaseOwner !== lease.owner || item.leaseUntil !== lease.until) return false;
      item.claims = Math.max(0, item.claims - 1);
      delete item.leaseOwner;
      delete item.leaseUntil;
      item.availableAt = Math.max(item.availableAt, availableAt);
      return true;
    },

    async takeOutbox(scope, id, options) {
      const item = outbox.get(`${scopeKey(scope)}|${id}`);
      if (!item || item.claims !== 0 || (item.leaseUntil !== undefined && item.leaseUntil > options.now)) return false;
      item.leaseOwner = options.owner;
      item.leaseUntil = options.now + options.leaseMs;
      return true;
    },

    async claimTimers(options: ClaimOptions) {
      const limit = sliceLimit(options.limit);
      if (limit === 0) return [];
      // Round-robin across tenants from the cursor (its own last), each tenant's earliest first;
      // the same visit as Postgres's `claim_timers`.
      const dueOf = (t: TimerItem) => Math.max(t.dueAt, t.leaseUntil ?? Number.NEGATIVE_INFINITY);
      const byTenant = new Map<string, TimerItem[]>();
      let anyDue = false;
      for (const t of timers.values()) {
        const list = byTenant.get(t.scope.tenantId) ?? [];
        byTenant.set(t.scope.tenantId, list);
        if (dueOf(t) <= options.now) {
          list.push(t);
          anyDue = true;
        }
      }
      if (!anyDue) return [];
      const tenants = [...byTenant.keys()].sort(compareText);
      const after = m.timerCursor;
      const order = after === null ? tenants : [...tenants.filter((t) => compareText(t, after) > 0), ...tenants.filter((t) => compareText(t, after) <= 0)];
      const visit = claimVisit(storeVisit, limit);
      const scanBudget = LANE_SCAN_FACTOR * visit;
      let scanned = 0;
      let lastExamined: string | undefined;
      const visited: string[] = [];
      for (const tenant of order) {
        if (visited.length >= visit || scanned >= scanBudget) break;
        scanned += 1;
        lastExamined = tenant;
        if (byTenant.get(tenant)!.length > 0) visited.push(tenant);
      }
      let fallback = false;
      if (visited.length === 0) {
        let earliest: TimerItem | undefined;
        for (const list of byTenant.values()) {
          for (const t of list) if (!earliest || dueOf(t) < dueOf(earliest) || (dueOf(t) === dueOf(earliest) && compareText(t.scope.tenantId, earliest.scope.tenantId) < 0)) earliest = t;
        }
        if (earliest) {
          visited.push(earliest.scope.tenantId);
          fallback = true;
        }
      }
      const ranked: Array<{ timer: TimerItem; round: number; position: number }> = [];
      visited.forEach((tenant, position) => {
        byTenant
          .get(tenant)!
          .sort((a, b) => dueOf(a) - dueOf(b) || compareText(a.runId, b.runId) || compareText(a.timerId, b.timerId))
          .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
          .forEach((timer, round) => ranked.push({ timer, round, position }));
      });
      ranked.sort((a, b) => a.round - b.round || a.position - b.position);
      const due = ranked.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
      // The next claim starts after the tenant of the last timer taken, or after the last tenant examined.
      if (due.length > 0 && !fallback) m.timerCursor = visited[due[due.length - 1]!.position]!;
      else if (lastExamined !== undefined) m.timerCursor = lastExamined;
      // Room left (the visit found few tenants with due timers): the earliest due timers of any
      // tenant, so sparse due timers fill a claim; the cursor stays where the visit left it.
      if (due.length < limit) {
        const taken = new Set(due.map(({ timer }) => timer));
        const rest = [...byTenant.values()]
          .flat()
          .filter((t) => !taken.has(t))
          .sort((a, b) => dueOf(a) - dueOf(b) || compareText(a.scope.tenantId, b.scope.tenantId) || compareText(a.runId, b.runId) || compareText(a.timerId, b.timerId));
        for (const timer of rest.slice(0, limit - due.length)) due.push({ timer, round: 0, position: -1 });
      }
      for (const { timer } of due) {
        timer.leaseOwner = options.owner;
        timer.leaseUntil = options.now + options.leaseMs;
      }
      return due.map(({ timer }) => clone(timer)).sort((a, b) => a.dueAt - b.dueAt || compareText(a.runId, b.runId) || compareText(a.timerId, b.timerId));
    },
  };
}
