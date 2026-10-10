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
 * Refreshing (`refresher`): on demand, when a token is near its expiry or
 * the service refused it. One refresh per connection at a time, in this
 * process (single flight) and across instances (a lease row); the new
 * secret is saved with a versioned write before the lease is released, so a
 * rotated refresh token is never lost. A refused grant (`invalid_grant`)
 * marks the connection `reauth` and is never retried.
 */

import { createHash, randomBytes } from "node:crypto";
import type { EnvironmentKind, JsonObject, Scope } from "@aaply/action-contract";
import { ConnectorError, type FetchLike } from "@aaply/connector-sdk";
import { AdminError, loggedAdmin, type RawAdmin } from "../admin.js";
import type { ConnectionOwner } from "../connect.js";
import type { TokenRefresher } from "../credentials.js";
import { newId } from "../ids.js";
import type { OAuthStore } from "../store/oauth-store.js";
import { StoreConflict, type ConnectStore, type Connection } from "../store/store.js";
import type { Vault } from "../vault.js";
import type { OAuthProvider } from "./providers.js";

export interface OAuthOptions {
  /** Connect's callback, as registered with every provider: `https://<connect>/oauth/callback`. */
  redirectUri: string;
  /** Origins a finished attempt may send the person back to (the Aaply app's), exactly. */
  returnOrigins: readonly string[];
  /** Per OAuth connector id: its provider and Aaply's client there. */
  apps: Readonly<Record<string, { provider: OAuthProvider; clientId: string; clientSecret: string }>>;
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
}

/** What an HTTP route answers: a redirect (with a cookie to set), or a short page. */
export type OAuthAnswer = { redirect: string; setCookie?: string } | { status: number; text: string; setCookie?: string };

const COOKIE = "__Host-aaply-oauth-";
const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");
const MAX_TOKEN_RESPONSE = 64 * 1024;
const LEASE_MS = 30_000;

/** A secret as an OAuth connection keeps it. */
function secretOf(tokens: Record<string, unknown>, previous: Readonly<Record<string, string>> | null, now: number): Record<string, string> {
  const out: Record<string, string> = { accessToken: String(tokens.access_token) };
  const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : previous?.refreshToken;
  if (refresh) out.refreshToken = refresh;
  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) out.expiresAt = String(now + tokens.expires_in * 1000);
  return out;
}

export function createOAuth(options: { config: OAuthOptions; store: ConnectStore; oauthStore: OAuthStore; vault: Vault; admin: RawAdmin; fetch: FetchLike; scopesOf: (connectorId: string) => readonly string[]; now?: () => number }) {
  const { config, oauthStore, vault } = options;
  const now = options.now ?? Date.now;
  const ttl = config.attemptTtlMs ?? 10 * 60_000;
  const callback = new URL(config.redirectUri);
  const startUrl = new URL("/oauth/start", callback.origin);
  const holder = randomBytes(9).toString("base64url");
  const inFlight = new Map<string, Promise<Readonly<Record<string, string>>>>();

  const appOf = (connectorId: string) => {
    const app = config.apps[connectorId];
    if (!app) throw new AdminError("admin/invalid", `${connectorId} has no OAuth client configured here`);
    return app;
  };

  /** Calls a provider endpoint and reads its JSON answer (bounded). */
  async function post(app: { provider: OAuthProvider; clientId: string; clientSecret: string }, url: string, fields: Record<string, string>, signal?: AbortSignal) {
    const p = app.provider;
    const headers: Record<string, string> = { accept: "application/json" };
    const body = { ...fields, ...(p.clientAuth === "body" ? { client_id: app.clientId, client_secret: app.clientSecret } : {}) };
    if (p.clientAuth === "basic") headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString("base64")}`;
    headers["content-type"] = p.tokenBody === "json" && url === p.tokenUrl ? "application/json" : "application/x-www-form-urlencoded";
    const res = await options.fetch(url, {
      method: "POST",
      headers,
      body: headers["content-type"] === "application/json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    const text = (await res.text()).slice(0, MAX_TOKEN_RESPONSE);
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // Not JSON: the status decides.
    }
    return { status: res.status, json };
  }

  /** The account a fresh token belongs to. */
  async function identify(app: { provider: OAuthProvider }, tokens: Record<string, unknown>): Promise<{ id: string; name?: string }> {
    const spec = app.provider.identity;
    let source: Record<string, unknown> = tokens;
    if ("url" in spec) {
      const res = await options.fetch(spec.url, { method: "GET", headers: { authorization: `Bearer ${String(tokens.access_token)}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200) throw new Error(`identity answered ${res.status}`);
      source = JSON.parse((await res.text()).slice(0, MAX_TOKEN_RESPONSE)) as Record<string, unknown>;
    }
    const id = source[spec.id];
    if (typeof id !== "string" && typeof id !== "number") throw new Error("the provider did not say which account this is");
    const name = spec.name ? source[spec.name] : undefined;
    return { id: String(id), ...(typeof name === "string" ? { name } : {}) };
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
      const id = newId("oauth");
      const request: JsonObject = {
        scope: { ...input.scope },
        connectorId: input.connectorId,
        owner: "person" in input.owner ? { person: input.owner.person } : { business: true, ...(input.owner.role ? { role: input.owner.role } : {}) },
        environmentKind: input.environmentKind ?? "production",
        actor,
        returnTo: back.toString(),
        ...(input.reconnect ? { reconnect: input.reconnect } : {}),
      };
      await oauthStore.createAttempt(id, input.scope.tenantId, request, randomBytes(48).toString("base64url"), ttl);
      const url = new URL(startUrl);
      url.searchParams.set("attempt", id);
      return { url: url.toString(), expiresAt: now() + ttl };
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

      let tokens: Record<string, unknown>;
      let account: { id: string; name?: string };
      try {
        const res = await post(app, app.provider.tokenUrl, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: attempt.verifier });
        if (res.status !== 200 || typeof res.json.access_token !== "string") return back({ connect: "error", reason: "token-exchange" });
        tokens = res.json;
        account = await identify(app, tokens);
      } catch {
        return back({ connect: "error", reason: "provider-unreachable" });
      }
      const granted = typeof tokens.scope === "string" ? tokens.scope.split(/[\s,]+/).filter(Boolean) : [];
      const secret = secretOf(tokens, null, now());
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
    },

    /** Revokes a connection's token at its provider, as far as it can; answers whether the provider confirmed. */
    async revokeAtProvider(connectorId: string, secret: Readonly<Record<string, string>> | null): Promise<boolean> {
      const app = config.apps[connectorId];
      const token = secret?.refreshToken ?? secret?.accessToken;
      if (!app?.provider.revokeUrl || !token) return false;
      try {
        return (await post(app, app.provider.revokeUrl, { token }, AbortSignal.timeout(5_000))).status === 200;
      } catch {
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
      const openCurrent = async (tenantId: string, connectionId: string) => {
        const c = await oauthStore.current(tenantId, connectionId);
        if (!c || c.status !== "active" || !c.secret) throw new ConnectorError("final", "connect/reconsent", "This account needs to be connected again.");
        return { version: c.version, secret: await vault.open(tenantId, connectionId, c.secret.sealed, c.secret.dataKey) };
      };

      async function refresh(request: Parameters<TokenRefresher["refresh"]>[0]): Promise<Readonly<Record<string, string>>> {
        const { tenantId, connectionId, signal } = request;
        if (!(await oauthStore.takeLease(tenantId, connectionId, holder, LEASE_MS))) {
          // Another instance is refreshing: wait for its new version, a while.
          const until = Math.min(now() + 5_000, now() + LEASE_MS);
          while (now() < until && !signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const c = await openCurrent(tenantId, connectionId);
            if (c.version > request.version) return c.secret;
          }
          throw new ConnectorError("retryable", "connect/refresh-busy", "The account's sign-in is being renewed; try again.");
        }
        try {
          // Someone may have refreshed between the call reading the secret and this lease.
          const c = await openCurrent(tenantId, connectionId);
          if (c.version > request.version) return c.secret;
          const connectorId = await connectorOf(tenantId, connectionId);
          const app = connectorId ? config.apps[connectorId] : undefined;
          if (!app || !c.secret.refreshToken) {
            await options.admin.updateConnection(tenantId, connectionId, c.version, { status: "reauth" }).catch(() => undefined);
            throw new ConnectorError("final", "connect/reconsent", "This account needs to be connected again.");
          }
          let res: Awaited<ReturnType<typeof post>>;
          try {
            res = await post(app, app.provider.tokenUrl, { grant_type: "refresh_token", refresh_token: c.secret.refreshToken }, signal);
          } catch {
            throw new ConnectorError("retryable", "connect/refresh-failed", "The account's sign-in could not be renewed right now.");
          }
          if (res.status !== 200 || typeof res.json.access_token !== "string") {
            if (res.json.error === "invalid_grant" || res.status === 401) {
              // The grant is gone (revoked, expired, or a refresh token used twice): only the person can fix it.
              await options.admin.updateConnection(tenantId, connectionId, c.version, { status: "reauth" }).catch(() => undefined);
              throw new ConnectorError("final", "connect/reconsent", "This account needs to be connected again.");
            }
            throw new ConnectorError("retryable", "connect/refresh-failed", "The account's sign-in could not be renewed right now.");
          }
          const next = secretOf(res.json, c.secret, now());
          // Saved before the lease is released: a rotated refresh token is never lost.
          try {
            await options.admin.updateConnection(tenantId, connectionId, c.version, { secret: next });
          } catch (error) {
            if (!(error instanceof StoreConflict)) throw error;
            return (await openCurrent(tenantId, connectionId)).secret;
          }
          return next;
        } finally {
          await oauthStore.releaseLease(tenantId, connectionId, holder).catch(() => undefined);
        }
      }

      return {
        refresh(request) {
          // One refresh per connection in this process; every caller gets its result.
          const key = `${request.tenantId}/${request.connectionId}`;
          const pending = inFlight.get(key);
          if (pending) return pending;
          const run = refresh(request).finally(() => inFlight.delete(key));
          inFlight.set(key, run);
          return run;
        },
      };
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
