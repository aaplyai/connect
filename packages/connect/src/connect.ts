/**
 * `createConnect`: one Connect service, from deployment config.
 *
 * It checks the database (schema version, and a login role that row
 * security binds) before it serves anything. Code connectors come only as
 * imported modules of this build: there is no way to load connector code
 * from data, so outside code has no way in until the separate runner exists.
 */

import type pg from "pg";
import { ed25519ActionVerifier, type ActionOutcome, type ActionPortDescription, type Ed25519PublicKey, type EnvironmentKind, type JsonObject, type OperationContract, type Scope } from "@aaply/action-contract";
import { operationContractOf, type BlobLimits, type BlobStore, type Connector, type ConnectorLogSink, type FetchLike, type HttpLimits } from "@aaply/connector-sdk";
import { adminAs, AdminError, loggedAdmin, type ActorAdmin, type AdminActor, type RawAdmin } from "./admin.js";
import { createAdminRoutes, type AdminAnswer, type AdminRequest } from "./admin-http.js";
import { secretProblem, type TokenRefresher } from "./credentials.js";
import { createOAuth, type OAuth, type OAuthAnswer, type OAuthOptions, type StartOAuthInput } from "./oauth/oauth.js";
import { egressPolicy, safeFetch, type EgressOptions } from "./egress.js";
import { newId } from "./ids.js";
import { compareVersions } from "./semver.js";
import { createPerformer, DEFAULT_ROLE } from "./performer.js";
import { sqlConnector } from "./sql/connector.js";
import { definitionDigest, sqlDefinitionProblems, type SqlConnectorDefinition } from "./sql/definition.js";
import { createSqlExecutor, sqlTargetProblem, type SqlExecutor } from "./sql/executor.js";
import { createOAuthStore } from "./store/oauth-store.js";
import { createPgStore, type Connection } from "./store/store.js";
import { createVault, type KeyProvider } from "./vault.js";

export interface ConnectOptions {
  /** This Connect's audience, as the engine's host names it when it signs. */
  audience: string;
  /**
   * The engine's Ed25519 public keys by key id, each optionally with a
   * `notAfter` (epoch ms). Rotate by adding the new key, switching the
   * engine, then removing the old one once its longest deadline has passed.
   */
  engineKeys: Readonly<Record<string, Ed25519PublicKey>>;
  /**
   * The Aaply backend's Ed25519 public keys by key id, for signed admin
   * requests (`/admin/*`). Without them, the admin routes answer 404.
   */
  adminKeys?: Readonly<Record<string, Ed25519PublicKey>>;
  /** Every code connector this build serves (several versions of one side by side during an upgrade). */
  connectors: readonly Connector[];
  /** A pool logged in as a member of `aaply_connect_app` (never the schema owner). */
  pool: pg.Pool;
  /** Wraps tenants' data keys (`localKeyProvider`, or a KMS). */
  keys: KeyProvider;
  egress?: EgressOptions;
  /**
   * OAuth: Connect's callback, the app origins people return to, and Aaply's
   * client at each provider per OAuth connector. Connect then connects
   * accounts (`admin.startOAuth`, `/oauth/*`) and renews their tokens.
   * Without it, OAuth connectors cannot be connected, and a refused token
   * answers `http/401`.
   */
  oauth?: OAuthOptions;
  /**
   * The Aaply backend's file store (ADR-0008), for connectors that take or
   * give files by reference (Drive's upload and download): a `BlobStore`
   * over the same object store the backend serves files from, scoped by
   * tenant, app and environment. Connect only stores what a call returns
   * and reads what a call was given; the backend deletes files when runs
   * release them (the engine's blob ledger). Without it, those operations
   * fail with `connect/blob-no-store`. `limits` default to the kit's
   * (25 MiB a file, 64 MiB a call).
   */
  files?: { store: BlobStore; limits?: Partial<BlobLimits> };
  /**
   * Bounds on what one call sends and reads over HTTP (default 5 MiB a
   * request or response, 16 MiB of responses a call). A deployment that
   * downloads files larger than 16 MiB raises `maxTotalResponseBytes`.
   */
  httpLimits?: Partial<HttpLimits>;
  /** Longest a call may run, in ms. Default 55 000. */
  ceilingMs?: number;
  /**
   * Calls one instance runs at once, in all and per tenant (default 256 and
   * 32); a call past either cap is refused `connect/unavailable`, retryable
   * after a second, before anything is read. The engine's lanes pace each
   * tenant's calls; this bounds what all tenants together can hold of one
   * instance's sockets and call budgets.
   */
  maxInFlight?: number;
  maxInFlightPerTenant?: number;
  /**
   * Tests only: replaces the egress-checked fetch (the kit's `mockFetch`).
   * Production leaves it out, so every socket passes the egress check.
   */
  fetch?: FetchLike;
  now?: () => number;
  log?: ConnectorLogSink;
  observer?: { error?(error: unknown, where: string): void };
}

/** How long `close` waits for deletes of files calls stored and did not answer. */
const CLOSE_SETTLE_MS = 10_000;

/** Whose account a new connection is. */
export type ConnectionOwner = { business: true; role?: string } | { person: string };

export interface NewConnectionInput {
  scope: Scope;
  connectorId: string;
  owner: ConnectionOwner;
  /** The kind of environment the account serves. Default `production`. */
  environmentKind?: EnvironmentKind;
  grantedScopes?: readonly string[];
  account?: JsonObject;
  config?: JsonObject;
  /** The credential, sealed by the vault (see credentials.ts for its fields). Null for a connector with no auth. */
  secret: Readonly<Record<string, string>> | null;
}

/** What the admin API can do. `Connect.admin` is the operator's (unchecked); `Connect.adminAs` checks a person's permission. Changes are logged either way. */
export interface ConnectAdmin {
  /** Installs one of this build's code connectors for a scope. */
  install(scope: Scope, connectorId: string): Promise<string>;
  /**
   * Installs a declared SQL connector (data) for a scope, replacing its
   * earlier definition. Flows pinned to an operation whose statement changed
   * are refused (`connect/contract-mismatch`) until they are published again.
   */
  installSql(scope: Scope, definition: SqlConnectorDefinition): Promise<string>;
  uninstall(scope: Scope, connectorId: string): Promise<boolean>;
  setPolicy(scope: Scope, change: { disabled?: boolean; denied?: readonly string[] }): Promise<void>;
  setGlobalDisabled(disabled: boolean): Promise<void>;
  createConnection(input: NewConnectionInput): Promise<Connection>;
  /** Replaces a connection's secret (and fields), only from `expectedVersion`. */
  updateConnection(
    tenantId: string,
    id: string,
    expectedVersion: number,
    change: { secret?: Readonly<Record<string, string>>; status?: "active" | "reauth"; grantedScopes?: readonly string[]; account?: JsonObject; config?: JsonObject },
  ): Promise<Connection>;
  revokeConnection(tenantId: string, id: string): Promise<Connection | null>;
  connection(tenantId: string, id: string): Promise<Connection | null>;
  connections(scope: Scope, filter?: { connectorId?: string; ownerSubject?: string }): Promise<Connection[]>;
  /**
   * Starts connecting an account with OAuth (`ConnectOptions.oauth`): answers
   * the link to send the person's browser to, valid for one use until
   * `expiresAt`. The person lands on `returnTo` afterwards, with
   * `connect=ok&connection=<id>` or `connect=error&reason=<code>`.
   */
  startOAuth(input: StartOAuthInput): Promise<{ url: string; expiresAt: number }>;
  /**
   * The operation contracts of the connectors installed for a scope (their
   * newest version), as the engine's `pinActionContracts` takes them when a
   * host publishes a flow. A pin is `operationDigest(contract)`.
   */
  operations(scope: Scope): Promise<Record<string, OperationContract>>;
}

export interface Connect {
  /** Performs one approved action. Never throws. */
  perform(value: unknown, signal?: AbortSignal): Promise<ActionOutcome>;
  describe(): ActionPortDescription;
  /** The operator's admin API, for code in the deployment: unchecked, each change logged as the operator's. */
  admin: ConnectAdmin;
  /** The admin API as a person the Aaply backend vouches for: each call checked against their permission, each change logged as theirs. */
  adminAs(actor: AdminActor): ActorAdmin;
  /** One signed admin request (`@aaply/connect/http` routes `/admin/*` here). */
  adminRequest(request: AdminRequest): Promise<AdminAnswer>;
  /** `GET /oauth/start` and `GET /oauth/callback` (`@aaply/connect/http` routes them here). */
  oauthRequest(request: { path: string; query: URLSearchParams; cookie: string | undefined }): Promise<OAuthAnswer>;
  /** Whether the store answers. */
  ready(): Promise<boolean>;
  /** Deletes expired replay claims, OAuth attempts and dead refresh leases; run it every minute from any instance (several at once is safe). */
  purgeExpired(): Promise<number>;
  /** Waits (up to 10 s) for deletes of files calls stored and did not answer, then closes the pools; once, however often called. Call it after `serveConnect`'s `close`. */
  close(): Promise<void>;
}

/** A Cookie header's pairs (the first of a repeated name wins). */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

function newest(connectors: readonly Connector[], id: string): Connector | undefined {
  return connectors.filter((c) => c.id === id).sort((a, b) => compareVersions(b.version, a.version))[0];
}

export async function createConnect(options: ConnectOptions): Promise<Connect> {
  if (!options.audience) throw new Error("audience is required");
  if (Object.keys(options.engineKeys).length === 0) throw new Error("engineKeys needs at least one key");
  // pg emits an idle socket's error on the pool; with no listener Node treats it as an uncaught exception,
  // so a database restart or failover would end every instance at once. The deployment may listen itself.
  if (options.pool.listenerCount("error") === 0) {
    options.pool.on("error", (error) => {
      try {
        options.observer?.error?.(error, "pool");
      } catch {
        // An observer that throws changes nothing.
      }
    });
  }
  const store = createPgStore(options.pool);
  await store.check();
  const vault = createVault({ keys: options.keys, store, ...(options.now ? { now: options.now } : {}) });
  const policy = egressPolicy(options.egress);
  const egress = safeFetch(policy, { connections: options.egress?.connectionsPerOrigin ?? 64 });
  // The OAuth module needs the admin API, which needs the performer: the performer's refresher reaches it once built.
  let oauth: OAuth | undefined;
  let refresher: TokenRefresher | undefined;
  const sql = createSqlExecutor({ egress: policy, ...(options.egress?.sqlPrivateTenants ? { privateTenants: options.egress.sqlPrivateTenants } : {}) });
  const performer = createPerformer({
    audience: options.audience,
    verifier: ed25519ActionVerifier(options.engineKeys, options.now ? { now: options.now } : {}),
    connectors: options.connectors,
    store,
    vault,
    fetch: options.fetch ?? egress.fetch,
    sql,
    ...(options.oauth ? { refresher: { refresh: (request) => refresher!.refresh(request) } satisfies TokenRefresher } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.ceilingMs !== undefined ? { ceilingMs: options.ceilingMs } : {}),
    ...(options.maxInFlight !== undefined ? { maxInFlight: options.maxInFlight } : {}),
    ...(options.maxInFlightPerTenant !== undefined ? { maxInFlightPerTenant: options.maxInFlightPerTenant } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.httpLimits ? { httpLimits: options.httpLimits } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.observer ? { observer: options.observer } : {}),
  });

  let closing: Promise<void> | undefined;

  const connectorOf = (id: string): Connector => {
    const c = newest(options.connectors, id);
    if (!c) throw new AdminError("admin/invalid", `no connector ${id} in this build`);
    return c;
  };

  /** A SQL definition as a kit connector, for its checks and contracts only (it never runs). */
  const declared = (definition: SqlConnectorDefinition) => sqlConnector(definition, idle, async () => Promise.reject(new Error("not running")));
  const idle: SqlExecutor = { run: () => Promise.reject(new Error("not running")), close: async () => {} };

  /** What is wrong with a connection's secret and config for its connector in this scope, or null. */
  const connectionProblem = async (scope: Scope, connectorId: string, secret: Readonly<Record<string, string>> | null, config: JsonObject | undefined, creating = false): Promise<string | null> => {
    const code = newest(options.connectors, connectorId);
    if (code) return secretProblem(code.auth, secret);
    const installed = (await store.installations(scope)).find((i) => i.connectorId === connectorId && i.kind === "sql");
    if (!installed) return `no connector ${connectorId} in this build or installed here`;
    if (config !== undefined) {
      const problem = sqlTargetProblem(config);
      if (problem) return problem;
    }
    if ((creating || secret !== null) && (secret === null || Object.keys(secret).join() !== "password" || !secret.password)) return "a SQL connection's secret is { password }";
    return null;
  };

  const raw: RawAdmin = {
    async install(scope, connectorId) {
      connectorOf(connectorId);
      const id = newId("inst");
      await store.install(scope, { id, connectorId, kind: "code" });
      return id;
    },
    async installSql(scope, definition) {
      const problems = sqlDefinitionProblems(definition);
      if (problems.length > 0) throw new AdminError("admin/invalid", `the SQL connector is not valid: ${problems.join("; ")}`);
      if (newest(options.connectors, definition.id)) throw new AdminError("admin/invalid", `${definition.id} is the id of a code connector in this build`);
      try {
        declared(definition); // the kit's own checks: schemas, undo pairing, risk floors
      } catch (error) {
        throw new AdminError("admin/invalid", `the SQL connector is not valid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      const id = newId("inst");
      await store.install(scope, { id, connectorId: definition.id, kind: "sql", definition: definition as unknown as JsonObject, digest: definitionDigest(definition) });
      return id;
    },
    uninstall: (scope, connectorId) => store.uninstall(scope, connectorId),
    setPolicy: (scope, change) => store.setPolicy(scope, change),
    setGlobalDisabled: (disabled) => store.setGlobalDisabled(disabled),
    async createConnection(input) {
      const problem = await connectionProblem(input.scope, input.connectorId, input.secret, input.config ?? {}, true);
      if (problem) throw new AdminError("admin/invalid", `${input.connectorId}: ${problem}`);
      const id = newId("conn");
      const person = "person" in input.owner ? input.owner.person : null;
      if (person !== null && !/^[^:\s]{1,64}:\S{1,256}$/.test(person)) throw new AdminError("admin/invalid", "a person is named domain:id");
      const role = "business" in input.owner ? (input.owner.role ?? DEFAULT_ROLE) : null;
      const sealed = input.secret && Object.keys(input.secret).length > 0 ? await vault.seal(input.scope.tenantId, id, 1, input.secret) : null;
      return store.insertConnection(
        {
          id,
          scope: input.scope,
          connectorId: input.connectorId,
          ownerSubject: person,
          role,
          environmentKind: input.environmentKind ?? "production",
          grantedScopes: input.grantedScopes ?? [],
          account: input.account ?? {},
          config: input.config ?? {},
        },
        sealed,
      );
    },
    async updateConnection(tenantId, id, expectedVersion, change) {
      const { secret, ...fields } = change;
      if (secret || fields.config) {
        const current = await store.connection(tenantId, id);
        if (!current) throw new AdminError("admin/not-found", `no connection ${id}`);
        const problem = await connectionProblem(current.scope, current.connectorId, secret ?? null, fields.config);
        if (problem) throw new AdminError("admin/invalid", `${current.connectorId}: ${problem}`);
      }
      return store.updateConnection(tenantId, id, expectedVersion, fields, secret ? (version) => vault.seal(tenantId, id, version, secret) : undefined);
    },
    async revokeConnection(tenantId, id) {
      // An OAuth grant is revoked at its provider too, as far as the provider allows: the secret is read before it is deleted.
      const before = oauth ? await store.connection(tenantId, id) : null;
      const secret = before && oauth?.serves(before.connectorId) && before.status !== "revoked" ? await oauth.secretOf(tenantId, id).catch(() => null) : null;
      const revoked = await store.revokeConnection(tenantId, id);
      // A provider revokes the whole grant (account and Aaply's client), so it is left alone while another connection here uses that account.
      // Connections of the same account in another app or tenant cannot be seen from here: they go to reauth on their next refresh.
      const shared = (c: Connection) => c.id !== id && c.status !== "revoked" && c.account.provider === before!.account.provider && c.account.id === before!.account.id;
      if (revoked && secret && !(await store.connections(before!.scope)).some(shared)) await oauth!.revokeAtProvider(before!.connectorId, secret);
      return revoked;
    },
    connection: (tenantId, id) => store.connection(tenantId, id),
    connections: (scope, filter) => store.connections(scope, filter),
    async startOAuth(input, actor) {
      if (!oauth) throw new AdminError("admin/invalid", "OAuth is not configured here");
      const connector = newest(options.connectors, input.connectorId);
      if (connector?.auth.kind !== "oauth2" || !oauth.serves(input.connectorId)) throw new AdminError("admin/invalid", `${input.connectorId} is not an OAuth connector served here`);
      if ("person" in input.owner && (typeof input.owner.person !== "string" || !/^[^:\s]{1,64}:\S{1,256}$/.test(input.owner.person))) throw new AdminError("admin/invalid", "a person is named domain:id");
      if (input.reconnect !== undefined) {
        const c = await store.connection(input.scope.tenantId, input.reconnect);
        const owner = "person" in input.owner ? input.owner.person : null;
        const role = "business" in input.owner ? (input.owner.role ?? DEFAULT_ROLE) : null;
        if (!c || c.status === "revoked") throw new AdminError("admin/not-found", `no connection ${input.reconnect}`);
        if (c.connectorId !== input.connectorId || c.scope.appId !== input.scope.appId || c.scope.environmentId !== input.scope.environmentId || c.ownerSubject !== owner || (owner === null && c.role !== role) || c.environmentKind !== (input.environmentKind ?? "production"))
          throw new AdminError("admin/invalid", "reconnect names a connection with another connector, scope, owner or environment");
      }
      return oauth.start(input, actor);
    },
    async operations(scope) {
      const out: Record<string, OperationContract> = {};
      for (const inst of await store.installations(scope)) {
        const connector = inst.kind === "sql" ? declared(inst.definition as unknown as SqlConnectorDefinition) : newest(options.connectors, inst.connectorId);
        if (!connector) continue;
        for (const name of Object.keys(connector.operations)) {
          const contract = operationContractOf(connector, name)!;
          out[`${connector.id}.${name}`] = contract;
        }
      }
      return out;
    },
  };

  const connect: Connect = {
    perform: performer.perform,
    describe: performer.describe,
    admin: loggedAdmin(raw, store, { operator: true }),
    adminAs: (actor) => adminAs(raw, store, actor),
    adminRequest: (request) => adminRoutes(request),
    async oauthRequest(request) {
      if (!oauth) return { status: 404, text: "Not found." };
      const cookies = parseCookies(request.cookie);
      if (request.path === "/oauth/start") return oauth.begin(request.query.get("attempt") ?? "");
      if (request.path === "/oauth/callback") return oauth.complete(request.query, cookies);
      return { status: 404, text: "Not found." };
    },
    async ready() {
      try {
        await options.pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    purgeExpired: () => store.purgeExpired(),
    close: () =>
      (closing ??= (async () => {
        // Deletes of files calls stored and did not answer, so none is left behind; then the pools.
        await performer.settle(CLOSE_SETTLE_MS);
        await Promise.all([egress.close(), sql.close()]);
      })()),
  };
  if (options.oauth) {
    const oauthStore = createOAuthStore(options.pool);
    oauth = createOAuth({
      config: options.oauth,
      store,
      oauthStore,
      vault,
      admin: raw,
      fetch: options.fetch ?? egress.fetch,
      scopesOf: (connectorId) => {
        const auth = newest(options.connectors, connectorId)?.auth;
        return auth?.kind === "oauth2" ? auth.scopes : [];
      },
      ...(options.now ? { now: options.now } : {}),
      report: (error, where) => {
        try {
          options.observer?.error?.(error, where);
        } catch {
          // An observer that throws changes nothing.
        }
      },
    });
    refresher = oauth.refresher(async (tenantId, connectionId) => (await store.connection(tenantId, connectionId))?.connectorId ?? null);
  }
  const adminRoutes = options.adminKeys
    ? createAdminRoutes(connect, { audience: options.audience, verifier: ed25519ActionVerifier(options.adminKeys, options.now ? { now: options.now } : {}), store, ...(options.now ? { now: options.now } : {}) })
    : async (): Promise<AdminAnswer> => ({ status: 404, body: { error: { code: "admin/not-found", message: "the admin API is not enabled" } } });
  return connect;
}
