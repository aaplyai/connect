/**
 * `@aaply/flow/blobs`: file references (ADR 0008): the host's `BlobHost`,
 * the blob ledger and its in-memory implementation, and erasing ended runs'
 * files (`eraseEndedRuns`).
 */

export {
  BLOB_CODES,
  MAX_BLOB_URL_LENGTH,
  MAX_INPUT_BLOB_REFS,
  type BlobArrival,
  type BlobHost,
  type BlobUrlContext,
  type BlobVouchRequest,
} from "../blob-guard.js";
export {
  createMemoryBlobLedger,
  MAX_RELEASE_PAGE,
  type BlobLedger,
  type BlobRelease,
  type BlobReleasePage,
  type MemoryBlobLedger,
  type MemoryBlobLedgerOptions,
} from "../blob-ledger.js";
export { eraseEndedRuns, type EndedRunsErasure } from "../blob-release.js";
