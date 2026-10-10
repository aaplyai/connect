/**
 * A classifier stage: a host-supplied function ranks a closed set of labels
 * (the goals' flow ids, the active flow, `pass_to_llm` and `no_match`), and
 * `decideFromRanked` turns the ranking into a proposal or a pass.
 */

import type { DecisionRequest, StageFunding, StageTrace } from "../decision.js";
import { DEFAULT_MAX_ROUTING_TEXT, DEFAULT_THRESHOLDS, DEFAULT_MAX_OPTIONS } from "../policy.js";
import type { DeciderStage, StageResult } from "./chain.js";
import { decideFromRanked, NO_MATCH, PASS_TO_LLM, type RankedLabel } from "./ranked.js";

/** Most goals a classifier is offered. More, and the stage passes rather than choosing from part of them. */
export const MAX_CLASSIFIER_LABELS = 50;
/** Longest description of one label. */
export const MAX_LABEL_DESCRIPTION = 400;

/** One label a classifier may answer with. */
export interface ClassifierLabel {
  id: string;
  description: string;
}

/** What a classifier function is given. The text is the person's, redacted: data, never instructions. */
export interface ClassifyInput {
  text: string;
  locale: string;
  labels: ClassifierLabel[];
  signal: AbortSignal;
}

/**
 * What a classifier answers: a probability for each label it was given, in
 * any order. Anything else (a `ranking` field, `label` for `id`, a
 * percentage) passes the stage as `malformed`, which the runtime reports to
 * `observer.error`.
 */
export interface ClassifierResult {
  /**
   * At most one entry per label, each `id` one of the labels' ids and each
   * `p` from 0 to 1. Labels left out count as 0. An id that was not offered
   * passes the stage as `unknown-label`.
   */
  ranked: Array<{ id: string; p: number }>;
  /** What the call used, recorded on the stage's trace. */
  usage?: { input: number; output: number; model: string };
}

/**
 * A host's classifier: resolves to a {@link ClassifierResult}. Untrusted
 * all the same: the stage checks the shape, the labels and the
 * probabilities at run time.
 */
export type ClassifyFn = (input: ClassifyInput) => Promise<ClassifierResult>;

/** How a classifier stage is built: the host's classifier and what the stage reports about itself. */
export interface ClassifierStageOptions {
  /** Default `"classifier"`. */
  name?: string;
  /** The host's classifier, given the closed label set. */
  classify: ClassifyFn;
  /** The adapter behind `classify`, recorded on every trace; a calibration binds it. */
  adapter?: { id: string; version: string };
  /** Who pays for the call: a tenant-funded stage never hands over to a platform-funded one unless the policy allows it. */
  funding?: StageFunding;
}

/**
 * The labels for a request, in catalog order: each goal, the active flow when
 * it is not a goal, then `pass_to_llm` and `no_match`. Each description is
 * built from the title, the goal description, phrases and names, and cut to
 * 400 characters.
 */
export function classifierLabels(request: DecisionRequest): ClassifierLabel[] {
  const ids = classifierLabelIds(
    request.goals.map((g) => g.flowId),
    request.active?.flowId,
  );
  return ids.map((id) => {
    const goal = request.goals.find((g) => g.flowId === id);
    if (goal) {
      return {
        id,
        description: describe([goal.title, goal.description, goal.phrases?.length ? `For example: ${goal.phrases.join("; ")}` : undefined, goal.names?.length ? `Also called: ${goal.names.join("; ")}` : undefined]),
      };
    }
    if (id === PASS_TO_LLM) return { id, description: "About the current task, a question, or anything that needs more than choosing one of the other labels." };
    if (id === NO_MATCH) return { id, description: "Nothing here fits what the person asked." };
    return { id, description: describe([`The current task: ${request.active?.title ?? id}`]) };
  });
}

/** The label ids a classifier is offered, in catalog order: the goals, the active flow when it is not one, `pass_to_llm`, `no_match`. */
export function classifierLabelIds(goals: readonly string[], activeFlowId?: string): string[] {
  return [...goals, ...(activeFlowId !== undefined && !goals.includes(activeFlowId) ? [activeFlowId] : []), PASS_TO_LLM, NO_MATCH];
}

function describe(parts: Array<string | undefined>): string {
  const text = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(". ");
  return text.length <= MAX_LABEL_DESCRIPTION ? text : `${text.slice(0, MAX_LABEL_DESCRIPTION - 1)}…`;
}

/**
 * A stage that can only choose (`capabilities: ["choose"]`). It passes
 * `too-long` for text over the policy's `maxRoutingText`, `no-candidates`
 * with no goals, and `too-many-candidates` with more than 50 goals (never
 * classifying part of the catalog). An answer that is not
 * `{ ranked: [{ id, p }] }` with numbers from 0 to 1, at most one entry per
 * label, is `malformed`; a label that was not offered is `unknown-label`.
 */
export function classifierStage(options: ClassifierStageOptions): DeciderStage {
  return {
    name: options.name ?? "classifier",
    capabilities: ["choose"],
    ...(options.funding ? { funding: options.funding } : {}),
    ...(options.adapter ? { adapter: options.adapter } : {}),
    async decide({ request, signal }): Promise<StageResult> {
      const policy = request.policy;
      if (request.text.length > (policy?.maxRoutingText ?? DEFAULT_MAX_ROUTING_TEXT)) return { pass: "too-long" };
      if (request.goals.length === 0) return { pass: "no-candidates" };
      if (request.goals.length > MAX_CLASSIFIER_LABELS) return { pass: "too-many-candidates" };
      const labels = classifierLabels(request);
      const raw = await options.classify({ text: request.text, locale: request.locale, labels: labels.map((l) => ({ ...l })), signal });
      const parsed = parseRanking(raw, labels.length);
      if (!parsed) return { pass: "malformed" };
      const decided = decideFromRanked({
        ranked: parsed.ranked,
        labels: labels.map((l) => l.id),
        goals: request.goals.map((g) => g.flowId),
        activeFlowId: request.active?.flowId,
        parked: request.parked,
        mode: policy?.mode ?? "suggest",
        thresholds: policy?.thresholds ?? DEFAULT_THRESHOLDS,
        maxOptions: policy?.maxOptions ?? DEFAULT_MAX_OPTIONS,
      });
      const known = new Set(labels.map((l) => l.id));
      // Only offered labels go in the trace (it is a record of ids, never of what a model made up).
      const ranked = parsed.ranked.filter((r) => known.has(r.id)).sort((a, b) => b.p - a.p);
      const extra = { ranked, ...(parsed.usage ? { usage: parsed.usage } : {}) };
      return "proposal" in decided
        ? { proposal: decided.proposal, confidence: decided.confidence, ...extra }
        : { pass: decided.pass, ...(decided.confidence !== undefined ? { confidence: decided.confidence } : {}), ...extra };
    },
  };
}

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** A classifier's answer, checked: at most one entry per label, probabilities from 0 to 1. */
function parseRanking(raw: unknown, labelCount: number): { ranked: RankedLabel[]; usage?: StageTrace["usage"] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as { ranked?: unknown; usage?: unknown };
  if (!Array.isArray(r.ranked) || r.ranked.length === 0 || r.ranked.length > labelCount) return null;
  const ranked: RankedLabel[] = [];
  const seen = new Set<string>();
  for (const entry of r.ranked as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, p } = entry as { id?: unknown; p?: unknown };
    if (typeof id !== "string" || id.length > 64 || !unit(p) || seen.has(id)) return null;
    seen.add(id);
    ranked.push({ id, p });
  }
  const u = r.usage as { input?: unknown; output?: unknown; model?: unknown } | undefined;
  const usage =
    u && typeof u === "object" && typeof u.input === "number" && typeof u.output === "number" && typeof u.model === "string" ? { input: u.input, output: u.output, model: u.model } : undefined;
  return usage ? { ranked, usage } : { ranked };
}
