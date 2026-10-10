/**
 * Running one operation: check the input, give the handler its context,
 * bound it by the deadline, check the output, and turn whatever happened
 * into an action outcome. Shared by the action port and the test kit, so
 * tests exercise exactly what production runs.
 *
 * - Input that does not match the input schema: `final`, and the handler never runs.
 * - The handler returns: `ok`, once the output matches the output schema. A
 *   mismatch is `final` for a read and `unknown` for a write (it may have happened).
 *   An output larger than `maxOutputBytes` fails a read (`final`,
 *   `connect/output-too-large`); a write's is withheld (`ok` with `output: null`
 *   and `withheld: { bytes }`), since the write happened, and logged.
 * - The handler throws a `ConnectorError`: its outcome. For a write that may
 *   already have changed something, `final` becomes `unknown`, and so does
 *   `retryable` unless the write is idempotent (a retry is then harmless).
 * - The handler throws anything else, or runs out of time: `retryable`, or
 *   `unknown` for a write that may already have changed something. So does
 *   a `ConnectorError` whose code only the kit's checks before running answer
 *   (`isCheckOnlyCode`: `connect/contract-unsupported`, `connect/replayed`,
 *   any `flow/` code, ...), whoever threw it during the call: code `connect/handler-error`.
 *   A thrown `ConnectorError` is read for its fields only, once
 *   (`adoptConnectorError`); its methods are never called, so it cannot
 *   answer one code to that check and another in its outcome.
 * - The handler calls `ctx.defer(ref)`: `pending` with that `ref`, whatever it does next.
 * - File references (ADR-0008): one in the input must be bound to the call's
 *   scope (`final`, `connect/invalid-input`); one in an `ok` output must be one
 *   the call was given or stored (`connect/bad-output`); what the call stored
 *   and the output does not name is deleted once the call ends, without
 *   holding up the answer. An answer ready only after the deadline names
 *   nothing the call stored: a read's is `retryable` (`connect/timeout`) and a
 *   write's output is withheld, and the files are deleted.
 */

import { MAX_ACTION_OUTPUT_BYTES, checkJson, cloneJson, formatPath, isJsonObject, jsonByteLength, validateValue, type ActionOutcome, type JsonObject, type JsonValue, type Scope } from "@aaply/action-contract";
import { BlobSession, checkBlobInput, type BlobLimits, type BlobStore } from "./blobs.js";
import { systemClock, type Clock } from "./clock.js";
import { compileConnector, type CompiledOperation, type Connector, type OperationContext } from "./definition.js";
import { ConnectorError, adoptConnectorError, isCheckOnlyCode } from "./errors.js";
import { DEFAULT_HTTP_LIMITS, HttpSession, userAgentFor, type FetchLike, type HttpLimits } from "./http.js";
import { createConnectorLog, safe, type ConnectorLog, type ConnectorLogSink } from "./log.js";
import type { RequestSigner } from "./signing.js";

/** Thrown by `ctx.defer`; never escapes the kit. */
class DeferredCall extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super("the operation's result will arrive later");
    this.name = "DeferredCall";
    this.ref = ref;
  }
}

export interface InvokeOptions {
  fetch: FetchLike;
  clock?: Clock;
  /** Aborts the call (the engine gave up on it). */
  signal?: AbortSignal;
  /** Absolute deadline on `clock`. */
  deadline: number;
  idempotencyKey: string;
  connection: { id: string; role: string | null };
  /** The connection's credential headers; called lazily, only if the handler makes a request. */
  credentials: () => Promise<Readonly<Record<string, string>>>;
  /** Fresh credential headers after a 401; called at most once per call (see `CredentialProvider.refresh`). */
  refreshCredentials?: () => Promise<Readonly<Record<string, string>>>;
  /** Signs each credentialed request, last (see `CredentialProvider.sign`). */
  sign?: RequestSigner;
  /** The engine's well-formed `traceparent`: given to the handler, and sent to the service when the connector has `propagateTrace`. */
  traceparent?: string;
  log?: ConnectorLogSink;
  logContext?: { effectId?: string; attempt?: number };
  limits?: Partial<HttpLimits>;
  /** Largest output kept, in bytes of JSON. Default `MAX_ACTION_OUTPUT_BYTES` (1 MiB), the engine's own cap. */
  maxOutputBytes?: number;
  /** Unexpected errors (handler bugs), for the host's error reporting. */
  onError?: (error: unknown, where: string) => void;
  /** Test hook: called with the exact input and context right before the handler runs. */
  onHandler?: (input: JsonObject, ctx: OperationContext) => void;
  /** The call's scope: the only scope its file references may be bound to. */
  scope?: Scope;
  /** The host's file store, for `ctx.blobs`. */
  blobs?: BlobStore;
  blobLimits?: Partial<BlobLimits>;
  /** Given the deletes that run after the answer (see `ConnectorActionPortOptions.waitUntil`). */
  waitUntil?: (work: Promise<void>) => void;
}

function final(code: string, message: string): ActionOutcome {
  return { status: "final", error: { code, message } };
}

const REF_RE = /^[\x21-\x7e]{1,256}$/;

/** The operation an action id names, or `null`. */
export function findOperation(connector: Connector, operation: string): CompiledOperation | null {
  return compileConnector(connector).operations.get(operation) ?? null;
}

/** Checks an input against the operation's input schema. `null` when valid. */
export function checkInput(entry: CompiledOperation, input: unknown): ActionOutcome | null {
  if (checkJson(input) !== null || !isJsonObject(input as JsonValue)) return final("connect/invalid-input", "The input must be a JSON object.");
  const issues = validateValue(entry.operation.input, input as JsonObject);
  const first = issues[0];
  if (first) return final("connect/invalid-input", `Invalid input at ${formatPath(first.path)}: ${first.message}.`);
  return null;
}

function checkOutput(entry: CompiledOperation, value: unknown, maxBytes: number, log: ConnectorLog): ActionOutcome {
  const output = value === undefined ? null : value;
  const write = entry.operation.effect === "write";
  const bad = (message: string): ActionOutcome => (write ? { status: "unknown", error: { code: "connect/bad-output", message } } : final("connect/bad-output", message));
  // Copied once, and every check below reads the copy: a getter answers the checks and the kept output alike.
  // A getter that throws, here or in the copy, is the handler's bad output, not a fault of the kit.
  let copy: JsonValue;
  try {
    const shapeIssue = checkJson(output);
    if (shapeIssue) return bad(`The connector returned a value that is not plain JSON at ${formatPath(shapeIssue.path)}.`);
    copy = cloneJson(output as JsonValue);
  } catch {
    return bad("The connector returned a value that could not be read as plain JSON.");
  }
  const jsonIssue = checkJson(copy);
  if (jsonIssue) return bad(`The connector returned a value that is not plain JSON at ${formatPath(jsonIssue.path)}.`);
  const bytes = jsonByteLength(copy);
  if (bytes > maxBytes) {
    log.warn("output.withheld", { bytes: safe(bytes), max: safe(maxBytes), effect: safe(entry.operation.effect) });
    // A write happened, so it is applied, but its output is not kept; a read is simply too large to use.
    if (write) return { status: "ok", output: null, withheld: { bytes } };
    return final("connect/output-too-large", `The connector's output is larger than ${maxBytes} bytes; name large content by reference instead.`);
  }
  const issues = validateValue(entry.operation.output, copy);
  const first = issues[0];
  if (first) return bad(`The connector returned an unexpected output at ${formatPath(first.path)}: ${first.message}.`);
  return { status: "ok", output: copy };
}

function failureOutcome(entry: CompiledOperation, session: HttpSession, error: unknown, report: () => void): ActionOutcome {
  const op = entry.operation;
  const changed = op.effect === "write" && session.mayHaveApplied;
  // Only the thrown value's fields, read once into a ConnectorError of the kit's own: never its methods.
  const failure = adoptConnectorError(error);
  // A code only the kit's checks before running answer ("nothing ran") is a fault when the call itself throws it.
  if (failure && !isCheckOnlyCode(failure.code)) {
    if (changed && (failure.kind === "final" || (failure.kind === "retryable" && !op.idempotent))) return failure.withKind("unknown").toOutcome();
    return failure.toOutcome();
  }
  report();
  const why = failure ? `the call threw ${failure.code}, which only the kit's checks before running answer` : ConnectorError.is(error) ? "the call threw a value with the kit's error brand whose fields are not a ConnectorError's" : undefined;
  const detail = why !== undefined ? { detail: why } : {};
  if (changed) return { status: "unknown", error: { code: "connect/handler-error", message: "The connector failed after it may have made the change.", ...detail } };
  return { status: "retryable", error: { code: "connect/handler-error", message: "The connector had a problem.", ...detail } };
}

/**
 * Runs `operation` of `connector` with `input`. Never throws.
 * `inputChecked` skips the input check when the caller already did it.
 */
export async function invokeOperation(connector: Connector, operation: string, input: unknown, options: InvokeOptions, inputChecked = false): Promise<ActionOutcome> {
  let entry: CompiledOperation | null;
  try {
    entry = findOperation(connector, operation);
  } catch (error) {
    options.onError?.(error, `connector:${String(connector?.id)}`);
    return final("connect/invalid-connector", "The connector is not valid.");
  }
  if (!entry) return final("connect/unknown-action", `${connector.id} has no operation "${operation}".`);
  if (!inputChecked) {
    const refused = checkInput(entry, input) ?? (options.scope ? checkBlobInput(input, options.scope) : null);
    if (refused) return refused;
  }

  const clock = options.clock ?? systemClock;
  const remaining = options.deadline - clock.now();
  if (options.signal?.aborted) return { status: "retryable", error: { code: "connect/cancelled", message: "The operation call was cancelled." } };
  if (!(remaining > 0)) return { status: "retryable", error: { code: "connect/timeout", message: "No time was left to run the operation." } };

  const where = `connector:${connector.id}.${operation}`;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, Math.min(remaining, 2_147_483_647));

  const log = createConnectorLog(options.log, {
    connectorId: connector.id,
    operation,
    connectionId: options.connection.id,
    ...(options.logContext?.effectId !== undefined ? { effectId: options.logContext.effectId } : {}),
    ...(options.logContext?.attempt !== undefined ? { attempt: options.logContext.attempt } : {}),
  });
  const session = new HttpSession({
    fetch: options.fetch,
    rules: entry.rules,
    effect: entry.operation.effect,
    signal: controller.signal,
    deadline: options.deadline,
    clock,
    credentials: options.credentials,
    credentialHosts: entry.credentialHosts,
    ...(options.refreshCredentials !== undefined ? { refreshCredentials: options.refreshCredentials } : {}),
    ...(options.sign !== undefined ? { sign: options.sign } : {}),
    ...(options.traceparent !== undefined && connector.propagateTrace === true ? { traceparent: options.traceparent } : {}),
    limits: { ...DEFAULT_HTTP_LIMITS, ...options.limits },
    userAgent: userAgentFor(connector),
    log,
  });
  const blobs = new BlobSession(
    {
      ...(options.blobs ? { store: options.blobs } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.blobLimits ? { limits: options.blobLimits } : {}),
      context: { connectorId: connector.id, operation, connectionId: options.connection.id, effectId: options.logContext?.effectId ?? null, signal: controller.signal },
      ...(options.onError ? { onError: options.onError } : {}),
    },
    input,
  );
  // Once a handler defers, the call is pending: whatever it does afterwards (catching the throw included) does not change that.
  let deferred: string | null = null;
  const ctx: OperationContext = Object.freeze({
    http: session.http,
    idempotencyKey: options.idempotencyKey,
    signal: controller.signal,
    deadline: options.deadline,
    connection: Object.freeze({ id: options.connection.id, role: options.connection.role }),
    log,
    ...(options.traceparent !== undefined ? { traceparent: options.traceparent } : {}),
    defer(ref: string): never {
      if (typeof ref !== "string" || !REF_RE.test(ref)) throw new TypeError("ctx.defer needs the service's reference: 1-256 printable ASCII characters, no spaces");
      if (deferred === null) deferred = ref;
      throw new DeferredCall(deferred);
    },
    blobs: blobs.blobs,
  });
  const aborted = new Promise<"aborted">((resolve) => {
    if (controller.signal.aborted) resolve("aborted");
    controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  try {
    const handlerInput = cloneJson(input as JsonObject);
    options.onHandler?.(handlerInput, ctx);
    const handler = entry.operation.handler;
    const settled = (async () => handler(handlerInput, ctx))().then(
      (value) => ({ value }) as const,
      (error: unknown) => ({ error }) as const,
    );
    const raced = await Promise.race([settled, aborted]);
    if (raced === "aborted") {
      const failure = state.timedOut
        ? ConnectorError.retryable("connect/timeout", "The operation did not finish in time.")
        : ConnectorError.retryable("connect/cancelled", "The operation call was cancelled.");
      return session.settle(failure).toOutcome();
    }
    if (deferred !== null) return { status: "pending", ref: deferred };
    if ("error" in raced) return failureOutcome(entry, session, raced.error, () => options.onError?.(raced.error, where));
    const answer = blobs.accept(checkOutput(entry, raced.value, options.maxOutputBytes ?? MAX_ACTION_OUTPUT_BYTES, log), entry.operation.effect);
    // Past the deadline the caller has stopped waiting: a file this answer names would be held by no run.
    if (clock.now() >= options.deadline) {
      const late = blobs.withholdLate(answer, entry.operation.effect);
      if (late !== answer) log.warn("output.late", { effect: safe(entry.operation.effect) });
      return late;
    }
    return answer;
  } catch (error) {
    // Only reachable through a throwing test hook or a bug in the kit.
    options.onError?.(error, where);
    return entry.operation.effect === "write" && session.mayHaveApplied
      ? { status: "unknown", error: { code: "connect/internal", message: "The connector kit had a problem." } }
      : { status: "retryable", error: { code: "connect/internal", message: "The connector kit had a problem." } };
  } finally {
    clearTimeout(timer);
    session.close();
    options.signal?.removeEventListener("abort", onParentAbort);
    // Stop anything the handler left running.
    controller.abort();
    // Delete what the call stored and its answer does not name, without holding the answer for it.
    const cleanup = blobs.close();
    try {
      options.waitUntil?.(cleanup);
    } catch (error) {
      options.onError?.(error, `${where}:waitUntil`);
    }
  }
}
