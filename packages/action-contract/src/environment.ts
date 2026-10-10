/**
 * Environment kinds: which kind of environment a call runs in, and which
 * kind of account it may use.
 *
 * The kind comes from the engine's trusted context, travels in the run's
 * state and on the envelope (`environment`, signed with every other field),
 * and reaches the performer's connection resolver. A connection may declare
 * the kind it serves; a performer refuses a call whose kind is not the
 * connection's with `connect/environment-mismatch` before anything is sent.
 * A connection that declares no kind is a production one, strictly: a
 * preview or test run never uses an account nobody declared as
 * non-production, and a production run never uses a sandbox account.
 */

import type { EnvironmentKind } from "./scope.js";

/** Every environment kind, in no particular order. */
export const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = Object.freeze(["production", "preview", "test"]);

/** The kind of a connection that declares none: production. */
export const UNDECLARED_ENVIRONMENT: EnvironmentKind = "production";

/** True for one of the {@link ENVIRONMENT_KINDS}. */
export function isEnvironmentKind(value: unknown): value is EnvironmentKind {
  return value === "production" || value === "preview" || value === "test";
}

/**
 * Whether a call of kind `call` may use a connection that declares
 * `connection` (undefined: it declares none, so it is production). Exact
 * match only.
 */
export function environmentAllows(call: EnvironmentKind, connection: EnvironmentKind | undefined): boolean {
  return call === (connection ?? UNDECLARED_ENVIRONMENT);
}
