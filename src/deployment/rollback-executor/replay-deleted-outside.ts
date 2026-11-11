/**
 * go-to-k/cdkd#6106: a force-revert of a resource AWS reports gone (deleted
 * outside cdkd) fails on every re-run, so `replayFailedOperations` skips the
 * op with `cdkd drift`'s remedy and it leaves the journal instead of failing.
 */
import {
  DELETED_OUTSIDE_SKIP_CAUSE,
  deletedOutsideCdkdMessage,
  failedUpdateResourceIsGone,
} from '../deleted-outside-cdkd.js';
import { recordRollbackSkip } from './messages.js';
import type { ResourceState } from '../../types/state.js';
import type { FailedOpReplayResult, FailedOperation, RollbackExecutorContext } from './types.js';

/**
 * After the `revert-failed-update` arm threw: whether AWS reports the op's
 * resource gone, in which case the op is recorded as skipped (warned, counted,
 * `ROLLBACK_RESOURCE_SKIPPED`) and the caller must not count a failure. Only
 * when the record still names the resource the read addressed: the revert
 * targets the current record, which a later segment's replacement may have
 * moved to another id, and a failure there says nothing about the old one.
 */
export async function skippedAsDeletedOutsideCdkd(
  action: string,
  op: FailedOperation,
  logger: Pick<RollbackExecutorContext['logger'], 'warn'>,
  skipScope: Parameters<typeof recordRollbackSkip>[0] & {
    ctx: Pick<RollbackExecutorContext, 'providerRegistry'>;
    result: Pick<FailedOpReplayResult, 'deletedOutsideOps'>;
    stateResources: Record<string, ResourceState | undefined>;
  }
): Promise<boolean> {
  if (action !== 'revert-failed-update') return false;
  const current = skipScope.stateResources[op.logicalId];
  if (current === undefined || current.physicalId !== op.previousState?.physicalId) return false;
  if (
    !(await failedUpdateResourceIsGone({ providerRegistry: skipScope.ctx.providerRegistry }, op))
  ) {
    return false;
  }
  logger.warn(skipScope.mask(`  Rollback: ${deletedOutsideCdkdMessage(op, true)}`));
  recordRollbackSkip(skipScope, op, DELETED_OUTSIDE_SKIP_CAUSE);
  (skipScope.result.deletedOutsideOps ??= []).push(op);
  return true;
}
