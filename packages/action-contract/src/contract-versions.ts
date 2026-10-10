/**
 * Contract-version discovery: which envelope versions a performer serves, so
 * an engine sends one it can perform.
 *
 * An `ActionPort` may `describe()` itself (`{ contracts }`, the versions it
 * serves). The engine asks before sending, sends the highest version both
 * sides know ({@link pickContractVersion}), and records it on the envelope
 * (`contract`). A port that does not describe itself is sent contract 1.
 *
 * `connect/contract-unsupported` is `retryable`, with `retryAfterMs`
 * (`CONTRACT_UNSUPPORTED_RETRY_MS`): during a rollout the next attempt
 * may reach a performer that serves the version. The deploy order is still
 * performers first, so the version an engine picks is always served.
 */

import { ACTION_CONTRACT_VERSION } from "./approved.js";
import { isJsonObject, type JsonValue } from "./json.js";

/** The envelope versions this package builds and checks, oldest first. */
export const ACTION_CONTRACT_VERSIONS: readonly number[] = Object.freeze([ACTION_CONTRACT_VERSION]);

/** Most versions a description may list. */
export const MAX_DESCRIBED_CONTRACTS = 64;

/** What an action port says about itself (`ActionPort.describe`). Other fields may be added later; a reader ignores them. */
export interface ActionPortDescription {
  /** The envelope versions the port serves: distinct positive integers, at least one. */
  contracts: number[];
}

/** True for a well-formed description: `contracts` lists 1 to 64 distinct positive integers. Other fields are allowed. Never throws. */
export function isActionPortDescription(value: unknown): value is ActionPortDescription {
  try {
    if (!isJsonObject(value as JsonValue)) return false;
    const contracts = (value as Record<string, unknown>).contracts;
    if (!Array.isArray(contracts) || contracts.length === 0 || contracts.length > MAX_DESCRIBED_CONTRACTS) return false;
    if (!contracts.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0)) return false;
    return new Set(contracts).size === contracts.length;
  } catch {
    return false;
  }
}

/** The highest version both lists hold, or null when they share none. */
export function pickContractVersion(sender: readonly number[], performer: readonly number[]): number | null {
  const served = new Set(performer);
  let best: number | null = null;
  for (const version of sender) if (served.has(version) && (best === null || version > best)) best = version;
  return best;
}
