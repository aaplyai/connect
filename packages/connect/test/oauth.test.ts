/**
 * Connecting a Google account with OAuth, end to end against a fake Google:
 * the backend starts an attempt, the person's browser goes through
 * /oauth/start and /oauth/callback, and Gmail sends with the token Connect
 * keeps and renews.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signApprovedAction, type ApprovedAction, type ApprovedActionSigner, type Scope } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE, draftApprovedAction, type ApprovedActionDraft } from "@aaply/action-contract/conformance";
import { mockFetch, type MockFetch, type MockRequest } from "@aaply/connector-sdk/testing";
import { gmail, GMAIL_SEND_SCOPE, GMAIL_SEND_URL } from "@aaply/connectors/gmail";
import { createFlowRuntime, createMemoryCatalog, createMemoryStore, e, hmacKeyMinter, pinActionContracts, type FlowDefinition, type TrustedContext } from "@aaply/flow";
import { ADMIN_ROLE, createConnect, oauthProviders, type AdminActor, type Connect } from "@aaply/connect";
import { serveConnect } from "@aaply/connect/http";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";

const AUDIENCE = "connect.oauth-test";
const scope: Scope = CONFORMANCE_SCOPE;
const APP = "https://app.example";
const TOKEN_URL = "POST https://oauth2.googleapis.com/token";
const USERINFO = "GET https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE = "POST https://oauth2.googleapis.com/revoke";
const boss: AdminActor = { tenantId: scope.tenantId, domain: "member", id: "boss", roles: [ADMIN_ROLE] };
const ana: AdminActor = { tenantId: scope.tenantId, domain: "member", id: "ana", roles: [] };
const s256 = (text: string) => createHash("sha256").update(text).digest("base64url");
const form = (r: MockRequest) => new URLSearchParams(r.body ?? "");

describe.skipIf(postgresUnavailable())("OAuth connections", () => {
  let db: TestDatabase;
  let engine: { signer: ApprovedActionSigner };
  let google: MockFetch;
  let connect: Connect;
  let clock = Date.now();
  /** What the fake Google answers next: the account, and each new token's lifetime. */
  let account = { sub: "g-111", email: "desk@clinic.example" };
  let expiresIn = 3600;
  let issued = 0;

  const tokens = (r: MockRequest) => {
    const f = form(r);
    if (f.get("client_id") !== "aaply-client" || f.get("client_secret") !== "aaply-secret") return { status: 401, json: { error: "invalid_client" } };
    if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "revoked-refresh") return { status: 400, json: { error: "invalid_grant" } };
    issued++;
    return { json: { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: expiresIn, scope: `openid email ${GMAIL_SEND_SCOPE}`, token_type: "Bearer" } };
  };

  const sign = async (draft: Partial<ApprovedActionDraft> = {}): Promise<ApprovedAction> => {
    const { proof: _p, ...unsigned } = draftApprovedAction({
      scope,
      action: "gmail.send",
      effect: "write",
      idempotent: false,
      risk: "confirm",
      input: { to: ["ana@example.com"], subject: "Booked", text: "See you." },
      role: null,
      effectId: `e-${Math.random()}`,
      ...draft,
      now: clock,
      audience: AUDIENCE,
      key: null,
    });
    return signApprovedAction<ApprovedAction>(unsigned, engine.signer);
  };

  /** The person's browser: start link, then the provider's redirect back with `code`. Answers the landing URL. */
  async function connectInBrowser(actor: AdminActor, input: Partial<Parameters<Connect["admin"]["startOAuth"]>[0]> = {}) {
    const { url } = await connect.adminAs(actor).startOAuth({ scope, connectorId: "gmail", owner: { business: true }, returnTo: `${APP}/settings`, ...input });
    const start = new URL(url);
    const begun = await connect.oauthRequest({ path: start.pathname, query: start.searchParams, cookie: undefined });
    if (!("redirect" in begun)) throw new Error(`start answered ${begun.status}: ${begun.text}`);
    const cookie = begun.setCookie!.split(";")[0]!;
    const atGoogle = new URL(begun.redirect);
    const back = new URLSearchParams({ code: "the-code", state: atGoogle.searchParams.get("state")! });
    const done = await connect.oauthRequest({ path: "/oauth/callback", query: back, cookie });
    return { atGoogle, cookie, back, done, landed: "redirect" in done ? new URL(done.redirect) : null };
  }

  beforeAll(async () => {
    db = await startTestDatabase();
    google = mockFetch({
      [TOKEN_URL]: tokens,
      [USERINFO]: () => ({ json: { ...account } }),
      [REVOKE]: { status: 200 },
      [`POST ${GMAIL_SEND_URL}`]: { json: { id: "m1", threadId: "t1" } },
    });
    connect = await createConnect({
      audience: AUDIENCE,
      engineKeys: (engine = await testEngineKeys()).engineKeys,
      connectors: [gmail],
      pool: db.app,
      keys: testKeyProvider(),
      fetch: google,
      now: () => clock,
      oauth: {
        redirectUri: "https://connect.example/oauth/callback",
        returnOrigins: [APP],
        apps: { gmail: { provider: oauthProviders.google, clientId: "aaply-client", clientSecret: "aaply-secret" } },
      },
    });
    await connect.admin.install(scope, "gmail");
  });
  afterAll(async () => {
    await connect?.close();
    await db?.close();
  });
  beforeEach(() => {
    google.calls.splice(0);
    clock = Date.now();
  });

  it("connects the business's Google account through the admin's browser, with PKCE", async () => {
    const { atGoogle, landed } = await connectInBrowser(boss);
    expect(atGoogle.origin + atGoogle.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(atGoogle.searchParams.get("scope")!.split(" ").sort()).toEqual([GMAIL_SEND_SCOPE, "email", "openid"].sort());
    expect(atGoogle.searchParams.get("code_challenge_method")).toBe("S256");
    expect(atGoogle.searchParams.get("access_type")).toBe("offline");
    const exchange = google.callsTo(TOKEN_URL)[0]!;
    expect(s256(form(exchange).get("code_verifier")!)).toBe(atGoogle.searchParams.get("code_challenge"));
    expect(form(exchange).get("redirect_uri")).toBe("https://connect.example/oauth/callback");
    expect(landed!.origin + landed!.pathname).toBe(`${APP}/settings`);
    expect(landed!.searchParams.get("connect")).toBe("ok");
    const made = await connect.admin.connection(scope.tenantId, landed!.searchParams.get("connection")!);
    expect(made).toMatchObject({ connectorId: "gmail", ownerSubject: null, status: "active", account: { provider: "google", id: "g-111", name: "desk@clinic.example" } });
    expect(made!.grantedScopes).toContain(GMAIL_SEND_SCOPE);
    expect((await connect.adminAs(boss).log(scope.tenantId))[0]).toMatchObject({ action: "createConnection", actor: { id: "boss" } });
  });

  it("sends with the kept token", async () => {
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok", output: { id: "m1", threadId: "t1" } });
    expect(google.callsTo(`POST ${GMAIL_SEND_URL}`)[0]!.headers.authorization).toBe(`Bearer access-${issued}`);
  });

  it("takes a sign-in once, and only in the browser that began it", async () => {
    const { cookie, back } = await connectInBrowser(boss);
    const again = await connect.oauthRequest({ path: "/oauth/callback", query: back, cookie });
    expect(again).toMatchObject({ status: 400 });

    const { url } = await connect.adminAs(boss).startOAuth({ scope, connectorId: "gmail", owner: { business: true }, returnTo: `${APP}/x` });
    const start = new URL(url);
    const begun = await connect.oauthRequest({ path: start.pathname, query: start.searchParams, cookie: undefined });
    const state = new URL((begun as { redirect: string }).redirect).searchParams.get("state")!;
    const name = (begun as { setCookie: string }).setCookie.split("=")[0];
    expect(name).toBe(`__Host-aaply-oauth-${state}`);
    expect((begun as { setCookie: string }).setCookie).toMatch(/; Secure; HttpOnly; SameSite=Lax/);
    // The start link works once: a second browser cannot take it over.
    expect(await connect.oauthRequest({ path: start.pathname, query: start.searchParams, cookie: undefined })).toMatchObject({ status: 400 });
    const q = new URLSearchParams({ code: "c", state });
    expect(await connect.oauthRequest({ path: "/oauth/callback", query: q, cookie: undefined })).toMatchObject({ status: 400 });
    expect(await connect.oauthRequest({ path: "/oauth/callback", query: q, cookie: `${name}=forged` })).toMatchObject({ status: 400 });
    expect(google.callsTo(TOKEN_URL).length).toBe(1); // only the first, completed sign-in traded a code
  });

  it("refuses another account where one is connected, and a person connecting the business's", async () => {
    account = { sub: "g-999", email: "someone@else.example" };
    const { landed } = await connectInBrowser(boss);
    expect(landed!.searchParams.get("connect")).toBe("error");
    expect(landed!.searchParams.get("reason")).toBe("different-account");
    account = { sub: "g-111", email: "desk@clinic.example" };
    await expect(connect.adminAs(ana).startOAuth({ scope, connectorId: "gmail", owner: { business: true }, returnTo: `${APP}/x` })).rejects.toMatchObject({ code: "admin/forbidden" });
    await expect(connect.adminAs(ana).startOAuth({ scope, connectorId: "gmail", owner: { person: "member:bo" }, returnTo: `${APP}/x` })).rejects.toMatchObject({ code: "admin/forbidden" });
    await expect(connect.adminAs(boss).startOAuth({ scope, connectorId: "gmail", owner: { business: true }, returnTo: "https://evil.example/x" })).rejects.toMatchObject({ code: "admin/invalid" });
    await expect(connect.adminAs(boss).startOAuth({ scope, connectorId: "notes", owner: { business: true }, returnTo: `${APP}/x` })).rejects.toMatchObject({ code: "admin/invalid" });
  });

  it("renews a token about to run out before sending, once for calls side by side", async () => {
    expiresIn = 30;
    await connectInBrowser(boss); // the same account again: new tokens, 30 s left
    expiresIn = 3600;
    google.calls.splice(0);
    const outcomes = await Promise.all([connect.perform(await sign()), connect.perform(await sign())]);
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok"]);
    const refreshes = google.callsTo(TOKEN_URL);
    expect(refreshes.length).toBe(1);
    expect(form(refreshes[0]!).get("grant_type")).toBe("refresh_token");
    for (const send of google.callsTo(`POST ${GMAIL_SEND_URL}`)) expect(send.headers.authorization).toBe(`Bearer access-${issued}`);
  });

  it("renews a token Gmail refused, and sends once", async () => {
    let first = true;
    google.on(`POST ${GMAIL_SEND_URL}`, () => (first ? ((first = false), { status: 401, json: { error: { code: 401 } } }) : { json: { id: "m2", threadId: "t2" } }));
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok", output: { id: "m2" } });
    expect(google.callsTo(TOKEN_URL).length).toBe(1);
    google.on(`POST ${GMAIL_SEND_URL}`, { json: { id: "m1", threadId: "t1" } });
  });

  it("sends the confirmation email a person confirmed in a flow the engine runs", async () => {
    const notify: FlowDefinition = {
      schemaVersion: 3,
      id: "notify",
      version: "1",
      title: "Email a confirmation",
      facts: {
        email: { type: { type: "string", minLength: 3 }, sensitivity: "personal" },
        messageId: { type: { type: "string" }, derive: e.result("send", "id"), sensitivity: "none" },
      },
      actions: {
        send: {
          action: "gmail.send",
          connection: "default",
          effect: "write",
          irreversible: true,
          risk: "confirm",
          input: { to: e.list(e.fact("email")), subject: e.lit("Your booking is confirmed"), text: e.lit("See you at 10:00.") },
        },
      },
      steps: [
        { id: "ask", view: { section: "email@1" }, on: { submit: { set: { email: e.payload("email") } } } },
        { id: "review", run: "send", view: { section: "review@1" }, on: { confirm: { confirm: true } } },
      ],
      completeWhen: e.known("messageId"),
    };
    const operations = await connect.admin.operations(scope);
    const pinned = pinActionContracts(notify, operations);
    expect(pinned.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const catalog = createMemoryCatalog();
    catalog.publish(scope, pinned.definition);
    const runtime = createFlowRuntime({
      catalog,
      store: createMemoryStore(),
      actions: { run: (a, signal) => connect.perform(a, signal) },
      keys: hmacKeyMinter("oauth-test-idempotency-secret-0123456789"),
      envelopes: { audience: AUDIENCE, signer: engine.signer },
      operations,
      policy: () => ({ mode: "off" }),
      clock: { now: () => clock },
    });
    const ctx: TrustedContext = { scope, environmentKind: "production", actor: { domain: "visitor", kind: "visitor", id: "v1" }, appRoles: [], locale: "en-GB", timezone: "Asia/Kolkata", requestId: "r1" };
    const { runId } = await runtime.start(ctx, { flowId: "notify" });
    const review = await runtime.submit({ ...ctx, requestId: "r2" }, runId, { kind: "output", stepId: "ask", name: "submit", payload: { email: "patient@example.com" } });
    const done = await runtime.submit({ ...ctx, requestId: "r3" }, runId, { kind: "output", stepId: "review", name: "confirm", digest: review.view.step!.confirm!.digest });
    expect(done.view.run).toBe("completed");
    const sent = google.callsTo(`POST ${GMAIL_SEND_URL}`);
    expect(sent.length).toBe(1);
    expect(Buffer.from((sent[0]!.json() as { raw: string }).raw, "base64url").toString("utf8")).toContain("To: patient@example.com\r\nSubject: Your booking is confirmed");
  });

  it("asks for the account again when Google no longer takes the grant", async () => {
    const [c] = await connect.admin.connections(scope, { connectorId: "gmail" });
    await connect.admin.updateConnection(scope.tenantId, c!.id, c!.version, { secret: { accessToken: "old", refreshToken: "revoked-refresh", expiresAt: String(clock + 1000) } });
    expect(await connect.perform(await sign())).toMatchObject({ status: "final", error: { code: "connect/reconsent" } });
    expect((await connect.admin.connection(scope.tenantId, c!.id))!.status).toBe("reauth");
    expect(google.callsTo(`POST ${GMAIL_SEND_URL}`)).toEqual([]);
    // Connecting the same account again makes it work.
    const { landed } = await connectInBrowser(boss, { reconnect: c!.id });
    expect(landed!.searchParams.get("connect")).toBe("ok");
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
  });

  it("revokes the grant at Google when the connection is removed", async () => {
    const [c] = await connect.admin.connections(scope, { connectorId: "gmail" });
    await connect.adminAs(boss).revokeConnection(scope.tenantId, c!.id);
    const revoked = google.callsTo(REVOKE);
    expect(revoked.length).toBe(1);
    expect(form(revoked[0]!).get("token")).toMatch(/^refresh-/);
    expect(await connect.perform(await sign())).toMatchObject({ status: "final" });
  });

  it("serves the browser's routes over HTTP, uncached and unframed", async () => {
    const { url } = await connect.adminAs(boss).startOAuth({ scope, connectorId: "gmail", owner: { business: true }, returnTo: `${APP}/x` });
    const served = await serveConnect(connect, { port: 0, noPerformToken: true });
    try {
      const { port } = served.server.address() as { port: number };
      const start = new URL(url);
      const res = await fetch(`http://127.0.0.1:${port}${start.pathname}${start.search}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
      expect(res.headers.get("set-cookie")).toMatch(/^__Host-aaply-oauth-/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const gone = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=nope&code=x`);
      expect(gone.status).toBe(400);
      expect(gone.headers.get("content-type")).toMatch(/^text\/plain/);
    } finally {
      await served.close();
    }
  });
});
