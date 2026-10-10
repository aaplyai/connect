/**
 * Gates: the bounds an evaluation must meet, frozen and digested before any
 * result is seen, so a bound cannot be moved to make a run pass unnoticed.
 */

import { sha256, toHex } from "../hash.js";
import { canonicalJson, type JsonValue } from "../json.js";

/** The bounds a decision evaluation is held to. Rates are fractions from 0 to 1. */
export interface DecisionGates {
  /** Most cases not expecting an open that end with a run opened. */
  falseOpenMax: number;
  /** The same, over the trap kinds alone. */
  trapFalseOpenMax: number;
  trapKinds: string[];
  /** Fewest correct outcomes, over every case. */
  accuracyMin: number;
  /** The same, over the paraphrase kinds alone. */
  paraphraseAccuracyMin: number;
  paraphraseKinds: string[];
  /** Whether an offer that includes the expected flow is correct, or only a question. */
  suggestCountsAs: "correct" | "question";
  /** Most cases answered with a question (an offer, a consent or a clarification). */
  clarifyRateMax: number;
  /** An open, fill or resume other than the one expected. Always 0. */
  wrongActionMax: 0;
  /**
   * Most cases the decision port was asked about whose every stage failed
   * (threw, timed out, answered malformed), or whose port did. A failure
   * becomes a question, so without this bound failures would pass for
   * caution.
   */
  providerFailureMax: number;
  /** Slowest 95th-percentile turn, in milliseconds. */
  p95MsMax?: number;
  /** Fewest cases scored, in all and per kind. */
  minCases: { total: number; perKind?: Record<string, number> };
}

/** Gates as frozen, with the digest every report and selection carries. */
export type FrozenGates = Readonly<Omit<DecisionGates, "trapKinds" | "paraphraseKinds" | "minCases">> & {
  readonly trapKinds: readonly string[];
  readonly paraphraseKinds: readonly string[];
  readonly minCases: Readonly<{ total: number; perKind?: Readonly<Record<string, number>> }>;
  /** SHA-256 (hex) of the gates' canonical JSON. */
  readonly digest: string;
};

const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const kinds = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === "string" && k.length > 0 && k.length <= 64);

/**
 * Checks and freezes gates, and digests them. Throws on a bound that is not
 * a fraction, an empty kind list, a `wrongActionMax` other than 0 or fewer
 * than one case. Print the digest before any result.
 */
export function freezeGates(gates: DecisionGates): FrozenGates {
  const g = gates as unknown as Record<string, unknown>;
  for (const key of ["falseOpenMax", "trapFalseOpenMax", "accuracyMin", "paraphraseAccuracyMin", "clarifyRateMax", "providerFailureMax"]) {
    if (!rate(g[key])) throw new Error(`Gate ${key} must be a number from 0 to 1.`);
  }
  if (!kinds(gates.trapKinds) || !kinds(gates.paraphraseKinds)) throw new Error("Gates name at least one trap kind and one paraphrase kind.");
  if (gates.suggestCountsAs !== "correct" && gates.suggestCountsAs !== "question") throw new Error('suggestCountsAs is "correct" or "question".');
  if (gates.wrongActionMax !== 0) throw new Error("wrongActionMax is 0: every failure must route to a question, never to a wrong action.");
  if (gates.p95MsMax !== undefined && !(typeof gates.p95MsMax === "number" && Number.isFinite(gates.p95MsMax) && gates.p95MsMax > 0)) throw new Error("p95MsMax is a positive number of milliseconds.");
  const min = gates.minCases;
  if (!min || !Number.isInteger(min.total) || min.total < 1) throw new Error("minCases.total is at least 1.");
  if (min.perKind !== undefined && !Object.values(min.perKind).every((n) => Number.isInteger(n) && n >= 1)) throw new Error("minCases.perKind values are at least 1.");
  const copy: DecisionGates = {
    falseOpenMax: gates.falseOpenMax,
    trapFalseOpenMax: gates.trapFalseOpenMax,
    trapKinds: [...gates.trapKinds],
    accuracyMin: gates.accuracyMin,
    paraphraseAccuracyMin: gates.paraphraseAccuracyMin,
    paraphraseKinds: [...gates.paraphraseKinds],
    suggestCountsAs: gates.suggestCountsAs,
    clarifyRateMax: gates.clarifyRateMax,
    wrongActionMax: 0,
    providerFailureMax: gates.providerFailureMax,
    ...(gates.p95MsMax !== undefined ? { p95MsMax: gates.p95MsMax } : {}),
    minCases: { total: min.total, ...(min.perKind ? { perKind: { ...min.perKind } } : {}) },
  };
  const digest = toHex(sha256(canonicalJson(copy as unknown as JsonValue)));
  return deepFreeze({ ...copy, digest }) as FrozenGates;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Whether `gates` is still exactly what was frozen (its digest matches its content). */
export function gatesIntact(gates: FrozenGates): boolean {
  const { digest, ...rest } = gates;
  return toHex(sha256(canonicalJson(rest as unknown as JsonValue))) === digest;
}
