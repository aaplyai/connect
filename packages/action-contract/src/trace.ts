/**
 * Correlation: the W3C Trace Context `traceparent` of the request that set
 * an action in motion.
 *
 * Only the field: no tracer and no dependency, so a host maps it to
 * OpenTelemetry (or anything else) itself. The engine takes it from its
 * trusted context, drops a malformed one (and reports it), and carries a
 * well-formed one on every envelope of the work that request set in motion:
 * every attempt, retry, timer-driven attempt, undo and check
 * (`ApprovedAction.traceparent`, signed with every other field). A
 * performer never refuses an envelope for it, and uses it only when
 * {@link isTraceparent} accepts it.
 */

import { fixedPattern } from "./frozen.js";

/** `<version>-<trace id>-<parent id>-<flags>`, lower-case hex: 2, 32, 16 and 2 digits. */
export const TRACEPARENT_RE = fixedPattern(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

/**
 * True for a well-formed `traceparent`: {@link TRACEPARENT_RE}, any version
 * but `ff` (invalid by the specification), and neither the trace id nor the
 * parent id all zeros. Never throws.
 */
export function isTraceparent(value: unknown): value is string {
  if (typeof value !== "string" || !TRACEPARENT_RE.test(value)) return false;
  const [version, traceId, parentId] = value.split("-") as [string, string, string, string];
  return version !== "ff" && !/^0+$/.test(traceId) && !/^0+$/.test(parentId);
}
