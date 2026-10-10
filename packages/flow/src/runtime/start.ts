/**
 * Starting runs and submitting to them: the inputs a caller gives a run
 * directly, checked, vouched for and applied.
 */

import { isItemId } from "../address.js";
import { FLOW_ID_RE, VERSION_RE, type CompiledFlow } from "../compile.js";
import { step } from "../core.js";
import { toBase64Url, fingerprint } from "../hash.js";
import { type JsonValue, isJsonObject, canonicalJson } from "../json.js";
import type { ResolvedPolicy } from "../policy.js";
import type { Why } from "../routing.js";
import type { TrustedContext } from "../ports.js";
import type { WorkspaceState } from "../store.js";
import { type ZoneSource, type ItemOp, type FlowEvent, EVENT_VERSION, CORE_VERSION, type AcceptEntry, type UndoRequest } from "../state.js";
import { resolveZone } from "../assist/zone.js";
import { FlowError } from "../errors.js";
import { RuntimeContext, DIGEST_RE, MAX_EPOCH } from "./context.js";
import { admit, checkInput, checkItems } from "./admission.js";
import { refuseRevoked, beforePerson, afterPerson } from "./migrate.js";
import { takeFor, applyWithdrawing, cancelTree } from "./calls.js";
import { runInline } from "./work.js";
import { newChain, batchFor, canInline, trace } from "./apply.js";
import { loadWorkspace, parkActive } from "./workspace.js";
import { nestedView, loadFor, respondTree, flowFor } from "./views.js";
import { type RunResponse, type SubmitInput } from "../runtime.js";
import { checkContext, checkId, subjectOf, fillCapOf, itemMarks, actorRef, requestKey, pause, withBusy } from "./helpers.js";
import { policyFor } from "./turns.js";

/** A new run's nonce: 16 bytes from `randomBytes`, base64url. */
export function newNonce(rt: RuntimeContext): string {
  const bytes = new Uint8Array(16);
  rt.randomBytes(bytes);
  return toBase64Url(bytes);
}

/** The zone for a new run or a turn with no run: the caller's, the app's, the engine's, then UTC (ADR 0012). */
export function zoneFor(rt: RuntimeContext, ctx: TrustedContext, policy: ResolvedPolicy): { timezone: string; source: ZoneSource } {
  return resolveZone({ context: ctx.timezone, app: policy.timezone, engine: rt.defaultTimezone });
}

// --- people ------------------------------------------------------------------

export async function start(rt: RuntimeContext, ctx: TrustedContext, input: { flowId: string; version?: string; facts?: Record<string, JsonValue>; workspaceId?: string }): Promise<RunResponse> {
  const started = await startRun(rt, ctx, input, "entry");
  if (!started) throw new FlowError("conflict", "Something changed meanwhile. Please try again.");
  return started;
}

/**
 * Starts a run, in a workspace when `workspaceId` is given. The run id is
 * keyed on the caller, the person, the flow and the request id, so a
 * retried start finds the run its first try made, with any store (a second
 * create of one id conflicts). Returns null, storing nothing, when `expect`
 * rejects the workspace, or when a retry after a workspace conflict finds
 * the active run or the open question changed. The commit clears an open
 * question or offer. `why` is the turn that asked for the start, if any.
 */
export async function startRun(rt: RuntimeContext, ctx: TrustedContext, input: { flowId: string; version?: string; facts?: Record<string, JsonValue>; items?: ItemOp[]; workspaceId?: string }, source: "entry" | "model", expect?: (ws: WorkspaceState) => boolean, why?: Why): Promise<RunResponse | null> {
  checkContext(ctx);
  if (typeof input.flowId !== "string" || !FLOW_ID_RE.test(input.flowId)) throw new FlowError("not_found", "No such flow.");
  if (input.version !== undefined && (typeof input.version !== "string" || !VERSION_RE.test(input.version))) throw new FlowError("not_found", "No such flow.");
  if (input.workspaceId !== undefined) checkId(input.workspaceId);
  await admit(rt, ctx, "start", input.flowId);
  const facts = input.facts ?? {};
  if (!isJsonObject(facts)) throw new FlowError("invalid", "facts must be an object.");
  checkInput(rt, facts);
  const items = input.items === undefined ? undefined : checkItems(rt, input.items);
  const flow = await startable(rt, ctx, input.flowId, input.version);
  const runId = startId(rt, ctx, flow.id);
  const earlier = await startedBefore(rt, ctx, runId, flow.id);
  if (earlier) return earlier;
  await refuseRevoked(rt, ctx.scope, flow);
  await rt.vouch(ctx, input, { via: "start", runId, flowId: flow.id });
  const subject = subjectOf(ctx);
  const nonce = newNonce(rt);
  const policy = await policyFor(rt, ctx);
  const zone = zoneFor(rt, ctx, policy);
  // 0.3: a model's start facts are marked, as a turn's are (ADR 0012): only stated values reach a
  // start, each with the tenant's cap on assisted fills (an uncalibrated policy caps at confirm).
  const cap = fillCapOf(policy);
  const marks =
    source === "model" && Object.keys(facts).length + (items?.length ?? 0) > 0
      ? { ...Object.fromEntries(Object.keys(facts).map((k) => [k, { basis: "stated" as const, ...(cap !== undefined ? { cap } : {}) }])), ...itemMarks(items, cap) }
      : undefined;
  let relied: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const at = rt.clock.now();
    const event: FlowEvent = {
      v: EVENT_VERSION,
      type: "run.started",
      id: rt.ids.newId(),
      at,
      actor: actorRef(ctx),
      requestId: requestKey(ctx),
      runId,
      flowId: flow.id,
      flowVersion: flow.version,
      flowHash: flow.hash,
      scope: { ...ctx.scope },
      subject: subject === null ? null : { id: subject },
      env: { locale: ctx.locale, timezone: zone.timezone, environment: ctx.environmentKind, ...(zone.source !== "context" ? { timezoneSource: zone.source } : {}) },
      facts,
      source,
      nonce,
      core: CORE_VERSION,
      ...(items !== undefined ? { items } : {}),
      ...(marks !== undefined ? { marks } : {}),
    };
    rt.requests.stamp(event, ctx);
    const result = step(flow, null, event);
    if (!result.accepted) throw new FlowError("invalid", result.rejection.message);
    const chain = newChain(rt);
    const { batch, inlineItems } = batchFor(rt, ctx.scope, 0, result.state, event, result.effects, {}, canInline(rt, chain));
    if (input.workspaceId !== undefined) {
      const ws = await loadWorkspace(rt, ctx, input.workspaceId);
      // Go ahead only while the workspace is as the caller saw it.
      const seen = focusOf(ws);
      if ((expect && !expect(ws)) || (relied !== undefined && relied !== seen)) return null;
      relied = seen;
      const expectedRevision = ws.revision;
      await parkActive(rt, ctx.scope, ws);
      ws.active = runId;
      ws.pending = null;
      ws.offer = null;
      ws.revision += 1;
      ws.updatedAt = at;
      batch.workspace = { state: ws, expectedRevision };
    }
    const committed = await rt.store.commit(batch);
    if (!committed.ok) {
      if (committed.conflict === "run") {
        // A concurrent try of this same request got there first.
        const raced = await startedBefore(rt, ctx, runId, flow.id);
        if (raced) return raced;
      } else if (attempt < rt.limits.conflictRetries) {
        await pause(attempt);
        continue;
      }
      throw new FlowError("conflict", "Please try again.");
    }
    trace(rt, null, result.state, flow, event, result, at, why);
    const latest = inlineItems.length > 0 ? await runInline(rt, ctx.scope, result.state, flow, inlineItems, chain) : null;
    const state = latest?.state ?? result.state;
    // A flow that calls another at once shows the child nested.
    return { runId, view: withBusy(await nestedView(rt, ctx, state, flow, 0), chain), accepted: true, notices: result.notices };
  }
}

export async function submit(rt: RuntimeContext, ctx: TrustedContext, runId: string, input: SubmitInput): Promise<RunResponse> {
  return submitAs(rt, ctx, runId, input);
}

/** `submit`, for a turn: `why` says which turn the input came from. */
export async function submitAs(rt: RuntimeContext, ctx: TrustedContext, runId: string, input: SubmitInput, why?: Why): Promise<RunResponse> {
  checkContext(ctx);
  checkId(runId);
  await admit(rt, ctx, "submit");
  const actor = actorRef(ctx);
  const requestId = requestKey(ctx);
  let make: (at: number) => FlowEvent;
  switch (input?.kind) {
    case "output": {
      checkId(input.stepId);
      checkId(input.name);
      if (input.digest !== undefined && (typeof input.digest !== "string" || !DIGEST_RE.test(input.digest))) throw new FlowError("invalid", "Bad digest.");
      if (input.epoch !== undefined && (typeof input.epoch !== "number" || !Number.isInteger(input.epoch) || input.epoch < 0 || input.epoch > MAX_EPOCH)) throw new FlowError("invalid", "Bad epoch.");
      const payload = input.payload ?? null;
      checkInput(rt, payload);
      if (input.item !== undefined && !isItemId(input.item)) throw new FlowError("invalid", "Bad item.");
      await rt.vouch(ctx, input, { via: "submit", runId }, () => loadFor(rt, ctx, runId));
      make = (at) => ({
        v: EVENT_VERSION,
        type: "output",
        id: rt.ids.newId(),
        at,
        actor,
        requestId,
        stepId: input.stepId,
        name: input.name,
        payload,
        ...(input.digest !== undefined ? { digest: input.digest } : {}),
        ...(input.item !== undefined ? { item: input.item } : {}),
        ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
      });
      break;
    }
    case "facts": {
      const facts = input.facts ?? {};
      if (!isJsonObject(facts)) throw new FlowError("invalid", "facts must be an object.");
      checkInput(rt, facts);
      const items = input.items === undefined ? undefined : checkItems(rt, input.items);
      await rt.vouch(ctx, input, { via: "submit", runId }, () => loadFor(rt, ctx, runId));
      const names = (list: unknown): string[] | undefined => {
        if (list === undefined) return undefined;
        if (!Array.isArray(list) || list.length > 100 || !list.every((n) => typeof n === "string" && n.length > 0 && n.length <= 64)) throw new FlowError("invalid", "accept and dismiss list fact names.");
        return [...list] as string[];
      };
      const accept = acceptInput(input.accept);
      const dismiss = names(input.dismiss);
      const undo = undoInput(input.undo, names);
      const answers = { ...(accept ? { accept } : {}), ...(dismiss ? { dismiss } : {}), ...(undo !== undefined ? { undo } : {}) };
      make = (at) => ({ v: EVENT_VERSION, type: "facts.input", id: rt.ids.newId(), at, actor, requestId, facts, source: "user", ...(items !== undefined ? { items } : {}), ...answers });
      break;
    }
    case "cancel":
      make = (at) => ({
        v: EVENT_VERSION,
        type: "run.cancelled",
        id: rt.ids.newId(),
        at,
        actor,
        requestId,
        ...(typeof input.reason === "string" ? { reason: input.reason.slice(0, 200) } : {}),
      });
      break;
    case "resume":
      make = (at) => ({ v: EVENT_VERSION, type: "run.resumed", id: rt.ids.newId(), at, actor, requestId });
      break;
    default:
      throw new FlowError("invalid", "Unknown input.");
  }
  // A cancel always goes ahead, under the version the run is on: it starts nothing new, and on a
  // revoked version it is what lets go of a hold only that version can release.
  const refused = input.kind === "cancel" ? null : await beforePerson(rt, ctx, runId);
  if (refused) return refused;
  // What nobody has sent is taken back in the cancel's own commit, so it neither blocks the cancel nor goes out after it.
  const taken = input.kind === "cancel" ? await takeFor(rt, ctx, runId) : [];
  const chain = newChain(rt);
  const applied = await applyWithdrawing(rt, ctx.scope, runId, taken, { build: () => make(rt.clock.now()), access: { ctx }, chain, ...(why ? { why } : {}) });
  // A run waiting for a child: the cancellation goes to the deepest run and travels up from there.
  if (input.kind === "cancel" && applied.result && !applied.result.accepted && applied.result.rejection.code === "flow/call-running") {
    const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : "cancelled";
    const refusedTree = await cancelTree(rt, ctx.scope, runId, actorRef(ctx), reason, newChain(rt), why);
    const after = await loadFor(rt, ctx, runId);
    return respondTree(rt, ctx, runId, { ...after, result: null }, refusedTree);
  }
  return respondTree(rt, ctx, runId, await afterPerson(rt, ctx.scope, applied), null, chain);
}

/**
 * The version to start. Start roles are checked on the current version and
 * on the version asked for, so naming an older version never widens who may
 * start. A flow the caller may not start looks the same as a missing one.
 */
export async function startable(rt: RuntimeContext, ctx: TrustedContext, flowId: string, version: string | undefined): Promise<CompiledFlow> {
  const current = await rt.catalog.get(ctx.scope, flowId);
  const flow = version === undefined || version === current?.version ? current : await rt.catalog.get(ctx.scope, flowId, version);
  const may = (f: CompiledFlow | null) => f === null || f.startRoles.length === 0 || ctx.appRoles.some((r) => f.startRoles.includes(r));
  // A flow only another flow may start looks like a missing one.
  const callable = (f: CompiledFlow | null) => f?.interface?.callableOnly === true;
  if (!flow || !may(flow) || !may(current) || callable(flow) || callable(current)) throw new FlowError("not_found", "No such flow.");
  return flow;
}

/** Run ids for starts: keyed (so they reveal nothing) on the request and who made it. */
export function startId(rt: RuntimeContext, ctx: TrustedContext, flowId: string): string {
  const key = rt.keys.idempotencyKey({ scope: ctx.scope, action: "flow.start", effectId: canonicalJson([requestKey(ctx), subjectOf(ctx), flowId]) });
  return `run-${fingerprint(key)}`;
}

/** The run an earlier try of this same start request made, if any. */
export async function startedBefore(rt: RuntimeContext, ctx: TrustedContext, runId: string, flowId: string): Promise<RunResponse | null> {
  const state = await rt.store.loadRun(ctx.scope, runId);
  if (!state) return null;
  if (state.flowId !== flowId || (state.subject?.id ?? null) !== subjectOf(ctx)) throw new FlowError("conflict", "This request id was already used.");
  const flow = await flowFor(rt, ctx.scope, state);
  return { runId, view: await nestedView(rt, ctx, state, flow, 0), accepted: true, notices: [] };
}

/** A submitted `accept`: fact names, or `{fact, turn?}` naming the assistant's turn the person saw. */
export function acceptInput(list: unknown): AcceptEntry[] | undefined {
  if (list === undefined) return undefined;
  const name = (n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= 64;
  if (!Array.isArray(list) || list.length > 100) throw new FlowError("invalid", "accept lists at most 100 facts.");
  return list.map((entry: unknown): AcceptEntry => {
    if (name(entry)) return entry;
    if (isJsonObject(entry as JsonValue) && Object.keys(entry as object).every((k) => k === "fact" || k === "turn")) {
      const { fact, turn } = entry as { fact?: unknown; turn?: unknown };
      if (name(fact) && (turn === undefined || (typeof turn === "string" && turn.length > 0 && turn.length <= 128))) return turn === undefined ? { fact } : { fact, turn };
    }
    throw new FlowError("invalid", "accept lists fact names, or {fact, turn}.");
  });
}

/** A submitted `undo`: `{turn, facts?}`. */
export function undoInput(raw: unknown, names: (list: unknown) => string[] | undefined): UndoRequest | undefined {
  if (raw === undefined) return undefined;
  if (!isJsonObject(raw as JsonValue) || !Object.keys(raw as object).every((k) => k === "turn" || k === "facts")) throw new FlowError("invalid", "undo is {turn, facts?}.");
  const { turn, facts } = raw as { turn?: unknown; facts?: unknown };
  if (typeof turn !== "string") throw new FlowError("invalid", "undo names the assistant's turn.");
  checkId(turn);
  const only = names(facts);
  return only !== undefined ? { turn, facts: only } : { turn };
}

/** What a workspace change relies on: the run in front of the person and the open question. */
export function focusOf(ws: WorkspaceState): string {
  return canonicalJson([ws.active, ws.pending as unknown as JsonValue, ws.offer?.id ?? null]);
}
