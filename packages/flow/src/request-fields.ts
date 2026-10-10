/**
 * What a request's trusted context says about it that the runtime passes
 * through to the envelopes of the work it causes, and never acts on
 * (ADR-0002, G1 amendment):
 *
 * - `traceparent`, for correlation: a well-formed one goes on the events the
 *   request causes, and the core records it with the write it sets in
 *   motion, so every envelope of that work carries it;
 * - `actor.authTime`, when the actor last signed in (epoch ms): it goes on
 *   the actor of the events the request causes, so the envelope's `actor`
 *   and, for a review, the approval's `by` carry it.
 *
 * A malformed value is dropped and reported to `observer.error` (as
 * `traceparent` or `authTime`), once per context; it never refuses the call.
 */

import { isTraceparent } from "@aaply/action-contract";
import type { TrustedContext } from "./ports.js";
import type { FlowEvent } from "./state.js";

/** True for a time: a finite, non-negative number of epoch ms, as the envelope's other times are. */
function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Reads contexts' pass-through fields, reporting each malformed one once per context. */
export class RequestFields {
  private readonly reported = { traceparent: new WeakSet<object>(), authTime: new WeakSet<object>() };

  constructor(private readonly report: (error: unknown, where: string) => void) {}

  /** `{ traceparent }` when `ctx` carries a well-formed one, else `{}`. Never throws. */
  traceOf(ctx: TrustedContext): { traceparent?: string } {
    const value: unknown = ctx.traceparent;
    if (value === undefined) return {};
    if (isTraceparent(value)) return { traceparent: value };
    this.dropped(ctx, "traceparent", "the trusted context's traceparent is not a W3C traceparent; it was dropped");
    return {};
  }

  /** The actor's `authTime` when `ctx` carries a well-formed one. Never throws. */
  authTimeOf(ctx: TrustedContext): number | undefined {
    const value: unknown = ctx.actor.authTime;
    if (value === undefined) return undefined;
    if (isTime(value)) return value;
    this.dropped(ctx, "authTime", "the trusted context's actor.authTime is not a time (epoch ms); it was dropped");
    return undefined;
  }

  /**
   * Puts what `ctx` carries on a person's or workload's `event` caused by
   * that request: the `traceparent` on the event, and `authTime` on its actor
   * when the actor is the context's. A system event gets neither.
   */
  stamp(event: FlowEvent, ctx: TrustedContext | undefined): void {
    if (ctx === undefined || event.actor.kind === "system") return;
    Object.assign(event, this.traceOf(ctx));
    const authTime = this.authTimeOf(ctx);
    if (authTime !== undefined && event.actor.id === `${ctx.actor.domain}:${ctx.actor.id}`) event.actor = { ...event.actor, authTime };
  }

  private dropped(ctx: TrustedContext, where: "traceparent" | "authTime", message: string): void {
    if (this.reported[where].has(ctx)) return;
    this.reported[where].add(ctx);
    try {
      this.report(new Error(message), where);
    } catch {
      // Reporting must not break the call.
    }
  }
}
