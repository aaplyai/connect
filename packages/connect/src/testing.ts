/**
 * `@aaply/connect/testing`: a throwaway PostgreSQL 16 for tests, migrated,
 * with an owner pool and an app pool (a login role that is only a member of
 * `aaply_connect_app`), and an engine key pair to sign envelopes with.
 *
 * It needs the server binaries (`initdb`, `pg_ctl`, `postgres`) in `PG_BIN`
 * (default `/usr/lib/postgresql/16/bin`). Postgres refuses to run as root,
 * so as root the server runs as the `postgres` (or `nobody`) user.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { ed25519ActionSigner, generateEd25519KeyPair, type ApprovedActionSigner } from "@aaply/action-contract";
import { migrate } from "./store/migrate.js";
import { APP_ROLE } from "./store/schema.js";
import { localKeyProvider, type KeyProvider } from "./vault.js";

const PG_BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/16/bin";

/** Why a test database cannot start here, or null when it can (for `describe.skipIf`; CI should fail instead). */
export function postgresUnavailable(): string | null {
  for (const bin of ["initdb", "pg_ctl", "postgres"]) if (!existsSync(join(PG_BIN, bin))) return `Postgres binaries not found in ${PG_BIN} (set PG_BIN)`;
  if (process.getuid?.() === 0 && !serverUser()) return "running as root and no 'postgres' or 'nobody' user to run the server as";
  return null;
}

function serverUser(): { uid: number; gid: number } | null {
  if (process.getuid?.() !== 0) return null;
  let passwd = "";
  try {
    passwd = readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }
  for (const name of ["postgres", "nobody"]) {
    const parts = passwd.split("\n").find((l) => l.startsWith(`${name}:`))?.split(":");
    if (parts && parts.length > 3) return { uid: Number(parts[2]), gid: Number(parts[3]) };
  }
  return null;
}

export interface TestDatabase {
  /** Owns the schema. */
  owner: pg.Pool;
  /** Logs in as `connect_app`, a member of `aaply_connect_app` only. What Connect uses. */
  app: pg.Pool;
  /** A pool for any role or database made in the test. */
  pool(user: string, database?: string): pg.Pool;
  /** The server's unix socket directory, as `host`. */
  host: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts a throwaway server with a migrated `connect` database. With `tcp`,
 * it also listens on 127.0.0.1 at a free port (`port`), for tests that reach
 * it as a customer database would.
 */
export async function startTestDatabase(options: { tcp?: boolean } = {}): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), "aaply-connect-pg-"));
  const user = serverUser();
  if (user) chownSync(dir, user.uid, user.gid);
  const asServer = { ...(user ? { uid: user.uid, gid: user.gid } : {}), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", LANG: "C" }, stdio: "pipe" as const };
  const data = join(dir, "data");
  const log = join(dir, "server.log");
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    if (existsSync(join(data, "postmaster.pid"))) spawnSync(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-s", "stop"], asServer);
    rmSync(dir, { recursive: true, force: true });
  };
  process.on("exit", stop);
  const pools: pg.Pool[] = [];
  const port = options.tcp ? await freePort() : 5432;
  const pool = (u: string, database = "connect") => {
    const p = new pg.Pool({ host: dir, port, user: u, database, max: 10 });
    p.on("error", () => {});
    pools.push(p);
    return p;
  };
  try {
    execFileSync(join(PG_BIN, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale", "-N"], asServer);
    const settings = [`-c listen_addresses='${options.tcp ? "127.0.0.1" : ""}'`, `-c unix_socket_directories=${dir}`, `-p ${port}`, "-c fsync=off", "-c synchronous_commit=off", "-c full_page_writes=off"];
    execFileSync(join(PG_BIN, "pg_ctl"), ["-D", data, "-l", log, "-w", "-s", "-o", settings.join(" "), "start"], asServer);
    const bootstrap = new pg.Client({ host: dir, port, user: "postgres", database: "postgres" });
    await bootstrap.connect();
    await bootstrap.query("CREATE ROLE connect_owner LOGIN CREATEROLE");
    await bootstrap.query("CREATE DATABASE connect OWNER connect_owner");
    await bootstrap.end();
    const owner = pool("connect_owner");
    await migrate(owner);
    await owner.query(`CREATE ROLE connect_app LOGIN IN ROLE ${APP_ROLE}`);
    return {
      owner,
      app: pool("connect_app"),
      pool,
      host: dir,
      port,
      async close() {
        await Promise.all(pools.map((p) => p.end().catch(() => {})));
        stop();
      },
    };
  } catch (error) {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const tail = existsSync(log) ? readFileSync(log, "utf8").slice(-2000) : "";
    stop();
    throw new Error(`could not start Postgres: ${error instanceof Error ? error.message : String(error)}\n${tail}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** An engine key pair for tests: the signer the engine's host would hold, and the key Connect pins. */
export async function testEngineKeys(keyId = "engine-test"): Promise<{ keyId: string; signer: ApprovedActionSigner; engineKeys: Record<string, string> }> {
  const pair = await generateEd25519KeyPair();
  return { keyId, signer: ed25519ActionSigner({ keyId, privateKey: pair.privateKey }), engineKeys: { [keyId]: pair.publicKey } };
}

/** A local key provider with a random key, for tests. */
export function testKeyProvider(): KeyProvider {
  return localKeyProvider({ keyId: "test", key: crypto.getRandomValues(new Uint8Array(32)) });
}
