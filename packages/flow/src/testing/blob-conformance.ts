/**
 * Behaviour every store's blob ledger (`RunStore.blobs`, ADR-0008) must have.
 * Framework-free, like `storeConformanceCases`:
 *
 *   for (const c of blobLedgerConformanceCases(() => makeStore())) it(c.name, c.run);
 */

import { makeBlobRef, type BlobRef } from "@aaply/action-contract";
import { MAX_RELEASE_PAGE, type BlobLedger, type BlobRelease } from "../blob-ledger.js";
import type { FlowEvent, RunState, Scope } from "../state.js";
import type { RunStore } from "../store.js";
import { isErasureHeld } from "../privacy.js";
import { conformanceRunState, conformanceWorkspace, type ConformanceCase } from "./conformance.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`blob ledger conformance: ${message}`);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`blob ledger conformance: ${message}\n  expected ${b}\n  got      ${a}`);
}

const SCOPE: Scope = { tenantId: "t-blob-1", appId: "a-1", environmentId: "e-1" };
const OTHER: Scope = { tenantId: "t-blob-2", appId: "a-1", environmentId: "e-1" };

const release = (blobId: string, runId: string | null = "run-1", at = 1_000): BlobRelease => ({ blobId, runId, at });

/** A reference to `id` bound to `scope`. */
const fileRef = (id: string, scope: Scope = SCOPE): BlobRef => makeBlobRef(scope, { id, digest: `sha256:${"0".repeat(64)}`, size: 1, mediaType: "text/plain" });

/** A run of `scope` whose state holds `refs` as facts. */
function runNaming(runId: string, revision: number, refs: Record<string, BlobRef>, scope: Scope = SCOPE): RunState {
  const state = conformanceRunState(runId, revision, scope, "visitor:s-1");
  for (const [name, ref] of Object.entries(refs)) state.facts[name] = { status: "valid", value: ref as never, rev: revision };
  return state;
}

async function all(ledger: BlobLedger, scope: Scope, limit?: number): Promise<BlobRelease[]> {
  const out: BlobRelease[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page = await ledger.listReleases(scope, { ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) });
    out.push(...page.releases);
    if (page.cursor === null) return out;
    after = page.cursor;
  }
  throw new Error("blob ledger conformance: listReleases never ended");
}

/** The cases a store with a blob ledger passes. `makeStore` gives a fresh, empty store each time. */
export function blobLedgerConformanceCases(makeStore: () => RunStore | Promise<RunStore>): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const it = (name: string, run: (ledger: BlobLedger, store: RunStore) => Promise<void>) =>
    cases.push({
      name,
      run: async () => {
        const store = await makeStore();
        assert(store.blobs, "the store has no blob ledger (RunStore.blobs)");
        await run(store.blobs, store);
      },
    });

  it("records releases and lists them in blob id order, page by page", async (ledger) => {
    await ledger.recordReleases(SCOPE, [release("blob-c"), release("blob-a", null, 2_000), release("blob-b", "run-2")]);
    eq(await ledger.listReleases(SCOPE), { releases: [release("blob-a", null, 2_000), release("blob-b", "run-2"), release("blob-c")], cursor: null }, "one page");
    const first = await ledger.listReleases(SCOPE, { limit: 2 });
    eq(first.releases.map((r) => r.blobId), ["blob-a", "blob-b"], "first page");
    assert(first.cursor !== null, "a cursor after a full page that is not the last");
    eq(await ledger.listReleases(SCOPE, { after: first.cursor, limit: 2 }), { releases: [release("blob-c")], cursor: null }, "last page");
    eq(await ledger.listReleases(SCOPE, { after: "blob-c" }), { releases: [], cursor: null }, "nothing after the last");
  });

  it("caps a page and walks a long ledger to its end", async (ledger) => {
    const many = Array.from({ length: MAX_RELEASE_PAGE + 20 }, (_, i) => release(`blob-${String(i).padStart(5, "0")}`));
    await ledger.recordReleases(SCOPE, many);
    const page = await ledger.listReleases(SCOPE, { limit: MAX_RELEASE_PAGE * 10 });
    eq(page.releases.length, MAX_RELEASE_PAGE, "a page is capped");
    eq((await all(ledger, SCOPE)).map((r) => r.blobId), many.map((r) => r.blobId), "every release, once, in order");
  });

  it("keeps the first record of a blob id: recording again changes nothing", async (ledger) => {
    await ledger.recordReleases(SCOPE, [release("blob-1", "run-1", 1_000)]);
    await ledger.recordReleases(SCOPE, [release("blob-1", "run-9", 9_000), release("blob-2", "run-2", 2_000)]);
    eq(await all(ledger, SCOPE), [release("blob-1", "run-1", 1_000), release("blob-2", "run-2", 2_000)], "first kept");
    await ledger.recordReleases(SCOPE, []);
    eq((await all(ledger, SCOPE)).length, 2, "an empty record changes nothing");
  });

  it("acknowledges what the host deleted, and ignores ids it does not hold", async (ledger) => {
    await ledger.recordReleases(SCOPE, [release("blob-1"), release("blob-2"), release("blob-3")]);
    eq(await ledger.acknowledgeReleases(SCOPE, ["blob-1", "blob-3", "blob-404"]), 2, "two removed");
    eq((await all(ledger, SCOPE)).map((r) => r.blobId), ["blob-2"], "one left");
    eq(await ledger.acknowledgeReleases(SCOPE, ["blob-1"]), 0, "already acknowledged");
    eq(await ledger.acknowledgeReleases(SCOPE, []), 0, "nothing to acknowledge");
  });

  it("keeps each scope's releases to that scope", async (ledger) => {
    await ledger.recordReleases(SCOPE, [release("blob-1")]);
    await ledger.recordReleases(OTHER, [release("blob-1", "run-other"), release("blob-2", "run-other")]);
    eq(await all(ledger, SCOPE), [release("blob-1")], "own scope");
    eq(await ledger.acknowledgeReleases(OTHER, ["blob-1"]), 1, "acknowledged in the other scope");
    eq(await all(ledger, SCOPE), [release("blob-1")], "untouched by the other scope's acknowledgement");
    eq(await all(ledger, OTHER), [release("blob-2", "run-other")], "the other scope's");
  });

  it("outlives the erased runs it names", async (ledger, store) => {
    await ledger.recordReleases(SCOPE, [release("blob-1", "run-gone")]);
    await store.eraseRun(SCOPE, "run-gone");
    await store.eraseWorkspaces(SCOPE, "visitor:s-1");
    eq(await all(ledger, SCOPE), [release("blob-1", "run-gone")], "still listed");
  });

  it("records an erasure's releases with the erasure, and nothing of one a hold refuses", async (ledger, store) => {
    const person = "visitor:s-1";
    await store.commit({
      scope: SCOPE,
      runs: ["run-1", "run-2"].map((runId) => ({ runId, expectedRevision: 0, state: conformanceRunState(runId, 1, SCOPE, person), events: [] })),
    });
    await store.commit({ scope: SCOPE, runs: [], workspace: { state: conformanceWorkspace("ws-1", 1, person, SCOPE), expectedRevision: 0 } });
    await store.eraseRun(SCOPE, "run-1", { now: 20, releases: [release("blob-1", "run-1", 20)] });
    eq(await all(ledger, SCOPE), [release("blob-1", "run-1", 20)], "recorded with the run's erasure");
    const holds = store.privacy;
    if (holds) {
      await holds.placeHold(SCOPE, { id: "h-person", target: { kind: "subject", subjectId: person }, reason: "audit", by: "staff:legal-1", at: 25 });
      assert(isErasureHeld(await store.eraseRun(SCOPE, "run-2", { now: 30, releases: [release("blob-2", "run-2", 30)] })), "a hold refuses the run's erasure");
      assert(isErasureHeld(await store.eraseWorkspaces(SCOPE, person, { now: 30, releases: [release("blob-ws", null, 30)] })), "and the workspaces'");
      eq((await all(ledger, SCOPE)).map((r) => r.blobId), ["blob-1"], "nothing a refused erasure was given is recorded");
      await holds.releaseHold(SCOPE, "h-person", { by: "staff:legal-2", at: 35 });
    }
    await store.eraseRun(SCOPE, "run-2", { now: 40, releases: [release("blob-2", "run-2", 40)] });
    await store.eraseWorkspaces(SCOPE, person, { now: 40, releases: [release("blob-ws", null, 40)] });
    eq((await all(ledger, SCOPE)).map((r) => r.blobId), ["blob-1", "blob-2", "blob-ws"], "recorded once erased");
    eq(await store.loadRun(SCOPE, "run-2"), null, "the run is gone");
    eq(await store.listWorkspacesByOwner(SCOPE, person), [], "and the workspaces");
  });

  it("lists a release only once no stored run names its file, and says which files runs name", async (ledger, store) => {
    // ADR-0008, amended by the verification round: a call's child, another person's run or a workload's may name the file still.
    assert(typeof store.blobsInUse === "function", "a store with a blob ledger says which files its runs name (RunStore.blobsInUse)");
    const named = async (ids: string[], scope: Scope = SCOPE) => [...(await store.blobsInUse!(scope, ids))].sort();
    // run-1 names blob-1 in its state; run-2 names blob-1 and blob-2 in an event; run-o names blob-1 in another scope.
    await store.commit({ scope: SCOPE, runs: [{ runId: "run-1", expectedRevision: 0, state: runNaming("run-1", 1, { file: fileRef("blob-1"), foreign: fileRef("blob-foreign", OTHER) }), events: [] }] });
    const event = { type: "facts.input", at: 2, facts: { file: fileRef("blob-1"), more: [fileRef("blob-2")] } } as unknown as FlowEvent;
    await store.commit({ scope: SCOPE, runs: [{ runId: "run-2", expectedRevision: 0, state: conformanceRunState("run-2", 1, SCOPE), events: [event] }] });
    await store.commit({ scope: OTHER, runs: [{ runId: "run-o", expectedRevision: 0, state: runNaming("run-o", 1, { file: fileRef("blob-1", OTHER) }, OTHER), events: [] }] });
    // A commit that loses its revision check names nothing.
    const lost = await store.commit({ scope: SCOPE, runs: [{ runId: "run-1", expectedRevision: 5, state: runNaming("run-1", 6, { file: fileRef("blob-lost") }), events: [] }] });
    assert(!lost.ok, "a stale commit conflicts");
    eq(await named(["blob-1", "blob-2", "blob-2", "blob-foreign", "blob-lost", "blob-none"]), ["blob-1", "blob-2"], "the files the scope's runs name, once each");
    eq(await named(["blob-2"], OTHER), [], "not another scope's");
    // A later revision of run-2 that no longer holds blob-2 in its state still names it through its event.
    await store.commit({ scope: SCOPE, runs: [{ runId: "run-2", expectedRevision: 1, state: conformanceRunState("run-2", 2, SCOPE), events: [] }] });

    await store.eraseRun(SCOPE, "run-1", { now: 10, releases: [release("blob-1", "run-1", 10), release("blob-9", "run-1", 10)] });
    eq((await all(ledger, SCOPE)).map((r) => r.blobId), ["blob-9"], "blob-1 is held back while run-2 names it");
    eq(await ledger.acknowledgeReleases(SCOPE, ["blob-9"]), 1, "the free one acknowledged");
    eq(await named(["blob-1"]), ["blob-1"], "run-2 still names blob-1");
    await store.eraseRun(SCOPE, "run-2", { now: 20, releases: [release("blob-1", "run-2", 20), release("blob-2", "run-2", 20)] });
    eq(await all(ledger, SCOPE), [release("blob-1", "run-1", 10), release("blob-2", "run-2", 20)], "listed once the last run naming them is gone, as first recorded");
    eq(await named(["blob-1", "blob-2"]), [], "no run names them now");
    eq(await named(["blob-1"], OTHER), ["blob-1"], "the other scope's run still names its own");
  });

  it("takes any id a reference may carry (printable ASCII), in byte order", async (ledger) => {
    const ids = ["blob_~x", "Blob/2026:01", "b.1", "Z", "a%2F!"];
    await ledger.recordReleases(SCOPE, ids.map((id) => release(id)));
    eq((await all(ledger, SCOPE, 2)).map((r) => r.blobId), ["Blob/2026:01", "Z", "a%2F!", "b.1", "blob_~x"], "byte order, not locale order");
  });

  return cases;
}
