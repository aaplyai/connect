/**
 * `@aaply/flow/migrate`: moving runs between versions of a flow:
 * `checkMigration` and `planMigration` (pure), `migrateStep`, the move
 * policy (`decideMove`, `MigrationPolicy`, approvals and revocations), the
 * runtime's migrate and sweep responses, and `storedRunsUse`.
 */

export { storedRunsUse, type VersionInUse } from "../catalog.js";
export {
  CARRY,
  checkMigration,
  isTemporaryBlocker,
  MAX_MOVES_PER_RUN,
  migrateStep,
  planMigration,
  TEMPORARY_BLOCKERS,
  type CarryRule,
  type FactOutcome,
  type MigrationPlan,
} from "../migrate.js";
export { MAX_MIGRATION_SOURCES, MAX_MIGRATIONS, type CompiledMigration } from "../migration-def.js";
export type { MigrationApproval, MigrationPolicy, Revocation, VersionStatus } from "../ports.js";
export type { MigrateResponse, SweepResponse } from "../runtime.js";
export { decideMove, revokedOf, validApproval, type MoveDecision, type MoveTrigger } from "../versions.js";
