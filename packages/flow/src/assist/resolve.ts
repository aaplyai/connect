/**
 * What the runtime makes of a decider's `continue` before anything is
 * recorded (ADR 0012): each value normalised against the turn's clock and
 * the run's zone, and judged stated or inferred by checking its quote
 * against the person's words. The event then records only the results, so
 * replay never reads text or a clock.
 */

import type { CompiledFlow } from "../compile.js";
import type { JsonValue } from "../json.js";
import type { AssistMark, FillMode } from "../state.js";
import { nearMidnight, normaliseValue, quoteIsRelative, quoteSupports, type NormaliseContext } from "./normalise.js";

/** How a decider says it knows one value (`DecisionProposal` `continue.meta`). */
export interface ProposalMeta {
  /** `stated`: the person said it; `inferred`: guessed from context. */
  basis?: "stated" | "inferred";
  /** The person's words the value came from. */
  quote?: string;
  /** `correct`: the person asked to change a value they gave. */
  op?: "set" | "correct";
}

export interface ResolvedProposal {
  /** The values to record, normalised. */
  facts: Record<string, JsonValue>;
  /** How each was judged. */
  marks: Record<string, AssistMark>;
  /** Facts whose value could not be used (ambiguous, impossible, or a relative day near midnight in a fallback zone): ask about them. */
  unclear: string[];
}

/**
 * Normalises and judges a decider's values. A proposal without any `meta`
 * comes from a decider that does not report how it knows (a 0.2 port): its
 * values count as stated, as they always did. Once a proposal carries
 * `meta`, a value counts as stated only when its quote is in `text` and
 * normalises to the value; anything else is inferred, and only suggested.
 */
export function resolveProposal(
  flow: CompiledFlow,
  text: string,
  facts: Record<string, JsonValue>,
  meta: Record<string, ProposalMeta> | undefined,
  ctx: NormaliseContext,
  cap?: FillMode,
): ResolvedProposal {
  const out: ResolvedProposal = { facts: {}, marks: {}, unclear: [] };
  for (const [name, raw] of Object.entries(facts)) {
    const fact = flow.facts.get(name);
    if (!fact) continue;
    const normal = normaliseValue(raw, fact.schema, ctx);
    if (!normal.ok && normal.reason !== "unparsed") {
      out.unclear.push(name);
      continue;
    }
    const m = meta === undefined ? undefined : Object.hasOwn(meta, name) ? meta[name] : undefined;
    // A day relative to now, judged from the value or from its quote: a model
    // that resolved "tomorrow" itself sends an ISO value but still quoted it.
    const relative = (normal.ok && normal.relative) || quoteIsRelative(m?.quote, fact.schema, ctx);
    if (relative && nearMidnight(ctx)) {
      out.unclear.push(name);
      continue;
    }
    // What does not parse is recorded as given: the core checks it against the fact and says why it was not filled.
    const value = normal.ok ? normal.value : raw;
    const stated = meta === undefined || (m?.basis !== "inferred" && m?.quote !== undefined && quoteSupports(m.quote, text, value, fact.schema, ctx));
    Object.defineProperty(out.facts, name, { value, enumerable: true, writable: true, configurable: true });
    const mark: AssistMark = { basis: stated ? "stated" : "inferred", ...(stated && m?.op === "correct" ? { op: "correct" as const } : {}), ...(cap !== undefined ? { cap } : {}) };
    Object.defineProperty(out.marks, name, { value: mark, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
