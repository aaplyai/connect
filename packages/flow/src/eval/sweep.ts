/**
 * Threshold sweeps: deciding a calibration run again at other thresholds
 * from the classifier rankings its traces kept, with no model call, and the
 * fixed rule that picks thresholds from the sweep.
 */

import { decideFromRanked } from "../decide/ranked.js";
import type { DecisionThresholds } from "../policy.js";
import type { FrozenGates } from "./gates.js";
import { EvaluationRefused, sameDigest, type DecisionReport, type ThresholdSelection } from "./run.js";
import { checkGates, judge, metricsOf, type CaseOutcome, type CaseResult, type DecisionMetrics, type GateResult } from "./score.js";

/** The thresholds to try; every combination with `suggestAt` at most `openAt` is a row. */
export interface SweepGrid {
  openAt: number[];
  suggestAt: number[];
  margin: number[];
}

/** One combination of thresholds, scored. */
export interface SweepRow {
  thresholds: DecisionThresholds;
  metrics: DecisionMetrics;
  checks: GateResult[];
  passed: boolean;
  /**
   * Cases a sweep cannot decide without a model: the classifier passed at
   * the recorded thresholds and would propose at these, or the reverse. They
   * score as incorrect, and a row with any is never selected.
   */
  unknown: number;
  gatesDigest: string;
  /** The report the rankings came from. */
  reportDigest: string;
  /** The grid the row belongs to. */
  grid: SweepGrid;
}

const MAX_GRID = 10_000;

/**
 * Scores every grid row from the report's recorded rankings, without
 * calling any decider. A case decided without a classifier ranking (an
 * exact name, a pick, a stage that does not rank) keeps its outcome. Only a
 * calibration report is swept, and only one whose digest matches its
 * content (`flow/eval-report-changed`): choosing thresholds on the holdout
 * (`flow/eval-sweep-holdout`), or on a report relabelled as calibration,
 * would leave nothing to check them on.
 */
export function sweep(report: DecisionReport, grid: SweepGrid): SweepRow[] {
  if (report.split !== "calibration") throw new EvaluationRefused("flow/eval-sweep-holdout", "Only a calibration report is swept.");
  if (!sameDigest(report)) throw new EvaluationRefused("flow/eval-report-changed", "The report's digest does not match its content.");
  const valid = (v: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (![...grid.openAt, ...grid.suggestAt, ...grid.margin].every(valid)) throw new Error("Grid values are numbers from 0 to 1.");
  if (grid.openAt.length * grid.suggestAt.length * grid.margin.length > MAX_GRID) throw new Error(`At most ${MAX_GRID} grid rows.`);
  const rows: SweepRow[] = [];
  const kept: SweepGrid = { openAt: [...grid.openAt], suggestAt: [...grid.suggestAt], margin: [...grid.margin] };
  for (const openAt of grid.openAt) {
    for (const suggestAt of grid.suggestAt) {
      if (suggestAt > openAt) continue;
      for (const margin of grid.margin) {
        const thresholds = { openAt, suggestAt, margin };
        let unknown = 0;
        const cases = report.cases.map((c) => {
          const outcome = redecide(c, report, thresholds);
          if (outcome === null) {
            unknown++;
            return { ...c, correct: false, wrongAction: false, falseOpen: false, question: false };
          }
          return { ...c, outcome, ...judge(c, outcome, report.gates) };
        });
        const metrics = metricsOf(cases, report.gates);
        const checks = checkGates(metrics, report.gates);
        rows.push({ thresholds, metrics, checks, passed: checks.every((g) => g.ok), unknown, gatesDigest: report.gates.digest, reportDigest: report.digest, grid: kept });
      }
    }
  }
  return rows;
}

/** The case's outcome at other thresholds; null when that needs a model call. */
function redecide(c: CaseResult, report: DecisionReport, thresholds: DecisionThresholds): CaseOutcome | null {
  const stages = c.turn?.stages.filter((s) => s.result !== "shadow") ?? [];
  const index = stages.findIndex((s) => s.ranked !== undefined && s.ranked.length > 0);
  if (index === -1) return c.outcome;
  const stage = stages[index]!;
  const r = c.routing;
  const decided = decideFromRanked({
    ranked: stage.ranked!,
    labels: r.labels,
    goals: r.goals,
    activeFlowId: r.activeFlowId,
    parked: r.parked,
    mode: report.policy.mode,
    thresholds,
    maxOptions: report.policy.maxOptions,
  });
  const recordedPassed = stage.result === "passed";
  // Passing again leaves the turn to the stages after it, as recorded; passing now where it proposed needs them anew.
  if (!("proposal" in decided)) return recordedPassed ? c.outcome : null;
  const p = decided.proposal;
  switch (p.kind) {
    case "switch":
      if (report.policy.mode === "off") return { kind: "replied" };
      return r.activeFlowId !== undefined ? { kind: "asked", switchTo: p.flowId } : report.policy.mode === "auto" ? { kind: "opened", flowId: p.flowId } : { kind: "offered", flowIds: [p.flowId] };
    case "resume": {
      // As the runtime: only auto brings a parked run back on its own; otherwise it is offered.
      const parked = r.parked.find((x) => x.runId === p.runId);
      if (!parked) return { kind: "asked" };
      if (report.policy.mode === "off") return { kind: "replied" };
      return report.policy.mode === "auto" ? { kind: "resumed", flowId: parked.flowId } : { kind: "offered", flowIds: [parked.flowId] };
    }
    case "suggest": {
      if (report.policy.mode === "off") return { kind: "replied" };
      const flowIds = [...new Set(p.options.map((o) => o.flowId))].filter((id) => r.goals.includes(id) && id !== r.activeFlowId);
      return flowIds.length > 0 ? { kind: "offered", flowIds } : { kind: "asked" };
    }
    case "nomatch":
      return { kind: "replied" };
    default:
      return null;
  }
}

/**
 * Picks thresholds from a sweep by a fixed rule: among rows that pass every
 * gate and decided every case, the highest accuracy; then the lowest clarify
 * rate; then the highest `openAt`, `margin` and `suggestAt` (the most
 * cautious). Null when no row qualifies: then nothing is calibrated.
 */
export function selectThresholds(rows: readonly SweepRow[], gates: FrozenGates): ThresholdSelection | null {
  const eligible = rows.filter((r) => r.gatesDigest === gates.digest && r.passed && r.unknown === 0);
  if (eligible.length === 0) return null;
  const best = [...eligible].sort(
    (a, b) =>
      b.metrics.accuracy.value - a.metrics.accuracy.value ||
      a.metrics.clarifyRate.value - b.metrics.clarifyRate.value ||
      b.thresholds.openAt - a.thresholds.openAt ||
      b.thresholds.margin - a.thresholds.margin ||
      b.thresholds.suggestAt - a.thresholds.suggestAt,
  )[0]!;
  return {
    thresholds: { ...best.thresholds },
    gatesDigest: gates.digest,
    reportDigest: best.reportDigest,
    grid: { openAt: [...best.grid.openAt], suggestAt: [...best.grid.suggestAt], margin: [...best.grid.margin] },
  };
}
