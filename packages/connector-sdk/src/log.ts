/**
 * Connector logging that redacts by default.
 *
 * Connectors handle other people's mail, files and notes, so a log line must
 * never carry a payload value by accident. Event names are fixed identifiers
 * (no interpolation), field names are identifiers, and every field value is
 * replaced by `"[redacted]"` unless the author wraps it in {@link safe}:
 *
 *   ctx.log.info("notes.listed", { count: safe(items.length), cursor: nextCursor });
 *   // → { event: "notes.listed", fields: { count: 3, cursor: "[redacted]" } }
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogPrimitive = string | number | boolean | null;

const SAFE = Symbol.for("@aaply/connector-sdk/safe");

/** A value the author vouches is not personal or secret (a count, a status, an enum). */
export interface SafeValue {
  readonly [SAFE]: true;
  readonly value: LogPrimitive;
}

/** Marks a value as fit to log as-is. Strings are cut to 200 characters. */
export function safe(value: LogPrimitive): SafeValue {
  return Object.freeze({ [SAFE]: true as const, value });
}

function isSafe(value: unknown): value is SafeValue {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SAFE] === true;
}

export interface ConnectorLogRecord {
  level: LogLevel;
  event: string;
  connectorId: string;
  operation: string;
  connectionId: string | null;
  effectId?: string;
  attempt?: number;
  fields: Record<string, LogPrimitive>;
}

/** Where log records go. Must not throw; errors are swallowed. */
export type ConnectorLogSink = (record: ConnectorLogRecord) => void;

/** The handler's logger (`ctx.log`). */
export interface ConnectorLog {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;
const MAX_FIELDS = 20;
const MAX_SAFE_STRING = 200;

export const REDACTED = "[redacted]";

/** Applies the redaction rules to one set of fields. */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, LogPrimitive> {
  const out: Record<string, LogPrimitive> = {};
  if (!fields || typeof fields !== "object") return out;
  let kept = 0;
  let dropped = 0;
  for (const name of Object.keys(fields)) {
    if (!NAME_RE.test(name) || kept >= MAX_FIELDS) {
      dropped++;
      continue;
    }
    const value = fields[name];
    let logged: LogPrimitive = REDACTED;
    if (isSafe(value)) {
      const v = value.value;
      if (typeof v === "string") logged = v.slice(0, MAX_SAFE_STRING);
      else if (typeof v === "number") logged = Number.isFinite(v) ? v : null;
      else if (typeof v === "boolean" || v === null) logged = v;
    }
    Object.defineProperty(out, name, { value: logged, enumerable: true, writable: true, configurable: true });
    kept++;
  }
  if (dropped > 0) out["_dropped"] = dropped;
  return out;
}

export interface LogContext {
  connectorId: string;
  operation: string;
  connectionId: string | null;
  effectId?: string;
  attempt?: number;
}

/** Builds the handler's logger over a sink. Without a sink, logging is a no-op. */
export function createConnectorLog(sink: ConnectorLogSink | undefined, context: LogContext): ConnectorLog {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (!sink) return;
    const record: ConnectorLogRecord = {
      level,
      event: typeof event === "string" && NAME_RE.test(event) ? event : "invalid-event",
      connectorId: context.connectorId,
      operation: context.operation,
      connectionId: context.connectionId,
      ...(context.effectId !== undefined ? { effectId: context.effectId } : {}),
      ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
      fields: redactFields(fields),
    };
    try {
      sink(record);
    } catch {
      // A broken sink must not break the operation.
    }
  };
  return Object.freeze({
    debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
    info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
    error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
  });
}
