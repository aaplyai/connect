/**
 * Webhooks: a connector's hooks for the events a service pushes, and the
 * kit's handler that runs them.
 *
 * A connector that receives webhooks declares `webhooks: { verify, parse }`.
 * The host receives the HTTP request at an endpoint it routes to one
 * connection, and calls {@link handleWebhook}: the kit verifies the request
 * with the connector's `verify` (a signature over the raw body, with the
 * connection's webhook secret), then turns it into the events it carries
 * with `parse`, as the contract's `DeliverRequest`s, each naming the
 * connection it came from and that connection's owner (from the host's
 * options, never from the request). The host delivers each to the engine's
 * `deliver` with a workload context in the connection's scope whose subject
 * is that owner (none for the business's own connection), so an event wakes
 * only a run of the person whose account it came from, and answers the
 * sender with the status the result names.
 *
 * Subscribing to a service's webhooks, and renewing a subscription that
 * expires (Gmail's watch, Drive's channels), is the host's (Connect's) job;
 * the kit does not build it.
 */

import { isDeliverConnection, isDeliverRequest, type DeliverRequest } from "@aaply/action-contract";
import { systemClock, type Clock } from "./clock.js";
import { compileConnector, type Connector } from "./definition.js";
import { adoptConnectorError } from "./errors.js";
import { createConnectorLog, safe, type ConnectorLog, type ConnectorLogSink } from "./log.js";

/** A webhook request as the host received it. */
export interface WebhookRequest {
  /** The HTTP method, uppercase. */
  method: string;
  /** The URL the sender called, as received. */
  url: string;
  /** Header names lowercase. */
  headers: Readonly<Record<string, string>>;
  /** The raw body, exactly as received: signatures are computed over these bytes. */
  body: Uint8Array;
}

/** What a connector's webhook hooks get besides the request. */
export interface WebhookContext {
  /** The connection this webhook endpoint belongs to. */
  readonly connectionId: string;
  /** The secret the service signs this connection's webhooks with, or null. Never log it. */
  readonly secret: string | null;
  /** Epoch milliseconds on the host's clock, for a signature's timestamp tolerance. */
  readonly now: number;
  /** Redacting logger. */
  readonly log: ConnectorLog;
}

/** A connector's webhook hooks (`ConnectorDefinition.webhooks`). */
export interface WebhookHooks {
  /** True when the request came from the service. Anything else (false, a throw) refuses it; compare signatures in constant time. */
  verify(request: WebhookRequest, ctx: WebhookContext): boolean | Promise<boolean>;
  /** The events a verified request carries, for the engine's `deliver`. An empty list acknowledges a request with none (a ping). */
  parse(request: WebhookRequest, ctx: WebhookContext): DeliverRequest[] | Promise<DeliverRequest[]>;
}

/** At most this many events come from one webhook request. */
export const MAX_WEBHOOK_DELIVERIES = 100;

/** Why {@link handleWebhook} refused a request, and the HTTP status to answer the sender with. */
export type WebhookRefusal =
  /** The connector declares no webhooks. 404. */
  | { ok: false; code: "connect/no-webhooks"; status: 404; message: string }
  /** `verify` said no. 401: the sender should not send it again. */
  | { ok: false; code: "connect/webhook-unverified"; status: 401; message: string }
  /**
   * `verify` or `parse` threw something other than a `ConnectorError`, or the
   * host's options named no well-formed connection (an id, and an owner or
   * null), so it may work later. 503: the sender should send it again.
   */
  | { ok: false; code: "connect/webhook-unavailable"; status: 503; message: string }
  /** `parse` refused the request (a `ConnectorError`), or answered what is not a list of at most {@link MAX_WEBHOOK_DELIVERIES} deliveries. 400. */
  | { ok: false; code: "connect/webhook-invalid"; status: 400; message: string };

/** What {@link handleWebhook} answers: the events to deliver, each naming its connection (answer the sender 2xx once they are), or a refusal. */
export type WebhookResult = { ok: true; deliveries: DeliverRequest[] } | WebhookRefusal;

export interface HandleWebhookOptions {
  /** The connection the endpoint belongs to. */
  connectionId: string;
  /**
   * Whose account the connection is, from the host's connection store: the
   * person's subject id (`domain:id`), or null for the business's own. Each
   * delivery carries it, and the engine wakes only a run of that person.
   */
  subjectId: string | null;
  /** The connection's webhook signing secret, if it has one. */
  secret?: string | null;
  clock?: Clock;
  log?: ConnectorLogSink;
  /** Unexpected errors (hook bugs), for the host's error reporting. */
  onError?: (error: unknown, where: string) => void;
}

/**
 * Verifies a webhook request with the connector's hooks and parses it into
 * the events it carries. Never throws. The request reaches `parse` only once
 * `verify` answered exactly `true`; each delivery is checked
 * (`isDeliverRequest`), copied, and given the connection from `options`
 * (replacing any `connection` that `parse` set).
 */
export async function handleWebhook(connector: Connector, request: WebhookRequest, options: HandleWebhookOptions): Promise<WebhookResult> {
  const where = `connector:${String(connector?.id)}.webhooks`;
  let hooks: WebhookHooks | undefined;
  try {
    hooks = compileConnector(connector).connector.webhooks;
  } catch (error) {
    options.onError?.(error, where);
    return { ok: false, code: "connect/no-webhooks", status: 404, message: "This connector does not accept webhooks." };
  }
  if (!hooks) return { ok: false, code: "connect/no-webhooks", status: 404, message: "This connector does not accept webhooks." };
  // Checked before anything is read: an event that names no owner could wake anyone's run.
  const connection = { id: options.connectionId, subjectId: options.subjectId };
  if (!isDeliverConnection(connection)) {
    options.onError?.(new Error("handleWebhook needs the connection's id and owner (subjectId: a subject id, or null)"), where);
    return { ok: false, code: "connect/webhook-unavailable", status: 503, message: "The webhook could not be read right now." };
  }
  const log = createConnectorLog(options.log, { connectorId: connector.id, operation: "webhooks", connectionId: options.connectionId });
  const frozen: WebhookRequest = Object.freeze({
    method: String(request.method).toUpperCase(),
    url: String(request.url),
    headers: Object.freeze(Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))),
    body: request.body instanceof Uint8Array ? request.body.slice() : new Uint8Array(0),
  });
  const ctx: WebhookContext = Object.freeze({ connectionId: options.connectionId, secret: options.secret ?? null, now: (options.clock ?? systemClock).now(), log });

  let verified: unknown;
  try {
    verified = await hooks.verify(frozen, ctx);
  } catch (error) {
    // A refusal is read for its fields only, once (never its methods or getters again).
    const refused = adoptConnectorError(error) !== null;
    if (!refused) options.onError?.(error, `${where}.verify`);
    log.warn("webhook.unverified", { reason: safe("verify threw") });
    return refused
      ? { ok: false, code: "connect/webhook-unverified", status: 401, message: "The webhook could not be verified." }
      : { ok: false, code: "connect/webhook-unavailable", status: 503, message: "The webhook could not be checked right now." };
  }
  if (verified !== true) {
    log.warn("webhook.unverified", { reason: safe("verify said no") });
    return { ok: false, code: "connect/webhook-unverified", status: 401, message: "The webhook could not be verified." };
  }

  let parsed: unknown;
  try {
    parsed = await hooks.parse(frozen, ctx);
  } catch (error) {
    const refusal = adoptConnectorError(error);
    if (refusal) return { ok: false, code: "connect/webhook-invalid", status: 400, message: refusal.message };
    options.onError?.(error, `${where}.parse`);
    return { ok: false, code: "connect/webhook-unavailable", status: 503, message: "The webhook could not be read right now." };
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_WEBHOOK_DELIVERIES || !parsed.every((d) => isDeliverRequest(d))) {
    options.onError?.(new Error("webhooks.parse answered something that is not a list of deliveries"), `${where}.parse`);
    return { ok: false, code: "connect/webhook-invalid", status: 400, message: "The webhook's events could not be read." };
  }
  const deliveries = (parsed as DeliverRequest[]).map((d) => ({ ...structuredClone(d), connection: { ...connection } }));
  log.info("webhook.parsed", { deliveries: safe(deliveries.length) });
  return { ok: true, deliveries };
}
