/**
 * The runtime's refusals. In a module of their own so the modules the
 * runtime delegates to (privacy, health) can throw them without importing
 * the runtime; `runtime.ts` re-exports both names.
 */

/**
 * Why a call at the runtime boundary was refused:
 * - `not_found`: no such run, flow or hold the caller may see;
 * - `forbidden`: the caller may not do this;
 * - `invalid`: the request is malformed;
 * - `conflict`: the request crossed another change;
 * - `denied`: policy refuses it (a forced move without approval, a full workspace);
 * - `rate_limited`: admission refused the request; try again after `retryAfterMs` when given;
 * - `unavailable`: a port or the store failed, or the store lacks what the call needs.
 */
export type FlowErrorCode = "not_found" | "forbidden" | "invalid" | "conflict" | "denied" | "rate_limited" | "unavailable";

/** A refusal at the runtime boundary (as opposed to a flow's own rejection of an input). */
export class FlowError extends Error {
  readonly code: FlowErrorCode;
  /** When to try again, for `rate_limited` only (and only when admission said). */
  readonly retryAfterMs?: number;

  constructor(code: FlowErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "FlowError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}
