/**
 * `@aaply/flow/store`: what a `RunStore` implementation reads and writes
 * beyond the port itself: outbox items and leases, timers, waits,
 * workspaces, commit batches, claims, lanes and erasure options, and the
 * health counts (`StoreHealth`, `runtimeHealth`).
 */

export type { ActionDispatch } from "../approved.js";
export { HEALTH_COUNT_CAP, healthCap, runtimeHealth, type Backlog, type RuntimeHealth, type StoreHealth, type StoreHealthOptions } from "../health.js";
export {
  sameScope,
  type ClaimOptions,
  type CommitBatch,
  type CommitResult,
  type EraseOptions,
  type InlineGrant,
  type LaneOps,
  type OutboxItem,
  type OutboxLease,
  type PendingConsent,
  type PendingOffer,
  type RunWrite,
  type TimerItem,
  type WaitItem,
  type WorkspaceState,
} from "../store.js";
