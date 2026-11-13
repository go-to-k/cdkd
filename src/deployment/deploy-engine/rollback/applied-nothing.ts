import type { FailedOperation } from '../../rollback-executor.js';
import { failedCreateRecordedNoPhysicalId } from '../../rollback-executor/plan/failed-ops.js';
import { safeMsg } from '../../../utils/display-safe.js';

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

/**
 * go-to-k/cdkd#6204: a failed CREATE that `cdkd rollback --revert-failed` can
 * only skip — it recorded no physical id (the revert's `skip-failed-unknown`,
 * the same predicate) and no abandoned Cloud Control request, which the
 * revert re-polls first and may turn into a deletable orphan. It may have
 * left something behind, so its manual check is named instead of the command.
 */
export function revertSkipsFailedCreate(op: FailedOperation): boolean {
  return failedCreateRecordedNoPhysicalId(op) && op.pendingCloudControlRequest === undefined;
}

/** Whether `cdkd rollback --revert-failed` has nothing to act on for `op`. */
export function revertFailedHasNothingToDo(op: FailedOperation): boolean {
  return appliedNothing(op) || revertSkipsFailedCreate(op);
}

/** What the revert itself warns for a {@link revertSkipsFailedCreate} op. */
export function unaddressableFailedCreateMessage(op: FailedOperation): string {
  return (
    safeMsg`${op.logicalId} (${op.resourceType}): the failed CREATE recorded no physical id, ` +
    `so 'cdkd rollback --revert-failed' cannot address it — if it was partially created in AWS, delete it manually.`
  );
}
