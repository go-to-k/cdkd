import type { DeployEngine } from './deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from './deploy-engine.js';
import { effectiveDeletionPolicy } from '../provisioning/final-snapshot.js';
import { isInterruptedWaitError } from '../provisioning/interrupt-watch.js';
import { isWaitAbandonedError } from '../provisioning/wait-abandoned.js';
import type { CloudFormationTemplate, ResourceDeleteResult } from '../types/resource.js';
import { type ResourceChange, type ResourceState, shouldRetainResource } from '../types/state.js';
import { getLiveRenderer } from '../utils/live-renderer.js';
import { pasteableCommand } from '../utils/pasteable-command.js';
import { formatResourceLine } from '../utils/resource-line.js';
import { deleteSkipReason, deleteSkippedMessage } from './delete-outcome.js';
import { isMarkedNonRetryable } from './retryable-errors.js';

declare module './deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    provisionDelete: OmitThisParameter<typeof provisionDelete>;
  }
}

/** The `DELETE` arm of `DeployEngine.provisionResourceBody` (#4200 phase 3a). */
export async function provisionDelete(
  this: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  counts?: ProvisionCounts,
  progress?: { current: number; total: number }
): Promise<ResourceOutcomeSignal | void> {
  const resourceType = change.resourceType;
  // Sticky `provisionedBy` routing (#614) — see `provisionUpdate`.
  const existingState = stateResources[logicalId];
  const renderer = getLiveRenderer();
  const currentResource = existingState;
  if (!currentResource) {
    throw new Error(`Cannot delete ${logicalId}: resource not found in state`);
  }

  // Honor `DeletionPolicy: Retain` / `RetainExceptOnCreate`.
  // State is source of truth as of schema v5+ (cdkd records the
  // attribute on every successful create/update). The synth template
  // is consulted as a fallback for pre-v5 state that has no
  // `state.deletionPolicy` recorded yet — once that resource is
  // re-deployed under v5, the state value takes over and stays
  // authoritative even if the user removes the template attribute
  // mid-flight (a destroy mid-PR would otherwise silently downgrade
  // from Retain to Delete on a transient template edit).
  const deletionPolicy =
    currentResource.deletionPolicy ?? template?.Resources?.[logicalId]?.DeletionPolicy;
  if (shouldRetainResource(deletionPolicy)) {
    this.logger.info(
      `Retaining ${logicalId} (${resourceType}) - DeletionPolicy: ${deletionPolicy}`
    );
    delete stateResources[logicalId];
    return;
  }

  // Honor `DeletionPolicy: Snapshot` (issues #1352 / #1353) — see
  // prepareFinalSnapshotForDelete for the mechanism matrix.
  // Issue #4030: an absent policy is CloudFormation's default, which is
  // `Snapshot` for an RDS cluster or standalone instance.
  const governingPolicy = effectiveDeletionPolicy(
    resourceType,
    deletionPolicy,
    currentResource.properties
  );
  const finalSnapshotIdentifier = await this.prepareFinalSnapshotForDelete(
    logicalId,
    resourceType,
    currentResource,
    governingPolicy
  );

  // Schema v7+: route DELETE through the layer recorded on state
  // (`provisionedBy: 'cc-api'` → Cloud Control; absent / `'sdk'`
  // → SDK provider — legacy default).
  const deleteProvider = this.providerRegistry.getProviderFor({
    resourceType,
    provisionedBy: currentResource.provisionedBy,
  }).provider;

  this.logger.debug(`Deleting ${logicalId} (${resourceType})`);
  // Issue #1762: what the provider actually DID. `undefined` (the
  // back-compat `void` return) means "deleted"; a `'skipped'` outcome
  // means the resource was NOT deleted and may still be alive.
  let deleteResult: void | ResourceDeleteResult = undefined;
  const inlinePolicyClaimed = this.inlinePolicyClaimedFor(resourceType, logicalId, stateResources);
  try {
    deleteResult = await this.withRetry(
      () =>
        deleteProvider.delete(
          logicalId,
          currentResource.physicalId,
          resourceType,
          currentResource.properties,
          {
            expectedRegion: this.stackRegion,
            ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
            ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
            // Issue #4029: absent is CloudFormation's `Delete` here.
            deletionPolicy: governingPolicy ?? 'Delete',
            ...(this.options.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
            // Issue #4157: the identity evidence of the record deleted.
            recordedAttributes: currentResource.attributes,
          }
        ),
      logicalId,
      3, // fewer retries for DELETE
      5_000,
      deleteProvider
    );
  } catch (deleteError) {
    const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
    // Treat "not found" errors as success (resource already deleted) —
    // but never a USER ABORT (issues #2053 / #1952). The match is on the
    // MESSAGE, and an interrupt's message embeds a name the user chose, so
    // a logical id containing `NotFoundException` / `NoSuchEntity` made an
    // interrupted delete read as "already deleted" and dropped a live
    // resource from state. Typed check first: the substring match cannot
    // be made safe, because any needle can appear in a user-chosen name.
    //
    // The same holds for a DELIBERATE cdkd REFUSAL (issue #2301): the
    // Cloud Control pre-flight region check interpolates the LOGICAL ID
    // into its message, so a construct id containing `NotFoundException`
    // would make the refusal read as "already deleted" here and drop a
    // live foreign-region resource from state on the deploy path's
    // template-removal delete. Twin of the guard in
    // `destroy-runner.ts`; see the longer note there for why
    // `isMarkedNonRetryable` is the predicate.
    // `isWaitAbandonedError` is the THIRD member of this family (issue
    // go-to-k/cdkd#3236), and it needs its own predicate rather than
    // riding `isMarkedNonRetryable`: a DELETE abandonment is
    // deliberately left RETRYABLE so the delete can be re-issued, so it
    // carries no non-retryable marker and would fall straight through to
    // the substring match below.
    if (
      !isInterruptedWaitError(deleteError) &&
      !isMarkedNonRetryable(deleteError) &&
      !isWaitAbandonedError(deleteError) &&
      (msg.includes('does not exist') ||
        msg.includes('was not found') ||
        msg.includes('not found') ||
        msg.includes('No policy found') ||
        msg.includes('NoSuchEntity') ||
        msg.includes('NotFoundException') ||
        msg.includes('ResourceNotFoundException'))
    ) {
      this.logger.debug(`Resource ${logicalId} already deleted (${msg}), removing from state`);
    } else {
      throw deleteError;
    }
  }

  // Issue #1762: handled OUTSIDE the catch above on purpose — a skip is
  // a RETURN VALUE, so it can never be read by that block's
  // already-deleted message classifier, whatever a provider puts in
  // `reason`. Reading a skip as "already deleted" is precisely the
  // mis-accounting this branch used to commit.
  const deleteSkipped = deleteSkipReason(deleteResult);
  if (deleteSkipped !== undefined) {
    if (progress) progress.current++;
    const skipPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    renderer.removeTask(logicalId);
    this.logger.info(
      `${skipPrefix}${formatResourceLine(
        'skipped',
        logicalId,
        resourceType,
        `skipped (${deleteSkipped})`
      )}`
    );
    this.logger.warn(
      deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        deleteSkipped,
        'while removing it from the template'
      ) +
        `. Its cdkd state record was KEPT, so the next 'cdkd deploy' re-attempts the ` +
        `delete. Repair the record first (for a nested stack it is the CHILD's own ` +
        `state, whose other resources may already be gone), or delete the resource by ` +
        `hand and drop the record.` +
        // `--stack-region` on BOTH, and `state orphan` is why: without
        // it that command drops the record for this NAME IN EVERY REGION
        // (`orphanCommandFor`'s header in `export.ts` states the same
        // rule), so an operator repairing one region would silently
        // orphan the resources another region's record points at. M2 of
        // the go-to-k/cdkd#3499 review.
        `\nInspect it with: ${
          pasteableCommand('cdkd state show', [
            { value: stackName, hole: 'stack' },
            { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
          ]).command
        }` +
        `\nDrop the record with: ${
          pasteableCommand('cdkd state orphan', [
            { value: stackName, hole: 'stack' },
            { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
          ]).command
        }`
    );
    // Deliberately NO `delete stateResources[logicalId]` and NO
    // `counts.deleted++`. Dropping the record is the data-loss half:
    // the user would have neither the AWS resource deleted nor a cdkd
    // record pointing at it. Keeping it also means the resource is
    // still diffed as a DELETE next run, which is why a skip here is a
    // warning rather than a resource failure — unlike `cdkd destroy`,
    // `cdkd deploy` self-heals on the next run.
    if (counts) counts.deleteSkipped++;
    return { deleteSkipped };
  }

  delete stateResources[logicalId];
  if (counts) counts.deleted++;
  if (progress) progress.current++;
  const deletePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
  renderer.removeTask(logicalId);
  this.logger.info(`${deletePrefix}${formatResourceLine('deleted', logicalId, resourceType)}`);
  return;
}
