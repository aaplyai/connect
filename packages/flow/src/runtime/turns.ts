/**
 * Turns: what a person says in a workspace, routed to the active run, a
 * question it asked, an offer, or the decision port; and the answer each
 * route gives back.
 */

import { FLOW_ID_RE, type CompiledFlow, type CompiledFact } from "../compile.js";
import { type DecisionGoal, type DecisionNeed, type DecisionRequest, type DecisionProposal, type StageTrace, parseDecision, type DecisionFact } from "../decision.js";
import { matchGoalName, matchOption, matchWord } from "../exact.js";
import { listGoals } from "../goals.js";
import { offeredItemOps, staleItems, startItems, decisionCollections } from "../decision-items.js";
import { own, canonicalJson, type JsonValue } from "../json.js";
import { policyText, stageCalibrated, type ResolvedPolicy, NO_POLICY, FAIL_CLOSED_POLICY, parseDecisionPolicy, resolvePolicy, type ShareValues } from "../policy.js";
import { filterReplyLinks } from "../reply.js";
import { turnIdOf, type Why, liveOffer, decisionUpdateOf, requestPolicyOf, staleFacts, scrubTraces } from "../routing.js";
import type { TrustedContext, TurnRecord } from "../ports.js";
import { RunReader } from "../reader.js";
import type { WorkspaceState, PendingConsent } from "../store.js";
import { isTerminal, type ZoneSource, EVENT_VERSION, type AcceptEntry, type RunState, type ActorRef } from "../state.js";
import { resolveProposal, type ResolvedProposal } from "../assist/resolve.js";
import { renderView } from "../view.js";
import { FlowError } from "../errors.js";
import { RuntimeContext, type Turn, type Goal, TIMED_OUT } from "./context.js";
import { admit, fitsInput } from "./admission.js";
import { beforePerson, moveBeforeTurn, maybeMigrate, revokedRefusal, afterPerson } from "./migrate.js";
import { newChain, apply } from "./apply.js";
import { loadWorkspace, workspaceView, activeRun, workspace, updateWorkspace, workspaceAfter, parkActive } from "./workspace.js";
import { leafOf, safeFacts, loadFor, respond } from "./views.js";
import { startRun, submitAs, zoneFor } from "./start.js";
import { emitTurn, replyFor, pick, openGoal, clarifyTurn, nomatchTurn, parkedOf, setOutcome, turnView, clearOffer, startFacts, askSwitch, offerTurn, storeOffer, resumeInTurn, askInTurn, pickInTurn } from "./offers.js";
import { type TurnInput, type TurnResponse, type WorkspaceView, type SubmitInput } from "../runtime.js";
import { checkContext, checkId, requestKey, busyFor, SHORT, actorRef, fillCapOf, itemMarks } from "./helpers.js";

export async function goals(rt: RuntimeContext, ctx: TrustedContext): Promise<DecisionGoal[]> {
  checkContext(ctx);
  return goalsFor(rt, ctx);
}

export async function turn(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, input: TurnInput): Promise<TurnResponse> {
  checkContext(ctx);
  await admit(rt, ctx, "turn");
  const open = typeof input?.open === "string" ? input.open : undefined;
  const text = open === undefined && typeof input?.text === "string" ? input.text.trim() : "";
  if (open !== undefined) {
    if (!FLOW_ID_RE.test(open)) throw new FlowError("invalid", "No such flow.");
  } else if (text.length === 0 || text.length > rt.limits.maxTextLength) throw new FlowError("invalid", "Please write a shorter message.");
  const ws = await loadWorkspace(rt, ctx, workspaceId);
  if (ws.active) {
    // A revoked version's run moves or ends before anything is read. One that cannot move yet
    // still hears the person, who may cancel it, switch away or answer its live child.
    const refused = await beforePerson(rt, ctx, ws.active, { whileBlocked: "proceed" });
    if (refused) return { kind: "run", workspace: await workspaceView(rt, ctx, ws, workspaceId), accepted: false, rejection: refused.rejection!, notices: [] };
    // What the person says is about the deepest live run of the active tree, the leaf (a child
    // while the active run waits for a call). A revoked leaf is handled the same way. Then a move
    // the leaf's version makes on the person's next turn happens now, so the decision is built
    // for the version it will be on (a run inside a live call never moves).
    const root = await activeRun(rt, ctx, ws);
    const leaf = root ? await leafOf(rt, ctx, root) : null;
    if (leaf && leaf.state.runId !== ws.active) {
      const refusedLeaf = await beforePerson(rt, ctx, leaf.state.runId, { whileBlocked: "proceed" });
      if (refusedLeaf) return { kind: "run", workspace: await workspaceView(rt, ctx, ws, workspaceId), accepted: false, rejection: refusedLeaf.rejection!, notices: [] };
    }
    if (leaf) await moveBeforeTurn(rt, ctx, leaf.state.runId);
  }
  const t = await beginTurn(rt, ctx, workspaceId, ws, open === undefined ? "text" : "open", text.length);
  // Recorded however the turn ends: one that fails is recorded with what it reached, and why.
  let failed = true;
  try {
    const response = await route(rt, t, text, open);
    failed = false;
    return response;
  } finally {
    if (failed) t.record.reason = "flow/turn-failed";
    emitTurn(rt, t);
  }
}

export async function consent(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, accept: boolean, question?: { turnId?: string }): Promise<TurnResponse> {
  checkContext(ctx);
  const wanted = question?.turnId;
  if (wanted !== undefined) checkId(wanted);
  const ws = await loadWorkspace(rt, ctx, workspaceId);
  const pending = ws.pending;
  const nothing = async (): Promise<TurnResponse> => ({ kind: "clarify", question: "There is nothing to confirm.", workspace: await workspace(rt, ctx, workspaceId) });
  if (!pending) return nothing();
  // Bound to the question the person saw: an answer that names another question, or none, is
  // not theirs to give to this one.
  if (pending.turnId !== wanted) {
    const policy = await policyFor(rt, ctx);
    const root = await activeRun(rt, ctx, ws);
    const at = { ctx, policy, active: root ? await leafOf(rt, ctx, root) : null };
    const question = policyText(policy, "changed");
    const reply = replyFor(rt, at, "clarify", question, `reply:${turnIdOf(ctx.scope, requestKey(ctx), workspaceId)}`, { reason: "flow/question-stale" });
    return { kind: "clarify", question, workspace: await workspace(rt, ctx, workspaceId), reply };
  }
  // Compare-and-clear: only the call that clears this exact question acts on it.
  const asked = (w: WorkspaceState) => w.pending !== null && samePending(w.pending, pending);
  const clear = () =>
    updateWorkspace(rt, ctx, workspaceId, (w) => {
      if (!asked(w)) return false;
      w.pending = null;
      return true;
    });
  // The question's own turn is what the transition rests on.
  const why: Why = { basis: pending.basis, turnId: pending.turnId };
  if (accept && pending.kind === "switch" && pending.flowId) {
    // The start clears the question in its own commit, and only while it is still open.
    const source = pending.facts || pending.items || pending.basis === "model" ? "model" : "entry";
    // Filtered again, as when it was shown.
    const facts = await safeFacts(rt, ctx, pending.flowId, pending.facts);
    const started = await startRun(rt, ctx, { flowId: pending.flowId, ...(facts ? { facts } : {}), ...(pending.items ? { items: pending.items } : {}), workspaceId }, source, asked, why);
    if (!started) return nothing();
    return { kind: "run", workspace: await workspaceAfter(rt, ctx, workspaceId, busyFor(started)), accepted: true, notices: [] };
  }
  if (accept && pending.kind === "cancel" && pending.runId) {
    const runId = pending.runId;
    if (!(await clear())) return nothing();
    const response = await submitAs(rt, ctx, runId, { kind: "cancel", reason: "person" }, why);
    if (response.accepted) {
      await updateWorkspace(rt, ctx, workspaceId, (w) => {
        if (w.active !== runId) return false;
        w.active = null;
        return true;
      });
    }
    return {
      kind: "run",
      workspace: await workspaceAfter(rt, ctx, workspaceId, busyFor(response)),
      accepted: response.accepted,
      notices: response.notices,
      ...(response.rejection ? { rejection: response.rejection } : {}),
    };
  }
  const cleared = await clear();
  if (!cleared || accept) return nothing();
  return { kind: "run", workspace: await workspaceView(rt, ctx, cleared, workspaceId), accepted: true, notices: [] };
}

export async function choose(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, input: { offerId: string; option: string | null }): Promise<TurnResponse> {
  checkContext(ctx);
  checkId(input?.offerId);
  if (input.option !== null && (typeof input.option !== "string" || input.option.length === 0 || input.option.length > 16)) throw new FlowError("invalid", "Bad option.");
  const policy = await policyFor(rt, ctx);
  return pick(rt, ctx, workspaceId, input.offerId, input.option, policy);
}

export async function resume(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, runId: string): Promise<WorkspaceView> {
  checkContext(ctx);
  checkId(runId);
  const ws = await loadWorkspace(rt, ctx, workspaceId);
  if (!ws.parked.includes(runId)) throw new FlowError("not_found", "Nothing to resume.");
  const { state } = await loadFor(rt, ctx, runId);
  // Against the latest workspace, retried on a concurrent change; gone from it meanwhile, nothing to resume.
  const saved = await updateWorkspace(rt, ctx, workspaceId, async (w) => {
    if (!w.parked.includes(runId)) return false;
    w.parked = w.parked.filter((id) => id !== runId);
    if (!isTerminal(state.status)) {
      await parkActive(rt, ctx.scope, w);
      w.active = runId;
    }
    w.pending = null;
    w.offer = null;
    return true;
  });
  if (!saved) throw new FlowError("not_found", "Nothing to resume.");
  if (!isTerminal(state.status)) await maybeMigrate(rt, ctx.scope, state, "person");
  return workspaceView(rt, ctx, saved, workspaceId);
}

// --- turns -----------------------------------------------------------------------

export async function beginTurn(rt: RuntimeContext, ctx: TrustedContext, workspaceId: string, ws: WorkspaceState, input: TurnRecord["input"], textLength: number): Promise<Turn> {
  const policy = await policyFor(rt, ctx);
  const root = await activeRun(rt, ctx, ws);
  // What the person says is about the leaf; setting aside, switching and cancelling act on the root.
  const active = root ? await leafOf(rt, ctx, root) : null;
  const now = rt.clock.now();
  const turnId = turnIdOf(ctx.scope, requestKey(ctx), workspaceId);
  const channel = typeof ctx.via?.kind === "string" && SHORT(ctx.via.kind, 64) ? ctx.via.kind : undefined;
  return {
    ctx,
    workspaceId,
    ws,
    policy,
    root,
    active,
    offer: liveOffer(ws, now),
    turnId,
    now,
    touched: false,
    record: {
      scope: { ...ctx.scope },
      turnId,
      at: now,
      mode: policy.mode,
      basis: "none",
      outcome: "clarify",
      stages: [],
      textLength,
      locale: ctx.locale,
      input,
      ...(channel !== undefined ? { channel } : {}),
      ...(policy.version !== undefined ? { policyVersion: policy.version } : {}),
      ...(policy.downgraded ? { downgraded: true } : {}),
      ...(active ? { activeFlowId: active.flow.id } : {}),
    },
  };
}

/** A turn's stages, in order; the first that answers wins. */
export async function route(rt: RuntimeContext, t: Turn, text: string, open: string | undefined): Promise<TurnResponse> {
  const { ctx, policy, active } = t;
  if (open === undefined) {
    const answered = await answerQuestion(rt, t, text);
    if (answered) return answered;
  }
  // Exact published names (and the reserved open output): deterministic, no model, no decide admission.
  let goals: Goal[] | null = null;
  if (open !== undefined || policy.exact) {
    goals = await goalsFor(rt, ctx);
    const flowId = open ?? matchGoalName(text, goals);
    if (flowId !== null) {
      const goal = goals.find((g) => g.flowId === flowId);
      t.record.basis = "exact";
      if (goal) return openGoal(rt, t, goal);
      return clarifyTurn(rt, t, policyText(policy, "nomatch"), "flow/decision-unknown-goal");
    }
  }
  // Off: no text reaches any model. Inside a flow the person is pointed to its view; nothing is extracted.
  if (policy.mode === "off") return active ? clarifyTurn(rt, t, policyText(policy, "useOptions"), "flow/routing-off") : nomatchTurn(rt, t, "flow/routing-off");
  if (!rt.decide) return nomatchTurn(rt, t);
  goals ??= await goalsFor(rt, ctx);
  // Over the limit, no goals at all: no stage may choose from part of the catalog.
  const truncated = goals.length > rt.limits.maxGoals;
  const offered = truncated ? [] : goals;
  const parked = await parkedOf(rt, t);
  await admit(rt, ctx, "decide", active?.flow.id);
  const facts = active ? decisionFacts(active.flow, active.state, actorRef(ctx), policy.shareValues) : [];
  const needs: DecisionNeed[] = [];
  if (offered.length > 0 || parked.length > 0 || active) needs.push("choose");
  if (facts.length > 0) needs.push("extract");
  needs.push("answer");
  const zone: { timezone: string; source: ZoneSource } = active
    ? { timezone: active.state.env.timezone, source: active.state.env.timezoneSource ?? "context" }
    : zoneFor(rt, ctx, policy);
  const request: DecisionRequest = {
    text,
    locale: ctx.locale,
    now: t.now,
    timezone: zone.timezone,
    timezoneSource: zone.source,
    active: active
      ? {
          runId: active.state.runId,
          flowId: active.flow.id,
          flowVersion: active.flow.version,
          flowHash: active.flow.hash,
          title: active.flow.definition.title,
          revision: active.state.revision,
          facts,
          ...(active.state.update ? { update: decisionUpdateOf(active.state.update) } : {}),
        }
      : null,
    parked,
    goals: offered,
    turnId: t.turnId,
    deadline: rt.clock.now() + rt.limits.decisionTimeoutMs,
    timeoutMs: rt.limits.decisionTimeoutMs,
    needs,
    ...(t.record.channel !== undefined ? { channel: t.record.channel } : {}),
    policy: requestPolicyOf(policy),
    ...(t.offer ? { offer: { options: t.offer.options.map((o) => ({ flowId: o.flowId, title: o.title })) } } : {}),
  };
  const asked = await ask(rt, ctx, request);
  t.record.stages = asked.stages;
  if (truncated) t.record.reason = "flow/goals-truncated";
  if (!asked.proposal) return clarifyTurn(rt, t, policyText(policy, "clarify"), asked.reason);
  t.record.basis = "model";
  return follow(rt, t, asked.proposal, request, offered, parked, asked.proposedBy);
}

/**
 * What a decider proposed, under the policy floor. Every proposal is
 * treated as a model's. Only `auto` acts on its own (opens, resumes), and
 * only on a proposal from a stage its calibration was earned with.
 */
export async function follow(rt: RuntimeContext, t: Turn, proposal: DecisionProposal, request: DecisionRequest, goals: Goal[], parked: Array<{ runId: string; flowId: string; title: string }>, proposedBy: StageTrace | null): Promise<TurnResponse> {
  const { ctx, ws, workspaceId, policy, active } = t;
  const onItsOwn = (): boolean => {
    if (policy.mode !== "auto") return false;
    if (stageCalibrated(policy, proposedBy)) return true;
    t.record.downgraded = true;
    return false;
  };
  switch (proposal.kind) {
    case "continue": {
      if (!active || !request.active) return clarifyTurn(rt, t, policyText(policy, "whatNext"));
      // A list is changed by item changes, never by a value in facts.
      const allowed = new Set(request.active.facts.filter((f) => !f.collection).map((f) => f.name));
      const facts = Object.fromEntries(Object.entries(proposal.facts).filter(([name]) => allowed.has(name)));
      const items = offeredItemOps(request.active.facts, proposal.items);
      if (Object.keys(facts).length === 0 && items.length === 0) {
        // Something was proposed, but nothing a model may write here (a fact not offered, such as one the person must state).
        const proposed = Object.keys(proposal.facts).length > 0 || (proposal.items?.length ?? 0) > 0;
        return clarifyTurn(rt, t, policyText(policy, "tellMore"), proposed ? "flow/decision-facts-filtered" : undefined);
      }
      // A revoked version's run that could not move yet takes no more facts under that version.
      const revoked = await revokedRefusal(rt, ctx.scope, active.state);
      if (revoked) {
        setOutcome(t, "unchanged", { flowId: active.flow.id, runId: active.state.runId });
        return { kind: "run", workspace: await turnView(rt, t), accepted: false, rejection: revoked, notices: [], turnId: t.turnId };
      }
      // Values are normalised and judged before anything is recorded (ADR 0012).
      const resolved = resolveProposal(active.flow, request.text, facts, proposal.meta, { now: t.now, timezone: request.timezone!, zoneSource: request.timezoneSource!, locale: active.state.env.locale, ...rt.normaliser }, fillCapOf(policy));
      const written = resolved.facts;
      if (resolved) t.record.assist = assistCounts(resolved);
      if (resolved && Object.keys(written).length === 0 && items.length === 0) {
        return clarifyTurn(rt, t, policyText(policy, "tellMore"), "flow/assist-unclear");
      }
      // Refused when a fact it writes changed after the request was built, or the run's flow moved.
      const seen = { revision: request.active.revision, flowHash: request.active.flowHash };
      let stale = false;
      const chain = newChain(rt);
      const recorded = await apply(rt, ctx.scope, active.state.runId, {
        build: (state) => {
          stale = staleFacts(state, Object.keys(written), seen).length > 0 || staleItems(state, items, seen).length > 0;
          return stale
            ? null
            : {
                v: EVENT_VERSION,
                type: "facts.input",
                id: rt.ids.newId(),
                at: rt.clock.now(),
                actor: actorRef(ctx),
                requestId: requestKey(ctx),
                facts: written,
                source: "model",
                ...(items.length > 0 ? { items } : {}),
                ...(resolved ? { marks: { ...resolved.marks, ...itemMarks(items, fillCapOf(policy)) } } : {}),
              };
        },
        access: { ctx },
        chain,
        why: { basis: "model", turnId: t.turnId },
        loaded: active.state,
      });
      if (stale) return clarifyTurn(rt, t, policyText(policy, "changed"), "flow/decision-stale");
      // As for any person's call: a move its version's policy makes now (one the turn could not make before).
      const applied = await afterPerson(rt, ctx.scope, recorded);
      await clearOffer(rt, t);
      const response = respond(ctx, active.state.runId, applied, chain);
      setOutcome(t, response.accepted ? "filled" : "unchanged", { flowId: active.flow.id, runId: active.state.runId });
      // A busy refusal goes on the view of the run in front of the person (the root of the tree).
      const busy = response.view.busy && t.ws.active ? { runId: t.ws.active, busy: response.view.busy } : undefined;
      // Values that could not be used are named, so the reply can ask for them again.
      const unclear = resolved && resolved.unclear.length > 0 ? [{ code: "flow/assist-unclear", message: "Some details could not be used. Please say them again.", facts: resolved.unclear }] : [];
      return {
        kind: "run",
        // The run just changed is shown as it was recorded, not loaded again.
        workspace: busy ? await workspaceAfter(rt, ctx, workspaceId, busy, applied) : await turnView(rt, t, applied),
        accepted: response.accepted,
        notices: [...response.notices, ...unclear],
        ...(response.rejection ? { rejection: response.rejection } : {}),
        turnId: t.turnId,
      };
    }
    case "detour": {
      await clearOffer(rt, t);
      const content = proposal.content ? filterReplyLinks(proposal.content, policy.linkOrigins) : null;
      setOutcome(t, "answered");
      const reply = replyFor(rt, t, "answer", proposal.answer, `reply:${t.turnId}`, content ? { content } : {});
      return { kind: "answer", text: proposal.answer, workspace: await turnView(rt, t), turnId: t.turnId, reply };
    }
    case "switch": {
      const goal = goals.find((g) => g.flowId === proposal.flowId);
      if (!goal) return clarifyTurn(rt, t, policyText(policy, "nomatch"), "flow/decision-unknown-goal");
      t.record.chosen = { flowId: goal.flowId };
      if (policy.mode === "off") return nomatchTurn(rt, t, "flow/routing-off");
      // Adds to the new run's lists, never to a secret field; facts declared, not derived, never secret.
      const target = await rt.catalog.get(ctx.scope, goal.flowId).catch(() => null);
      const items = proposal.items ? startItems(target, proposal.items) : undefined;
      // 0.3: values that start a run are normalised in the zone that run will get (ADR 0012); what cannot be used is left out.
      const { facts, normal } = startFacts(rt, t, target, request.text, proposal.facts, proposal.meta);
      if (t.root) return askSwitch(rt, t, goal, facts, "model", items);
      if (!onItsOwn()) {
        return offerTurn(rt, t, [{ flowId: goal.flowId, ...(facts ? { facts } : {}) }], goals, parked, undefined, "flow/routing-downgraded", false);
      }
      // Nothing to set aside, so no question; but only if nothing became active meanwhile.
      const started = await startRun(rt, ctx, { flowId: goal.flowId, ...(facts ? { facts } : {}), ...(items ? { items } : {}), workspaceId }, "model", (w) => w.active === ws.active, {
        basis: "model",
        turnId: t.turnId,
      });
      if (!started) return clarifyTurn(rt, t, policyText(policy, "changed"));
      setOutcome(t, "opened", { flowId: goal.flowId, runId: started.runId });
      if (normal) t.record.assist = assistCounts(normal);
      // Values that could not be used are left for the form to ask; the notice says which.
      const unclear = normal && normal.unclear.length > 0 ? [{ code: "flow/assist-unclear", message: "Some details could not be used. Please say them again.", facts: normal.unclear }] : [];
      return { kind: "run", workspace: await workspaceAfter(rt, ctx, workspaceId, busyFor(started)), accepted: true, notices: unclear, turnId: t.turnId };
    }
    case "resume": {
      const run = ws.parked.includes(proposal.runId) ? parked.find((p) => p.runId === proposal.runId) : undefined;
      if (!run) return clarifyTurn(rt, t, policyText(policy, "whichOne"));
      if (!onItsOwn()) {
        // Bringing a run back sets the one in front of the person aside: the person picks it.
        const option = { id: "1", flowId: run.flowId, title: run.title, runId: run.runId };
        return storeOffer(rt, t, [option], undefined, "flow/routing-downgraded");
      }
      return resumeInTurn(rt, t, proposal.runId, { runId: proposal.runId });
    }
    case "cancel": {
      // A cancel ends the whole tree: it is asked about, and applied to, the active (root) run.
      const root = t.root;
      if (!root) return clarifyTurn(rt, t, policyText(policy, "nothingToCancel"));
      const saved = await askInTurn(rt, t, { kind: "cancel", runId: root.state.runId, askedAt: rt.clock.now(), basis: "model", turnId: t.turnId });
      if (!saved) return clarifyTurn(rt, t, policyText(policy, "changed"));
      const question = policyText(policy, "cancel", { flow: root.flow.definition.title });
      setOutcome(t, "consent", { flowId: root.flow.id, runId: root.state.runId });
      return { kind: "consent", question, workspace: await workspaceView(rt, ctx, saved, workspaceId), turnId: t.turnId, reply: replyFor(rt, t, "consent", question, `reply:${t.turnId}`) };
    }
    case "clarify":
      return clarifyTurn(rt, t, proposal.question);
    case "suggest":
      if (policy.mode === "off") return nomatchTurn(rt, t, "flow/routing-off");
      return offerTurn(rt, t, proposal.options, goals, parked, proposal.question, undefined, true, request.text);
    case "nomatch":
      return nomatchTurn(rt, t);
  }
}

/** An open offer or yes-or-no question, answered by a digit, an option's title, or an affirm or deny word. Never by a model. */
export async function answerQuestion(rt: RuntimeContext, t: Turn, text: string): Promise<TurnResponse | null> {
  const { policy } = t;
  const assisted = await answerAssist(rt, t, text);
  if (assisted) return assisted;
  if (t.offer) {
    const offer = t.offer;
    let index = matchOption(text, offer.options);
    if (index === null && offer.options.length === 1) {
      if (matchWord(text, policy.affirm)) index = 0;
      else if (matchWord(text, policy.deny)) return pickInTurn(rt, t, offer, null);
    }
    return index === null ? null : pickInTurn(rt, t, offer, offer.options[index]!.id);
  }
  if (t.ws.pending) {
    const yes = matchWord(text, policy.affirm);
    if (!yes && !matchWord(text, policy.deny)) return null;
    const pending = t.ws.pending;
    t.record.basis = "pick";
    // The words answer the question this turn found open, and only while it still is.
    const response = await consent(rt, t.ctx, t.workspaceId, yes, { turnId: pending.turnId });
    setOutcome(t, response.kind !== "run" ? "clarify" : yes && pending.kind === "switch" ? "opened" : "unchanged", pending.flowId !== undefined ? { flowId: pending.flowId } : undefined);
    if (response.kind === "clarify" && response.reply?.reason !== undefined) t.record.reason = response.reply.reason;
    return { ...response, turnId: t.turnId };
  }
  return null;
}

/**
 * With no offer or question open, the undo words undo the assistant's
 * latest fills in the step in front of the person, and the affirm words
 * accept the ones still waiting for a yes. Never a model (ADR 0012).
 */
export async function answerAssist(rt: RuntimeContext, t: Turn, text: string): Promise<TurnResponse | null> {
  const { policy, active } = t;
  if (t.offer || t.ws.pending || !active) return null;
  const undo = matchWord(text, policy.undo);
  if (!undo && !matchWord(text, policy.affirm)) return null;
  // Read from the run's state.
  const step = renderView(active.flow, active.state, actorRef(t.ctx)).step;
  const compiled = step && step.item === undefined ? active.flow.stepById.get(step.id) : undefined;
  const turn = step?.assist;
  // Every value of the step still waiting for the person's yes, each with the turn that wrote it
  // (a value a move carried has none), so a value that changed meanwhile is refused, never confirmed.
  const waiting: AcceptEntry[] = [];
  for (const name of compiled?.fills ?? []) {
    if (name.includes(".") || active.flow.facts.get(name)?.userFillable !== true) continue;
    const st = own(active.state.facts, name);
    if (st?.status !== "needs_confirmation" || st.provenance !== "model") continue;
    waiting.push(st.assist !== undefined ? { fact: name, turn: st.assist.turn } : name);
  }
  if (undo ? !turn : waiting.length === 0) {
    if (!undo) return null;
    // "undo" with nothing the assistant filled is answered here, never read by a model as something else.
    t.record.basis = "pick";
    return clarifyTurn(rt, t, policyText(policy, "nothingToUndo"), "flow/undo-nothing");
  }
  t.record.basis = "pick";
  const input: SubmitInput = undo ? { kind: "facts", undo: { turn: turn!.turn } } : { kind: "facts", accept: waiting };
  const response = await submitAs(rt, t.ctx, active.state.runId, input, { basis: "pick", turnId: t.turnId });
  setOutcome(t, response.accepted ? "filled" : "unchanged", { flowId: active.flow.id, runId: active.state.runId });
  return {
    kind: "run",
    workspace: await turnView(rt, t),
    accepted: response.accepted,
    notices: response.notices,
    ...(response.rejection ? { rejection: response.rejection } : {}),
    turnId: t.turnId,
  };
}

/** The flows a person may be offered, filtered by their roles whatever the catalog lists (`listGoals`). */
export async function goalsFor(rt: RuntimeContext, ctx: TrustedContext): Promise<Goal[]> {
  return listGoals(rt.catalog, ctx.scope, { appRoles: ctx.appRoles });
}

/** The tenant's policy for this turn. One that throws or does not parse makes routing off, and is reported. */
export async function policyFor(rt: RuntimeContext, ctx: TrustedContext): Promise<ResolvedPolicy> {
  let raw: unknown = NO_POLICY;
  try {
    if (rt.policy) raw = await rt.policy(ctx);
  } catch (error) {
    rt.observer.error?.(error, "policy");
    raw = FAIL_CLOSED_POLICY;
  }
  const parsed = parseDecisionPolicy(raw);
  let policy = parsed.policy;
  if (!policy) {
    const first = parsed.diagnostics.find((d) => d.severity === "error");
    rt.observer.error?.(new FlowError("unavailable", `The decision policy is invalid${first ? ` (${first.code} at ${first.path})` : ""}; routing is off.`), "policy");
    policy = FAIL_CLOSED_POLICY;
  }
  return resolvePolicy(policy, { channel: typeof ctx.via?.kind === "string" ? ctx.via.kind : undefined, locale: ctx.locale });
}

/**
 * Asks the decision port, within the decision timeout; at the deadline the
 * port's signal aborts and a later answer is ignored. Never throws: no
 * proposal comes back with a reason (`flow/decision-timeout`,
 * `flow/decision-malformed`, `flow/decision-unavailable`).
 */
export async function ask(rt: RuntimeContext, ctx: TrustedContext, request: DecisionRequest): Promise<{ proposal: DecisionProposal | null; stages: StageTrace[]; reason?: string; proposedBy: StageTrace | null }> {
  const decide = rt.decide;
  const none = { stages: [] as StageTrace[], proposedBy: null };
  if (!decide) return { proposal: null, ...none, reason: "flow/decision-unavailable" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, rt.limits.decisionTimeoutMs);
    });
    const raw = await Promise.race([Promise.resolve().then(() => decide.decide(ctx, request, { signal: controller.signal })), timeout]);
    if (raw === TIMED_OUT) return { proposal: null, ...none, reason: "flow/decision-timeout" };
    const parsed = parseDecision(raw);
    if (!parsed) {
      reportMalformed(rt, "The decision port answered in a shape the runtime cannot read.", "decide");
      return { proposal: null, ...none, reason: "flow/decision-malformed" };
    }
    // Only ids the request offered are recorded: a made-up one may carry what the person typed.
    const stages = scrubTraces(parsed.trace?.stages ?? [], request);
    // A stage that answered in a shape it cannot read (a classifier's adapter, say) still only passes, but never silently.
    for (const st of stages) {
      if (st.reason === "malformed") reportMalformed(rt, `Decider stage "${st.name}" answered in a shape it cannot read, and passed as malformed.`, `decide:${st.name}`);
    }
    const proposedBy = stages.find((st) => st.result === "proposed") ?? null;
    // Every stage asked failed: ask again, with the reason, rather than say nothing fits.
    if (parsed.failed) return { proposal: null, stages, proposedBy, reason: "flow/decision-unavailable" };
    // What a model proposes is held to the checks a person's input gets.
    if (!fitsInput(rt, parsed.proposal)) return { proposal: null, stages, proposedBy, reason: "flow/decision-malformed" };
    return { proposal: parsed.proposal, stages, proposedBy };
  } catch (error) {
    rt.observer.error?.(error, "decide");
    return { proposal: null, ...none, reason: "flow/decision-unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Reports an answer the decision port or one of its stages gave in a shape nothing can read. Never throws. */
export function reportMalformed(rt: RuntimeContext, message: string, where: string): void {
  try {
    rt.observer.error?.(new FlowError("unavailable", message), where);
  } catch {
    // An observer that throws changes nothing about the turn.
  }
}

/**
 * What a decision model may propose for the active run: facts it may fill, of
 * steps that apply now. Secret facts are never offered, not even by name, so
 * a model cannot be asked to extract one. Current values go along as the
 * policy's `shareValues` allows (by default, every value that is not secret).
 */
export function decisionFacts(flow: CompiledFlow, state: RunState, viewer: ActorRef, shareValues: ShareValues = "nonSecret"): DecisionFact[] {
  const reader = new RunReader(flow, state, state.updatedAt);
  const locked = reader.lockedFacts();
  const current = state.current ? flow.stepById.get(state.current) : undefined;
  const asked = new Set(current?.fills ?? []);
  const out: DecisionFact[] = [];
  for (const [name, fact] of flow.facts) {
    if (fact.list || !fact.userFillable || fact.derive || locked.has(name) || fact.def.userAsserted || fact.sensitivity === "secret") continue;
    if (reader.directProblem(name, viewer, false) !== null) continue;
    const st = own(state.facts, name);
    out.push({
      name,
      ...(fact.def.title !== undefined ? { title: fact.def.title } : {}),
      ...(fact.def.prompt !== undefined ? { prompt: fact.def.prompt } : {}),
      schema: fact.schema,
      // 0.3: an assistant's value waiting for the person is shared too, so "no, make it 6pm" has something to correct.
      ...((st?.status === "valid" || (st?.status === "needs_confirmation" && st.assist !== undefined)) && shares(shareValues, fact.sensitivity) ? { value: st.value ?? null } : {}),
      asked: asked.has(name),
      ...(st !== undefined && (st.status === "valid" || st.status === "needs_confirmation") && st.provenance !== undefined && shares(shareValues, fact.sensitivity)
        ? { origin: st.assist !== undefined || st.provenance === "model" ? ("assistant" as const) : ("person" as const) }
        : {}),
    });
  }
  // Lists: never a secret field, not even by name.
  out.push(...decisionCollections(flow, state, reader, viewer, asked, (sensitivity) => shares(shareValues, sensitivity)));
  return out;
}

export function shares(share: ShareValues, sensitivity: CompiledFact["sensitivity"]): boolean {
  if (sensitivity === "secret" || share === "none") return false;
  return share === "nonSecret" || sensitivity === "none";
}

/** What a turn's resolution did with a decider's values, as counts for its record (never the values). */
export function assistCounts(resolved: ResolvedProposal): NonNullable<TurnRecord["assist"]> {
  const marks = Object.values(resolved.marks);
  return { stated: marks.filter((m) => m.basis === "stated").length, inferred: marks.filter((m) => m.basis === "inferred").length, unclear: resolved.unclear.length };
}

export function samePending(a: PendingConsent, b: PendingConsent): boolean {
  return canonicalJson(a as unknown as JsonValue) === canonicalJson(b as unknown as JsonValue);
}
