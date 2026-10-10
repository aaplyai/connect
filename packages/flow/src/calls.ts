/**
 * Sub-flows: what a `call` step and a flow's `interface` mean, shared by the
 * core, the runtime and publishing.
 *
 * A call runs another flow as a child run. The child is a run of its own
 * (its own events, limits, roles and audit); it shares only its caller's
 * scope, person and environment, and receives nothing but the input its
 * interface declares. These checks keep that boundary: a call cannot reach a
 * flow that did not opt in, launder what a person asserted, downgrade a
 * secret, bypass start roles, recurse, or nest without bound.
 */

import { deepFreeze } from "@aaply/action-contract/internal";
import type { CompiledFlow, CompiledStep } from "./compile.js";
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";
import { nodeChildren, type Node } from "./expr.js";
import { fingerprint } from "./hash.js";
import { withHints } from "./hints.js";
import { isJsonObject, type JsonValue, type PathSegment } from "./json.js";
import type { FlowCatalog } from "./ports.js";
import { secretsOf } from "./secrets.js";
import type { ActorRef, CallEnd, ParentLink, Scope } from "./state.js";

/** The actor that starts child runs and reports their ends. Only the runtime uses it. */
export const CALL_ACTOR: ActorRef = deepFreeze({ kind: "system", id: "system:call", roles: [] });

/** Default for `RuntimeLimits.maxCallDepth`: a root, its child, grandchild and great-grandchild. */
export const DEFAULT_MAX_CALL_DEPTH = 3;
/** The most `maxCallDepth` may be set to. */
export const MAX_CALL_DEPTH = 8;
/** Largest interface output a child returns, in UTF-8 bytes. */
export const MAX_CALL_OUTPUT_BYTES = 256 * 1024;
/** Most contributor ids a call carries; more are summarised as `"*"`, which no approver passes. */
export const MAX_CONTRIBUTORS = 32;
/** Retries of a start that failed for a transient reason (admission, an unreadable catalog). */
export const CALL_START_RETRIES = 3;

/**
 * The child run's id: derived from the caller's nonce (or its id) and the
 * call id, so every retry of a start names the same child, and a client that
 * knows a run's id cannot work out its children's.
 */
export function childRunId(seed: string, callId: string): string {
  return `run-${fingerprint(["call", seed, callId])}`;
}

/** Contributor ids, sorted, at most {@link MAX_CONTRIBUTORS}; past the cap the list ends in `"*"`. */
export function capContributors(ids: Iterable<string>): string[] {
  const all = [...new Set(ids)].sort();
  if (all.includes("*")) return [...all.filter((id) => id !== "*").slice(0, MAX_CONTRIBUTORS - 1), "*"];
  return all.length <= MAX_CONTRIBUTORS ? all : [...all.slice(0, MAX_CONTRIBUTORS - 1), "*"];
}

/** Whether `actorId` is among `contributors` (or they were capped, which fails closed). */
export function isContributor(contributors: readonly string[], actorId: string): boolean {
  return contributors.includes(actorId) || contributors.includes("*");
}

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isTextList = (v: unknown, maxItems: number, maxLength: number): v is string[] => Array.isArray(v) && v.length <= maxItems && v.every((x) => isText(x, maxLength));

/** A parent link as the runtime builds it; anything else is refused when a child starts. */
export function isParentLink(v: unknown): v is ParentLink {
  if (!isJsonObject(v as JsonValue)) return false;
  const link = v as Record<string, unknown>;
  return (
    isText(link.runId, 256) &&
    isText(link.callId, 300) &&
    isText(link.rootRunId, 256) &&
    typeof link.depth === "number" &&
    Number.isInteger(link.depth) &&
    link.depth >= 1 &&
    link.depth <= MAX_CALL_DEPTH &&
    isTextList(link.chain, MAX_CALL_DEPTH, 64) &&
    (link.chain as string[]).length === link.depth &&
    isTextList(link.contributors, MAX_CONTRIBUTORS, 400)
  );
}

const END_KINDS = new Set(["completed", "cancelled", "failed", "expired"]);

/**
 * A child's end as the caller records it. The runtime builds it from the
 * child's own state, but the caller still checks its shape; a malformed end
 * reads as a failure with no output. So does an end whose `contributors` is
 * not a list of ids within the cap: who gave the child its values decides
 * who may approve with them, so it is never dropped and read as nobody.
 */
export function readCallEnd(raw: unknown, fallbackAt: number): CallEnd {
  const bad: CallEnd = { kind: "failed", committed: false, error: { code: "flow/call-failed", message: "That did not work. Please try again." }, lastInputAt: fallbackAt };
  if (!isJsonObject(raw as JsonValue)) return bad;
  const e = raw as Record<string, unknown>;
  if (typeof e.kind !== "string" || !END_KINDS.has(e.kind) || typeof e.committed !== "boolean") return bad;
  const lastInputAt = typeof e.lastInputAt === "number" && Number.isFinite(e.lastInputAt) ? e.lastInputAt : fallbackAt;
  const end: CallEnd = { kind: e.kind as CallEnd["kind"], committed: e.committed, lastInputAt };
  if (isText(e.reason, 200)) end.reason = e.reason;
  if (isText(e.cascade, 256)) end.cascade = e.cascade;
  if (e.contributors !== undefined) {
    if (!isTextList(e.contributors, MAX_CONTRIBUTORS, 400)) return { ...bad, committed: e.committed };
    end.contributors = [...e.contributors];
  }
  if (isJsonObject(e.error as JsonValue)) {
    const err = e.error as Record<string, unknown>;
    if (isText(err.code, 100) && typeof err.message === "string") end.error = { code: err.code, message: err.message.slice(0, 500) };
  }
  if (end.kind === "completed") {
    if (!isJsonObject(e.output as JsonValue)) return { ...bad, committed: e.committed };
    end.output = e.output as CallEnd["output"] & object;
  }
  return end;
}

/** One reason a call cannot go ahead. `path` is relative to the call step's `call`. */
export interface CallProblem {
  code: string;
  message: string;
  path: PathSegment[];
}

/** Facts whose values a node reads (not merely whether they are known). */
function valueFacts(node: Node, out = new Set<string>()): Set<string> {
  if (node.k === "fact") out.add(node.name);
  for (const child of nodeChildren(node)) valueFacts(child, out);
  return out;
}

/** Output names a rule's expression reads from the payload; null when it reads the whole payload. */
function payloadNames(node: Node, out: Set<string>): boolean {
  if (node.k === "payload") {
    const head = node.path[0];
    if (typeof head !== "string") return false;
    out.add(head);
  }
  return nodeChildren(node).every((child) => payloadNames(child, out));
}

/**
 * Whether `parent`'s call step may call `child`, as far as both definitions
 * tell: the child opted in, the mapping fits its interface, secrets stay
 * secret in both directions, what a person asserted is not laundered, and
 * the child's start roles are not bypassed. Checked at publish and again at
 * every start (the child version may differ under `compatible`).
 */
export function checkCallPair(parent: CompiledFlow, step: CompiledStep, child: CompiledFlow): CallProblem[] {
  const out: CallProblem[] = [];
  const call = step.call;
  if (!call) return out;
  const iface = child.interface;
  if (!iface) {
    out.push({ code: "flow/call-not-callable", message: `${child.id}@${child.version} declares no interface, so it cannot be called`, path: ["flow"] });
    return out;
  }
  const given = new Set(call.input.map(([key]) => key));
  for (const [key, node] of call.input) {
    if (!iface.input.includes(key)) {
      out.push({ code: "flow/call-input-unknown", message: `"${key}" is not an input of ${child.id}@${child.version}`, path: ["input", key] });
      continue;
    }
    const fact = child.facts.get(key)!;
    const reads = [...valueFacts(node)];
    // Secret facts, facts derived from one, and secret item fields a list read takes.
    const secret = secretsOf(parent).secretRead(node);
    if (secret !== null && fact.sensitivity !== "secret") {
      out.push({ code: "flow/call-sensitivity", message: `"${key}" is not secret in ${child.id}, but reads secret "${secret}"`, path: ["input", key] });
    }
    if (fact.def.userAsserted) {
      const laundered = reads.find((f) => parent.facts.get(f)?.def.userAsserted !== true);
      if (laundered !== undefined) {
        out.push({ code: "flow/call-launders-assertion", message: `"${key}" must come from the person, but "${laundered}" is not userAsserted here`, path: ["input", key] });
      }
    }
  }
  const missing = iface.required.filter((name) => !given.has(name));
  if (missing.length > 0) out.push({ code: "flow/call-input-missing", message: `${child.id}@${child.version} needs ${missing.map((n) => `"${n}"`).join(", ")}`, path: ["input"] });
  // The output reaches the caller only through its end rules' payload.
  for (const [ruleName, rule] of step.rules) {
    if (ruleName !== "completed") continue;
    for (const [target, node] of rule.set) {
      const names = new Set<string>();
      const whole = !payloadNames(node, names);
      for (const name of names) {
        if (!iface.output.includes(name)) out.push({ code: "flow/call-output-unknown", message: `"${name}" is not an output of ${child.id}@${child.version}`, path: [] });
      }
      const read = whole ? iface.output : [...names].filter((n) => iface.output.includes(n));
      // An output holds a secret when it is secret or derived from one, whatever it declares.
      const secret = read.find((n) => secretsOf(child).secretIn(n) !== null);
      if (secret !== undefined && secretsOf(parent).secretIn(target) === null) {
        out.push({ code: "flow/call-sensitivity", message: `"${target}" is not secret, but takes secret output "${secret}" of ${child.id}`, path: [] });
      }
    }
  }
  if (child.startRoles.length > 0) {
    const covered = parent.startRoles.length > 0 && parent.startRoles.every((r) => child.startRoles.includes(r));
    if (!covered) out.push({ code: "flow/call-start-roles", message: `only ${child.startRoles.map((r) => `"${r}"`).join(", ")} may start ${child.id}; this flow's startRoles must be a non-empty subset of them`, path: ["flow"] });
  }
  return out;
}

/** Whether a new child of `flowId` under `link` stays within the depth limit and off its own chain. */
export function checkChain(flowId: string, link: ParentLink, maxDepth: number): CallProblem | null {
  if (link.chain.includes(flowId)) return { code: "flow/call-cycle", message: `${flowId} is already running higher up this call chain`, path: ["flow"] };
  if (link.depth > maxDepth) return { code: "flow/call-depth", message: `calls nest at most ${maxDepth} deep`, path: ["flow"] };
  return null;
}

/** Bound on the flows one publish-time check visits, so a wide call graph cannot make it slow. */
const MAX_VISITS = 500;

/**
 * Checks a flow's calls against what is published in `scope` (at publish):
 * each target exists and fits, and no path through the call graph repeats a
 * flow id or nests deeper than `maxDepth`. Under `compatible`, the target's
 * current version is followed too. Problems are reported at the root flow's
 * call step, each with its code's hint.
 */
export async function checkFlowCalls(flow: CompiledFlow, options: { scope: Scope; catalog: FlowCatalog; maxDepth?: number }): Promise<Diagnostic[]> {
  const bag = new DiagnosticBag();
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? DEFAULT_MAX_CALL_DEPTH, MAX_CALL_DEPTH));
  let visits = 0;
  const seen = new Set<string>();
  const visit = async (f: CompiledFlow, chain: string[], at: PathSegment[] | null): Promise<void> => {
    for (const step of f.steps) {
      if (!step.call) continue;
      const path: PathSegment[] = at ?? ["steps", step.index, "call"];
      const ref = `${step.call.flowId}@${step.call.version}`;
      const childChain = [...chain, f.id];
      if (childChain.includes(step.call.flowId)) {
        bag.error("flow/call-cycle", path, `${ref} would call ${step.call.flowId} again (${[...childChain, step.call.flowId].join(" -> ")})`);
        continue;
      }
      if (childChain.length > maxDepth) {
        bag.error("flow/call-depth", path, `calls nest at most ${maxDepth} deep (${[...childChain, step.call.flowId].join(" -> ")})`);
        continue;
      }
      const pinned = await options.catalog.get(options.scope, step.call.flowId, step.call.version);
      if (!pinned) {
        bag.error("flow/call-target-missing", path, at === null ? `${ref} is not published` : `${ref}, called further down, is not published`);
        continue;
      }
      const targets = [pinned];
      if (step.call.upgrade === "compatible") {
        const current = await options.catalog.get(options.scope, step.call.flowId);
        if (current && current.version !== pinned.version && current.interface !== undefined && current.interface.hash === pinned.interface?.hash) targets.push(current);
      }
      for (const child of targets) {
        if (at === null) for (const p of checkCallPair(f, step, child)) bag.error(p.code, [...path, ...p.path], p.message);
        const key = `${child.id}@${child.version}|${childChain.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (++visits > MAX_VISITS) {
          bag.error("flow/call-depth", path, "the call graph is too large to check");
          return;
        }
        await visit(child, childChain, path);
      }
    }
  };
  await visit(flow, [], null);
  return withHints(bag.items);
}
