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
const POLL_MS = 250;

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
  /** Per connection and kind of call: the shared refresh, how many callers still wait on it, and a switch that stops a refresh nobody waits for any more. */
  const inFlight = new Map<string, { run: Promise<Secret>; waiting: number; unwanted: AbortController }>();

  const current = async (tenantId: string, connectionId: string) => {
    const c = await oauthStore.current(tenantId, connectionId);
    if (!c || c.status !== "active" || !c.secret) throw reconsent();
    return { version: c.version, secret: await vault.open(tenantId, connectionId, c.secret.sealed, c.secret.dataKey) };
  };

  const markReauth = async (tenantId: string, connectionId: string, version: number) => {
    await admin.updateConnection(tenantId, connectionId, version, { status: "reauth" }).catch((error: unknown) => options.report(error, "oauth.reauth"));
  };

  /**
   * Saves the new secret on the connection as it is now, however often it
   * changed meanwhile, unless the account was connected again meanwhile
   * (new tokens, perhaps for more scopes): those win, and are answered.
   */
  async function save(tenantId: string, connectionId: string, version: number, used: Secret, next: Secret): Promise<Secret> {
    let at = version;
    for (let i = 0; i < 5; i++) {
      try {
        await admin.updateConnection(tenantId, connectionId, at, { secret: next });
        return next;
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        const c = await current(tenantId, connectionId);
        if (c.secret.refreshToken !== used.refreshToken) return c.secret;
        at = c.version;
      }
    }
    throw failed();
  }

  async function refresh(tenantId: string, connectionId: string, used: Secret, wait: boolean, unwanted: AbortSignal): Promise<Secret> {
    const until = now() + LEASE_MS;
    // Another instance is refreshing. A call whose token still works does not wait; the others watch for the new
    // token, and take the lease themselves if it comes free without one (that instance failed).
    while (!(await oauthStore.takeLease(tenantId, connectionId, options.holder, LEASE_MS))) {
      if (!wait || unwanted.aborted || now() >= until) throw new ConnectorError("retryable", "connect/refresh-busy", "The account's sign-in is being renewed; try again.");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const c = await current(tenantId, connectionId);
      if (c.secret.accessToken !== used.accessToken) return c.secret;
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
        // RFC 6749 names the error in `error`; Notion's API errors name it in `code`.
        if ((res.json.error ?? res.json.code) === "invalid_grant") {
          // The grant is gone (revoked, expired, or a refresh token used twice): only the person can fix it.
          await markReauth(tenantId, connectionId, c.version);
          throw reconsent();
        }
        // invalid_client and the like are the deployment's to fix, not the person's: the connection stays as it is.
        options.report(new Error(`the token endpoint answered ${res.status}${typeof res.json.error === "string" ? ` ${res.json.error}` : ""}`), "oauth.refresh");
        throw failed();
      }
      return await save(tenantId, connectionId, c.version, c.secret, tokenSecret(res.json, c.secret, now()));
    } finally {
      await oauthStore.releaseLease(tenantId, connectionId, options.holder).catch(() => undefined);
    }
  }

  return {
    refresh(request) {
      // One refresh per connection (and kind of call) in this process; every caller gets its result, each waiting only within its own budget.
      const wait = request.wait !== false;
      const key = `${request.tenantId}/${request.connectionId}/${wait ? "wait" : "now"}`;
      let entry = inFlight.get(key);
      if (!entry) {
        const unwanted = new AbortController();
        const run = refresh(request.tenantId, request.connectionId, request.secret, wait, unwanted.signal).finally(() => inFlight.delete(key));
        entry = { run, waiting: 0, unwanted };
        inFlight.set(key, entry);
      }
      const shared = entry;
      shared.waiting++;
      return new Promise<Secret>((resolve, reject) => {
        const done = () => {
          request.signal.removeEventListener("abort", stop);
          // Nobody waits any more: a refresh still waiting on another instance stops (one already at the provider finishes and saves).
          if (--shared.waiting === 0) shared.unwanted.abort();
        };
        const stop = () => (done(), reject(request.signal.reason));
        if (request.signal.aborted) return stop();
        request.signal.addEventListener("abort", stop, { once: true });
        shared.run.then(
          (value) => (done(), resolve(value)),
          (error: unknown) => (done(), reject(error)),
        );
      });
    },
  };
}
