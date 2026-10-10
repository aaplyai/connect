/**
 * Which envelope version the runtime sends: the highest one both it and the
 * action port serve (ADR-0002, G1 amendment).
 *
 * A port that describes itself (`ActionPort.describe`) is asked before the
 * first send, and its answer is kept for a minute; a port that refuses an
 * envelope as `connect/contract-unsupported`, or shares no version with the
 * engine, is asked again on the next send. A port with no `describe`, or whose description fails, takes too
 * long or does not parse, is sent contract 1, as before (and the failure is
 * reported): the performer still checks the version it receives. When the
 * two share no version, nothing is sent; that, and a performer's refusal of
 * the version (`connect/contract-unsupported`), waits like an admission
 * deferral, spending no attempt, within `maxDeferMs` (ADR-0009, amended).
 * Past it the attempt is recorded `retryable` (`flow/contract-unsupported`).
 */

import {
  ACTION_CONTRACT_VERSION,
  ACTION_CONTRACT_VERSIONS,
  CONTRACT_UNSUPPORTED_RETRY_MS,
  isActionPortDescription,
  pickContractVersion,
  type ActionOutcome,
  type ActionPort,
  type ApprovedAction,
} from "@aaply/action-contract";
import type { Clock } from "./ports.js";

/** How long a port's description is kept before it is asked again: 1 minute. */
export const DESCRIBE_TTL_MS = 60_000;

/** How long the runtime waits for a port's description before it sends contract 1: 5 s. */
export const DESCRIBE_TIMEOUT_MS = 5_000;

/** An envelope version this engine builds: one of `ACTION_CONTRACT_VERSIONS`. */
export type ContractVersion = ApprovedAction["contract"];

/** `version` when this engine builds it (it is in `ACTION_CONTRACT_VERSIONS`), else null. */
function built(version: number | null): ContractVersion | null {
  return version !== null && ACTION_CONTRACT_VERSIONS.includes(version) ? (version as ContractVersion) : null;
}

/** Picks the envelope version for one action port, asking it at most once a minute. */
export class ContractNegotiator {
  private cached: { version: ContractVersion; until: number } | null = null;
  private asking: Promise<ContractVersion | null> | null = null;

  constructor(
    private readonly port: ActionPort,
    private readonly clock: Clock,
    private readonly report: (error: unknown, where: string) => void,
  ) {}

  /** The version to send (the envelope's `contract`), or null when the port serves none this engine builds. Never throws. */
  version(): Promise<ContractVersion | null> {
    if (typeof this.port.describe !== "function") return Promise.resolve(ACTION_CONTRACT_VERSION);
    if (this.cached !== null && this.clock.now() < this.cached.until) return Promise.resolve(this.cached.version);
    this.asking ??= this.ask().finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  /** Takes note of the port's answer: after `connect/contract-unsupported` the next send asks the port again. */
  answered(outcome: ActionOutcome): void {
    if (refusedForVersion(outcome)) this.cached = null;
  }

  private async ask(): Promise<ContractVersion | null> {
    let version: ContractVersion | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), DESCRIBE_TIMEOUT_MS);
      });
      const described: unknown = await Promise.race([Promise.resolve().then(() => this.port.describe!()), late]);
      if (described === "timeout") throw new Error("the action port did not describe itself in time; sending contract 1");
      if (!isActionPortDescription(described)) throw new Error("the action port's description is not { contracts: [distinct positive integers] }; sending contract 1");
      version = built(pickContractVersion(ACTION_CONTRACT_VERSIONS, described.contracts));
    } catch (error) {
      try {
        this.report(error, "describe");
      } catch {
        // Reporting must not break a send.
      }
      version = ACTION_CONTRACT_VERSION;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // No version in common is never kept: the port may be upgraded by the next attempt.
    this.cached = version === null ? null : { version, until: this.clock.now() + DESCRIBE_TTL_MS };
    return version;
  }
}

/**
 * Whether a performer refused an attempt for its envelope version
 * (`connect/contract-unsupported`): it checks the version before anything
 * else, its replay guard included, so the same attempt can be sent again.
 */
export function refusedForVersion(outcome: ActionOutcome): outcome is Extract<ActionOutcome, { status: "retryable" }> {
  return outcome.status === "retryable" && outcome.error.code === "connect/contract-unsupported";
}

/**
 * The outcome of an attempt that was not sent because the port serves no
 * envelope version this engine builds, recorded once it can wait no longer
 * (past `maxDeferMs`): retried after 30 s, as a performer's
 * `connect/contract-unsupported` is, since the port may be upgraded by then.
 */
export function noCommonContract(): ActionOutcome {
  return {
    status: "retryable",
    error: { code: "flow/contract-unsupported", message: "This action cannot be sent yet. It will be tried again.", detail: "the action port serves no contract version this engine builds" },
    retryAfterMs: CONTRACT_UNSUPPORTED_RETRY_MS,
  };
}
