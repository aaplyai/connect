/** How Google's APIs answer a refusal, mapped to outcomes the engine can act on. */

import { ConnectorError, type ConnectorResponse } from "@aaply/connector-sdk";

/** Google's per-user and per-project limits answer 403 with these reasons: wait and ask again. */
const RATE_LIMITED = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

function reasonOf(res: ConnectorResponse): string | null {
  try {
    const body = res.json() as { error?: { errors?: Array<{ reason?: unknown }> } } | null;
    const reason = body?.error?.errors?.[0]?.reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

/**
 * The response when 2xx; otherwise throws the error it means. A 403 for a
 * rate limit is retryable (Google answers some with 403, not 429), 404 is
 * `<prefix>/not-found` (final), and anything else is the kit's mapping by
 * status.
 */
/** True for a 403 that is one of Google's rate limits. */
export function retryableGoogle(res: ConnectorResponse): boolean {
  if (res.status !== 403) return false;
  const reason = reasonOf(res);
  return reason !== null && RATE_LIMITED.has(reason);
}

export function googleOk(res: ConnectorResponse, prefix: string): ConnectorResponse {
  if (res.ok) return res;
  if (retryableGoogle(res)) throw ConnectorError.retryable("http/403", "Google is rate limiting requests.", { retryAfterMs: 5_000 });
  if (res.status === 404) throw ConnectorError.final(`${prefix}/not-found`, "Google found no such file, or this connection may not open it.");
  return res.ensureOk();
}
