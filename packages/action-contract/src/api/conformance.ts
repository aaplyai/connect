/**
 * `@aaply/action-contract/conformance`: the suite every action port passes
 * (`actionPortConformance`, and `blobPortConformance` for file references),
 * and what a performer's own tests build envelopes with: `draftApprovedAction`,
 * `draftApproval`, `sealApprovedAction`, `conformanceVerifier` and the
 * conformance scope, audience and key.
 */

export { blobPortConformance, type BlobConformanceCall, type BlobPortConformanceOptions } from "../blob-conformance.js";
export {
  actionPortConformance,
  CONFORMANCE_AUDIENCE,
  CONFORMANCE_KEY,
  CONFORMANCE_SCOPE,
  CONFORMANCE_UNDONE,
  conformanceVerifier,
  draftApproval,
  draftApprovedAction,
  sealApprovedAction,
  type ActionPortConformanceCase,
  type ActionPortConformanceOptions,
  type ApprovedActionDraft,
  type ConformanceCall,
  type ConformanceUndo,
} from "../conformance.js";
