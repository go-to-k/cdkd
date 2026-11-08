import {
  DescribeGlobalClustersCommand,
  ModifyDBClusterCommand,
  type ModifyDBClusterCommandInput,
} from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { associatedRoleList } from '../db-associated-roles.js';
import type { RDSProvider } from '../rds-provider.js';
import {
  masterUserPasswordToSend,
  masterCredentialSettingsChanged,
  managedPasswordSettingRides,
  passwordAuthenticationCompanion,
  passwordAuthenticationMissingText,
  masterUserAuthenticationTypeToSend,
  managedPasswordOnRemoval,
} from './master-credentials.js';
import {
  numberOrUndefined,
  desiredLogExports,
  logExportsDelta,
  logExportsApplied,
} from './instance-members.js';
import {
  type ServerlessV2ScalingProps,
  serverlessV2ScalingToSend,
  clusterModifyBackfillMembers,
  clusterModifyMultiAzMembers,
  multiAzAppliedProbe,
  clusterSizeValue,
  usableClusterSize,
  malformedInstanceClass,
  usableInstanceClass,
  clusterModifyScalarMembers,
  backtrackWindowValue,
  localWriteForwardingFlag,
  localWriteForwardingToSend,
  localWriteForwardingApplied,
  retentionPeriodValue,
  clusterHttpEndpointAction,
  withPreviousValues,
  usableHttpEndpoint,
  usableRetentionPeriod,
  usableBacktrackWindow,
  usableLocalWriteForwarding,
  usableAvailabilityZones,
  clusterEngineVersionChanged,
  SECURITY_GROUP_CHANGE_MEMBER_STATUSES,
  PORT_CHANGE_MEMBER_STATUSES,
  clusterPortToSend,
  isClusterBusyRefusal,
} from './cluster-members.js';
import {
  securityGroupListChanged,
  GlobalClusterDetachError,
  usableGlobalClusterId,
  readableGlobalClusterId,
  recordedGlobalClusterIdentifier,
  GLOBAL_CLUSTER_CHANGE_REFUSED,
  type GlobalClusterUpdate,
} from './shared.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { slowCcOperationTimeoutMs } from '../../slow-cc-operation-timeouts.js';

export async function updateDBCluster(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating DBCluster ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // go-to-k/cdkd#5639: likewise a malformed AssociatedRoles, on every path.
  const roles = this.desiredAssociatedRoles(properties, resourceType, logicalId, physicalId, false);
  // go-to-k/cdkd#5639: refused before any call when malformed; a removal
  // disables what the previous template declared, as CloudFormation does.
  const logExportConfig = logExportsDelta(
    desiredLogExports(properties, resourceType, logicalId, physicalId),
    previousProperties['EnableCloudwatchLogsExports']
  );
  // go-to-k/cdkd#5639: a malformed template flag is refused before any call.
  const httpEndpointAction = clusterHttpEndpointAction(
    properties,
    previousProperties,
    resourceType,
    logicalId,
    physicalId,
    context
  );
  if (httpEndpointAction === 'skip') {
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed EnableHttpEndpoint is not true or false; the Data API setting is left as it is`
    );
  }
  if (httpEndpointAction === 'withheld') {
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: drift --revert does not turn the Data API (EnableHttpEndpoint) back on, because the template does not declare EnableHttpEndpoint: true; declare it and deploy, or turn the Data API on with aws rds enable-http-endpoint`
    );
  }
  // go-to-k/cdkd#5639: likewise a retention period that would go out as NaN.
  const skippedKeys: Array<readonly [string, (value: unknown) => boolean]> =
    httpEndpointAction === 'skip' || httpEndpointAction === 'withheld'
      ? [['EnableHttpEndpoint', usableHttpEndpoint]]
      : [];
  if (retentionPeriodValue(properties['PerformanceInsightsRetentionPeriod']) === 'malformed') {
    if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: PerformanceInsightsRetentionPeriod must be a whole number of days`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed PerformanceInsightsRetentionPeriod is not a whole number of days; the retention period is left as it is`
    );
    skippedKeys.push(['PerformanceInsightsRetentionPeriod', usableRetentionPeriod]);
  }
  // go-to-k/cdkd#5639: an update sends no AvailabilityZones (ModifyDBCluster
  // has no member; CloudFormation's update keeps the live zones), but a
  // malformed list is refused as the create refuses it, so the record never
  // carries one a later re-create would refuse. A state-borne one records the
  // previous list instead.
  if (!usableAvailabilityZones(properties['AvailabilityZones'])) {
    if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: AvailabilityZones must be a list of Availability Zone names`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed AvailabilityZones is not a list of Availability Zone names; the record keeps the previous list`
    );
    skippedKeys.push(['AvailabilityZones', usableAvailabilityZones]);
  }
  // go-to-k/cdkd#5639: likewise the backtrack window and the write-forwarding
  // flag, which would go out as NaN or read as "not true".
  for (const [malformed, key, expected, usable] of [
    [
      backtrackWindowValue(properties['BacktrackWindow']) === 'malformed',
      'BacktrackWindow',
      'a whole number of seconds',
      usableBacktrackWindow,
    ],
    [
      localWriteForwardingFlag(properties['EnableLocalWriteForwarding']) === 'malformed',
      'EnableLocalWriteForwarding',
      'true or false',
      usableLocalWriteForwarding,
    ],
    // go-to-k/cdkd#5639: a Multi-AZ DB cluster's instance class, storage
    // size and IOPS.
    [
      malformedInstanceClass(properties['DBClusterInstanceClass']),
      'DBClusterInstanceClass',
      'a string',
      usableInstanceClass,
    ],
    [
      clusterSizeValue(properties['AllocatedStorage']) === 'malformed',
      'AllocatedStorage',
      'a whole number of GiB',
      usableClusterSize,
    ],
    [
      clusterSizeValue(properties['Iops']) === 'malformed',
      'Iops',
      'a whole number',
      usableClusterSize,
    ],
  ] as const) {
    if (!malformed) continue;
    if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: ${key} must be ${expected}`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: the replayed ${key} is not ${expected}; the setting is left as it is`
    );
    skippedKeys.push([key, usable]);
  }
  if (localWriteForwardingToSend(properties, previousProperties, context) === 'withheld') {
    this.logger.warn(
      safeMsg`DBCluster ${logicalId}: drift --revert does not turn local write forwarding (EnableLocalWriteForwarding) back on, because the template does not declare EnableLocalWriteForwarding: true; declare it and deploy, or turn it on with aws rds modify-db-cluster --enable-local-write-forwarding`
    );
    skippedKeys.push(['EnableLocalWriteForwarding', usableLocalWriteForwarding]);
  }

  // Set once this update detached the cluster, so a later failure says so.
  let detachedFrom: string | undefined;
  try {
    // go-to-k/cdkd#5639: an add or change CloudFormation fails is refused
    // before any write; its ProvisioningError passes through the catch.
    const globalClusterPlan = await planGlobalClusterUpdate.call(
      this,
      physicalId,
      properties,
      previousProperties,
      resourceType,
      logicalId,
      context
    );
    if (globalClusterPlan.kind === 'keep') {
      skippedKeys.push(['GlobalClusterIdentifier', usableGlobalClusterId]);
    }
    if (globalClusterPlan.kind === 'drop') {
      // Never restored: the previous value names a membership AWS no longer holds.
      skippedKeys.push(['GlobalClusterIdentifier', () => false]);
    }
    // go-to-k/cdkd#5639: a changed EngineLifecycleSupport is refused before
    // any change, as CloudFormation refuses it; its ProvisioningError passes
    // through the catch.
    const engineLifecycleSupport = await this.engineLifecycleSupportToSend(
      'DB cluster',
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
    let authenticationType = masterUserAuthenticationTypeToSend(
      properties,
      previousProperties,
      context
    );
    let passwordCompanion = passwordAuthenticationCompanion(
      properties,
      previousProperties,
      authenticationType
    );
    // A rollback replay cannot fix the record: it reverts every other member
    // and leaves the type as it is, with a warning.
    if (passwordCompanion?.kind === 'missing' && context?.replayingState === true) {
      this.logger.warn(
        safeMsg`${logicalId}: the rollback leaves MasterUserAuthenticationType as it is, because the restored properties declare neither MasterUserPassword nor ManageMasterUserPassword: true, which RDS needs beside a switch to password`
      );
      authenticationType = undefined;
      passwordCompanion = undefined;
    }
    if (passwordCompanion?.kind === 'missing') {
      throw markNonRetryable(
        new ProvisioningError(
          passwordAuthenticationMissingText(resourceType, logicalId),
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    // Its own ProvisioningError names the cause; the catch passes it through.
    const vpcSgIds = await this.securityGroupsToSend(
      'DBCluster',
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
    const serverlessV2Config = properties['ServerlessV2ScalingConfiguration'] as
      | ServerlessV2ScalingProps
      | undefined;
    // Class 2 — defence-in-depth on top of the readCurrentState gate.
    // `{}` (or `{ MinCapacity: undefined, MaxCapacity: undefined }`)
    // is structurally invalid as ModifyDBCluster input on
    // non-serverless-v2 clusters; only ship the field when at least
    // one member is present.
    const hasServerlessV2 =
      serverlessV2Config !== undefined &&
      (serverlessV2Config.MinCapacity !== undefined ||
        serverlessV2Config.MaxCapacity !== undefined ||
        serverlessV2Config.SecondsUntilAutoPause !== undefined);

    // #609 — `MasterUserSecret` `{ KmsKeyId }` maps to the scalar modify
    // field `MasterUserSecretKmsKeyId` (same flip as create()).
    const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;
    // #5153: the managed-password settings ride only a credential change.
    const sendCredentialSettings = masterCredentialSettingsChanged(
      properties,
      previousProperties,
      context
    );
    // go-to-k/cdkd#5639 / #5640: the managed-password flag also rides a changed
    // MasterUserAuthenticationType; the KMS key does not.
    const sendManagedPasswordSetting = managedPasswordSettingRides(
      sendCredentialSettings,
      authenticationType
    );

    // #1160 removal — ModifyDBCluster has merge semantics (an absent input
    // field means "no change"), so a property REMOVED from the template is
    // sent as its CFn reset value only where CloudFormation resets it, per
    // real A/Bs (#5004, #1160 comment 6401151077):
    //   * RESET: BackupRetentionPeriod (to 1), Port (to the engine default
    //     on Aurora; on a Multi-AZ DB cluster CloudFormation sends 3306,
    //     which RDS refuses: `CLUSTER_REMOVED_PORT`), ManageMasterUserPassword
    //     (to false, `managedPasswordOnRemoval`), VpcSecurityGroupIds (to the
    //     VPC's default security group, `securityGroupsToSend`).
    //   * KEPT (omitted = unchanged): DeletionProtection,
    //     EnableIAMDatabaseAuthentication, EngineVersion, MonitoringInterval,
    //     MonitoringRoleArn, ServerlessV2ScalingConfiguration, the
    //     #2762 backfill members (`clusterModifyBackfillMembers`) and the
    //     #5639 scalars (`clusterModifyScalarMembers`) and Multi-AZ members
    //     (`clusterModifyMultiAzMembers`).
    //   * TURNED OFF: a removed `EnableHttpEndpoint: true` disables the Data
    //     API, as CloudFormation's handler does (`clusterHttpEndpointAction`),
    //     and a removed `EnableLocalWriteForwarding: true` disables write
    //     forwarding (`localWriteForwardingToSend`).
    // MasterUserSecret removed while the managed password stays on: the
    // credential gate re-sends ManageMasterUserPassword=true with no key, as
    // CloudFormation does, and the secret stays on its customer key
    // (#1160 comment 6484915102). Unmeasured: ManageMasterUserPassword
    // removed while MasterUserSecret { KmsKeyId } stays declared, which sends
    // `false` plus MasterUserSecretKmsKeyId (RDS accepts a key only when
    // enabling).
    // A changed MasterUsername sends nothing, and ModifyDBCluster has no such
    // member. Measured against CloudFormation (us-east-1, 2026-10-28, #5467):
    // the stack update completes in place and the live user stays the old one.
    const manageMasterUserPasswordOff = managedPasswordOnRemoval(properties, previousProperties);
    const portToSend = clusterPortToSend(properties, previousProperties);
    // go-to-k/cdkd#2762: EngineVersion goes out only when changed, with
    // AllowMajorVersionUpgrade, as CloudFormation's handler sends both
    // (`Translator.modifyDbClusterRequest`: any EngineVersion change outside
    // a rollback). Without it RDS refuses a major upgrade, such as the one
    // CDK's L2 cluster emits with its default parameter group's family, which
    // CloudFormation applies in place. DBCluster has no template
    // `AllowMajorVersionUpgrade` property to read.
    const engineVersionChanged = clusterEngineVersionChanged(
      properties,
      previousProperties,
      context
    );
    const scalarMembers = clusterModifyScalarMembers(properties, previousProperties, context);
    const multiAzMembers = clusterModifyMultiAzMembers(
      properties,
      previousProperties,
      context,
      // The record keeps the size AWS still holds (`effectiveProperties`).
      (desired, previous) => {
        this.logger.warn(
          safeMsg`DBCluster ${logicalId}: AllocatedStorage stays at ${String(previous)} GiB rather than going back to ${String(desired)} GiB, because RDS cannot shrink storage`
        );
        skippedKeys.push(['AllocatedStorage', usableClusterSize]);
      }
    );
    // go-to-k/cdkd#5639: a removed GlobalClusterIdentifier detaches the
    // cluster in place BEFORE the ModifyDBCluster, as CloudFormation's update
    // handler does (`removeFromGlobalCluster`): the detach leaves it
    // `modifying` until it is out and `available` again. The wait runs under
    // `--no-wait` too, since RDS refuses the ModifyDBCluster meanwhile.
    if (globalClusterPlan.kind === 'detach') {
      const detached = await this.detachFromGlobalCluster(
        logicalId,
        physicalId,
        globalClusterPlan.globalClusterId,
        { beforeDelete: false, removeProtection: false },
        { stripped: false },
        maskerOrIdentity(context?.maskSecrets)
      );
      if (detached) detachedFrom = globalClusterPlan.globalClusterId;
    }
    // go-to-k/cdkd#5994: RDS refuses the modify while the cluster is busy
    // with something that ends on its own (`backing-up` right after create,
    // a member still taking its settings), and CloudFormation waits it out.
    // The same input is resent only after such a refusal, so a rollback
    // replay sends exactly what it computed; a terminal status fails at once.
    const modifyInput: ModifyDBClusterCommandInput = {
      DBClusterIdentifier: physicalId,
      // Only a changed EngineVersion, with the flag, as the handler sends
      // it: an unchanged one re-sent after AWS auto-upgraded the minor
      // version reads as a downgrade, and a rollback replay sends none (RDS
      // refuses the downgrade, failing every other reverted member).
      ...(engineVersionChanged && {
        EngineVersion: properties['EngineVersion'] as string,
        AllowMajorVersionUpgrade: true,
      }),
      // Removal keeps the live value, as CFn does (#5004 A/B).
      DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
      // CFn resets a removed BackupRetentionPeriod to 1 (#5004 A/B).
      BackupRetentionPeriod: clearOnUpdateRemoval(
        properties['BackupRetentionPeriod'] != null
          ? Number(properties['BackupRetentionPeriod'])
          : undefined,
        previousProperties['BackupRetentionPeriod'] != null
          ? Number(previousProperties['BackupRetentionPeriod'])
          : undefined,
        1
      ),
      ...(vpcSgIds !== undefined && { VpcSecurityGroupIds: vpcSgIds }),
      // #5153: only a changed password; any supplied one resets credentials.
      // go-to-k/cdkd#5639: a switch to password also carries the declared one.
      MasterUserPassword:
        masterUserPasswordToSend(properties, previousProperties, context) ??
        (passwordCompanion?.kind === 'password' ? passwordCompanion.password : undefined),
      Port: portToSend,
      // #609 security-cluster backfill — all mutable via ModifyDBCluster.
      ...(sendManagedPasswordSetting &&
        properties['ManageMasterUserPassword'] !== undefined && {
          ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
        }),
      ...(manageMasterUserPasswordOff && { ManageMasterUserPassword: false }),
      // go-to-k/cdkd#5639: also when a switch to password turns the
      // managed secret on (`passwordAuthenticationCompanion`).
      ...((sendCredentialSettings || passwordCompanion?.kind === 'managed') &&
        masterUserSecret?.KmsKeyId !== undefined && {
          MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
        }),
      ...(properties['MonitoringRoleArn'] !== undefined && {
        MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
      }),
      // Removal keeps the live interval, as CFn does, with or without the
      // role removed alongside (#1160 comment 6401151077).
      ...(properties['MonitoringInterval'] != null && {
        MonitoringInterval: Number(properties['MonitoringInterval']),
      }),
      // Removal keeps the live value, as CFn does (#5004 A/B).
      EnableIAMDatabaseAuthentication: properties['EnableIAMDatabaseAuthentication'] as
        | boolean
        | undefined,
      ...(hasServerlessV2 && {
        ServerlessV2ScalingConfiguration: serverlessV2ScalingToSend(serverlessV2Config),
      }),
      // go-to-k/cdkd#2762: only what changed; a removal keeps the live value.
      ...clusterModifyBackfillMembers(properties, previousProperties, context),
      // go-to-k/cdkd#5639: only what changed; a removal keeps the live value,
      // except a removed EnableLocalWriteForwarding: true, which turns it off.
      ...scalarMembers,
      // go-to-k/cdkd#5639: a Multi-AZ DB cluster's instance class, and its
      // storage size and IOPS together; a removal keeps the live value.
      ...multiAzMembers,
      // go-to-k/cdkd#5639: only a drift revert sends it; only a change
      // sends the authentication type, beside the credential settings.
      ...(engineLifecycleSupport !== undefined && {
        EngineLifecycleSupport: engineLifecycleSupport,
      }),
      ...(authenticationType !== undefined && {
        MasterUserAuthenticationType: authenticationType,
      }),
      ...(logExportConfig !== undefined && {
        CloudwatchLogsExportConfiguration: logExportConfig,
      }),
      ApplyImmediately: true,
    };
    await modifyDbInstanceWhenAvailable({
      send: () => this.getClient().send(new ModifyDBClusterCommand(modifyInput)),
      readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label: 'RDS DBCluster',
      subject: 'cluster',
      isRefusal: isClusterBusyRefusal,
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });

    this.logger.debug(`Successfully updated DBCluster ${logicalId}`);

    // A changed Port (declared, or the engine default on removal) applies
    // asynchronously: the describe below could still read the old one, and a
    // same-deploy `Fn::GetAtt <cluster>.Endpoint.Port` would get it.
    // CloudFormation reports the update once it has settled, so wait for the
    // new port first, then for the member instances it moved to `modifying` /
    // `rebooting`, whose own Modify* in the same deploy would otherwise be
    // refused. An unchanged port adds no call; `--no-wait` skips both.
    const noWait = process.env['CDKD_NO_WAIT'] === 'true';
    const portChanged =
      portToSend !== undefined && portToSend !== numberOrUndefined(previousProperties['Port']);
    if (!noWait && portChanged) {
      await this.waitForClusterPortApplied(physicalId, logicalId, portToSend);
    }

    // go-to-k/cdkd#5639: CloudFormation reports the update once no change is
    // pending; a later read of the old list would also be a phantom drift.
    if (!noWait && logExportConfig !== undefined) {
      await this.waitForClusterState(
        logicalId,
        physicalId,
        (cluster) =>
          logExportsApplied(
            logExportConfig,
            cluster.EnabledCloudwatchLogsExports,
            cluster.PendingModifiedValues?.PendingCloudwatchLogsExports
          ),
        'CloudWatch Logs exports'
      );
    }

    // go-to-k/cdkd#5639: CloudFormation's update stabilizes only once local
    // write forwarding is no longer `enabling` / `disabling`
    // (`BaseHandlerStd.isLocalWriteForwardingStabilized`).
    const forwardingSent = scalarMembers.EnableLocalWriteForwarding;
    if (!noWait && forwardingSent !== undefined) {
      await this.waitForClusterState(
        logicalId,
        physicalId,
        (cluster) => localWriteForwardingApplied(cluster, forwardingSent),
        'local write forwarding setting'
      );
    }

    // go-to-k/cdkd#5639: RDS applies a changed BacktrackWindow after
    // ModifyDBCluster returns (measured: a describe right after the call
    // still read the old window), and it is not among the pending modified
    // values. CloudFormation reports the update only once the cluster has
    // stabilized (`BaseHandlerStd.isDBClusterStabilized`), so wait for the
    // window sent; a describe that never reports one ends the wait.
    const backtrackSent = scalarMembers.BacktrackWindow;
    if (!noWait && backtrackSent !== undefined) {
      await this.waitForClusterState(
        logicalId,
        physicalId,
        (cluster) =>
          cluster.BacktrackWindow === undefined || cluster.BacktrackWindow === backtrackSent,
        'backtrack window'
      );
    }

    // go-to-k/cdkd#5639: a Multi-AZ DB cluster applies a new instance class or
    // storage size after ModifyDBCluster returns, and CloudFormation reports
    // the update only once it has (`multiAzAppliedProbe`). `--full-wait` also
    // waits out `storage-optimization`, as CloudFormation does.
    if (!noWait && Object.keys(multiAzMembers).length > 0) {
      await this.waitForClusterState(
        logicalId,
        physicalId,
        multiAzAppliedProbe(multiAzMembers, process.env['CDKD_FULL_WAIT'] === 'true'),
        'instance class or storage change',
        // A rollback replay has no resource deadline: give the rolling class
        // change the same budget the deploy's update floor does.
        slowCcOperationTimeoutMs('AWS::RDS::DBCluster', 'UPDATE')
      );
    }

    // Describe to get updated attributes
    const described = await this.describeDBCluster(physicalId);

    // go-to-k/cdkd#5639: the Data API is turned on or off by its own call on
    // the cluster ARN, after the ModifyDBCluster, as CloudFormation's update
    // handler does; it then waits for the cluster to report the new setting.
    // The handler makes the call only once the ModifyDBCluster stabilized
    // (`isDBClusterStabilized`: the cluster `available`), and RDS refuses it
    // while another change is in progress, so the call waits for `available`
    // first, under `--no-wait` too.
    if (httpEndpointAction === 'enable' || httpEndpointAction === 'disable') {
      const arn = described?.DBClusterArn;
      if (!arn) {
        throw new Error(
          `DescribeDBClusters did not report the cluster ARN, which ${httpEndpointAction === 'enable' ? 'EnableHttpEndpoint' : 'DisableHttpEndpoint'} needs`
        );
      }
      const enable = httpEndpointAction === 'enable';
      await this.sendHttpEndpointChange(logicalId, physicalId, arn, enable);
      if (!noWait) {
        await this.waitForClusterState(
          logicalId,
          physicalId,
          (cluster) => (cluster.HttpEndpointEnabled ?? false) === enable,
          'HTTP endpoint (Data API) setting'
        );
      }
    }

    if (!noWait && portChanged) {
      for (const member of described?.DBClusterMembers ?? []) {
        if (member.DBInstanceIdentifier) {
          await this.waitForMemberAfterClusterChange(
            member.DBInstanceIdentifier,
            logicalId,
            PORT_CHANGE_MEMBER_STATUSES,
            'port'
          );
        }
      }
    }

    // A changed VpcSecurityGroupIds also moves every member instance to
    // `modifying` within about a second, and a member's own Modify* in the
    // same deploy is then refused ("Database instance is not in available
    // state"). CloudFormation reports the update only once it has settled, so
    // wait here, but ONLY when the sent list differs from the previous one:
    // an unchanged list (re-sent on every update) adds no time. `--no-wait`
    // skips it, exactly as create() skips waitForClusterAvailable.
    if (!noWait && securityGroupListChanged(vpcSgIds, previousProperties['VpcSecurityGroupIds'])) {
      await this.waitForSecurityGroupsApplied(physicalId, logicalId, vpcSgIds ?? []);
      for (const member of described?.DBClusterMembers ?? []) {
        if (member.DBInstanceIdentifier) {
          await this.waitForMemberAfterClusterChange(
            member.DBInstanceIdentifier,
            logicalId,
            SECURITY_GROUP_CHANGE_MEMBER_STATUSES,
            'VPC security groups'
          );
        }
      }
    }

    // go-to-k/cdkd#5639: after the ModifyDBCluster, as CloudFormation's
    // update handler changes them. A malformed record only misses detaches:
    // the plan reads what is live, so an attached role is not attached twice.
    await this.applyAssociatedRoles(
      'cluster',
      logicalId,
      physicalId,
      roles,
      associatedRoleList(previousProperties['AssociatedRoles']) ?? [],
      context?.maskSecrets,
      context
    );

    // Apply tag diff using the cluster ARN.
    if (described?.DBClusterArn) {
      await this.applyTagDiff(
        described.DBClusterArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: definedAttributes({
        'Endpoint.Address': described?.Endpoint,
        // Under `--no-wait` the describe can still read the OLD port; record
        // the one sent, or a `Fn::GetAtt <cluster>.Endpoint.Port` consumer
        // stays stale.
        'Endpoint.Port': stringifyIfAssigned(
          noWait && portChanged && described !== undefined ? portToSend : described?.Port
        ),
        'ReadEndpoint.Address': described?.ReaderEndpoint,
        Arn: described?.DBClusterArn,
        DBClusterResourceId: described?.DbClusterResourceId,
      }),
      // go-to-k/cdkd#5639: a skipped key keeps the previous record's value
      // (none when it held none or an unusable one).
      ...(skippedKeys.length > 0 && {
        effectiveProperties: withPreviousValues(properties, previousProperties, skippedKeys),
      }),
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    if (error instanceof GlobalClusterDetachError) {
      // Already masked and waited through: a retry would only repeat it.
      throw markNonRetryable(
        new ProvisioningError(
          `Failed to update DBCluster ${logicalId}: ${error.message}`,
          resourceType,
          logicalId,
          physicalId,
          error
        )
      );
    }
    const cause = error instanceof Error ? error : undefined;
    const detachedNote =
      detachedFrom !== undefined
        ? ' (it was already detached from its global cluster, and stays a standalone cluster)'
        : '';
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update DBCluster ${logicalId}: ${text}${detachedNote}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * go-to-k/cdkd#5639: what an update does about `GlobalClusterIdentifier`.
 * ModifyDBCluster has no member for it. CloudFormation's update handler
 * (archived `aws-cloudformation-resource-providers-rds` at
 * 5a410e843efb90076c1c4d322707bc989e5a058b, `ImmutabilityHelper.
 * isGlobalClusterMutable` and `UpdateHandler.shouldRemoveFromGlobalCluster`;
 * read from the source, not measured for RDS):
 *
 * - REMOVAL, or `""`, updates in place: RemoveFromGlobalCluster, waiting
 *   until the cluster is out and `available`. Here a template removal is
 *   `detach` (`detachFromGlobalCluster`, which does nothing once the live
 *   cluster is no longer listed).
 * - ADD or CHANGE fails `NotUpdatable` ("Resource is immutable"). Whether
 *   CloudFormation then replaces the cluster is not measured for this
 *   property (DocDB's handler failed both, go-to-k/cdkd#5628 A/B), so cdkd
 *   refuses it before any write, the conservative side: a replacement
 *   destroys the database. One exception: a cluster the live global cluster
 *   already lists (a CDK `GlobalCluster` made with `SourceDBClusterIdentifier`
 *   holds it before the template names it) needs no change, so `none`.
 *
 * A STATE-BORNE bag (a rollback replay, `drift --revert`) changes no
 * membership, and its record follows what the restored bag declares only
 * where that cannot arm a later write the user never asked for:
 * - An add (a rollback of a forward removal asks to re-join) cannot be
 *   applied: it warns, and `keep` records the previous side.
 * - A removal (a rollback of a forward add, which cdkd only ever accepted for
 *   a cluster already a member) never detaches: a detach is irreversible.
 *   `none` records the restored bag, without the key, so re-deploying the
 *   restored template detaches nothing either. Recording the key instead
 *   would turn that re-deploy into a removal, and so into a detach.
 * - An unchanged one the live cluster does not show (a forward update that
 *   failed after its detach) is `drop`: the record loses the key, as the
 *   cluster did.
 * - A `drift --revert` readback never carries the key (a drift-unknown path),
 *   so its ABSENCE there is no change: `keep`, silently.
 */
export async function planGlobalClusterUpdate(
  this: RDSProvider,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  context: UpdateContext | undefined
): Promise<GlobalClusterUpdate> {
  const desired = properties['GlobalClusterIdentifier'];
  if (context?.desiredFromAwsReadback === true && desired === undefined) {
    return previousProperties['GlobalClusterIdentifier'] !== undefined
      ? { kind: 'keep' }
      : { kind: 'none' };
  }
  const mask = maskerOrIdentity(context?.maskSecrets);
  const stateBorne = context?.replayingState === true || context?.desiredFromAwsReadback === true;
  const readable = readableGlobalClusterId(desired);
  const desiredId = recordedGlobalClusterIdentifier(properties);
  const previousId = recordedGlobalClusterIdentifier(previousProperties);
  if (readable && desiredId === previousId) {
    if (!stateBorne || desiredId === undefined) return { kind: 'none' };
    const live = await liveGlobalClusterMembership.call(this, physicalId, desiredId);
    if (live.kind !== 'answered' || live.member) return { kind: 'none' };
    this.logger.warn(
      mask(
        safeMsg`${logicalId} (${resourceType}): the cluster is no longer a member of global cluster ${desiredId}, so the record drops GlobalClusterIdentifier.`
      )
    );
    return { kind: 'drop' };
  }
  if (readable && desiredId === undefined && previousId !== undefined) {
    if (!stateBorne) return { kind: 'detach', globalClusterId: previousId };
    const live = await liveGlobalClusterMembership.call(this, physicalId, previousId);
    if (live.kind !== 'answered' || live.member) {
      this.logger.warn(
        mask(
          safeMsg`${logicalId} (${resourceType}): the restored state has no GlobalClusterIdentifier; cdkd never detaches on a restore, so the cluster stays wherever it is${live.kind === 'answered' ? safeMsg` (a member of global cluster ${previousId})` : ''}. A destroy is refused while it is a member: detach it first with aws rds remove-from-global-cluster.`
        )
      );
    }
    return { kind: 'none' };
  }
  let unreadable = '';
  if (readable) {
    const live = await liveGlobalClusterMembership.call(this, physicalId, desiredId);
    if (live.kind === 'answered' && live.member) return { kind: 'none' };
    if (live.kind === 'unreadable') {
      unreadable = ` (cdkd could not read the cluster's global cluster membership: ${live.summary})`;
    }
  }
  if (!stateBorne) {
    throw markNonRetryable(
      new ProvisioningError(
        `${resourceType} ${logicalId}: ${readable ? GLOBAL_CLUSTER_CHANGE_REFUSED : 'GlobalClusterIdentifier must be a string'}${unreadable}`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  this.logger.warn(
    mask(
      readable
        ? safeMsg`${logicalId} (${resourceType}): the restored state names global cluster ${desiredId ?? ''}, but cdkd never adds an existing cluster to a global cluster, so it keeps its current membership.`
        : safeMsg`${logicalId} (${resourceType}): the restored GlobalClusterIdentifier is not a string; the cluster keeps its current membership.`
    )
  );
  return { kind: 'keep' };
}

/**
 * go-to-k/cdkd#5639: whether the live cluster's global cluster is
 * `desiredId` (`undefined`: none). Every global cluster is listed, as a
 * cluster can be in at most one. A failed read is `unreadable`, carrying
 * the failure's class, which callers keep apart from an answer: an add keeps
 * its refusal on either.
 */
export async function liveGlobalClusterMembership(
  this: RDSProvider,
  physicalId: string,
  desiredId: string | undefined
): Promise<{ kind: 'answered'; member: boolean } | { kind: 'unreadable'; summary: string }> {
  try {
    const arn = (await this.describeDBCluster(physicalId))?.DBClusterArn;
    if (typeof arn !== 'string' || arn === '') {
      return { kind: 'unreadable', summary: 'DescribeDBClusters reported no cluster ARN' };
    }
    let liveId: string | undefined;
    let marker: string | undefined;
    do {
      const page = await this.getClient().send(
        new DescribeGlobalClustersCommand({ ...(marker !== undefined && { Marker: marker }) })
      );
      const holder = (page.GlobalClusters ?? []).find((global) =>
        (global.GlobalClusterMembers ?? []).some((member) => member.DBClusterArn === arn)
      );
      if (holder !== undefined) {
        liveId = holder.GlobalClusterIdentifier;
        break;
      }
      marker = page.Marker;
    } while (marker);
    return { kind: 'answered', member: liveId === desiredId };
  } catch (error) {
    const failure = describeAwsFailure(error);
    this.logger.debug(
      safeMsg`Could not read an RDS cluster's global cluster membership: ${failure.summary}`
    );
    return { kind: 'unreadable', summary: failure.summary };
  }
}
