import { DeleteDBInstanceCommand, ModifyDBInstanceCommand } from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
  deleteAfterProtectionFlipWithFinalSnapshot,
  PROTECTION_FLIP_RETRY_WAIT_MS,
} from '../deletion-protection-compensation.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import type { RDSProvider } from '../rds-provider.js';
import { isLiveReadReplica, replicaSourceOf } from './read-replica.js';
import { RDS_DELETE_WAIT_MS, deleteAutomatedBackupsInput } from './shared.js';

/** The compensation boundary for a DBInstance; see {@link deleteDBCluster}. */
export async function deleteDBInstance(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) =>
      this.deleteDBInstanceOnce(logicalId, physicalId, resourceType, properties, context, flip),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site: rdsFamilyProtectionSite({
        cliService: 'rds',
        serviceLabel: 'RDS',
        kind: 'instance',
        physicalId,
        region: context?.expectedRegion,
        notFoundFault: 'DBInstanceNotFoundFault',
        isNotFound: (error) => this.isNotFoundError(error, 'DBInstanceNotFoundFault'),
      }),
      // go-to-k/cdkd#5639: as for a DB cluster.
      reEnable: async () => {
        await modifyDbInstanceWhenAvailable({
          send: () =>
            this.getClient().send(
              new ModifyDBInstanceCommand({
                DBInstanceIdentifier: physicalId,
                DeletionProtection: true,
                ApplyImmediately: true,
              })
            ),
          readStatus: async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
          sleep: (ms) => this.sleep(ms),
          logger: this.logger,
          label: 'RDS DBInstance',
          logicalId,
          remainingMs: enclosingDeadlineRemainingMs(),
          maxWaitMs: PROTECTION_FLIP_RETRY_WAIT_MS,
          command: 'destroy',
        });
      },
    },
  });
}

export async function deleteDBInstanceOnce(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting DBInstance ${logicalId}`);

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
            (await this.describeDBInstance(physicalId))?.DeletionProtection === true,
          // go-to-k/cdkd#5639: as for a DB cluster, a refusal of the flip
          // as not `available` is waited out and resent.
          disable: async () => {
            await modifyDbInstanceWhenAvailable({
              send: () =>
                this.getClient().send(
                  new ModifyDBInstanceCommand({
                    DBInstanceIdentifier: physicalId,
                    DeletionProtection: false,
                    ApplyImmediately: true,
                  })
                ),
              readStatus: async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
              sleep: (ms) => this.sleep(ms),
              logger: this.logger,
              label: 'RDS DBInstance',
              logicalId,
              remainingMs: enclosingDeadlineRemainingMs(),
              maxWaitMs: PROTECTION_FLIP_RETRY_WAIT_MS,
              command: 'destroy',
            });
          },
        });
        this.logger.debug(`Disabled DeletionProtection on DBInstance ${logicalId} before delete`);
      } catch (disableError) {
        if (!this.isNotFoundError(disableError, 'DBInstanceNotFoundFault')) {
          this.logger.debug(
            maskerOrIdentity(context?.maskSecrets)(
              `Could not disable deletion protection for DBInstance ${logicalId}: ${describeAwsFailure(disableError).detail}`
            )
          );
        }
      }
    }

    // `DeletionPolicy: Snapshot` (issue #1352): the destroy call sites pass
    // `finalSnapshotIdentifier`; flip the delete to the atomic
    // final-snapshot form. CFn nuance: a cluster-member instance
    // (`DBClusterIdentifier` present) is deleted WITHOUT a final snapshot
    // even under `Snapshot` — cluster-level snapshots cover it, and the
    // instance-level DeleteDBInstance would reject the parameter anyway.
    let finalSnapshotId =
      properties?.['DBClusterIdentifier'] === undefined
        ? context?.finalSnapshotIdentifier
        : undefined;
    // go-to-k/cdkd#5640: likewise a read replica, as CloudFormation's delete
    // handler skips the snapshot for one (RDS refuses FinalDBSnapshotIdentifier
    // there; the source keeps the data). Read live, and only for a record
    // declaring a source, so a standalone delete pays no extra call. A record
    // that lacks it over a live replica (a `cdkd import` of a replica whose
    // template omits the source) keeps the snapshot, which RDS refuses: the
    // delete fails closed, no data lost. A replica promoted outside cdkd holds
    // its own data now and keeps the snapshot; an unreadable instance keeps it
    // too, so RDS refuses rather than a standalone instance losing its
    // snapshot.
    if (finalSnapshotId && replicaSourceOf(properties) !== undefined) {
      const live = await this.describeDBInstance(physicalId).catch((err: unknown) => {
        this.logger.debug(
          maskerOrIdentity(context?.maskSecrets)(
            safeMsg`Could not read whether DBInstance ${logicalId} is a read replica: ${describeAwsFailure(err).detail}`
          )
        );
        return undefined;
      });
      if (isLiveReadReplica(live)) {
        finalSnapshotId = undefined;
        this.logger.info(
          safeMsg`Deleting DBInstance ${logicalId} without a final snapshot: it is a read replica, whose DeletionPolicy CloudFormation ignores`
        );
      }
    }
    // Issue #5155: as on the DBCluster delete above.
    const sendDelete = () =>
      this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          ...(finalSnapshotId
            ? { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshotId }
            : { SkipFinalSnapshot: true }),
          ...deleteAutomatedBackupsInput(properties),
        })
      );
    if (finalSnapshotId && flip.flippedOffByThisRun && !flip.deleteAccepted) {
      // Issue #5184: waits, then retries a delete AWS refuses as not `available`.
      await this.deleteInstanceAfterProtectionFlip(logicalId, physicalId, sendDelete);
    } else {
      await sendDelete();
    }
    // AWS took the delete: see `deleteDBClusterOnce`.
    flip.deleteAccepted = true;
    // Not the identifier: it embeds the physical id, which may be secret-derived
    // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/cli-destroy.md).
    if (finalSnapshotId) {
      this.logger.info(
        `Deleting DBInstance ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
      );
    }

    this.logger.debug(`Successfully initiated deletion of DBInstance ${logicalId}`);

    // Wait for instance to be fully deleted
    await this.waitForInstanceDeleted(logicalId, physicalId, RDS_DELETE_WAIT_MS);
  } catch (error) {
    if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  RDS DB instance ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`DBInstance ${logicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DBInstance ${logicalId}: ${text}`,
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
export async function deleteInstanceAfterProtectionFlip(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  send: () => Promise<unknown>
): Promise<void> {
  await deleteAfterProtectionFlipWithFinalSnapshot({
    stateFault: 'InvalidDBInstanceStateFault',
    send,
    noun: 'instance',
    label: 'DBInstance',
    logicalId,
    read: async () => {
      const current = await this.describeDBInstance(physicalId);
      return current === undefined
        ? undefined
        : { deletionProtection: current.DeletionProtection, status: current.DBInstanceStatus };
    },
    sleep: (ms) => this.sleep(ms),
    logger: this.logger,
    remainingMs: enclosingDeadlineRemainingMs(),
  });
}
