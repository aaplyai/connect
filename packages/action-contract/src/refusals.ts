/**
 * How whoever performs an action refuses it before sending anything.
 *
 * A refusal is always `final` (it will never work as sent) or `retryable`
 * (try again later). It is never `unknown`, so the engine never reconciles a
 * call that was not made. Staff-only reasons go in `error.detail`.
 */

import { deepFreeze } from "./frozen.js";
import type { ActionOutcome, RateLimitBucket } from "./outcome.js";

/** Every refusal code and the outcome it is answered with. */
export const CONNECT_REFUSALS = deepFreeze({
  /**
   * The envelope's `contract` version is not one this performer serves.
   * Retryable, with `retryAfterMs`: during a rollout the next attempt may
   * reach a performer that serves it (see `contract-versions.ts`).
   */
  "connect/contract-unsupported": "retryable",
  /** The envelope is not an approved action of a version this performer serves. */
  "connect/invalid-envelope": "final",
  /** The approval's `notAfter` has passed: the review must be given again. */
  "connect/expired": "final",
  /** The envelope is for another performer (`audience`). */
  "connect/wrong-audience": "final",
  /** The envelope's proof does not verify, or it is unsigned. */
  "connect/proof-invalid": "final",
  /**
   * The same attempt of a write that does not de-duplicate was sent again.
   * Final for this delivery, but the first delivery may have been performed:
   * the engine records it as `unknown` for a write, never as a failure.
   */
  "connect/replayed": "final",
  /** No operation with this action id. */
  "connect/unknown-action": "final",
  /** The flow pinned an operation contract this performer does not serve. */
  "connect/contract-mismatch": "final",
  /** A write sent as a read, an undo or reconcile of the wrong kind, or an undo-only operation sent as a step (`run`). */
  "connect/effect-mismatch": "final",
  /** A write marked idempotent that does not de-duplicate. */
  "connect/idempotency-mismatch": "final",
  /** The input does not match the operation's schema or the envelope's digest. */
  "connect/invalid-input": "final",
  /** No connection is bound for this role. */
  "connect/no-connection": "final",
  /** The bound connection belongs to someone else. */
  "connect/not-own-connection": "final",
  /** The bound connection serves another kind of environment (a sandbox account for a production run, or the reverse). */
  "connect/environment-mismatch": "final",
  /** The action acts for the run's person, and the run has none. */
  "connect/no-subject": "final",
  /** The account must consent again (a scope is missing). */
  "connect/reconsent": "final",
  /** The account's access was revoked. */
  "connect/connection-revoked": "final",
  /** Tenant policy does not allow this call. */
  "connect/policy-denied": "final",
  /** The approval evidence is missing, for other input, or below the operation's risk floor. */
  "connect/approval-invalid": "final",
  /** The call would reach a host the operation may not reach. */
  "connect/egress-denied": "final",
  /** The action is turned off for this tenant or environment. */
  "connect/disabled": "final",
  /** This attempt's deadline has passed; the next attempt is sent with a new one. */
  "connect/late": "retryable",
  /** The envelope's times do not fit the performer's clock (issued in the future, or due beyond its timeout). */
  "connect/clock-skew": "retryable",
  /** Too many calls; `retryAfterMs` says when to try again, and `limit` which bucket was hit. */
  "connect/rate-limited": "retryable",
  /** The performer cannot take the call now (or cannot check it: a verifier or replay guard failed). */
  "connect/unavailable": "retryable",
} as const satisfies Record<string, "final" | "retryable">);

/** A refusal code. */
export type ConnectRefusalCode = keyof typeof CONNECT_REFUSALS;

/** True when `code` is one of the {@link CONNECT_REFUSALS}. */
export function isRefusalCode(code: unknown): code is ConnectRefusalCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CONNECT_REFUSALS, code);
}

/** Options of {@link refuse}. `retryAfterMs` and `limit` apply to a retryable refusal only. */
export interface RefuseOptions {
  /** Staff-only detail. */
  detail?: string;
  /** When to try again. */
  retryAfterMs?: number;
  /** Which bucket a rate limit belongs to: the connection (one account) or the whole connector. */
  limit?: RateLimitBucket;
}

/** Builds the outcome for a refusal, `final` or `retryable` as the table says. */
export function refuse(code: ConnectRefusalCode, message: string, options: RefuseOptions = {}): ActionOutcome {
  const error = { code, message, ...(options.detail !== undefined ? { detail: options.detail } : {}) };
  if (CONNECT_REFUSALS[code] === "retryable") {
    return {
      status: "retryable",
      error,
      ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
      ...(options.limit === "connection" || options.limit === "connector" ? { limit: options.limit } : {}),
    };
  }
  return { status: "final", error };
}

/**
 * When an attempt refused `connect/contract-unsupported` is tried again:
 * 30 s. During a rollout the next attempt may reach a performer that serves
 * the version (see `contract-versions.ts`).
 */
export const CONTRACT_UNSUPPORTED_RETRY_MS = 30_000;
