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
import type { FailedOperation, RollbackExecutorContext } from './types.js';

/**
 * After the `revert-failed-update` arm threw: whether AWS reports the op's
 * resource gone, in which case the op is recorded as skipped (warned, counted,
 * `ROLLBACK_RESOURCE_SKIPPED`) and the caller must not count a failure.
 */
export async function skippedAsDeletedOutsideCdkd(
  action: string,
  op: FailedOperation,
  logger: Pick<RollbackExecutorContext['logger'], 'warn'>,
  skipScope: Parameters<typeof recordRollbackSkip>[0] & {
    ctx: Pick<RollbackExecutorContext, 'providerRegistry'>;
  }
): Promise<boolean> {
  if (action !== 'revert-failed-update') return false;
  if (
    !(await failedUpdateResourceIsGone({ providerRegistry: skipScope.ctx.providerRegistry }, op))
  ) {
    return false;
  }
  logger.warn(skipScope.mask(`  Rollback: ${deletedOutsideCdkdMessage(op, true)}`));
  recordRollbackSkip(skipScope, op, DELETED_OUTSIDE_SKIP_CAUSE);
  return true;
}
