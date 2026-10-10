import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed25519ActionSigner, generateEd25519KeyPair, type ApprovedActionSigner, type Scope } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE } from "@aaply/action-contract/conformance";
import { AdminError, createConnect, type ActorAdmin, type AdminActor, type Connect } from "@aaply/connect";
import { createAdminClient, serveConnect, type ServedConnect } from "@aaply/connect/http";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";
import { notesConnector } from "./support.js";

const AUDIENCE = "connect.admin-test";
const TOKEN = "a-transport-token-long-enough-for-the-check-0123";
const scope: Scope = { ...CONFORMANCE_SCOPE, appId: "admin-app" };
const KEY = { "header:authorization": "Bearer key-1" };
const boss: AdminActor = { domain: "member", id: "boss", roles: ["connect-admin"] };
const ana: AdminActor = { domain: "member", id: "ana", roles: [] };
const bo: AdminActor = { domain: "member", id: "bo", roles: [] };

describe.skipIf(postgresUnavailable())("the signed admin API", () => {
  let db: TestDatabase;
  let connect: Connect;
  let served: ServedConnect;
  let url: string;
  let backend: ApprovedActionSigner;
  let as: (actor: AdminActor) => ActorAdmin;

  const signed = (path: string, headers: Record<string, string>, body: string) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  beforeAll(async () => {
    db = await startTestDatabase();
    const engine = await testEngineKeys();
    const pair = await generateEd25519KeyPair();
    backend = ed25519ActionSigner({ keyId: "backend-1", privateKey: pair.privateKey });
    connect = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, adminKeys: { "backend-1": pair.publicKey }, connectors: [notesConnector("1.0.0", "v1")], pool: db.app, keys: testKeyProvider() });
    served = await serveConnect(connect, { port: 0, performToken: TOKEN });
    url = `http://127.0.0.1:${(served.server.address() as { port: number }).port}`;
    const client = createAdminClient({ url, audience: AUDIENCE, signer: backend });
    as = (actor) => client.as(actor);
  });
  afterAll(async () => {
    await served?.close();
    await connect?.close();
    await db?.close();
  });

  it("lets an admin install and connect the business's account, and logs both as theirs, without the secret", async () => {
    await as(boss).install(scope, "notes");
    const c = await as(boss).createConnection({ scope, connectorId: "notes", owner: { business: true }, secret: KEY });
    expect(c).toMatchObject({ connectorId: "notes", ownerSubject: null, status: "active" });
    const log = await as(boss).log(scope.tenantId);
    expect(log.map((e) => e.action).slice(0, 2)).toEqual(["createConnection", "install"]);
    expect(log[0]).toMatchObject({ actor: { domain: "member", id: "boss", roles: ["connect-admin"] }, target: c.id });
    expect(JSON.stringify(log)).not.toContain("key-1");
  });

  it("lets a person connect, see and remove only their own account", async () => {
    const mine = await as(ana).createConnection({ scope, connectorId: "notes", owner: { person: "member:ana" }, secret: KEY });
    await expect(as(ana).createConnection({ scope, connectorId: "notes", owner: { person: "member:bo" }, secret: KEY })).rejects.toMatchObject({ code: "admin/forbidden" });
    // Not even an admin connects someone else's account.
    await expect(as(boss).createConnection({ scope, connectorId: "notes", owner: { person: "member:bo" }, secret: KEY })).rejects.toMatchObject({ code: "admin/forbidden" });
    expect((await as(ana).connections(scope)).map((c) => c.id)).toEqual([mine.id]);
    expect(await as(bo).connections(scope)).toEqual([]);
    expect(await as(bo).connection(scope.tenantId, mine.id)).toBeNull();
    await expect(as(bo).revokeConnection(scope.tenantId, mine.id)).rejects.toMatchObject({ code: "admin/not-found" });
    await expect(as(bo).connections(scope, { ownerSubject: "member:ana" })).rejects.toMatchObject({ code: "admin/forbidden" });
    expect((await as(boss).connections(scope)).length).toBeGreaterThan(1);
    expect(await as(ana).revokeConnection(scope.tenantId, mine.id)).toMatchObject({ status: "revoked" });
  });

  it("keeps installs, policy, contracts, the business's account and the log to admins", async () => {
    const business = (await as(boss).connections(scope, { connectorId: "notes" })).find((c) => c.ownerSubject === null)!;
    for (const attempt of [
      () => as(ana).install(scope, "notes"),
      () => as(ana).setPolicy(scope, { disabled: true }),
      () => as(ana).operations(scope),
      () => as(ana).log(scope.tenantId),
      () => as(ana).createConnection({ scope, connectorId: "notes", owner: { business: true, role: "x" }, secret: KEY }),
      () => as(ana).revokeConnection(scope.tenantId, business.id),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(AdminError);
    }
    expect((await as(boss).connection(scope.tenantId, business.id))?.status).toBe("active");
  });

  it("logs no change that did not happen, and logs the operator's own changes as the operator's", async () => {
    const before = (await as(boss).log(scope.tenantId)).length;
    await expect(as(boss).createConnection({ scope, connectorId: "notes", owner: { business: true }, secret: KEY })).rejects.toMatchObject({ code: "admin/conflict" });
    expect((await as(boss).log(scope.tenantId)).length).toBe(before);
    await connect.admin.setPolicy(scope, { denied: ["notes.create"] });
    expect((await as(boss).log(scope.tenantId))[0]).toMatchObject({ action: "setPolicy", actor: { operator: true }, detail: { denied: ["notes.create"] } });
  });

  it("pages the log, newest first", async () => {
    const all = await as(boss).log(scope.tenantId);
    const first = await as(boss).log(scope.tenantId, { limit: 2 });
    const next = await as(boss).log(scope.tenantId, { limit: 2, before: first[1]!.id });
    expect([...first, ...next].map((e) => e.id)).toEqual(all.slice(0, 4).map((e) => e.id));
  });

  it("keeps the log append-only for the service's own role", async () => {
    await expect(db.app.query("UPDATE aaply_connect.admin_log SET action = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("DELETE FROM aaply_connect.admin_log")).rejects.toThrow(/permission denied/);
  });

  it("refuses a request that is unsigned, signed for another Connect, too old, replayed, or signed by an unknown key", async () => {
    const body = JSON.stringify({ actor: boss, scope });
    expect((await signed("/admin/operations", {}, body)).status).toBe(401);

    const elsewhere = createAdminClient({ url, audience: "another.connect", signer: backend });
    await expect(elsewhere.as(boss).operations(scope)).rejects.toMatchObject({ message: expect.stringMatching(/signature/) });

    const old = createAdminClient({ url, audience: AUDIENCE, signer: backend, now: () => Date.now() - 5 * 60_000 });
    await expect(old.as(boss).operations(scope)).rejects.toMatchObject({ message: expect.stringMatching(/time/) });

    const stranger = ed25519ActionSigner({ keyId: "backend-1", privateKey: (await generateEd25519KeyPair()).privateKey });
    await expect(createAdminClient({ url, audience: AUDIENCE, signer: stranger }).as(boss).operations(scope)).rejects.toMatchObject({ message: expect.stringMatching(/signature/) });

    // The same signed request, sent twice: the second is refused.
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const capturing = createAdminClient({
      url,
      audience: AUDIENCE,
      signer: backend,
      fetch: (async (input: string, init: RequestInit) => {
        captured = { headers: init.headers as Record<string, string>, body: init.body as string };
        return fetch(input, init);
      }) as typeof fetch,
    });
    await capturing.as(boss).operations(scope);
    const replay = await signed("/admin/operations", captured!.headers, captured!.body);
    expect(replay.status).toBe(401);

    // A body changed after signing.
    const tampered = await signed("/admin/operations", { ...captured!.headers, "x-aaply-nonce": "another-nonce-0123456789" }, captured!.body.replace("connect-admin", "x"));
    expect(tampered.status).toBe(401);
  });

  it("answers 404 for the admin routes when no admin keys are configured", async () => {
    const plain = await createConnect({ audience: AUDIENCE, engineKeys: (await testEngineKeys()).engineKeys, connectors: [], pool: db.app, keys: testKeyProvider() });
    try {
      expect((await plain.adminRequest({ method: "POST", path: "/admin/operations", headers: {}, body: "{}" })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
