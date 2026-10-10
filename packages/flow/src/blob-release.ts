/**
 * What an erasure releases (ADR-0008 §5, amended with ADR-0010 and by the
 * verification round): the file references a run (its state and every event,
 * archived ones included) and a person's workspaces hold, read before
 * anything is erased and handed to each erasure as its `releases`, which a
 * store with a blob ledger records atomically with that erasure
 * (`EraseOptions`). Nothing is recorded ahead of an erasure, so nothing has
 * to be taken back when a hold stops one or a store fails part way.
 *
 * Who else still names a file is the store's to say, when its ledger is
 * read: it lists a release only once no run stored in the scope names the
 * file (`RunStore.blobsInUse`), whoever started that run, a person, another
 * person or a workload, and whether it is a call's child or kept by a hold.
 * So every erasure records all its run held, except what the person's own
 * workspaces hold (those go with the workspaces), two erasures at once cannot
 * strand a file, and the ledger never lists one a run still names. A store
 * that cannot say is given no releases (fail closed). The runtime answers as
 * `released` only those no stored run names once its erasures are done; the
 * ledger lists the others when their last run goes.
 */

import type { BlobRef } from "@aaply/action-contract";
import { heldBlobRefs, readScope } from "./blob-guard.js";
import type { BlobRelease } from "./blob-ledger.js";
import { FlowError } from "./errors.js";
import { isErasureHeld } from "./privacy.js";
import { isTerminal, type Scope } from "./state.js";
import type { RunStore } from "./store.js";

/** Events read per page while reading what a run holds. */
const EVENT_PAGE = 500;
/** Blob ids asked per `blobsInUse` call. */
const IN_USE_PAGE = 500;

/** What runs and a person's workspaces hold, each read at most once (an erasure's snapshot). */
export interface Holdings {
  /**
   * The references bound to the scope that a run holds, in its state and
   * every event, by id. None for a run that does not load: one gone, or one
   * an interrupted erasure marked `erasing` (its key may be gone, so it is
   * never read; its releases were recorded by the attempt that marked it).
   */
  run(runId: string): Promise<ReadonlyMap<string, BlobRef>>;
  /** The references `owner`'s workspaces hold, by id. */
  workspaces(owner: string): Promise<ReadonlyMap<string, BlobRef>>;
}

/**
 * Reads holdings from `store` in `scope` as they are asked for, and remembers
 * them. Every reference is checked against a plain copy of the scope
 * (`readScope`); a scope that cannot be read throws `invalid` here, before
 * anything is erased, rather than let an erasure release nothing.
 */
export function readHoldings(store: RunStore, scope: Scope): Holdings {
  const bound = boundScope(scope);
  const runs = new Map<string, Promise<ReadonlyMap<string, BlobRef>>>();
  const owners = new Map<string, Promise<ReadonlyMap<string, BlobRef>>>();
  const readRun = async (runId: string): Promise<ReadonlyMap<string, BlobRef>> => {
    const held = new Map<string, BlobRef>();
    const state = await store.loadRun(scope, runId);
    if (state === null) return held;
    heldBlobRefs(state, bound, held);
    for (let afterSeq = 0; ; ) {
      const page = await store.listEvents(scope, runId, { afterSeq, limit: EVENT_PAGE });
      for (const stored of page) heldBlobRefs(stored.event, bound, held);
      if (page.length < EVENT_PAGE) break;
      afterSeq = page[page.length - 1]!.seq;
    }
    return held;
  };
  const readOwner = async (owner: string): Promise<ReadonlyMap<string, BlobRef>> => {
    const held = new Map<string, BlobRef>();
    for (const ws of await store.listWorkspacesByOwner(scope, owner)) heldBlobRefs(ws, bound, held);
    return held;
  };
  // A failed read is not remembered: the erasure throws, and a retry reads again.
  const cached = (cache: Map<string, Promise<ReadonlyMap<string, BlobRef>>>, key: string, read: (key: string) => Promise<ReadonlyMap<string, BlobRef>>) => {
    let found = cache.get(key);
    if (!found) {
      found = read(key);
      cache.set(key, found);
      found.catch(() => cache.delete(key));
    }
    return found;
  };
  return {
    run: (runId) => cached(runs, runId, readRun),
    workspaces: (owner) => cached(owners, owner, readOwner),
  };
}

/**
 * The references of `held` an erasure records as released: none when the
 * store cannot say which files its runs name (`blobsInUse`, fail closed), and
 * otherwise all but those `owner`'s workspaces hold while they stand (null:
 * none to keep). In the order `held` lists them.
 */
export async function releasesOf(store: RunStore, holdings: Holdings, held: ReadonlyMap<string, BlobRef>, owner: string | null): Promise<BlobRef[]> {
  if (held.size === 0 || typeof store.blobsInUse !== "function") return [];
  if (owner === null) return [...held.values()];
  const kept = await holdings.workspaces(owner);
  return [...held.values()].filter((ref) => !kept.has(ref.id));
}

/**
 * The references of `recorded` (released by completed erasures) that no run
 * stored in `scope` names now, unique by id, in the order given: the content
 * the host may delete at once. The ledger lists the rest when their last run
 * is erased. Throws when the store does.
 */
export async function freedOf(store: RunStore, scope: Scope, recorded: Iterable<BlobRef>): Promise<BlobRef[]> {
  const unique = new Map<string, BlobRef>();
  for (const ref of recorded) if (!unique.has(ref.id)) unique.set(ref.id, ref);
  if (unique.size === 0 || typeof store.blobsInUse !== "function") return [];
  const named = new Set<string>();
  const ids = [...unique.keys()];
  for (let i = 0; i < ids.length; i += IN_USE_PAGE) for (const id of await store.blobsInUse(scope, ids.slice(i, i + IN_USE_PAGE))) named.add(id);
  return [...unique.values()].filter((ref) => !named.has(ref.id));
}

/** A plain copy of `scope`, or `invalid` when it cannot be read: a reference is never checked against what is not a scope. */
function boundScope(scope: Scope): Scope {
  const bound = readScope(scope);
  if (bound === null) throw new FlowError("invalid", "Invalid scope: it cannot be read, so nothing is erased.");
  return bound;
}

/** References as the ledger records them: ids only, with the erased run (null for workspaces) and the time. */
export function asReleases(refs: readonly BlobRef[], runId: string | null, at: number): BlobRelease[] {
  return refs.map((ref) => ({ blobId: ref.id, runId, at }));
}

/** What {@link eraseEndedRuns} did. */
export interface EndedRunsErasure {
  /** Runs erased (or found gone already), in the order given. */
  erased: string[];
  /** Runs a legal hold kept, with the ids of the holds: nothing of them was changed or released. */
  held: Array<{ runId: string; holds: string[] }>;
  /** Runs not ended (`active` or `cancelling`): left alone, since erasing one would orphan what it holds at a service. */
  live: string[];
  /**
   * The references the erased runs released that no stored run names any
   * more, unique by id: their content may go, by the host's rule (a vouch it
   * answered meanwhile may still name one: stop vouching, wait for those
   * requests, ask `blobsInUse`; docs/runtime.md, Files). The store's blob
   * ledger recorded each with its run's erasure, and lists one another run
   * still names once that run is erased too.
   */
  released: BlobRef[];
}

/**
 * Erases stored runs that ended, for a retention job (ADR-0008, ADR-0010):
 * one at a time through `store.eraseRun`, each with the file references its
 * run held, which a store with a blob ledger records atomically with that
 * run's erasure, and lists once no stored run names them (another run of the
 * person, of another person or of a workload, or a call's child kept by a
 * hold). A reference one of the person's workspaces holds is held back: the
 * workspaces' erasure releases it. A run a legal hold covers is refused by
 * the store, changes nothing and releases nothing; a run that has not ended
 * is left alone. A store without `blobsInUse` is given no releases. Reads
 * every event of each run it erases, archived ones included. Throws
 * `invalid` for a scope that cannot be read, before anything is erased, and
 * throws when the store does; a retry erases what is left.
 */
export async function eraseEndedRuns(store: RunStore, given: Scope, runIds: readonly string[], options: { now?: number } = {}): Promise<EndedRunsErasure> {
  const scope = boundScope(given);
  const now = options.now ?? Date.now();
  const holdings = readHoldings(store, scope);
  const out: EndedRunsErasure = { erased: [], held: [], live: [], released: [] };
  const recorded: BlobRef[] = [];
  for (const runId of new Set(runIds)) {
    const state = await store.loadRun(scope, runId);
    if (state !== null && !isTerminal(state.status)) {
      out.live.push(runId);
      continue;
    }
    // A run that does not load is gone or being erased: completing it releases nothing more.
    const refs = await releasesOf(store, holdings, await holdings.run(runId), state?.subject?.id ?? null);
    const outcome = await store.eraseRun(scope, runId, { now, releases: asReleases(refs, runId, now) });
    if (isErasureHeld(outcome)) {
      out.held.push({ runId, holds: outcome.holds.map((h) => h.id) });
      continue;
    }
    out.erased.push(runId);
    recorded.push(...refs);
  }
  out.released = await freedOf(store, scope, recorded);
  return out;
}
