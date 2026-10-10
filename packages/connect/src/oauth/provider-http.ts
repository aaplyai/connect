/**
 * Talking to an OAuth provider: its token and revoke endpoints, and where it
 * says which account a token belongs to. Every call has its own timeout and
 * reads at most 64 KiB, whoever is waiting for it.
 */

import type { FetchLike } from "@aaply/connector-sdk";
import type { OAuthProvider } from "./providers.js";

export interface OAuthApp {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
}

const MAX_RESPONSE = 64 * 1024;
/** Each provider call's own limit. A refresh lease outlasts it, so no two instances ever send one refresh token. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** A response body, refused past `max` bytes as they arrive (never read whole first). */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`the provider answered more than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the status decides.
  }
  return {};
}

/** A value at a dotted path (`owner.user.id`), or undefined. */
export function pick(source: unknown, path: string): unknown {
  let at: unknown = source;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** POSTs to a provider endpoint as Aaply's client and reads its JSON answer. */
export async function providerPost(fetch: FetchLike, app: OAuthApp, url: string, fields: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const p = app.provider;
  const json = p.tokenBody === "json" && url === p.tokenUrl;
  const headers: Record<string, string> = { accept: "application/json", "content-type": json ? "application/json" : "application/x-www-form-urlencoded" };
  const body = { ...fields, ...(p.clientAuth === "body" ? { client_id: app.clientId, client_secret: app.clientSecret } : {}) };
  if (p.clientAuth === "basic") headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString("base64")}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  return { status: res.status, json: jsonObject(await readCapped(res, MAX_RESPONSE)) };
}

/** The account a fresh token belongs to: its stable id, a name for people, and its email when the provider says. */
export async function identify(fetch: FetchLike, app: OAuthApp, tokens: Record<string, unknown>): Promise<{ id: string; name?: string; email?: string }> {
  const spec = app.provider.identity;
  let source: unknown = tokens;
  if ("url" in spec) {
    const res = await fetch(spec.url, { method: "GET", headers: { authorization: `Bearer ${String(tokens.access_token)}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    const text = await readCapped(res, MAX_RESPONSE);
    if (res.status !== 200) throw new Error(`identity answered ${res.status}`);
    source = jsonObject(text);
  }
  const id = pick(source, spec.id);
  if ((typeof id !== "string" || id.length === 0) && typeof id !== "number") throw new Error("the provider did not say which account this is");
  const name = spec.name ? pick(source, spec.name) : undefined;
  // An email the provider has not verified names nobody (`expectAccount` cannot match it).
  const verified = spec.emailVerified ? pick(source, spec.emailVerified) === true : true;
  const email = spec.email && verified ? pick(source, spec.email) : undefined;
  return { id: String(id), ...(typeof name === "string" ? { name } : {}), ...(typeof email === "string" ? { email } : {}) };
}
