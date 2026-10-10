/**
 * `@aaply/flow/privacy`: legal holds and the privacy log (ADR 0010) for a
 * store that implements `PrivacyOps`, and the shapes of subject exports and
 * erasure.
 */

export type { ListHoldsInput, PlaceHoldInput } from "../privacy-runtime.js";
export {
  holdInForce,
  holdProblems,
  holdRowOf,
  isErasureHeld,
  MAX_HOLD_REASON,
  MAX_PRIVACY_ID,
  recordProblems,
  rowCovers,
  targetOfRow,
  type ErasureHeld,
  type HoldQuery,
  type HoldRelease,
  type HoldRow,
  type HoldTarget,
  type LegalHold,
  type NewHold,
  type PrivacyOps,
  type PrivacyRecord,
  type RecordCursor,
  type RunErasure,
  type WorkspaceErasure,
} from "../privacy.js";
export type { EraseResult, ErasureRun, SubjectExport, SubjectExportOptions } from "../runtime.js";
