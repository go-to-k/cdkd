/**
 * `DeployEngine`'s rollback driving and rollback-journal settles. Entry
 * module: the code lives in `deploy-engine/rollback/` (go-to-k/cdkd#5835),
 * and every symbol this file exported is re-exported here, so no importer
 * changes.
 */
export type { RollbackDeps } from './rollback/deps.js';
export { adoptRollbackOrphans, redactOperationsForJournal } from './rollback/adopt-orphans.js';
export { performRollback } from './rollback/perform.js';
export type { UnsettledRevertHooks } from './rollback/unsettled-revert.js';
export { revertUnsettledFailedUpdates } from './rollback/unsettled-revert.js';
export {
  deleteRollbackJournalBestEffort,
  settleJournalAfterCleanRollback,
  settleJournalAfterSuccess,
  settleNestedChildrenAfterCleanRollback,
} from './rollback/settle.js';
export {
  producerRegionEvidence,
  recoveryHint,
  rollbackExecutorContext,
} from './rollback/context.js';
export { writeRollbackJournalSegment } from './rollback/journal-write.js';
