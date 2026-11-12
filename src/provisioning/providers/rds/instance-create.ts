import {
  CreateDBInstanceCommand,
  CreateDBInstanceReadReplicaCommand,
  ModifyDBInstanceCommand,
  RestoreDBInstanceFromDBSnapshotCommand,
  type CreateDBInstanceCommandInput,
  type DBInstance,
} from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import type { RDSProvider } from '../rds-provider.js';
import { applyBackupReplication } from './calls.js';
import {
  backupReplicationPlan,
  desiredLogExports,
  desiredProcessorFeatures,
  engineLifecycleSupportOf,
} from './instance-members.js';
import {
  describeReplicaSource,
  refuseMalformedReplicaSource,
  refuseUnknownSourceRegion,
  replicaCreateInput,
  replicaEngine,
  replicaModifyAfterCreateInput,
  replicaNeedsModifyAfterCreate,
  replicaSourceOf,
} from './read-replica.js';
import { desiredAdditionalStorageVolumes } from './additional-storage-volumes.js';
import {
  declaredSnapshotKeys,
  followUpOnlyKeys,
  readInstanceSnapshotRestore,
  readSnapshotRestoreSource,
  snapshotRestoredDifferences,
  snapshotRestoreInput,
  unusedSnapshotRestoreKeys,
} from './instance-restore.js';
import { refuseRestoreFromItself } from '../../restore-source-guard.js';
import { safeMsg } from '../../../utils/display-safe.js';

// ─── DBInstance ───────────────────────────────────────────────────

export async function createDBInstance(
  this: RDSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  replaying = false
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating DBInstance ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  // go-to-k/cdkd#5640: likewise a malformed AssociatedRoles.
  const roles = this.desiredAssociatedRoles(
    properties,
    resourceType,
    logicalId,
    undefined,
    replaying
  );
  const logExports = desiredLogExports(properties, resourceType, logicalId);
  const processor = desiredProcessorFeatures(properties, resourceType, logicalId);
  // go-to-k/cdkd#5640: refused before any call when malformed.
  const volumes = desiredAdditionalStorageVolumes(properties, resourceType, logicalId);
  // go-to-k/cdkd#5640: validated before any call, started once available.
  const replication = backupReplicationPlan(
    properties,
    {},
    resourceType,
    logicalId,
    undefined,
    replaying,
    (message) => this.logger.warn(message)
  );
  // go-to-k/cdkd#5640: a declared source makes the instance a read replica.
  refuseMalformedReplicaSource(properties, resourceType, logicalId);
  // go-to-k/cdkd#5640: an unknown SourceRegion is refused as CloudFormation
  // refuses it; nothing else is sent for it (`./read-replica.ts`).
  refuseUnknownSourceRegion(properties, resourceType, logicalId, replaying, (message) =>
    this.logger.warn(message)
  );
  const replicaSource = replicaSourceOf(properties);
  // go-to-k/cdkd#5640: a declared snapshot makes the create a restore
  // (`./instance-restore.ts`), unless a source makes it a read replica, which
  // CloudFormation's handler tests first and which reads neither key.
  const snapshotRestore =
    replicaSource === undefined
      ? readInstanceSnapshotRestore(properties, resourceType, logicalId)
      : undefined;
  if (replicaSource !== undefined && declaredSnapshotKeys(properties).length > 0) {
    this.logger.warn(
      safeMsg`DBInstance ${logicalId}: ${declaredSnapshotKeys(properties).join(', ')} not applied: SourceDBInstanceIdentifier makes the instance a read replica, which restores no snapshot, as in CloudFormation.`
    );
  }

  const dbInstanceIdentifier =
    (properties['DBInstanceIdentifier'] as string | undefined) ||
    generatedNameFor('AWS::RDS::DBInstance', logicalId);
  // go-to-k/cdkd#5640: never the instance's own automated snapshot, which its
  // delete removes; a replacement's name may be generated here.
  if (snapshotRestore !== undefined) {
    refuseRestoreFromItself(resourceType, properties, dbInstanceIdentifier, logicalId, {});
  }

  // go-to-k/cdkd#4583: set once CreateDBInstance returned (no self-cleanup).
  let instanceCreated = false;
  // go-to-k/cdkd#4655: the `DbiResourceId` CreateDBInstance returned,
  // carried on the failure's mark as the orphan's identity.
  let createdResourceId: string | undefined;
  try {
    // #609 — `MasterUserSecret` `{ KmsKeyId }` → scalar
    // `MasterUserSecretKmsKeyId` (same flip as the DBCluster path).
    const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;

    const standaloneCreate = (): CreateDBInstanceCommand =>
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        DBInstanceClass: properties['DBInstanceClass'] as string,
        Engine: properties['Engine'] as string,
        DBClusterIdentifier: properties['DBClusterIdentifier'] as string | undefined,
        DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
        PubliclyAccessible: properties['PubliclyAccessible'] as boolean | undefined,
        // #609 backfill — 8 sibling props matching DBCluster.
        // Use `!== undefined` for booleans (DeletionProtection,
        // StorageEncrypted) so an explicit `false` is forwarded as the
        // user-set opt-out rather than silently dropped by a truthy gate.
        // AllocatedStorage / MasterUsername are AWS-required for standalone
        // (non-cluster-member) DBInstance. CFn accepts AllocatedStorage as
        // a numeric STRING (CDK emits `"20"`); coerce through Number().
        ...(properties['AllocatedStorage'] !== undefined && {
          AllocatedStorage: Number(properties['AllocatedStorage']),
        }),
        ...(properties['MasterUsername'] !== undefined && {
          MasterUsername: properties['MasterUsername'] as string,
        }),
        ...(properties['DeletionProtection'] !== undefined && {
          DeletionProtection: properties['DeletionProtection'] as boolean,
        }),
        ...(properties['EngineVersion'] !== undefined && {
          EngineVersion: properties['EngineVersion'] as string,
        }),
        // CFn `Port` → SDK `Port` on CreateDBInstance (not DBPortNumber —
        // that's the MODIFY-side name; AWS uses different field names for
        // the same logical setting across the create vs modify shapes).
        // CFn types Port as a STRING in the template ("5432"); the SDK
        // requires a number, so coerce here.
        ...(properties['Port'] !== undefined && {
          Port: Number(properties['Port']),
        }),
        ...(properties['MasterUserPassword'] !== undefined && {
          MasterUserPassword: properties['MasterUserPassword'] as string,
        }),
        // StorageEncrypted is create-only per AWS RDS docs — set here, not
        // forwarded on update. `!== undefined` so explicit `false` reaches
        // AWS (vs. the AWS-side default, which depends on engine + storage class).
        ...(properties['StorageEncrypted'] !== undefined && {
          StorageEncrypted: properties['StorageEncrypted'] as boolean,
        }),
        // CFn `VPCSecurityGroups` → SDK `VpcSecurityGroupIds` (casing + name flip).
        ...(properties['VPCSecurityGroups'] !== undefined && {
          VpcSecurityGroupIds: properties['VPCSecurityGroups'] as string[],
        }),
        // #609 security-cluster backfill. `KmsKeyId` is the storage-encryption
        // key (pairs with the already-handled StorageEncrypted) — create-only
        // + immutable, so NOT forwarded on update. `MonitoringInterval` is
        // CFn-string-typed → Number(). `!== undefined` on the booleans so an
        // explicit `false` reaches AWS.
        ...(properties['KmsKeyId'] !== undefined && {
          KmsKeyId: properties['KmsKeyId'] as string,
        }),
        ...(masterUserSecret?.KmsKeyId !== undefined && {
          MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
        }),
        ...(properties['ManageMasterUserPassword'] !== undefined && {
          ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
        }),
        ...(properties['MonitoringRoleArn'] !== undefined && {
          MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
        }),
        ...(properties['MonitoringInterval'] !== undefined && {
          MonitoringInterval: Number(properties['MonitoringInterval']),
        }),
        ...(properties['EnableIAMDatabaseAuthentication'] !== undefined && {
          EnableIAMDatabaseAuthentication: properties['EnableIAMDatabaseAuthentication'] as boolean,
        }),
        // go-to-k/cdkd#2762: the same names on the wire; CFn integers may
        // arrive as strings, so they go through Number().
        ...(properties['BackupRetentionPeriod'] != null && {
          BackupRetentionPeriod: Number(properties['BackupRetentionPeriod']),
        }),
        ...(properties['PreferredBackupWindow'] != null && {
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string,
        }),
        ...(properties['PreferredMaintenanceWindow'] != null && {
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string,
        }),
        ...(properties['StorageType'] != null && {
          StorageType: properties['StorageType'] as string,
        }),
        ...(properties['Iops'] != null && { Iops: Number(properties['Iops']) }),
        ...(properties['StorageThroughput'] != null && {
          StorageThroughput: Number(properties['StorageThroughput']),
        }),
        ...(properties['MaxAllocatedStorage'] != null && {
          MaxAllocatedStorage: Number(properties['MaxAllocatedStorage']),
        }),
        ...(properties['MultiAZ'] != null && { MultiAZ: properties['MultiAZ'] as boolean }),
        ...(properties['AutoMinorVersionUpgrade'] != null && {
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean,
        }),
        ...(properties['CopyTagsToSnapshot'] != null && {
          CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean,
        }),
        ...(properties['OptionGroupName'] != null && {
          OptionGroupName: properties['OptionGroupName'] as string,
        }),
        ...(properties['CACertificateIdentifier'] != null && {
          CACertificateIdentifier: properties['CACertificateIdentifier'] as string,
        }),
        // As CloudFormation's create translation does, the flag and the
        // key go out only when Performance Insights is enabled; the
        // retention period always does.
        ...(String(properties['EnablePerformanceInsights']) === 'true' && {
          EnablePerformanceInsights: true,
          ...(properties['PerformanceInsightsKMSKeyId'] != null && {
            PerformanceInsightsKMSKeyId: properties['PerformanceInsightsKMSKeyId'] as string,
          }),
        }),
        ...(properties['PerformanceInsightsRetentionPeriod'] != null && {
          PerformanceInsightsRetentionPeriod: Number(
            properties['PerformanceInsightsRetentionPeriod']
          ),
        }),
        // go-to-k/cdkd#2762: as CloudFormation's create translation sends
        // them. `AllowMajorVersionUpgrade` and `CertificateRotationRestart`
        // are not CreateDBInstance members.
        ...(properties['NetworkType'] != null && {
          NetworkType: properties['NetworkType'] as string,
        }),
        ...(properties['LicenseModel'] != null && {
          LicenseModel: properties['LicenseModel'] as string,
        }),
        ...(properties['PromotionTier'] != null && {
          PromotionTier: Number(properties['PromotionTier']),
        }),
        ...(properties['DatabaseInsightsMode'] != null && {
          DatabaseInsightsMode: properties[
            'DatabaseInsightsMode'
          ] as CreateDBInstanceCommandInput['DatabaseInsightsMode'],
        }),
        ...(properties['DedicatedLogVolume'] != null && {
          DedicatedLogVolume: properties['DedicatedLogVolume'] as boolean,
        }),
        // go-to-k/cdkd#5640: as CloudFormation's create translation sends them.
        ...(engineLifecycleSupportOf(properties) !== undefined && {
          EngineLifecycleSupport: engineLifecycleSupportOf(properties),
        }),
        ...(properties['MasterUserAuthenticationType'] != null && {
          MasterUserAuthenticationType: properties[
            'MasterUserAuthenticationType'
          ] as CreateDBInstanceCommandInput['MasterUserAuthenticationType'],
        }),
        // The group applies at create, so no reboot follows, as under
        // CloudFormation's create handler.
        ...(properties['DBParameterGroupName'] != null && {
          DBParameterGroupName: properties['DBParameterGroupName'] as string,
        }),
        // go-to-k/cdkd#5640: the declared list, as CloudFormation's create sends it.
        ...(logExports !== undefined &&
          logExports.length > 0 && { EnableCloudwatchLogsExports: logExports }),
        // go-to-k/cdkd#5640: sent as declared, as CloudFormation's create
        // sends them; RDS itself refuses a DBName on an engine that takes
        // none (SQL Server) and a zone beside `MultiAZ: true`.
        ...(properties['DBName'] != null && { DBName: properties['DBName'] as string }),
        ...(properties['AvailabilityZone'] != null && {
          AvailabilityZone: properties['AvailabilityZone'] as string,
        }),
        // go-to-k/cdkd#5640: create-only, sent as declared, as CloudFormation's
        // create translation sends them; RDS itself refuses one its engine
        // does not take (a time zone outside SQL Server and Db2, an NCHAR
        // character set outside Oracle). A read replica's create carries none
        // of the three, under CloudFormation too: it inherits its source's.
        ...(properties['CharacterSetName'] != null && {
          CharacterSetName: properties['CharacterSetName'] as string,
        }),
        ...(properties['NcharCharacterSetName'] != null && {
          NcharCharacterSetName: properties['NcharCharacterSetName'] as string,
        }),
        ...(properties['Timezone'] != null && { Timezone: properties['Timezone'] as string }),
        // go-to-k/cdkd#5640: as CloudFormation's create translation sends it.
        // `UseDefaultProcessorFeatures` is no CreateDBInstance member, so the
        // handler drops it here; a standalone create without the list runs
        // the class defaults anyway.
        ...(processor.features !== undefined && { ProcessorFeatures: processor.features }),
        // go-to-k/cdkd#5640: on the create call itself, as CloudFormation was
        // measured to send it (no follow-up modify).
        ...(volumes !== undefined && { AdditionalStorageVolumes: volumes }),
        ...(tags.length > 0 && { Tags: tags }),
      });
    // go-to-k/cdkd#5640: a read replica is created as CloudFormation's
    // handler creates it (`./read-replica.ts`); the engine it inherits decides
    // which storage members that call carries.
    const replicaEngineName =
      replicaSource === undefined
        ? undefined
        : await replicaEngine.call(this, properties, replicaSource);
    // go-to-k/cdkd#5640: the snapshot reads CloudFormation's create makes
    // before a restore; any failure stops it before anything is made.
    const restoreSource =
      snapshotRestore === undefined
        ? undefined
        : await readSnapshotRestoreSource.call(
            this,
            properties,
            snapshotRestore,
            resourceType,
            logicalId,
            mask
          );
    const response =
      snapshotRestore !== undefined && restoreSource !== undefined
        ? await this.getCreateClient().send(
            new RestoreDBInstanceFromDBSnapshotCommand(
              snapshotRestoreInput(properties, {
                identifier: dbInstanceIdentifier,
                restore: snapshotRestore,
                source: restoreSource,
                tags,
                logExports,
                processor,
              })
            )
          )
        : replicaSource === undefined
          ? await this.getCreateClient().send(standaloneCreate())
          : await createReadReplicaWhenSourceAvailable.call(
              this,
              logicalId,
              replicaSource,
              new CreateDBInstanceReadReplicaCommand({
                ...replicaCreateInput(properties, {
                  identifier: dbInstanceIdentifier,
                  source: replicaSource,
                  engine: replicaEngineName,
                  currentRegion: await this.getClient().config.region(),
                  tags,
                  logExports,
                }),
                // go-to-k/cdkd#5640: both, as CloudFormation's replica create
                // translation sends them.
                ...(processor.features !== undefined && { ProcessorFeatures: processor.features }),
                ...(processor.useDefault !== undefined && {
                  UseDefaultProcessorFeatures: processor.useDefault,
                }),
                // go-to-k/cdkd#5640: the replica's own volumes, a
                // CreateDBInstanceReadReplica member like the standalone one.
                ...(volumes !== undefined && { AdditionalStorageVolumes: volumes }),
              })
            );
    instanceCreated = true;
    createdResourceId = response.DBInstance?.DbiResourceId;
    // go-to-k/cdkd#5511: reported before the available wait.
    reportCreatedResource(logicalId, resourceType, dbInstanceIdentifier, createdResourceId);

    const instance = response.DBInstance;
    if (!instance) {
      throw new Error(
        `${snapshotRestore !== undefined ? 'RestoreDBInstanceFromDBSnapshot' : replicaSource === undefined ? 'CreateDBInstance' : 'CreateDBInstanceReadReplica'} did not return DBInstance`
      );
    }
    if (snapshotRestore !== undefined) {
      // go-to-k/cdkd#5640: what the snapshot decided instead of the template.
      const unused = [
        ...unusedSnapshotRestoreKeys(properties),
        ...snapshotRestoredDifferences(properties, instance),
      ];
      if (unused.length > 0) {
        this.logger.warn(
          safeMsg`DBInstance ${logicalId}: ${unused.join(', ')} not applied: a restore from a snapshot takes them from the snapshot, as in CloudFormation.`
        );
      }
    }

    this.logger.debug(`Successfully created DBInstance ${logicalId}: ${dbInstanceIdentifier}`);

    // go-to-k/cdkd#5640: CloudFormation's after-create update of a replica or
    // a restored instance, which needs it `available`, under --no-wait too.
    const followUpEngine = replicaEngineName ?? restoreSource?.engine;
    const modifyAfterCreate =
      (replicaSource !== undefined || snapshotRestore !== undefined) &&
      replicaNeedsModifyAfterCreate(properties, followUpEngine, instance.Engine);
    // go-to-k/cdkd#5640: the members only that follow-up carries, when it does not run.
    const unappliedFollowUp =
      modifyAfterCreate || (replicaSource === undefined && snapshotRestore === undefined)
        ? []
        : followUpOnlyKeys(properties, snapshotRestore !== undefined ? 'restore' : 'replica');
    if (unappliedFollowUp.length > 0) {
      this.logger.warn(
        safeMsg`DBInstance ${logicalId}: ${unappliedFollowUp.join(', ')} not applied: only CloudFormation's after-create ModifyDBInstance carries them, and nothing else declared calls for it, as in CloudFormation.`
      );
    }

    // Wait for instance to become available (skip with --no-wait)
    if (process.env['CDKD_NO_WAIT'] !== 'true' || modifyAfterCreate) {
      await this.waitForInstanceAvailable(logicalId, dbInstanceIdentifier);
    }

    if (modifyAfterCreate) {
      await modifyReplicaAfterCreate.call(
        this,
        logicalId,
        dbInstanceIdentifier,
        properties,
        followUpEngine
      );
    }

    // go-to-k/cdkd#5640: once the instance is available, as CloudFormation's
    // create handler attaches the roles (`updateAssociatedRoles`), then starts
    // the backup replication (`startAutomaticBackupReplicationInRegion`).
    // Neither failure is this instance name's collision (#3826).
    try {
      if (roles !== 'skipped') {
        await this.applyAssociatedRoles(
          'instance',
          logicalId,
          dbInstanceIdentifier,
          roles,
          [],
          mask,
          undefined
        );
      }
      await applyBackupReplication.call(this, logicalId, dbInstanceIdentifier, replication);
    } catch (auxiliaryError) {
      markAuxiliaryFailure(auxiliaryError, logicalId);
      throw auxiliaryError;
    }

    // Describe to get final attributes
    const described = await this.describeDBInstance(dbInstanceIdentifier);

    return {
      physicalId: dbInstanceIdentifier,
      attributes: definedAttributes({
        'Endpoint.Address': described?.Endpoint?.Address,
        'Endpoint.Port': stringifyIfAssigned(described?.Endpoint?.Port),
        Arn: described?.DBInstanceArn,
      }),
      // A replayed create that attached no role records none.
      ...(roles === 'skipped' && {
        effectiveProperties: Object.fromEntries(
          Object.entries(properties).filter(([key]) => key !== 'AssociatedRoles')
        ),
      }),
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
                `Failed to create DBInstance ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                dbInstanceIdentifier,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#4583: the instance exists and no state record will hold
    // it; never before CreateDBInstance returned (another owner's name).
    if (instanceCreated) {
      markCreatedBeforeFailure(
        thrown,
        logicalId,
        resourceType,
        dbInstanceIdentifier,
        createdResourceId
      );
    }
    throw thrown;
  }
}

/**
 * go-to-k/cdkd#5640: the replica's (or restored instance's) after-create `ModifyDBInstance`
 * (`replicaModifyAfterCreateInput`), then, as the handler reboots when a
 * parameter group is declared, a reboot of one left `pending-reboot`.
 */
export async function modifyReplicaAfterCreate(
  this: RDSProvider,
  logicalId: string,
  dbInstanceIdentifier: string,
  properties: Record<string, unknown>,
  engine: string | undefined
): Promise<void> {
  await modifyDbInstanceWhenAvailable({
    send: () =>
      this.getClient().send(
        new ModifyDBInstanceCommand(
          replicaModifyAfterCreateInput(properties, dbInstanceIdentifier, engine)
        )
      ),
    readStatus: async () => (await this.describeDBInstance(dbInstanceIdentifier))?.DBInstanceStatus,
    sleep: (ms) => this.sleep(ms),
    logger: this.logger,
    label: 'RDS DBInstance',
    logicalId,
    remainingMs: enclosingDeadlineRemainingMs(),
  });
  const group = properties['DBParameterGroupName'];
  if (typeof group === 'string' && group !== '') {
    await this.rebootForPendingParameterGroup(logicalId, dbInstanceIdentifier, group, false);
  } else if (process.env['CDKD_NO_WAIT'] !== 'true') {
    await this.waitForInstanceAvailable(
      logicalId,
      dbInstanceIdentifier,
      undefined,
      'being modified after its create'
    );
  }
}

/**
 * go-to-k/cdkd#5640: `CreateDBInstanceReadReplica`, waiting out a SOURCE that
 * is not `available`. Its replicas are created in parallel when a template
 * declares more than one, and the source leaves `available` as the first
 * starts, so RDS refuses the next ("DB instance is not in the available
 * state", `InvalidDBInstanceStateFault`). The refusal created nothing, so it
 * is resent once the source reads `available` again, within the #5194 retry
 * budget and its classifier (`modifyDbInstanceWhenAvailable`); under
 * --no-wait too, since the replica cannot be created otherwise. Any other
 * failure propagates at once. CloudFormation's handler maps the fault to
 * `ResourceConflict` (`DEFAULT_DB_INSTANCE_ERROR_RULE_SET`). A source in
 * `storage-optimization` / `storage-initialization` counts as proceed
 * (`isProceedDbStatus`), so should RDS keep refusing replicas there the
 * create is resent about every 10 seconds until the budget ends (bounded;
 * not verified on AWS).
 */
export async function createReadReplicaWhenSourceAvailable(
  this: RDSProvider,
  logicalId: string,
  source: string,
  command: CreateDBInstanceReadReplicaCommand
): Promise<{ DBInstance?: DBInstance | undefined }> {
  let response: { DBInstance?: DBInstance | undefined } = {};
  await modifyDbInstanceWhenAvailable({
    send: async () => {
      response = await this.getCreateClient().send(command);
    },
    readStatus: async () => (await describeReplicaSource.call(this, source))?.DBInstanceStatus,
    sleep: (ms) => this.sleep(ms),
    logger: this.logger,
    label: 'RDS DBInstance',
    logicalId,
    remainingMs: enclosingDeadlineRemainingMs(),
    action: 'create of the read replica',
    nounText: 'source instance',
  });
  return response;
}
