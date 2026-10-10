/**
 * Delivering an outside event to the run that waits on it.
 *
 * A flow's `wait` step names an event and a correlation; a webhook, an email
 * or a job queue later reports that event, and whoever received it calls the
 * engine's `deliver` with a {@link DeliverRequest}. It is defined here so a
 * performer (Aaply Connect, a connector's webhook parser) can build one
 * without importing the engine.
 */

import { checkJson, isJsonObject, type JsonValue } from "./json.js";
import { fixedPattern } from "./frozen.js";

/** An event name as a flow's `wait` step writes it: a letter, then up to 127 letters, digits, `_`, `.` or `-`. */
export const DELIVER_EVENT_RE = fixedPattern(/^[a-z][a-zA-Z0-9_.-]{0,127}$/);

/** A sender's event id (`dedupeKey`): 1-256 characters of letters, digits and `._:@/-`, starting with a letter or digit. */
export const DEDUPE_KEY_RE = fixedPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/);

/**
 * The connection an event came from (a webhook endpoint belongs to one), as
 * the host's own connection store records it. A service's references are
 * often unique only within one account (a Gmail thread id), so an event that
 * names its connection wakes only a run of that connection's owner.
 */
export interface DeliverConnection {
  /** The connection's id in the host's store. */
  id: string;
  /** Whose account it is: the person's subject id (`domain:id`), or null for the business's own. */
  subjectId: string | null;
}

/** What the engine's `deliver` takes. */
export interface DeliverRequest {
  /** The event name the waiting step names, such as `payment.completed`. */
  event: string;
  /** What names the run: equal (as canonical JSON) to the value the waiting step's `correlate` gave. */
  correlation: JsonValue;
  /** The event's content, which the step's rule reads as `payload`. */
  payload: JsonValue;
  /** The sender's own id for the event, so a redelivery is ignored by a run that took it. */
  dedupeKey?: string;
  /**
   * The connection the event came from (the kit's `handleWebhook` sets it
   * from the host's options, never from the request). With it, the engine
   * delivers only to a run of the connection's owner, and the deliverer's
   * context must name that owner as its subject (null: none, for the
   * business's own connection).
   */
  connection?: DeliverConnection;
}

/** What the engine answers: how many runs took the event (0 or 1). */
export interface DeliverResult {
  delivered: number;
}

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** True for a well-formed {@link DeliverConnection}: exactly an `id` (1-256 characters) and a `subjectId` (`domain:id`, or null). Never throws. */
export function isDeliverConnection(value: unknown): value is DeliverConnection {
  try {
    if (checkJson(value) !== null || !isJsonObject(value as JsonValue)) return false;
    const c = value as Record<string, unknown>;
    if (Object.keys(c).some((k) => k !== "id" && k !== "subjectId")) return false;
    return text(c.id, 256) && (c.subjectId === null || (text(c.subjectId, 512) && c.subjectId.indexOf(":") > 0));
  } catch {
    return false;
  }
}

/**
 * True for a well-formed {@link DeliverRequest}: an object with exactly
 * these fields, a valid event name and dedupe key, a well-formed connection
 * when there is one, and plain-JSON correlation and payload. Never throws.
 * The engine checks sizes itself.
 */
export function isDeliverRequest(value: unknown): value is DeliverRequest {
  try {
    if (checkJson(value) !== null || !isJsonObject(value as JsonValue)) return false;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some((k) => k !== "event" && k !== "correlation" && k !== "payload" && k !== "dedupeKey" && k !== "connection")) return false;
    if (typeof v.event !== "string" || !DELIVER_EVENT_RE.test(v.event)) return false;
    if (v.correlation === undefined || v.payload === undefined) return false;
    if (v.connection !== undefined && !isDeliverConnection(v.connection)) return false;
    return v.dedupeKey === undefined || (typeof v.dedupeKey === "string" && DEDUPE_KEY_RE.test(v.dedupeKey));
  } catch {
    return false;
  }
}
