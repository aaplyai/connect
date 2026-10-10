/**
 * Behaviour every flow catalog with the memory catalog's management surface
 * must have: published versions are immutable, belong to one scope, are
 * listed by role, revoked by a migration role once and still loadable,
 * forced onto runs only with two different people's approval, and never
 * removed while a stored run uses them or a published version calls them.
 *
 * Framework-free: each case builds a fresh catalog and throws on failure, so
 * any test runner can run them:
 *
 *   for (const c of catalogConformance((env) => createMemoryCatalog({ inUse: env.inUse }))) it(c.name, c.run);
 */

import { e } from "../builder.js";
import type { CompiledFlow } from "../compile.js";
import type { FlowDefinition } from "../definition.js";
import type { FlowCatalog, MigrationPolicy, TrustedContext, VersionStatus } from "../ports.js";
import type { Scope } from "../state.js";

/**
 * The surface `catalogConformance` drives: a `FlowCatalog` with `status` and
 * the memory catalog's management calls. Each may answer a promise.
 */
export interface ManagedCatalog extends FlowCatalog {
  status(scope: Scope, flowId: string, version: string): Promise<VersionStatus | null>;
  /** Publishes a definition; the first publish of a version makes it current unless `makeCurrent` is false. */
  publish(scope: Scope, definition: unknown, options?: { makeCurrent?: boolean }): unknown;
  /** Points the flow's current version at a published version. */
  setCurrent(scope: Scope, flowId: string, version: string): unknown;
  revoke(ctx: TrustedContext, flowId: string, version: string, options: { then: "migrate" | "end"; message: string }): unknown;
  requestForcedMigration(ctx: TrustedContext, flowId: string, version: string, options?: { from?: string[]; message?: string }): unknown;
  approveForcedMigration(ctx: TrustedContext, flowId: string, version: string): unknown;
  /** Optional: removes a version nothing uses. A catalog without it passes the removal case unchecked. */
  remove?(ctx: TrustedContext, flowId: string, version: string): unknown;
}

/** What each case gives `makeCatalog`: the host's runs, as far as the removal guard asks about them. */
export interface CatalogConformanceEnv {
  /** Whether a stored run uses the version: wire the catalog's removal guard to it. */
  inUse(scope: Scope, flowId: string, version: string): boolean;
}

/** How `catalogConformance` reaches the catalog under test. */
export interface CatalogConformanceOptions {
  /** An app role the catalog lets force moves, revoke and remove versions. Default `flow-admin`. */
  migrationRole?: string;
  /**
   * Makes a stored run use a version, for the removal case. Default: marks
   * it in the case's `CatalogConformanceEnv`. A catalog that asks its own run
   * table instead creates such a run here.
   */
  useVersion?: (scope: Scope, flowId: string, version: string) => void | Promise<void>;
}

/** One case: a name and a check that throws on failure. */
export interface CatalogConformanceCase {
  name: string;
  run: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`catalog conformance: ${message}`);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`catalog conformance: ${message}\n  expected ${b}\n  got      ${a}`);
}

/** Passes when `act` throws or rejects. */
async function refused(act: () => unknown, message: string): Promise<void> {
  try {
    await act();
  } catch {
    return;
  }
  throw new Error(`catalog conformance: ${message}`);
}

const SCOPE: Scope = { tenantId: "t-conformance", appId: "a-1", environmentId: "e-1" };
const OTHER: Scope = { tenantId: "t-other", appId: "a-1", environmentId: "e-1" };

/** A small flow anybody may start: one step, one fact. */
function flow(id: string, version: string, extra: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    schemaVersion: 3,
    id,
    version,
    title: `Flow ${id}`,
    goal: { description: `Do ${id}` },
    facts: { answer: { type: { type: "string" }, sensitivity: "none" } },
    steps: [{ id: "ask", view: { section: "form@1" }, on: { submit: { set: { answer: e.payload("answer") } } } }],
    completeWhen: e.known("answer"),
    ...extra,
  };
}

/** A flow only other flows may call, answering `answer`. */
function callee(id: string, version: string): FlowDefinition {
  return flow(id, version, { interface: { input: [], output: ["answer"], callableOnly: true } });
}

/** A flow whose one step calls `target` (`id@version`). */
function caller(id: string, version: string, target: string): FlowDefinition {
  return flow(id, version, { steps: [{ id: "call", call: { flow: target, input: {} }, on: { completed: { set: { answer: e.payload("answer") } } } }] });
}

/** A later version that accepts runs from `from`. */
function later(id: string, version: string, from: string): FlowDefinition {
  return flow(id, version, { title: `Flow ${id}, version ${version}`, migrations: [{ from }] });
}

function context(scope: Scope, kind: "visitor" | "member", id: string, appRoles: string[]): TrustedContext {
  return {
    scope,
    environmentKind: "production",
    actor: { domain: kind, kind, id },
    appRoles,
    locale: "en-GB",
    timezone: "Europe/London",
    requestId: `conformance-${id}`,
  };
}

const sorted = (entries: Array<{ flowId: string; version: string }>) => entries.map((x) => `${x.flowId}@${x.version}`).sort();

/** The policy's mode, or a description of a missing status. */
const modeOf = (status: VersionStatus | null): MigrationPolicy["mode"] | "missing" => status?.policy.mode ?? "missing";

/**
 * The cases every catalog with the management surface must pass.
 * `makeCatalog` builds a fresh, empty catalog for each case; the case's
 * `env.inUse` stands for the host's runs, which the removal guard asks.
 */
export function catalogConformance(makeCatalog: (env: CatalogConformanceEnv) => ManagedCatalog | Promise<ManagedCatalog>, options: CatalogConformanceOptions = {}): CatalogConformanceCase[] {
  const role = options.migrationRole ?? "flow-admin";
  const ann = context(SCOPE, "member", "ann", [role]);
  const bob = context(SCOPE, "member", "bob", [role]);
  const carol = context(SCOPE, "member", "carol", ["sales"]);
  const visitor = context(SCOPE, "visitor", "v-1", [role]);

  /** A fresh catalog and its runs. */
  async function setup(): Promise<{ catalog: ManagedCatalog; use: (scope: Scope, flowId: string, version: string) => Promise<void> }> {
    const used = new Set<string>();
    const k = (scope: Scope, flowId: string, version: string) => JSON.stringify([scope.tenantId, scope.appId, scope.environmentId, flowId, version]);
    const catalog = await makeCatalog({ inUse: (scope, flowId, version) => used.has(k(scope, flowId, version)) });
    const use = async (scope: Scope, flowId: string, version: string) => {
      if (options.useVersion) await options.useVersion(scope, flowId, version);
      else used.add(k(scope, flowId, version));
    };
    return { catalog, use };
  }

  const hashOf = async (catalog: ManagedCatalog, scope: Scope, flowId: string, version?: string): Promise<string | null> => (await catalog.get(scope, flowId, version))?.hash ?? null;

  return [
    {
      name: "a published version reads back as published, whatever happens to the definition it was given",
      async run() {
        const { catalog } = await setup();
        const definition = flow("intake", "1");
        await catalog.publish(SCOPE, definition);
        const published = (await catalog.get(SCOPE, "intake", "1")) as CompiledFlow | null;
        assert(published, "a published version is not returned by get");
        eq([published.id, published.version, published.definition.title], ["intake", "1", "Flow intake"], "get returns another flow");
        eq(await hashOf(catalog, SCOPE, "intake"), published.hash, "the first publish of a flow is not its current version");
        definition.title = "Changed after publishing";
        definition.steps.length = 0;
        const again = await catalog.get(SCOPE, "intake", "1");
        eq([again?.hash, again?.definition.title], [published.hash, "Flow intake"], "changing the published definition object changed the version");
      },
    },
    {
      name: "a version is never replaced: other content under a published version is refused, the same content changes nothing",
      async run() {
        const { catalog } = await setup();
        await catalog.publish(SCOPE, flow("intake", "1"));
        const first = await hashOf(catalog, SCOPE, "intake", "1");
        await refused(() => catalog.publish(SCOPE, flow("intake", "1", { title: "Something else" })), "other content was published under an existing version");
        eq(await hashOf(catalog, SCOPE, "intake", "1"), first, "a refused publish changed the version");
        await catalog.publish(SCOPE, later("intake", "2", "1"));
        await catalog.publish(SCOPE, flow("intake", "1"));
        eq(await hashOf(catalog, SCOPE, "intake", "1"), first, "publishing the same content again changed the version");
        eq((await catalog.get(SCOPE, "intake"))?.version, "2", "publishing an older version again moved the current version back");
        const statuses = await catalog.versions?.(SCOPE, "intake");
        if (statuses) eq(statuses.map((s) => [s.version, s.current]), [["1", false], ["2", true]], "versions does not list each version once, oldest first, with the current one");
      },
    },
    {
      name: "versions belong to one scope: another tenant reads, lists and finds nothing",
      async run() {
        const { catalog } = await setup();
        await catalog.publish(SCOPE, flow("intake", "1"));
        eq(await hashOf(catalog, OTHER, "intake", "1"), null, "another scope reads the version");
        eq(await hashOf(catalog, OTHER, "intake"), null, "another scope reads the current version");
        eq(sorted(await catalog.list(OTHER, { appRoles: [role] })), [], "another scope lists the flow");
        eq(await catalog.status(OTHER, "intake", "1"), null, "another scope reads the version's status");
        eq((await catalog.versions?.(OTHER, "intake")) ?? [], [], "another scope lists the flow's versions");
      },
    },
    {
      name: "list offers each flow's current version, role-gated flows only to their roles, and never a flow only other flows may call",
      async run() {
        const { catalog } = await setup();
        await catalog.publish(SCOPE, flow("intake", "1"));
        await catalog.publish(SCOPE, flow("refund", "1", { startRoles: ["desk"] }));
        await catalog.publish(SCOPE, flow("otp", "1", { interface: { input: [], output: ["answer"], callableOnly: true } }));
        eq(sorted(await catalog.list(SCOPE)), ["intake@1"], "without a viewer, list offers more than the flows anybody may start");
        eq(sorted(await catalog.list(SCOPE, { appRoles: [] })), ["intake@1"], "a visitor is offered a role-gated or callable-only flow");
        eq(sorted(await catalog.list(SCOPE, { appRoles: ["sales"] })), ["intake@1"], "a viewer without the flow's role is offered it");
        eq(sorted(await catalog.list(SCOPE, { appRoles: ["sales", "desk"] })), ["intake@1", "refund@1"], "a viewer holding the flow's role is not offered it, or is offered a callable-only flow");
        await catalog.publish(SCOPE, later("intake", "2", "1"));
        eq(sorted(await catalog.list(SCOPE, { appRoles: [] })), ["intake@2"], "list does not offer the new current version");
        await catalog.setCurrent(SCOPE, "intake", "1");
        eq(sorted(await catalog.list(SCOPE, { appRoles: [] })), ["intake@1"], "list does not follow setCurrent");
        eq((await catalog.status(SCOPE, "intake", "1"))?.current, true, "status does not follow setCurrent");
      },
    },
    {
      name: "revoking a version needs a migration role, keeps it loadable, stops offering it, and happens once",
      async run() {
        const { catalog } = await setup();
        await catalog.publish(SCOPE, flow("intake", "1"));
        const hash = await hashOf(catalog, SCOPE, "intake", "1");
        await refused(() => catalog.revoke(visitor, "intake", "1", { then: "end", message: "Withdrawn." }), "a visitor revoked a version (whatever roles the context claims)");
        await refused(() => catalog.revoke(carol, "intake", "1", { then: "end", message: "Withdrawn." }), "a member without a migration role revoked a version");
        eq((await catalog.status(SCOPE, "intake", "1"))?.revoked ?? null, null, "a refused revocation was recorded");
        await catalog.revoke(ann, "intake", "1", { then: "end", message: "Withdrawn." });
        const revoked = (await catalog.status(SCOPE, "intake", "1"))?.revoked;
        assert(revoked, "status does not say the version is revoked");
        eq([revoked.by, revoked.then, revoked.message, typeof revoked.at], ["member:ann", "end", "Withdrawn.", "number"], "the revocation does not say who revoked it (domain:id from their context), how and why");
        eq(await hashOf(catalog, SCOPE, "intake", "1"), hash, "a revoked version no longer loads: its runs could not continue or end");
        eq(sorted(await catalog.list(SCOPE, { appRoles: [role] })), [], "a revoked version is still offered");
        await catalog.revoke(bob, "intake", "1", { then: "migrate", message: "Another reason." });
        eq((await catalog.status(SCOPE, "intake", "1"))?.revoked, revoked, "revoking a revoked version changed its revocation");
        await refused(() => catalog.revoke(ann, "intake", "9", { then: "end", message: "Withdrawn." }), "a version that was never published was revoked");
      },
    },
    {
      name: "a forced move needs a request and a second person's approval, both holding a migration role",
      async run() {
        const { catalog } = await setup();
        await catalog.publish(SCOPE, flow("intake", "1"));
        await catalog.publish(SCOPE, later("intake", "2", "1"));
        const forced = async () => modeOf(await catalog.status(SCOPE, "intake", "2"));
        await refused(() => catalog.approveForcedMigration(bob, "intake", "2"), "a move nobody asked for was approved");
        await refused(() => catalog.requestForcedMigration(visitor, "intake", "2"), "a visitor asked to force a move (whatever roles the context claims)");
        await refused(() => catalog.requestForcedMigration(carol, "intake", "2"), "a member without a migration role asked to force a move");
        await refused(() => catalog.requestForcedMigration(ann, "intake", "1"), "a move was asked for onto a version that accepts runs from no other");
        await catalog.requestForcedMigration(ann, "intake", "2", { from: ["1"], message: "Fixes the address step." });
        eq(await forced(), "pinned", "asking for a forced move forced it");
        await refused(() => catalog.approveForcedMigration(ann, "intake", "2"), "the person who asked approved their own request");
        await refused(() => catalog.approveForcedMigration(carol, "intake", "2"), "a member without a migration role approved a forced move");
        eq(await forced(), "pinned", "a refused approval forced the move");
        await catalog.approveForcedMigration(bob, "intake", "2");
        const policy = (await catalog.status(SCOPE, "intake", "2"))?.policy;
        assert(policy?.mode === "forced", `a second person's approval did not force the move (policy ${JSON.stringify(policy)})`);
        eq([policy.approval.requestedBy, policy.approval.approvedBy, typeof policy.approval.approvedAt, policy.from, policy.message], ["member:ann", "member:bob", "number", ["1"], "Fixes the address step."], "the forced policy does not record both people (domain:id from their contexts) and the request");
        await refused(() => catalog.approveForcedMigration(ann, "intake", "2"), "a request was approved twice");
      },
    },
    {
      name: "a version a stored run uses, or the current version, cannot be removed, and a removed version's id is never reused nor made current again",
      async run() {
        const { catalog, use } = await setup();
        const remove = catalog.remove?.bind(catalog);
        if (!remove) return;
        await catalog.publish(SCOPE, flow("intake", "1"));
        await catalog.publish(SCOPE, later("intake", "2", "1"));
        await catalog.publish(SCOPE, later("intake", "3", "2"), { makeCurrent: false });
        await use(SCOPE, "intake", "1");
        const hashes = await Promise.all(["1", "2", "3"].map((v) => hashOf(catalog, SCOPE, "intake", v)));
        await refused(() => remove(carol, "intake", "3"), "a member without a migration role removed a version");
        await refused(() => remove(ann, "intake", "1"), "a version a stored run uses was removed");
        await refused(() => remove(ann, "intake", "2"), "the current version was removed");
        await refused(() => remove(context(OTHER, "member", "ann", [role]), "intake", "3"), "another scope removed a version it does not have");
        eq(await Promise.all(["1", "2", "3"].map((v) => hashOf(catalog, SCOPE, "intake", v))), hashes, "a refused removal removed something");
        await remove(ann, "intake", "3");
        eq(await hashOf(catalog, SCOPE, "intake", "3"), null, "a removed version still loads");
        eq(await catalog.status(SCOPE, "intake", "3"), null, "a removed version still has a status");
        eq((await catalog.get(SCOPE, "intake"))?.version, "2", "removing a version moved the current version");
        await refused(() => catalog.publish(SCOPE, flow("intake", "3", { title: "Other content" })), "a removed version's id was reused for other content");
        // Publishing the removed version again may be refused, or restore it; either way the current version stays.
        await Promise.resolve()
          .then(() => catalog.publish(SCOPE, later("intake", "3", "2")))
          .catch(() => undefined);
        eq((await catalog.get(SCOPE, "intake"))?.version, "2", "publishing a removed version again made it current");
      },
    },
    {
      name: "a version a published version calls cannot be removed while that version is published",
      async run() {
        const { catalog } = await setup();
        const remove = catalog.remove?.bind(catalog);
        if (!remove) return;
        await catalog.publish(SCOPE, callee("otp", "1"));
        await catalog.publish(SCOPE, callee("otp", "2"));
        await catalog.publish(SCOPE, caller("intake", "1", "otp@1"));
        const pinned = await hashOf(catalog, SCOPE, "otp", "1");
        await refused(() => remove(ann, "otp", "1"), "a version a published version calls was removed: the caller's runs could not call it");
        eq(await hashOf(catalog, SCOPE, "otp", "1"), pinned, "a refused removal removed the called version");
        // Once its caller is gone, nothing published calls it.
        await catalog.publish(SCOPE, caller("intake", "2", "otp@2"));
        await remove(ann, "intake", "1");
        await remove(ann, "otp", "1");
        eq(await hashOf(catalog, SCOPE, "otp", "1"), null, "a version nothing calls or uses any more was not removed");
      },
    },
  ];
}
