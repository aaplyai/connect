/**
 * How a connection's secret becomes request headers. The kit adds them only
 * to requests to the connector's declared hosts, and the handler never sees
 * them.
 *
 * - `apiKey`: the secret is the headers themselves, each field named
 *   `header:<name>` (`header:authorization` → `Bearer …`, `header:x-api-key`).
 * - `oauth2`: the secret holds `accessToken` (and, for refresh, what the
 *   OAuth module keeps); the header is `authorization: Bearer <accessToken>`.
 *   Refreshing is the OAuth module's, given as {@link TokenRefresher}.
 */

import { ConnectorError, type AuthSpec } from "@aaply/connector-sdk";

const HEADER = /^header:([a-z0-9-]{1,64})$/;
const FORBIDDEN = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie"]);

/** Checks a secret before it is sealed: what the connector's auth needs, and nothing it cannot use. */
export function secretProblem(auth: AuthSpec, secret: Readonly<Record<string, string>> | null): string | null {
  if (auth.kind === "none") return secret === null || Object.keys(secret).length === 0 ? null : "this connector takes no secret";
  if (secret === null) return "this connector needs a secret";
  if (auth.kind === "oauth2") return typeof secret.accessToken === "string" && secret.accessToken.length > 0 ? null : "an OAuth connection needs accessToken";
  const names = Object.keys(secret);
  if (names.length === 0) return "an API key connection needs at least one header:<name> field";
  for (const name of names) {
    const m = HEADER.exec(name);
    if (!m) return `${name}: an API key secret's fields are header:<lower-case header name>`;
    if (FORBIDDEN.has(m[1]!)) return `${name}: that header is set by the platform`;
  }
  return null;
}

/** The headers a secret stands for. */
export function headersOf(auth: AuthSpec, secret: Readonly<Record<string, string>> | null): Record<string, string> {
  if (auth.kind === "none") return {};
  if (secret === null) throw new ConnectorError("final", "connect/reconsent", "This account needs to be connected again.");
  if (auth.kind === "oauth2") return { authorization: `Bearer ${secret.accessToken ?? ""}` };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secret)) {
    const m = HEADER.exec(name);
    if (m) out[m[1]!] = value;
  }
  return out;
}

/** What the OAuth module plugs in: a fresh secret for a connection whose token was refused or is about to expire. */
export interface TokenRefresher {
  /** Answers the refreshed secret (already saved), or throws a `ConnectorError` (`final` `connect/reconsent` when the grant is gone). */
  refresh(request: { tenantId: string; connectionId: string; version: number; secret: Readonly<Record<string, string>>; signal: AbortSignal }): Promise<Readonly<Record<string, string>>>;
}

/** Whether an OAuth secret's access token runs out within a minute, so it is renewed before use. */
export function nearExpiry(secret: Readonly<Record<string, string>> | null, now: number): boolean {
  const at = Number(secret?.expiresAt);
  return Number.isFinite(at) && at - now < 60_000;
}
