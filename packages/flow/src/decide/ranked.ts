/**
 * From a classifier's ranking to a proposal: a pure function, so a threshold
 * sweep can decide again from recorded rankings without calling a model.
 */

import type { DecisionProposal, PassReason, SuggestOption } from "../decision.js";
import type { DecisionThresholds, RoutingMode } from "../policy.js";

/** The label a classifier gives text that only a fuller stage can handle (a question, or the active task). */
export const PASS_TO_LLM = "pass_to_llm";
/** The label a classifier gives text that no offered flow fits. */
export const NO_MATCH = "no_match";

/** One entry of a ranking: a label and its probability. */
export interface RankedLabel {
  id: string;
  p: number;
}

/** What `decideFromRanked` decides from: a ranking, what was offered, and the policy's mode and thresholds. */
export interface RankedInput {
  /** The classifier's ranking, in any order. */
  ranked: readonly RankedLabel[];
  /** Every label offered, in catalog order (goals, then the active flow, then the two reserved labels). Ties break on this order. */
  labels: readonly string[];
  /** The goals' flow ids. */
  goals: readonly string[];
  /** The active run's flow: the classifier ranking it first hands the turn on. */
  activeFlowId?: string | undefined;
  /** Live parked runs: a confident match for one of their flows resumes it. */
  parked: ReadonlyArray<{ runId: string; flowId: string }>;
  /** Only `auto` switches or resumes; otherwise a confident match is offered. */
  mode: RoutingMode;
  thresholds: DecisionThresholds;
  /** Most goals an offer holds. */
  maxOptions: number;
}

/** What a ranking decides: a proposal with its confidence, or a pass with the reason. */
export type RankedDecision = { proposal: DecisionProposal; confidence: number } | { pass: PassReason; confidence?: number };

const probability = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

/**
 * Sorts a ranking: probability, highest first; then catalog order; then id.
 * Returns null when it is malformed (empty, a duplicate label, or a
 * probability that is not a number from 0 to 1).
 */
export function sortRanked(ranked: readonly RankedLabel[], labels: readonly string[]): RankedLabel[] | null {
  if (ranked.length === 0) return null;
  const seen = new Set<string>();
  for (const r of ranked) {
    if (typeof r.id !== "string" || !probability(r.p) || seen.has(r.id)) return null;
    seen.add(r.id);
  }
  const order = (id: string) => {
    const i = labels.indexOf(id);
    return i === -1 ? labels.length : i;
  };
  return [...ranked].sort((a, b) => b.p - a.p || order(a.id) - order(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Decides from a ranking, in order:
 * 1. a label that was not offered: pass `unknown-label`;
 * 2. `pass_to_llm`, or the active flow, first: pass `pass-to-llm`;
 * 3. `no_match` first at `openAt` or above, leading by `margin`: `nomatch`
 *    (without the lead, `close-call`; below `openAt`, `low-confidence`);
 * 4. a goal first, in `auto`, at `openAt` or above and leading by `margin`:
 *    `switch`, or `resume` when the person has that flow parked;
 * 5. a goal first at `suggestAt` or above: `suggest` the goals at
 *    `suggestAt` times the first's probability or above, at most
 *    `maxOptions`, never the active flow;
 * 6. otherwise: pass `low-confidence`.
 *
 * Comparisons use `>=` on the probabilities as given, without rounding. The
 * mode is not otherwise applied here: the runtime's policy floor does that.
 */
export function decideFromRanked(input: RankedInput): RankedDecision {
  const sorted = sortRanked(input.ranked, input.labels);
  if (!sorted) return { pass: "malformed" };
  if (sorted.some((r) => !input.labels.includes(r.id))) return { pass: "unknown-label" };
  const top = sorted[0]!;
  const c = top.p;
  const lead = c - (sorted[1]?.p ?? 0);
  const { openAt, suggestAt, margin } = input.thresholds;
  if (top.id === PASS_TO_LLM || (input.activeFlowId !== undefined && top.id === input.activeFlowId)) return { pass: "pass-to-llm", confidence: c };
  if (top.id === NO_MATCH) {
    if (c >= openAt && lead >= margin) return { proposal: { kind: "nomatch" }, confidence: c };
    return { pass: c >= openAt ? "close-call" : "low-confidence", confidence: c };
  }
  if (!input.goals.includes(top.id)) return { pass: "unknown-label", confidence: c };
  if (input.mode === "auto" && c >= openAt && lead >= margin) {
    const parked = input.parked.find((p) => p.flowId === top.id);
    return { proposal: parked ? { kind: "resume", runId: parked.runId } : { kind: "switch", flowId: top.id }, confidence: c };
  }
  if (c >= suggestAt) {
    const floor = suggestAt * c;
    const options: SuggestOption[] = [];
    for (const r of sorted) {
      if (options.length >= input.maxOptions) break;
      if (r.p < floor) break;
      if (!input.goals.includes(r.id) || r.id === input.activeFlowId) continue;
      options.push({ flowId: r.id, confidence: r.p });
    }
    return { proposal: { kind: "suggest", options }, confidence: c };
  }
  return { pass: "low-confidence", confidence: c };
}
