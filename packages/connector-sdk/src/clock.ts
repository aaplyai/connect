/**
 * Time, injectable. The same shape as the engine's `Clock`, so the engine's
 * clock (or a test clock) can be passed straight in.
 */

/** Epoch milliseconds now. */
import { deepFreeze } from "@aaply/action-contract/internal";

export interface Clock {
  now(): number;
}

/** The system clock. */
export const systemClock: Clock = deepFreeze({ now: () => Date.now() });
