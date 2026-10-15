/**
 * Small helpers the runtime modules share: checks of ids and contexts, who
 * a request is from, busy refusals, and waiting within a deadline.
 */

import { isEnvironmentKind } from "@aaply/action-contract";
import { templateOf } from "../address.js";
import type { ResolvedPolicy } from "../policy.js";
import type { TrustedContext } from "../ports.js";
import type { ActorRef, RunState, FillMode, ItemOp, AssistMark } from "../state.js";
import { tighterMode } from "../fill.js";
import type { FlowView } from "../view.js";
import { FlowError } from "../errors.js";
import { type Chain, type Busy, ID_RE } from "./context.js";
import type { RunResponse } from "../runtime.js";

/** `view` with the busy refusal its request met, if any. */
export function withBusy(view: FlowView, chain: Chain | undefined): FlowView {
  return chain?.busy?.value ? { ...view, busy: chain.busy.value } : view;
}

/** The next round of a request's inline chain: one deeper, same deadline, same busy record. */
export function deeper(chain: Chain): Chain {
  return { depth: chain.depth + 1, deadline: chain.deadline, ...(chain.busy ? { busy: chain.busy } : {}) };
}

/** A response's busy refusal, for the workspace view of the same run. */
export function busyFor(response: RunResponse): { runId: string; busy: Busy } | undefined {
  return response.view.busy ? { runId: response.runId, busy: response.view.busy } : undefined;
}

export function actorRef(ctx: TrustedContext): ActorRef {
  const id = `${ctx.actor.domain}:${ctx.actor.id}`;
  const subject = ctx.subject ? `${ctx.subject.domain}:${ctx.subject.id}` : null;
  return { kind: ctx.actor.kind, id, roles: [...ctx.appRoles], ...(subject !== null && subject !== id ? { for: subject } : {}) };
}

export function subjectOf(ctx: TrustedContext): string | null {
  if (ctx.subject) return `${ctx.subject.domain}:${ctx.subject.id}`;
  return ctx.actor.kind === "workload" ? null : `${ctx.actor.domain}:${ctx.actor.id}`;
}

/** The caller's request id, namespaced by actor, so no one can pre-empt another's request id in a run. */
export function requestKey(ctx: TrustedContext): string {
  return JSON.stringify([ctx.actor.kind, ctx.actor.domain, ctx.actor.id, ctx.requestId]);
}

/** The run's own person, or a service acting for them. */
export function isOwner(ctx: TrustedContext, state: RunState): boolean {
  if (!state.subject) return false;
  if (state.subject.id === actorRef(ctx).id) return true;
  return ctx.actor.kind === "workload" && subjectOf(ctx) === state.subject.id;
}

/** A policy version admission reported, if it is one the approved action can carry. */
export function policyVersion(policy: { version: string } | undefined): boolean {
  return policy !== undefined && typeof policy.version === "string" && policy.version.length > 0 && policy.version.length <= 256;
}

/** A write given up on may have happened, so it is unknown; a read simply failed. */
/**
 * A port's own error as the engine's: `unavailable`, with a message fit for
 * people and the port's error as its `cause`. A FlowError passes unchanged.
 */
export function portFailure(error: unknown, port: string): FlowError {
  if (error instanceof FlowError) return error;
  const failure = new FlowError("unavailable", "This is not available right now. Please try again shortly.");
  Object.defineProperty(failure, "cause", { value: error, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(failure, "port", { value: port, enumerable: false });
  return failure;
}

/**
 * SQLSTATEs a retry can outlive beyond classes 08 and 57P: out of memory,
 * disk or connections (53000, 53100, 53200, 53300; not 53400, a configured
 * limit a retry meets again), and a transaction lost to a concurrent one.
 */
const TRANSIENT_SQLSTATE = new Set(["53000", "53100", "53200", "53300", "40001", "40P01"]);

/** Network errors a retry can outlive (Node's `code`). */
const TRANSIENT_ERRNO = new Set(["EPIPE", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

/**
 * Whether a store's error is one a retry can outlive: the connection or the
 * network failed (Node's network error codes, node-postgres's messages for
 * a dead or late connection), the database is shutting down or starting
 * (SQLSTATE class 08, 57P01 to 57P03) or out of resources (53000 to 53300),
 * or a transaction lost to a concurrent one (40001, 40P01). Anything else (a missing table, a
 * refused permission, a broken constraint, a bug in a custom store) is not,
 * and a retry would meet it again.
 */
export function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_ERRNO.has(code) || /^08[0-9A-Z]{3}$/.test(code) || /^57P0[1-3]$/.test(code) || TRANSIENT_SQLSTATE.has(code)) return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|Client has encountered a connection error and is not queryable|timeout exceeded when trying to connect)$/.test(message);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof FlowError && error.code === "not_found";
}

/** A short random pause before retrying a conflicting commit, so competing writers spread out. */
export function pause(attempt: number): Promise<void> {
  const ms = Math.floor(Math.random() * Math.min(100, 5 * 2 ** attempt));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `work` settles within `ms` of real time. */
export async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function checkId(id: unknown): void {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new FlowError("invalid", "Bad id.");
}

export const SHORT = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** The identity domain of the engine's own actors; no trusted context may use it. */
export const SYSTEM_DOMAIN = "system";

/** The trusted context is built by the host, but is still checked so a host bug fails closed. */
export function checkContext(ctx: TrustedContext): void {
  const ok =
    ctx !== null &&
    typeof ctx === "object" &&
    ctx.scope !== null &&
    typeof ctx.scope === "object" &&
    SHORT(ctx.scope.tenantId, 128) &&
    SHORT(ctx.scope.appId, 128) &&
    SHORT(ctx.scope.environmentId, 128) &&
    isEnvironmentKind(ctx.environmentKind) &&
    ctx.actor !== null &&
    typeof ctx.actor === "object" &&
    SHORT(ctx.actor.domain, 64) &&
    !ctx.actor.domain.includes(":") &&
    SHORT(ctx.actor.id, 256) &&
    ["visitor", "member", "staff", "workload"].includes(ctx.actor.kind) &&
    (ctx.subject === undefined || (SHORT(ctx.subject.domain, 64) && !ctx.subject.domain.includes(":") && SHORT(ctx.subject.id, 256))) &&
    Array.isArray(ctx.appRoles) &&
    ctx.appRoles.length <= 100 &&
    ctx.appRoles.every((r) => SHORT(r, 64)) &&
    SHORT(ctx.locale, 35) &&
    // Any short string: one that names no zone this runtime knows falls back (ADR 0012).
    (ctx.timezone === undefined || (typeof ctx.timezone === "string" && ctx.timezone.length <= 64)) &&
    SHORT(ctx.requestId, 128);
  if (!ok) throw new FlowError("invalid", "Invalid trusted context.");
  // `system:...` ids are the engine's own actors (a call's `system:call`, the runtime, the planner):
  // a caller named like one would be taken for it, so the domain is reserved.
  if (ctx.actor.domain === SYSTEM_DOMAIN || ctx.subject?.domain === SYSTEM_DOMAIN) throw new FlowError("invalid", `Invalid trusted context: the "${SYSTEM_DOMAIN}" identity domain is reserved for the engine.`);
  if (ctx.subject && ctx.actor.kind === "visitor") throw new FlowError("forbidden", "A visitor cannot act for someone else.");
}

/**
 * The cap on a model's fills a turn's policy allows (ADR 0012): the tenant's
 * `fill`, and never past `confirm` unless the policy runs in a calibrated
 * `auto` (still `auto` once resolved).
 */
export function fillCapOf(policy: ResolvedPolicy): FillMode | undefined {
  if (policy.mode === "auto" && !policy.downgraded) return policy.fill;
  return tighterMode(policy.fill, "confirm");
}

/** Marks for the item fields a model gives (`collection.field`), carrying the cap; none without one. */
export function itemMarks(items: readonly ItemOp[] | undefined, cap: FillMode | undefined): Record<string, AssistMark> {
  const out: Record<string, AssistMark> = {};
  if (cap === undefined || !items) return out;
  for (const op of items) {
    if (op.op !== "add" && op.op !== "set") continue;
    for (const field of Object.keys(op.fields ?? {})) Object.defineProperty(out, templateOf(op.collection, field), { value: { basis: "stated", cap }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
