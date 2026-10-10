/**
 * An in-memory flow catalog: publish validated, immutable flow versions per
 * app and environment, with one current version per flow. Hosts with their
 * own manifest storage implement `FlowCatalog` directly.
 *
 * It also keeps what the host decides about live runs, per version: the
 * migration policy and revocation. A forced move needs two different people,
 * each identified only by their own `TrustedContext`: one asks
 * (`requestForcedMigration`), another approves (`approveForcedMigration`).
 *
 * A version is removed only when nothing uses it (`remove`): no published
 * version calls it, and no stored run needs it. The catalog cannot see runs,
 * so the host says which versions its runs are on (`inUse`,
 * `storedRunsUse(store)`).
 */

import { checkFlowCalls } from "./calls.js";
import { compileFlow, mustCompileFlow, VERSION_RE, type CompiledFlow } from "./compile.js";
import { DiagnosticsError, type Diagnostic } from "./diagnostics.js";
import { MAX_UPDATE_MESSAGE } from "./core.js";
import { mayStart } from "./goals.js";
import { expandFlow, mustExpand, type PublishSourceOptions } from "./include.js";
import { checkMigration } from "./migrate.js";
import { withHints } from "./hints.js";
import { systemClock, type Clock, type FlowCatalog, type MigrationPolicy, type Revocation, type TrustedContext, type VersionStatus } from "./ports.js";
import { FlowError } from "./runtime.js";
import { checkContext } from "./runtime/helpers.js";
import type { Scope } from "./state.js";
import { scopeKey, type RunStore } from "./store.js";

/**
 * Whether any run the host keeps is on a version, ended runs included: the
 * guard `remove` asks. True, a throw or a rejection keeps the version.
 */
export type VersionInUse = (scope: Scope, flowId: string, version: string) => boolean | Promise<boolean>;

/** A policy the host may set directly; `forced` needs the two-person request and approval. */
export type DirectPolicy = Extract<MigrationPolicy, { mode: "pinned" | "onNextTurn" }>;

/** How a memory catalog is built: its clock and the roles that govern version moves. */
export interface MemoryCatalogOptions {
  clock?: Clock;
  /** App roles allowed to force moves, revoke and remove versions. Default `["flow-admin"]`. */
  migrationRoles?: string[];
  /**
   * Whether a stored run, ended runs included, is on a version, asked before
   * `remove`. Without it nothing can be removed: the catalog never assumes a
   * version is unused. `storedRunsUse(store)` answers from the store. Replay
   * and export need every version a run was on, so `remove` asks about the
   * version itself and about every published version a run on it could have
   * moved to since (one that accepts runs from it, directly or through
   * others).
   */
  inUse?: VersionInUse;
}

export interface MemoryCatalog extends FlowCatalog {
  /**
   * Validates, compiles and publishes a version. The first publish of a
   * version makes it current (unless `makeCurrent` is false). Publishing the
   * same id and version again is allowed only with an identical definition,
   * and changes nothing: it never moves the current version back. Use
   * `setCurrent` for that. Publishing a removed version again (to replay or
   * export an old run, say) restores it, with its revocation if it had one,
   * and makes it current only with `makeCurrent: true`.
   *
   * A version with `migrations` is checked against each source version it
   * names that is published in the scope (`checkMigration`); an error
   * refuses the publish. `check` returns the warnings too.
   *
   * It does not check the flow's calls against the connectors' operation
   * contracts or its views against the section contracts: it knows neither.
   * A host publishes with `publishChecked` from `@aaply/flow-host`, which
   * pins and checks both first and then calls this.
   */
  publish(scope: Scope, definition: unknown, options?: { makeCurrent?: boolean; policy?: DirectPolicy }): CompiledFlow;
  /** Everything publishing `definition` would report, warnings included, without publishing it. */
  check(scope: Scope, definition: unknown): Diagnostic[];
  /**
   * Publishes a flow source: expands its includes (`expandFlow`), compiles
   * it, checks its calls against what is published in `scope`
   * (`checkFlowCalls`, unless `checkCalls` is false), then publishes the
   * expanded definition as `publish` does. Throws {@link DiagnosticsError}
   * with every problem found.
   */
  publishSource(scope: Scope, source: unknown, options?: PublishSourceOptions): Promise<CompiledFlow>;
  /** Points the flow's current version somewhere else (rollback). Existing runs keep their own version. */
  setCurrent(scope: Scope, flowId: string, version: string): void;
  /** Sets a version's policy to `pinned` or `onNextTurn`; also withdraws a forced policy or a pending request. */
  setPolicy(scope: Scope, flowId: string, version: string, policy: DirectPolicy): void;
  /** Asks for runs to be forced onto `version`. Needs a migration role; a different person must approve. */
  requestForcedMigration(ctx: TrustedContext, flowId: string, version: string, options?: { from?: string[]; message?: string }): void;
  /** Approves the open request for `version`: the policy becomes `forced`. Refused for the person who asked. */
  approveForcedMigration(ctx: TrustedContext, flowId: string, version: string): VersionStatus;
  /**
   * Revokes a version: nothing new starts on it, and its runs move to the
   * current version (`then: "migrate"`) where they can, or end. Needs a
   * migration role. Revoking a revoked version changes nothing.
   */
  revoke(ctx: TrustedContext, flowId: string, version: string, options: { then: "migrate" | "end"; message: string }): VersionStatus;
  status(scope: Scope, flowId: string, version: string): Promise<VersionStatus | null>;
  versions(scope: Scope, flowId: string): Promise<VersionStatus[]>;
  /**
   * Removes a version nothing uses. Needs a migration role; refused for the
   * current version, while a call step of any version published in the scope
   * pins it (`flowId@version`), and unless `inUse` (an option) answers false
   * for it and for every published version a run on it could have moved to.
   * The version's id stays taken: publishing it again is allowed only with
   * the same definition. Check and removal are not one transaction: a run
   * started on the version by name meanwhile is not seen, so revoke a version
   * before removing it.
   */
  remove(ctx: TrustedContext, flowId: string, version: string): Promise<void>;
}

interface Entry {
  flow: CompiledFlow;
  publishedAt: number;
  seq: number;
  policy: MigrationPolicy;
  request?: { by: string; from?: string[]; message?: string };
  revoked?: Revocation;
}

/** A version published again with other content. */
function versionExists(flow: CompiledFlow): Diagnostic {
  return { code: "flow/version-exists", severity: "error", path: "version", pointer: "/version", message: `${flow.id}@${flow.version} is already published with different content; publish a new version` };
}

export function createMemoryCatalog(options: MemoryCatalogOptions = {}): MemoryCatalog {
  const clock = options.clock ?? systemClock;
  const migrationRoles = options.migrationRoles ?? ["flow-admin"];
  const versions = new Map<string, Entry>();
  const current = new Map<string, string>();
  // Removed versions, by key: a version id is never reused for other content, and a restored version keeps its revocation.
  const removed = new Map<string, { hash: string; revoked?: Revocation }>();
  let seq = 0;
  const key = (scope: Scope, flowId: string, version: string) => `${scopeKey(scope)}|${flowId}|${version}`;
  const currentKey = (scope: Scope, flowId: string) => `${scopeKey(scope)}|${flowId}`;

  const statusOf = (scope: Scope, entry: Entry): VersionStatus => ({
    flowId: entry.flow.id,
    version: entry.flow.version,
    hash: entry.flow.hash,
    publishedAt: entry.publishedAt,
    current: current.get(currentKey(scope, entry.flow.id)) === entry.flow.version,
    policy: structuredClone(entry.policy),
    ...(entry.revoked ? { revoked: { ...entry.revoked } } : {}),
  });

  const entryOf = (scope: Scope, flowId: string, version: string): Entry => {
    const entry = typeof flowId === "string" && typeof version === "string" ? versions.get(key(scope, flowId, version)) : undefined;
    if (!entry) throw new FlowError("not_found", `${String(flowId)}@${String(version)} is not published`);
    return entry;
  };

  /** Migration diagnostics of `flow` against its published sources. */
  const migrationChecks = (scope: Scope, flow: CompiledFlow): Diagnostic[] => {
    const out: Diagnostic[] = [];
    for (const from of [...flow.migrations.keys()].sort()) {
      const source = versions.get(key(scope, flow.id, from));
      if (source) out.push(...checkMigration(source.flow, flow));
    }
    return out;
  };

  /** Who is acting, from their trusted context only; they must hold a migration role. */
  const admin = (ctx: TrustedContext): string => {
    checkContext(ctx);
    if ((ctx.actor.kind !== "member" && ctx.actor.kind !== "staff") || !ctx.appRoles.some((r) => migrationRoles.includes(r))) {
      throw new FlowError("forbidden", "You cannot change how runs move between versions.");
    }
    return `${ctx.actor.domain}:${ctx.actor.id}`;
  };

  const checkMessage = (message: unknown): void => {
    if (message !== undefined && (typeof message !== "string" || message.length === 0 || message.length > MAX_UPDATE_MESSAGE)) {
      throw new FlowError("invalid", `A message has 1 to ${MAX_UPDATE_MESSAGE} characters.`);
    }
  };

  /** `from` must name versions the target accepts runs from. */
  const checkFrom = (flow: CompiledFlow, from: unknown): void => {
    if (from === undefined) return;
    if (!Array.isArray(from) || from.length === 0 || from.length > 100 || from.some((v) => typeof v !== "string" || !VERSION_RE.test(v) || !flow.migrations.has(v))) {
      throw new FlowError("invalid", `from must list versions that ${flow.id}@${flow.version} accepts runs from.`);
    }
  };

  const direct = (flow: CompiledFlow, policy: unknown): DirectPolicy => {
    const p = policy as DirectPolicy | undefined;
    if (p?.mode === "pinned") return { mode: "pinned" };
    if (p?.mode === "onNextTurn") {
      checkFrom(flow, p.from);
      checkMessage(p.message);
      return { mode: "onNextTurn", ...(p.from ? { from: [...p.from] } : {}), ...(p.message !== undefined ? { message: p.message } : {}) };
    }
    throw new FlowError("invalid", "A policy set directly is pinned or onNextTurn; forcing a move needs a request and a second person's approval.");
  };

  /** The first version published in `scope` (any flow, revoked ones too) with a call step pinning `flowId@version`, or null. */
  const pinnedBy = (scope: Scope, flowId: string, version: string): string | null => {
    const prefix = `${scopeKey(scope)}|`;
    for (const [k, entry] of versions) {
      if (!k.startsWith(prefix)) continue;
      if (entry.flow.steps.some((step) => step.call?.flowId === flowId && step.call.version === version)) return `${entry.flow.id}@${entry.flow.version}`;
    }
    return null;
  };

  /**
   * The published versions of `flow`'s flow a run on `flow` could have moved
   * to: those accepting runs from it, directly or through another (a run
   * moves only to a version that accepts runs from its own).
   */
  const movesFrom = (scope: Scope, flow: CompiledFlow): string[] => {
    const prefix = `${scopeKey(scope)}|${flow.id}|`;
    const others = [...versions.entries()].filter(([k]) => k.startsWith(prefix)).map(([, entry]) => entry.flow);
    const reached = new Set<string>([flow.version]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const other of others) {
        if (reached.has(other.version) || ![...other.migrations.keys()].some((from) => reached.has(from))) continue;
        reached.add(other.version);
        grew = true;
      }
    }
    reached.delete(flow.version);
    return [...reached].sort();
  };

  const catalog: MemoryCatalog = {
    publish(scope, definition, publishOptions = {}) {
      const flow = mustCompileFlow(definition);
      const k = key(scope, flow.id, flow.version);
      const existing = versions.get(k);
      const gone = removed.get(k);
      const taken = existing?.flow.hash ?? gone?.hash;
      if (taken !== undefined && taken !== flow.hash) throw new DiagnosticsError("flow version already published", withHints([versionExists(flow)]));
      if (existing) return existing.flow;
      const policy = publishOptions.policy === undefined ? ({ mode: "pinned" } as const) : direct(flow, publishOptions.policy);
      const problems = migrationChecks(scope, flow);
      if (problems.some((d) => d.severity === "error")) throw new DiagnosticsError("migrations do not fit the published versions", withHints(problems));
      versions.set(k, { flow, publishedAt: clock.now(), seq: seq++, policy, ...(gone?.revoked ? { revoked: { ...gone.revoked } } : {}) });
      // A restored version was current once and was moved off: it becomes current again only when asked.
      if (gone ? publishOptions.makeCurrent === true : publishOptions.makeCurrent !== false) current.set(currentKey(scope, flow.id), flow.version);
      return flow;
    },
    check(scope, definition) {
      const { flow, diagnostics } = compileFlow(definition);
      if (!flow) return diagnostics;
      const k = key(scope, flow.id, flow.version);
      const taken = versions.get(k)?.flow.hash ?? removed.get(k)?.hash;
      if (taken !== undefined && taken !== flow.hash) return withHints([...diagnostics, versionExists(flow)]);
      return withHints([...diagnostics, ...migrationChecks(scope, flow)]);
    },
    async publishSource(scope, source, options = {}) {
      const definition = mustExpand(await expandFlow(source, { scope, ...(options.fragments ? { fragments: options.fragments } : {}) }));
      const flow = mustCompileFlow(definition);
      if (options.checkCalls !== false) {
        const problems = await checkFlowCalls(flow, { scope, catalog, ...(options.maxCallDepth !== undefined ? { maxDepth: options.maxCallDepth } : {}) });
        if (problems.some((d) => d.severity === "error")) throw new DiagnosticsError("flow calls do not fit", problems);
      }
      return catalog.publish(scope, definition, {
        ...(options.makeCurrent !== undefined ? { makeCurrent: options.makeCurrent } : {}),
        ...(options.policy !== undefined ? { policy: options.policy } : {}),
      });
    },
    setCurrent(scope, flowId, version) {
      if (!versions.has(key(scope, flowId, version))) throw new Error(`${flowId}@${version} is not published`);
      current.set(currentKey(scope, flowId), version);
    },
    setPolicy(scope, flowId, version, policy) {
      const entry = entryOf(scope, flowId, version);
      entry.policy = direct(entry.flow, policy);
      delete entry.request;
    },
    requestForcedMigration(ctx, flowId, version, request = {}) {
      const by = admin(ctx);
      const entry = entryOf(ctx.scope, flowId, version);
      if (entry.flow.migrations.size === 0) throw new FlowError("invalid", `${flowId}@${version} accepts runs from no other version.`);
      checkFrom(entry.flow, request.from);
      checkMessage(request.message);
      entry.request = { by, ...(request.from ? { from: [...request.from] } : {}), ...(request.message !== undefined ? { message: request.message } : {}) };
    },
    approveForcedMigration(ctx, flowId, version) {
      const by = admin(ctx);
      const entry = entryOf(ctx.scope, flowId, version);
      const request = entry.request;
      if (!request) throw new FlowError("not_found", "Nobody asked to force this move.");
      if (request.by === by) throw new FlowError("denied", "A forced move needs a second person's approval.");
      entry.policy = {
        mode: "forced",
        ...(request.from ? { from: request.from } : {}),
        ...(request.message !== undefined ? { message: request.message } : {}),
        approval: { requestedBy: request.by, approvedBy: by, approvedAt: clock.now() },
      };
      delete entry.request;
      return statusOf(ctx.scope, entry);
    },
    revoke(ctx, flowId, version, revocation) {
      const by = admin(ctx);
      const entry = entryOf(ctx.scope, flowId, version);
      if (entry.revoked) return statusOf(ctx.scope, entry);
      if (revocation?.then !== "migrate" && revocation?.then !== "end") throw new FlowError("invalid", 'then is "migrate" or "end".');
      checkMessage(revocation.message);
      if (revocation.message === undefined) throw new FlowError("invalid", "Say why, for the people whose runs this affects.");
      entry.revoked = { at: clock.now(), by, then: revocation.then, message: revocation.message };
      return statusOf(ctx.scope, entry);
    },
    async remove(ctx, flowId, version) {
      admin(ctx);
      const k = key(ctx.scope, flowId, version);
      const entry = entryOf(ctx.scope, flowId, version);
      const isCurrent = () => current.get(currentKey(ctx.scope, flowId)) === version;
      if (isCurrent()) throw new FlowError("conflict", `${flowId}@${version} is the current version; make another version current first.`);
      const caller = pinnedBy(ctx.scope, flowId, version);
      if (caller !== null) throw new FlowError("conflict", `${flowId}@${version} is called by ${caller}, a published version; it stays while a published version calls it.`);
      // Runs on this version, and on every version one of them could have moved to since: a moved run's replay needs each version it was on.
      const asked = [version, ...movesFrom(ctx.scope, entry.flow)];
      let used = true;
      try {
        if (options.inUse) {
          used = false;
          for (const v of asked) {
            if ((await options.inUse(ctx.scope, flowId, v)) === false) continue;
            used = true;
            break;
          }
        }
      } catch {
        used = true;
      }
      if (used) throw new FlowError("conflict", `${flowId}@${version} may be needed by a stored run, whose replay and export need it; it stays.`);
      // Asked again after the wait: it may have become current, been called or removed, or gained a version runs could move to, meanwhile.
      const unchanged = versions.get(k) === entry && !isCurrent() && pinnedBy(ctx.scope, flowId, version) === null && movesFrom(ctx.scope, entry.flow).every((v) => asked.includes(v));
      if (!unchanged) throw new FlowError("conflict", `${flowId}@${version} changed meanwhile; try again.`);
      versions.delete(k);
      removed.set(k, { hash: entry.flow.hash, ...(entry.revoked ? { revoked: { ...entry.revoked } } : {}) });
    },
    async get(scope, flowId, version) {
      const v = version ?? current.get(currentKey(scope, flowId));
      if (v === undefined) return null;
      return versions.get(key(scope, flowId, v))?.flow ?? null;
    },
    async list(scope, viewer) {
      const out = [];
      const prefix = `${scopeKey(scope)}|`;
      const roles = Array.isArray(viewer?.appRoles) ? viewer.appRoles : [];
      for (const [k, version] of current) {
        if (!k.startsWith(prefix)) continue;
        const entry = versions.get(`${k}|${version}`);
        // Revoked versions, flows only other flows may call, and flows with start roles the viewer holds none of, are not offered.
        if (!entry || entry.revoked || !mayStart(entry.flow, roles) || entry.flow.interface?.callableOnly === true) continue;
        const def = entry.flow.definition;
        out.push({
          flowId: entry.flow.id,
          version: entry.flow.version,
          title: def.title,
          ...(def.goal?.description ?? def.description ? { description: def.goal?.description ?? def.description! } : {}),
          ...(def.goal?.phrases ? { phrases: def.goal.phrases } : {}),
          ...(def.goal?.names ? { names: def.goal.names } : {}),
        });
      }
      return out;
    },
    async status(scope, flowId, version) {
      const entry = versions.get(key(scope, flowId, version));
      return entry ? statusOf(scope, entry) : null;
    },
    async versions(scope, flowId) {
      const prefix = `${scopeKey(scope)}|${flowId}|`;
      return [...versions.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, entry]) => entry)
        .sort((a, b) => a.seq - b.seq)
        .map((entry) => statusOf(scope, entry));
    },
  };
  return catalog;
}

/**
 * A `VersionInUse` from a store's runs (`hasRunOnVersion`): a version is in
 * use while any stored run is on it, ended runs included. Fails closed: it
 * throws, which keeps the version, when the store cannot answer. A run that
 * moved on to another version is on that one now; the memory catalog asks
 * about every version such a run could be on.
 */
export function storedRunsUse(store: Pick<RunStore, "hasRunOnVersion">): VersionInUse {
  return async (scope, flowId, version) => {
    if (!store.hasRunOnVersion) throw new FlowError("unavailable", "This store cannot say which versions its runs are on, so whether a version is in use is unknown.");
    return (await store.hasRunOnVersion(scope, { flowId, version })) !== false;
  };
}
