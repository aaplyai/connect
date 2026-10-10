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
  /** The opened secret, once a request asked for it. */
  secret?: Readonly<Record<string, string>> | null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pb = b.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
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
      s.secret = await options.vault.open(s.tenantId, c.id, c.version, c.secret.sealed, c.secret.dataKey);
    } catch (error) {
      report(error, "vault.open");
      throw new ConnectorError("retryable", "connect/unavailable", "The account's credentials could not be read right now.");
    }
    return s.secret;
  };

  const versions = new Map<string, Served[]>();
  for (const connector of options.connectors) {
    const list = versions.get(connector.id) ?? [];
    if (list.some((s) => s.connector.version === connector.version)) throw new Error(`${connector.id}@${connector.version} is given twice`);
    const digests = new Map<string, Sha256Digest>();
    for (const name of Object.keys(connector.operations)) digests.set(name, operationDigest(operationContractOf(connector, name)!));
    const port = createConnectorActionPort({
      audience: options.audience,
      verifier: options.verifier,
      connectors: [connector],
      fetch: options.fetch,
      clock: { now },
      ...(options.log ? { log: options.log } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      replayGuard: { claim: (key, until) => options.store.claim(state().tenantId, key, until) },
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
                s.secret = await options.refresher!.refresh({ tenantId: s.tenantId, connectionId: c.id, version: c.version, secret, signal: request.signal });
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
    const dot = a.action.id.indexOf(".");
    const connectorId = dot > 0 ? a.action.id.slice(0, dot) : a.action.id;
    const operation = dot > 0 ? a.action.id.slice(dot + 1) : "";
    const list = versions.get(connectorId);
    if (!list) return refuse("connect/unknown-action", "This action is not available.", { detail: `no connector ${connectorId}` });

    let resolution: Resolution;
    try {
      resolution = await options.store.resolve({
        scope: a.scope,
        connectorId,
        actingFor: a.connection.actingFor,
        role: a.connection.role ?? DEFAULT_ROLE,
        subject: a.subject ? `${a.subject.domain}:${a.subject.id}` : null,
        environment: a.environment,
      });
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
    const budget = Math.max(1, Math.min(a.deadline - marginMs - now(), ceilingMs));
    const timeout = AbortSignal.timeout(budget);
    const capped = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await calls.run({ tenantId: a.scope.tenantId, resolution, connector: served.connector }, () => served.port.run(a, capped));
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
