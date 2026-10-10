import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApprovedAction, type ApprovedAction } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE, draftApprovedAction } from "@aaply/action-contract/conformance";
import { createConnect, type Connect } from "@aaply/connect";
import { serveConnect } from "@aaply/connect/http";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";
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
