/**
 * @aaply/flow/decide: a decision port built from stages.
 *
 * - `createDeciderChain` runs stages in order within one deadline; the first
 *   valid proposal wins, and if every stage passes the answer is `nomatch`.
 * - `classifierStage` ranks a closed set of labels with a host's classifier,
 *   and `decideFromRanked` (pure) turns a ranking into a proposal.
 * - `llmStage` asks a host's model for a structured proposal.
 *
 * - The parts of a decision and of a routing policy beyond the main entry:
 *   proposals and stage traces, thresholds and calibrations, the policy's
 *   texts and defaults, and `checkGoals` for a catalog's goal names.
 *
 * The engine ships no model client and holds no keys: each stage calls a
 * function the host supplies. Exact published names are matched by the
 * runtime before any of this runs.
 */

export type { ProposalMeta } from "../assist/resolve.js";
export { createDeciderChain, type DeciderChainOptions, type DeciderStage, type StageInput, type StageResult } from "../decide/chain.js";
export {
  classifierLabels,
  classifierStage,
  MAX_CLASSIFIER_LABELS,
  MAX_LABEL_DESCRIPTION,
  type ClassifierLabel,
  type ClassifierResult,
  type ClassifierStageOptions,
  type ClassifyFn,
  type ClassifyInput,
} from "../decide/classifier.js";
export { LLM_INSTRUCTIONS, llmInput, llmStage, MAX_LLM_OUTPUT_BYTES, type CompleteFn, type CompleteInput, type LlmStageOptions } from "../decide/llm.js";
export { decideFromRanked, NO_MATCH, PASS_TO_LLM, type RankedDecision, type RankedInput, type RankedLabel } from "../decide/ranked.js";
export {
  MAX_ANSWER_TEXT,
  MAX_PROPOSAL_FACTS,
  MAX_QUOTE,
  MAX_SUGGEST_OPTIONS,
  MAX_TRACE_STAGES,
  parseDecision,
  PASS_REASONS,
  PROPOSAL_SCHEMA,
  type DecisionCollection,
  type DecisionFact,
  type DecisionField,
  type DecisionNeed,
  type DecisionProposal,
  type DecisionUpdate,
  type PassReason,
  type ProposedItemOp,
  type RequestPolicy,
  type StageFunding,
  type StageTrace,
  type SuggestOption,
} from "../decision.js";
export { checkGoals, type NamedGoal } from "../exact.js";
export {
  DEFAULT_MAX_OPTIONS,
  DEFAULT_MAX_ROUTING_TEXT,
  DEFAULT_OFFER_TTL_MS,
  DEFAULT_TEXTS,
  DEFAULT_THRESHOLDS,
  effectiveThresholds,
  FAIL_CLOSED_POLICY,
  MAX_OPTIONS_CAP,
  resolvePolicy,
  TEXT_KEYS,
  type CalibratedStage,
  type Calibration,
  type DecisionThresholds,
  type ResolvedPolicy,
  type RoutingMode,
  type ShareValues,
  type TextKey,
} from "../policy.js";
