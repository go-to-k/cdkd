/**
 * The success-path rule of `settleJournaledOrphansOnSuccess`
 * (go-to-k/cdkd#4600, #4606), split out of `journaled-orphans.ts`
 * (go-to-k/cdkd#5835).
 */
import type { ResourceState } from '../../../types/state.js';
import type { ResourceIdentityVerdict } from '../../../types/resource.js';
import type { Logger } from '../../../types/config.js';
import { askForeignHolder, createdResourceStillThere } from '../orphan-identity.js';
import { samePhysicalId } from '../../replacement-name-holder/name-keys.js';
import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  type FailedOperation,
  type RollbackExecutorContext,
  isReplacedRecord,
  markProvenDistinctFromRecord,
} from '../../rollback-executor.js';
import type { JournaledOrphans } from '../journaled-orphans.js';
import type { ForeignHolding } from './foreign-holder-scan.js';

/**
 * The success-path rule (see `settleJournaledOrphansOnSuccess`): demote
 * every proven orphan this deploy's outcome may own, and return those whose
 * ownership could not be read (kept, not acted on), those settled without
 * a delete: a record of this stack tracks them, or AWS reports them gone
 * (go-to-k/cdkd#4655), and those it proved deletable (`proven`, which the
 * replay's delete then does not ask again).
 */
export async function applySuccessRule(
  orphans: JournaledOrphans,
  stateResources: Record<string, ResourceState>,
  deployLogicalIds: ReadonlySet<string>,
  foreignHolder: (resourceType: string, physicalId: string) => Promise<ForeignHolding>,
  stack: string,
  logger: Logger,
  isInterrupted: (() => boolean) | undefined,
  identityCtx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'>
): Promise<{
  unreadable: Set<FailedOperation>;
  tracked: Set<FailedOperation>;
  proven: Set<FailedOperation>;
}> {
  const unreadable = new Set<FailedOperation>();
  const tracked = new Set<FailedOperation>();
  const proven = new Set<FailedOperation>();
  let interrupted = false;
  for (const { ops } of orphans.segments) {
    for (const op of ops) {
      if (op.physicalIdRecoveredFromError !== true || !op.physicalId) continue;
      // An interrupt stops the scan; what it did not reach is kept untouched.
      if (interrupted || isInterrupted?.()) {
        interrupted = true;
        unreadable.add(op);
        continue;
      }
      // A record of this stack holding this very resource tracks it (an
      // idempotent create, an adoption): settled here, silently, without the
      // classifier, whose same-logical-id check would call a record holding
      // another resource under that id a mismatch. Under the type's case rule
      // (go-to-k/cdkd#4692): `mycluster` holds the cluster `MyCluster` names.
      const opId = op.physicalId;
      if (
        Object.values(stateResources).some(
          (r) =>
            r?.resourceType === op.resourceType &&
            typeof r.physicalId === 'string' &&
            samePhysicalId(op.resourceType, r.physicalId, opId)
        )
      ) {
        tracked.add(op);
        continue;
      }
      // go-to-k/cdkd#4604: a replacement's new resource shares its logical
      // id with the resource it was replacing; a record still naming THAT
      // resource is not one this deploy or a later one put there.
      const hasRecord = Object.prototype.hasOwnProperty.call(stateResources, op.logicalId);
      const record = hasRecord ? stateResources[op.logicalId] : undefined;
      const recordUnderId = hasRecord && !isReplacedRecord(op, record);
      if (recordUnderId || deployLogicalIds.has(op.logicalId)) {
        // go-to-k/cdkd#4606: the fix-forward. A record under the id may hold
        // a NEW resource; only the provider's live read can tell, and only
        // its `'different'` lets the orphan on to the delete below.
        const verdict = recordUnderId
          ? await recordIdentity(op, record, identityCtx, logger)
          : 'unknown';
        if (verdict === 'same') {
          tracked.add(op);
          continue;
        }
        if (verdict !== 'different') {
          op.physicalIdRecoveredFromError = false;
          continue;
        }
        markProvenDistinctFromRecord(op, record!);
      }
      const holding = await askForeignHolder(foreignHolder, { ...op, physicalId: op.physicalId });
      if (holding === undefined) {
        // go-to-k/cdkd#4655: the last check before the delete. A name-keyed
        // id may now name a resource made after the orphan was removed.
        const created = await createdResourceStillThere(op, identityCtx);
        if (created === 'proven') proven.add(op);
        else if (created === 'gone') {
          // Settled without a delete: one sent later, after the other
          // orphans' reads and deletes, could reach a resource created under
          // the name in between.
          logger.info(
            safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
              safeMsg`of stack ${stack} created, is already gone: nothing to delete.`
          );
          tracked.add(op);
        } else if (created === 'mismatch') {
          logger.warn(
            safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
              safeMsg`of stack ${stack} created, is not deleted: the resource now under its physical id is another ` +
              'one (its identity differs from the one that deploy recorded, so its name was reused).'
          );
          op.physicalIdRecoveredFromError = false;
        } else if (created === 'unproven') {
          logger.warn(
            safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
              safeMsg`of stack ${stack} created, is not deleted: nothing proves the resource now under its physical ` +
              'id is the one that deploy created (it may have been deleted and its name reused).'
          );
          op.physicalIdRecoveredFromError = false;
        }
        continue;
      }
      if (holding.kind === 'held') {
        logger.warn(
          safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
            safeMsg`of stack ${stack} created, is not deleted: ${holding.by} holds a resource of that type under ` +
            'the same physical id.'
        );
        op.physicalIdRecoveredFromError = false;
        continue;
      }
      logger.warn(
        safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
          safeMsg`of stack ${stack} created, is not deleted: ${holding.what}, so whether another stack holds it is unknown.`
      );
      unreadable.add(op);
    }
  }
  return { unreadable, tracked, proven };
}

/**
 * go-to-k/cdkd#4606: whether the proven orphan `op` is the resource `record`
 * (the record under its logical id) holds, by the provider's live read
 * (`ResourceProvider.isSameResource`), asked through the provider the orphan's
 * delete would take. `'unknown'` for a record of another type or without a
 * physical id, a provider without the method, and any error: the caller then
 * keeps today's warn-and-skip.
 */
async function recordIdentity(
  op: FailedOperation,
  record: ResourceState | undefined,
  ctx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'>,
  logger: Logger
): Promise<ResourceIdentityVerdict> {
  if (
    typeof record !== 'object' ||
    record === null ||
    record.resourceType !== op.resourceType ||
    typeof record.physicalId !== 'string' ||
    record.physicalId === '' ||
    !op.physicalId
  ) {
    return 'unknown';
  }
  try {
    const { provider } = ctx.providerRegistry.getProviderFor({
      resourceType: op.resourceType,
      provisionedBy: op.provisionedBy,
    });
    if (typeof provider.isSameResource !== 'function') return 'unknown';
    return await provider.isSameResource(
      op.physicalId,
      {
        physicalId: record.physicalId,
        ...(record.provisionedBy !== undefined && { provisionedBy: record.provisionedBy }),
      },
      op.resourceType,
      { expectedRegion: ctx.region }
    );
  } catch (err) {
    // The error CLASS only: AWS's text may quote the account and role, or a
    // resource name this line has no masker for (go-to-k/cdkd#3869). The
    // warn-and-skip that follows names the resource, masked.
    logger.debug(
      safeMsg`Could not compare ${logicalIdShown(op.logicalId)}'s journaled resource with its state record (${displaySafe(err instanceof Error ? err.name : typeof err)}).`
    );
    return 'unknown';
  }
}
