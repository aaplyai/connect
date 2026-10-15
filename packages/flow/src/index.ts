/**
 * @aaply/flow: a general-purpose flow engine. This entry is what a host
 * needs (ADR 0016, "Public entry points"):
 *
 * - Authoring: `defineFlow`, the `e` expression helpers, `compileFlow`,
 *   `expandFlow` and the definition types (`FlowDefinition` and its parts).
 * - The runtime: `createFlowRuntime`, its options, limits, requests and
 *   responses, and `FlowError`.
 * - The ports a host implements (`RunStore`, `FlowCatalog`, `ActionPort`,
 *   `DecisionPort`, `AdmissionPort`, `Observer`, ...) and the defaults
 *   (`createMemoryStore`, `createMemoryCatalog`, `systemClock`, `uuidv7Ids`,
 *   `hmacKeyMinter`, `hmacActionSigner`).
 * - Views and replies (`FlowView`, `Reply`), routing policy (`DecisionPolicy`,
 *   `parseDecisionPolicy`), diagnostics, and the parts of the approved-action
 *   contract a host meets (`ApprovedAction`, `ActionOutcome`, `JsonValue`, ...).
 *
 * The rest is on named entries, one home per symbol:
 * `@aaply/flow/core` (the pure step function, run state and events),
 * `/expr` (expressions), `/definition` (the definition format's tables,
 * patterns and limits), `/store` and `/lanes` (for a store implementation),
 * `/privacy` (legal holds, the privacy log), `/migrate` (moving runs between
 * versions), `/contracts` (operation contracts the runtime has seen),
 * `/blobs` (file references), `/decide` (decider stages and policy details),
 * `/eval` (measuring a decider) and `/testing` (the test kit). The
 * approved-action contract itself is `@aaply/action-contract`.
 */

export {
  DiagnosticsError,
  hmacActionSigner,
  isActionOutcome,
  type ActionError,
  type ActionOutcome,
  type ActionPort,
  type ApprovedAction,
  type ApprovedActionSigner,
  type BlobRef,
  type CompletionResult,
  type DeliverRequest,
  type DeliverResult,
  type Diagnostic,
  type EnvironmentKind,
  type JsonObject,
  type JsonPrimitive,
  type JsonSchema,
  type JsonValue,
  type OperationContract,
  type Risk,
  type Scope,
  type Severity,
} from "@aaply/action-contract";
export type { EnvelopeSigning } from "./approved.js";
export type { NormaliseContext, Normalised } from "./assist/normalise.js";
export { checkActionBindings, pinActionContracts, type ActionBindingOptions, type OperationContracts } from "./bindings.js";
export { defineFlow, e } from "./builder.js";
export { checkFlowCalls } from "./calls.js";
export { createMemoryCatalog, type DirectPolicy, type MemoryCatalog, type MemoryCatalogOptions } from "./catalog.js";
export {
  compileFlow,
  mustCompileFlow,
  type CompiledAction,
  type CompiledFact,
  type CompiledFlow,
  type CompiledStep,
  type CompiledView,
  type CompileResult,
} from "./compile.js";
export type { Rejection } from "./core.js";
export type { DecisionAnswer, DecisionGoal, DecisionPort, DecisionRequest } from "./decision.js";
export {
  FLOW_SCHEMA_VERSION,
  type ActionCall,
  type ActionDef,
  type CallDef,
  type CollectionDef,
  type EffectKind,
  type EndKind,
  type Extensions,
  type FactCheck,
  type FactDef,
  type FlowDefinition,
  type FlowLimits,
  type FlowSchemaVersion,
  type InterfaceDef,
  type ItemFieldDef,
  type MigrationDef,
  type Rule,
  type Sensitivity,
  type StepDef,
  type ViewDef,
  type WaitDef,
} from "./definition.js";
export { FlowError, type FlowErrorCode } from "./errors.js";
export type { Expr } from "./expr.js";
export {
  createMemoryFragments,
  expandFlow,
  mustExpand,
  type ExpandResult,
  type FragmentDefinition,
  type FragmentParam,
  type FragmentProvider,
  type IncludeDef,
  type MemoryFragments,
} from "./include.js";
export { createMemoryStore, type MemoryRunStore, type MemoryStoreOptions } from "./memory-store.js";
export { NO_POLICY, parseDecisionPolicy, type DecisionPolicy } from "./policy.js";
export {
  hmacKeyMinter,
  systemClock,
  uuidv7Ids,
  type Admission,
  type AdmissionAction,
  type AdmissionOp,
  type AdmissionPort,
  type CatalogViewer,
  type Clock,
  type FlowCatalog,
  type IdSource,
  type KeyMinter,
  type LanePolicy,
  type Observer,
  type PickRecord,
  type TraceBasis,
  type TraceRecord,
  type TraceSettled,
  type TrustedContext,
  type TurnOutcome,
  type TurnRecord,
} from "./ports.js";
export {
  filterReplyLinks,
  linkAllowed,
  type Reply,
  type ReplyBlock,
  type ReplyContent,
  type ReplyKind,
  type ReplyOption,
  type ReplyViewDef,
  type ReplyViewKey,
  type ReplyViews,
} from "./reply.js";
export {
  createFlowRuntime,
  DEFAULT_RUNTIME_LIMITS,
  type FlowRuntime,
  type OfferView,
  type RunResponse,
  type RuntimeLimits,
  type RuntimeOptions,
  type SubmitInput,
  type TurnInput,
  type TurnResponse,
  type WorkspaceView,
} from "./runtime.js";
export type { AcceptEntry, ItemOp, Notice, RunStatus, UndoRequest } from "./state.js";
export type { RunStore } from "./store.js";
export {
  REDACTED,
  type Ask,
  type FlowView,
  type KnownFact,
  type KnownItem,
  type ViewField,
  type ViewStatus,
  type ViewStep,
  type ViewSuggestion,
} from "./view.js";
