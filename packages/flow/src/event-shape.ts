/**
 * The shape an event must have before the core reads it. Events come from
 * the runtime, which builds them, and from stored logs, so a malformed one is
 * a bug elsewhere; the core still refuses it (`flow/invalid-event`) rather
 * than throwing. Only what the core reads without a check of its own is
 * checked here: an event the core refuses for its meaning keeps that refusal.
 */

import { MAX_COMPLETION_WINDOW_MS, isTraceparent } from "@aaply/action-contract";
import { isJsonObject } from "./json.js";

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, test: (v: unknown) => boolean) => v === undefined || test(v);
const isWindow = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_COMPLETION_WINDOW_MS;

const isNames = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
const MODES = ["never", "suggest", "confirm", "auto"];
const isAssistMarks = (v: unknown): boolean =>
  isObject(v) &&
  Object.values(v).every(
    (m) => isObject(m) && (m.basis === "stated" || m.basis === "inferred") && optional(m.op, (o) => o === "set" || o === "correct") && optional(m.cap, (c) => MODES.includes(c as string)),
  );

const isAccept = (v: unknown): boolean =>
  Array.isArray(v) && v.every((a) => isString(a) || (isObject(a) && isString(a.fact) && optional(a.turn, isString) && Object.keys(a).every((k) => k === "fact" || k === "turn")));
const isUndo = (v: unknown): boolean => isObject(v) && isString(v.turn) && optional(v.facts, isNames) && Object.keys(v).every((k) => k === "turn" || k === "facts");

/** What the core needs of each event type, beyond the fields every event has. */
const FIELDS: Readonly<Record<string, (ev: Fields) => string | null>> = {
  "run.started": (ev) => (!isJsonObject(ev.facts) ? "facts must be an object" : !optional(ev.marks, isAssistMarks) ? "marks map facts to marks of a basis, an op and a cap" : null),
  "facts.input": (ev) =>
    !isJsonObject(ev.facts)
      ? "facts must be an object"
      : !optional(ev.marks, isAssistMarks)
        ? "marks map facts to marks of a basis, an op and a cap"
        : !optional(ev.accept, isAccept) || !optional(ev.dismiss, isNames) || !optional(ev.undo, isUndo)
          ? "accept lists names or {fact, turn}, dismiss lists names, and undo is {turn, facts?}"
          : null,
  output: (ev) =>
    !isString(ev.stepId) || !isString(ev.name)
      ? "an output names its step and output"
      : !optional(ev.digest, isString) || !optional(ev.item, isString) || !optional(ev.epoch, isNumber)
        ? "digest and item are strings, and epoch a number"
        : null,
  "action.settled": (ev) =>
    !isString(ev.effectId) || !isNumber(ev.attempt)
      ? "an outcome names its effect and attempt"
      : !isObject(ev.outcome) || !isString(ev.outcome.status)
        ? "outcome must be an object with a status"
        : !optional(ev.windowMs, isWindow)
          ? `windowMs must be a whole number of milliseconds up to ${MAX_COMPLETION_WINDOW_MS}`
          : null,
  "timer.fired": (ev) => (isString(ev.timerId) && isNumber(ev.generation) ? null : "a timer names its id and generation"),
  external: (ev) => (isString(ev.event) && isString(ev.key) ? null : "an outside event names its event and key"),
  "run.cancelled": (ev) => (optional(ev.reason, isString) && optional(ev.cascade, isString) && optional(ev.erase, (v) => v === true) ? null : "reason and cascade are strings, and erase is true"),
  "effect.resolved": (ev) => (isString(ev.effectId) && typeof ev.applied === "boolean" ? null : "a resolution names its effect and whether it was applied"),
  "call.started": (ev) => (!isString(ev.callId) || !isNumber(ev.attempt) ? "a call start names its call and attempt" : !isObject(ev.outcome) || !isString(ev.outcome.status) ? "outcome must be an object with a status" : null),
  "call.settled": (ev) => (isString(ev.callId) && isString(ev.childRunId) && isObject(ev.end) ? null : "a call's end names its call, its child and the end"),
  "call.cancelled": (ev) => (isString(ev.reason) ? null : "reason must be a string"),
  "run.revoked": (ev) => (isString(ev.version) && isString(ev.hash) && optional(ev.message, isString) ? null : "a revocation names the version and hash"),
};

/**
 * Why `event` cannot be read, or null: an object with an id, a time and an
 * actor (an id, a kind and a list of roles), and for its type the fields the
 * core reads. An unknown type is left to the core, which refuses it.
 */
export function eventShapeProblem(event: unknown): string | null {
  if (!isObject(event)) return "an event must be an object";
  if (!isString(event.id) || !isNumber(event.at)) return "an event has an id and a time";
  const actor = event.actor;
  if (!isObject(actor) || !isString(actor.id) || !isString(actor.kind) || !Array.isArray(actor.roles) || !actor.roles.every(isString)) {
    return "an event's actor has an id, a kind and a list of roles";
  }
  if (!optional(actor.authTime, (v) => isNumber(v) && v >= 0)) return "an actor's authTime is a time (epoch ms)";
  if (!optional(event.requestId, isString)) return "requestId must be a string";
  if (!optional(event.traceparent, isTraceparent)) return "traceparent must be a W3C traceparent";
  const fields = isString(event.type) && Object.prototype.hasOwnProperty.call(FIELDS, event.type) ? FIELDS[event.type] : undefined;
  return fields ? fields(event) : null;
}
