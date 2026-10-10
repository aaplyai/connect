/**
 * The decision port: an optional model that reads a person's free text and
 * proposes what it means. It only classifies and extracts. It cannot carry
 * identity, approve anything, confirm a write or run an action; every
 * proposal is checked like any other input, and anything malformed becomes
 * a clarifying question.
 *
 * A port answers with a bare `DecisionProposal` or with a
 * `DecisionAnswer`, which adds a trace of the stages that produced it. The
 * ready-made chain of stages (exact names are matched in the runtime; a
 * classifier and an LLM are host-supplied functions) is `@aaply/flow/decide`.
 */

import { deepFreeze } from "@aaply/action-contract/internal";
import { isItemId } from "./address.js";
import { MAX_ITEM_OPS } from "./collections-compile.js";
import { checkJson, isJsonObject, type JsonValue } from "./json.js";
import type { JsonSchema } from "./schema.js";
import type { TrustedContext } from "./ports.js";
import { parseReplyContent, type ReplyContent } from "./reply.js";
import type { RoutingMode, DecisionThresholds } from "./policy.js";
import type { ItemOp, ZoneSource } from "./state.js";
import type { ProposalMeta } from "./assist/resolve.js";

export type { ProposalMeta };

/** A fact of the active run a decider may fill, as the request offers it. */
export interface DecisionFact {
  name: string;
  title?: string;
  prompt?: string;
  schema: JsonSchema;
  /** Current value, when known and the policy's `shareValues` allows it. Secret facts are never offered. */
  value?: JsonValue;
  /** Asked for right now. */
  asked: boolean;
  /**
   * Who gave the current value, when there is one (0.3): the person, or the
   * assistant (a value it wrote that the person has not confirmed yet). Never
   * an actor id. A correction should target a value the person gave only
   * when they ask to change it (`meta.op: "correct"`).
   */
  origin?: "person" | "assistant";
  /**
   * Set when the fact is a list. A decider changes it with item
   * changes in `items`, never with a value in `facts`; `schema` is then the
   * list's rows with the offered fields only.
   */
  collection?: DecisionCollection;
}

/**
 * A list a decider may change, and how: the fields it may give (never a
 * secret one, not even by name) and the items as they stand, by id.
 */
export interface DecisionCollection {
  /** A decider may add items; otherwise it may only set fields of the items listed. */
  add: boolean;
  /** Most items the list holds. */
  max: number;
  /** Fields a decider may give, in the definition's order. */
  fields: DecisionField[];
  /** The live items, in order, each with the values of its offered fields that the policy's `shareValues` allows. */
  items: Array<{ id: string; fields: Record<string, JsonValue> }>;
}

/** A field of a list's items that a decider may give. */
export interface DecisionField {
  name: string;
  title?: string;
  prompt?: string;
  schema: JsonSchema;
}

/** What a turn needs from the decider: choosing among flows, extracting facts, answering a side question. */
export type DecisionNeed = "choose" | "extract" | "answer";

/** A published flow a person may start. */
export interface DecisionGoal {
  flowId: string;
  /** The current published version. */
  version: string;
  title: string;
  description?: string;
  phrases?: string[];
  /** Exact names the flow answers to (matched by the runtime, without a model). */
  names?: string[];
}

/** The part of the tenant's decision policy a decider needs. */
export interface RequestPolicy {
  mode: RoutingMode;
  /** Policy version, for traces. */
  version?: string;
  /** The stages this tenant may use, in order. Absent: every configured stage. */
  stages?: string[];
  /** Stages that run beside the live ones and are only recorded. */
  shadow: string[];
  /** A tenant-funded stage may hand over to a platform-funded one. */
  platformFallback: boolean;
  thresholds: DecisionThresholds;
  maxOptions: number;
  /** Text longer than this is not sent to a classifier. */
  maxRoutingText: number;
}

/** A version move the active run carries, as a decider sees it (no timestamps, no values). */
export interface DecisionUpdate {
  kind: "migrated" | "revoked";
  /** The version the run was on. */
  from: string;
  /** The version it moved to (moves only). */
  to?: string;
  /** Facts the person is asked for again (names only). */
  facts: string[];
  /** The author's note shown to the person; at most 500 characters. */
  message?: string;
}

/** What a decision port is asked: the person's words and everything they may lead to. */
export interface DecisionRequest {
  /** The person's words. Untrusted: providers must keep it apart from their instructions. */
  text: string;
  locale: string;
  /** 0.3: the runtime's clock when it asked (epoch ms), so "tomorrow" can be resolved. */
  now?: number;
  /** 0.3: the IANA time zone relative days are resolved in (the active run's, else the turn's). */
  timezone?: string;
  /** 0.3: where that zone came from; anything but `context` is a fallback the person never confirmed. */
  timezoneSource?: ZoneSource;
  active: {
    runId: string;
    flowId: string;
    /** The run's pinned flow version and its hash; a proposal for a run that moved on is refused. */
    flowVersion: string;
    flowHash: string;
    title: string;
    /** The run's revision when asked; a proposal writing a fact changed since is refused (`flow/decision-stale`). */
    revision: number;
    /** Facts the person may state; nothing else will be accepted. */
    facts: DecisionFact[];
    /**
     * Set while the run carries a version move or revocation the person has
     * not answered since (`FlowView.update`): what changed, and which facts
     * (names only) they are asked for again.
     */
    update?: DecisionUpdate;
  } | null;
  parked: Array<{ runId: string; flowId: string; title: string }>;
  /** Published flows the person may start. Empty when the catalog is larger than `maxGoals`. */
  goals: DecisionGoal[];
  /** Stable for retries of one turn. */
  turnId?: string;
  /** Epoch milliseconds by which every stage must have answered, on the runtime's clock. */
  deadline?: number;
  /**
   * The same deadline as milliseconds from when the request was made, for
   * a port that keeps time on another clock than the runtime's (the decider
   * chain without a `clock`, with a runtime on a test clock, say).
   */
  timeoutMs?: number;
  /** What the turn can use. A stage only runs when it can provide one of them. */
  needs?: DecisionNeed[];
  /** The channel the turn came through (`TrustedContext.via.kind`). */
  channel?: string;
  policy?: RequestPolicy;
  /** The offer open when the person typed, for context only: a model cannot pick from it. */
  offer?: { options: Array<{ flowId: string; title: string }> } | null;
}

/**
 * A change to a list's items that a decider may propose: the collections
 * feature's `ItemOp`, `add` and `set` only. They are applied as a model's,
 * leniently (a model never removes items or settles a list).
 */
export type ProposedItemOp = Extract<ItemOp, { op: "add" | "set" }>;

/** One option a decider suggests. */
export interface SuggestOption {
  flowId: string;
  facts?: Record<string, JsonValue>;
  /** 0.3: how the model knows each of `facts`, as on `continue`. Only stated values start the run. */
  meta?: Record<string, ProposalMeta>;
  confidence?: number;
}

/** What a decider proposes the text means. Untrusted: the runtime checks every proposal. */
export type DecisionProposal =
  /**
   * Answers for the active run. `meta` (0.3) says, per fact, how the model
   * knows the value: `basis` stated or inferred, the `quote` it came from,
   * and `op: "correct"` when the person asked to change a value they gave.
   * Once a proposal carries `meta`, only a value whose quote is in the
   * person's words counts as stated; the others are only suggested.
   */
  | { kind: "continue"; facts: Record<string, JsonValue>; items?: ProposedItemOp[]; meta?: Record<string, ProposalMeta> }
  /** A side question answered without changing anything. */
  | { kind: "detour"; answer: string; content?: ReplyContent }
  /**
   * Start another flow (asks for consent when one is active). `meta` (0.3)
   * is as on `continue`: only the values it shows the person stated start
   * the run; a proposal without `meta` counts every value as stated.
   */
  | { kind: "switch"; flowId: string; facts?: Record<string, JsonValue>; items?: ProposedItemOp[]; meta?: Record<string, ProposalMeta> }
  /** Bring back a parked run. */
  | { kind: "resume"; runId: string }
  /** Stop the active run (asks for consent). */
  | { kind: "cancel" }
  /** Ask the person to say more. */
  | { kind: "clarify"; question: string }
  /** Close matches, offered as choices for the person to pick from. */
  | { kind: "suggest"; options: SuggestOption[]; question?: string }
  /** Nothing published fits. */
  | { kind: "nomatch" };

/** Why a stage handed the turn on instead of proposing. */
export type PassReason =
  | "pass-to-llm"
  | "low-confidence"
  | "close-call"
  | "timeout"
  | "unavailable"
  | "malformed"
  | "unknown-label"
  | "too-many-candidates"
  | "too-long"
  | "over-limit"
  | "shadow"
  | "no-candidates"
  | "capability"
  | "funding";

/** Every pass reason a stage may give. */
export const PASS_REASONS: readonly PassReason[] = deepFreeze([
  "pass-to-llm",
  "low-confidence",
  "close-call",
  "timeout",
  "unavailable",
  "malformed",
  "unknown-label",
  "too-many-candidates",
  "too-long",
  "over-limit",
  "shadow",
  "no-candidates",
  "capability",
  "funding",
]);

/** Who pays for a stage's model calls. */
export type StageFunding = "platform" | "tenant";

/**
 * What one stage did in one turn. Ids, probabilities and timings only:
 * never the person's text or a fact's value.
 */
export interface StageTrace {
  name: string;
  result: "proposed" | "passed" | "shadow";
  reason?: PassReason;
  ms: number;
  confidence?: number;
  /** The classifier's ranking, kept so a threshold sweep can decide again without a model. */
  ranked?: Array<{ id: string; p: number }>;
  /** What the stage proposed (or, in shadow, would have): the kind and the ids it named. */
  proposed?: { kind: DecisionProposal["kind"]; flowId?: string; runId?: string };
  usage?: { input: number; output: number; model: string };
  /** The adapter that called the model, and its version. */
  adapter?: { id: string; version: string };
  funding?: StageFunding;
}

/** A port's answer with a trace of the stages that produced it (what the decider chain returns). */
export interface DecisionAnswer {
  proposal: DecisionProposal;
  /** At most 8 stages. */
  trace?: { stages: StageTrace[] };
  /**
   * Every live stage that was asked failed (threw, timed out or answered
   * something malformed) and none judged the text: the proposal is only a
   * placeholder, and the runtime asks a clarifying question with
   * `flow/decision-unavailable` rather than answering `nomatch`.
   */
  failed?: true;
}

/** The optional model behind `turn`: proposes what a person's free text means. */
export interface DecisionPort {
  /**
   * Proposes what the text means. `options.signal` aborts at the turn's
   * deadline; an answer after it is ignored.
   */
  decide(context: TrustedContext, request: DecisionRequest, options?: { signal: AbortSignal }): Promise<DecisionProposal | DecisionAnswer>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Longest answer, question or clarification text accepted from a decider. */
export const MAX_ANSWER_TEXT = 2000;
/** Most facts in one proposal. */
export const MAX_PROPOSAL_FACTS = 100;
/** Most options a decider may suggest; the runtime keeps at most `maxOptions` of them. */
export const MAX_SUGGEST_OPTIONS = 50;
/** Most stages in one trace. */
export const MAX_TRACE_STAGES = 8;
/** Most entries in a stage's ranking (a classifier's labels: up to 50 goals, the active flow and two of its own). */
const MAX_RANKED = 64;

const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const STAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const LABEL = /^[a-z][a-z0-9_-]{0,63}$/;
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function shortText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_ANSWER_TEXT;
}

function factRecord(v: unknown): v is Record<string, JsonValue> {
  return isJsonObject(v) && checkJson(v) === null && Object.keys(v).length <= MAX_PROPOSAL_FACTS;
}

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Item operations a decider may propose: `add` and `set`, well formed. Null when any is not. */
function itemOps(v: unknown): ProposedItemOp[] | null {
  if (!Array.isArray(v) || v.length > MAX_ITEM_OPS) return null;
  const out: ProposedItemOp[] = [];
  for (const op of v) {
    if (!isJsonObject(op) || typeof op.collection !== "string" || !NAME.test(op.collection)) return null;
    const fieldsOk = (f: unknown) => factRecord(f) && Object.keys(f).every((k) => NAME.test(k));
    if (op.op === "add" && Object.keys(op).every((k) => k === "op" || k === "collection" || k === "fields")) {
      if (op.fields !== undefined && !fieldsOk(op.fields)) return null;
      out.push({ op: "add", collection: op.collection, ...(op.fields !== undefined ? { fields: op.fields as Record<string, JsonValue> } : {}) });
    } else if (op.op === "set" && isItemId(op.id) && fieldsOk(op.fields) && Object.keys(op).length === 4) {
      out.push({ op: "set", collection: op.collection, id: op.id, fields: op.fields as Record<string, JsonValue> });
    } else return null;
  }
  return out;
}

/** Longest quote a decider may give for one value. */
export const MAX_QUOTE = 200;

/** A proposal's `meta`: one entry per fact it gives, each well formed. Null when it is not. */
function proposalMeta(v: unknown, facts: Record<string, JsonValue>): Record<string, ProposalMeta> | null {
  if (!isJsonObject(v) || Object.keys(v).length > MAX_PROPOSAL_FACTS) return null;
  const out: Record<string, ProposalMeta> = {};
  for (const [name, m] of Object.entries(v)) {
    if (!Object.hasOwn(facts, name) || !isJsonObject(m) || !Object.keys(m).every((k) => k === "basis" || k === "quote" || k === "op")) return null;
    if (m.basis !== undefined && m.basis !== "stated" && m.basis !== "inferred") return null;
    if (m.quote !== undefined && (typeof m.quote !== "string" || m.quote.length === 0 || m.quote.length > MAX_QUOTE)) return null;
    if (m.op !== undefined && m.op !== "set" && m.op !== "correct") return null;
    const entry: ProposalMeta = {
      ...(m.basis !== undefined ? { basis: m.basis as "stated" | "inferred" } : {}),
      ...(typeof m.quote === "string" ? { quote: m.quote } : {}),
      ...(m.op !== undefined ? { op: m.op as "set" | "correct" } : {}),
    };
    Object.defineProperty(out, name, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Validates a provider's proposal. Returns null when it is not a well-formed proposal. */
export function parseProposal(raw: unknown): DecisionProposal | null {
  if (!isJsonObject(raw)) return null;
  switch (raw.kind) {
    case "continue": {
      if (!factRecord(raw.facts)) return null;
      const meta = raw.meta === undefined ? undefined : proposalMeta(raw.meta, raw.facts);
      if (meta === null) return null;
      const items = raw.items === undefined ? undefined : itemOps(raw.items);
      if (items === null) return null;
      return { kind: "continue", facts: raw.facts, ...(items !== undefined ? { items } : {}), ...(meta !== undefined ? { meta } : {}) };
    }
    case "detour": {
      if (!shortText(raw.answer)) return null;
      if (raw.content === undefined) return { kind: "detour", answer: raw.answer };
      const content = parseReplyContent(raw.content);
      return content ? { kind: "detour", answer: raw.answer, content } : null;
    }
    case "switch": {
      if (typeof raw.flowId !== "string" || raw.flowId.length > 64) return null;
      if (raw.facts !== undefined && !factRecord(raw.facts)) return null;
      const meta = raw.meta === undefined ? undefined : proposalMeta(raw.meta, (raw.facts ?? {}) as Record<string, JsonValue>);
      if (meta === null) return null;
      const items = raw.items === undefined ? undefined : itemOps(raw.items);
      if (items === null) return null;
      return {
        kind: "switch",
        flowId: raw.flowId,
        ...(raw.facts !== undefined ? { facts: raw.facts as Record<string, JsonValue> } : {}),
        ...(items !== undefined ? { items } : {}),
        ...(meta !== undefined ? { meta } : {}),
      };
    }
    case "resume":
      return typeof raw.runId === "string" && raw.runId.length <= 128 ? { kind: "resume", runId: raw.runId } : null;
    case "cancel":
      return { kind: "cancel" };
    case "clarify":
      return shortText(raw.question) ? { kind: "clarify", question: raw.question } : null;
    case "suggest": {
      if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > MAX_SUGGEST_OPTIONS) return null;
      if (raw.question !== undefined && !shortText(raw.question)) return null;
      const options: SuggestOption[] = [];
      for (const o of raw.options) {
        if (!isJsonObject(o) || typeof o.flowId !== "string" || o.flowId.length > 64) return null;
        if (o.facts !== undefined && !factRecord(o.facts)) return null;
        if (o.confidence !== undefined && !unit(o.confidence)) return null;
        const meta = o.meta === undefined ? undefined : proposalMeta(o.meta, (o.facts ?? {}) as Record<string, JsonValue>);
        if (meta === null) return null;
        options.push({
          flowId: o.flowId,
          ...(o.facts !== undefined ? { facts: o.facts as Record<string, JsonValue> } : {}),
          ...(meta !== undefined ? { meta } : {}),
          ...(typeof o.confidence === "number" ? { confidence: o.confidence } : {}),
        });
      }
      return { kind: "suggest", options, ...(typeof raw.question === "string" ? { question: raw.question } : {}) };
    }
    case "nomatch":
      return { kind: "nomatch" };
    default:
      return null;
  }
}

const RESULTS = new Set(["proposed", "passed", "shadow"]);
const KINDS = new Set(["continue", "detour", "switch", "resume", "cancel", "clarify", "suggest", "nomatch"]);
const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validates one stage trace. Null when it is malformed or could carry text. */
export function parseStageTrace(raw: unknown): StageTrace | null {
  if (!isJsonObject(raw) || typeof raw.name !== "string" || !STAGE_NAME.test(raw.name)) return null;
  if (typeof raw.result !== "string" || !RESULTS.has(raw.result) || !nonNegative(raw.ms)) return null;
  const out: StageTrace = { name: raw.name, result: raw.result as StageTrace["result"], ms: raw.ms };
  for (const key of Object.keys(raw)) {
    if (!["name", "result", "reason", "ms", "confidence", "ranked", "proposed", "usage", "adapter", "funding"].includes(key)) return null;
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string" || !(PASS_REASONS as readonly string[]).includes(raw.reason)) return null;
    out.reason = raw.reason as PassReason;
  }
  if (raw.confidence !== undefined) {
    if (!unit(raw.confidence)) return null;
    out.confidence = raw.confidence;
  }
  if (raw.ranked !== undefined) {
    if (!Array.isArray(raw.ranked) || raw.ranked.length > MAX_RANKED) return null;
    const ranked: Array<{ id: string; p: number }> = [];
    for (const r of raw.ranked) {
      if (!isJsonObject(r) || typeof r.id !== "string" || !LABEL.test(r.id) || !unit(r.p) || Object.keys(r).length !== 2) return null;
      ranked.push({ id: r.id, p: r.p });
    }
    out.ranked = ranked;
  }
  if (raw.proposed !== undefined) {
    const p = raw.proposed;
    if (!isJsonObject(p) || typeof p.kind !== "string" || !KINDS.has(p.kind)) return null;
    if (p.flowId !== undefined && (typeof p.flowId !== "string" || !LABEL.test(p.flowId))) return null;
    if (p.runId !== undefined && (typeof p.runId !== "string" || !RUN_ID.test(p.runId))) return null;
    out.proposed = { kind: p.kind as DecisionProposal["kind"], ...(typeof p.flowId === "string" ? { flowId: p.flowId } : {}), ...(typeof p.runId === "string" ? { runId: p.runId } : {}) };
  }
  if (raw.usage !== undefined) {
    const u = raw.usage;
    if (!isJsonObject(u) || !nonNegative(u.input) || !nonNegative(u.output) || typeof u.model !== "string" || !SHORT_ID.test(u.model)) return null;
    out.usage = { input: u.input, output: u.output, model: u.model };
  }
  if (raw.adapter !== undefined) {
    const a = raw.adapter;
    if (!isJsonObject(a) || typeof a.id !== "string" || !SHORT_ID.test(a.id) || typeof a.version !== "string" || !SHORT_ID.test(a.version)) return null;
    out.adapter = { id: a.id, version: a.version };
  }
  if (raw.funding !== undefined) {
    if (raw.funding !== "platform" && raw.funding !== "tenant") return null;
    out.funding = raw.funding;
  }
  return out;
}

/**
 * Validates a provider's answer: a bare proposal or a
 * `DecisionAnswer`. Returns null when the proposal is not well formed. A
 * trace that is malformed, or longer than 8 stages, is dropped; the proposal
 * still stands, since it is checked on its own.
 */
export function parseDecision(raw: unknown): DecisionAnswer | null {
  if (!isJsonObject(raw)) return null;
  if (raw.kind === undefined && raw.proposal !== undefined) {
    const proposal = parseProposal(raw.proposal);
    if (!proposal) return null;
    const failed = raw.failed === true ? { failed: true as const } : {};
    const trace = raw.trace;
    if (isJsonObject(trace) && Array.isArray(trace.stages) && trace.stages.length <= MAX_TRACE_STAGES) {
      const stages = trace.stages.map(parseStageTrace);
      if (stages.every((s): s is StageTrace => s !== null)) return { proposal, trace: { stages }, ...failed };
    }
    return { proposal, ...failed };
  }
  const proposal = parseProposal(raw);
  return proposal ? { proposal } : null;
}

/** The capabilities a proposal needs from the stage that made it. */
export function proposalNeeds(proposal: DecisionProposal): DecisionNeed[] {
  switch (proposal.kind) {
    case "continue":
      return ["extract"];
    case "detour":
      return ["answer"];
    case "switch":
      return proposal.facts || proposal.items ? ["choose", "extract"] : ["choose"];
    case "suggest":
      return proposal.options.some((o) => o.facts) ? ["choose", "extract"] : ["choose"];
    case "resume":
    case "cancel":
      return ["choose"];
    case "clarify":
    case "nomatch":
      return [];
  }
}

const factsSchema: JsonSchema = { type: "object", description: "Fact name to value, only for facts listed in the request." };
const itemsSchema: JsonSchema = {
  type: "array",
  maxItems: MAX_ITEM_OPS,
  items: {
    anyOf: [
      { type: "object", properties: { op: { const: "add" }, collection: { type: "string" }, fields: { type: "object" } }, required: ["op", "collection"], additionalProperties: false },
      { type: "object", properties: { op: { const: "set" }, collection: { type: "string" }, id: { type: "string" }, fields: { type: "object" } }, required: ["op", "collection", "id", "fields"], additionalProperties: false },
    ],
  },
};
const metaSchema: JsonSchema = {
  type: "object",
  description: "Per fact in facts: how you know it. basis: stated (the person said it) or inferred (guessed). quote: the person's exact words it came from. op: correct when the person asks to change a value they gave.",
  additionalProperties: {
    type: "object",
    properties: { basis: { enum: ["stated", "inferred"] }, quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE }, op: { enum: ["set", "correct"] } },
    additionalProperties: false,
  },
};
const text = (description: string): JsonSchema => ({ type: "string", minLength: 1, maxLength: MAX_ANSWER_TEXT, description });

/**
 * The JSON Schema of a proposal, for a model's structured output. It is in
 * the engine's schema subset, which is plain JSON Schema. `parseDecision`
 * still checks every answer: a schema is a request, not a guarantee.
 */
export const PROPOSAL_SCHEMA: JsonSchema = deepFreeze({
  anyOf: [
    { type: "object", properties: { kind: { const: "continue" }, facts: factsSchema, items: itemsSchema, meta: metaSchema }, required: ["kind", "facts"], additionalProperties: false },
    {
      type: "object",
      properties: {
        kind: { const: "detour" },
        answer: text("A short answer to a side question."),
        content: {
          type: "object",
          properties: {
            blocks: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                anyOf: [
                  { type: "object", properties: { type: { const: "text" }, text: { type: "string" } }, required: ["type", "text"], additionalProperties: false },
                  { type: "object", properties: { type: { const: "list" }, items: { type: "array", items: { type: "string" }, maxItems: 20 } }, required: ["type", "items"], additionalProperties: false },
                  { type: "object", properties: { type: { const: "link" }, title: { type: "string" }, url: { type: "string" } }, required: ["type", "title", "url"], additionalProperties: false },
                ],
              },
            },
            sources: {
              type: "array",
              maxItems: 10,
              items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title"], additionalProperties: false },
            },
          },
          required: ["blocks"],
          additionalProperties: false,
        },
      },
      required: ["kind", "answer"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "switch" }, flowId: { type: "string", description: "A goal's flowId from the request." }, facts: factsSchema, items: itemsSchema, meta: metaSchema },
      required: ["kind", "flowId"],
      additionalProperties: false,
    },
    { type: "object", properties: { kind: { const: "resume" }, runId: { type: "string", description: "A parked run's runId from the request." } }, required: ["kind", "runId"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "cancel" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "clarify" }, question: text("A question asking the person to say more.") }, required: ["kind", "question"], additionalProperties: false },
    {
      type: "object",
      properties: {
        kind: { const: "suggest" },
        question: text("A short question introducing the options."),
        options: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: { flowId: { type: "string" }, facts: factsSchema, meta: metaSchema, confidence: { type: "number", minimum: 0, maximum: 1 } },
            required: ["flowId"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "options"],
      additionalProperties: false,
    },
    { type: "object", properties: { kind: { const: "nomatch" } }, required: ["kind"], additionalProperties: false },
  ],
});
