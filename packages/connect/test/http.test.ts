import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApprovedAction, type ApprovedAction } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE, draftApprovedAction } from "@aaply/action-contract/conformance";
import { createConnect, type Connect } from "@aaply/connect";
import { serveConnect } from "@aaply/connect/http";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";
import pg from "pg";
import { notesConnector, notesService } from "./support.js";

const TOKEN = "a-transport-token-long-enough-for-the-check-0123";

describe.skipIf(postgresUnavailable())("Connect over HTTP", () => {
  let db: TestDatabase;
  let connect: Connect;
  let engine: Awaited<ReturnType<typeof testEngineKeys>>;

  beforeAll(async () => {
    db = await startTestDatabase();
    engine = await testEngineKeys();
    connect = await createConnect({ audience: "connect.test", engineKeys: engine.engineKeys, connectors: [notesConnector("1.0.0", "v1", { slowMs: 300 })], pool: db.app, keys: testKeyProvider(), fetch: notesService() });
    await connect.admin.install(CONFORMANCE_SCOPE, "notes");
    await connect.admin.createConnection({ scope: CONFORMANCE_SCOPE, connectorId: "notes", owner: { business: true }, secret: { "header:authorization": "Bearer k" } });
  });
  afterAll(async () => {
    await connect?.close();
    await db?.close();
  });

  const serve = async () => {
    const served = await serveConnect(connect, { port: 0, performToken: TOKEN, maxBodyBytes: 64 * 1024 });
    return { served, base: `http://127.0.0.1:${(served.server.address() as { port: number }).port}` };
  };
  const post = (base: string, body: string, token: string | null = TOKEN) =>
    fetch(`${base}/perform`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
  const envelope = async () => {
    const { proof: _p, ...unsigned } = draftApprovedAction({ action: "notes.get", effect: "read", input: { id: "n1" }, now: Date.now(), audience: "connect.test", key: null });
    return signApprovedAction<ApprovedAction>(unsigned, engine.signer);
  };

  it("needs a transport token unless told to run without one", async () => {
    await expect(serveConnect(connect, { port: 0 })).rejects.toThrow(/performToken is required/);
  });

  it("needs the transport token before it reads anything", async () => {
    const { served, base } = await serve();
    try {
      expect((await post(base, "{}", null)).status).toBe(401);
      expect((await post(base, "{}", "wrong-token-of-the-same-length-as-the-real-one!!")).status).toBe(401);
    } finally {
      await served.close();
    }
  });

  it("answers 200 with a refusal for a body that is not JSON or is too large", async () => {
    const { served, base } = await serve();
    try {
      const bad = await post(base, "not json");
      expect(bad.status).toBe(200);
      expect(await bad.json()).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
      const big = await post(base, JSON.stringify({ x: "y".repeat(100 * 1024) }));
      expect(big.status).toBe(200);
      expect(await big.json()).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
    } finally {
      await served.close();
    }
  });

  it("answers health, readiness and describe", async () => {
    const { served, base } = await serve();
    try {
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: "ok" });
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      expect(await (await fetch(`${base}/describe`)).json()).toEqual({ contracts: [1] });
      expect((await fetch(`${base}/nowhere`)).status).toBe(404);
    } finally {
      await served.close();
    }
  });

  it("stays ready while a burst holds every client of the pool, but not when no client came back for 30 s, and answers 503 once the database is gone", async () => {
    const own = await startTestDatabase();
    const pool = new pg.Pool({ host: own.host, port: own.port, user: "connect_app", database: "connect", max: 3, connectionTimeoutMillis: 300 });
    pool.on("error", () => {});
    let now = Date.now();
    const busy = await createConnect({ audience: "connect.test", engineKeys: engine.engineKeys, connectors: [notesConnector("1.0.0", "v1")], pool, keys: testKeyProvider(), fetch: notesService(), now: () => now });
    const served = await serveConnect(busy, { port: 0, performToken: TOKEN });
    const base = `http://127.0.0.1:${(served.server.address() as { port: number }).port}`;
    try {
      // A burst: every client is checked out, so the readiness query waits connectionTimeoutMillis and gets none.
      // A query came back moments ago (createConnect's own), so the pool is busy with work: ready.
      const sleeps = Array.from({ length: 3 }, () => pool.query("SELECT pg_sleep(3)"));
      while (pool.totalCount < 3 || pool.idleCount > 0) await new Promise((r) => setTimeout(r, 10));
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      // Still every client held, and none came back for over 30 s: stuck (a half-open socket after a failover), not busy.
      now += 31_000;
      expect(pool.idleCount).toBe(0);
      expect((await fetch(`${base}/ready`)).status).toBe(503);
      // The clients come back, and the next probe after the answer that stands finds the pool well.
      await Promise.all(sleeps);
      now += 10_000;
      expect((await fetch(`${base}/ready`)).status).toBe(200);

      // The database stops. The answer stands for a few seconds, then the next probe finds it gone.
      await own.close();
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      now += 10_000;
      expect((await fetch(`${base}/ready`)).status).toBe(503);
    } finally {
      await served.close();
      await busy.close();
      await pool.end().catch(() => {});
      await own.close();
    }
  });

  it("finishes calls in flight when it shuts down", async () => {
    const { served, base } = await serve();
    const call = post(base, JSON.stringify(await envelope()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = served.close();
    const answer = await call;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ status: "ok" });
    await closing;
  });
});
