import type { FailedOperation } from '../../rollback-executor.js';

/**
 * go-to-k/cdkd#6118: an UPDATE that deleted and created nothing (a refused one, or one failing before its first write). Its
 * record is still journaled (the #4355 / #5064 supersede semantics rely on
 * it), but there is nothing for `cdkd rollback --revert-failed` to revert, so
 * the settle must not advertise it. Provable only from what the journaled op
 * itself says: an UPDATE with no attempted bag (the mark drops it) and none
 * of the fields a made or deleted resource sets. A replacement-orphan
 * companion op is a CREATE, so it never qualifies. Assumes the journal was
 * written by a cdkd that records the attempted bag (#1198 onward): an older
 * one's partially applied UPDATE also lacks it and would read as nothing.
 */
export function appliedNothing(op: FailedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    op.attemptedProperties === undefined &&
    op.replacementOrphaned === undefined &&
    op.oldDeletedBeforeCreate !== true &&
    op.physicalIdRecoveredFromError !== true &&
    op.pendingCloudControlRequest === undefined &&
    op.nameGeneration === undefined
  );
}
