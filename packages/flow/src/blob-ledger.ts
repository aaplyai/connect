/**
 * The blob ledger: where erasure records the file references it released,
 * until the host has deleted their content (ADR-0008 §5).
 *
 * `eraseSubject` answers the references it released, and the store records
 * each erasure's releases here atomically with that erasure (`eraseRun`'s
 * `releases`), never ahead of it, so nothing a hold keeps is ever listed. A
 * release whose file a run stored in the scope still names is kept unlisted
 * until the last such run is erased (`RunStore.blobsInUse`; ADR-0008, amended
 * by the verification round). A host that loses the answer, or stops before
 * deleting, finds them here: it lists them, deletes the content from its file
 * store, and acknowledges them. The ledger keeps ids only (the blob's id in the host's store, the
 * erased run that released it, when), never a name or a digest: it outlives
 * the runs, and with a cipher everything else a run held was sealed under the
 * run's key that erasure destroyed.
 */

import type { Scope } from "./state.js";

/** One file reference an erasure released. */
export interface BlobRelease {
  /** The reference's `id`: the content's id in the host's file store. */
  blobId: string;
  /** The erased run that first recorded it; null when a person's workspaces did. */
  runId: string | null;
  /** When the erasure recorded it, on the runtime's clock (epoch milliseconds). */
  at: number;
}

/** One page of {@link BlobLedger.listReleases}. */
export interface BlobReleasePage {
  /** In blob id order (byte order). */
  releases: BlobRelease[];
  /** Pass as `after` for the next page; null when this was the last. */
  cursor: string | null;
}

/** Most releases one `listReleases` page holds. */
export const MAX_RELEASE_PAGE = 500;

/**
 * A store's blob ledger (`RunStore.blobs`, optional like `lanes`). Every call
 * is scoped: one scope never sees another's releases.
 */
export interface BlobLedger {
  /**
   * Records releases in `scope` directly. Idempotent: a blob id already
   * recorded (and not yet acknowledged) is kept as it was. Atomic: all are
   * recorded, or the call throws and none is. Erasure does not call it: the
   * store records an erasure's releases with the erasure (`EraseOptions`).
   */
  recordReleases(scope: Scope, releases: readonly BlobRelease[]): Promise<void>;
  /**
   * Releases not yet acknowledged whose erasure has completed and whose file
   * no run stored in the scope names, in blob id order, after `after`;
   * `limit` defaults to and is capped at {@link MAX_RELEASE_PAGE}. A release
   * held back by a run is listed by the first call after that run is erased.
   */
  listReleases(scope: Scope, options?: { after?: string; limit?: number }): Promise<BlobReleasePage>;
  /** Removes listed releases whose content the host deleted. Unknown ids are ignored. Answers how many it removed. */
  acknowledgeReleases(scope: Scope, blobIds: readonly string[]): Promise<number>;
}

/** The memory ledger, with the synchronous record the memory store makes in the same step as an erasure. */
export interface MemoryBlobLedger extends BlobLedger {
  /** `recordReleases`, at once: the memory store calls it with no await between its hold check, its delete and the record. */
  recordNow(scope: Scope, releases: readonly BlobRelease[]): void;
}

const scopeKey = (scope: Scope): string => JSON.stringify([scope.tenantId, scope.appId, scope.environmentId]);

/** Byte-order comparison of two strings (UTF-16 code units agree with it for the ids a store gives). */
const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Options of {@link createMemoryBlobLedger}. */
export interface MemoryBlobLedgerOptions {
  /**
   * The blob ids the runs stored in `scope` name now: their releases stay
   * unlisted. The memory store passes its own; without it every release of a
   * completed erasure is listed.
   */
  inUse?: (scope: Scope) => ReadonlySet<string>;
}

/** A {@link BlobLedger} in memory: the memory store's, and a reference for other stores. */
export function createMemoryBlobLedger(options: MemoryBlobLedgerOptions = {}): MemoryBlobLedger {
  const scopes = new Map<string, Map<string, BlobRelease>>();
  const inUse = options.inUse;
  const recordNow = (scope: Scope, releases: readonly BlobRelease[]): void => {
    const key = scopeKey(scope);
    let held = scopes.get(key);
    if (!held) scopes.set(key, (held = new Map()));
    for (const r of releases) if (!held.has(r.blobId)) held.set(r.blobId, { blobId: r.blobId, runId: r.runId, at: r.at });
  };
  return {
    recordNow,
    async recordReleases(scope, releases) {
      recordNow(scope, releases);
    },
    async listReleases(scope, options = {}) {
      const limit = Math.max(1, Math.min(Math.floor(options.limit ?? MAX_RELEASE_PAGE), MAX_RELEASE_PAGE)) || MAX_RELEASE_PAGE;
      const after = options.after;
      const named = inUse?.(scope);
      const all = [...(scopes.get(scopeKey(scope))?.values() ?? [])]
        .filter((r) => (after === undefined || byteOrder(r.blobId, after) > 0) && !named?.has(r.blobId))
        .sort((a, b) => byteOrder(a.blobId, b.blobId));
      const page = all.slice(0, limit).map((r) => ({ ...r }));
      return { releases: page, cursor: all.length > limit ? page[page.length - 1]!.blobId : null };
    },
    async acknowledgeReleases(scope, blobIds) {
      const held = scopes.get(scopeKey(scope));
      if (!held) return 0;
      let removed = 0;
      for (const id of blobIds) if (held.delete(id)) removed += 1;
      return removed;
    },
  };
}
