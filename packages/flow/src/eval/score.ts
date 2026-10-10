/**
 * Scoring: what a case expected, what happened, and the rates the gates
 * bound. Each rate carries its numerator and denominator.
 */

import type { TurnRecord } from "../ports.js";
import type { FrozenGates } from "./gates.js";

/** What a case expects the turn to do. */
export type CaseExpect = { open: string } | { reply: true } | { continue: string[] } | { resume: string } | { cancel: true };

/** One evaluation case. `kind` is its family (exact, paraphrase, trap, question...). */
export interface DecisionCase {
  id: string;
  text: string;
  kind: string;
  lang?: string;
  split: "calibration" | "holdout";
  /** The person's workspace before the turn: flow ids active, parked and offered. */
  setup?: { active?: string; parked?: string[]; offer?: string[] };
  expect: CaseExpect;
}

/**
 * What a turn did, read from the workspace and the runs before and after it
 * (never from the proposal):
 * - `opened` and `resumed`: a run is now in front of the person;
 * - `filled`: facts of the active run changed;
 * - `offered`: an offer is open;
 * - `asked`: a consent question (switching to `switchTo`, or cancelling) or
 *   a clarifying question;
 * - `replied`: an answer, changing nothing;
 * - `unchanged`: nothing changed and nothing was said (a refused fill);
 * - `failed`: the turn threw.
 */
export type CaseOutcome =
  | { kind: "opened"; flowId: string }
  | { kind: "resumed"; flowId: string }
  | { kind: "filled"; facts: string[] }
  | { kind: "offered"; flowIds: string[] }
  | { kind: "asked"; switchTo?: string; cancel?: true }
  | { kind: "replied" }
  | { kind: "unchanged" }
  | { kind: "failed"; error: string };

/** The ids a sweep needs to decide a case again from a recorded ranking. */
export interface CaseRouting {
  /** Classifier labels in catalog order, as `classifierLabels` builds them. */
  labels: string[];
  goals: string[];
  activeFlowId?: string;
  parked: Array<{ runId: string; flowId: string }>;
}

/** One case, scored. */
export interface CaseResult {
  id: string;
  kind: string;
  lang?: string;
  expect: CaseExpect;
  outcome: CaseOutcome;
  correct: boolean;
  wrongAction: boolean;
  falseOpen: boolean;
  /** Answered with a question: an offer, a consent or a clarification. */
  question: boolean;
  /** The decision port was asked (not an exact name or a pick). */
  decided: boolean;
  /** Every stage the port tried failed (timeout, unavailable, malformed), or the port itself did. */
  providerFailed: boolean;
  /**
   * SHA-256 (hex) of the case's text as exact names compare it
   * (`normaliseName`): how a holdout shows it shares no text with the
   * calibration it was selected on, without holding the text.
   */
  textDigest: string;
  ms: number;
  /** The turn's record: ids, probabilities and timings only. */
  turn?: TurnRecord;
  routing: CaseRouting;
}

/** A rate, with what it counts. */
export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator / denominator. */
  value: number;
}

/** Every rate an evaluation measures, each with its numerator and denominator. */
export interface DecisionMetrics {
  falseOpen: Rate;
  trapFalseOpen: Rate;
  accuracy: Rate;
  paraphraseAccuracy: Rate;
  clarifyRate: Rate;
  wrongAction: Rate;
  /** Over the cases the decision port was asked about: those whose call failed. */
  providerFailure: Rate;
  /** 95th-percentile turn time, in milliseconds. */
  p95Ms: number;
  /** Accuracy per case kind. */
  byKind: Record<string, Rate>;
}

/** One gate, checked: its bound and the measured value. */
export interface GateResult {
  gate: "falseOpen" | "trapFalseOpen" | "accuracy" | "paraphraseAccuracy" | "clarifyRate" | "wrongAction" | "providerFailure" | "p95Ms";
  bound: number;
  value: number;
  ok: boolean;
}

/** Whether `outcome` is what `expect` asked for. */
export function isCorrect(expect: CaseExpect, outcome: CaseOutcome, suggestCountsAs: FrozenGates["suggestCountsAs"]): boolean {
  if ("open" in expect) {
    return (
      (outcome.kind === "opened" && outcome.flowId === expect.open) ||
      // With a run in front of the person, opening means asking to set it aside first.
      (outcome.kind === "asked" && outcome.switchTo === expect.open) ||
      (suggestCountsAs === "correct" && outcome.kind === "offered" && outcome.flowIds.includes(expect.open))
    );
  }
  if ("reply" in expect) return outcome.kind === "replied";
  if ("continue" in expect) return outcome.kind === "filled" && expect.continue.every((f) => outcome.facts.includes(f)) && outcome.facts.every((f) => expect.continue.includes(f));
  if ("resume" in expect) return outcome.kind === "resumed" && outcome.flowId === expect.resume;
  return outcome.kind === "asked" && outcome.cancel === true;
}

/** An open, fill or resume other than the one expected (a question never is). */
export function isWrongAction(expect: CaseExpect, outcome: CaseOutcome): boolean {
  switch (outcome.kind) {
    case "opened":
      return !("open" in expect && expect.open === outcome.flowId);
    case "resumed":
      return !("resume" in expect && expect.resume === outcome.flowId);
    case "filled":
      return !("continue" in expect && outcome.facts.every((f) => expect.continue.includes(f)));
    default:
      return false;
  }
}

/** Scores an outcome against its case. */
export function judge(
  c: Pick<DecisionCase, "expect">,
  outcome: CaseOutcome,
  gates: FrozenGates,
): Pick<CaseResult, "correct" | "wrongAction" | "falseOpen" | "question"> {
  return {
    correct: isCorrect(c.expect, outcome, gates.suggestCountsAs),
    wrongAction: isWrongAction(c.expect, outcome),
    falseOpen: !("open" in c.expect) && outcome.kind === "opened",
    question: outcome.kind === "asked" || outcome.kind === "offered",
  };
}

function rateOf(numerator: number, denominator: number): Rate {
  return { numerator, denominator, value: denominator === 0 ? 0 : numerator / denominator };
}

/** The rates over `cases`. */
export function metricsOf(cases: readonly CaseResult[], gates: FrozenGates): DecisionMetrics {
  const notOpen = cases.filter((c) => !("open" in c.expect));
  const traps = notOpen.filter((c) => gates.trapKinds.includes(c.kind));
  const paraphrases = cases.filter((c) => gates.paraphraseKinds.includes(c.kind));
  const decided = cases.filter((c) => c.decided);
  const byKind: Record<string, Rate> = {};
  for (const kind of [...new Set(cases.map((c) => c.kind))].sort()) {
    const of = cases.filter((c) => c.kind === kind);
    byKind[kind] = rateOf(of.filter((c) => c.correct).length, of.length);
  }
  return {
    falseOpen: rateOf(notOpen.filter((c) => c.falseOpen).length, notOpen.length),
    trapFalseOpen: rateOf(traps.filter((c) => c.falseOpen).length, traps.length),
    accuracy: rateOf(cases.filter((c) => c.correct).length, cases.length),
    paraphraseAccuracy: rateOf(paraphrases.filter((c) => c.correct).length, paraphrases.length),
    clarifyRate: rateOf(cases.filter((c) => c.question).length, cases.length),
    wrongAction: rateOf(cases.filter((c) => c.wrongAction).length, cases.length),
    providerFailure: rateOf(decided.filter((c) => c.providerFailed).length, decided.length),
    p95Ms: percentile(cases.map((c) => c.ms), 0.95),
    byKind,
  };
}

/** The `q` quantile by the nearest-rank method; 0 for no values. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** Each gate against the metrics. */
export function checkGates(metrics: DecisionMetrics, gates: FrozenGates): GateResult[] {
  const out: GateResult[] = [
    { gate: "falseOpen", bound: gates.falseOpenMax, value: metrics.falseOpen.value, ok: metrics.falseOpen.value <= gates.falseOpenMax },
    { gate: "trapFalseOpen", bound: gates.trapFalseOpenMax, value: metrics.trapFalseOpen.value, ok: metrics.trapFalseOpen.value <= gates.trapFalseOpenMax },
    { gate: "accuracy", bound: gates.accuracyMin, value: metrics.accuracy.value, ok: metrics.accuracy.value >= gates.accuracyMin },
    { gate: "paraphraseAccuracy", bound: gates.paraphraseAccuracyMin, value: metrics.paraphraseAccuracy.value, ok: metrics.paraphraseAccuracy.value >= gates.paraphraseAccuracyMin },
    { gate: "clarifyRate", bound: gates.clarifyRateMax, value: metrics.clarifyRate.value, ok: metrics.clarifyRate.value <= gates.clarifyRateMax },
    { gate: "wrongAction", bound: gates.wrongActionMax, value: metrics.wrongAction.numerator, ok: metrics.wrongAction.numerator <= gates.wrongActionMax },
    { gate: "providerFailure", bound: gates.providerFailureMax, value: metrics.providerFailure.value, ok: metrics.providerFailure.value <= gates.providerFailureMax },
  ];
  if (gates.p95MsMax !== undefined) out.push({ gate: "p95Ms", bound: gates.p95MsMax, value: metrics.p95Ms, ok: metrics.p95Ms <= gates.p95MsMax });
  return out;
}

/** The denominators that are empty, by metric name. A rate over nothing is refused, never reported as 0. */
export function emptyDenominators(metrics: DecisionMetrics): string[] {
  const named: Array<[string, Rate]> = [
    ["falseOpen", metrics.falseOpen],
    ["trapFalseOpen", metrics.trapFalseOpen],
    ["accuracy", metrics.accuracy],
    ["paraphraseAccuracy", metrics.paraphraseAccuracy],
    ["clarifyRate", metrics.clarifyRate],
    ["providerFailure", metrics.providerFailure],
  ];
  return named.filter(([, r]) => r.denominator === 0).map(([n]) => n);
}
