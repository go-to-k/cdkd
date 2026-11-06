import type { NeptuneProvider } from '../neptune-provider.js';
import {
  CreateDBClusterCommand,
  ModifyDBClusterCommand,
  RestoreDBClusterFromSnapshotCommand,
  RestoreDBClusterToPointInTimeCommand,
} from '@aws-sdk/client-neptune';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseRestoreFromItself } from '../../restore-source-guard.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from '../db-instance-modify-retry.js';
import {
  type ClusterRestore,
  DEFAULT_CLUSTER_PORT,
  DEFAULT_STORAGE_KEY,
  RESTORE_VALUE_REFUSALS,
  type RestoreFollowUp,
  clusterAttributes,
  declaresSnapshot,
  ignoredRestoreKeys,
  isRestoringClusterRefusal,
  readClusterRestore,
  restoreFollowUp,
  restoreWaitMs,
} from './shared.js';

// ─── DBCluster ────────────────────────────────────────────────────

export async function createDBCluster(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  replayingState: boolean
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Neptune DBCluster ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const { roles, logTypes, scaling } = this.readClusterBlocks(properties, resourceType, logicalId, {
    creating: true,
    stateBorne: replayingState,
  });
  const restore = readClusterRestore(properties, resourceType, logicalId);
  this.warnIgnoredRestoreProperties(logicalId, resourceType, properties, restore);

  const dbClusterIdentifier =
    (properties['DBClusterIdentifier'] as string | undefined) ||
    generatedNameFor('AWS::Neptune::DBCluster', logicalId);
  // Names only: no account is known here, and an ARN naming this very cluster
  // deletes nothing at create, AWS answers it with AlreadyExists.
  if (!String(properties['SourceDBClusterIdentifier']).startsWith('arn:')) {
    refuseRestoreFromItself(resourceType, properties, dbClusterIdentifier, logicalId, {
      region: this.providerRegion,
    });
  }

  // CFn schema's writable port field is `DBPort`; `Port` is readOnly in the
  // schema but older CDK versions emit it. Prefer DBPort, fall back to Port
  // for backward compat.
  const port =
    properties['DBPort'] != null
      ? Number(properties['DBPort'])
      : properties['Port'] != null
        ? Number(properties['Port'])
        : undefined;
  const kmsKeyId = properties['KmsKeyId'] as string | undefined;
  // What a create and a restore both take.
  const sharedInput = {
    DBClusterIdentifier: dbClusterIdentifier,
    VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
    DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
    DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as string | undefined,
    EnableIAMDatabaseAuthentication: properties['IamAuthEnabled'] as boolean | undefined,
    DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
    NetworkType: properties['NetworkType'] as string | undefined,
    ...(logTypes.length > 0 && { EnableCloudwatchLogsExports: logTypes }),
    ...(scaling != null && { ServerlessV2ScalingConfiguration: scaling }),
    ...(tags.length > 0 && { Tags: tags }),
  };
  // Measured (#5638): a restore takes the type's port, not the source's, and
  // `StorageEncrypted` has no restore member, so it reaches AWS as a key.
  const restoreInput = {
    ...sharedInput,
    Port: port ?? DEFAULT_CLUSTER_PORT,
    KmsKeyId:
      kmsKeyId ??
      (String(properties['StorageEncrypted']).toLowerCase() === 'true'
        ? DEFAULT_STORAGE_KEY
        : undefined),
  };

  // go-to-k/cdkd#4583: set once CreateDBCluster returned (no self-cleanup).
  let clusterCreated = false;
  // go-to-k/cdkd#4606: the `DbClusterResourceId` CreateDBCluster returned,
  // carried on the failure's mark as the orphan's identity.
  let createdResourceId: string | undefined;
  try {
    const response = await (restore === undefined
      ? this.getCreateClient().send(
          new CreateDBClusterCommand({
            ...sharedInput,
            // Neptune engine value is fixed: only `neptune` is accepted.
            Engine: 'neptune',
            EngineVersion: properties['EngineVersion'] as string | undefined,
            Port: port,
            StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
            KmsKeyId: kmsKeyId,
            BackupRetentionPeriod:
              properties['BackupRetentionPeriod'] != null
                ? Number(properties['BackupRetentionPeriod'])
                : undefined,
            PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
            PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
              | string
              | undefined,
            AvailabilityZones: properties['AvailabilityZones'] as string[] | undefined,
            CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
          })
        )
      : restore.kind === 'snapshot'
        ? this.getCreateClient().send(
            new RestoreDBClusterFromSnapshotCommand({
              ...restoreInput,
              SnapshotIdentifier: restore.snapshotIdentifier,
              Engine: 'neptune',
              EngineVersion: properties['EngineVersion'] as string | undefined,
              AvailabilityZones: properties['AvailabilityZones'] as string[] | undefined,
              CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
            })
          )
        : this.getCreateClient().send(
            new RestoreDBClusterToPointInTimeCommand({
              ...restoreInput,
              // Sent by the follow-up, see restoreFollowUp.
              DBClusterParameterGroupName: undefined,
              SourceDBClusterIdentifier: restore.sourceDBClusterIdentifier,
              RestoreType: properties['RestoreType'] as string | undefined,
              ...(restore.restoreToTime !== undefined && {
                RestoreToTime: restore.restoreToTime,
              }),
              UseLatestRestorableTime: properties['UseLatestRestorableTime'] as boolean | undefined,
            })
          ));
    clusterCreated = true;
    createdResourceId = response.DBCluster?.DbClusterResourceId;
    // go-to-k/cdkd#5511: reported before the available wait.
    reportCreatedResource(logicalId, resourceType, dbClusterIdentifier, createdResourceId);

    const cluster = response.DBCluster;
    if (!cluster) {
      throw new Error('The create call did not return DBCluster');
    }

    this.logger.debug(
      `Successfully created Neptune DBCluster ${logicalId}: ${dbClusterIdentifier}`
    );

    const followUp =
      restore === undefined
        ? undefined
        : restoreFollowUp(properties, restore, cluster.EngineVersion);
    const followingUp =
      followUp !== undefined && (followUp.parity !== undefined || followUp.declared.length > 0);
    // A restore copies the source's data, so its wait follows the resource
    // timeout. Skipped with --no-wait, unless a follow-up needs `available`.
    if (followingUp || process.env['CDKD_NO_WAIT'] !== 'true') {
      await this.waitForClusterAvailable(
        logicalId,
        dbClusterIdentifier,
        undefined,
        restore === undefined ? undefined : restoreWaitMs()
      );
    }
    try {
      if (followUp !== undefined && followingUp) {
        await this.sendRestoreFollowUp(
          logicalId,
          resourceType,
          dbClusterIdentifier,
          followUp,
          mask
        );
      }
      await this.applyClusterRoles(logicalId, dbClusterIdentifier, roles, [], mask, undefined);
    } catch (error) {
      // The cluster itself was created: a follow-up's or a role's "already
      // exists" is not this name's collision (#3826).
      markAuxiliaryFailure(error, logicalId);
      throw error;
    }

    const described = await this.describeDBCluster(dbClusterIdentifier);

    return {
      physicalId: dbClusterIdentifier,
      attributes: clusterAttributes(described),
    };
  } catch (error) {
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            mask,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create Neptune DBCluster ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                dbClusterIdentifier,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#4583: the cluster exists and no state record will hold
    // it; never before CreateDBCluster returned (another owner's name).
    if (clusterCreated) {
      markCreatedBeforeFailure(
        thrown,
        logicalId,
        resourceType,
        dbClusterIdentifier,
        createdResourceId
      );
    }
    throw thrown;
  }
}

/**
 * The `ModifyDBCluster` calls after a restore ({@link restoreFollowUp}), sent
 * once the cluster is available, then waited out. A restore's first status
 * changes can refuse one as not available, as a role call (#5194's rule), in
 * a wording of their own. A refused `declared` group names its keys only, its
 * masked reason behind debug: AWS's text can echo a value.
 */
export async function sendRestoreFollowUp(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  followUp: RestoreFollowUp,
  mask: ((text: string) => string) | undefined
): Promise<void> {
  const send = (members: NonNullable<RestoreFollowUp['parity']>): Promise<void> =>
    modifyDbInstanceWhenAvailable({
      send: () =>
        this.getClient().send(
          new ModifyDBClusterCommand({
            DBClusterIdentifier: physicalId,
            ...members,
            ApplyImmediately: true,
          })
        ),
      readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label: 'Neptune DBCluster',
      subject: 'cluster',
      isRefusal: (error) => isModifyNotAvailableRefusal(error) || isRestoringClusterRefusal(error),
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });
  if (followUp.parity !== undefined) await send(followUp.parity);
  // Whether AWS refused the value: anything else still fails the create.
  const refused = async (members: RestoreFollowUp['declared'][number]): Promise<boolean> => {
    try {
      await send(members);
      return false;
    } catch (error) {
      if (error instanceof Error && RESTORE_VALUE_REFUSALS.has(error.name)) {
        this.logger.debug(
          safeMsg`${error.name} after restoring ${logicalId}: ${(mask ?? String)(error.message)}`
        );
        return true;
      }
      throw error;
    }
  };
  const { declared } = followUp;
  if (declared.length > 0 && (await refused(Object.assign({}, ...declared) as object))) {
    // AWS refuses a call whole: one group at a time finds what it refused.
    const keys: string[] = [];
    for (const group of declared) {
      if (declared.length === 1 || (await refused(group))) keys.push(...Object.keys(group));
    }
    // Not a template key: the flag beside a declared EngineVersion.
    const refusedKeys = keys.filter((key) => key !== 'AllowMajorVersionUpgrade');
    if (refusedKeys.length > 0) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): AWS refused ${refusedKeys.join(', ')} after the restore, so the cluster keeps its restored values. The record holds the declared ones, so drift does not report the difference. An update leaves an unchanged window or EngineVersion out, as CloudFormation does; a refused BackupRetentionPeriod, CopyTagsToSnapshot or DBClusterParameterGroupName is sent again, so every update of this cluster fails until the template changes it.`
      );
    }
  }
  if (process.env['CDKD_NO_WAIT'] !== 'true') {
    await this.waitForClusterAvailable(
      logicalId,
      physicalId,
      'being configured after a restore',
      restoreWaitMs()
    );
  }
}

/**
 * Which restore keys this create leaves unused, as CloudFormation does: each
 * was measured deploying without an error (#5638), so a template relying on
 * one would otherwise get an empty cluster or the wrong source in silence.
 * A false `UseLatestRestorableTime` asks for nothing, so it stays unnamed. A
 * `SnapshotIdentifier` beside a source restores nothing, yet still draws the
 * retention {@link restoreFollowUp} sends. Names keys only.
 */
export function warnIgnoredRestoreProperties(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  restore: ClusterRestore | undefined
): void {
  const ignored = ignoredRestoreKeys(restore).filter(
    (key) => properties[key] != null && properties[key] !== false
  );
  if (ignored.length === 0) return;
  const call =
    restore === undefined
      ? 'create'
      : restore.kind === 'snapshot'
        ? 'snapshot restore'
        : 'point-in-time restore';
  const retention =
    restore?.kind === 'point-in-time' && declaresSnapshot(properties)
      ? ' A declared SnapshotIdentifier still sets BackupRetentionPeriod, 1 when none is declared.'
      : '';
  this.logger.warn(
    safeMsg`${logicalId} (${resourceType}): this ${call} does not use ${ignored.join(', ')}, as in CloudFormation.${retention}`
  );
}
