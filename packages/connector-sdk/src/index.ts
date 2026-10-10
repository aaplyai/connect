/**
 * @aaply/connector-sdk: the kit for building connectors whose operations
 * flows run as actions. It depends only on `@aaply/action-contract`, never on
 * the engine.
 *
 * - Definitions (`defineConnector`) declare operations, schemas, undo semantics and egress; `manifestOf` and `manifestDigest` describe them as JSON,
 *   and `operationContracts` gives the operation contracts a flow pins.
 * - Handlers reach the network only through `ctx.http`: egress-checked, credentialed by the host, bounded. `ctx.defer(ref)` hands a result to later.
 * - Failures are `ConnectorError`s with the contract's outcome semantics; `httpOutcome` maps HTTP answers. A code only the kit's
 *   checks before running answer (`isCheckOnlyCode`) is never a handler's: thrown during a call, it is `connect/handler-error`.
 * - `createConnectorActionPort` turns a set of connectors into an action port that takes approved actions, verified under the
 *   host's `audience` and `verifier`; `memoryReplayGuard` is a one-process `ReplayGuard`.
 * - `handleWebhook` verifies and parses a service's webhooks with a connector's `webhooks` hooks, into the contract's `DeliverRequest`s.
 * - `ctx.blobs` stores and reads content by reference through the host's `BlobStore` (ADR-0008); `memoryBlobStore` is the in-memory one.
 * - The test kit (mock fetch, direct calls, conformance cases) is in `@aaply/connector-sdk/testing`.
 *
 * Checking a flow against connectors is `checkActionBindings(flow, operationContracts(connectors))` in `@aaply/flow`.
 */

export {
  DEFAULT_BLOB_LIMITS,
  memoryBlobStore,
  type BlobCallContext,
  type BlobContent,
  type BlobLimits,
  type BlobStore,
  type ConnectorBlobs,
  type MemoryBlobStore,
} from "./blobs.js";
export type { Clock } from "./clock.js";
export {
  defineConnector,
  MANIFEST_VERSION,
  manifestDigest,
  manifestOf,
  operationContractOf,
  operationContracts,
  scopesNeeded,
  validateConnector,
  validateManifest,
  type AuthSpec,
  type Connector,
  type ConnectorDefinition,
  type ConnectorManifest,
  type Operation,
  type OperationContext,
  type OperationDefinition,
  type OperationEffect,
  type OperationManifest,
  type RiskFloor,
} from "./definition.js";
export { EGRESS_METHODS, type EgressMethod, type EgressRefusal, type EgressRule } from "./egress.js";
export {
  CHECK_ONLY_CODES,
  ConnectorError,
  fetchErrorOutcome,
  httpError,
  httpOutcome,
  isCheckOnlyCode,
  REFUSAL_ORIGINS,
  type ConnectorErrorOptions,
  type FailureKind,
  type HeadersLike,
  type ResponseLike,
  type RetryOptions,
} from "./errors.js";
export type { ConnectorHttp, ConnectorResponse, FetchLike, HttpLimits, HttpRequest } from "./http.js";
export { safe, type ConnectorLog, type ConnectorLogRecord, type ConnectorLogSink, type LogLevel, type LogPrimitive, type SafeValue } from "./log.js";
export {
  createConnectorActionPort,
  deferredKey,
  memoryReplayGuard,
  replayKey,
  type ConnectionQuery,
  type ConnectionResolver,
  type ConnectorActionPort,
  type ConnectorActionPortOptions,
  type CredentialProvider,
  type CredentialRequest,
  type DeferredAction,
  type ReplayGuard,
  type ResolvedConnection,
  type SignRequest,
} from "./port.js";
export type { SignableRequest } from "./signing.js";
export {
  handleWebhook,
  MAX_WEBHOOK_DELIVERIES,
  type HandleWebhookOptions,
  type WebhookContext,
  type WebhookHooks,
  type WebhookRefusal,
  type WebhookRequest,
  type WebhookResult,
} from "./webhooks.js";
