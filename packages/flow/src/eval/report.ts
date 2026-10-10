/**
 * A report as text: the gates' digest first, then every rate with its
 * numerator and denominator, then the cases that failed (by id; a report
 * never prints case text).
 */

import type { DecisionReport } from "./run.js";
import type { GateResult, Rate } from "./score.js";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const frac = (r: Rate) => `${r.numerator}/${r.denominator} = ${pct(r.value)}`;

const LABELS: Record<GateResult["gate"], string> = {
  falseOpen: "false-open",
  trapFalseOpen: "trap false-open",
  accuracy: "accuracy",
  paraphraseAccuracy: "paraphrase accuracy",
  clarifyRate: "clarify rate",
  wrongAction: "wrong action",
  providerFailure: "provider failures",
  p95Ms: "p95 time",
};

/** Formats a report for people. The first line is the gates' digest, so it is read before any result. */
export function formatReport(report: DecisionReport): string {
  const g = report.gates;
  const m = report.metrics;
  const lines: string[] = [];
  lines.push(`Gates ${g.digest}`);
  lines.push(
    `  false-open <= ${pct(g.falseOpenMax)}; trap false-open <= ${pct(g.trapFalseOpenMax)} over ${g.trapKinds.join(", ")}; accuracy >= ${pct(g.accuracyMin)}; ` +
      `paraphrase accuracy >= ${pct(g.paraphraseAccuracyMin)} over ${g.paraphraseKinds.join(", ")}; clarify rate <= ${pct(g.clarifyRateMax)}; wrong action <= 0; ` +
      `provider failures <= ${pct(g.providerFailureMax)} of decided cases` +
      `${g.p95MsMax !== undefined ? `; p95 <= ${g.p95MsMax} ms` : ""}; an offer counts as ${g.suggestCountsAs === "correct" ? "correct" : "a question"}; at least ${g.minCases.total} cases`,
  );
  const t = report.policy.thresholds;
  lines.push(`Split ${report.split}: ${report.cases.length} cases; mode ${report.policy.mode}${report.policy.version !== undefined ? ` (policy ${report.policy.version})` : ""}; thresholds open ${t.openAt}, suggest ${t.suggestAt}, margin ${t.margin}`);
  const failed = report.checks.filter((c) => !c.ok).map((c) => LABELS[c.gate]);
  lines.push(`Result: ${report.passed ? "PASS" : `FAIL (${failed.join(", ")})`}`);
  const rates: Array<[GateResult["gate"], string]> = [
    ["falseOpen", frac(m.falseOpen)],
    ["trapFalseOpen", frac(m.trapFalseOpen)],
    ["accuracy", frac(m.accuracy)],
    ["paraphraseAccuracy", frac(m.paraphraseAccuracy)],
    ["clarifyRate", frac(m.clarifyRate)],
    ["wrongAction", `${m.wrongAction.numerator} of ${m.wrongAction.denominator}`],
    ["providerFailure", frac(m.providerFailure)],
    ["p95Ms", `${m.p95Ms} ms`],
  ];
  for (const [gate, shown] of rates) {
    const check = report.checks.find((c) => c.gate === gate);
    lines.push(`  ${LABELS[gate].padEnd(20)} ${shown.padEnd(24)} ${check ? (check.ok ? "ok" : "FAIL") : ""}`.trimEnd());
  }
  lines.push("By kind:");
  for (const [kind, rate] of Object.entries(m.byKind)) lines.push(`  ${kind.padEnd(20)} ${frac(rate)}`);
  const wrong = report.cases.filter((c) => c.wrongAction);
  if (wrong.length > 0) lines.push(`Wrong actions: ${wrong.map((c) => `${c.id} (${c.outcome.kind})`).join(", ")}`);
  const incorrect = report.cases.filter((c) => !c.correct && !c.wrongAction);
  if (incorrect.length > 0) lines.push(`Not correct: ${incorrect.map((c) => `${c.id} (${c.outcome.kind})`).join(", ")}`);
  if (report.selection) lines.push(`Thresholds selected on calibration report ${report.selection.reportDigest}`);
  lines.push(`Report ${report.digest}`);
  if (report.calibration) lines.push(`Calibration: ${JSON.stringify(report.calibration)}`);
  return lines.join("\n");
}
