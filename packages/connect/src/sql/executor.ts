/**
 * Runs declared statements against a customer's PostgreSQL.
 *
 * Each connection gets one small pool (default 2 sockets), made on first
 * use, closed after 60 s idle, at most 200 per instance (least recently used
 * closed first). Its address is resolved once and checked by the egress
 * policy, and the pool connects to that address (TLS still checks the host
 * name), so a name that changes its answer cannot move the pool. Plain TCP
 * without TLS is allowed only to a private address the operator allowlisted.
 *
 * Outcomes: anything that fails before COMMIT was rolled back, so it is
 * `retryable` (timeouts, serialization failures, deadlocks, a lost
 * connection, a full pool) or `final` (a declared error, a constraint, bad
 * SQL). Only a failure during COMMIT of a write is `unknown`.
 */

import { isIP } from "node:net";
import pg from "pg";
import { ConnectorError } from "@aaply/connector-sdk";
import { egressPolicy, type EgressPolicy } from "../egress.js";
import { MAX_SQL_ROWS, type SqlOperation, type SqlStatement } from "./definition.js";

/** Where a SQL connection points: its `config`. The password is the secret's `password`. */
export interface SqlTarget {
  host: string;
  port?: number;
  database: string;
  user: string;
  /** `verify-full` (default) checks the server's certificate and name; `disable` only to an allowlisted private address. */
  tls?: "verify-full" | "disable";
  /** A PEM CA for a server with its own certificate authority. */
  ca?: string;
  /** `transaction` for PgBouncer before 1.21 in transaction mode: no named prepared statements. */
  pooler?: "session" | "transaction";
}

export function sqlTargetProblem(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "a SQL connection's config is { host, port?, database, user, tls?, ca?, pooler? }";
  const c = config as Record<string, unknown>;
  if (typeof c.host !== "string" || !/^[A-Za-z0-9.:-]{1,253}$/.test(c.host)) return "host is a host name or an IP address";
  if (c.port !== undefined && (!Number.isInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65535)) return "port is 1-65535";
  if (typeof c.database !== "string" || c.database.length === 0 || c.database.length > 63) return "database is 1-63 characters";
  if (typeof c.user !== "string" || c.user.length === 0 || c.user.length > 63) return "user is 1-63 characters";
  if (c.tls !== undefined && c.tls !== "verify-full" && c.tls !== "disable") return "tls is verify-full or disable";
  if (c.ca !== undefined && (typeof c.ca !== "string" || !c.ca.includes("BEGIN CERTIFICATE"))) return "ca is a PEM certificate";
  if (c.pooler !== undefined && c.pooler !== "session" && c.pooler !== "transaction") return "pooler is session or transaction";
  return null;
}

export interface SqlExecutorOptions {
  egress: EgressPolicy;
  /** Sockets per connection's pool. Default 2. */
  poolSize?: number;
  /** Pools kept per instance. Default 200. */
  maxPools?: number;
  /** Close a pool idle this long, in ms. Default 60 000. */
  idleMs?: number;
}

export interface SqlCall {
  /** One pool per connection and version: a changed config or password gets a new pool. */
  poolKey: string;
  target: SqlTarget;
  password: string;
  op: SqlOperation;
  /** The digest that names the prepared statement. */
  name: string;
  input: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  deadline: number;
  now: number;
}

export interface SqlExecutor {
  run(call: SqlCall): Promise<unknown>;
  close(): Promise<void>;
}

const RETRYABLE_STATES = new Set(["40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03", "53000", "53100", "53200", "53300", "53400"]);
const FINAL_STATES: Readonly<Record<string, [string, string]>> = {
  "28P01": ["sql/auth-failed", "The database refused the connection's credentials."],
  "28000": ["sql/auth-failed", "The database refused the connection's credentials."],
  "3D000": ["sql/no-database", "The database does not exist."],
  "42501": ["sql/permission-denied", "The database role may not do this."],
  "25006": ["sql/read-only", "A read tried to change the database."],
};

const stateOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

/** The outcome of an error raised before COMMIT (everything was rolled back). */
function beforeCommit(error: unknown, op: SqlOperation): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const state = stateOf(error);
  const declared = state ? op.errors?.[state] : undefined;
  if (declared) return new ConnectorError("final", declared, "The database refused this.", { detail: `SQLSTATE ${state}` });
  if (state === null) return new ConnectorError("retryable", "sql/connection-lost", "The database could not be reached.");
  if (RETRYABLE_STATES.has(state) || state.startsWith("08")) return new ConnectorError("retryable", state === "57014" ? "sql/timeout" : "sql/busy", "The database is busy; try again.", { detail: `SQLSTATE ${state}` });
  const known = FINAL_STATES[state];
  if (known) return new ConnectorError("final", known[0], known[1], { detail: `SQLSTATE ${state}` });
  return new ConnectorError("final", `sql/${state.toLowerCase()}`, "The database refused this statement.", { detail: `SQLSTATE ${state}` });
}

/** The outcome of an error during COMMIT. */
function atCommit(error: unknown, op: SqlOperation): ConnectorError {
  const state = stateOf(error);
  // Serialization and deferred-constraint failures at COMMIT roll back; anything else may have committed.
  if (state && (state === "40001" || state === "40P01" || state.startsWith("23") || op.errors?.[state])) return beforeCommit(error, op);
  if (op.effect === "read") return new ConnectorError("retryable", "sql/connection-lost", "The database could not be reached.");
  return new ConnectorError("unknown", "sql/commit-unknown", "The database did not confirm the change.");
}

/** A row as plain JSON: dates as ISO text, bytes as base64, big numbers as text. */
function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = Number.isNaN(v.getTime()) ? null : v.toISOString();
    else if (Buffer.isBuffer(v)) out[k] = v.toString("base64");
    else if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

export function createSqlExecutor(options: SqlExecutorOptions): SqlExecutor {
  const pools = new Map<string, pg.Pool>();
  const maxPools = options.maxPools ?? 200;

  async function address(target: SqlTarget): Promise<{ ip: string; isPrivate: boolean }> {
    const check = (ip: string) => {
      const problem = options.egress.check(ip, target.host);
      if (problem) throw new ConnectorError("final", "sql/egress-denied", "This database address is not allowed.", { detail: problem });
    };
    if (isIP(target.host) !== 0) {
      check(target.host);
      return { ip: target.host, isPrivate: egressBlockedWithoutAllowlist(target.host) };
    }
    const ip = await new Promise<string>((resolve, reject) =>
      options.egress.lookup(target.host, { all: true }, (error, addresses) => {
        if (error) {
          const egress = (error as { egressRefused?: unknown }).egressRefused === true;
          reject(egress ? new ConnectorError("final", "sql/egress-denied", "This database address is not allowed.", { detail: error.message }) : new ConnectorError("retryable", "sql/connection-lost", "The database host could not be resolved."));
        } else resolve((addresses as Array<{ address: string }>)[0]!.address);
      }),
    );
    return { ip, isPrivate: egressBlockedWithoutAllowlist(ip) };
  }

  // The policy with no allowlist: an address it refuses is private, reached only through the operator's allowlist.
  const strict = egressPolicy();
  const egressBlockedWithoutAllowlist = (ip: string) => strict.check(ip, "") !== null;

  async function poolFor(call: SqlCall): Promise<pg.Pool> {
    const existing = pools.get(call.poolKey);
    if (existing) {
      pools.delete(call.poolKey);
      pools.set(call.poolKey, existing);
      return existing;
    }
    const { ip, isPrivate } = await address(call.target);
    const tls = call.target.tls ?? "verify-full";
    if (tls === "disable" && !isPrivate) throw new ConnectorError("final", "sql/tls-required", "A database on the internet must use TLS.");
    const pool = new pg.Pool({
      host: ip,
      port: call.target.port ?? 5432,
      database: call.target.database,
      user: call.target.user,
      password: call.password,
      ssl: tls === "disable" ? false : { servername: call.target.host, rejectUnauthorized: true, ...(call.target.ca ? { ca: call.target.ca } : {}) },
      max: options.poolSize ?? 2,
      idleTimeoutMillis: options.idleMs ?? 60_000,
      maxLifetimeSeconds: 600,
      connectionTimeoutMillis: 10_000,
      application_name: "aaply-connect",
    });
    pool.on("error", () => {});
    const raced = pools.get(call.poolKey);
    if (raced) {
      void pool.end().catch(() => {});
      return raced;
    }
    pools.set(call.poolKey, pool);
    while (pools.size > maxPools) {
      const [oldest, p] = pools.entries().next().value as [string, pg.Pool];
      pools.delete(oldest);
      void p.end().catch(() => {});
    }
    return pool;
  }

  async function checkout(pool: pg.Pool, signal: AbortSignal): Promise<pg.PoolClient> {
    if (signal.aborted) throw new ConnectorError("retryable", "sql/timeout", "There was no time left to reach the database.");
    const pending = pool.connect();
    return new Promise((resolve, reject) => {
      const stop = () => {
        // The socket arrives later; give it back then.
        pending.then((c) => c.release(), () => {});
        reject(new ConnectorError("retryable", "sql/busy", "The database connection is busy; try again.", { limit: "connection" }));
      };
      signal.addEventListener("abort", stop, { once: true });
      pending.then(
        (client) => {
          signal.removeEventListener("abort", stop);
          if (signal.aborted) return;
          resolve(client);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", stop);
          const state = stateOf(error);
          if (state && FINAL_STATES[state]) reject(new ConnectorError("final", FINAL_STATES[state]![0], FINAL_STATES[state]![1], { detail: `SQLSTATE ${state}` }));
          else if (/timeout/i.test(String((error as Error)?.message))) reject(new ConnectorError("retryable", "sql/busy", "The database connection is busy; try again.", { limit: "connection" }));
          else reject(new ConnectorError("retryable", "sql/connection-lost", "The database could not be reached."));
        },
      );
    });
  }

  const values = (s: SqlStatement, input: Readonly<Record<string, unknown>>) => s.params.map((p) => (input[p] === undefined ? null : input[p]));
  const query = (client: pg.PoolClient, call: SqlCall, s: SqlStatement, suffix: string) =>
    client.query(call.target.pooler === "transaction" ? { text: s.statement, values: values(s, call.input) } : { name: `aaply_${call.name.slice(7, 31)}${suffix}`, text: s.statement, values: values(s, call.input) });

  return {
    async run(call) {
      const op = call.op;
      const pool = await poolFor(call);
      const client = await checkout(pool, call.signal);
      let broken = false;
      let committing = false;
      try {
        // Leave the last 250 ms of the budget to answer.
        const ms = Math.max(1, Math.floor(call.deadline - call.now - 250));
        await client.query(`BEGIN${op.effect === "read" ? " READ ONLY" : ""}; SET LOCAL statement_timeout = ${ms}; SET LOCAL lock_timeout = ${ms}`);
        const result = await query(client, call, op, "");
        let rows = result.rows as Record<string, unknown>[];
        if (op.onConflictEmpty && rows.length === 0) {
          rows = (await query(client, call, op.onConflictEmpty, "_c")).rows as Record<string, unknown>[];
          if (rows.length === 0) throw new ConnectorError("final", "sql/reference-reused", "This reference was already used with other details.");
        }
        const limit = op.rows === "many" ? Math.min(op.maxRows ?? 100, MAX_SQL_ROWS) : 1;
        if (op.rows === "one" && rows.length !== 1) throw new ConnectorError("final", rows.length === 0 ? "sql/no-row" : "sql/too-many-rows", rows.length === 0 ? "Nothing matched." : "More than one row matched.");
        if (op.rows === "optional" && rows.length > 1) throw new ConnectorError("final", "sql/too-many-rows", "More than one row matched.");
        if (op.rows === "many" && rows.length > limit) throw new ConnectorError("final", "sql/too-many-rows", `More than ${limit} rows matched.`);
        committing = true;
        await client.query("COMMIT");
        if (op.rows === "one") return plainRow(rows[0]!);
        if (op.rows === "optional") return { row: rows[0] ? plainRow(rows[0]) : null };
        if (op.rows === "many") return { rows: rows.map(plainRow) };
        return { rowCount: result.rowCount ?? 0 };
      } catch (error) {
        broken = stateOf(error) === null && !(error instanceof ConnectorError);
        if (!committing) {
          await client.query("ROLLBACK").catch(() => (broken = true));
          throw beforeCommit(error, op);
        }
        broken = true;
        throw atCommit(error, op);
      } finally {
        client.release(broken);
      }
    },
    async close() {
      const all = [...pools.values()];
      pools.clear();
      await Promise.all(all.map((p) => p.end().catch(() => {})));
    },
  };
}
