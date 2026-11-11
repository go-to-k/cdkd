import {
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  ModifyDBClusterCommand,
  type CreateDBClusterCommandInput,
} from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseRestoreFromItself } from '../../restore-source-guard.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { RDSProvider } from '../rds-provider.js';
import { desiredLogExports } from './instance-members.js';
import {
  type ServerlessV2ScalingProps,
  serverlessV2ScalingToSend,
  clusterCreateBackfillMembers,
  clusterCreateMultiAzMembers,
  clusterSizeValue,
  malformedInstanceClass,
  clusterCreateScalarMembers,
  backtrackWindowValue,
  localWriteForwardingFlag,
  localWriteForwardingApplied,
  httpEndpointFlag,
  retentionPeriodValue,
  usableAvailabilityZones,
} from './cluster-members.js';
import { readableGlobalClusterId, recordedGlobalClusterIdentifier } from './shared.js';
import {
  EXPRESS_WRITER_RESOURCE_ID_KEY,
  expressConfigurationFlag,
  expressWriterIdentifier,
  isOwnExpressWriter,
  readExpressWriterId,
} from './express-writer.js';
import {
  isLimitlessSource,
  readClusterRestore,
  readRestoreBackup,
  readRestoreSource,
  readSnapshotIsLimitless,
  refuseRestoreEncryption,
  restoreCallName,
  restoreFollowUp,
  restoredDifferences,
  restoreWaitMs,
  sendClusterRestore,
  sendRestoreFollowUp,
  unusedRestoreKeys,
} from './cluster-restore.js';

// ─── DBCluster ────────────────────────────────────────────────────

export async function createDBCluster(
  this: RDSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  replaying = false
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating DBCluster ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  // go-to-k/cdkd#5639: the Data API flag, refused before any call when it is
  // not a boolean, as an update refuses it. A rollback re-create from a state
  // record warns and leaves it out (AWS's default: off) instead.
  let httpEndpoint = httpEndpointFlag(properties['EnableHttpEndpoint']);
  if (httpEndpoint === 'malformed') {
    if (!replaying) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: EnableHttpEndpoint must be true or false`,
          resourceType,
          logicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed EnableHttpEndpoint is not true or false; the cluster is created with the Data API off`
    );
    httpEndpoint = undefined;
  }
  // go-to-k/cdkd#5639: likewise the retention period, which would go out as
  // NaN; a rollback re-create sends none (AWS's default, 7 days).
  const retentionSkipped =
    retentionPeriodValue(properties['PerformanceInsightsRetentionPeriod']) === 'malformed';
  if (retentionSkipped) {
    if (!replaying) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: PerformanceInsightsRetentionPeriod must be a whole number of days`,
          resourceType,
          logicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed PerformanceInsightsRetentionPeriod is not a whole number of days; the cluster is created with AWS's default retention`
    );
  }
  // go-to-k/cdkd#5639: likewise the backtrack window and the write-forwarding
  // flag; a rollback re-create sends neither (AWS's defaults: both off).
  const backtrackSkipped = backtrackWindowValue(properties['BacktrackWindow']) === 'malformed';
  const forwardingSkipped =
    localWriteForwardingFlag(properties['EnableLocalWriteForwarding']) === 'malformed';
  // go-to-k/cdkd#5639: likewise the Availability Zones, which must be a list
  // of names; a rollback re-create sends none (RDS picks the zones).
  const rawAvailabilityZones = properties['AvailabilityZones'];
  const availabilityZonesSkipped = !usableAvailabilityZones(rawAvailabilityZones);
  const availabilityZones =
    rawAvailabilityZones != null && !availabilityZonesSkipped
      ? (rawAvailabilityZones as string[])
      : undefined;
  // go-to-k/cdkd#5639: likewise a global cluster to join that is not a
  // string; a rollback re-create leaves that one out (a string joins, as on
  // a template create).
  const globalClusterSkipped = !readableGlobalClusterId(properties['GlobalClusterIdentifier']);
  const globalClusterId = globalClusterSkipped
    ? undefined
    : recordedGlobalClusterIdentifier(properties);
  // go-to-k/cdkd#5984: create-only; likewise refused when not a boolean, and
  // a rollback re-create leaves it out (a cluster without express configuration).
  const expressFlag = expressConfigurationFlag(properties['WithExpressConfiguration']);
  const expressSkipped = expressFlag === 'malformed';
  // go-to-k/cdkd#5639: a point-in-time or snapshot restore (`readClusterRestore`),
  // refused before any call where CloudFormation refuses its keys. It creates
  // no express writer: neither restore call has such a member.
  const restore = readClusterRestore(properties, resourceType, logicalId);
  const express = expressFlag === true && restore === undefined;
  const unused = unusedRestoreKeys(properties, restore);
  if (unused.length > 0) {
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: this ${restore === undefined ? 'create' : `${restore.kind} restore`} does not apply ${unused.join(', ')}, as in CloudFormation.`
    );
  }
  const classSkipped = malformedInstanceClass(properties['DBClusterInstanceClass']);
  const allocatedSkipped = clusterSizeValue(properties['AllocatedStorage']) === 'malformed';
  const iopsSkipped = clusterSizeValue(properties['Iops']) === 'malformed';
  // go-to-k/cdkd#5639: CreateDBCluster has no DBInstanceParameterGroupName
  // member, so it is never sent; a malformed one is still refused here, as an
  // update refuses it, rather than recorded.
  const instanceParamsSkipped = malformedInstanceClass(properties['DBInstanceParameterGroupName']);
  for (const [skipped, key, expected, created] of [
    [backtrackSkipped, 'BacktrackWindow', 'a whole number of seconds', 'backtracking off'],
    [forwardingSkipped, 'EnableLocalWriteForwarding', 'true or false', 'write forwarding off'],
    [globalClusterSkipped, 'GlobalClusterIdentifier', 'a string', 'no global cluster'],
    [expressSkipped, 'WithExpressConfiguration', 'true or false', 'no express configuration'],
    // go-to-k/cdkd#5639: a Multi-AZ DB cluster's instance class, storage
    // size and IOPS.
    [classSkipped, 'DBClusterInstanceClass', 'a string', 'no instance class sent'],
    [allocatedSkipped, 'AllocatedStorage', 'a whole number of GiB', 'no storage size sent'],
    [iopsSkipped, 'Iops', 'a whole number', 'no IOPS sent'],
    [
      instanceParamsSkipped,
      'DBInstanceParameterGroupName',
      'a string',
      'none (CreateDBCluster takes none), and the record drops it',
    ],
    [
      availabilityZonesSkipped,
      'AvailabilityZones',
      'a list of Availability Zone names',
      'the Availability Zones RDS picks',
    ],
  ] as const) {
    if (!skipped) continue;
    if (!replaying) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: ${key} must be ${expected}`,
          resourceType,
          logicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed ${key} is not ${expected}; the cluster is created with ${created}`
    );
  }
  // go-to-k/cdkd#5639: refused before any call when malformed.
  const roles = this.desiredAssociatedRoles(
    properties,
    resourceType,
    logicalId,
    undefined,
    replaying
  );
  // What the call sent: a record without a skipped key
  // (provider-property-fidelity: a replay-create that skipped drops the key).
  const skippedKeys = [
    ...(roles === 'skipped' ? ['AssociatedRoles'] : []),
    ...(properties['EnableHttpEndpoint'] != null && httpEndpoint === undefined
      ? ['EnableHttpEndpoint']
      : []),
    ...(retentionSkipped ? ['PerformanceInsightsRetentionPeriod'] : []),
    ...(backtrackSkipped ? ['BacktrackWindow'] : []),
    ...(forwardingSkipped ? ['EnableLocalWriteForwarding'] : []),
    ...(availabilityZonesSkipped ? ['AvailabilityZones'] : []),
    ...(globalClusterSkipped ? ['GlobalClusterIdentifier'] : []),
    ...(expressSkipped ? ['WithExpressConfiguration'] : []),
    ...(classSkipped ? ['DBClusterInstanceClass'] : []),
    ...(allocatedSkipped ? ['AllocatedStorage'] : []),
    ...(iopsSkipped ? ['Iops'] : []),
    ...(instanceParamsSkipped ? ['DBInstanceParameterGroupName'] : []),
  ];
  const effectiveProperties =
    skippedKeys.length > 0
      ? Object.fromEntries(Object.entries(properties).filter(([key]) => !skippedKeys.includes(key)))
      : undefined;
  const logExports = desiredLogExports(properties, resourceType, logicalId);

  const dbClusterIdentifier =
    (properties['DBClusterIdentifier'] as string | undefined) ||
    // go-to-k/cdkd#5984: an express cluster's name leaves room for its writer's.
    generatedNameFor('AWS::RDS::DBCluster', logicalId, { properties });
  // go-to-k/cdkd#5639: a replacement's generated name may be the source's, or
  // its automated snapshot's. Names only, as for DocDB: no account is known
  // here, so a source cluster ARN is left to the engine's guard.
  if (
    restore !== undefined &&
    !(restore.kind === 'point-in-time' && /^arn:/i.test(restore.sourceDBClusterIdentifier ?? ''))
  ) {
    refuseRestoreFromItself(resourceType, properties, dbClusterIdentifier, logicalId, {});
  }
  // go-to-k/cdkd#5639: CloudFormation reads the source before restoring: its
  // scalability type picks the request, and a point-in-time source's
  // encryption is checked (a snapshot's is not).
  let limitless = false;
  if (restore?.kind === 'point-in-time' && restore.sourceDBClusterIdentifier !== undefined) {
    const source = await readRestoreSource.call(
      this,
      restore.sourceDBClusterIdentifier,
      resourceType,
      logicalId,
      mask
    );
    refuseRestoreEncryption(properties, source, resourceType, logicalId);
    limitless = isLimitlessSource(source);
  } else if (restore?.kind === 'point-in-time') {
    // Named by its resource id: the source's automated backups are read instead.
    const backup = await readRestoreBackup.call(
      this,
      restore.sourceDbClusterResourceId ?? '',
      resourceType,
      logicalId,
      mask
    );
    refuseRestoreEncryption(properties, backup, resourceType, logicalId);
    limitless = backup.limitless;
  } else if (restore?.kind === 'snapshot') {
    limitless = await readSnapshotIsLimitless.call(
      this,
      restore.snapshotIdentifier,
      resourceType,
      logicalId,
      mask
    );
  }

  // go-to-k/cdkd#4583: true while a cluster THIS create made is left in AWS
  // (CreateDBCluster returned and the self-cleanup below did not delete it).
  let clusterLeftBehind = false;
  // go-to-k/cdkd#4655: the `DbClusterResourceId` CreateDBCluster returned,
  // carried on the failure's mark as the orphan's identity.
  let createdResourceId: string | undefined;
  try {
    const serverlessV2Config = properties['ServerlessV2ScalingConfiguration'] as
      | ServerlessV2ScalingProps
      | undefined;

    // #609 — CFn `MasterUserSecret` is `{ KmsKeyId }`; only the key id is a
    // create input (`MasterUserSecretKmsKeyId`). The object may also carry
    // read-only `SecretArn` / `SecretStatus` (ignored on the write side).
    const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;

    const response = await (restore !== undefined
      ? sendClusterRestore.call(this, properties, restore, {
          dbClusterIdentifier,
          tags,
          logExports,
          availabilityZones,
          limitless,
        })
      : this.getCreateClient().send(
          new CreateDBClusterCommand({
            DBClusterIdentifier: dbClusterIdentifier,
            Engine: properties['Engine'] as string,
            EngineVersion: properties['EngineVersion'] as string | undefined,
            MasterUsername: properties['MasterUsername'] as string | undefined,
            MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
            DatabaseName: properties['DatabaseName'] as string | undefined,
            Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
            VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
            DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
            StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
            KmsKeyId: properties['KmsKeyId'] as string | undefined,
            BackupRetentionPeriod:
              properties['BackupRetentionPeriod'] != null
                ? Number(properties['BackupRetentionPeriod'])
                : undefined,
            DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
            // #609 security-cluster backfill. `!== undefined` for the booleans so
            // an explicit `false` opt-out reaches AWS rather than being dropped by
            // a truthy gate. `MonitoringInterval` is CFn-string-typed → Number().
            ...(properties['ManageMasterUserPassword'] !== undefined && {
              ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
            }),
            ...(masterUserSecret?.KmsKeyId !== undefined && {
              MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
            }),
            ...(properties['MonitoringRoleArn'] !== undefined && {
              MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
            }),
            ...(properties['MonitoringInterval'] !== undefined && {
              MonitoringInterval: Number(properties['MonitoringInterval']),
            }),
            ...(properties['EnableIAMDatabaseAuthentication'] !== undefined && {
              EnableIAMDatabaseAuthentication: properties[
                'EnableIAMDatabaseAuthentication'
              ] as boolean,
            }),
            ...(properties['PubliclyAccessible'] !== undefined && {
              PubliclyAccessible: properties['PubliclyAccessible'] as boolean,
            }),
            ...(serverlessV2Config && {
              ServerlessV2ScalingConfiguration: serverlessV2ScalingToSend(serverlessV2Config),
            }),
            // go-to-k/cdkd#2762: parameter group, windows, tag copying, storage type.
            ...clusterCreateBackfillMembers(properties),
            // go-to-k/cdkd#5639: a Multi-AZ DB cluster's instance class and storage.
            ...clusterCreateMultiAzMembers(properties),
            // go-to-k/cdkd#5639: the declared list, as CloudFormation's create sends it.
            ...(logExports !== undefined &&
              logExports.length > 0 && { EnableCloudwatchLogsExports: logExports }),
            // go-to-k/cdkd#5639: each declared scalar, as CloudFormation's create
            // sends it (the Data API flag included: CreateDBCluster takes it for
            // provisioned and Serverless v2 clusters).
            ...clusterCreateScalarMembers(properties),
            ...(httpEndpoint !== undefined && { EnableHttpEndpoint: httpEndpoint }),
            // go-to-k/cdkd#5639: create-only (a change replaces the cluster).
            ...(properties['ClusterScalabilityType'] != null && {
              ClusterScalabilityType: properties[
                'ClusterScalabilityType'
              ] as CreateDBClusterCommandInput['ClusterScalabilityType'],
            }),
            // go-to-k/cdkd#5639: create-only (a change replaces the cluster).
            ...(properties['EngineMode'] != null && {
              EngineMode: properties['EngineMode'] as string,
            }),
            // go-to-k/cdkd#5639: CreateDBCluster alone, as CloudFormation's create
            // sends it; ModifyDBCluster has no member for it.
            // An empty list leaves the choice to RDS, as an absent one does.
            ...(availabilityZones !== undefined &&
              availabilityZones.length > 0 && { AvailabilityZones: availabilityZones }),
            // go-to-k/cdkd#5639: the global cluster to join, as CloudFormation's
            // create sends it (a blank one names none).
            ...(globalClusterId !== undefined && { GlobalClusterIdentifier: globalClusterId }),
            // go-to-k/cdkd#5984: RDS creates the writer instance with the cluster.
            ...(expressFlag !== undefined &&
              !expressSkipped && { WithExpressConfiguration: express }),
            ...(tags.length > 0 && { Tags: tags }),
          })
        ));
    clusterLeftBehind = true;
    createdResourceId = response.DBCluster?.DbClusterResourceId;
    // go-to-k/cdkd#5511: reported before the post-create wiring and waits.
    reportCreatedResource(logicalId, resourceType, dbClusterIdentifier, createdResourceId);

    const cluster = response.DBCluster;
    if (!cluster) {
      // Theoretical AWS SDK contract violation: CreateDBCluster returned
      // success but with no DBCluster. Cannot clean up — we have no
      // identifier to delete. Has never been observed in practice.
      throw new Error(`${restoreCallName(restore)} did not return DBCluster`);
    }
    if (restore !== undefined) {
      const differs = restoredDifferences(properties, cluster);
      if (differs.length > 0) {
        this.logger.warn(
          safeMsg`DBCluster ${logicalId}: the restored cluster keeps its source's ${differs.join(', ')}, not the template's, as in CloudFormation: a restore does not set ${differs.length === 1 ? 'it' : 'them'}.`
        );
      }
    }

    this.logger.debug(`Successfully created DBCluster ${logicalId}: ${dbClusterIdentifier}`);

    // CreateDBClusterCommand has succeeded — AWS has now committed the
    // cluster and BILLING HAS STARTED (Aurora minimum ~$0.07/hour idle).
    // This is the **cost-leak class** (poll-failure case mentioned in
    // Issue #376): if `waitForClusterAvailable` times out or AWS
    // reports CREATE_FAILED via the waiter, the cluster keeps running
    // until manual cleanup. Wrap the post-create wiring in an inner
    // try/catch that issues a best-effort
    // `ModifyDBCluster(DeletionProtection: false)` (if template asked
    // for protection) + `DeleteDBCluster(SkipFinalSnapshot: true)`
    // before re-throwing the original error. We do NOT wait for the
    // cluster to fully delete (the deploy is already failing — making
    // the user wait another 5-30 min on RDS's eventual termination is
    // bad UX; the same UX choice we made for EC2 Instance in PR #379).
    // When cleanup itself fails, the WARN escalates to `THE CLUSTER
    // IS STILL RUNNING AND BILLING` with the exact recovery commands.
    const wantsDeletionProtection = properties['DeletionProtection'] === true;
    try {
      // go-to-k/cdkd#5639: CloudFormation's create follows a restore with a
      // ModifyDBCluster once the cluster is available (`shouldUpdateAfterCreate`),
      // then turns the Data API on (`enableHttpEndpointV2`). The follow-up always
      // carries a BackupRetentionPeriod, so this wait runs under --no-wait too.
      if (restore !== undefined) {
        await this.waitForClusterAvailable(
          logicalId,
          dbClusterIdentifier,
          restoreWaitMs(),
          'being restored'
        );
        await sendRestoreFollowUp.call(
          this,
          logicalId,
          dbClusterIdentifier,
          restoreFollowUp(properties, logExports, limitless)
        );
        if (httpEndpoint === true && properties['EngineMode'] !== 'serverless') {
          const arn =
            cluster.DBClusterArn ??
            (await this.describeDBCluster(dbClusterIdentifier))?.DBClusterArn;
          if (arn === undefined)
            throw new Error('The restored DBCluster has no ARN to enable the Data API on');
          await this.sendHttpEndpointChange(logicalId, dbClusterIdentifier, arn, true);
          // As the handler's `enableHttpEndpointV2` stabilizes, and as an
          // update waits for the setting (skipped with --no-wait).
          if (process.env['CDKD_NO_WAIT'] !== 'true') {
            await this.waitForClusterState(
              logicalId,
              dbClusterIdentifier,
              (live) => live.HttpEndpointEnabled === true,
              'HTTP endpoint (Data API) setting'
            );
          }
        }
      }
      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(
          logicalId,
          dbClusterIdentifier,
          restore === undefined ? undefined : restoreWaitMs(),
          restore === undefined ? undefined : 'applying the restored cluster settings'
        );
        // go-to-k/cdkd#5639: CloudFormation's create stabilizes only once
        // local write forwarding is no longer `enabling`
        // (`BaseHandlerStd.isLocalWriteForwardingStabilized`).
        if (localWriteForwardingFlag(properties['EnableLocalWriteForwarding']) === true) {
          await this.waitForClusterState(
            logicalId,
            dbClusterIdentifier,
            (cluster) => localWriteForwardingApplied(cluster, true),
            'local write forwarding setting'
          );
        }
        // go-to-k/cdkd#5984: CloudFormation's create completes with the
        // writer RDS created `available`.
        if (express) {
          await this.waitForInstanceAvailable(
            logicalId,
            expressWriterIdentifier(dbClusterIdentifier)
          );
        }
      }

      // go-to-k/cdkd#5639: once the cluster is available, as CloudFormation's
      // create handler attaches them (`addAssociatedRoles`). A role's failure
      // is not this cluster name's collision (#3826).
      if (roles !== 'skipped') {
        try {
          await this.applyAssociatedRoles(
            'cluster',
            logicalId,
            dbClusterIdentifier,
            roles,
            [],
            mask,
            undefined
          );
        } catch (roleError) {
          markAuxiliaryFailure(roleError, logicalId);
          throw roleError;
        }
      }

      // Describe to get final attributes
      const described = await this.describeDBCluster(dbClusterIdentifier);
      const expressWriterId = express
        ? await readExpressWriterId.call(this, dbClusterIdentifier, maskerOrIdentity(mask))
        : undefined;

      return {
        physicalId: dbClusterIdentifier,
        attributes: definedAttributes({
          'Endpoint.Address': described?.Endpoint,
          'Endpoint.Port': stringifyIfAssigned(described?.Port),
          'ReadEndpoint.Address': described?.ReaderEndpoint,
          Arn: described?.DBClusterArn,
          DBClusterResourceId: described?.DbClusterResourceId,
          [EXPRESS_WRITER_RESOURCE_ID_KEY]: expressWriterId,
        }),
        ...(effectiveProperties !== undefined && { effectiveProperties }),
      };
    } catch (innerError) {
      // go-to-k/cdkd#5984: whether the writer under `<cluster>-instance-1` is
      // this cluster's, read before the cleanup and named in its recovery.
      let ownWriter = false;
      try {
        // Flip DeletionProtection off first when template requested it
        // — otherwise DeleteDBCluster rejects with `InvalidParameter
        // Combination: Cannot delete protected DB cluster`.
        if (wantsDeletionProtection) {
          try {
            await this.getClient().send(
              new ModifyDBClusterCommand({
                DBClusterIdentifier: dbClusterIdentifier,
                DeletionProtection: false,
                ApplyImmediately: true,
              })
            );
          } catch (disableError) {
            this.logger.debug(
              maskerOrIdentity(mask)(
                `Could not disable DeletionProtection on partially-created DBCluster ${dbClusterIdentifier}: ${describeAwsFailure(disableError).detail} (proceeding with DeleteDBCluster anyway)`
              )
            );
          }
        }
        // go-to-k/cdkd#5984: RDS refuses the cluster delete while the writer
        // it created for this cluster exists; it takes it once the writer is
        // `deleting`. Only a member of this cluster: a name is no attribution.
        ownWriter = express && (await isOwnExpressWriter.call(this, dbClusterIdentifier));
        if (ownWriter) {
          try {
            await this.getClient().send(
              new DeleteDBInstanceCommand({
                DBInstanceIdentifier: expressWriterIdentifier(dbClusterIdentifier),
                SkipFinalSnapshot: true,
              })
            );
          } catch (writerError) {
            if (!this.isNotFoundError(writerError, 'DBInstanceNotFoundFault')) throw writerError;
          }
        }
        await this.getClient().send(
          new DeleteDBClusterCommand({
            DBClusterIdentifier: dbClusterIdentifier,
            SkipFinalSnapshot: true,
          })
        );
        clusterLeftBehind = false;
        retractCreatedResource(logicalId, resourceType, dbClusterIdentifier);
        this.logger.debug(
          `Delete requested for partially-created DBCluster ${logicalId} (${dbClusterIdentifier}) after wiring failure (not waiting for deleted state)`
        );
      } catch (cleanupError) {
        // Issue #5426: a cluster deleted from outside cdkd (the create wait
        // read `deleting`) refuses this delete yet is not left running: say
        // so instead of the billing warning. Only AWS's own not-found class
        // counts as gone; any other read keeps the warning. Either way the
        // created-before-failure mark stays (fail closed): a not-found read
        // can be read-after-create lag, and a later delete of a gone
        // cluster is a no-op success.
        const retiring = await this.partialClusterRetiring(dbClusterIdentifier);
        if (retiring !== undefined) {
          // AWS's refusal text at debug only, masked (go-to-k/cdkd#2319).
          this.logger.debug(
            maskerOrIdentity(mask)(
              `Cleanup delete of partially-created DBCluster ${logicalId} refused: ${maskerOrIdentity(mask)(describeAwsFailure(cleanupError).detail)}`
            )
          );
          this.logger.warn(
            maskerOrIdentity(mask)(
              `Partially-created DBCluster ${logicalId} (${dbClusterIdentifier}) is ${retiring === 'gone' ? 'read as already deleted' : "already in status 'deleting'"}; cdkd did not delete it again. Outside a rollback's re-create, the failed deploy's rollback journal still records it, so \`cdkd rollback --revert-failed\` confirms it is gone`
            )
          );
          throw innerError;
        }
        // The identifier is TEMPLATE-chosen (or generated), so the recovery
        // commands render through `pasteableAwsCommand` (issue #3136): one
        // that cannot be printed exactly withholds them rather than naming
        // another cluster.
        const aws = pasteableAwsCommand();
        const unprotect = wantsDeletionProtection
          ? aws`aws rds modify-db-cluster --db-cluster-identifier ${dbClusterIdentifier} --no-deletion-protection --apply-immediately; `
          : aws``;
        // go-to-k/cdkd#5984: RDS refuses the cluster delete while its writer exists.
        const writer = ownWriter
          ? aws`aws rds delete-db-instance --db-instance-identifier ${expressWriterIdentifier(dbClusterIdentifier)} --skip-final-snapshot; `
          : aws``;
        // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a denied
        // DeleteDBCluster names the caller's assumed-role ARN. Masked: AWS's
        // text can echo the create's resolved inputs.
        const m = maskerOrIdentity(mask);
        const cleanupFailure = describeAwsFailure(cleanupError);
        const cleanupHead = `Failed to delete partially-created DBCluster ${logicalId} (${dbClusterIdentifier}): `;
        if (cleanupFailure.redacted) {
          this.logger.debug(m(`${cleanupHead}${m(cleanupFailure.detail)}`));
        }
        this.logger.warn(
          `${cleanupHead}${cleanupFailure.redacted ? `${m(cleanupFailure.summary)} ` : `${m(cleanupFailure.detail)}. `}THE CLUSTER IS STILL RUNNING AND BILLING. Outside a rollback's re-create, the failed deploy's rollback journal records it for \`cdkd rollback --revert-failed\`${wantsDeletionProtection ? ', which cannot delete it while its DeletionProtection is on' : ''}; otherwise delete it yourself: ${aws`${unprotect}${writer}aws rds delete-db-cluster --db-cluster-identifier ${dbClusterIdentifier} --skip-final-snapshot`.render()}`
        );
      }
      throw innerError;
    }
  } catch (error) {
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            mask,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create DBCluster ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                dbClusterIdentifier,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#4583: name the cluster still in AWS for the failed-CREATE
    // journal; never before CreateDBCluster returned (another owner's name).
    if (clusterLeftBehind) {
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
