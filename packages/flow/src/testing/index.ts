/**
 * Test kit: fake ports, a deterministic clock and ids, a harness that wires
 * a runtime to an in-memory store, the store conformance cases every
 * RunStore implementation must pass, and the catalog conformance cases.
 */

import { createMemoryCatalog, type MemoryCatalog } from "../catalog.js";
import type { JsonValue } from "../json.js";
import { createMemoryStore, type MemoryRunStore } from "../memory-store.js";
import type { DecisionAnswer, DecisionPort, DecisionProposal, DecisionRequest } from "../decision.js";
import type { ClassifierResult, ClassifyFn, ClassifyInput } from "../decide/classifier.js";
import type { CompleteFn, CompleteInput } from "../decide/llm.js";
import type { LaneRecord } from "../lanes.js";
import { DEFAULT_THRESHOLDS, sealCalibration, type Calibration, type CalibratedStage, type DecisionPolicy, type DecisionThresholds } from "../policy.js";
import { hmacActionSigner, sha256, type ApprovedAction } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, CONFORMANCE_KEY } from "@aaply/action-contract/conformance";
import { deepFreeze } from "@aaply/action-contract/internal";
import type { EnvelopeSigning } from "../approved.js";
import type { OperationContracts } from "../bindings.js";
import type { BlobHost } from "../blob-guard.js";
import { hmacKeyMinter, type ActionPort, type AdmissionPort, type Clock, type IdSource, type LanePolicy, type Observer, type PickRecord, type TraceRecord, type TrustedContext, type TurnRecord } from "../ports.js";
import { createFlowRuntime, type FlowRuntime, type RuntimeLimits, type RuntimeOptions } from "../runtime.js";
import type { ActionOutcome, Scope } from "../state.js";
import type { RunStore } from "../store.js";
import { callView, type ActionContext, type ActionRequest } from "./call-view.js";

export type { ActionContext, ActionRequest } from "./call-view.js";
export { storeConformanceCases, type ConformanceCase } from "./conformance.js";
export { laneConformanceCases, type LaneConfig } from "./lane-conformance.js";
export { blobLedgerConformanceCases } from "./blob-conformance.js";
export { memoryBlobHost, type MemoryBlobHost, type MemoryBlobHostOptions } from "./blobs.js";
export {
  catalogConformance,
  type CatalogConformanceCase,
  type CatalogConformanceEnv,
  type CatalogConformanceOptions,
  type ManagedCatalog,
} from "./catalog-conformance.js";
export {
  exportCorpusCase,
  replayCorpusCase,
  type CorpusCase,
  type CorpusDivergence,
  type CorpusDivergenceKind,
  type CorpusExpected,
  type CorpusStep,
  type CorpusViews,
} from "./corpus.js";

export interface TestClock extends Clock {
  advance(ms: number): number;
  set(ms: number): void;
}

export function testClock(start = Date.UTC(2026, 0, 1)): TestClock {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      return now;
    },
    set(ms) {
      now = ms;
    },
  };
}

export function sequentialIds(prefix = "id"): IdSource {
  let n = 0;
  return { newId: () => `${prefix}-${String(++n).padStart(6, "0")}` };
}

export const testKeys = deepFreeze(hmacKeyMinter("test-idempotency-secret-0123456789"));

/**
 * A repeatable `RuntimeOptions.randomBytes`: the bytes of SHA-256 over
 * `seed:0`, `seed:1` and so on, handed out in order, so two runtimes given
 * the same seed and the same calls draw the same run nonces (and so the same
 * confirm digests and child run ids). For tests only: whoever knows the seed
 * can predict every nonce.
 */
export function seededRandomBytes(seed: string): (out: Uint8Array) => void {
  let block = 0;
  let buffer: Uint8Array = new Uint8Array(0);
  let offset = 0;
  return (out) => {
    for (let i = 0; i < out.length; i++) {
      if (offset >= buffer.length) {
        buffer = sha256(`${seed}:${block++}`);
        offset = 0;
      }
      out[i] = buffer[offset++]!;
    }
  };
}

/**
 * The harness's envelope signing: the contract's conformance key, for its
 * conformance audience. A port built with `CONFORMANCE_AUDIENCE` and
 * `conformanceVerifier()` (from `@aaply/action-contract`) accepts what a
 * harness runtime sends. A test key: never use it for real envelopes.
 */
export const testEnvelopes: EnvelopeSigning = deepFreeze({ audience: CONFORMANCE_AUDIENCE, signer: hmacActionSigner(CONFORMANCE_KEY) });

export const ok = (output: JsonValue = null): ActionOutcome => ({ status: "ok", output });
export const retryable = (code = "unavailable", retryAfterMs?: number): ActionOutcome => ({ status: "retryable", error: { code, message: "Try again." }, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
export const final = (code = "rejected", message = "Not possible."): ActionOutcome => ({ status: "final", error: { code, message } });
export const unknownOutcome = (code = "timeout"): ActionOutcome => ({ status: "unknown", error: { code, message: "No answer." } });
export const pending = (ref?: string): ActionOutcome => ({ status: "pending", ...(ref !== undefined ? { ref } : {}) });

/** A fake action. `request` and `context` are a flat view of `approved` (`callView`), the envelope the port received. */
export type FakeHandler = (input: Record<string, JsonValue>, request: ActionRequest, context: ActionContext, approved: ApprovedAction) => ActionOutcome | Promise<ActionOutcome>;

/** One call a fake port received. */
export interface ActionCall {
  action: string;
  request: ActionRequest;
  context: ActionContext;
  /** The approved action as sent, including its completion token. */
  approved: ApprovedAction;
}

export interface FakeActions extends ActionPort {
  readonly calls: ActionCall[];
  callsTo(action: string): ActionCall[];
  /** Replace or add a handler. */
  on(action: string, handler: FakeHandler): void;
}

/** A fake connector backend. Unknown actions answer `final`. */
export function fakeActions(handlers: Record<string, FakeHandler> = {}): FakeActions {
  const table = new Map(Object.entries(handlers));
  const calls: ActionCall[] = [];
  return {
    calls,
    callsTo: (action) => calls.filter((c) => c.request.action === action),
    on(action, handler) {
      table.set(action, handler);
    },
    async run(approved, signal) {
      const { context, request } = callView(approved, signal);
      calls.push({ action: request.action, request: structuredClone(request), context, approved: structuredClone(approved) });
      const handler = table.get(request.action);
      if (!handler) return final("no-handler", `no fake handler for ${request.action}`);
      return handler(request.input, request, context, approved);
    },
  };
}

export function testScope(overrides: Partial<Scope> = {}): Scope {
  return { tenantId: "tenant-a", appId: "app-1", environmentId: "env-prod", ...overrides };
}

let requestCounter = 0;

export function testContext(overrides: Partial<TrustedContext> & { actorId?: string } = {}): TrustedContext {
  const { actorId, ...rest } = overrides;
  return {
    scope: testScope(),
    environmentKind: "production",
    actor: { domain: "visitor", kind: "visitor", id: actorId ?? "v-1" },
    appRoles: [],
    locale: "en-GB",
    timezone: "Europe/London",
    requestId: `req-${++requestCounter}`,
    ...rest,
  };
}

export interface Harness<S extends RunStore = MemoryRunStore> {
  runtime: FlowRuntime;
  store: S;
  catalog: MemoryCatalog;
  clock: TestClock;
  actions: FakeActions;
  traces: TraceRecord[];
  /** Every turn's record (`Observer.turn`). */
  turns: TurnRecord[];
  /** Every pick from an offer (`Observer.pick`). */
  picks: PickRecord[];
  errors: Array<{ error: unknown; where: string }>;
  /** Lane records the runtime reported. */
  laneRecords: LaneRecord[];
  scope: Scope;
  /** A fresh context (new request id) for the default visitor, or as overridden. */
  ctx(overrides?: Partial<TrustedContext> & { actorId?: string }): TrustedContext;
  /** Runs workers until nothing is due. */
  drain(maxPasses?: number): Promise<number>;
  /** Moves time forward and runs whatever became due. */
  advance(ms: number): Promise<void>;
}

export interface HarnessOptions<S extends RunStore = MemoryRunStore> {
  flows?: unknown[];
  /** Fake connector actions by action id (for example `"calendar.findSlots"`). */
  actions?: Record<string, FakeHandler>;
  /** Same as `actions`; kept for older tests. `actions` wins on a clash. */
  handlers?: Record<string, FakeHandler>;
  decide?: DecisionPort;
  /** The tenant's decision policy (a value, or read per turn). Absent: routing off (`NO_POLICY`), so a decider is never asked. */
  policy?: DecisionPolicy | ((ctx: TrustedContext) => DecisionPolicy | Promise<DecisionPolicy>);
  /** Quotas and budgets; everything is admitted by default. */
  admission?: AdmissionPort;
  /** The clock; a test clock at 1 January 2026 by default. */
  clock?: TestClock;
  limits?: Partial<RuntimeLimits>;
  /** Any RunStore; the in-memory store by default. */
  store?: S;
  observer?: Observer;
  /** The runtime's lane policy (used with a store that has `lanes`). */
  lanes?: LanePolicy;
  /** How the runtime signs envelopes: {@link testEnvelopes} by default; null gives it none, so envelopes go unsigned. */
  envelopes?: EnvelopeSigning | null;
  /** The runtime's operation contracts (`RuntimeOptions.operations`): an undo's envelope then states its operation's own risk and idempotency. */
  operations?: OperationContracts;
  /** The runtime's fallback time zone (`RuntimeOptions.defaultTimezone`). */
  defaultTimezone?: string;
  /** A reader for other languages (`RuntimeOptions.normalise`). */
  normalise?: RuntimeOptions["normalise"];
  /** The host's file store (`RuntimeOptions.blobs`; `memoryBlobHost()` for tests). */
  blobs?: BlobHost;
  /**
   * Seeds the runtime's random bytes (`seededRandomBytes`), so two harnesses
   * given the same seed and the same calls record byte-identical events,
   * states and confirm digests. Absent: real random bytes, as in production.
   */
  seed?: string;
}

export function createHarness<S extends RunStore = MemoryRunStore>(options: HarnessOptions<S> = {}): Harness<S> {
  const clock = options.clock ?? testClock();
  const store = (options.store ?? createMemoryStore()) as S;
  const catalog = createMemoryCatalog({ clock });
  const actions = fakeActions({ ...options.handlers, ...options.actions });
  const scope = testScope();
  const traces: TraceRecord[] = [];
  const turns: TurnRecord[] = [];
  const picks: PickRecord[] = [];
  const errors: Array<{ error: unknown; where: string }> = [];
  const laneRecords: LaneRecord[] = [];
  const policy = options.policy;
  for (const flow of options.flows ?? []) catalog.publish(scope, flow);
  const runtime = createFlowRuntime({
    catalog,
    store,
    actions,
    keys: testKeys,
    ...(options.envelopes === null ? {} : { envelopes: options.envelopes ?? testEnvelopes }),
    ...(options.operations ? { operations: options.operations } : {}),
    ...(options.defaultTimezone !== undefined ? { defaultTimezone: options.defaultTimezone } : {}),
    ...(options.normalise !== undefined ? { normalise: options.normalise } : {}),
    clock,
    ids: sequentialIds("x"),
    ...(options.decide ? { decide: options.decide } : {}),
    ...(policy !== undefined ? { policy: typeof policy === "function" ? policy : () => policy } : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    observer: {
      trace: (t) => {
        traces.push(t);
        options.observer?.trace?.(t);
      },
      error: (error, where) => {
        errors.push({ error, where });
        options.observer?.error?.(error, where);
      },
      lane: (record) => {
        laneRecords.push(record);
        options.observer?.lane?.(record);
      },
      turn: (record) => {
        turns.push(record);
        options.observer?.turn?.(record);
      },
      pick: (record) => {
        picks.push(record);
        options.observer?.pick?.(record);
      },
      contract: (record) => options.observer?.contract?.(record),
    },
    workerId: "test-worker",
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.lanes ? { lanes: options.lanes } : {}),
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(options.seed !== undefined ? { randomBytes: seededRandomBytes(options.seed) } : {}),
  });
  const harness: Harness<S> = {
    runtime,
    store,
    catalog,
    clock,
    actions,
    traces,
    turns,
    picks,
    errors,
    laneRecords,
    scope,
    ctx: (overrides = {}) => testContext({ scope, ...overrides }),
    async drain(maxPasses = 50) {
      let total = 0;
      for (let i = 0; i < maxPasses; i++) {
        const { actions: a, timers } = await runtime.work();
        total += a + timers;
        if (a + timers === 0) return total;
      }
      throw new Error("drain did not settle");
    },
    async advance(ms) {
      clock.advance(ms);
      await harness.drain();
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Fake deciders
// ---------------------------------------------------------------------------

/**
 * A calibration for tests of `auto`, sealed with its digest: the thresholds
 * (default the policy defaults) and, when given, the stages it binds. Its
 * `report` names no real report, so `verifyCalibration` refuses it; a host
 * gets a calibration only from a passing holdout report.
 */
export function testCalibration(thresholds: DecisionThresholds = DEFAULT_THRESHOLDS, stages?: CalibratedStage[]): Calibration {
  return sealCalibration({ report: "0".repeat(64), thresholds: { ...thresholds }, mode: "auto", ...(stages ? { stages } : {}) });
}

/** A decision port that answers from a script, and keeps every request it was sent. */
export interface ScriptedDecider extends DecisionPort {
  readonly requests: DecisionRequest[];
  /** The abort signals it was given, in order. */
  readonly signals: AbortSignal[];
}

/**
 * A decision port answering from `script` (a proposal, an answer with a
 * trace, or anything malformed, to test the parser). A script that returns
 * a promise that never settles is a decider that hangs.
 */
export function scriptedDecider(script: (request: DecisionRequest) => DecisionProposal | DecisionAnswer | unknown | Promise<unknown>): ScriptedDecider {
  const requests: DecisionRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    requests,
    signals,
    async decide(_ctx, request, options) {
      requests.push(structuredClone(request));
      if (options?.signal) signals.push(options.signal);
      return (await script(request)) as DecisionProposal;
    },
  };
}

/** A classifier function from a script, keeping every input it was given. */
export interface FakeClassifier extends ClassifyFn {
  readonly calls: Array<Omit<ClassifyInput, "signal">>;
}

/**
 * A classifier for `classifierStage`: `script` gets the text and the labels
 * and returns the raw answer (normally `{ ranked: [{ id, p }] }`, but
 * anything, so a test can send what a broken adapter would). A table maps
 * exact texts to rankings; other texts rank `no_match` at 1.
 */
export function fakeClassifier(script: Record<string, Array<{ id: string; p: number }>> | ((input: Omit<ClassifyInput, "signal">) => unknown | Promise<unknown>)): FakeClassifier {
  const calls: Array<Omit<ClassifyInput, "signal">> = [];
  const fn = async (input: ClassifyInput): Promise<ClassifierResult> => {
    const seen = { text: input.text, locale: input.locale, labels: input.labels.map((l) => ({ ...l })) };
    calls.push(seen);
    // Typed as a result, but passed on as the script gave it: the stage checks the shape at run time.
    if (typeof script === "function") return (await script(seen)) as ClassifierResult;
    return { ranked: script[input.text] ?? [{ id: "no_match", p: 1 }] };
  };
  return Object.assign(fn, { calls });
}

/** A completion function from a script, keeping every input it was given. */
export interface FakeComplete extends CompleteFn {
  readonly calls: Array<Omit<CompleteInput, "signal">>;
}

/**
 * A completion for `llmStage`: `script` gets the parsed request (the JSON the
 * stage sends) and returns the model's output (an object, or a string of
 * JSON, or anything malformed).
 */
export function fakeComplete(script: (request: Record<string, unknown>, input: Omit<CompleteInput, "signal">) => unknown | Promise<unknown>): FakeComplete {
  const calls: Array<Omit<CompleteInput, "signal">> = [];
  const fn = async (input: CompleteInput): Promise<{ output: unknown; usage?: { input: number; output: number; model: string } }> => {
    const seen = { instructions: input.instructions, input: input.input, schema: input.schema };
    calls.push(seen);
    const output = await script(JSON.parse(input.input) as Record<string, unknown>, seen);
    return { output, usage: { input: input.input.length, output: 1, model: "fake" } };
  };
  return Object.assign(fn, { calls });
}
