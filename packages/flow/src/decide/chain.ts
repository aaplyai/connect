/**
 * The decider chain: stages tried in order within one deadline, the first
 * proposal winning. A stage is a host-supplied adapter (a classifier, an
 * LLM, anything else); the engine holds no client and no credentials.
 *
 * Exact published names are not a stage: the runtime matches them before
 * the decision port is asked (FacetJS ADR-0046), so they work without a
 * decider and never cost a model call.
 */

import { proposalNeeds, parseProposal, parseStageTrace, MAX_TRACE_STAGES, PASS_REASONS, type DecisionAnswer, type DecisionNeed, type DecisionPort, type DecisionProposal, type DecisionRequest, type PassReason, type StageFunding, type StageTrace } from "../decision.js";
import { systemClock, type Clock, type TrustedContext } from "../ports.js";

/** What a stage is given. */
export interface StageInput {
  ctx: TrustedContext;
  /** The request, with the text already redacted. */
  request: DecisionRequest;
  /** Aborted at the deadline, or when the turn is abandoned. */
  signal: AbortSignal;
  /** Milliseconds left before the deadline. */
  remainingMs: number;
}

/** What a stage answers: a proposal (untrusted, checked by the chain) or a pass. */
export type StageResult =
  | { proposal: unknown; confidence?: number; ranked?: Array<{ id: string; p: number }>; usage?: StageTrace["usage"] }
  | { pass: PassReason; confidence?: number; ranked?: Array<{ id: string; p: number }>; usage?: StageTrace["usage"] };

/** One stage of a chain. */
export interface DeciderStage {
  /** Unique in the chain; what a policy's `stages` and `shadow` name. */
  name: string;
  /**
   * What the stage may propose: `choose` (switch, resume, cancel, suggest),
   * `extract` (facts) and `answer` (side questions). A stage none of whose
   * capabilities the turn needs is skipped, and a proposal that needs more
   * than the stage declares is dropped; both pass as `capability`.
   */
  capabilities: readonly DecisionNeed[];
  /** Who pays for its calls. A tenant-funded stage never hands over to a platform-funded one unless the policy allows it. */
  funding?: StageFunding;
  /** The adapter and its version, recorded on the stage's trace. */
  adapter?: { id: string; version: string };
  decide(input: StageInput): Promise<StageResult>;
}

/** How a decider chain is built: its stages and the host's hooks around them. */
export interface DeciderChainOptions {
  stages: readonly DeciderStage[];
  /**
   * Runs on the text before any stage sees it (remove card numbers, say). A
   * redactor that throws fails the turn: unredacted text is never sent.
   */
  redact?: (text: string) => string;
  /**
   * Asked before each stage runs (a spend budget, say: pass `stage` to
   * `AdmissionPort.admit`). False, or a throw, passes the stage as
   * `over-limit`. It counts against the deadline: one still undecided when
   * the deadline passes passes the stage as `timeout`, and the stage is
   * never called.
   */
  beforeStage?: (ctx: TrustedContext, info: { stage: string; funding: StageFunding | undefined; turnId: string | undefined; shadow: boolean }) => boolean | Promise<boolean>;
  /** Every shadow stage's trace, when it finishes (which may be after the turn answered). */
  onShadow?: (trace: StageTrace, info: { turnId: string | undefined }) => void;
  /** A stage, the redactor or a callback threw. */
  onError?: (error: unknown, where: string) => void;
  /**
   * The clock the request's `deadline` is on: pass the runtime's. Without
   * one, the chain times the request's `timeoutMs` (the same deadline,
   * relative), so it never disagrees with the runtime's clock; a request
   * with only a `deadline` is read against the system clock.
   */
  clock?: Clock;
  /** Budget when a request carries no deadline. Default 15 seconds. */
  budgetMs?: number;
}

const STAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const NEEDS = new Set<DecisionNeed>(["choose", "extract", "answer"]);
const TIMEOUT: unique symbol = Symbol("timeout");
/** A stage that passed for one of these was asked and failed; any other pass, bar the skips, judged the text. */
const FAILED: ReadonlySet<PassReason> = new Set(["timeout", "unavailable", "malformed"]);
/** Passes for stages that were never asked. */
const SKIPPED: ReadonlySet<PassReason> = new Set(["capability", "funding", "over-limit"]);

/**
 * A decision port from stages. Stages run in the order of the policy's
 * `stages` (or as given), each within what is left of the deadline; the
 * first valid proposal wins, and if every stage passes the answer is
 * `nomatch`. When no stage judged the text because every one asked failed
 * (threw, timed out, answered malformed), the answer is marked `failed`, so
 * the runtime asks again with `flow/decision-unavailable` instead of saying
 * it cannot help. A stage named in the policy's `shadow` runs beside the
 * live ones from the start, is only recorded (`result: "shadow"`), and never
 * delays the answer. The answer carries a trace of every stage (ids the
 * request offered, probabilities and timings; never text).
 *
 * Throws at creation on more than 8 stages, a repeated or malformed name, or
 * an unknown capability.
 */
export function createDeciderChain(options: DeciderChainOptions): DecisionPort {
  const stages = [...options.stages];
  if (stages.length === 0 || stages.length > MAX_TRACE_STAGES) throw new Error(`A decider chain has 1 to ${MAX_TRACE_STAGES} stages.`);
  const byName = new Map<string, DeciderStage>();
  for (const stage of stages) {
    if (typeof stage.name !== "string" || !STAGE_NAME.test(stage.name) || byName.has(stage.name)) throw new Error(`Bad or repeated stage name: ${String(stage.name)}.`);
    if (!Array.isArray(stage.capabilities) || stage.capabilities.some((c) => !NEEDS.has(c))) throw new Error(`Stage ${stage.name} has an unknown capability.`);
    byName.set(stage.name, stage);
  }
  const budgetMs = options.budgetMs ?? 15_000;
  /** Milliseconds left of the request's deadline, measured on one clock throughout. */
  const remainingOf = (request: DecisionRequest): number => {
    if (options.clock) return (request.deadline ?? options.clock.now() + budgetMs) - options.clock.now();
    if (typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs)) return request.timeoutMs;
    return request.deadline !== undefined ? request.deadline - systemClock.now() : budgetMs;
  };
  const report = (error: unknown, where: string) => {
    try {
      options.onError?.(error, where);
    } catch {
      // A reporter that throws is ignored.
    }
  };

  return {
    async decide(ctx, request, call) {
      const text = options.redact ? options.redact(request.text) : request.text;
      if (typeof text !== "string") throw new Error("The redactor did not return text.");
      const req: DecisionRequest = { ...request, text };
      const policy = request.policy;
      const allowed = policy?.stages ? policy.stages.filter((n) => byName.has(n)) : stages.map((s) => s.name);
      const shadowNames = new Set((policy?.shadow ?? []).filter((n) => allowed.includes(n)));
      const live = allowed.filter((n) => !shadowNames.has(n)).map((n) => byName.get(n)!);
      const remaining = remainingOf(request);
      const endAt = performance.now() + remaining;
      const outer = call?.signal;
      const traces: StageTrace[] = [];
      let answered = false;
      // Set when a stage's deadline timer fires (timers may fire a little before the clock agrees).
      let outOfTime = false;

      // Shadow stages start at once and are never awaited.
      for (const name of shadowNames) {
        const stage = byName.get(name)!;
        void runStage(stage, true).then(({ trace }) => {
          if (!answered) traces.push(trace);
          try {
            options.onShadow?.(trace, { turnId: request.turnId });
          } catch (error) {
            report(error, "onShadow");
          }
        });
      }

      let tenantPassed = false;
      let proposal: DecisionProposal | null = null;
      for (const stage of live) {
        if (tenantPassed && stage.funding === "platform" && !policy?.platformFallback) {
          traces.push(trace(stage, { result: "passed", reason: "funding", ms: 0 }));
          continue;
        }
        const ran = await runStage(stage, false);
        traces.push(ran.trace);
        if (ran.proposal) {
          proposal = ran.proposal;
          break;
        }
        if (stage.funding === "tenant") tenantPassed = true;
      }
      answered = true;
      const asked = traces.filter((t) => t.result === "passed" && t.reason !== undefined && !SKIPPED.has(t.reason));
      const failed = proposal === null && asked.length > 0 && asked.every((t) => FAILED.has(t.reason!));
      const answer: DecisionAnswer = { proposal: proposal ?? { kind: "nomatch" }, trace: { stages: traces.slice(0, MAX_TRACE_STAGES) }, ...(failed ? { failed: true as const } : {}) };
      return answer;

      async function runStage(stage: DeciderStage, shadow: boolean): Promise<{ trace: StageTrace; proposal?: DecisionProposal }> {
        const started = performance.now();
        const ms = () => Math.max(0, Math.round(performance.now() - started));
        const passed = (reason: PassReason, extra: Partial<StageTrace> = {}) => ({ trace: trace(stage, { result: shadow ? "shadow" : "passed", reason, ms: ms(), ...extra }) });
        if (outer?.aborted || outOfTime || endAt - performance.now() <= 0) return passed("timeout");
        if (request.needs && !stage.capabilities.some((c) => request.needs!.includes(c))) return passed("capability");
        if (options.beforeStage) {
          const before = options.beforeStage;
          let verdict: unknown = false;
          try {
            verdict = await withinDeadline(() => before(ctx, { stage: stage.name, funding: stage.funding, turnId: request.turnId, shadow }));
          } catch (error) {
            report(error, `beforeStage:${stage.name}`);
          }
          if (verdict === TIMEOUT) return passed("timeout");
          if (verdict !== true) return passed("over-limit");
          if (outer?.aborted || outOfTime || endAt - performance.now() <= 0) return passed("timeout");
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        outer?.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: StageResult | typeof TIMEOUT;
        try {
          const timeout = new Promise<typeof TIMEOUT>((resolve) => {
            timer = setTimeout(() => {
              outOfTime = true;
              controller.abort();
              resolve(TIMEOUT);
            }, Math.max(0, endAt - performance.now()));
            // The turn was abandoned: stop waiting at once.
            controller.signal.addEventListener("abort", () => resolve(TIMEOUT), { once: true });
          });
          result = await Promise.race([
            Promise.resolve().then(() => stage.decide({ ctx, request: req, signal: controller.signal, remainingMs: Math.max(0, endAt - performance.now()) })),
            timeout,
          ]);
        } catch (error) {
          report(error, `stage:${stage.name}`);
          return passed("unavailable");
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          outer?.removeEventListener("abort", abort);
          controller.abort();
        }
        if (result === TIMEOUT) return passed("timeout");
        if (typeof result !== "object" || result === null) return passed("malformed");
        const extra = details(result);
        if (!("proposal" in result)) {
          const reason = (result as { pass?: unknown }).pass;
          return passed(typeof reason === "string" && reason !== "shadow" && (PASS_REASONS as readonly string[]).includes(reason) ? (reason as PassReason) : "malformed", extra);
        }
        const checked = parseProposal(result.proposal);
        if (!checked) return passed("malformed", extra);
        if (!proposalNeeds(checked).every((n) => stage.capabilities.includes(n))) return passed("capability", extra);
        const done = trace(stage, { result: shadow ? "shadow" : "proposed", ms: ms(), ...extra, proposed: summary(checked, request) });
        return shadow ? { trace: done } : { trace: done, proposal: checked };
      }

      /** Runs `work` until it settles or the deadline (or the turn's abort) comes first. */
      async function withinDeadline<T>(work: () => T | Promise<T>): Promise<T | typeof TIMEOUT> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const timeout = new Promise<typeof TIMEOUT>((resolve) => {
            timer = setTimeout(() => {
              outOfTime = true;
              resolve(TIMEOUT);
            }, Math.max(0, endAt - performance.now()));
            onAbort = () => resolve(TIMEOUT);
            outer?.addEventListener("abort", onAbort, { once: true });
          });
          return await Promise.race([Promise.resolve().then(work), timeout]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort) outer?.removeEventListener("abort", onAbort);
        }
      }
    },
  };
}

/** A stage's trace, from validated parts only; anything that would not parse is dropped. */
function trace(stage: DeciderStage, parts: Omit<StageTrace, "name">): StageTrace {
  const candidate: StageTrace = {
    name: stage.name,
    ...parts,
    ...(stage.adapter ? { adapter: { ...stage.adapter } } : {}),
    ...(stage.funding ? { funding: stage.funding } : {}),
  };
  const parsed = parseStageTrace(candidate);
  if (parsed) return parsed;
  // Something the stage reported (a ranking, usage, its adapter) is malformed: keep only what is certain.
  return { name: stage.name, result: parts.result, ...(parts.reason ? { reason: parts.reason } : {}), ms: parts.ms, ...(parts.proposed ? { proposed: parts.proposed } : {}) };
}

function details(result: StageResult): Partial<StageTrace> {
  return {
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(result.ranked !== undefined ? { ranked: result.ranked.map((r) => ({ id: r.id, p: r.p })) } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

/**
 * What a proposal named, by id: only an id the request offered (a goal's
 * flow id, a parked run's id). Any other id is a model's invention, and may
 * carry what the person typed, so it is left out.
 */
function summary(proposal: DecisionProposal, request: DecisionRequest): NonNullable<StageTrace["proposed"]> {
  switch (proposal.kind) {
    case "switch":
      return { kind: "switch", ...(request.goals.some((g) => g.flowId === proposal.flowId) ? { flowId: proposal.flowId } : {}) };
    case "resume":
      return { kind: "resume", ...(request.parked.some((p) => p.runId === proposal.runId) ? { runId: proposal.runId } : {}) };
    default:
      return { kind: proposal.kind };
  }
}
