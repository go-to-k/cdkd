import type { DeployEngine } from '../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import { effectiveDeletionPolicy } from '../../provisioning/final-snapshot.js';
import { isInterruptedWaitError } from '../../provisioning/interrupt-watch.js';
import { isWaitAbandonedError } from '../../provisioning/wait-abandoned.js';
import type { CloudFormationTemplate, ResourceDeleteResult } from '../../types/resource.js';
import {
  type ResourceChange,
  type ResourceState,
  shouldRetainResource,
} from '../../types/state.js';
import {
  accountArgs,
  hasAddressablePhysicalId,
  withheldAccountClause,
} from '../../state/malformed-resources-bag.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { getLiveRenderer } from '../../utils/live-renderer.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import { formatResourceLine } from '../../utils/resource-line.js';
import { deleteSkipReason, deleteSkippedMessage } from '../delete-outcome.js';
import { reportDeleteGuards } from '../delete-guard-scope.js';
import { isMarkedNonRetryable } from '../retryable-errors.js';
import { nestedChildStackName } from '../nested-child-journal.js';
import { noteRetainedResource } from '../../provisioning/providers/create-token-ledger.js';

declare module '../deploy-engine.js' {
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
    // go-to-k/cdkd#4438: the kept resource still holds this stack's create
    // token, so a later create of the logical id must not send it again.
    await noteRetainedResource(resourceType, logicalId);
    return;
  }

  // go-to-k/cdkd#3211: a record with no usable physical id cannot be
  // ADDRESSED, so it takes the skip below (record kept, `cdkd deploy`
  // re-attempts the delete) without a provider call, as `cdkd destroy` does.
  // What the call would have done is why it may not be made: the catch below
  // reads a `*NotFound` as ALREADY DELETED and drops the record of a resource
  // still live. Below the retention branch, which never addresses the
  // resource, and above the final-snapshot preparation, which names the
  // snapshot after the id. A nested-stack row is EXEMPT: its delete finds the
  // child by name and never reads the id. Not one recorded on Cloud Control,
  // whose delete addresses AWS by the id (a hand-edited shape; keeping the
  // record is the safe direction).
  // The RECORD's type, as the UPDATE arm reads it: the record is what the
  // delete addresses.
  const deletedByName =
    currentResource.resourceType === 'AWS::CloudFormation::Stack' &&
    currentResource.provisionedBy !== 'cc-api';
  if (!deletedByName && !hasAddressablePhysicalId(currentResource)) {
    const reason = 'state record has no physical id';
    if (progress) progress.current++;
    const skipPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    renderer.removeTask(logicalId);
    const skipLine = formatResourceLine('skipped', logicalId, resourceType, `skipped (${reason})`);
    this.logger.info(safeMsg`${skipPrefix}${skipLine}`);
    // The run's account flags ride on both commands (go-to-k/cdkd#4648), so a
    // pasted drop removes the record in the bucket this deploy read.
    const recovery = this.options.refusalRecovery;
    const account = accountArgs(recovery);
    const showCommand = pasteableCommand('cdkd state show', [
      { value: stackName, hole: 'stack', opts: { plainIdent: true } },
      { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
      ...account,
    ]).command;
    const dropCommand = pasteableCommand('cdkd state orphan', [
      { value: stackName, hole: 'stack', opts: { plainIdent: true } },
      { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
      { flag: '--resource', value: logicalId, hole: 'logicalId', opts: { plainIdent: true } },
      ...account,
    ]).command;
    const accountClause = withheldAccountClause(
      recovery,
      'the command lines below print'
    ).trimEnd();
    this.logger.warn(
      safeMsg`Resource ${displaySafe(logicalId)} (${displaySafe(resourceType)}) has no non-empty string 'physicalId' in its state record, so cdkd cannot address it in AWS and did not try to delete it while removing it from the template. Its cdkd state record was KEPT, so the next 'cdkd deploy' re-attempts the delete. Repair the record's 'physicalId', or delete the resource by hand and drop the record.${accountClause === '' ? '' : ` ${accountClause}`}
Inspect it with: ${showCommand}
Drop the record with: ${dropCommand}`
    );
    if (counts) counts.deleteSkipped++;
    return { deleteSkipped: reason };
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
  const deleteRoute = this.providerRegistry.getProviderFor({
    resourceType,
    provisionedBy: currentResource.provisionedBy,
  });
  const deleteProvider = deleteRoute.provider;

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

  // Issue #2422: a guard the delete could not enforce, for
  // `provisionResource` to persist.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType,
    // The layer the delete was ROUTED to, which a legacy record without
    // `provisionedBy` does not name.
    provisionedBy: deleteRoute.provisionedBy,
  });

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
    // go-to-k/cdkd#4602: this stack is still DEPLOYED, so the drop names ONE
    // record, never the whole-stack `cdkd state orphan <stack>`, which drops
    // every live resource's record. A nested stack's row is the exception:
    // `--resource` refuses it while the child's record exists, and the record
    // to repair is the CHILD's (`<parent>~<logicalId>`, in this region), which
    // this delete removes whole -- once it is gone, the next deploy's
    // re-attempt finds no child state and drops this row itself.
    const nested = resourceType === 'AWS::CloudFormation::Stack';
    const recordStack = nested ? nestedChildStackName(stackName, logicalId) : stackName;
    // `NestedStackProvider.delete` puts an interrupt LAST in its reason
    // (`... was interrupted`), after the child name, so a name cannot forge
    // it. An interrupted child destroy is resumed by re-running the deploy;
    // advising to drop its record first would untrack resources mid-teardown.
    const interrupted = nested && deleteSkipped.endsWith(' was interrupted');
    const recovery = this.options.refusalRecovery;
    const account = accountArgs(recovery);
    const accountClause = withheldAccountClause(
      recovery,
      'the command lines below print'
    ).trimEnd();
    // The hole names WHOSE record it is, so a withheld child name is not
    // filled in with the parent's (the deployed stack this run named).
    const stackArg = {
      value: recordStack,
      hole: nested ? 'child-stack' : 'stack',
      opts: { plainIdent: true },
    };
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
        (interrupted
          ? ` The commands name the child stack record. Its destroy was interrupted: re-run ` +
            `'cdkd deploy' to resume it, and drop the child record only if that cannot finish, ` +
            `after deleting by hand what the child still holds (the inspect command with ` +
            `--show-nested lists every level; a child with nested stacks of its own has records ` +
            `under '<child>~<logicalId>' too, each needing the same drop).`
          : nested
            ? ` The commands name the child stack record. Dropping it drops every record the ` +
              `child still has and nothing reaches those resources again, so first delete by hand ` +
              `what the child still holds (the inspect command with --show-nested lists every ` +
              `level; a child with nested stacks of its own has records under ` +
              `'<child>~<logicalId>' too, each needing the same drop). The next 'cdkd deploy' ` +
              `then removes this row.`
            : ` Keep '--resource' on the drop: without it the command drops the record of every ` +
              `resource in this still-deployed stack.`) +
        // `--stack-region` on BOTH, and `state orphan` is why: without
        // it that command drops the record for this NAME IN EVERY REGION
        // (`orphanCommandFor`'s header in `export.ts` states the same
        // rule), so an operator repairing one region would silently
        // orphan the resources another region's record points at. M2 of
        // the go-to-k/cdkd#3499 review.
        // The run's account flags ride on both commands (go-to-k/cdkd#4648).
        (accountClause === '' ? '' : ` ${accountClause}`) +
        `\nInspect it with: ${
          pasteableCommand('cdkd state show', [
            stackArg,
            { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
            ...account,
          ]).command
        }` +
        `\nDrop the record with: ${
          pasteableCommand('cdkd state orphan', [
            stackArg,
            { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
            // The same gate `stateOrphanRecordRemedy` puts the id through.
            ...(nested
              ? []
              : [
                  {
                    flag: '--resource',
                    value: logicalId,
                    hole: 'logicalId',
                    opts: { plainIdent: true },
                  },
                ]),
            ...account,
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
