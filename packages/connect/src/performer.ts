/**
 * The performer: takes an approved action, checks it, finds what it needs
 * in one store round trip, and runs it through the kit's action port for
 * the connector version the flow pinned.
 *
 * Order: the contract's checks and the engine's Ed25519 proof (before the
 * store is touched); one store read (kill switches, the scope's policy, the
 * installation, the connection with its sealed secret); then the kit port,
 * which checks everything again that the contract asks of a performer and
 * runs the operation. A write that does not de-duplicate is claimed in the
 * store just before it is sent. Every call is cut off two seconds before its
 * deadline and at a ceiling (55 s by default), so Connect answers before the
 * engine gives up and before a load balancer cuts the request.
 *
 * Not yet: deferred results. A handler that defers (`ctx.defer`) has no sink
 * here, so it answers `unknown` for a write and `retryable` for a read, as
 * the contract says; the sink comes with the first flow that waits on one.
 *
 * `perform` never throws: every path ends in an `ActionOutcome`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  ACTION_CONTRACT_VERSIONS,
  operationDigest,
  refuse,
  verifyApprovedAction,
  type ActionOutcome,
  type ActionPortDescription,
  type ApprovedAction,
  type ActionProof,
  type ApprovedActionVerifier,
  type Sha256Digest,
} from "@aaply/action-contract";
import {
  ConnectorError,
  createConnectorActionPort,
  operationContractOf,
  type Connector,
  type ConnectorActionPort,
  type ConnectorLogSink,
  type FetchLike,
} from "@aaply/connector-sdk";
import { headersOf, type TokenRefresher } from "./credentials.js";
import { compareVersions } from "./semver.js";
import type { ConnectStore, Resolution } from "./store/store.js";
import type { Vault } from "./vault.js";

/** The role a business connection serves when the flow names none. */
export const DEFAULT_ROLE = "default";

export interface PerformerOptions {
  /** This Connect's audience: envelopes for any other are refused. */
  audience: string;
  verifier: ApprovedActionVerifier;
  /** Every code connector this build serves, every version of each. */
  connectors: readonly Connector[];
  store: ConnectStore;
  vault: Vault;
  fetch: FetchLike;
  refresher?: TokenRefresher;
  now?: () => number;
  /** Longest a call may run, in ms. Default 55 000. */
  ceilingMs?: number;
  /** How long before the envelope's deadline Connect answers, in ms. Default 2 000. */
  marginMs?: number;
  log?: ConnectorLogSink;
  observer?: { error?(error: unknown, where: string): void };
}

export interface Performer {
  perform(value: unknown, signal?: AbortSignal): Promise<ActionOutcome>;
  describe(): ActionPortDescription;
}

/** One version of a code connector, with its own kit port and its operations' digests. */
interface Served {
  connector: Connector;
  port: ConnectorActionPort;
  digests: ReadonlyMap<string, Sha256Digest>;
}

/** What the kit's hooks need during one call; set by `perform` around the kit port. */
interface CallState {
  tenantId: string;
  resolution: Resolution;
  connector: Connector;
  /** The proof `perform` already verified for this envelope, so the kit's own check need not verify it again. */
  verified: ActionProof;
  /** The call's budget: every store, vault or refresh step inside the kit stops when it runs out. */
  signal: AbortSignal;
  /** The opened secret, once a request asked for it. */
  secret?: Readonly<Record<string, string>> | null;
}

/** `work`, or a rejection once `signal` aborts (a store that stalls must not hold the answer past the deadline). */
function whileOpen<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => (signal.removeEventListener("abort", stop), resolve(value)),
      (error: unknown) => (signal.removeEventListener("abort", stop), reject(error)),
    );
  });
}

export function createPerformer(options: PerformerOptions): Performer {
  const now = options.now ?? Date.now;
  const ceilingMs = options.ceilingMs ?? 55_000;
  const marginMs = options.marginMs ?? 2_000;
  const calls = new AsyncLocalStorage<CallState>();
  const report = (error: unknown, where: string) => {
    try {
      options.observer?.error?.(error, where);
    } catch {
      // An observer that throws must not change the answer.
    }
  };

  const state = (): CallState => {
    const s = calls.getStore();
    if (!s) throw new Error("no call in progress");
    return s;
  };

  const secretOf = async (s: CallState): Promise<Readonly<Record<string, string>> | null> => {
    if (s.secret !== undefined) return s.secret;
    const c = s.resolution.connection;
    if (!c?.secret) return (s.secret = null);
    try {
      s.secret = await whileOpen(s.signal, options.vault.open(s.tenantId, c.id, c.secret.sealed, c.secret.dataKey));
    } catch (error) {
      report(error, "vault.open");
      throw new ConnectorError("retryable", "connect/unavailable", "The account's credentials could not be read right now.");
    }
    return s.secret;
  };

  // The kit checks every envelope again, signature included. perform() has just verified this very envelope
  // and hands the kit the same object, so the kit's check of that proof is answered from the call state.
  const kitVerifier: ApprovedActionVerifier = {
    verify: (data, proof, context) => {
      const done = calls.getStore()?.verified;
      if (done && done.alg === proof.alg && done.keyId === proof.keyId && done.sig === proof.sig) return true;
      return options.verifier.verify(data, proof, context);
    },
  };

  // One kit port per connector version, so a flow's pin routes to the version it was published against.
  const versions = new Map<string, Served[]>();
  for (const connector of options.connectors) {
    const list = versions.get(connector.id) ?? [];
    if (list.some((s) => compareVersions(s.connector.version, connector.version) === 0)) throw new Error(`${connector.id}@${connector.version} is given twice`);
    const digests = new Map<string, Sha256Digest>();
    for (const name of Object.keys(connector.operations)) digests.set(name, operationDigest(operationContractOf(connector, name)!));
    const port = createConnectorActionPort({
      audience: options.audience,
      verifier: kitVerifier,
      connectors: [connector],
      fetch: options.fetch,
      clock: { now },
      ...(options.log ? { log: options.log } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      replayGuard: {
        claim: (key, until) => {
          const s = state();
          return whileOpen(s.signal, options.store.claim(s.tenantId, key, until));
        },
      },
      connections: (_scope, query) => {
        const c = state().resolution.connection;
        if (!c) return null;
        if (query.actingFor === "endUser" ? c.ownerSubject !== query.subjectId : c.ownerSubject !== null) return null;
        return { connectionId: c.id, grantedScopes: c.grantedScopes, subjectId: c.ownerSubject, environment: c.environmentKind };
      },
      credentials: {
        headers: async () => {
          const s = state();
          return headersOf(s.connector.auth, await secretOf(s));
        },
        ...(options.refresher
          ? {
              refresh: async (request) => {
                const s = state();
                const c = s.resolution.connection;
                const secret = await secretOf(s);
                if (!c || !secret || s.connector.auth.kind !== "oauth2") throw new ConnectorError("final", "connect/reconsent", "This account needs to be connected again.");
                s.secret = await whileOpen(s.signal, options.refresher!.refresh({ tenantId: s.tenantId, connectionId: c.id, version: c.version, secret, signal: AbortSignal.any([request.signal, s.signal]) }));
                return headersOf(s.connector.auth, s.secret);
              },
            }
          : {}),
      },
    });
    list.push({ connector, port, digests });
    list.sort((a, b) => compareVersions(b.connector.version, a.connector.version));
    versions.set(connector.id, list);
  }

  /** The newest version whose operation the flow pinned; else the newest, which refuses a pin it does not serve. */
  const pick = (list: readonly Served[], operation: string, pin: Sha256Digest | undefined): Served => {
    if (pin !== undefined) for (const s of list) if (s.digests.get(operation) === pin) return s;
    return list[0]!;
  };

  async function perform(value: unknown, signal?: AbortSignal): Promise<ActionOutcome> {
    const checked = await verifyApprovedAction(value, { now: now(), audience: options.audience, verifier: options.verifier });
    if (!checked.ok) return checked.outcome;
    const a: ApprovedAction = checked.action;
    // A person is stored as domain:id; a domain with a colon in it would read as another person.
    if (a.subject?.domain.includes(":")) return refuse("connect/invalid-envelope", "The run's person is malformed.", { detail: "subject.domain contains ':'" });
    const dot = a.action.id.indexOf(".");
    const connectorId = dot > 0 ? a.action.id.slice(0, dot) : a.action.id;
    const operation = dot > 0 ? a.action.id.slice(dot + 1) : "";
    const list = versions.get(connectorId);
    if (!list) return refuse("connect/unknown-action", "This action is not available.", { detail: `no connector ${connectorId}` });
    // Too close to its deadline to answer in time: nothing is read, claimed or sent.
    const budget = Math.min(a.deadline - marginMs - now(), ceilingMs);
    if (budget <= 0) return refuse("connect/late", "This action arrived too close to its deadline.");
    const timeout = AbortSignal.timeout(budget);
    const capped = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let resolution: Resolution;
    try {
      resolution = await whileOpen(capped, options.store.resolve({
        scope: a.scope,
        connectorId,
        actingFor: a.connection.actingFor,
        role: a.connection.role ?? DEFAULT_ROLE,
        subject: a.subject ? `${a.subject.domain}:${a.subject.id}` : null,
        environment: a.environment,
      }));
    } catch (error) {
      report(error, "store.resolve");
      return refuse("connect/unavailable", "Connect cannot reach its store right now.");
    }
    if (resolution.global.disabled) return refuse("connect/disabled", "Actions are switched off for now.", { detail: "global" });
    if (resolution.policy?.disabled) return refuse("connect/disabled", "Actions are switched off for this app.", { detail: "scope" });
    if (resolution.policy?.denied.includes(a.action.id)) return refuse("connect/policy-denied", "This action is not allowed here.");
    if (!resolution.installation || resolution.installation.kind !== "code") {
      return refuse("connect/unknown-action", "This action is not available here.", { detail: `${connectorId} is not installed for this app` });
    }
    if (resolution.connection?.status === "reauth") return refuse("connect/reconsent", "This account needs to be connected again.");
    if (resolution.connection?.status === "revoked") return refuse("connect/connection-revoked", "This account was disconnected.");

    const served = pick(list, operation, a.action.contract);
    try {
      return await calls.run({ tenantId: a.scope.tenantId, resolution, connector: served.connector, verified: a.proof, signal: capped }, () => served.port.run(a, capped));
    } catch (error) {
      // The kit's port never throws; this is a last guard so /perform always answers an outcome.
      report(error, "perform");
      return a.action.effect === "write" ? { status: "unknown", error: { code: "connect/unavailable", message: "The call failed in Connect." } } : refuse("connect/unavailable", "The call failed in Connect.");
    }
  }

  return {
    perform: async (value, signal) => {
      try {
        return await perform(value, signal);
      } catch (error) {
        report(error, "perform");
        return refuse("connect/unavailable", "The call failed in Connect.");
      }
    },
    describe: () => ({ contracts: [...ACTION_CONTRACT_VERSIONS] }),
  };
}
