# @aaply/flow

The Aaply Flow Engine. Its one dependency is
[`@aaply/action-contract`](../action-contract), which has none; runs in Node,
Bun, workers and browsers (the pure core) and in any server (the runtime).
The main entry re-exports the parts of the contract a host meets
(`ApprovedAction`, `ActionOutcome`, `JsonValue`, `Diagnostic`, ...); the rest
of it is imported from `@aaply/action-contract`.

```ts
import { defineFlow, e, createFlowRuntime } from "@aaply/flow";
import { createHarness, ok } from "@aaply/flow/testing";
import { createDeciderChain, classifierStage, llmStage } from "@aaply/flow/decide";
import { evaluateDecisions, freezeGates, sweep, selectThresholds } from "@aaply/flow/eval";
```

## Entry points

The main entry is what a host needs; everything else has one named home
([ADR 0016](../../docs/adr/0016-public-entry-points.md)).
`docs/api-surface.json` records every entry's names and budget, and
`test/api-surface.test.ts` holds the packages to it.

| Entry | What is in it |
| --- | --- |
| `@aaply/flow` | Authoring: `defineFlow`, `e`, `compileFlow`, `mustCompileFlow`, `expandFlow`, `mustExpand`, `createMemoryFragments`, `FLOW_SCHEMA_VERSION`, `FlowDefinition` and its parts, the compiled shapes a host reads (`CompiledFlow`, `CompiledStep`, ...). Runtime: `createFlowRuntime`, `DEFAULT_RUNTIME_LIMITS`, `RuntimeOptions`, `RuntimeLimits`, requests and responses (`SubmitInput`, `RunResponse`, `TurnInput`, `TurnResponse`, `WorkspaceView`, `OfferView`, `Notice`, `Rejection`), `FlowError` and `FlowErrorCode`. Ports and defaults: `TrustedContext`, `FlowCatalog`, `RunStore`, `ActionPort`, `DecisionPort`, `AdmissionPort`, `Observer` and their records, `Clock`, `IdSource`, `KeyMinter`, `LanePolicy`, `createMemoryStore`, `createMemoryCatalog`, `systemClock`, `uuidv7Ids`, `hmacKeyMinter`, `hmacActionSigner`. Views and replies: `FlowView`, `Ask`, `Reply` and its parts, `REDACTED`, `linkAllowed`, `filterReplyLinks`. Routing: `DecisionPolicy`, `parseDecisionPolicy`, `NO_POLICY`, `DecisionRequest`, `DecisionAnswer`, `NormaliseContext` and `Normalised`. Publishing: `checkActionBindings`, `pinActionContracts`, `OperationContracts`. Errors: `Diagnostic`, `DiagnosticsError`. From the contract: `ApprovedAction`, `ActionOutcome`, `isActionOutcome`, `JsonValue`, `Scope`, `BlobRef`, ... |
| `@aaply/flow/core` | The pure core: `step`, `replay`, `renderView`, `RunReader`, `confirmDigest`, `instanceKey`, `usageEntries`, `parseItemOps`, `isTerminal`, and every type of a run's state, events and effects (`RunState`, `FlowEvent`, `FlowEffect`, ...) with the versions they are written at |
| `@aaply/flow/expr` | Expressions: `parseExpr`, `evaluate`, `textToExpr` (Facet's syntax to the JSON tree), `nodeChildren`, the environment names, operators and limits |
| `@aaply/flow/definition` | The format's tables: `DEFINITION_KEYS` and `keysOf`, the name patterns (`NAME_RE`, `FLOW_ID_RE`, ...), the limits, reply kinds and view keys, `FILL_MODES` and `fillModeOf`, fact and item addresses (`keyOf`, `templateOf`, `nameOfKey`, `itemOfKey`), `validateFlow` |
| `@aaply/flow/store` | For a `RunStore`: outbox items and leases, timers, waits, workspaces, commit batches, claims, `LaneOps`, erasure options, `sameScope`, and the health counts (`StoreHealth`, `runtimeHealth`) |
| `@aaply/flow/lanes` | Fair lanes for a store that implements them: names, limits and classes with their checks, defaults and bounds, `tokensAt`, the lane state; see [runtime: fair lanes](../../docs/runtime.md#fair-lanes) |
| `@aaply/flow/privacy` | Legal holds and the privacy log for a store (`PrivacyOps`, `LegalHold`, `PrivacyRecord`, `holdProblems`, ...) and the shapes of subject exports and erasure |
| `@aaply/flow/migrate` | Moving runs between versions: `checkMigration`, `planMigration`, `migrateStep`, `decideMove`, the move policy and approvals, `storedRunsUse`, `VersionInUse` |
| `@aaply/flow/contracts` | Operation contracts the runtime has met: `unseenContracts`, `completionToken`, the describe timings |
| `@aaply/flow/blobs` | File references: `BlobHost`, the blob ledger (`createMemoryBlobLedger`), `eraseEndedRuns` |
| `@aaply/flow/decide` | Deciders: `createDeciderChain`, `classifierStage`, `llmStage`, `decideFromRanked`, `classifierLabels`, `llmInput`, `LLM_INSTRUCTIONS`, `PASS_TO_LLM`, `NO_MATCH`; the parts of a decision (`DecisionProposal`, `StageTrace`, ...) and of a policy (`resolvePolicy`, `Calibration`, thresholds, texts, defaults); `checkGoals` for a catalog's goal names |
| `@aaply/flow/eval` | Evaluation: `freezeGates`, `evaluateDecisions`, `sweep`, `selectThresholds`, `formatReport`, `verifyCalibration` (the host's check before saving a policy's calibration), `EvaluationRefused`, `DecisionCase`, `DecisionReport` |
| `@aaply/flow/testing` | The test kit: `createHarness` (with a `seed`, reproducible run nonces: `seededRandomBytes`), `fakeActions` (each call records its `approved` envelope), `testClock`, `sequentialIds`, `testKeys`, `testScope`, `testContext`, outcome helpers (`ok`, `retryable`, `final`, `unknownOutcome`, `pending(ref?)`), `storeConformanceCases`, `laneConformanceCases`, `blobLedgerConformanceCases`, `catalogConformance` (a catalog with the memory catalog's management surface), `scriptedDecider`, `fakeClassifier`, `fakeComplete`, `testCalibration` (a sealed calibration for tests of `auto`; it names no real report) |
| `@aaply/flow/internal` | Shared with the toolkit only; not public API |

Codes added in 0.2 for actions: `flow/action-input-invalid` (an input that
does not fit `inputSchema`, never sent), `flow/approval-expired` (a retry
after a review's time to live), and at publish `flow/contract-mismatch`,
`flow/contract-unpinned`, `flow/contract-unknown` and `flow/contract-invalid`.
See [Runtime](../../docs/runtime.md#before-an-action-is-sent) and
[Connectors](../../docs/connectors.md#publishing-bindings-and-pins).

## Docs

See the [Flow Engine docs](../../docs): [concepts](../../docs/concepts.md),
[authoring](../../docs/authoring.md), [runtime and ports](../../docs/runtime.md),
[connectors](../../docs/connectors.md), [decisions](../../docs/decisions.md), [Facet](../../docs/facet.md),
[security](../../docs/security.md) and [scalability](../../docs/scalability.md).
