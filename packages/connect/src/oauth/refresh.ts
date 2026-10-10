/**
 * Renewing OAuth tokens. One refresh per connection at a time: in this
 * process every caller shares one (single flight), and across instances a
 * lease row decides who sends the refresh token. The refresh runs on its
 * own clock, never a caller's: a caller that gives up stops waiting, but the
 * provider's answer is still read and saved, so a rotated refresh token is
 * never dropped. It is saved before the lease is released, onto whatever
 * version the connection has by then.
 *
 * Only the provider saying the grant is gone (`invalid_grant`) marks the
 * connection `reauth`; anything else (a bad client secret, an outage) is
 * retryable and leaves the connection as it is.
 */

import { ConnectorError, type FetchLike } from "@aaply/connector-sdk";
import type { RawAdmin } from "../admin.js";
import type { TokenRefresher } from "../credentials.js";
import type { OAuthStore } from "../store/oauth-store.js";
import { StoreConflict } from "../store/store.js";
import type { Vault } from "../vault.js";
import { PROVIDER_TIMEOUT_MS, providerPost, type OAuthApp } from "./provider-http.js";

/** Longer than a provider call can take, so a live holder never loses its lease mid-refresh. */
const LEASE_MS = PROVIDER_TIMEOUT_MS * 3;
const POLL_MS = 200;

type Secret = Readonly<Record<string, string>>;

const reconsent = () => new ConnectorError("final", "connect/reconsent", "This account needs to be connected again.");
const failed = () => new ConnectorError("retryable", "connect/refresh-failed", "The account's sign-in could not be renewed right now.");

/** A secret as an OAuth connection keeps it: a provider that sends no new refresh token keeps the old one valid. */
export function tokenSecret(tokens: Record<string, unknown>, previous: Secret | null, now: number): Record<string, string> {
  const out: Record<string, string> = { accessToken: String(tokens.access_token) };
  const refresh = typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : previous?.refreshToken;
  if (refresh) out.refreshToken = refresh;
  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) out.expiresAt = String(now + tokens.expires_in * 1000);
  return out;
}

export function createRefresher(options: {
  oauthStore: OAuthStore;
  vault: Vault;
  admin: RawAdmin;
  fetch: FetchLike;
  appOf: (tenantId: string, connectionId: string) => Promise<OAuthApp | undefined>;
  holder: string;
  now: () => number;
  report: (error: unknown, where: string) => void;
}): TokenRefresher {
  const { oauthStore, vault, admin, now } = options;
  const inFlight = new Map<string, Promise<Secret>>();

  const current = async (tenantId: string, connectionId: string) => {
    const c = await oauthStore.current(tenantId, connectionId);
    if (!c || c.status !== "active" || !c.secret) throw reconsent();
    return { version: c.version, secret: await vault.open(tenantId, connectionId, c.secret.sealed, c.secret.dataKey) };
  };

  const markReauth = async (tenantId: string, connectionId: string, version: number) => {
    await admin.updateConnection(tenantId, connectionId, version, { status: "reauth" }).catch((error: unknown) => options.report(error, "oauth.reauth"));
  };

  /** Saves the new secret on the connection as it is now, however often it changed meanwhile. */
  async function save(tenantId: string, connectionId: string, version: number, next: Secret): Promise<void> {
    let at = version;
    for (let i = 0; i < 5; i++) {
      try {
        await admin.updateConnection(tenantId, connectionId, at, { secret: next });
        return;
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        const c = await oauthStore.current(tenantId, connectionId);
        if (!c || c.status === "revoked") return;
        at = c.version;
      }
    }
    throw failed();
  }

  async function refresh(tenantId: string, connectionId: string, used: Secret, wait: boolean): Promise<Secret> {
    if (!(await oauthStore.takeLease(tenantId, connectionId, options.holder, LEASE_MS))) {
      // Another instance is refreshing. A call whose token still works does not wait; the others watch for the new token.
      if (!wait) throw new ConnectorError("retryable", "connect/refresh-busy", "The account's sign-in is being renewed; try again.");
      const until = now() + LEASE_MS;
      while (now() < until) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const c = await current(tenantId, connectionId);
        if (c.secret.accessToken !== used.accessToken) return c.secret;
      }
      throw new ConnectorError("retryable", "connect/refresh-busy", "The account's sign-in is being renewed; try again.");
    }
    try {
      // Someone may have renewed it between the call reading the secret and this lease.
      const c = await current(tenantId, connectionId);
      if (c.secret.accessToken !== used.accessToken) return c.secret;
      const app = await options.appOf(tenantId, connectionId);
      if (!app || !c.secret.refreshToken) {
        await markReauth(tenantId, connectionId, c.version);
        throw reconsent();
      }
      let res: Awaited<ReturnType<typeof providerPost>>;
      try {
        res = await providerPost(options.fetch, app, app.provider.tokenUrl, { grant_type: "refresh_token", refresh_token: c.secret.refreshToken });
      } catch (error) {
        options.report(error, "oauth.refresh");
        throw failed();
      }
      if (res.status !== 200 || typeof res.json.access_token !== "string" || !res.json.access_token) {
        if (res.json.error === "invalid_grant") {
          // The grant is gone (revoked, expired, or a refresh token used twice): only the person can fix it.
          await markReauth(tenantId, connectionId, c.version);
          throw reconsent();
        }
        // invalid_client and the like are the deployment's to fix, not the person's: the connection stays as it is.
        options.report(new Error(`the token endpoint answered ${res.status}${typeof res.json.error === "string" ? ` ${res.json.error}` : ""}`), "oauth.refresh");
        throw failed();
      }
      const next = tokenSecret(res.json, c.secret, now());
      await save(tenantId, connectionId, c.version, next);
      return next;
    } finally {
      await oauthStore.releaseLease(tenantId, connectionId, options.holder).catch(() => undefined);
    }
  }

  return {
    refresh(request) {
      // One refresh per connection in this process; every caller gets its result, each waiting only within its own budget.
      const key = `${request.tenantId}/${request.connectionId}`;
      let run = inFlight.get(key);
      if (!run) {
        run = refresh(request.tenantId, request.connectionId, request.secret, request.wait !== false).finally(() => inFlight.delete(key));
        inFlight.set(key, run);
      }
      const shared = run;
      return new Promise<Secret>((resolve, reject) => {
        if (request.signal.aborted) return reject(request.signal.reason);
        const stop = () => reject(request.signal.reason);
        request.signal.addEventListener("abort", stop, { once: true });
        shared.then(
          (value) => (request.signal.removeEventListener("abort", stop), resolve(value)),
          (error: unknown) => (request.signal.removeEventListener("abort", stop), reject(error)),
        );
      });
    },
  };
}
