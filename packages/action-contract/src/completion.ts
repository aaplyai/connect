/**
 * Completing an action that answered `pending`.
 *
 * The performer keeps the envelope's `completion.token` and, once the
 * outside service reports the result (a verified webhook, a finished job),
 * sends a {@link CompletionRequest} to the engine's `completeAction`. The
 * token is an HMAC the engine minted for exactly that scope, run, effect and
 * attempt, so a completion cannot settle any other effect. Repeating an
 * identical completion is safe: the engine answers `already`, so the
 * performer can retry until it gets an answer.
 */

import type { ActionOutcome } from "./outcome.js";

/** What a performer sends to complete a pending action. */
export interface CompletionRequest {
  runId: string;
  effectId: string;
  attempt: number;
  outcome: ActionOutcome;
  /** The envelope's `completion.token`. */
  token: string;
}

/**
 * How the engine took a completion:
 * - `now`: this completion settled the effect;
 * - `already`: an identical completion settled it before;
 * - `late`: the engine had already put the effect in doubt (its pending timed
 *   out) and this completion was recorded: it settled the effect when it said
 *   what happened (`ok`; or `final` or `retryable` for an attempt no earlier
 *   one may have applied before), and is kept for staff otherwise;
 * - `stale`: the effect no longer waits for this attempt (it was retried or checked, settled by staff, or the run ended), so nothing changed.
 *
 * A completion that disagrees with the one already recorded is refused as a conflict.
 */
export interface CompletionResult {
  settled: "now" | "late" | "already" | "stale";
}
