/**
 * The bridge to the engine: an action port that performs connector
 * operations as flow actions.
 *
 * It takes the approved-action envelope of `@aaply/action-contract`
 * (`run(approved, signal)`). `approved.action.id` is
 * `"<connectorId>.<operation>"`. Before an operation runs, the port checks
 * again what the contract says every performer checks: the envelope itself
 * (version, shape, times, input digest, review evidence and what it is bound
 * to), that it is for this performer and its proof verifies under the host's
 * {@link ConnectorActionPortOptions.verifier}, that it serves
 * the operation contract the flow pinned, that the flow uses the operation as
 * declared (a write is never run as a read, a check is a read, and an undo is
 * the operation the undone write declares as its undo, which de-duplicates and
 * needs no review), that the review meets the
 * operation's risk floor, and that the input is valid. It then binds the
 * flow's connection role to a real connection through the host's
 * {@link ConnectionResolver} and checks that the connection's consent covers
 * every scope the connector needs. The credential itself is fetched only when
 * the handler makes a request, and is added to that request by the kit.
 *
 * An attempt of a write that does not de-duplicate is claimed in the host's
 * {@link ReplayGuard} just before it is performed, so the same envelope
 * delivered twice is performed once. A port that serves such a write needs
 * one: it cannot be created without (short of the unsafe opt-out).
 *
 * A refusal before anything is sent is `final` or `retryable`, never
 * `unknown`. Every path ends in an `ActionOutcome`; `run` never throws.
 */

import {
  ACTION_CONTRACT_VERSIONS,
  environmentAllows,
  isActionOutcome,
  isEnvironmentKind,
  isTraceparent,
  verifyApprovedAction,
  operationDigest,
  refuse,
  riskAtLeast,
  type ActionOutcome,
  type ApprovedAction,
  type ApprovedActionVerifier,
  type ActingFor,
  type ActionPortDescription,
  type ActionPurpose,
  type EnvironmentKind,
  type JsonObject,
  type Scope,
} from "@aaply/action-contract";
import { checkBlobInput, type BlobLimits, type BlobStore } from "./blobs.js";
import { systemClock, type Clock } from "./clock.js";
import { compileConnector, operationContractOf, scopesNeeded, type AuthSpec, type CompiledConnector, type CompiledOperation, type Connector } from "./definition.js";
import { adoptConnectorError, isCheckOnlyCode } from "./errors.js";
import type { FetchLike, HttpLimits } from "./http.js";
import { checkInput, invokeOperation } from "./invoke.js";
import type { ConnectorLogSink } from "./log.js";
import type { SignableRequest } from "./signing.js";

/** What the port asks the host when it needs a connection. */
export interface ConnectionQuery {
  /** The flow's connection role (`approved.connection.role`), or null when the flow names none. */
  role: string | null;
  actingFor: ActingFor;
  /** The run's person as `domain:id`. Always set for `endUser` calls: resolve that person's own connection. */
  subjectId: string | null;
  connectorId: string;
  /**
   * The kind of environment the call runs in (the envelope's signed
   * `environment`): return the account for that kind. A connection of
   * another kind is refused (`connect/environment-mismatch`).
   */
  environment: EnvironmentKind;
}

export interface ResolvedConnection {
  connectionId: string;
  /** Scopes the account owner consented to. */
  grantedScopes: readonly string[];
  /**
   * Whose account this is: the end user's subject id, or null for the
   * business's own. Required for `endUser` calls and checked against the
   * run's person; a business call refuses a person's connection.
   */
  subjectId?: string | null;
  /**
   * The kind of environment this account serves: a sandbox account is
   * `preview` or `test`. Left out, it is `production`, strictly: a preview
   * or test call is refused it, as a production call is refused a sandbox.
   */
  environment?: EnvironmentKind;
}

/**
 * Binds a flow's connection role to a real connection in a tenant scope.
 * Returns null when there is none. Implemented by the host (its connection
 * store); never by connector code.
 */
export type ConnectionResolver = (scope: Scope, query: ConnectionQuery) => ResolvedConnection | null | Promise<ResolvedConnection | null>;

export interface CredentialRequest {
  scope: Scope;
  /** The kind of environment the call runs in, which the connection serves. */
  environment: EnvironmentKind;
  connectorId: string;
  connectionId: string;
  auth: AuthSpec;
  signal: AbortSignal;
}

/**
 * Supplies the headers that authenticate a connection's requests, e.g.
 * `{ authorization: "Bearer ..." }`, refreshing tokens as needed. Called at
 * most once per operation call, and only when the handler makes a request.
 * Throw a `ConnectorError` to report a problem (for example `final` when the
 * account must be reconnected); anything else counts as retryable.
 */
export interface CredentialProvider {
  headers(request: CredentialRequest): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /**
   * Optional: refreshes the connection's credential (an OAuth refresh-token
   * grant, say) and returns the new headers. Called when a credentialed
   * request answers 401, at most once per operation call; that request is
   * then sent once more. A 401 was not applied, so sending it again is safe
   * for a write. A second 401 is the answer (`http/401`, final). Throw a
   * `ConnectorError` as from `headers` (`final` when the account must be
   * reconnected).
   */
  refresh?(request: CredentialRequest): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /**
   * Optional: signs a request, for a service that authenticates each request
   * by a signature over it (AWS Signature Version 4, say), and returns the
   * headers to add (`authorization`, `x-amz-date`, `x-amz-content-sha256`).
   * Gets the credential request and the request exactly as it will be sent
   * (`method`, `url`, `headers`, `body` as bytes or null). Called last, after
   * the body and the credential headers are final, for every credentialed
   * request: each same-origin redirect hop and the resend after `refresh` is
   * signed afresh. What it signed is what is sent. The handler never sees it
   * or the headers it adds, and they never go to another origin. Throw a
   * `ConnectorError` to answer with it; anything else thrown is
   * `connect/sign-failed` (retryable). Headers that are not strings, or that
   * name one the platform sets (`host`, `content-length`, ...), are
   * `connect/credential-invalid` (final).
   */
  sign?(request: SignRequest): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
}

/** What `CredentialProvider.sign` gets: whose credential, and the request to sign. */
export interface SignRequest extends CredentialRequest, SignableRequest {}

/**
 * A call a handler deferred with `ctx.defer(ref)`. The host keeps it, and
 * when the service reports the result it sends the engine a completion with
 * `token` (the engine's `completeAction`). The token completes only this
 * attempt of this effect; keep it as private as a session.
 *
 * Match the service's later report on {@link deferredKey} (scope, connector,
 * connection and `ref`), never on `ref` alone: a service's references are
 * unique only within one account, so two people's connections (two Gmail or
 * Drive accounts) can report the same `ref`.
 */
export interface DeferredAction {
  scope: Scope;
  runId: string;
  effectId: string;
  attempt: number;
  /** `<connectorId>.<operation>`. */
  action: string;
  purpose: ActionPurpose;
  /** The connector's id. */
  connector: string;
  /** The real connection the call was made with (the resolver's `connectionId`). */
  connectionId: string;
  /** The service's reference, as the handler gave it. */
  ref: string;
  /** The approved action's `completion.token`. */
  token: string;
  /**
   * The operation's declared completion window (`completion.windowMs`), when
   * it declares one: the engine waits that long, from its `pending` answer,
   * before it puts the effect in doubt. Keep the deferral at least that long;
   * a report after it is still recorded (`late`).
   */
  windowMs?: number;
}

/**
 * The key a host stores a {@link DeferredAction} under and looks a service's
 * report up by: its scope, connector, connection and `ref`. A report is
 * attributed to the connection it arrived for (the webhook's account), so
 * one account's report never completes another's call with the same `ref`.
 */
export function deferredKey(deferral: Pick<DeferredAction, "scope" | "connector" | "connectionId" | "ref">): string {
  return JSON.stringify([deferral.scope.tenantId, deferral.scope.appId, deferral.scope.environmentId, deferral.connector, deferral.connectionId, deferral.ref]);
}

/**
 * Remembers which attempts of writes that do not de-duplicate were already
 * taken, so a replayed envelope is never performed twice. Supplied by the
 * host; it must be shared by every instance of the port that serves one
 * engine (a database row with a unique key, a Redis `SET NX PX`), or a replay
 * sent to another instance is not caught. {@link memoryReplayGuard} suits a
 * single process.
 */
export interface ReplayGuard {
  /**
   * Claims `key` until `until` (epoch ms; the envelope's deadline, after
   * which it is refused as late anyway). Answers true for the first claim and
   * false for any later one. Throw or reject when the claim cannot be made:
   * the call is then refused as retryable, and nothing is sent.
   */
  claim(key: string, until: number): boolean | Promise<boolean>;
}

/** A {@link ReplayGuard} in this process's memory, dropping keys once their time has passed. For one process and for tests. */
export function memoryReplayGuard(clock: Clock = systemClock): ReplayGuard {
  const claimed = new Map<string, number>();
  return {
    claim(key, until) {
      const now = clock.now();
      if (claimed.size >= 1024) for (const [k, t] of claimed) if (t <= now) claimed.delete(k);
      const held = claimed.get(key);
      if (held !== undefined && held > now) return false;
      claimed.set(key, until);
      return true;
    },
  };
}

/** The key one attempt of one effect is claimed under: its scope, effect id and attempt. */
export function replayKey(scope: Scope, effectId: string, attempt: number): string {
  return JSON.stringify([scope.tenantId, scope.appId, scope.environmentId, effectId, attempt]);
}

export interface ConnectorActionPortOptions {
  /**
   * This performer's audience. The engine's host signs each envelope for one
   * audience, and an envelope for any other is refused (`connect/wrong-audience`).
   */
  audience: string;
  /**
   * Verifies an envelope's proof: the counterpart of the engine host's
   * signer (for example `hmacActionVerifier` from `@aaply/action-contract`).
   * An envelope that does not verify is refused (`connect/proof-invalid`).
   */
  verifier: ApprovedActionVerifier;
  /**
   * Claims each attempt of a write whose operation does not de-duplicate,
   * so a replayed envelope is refused (`connect/replayed`). Required when
   * any operation the port serves is such a write: creating the port
   * without one throws, unless {@link unsafeAllowReplays} says otherwise.
   */
  replayGuard?: ReplayGuard;
  /**
   * **Unsafe.** Serve writes that do not de-duplicate without a
   * {@link replayGuard}: an envelope replayed before its deadline (by a
   * retrying network, a proxy or anyone holding a copy) is then performed
   * again, sending a message or a payment twice. Only for tests, or a
   * performer that only an engine in the same process can reach. Default
   * false.
   */
  unsafeAllowReplays?: boolean;
  /** How far this clock may be behind the engine's. Default `DEFAULT_CLOCK_SKEW_MS` (30 s). */
  skewMs?: number;
  connectors: readonly Connector[];
  connections: ConnectionResolver;
  credentials: CredentialProvider;
  /**
   * Receives every deferred call, before the port answers `pending`. Without
   * it (or when it throws), a deferral cannot be completed, so the call
   * answers `unknown` for a write (the service may have done it) and
   * `retryable` for a read.
   */
  deferred?: (deferral: DeferredAction) => void | Promise<void>;
  /** Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Must be the runtime's clock: deadlines are measured on it. Default system time. */
  clock?: Clock;
  log?: ConnectorLogSink;
  limits?: Partial<HttpLimits>;
  /**
   * Largest output an operation may return, in bytes of JSON. Default
   * `MAX_ACTION_OUTPUT_BYTES` (1 MiB), the engine's own cap. A read over it
   * fails (`connect/output-too-large`); a write over it answers `ok` with its
   * output withheld.
   */
  maxOutputBytes?: number;
  observer?: { error?(error: unknown, where: string): void };
  /**
   * The host's file store, for handlers' `ctx.blobs` (ADR-0008). Without it,
   * `ctx.blobs` throws `connect/blob-no-store`; file references in an input
   * are checked against the envelope's scope either way.
   */
  blobs?: BlobStore;
  /** Bounds on what one call stores and reads. Default `DEFAULT_BLOB_LIMITS`. */
  blobLimits?: Partial<BlobLimits>;
  /**
   * Given the work the kit does after it answers: the deletes of what a call
   * stored and its answer does not name, which never hold up the answer. A
   * host on a platform that stops work once a response is sent passes the
   * platform's own `waitUntil`, so the deletes still finish.
   */
  waitUntil?(work: Promise<void>): void;
}

/** The connector kit's action port. */
export interface ConnectorActionPort {
  /** Performs an approved action (contract 1). Never throws. */
  run(approved: ApprovedAction, signal?: AbortSignal): Promise<ActionOutcome>;
  /** The envelope versions this port serves (`ACTION_CONTRACT_VERSIONS`), so the engine sends one of them. */
  describe(): ActionPortDescription;
}

function final(code: string, message: string): ActionOutcome {
  return { status: "final", error: { code, message } };
}

function isResolved(value: unknown): value is ResolvedConnection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.connectionId === "string" &&
    v.connectionId.length > 0 &&
    Array.isArray(v.grantedScopes) &&
    v.grantedScopes.every((s) => typeof s === "string") &&
    (v.subjectId === undefined || v.subjectId === null || typeof v.subjectId === "string") &&
    (v.environment === undefined || isEnvironmentKind(v.environment))
  );
}

/** One call, as the checks read it. */
interface Call {
  scope: Scope;
  /** The kind of environment the call runs in. */
  environment: EnvironmentKind;
  runId: string;
  subjectId: string | null;
  actingFor: ActingFor;
  signal: AbortSignal;
  deadline: number;
  effectId: string;
  attempt: number;
  purpose: ActionPurpose;
  action: string;
  role: string | null;
  effect: "read" | "write";
  input: unknown;
  idempotencyKey: string;
  idempotent: boolean;
  timeoutMs: number;
  /** The completion token, when the envelope carries one. */
  token?: string;
  /** Claim the attempt in the replay guard until then, if the operation does not de-duplicate. */
  claimUntil?: number;
  /** For a `compensate`: the action id of the write it undoes. */
  undoes?: string;
  /** A well-formed `traceparent` the call carried. */
  traceparent?: string;
}

/**
 * True when `outcome` has the shape of an outcome the kit builds: plain JSON
 * with one of the five statuses ({@link isActionOutcome}), an `output` when
 * `ok`, a string `ref` (or none) when `pending`, and otherwise an `error`
 * with a string `code` and `message`. Never throws.
 */
function wellFormed(outcome: unknown): outcome is ActionOutcome {
  if (!isActionOutcome(outcome)) return false;
  const o = outcome as Record<string, unknown>;
  if (o.status === "ok") return "output" in o;
  if (o.status === "pending") return o.ref === undefined || typeof o.ref === "string";
  const error = o.error;
  return typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).code === "string" && typeof (error as Record<string, unknown>).message === "string";
}

/**
 * Creates the action port the flow runtime calls for connector actions.
 * Throws when an option is missing or wrong: no audience or verifier, a
 * connector listed twice, or a write that does not de-duplicate served
 * without a `replayGuard` (unless `unsafeAllowReplays`).
 */
export function createConnectorActionPort(options: ConnectorActionPortOptions): ConnectorActionPort {
  if (typeof options.audience !== "string" || options.audience.length === 0) throw new Error("createConnectorActionPort needs an audience");
  if (typeof options.verifier?.verify !== "function") throw new Error("createConnectorActionPort needs a verifier");
  const table = new Map<string, CompiledConnector>();
  for (const connector of options.connectors) {
    const c = compileConnector(connector);
    if (table.has(c.connector.id)) throw new Error(`connector "${c.connector.id}" is listed twice`);
    table.set(c.connector.id, c);
  }
  // A replayed envelope of a write that does not de-duplicate would be performed again.
  if (options.replayGuard === undefined && options.unsafeAllowReplays !== true) {
    for (const c of table.values()) {
      for (const entry of c.operations.values()) {
        if (entry.operation.effect === "write" && !entry.operation.idempotent) {
          throw new Error(`createConnectorActionPort needs a replayGuard: "${c.connector.id}.${entry.name}" is a write that does not de-duplicate`);
        }
      }
    }
  }
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const clock = options.clock ?? systemClock;
  const report = (error: unknown, where: string) => {
    try {
      options.observer?.error?.(error, where);
    } catch {
      // Reporting must not break the call.
    }
  };
  const find = (action: string): { compiled: CompiledConnector; entry: CompiledOperation } | null => {
    const dot = action.indexOf(".");
    const compiled = dot > 0 ? table.get(action.slice(0, dot)) : undefined;
    const entry = compiled?.operations.get(action.slice(dot + 1));
    return compiled && entry ? { compiled, entry } : null;
  };

  /** The checks of every call: use as declared, then the connection. */
  async function perform(call: Call, compiled: CompiledConnector, entry: CompiledOperation): Promise<ActionOutcome> {
    const connector = compiled.connector;
    const op = entry.operation;
    const action = call.action;

    // The flow must use the operation as declared.
    if (call.effect === "read" && op.effect === "write") {
      return final("connect/effect-mismatch", `${action} changes things; the flow must declare it as a write.`);
    }
    if (call.purpose === "compensate" && op.effect !== "write") {
      return final("connect/effect-mismatch", `${action} is a read and cannot undo anything.`);
    }
    if (call.purpose === "reconcile" && op.effect !== "read") {
      return final("connect/effect-mismatch", `${action} changes things; a check must be a read.`);
    }
    if (call.purpose === "compensate") {
      // An undo runs unreviewed (nobody can review it while a run is cancelled or a hold
      // released), and is sent again after an unknown answer: only a declared undo that
      // de-duplicates and needs no review may be one.
      if (call.undoes !== undefined) {
        // It must be the undo the undone write's own operation declares, not another write's.
        const undone = find(call.undoes);
        if (!undone || undone.compiled !== compiled || undone.entry.operation.compensate !== entry.name) {
          return final("connect/effect-mismatch", `${action} is not the undo ${call.undoes} declares.`);
        }
      } else if (![...compiled.operations.values()].some((o) => o.operation.compensate === entry.name)) {
        // An envelope that does not say which write it undoes: only that some operation declares this undo is checked.
        return final("connect/effect-mismatch", `${action} is not declared as the undo of any operation.`);
      }
      if (!op.idempotent) return final("connect/idempotency-mismatch", `${action} does not de-duplicate, so it cannot be an undo the engine may send again.`);
      if (op.riskFloor !== "none") return final("connect/approval-invalid", `${action} needs a review, which nobody can give to an undo.`);
    }
    if (call.purpose === "run" && op.effect === "write" && call.idempotent && !op.idempotent) {
      return final("connect/idempotency-mismatch", `${action} is not idempotent; the flow must not mark it idempotent.`);
    }

    const refused = checkInput(entry, call.input) ?? checkBlobInput(call.input, call.scope);
    if (refused) return refused;

    // Bind the connection role to a real connection.
    if (call.actingFor === "endUser" && !call.subjectId) {
      return final("connect/no-subject", "This action acts for a person, but the run has none.");
    }
    const role = call.role;
    let resolved: unknown;
    try {
      resolved = await options.connections(call.scope, { role, actingFor: call.actingFor, subjectId: call.subjectId, connectorId: connector.id, environment: call.environment });
    } catch (error) {
      // The resolver may refuse for the account, never with a code only the kit's own checks answer.
      const failure = adoptConnectorError(error);
      if (failure && !isCheckOnlyCode(failure.code)) return failure.withKind(failure.kind === "unknown" ? "retryable" : failure.kind).toOutcome();
      report(error, "connector-port:connections");
      return { status: "retryable", error: { code: "connect/resolver-error", message: "The connection could not be looked up." } };
    }
    if (resolved === null || resolved === undefined) {
      return final("connect/no-connection", role ? `No ${connector.title} connection is set up for "${role}".` : `No ${connector.title} connection is set up.`);
    }
    if (!isResolved(resolved)) {
      report(new Error("connection resolver returned an invalid value"), "connector-port:connections");
      return final("connect/no-connection", `The ${connector.title} connection is not usable.`);
    }
    const owner = resolved.subjectId ?? null;
    if (call.actingFor === "endUser" ? owner !== call.subjectId : owner !== null) {
      return final(
        "connect/not-own-connection",
        call.actingFor === "endUser" ? "The connection does not belong to the person this run is for." : "A business action cannot use a person's own connection.",
      );
    }
    // A sandbox account never stands in for a live one, nor a live one for a sandbox.
    if (!environmentAllows(call.environment, resolved.environment)) {
      return refuse("connect/environment-mismatch", `The ${connector.title} connection is not set up for this environment.`, {
        detail: `a ${call.environment} call, and a ${resolved.environment ?? "production (undeclared)"} connection`,
      });
    }
    if (connector.auth.kind === "oauth2") {
      // Only what this operation needs: a scope added for another operation asks only its users to consent again.
      const granted = new Set(resolved.grantedScopes);
      const missing = scopesNeeded(connector, op).filter((s) => !granted.has(s));
      if (missing.length > 0) {
        return final("connect/reconsent", `The ${connector.title} connection must be authorised again to allow: ${missing.join(", ")}.`);
      }
    }

    // Last before anything is sent: one attempt of a write that does not de-duplicate is performed once.
    if (call.claimUntil !== undefined && op.effect === "write" && !op.idempotent && options.replayGuard) {
      let first: unknown;
      try {
        first = await options.replayGuard.claim(replayKey(call.scope, call.effectId, call.attempt), call.claimUntil);
      } catch (error) {
        report(error, "connector-port:replay-guard");
        return refuse("connect/unavailable", "This action could not be checked right now.", { detail: "the replay guard failed" });
      }
      if (first !== true) return refuse("connect/replayed", "This action was already received.", { detail: `attempt ${call.attempt} of ${call.effectId} was delivered before` });
    }

    const connectionId = resolved.connectionId;
    const auth = connector.auth;
    let credential: Promise<Readonly<Record<string, string>>> | undefined;
    const credentials = () =>
      (credential ??=
        auth.kind === "none"
          ? Promise.resolve({})
          : Promise.resolve().then(() => options.credentials.headers({ scope: call.scope, environment: call.environment, connectorId: connector.id, connectionId, auth, signal: call.signal })));
    const provider = options.credentials;
    const refreshCredentials =
      auth.kind !== "none" && typeof provider.refresh === "function"
        ? () => Promise.resolve().then(() => provider.refresh!({ scope: call.scope, environment: call.environment, connectorId: connector.id, connectionId, auth, signal: call.signal }))
        : undefined;
    const sign =
      auth.kind !== "none" && typeof provider.sign === "function"
        ? (request: SignableRequest) => Promise.resolve().then(() => provider.sign!({ scope: call.scope, environment: call.environment, connectorId: connector.id, connectionId, auth, signal: call.signal, ...request }))
        : undefined;

    const outcome = await invokeOperation(
      connector,
      entry.name,
      call.input,
      {
        fetch: fetchImpl,
        clock,
        signal: call.signal,
        deadline: Math.min(call.deadline, clock.now() + call.timeoutMs),
        idempotencyKey: call.idempotencyKey,
        connection: { id: connectionId, role },
        credentials,
        ...(refreshCredentials !== undefined ? { refreshCredentials } : {}),
        ...(sign !== undefined ? { sign } : {}),
        ...(call.traceparent !== undefined ? { traceparent: call.traceparent } : {}),
        ...(options.log ? { log: options.log } : {}),
        logContext: { effectId: call.effectId, attempt: call.attempt },
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        onError: report,
        scope: call.scope,
        ...(options.blobs ? { blobs: options.blobs } : {}),
        ...(options.blobLimits ? { blobLimits: options.blobLimits } : {}),
        ...(options.waitUntil ? { waitUntil: (work: Promise<void>) => options.waitUntil!(work) } : {}),
      },
      true,
    );
    // Every outcome the kit builds has this shape; one it did not build never reaches the engine.
    if (!wellFormed(outcome)) {
      report(new Error(`${action}: the operation call answered something that is not an outcome the kit builds`), "connector-port:outcome");
      const error = { code: "connect/internal", message: "The connector kit had a problem." };
      return op.effect === "write" ? { status: "unknown", error } : { status: "retryable", error };
    }
    if (outcome.status === "pending") return deferral(call, op.effect, outcome.ref, connector.id, connectionId, op.completion?.windowMs);
    // A 429 on a person's own connection is that account's quota: pause only it, not every lane.
    if (outcome.status === "retryable" && outcome.limit === undefined && outcome.error.code === "http/429" && call.actingFor === "endUser") return { ...outcome, limit: "connection" };
    return outcome;
  }

  /** A deferred call is pending only when someone will complete it. */
  async function deferral(call: Call, effect: "read" | "write", ref: string | undefined, connectorId: string, connectionId: string, windowMs: number | undefined): Promise<ActionOutcome> {
    const lost = (detail: string): ActionOutcome => {
      const error = { code: "connect/no-completion", message: "The service will finish this later, but its result cannot be received.", detail };
      return effect === "write" ? { status: "unknown", error } : { status: "retryable", error };
    };
    if (ref === undefined) return lost("the handler deferred without a reference");
    if (call.token === undefined) return lost("the call carried no completion token ");
    if (!options.deferred) return lost("the port has no deferred sink");
    try {
      await options.deferred({
        scope: call.scope,
        runId: call.runId,
        effectId: call.effectId,
        attempt: call.attempt,
        action: call.action,
        purpose: call.purpose,
        connector: connectorId,
        connectionId,
        ref,
        token: call.token,
        ...(windowMs !== undefined ? { windowMs } : {}),
      });
    } catch (error) {
      report(error, "connector-port:deferred");
      return lost("the deferred sink failed");
    }
    return { status: "pending", ref };
  }

  async function runApproved(value: unknown, signal: AbortSignal): Promise<ActionOutcome> {
    const checked = await verifyApprovedAction(value, {
      now: clock.now(),
      audience: options.audience,
      verifier: options.verifier,
      ...(options.skewMs !== undefined ? { skewMs: options.skewMs } : {}),
    });
    if (!checked.ok) return checked.outcome;
    const approved = checked.action;
    const action = approved.action.id;
    const found = find(action);
    if (!found) return refuse("connect/unknown-action", `No connector provides "${action}".`);
    const op = found.entry.operation;
    if (approved.action.contract !== undefined && approved.action.contract !== operationDigest(operationContractOf(found.compiled.connector, found.entry.name)!)) {
      return refuse("connect/contract-mismatch", `${action} has changed since this flow was published.`, { detail: `pinned ${approved.action.contract}` });
    }
    // The review must be at least what the operation asks for (the envelope check matched it to the input).
    if (approved.purpose === "run" && op.effect === "write" && !riskAtLeast(approved.action.risk, op.riskFloor)) {
      return refuse("connect/approval-invalid", "This action needs a review first.", { detail: `risk ${approved.action.risk} is below the floor ${op.riskFloor}` });
    }
    return perform(
      {
        scope: approved.scope,
        environment: approved.environment,
        runId: approved.origin.runId,
        subjectId: approved.subject ? `${approved.subject.domain}:${approved.subject.id}` : null,
        actingFor: approved.connection.actingFor,
        signal,
        deadline: approved.deadline,
        effectId: approved.effectId,
        attempt: approved.attempt,
        purpose: approved.purpose,
        action,
        role: approved.connection.role,
        effect: approved.action.effect,
        input: approved.input as JsonObject,
        idempotencyKey: approved.idempotencyKey,
        idempotent: approved.action.idempotent,
        timeoutMs: approved.timeoutMs,
        ...(approved.completion ? { token: approved.completion.token } : {}),
        claimUntil: approved.deadline,
        ...(approved.undoes !== undefined ? { undoes: approved.undoes } : {}),
        ...(isTraceparent(approved.traceparent) ? { traceparent: approved.traceparent } : {}),
      },
      found.compiled,
      found.entry,
    );
  }

  async function run(a: unknown, b?: unknown): Promise<ActionOutcome> {
    try {
      return await runApproved(a, b instanceof AbortSignal ? b : new AbortController().signal);
    } catch (error) {
      report(error, "connector-port");
      const message = "The connector kit had a problem.";
      const effect = (a as ApprovedAction | undefined)?.action?.effect;
      return effect === "read" ? { status: "retryable", error: { code: "connect/internal", message } } : { status: "unknown", error: { code: "connect/internal", message } };
    }
  }

  const describe = (): ActionPortDescription => ({ contracts: [...ACTION_CONTRACT_VERSIONS] });
  return { run, describe } as ConnectorActionPort;
}
