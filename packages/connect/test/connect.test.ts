import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOB_REF_SCHEMA, blobDigest, operationDigest, signApprovedAction, type BlobRef, type ApprovedAction, type ApprovedActionSigner, type Scope } from "@aaply/action-contract";
import { actionPortConformance, CONFORMANCE_SCOPE, draftApprovedAction, type ApprovedActionDraft } from "@aaply/action-contract/conformance";
import { defineConnector, memoryBlobStore, operationContractOf } from "@aaply/connector-sdk";
import type { MockFetch } from "@aaply/connector-sdk/testing";
import { createConnect, type Connect } from "@aaply/connect";
import { serveConnect } from "@aaply/connect/http";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";
import pg from "pg";
import { resolveConnectionSql } from "../src/store/schema.js";
import { countingPool, httpPort, notesConnector, notesService } from "./support.js";

const AUDIENCE = "connect.test";
const TOKEN = "a-transport-token-long-enough-for-the-check-0123";
const scope: Scope = CONFORMANCE_SCOPE;
const API_KEY = { "header:authorization": "Bearer key-1" };
const v1 = notesConnector("1.0.0", "v1");
const v2 = notesConnector("1.1.0", "v2");

describe.skipIf(postgresUnavailable())("Connect", () => {
  let db: TestDatabase;
  let engine: { signer: ApprovedActionSigner; engineKeys: Record<string, string> };
  let service: MockFetch;
  let connect: Connect;
  let counter: ReturnType<typeof countingPool>;

  const make = (extra: Partial<Parameters<typeof createConnect>[0]> = {}) =>
    createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [v1, v2], pool: counter.pool, keys, fetch: service, ...extra });
  const keys = testKeyProvider();

  const sign = (draft: Omit<ApprovedActionDraft, "now" | "audience" | "key">): Promise<ApprovedAction> => {
    const { proof: _p, ...unsigned } = draftApprovedAction({ scope, ...draft, now: Date.now(), audience: AUDIENCE, key: null });
    return signApprovedAction<ApprovedAction>(unsigned, engine.signer);
  };
  let seq = 0;
  const read = (extra: Partial<ApprovedActionDraft> = {}) => sign({ action: "notes.get", effect: "read", input: { id: "n1" }, effectId: `e-${++seq}`, ...extra });
  const write = (extra: Partial<ApprovedActionDraft> = {}) => sign({ action: "notes.create", effect: "write", input: { title: "Hi" }, idempotent: false, effectId: `e-${++seq}`, ...extra });

  beforeAll(async () => {
    db = await startTestDatabase();
    engine = await testEngineKeys();
    counter = countingPool(db.app);
    service = notesService();
    connect = await make();
    await connect.admin.install(scope, "notes");
    await connect.admin.createConnection({ scope, connectorId: "notes", owner: { business: true }, secret: API_KEY, account: { name: "Notes HQ" } });
  });
  afterAll(async () => {
    await connect?.close();
    await db?.close();
  });
  beforeEach(() => service.calls.splice(0));

  it("passes the action contract's conformance suite over HTTP", async () => {
    const served = await serveConnect(connect, { port: 0, performToken: TOKEN });
    try {
      const address = served.server.address() as { port: number };
      const port = httpPort(`http://127.0.0.1:${address.port}`, TOKEN);
      const cases = actionPortConformance(port, {
        signer: engine.signer,
        audience: AUDIENCE,
        scope,
        read: { action: "notes.get", input: { id: "n1" }, role: null },
        write: { action: "notes.create", input: { title: "Hi" }, role: null, idempotent: false },
        performedWrite: { action: "notes.create", input: { title: "Hi" }, role: null, idempotent: false },
        undos: [{ action: "notes.remove", input: {}, role: null, undoes: "notes.create", idempotent: true }],
        performed: () => service.calls.length,
      });
      expect(cases.length).toBeGreaterThan(10);
      for (const c of cases) await c.run();
    } finally {
      await served.close();
    }
  });

  it("sends the connection's credential, which the store keeps only sealed", async () => {
    expect(await connect.perform(await read())).toMatchObject({ status: "ok", output: { id: "n1", tag: "v2" } });
    expect(service.calls[0]?.headers.authorization).toBe("Bearer key-1");
    const { rows } = await db.pool("postgres").query("SELECT encode(sealed, 'escape') AS s FROM aaply_connect.secrets");
    expect(rows.length).toBe(1);
    expect(rows[0].s).not.toContain("key-1");
  });

  it("serves the version the flow pinned, the newest when it pinned none, and refuses a pin it does not serve", async () => {
    const pin = (c: typeof v1) => operationDigest(operationContractOf(c, "create")!);
    expect(pin(v1)).not.toBe(pin(v2));
    expect(await connect.perform(await write({ contract: pin(v1) }))).toMatchObject({ status: "ok", output: { tag: "v1" } });
    expect(await connect.perform(await write({ contract: pin(v2) }))).toMatchObject({ status: "ok", output: { tag: "v2" } });
    expect(await connect.perform(await write())).toMatchObject({ status: "ok", output: { tag: "v2" } });
    expect(await connect.perform(await write({ contract: `sha256:${"0".repeat(64)}` as never }))).toMatchObject({ status: "final", error: { code: "connect/contract-mismatch" } });
  });

  it("reads everything a call needs in one store round trip, and claims a write that does not de-duplicate in one more", async () => {
    counter.reset();
    expect((await connect.perform(await read())).status).toBe("ok");
    expect(counter.count()).toBe(1);
    counter.reset();
    expect((await connect.perform(await write())).status).toBe("ok");
    expect(counter.count()).toBe(2);
  });

  it("performs a write once when the same envelope reaches two instances", async () => {
    const other = await make();
    try {
      const sealed = await write();
      expect((await connect.perform(sealed)).status).toBe("ok");
      expect(await other.perform(sealed)).toMatchObject({ status: "final", error: { code: "connect/replayed" } });
      expect(service.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("refuses everything under the kill switches and a denied action, without calling the service", async () => {
    await connect.admin.setGlobalDisabled(true);
    expect(await connect.perform(await read())).toMatchObject({ status: "final", error: { code: "connect/disabled" } });
    await connect.admin.setGlobalDisabled(false);
    await connect.admin.setPolicy(scope, { disabled: true });
    expect(await connect.perform(await read())).toMatchObject({ status: "final", error: { code: "connect/disabled" } });
    await connect.admin.setPolicy(scope, { disabled: false, denied: ["notes.create"] });
    expect(await connect.perform(await write())).toMatchObject({ status: "final", error: { code: "connect/policy-denied" } });
    expect((await connect.perform(await read())).status).toBe("ok");
    await connect.admin.setPolicy(scope, { denied: [] });
    expect(service.calls).toHaveLength(1);
  });

  it("refuses a connector not installed for the scope, and one not in this build", async () => {
    const elsewhere = { ...scope, appId: "another-app" };
    expect(await connect.perform(await read({ scope: elsewhere }))).toMatchObject({ status: "final", error: { code: "connect/unknown-action" } });
    expect(await connect.perform(await sign({ action: "nope.get", effect: "read", input: {} }))).toMatchObject({ status: "final", error: { code: "connect/unknown-action" } });
    await expect(connect.admin.install(scope, "nope")).rejects.toThrow(/no connector nope/);
  });

  it("uses the run's person's own connection when acting for them, and never another's", async () => {
    const people = { ...scope, appId: "people" };
    await connect.admin.install(people, "notes");
    await connect.admin.createConnection({ scope: people, connectorId: "notes", owner: { person: "member:ana" }, secret: { "header:authorization": "Bearer ana" } });
    const forAna = await read({ scope: people, actingFor: "endUser", subject: { domain: "member", id: "ana" } });
    expect((await connect.perform(forAna)).status).toBe("ok");
    expect(service.calls.at(-1)?.headers.authorization).toBe("Bearer ana");
    const forBo = await read({ scope: people, actingFor: "endUser", subject: { domain: "member", id: "bo" } });
    expect(await connect.perform(forBo)).toMatchObject({ status: "final", error: { code: "connect/no-connection" } });
    // A business call never uses a person's connection.
    expect(await connect.perform(await read({ scope: people }))).toMatchObject({ status: "final", error: { code: "connect/no-connection" } });
  });

  it("answers reconsent for a connection that needs it, and connection-revoked once it is revoked", async () => {
    const s = { ...scope, appId: "lifecycle" };
    await connect.admin.install(s, "notes");
    const c = await connect.admin.createConnection({ scope: s, connectorId: "notes", owner: { business: true }, secret: API_KEY });
    // A change that is not a new secret keeps the sealed one readable.
    const scoped = await connect.admin.updateConnection(s.tenantId, c.id, c.version, { grantedScopes: ["x"] });
    expect((await connect.perform(await read({ scope: s }))).status).toBe("ok");
    const after = await connect.admin.updateConnection(s.tenantId, c.id, scoped.version, { status: "reauth" });
    expect(await connect.perform(await read({ scope: s }))).toMatchObject({ status: "final", error: { code: "connect/reconsent" } });
    await expect(connect.admin.updateConnection(s.tenantId, c.id, scoped.version, { status: "active" })).rejects.toThrow(/version/);
    await connect.admin.updateConnection(s.tenantId, c.id, after.version, { status: "active", secret: { "header:authorization": "Bearer rotated" } });
    expect((await connect.perform(await read({ scope: s }))).status).toBe("ok");
    expect(service.calls.at(-1)?.headers.authorization).toBe("Bearer rotated");
    await connect.admin.revokeConnection(s.tenantId, c.id);
    expect(await connect.perform(await read({ scope: s }))).toMatchObject({ status: "final", error: { code: "connect/connection-revoked" } });
    const { rows } = await db.pool("postgres").query("SELECT 1 FROM aaply_connect.secrets WHERE connection_id = $1", [c.id]);
    expect(rows).toHaveLength(0);
  });

  it("does not open a sealed secret moved to another connection", async () => {
    const s = { ...scope, appId: "moved" };
    await connect.admin.install(s, "notes");
    const a = await connect.admin.createConnection({ scope: s, connectorId: "notes", owner: { business: true, role: "a" }, secret: { "header:authorization": "Bearer a" } });
    const b = await connect.admin.createConnection({ scope: s, connectorId: "notes", owner: { business: true, role: "b" }, secret: { "header:authorization": "Bearer b" } });
    await db.pool("postgres").query("UPDATE aaply_connect.secrets SET iv = x.iv, sealed = x.sealed FROM (SELECT iv, sealed FROM aaply_connect.secrets WHERE connection_id = $1) x WHERE connection_id = $2", [a.id, b.id]);
    expect(await connect.perform(await read({ scope: s, role: "b" }))).toMatchObject({ status: "retryable", error: { code: "connect/unavailable" } });
    expect(service.calls).toHaveLength(0);
  });

  it("answers before the envelope's deadline, keeping its margin", async () => {
    const slow = await make({ connectors: [notesConnector("1.0.0", "slow", { slowMs: 10_000 })] });
    try {
      const started = Date.now();
      const outcome = await slow.perform(await read({ timeoutMs: 3_000 }));
      expect(outcome.status).toBe("retryable");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await slow.close();
    }
  });

  it("answers before the deadline when the replay claim stalls", async () => {
    const stalling = new Proxy(db.app, {
      get(target, key, receiver) {
        if (key === "query") {
          return async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("aaply_connect.claim")) await new Promise((r) => setTimeout(r, 8_000));
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, key, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const stalled = await make({ pool: stalling });
    try {
      const started = Date.now();
      const outcome = await stalled.perform(await write({ timeoutMs: 4_000 }));
      expect(outcome.status).toBe("retryable");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(service.calls).toHaveLength(0);
    } finally {
      await stalled.close();
    }
  }, 15_000);

  it("refuses an envelope already inside its answer margin without reading or claiming anything", async () => {
    counter.reset();
    expect(await connect.perform(await write({ timeoutMs: 1_500 }))).toMatchObject({ status: "retryable", error: { code: "connect/late" } });
    expect(counter.count()).toBe(0);
  });

  it("uses only a connection of the call's environment kind", async () => {
    const s = { ...scope, appId: "kinds" };
    await connect.admin.install(s, "notes");
    await connect.admin.createConnection({ scope: s, connectorId: "notes", owner: { business: true }, secret: API_KEY });
    const sandbox = await connect.admin.createConnection({ scope: s, connectorId: "notes", owner: { business: true }, environmentKind: "test", secret: API_KEY });
    await connect.admin.revokeConnection(s.tenantId, sandbox.id);
    expect(await connect.perform(await read({ scope: s, environment: "test" }))).toMatchObject({ status: "final", error: { code: "connect/connection-revoked" } });
    expect(await connect.perform(await read({ scope: s, environment: "preview" }))).toMatchObject({ status: "final", error: { code: "connect/no-connection" } });
    expect((await connect.perform(await read({ scope: s }))).status).toBe("ok");
  });

  it("refuses an envelope signed with HMAC, or with a key it does not pin", async () => {
    const hmac = draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: Date.now(), audience: AUDIENCE, scope });
    expect(await connect.perform(hmac)).toMatchObject({ status: "final", error: { code: "connect/proof-invalid" } });
    const stranger = await testEngineKeys("engine-test");
    const { proof: _p, ...unsigned } = draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: Date.now(), audience: AUDIENCE, scope, key: null });
    expect(await connect.perform(await signApprovedAction(unsigned, stranger.signer))).toMatchObject({ status: "final", error: { code: "connect/proof-invalid" } });
  });

  it("refuses to start as the owner, a member of the owner, or a role that can bypass row security", async () => {
    const start = (pool: typeof db.owner) => createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [v1], pool, keys });
    await expect(start(db.owner)).rejects.toThrow(/owns Connect's schema or tables/);
    const admin = db.pool("postgres");
    await admin.query("CREATE ROLE sneaky LOGIN IN ROLE aaply_connect_app, connect_owner");
    await expect(start(db.pool("sneaky"))).rejects.toThrow(/owns Connect's schema or tables/);
    await admin.query("CREATE ROLE bypasser NOLOGIN BYPASSRLS");
    await admin.query("CREATE ROLE sly LOGIN IN ROLE aaply_connect_app, bypasser");
    await expect(start(db.pool("sly"))).rejects.toThrow(/bypass row security/);
    await admin.query("CREATE ROLE maker LOGIN CREATEROLE IN ROLE aaply_connect_app");
    await expect(start(db.pool("maker"))).rejects.toThrow(/create roles/);
  });

  it("refuses an envelope whose person's domain could read as another person", async () => {
    expect(await connect.perform(await read({ actingFor: "endUser", subject: { domain: "member:ana", id: "x" } }))).toMatchObject({ status: "final", error: { code: "connect/invalid-envelope" } });
  });

  it("keeps tenants apart even when a query forgets its tenant", async () => {
    const { rows } = await db.app.query("SELECT count(*)::int AS n FROM aaply_connect.connections");
    expect(rows[0].n).toBe(0);
    const client = await db.app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('aaply_connect.tenant', 'someone-else', true)");
      expect((await client.query("SELECT count(*)::int AS n FROM aaply_connect.connections")).rows[0].n).toBe(0);
      await expect(client.query("INSERT INTO aaply_connect.policy (tenant_id, app_id, environment_id) VALUES ($1, 'a', 'e')", [scope.tenantId])).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("lists the operation contracts of what a scope has installed, for a host to pin", async () => {
    const ops = await connect.admin.operations(scope);
    expect(Object.keys(ops).sort()).toEqual(["notes.create", "notes.get", "notes.remove"]);
    expect(operationDigest(ops["notes.create"]!)).toBe(operationDigest(operationContractOf(v2, "create")!));
  });

  it("checks the engine's signature once per call", async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "verify");
    try {
      expect((await connect.perform(await read())).status).toBe("ok");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("finds the call's connection by index however many connections there are, also when one app's people hold them all", async () => {
    // The common shape: one scope and connector, many people connected, one business connection. Both lookups are
    // asked of the planner in the very text resolve() runs.
    const admin = db.pool("postgres");
    await admin.query(`INSERT INTO aaply_connect.connections (id, tenant_id, app_id, environment_id, connector_id, owner_subject, environment_kind)
      SELECT 'conn_bulk' || g, 'tenant-bulk', 'app', 'env', 'notes', 'member:' || g, 'production' FROM generate_series(1, 20000) g`);
    await admin.query(`INSERT INTO aaply_connect.connections (id, tenant_id, app_id, environment_id, connector_id, role, environment_kind)
      VALUES ('conn_bulk_business', 'tenant-bulk', 'app', 'env', 'notes', 'default', 'production')`);
    await admin.query("ANALYZE aaply_connect.connections");
    const params = ["'tenant-bulk'", "'app'", "'env'", "'notes'", "'production'"] as const;
    for (const [side, last] of [["endUser", "'member:7'"], ["business", "'default'"]] as const) {
      const plan = await admin.query(`EXPLAIN ${resolveConnectionSql(side, [...params, last])}`);
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text, side).toMatch(/Index Scan|Bitmap Index Scan/);
      expect(text, side).not.toMatch(/Seq Scan/);
    }
    await admin.query("DELETE FROM aaply_connect.connections WHERE id LIKE 'conn_bulk%'");
  });

  it("survives the database dropping its idle sockets, and reports it, when the deployment listens for nothing", async () => {
    const pool = new pg.Pool({ host: db.host, port: db.port, user: "connect_app", database: "connect", max: 4, application_name: "pool-error-test" });
    const uncaught: unknown[] = [];
    const reported: string[] = [];
    const handler = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", handler);
    try {
      const alone = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [v1], pool, keys, observer: { error: (_e, where) => reported.push(where) } });
      expect(await alone.ready()).toBe(true);
      // The database restarts, or a pooler recycles: every idle socket of this pool errors at once.
      await db.pool("postgres").query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pool-error-test'");
      await new Promise((r) => setTimeout(r, 300));
      expect(uncaught).toEqual([]);
      expect(reported).toContain("pool");
      expect(await alone.ready()).toBe(true);
      await alone.close();
    } finally {
      process.off("uncaughtException", handler);
      await pool.end().catch(() => {});
    }
  });

  it("refuses a call past the instance's or the tenant's in-flight cap before reading anything, retryable after a second", async () => {
    const slow = notesConnector("1.0.0", "slow", { slowMs: 800 });
    const busy = await make({ connectors: [slow], maxInFlightPerTenant: 2, maxInFlight: 2 });
    try {
      const first = busy.perform(await read());
      const second = busy.perform(await read());
      await new Promise((r) => setTimeout(r, 50));
      counter.reset();
      expect(await busy.perform(await read())).toMatchObject({ status: "retryable", error: { code: "connect/unavailable" }, retryAfterMs: 1000 });
      expect(counter.count()).toBe(0);
      expect((await first).status).toBe("ok");
      expect((await second).status).toBe("ok");
      // Room again once they answered.
      expect((await busy.perform(await read())).status).toBe("ok");
    } finally {
      await busy.close();
    }
  });

  it("gives handlers the backend's file store, and refuses file references made for another workspace", async () => {
    const copier = defineConnector({
      id: "copier",
      version: "1.0.0",
      title: "Copier",
      auth: { kind: "none" },
      egress: ["GET notes.example.com/v1/notes/*"],
      operations: {
        upper: {
          title: "Upper-case a text file",
          effect: "read",
          input: { type: "object", required: ["file"], properties: { file: BLOB_REF_SCHEMA }, additionalProperties: false },
          output: { type: "object", required: ["file"], properties: { file: BLOB_REF_SCHEMA }, additionalProperties: false },
          async handler(input, ctx) {
            const text = new TextDecoder().decode(await ctx.blobs.get(input.file as unknown as BlobRef));
            const made = await ctx.blobs.put(new TextEncoder().encode(text.toUpperCase()), { mediaType: "text/plain" });
            if (text === "fail") throw new Error("the handler failed after storing a file");
            return { file: made as never };
          },
        },
        fetch: {
          title: "Fetch",
          effect: "read",
          input: { type: "object" },
          output: { type: "object" },
          handler: async (_input, ctx) => (await ctx.http({ url: "https://notes.example.com/v1/notes/n1" })).ensureOk().json() as never,
        },
      },
    });
    const store = memoryBlobStore();
    const files = await make({ connectors: [v1, copier], files: { store } });
    const none = await make({ connectors: [v1, copier] });
    const tight = await make({ connectors: [v1, copier], files: { store, limits: { maxBlobBytes: 4 } }, httpLimits: { maxResponseBytes: 8 } });
    try {
      const s = { ...scope, tenantId: "tenant-files" };
      await files.admin.install(s, "copier");
      await files.admin.createConnection({ scope: s, connectorId: "copier", owner: { business: true }, secret: null });
      const bytes = new TextEncoder().encode("hello");
      const context = { connectorId: "x", operation: "x", connectionId: "x", effectId: null };
      const file = await store.put(s, { bytes, digest: await blobDigest(bytes), size: 5, mediaType: "text/plain" }, context);
      const action = (input: object) => sign({ scope: s, action: "copier.upper", effect: "read", input: input as never, effectId: `e-${++seq}` });

      const done = await files.perform(await action({ file }));
      expect(done.status).toBe("ok");
      const out = (done as unknown as { output: { file: BlobRef } }).output.file;
      expect(new TextDecoder().decode((await store.get(s, out, context))!)).toBe("HELLO");

      const foreign = await store.put(scope, { bytes, digest: await blobDigest(bytes), size: 5, mediaType: "text/plain" }, context);
      expect(await files.perform(await action({ file: foreign }))).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
      const otherApp = await store.put({ ...s, appId: "another-app" }, { bytes, digest: await blobDigest(bytes), size: 5, mediaType: "text/plain" }, context);
      expect(await files.perform(await action({ file: otherApp }))).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
      expect(await none.perform(await action({ file }))).toMatchObject({ status: "final", error: { code: "connect/blob-no-store" } });

      // The limits reach the kit: a 5-byte file is over 4, and a response over 8 bytes is refused.
      expect(await tight.perform(await action({ file }))).toMatchObject({ status: "final", error: { code: "connect/blob-too-large" } });
      expect(await tight.perform(await sign({ scope: s, action: "copier.fetch", effect: "read", input: {}, effectId: `e-${++seq}` }))).toMatchObject({ status: "final", error: { code: "connect/response-too-large" } });

      // A file stored by a call that then failed is deleted, and close waits for the delete.
      const failing = new TextEncoder().encode("fail");
      const input = await store.put(s, { bytes: failing, digest: await blobDigest(failing), size: 4, mediaType: "text/plain" }, context);
      const held = store.count;
      expect((await files.perform(await action({ file: input }))).status).not.toBe("ok");
      await files.close();
      expect(store.count).toBe(held);
      expect(store.deletes.length).toBeGreaterThan(0);
    } finally {
      await files.close();
      await none.close();
      await tight.close();
    }
  });

  it("deletes expired replay claims", async () => {
    await db.pool("postgres").query("INSERT INTO aaply_connect.replay_claims (tenant_id, claim_key, until) SELECT 't', 'k' || g, now() - interval '1 minute' FROM generate_series(1, 12000) g");
    await db.pool("postgres").query("UPDATE aaply_connect.replay_claims SET until = now() - interval '1 minute'");
    expect(await connect.purgeExpired()).toBeGreaterThan(12_000);
    expect((await db.pool("postgres").query("SELECT count(*)::int AS n FROM aaply_connect.replay_claims")).rows[0].n).toBe(0);
  });
});
