/**
 * go-to-k/cdkd#6120: the rollback twin of go-to-k/cdkd#6117's cleanup. A
 * rollback `update()` whose provider moved the resource to another physical
 * id and left the id it moved off live (`oldPhysicalIdLeftForCleanup`: a
 * custom resource whose handler answered a new `PhysicalResourceId`) leaves
 * that id with the handler. CloudFormation sends it a `Delete` in
 * `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS`, once the rollback has
 * completed; so does cdkd, from the queue below, which a replay runs after
 * its last op.
 */
import type { ResourceProvider, ResourceUpdateResult } from '../../types/resource.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../../types/state.js';
import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import { replacementDeletePolicy } from '../../provisioning/final-snapshot.js';
import { displaySafe } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  addSuperseded,
  canRecordSuperseded,
  removeSuperseded,
  SUPERSEDED_KEPT_REMEDY,
} from '../superseded-resources.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { withReplayDeletePrinting } from './replay-scope.js';
import { safe, shownLogicalId, throwIfDeleteSkipped } from './messages.js';
import type { MaskerFn } from '../../provisioning/masked-retry-logger.js';
import type { RollbackExecutorContext, RollbackReplayResult } from './types.js';

/** One id a rollback `update()` moved off, waiting for the end of the replay. */
interface MovedIdCleanup {
  readonly logicalId: string;
  /** The record the rollback `update()` was sent to: the id moved off. */
  readonly sent: ResourceState;
  readonly provider: ResourceProvider;
  readonly provisionedBy: 'sdk' | 'cc-api' | undefined;
  /** Set when the id is kept in `supersededResources` until its delete settles. */
  readonly superseded: SupersededResourceRecord | undefined;
  readonly secrets: RecordedSecretValues;
  readonly mask: MaskerFn;
}

/**
 * The ids a replay's rollback `update()`s moved off, deleted after its last
 * op. `onSuperseded` / `onSupersededSettled` are the driver's
 * `supersededResources` writers (go-to-k/cdkd#5111), as for a deferred
 * reverse-replacement delete; absent, the id is kept in memory only.
 */
export interface MovedIdCleanupQueue {
  readonly pending: MovedIdCleanup[];
  readonly onSuperseded: ((entry: SupersededResourceRecord) => void) | undefined;
  readonly onSupersededSettled: ((entry: SupersededResourceRecord) => void) | undefined;
}

export function newMovedIdCleanupQueue(hooks: {
  onSuperseded?: ((entry: SupersededResourceRecord) => void) | undefined;
  onSupersededSettled?: ((entry: SupersededResourceRecord) => void) | undefined;
}): MovedIdCleanupQueue {
  return {
    pending: [],
    onSuperseded: hooks.onSuperseded,
    onSupersededSettled: hooks.onSupersededSettled,
  };
}

/**
 * `cdkd rollback`'s options for a segment's two replays (spread into both):
 * the driver's superseded writers, plus ONE shared queue when the segment has
 * completed ops, so an id a `--revert-failed` update moved off is deleted
 * only after those are reverted too (the rollback's cleanup phase). The
 * failed-op replay runs it itself only when interrupted (nothing is sent).
 */
export function segmentCleanupOptions(
  shared: boolean,
  host: Pick<StackState, 'supersededResources'>
): {
  onSuperseded: (entry: SupersededResourceRecord) => void;
  onSupersededSettled: (entry: SupersededResourceRecord) => void;
  movedIdCleanups?: MovedIdCleanupQueue;
} {
  const hooks = {
    onSuperseded: (entry: SupersededResourceRecord) => addSuperseded(host, entry),
    onSupersededSettled: (entry: SupersededResourceRecord) => removeSuperseded(host, entry),
  };
  return shared ? { ...hooks, movedIdCleanups: newMovedIdCleanupQueue(hooks) } : hooks;
}

/**
 * Called by a rollback UPDATE arm right after it recorded the `update()`'s
 * answer and BEFORE its `afterOp` save: when the provider moved the resource
 * off the id the update was sent to and left that id live, queue its delete.
 *
 * - `UpdateReplacePolicy: Retain` on the record keeps it (no delete, a line
 *   naming it), as CloudFormation retains a replaced resource under it, and
 *   as go-to-k/cdkd#6117's deploy cleanup does. So does `Snapshot` unless
 *   `--skip-final-snapshot`: a custom resource takes no snapshot.
 * - Otherwise the record moved off is reported as superseded first, so a run
 *   killed before the delete leaves it for the next deploy or `cdkd destroy`
 *   (only a record a later run can delete: `canRecordSuperseded`, which
 *   refuses one holding a NoEcho mask).
 */
export function queueMovedIdCleanup(
  queue: MovedIdCleanupQueue | undefined,
  scope: {
    ctx: Pick<RollbackExecutorContext, 'logger' | 'skipFinalSnapshot'>;
    result: Pick<RollbackReplayResult, 'warnings'>;
    mask: MaskerFn;
    /** The records after the arm recorded the `update()`'s answer. */
    stateResources: Record<string, ResourceState>;
  },
  op: { logicalId: string },
  /** The record the rollback `update()` was sent to. */
  sent: ResourceState,
  answer: Pick<ResourceUpdateResult, 'oldPhysicalIdLeftForCleanup'> | undefined,
  route: {
    provider: ResourceProvider;
    provisionedBy: 'sdk' | 'cc-api' | undefined;
    secrets: RecordedSecretValues;
  }
): void {
  const { logicalId } = op;
  const { mask } = scope;
  if (queue === undefined || answer?.oldPhysicalIdLeftForCleanup !== true) return;
  if (scope.stateResources[logicalId]?.physicalId === sent.physicalId) return;
  const shown = displaySafe(mask(String(displayPhysicalId(sent.resourceType, sent.physicalId))));
  const policy = sent.updateReplacePolicy;
  if (policy === 'Retain') {
    scope.ctx.logger.info(
      mask(
        `  Rollback: ${safe(logicalId)} has UpdateReplacePolicy: Retain — the physical id it ` +
          `moved off (${shown}) is not sent a Delete and is no longer tracked by cdkd`
      )
    );
    return;
  }
  if (policy === 'Snapshot' && scope.ctx.skipFinalSnapshot !== true) {
    scope.ctx.logger.warn(
      mask(
        `  ⚠ Rollback: ${safe(logicalId)} has UpdateReplacePolicy: Snapshot, which a custom ` +
          `resource cannot take — the physical id it moved off (${shown}) is not sent a Delete ` +
          `and is no longer tracked by cdkd`
      )
    );
    scope.result.warnings++;
    return;
  }
  const record = canRecordSuperseded(sent, {});
  const superseded: SupersededResourceRecord | undefined =
    record && queue.onSuperseded !== undefined
      ? {
          logicalId,
          supersededAt: Date.now(),
          state: sent,
          ...((policy === 'Delete' || policy === 'RetainExceptOnCreate') && {
            updateReplacePolicy: policy,
          }),
        }
      : undefined;
  if (superseded !== undefined) queue.onSuperseded?.(superseded);
  queue.pending.push({
    logicalId,
    sent,
    provider: route.provider,
    provisionedBy: route.provisionedBy,
    superseded,
    secrets: route.secrets,
    mask,
  });
  scope.ctx.logger.info(
    mask(
      `  Rollback: ${safe(logicalId)} moved off ${shown}, which is sent a Delete once the ` +
        `rollback completes`
    )
  );
}

/**
 * Send every queued delete, after the replay's last op. Never throws: a
 * failed or declined delete warns naming the id; a recorded one stays in
 * `supersededResources` for the next deploy, anything else is untracked (a
 * line and a `ROLLBACK_RESOURCE_SUCCEEDED` event name it). Interrupted,
 * nothing is sent: a recorded id is kept for the next deploy, an unrecorded
 * one is named as untracked. An id a record of the stack holds by then is
 * never deleted. A failed state save after a settled entry only warns.
 */
export async function runMovedIdCleanups(
  queue: MovedIdCleanupQueue,
  scope: {
    stateResources: Record<string, ResourceState>;
    stackName: string;
    ctx: RollbackExecutorContext;
    result: RollbackReplayResult;
    afterOp: ((logicalId: string) => Promise<void> | void) | undefined;
    interrupted: boolean;
  }
): Promise<void> {
  const { stateResources, stackName, ctx, result, afterOp } = scope;
  const { logger } = ctx;
  const entries = queue.pending.splice(0);
  for (const entry of entries) {
    const { logicalId, sent, mask, superseded } = entry;
    const shown = displaySafe(mask(String(displayPhysicalId(sent.resourceType, sent.physicalId))));
    const untracked = (why: string): void => {
      ctx.recordEvent?.({
        eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
        stackName,
        operation: 'UPDATE',
        logicalId,
        resourceType: sent.resourceType,
        ...(entry.provisionedBy && { provisionedBy: entry.provisionedBy }),
        physicalId: sent.physicalId,
        reason: mask(
          `The rollback moved ${logicalId} off ${sent.physicalId}, which ${why}; it is no ` +
            `longer tracked by cdkd.`
        ),
      });
    };
    if (scope.interrupted) {
      logger.warn(
        mask(
          `  Rollback: the physical id ${safe(logicalId)} moved off (${shown}) was not sent its ` +
            `Delete: the rollback was interrupted. ` +
            (superseded !== undefined
              ? `${SUPERSEDED_KEPT_REMEDY}.`
              : `It is no longer tracked by cdkd; delete what the handler made under it manually.`)
        )
      );
      result.warnings++;
      if (superseded === undefined) untracked('was not sent its Delete (interrupted)');
      continue;
    }
    const settle = async (): Promise<void> => {
      if (superseded === undefined) return;
      queue.onSupersededSettled?.(superseded);
      try {
        await afterOp?.(logicalId);
      } catch (saveError) {
        // The next save writes it; the delete itself is settled.
        logger.warn(
          mask(
            `  Rollback: saving state after settling the physical id ${safe(logicalId)} moved ` +
              `off (${shown}) failed: ${displaySafe(describeAwsFailure(saveError).detail)}`
          )
        );
        result.warnings++;
      }
    };
    const holder = Object.entries(stateResources).find(
      ([, record]) =>
        typeof record === 'object' && record !== null && record.physicalId === sent.physicalId
    )?.[0];
    if (holder !== undefined) {
      logger.warn(
        mask(
          `  Rollback: the physical id ${safe(logicalId)} moved off (${shown}) is not sent a ` +
            `Delete: ${safe(holder)} records the same physical id, and cdkd never ` +
            `deletes an id a record names`
        )
      );
      result.warnings++;
      await settle();
      continue;
    }
    let deleted = false;
    try {
      const outcome = await withReplayDeletePrinting(
        {
          ctx,
          op: { logicalId, changeType: 'UPDATE', resourceType: sent.resourceType },
          secrets: entry.secrets,
        },
        () =>
          entry.provider.delete(logicalId, sent.physicalId, sent.resourceType, sent.properties, {
            expectedRegion: ctx.region,
            deletionPolicy: replacementDeletePolicy(sent.updateReplacePolicy),
            recordedAttributes: sent.attributes,
            recordedCreateOnlyDrops: sent.acceptedCreateOnlyDrops,
            // go-to-k/cdkd#4043: a custom resource's delete skips, never
            // sends, a payload still holding a NoEcho mask.
            recordedNoEchoLeaves: sent.noEchoLeaves,
            maskSecrets: mask,
          })
      );
      throwIfDeleteSkipped(
        outcome,
        logicalId,
        sent.physicalId,
        'while deleting the physical id the rollback moved off',
        {
          ctx,
          stackName,
          resourceType: sent.resourceType,
          provisionedBy: entry.provisionedBy,
          mask,
        }
      );
      deleted = true;
    } catch (deleteError) {
      logger.warn(
        mask(
          `  Rollback: ${shownLogicalId(logicalId)} was restored, but deleting the physical id ` +
            `it moved off (${shown}) failed: ${displaySafe(describeAwsFailure(deleteError).detail)}. ` +
            (superseded !== undefined
              ? `${SUPERSEDED_KEPT_REMEDY}.`
              : `It is no longer tracked by cdkd; delete what the handler made under it manually.`)
        )
      );
      result.warnings++;
      if (superseded === undefined) untracked('its Delete did not complete');
    }
    if (deleted) {
      logger.info(mask(`  ✓ Rollback: ${safe(logicalId)}'s old physical id (${shown}) deleted`));
      await settle();
    }
  }
}
