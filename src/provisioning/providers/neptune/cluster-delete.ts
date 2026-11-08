import type { NeptuneProvider } from '../neptune-provider.js';
import { DeleteDBClusterCommand, ModifyDBClusterCommand } from '@aws-sdk/client-neptune';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from '../db-instance-modify-retry.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
  deleteAfterProtectionFlipWithFinalSnapshot,
  PROTECTION_FLIP_RETRY_WAIT_MS,
} from '../deletion-protection-compensation.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';

/**
 * The compensation boundary (issue #2204): a `--remove-protection` flip whose
 * delete then fails terminally is undone here, so a destroy that did not
 * happen does not leave a live cluster with its guard stripped.
 */
export async function deleteDBCluster(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) => this.deleteDBClusterOnce(logicalId, physicalId, resourceType, context, flip),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site: rdsFamilyProtectionSite({
        cliService: 'neptune',
        serviceLabel: 'Neptune',
        kind: 'cluster',
        physicalId,
        region: context?.expectedRegion,
        notFoundFault: 'DBClusterNotFoundFault',
        isNotFound: (error) => this.isNotFoundError(error, 'DBClusterNotFoundFault'),
      }),
      // go-to-k/cdkd#5995: the flip succeeds in the window a busy cluster
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
          label: 'Neptune DBCluster',
          subject: 'cluster',
          isRefusal: isModifyNotAvailableRefusal,
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
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting Neptune DBCluster ${logicalId}`);

  try {
    // `--remove-protection`: flip DeletionProtection off in-place
    // before delete. Idempotent — Neptune accepts the call when
    // protection is already disabled. Non-fatal: log at debug if the
    // flip-off errors (e.g. NotFound) so the actual delete still
    // proceeds.
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
          // go-to-k/cdkd#5995: AWS refuses the flip while the cluster is in a
          // status that ends on its own (`backing-up` right after create);
          // wait that out and resend, within a bounded budget, as RDS does
          // (RDS's matcher also takes Aurora's "could not be modified" wording,
          // which no Neptune refusal has been seen to use).
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
              label: 'Neptune DBCluster',
              subject: 'cluster',
              isRefusal: isModifyNotAvailableRefusal,
              logicalId,
              remainingMs: enclosingDeadlineRemainingMs(),
              maxWaitMs: PROTECTION_FLIP_RETRY_WAIT_MS,
              command: 'destroy',
            });
          },
        });
        this.logger.debug(
          `Disabled DeletionProtection on Neptune DBCluster ${logicalId} before delete`
        );
      } catch (disableError) {
        if (!this.isNotFoundError(disableError, 'DBClusterNotFoundFault')) {
          this.logger.debug(
            maskerOrIdentity(context?.maskSecrets)(
              `Could not disable deletion protection for Neptune DBCluster ${logicalId}: ${describeAwsFailure(disableError).detail}`
            )
          );
        }
      }
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
        `Deleting Neptune DBCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
      );
    }

    this.logger.debug(`Successfully initiated deletion of Neptune DBCluster ${logicalId}`);

    // Wait for cluster to be fully deleted
    await this.waitForClusterDeleted(logicalId, physicalId);
  } catch (error) {
    if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  Neptune DB cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`Neptune DBCluster ${logicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Neptune DBCluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
 * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
 * and their bounds).
 */
export async function deleteAfterProtectionFlip(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  send: () => Promise<unknown>
): Promise<void> {
  await deleteAfterProtectionFlipWithFinalSnapshot({
    stateFault: 'InvalidDBClusterStateFault',
    send,
    noun: 'cluster',
    label: 'Neptune DBCluster',
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
