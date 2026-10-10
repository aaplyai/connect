/**
 * `createConnect`: one Connect service, from deployment config.
 *
 * It checks the database (schema version, and a login role that row
 * security binds) before it serves anything. Code connectors come only as
 * imported modules of this build: there is no way to load connector code
 * from data, so outside code has no way in until the separate runner exists.
 */

import type pg from "pg";
import { ed25519ActionVerifier, operationDigest, type ActionOutcome, type ActionPortDescription, type Ed25519PublicKey, type EnvironmentKind, type JsonObject, type OperationContract, type Scope } from "@aaply/action-contract";
import { operationContractOf, type Connector, type ConnectorLogSink, type FetchLike } from "@aaply/connector-sdk";
import { secretProblem, type TokenRefresher } from "./credentials.js";
import { egressPolicy, safeFetch, type EgressOptions } from "./egress.js";
import { newId } from "./ids.js";
import { createPerformer, DEFAULT_ROLE } from "./performer.js";
import { createPgStore, type Connection, type ConnectStore } from "./store/store.js";
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
  /** Every code connector this build serves (several versions of one side by side during an upgrade). */
  connectors: readonly Connector[];
  /** A pool logged in as a member of `aaply_connect_app` (never the schema owner). */
  pool: pg.Pool;
  /** Wraps tenants' data keys (`localKeyProvider`, or a KMS). */
  keys: KeyProvider;
  egress?: EgressOptions;
  /** The OAuth module's token refresh. Without it, a refused token answers `http/401`. */
  refresher?: TokenRefresher;
  /** Longest a call may run, in ms. Default 55 000. */
  ceilingMs?: number;
  /**
   * Tests only: replaces the egress-checked fetch (the kit's `mockFetch`).
   * Production leaves it out, so every socket passes the egress check.
   */
  fetch?: FetchLike;
  now?: () => number;
  log?: ConnectorLogSink;
  observer?: { error?(error: unknown, where: string): void };
}

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

/** What the admin API (and later the signed /admin routes) can do. Permission checks belong to the caller. */
export interface ConnectAdmin {
  install(scope: Scope, connectorId: string): Promise<string>;
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
  /** The operation contracts of the connectors installed for a scope (their newest version), which a host pins when it publishes a flow. */
  operations(scope: Scope): Promise<Record<string, OperationContract & { digest: string }>>;
}

export interface Connect {
  /** Performs one approved action. Never throws. */
  perform(value: unknown, signal?: AbortSignal): Promise<ActionOutcome>;
  describe(): ActionPortDescription;
  admin: ConnectAdmin;
  store: ConnectStore;
  /** Whether the store answers. */
  ready(): Promise<boolean>;
  /** Deletes expired replay claims; run it from a timer on any instance. */
  purgeExpired(): Promise<number>;
  close(): Promise<void>;
}

function newest(connectors: readonly Connector[], id: string): Connector | undefined {
  return connectors.filter((c) => c.id === id).sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0))[0];
}

export async function createConnect(options: ConnectOptions): Promise<Connect> {
  if (!options.audience) throw new Error("audience is required");
  if (Object.keys(options.engineKeys).length === 0) throw new Error("engineKeys needs at least one key");
  const store = createPgStore(options.pool);
  await store.check();
  const vault = createVault({ keys: options.keys, store, ...(options.now ? { now: options.now } : {}) });
  const egress = safeFetch(egressPolicy(options.egress));
  const performer = createPerformer({
    audience: options.audience,
    verifier: ed25519ActionVerifier(options.engineKeys, options.now ? { now: options.now } : {}),
    connectors: options.connectors,
    store,
    vault,
    fetch: options.fetch ?? egress.fetch,
    ...(options.refresher ? { refresher: options.refresher } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.ceilingMs !== undefined ? { ceilingMs: options.ceilingMs } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.observer ? { observer: options.observer } : {}),
  });

  const connectorOf = (id: string): Connector => {
    const c = newest(options.connectors, id);
    if (!c) throw new Error(`no connector ${id} in this build`);
    return c;
  };

  const admin: ConnectAdmin = {
    async install(scope, connectorId) {
      connectorOf(connectorId);
      const id = newId("inst");
      await store.install(scope, { id, connectorId, kind: "code" });
      return id;
    },
    uninstall: (scope, connectorId) => store.uninstall(scope, connectorId),
    setPolicy: (scope, change) => store.setPolicy(scope, change),
    setGlobalDisabled: (disabled) => store.setGlobalDisabled(disabled),
    async createConnection(input) {
      const connector = connectorOf(input.connectorId);
      const problem = secretProblem(connector.auth, input.secret);
      if (problem) throw new Error(`${input.connectorId}: ${problem}`);
      const id = newId("conn");
      const person = "person" in input.owner ? input.owner.person : null;
      if (person !== null && !/^[^:\s]{1,64}:\S{1,256}$/.test(person)) throw new Error("a person is named domain:id");
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
      if (secret) {
        const current = await store.connection(tenantId, id);
        if (!current) throw new Error(`no connection ${id}`);
        const problem = secretProblem(connectorOf(current.connectorId).auth, secret);
        if (problem) throw new Error(`${current.connectorId}: ${problem}`);
      }
      return store.updateConnection(tenantId, id, expectedVersion, fields, secret ? (version) => vault.seal(tenantId, id, version, secret) : undefined);
    },
    revokeConnection: (tenantId, id) => store.revokeConnection(tenantId, id),
    connection: (tenantId, id) => store.connection(tenantId, id),
    connections: (scope, filter) => store.connections(scope, filter),
    async operations(scope) {
      const out: Record<string, OperationContract & { digest: string }> = {};
      for (const inst of await store.installations(scope)) {
        if (inst.kind !== "code") continue;
        const connector = newest(options.connectors, inst.connectorId);
        if (!connector) continue;
        for (const name of Object.keys(connector.operations)) {
          const contract = operationContractOf(connector, name)!;
          out[`${connector.id}.${name}`] = { ...contract, digest: operationDigest(contract) };
        }
      }
      return out;
    },
  };

  return {
    perform: performer.perform,
    describe: performer.describe,
    admin,
    store,
    async ready() {
      try {
        await options.pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    purgeExpired: () => store.purgeExpired(),
    close: () => egress.close(),
  };
}
