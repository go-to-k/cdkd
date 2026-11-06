import {
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeGlobalClustersCommand,
  RemoveFromGlobalClusterCommand,
} from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
  deleteAfterProtectionFlipWithFinalSnapshot,
} from '../deletion-protection-compensation.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import type { RDSProvider } from '../rds-provider.js';
import { isClusterBusyRefusal } from './cluster-members.js';
import {
  PROTECTION_FLIP_RETRY_WAIT_MS,
  RDS_DELETE_WAIT_MS,
  deleteAutomatedBackupsInput,
  recordedGlobalClusterIdentifier,
  TRANSIENT_DETACH_FAULTS,
  awsErrorName,
  GlobalClusterDetachError,
} from './shared.js';

/**
 * The compensation boundary (issue #2204): a `--remove-protection` flip whose
 * delete then fails terminally is undone here, so a destroy that did not
 * happen does not leave a live cluster with its guard stripped.
 */
export async function deleteDBCluster(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context?: DeleteContext
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) =>
      this.deleteDBClusterOnce(logicalId, physicalId, resourceType, properties, context, flip),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site: rdsFamilyProtectionSite({
        cliService: 'rds',
        serviceLabel: 'RDS',
        kind: 'cluster',
        physicalId,
        region: context?.expectedRegion,
        notFoundFault: 'DBClusterNotFoundFault',
        isNotFound: (error) => this.isNotFoundError(error, 'DBClusterNotFoundFault'),
      }),
      // go-to-k/cdkd#5639: the flip succeeds in the window a busy cluster
      // opens, so the re-enable waits that window out too, within the same
      // bounded budget, rather than leaving the guard off on one refusal.
      reEnable: async () => {
        await modifyDbInstanceWhenAvailable({
          send: () =>
            this.getClient().send(
              new ModifyDBClusterCommand({
                DBClusterIdentifier: physicalId,
                DeletionProtection: true,
                ApplyImmediately: true,
              })
            ),
          readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
          sleep: (ms) => this.sleep(ms),
          logger: this.logger,
          label: 'RDS DBCluster',
          subject: 'cluster',
          isRefusal: isClusterBusyRefusal,
          logicalId,
          remainingMs: enclosingDeadlineRemainingMs(),
          maxWaitMs: PROTECTION_FLIP_RETRY_WAIT_MS,
          command: 'destroy',
        });
      },
    },
  });
}

export async function deleteDBClusterOnce(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting DBCluster ${logicalId}`);
  // Issue #4029: set once a global-cluster detach was issued, so a delete
  // failing after it says the cluster is already standalone.
  let detachedFrom: string | undefined;
  // go-to-k/cdkd#4946: set once the detach is accepted, even when its wait
  // then fails: a detached cluster is not the global member its record
  // describes, so a refused delete is never read as a whole survivor.
  const progress: DeleteProgress = { stripped: false };

  try {
    // `--remove-protection`: flip DeletionProtection off in-place
    // before delete. Idempotent — RDS accepts the call when protection
    // is already disabled. Non-fatal: log at debug if the flip-off
    // errors (e.g. NotFound) so the actual delete still proceeds. The
    // pre-flip readback is what lets a terminal failure restore ONLY a
    // guard this run turned off (issue #2204).
    if (context?.removeProtection === true) {
      try {
        await observeThenDisableProtection({
          flip,
          logger: this.logger,
          physicalId,
          mask: context?.maskSecrets,
          guardName: 'DeletionProtection',
          observe: async () =>
            (await this.describeDBCluster(physicalId))?.DeletionProtection === true,
          // go-to-k/cdkd#5639: RDS refuses the flip while the cluster is
          // busy (a member still taking its settings); wait that out and
          // resend, within a bounded budget.
          disable: async () => {
            await modifyDbInstanceWhenAvailable({
              send: () =>
                this.getClient().send(
                  new ModifyDBClusterCommand({
                    DBClusterIdentifier: physicalId,
                    DeletionProtection: false,
                    ApplyImmediately: true,
                  })
                ),
              readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
              sleep: (ms) => this.sleep(ms),
              logger: this.logger,
              label: 'RDS DBCluster',
              subject: 'cluster',
              isRefusal: isClusterBusyRefusal,
              logicalId,
              remainingMs: enclosingDeadlineRemainingMs(),
              maxWaitMs: PROTECTION_FLIP_RETRY_WAIT_MS,
              command: 'destroy',
            });
          },
        });
        this.logger.debug(`Disabled DeletionProtection on DBCluster ${logicalId} before delete`);
      } catch (disableError) {
        if (!this.isNotFoundError(disableError, 'DBClusterNotFoundFault')) {
          this.logger.debug(
            maskerOrIdentity(context?.maskSecrets)(
              `Could not disable deletion protection for DBCluster ${logicalId}: ${describeAwsFailure(disableError).detail}`
            )
          );
        }
      }
    }

    // Issue #4029: a global-cluster member cannot be deleted until it is
    // detached, which is what the Cloud Control handler did before its own
    // (unwanted) final snapshot.
    const globalClusterId = recordedGlobalClusterIdentifier(properties);
    if (globalClusterId !== undefined) {
      detachedFrom = (await this.detachFromGlobalCluster(
        logicalId,
        physicalId,
        globalClusterId,
        { beforeDelete: true, removeProtection: context?.removeProtection === true },
        progress,
        maskerOrIdentity(context?.maskSecrets)
      ))
        ? globalClusterId
        : undefined;
    }

    // `DeletionPolicy: Snapshot` (issue #1352): flip to the atomic
    // final-snapshot delete when the destroy call site passed an id.
    const finalSnapshotId = context?.finalSnapshotIdentifier;
    // Issue #5155: a final snapshot needs `available`, which the flip above
    // briefly takes away. Only a flip of this run AND a snapshot wait, and
    // never once AWS accepted the delete (a re-entry after a failed wait).
    const sendDelete = () =>
      this.getClient().send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: physicalId,
          ...(finalSnapshotId
            ? { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshotId }
            : { SkipFinalSnapshot: true }),
          ...deleteAutomatedBackupsInput(properties),
        })
      );
    if (finalSnapshotId && flip.flippedOffByThisRun && !flip.deleteAccepted) {
      // Issue #5184: waits, then retries a delete AWS refuses as not `available`.
      await this.deleteAfterProtectionFlip(logicalId, physicalId, sendDelete);
    } else {
      await sendDelete();
    }
    // AWS took the delete: a later throw is the WAIT failing, and the guard
    // must not be put back on a cluster that is being deleted.
    flip.deleteAccepted = true;
    // Not the identifier: it embeds the physical id, which may be secret-derived
    // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/cli-destroy.md).
    if (finalSnapshotId) {
      this.logger.info(
        `Deleting DBCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
      );
    }

    this.logger.debug(`Successfully initiated deletion of DBCluster ${logicalId}`);

    // Wait for cluster to be fully deleted
    await this.waitForClusterDeleted(logicalId, physicalId, RDS_DELETE_WAIT_MS);
  } catch (error) {
    if (error instanceof GlobalClusterDetachError) {
      // Not gone, so the destroy / deploy classifiers never read an AWS
      // "not found" in the detail as the cluster being gone (#5228). Also
      // non-retryable: the detach already waited out busy states and
      // throttles within the delete budget, so a retry would only spend it
      // again; a re-run of the destroy repeats the detach.
      const detachFailure = markNotGone(
        markNonRetryable(
          new ProvisioningError(
            `Failed to delete DBCluster ${logicalId}: ${error.message}`,
            resourceType,
            logicalId,
            physicalId,
            error
          )
        )
      );
      throw progress.stripped ? markDeleteStarted(detachFailure) : detachFailure;
    }
    if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  RDS DB cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`DBCluster ${logicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const detachedNote =
      detachedFrom !== undefined
        ? ' (it was already detached from its global cluster, and stays a standalone cluster)'
        : '';
    const failure = this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DBCluster ${logicalId}: ${text}${detachedNote}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    throw progress.stripped ? markDeleteStarted(failure) : failure;
  }
}

/**
 * Issue #5426: after a failed cleanup delete of a partially-created cluster,
 * whether AWS already has it on its way out: `gone` on `DBClusterNotFoundFault`
 * by class, `deleting` on that status, `undefined` for anything else (an
 * empty read or another failure included), which keeps the caller's warning.
 */
export async function partialClusterRetiring(
  this: RDSProvider,
  dbClusterIdentifier: string
): Promise<'gone' | 'deleting' | undefined> {
  try {
    const cluster = await this.describeDBCluster(dbClusterIdentifier);
    return cluster?.Status === 'deleting' ? 'deleting' : undefined;
  } catch (error) {
    return error instanceof Error && error.name === 'DBClusterNotFoundFault' ? 'gone' : undefined;
  }
}

/**
 * A {@link GlobalClusterDetachError} for a failed detach or membership read.
 * Its message is the "Failed to delete DBCluster" wrap's, which is persisted
 * to `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its
 * CLASS plus the `--verbose` pointer (go-to-k/cdkd#2319) and AWS's text goes
 * to `debug` through the delete's masker. No `cause` is threaded, as before
 * (the wrap is non-retryable, so no retry classifier needs AWS's text on a
 * chain).
 */
export function wrapGlobalClusterDetachError(
  this: RDSProvider,
  error: unknown,
  mask: (text: string) => string,
  build: (text: string) => string
): GlobalClusterDetachError {
  const failure = describeAwsFailure(error);
  if (failure.redacted) this.logger.debug(mask(build(mask(failure.detail))));
  // Masked: the class is AWS-authored text too.
  return new GlobalClusterDetachError(build(mask(failure.summary)));
}

/**
 * Detach cluster `physicalId` from global cluster `globalClusterId` and wait
 * until it is out of the member list and `available` again, as the
 * CloudFormation handler does before its delete (issue #4029). Returns
 * whether a detach was issued, for the caller's failure message.
 *
 * The PRIMARY of a global cluster that still has other members is refused
 * at once, naming them (go-to-k/cdkd#5853): AWS refuses its detach, as a
 * busy fault no wait clears.
 *
 * The detach is IRREVERSIBLE (a secondary becomes a standalone writer), so
 * `beforeDelete`, a cluster whose deletion protection is still on is refused
 * BEFORE it: the delete could only fail after it. Under `--remove-protection`
 * the flip just made gets a short grace to show. An update's detach (a
 * removed `GlobalClusterIdentifier`, go-to-k/cdkd#5639) is the change
 * itself, and deletion protection guards only a delete, so it is not
 * consulted there.
 *
 * A cluster that is gone surfaces as the describe's `DBClusterNotFoundFault`
 * or an empty answer, both left to the caller's region-checked not-found
 * arm. A global cluster that is gone, or a cluster that is not (or no
 * longer) a member, needs no detach. A busy cluster or global cluster, or a
 * throttle, is waited through within the delete budget. Every other failure
 * is a {@link GlobalClusterDetachError}.
 */
export async function detachFromGlobalCluster(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  globalClusterId: string,
  { beforeDelete, removeProtection }: { beforeDelete: boolean; removeProtection: boolean },
  progress: DeleteProgress,
  mask: (text: string) => string
): Promise<boolean> {
  let cluster = await this.describeDBCluster(physicalId);
  for (let i = 0; removeProtection && cluster?.DeletionProtection === true && i < 6; i++) {
    await this.sleep(5_000);
    cluster = await this.describeDBCluster(physicalId);
  }
  if (cluster === undefined) return false;
  if (beforeDelete && cluster.DeletionProtection === true) {
    throw new GlobalClusterDetachError(
      safeMsg`${physicalId} has deletion protection on, so cdkd did not detach it from global cluster ${globalClusterId}; turn it off (cdkd destroy --remove-protection does) and re-run`
    );
  }
  const clusterArn = cluster.DBClusterArn;
  if (typeof clusterArn !== 'string' || clusterArn === '') {
    throw new GlobalClusterDetachError(
      safeMsg`could not read the ARN of ${physicalId} to detach it from global cluster ${globalClusterId}`
    );
  }

  const startTime = Date.now();
  let delay = 5_000;
  const backOff = async (): Promise<void> => {
    if (Date.now() - startTime >= RDS_DELETE_WAIT_MS) {
      throw new GlobalClusterDetachError(
        safeMsg`timed out waiting for ${physicalId} to leave global cluster ${globalClusterId}`
      );
    }
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  };

  // go-to-k/cdkd#5853: AWS refuses to detach the primary while secondaries
  // remain, as `InvalidGlobalClusterStateFault`, which the loop below waits
  // through as busy. No wait changes that, so name them and fail at once, as
  // the DocDB detach does. A busy or throttled read is waited through; a
  // global cluster that is gone has no members to check.
  for (;;) {
    let members:
      | Array<{ DBClusterArn?: string | undefined; IsWriter?: boolean | undefined }>
      | undefined;
    try {
      const response = await this.getClient().send(
        new DescribeGlobalClustersCommand({ GlobalClusterIdentifier: globalClusterId })
      );
      members = response.GlobalClusters?.[0]?.GlobalClusterMembers ?? [];
    } catch (error) {
      const name = awsErrorName(error);
      if (name === 'GlobalClusterNotFoundFault') {
        members = [];
      } else if (!TRANSIENT_DETACH_FAULTS.has(name)) {
        throw this.wrapGlobalClusterDetachError(
          error,
          mask,
          (text) =>
            safeMsg`could not read the members of global cluster ${globalClusterId} to detach ${physicalId} (${text})`
        );
      }
    }
    if (members === undefined) {
      await backOff();
      continue;
    }
    const own = members.find((member) => member.DBClusterArn === clusterArn);
    // The identifier, not the ARN: the ARN carries the account id.
    const others = members
      .filter((member) => member.DBClusterArn !== clusterArn)
      .map(
        (member) =>
          /^arn:[^:]*:rds:[^:]*:[^:]*:cluster:(.+)$/.exec(member.DBClusterArn ?? '')?.[1] ??
          '(unnamed)'
      );
    if (own?.IsWriter === true && others.length > 0) {
      throw new GlobalClusterDetachError(
        mask(
          safeMsg`${physicalId} is the primary of global cluster ${globalClusterId}, which still has other members (${others.join(', ')}); detach or delete them first, then re-run`
        )
      );
    }
    break;
  }

  for (;;) {
    try {
      await this.getClient().send(
        new RemoveFromGlobalClusterCommand({
          GlobalClusterIdentifier: globalClusterId,
          DbClusterIdentifier: clusterArn,
        })
      );
      progress.stripped = true;
      this.logger.info(
        mask(
          beforeDelete
            ? safeMsg`Detaching DBCluster ${logicalId} from global cluster ${globalClusterId} before the delete`
            : safeMsg`Detaching DBCluster ${logicalId} from global cluster ${globalClusterId}: GlobalClusterIdentifier was removed`
        )
      );
      break;
    } catch (error) {
      const name = awsErrorName(error);
      if (name === 'GlobalClusterNotFoundFault') return false;
      // Not (or no longer) a member: nothing to detach, and the delete that
      // follows reports the cluster's real state.
      if (name === 'DBClusterNotFoundFault') break;
      if (!TRANSIENT_DETACH_FAULTS.has(name)) {
        throw this.wrapGlobalClusterDetachError(
          error,
          mask,
          (text) =>
            safeMsg`detaching ${physicalId} from global cluster ${globalClusterId} failed (${text})`
        );
      }
      await backOff();
    }
  }

  for (;;) {
    let stillMember: boolean | undefined;
    try {
      const response = await this.getClient().send(
        new DescribeGlobalClustersCommand({ GlobalClusterIdentifier: globalClusterId })
      );
      stillMember = (response.GlobalClusters?.[0]?.GlobalClusterMembers ?? []).some(
        (member) => member.DBClusterArn === clusterArn
      );
    } catch (error) {
      const name = awsErrorName(error);
      if (name === 'GlobalClusterNotFoundFault') {
        stillMember = false;
      } else if (!TRANSIENT_DETACH_FAULTS.has(name)) {
        throw this.wrapGlobalClusterDetachError(
          error,
          mask,
          (text) =>
            safeMsg`could not confirm ${physicalId} left global cluster ${globalClusterId} (${text})`
        );
      }
    }
    if (stillMember === false) {
      const after = await this.describeDBCluster(physicalId);
      if (after === undefined) return true;
      this.logger.debug(safeMsg`DBCluster ${physicalId} status after the detach: ${after.Status}`);
      if (after.Status === 'available') return true;
    }
    await backOff();
  }
}

/**
 * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
 * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
 * and their bounds).
 */
export async function deleteAfterProtectionFlip(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  send: () => Promise<unknown>
): Promise<void> {
  await deleteAfterProtectionFlipWithFinalSnapshot({
    stateFault: 'InvalidDBClusterStateFault',
    send,
    noun: 'cluster',
    label: 'DBCluster',
    logicalId,
    read: async () => {
      const current = await this.describeDBCluster(physicalId);
      return current === undefined
        ? undefined
        : { deletionProtection: current.DeletionProtection, status: current.Status };
    },
    sleep: (ms) => this.sleep(ms),
    logger: this.logger,
    remainingMs: enclosingDeadlineRemainingMs(),
  });
}
