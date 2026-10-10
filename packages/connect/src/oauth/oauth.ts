/**
 * Connecting an account with OAuth, and keeping its token fresh.
 *
 * Connecting: the Aaply backend asks for an attempt (signed admin
 * `startOAuth`, checked like creating the connection), and sends the
 * person's browser to the link it gets. Connect then binds the attempt to
 * that browser with a cookie nonce, sends it to the provider with PKCE, and
 * on the way back takes the attempt once, for that browser only, trades the
 * code for tokens, learns which account it is, and saves the connection: a
 * new one, or the same account connected again (a different account is
 * refused). The person lands back on the backend's page with the result.
 *
 * The start link works once and only within two minutes, so the backend
 * sends the browser on at once and never shows the link. Who opens it is
 * not provable: `expectAccount` pins the account (its email) that may be
 * connected, which the backend should give for a person's own connection.
 *
 * Refreshing is refresh.ts.
 */

import { createHash, randomBytes } from "node:crypto";
import type { EnvironmentKind, JsonObject, Scope } from "@aaply/action-contract";
import type { FetchLike } from "@aaply/connector-sdk";
import { AdminError, loggedAdmin, type RawAdmin } from "../admin.js";
import type { ConnectionOwner } from "../connect.js";
import type { TokenRefresher } from "../credentials.js";
import { newId } from "../ids.js";
import type { OAuthStore } from "../store/oauth-store.js";
import { StoreConflict, type ConnectStore, type Connection } from "../store/store.js";
import type { Vault } from "../vault.js";
import { identify, providerPost, type OAuthApp } from "./provider-http.js";
import { createRefresher, tokenSecret } from "./refresh.js";

export interface OAuthOptions {
  /** Connect's callback, as registered with every provider: `https://<connect>/oauth/callback`. */
  redirectUri: string;
  /** Origins a finished attempt may send the person back to (the Aaply app's), exactly. */
  returnOrigins: readonly string[];
  /** Per OAuth connector id: its provider and Aaply's client there. */
  apps: Readonly<Record<string, OAuthApp>>;
  /** How long an attempt lasts, in ms. Default 10 minutes. */
  attemptTtlMs?: number;
}

export interface StartOAuthInput {
  scope: Scope;
  connectorId: string;
  owner: ConnectionOwner;
  environmentKind?: EnvironmentKind;
  /** Where the person lands afterwards, with `connect=ok&connection=<id>` or `connect=error&reason=<code>` added. */
  returnTo: string;
  /** Connect this connection's account again (after `reauth`, or for more scopes). */
  reconnect?: string;
  /**
   * The email of the only account that may be connected (suggested to the
   * provider, and checked when the person comes back). Give it for a
   * person's own connection, so a start link opened by someone else cannot
   * attach their account to this person.
   */
  expectAccount?: string;
}

/** What an HTTP route answers: a redirect (with a cookie to set), or a short page. */
export type OAuthAnswer = { redirect: string; setCookie?: string } | { status: number; text: string; setCookie?: string };

const COOKIE = "__Host-aaply-oauth-";
const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");
export function createOAuth(options: {
  config: OAuthOptions;
  store: ConnectStore;
  oauthStore: OAuthStore;
  vault: Vault;
  admin: RawAdmin;
  fetch: FetchLike;
  scopesOf: (connectorId: string) => readonly string[];
  now?: () => number;
  report?: (error: unknown, where: string) => void;
}) {
  const { config, oauthStore, vault } = options;
  const now = options.now ?? Date.now;
  const ttl = config.attemptTtlMs ?? 10 * 60_000;
  const callback = new URL(config.redirectUri);
  const startUrl = new URL("/oauth/start", callback.origin);
  const report = options.report ?? (() => undefined);

  const appOf = (connectorId: string) => {
    const app = config.apps[connectorId];
    if (!app) throw new AdminError("admin/invalid", `${connectorId} has no OAuth client configured here`);
    return app;
  };

  /** Trades the code, checks the account, and saves the connection. */
  async function finish(r: Record<string, any>, app: OAuthApp, code: string, verifier: string, back: (result: Record<string, string>) => OAuthAnswer): Promise<OAuthAnswer> {
    let tokens: Record<string, unknown>;
    let account: { id: string; name?: string; email?: string };
    try {
      const res = await providerPost(options.fetch, app, app.provider.tokenUrl, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier });
      if (res.status !== 200 || typeof res.json.access_token !== "string" || !res.json.access_token) return back({ connect: "error", reason: "token-exchange" });
      tokens = res.json;
      account = await identify(options.fetch, app, tokens);
    } catch (error) {
      report(error, "oauth.exchange");
      return back({ connect: "error", reason: "provider-unreachable" });
    }
    if (typeof r.expectAccount === "string" && account.email?.toLowerCase() !== r.expectAccount.toLowerCase()) return back({ connect: "error", reason: "different-account" });
    const asked = options.scopesOf(r.connectorId as string);
    // A provider that names no scopes granted what was asked (RFC 6749 5.1); one that names them may have had some unticked.
    const granted = typeof tokens.scope === "string" ? tokens.scope.split(/[\s,]+/).filter(Boolean) : [...asked];
    if (asked.some((s) => !granted.includes(s))) return back({ connect: "error", reason: "scopes-declined" });
    const secret = tokenSecret(tokens, null, now());
    const scope = r.scope as Scope;
    const owner = r.owner as ConnectionOwner;
    const kind = r.environmentKind as EnvironmentKind;
    const admin = loggedAdmin(options.admin, options.store, r.actor as JsonObject);
    const accountJson: JsonObject = { provider: app.provider.id, id: account.id, ...(account.name ? { name: account.name } : {}) };

    // The same account again: its connection gets the new tokens. Another account: refused.
    const existing = async (): Promise<Connection | undefined> => {
      if (r.reconnect) return (await options.admin.connection(scope.tenantId, r.reconnect as string)) ?? undefined;
      const person = "person" in owner ? owner.person : undefined;
      const all = await options.admin.connections(scope, { connectorId: r.connectorId as string, ...(person ? { ownerSubject: person } : {}) });
      return all.find((c) => c.status !== "revoked" && c.environmentKind === kind && (person ? c.ownerSubject === person : c.ownerSubject === null && c.role === ("role" in owner && owner.role ? owner.role : "default")));
    };
    try {
      const current = await existing();
      if (current && current.status !== "revoked") {
        if ((current.account as Record<string, unknown>).id !== account.id) return back({ connect: "error", reason: "different-account" });
        const updated = await admin.updateConnection(scope.tenantId, current.id, current.version, { secret, grantedScopes: granted, account: accountJson, status: "active" });
        return back({ connect: "ok", connection: updated.id });
      }
      if (r.reconnect) return back({ connect: "error", reason: "connection-gone" });
      const made = await admin.createConnection({ scope, connectorId: r.connectorId as string, owner, environmentKind: kind, grantedScopes: granted, account: accountJson, secret });
      return back({ connect: "ok", connection: made.id });
    } catch (error) {
      if (error instanceof StoreConflict) return back({ connect: "error", reason: "changed-meanwhile" });
      throw error;
    }
  }

  return {
    /** A new attempt, after the caller checked the person may make this connection. Answers the link to send their browser to. */
    async start(input: StartOAuthInput, actor: JsonObject): Promise<{ url: string; expiresAt: number }> {
      const app = appOf(input.connectorId);
      let back: URL;
      try {
        back = new URL(input.returnTo);
      } catch {
        throw new AdminError("admin/invalid", "returnTo is not a URL");
      }
      if (!config.returnOrigins.includes(back.origin)) throw new AdminError("admin/invalid", `returnTo must be on ${config.returnOrigins.join(", ")}`);
      void app;
      if (input.expectAccount !== undefined && (typeof input.expectAccount !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(input.expectAccount))) throw new AdminError("admin/invalid", "expectAccount is an email address");
      const id = newId("oauth");
      const request: JsonObject = {
        scope: { ...input.scope },
        connectorId: input.connectorId,
        owner: "person" in input.owner ? { person: input.owner.person } : { business: true, ...(input.owner.role ? { role: input.owner.role } : {}) },
        environmentKind: input.environmentKind ?? "production",
        actor,
        returnTo: back.toString(),
        ...(input.reconnect ? { reconnect: input.reconnect } : {}),
        ...(input.expectAccount ? { expectAccount: input.expectAccount } : {}),
      };
      await oauthStore.createAttempt(id, input.scope.tenantId, request, randomBytes(48).toString("base64url"), ttl);
      const url = new URL(startUrl);
      url.searchParams.set("attempt", id);
      // The link itself must be opened within two minutes (oauth_state_begin); the sign-in then has the attempt's whole lifetime.
      return { url: url.toString(), expiresAt: now() + Math.min(ttl, 2 * 60_000) };
    },

    /** `GET /oauth/start?attempt=…`: binds the attempt to this browser, once, and sends it to the provider. */
    async begin(attemptId: string): Promise<OAuthAnswer> {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(attemptId)) return { status: 400, text: "This link is not valid. Start connecting again." };
      const nonce = randomBytes(24).toString("base64url");
      const attempt = await oauthStore.beginAttempt(attemptId, sha256(nonce));
      if (!attempt) return { status: 400, text: "This link has expired or was already used. Start connecting again." };
      const app = config.apps[attempt.request.connectorId as string];
      if (!app) return { status: 400, text: "This connection can no longer be made here." };
      const p = app.provider;
      const url = new URL(p.authorizeUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", app.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", attemptId);
      url.searchParams.set("code_challenge", sha256(attempt.verifier));
      url.searchParams.set("code_challenge_method", "S256");
      const all = [...new Set([...options.scopesOf(attempt.request.connectorId as string), ...(p.identityScopes ?? [])])];
      if (all.length > 0) url.searchParams.set("scope", all.join(" "));
      for (const [k, v] of Object.entries(p.authorizeParams ?? {})) url.searchParams.set(k, v);
      if (p.loginHint && typeof attempt.request.expectAccount === "string") url.searchParams.set(p.loginHint, attempt.request.expectAccount);
      return { redirect: url.toString(), setCookie: `${COOKIE}${attemptId}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(ttl / 1000)}` };
    },

    /** `GET /oauth/callback`: takes the attempt for the browser that began it, and saves the connection. */
    async complete(query: URLSearchParams, cookies: Readonly<Record<string, string>>): Promise<OAuthAnswer> {
      const attemptId = query.get("state") ?? "";
      const nonce = cookies[`${COOKIE}${attemptId}`];
      const clear = `${COOKIE}${attemptId}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
      if (!attemptId || !nonce) return { status: 400, text: "This sign-in did not start in this browser. Start connecting again.", setCookie: clear };
      const attempt = await oauthStore.takeAttempt(attemptId, sha256(nonce));
      if (!attempt) return { status: 400, text: "This sign-in has expired or was already used. Start connecting again.", setCookie: clear };
      const r = attempt.request as Record<string, any>;
      const back = (result: Record<string, string>): OAuthAnswer => {
        const url = new URL(r.returnTo as string);
        for (const [k, v] of Object.entries(result)) url.searchParams.set(k, v);
        return { redirect: url.toString(), setCookie: clear };
      };
      const app = config.apps[r.connectorId as string];
      if (!app) return back({ connect: "error", reason: "not-configured" });
      const denied = query.get("error");
      if (denied) return back({ connect: "error", reason: denied === "access_denied" ? "declined" : "provider-error" });
      const code = query.get("code");
      if (!code) return back({ connect: "error", reason: "provider-error" });

      try {
        return await finish(r, app, code, attempt.verifier, back);
      } catch (error) {
        // The attempt is used up either way: the person goes back with a reason, never to a bare error page.
        report(error, "oauth.callback");
        return back({ connect: "error", reason: "failed" });
      }
    },

    /** Revokes a connection's token at its provider, as far as it can; answers whether the provider confirmed. */
    async revokeAtProvider(connectorId: string, secret: Readonly<Record<string, string>> | null): Promise<boolean> {
      const app = config.apps[connectorId];
      const token = secret?.refreshToken ?? secret?.accessToken;
      if (!app?.provider.revokeUrl || !token) return false;
      try {
        return (await providerPost(options.fetch, app, app.provider.revokeUrl, { token })).status === 200;
      } catch (error) {
        report(error, "oauth.revoke");
        return false;
      }
    },

    /** A connection's secret as it is now (to revoke it at the provider before it is deleted). */
    async secretOf(tenantId: string, connectionId: string): Promise<Readonly<Record<string, string>> | null> {
      const c = await oauthStore.current(tenantId, connectionId);
      return c?.secret ? vault.open(tenantId, connectionId, c.secret.sealed, c.secret.dataKey) : null;
    },

    /** Whether this connector's connections are OAuth ones this Connect can refresh. */
    serves: (connectorId: string) => config.apps[connectorId] !== undefined,

    refresher(connectorOf: (tenantId: string, connectionId: string) => Promise<string | null>): TokenRefresher {
      return createRefresher({
        oauthStore,
        vault,
        admin: options.admin,
        fetch: options.fetch,
        appOf: async (tenantId, connectionId) => {
          const connectorId = await connectorOf(tenantId, connectionId);
          return connectorId ? config.apps[connectorId] : undefined;
        },
        holder: randomBytes(9).toString("base64url"),
        now,
        report,
      });
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
