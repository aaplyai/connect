/**
 * What the OAuth module keeps in the store: connection attempts (through
 * the SQL functions that alone touch them), refresh leases, and a
 * connection's sealed secret as it is now.
 */

import type pg from "pg";
import type { JsonObject } from "@aaply/action-contract";
import type { SealedSecret, WrappedDataKey } from "../vault.js";
import type { ConnectionStatus } from "./store.js";

export interface OAuthAttempt {
  tenantId: string;
  request: JsonObject;
  verifier: string;
}

export interface CurrentSecret {
  version: number;
  status: ConnectionStatus;
  secret: { sealed: SealedSecret; dataKey: WrappedDataKey } | null;
}

export interface OAuthStore {
  createAttempt(id: string, tenantId: string, request: JsonObject, verifier: string, ttlMs: number): Promise<void>;
  /** Binds the attempt to a browser (by its nonce's hash), once; null when unknown, expired or already begun. */
  beginAttempt(id: string, nonceHash: string): Promise<OAuthAttempt | null>;
  /** Takes the attempt, once, for the browser that began it; null otherwise. */
  takeAttempt(id: string, nonceHash: string): Promise<OAuthAttempt | null>;
  /** Takes the connection's refresh lease for `ms`, unless another holder's has not run out. */
  takeLease(tenantId: string, connectionId: string, holder: string, ms: number): Promise<boolean>;
  releaseLease(tenantId: string, connectionId: string, holder: string): Promise<void>;
  /** The connection's version, status and sealed secret now. */
  current(tenantId: string, connectionId: string): Promise<CurrentSecret | null>;
}

const attemptOf = (value: unknown): OAuthAttempt | null => {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return { tenantId: v.tenantId as string, request: v.request as JsonObject, verifier: v.verifier as string };
};

export function createOAuthStore(pool: pg.Pool): OAuthStore {
  async function asTenant<T>(tenantId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('aaply_connect.tenant', $1, true)", [tenantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async createAttempt(id, tenantId, request, verifier, ttlMs) {
      await pool.query("SELECT aaply_connect.oauth_state_create($1, $2, $3, $4, $5)", [id, tenantId, request, verifier, ttlMs]);
    },
    async beginAttempt(id, nonceHash) {
      const { rows } = await pool.query("SELECT aaply_connect.oauth_state_begin($1, $2) AS a", [id, nonceHash]);
      return attemptOf(rows[0]?.a);
    },
    async takeAttempt(id, nonceHash) {
      const { rows } = await pool.query("SELECT aaply_connect.oauth_state_take($1, $2) AS a", [id, nonceHash]);
      return attemptOf(rows[0]?.a);
    },
    async takeLease(tenantId, connectionId, holder, ms) {
      return asTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO aaply_connect.refresh_leases (connection_id, tenant_id, holder, until) VALUES ($1, $2, $3, now() + make_interval(secs => $4 / 1000.0))
           ON CONFLICT (connection_id) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until WHERE aaply_connect.refresh_leases.until < now()
           RETURNING holder`,
          [connectionId, tenantId, holder, ms],
        );
        return rows.length === 1;
      });
    },
    async releaseLease(tenantId, connectionId, holder) {
      await asTenant(tenantId, (client) => client.query("DELETE FROM aaply_connect.refresh_leases WHERE tenant_id = $1 AND connection_id = $2 AND holder = $3", [tenantId, connectionId, holder]));
    },
    async current(tenantId, connectionId) {
      return asTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT c.version, c.status, s.data_key_id, s.sealed_version, s.iv, s.sealed, k.wrapped, k.wrapping_key_id
           FROM aaply_connect.connections c
           LEFT JOIN aaply_connect.secrets s ON s.connection_id = c.id
           LEFT JOIN aaply_connect.data_keys k ON k.tenant_id = s.tenant_id AND k.data_key_id = s.data_key_id
           WHERE c.tenant_id = $1 AND c.id = $2`,
          [tenantId, connectionId],
        );
        const r = rows[0];
        if (!r) return null;
        return {
          version: r.version as number,
          status: r.status as ConnectionStatus,
          secret: r.sealed
            ? {
                sealed: { dataKeyId: r.data_key_id, version: r.sealed_version, iv: new Uint8Array(r.iv as Buffer), sealed: new Uint8Array(r.sealed as Buffer) },
                dataKey: { dataKeyId: r.data_key_id, wrapped: new Uint8Array(r.wrapped as Buffer), wrappingKeyId: r.wrapping_key_id },
              }
            : null,
        };
      });
    },
  };
}
