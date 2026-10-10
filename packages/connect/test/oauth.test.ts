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
import { defineConnector } from "@aaply/connector-sdk";
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
const keys = testKeyProvider();
const s256 = (text: string) => createHash("sha256").update(text).digest("base64url");
const form = (r: MockRequest) => new URLSearchParams(r.body ?? "");

describe.skipIf(postgresUnavailable())("OAuth connections", () => {
  let db: TestDatabase;
  let engine: { signer: ApprovedActionSigner; engineKeys: Record<string, string> };
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
      [USERINFO]: () => ({ json: { ...account, email_verified: true } }),
      [REVOKE]: { status: 200 },
      [`POST ${GMAIL_SEND_URL}`]: { json: { id: "m1", threadId: "t1" } },
    });
    connect = await createConnect({
      audience: AUDIENCE,
      engineKeys: (engine = await testEngineKeys()).engineKeys,
      connectors: [gmail],
      pool: db.app,
      keys,
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

  /** The business's Gmail connection now, and a fresh secret on it that runs out in `inMs`. */
  async function nearlyExpired(inMs: number, refreshToken = `refresh-${issued}`) {
    const [c] = (await connect.admin.connections(scope, { connectorId: "gmail" })).filter((x) => x.status === "active");
    return connect.admin.updateConnection(scope.tenantId, c!.id, c!.version, { secret: { accessToken: "old-access", refreshToken, expiresAt: String(clock + inMs) } });
  }
  const sentWith = () => google.callsTo(`POST ${GMAIL_SEND_URL}`).map((r) => r.headers.authorization);

  it("keeps a renewed token although the connection changed meanwhile, and a call that gave up does not stop it", async () => {
    const c = await nearlyExpired(-1000);
    google.on(TOKEN_URL, async (r) => {
      // An admin edit lands while Google answers, and the first caller gives up.
      const now = (await connect.admin.connection(scope.tenantId, c.id))!;
      await connect.admin.updateConnection(scope.tenantId, c.id, now.version, { account: { ...now.account, note: "edited" } });
      gaveUp.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return tokens(r);
    });
    const gaveUp = new AbortController();
    const [first, second] = await Promise.all([connect.perform(await sign(), gaveUp.signal), connect.perform(await sign())]);
    expect(first.status).not.toBe("ok");
    expect(second).toMatchObject({ status: "ok" });
    google.on(TOKEN_URL, tokens);
    google.calls.splice(0);
    // The renewed token was saved: the next call uses it without renewing again.
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    expect(google.callsTo(TOKEN_URL)).toEqual([]);
    expect(sentWith()).toEqual([`Bearer access-${issued}`]);
  });

  it("keeps the refresh token when Google sends no new one", async () => {
    await nearlyExpired(-1000, "the-long-lived-one");
    const used: Array<string | null> = [];
    google.on(TOKEN_URL, (r) => (used.push(form(r).get("refresh_token")), { json: { access_token: `access-short-${used.length}`, expires_in: 1, token_type: "Bearer" } }));
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    clock += 5_000; // that token has run out: the next call renews with the refresh token it kept
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    expect(used).toEqual(["the-long-lived-one", "the-long-lived-one"]);
    expect(sentWith()).toEqual(["Bearer access-short-1", "Bearer access-short-2"]);
    google.on(TOKEN_URL, tokens);
  });

  it("leaves the connection alone when Google refuses Aaply's client, and uses a token that still works", async () => {
    const c = await nearlyExpired(20_000);
    google.on(TOKEN_URL, { status: 401, json: { error: "invalid_client" } });
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    expect(sentWith()).toEqual(["Bearer old-access"]);
    await nearlyExpired(-1000);
    expect(await connect.perform(await sign())).toMatchObject({ status: "retryable", error: { code: "connect/refresh-failed" } });
    expect((await connect.admin.connection(scope.tenantId, c.id))!.status).toBe("active");
    google.on(TOKEN_URL, tokens);
  });

  it("does not wait on another instance's renewal while the token still works", async () => {
    const c = await nearlyExpired(20_000);
    await db.pool("postgres").query("INSERT INTO aaply_connect.refresh_leases (connection_id, tenant_id, holder, until) VALUES ($1, $2, 'elsewhere', now() + interval '30 seconds')", [c.id, scope.tenantId]);
    const started = Date.now();
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sentWith()).toEqual(["Bearer old-access"]);
    expect(google.callsTo(TOKEN_URL)).toEqual([]);
    await db.pool("postgres").query("DELETE FROM aaply_connect.refresh_leases");
  });

  it("refuses a sign-in that unticked a scope the connector needs, or used another account than expected", async () => {
    google.on(TOKEN_URL, (r) => ({ ...tokens(r), json: { ...(tokens(r) as { json: Record<string, unknown> }).json, scope: "openid email" } }));
    expect((await connectInBrowser(boss)).landed!.searchParams.get("reason")).toBe("scopes-declined");
    google.on(TOKEN_URL, tokens);
    const wrong = await connectInBrowser(ana, { owner: { person: "member:ana" }, expectAccount: "ana@clinic.example" });
    expect(wrong.atGoogle.searchParams.get("login_hint")).toBe("ana@clinic.example");
    expect(wrong.landed!.searchParams.get("reason")).toBe("different-account");
    account = { sub: "g-ana", email: "Ana@Clinic.example" };
    expect((await connectInBrowser(ana, { owner: { person: "member:ana" }, expectAccount: "ana@clinic.example" })).landed!.searchParams.get("connect")).toBe("ok");
    account = { sub: "g-111", email: "desk@clinic.example" };
  });

  it("lets a reconnect made during a renewal win, and takes over a lease its holder let go", async () => {
    const c = await nearlyExpired(-1000);
    google.on(TOKEN_URL, async (r) => {
      if (form(r).get("grant_type") === "refresh_token") {
        // The person connects the account again while this renewal is out at Google.
        google.on(TOKEN_URL, tokens);
        await connectInBrowser(boss);
      }
      return tokens(r);
    });
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    const reconnected = issued - 1; // the reconnect's tokens were issued before the renewal's answer
    google.calls.splice(0);
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    expect(sentWith()).toEqual([`Bearer access-${reconnected}`]);

    // A lease another instance let go without renewing: a call whose token has run out takes it and renews.
    await nearlyExpired(-1000);
    await db.pool("postgres").query("INSERT INTO aaply_connect.refresh_leases (connection_id, tenant_id, holder, until) VALUES ($1, $2, 'elsewhere', now() + interval '30 seconds')", [c.id, scope.tenantId]);
    setTimeout(() => void db.pool("postgres").query("DELETE FROM aaply_connect.refresh_leases WHERE holder = 'elsewhere'"), 300);
    expect(await connect.perform(await sign())).toMatchObject({ status: "ok" });
    expect(google.callsTo(TOKEN_URL).length).toBe(1);
  });

  it("lets a start link go unused for two minutes at most", async () => {
    const { url } = await connect.adminAs(boss).startOAuth({ scope, connectorId: "gmail", owner: { business: true }, returnTo: `${APP}/x` });
    const start = new URL(url);
    await db.pool("postgres").query("UPDATE aaply_connect.oauth_states SET created_at = now() - interval '3 minutes' WHERE id = $1", [start.searchParams.get("attempt")]);
    expect(await connect.oauthRequest({ path: start.pathname, query: start.searchParams, cookie: undefined })).toMatchObject({ status: 400 });
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

  it("connects Notion with HTTP Basic and a JSON token request, as the person who authorized", async () => {
    const notion = mockFetch({
      "POST https://api.notion.com/v1/oauth/token": (r) => {
        const basic = Buffer.from("notion-client:notion-secret").toString("base64");
        if (r.headers.authorization !== `Basic ${basic}` || r.headers["content-type"] !== "application/json") return { status: 401, json: { error: "invalid_client" } };
        const body = r.json() as Record<string, string>;
        if (body.grant_type !== "authorization_code" || !body.code_verifier || body.client_secret) return { status: 400, json: { error: "invalid_request" } };
        return { json: { access_token: "notion-access", token_type: "bearer", bot_id: "bot-1", workspace_id: "ws-1", workspace_name: "Clinic", owner: { type: "user", user: { id: "u-ana", person: { email: "ana@clinic.example" } } } } };
      },
      "GET https://api.notion.com/v1/users/me": { json: { object: "user" } },
    });
    const pages = defineConnector({
      id: "notion-test",
      version: "1.0.0",
      title: "Notion",
      auth: { kind: "oauth2", scopes: [] },
      egress: ["GET api.notion.com/v1/users/me"],
      operations: { me: { title: "Me", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ url: "https://api.notion.com/v1/users/me" })).ensureOk().json() as never } },
    });
    const other = await createConnect({
      audience: AUDIENCE,
      engineKeys: engine.engineKeys,
      connectors: [pages],
      pool: db.app,
      keys,
      fetch: notion,
      oauth: { redirectUri: "https://connect.example/oauth/callback", returnOrigins: [APP], apps: { "notion-test": { provider: oauthProviders.notion, clientId: "notion-client", clientSecret: "notion-secret" } } },
    });
    try {
      const { url } = await other.adminAs(ana).startOAuth({ scope, connectorId: "notion-test", owner: { person: "member:ana" }, returnTo: `${APP}/x`, expectAccount: "ana@clinic.example" });
      const start = new URL(url);
      const begun = (await other.oauthRequest({ path: start.pathname, query: start.searchParams, cookie: undefined })) as { redirect: string; setCookie: string };
      expect(new URL(begun.redirect).searchParams.get("owner")).toBe("user");
      const state = new URL(begun.redirect).searchParams.get("state")!;
      const done = (await other.oauthRequest({ path: "/oauth/callback", query: new URLSearchParams({ code: "c", state }), cookie: begun.setCookie.split(";")[0] })) as { redirect: string };
      const landed = new URL(done.redirect);
      expect(landed.searchParams.toString()).toBe("connect=ok&connection=" + landed.searchParams.get("connection"));
      expect(await other.admin.connection(scope.tenantId, landed.searchParams.get("connection")!)).toMatchObject({ account: { provider: "notion", id: "u-ana", name: "Clinic" }, ownerSubject: "member:ana" });
    } finally {
      await other.close();
    }
  });

  it("sends the person back with a reason when the connection cannot be saved", async () => {
    // Another key provider cannot open this tenant's data key: saving fails after Google said yes.
    const broken = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [gmail], pool: db.app, keys: testKeyProvider(), fetch: google, oauth: { redirectUri: "https://connect.example/oauth/callback", returnOrigins: [APP], apps: { gmail: { provider: oauthProviders.google, clientId: "aaply-client", clientSecret: "aaply-secret" } } } });
    try {
      const cy: AdminActor = { ...ana, id: "cy" };
      const { url } = await broken.adminAs(cy).startOAuth({ scope, connectorId: "gmail", owner: { person: "member:cy" }, returnTo: `${APP}/x` });
      const start = new URL(url);
      const begun = (await broken.oauthRequest({ path: start.pathname, query: start.searchParams, cookie: undefined })) as { redirect: string; setCookie: string };
      const state = new URL(begun.redirect).searchParams.get("state")!;
      const done = await broken.oauthRequest({ path: "/oauth/callback", query: new URLSearchParams({ code: "c", state }), cookie: begun.setCookie.split(";")[0] });
      expect("redirect" in done && new URL(done.redirect).searchParams.get("reason")).toBe("failed");
    } finally {
      await broken.close();
    }
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
