/**
 * @aaply/flow/eval: measuring a decider against frozen gates before any
 * tenant runs it in `auto`.
 *
 * 1. `freezeGates` fixes the bounds and digests them; print the digest first.
 * 2. `evaluateDecisions` runs every case of a split end to end, through a
 *    fresh runtime and the tenant's policy, and classifies each outcome from
 *    the state before and after the turn.
 * 3. `sweep` decides a calibration run again at other thresholds from the
 *    rankings its traces kept, with no model call; `selectThresholds` picks
 *    by a fixed rule.
 * 4. The holdout is scored only at the selected thresholds, given the
 *    calibration report too: the kit checks its digest, chooses again from
 *    it and compares, and refuses a holdout sharing a case with it. A
 *    passing holdout run in `auto` gives a `calibration`, bound to the
 *    report's digest, the thresholds and the stages that proposed.
 * 5. Before saving a policy with that calibration, the host checks it
 *    against the two reports it kept: `verifyCalibration`.
 *
 * The kit refuses rather than report a rate over nothing, or a run in which
 * every decider call failed.
 */

export { freezeGates, gatesIntact, type DecisionGates, type FrozenGates } from "../eval/gates.js";
export { formatReport } from "../eval/report.js";
export { evaluateDecisions, EvaluationRefused, verifyCalibration, type DecisionReport, type EvaluateOptions, type ThresholdSelection } from "../eval/run.js";
export type { CaseExpect, CaseOutcome, CaseResult, CaseRouting, DecisionCase, DecisionMetrics, GateResult, Rate } from "../eval/score.js";
export { selectThresholds, sweep, type SweepGrid, type SweepRow } from "../eval/sweep.js";
