/**
 * @aaply/action-contract: the contract between the Aaply Flow Engine and
 * whatever performs its actions (Aaply Connect, the connector kit, a test
 * fake). No dependencies, so a connector author installs this and the kit,
 * never the engine.
 *
 * - `ApprovedAction` (contract 1): the envelope the engine sends, and `checkApprovedAction` and `verifyApprovedAction`, the checks every performer runs first.
 * - `ApprovedActionSigner` and `ApprovedActionVerifier`: the host-supplied ports that sign and verify an envelope, over `approvedActionSigningBytes`; `hmacActionSigner` and `hmacActionVerifier` are the reference pair.
 * - `ActionPort`: the port that receives it.
 * - `ActionOutcome` and `normalizeOutcome`: the five answers.
 * - `OperationContract` and `operationDigest`: what a flow pins at publish; `completion` (`MAX_COMPLETION_WINDOW_MS`) is how long a deferred result may take.
 * - `CONNECT_REFUSALS` and `refuse`: how a performer says no before sending anything.
 * - `CompletionRequest` and `CompletionResult`: settling a `pending` action later.
 * - `DeliverRequest` and `DeliverResult`: an outside event (a webhook) for the run waiting on it.
 * - Plain JSON, canonical form, SHA-256, diagnostics and the JSON Schema subset both sides validate with.
 * - `FixedPattern`: how an exported pattern is published (a source and a test, never a RegExp).
 * - `BlobRef` and `checkBlobRef`: large or binary content named by a reference bound to its scope (the schema subset's `blob` keyword types one); the conformance suite every port passes, for them too, is `@aaply/action-contract/conformance`.
 */

export {
  ACTION_CONTRACT_VERSION,
  checkApprovedAction,
  DEFAULT_CLOCK_SKEW_MS,
  MAX_ACTION_TIMEOUT_MS,
  verifyApprovedAction,
  type ActionOrigin,
  type ActionPort,
  type ApprovalEvidence,
  type ApprovedAction,
  type ApprovedActionCheck,
  type ApprovedActionCheckOptions,
  type ApprovedActionVerifyOptions,
  type IdentityRef,
} from "./approved.js";
export {
  BLOB_CONSTRAINT_KEYS,
  BLOB_REF_KEY,
  BLOB_REF_SCHEMA,
  BLOB_REF_VERSION,
  blobBinding,
  blobConstraintCovers,
  blobConstraintProblem,
  blobDigest,
  blobDigestSync,
  blobValueProblem,
  checkBlobRef,
  copyBlobRef,
  findBlobRefs,
  hasBlobRefs,
  isBlobName,
  isBlobRef,
  isBlobRefLike,
  isMediaTypePattern,
  makeBlobRef,
  mapBlobRefs,
  MAX_BLOB_ID_LENGTH,
  MAX_BLOB_MEDIA_TYPES,
  MAX_BLOB_NAME_LENGTH,
  mediaTypeMatches,
  normalizeMediaType,
  sanitizeBlobName,
  schemaUsesBlob,
  type BlobConstraint,
  type BlobRef,
  type BlobRefProblem,
  type FoundBlobRef,
} from "./blob.js";
export { isOperationCompletion, MAX_COMPLETION_WINDOW_MS, type OperationCompletion } from "./completion-window.js";
export type { CompletionRequest, CompletionResult } from "./completion.js";
export {
  ACTION_CONTRACT_VERSIONS,
  isActionPortDescription,
  MAX_DESCRIBED_CONTRACTS,
  pickContractVersion,
  type ActionPortDescription,
} from "./contract-versions.js";
export {
  DEDUPE_KEY_RE,
  DELIVER_EVENT_RE,
  isDeliverConnection,
  isDeliverRequest,
  type DeliverConnection,
  type DeliverRequest,
  type DeliverResult,
} from "./deliver.js";
export { DiagnosticBag, DiagnosticsError, type Diagnostic, type Severity } from "./diagnostics.js";
export { isSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
export { ENVIRONMENT_KINDS, environmentAllows, isEnvironmentKind, UNDECLARED_ENVIRONMENT } from "./environment.js";
export type { FixedPattern } from "./frozen.js";
export { fingerprint, hmacSha256, safeEqual, sha256, toBase64Url, toHex } from "./hash.js";
export {
  canonicalJson,
  checkJson,
  cloneJson,
  formatPath,
  getPath,
  hasOwn,
  isJsonObject,
  isJsonValue,
  jsonByteLength,
  jsonEqual,
  jsonPointer,
  MAX_JSON_DEPTH,
  own,
  utf8Length,
  type JsonCheckIssue,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PathSegment,
} from "./json.js";
export { isOperationContract, OPERATION_CONTRACT_VERSION, operationDigest, type OperationContract } from "./operation.js";
export {
  isActionOutcome,
  MAX_ACTION_OUTPUT_BYTES,
  MAX_PENDING_REF_LENGTH,
  normalizeOutcome,
  type ActionError,
  type ActionOutcome,
  type NormalizeOutcomeOptions,
  type RateLimitBucket,
} from "./outcome.js";
export { CONNECT_REFUSALS, CONTRACT_UNSUPPORTED_RETRY_MS, isRefusalCode, refuse, type ConnectRefusalCode, type RefuseOptions } from "./refusals.js";
export {
  assignabilityProblems,
  checkFormat,
  checkPattern,
  checkSchema,
  dateMs,
  dateTimeMs,
  describeType,
  isAssignable,
  JSON_TYPES,
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_SUBJECT,
  MAX_PATTERN_WORK,
  SCHEMA_ANNOTATIONS,
  SCHEMA_KEYWORDS,
  STRING_FORMATS,
  timestampMs,
  validateValue,
  type JsonSchema,
  type JsonType,
  type SchemaIssue,
  type StringFormat,
} from "./schema.js";
export {
  riskAtLeast,
  type ActingFor,
  type ActionEffectKind,
  type ActionPurpose,
  type ActorKind,
  type EnvironmentKind,
  type Risk,
  type Scope,
} from "./scope.js";
export {
  approvalBinding,
  APPROVED_ACTION_SIGNING_TAG,
  approvedActionSigningBytes,
  HMAC_PROOF_ALG,
  hmacActionSigner,
  hmacActionVerifier,
  isActionProof,
  signApprovedAction,
  UNSIGNED_PROOF,
  type ActionKeyContext,
  type ActionProof,
  type ApprovalBindingParts,
  type ApprovedActionSigner,
  type ApprovedActionVerifier,
  type UnsignedApprovedAction,
} from "./signing.js";
export { isTraceparent, TRACEPARENT_RE } from "./trace.js";
