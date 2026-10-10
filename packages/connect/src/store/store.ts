/**
 * The PostgreSQL store. Hot-path reads are one round trip each
 * (`resolve`, and `claim` for a write that does not de-duplicate); every
 * other method runs in a transaction that sets the tenant first, so row
 * security applies to everything the service reads or writes.
 */

import type pg from "pg";
import type { EnvironmentKind, JsonObject, Scope } from "@aaply/action-contract";
import type { SealedSecret, WrappedDataKey } from "../vault.js";
import { APP_ROLE, SCHEMA_VERSION } from "./schema.js";

export type ConnectionStatus = "active" | "reauth" | "revoked";

/** A connection as the store keeps it, without its secret. */
export interface Connection {
  id: string;
  scope: Scope;
  connectorId: string;
  /** The person whose account it is (`domain:id`), or null for the business's own. */
  ownerSubject: string | null;
  /** The flow role a business connection serves; null for a person's. */
  role: string | null;
  environmentKind: EnvironmentKind;
  grantedScopes: string[];
  /** Who the account is at the service (an email, a workspace id): never a secret. */
  account: JsonObject;
  /** Settings that are not secret (a database host, a pooler mode). */
  config: JsonObject;
  status: ConnectionStatus;
  version: number;
}

export interface Installation {
  id: string;
  kind: "code" | "sql";
  definition: JsonObject | null;
  digest: string | null;
}

/** What one call needs, read in one round trip. */
export interface Resolution {
  global: { disabled: boolean; version: number };
  policy: { disabled: boolean; denied: string[]; version: number } | null;
  installation: Installation | null;
  connection: (Omit<Connection, "scope" | "connectorId"> & { secret: { sealed: SealedSecret; dataKey: WrappedDataKey } | null }) | null;
}

export interface ResolveQuery {
  scope: Scope;
  connectorId: string;
  actingFor: "business" | "endUser";
  /** The business connection's role; the flow's null role is `default`. */
  role: string;
  subject: string | null;
  environment: EnvironmentKind;
}

export interface NewConnection {
  id: string;
  scope: Scope;
  connectorId: string;
  ownerSubject: string | null;
  role: string | null;
  environmentKind: EnvironmentKind;
  grantedScopes: readonly string[];
  account: JsonObject;
  config: JsonObject;
}

/** Raised when a write would break a uniqueness rule, or a versioned write lost a race. */
export class StoreConflict extends Error {
  override readonly name = "StoreConflict";
}

const b64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

function connectionOf(row: Record<string, unknown>): Connection {
  return {
    id: row.id as string,
    scope: { tenantId: row.tenant_id as string, appId: row.app_id as string, environmentId: row.environment_id as string },
    connectorId: row.connector_id as string,
    ownerSubject: (row.owner_subject as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    environmentKind: row.environment_kind as EnvironmentKind,
    grantedScopes: row.granted_scopes as string[],
    account: row.account as JsonObject,
    config: row.config as JsonObject,
    status: row.status as ConnectionStatus,
    version: row.version as number,
  };
}

const COLUMNS = "id, tenant_id, app_id, environment_id, connector_id, owner_subject, role, environment_kind, granted_scopes, account, config, status, version";

export interface ConnectStore {
  resolve(query: ResolveQuery): Promise<Resolution>;
  claim(tenantId: string, key: string, until: number): Promise<boolean>;
  currentDataKey(tenantId: string, create: () => Promise<WrappedDataKey>): Promise<WrappedDataKey>;
  install(scope: Scope, installation: { id: string; connectorId: string; kind: "code" | "sql"; definition?: JsonObject; digest?: string }): Promise<void>;
  uninstall(scope: Scope, connectorId: string): Promise<boolean>;
  installations(scope: Scope): Promise<Array<Installation & { connectorId: string }>>;
  setPolicy(scope: Scope, change: { disabled?: boolean; denied?: readonly string[] }): Promise<void>;
  setGlobalDisabled(disabled: boolean): Promise<void>;
  /** Inserts a connection and its sealed secret (sealed for version 1). */
  insertConnection(connection: NewConnection, secret: SealedSecret | null): Promise<Connection>;
  /**
   * Replaces a connection's secret and fields, moving its version on by one,
   * only when it is still at `expectedVersion` (else {@link StoreConflict}).
   * `seal` gets the new version, because the vault binds a secret to it.
   */
  updateConnection(
    tenantId: string,
    id: string,
    expectedVersion: number,
    change: { status?: ConnectionStatus; grantedScopes?: readonly string[]; account?: JsonObject; config?: JsonObject },
    seal?: (version: number) => Promise<SealedSecret>,
  ): Promise<Connection>;
  /** Marks a connection revoked and deletes its secret. Answers null when there is none. */
  revokeConnection(tenantId: string, id: string): Promise<Connection | null>;
  connection(tenantId: string, id: string): Promise<Connection | null>;
  connections(scope: Scope, filter?: { connectorId?: string; ownerSubject?: string }): Promise<Connection[]>;
  /** Deletes up to `limit` expired claims across tenants; answers how many. */
  purgeExpired(limit?: number): Promise<number>;
  /** Refuses a database made by another build, and a login role that can bypass row security. */
  check(): Promise<void>;
}

export function createPgStore(pool: pg.Pool): ConnectStore {
  async function tx<T>(tenantId: string | null, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (tenantId !== null) await client.query("SELECT set_config('aaply_connect.tenant', $1, true)", [tenantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: unknown }).code === "23505") throw new StoreConflict("that already exists", { cause: error });
      throw error;
    } finally {
      client.release();
    }
  }
  const scopeParams = (s: Scope) => [s.tenantId, s.appId, s.environmentId];

  return {
    async resolve(q) {
      const { rows } = await pool.query("SELECT aaply_connect.resolve($1, $2, $3, $4, $5, $6, $7, $8) AS r", [
        ...scopeParams(q.scope),
        q.connectorId,
        q.actingFor,
        q.role,
        q.subject,
        q.environment,
      ]);
      const r = rows[0]?.r as Record<string, any>;
      const c = r.connection as Record<string, any> | null;
      return {
        global: { disabled: r.global.disabled, version: Number(r.global.version) },
        policy: r.policy ? { disabled: r.policy.disabled, denied: r.policy.denied, version: Number(r.policy.version) } : null,
        installation: r.installation ? { id: r.installation.id, kind: r.installation.kind, definition: r.installation.definition ?? null, digest: r.installation.digest ?? null } : null,
        connection: c
          ? {
              id: c.id,
              ownerSubject: c.ownerSubject ?? null,
              role: c.role ?? null,
              environmentKind: c.environmentKind,
              grantedScopes: c.grantedScopes,
              account: c.account,
              config: c.config,
              status: c.status,
              version: c.version,
              secret: c.secret
                ? {
                    sealed: { dataKeyId: c.secret.dataKeyId, iv: b64(c.secret.iv), sealed: b64(c.secret.sealed) },
                    dataKey: { dataKeyId: c.secret.dataKeyId, wrapped: b64(c.secret.wrapped), wrappingKeyId: c.secret.wrappingKeyId },
                  }
                : null,
            }
          : null,
      };
    },

    async claim(tenantId, key, until) {
      const { rows } = await pool.query("SELECT aaply_connect.claim($1, $2, to_timestamp($3::double precision / 1000)) AS claimed", [tenantId, key, until]);
      return rows[0]?.claimed === true;
    },

    async currentDataKey(tenantId, create) {
      const read = async (client: pg.PoolClient) => {
        const { rows } = await client.query("SELECT data_key_id, wrapped, wrapping_key_id FROM aaply_connect.data_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", [tenantId]);
        const row = rows[0];
        return row ? { dataKeyId: row.data_key_id as string, wrapped: new Uint8Array(row.wrapped as Buffer), wrappingKeyId: row.wrapping_key_id as string } : null;
      };
      const existing = await tx(tenantId, read);
      if (existing) return existing;
      const made = await create();
      return tx(tenantId, async (client) => {
        // One data key per tenant: concurrent first writes serialise here, and the loser uses the winner's key.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('aaply_connect.data_key'), hashtext($1))", [tenantId]);
        const raced = await read(client);
        if (raced) return raced;
        await client.query("INSERT INTO aaply_connect.data_keys (tenant_id, data_key_id, wrapping_key_id, wrapped) VALUES ($1, $2, $3, $4)", [
          tenantId,
          made.dataKeyId,
          made.wrappingKeyId,
          Buffer.from(made.wrapped),
        ]);
        return made;
      });
    },

    async install(scope, i) {
      await tx(scope.tenantId, (client) =>
        client.query("INSERT INTO aaply_connect.installations (id, tenant_id, app_id, environment_id, connector_id, kind, definition, digest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
          i.id,
          ...scopeParams(scope),
          i.connectorId,
          i.kind,
          i.definition ?? null,
          i.digest ?? null,
        ]),
      );
    },

    async uninstall(scope, connectorId) {
      return tx(scope.tenantId, async (client) => {
        const { rowCount } = await client.query("DELETE FROM aaply_connect.installations WHERE tenant_id = $1 AND app_id = $2 AND environment_id = $3 AND connector_id = $4", [
          ...scopeParams(scope),
          connectorId,
        ]);
        return (rowCount ?? 0) > 0;
      });
    },

    async installations(scope) {
      return tx(scope.tenantId, async (client) => {
        const { rows } = await client.query(
          "SELECT id, connector_id, kind, definition, digest FROM aaply_connect.installations WHERE tenant_id = $1 AND app_id = $2 AND environment_id = $3 ORDER BY connector_id",
          scopeParams(scope),
        );
        return rows.map((r) => ({ id: r.id, connectorId: r.connector_id, kind: r.kind, definition: r.definition ?? null, digest: r.digest ?? null }));
      });
    },

    async setPolicy(scope, change) {
      await tx(scope.tenantId, (client) =>
        client.query(
          `INSERT INTO aaply_connect.policy (tenant_id, app_id, environment_id, disabled, denied) VALUES ($1, $2, $3, coalesce($4::boolean, false), coalesce($5::text[], '{}'))
           ON CONFLICT (tenant_id, app_id, environment_id) DO UPDATE SET
             disabled = coalesce($4::boolean, aaply_connect.policy.disabled), denied = coalesce($5::text[], aaply_connect.policy.denied), version = aaply_connect.policy.version + 1`,
          [...scopeParams(scope), change.disabled ?? null, change.denied ? [...change.denied] : null],
        ),
      );
    },

    async setGlobalDisabled(disabled) {
      await pool.query("UPDATE aaply_connect.global_policy SET disabled = $1, version = version + 1", [disabled]);
    },

    async insertConnection(c, secret) {
      return tx(c.scope.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO aaply_connect.connections (id, tenant_id, app_id, environment_id, connector_id, owner_subject, role, environment_kind, granted_scopes, account, config)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
          [c.id, ...scopeParams(c.scope), c.connectorId, c.ownerSubject, c.role, c.environmentKind, [...c.grantedScopes], c.account, c.config],
        );
        if (secret) {
          await client.query("INSERT INTO aaply_connect.secrets (connection_id, tenant_id, data_key_id, iv, sealed) VALUES ($1, $2, $3, $4, $5)", [
            c.id,
            c.scope.tenantId,
            secret.dataKeyId,
            Buffer.from(secret.iv),
            Buffer.from(secret.sealed),
          ]);
        }
        return connectionOf(rows[0]);
      });
    },

    async updateConnection(tenantId, id, expectedVersion, change, seal) {
      // Sealing reads the tenant's data key in its own transaction, so it runs before this one.
      const sealed = seal ? await seal(expectedVersion + 1) : null;
      return tx(tenantId, async (client) => {
        const { rows } = await client.query(
          `UPDATE aaply_connect.connections SET
             status = coalesce($3, status), granted_scopes = coalesce($4, granted_scopes), account = coalesce($5, account), config = coalesce($6, config),
             version = version + 1, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND version = $7 AND status <> 'revoked' RETURNING ${COLUMNS}`,
          [tenantId, id, change.status ?? null, change.grantedScopes ? [...change.grantedScopes] : null, change.account ?? null, change.config ?? null, expectedVersion],
        );
        if (rows.length === 0) throw new StoreConflict(`connection ${id} is not at version ${expectedVersion}, or is revoked`);
        if (sealed) {
          await client.query(
            `INSERT INTO aaply_connect.secrets (connection_id, tenant_id, data_key_id, iv, sealed) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (connection_id) DO UPDATE SET data_key_id = EXCLUDED.data_key_id, iv = EXCLUDED.iv, sealed = EXCLUDED.sealed`,
            [id, tenantId, sealed.dataKeyId, Buffer.from(sealed.iv), Buffer.from(sealed.sealed)],
          );
        }
        return connectionOf(rows[0]);
      });
    },

    async revokeConnection(tenantId, id) {
      return tx(tenantId, async (client) => {
        await client.query("DELETE FROM aaply_connect.secrets WHERE tenant_id = $1 AND connection_id = $2", [tenantId, id]);
        const { rows } = await client.query(
          `UPDATE aaply_connect.connections SET status = 'revoked', version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
          [tenantId, id],
        );
        return rows[0] ? connectionOf(rows[0]) : null;
      });
    },

    async connection(tenantId, id) {
      return tx(tenantId, async (client) => {
        const { rows } = await client.query(`SELECT ${COLUMNS} FROM aaply_connect.connections WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
        return rows[0] ? connectionOf(rows[0]) : null;
      });
    },

    async connections(scope, filter = {}) {
      return tx(scope.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT ${COLUMNS} FROM aaply_connect.connections WHERE tenant_id = $1 AND app_id = $2 AND environment_id = $3
             AND ($4::text IS NULL OR connector_id = $4) AND ($5::text IS NULL OR owner_subject = $5) ORDER BY created_at, id`,
          [...scopeParams(scope), filter.connectorId ?? null, filter.ownerSubject ?? null],
        );
        return rows.map(connectionOf);
      });
    },

    async purgeExpired(limit = 1000) {
      const { rows } = await pool.query("SELECT aaply_connect.purge_expired($1) AS n", [limit]);
      return Number(rows[0]?.n ?? 0);
    },

    async check() {
      const { rows } = await pool.query(
        `SELECT (SELECT schema_version FROM aaply_connect.meta) AS version, r.rolsuper, r.rolbypassrls, pg_has_role(current_user, $1, 'MEMBER') AS member,
                EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'aaply_connect' AND pg_get_userbyid(c.relowner) = current_user) AS owns
         FROM pg_roles r WHERE r.rolname = current_user`,
        [APP_ROLE],
      );
      const row = rows[0];
      if (!row) throw new Error("cannot read the login role");
      if (row.version !== SCHEMA_VERSION) throw new Error(`the database has Connect schema ${row.version}; this build needs ${SCHEMA_VERSION}. Pre-1.0 builds do not migrate: make a new database.`);
      if (row.rolsuper || row.rolbypassrls) throw new Error("the login role can bypass row security; use a role that is only a member of aaply_connect_app");
      if (row.owns) throw new Error("the login role owns Connect's tables, so row security does not bind it; use a role that is only a member of aaply_connect_app");
      if (!row.member) throw new Error("the login role is not a member of aaply_connect_app");
    },
  };
}
