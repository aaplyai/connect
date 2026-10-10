/**
 * How long an operation's service may take to report a deferred result.
 *
 * A call that answers `pending` (the kit's `ctx.defer`) is finished by the
 * service later, through a webhook or a job, and the engine waits for its
 * completion. Without a declared window it waits for the action's
 * `timeoutMs`, the time a request may take; an operation whose service
 * reports a day later declares `completion: { windowMs }` in its contract,
 * and the engine waits that long instead. When the window ends the effect
 * goes in doubt as before, and a completion that arrives later is still
 * recorded (`late`).
 */

import { isJsonObject, type JsonValue } from "./json.js";

/** Longest completion window an operation may declare: 30 days. */
export const MAX_COMPLETION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** An operation's declared completion window (`OperationContract.completion`). */
export interface OperationCompletion {
  /** How long, in ms from its `pending` answer, the service may take to report the result: a positive integer up to {@link MAX_COMPLETION_WINDOW_MS}. */
  windowMs: number;
}

/** True for a completion window as written: exactly `{ windowMs }`, a positive integer up to {@link MAX_COMPLETION_WINDOW_MS}. Never throws. */
export function isOperationCompletion(value: unknown): value is OperationCompletion {
  try {
    if (!isJsonObject(value as JsonValue)) return false;
    const keys = Object.keys(value as object);
    if (keys.length !== 1 || keys[0] !== "windowMs") return false;
    const ms = (value as Record<string, unknown>).windowMs;
    return typeof ms === "number" && Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_COMPLETION_WINDOW_MS;
  } catch {
    return false;
  }
}
