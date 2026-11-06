import type { DocDBProvider } from '../docdb-provider.js';
import {
  CreateDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClusterSnapshotsCommand,
  RestoreDBClusterFromSnapshotCommand,
  RestoreDBClusterToPointInTimeCommand,
  type DBCluster,
} from '@aws-sdk/client-docdb';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseRestoreFromItself } from '../../restore-source-guard.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { isDocDBNotFoundError } from '../docdb-shared.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  DOCDB_DEFAULT_PORT,
  numberOrUndefined,
  docdbGlobalClusterId,
  readableGlobalClusterId,
  clusterAttributes,
  type DocDBClusterRestore,
  readDocDBClusterRestore,
  unusedRestoreKeys,
  restoreWaitMs,
  RESTORE_VALUE_REFUSALS,
  type ClusterModifyMembers,
  type DocDBRestoreFollowUp,
  docdbRestoreFollowUp,
} from './shared.js';

// ─── DBCluster ────────────────────────────────────────────────────
export async function createDBCluster(
  this: DocDBProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  replayingState: boolean
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating DocDB DBCluster ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const origin = { stateBorne: replayingState };
  const { logTypes, scaling } = this.readClusterBlocks(
    properties,
    resourceType,
    logicalId,
    origin,
    true
  );
  const managedPassword = this.readBooleanProperty(
    'ManageMasterUserPassword',
    properties,
    resourceType,
    logicalId,
    origin
  );
  const password = this.passwordBesideManaged(
    managedPassword,
    false,
    properties['MasterUserPassword'] as string | undefined,
    resourceType,
    logicalId,
    origin
  );
  // go-to-k/cdkd#5628: the global cluster this one joins (a primary when the
  // global cluster has no member yet). Refused before any call when it is
  // not a string; a state replay leaves it out instead.
  if (!readableGlobalClusterId(properties['GlobalClusterIdentifier'])) {
    if (!replayingState) {
      this.refuseBlock(
        logicalId,
        resourceType,
        undefined,
        'GlobalClusterIdentifier is not a string'
      );
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded GlobalClusterIdentifier is unusable, so it is not sent.`
    );
  }
  const globalClusterId = docdbGlobalClusterId(properties['GlobalClusterIdentifier']);
  // go-to-k/cdkd#5628: a restore, refused before any call where CloudFormation
  // refuses its keys.
  const restore = readDocDBClusterRestore(properties, resourceType, logicalId);
  const unused = unusedRestoreKeys(properties, restore);
  if (unused.length > 0) {
    const call =
      restore === undefined
        ? 'create'
        : restore.kind === 'snapshot'
          ? 'snapshot restore'
          : 'point-in-time restore';
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): this ${call} does not use ${unused.join(', ')}, as in CloudFormation.`
    );
  }

  const dbClusterIdentifier =
    (properties['DBClusterIdentifier'] as string | undefined) ||
    generatedNameFor('AWS::DocDB::DBCluster', logicalId);
  // go-to-k/cdkd#5628: a replacement's generated name may be the source's.
  // Names only: no account is known here, and an ARN naming this very cluster
  // deletes nothing at create, AWS answers it with AlreadyExists.
  if (!String(properties['SourceDBClusterIdentifier']).startsWith('arn:')) {
    refuseRestoreFromItself(resourceType, properties, dbClusterIdentifier, logicalId, {
      region: this.providerRegion,
    });
  }
  const port = properties['Port'] != null ? Number(properties['Port']) : undefined;
  const kmsKeyId = properties['KmsKeyId'] as string | undefined;
  // What a create and both restores take alike.
  const sharedInput = {
    DBClusterIdentifier: dbClusterIdentifier,
    VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
    DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
    KmsKeyId: kmsKeyId,
    DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
    CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
    NetworkType: properties['NetworkType'] as string | undefined,
    StorageType: properties['StorageType'] as string | undefined,
    ...(logTypes !== undefined && logTypes.length > 0 && { EnableCloudwatchLogsExports: logTypes }),
    ...(scaling != null && { ServerlessV2ScalingConfiguration: scaling }),
    ...(tags.length > 0 && { Tags: tags }),
  };
  // Measured (#5628): a restore takes the type's port, not the source's,
  // which is what AWS defaults a restore to.
  const restorePort = port ?? DOCDB_DEFAULT_PORT;
  if (restore !== undefined) {
    await this.refuseUnencryptedRestoreSource(properties, restore, resourceType, logicalId, mask);
  }

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
            // DocDB engine value is fixed: only `docdb` is accepted.
            Engine: 'docdb',
            EngineVersion: properties['EngineVersion'] as string | undefined,
            MasterUsername: properties['MasterUsername'] as string | undefined,
            MasterUserPassword: password,
            Port: port,
            StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
            BackupRetentionPeriod: numberOrUndefined(properties['BackupRetentionPeriod']),
            PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
            PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
              | string
              | undefined,
            DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
              | string
              | undefined,
            AvailabilityZones: properties['AvailabilityZones'] as string[] | undefined,
            ManageMasterUserPassword: managedPassword,
            MasterUserSecretKmsKeyId: properties['MasterUserSecretKmsKeyId'] as string | undefined,
            ...(globalClusterId !== undefined && { GlobalClusterIdentifier: globalClusterId }),
          })
        )
      : restore.kind === 'snapshot'
        ? this.getCreateClient().send(
            new RestoreDBClusterFromSnapshotCommand({
              ...sharedInput,
              SnapshotIdentifier: restore.snapshotIdentifier,
              Engine: 'docdb',
              EngineVersion: properties['EngineVersion'] as string | undefined,
              Port: restorePort,
              AvailabilityZones: properties['AvailabilityZones'] as string[] | undefined,
            })
          )
        : this.getCreateClient().send(
            new RestoreDBClusterToPointInTimeCommand({
              ...sharedInput,
              SourceDBClusterIdentifier: restore.sourceDBClusterIdentifier,
              RestoreType: properties['RestoreType'] as string | undefined,
              ...(restore.restoreToTime !== undefined
                ? { RestoreToTime: restore.restoreToTime }
                : { UseLatestRestorableTime: true }),
              Port: restorePort,
            })
          ));
    clusterCreated = true;
    createdResourceId = response.DBCluster?.DbClusterResourceId;
    // go-to-k/cdkd#5511: report before the availability wait.
    reportCreatedResource(logicalId, resourceType, dbClusterIdentifier, createdResourceId);

    const cluster = response.DBCluster;
    if (!cluster) {
      throw new Error('The create call did not return DBCluster');
    }

    this.logger.debug(`Successfully created DocDB DBCluster ${logicalId}: ${dbClusterIdentifier}`);

    const followUp =
      restore === undefined
        ? undefined
        : docdbRestoreFollowUp(properties, restore, password, managedPassword);
    const followingUp =
      followUp !== undefined && (followUp.parity !== undefined || followUp.declared.length > 0);
    // A restore copies the source's data, so its wait follows the resource
    // timeout. Skipped with --no-wait, unless a follow-up needs `available`.
    if (followingUp || process.env['CDKD_NO_WAIT'] !== 'true') {
      await this.waitForClusterAvailable(
        logicalId,
        dbClusterIdentifier,
        restore === undefined ? undefined : restoreWaitMs()
      );
    }
    if (followUp !== undefined && followingUp) {
      await this.sendRestoreFollowUp(logicalId, resourceType, dbClusterIdentifier, followUp, mask);
    }
    if (restore !== undefined) {
      this.warnRestoredDifferences(logicalId, resourceType, properties, restore, cluster);
    }

    // Describe to get final attributes
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
                `Failed to create DocDB DBCluster ${logicalId}: ${text}`,
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
 * go-to-k/cdkd#5628: CloudFormation refuses `StorageEncrypted: true` with no
 * `KmsKeyId` when the snapshot or source cluster is not encrypted (measured
 * on both restores: "You can't create an encrypted DB cluster from an
 * unencrypted source DB cluster or DB cluster snapshot without an AWS KMS
 * key"), where AWS would restore it unencrypted: neither restore call has a
 * `StorageEncrypted` member. The source is read only for that combination,
 * so no other create pays the call. A source AWS does not find is left to the
 * restore's own not-found; one it finds is restored only when it reads
 * encrypted. `IncludePublic`: a public snapshot is never encrypted.
 */
export async function refuseUnencryptedRestoreSource(
  this: DocDBProvider,
  properties: Record<string, unknown>,
  restore: DocDBClusterRestore,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<void> {
  if (coerceCfnBoolean(properties['StorageEncrypted']) !== true) return;
  if (properties['KmsKeyId'] != null && properties['KmsKeyId'] !== '') return;
  let encrypted: boolean | undefined;
  try {
    if (restore.kind === 'snapshot') {
      const response = await this.getClient().send(
        new DescribeDBClusterSnapshotsCommand({
          DBClusterSnapshotIdentifier: restore.snapshotIdentifier,
          IncludeShared: true,
          IncludePublic: true,
        })
      );
      const snapshot = response.DBClusterSnapshots?.[0];
      if (snapshot === undefined) return;
      encrypted = snapshot.StorageEncrypted;
    } else {
      const source = await this.describeDBCluster(restore.sourceDBClusterIdentifier);
      if (source === undefined) return;
      encrypted = source.StorageEncrypted;
    }
  } catch (error) {
    const fault =
      restore.kind === 'snapshot' ? 'DBClusterSnapshotNotFoundFault' : 'DBClusterNotFoundFault';
    if (isDocDBNotFoundError(error, fault)) return;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create DocDB DBCluster ${logicalId}: reading whether the restore source is encrypted failed, so nothing was changed: ${text}`,
          resourceType,
          logicalId,
          undefined,
          error instanceof Error ? error : undefined
        )
    );
  }
  if (encrypted === true) return;
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`DocDB DBCluster ${logicalId}: StorageEncrypted is true, but the restore source does not read as encrypted and no KmsKeyId is set. Set KmsKeyId (alias/aws/rds is the default key), as CloudFormation requires; nothing was changed.`,
      resourceType,
      logicalId
    )
  );
}

/**
 * The `ModifyDBCluster` calls after a restore ({@link docdbRestoreFollowUp}),
 * sent once the cluster is `available`, then waited out. A refusal as not
 * available is waited out and resent (#5194's rule). A refused `declared`
 * group names its keys only, its masked reason behind debug: AWS's text can
 * echo a value, and one group may hold the master password.
 */
export async function sendRestoreFollowUp(
  this: DocDBProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  followUp: DocDBRestoreFollowUp,
  mask: ((text: string) => string) | undefined
): Promise<void> {
  const send = (members: ClusterModifyMembers): Promise<void> =>
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
      label: 'DocDB DBCluster',
      subject: 'cluster',
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });
  if (followUp.parity !== undefined) await send(followUp.parity);
  // Whether AWS refused the value: anything else still fails the create.
  const refused = async (members: ClusterModifyMembers): Promise<boolean> => {
    try {
      await send(members);
      return false;
    } catch (error) {
      if (error instanceof Error && RESTORE_VALUE_REFUSALS.has(error.name)) {
        this.logger.debug(
          safeMsg`${error.name} after restoring ${logicalId}: ${maskerOrIdentity(mask)(error.message)}`
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
      if (declared.length === 1 || (await refused(group))) {
        keys.push(
          ...Object.keys(group).filter(
            (key) => group[key as keyof ClusterModifyMembers] !== undefined
          )
        );
      }
    }
    if (keys.length > 0) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): AWS refused ${keys.join(', ')} after the restore, so the cluster keeps its restored values. The record holds the declared ones, so drift does not report the difference. An update sends a declared BackupRetentionPeriod or window again; the password settings only once the template changes them.`
      );
    }
  }
  if (process.env['CDKD_NO_WAIT'] !== 'true') {
    await this.waitForClusterAvailable(logicalId, physicalId, restoreWaitMs());
  }
}

/**
 * What a restore keeps from its source although the template declares
 * otherwise, as CloudFormation's restore does (measured, go-to-k/cdkd#5628):
 * the master user name, and on a point-in-time restore the engine version,
 * which neither call can set. Drift does not show it, its baseline being the
 * deploy-time readback of the live value, so this warning is the one place it
 * is named. Read off the restore call's own
 * answer, so it costs no call. Names keys only.
 */
export function warnRestoredDifferences(
  this: DocDBProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  restore: DocDBClusterRestore,
  cluster: DBCluster
): void {
  const differs = (key: string, live: string | undefined): boolean =>
    properties[key] != null && live !== undefined && String(properties[key]) !== live;
  const keys = [
    ...(differs('MasterUsername', cluster.MasterUsername) ? ['MasterUsername'] : []),
    ...(restore.kind === 'point-in-time' && differs('EngineVersion', cluster.EngineVersion)
      ? ['EngineVersion']
      : []),
  ];
  if (keys.length === 0) return;
  this.logger.warn(
    safeMsg`${logicalId} (${resourceType}): the restored cluster keeps its source's ${keys.join(', ')}, not the template's, as in CloudFormation: a restore does not set ${keys.length === 1 ? 'it' : 'them'}. cdkd drift does not report the difference: its baseline is the readback taken at deploy.`
  );
}
