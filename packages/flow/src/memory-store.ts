/**
 * In-memory RunStore for tests, local development and single-process use.
 * Implements the full store contract, including leases and atomic commits;
 * nothing survives a restart.
 *
 * Claims go round-robin across tenants, then across each tenant's lanes
 * (interactive items first within a tenant's round), and timers round-robin
 * across tenants. With the `lanes` option the store also has
 * fair lanes (`store.lanes`): caps, reserve, token buckets, pauses and
 * breakers, with the same rules as the Postgres store.
 */

import { type BlobLedger } from "./blob-ledger.js";
import {
  type LaneClass,
  type LaneLimit,
  type LaneRecord,
} from "./lanes.js";
import type { OutboxItem, RunStore, TimerItem, WaitItem } from "./store.js";
import {
  type PrivacyOps,
} from "./privacy.js";
import { memoryContext, clone } from "./memory-store/context.js";
import { setLimits, setClasses, laneOps } from "./memory-store/lanes.js";
import { privacyOps, erasureOps } from "./memory-store/erasure.js";
import { runOps, readOps, healthOps } from "./memory-store/runs.js";
import { workOps } from "./memory-store/work.js";

export interface MemoryRunStore extends RunStore {
  /** Number of stored runs, for tests. */
  readonly size: number;
  /** Pending outbox items and timers, for tests. */
  snapshot(): { outbox: OutboxItem[]; timers: TimerItem[]; waits: WaitItem[] };
  listLiveRuns: NonNullable<RunStore["listLiveRuns"]>;
  takeOutbox: NonNullable<RunStore["takeOutbox"]>;
  hasRunOnVersion: NonNullable<RunStore["hasRunOnVersion"]>;
  blobsInUse: NonNullable<RunStore["blobsInUse"]>;
  /** Legal holds and the privacy log. */
  privacy: PrivacyOps;
  health: NonNullable<RunStore["health"]>;
  /** The blob ledger erasure records released file references in. */
  blobs: BlobLedger;
  /** Replaces the lane limit rows (stores created with `lanes`). */
  setLaneLimits(rows: LaneLimit[]): void;
  /** Replaces the lane class rows (stores created with `lanes`). */
  setLaneClasses(rows: LaneClass[]): void;
}

export interface MemoryStoreOptions {
  /** Fair lanes: present (even `{}`) gives the store `lanes` and applies limits and signals. */
  lanes?: {
    limits?: LaneLimit[];
    classes?: LaneClass[];
    /** Lanes with due items one claim visits at most (narrowed to its limit by `claimVisit`), as in the Postgres store. Default 128. */
    visit?: number;
    /** Told about deferred lanes and breaker changes (names only); the runtime's observer hears the rest. */
    onLane?: (record: LaneRecord) => void;
  };
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryRunStore {
  const m = memoryContext(options);
  const { fair, runs, ledger, outbox, timers, waits } = m;

  const privacy = privacyOps(m);

  if (fair) {
    setLimits(m, fair.limits ?? []);
    setClasses(m, fair.classes ?? []);
  }

  return {
    get size() {
      return runs.size;
    },
    blobs: ledger,

    ...(fair ? { lanes: laneOps(m) } : {}),

    snapshot() {
      return { outbox: [...outbox.values()].map(clone), timers: [...timers.values()].map(clone), waits: [...waits.values()].map(clone) };
    },

    setLaneLimits(rows) {
      setLimits(m, rows);
    },

    setLaneClasses(rows) {
      setClasses(m, rows);
    },

    ...runOps(m),

    ...workOps(m),

    ...readOps(m),

    ...erasureOps(m),

    privacy,

    ...healthOps(m),
  };
}
