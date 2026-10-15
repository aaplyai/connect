/**
 * Runs declared statements against a customer's PostgreSQL.
 *
 * Each connection gets one small pool (default 2 sockets), made on first
 * use; a pool whose sockets all closed after 60 s idle is dropped. At most
 * 200 pools per instance and 20 per tenant (least recently used closed
 * first). Its address is resolved once and checked by the egress policy, and
 * the pool connects to that address (TLS still checks the host name), so a
 * name that changes its answer cannot move the pool. A private address is
 * reached only by a tenant the operator named (`sqlPrivateTenants`), and
 * only there may TLS be off.
 *
 * Every statement goes with the extended protocol (exactly one command) and
 * `standard_conforming_strings` on; a call reads at most 4 MiB from the
 * database, and a session's state is discarded after each call.
 *
 * Outcomes: anything that fails before COMMIT was rolled back, so it is
 * `retryable` (timeouts, serialization failures, deadlocks, a lost
 * connection, a full pool) or `final` (a declared error, a constraint, bad
 * SQL). A call stopped before COMMIT is sent closes its socket, so the
 * database rolls it back. Once COMMIT of a write is sent, `onCommit` tells
 * the caller, and a failure from then on is `unknown`.
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
  /** `transaction` for a pooler in transaction mode (PgBouncer): session state is not discarded after a call. */
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
  /** Tenants that may reach the operator's private addresses. */
  privateTenants?: readonly string[];
  /** Sockets per connection's pool. Default 2. */
  poolSize?: number;
  /** Pools kept per instance. Default 200. */
  maxPools?: number;
  /** Pools kept per tenant. Default 20. */
  maxPoolsPerTenant?: number;
  /** Close a socket idle this long, in ms. Default 60 000. */
  idleMs?: number;
  /** Most bytes one call reads from the database. Default 4 MiB. */
  maxResultBytes?: number;
}

export interface SqlCall {
  tenantId: string;
  /** One pool per connection and version: a changed config or password gets a new pool. */
  poolKey: string;
  target: SqlTarget;
  password: string;
  op: SqlOperation;
  input: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  /** When the call must have answered (epoch ms): the database's timeouts end before it. */
  deadline: number;
  now: number;
  /** Called just before COMMIT of a write is sent: from then on, the write may have applied. */
  onCommit?(): void;
  /** Called when a failed COMMIT certainly rolled back (a serialization or deferred constraint failure). */
  onRolledBack?(): void;
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

/** The SQLSTATE of an error the database sent; null for anything else (a socket error's `EPIPE` is not one). */
const stateOf = (error: unknown): string | null => (error instanceof pg.DatabaseError && typeof error.code === "string" ? error.code : null);

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
  // Serialization, deadlock and deferred-constraint failures at COMMIT roll back; anything else may have committed.
  if (state && (state === "40001" || state === "40P01" || state.startsWith("23"))) return beforeCommit(error, op);
  if (op.effect === "read") return new ConnectorError("retryable", "sql/connection-lost", "The database could not be reached.");
  return new ConnectorError("unknown", "sql/commit-unknown", "The database did not confirm the change.");
}

/** A value as plain JSON: dates as ISO text, bytes as base64, big and non-finite numbers as text, at any depth. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** Dates and timestamps without a zone stay as the database wrote them: parsing them would shift them by Connect's own zone. */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 1082 || oid === 1114) return (text: string) => text;
    if (oid === 1182 || oid === 1115) return pg.types.getTypeParser(1009 as Parameters<typeof pg.types.getTypeParser>[0], format as "text"); // as text[]
    return pg.types.getTypeParser(oid, format as "text");
  },
};

interface Held {
  pool: pg.Pool;
  tenantId: string;
  /** Calls between poolFor and the end of their checkout: pg-pool does not count them as waiting until connect() runs. */
  users: number;
}

export function createSqlExecutor(options: SqlExecutorOptions): SqlExecutor {
  const pools = new Map<string, Held>();
  const maxPools = options.maxPools ?? 200;
  const perTenant = options.maxPoolsPerTenant ?? 20;
  const maxBytes = options.maxResultBytes ?? 4 * 1024 * 1024;
  const privateTenants = new Set(options.privateTenants ?? []);
  let closed = false;
  const quiet = new WeakSet<pg.PoolClient>();

  // The policy with no allowlist: an address it refuses is private, reached only through the operator's allowlist.
  const strict = egressPolicy();
  const isPrivate = (ip: string) => strict.check(ip, "") !== null;
  const denied = (detail: string) => new ConnectorError("final", "sql/egress-denied", "This database address is not allowed.", { detail });

  async function address(target: SqlTarget): Promise<string> {
    if (isIP(target.host) !== 0) {
      const problem = options.egress.check(target.host, target.host);
      if (problem) throw denied(problem);
      return target.host;
    }
    return new Promise<string>((resolve, reject) =>
      options.egress.lookup(target.host, { all: true }, (error, addresses) => {
        if (error) {
          const egress = (error as { egressRefused?: unknown }).egressRefused === true;
          reject(egress ? denied(error.message) : new ConnectorError("retryable", "sql/connection-lost", "The database host could not be resolved."));
        } else resolve((addresses as Array<{ address: string }>)[0]!.address);
      }),
    );
  }

  const drop = (key: string, held: Held) => {
    if (pools.get(key) === held) pools.delete(key);
    void held.pool.end().catch(() => {});
  };

  /** The pool for a call's database, counted as in use until the caller's checkout settles (see `users`). */
  async function poolFor(call: SqlCall): Promise<Held> {
    if (closed) throw new ConnectorError("retryable", "sql/closing", "Connect is shutting down.");
    const existing = pools.get(call.poolKey);
    if (existing) {
      pools.delete(call.poolKey);
      pools.set(call.poolKey, existing);
      existing.users++;
      return existing;
    }
    const ip = await address(call.target);
    if (closed) throw new ConnectorError("retryable", "sql/closing", "Connect is shutting down.");
    const priv = isPrivate(ip);
    if (priv && !privateTenants.has(call.tenantId)) throw denied(`${ip} is private; this tenant may not reach private addresses`);
    const tls = call.target.tls ?? "verify-full";
    if (tls === "disable" && !priv) throw new ConnectorError("final", "sql/tls-required", "A database on the internet must use TLS.");
    const password = call.password;
    const pool = new pg.Pool({
      host: ip,
      port: call.target.port ?? 5432,
      database: call.target.database,
      user: call.target.user,
      // A function, so pg never falls back to PGPASSWORD or ~/.pgpass (Connect's own credentials).
      password: () => password,
      ssl: tls === "disable" ? false : { ...(isIP(call.target.host) === 0 ? { servername: call.target.host } : {}), rejectUnauthorized: true, ...(call.target.ca ? { ca: call.target.ca } : {}) },
      types,
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
      raced.users++;
      return raced;
    }
    const held: Held = { pool, tenantId: call.tenantId, users: 1 };
    // A pool whose last socket closed (idle) is dropped, so old keys do not pile up.
    // Checked a tick later: pg-pool serves waiting callers after it reports the removal.
    pool.on("remove", () =>
      setImmediate(() => {
        if (pool.totalCount === 0 && pool.waitingCount === 0 && held.users === 0) drop(call.poolKey, held);
      }),
    );
    pools.set(call.poolKey, held);
    // Room is made by dropping the least recently used pool that nothing uses: pg-pool never serves a call already queued
    // on a pool it is ending, so a busy pool stays (its idle timer reaps it later) and the cap is exceeded for that long.
    // A pool is in use from poolFor until its checkout settles, not only once pg-pool counts the call as waiting.
    // So a tenant whose pools are all busy may hold more than perTenant for a while; the in-flight caps bound that.
    const idle = (h: Held) => h.users === 0 && h.pool.waitingCount === 0 && h.pool.idleCount === h.pool.totalCount;
    const mine = [...pools].filter(([, h]) => h.tenantId === call.tenantId);
    if (mine.length > perTenant) {
      const victim = mine.find(([, h]) => h !== held && idle(h));
      if (victim) drop(victim[0], victim[1]);
    }
    if (pools.size > maxPools) {
      for (const [key, h] of pools) {
        if (pools.size <= maxPools) break;
        if (h !== held && idle(h)) drop(key, h);
      }
    }
    return held;
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
  // The extended protocol runs exactly one command: nothing the scanner missed can stack a second.
  const query = (client: pg.PoolClient, call: SqlCall, s: SqlStatement) => client.query({ text: s.statement, values: values(s, call.input), queryMode: "extended" } as pg.QueryConfig);

  return {
    async run(call) {
      const op = call.op;
      if (!call.password) throw new ConnectorError("final", "sql/no-credentials", "The database connection has no password.");
      const held = await poolFor(call);
      let client: pg.PoolClient;
      try {
        client = await checkout(held.pool, call.signal);
      } finally {
        held.users--;
      }
      // A socket this call closes (or the server drops) errors on the client; the query's own rejection carries it.
      if (!quiet.has(client)) {
        quiet.add(client);
        client.on("error", () => {});
      }
      const socket = (client as unknown as { connection: { stream: NodeJS.ReadableStream & { destroy(): void } } }).connection.stream;
      let broken = false;
      let committing = false;
      let tooLarge = false;
      let stopped = false;
      let received = 0;
      // What the database sends is counted, and a call that reads too much is cut off before it fills memory.
      const count = (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes && !committing) {
          tooLarge = true;
          socket.destroy();
        }
      };
      // Stopped before COMMIT is sent: close the socket, so the database rolls the transaction back.
      const stop = () => {
        if (committing) return;
        stopped = true;
        socket.destroy();
      };
      socket.on("data", count);
      call.signal.addEventListener("abort", stop, { once: true });
      try {
        if (call.signal.aborted) stop();
        // Leave the last 250 ms of the budget to answer.
        const ms = Math.max(1, Math.floor(call.deadline - call.now - 250));
        await client.query(`BEGIN${op.effect === "read" ? " READ ONLY" : ""}; SET LOCAL statement_timeout = ${ms}; SET LOCAL lock_timeout = ${ms}; SET LOCAL standard_conforming_strings = on`);
        const result = await query(client, call, op);
        let rows = result.rows as Record<string, unknown>[];
        if (op.onConflictEmpty && rows.length === 0) {
          rows = (await query(client, call, op.onConflictEmpty)).rows as Record<string, unknown>[];
          if (rows.length === 0) throw new ConnectorError("final", "sql/reference-reused", "This reference was already used with other details.");
        }
        const limit = op.rows === "many" ? Math.min(op.maxRows ?? 100, MAX_SQL_ROWS) : 1;
        if (op.rows === "one" && rows.length !== 1) throw new ConnectorError("final", rows.length === 0 ? "sql/no-row" : "sql/too-many-rows", rows.length === 0 ? "Nothing matched." : "More than one row matched.");
        if (op.rows === "optional" && rows.length > 1) throw new ConnectorError("final", "sql/too-many-rows", "More than one row matched.");
        if (op.rows === "many" && rows.length > limit) throw new ConnectorError("final", "sql/too-many-rows", `More than ${limit} rows matched.`);
        if (call.signal.aborted || stopped) throw new ConnectorError("retryable", "sql/timeout", "The call ran out of time before it committed.");
        committing = true;
        if (op.effect === "write") call.onCommit?.();
        await client.query("COMMIT");
        if (op.rows === "one") return plain(rows[0]!);
        if (op.rows === "optional") return { row: rows[0] ? plain(rows[0]) : null };
        if (op.rows === "many") return { rows: rows.map(plain) };
        return { rowCount: result.rowCount ?? 0 };
      } catch (error) {
        // A socket error, or one this call cut off, leaves the socket unusable; a database's refusal or the call's own answer does not.
        broken = broken || stopped || tooLarge || (!(error instanceof ConnectorError) && stateOf(error) === null);
        if (!committing) {
          if (!stopped && !tooLarge) await client.query("ROLLBACK").catch(() => (broken = true));
          if (tooLarge) throw new ConnectorError("final", "sql/result-too-large", `The database answered more than ${maxBytes} bytes.`);
          if (stopped) throw new ConnectorError("retryable", "sql/timeout", "The call ran out of time before it committed.");
          throw beforeCommit(error, op);
        }
        broken = true;
        const outcome = atCommit(error, op);
        if (outcome.kind !== "unknown") call.onRolledBack?.();
        throw outcome;
      } finally {
        socket.removeListener("data", count);
        call.signal.removeEventListener("abort", stop);
        if (!broken && call.target.pooler !== "transaction") {
          // Locks, settings and temporary tables a statement left behind, whether it succeeded or not, do not reach the next call.
          await client.query("DISCARD ALL").catch(() => (broken = true));
        }
        client.release(broken);
      }
    },
    async close() {
      closed = true;
      const all = [...pools.values()];
      pools.clear();
      await Promise.all(all.map((h) => h.pool.end().catch(() => {})));
    },
  };
}
