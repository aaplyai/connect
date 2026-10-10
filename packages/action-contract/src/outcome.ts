/**
 * What happened to an action: the five outcomes, and the normaliser that
 * turns whatever a port answered into one of them.
 */

import { checkJson, isJsonObject, jsonByteLength, type JsonValue } from "./json.js";
import type { ActionEffectKind } from "./scope.js";

/** Why an action did not work. */
export interface ActionError {
  code: string;
  /** Shown to people: no payload values, nothing the service echoed back. */
  message: string;
  /** Internal detail for staff and logs; never shown to the person. */
  detail?: string;
}

/**
 * Which bucket a rate limit belongs to: one connection (one account), or the
 * whole connector. With a store that has fair lanes, a `retryAfterMs` pauses
 * only that bucket; without `limit` it pauses the effect's lane.
 */
export type RateLimitBucket = "connection" | "connector";

/**
 * Largest action output kept, in bytes of its JSON (1 MiB, the most a flow's
 * fact may hold, so an output never limits what a flow may derive). An output is
 * stored whole in the run's state and event log, so it is for what the flow
 * reads, never for content: large or binary content stays at the service, and
 * the output names it (a blob reference: an id or a URL the flow passes on).
 * A read over it fails; a write over it is recorded as applied with its output
 * withheld.
 */
export const MAX_ACTION_OUTPUT_BYTES = 1024 * 1024;

/** What an action port answers. */
export type ActionOutcome =
  /**
   * Applied. `withheld` is set, with `output: null`, when the output was
   * larger than the performer or the engine keeps
   * ({@link MAX_ACTION_OUTPUT_BYTES}): the write was applied, but its output
   * is not kept. Never on a read, which fails instead.
   */
  | { status: "ok"; output: JsonValue; withheld?: { bytes: number } }
  /** Not applied; a transient problem. Safe to try again. */
  | { status: "retryable"; error: ActionError; retryAfterMs?: number; limit?: RateLimitBucket }
  /** Not applied; trying again will not help. */
  | { status: "final"; error: ActionError }
  /** May or may not have been applied (for example a timeout after sending). */
  | { status: "unknown"; error: ActionError }
  /**
   * Accepted; the result arrives later through `completeAction` with the same
   * effect id. `ref` is the performer's own reference for it (a provider's
   * job or payment id), for traces and support.
   */
  | { status: "pending"; ref?: string };

/** Longest `pending.ref` kept. A longer or malformed one is dropped, not the outcome. */
export const MAX_PENDING_REF_LENGTH = 256;

const OUTCOME_STATUSES = new Set(["ok", "retryable", "final", "unknown", "pending"]);
const REF_RE = /^[\x21-\x7e]+$/;

/** Options of {@link normalizeOutcome}. */
export interface NormalizeOutcomeOptions {
  /** Largest output kept, in bytes of JSON. Default {@link MAX_ACTION_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
}

function withheldOf(value: unknown): { bytes: number } | undefined {
  if (!isJsonObject(value as JsonValue)) return undefined;
  const bytes = (value as Record<string, unknown>).bytes;
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes } : undefined;
}

/**
 * True when `value` is an outcome as written: plain JSON (no cycles,
 * functions, symbols or non-finite numbers), an object, and a `status` that
 * is one of the five. Never throws. Fields beyond `status` are left to
 * {@link normalizeOutcome}, which caps or drops what it does not accept. A
 * completion that is not one is refused rather than recorded. A guard: a
 * caller that checked needs no cast to read the value as an outcome.
 */
export function isActionOutcome(value: unknown): value is ActionOutcome {
  try {
    if (checkJson(value) !== null || !isJsonObject(value as JsonValue)) return false;
    const status = (value as Record<string, unknown>).status;
    return typeof status === "string" && OUTCOME_STATUSES.has(status);
  } catch {
    // A getter that throws, or a proxy: not an outcome.
    return false;
  }
}

/**
 * Turns anything a port answered into a well-formed outcome. Never throws. A
 * malformed answer (one {@link isActionOutcome} refuses, or with an `ok`
 * output that is not plain JSON) counts as `retryable` for a read (nothing
 * changed) and `unknown` for a write (something may have), with code
 * `flow/bad-outcome`. Codes, messages and details are capped. An output over
 * `maxOutputBytes` (or one a performer already withheld) fails a read
 * (`final`, `flow/output-too-large`) and is withheld from a write, which stays
 * applied: `{ status: "ok", output: null, withheld: { bytes } }`.
 */
export function normalizeOutcome(raw: unknown, effect: ActionEffectKind, options: NormalizeOutcomeOptions = {}): ActionOutcome {
  const fallback: ActionOutcome =
    effect === "read" ? { status: "retryable", error: { code: "flow/bad-outcome", message: "The service answered strangely." } } : { status: "unknown", error: { code: "flow/bad-outcome", message: "The service answered strangely." } };
  try {
    return normalized(raw, effect, options) ?? fallback;
  } catch {
    // A getter that throws, or a proxy, in an answer that looked like an object.
    return fallback;
  }
}

function normalized(raw: unknown, effect: ActionEffectKind, options: NormalizeOutcomeOptions): ActionOutcome | null {
  if (!isJsonObject(raw as JsonValue)) return null;
  const status = (raw as Record<string, unknown>).status;
  if (typeof status !== "string" || !OUTCOME_STATUSES.has(status)) return null;
  const r = raw as Record<string, unknown>;
  const error = () => {
    const e = r.error;
    const code = isJsonObject(e as JsonValue) && typeof (e as Record<string, unknown>).code === "string" ? String((e as Record<string, unknown>).code).slice(0, 100) : "error";
    const message = isJsonObject(e as JsonValue) && typeof (e as Record<string, unknown>).message === "string" ? String((e as Record<string, unknown>).message).slice(0, 500) : "The service had a problem.";
    // Internal text for staff and logs, never shown to the person.
    const detail = isJsonObject(e as JsonValue) && typeof (e as Record<string, unknown>).detail === "string" ? String((e as Record<string, unknown>).detail).slice(0, 2000) : undefined;
    return { code, message, ...(detail !== undefined ? { detail } : {}) };
  };
  switch (r.status) {
    case "ok": {
      const output = r.output === undefined ? null : r.output;
      if (checkJson(output)) return null;
      const max = options.maxOutputBytes ?? MAX_ACTION_OUTPUT_BYTES;
      const bytes = jsonByteLength(output as JsonValue);
      const withheld = bytes > max ? { bytes } : output === null ? withheldOf(r.withheld) : undefined;
      if (withheld) {
        if (effect === "read") return { status: "final", error: { code: "flow/output-too-large", message: "The answer was too large to use.", detail: `${withheld.bytes} bytes; at most ${max} are kept` } };
        return { status: "ok", output: null, withheld };
      }
      return { status: "ok", output: output as JsonValue };
    }
    case "pending": {
      const ref = r.ref;
      return typeof ref === "string" && ref.length <= MAX_PENDING_REF_LENGTH && REF_RE.test(ref) ? { status: "pending", ref } : { status: "pending" };
    }
    case "retryable": {
      const after = typeof r.retryAfterMs === "number" && Number.isFinite(r.retryAfterMs) && r.retryAfterMs >= 0 ? { retryAfterMs: r.retryAfterMs } : {};
      const limit: { limit?: RateLimitBucket } = r.limit === "connection" || r.limit === "connector" ? { limit: r.limit } : {};
      return { status: "retryable", error: error(), ...after, ...limit };
    }
    case "final":
      return { status: "final", error: error() };
    default:
      return { status: "unknown", error: error() };
  }
}
