import type { DocDBProvider } from '../docdb-provider.js';
import {
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeGlobalClustersCommand,
  RemoveFromGlobalClusterCommand,
  type DBCluster,
  type GlobalClusterMember,
} from '@aws-sdk/client-docdb';
import { markNotGone } from '../../not-gone.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { isDocDBNotFoundError } from '../docdb-shared.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  docdbGlobalClusterId,
  DETACH_MAX_WAIT_MS,
  GLOBAL_CLUSTER_BUSY_MAX_WAIT_MS,
  TRANSIENT_DETACH_FAULTS,
  awsErrorName,
  GlobalClusterDetachError,
} from './shared.js';

/**
 * The compensation boundary (issue #2204): a `--remove-protection` flip whose
 * delete then fails terminally is undone here, so a destroy that did not
 * happen does not leave a live cluster with its guard stripped. DocDB
 * instances carry no guard of their own, so the cluster is the only site.
 */
export async function deleteDBCluster(
  this: DocDBProvider,
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
        cliService: 'docdb',
        serviceLabel: 'DocDB',
        kind: 'cluster',
        physicalId,
        region: context?.expectedRegion,
        notFoundFault: 'DBClusterNotFoundFault',
        isNotFound: (error) => isDocDBNotFoundError(error, 'DBClusterNotFoundFault'),
      }),
      reEnable: async () => {
        await this.getClient().send(
          new ModifyDBClusterCommand({
            DBClusterIdentifier: physicalId,
            DeletionProtection: true,
            ApplyImmediately: true,
          })
        );
      },
    },
  });
}

export async function deleteDBClusterOnce(
  this: DocDBProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting DocDB DBCluster ${logicalId}`);
  // go-to-k/cdkd#5628: set once a global-cluster detach was issued, so a
  // delete failing after it says the cluster is already standalone.
  let detachedFrom: string | undefined;
  // Set once the detach is accepted, even when its wait then fails: a
  // detached cluster is not the global member its record describes, so a
  // refused delete is never read as a whole survivor (go-to-k/cdkd#4946).
  const progress: DeleteProgress = { stripped: false };

  try {
    // `--remove-protection`: flip DeletionProtection off in-place
    // before delete. Idempotent — DocDB accepts the call when protection
    // is already disabled. Non-fatal: log at debug if the flip-off
    // errors (e.g. NotFound) so the actual delete still proceeds.
    // The pre-flip readback is what lets a terminal failure restore ONLY a
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
          disable: async () => {
            await this.getClient().send(
              new ModifyDBClusterCommand({
                DBClusterIdentifier: physicalId,
                DeletionProtection: false,
                ApplyImmediately: true,
              })
            );
          },
        });
        this.logger.debug(
          `Disabled DeletionProtection on DocDB DBCluster ${logicalId} before delete`
        );
      } catch (disableError) {
        if (!isDocDBNotFoundError(disableError, 'DBClusterNotFoundFault')) {
          this.logger.debug(
            maskerOrIdentity(context?.maskSecrets)(
              `Could not disable deletion protection for DocDB DBCluster ${logicalId}: ${describeAwsFailure(disableError).detail}`
            )
          );
        }
      }
    }

    // go-to-k/cdkd#5628: a global-cluster member cannot be deleted until it
    // is detached.
    const globalClusterId = docdbGlobalClusterId(properties?.['GlobalClusterIdentifier']);
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
        `Deleting DocDB DBCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
      );
    }

    this.logger.debug(`Successfully initiated deletion of DocDB DBCluster ${logicalId}`);

    // Wait for cluster to be fully deleted
    await this.waitForClusterDeleted(logicalId, physicalId);
  } catch (error) {
    if (error instanceof GlobalClusterDetachError) {
      // Not gone, so the destroy / deploy classifiers never read an AWS
      // "not found" in the detail as the cluster being gone (#5228). Also
      // non-retryable: the detach already waited out busy states and
      // throttles, so a retry would only spend that budget again; a re-run
      // of the destroy repeats the detach.
      const detachFailure = markNotGone(
        markNonRetryable(
          new ProvisioningError(
            `Failed to delete DocDB DBCluster ${logicalId}: ${error.message}`,
            resourceType,
            logicalId,
            physicalId,
            error
          )
        )
      );
      throw progress.stripped ? markDeleteStarted(detachFailure) : detachFailure;
    }
    if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  DocDB DB cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`DocDB DBCluster ${logicalId} does not exist, skipping deletion`);
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
          `Failed to delete DocDB DBCluster ${logicalId}: ${text}${detachedNote}`,
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
 * A {@link GlobalClusterDetachError} for a failed detach or membership read:
 * the class goes on the error, AWS's text (it can quote the caller's role) to
 * debug only, both through the delete's masker (go-to-k/cdkd#2319).
 */
export function wrapGlobalClusterDetachError(
  this: DocDBProvider,
  error: unknown,
  mask: (text: string) => string,
  build: (text: string) => string
): GlobalClusterDetachError {
  const failure = describeAwsFailure(error);
  if (failure.redacted) this.logger.debug(mask(build(mask(failure.detail))));
  return new GlobalClusterDetachError(build(mask(failure.summary)));
}

/**
 * Detach cluster `physicalId` from global cluster `globalClusterId` and wait
 * until it is out of the member list and `available` again
 * (go-to-k/cdkd#5628, the shape of `RDSProvider`'s #4029 detach). Returns
 * whether the cluster was detached (`progress.stripped`), for the caller's
 * failure message.
 *
 * The detach is IRREVERSIBLE (a secondary becomes a standalone cluster), so
 * `beforeDelete`, a cluster whose deletion protection is still on is refused
 * BEFORE it: the delete could only fail after it. Under `--remove-protection`
 * the flip just made gets a short grace to show. An update's detach (a
 * removed `GlobalClusterIdentifier`) is the change itself, and deletion
 * protection guards only a delete, so it is not consulted there.
 *
 * A cluster that is gone surfaces as the describe's `DBClusterNotFoundFault`
 * or an empty answer, both left to the caller's region-checked not-found
 * arm. A global cluster that is gone, or a cluster it does not list (read
 * BEFORE the detach), needs no detach. A busy cluster or global cluster, or a
 * throttle, is waited through within {@link DETACH_MAX_WAIT_MS}, a global
 * cluster refusing the detach as busy within
 * {@link GLOBAL_CLUSTER_BUSY_MAX_WAIT_MS}. Every other failure is a
 * {@link GlobalClusterDetachError}.
 */
export async function detachFromGlobalCluster(
  this: DocDBProvider,
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
    if (Date.now() - startTime >= DETACH_MAX_WAIT_MS) {
      throw new GlobalClusterDetachError(
        safeMsg`timed out waiting for ${physicalId} to leave global cluster ${globalClusterId}`
      );
    }
    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  };
  // The global cluster's members, `undefined` for a busy or throttled read
  // (the caller waits through it), `[]` for a global cluster that is gone.
  const readMembers = async (
    build: (text: string) => string
  ): Promise<GlobalClusterMember[] | undefined> => {
    try {
      const response = await this.getClient().send(
        new DescribeGlobalClustersCommand({ GlobalClusterIdentifier: globalClusterId })
      );
      return response.GlobalClusters?.[0]?.GlobalClusterMembers ?? [];
    } catch (error) {
      const name = awsErrorName(error);
      if (name === 'GlobalClusterNotFoundFault') return [];
      if (TRANSIENT_DETACH_FAULTS.has(name)) return undefined;
      throw this.wrapGlobalClusterDetachError(error, mask, build);
    }
  };
  const isMember = async (build: (text: string) => string): Promise<boolean | undefined> => {
    const members = await readMembers(build);
    return members?.some((member) => member.DBClusterArn === clusterArn);
  };

  // A cluster the global cluster does not hold (detached outside cdkd, or a
  // global cluster that is gone) needs no detach, and none is claimed.
  for (;;) {
    const members = await readMembers(
      (text) =>
        safeMsg`could not read whether ${physicalId} is a member of global cluster ${globalClusterId} (${text})`
    );
    if (members !== undefined) {
      const own = members.find((member) => member.DBClusterArn === clusterArn);
      if (own === undefined) return false;
      // AWS refuses to detach the primary while secondaries remain: no wait
      // changes that, so name them instead of spending the busy budget.
      const others = members
        .filter((member) => member.DBClusterArn !== clusterArn)
        // The identifier, not the ARN: the ARN carries the account id.
        .map(
          (member) =>
            /^arn:[^:]*:rds:[^:]*:[^:]*:cluster:(.+)$/.exec(member.DBClusterArn ?? '')?.[1] ??
            '(unnamed)'
        );
      if (own.IsWriter === true && others.length > 0) {
        throw new GlobalClusterDetachError(
          safeMsg`${physicalId} is the primary of global cluster ${globalClusterId}, which still has other members (${others.join(', ')}); detach or delete them first, then re-run`
        );
      }
      break;
    }
    await backOff();
  }

  let globalBusySince: number | undefined;
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
        beforeDelete
          ? safeMsg`Detaching DocDB DBCluster ${logicalId} from global cluster ${globalClusterId} before the delete`
          : safeMsg`Detaching DocDB DBCluster ${logicalId} from global cluster ${globalClusterId}: GlobalClusterIdentifier was removed`
      );
      break;
    } catch (error) {
      const name = awsErrorName(error);
      if (name === 'GlobalClusterNotFoundFault') return false;
      // The read above found it a member, so "not a member" now means an
      // earlier send (an SDK replay) already detached it: the cluster is no
      // longer the member its record describes (go-to-k/cdkd#4946).
      if (name === 'DBClusterNotFoundFault') {
        progress.stripped = true;
        break;
      }
      // A global cluster that stays in a state refusing the detach (a
      // primary with secondaries left, for one) is not waited on for the
      // whole budget.
      if (name === 'InvalidGlobalClusterStateFault') {
        globalBusySince ??= Date.now();
        if (Date.now() - globalBusySince >= GLOBAL_CLUSTER_BUSY_MAX_WAIT_MS) {
          throw this.wrapGlobalClusterDetachError(
            error,
            mask,
            (text) =>
              safeMsg`detaching ${physicalId} from global cluster ${globalClusterId} failed (${text})`
          );
        }
      }
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
    const stillMember = await isMember(
      (text) =>
        safeMsg`could not confirm ${physicalId} left global cluster ${globalClusterId} (${text})`
    );
    if (stillMember === false) {
      let after: DBCluster | undefined;
      try {
        after = await this.describeDBCluster(physicalId);
      } catch (error) {
        // A throttle is waited through like the detach's own reads; any
        // other failure (a not-found included) is the caller's to classify.
        if (!TRANSIENT_DETACH_FAULTS.has(awsErrorName(error))) throw error;
        await backOff();
        continue;
      }
      if (after === undefined) return true;
      this.logger.debug(
        safeMsg`DocDB DBCluster ${physicalId} status after the detach: ${after.Status}`
      );
      if (after.Status === 'available') return true;
    }
    await backOff();
  }
}
