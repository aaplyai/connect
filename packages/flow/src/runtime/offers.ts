/**
 * Offers and replies within a turn: picking an option of an offer, opening
 * or resuming a goal, asking to switch, and the reply and record each turn
 * ends with.
 */

import type { CompiledFlow } from "../compile.js";
import type { SuggestOption } from "../decision.js";
import { type JsonValue, own } from "../json.js";
import { type ResolvedPolicy, policyText } from "../policy.js";
import { type ReplyKind, type ReplyContent, type ReplyOption, type Reply, bareEnv, evaluateReplyInput } from "../reply.js";
import { turnIdOf, offerOptions, type Why, offerFacts, buildOfferOptions, offerIdOf } from "../routing.js";
import type { TrustedContext, TurnOutcome, TurnRecord, Observer } from "../ports.js";
import { RunReader } from "../reader.js";
import type { PendingOffer, PendingConsent, WorkspaceState } from "../store.js";
import { isTerminal, type ItemOp } from "../state.js";
import { type ProposalMeta, type ResolvedProposal, resolveProposal } from "../assist/resolve.js";
import { FlowError } from "../errors.js";
import { RuntimeContext, type Turn, type Goal, type Loaded } from "./context.js";
import { loadWorkspace, activeRun, workspace, workspaceView, saveWorkspace, parkActive, workspaceAfter, updateWorkspace } from "./workspace.js";
import { leafOf, tryLoadFor } from "./views.js";
import { startRun, zoneFor } from "./start.js";
import { type TurnResponse, type RunResponse, type WorkspaceView } from "../runtime.js";
import { requestKey, isNotFound, busyFor } from "./helpers.js";
import { resume } from "./turns.js";

export async function pickInTurn(rt: RuntimeContext, t: Turn, offer: PendingOffer, option: string | null): Promise<TurnResponse> {
  t.record.basis = "pick";
  const response = await pick(rt, t.ctx, t.workspaceId, offer.id, option, t.policy, t);
  return { ...response, turnId: t.turnId };
}

/**
 * Acts on a pick from the open offer, compare-and-clear: only the call that
 * takes this exact offer acts on it. A resume option resumes; with a live
 * run in front of the person the pick becomes a question (consent); a flow
 * that is no longer published answers `flow/offer-unavailable`.
 */
export async function pick(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, offerId: string, option: string | null, policy: ResolvedPolicy, t?: Turn): Promise<TurnResponse> {
  const ws = await loadWorkspace(rt, ctx, workspaceId);
  const now = rt.clock.now();
  const offer = ws.offer ?? null;
  const root = await activeRun(rt, ctx, ws);
  // Replies use the leaf's flow (what the person is looking at); a switch sets the root aside.
  const at = { ctx, policy, active: root ? await leafOf(rt, ctx, root) : null };
  const key = `reply:${turnIdOf(ctx.scope, requestKey(ctx), workspaceId)}`;
  const done = (outcome: TurnOutcome, chosen?: TurnRecord["chosen"], reason?: string) => {
    if (!t) return;
    setOutcome(t, outcome, chosen);
    if (reason !== undefined) t.record.reason = reason;
  };
  const gone = async (reason: string): Promise<TurnResponse> => {
    done("clarify", { offerId }, reason);
    const question = policyText(policy, "offerGone");
    return { kind: "clarify", question, workspace: await workspace(rt, ctx, workspaceId), reply: replyFor(rt, at, "clarify", question, key, { reason }) };
  };
  if (!offer || offer.id !== offerId) return gone("flow/offer-stale");
  if (offer.expiresAt <= now) {
    await takeOffer(rt, ctx, workspaceId, offerId);
    return gone("flow/offer-expired");
  }
  const picked = (flowId: string | null, position: number | null) =>
    emitPick(rt, { scope: { ...ctx.scope }, turnId: offer.turnId, offerId, at: now, picked: flowId, position });
  if (option === null) {
    const cleared = await takeOffer(rt, ctx, workspaceId, offerId);
    if (!cleared) return gone("flow/offer-stale");
    picked(null, null);
    done("unchanged", { offerId });
    return { kind: "run", workspace: await workspaceView(rt, ctx, cleared, workspaceId), accepted: true, notices: [] };
  }
  const index = offer.options.findIndex((o) => o.id === option);
  const chosen = offer.options[index];
  if (!chosen) {
    done("clarify", { offerId }, "flow/offer-unknown-option");
    const question = policyText(policy, "pickOne");
    return {
      kind: "clarify",
      question,
      workspace: await workspaceView(rt, ctx, ws, workspaceId),
      reply: replyFor(rt, at, "clarify", question, key, { reason: "flow/offer-unknown-option", options: offerOptions(offer) }),
    };
  }
  const why: Why = { basis: "pick", turnId: offer.turnId };
  const facts = chosen.facts;
  const conflictIsStale = async (work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return false;
    } catch (error) {
      if (error instanceof FlowError && error.code === "conflict") return true;
      throw error;
    }
  };
  if (chosen.runId !== undefined) {
    const runId = chosen.runId;
    const loaded = ws.parked.includes(runId) ? await tryLoadFor(rt, ctx, runId) : null;
    if (!loaded || isTerminal(loaded.state.status)) {
      await takeOffer(rt, ctx, workspaceId, offerId);
      return gone("flow/offer-unavailable");
    }
    const stale = await conflictIsStale(() =>
      saveWorkspace(rt, ctx.scope, ws, async (w) => {
        w.offer = null;
        w.parked = w.parked.filter((id) => id !== runId);
        await parkActive(rt, ctx.scope, w);
        w.active = runId;
        w.pending = null;
      }),
    );
    if (stale) return gone("flow/offer-stale");
    picked(chosen.flowId, index + 1);
    done("resumed", { flowId: chosen.flowId, runId, offerId });
    return { kind: "run", workspace: await workspaceView(rt, ctx, ws, workspaceId), accepted: true, notices: [] };
  }
  if (root && isOpen(root, at.active, chosen.flowId)) {
    const cleared = await takeOffer(rt, ctx, workspaceId, offerId);
    if (!cleared) return gone("flow/offer-stale");
    picked(chosen.flowId, index + 1);
    done("unchanged", { flowId: chosen.flowId, offerId });
    return { kind: "run", workspace: await workspaceView(rt, ctx, cleared, workspaceId), accepted: true, notices: [] };
  }
  if (root) {
    // Setting the active run aside is the person's second answer, as for any switch. The question
    // is asked by the turn the person picked in, or (`choose`) rests on the turn that made the offer.
    const askedBy = t?.turnId ?? offer.turnId;
    const stale = await conflictIsStale(() =>
      saveWorkspace(rt, ctx.scope, ws, (w) => {
        w.offer = null;
        w.pending = { kind: "switch", flowId: chosen.flowId, ...(facts ? { facts } : {}), askedAt: now, basis: "pick", turnId: askedBy };
      }),
    );
    if (stale) return gone("flow/offer-stale");
    picked(chosen.flowId, index + 1);
    done("consent", { flowId: chosen.flowId, offerId });
    const question = policyText(policy, "switch", { from: root.flow.definition.title, to: chosen.title });
    return { kind: "consent", question, workspace: await workspaceView(rt, ctx, ws, workspaceId), turnId: askedBy, reply: replyFor(rt, at, "consent", question, `reply:${askedBy}`) };
  }
  let started: RunResponse | null;
  try {
    started = await startRun(rt, ctx, { flowId: chosen.flowId, ...(facts ? { facts } : {}), workspaceId }, facts ? "model" : "entry", (w) => w.offer?.id === offerId, why);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await takeOffer(rt, ctx, workspaceId, offerId);
    return gone("flow/offer-unavailable");
  }
  if (!started) return gone("flow/offer-stale");
  picked(chosen.flowId, index + 1);
  done("opened", { flowId: chosen.flowId, runId: started.runId, offerId });
  return { kind: "run", workspace: await workspaceAfter(rt, ctx, workspaceId, busyFor(started)), accepted: true, notices: [] };
}

/** An exact name or an `open` output: the run in front of the person, a parked run, a question, or a start. */
export async function openGoal(rt: RuntimeContext, t: Turn, goal: Goal): Promise<TurnResponse> {
  const { ctx, workspaceId, root, active } = t;
  if (root && isOpen(root, active, goal.flowId)) {
    await clearOffer(rt, t);
    setOutcome(t, "unchanged", { flowId: goal.flowId, runId: root.state.runId });
    return { kind: "run", workspace: await turnView(rt, t), accepted: true, notices: [], turnId: t.turnId };
  }
  const parked = (await parkedOf(rt, t)).find((p) => p.flowId === goal.flowId);
  if (parked) return resumeInTurn(rt, t, parked.runId, { flowId: goal.flowId, runId: parked.runId });
  if (root) return askSwitch(rt, t, goal, undefined, "exact");
  const started = await startRun(rt, ctx, { flowId: goal.flowId, workspaceId }, "entry", (w) => w.active === t.ws.active, { basis: "exact", turnId: t.turnId });
  if (!started) return clarifyTurn(rt, t, policyText(t.policy, "changed"));
  setOutcome(t, "opened", { flowId: goal.flowId, runId: started.runId });
  return { kind: "run", workspace: await workspaceAfter(rt, ctx, workspaceId, busyFor(started)), accepted: true, notices: [], turnId: t.turnId };
}

/** Resumes a parked run for a turn. One that left the workspace meanwhile means the person is asked again. */
export async function resumeInTurn(rt: RuntimeContext, t: Turn, runId: string, chosen: TurnRecord["chosen"]): Promise<TurnResponse> {
  let workspace: WorkspaceView;
  try {
    workspace = await resume(rt, t.ctx, t.workspaceId, runId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return clarifyTurn(rt, t, policyText(t.policy, "changed"));
  }
  setOutcome(t, "resumed", chosen);
  return { kind: "run", workspace, accepted: true, notices: [], turnId: t.turnId };
}

/**
 * A model's facts for a run it would start (ADR 0012): those the flow may
 * take (`offerFacts`), normalised in the zone that run will get and judged
 * by `meta` as a `continue`'s are. Only stated values start a run; an
 * inferred one is left out, as is one that could not be used.
 */
export function startFacts(rt: RuntimeContext, t: Turn, target: CompiledFlow | null, text: string, given: Record<string, JsonValue> | undefined, meta: Record<string, ProposalMeta> | undefined): { facts: Record<string, JsonValue> | undefined; normal: ResolvedProposal | null } {
  const offered = offerFacts(target, given);
  if (!offered || !target) return { facts: offered, normal: null };
  const zone = zoneFor(rt, t.ctx, t.policy);
  const normal = resolveProposal(target, text, offered, meta, { now: t.now, timezone: zone.timezone, zoneSource: zone.source, locale: t.ctx.locale, ...rt.normaliser });
  const stated = Object.fromEntries(Object.entries(normal.facts).filter(([name]) => own(normal.marks, name)?.basis === "stated"));
  return { facts: Object.keys(stated).length > 0 ? stated : undefined, normal };
}

/** Asks before setting the active run aside for another flow. */
export async function askSwitch(rt: RuntimeContext, t: Turn, goal: Goal, facts: Record<string, JsonValue> | undefined, basis: "exact" | "model", items?: ItemOp[]): Promise<TurnResponse> {
  const { ctx, workspaceId, policy, root } = t;
  const saved = await askInTurn(rt, t, { kind: "switch", flowId: goal.flowId, ...(facts ? { facts } : {}), ...(items ? { items } : {}), askedAt: rt.clock.now(), basis, turnId: t.turnId });
  if (!saved) return clarifyTurn(rt, t, policyText(policy, "changed"));
  const question = policyText(policy, "switch", { from: root?.flow.definition.title ?? "", to: goal.title });
  setOutcome(t, "consent", { flowId: goal.flowId });
  return { kind: "consent", question, workspace: await workspaceView(rt, ctx, saved, workspaceId), turnId: t.turnId, reply: replyFor(rt, t, "consent", question, `reply:${t.turnId}`) };
}

/**
 * Stores a turn's yes-or-no question against the latest workspace, retried
 * on a concurrent change, while the run the turn found is still the one in
 * front of the person. Null when it is not (the person is asked again).
 */
export async function askInTurn(rt: RuntimeContext, t: Turn, pending: PendingConsent): Promise<WorkspaceState | null> {
  const saved = await updateWorkspace(rt, t.ctx, t.workspaceId, (w) => {
    if (w.active !== t.ws.active) return false;
    w.pending = pending;
    w.offer = null;
    return true;
  });
  t.touched = true;
  return saved;
}

/**
 * Stores an offer of the suggested flows that survive the policy floor:
 * goals of this request, each once, not the active flow, at most
 * `maxOptions`; a parked flow becomes a resume option. None left: a
 * clarifying question. The later of two concurrent offers wins.
 */
export async function offerTurn(rt: RuntimeContext, t: Turn, proposed: readonly SuggestOption[], goals: Goal[], parked: Array<{ runId: string; flowId: string }>, question?: string, reason?: string, resolve = false, text = ""): Promise<TurnResponse> {
  const { ctx, policy } = t;
  // 0.3: a model's option facts are normalised and judged as a switch's are, at the turn that heard them (ADR 0012).
  const suggested: SuggestOption[] = [];
  for (const option of proposed) {
    if (!resolve || !option.facts) {
      suggested.push(option);
      continue;
    }
    const { meta: _meta, facts: given, ...rest } = option;
    const flow = await rt.catalog.get(ctx.scope, option.flowId).catch(() => null);
    const { facts } = startFacts(rt, t, flow, text, given, option.meta);
    suggested.push({ ...rest, ...(facts ? { facts } : {}) });
  }
  // Neither the flow in front of the person (the leaf) nor the run it belongs to (the root) is offered.
  const offerable = goals.filter((g) => g.flowId !== t.root?.flow.id);
  const options = buildOfferOptions({ options: suggested, goals: offerable, activeFlowId: t.active?.flow.id, parked, max: Math.min(policy.maxOptions, rt.limits.maxOptionsCap) });
  if (options.length === 0) return clarifyTurn(rt, t, policyText(policy, "whatNext"));
  for (const option of options) {
    if (!option.facts) continue;
    const flow = await rt.catalog.get(ctx.scope, option.flowId).catch(() => null);
    const facts = offerFacts(flow, option.facts);
    if (facts) option.facts = facts;
    else delete option.facts;
  }
  return storeOffer(rt, t, options, question, reason);
}

/** Stores an offer of `options` (already held to the policy floor) and answers with it. */
export async function storeOffer(rt: RuntimeContext, t: Turn, options: PendingOffer["options"], question?: string, reason?: string): Promise<TurnResponse> {
  const { ctx, policy, workspaceId } = t;
  const now = rt.clock.now();
  const offer: PendingOffer = { id: offerIdOf(t.turnId), turnId: t.turnId, askedAt: now, expiresAt: now + policy.offerTtlMs, options };
  const saved = await updateWorkspace(rt, ctx, workspaceId, (w) => {
    if (w.active !== t.ws.active) return false;
    w.pending = null;
    w.offer = offer;
    return true;
  });
  t.touched = true;
  if (!saved) return clarifyTurn(rt, t, policyText(policy, "changed"));
  const shown = offerOptions(offer);
  const text = question ?? (shown.length === 1 ? policyText(policy, "suggestOne", { flow: shown[0]!.title }) : policyText(policy, "suggest"));
  setOutcome(t, "offered", { offerId: offer.id });
  if (reason !== undefined) t.record.reason = reason;
  const reply = replyFor(rt, t, "suggest", text, `offer:${offer.id}`, { ...(reason !== undefined ? { reason } : {}), options: shown });
  return { kind: "suggest", question: text, offerId: offer.id, options: shown, workspace: await workspaceView(rt, ctx, saved, workspaceId), turnId: t.turnId, reply };
}

export async function clarifyTurn(rt: RuntimeContext, t: Turn, question: string, reason?: string): Promise<TurnResponse> {
  await clearOffer(rt, t);
  setOutcome(t, "clarify");
  if (reason !== undefined) t.record.reason = reason;
  const reply = replyFor(rt, t, "clarify", question, `reply:${t.turnId}`, reason !== undefined ? { reason } : {});
  return { kind: "clarify", question, workspace: await workspace(rt, t.ctx, t.workspaceId), turnId: t.turnId, reply };
}

/** Nothing published fits: an answer whose reply kind is `nomatch`. */
export async function nomatchTurn(rt: RuntimeContext, t: Turn, reason?: string): Promise<TurnResponse> {
  await clearOffer(rt, t);
  setOutcome(t, "nomatch");
  if (reason !== undefined) t.record.reason = reason;
  const text = policyText(t.policy, "nomatch");
  const reply = replyFor(rt, t, "nomatch", text, `reply:${t.turnId}`, reason !== undefined ? { reason } : {});
  return { kind: "answer", text, workspace: await workspace(rt, t.ctx, t.workspaceId), turnId: t.turnId, reply };
}

/**
 * A reply with its view: the active flow's for this kind, its default,
 * then the policy's for this kind, its default. A reply that asks the
 * person something (`consent`, `suggest`) skips the flow's default when the
 * policy has a view for its kind: a flow's catch-all never hides the
 * tenant's question or offer behind a section that may not answer it. A
 * flow's view may read the run's (non-secret) facts; a policy's reads only
 * the reply.
 */
export function replyFor(rt: RuntimeContext, at: { ctx: TrustedContext; policy: ResolvedPolicy; active: Loaded | null }, kind: ReplyKind, text: string, instanceKey: string, extra: { reason?: string; content?: ReplyContent; options?: ReplyOption[] } = {}): Reply {
  const reply: Reply = { kind, text, ...extra };
  const tenants = at.policy.replies.get(kind);
  const flowDefault = ASKING_REPLIES.has(kind) && tenants ? undefined : at.active?.flow.replies.get("default");
  const own = at.active ? (at.active.flow.replies.get(kind) ?? flowDefault) : undefined;
  const view = own ?? tenants ?? at.policy.replies.get("default");
  if (!view) return reply;
  try {
    const now = rt.clock.now();
    const env =
      own && at.active
        ? new RunReader(at.active.flow, at.active.state, now).env()
        : bareEnv({ locale: at.ctx.locale, timezone: zoneFor(rt, at.ctx, at.policy).timezone, environment: at.ctx.environmentKind }, now);
    reply.view = { section: view.section, input: evaluateReplyInput(view, reply, env), instanceKey };
  } catch (error) {
    rt.observer.error?.(error, "reply");
  }
  return reply;
}

/** Takes the open offer away, if it is still this one. */
export function takeOffer(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, offerId: string): Promise<WorkspaceState | null> {
  return updateWorkspace(rt, ctx, workspaceId, (w) => {
    if (w.offer?.id !== offerId) return false;
    w.offer = null;
    return true;
  });
}

/** Every turn clears the offer it found, unless the turn picked from it. */
export async function clearOffer(rt: RuntimeContext, t: Turn): Promise<void> {
  if (!t.offer) return;
  const offer = t.offer;
  t.offer = null;
  t.touched = true;
  await takeOffer(rt, t.ctx, t.workspaceId, offer.id);
}

/** The workspace at the end of a turn; `known` is a run the turn has just loaded or recorded, shown without loading it again. */
export async function turnView(rt: RuntimeContext, t: Turn, known?: Loaded): Promise<WorkspaceView> {
  return t.touched ? workspace(rt, t.ctx, t.workspaceId, known) : workspaceView(rt, t.ctx, t.ws, t.workspaceId, undefined, known);
}

export function setOutcome(t: Turn, outcome: TurnOutcome, chosen?: TurnRecord["chosen"]): void {
  t.record.outcome = outcome;
  if (chosen) t.record.chosen = { ...t.record.chosen, ...chosen };
}

export async function parkedOf(rt: RuntimeContext, t: Turn): Promise<Array<{ runId: string; flowId: string; title: string }>> {
  if (!t.parked) {
    const parked: Array<{ runId: string; flowId: string; title: string }> = [];
    for (const runId of t.ws.parked) {
      const loaded = await tryLoadFor(rt, t.ctx, runId);
      if (loaded && !isTerminal(loaded.state.status)) parked.push({ runId, flowId: loaded.flow.id, title: loaded.flow.definition.title });
    }
    t.parked = parked;
  }
  return t.parked;
}

export function emitTurn(rt: RuntimeContext, t: Turn): void {
  if (!rt.observer.turn) return;
  try {
    rt.observer.turn(t.record);
  } catch (error) {
    rt.observer.error?.(error, "turn");
  }
}

export function emitPick(rt: RuntimeContext, record: Parameters<NonNullable<Observer["pick"]>>[0]): void {
  if (!rt.observer.pick) return;
  try {
    rt.observer.pick(record);
  } catch (error) {
    rt.observer.error?.(error, "pick");
  }
}

/** Reply kinds that ask the person something; a flow's `default` view never stands in for the policy's view of one. */
export const ASKING_REPLIES: ReadonlySet<ReplyKind> = new Set<ReplyKind>(["consent", "suggest"]);

/** Whether `flowId` is already in front of the person: the active run's flow, or the leaf's it is calling. */
export function isOpen(root: Loaded, leaf: Loaded | null, flowId: string): boolean {
  return root.flow.id === flowId || leaf?.flow.id === flowId;
}
