import { ModifyDBInstanceCommand } from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { protectedReplacementAdvice } from '../../replacement-protection-advice.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import { associatedRoleList } from '../db-associated-roles.js';
import { dbInstanceEngineChangeIsInPlace } from '../../../analyzer/replacement-rules.js';
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
  instanceModifyBackfillMembers,
  instanceParameterGroupPendingReboot,
  instanceParameterGroupApplying,
  desiredLogExports,
  logExportsDelta,
  logExportsApplied,
  instanceAvailabilityZoneKept,
  withPreviousAvailabilityZone,
} from './instance-members.js';

export async function updateDBInstance(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating DBInstance ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // go-to-k/cdkd#5640: likewise a malformed AssociatedRoles, on every path.
  const roles = this.desiredAssociatedRoles(properties, resourceType, logicalId, physicalId, false);
  // go-to-k/cdkd#5640: refused before any call when malformed; a removal
  // disables what the previous template declared, as CloudFormation does.
  const logExportConfig = logExportsDelta(
    desiredLogExports(properties, resourceType, logicalId, physicalId),
    previousProperties['EnableCloudwatchLogsExports']
  );
  // Outside the try: it throws only its own ProvisioningError, which names
  // the cause and must not be re-wrapped.
  const vpcSgIds = await this.securityGroupsToSend(
    'DBInstance',
    logicalId,
    physicalId,
    resourceType,
    properties,
    previousProperties,
    context
  );
  // go-to-k/cdkd#5640: likewise outside the try. A changed
  // EngineLifecycleSupport is refused before any change, as CloudFormation
  // refuses it.
  const engineLifecycleSupport = await this.engineLifecycleSupportToSend(
    'DB instance',
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

  try {
    // go-to-k/cdkd#5640: a zone ModifyDBInstance cannot apply is refused
    // before any change, as CloudFormation refuses the update. A rollback
    // replay hands over a STATE record the template cannot fix: it warns,
    // sends nothing for the zone either way, and records the zone the instance
    // kept (`effectiveProperties` below). A `drift --revert` bag IS the live
    // readback, so its zone is the one the instance already holds.
    //
    // The physical id is the template's DBInstanceIdentifier, which can be
    // secret-derived; after a rotation it is the PRE-rotation value this
    // deploy's masker never resolved, so it is paired with the recorded name
    // (go-to-k/cdkd#4339).
    const { mask: zoneMask } = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [[previousProperties['DBInstanceIdentifier'], physicalId]]
    );
    const desiredZone = properties['AvailabilityZone'];
    // A rollback replay restoring a record that declared no zone restores
    // exactly that: CloudFormation reverts to the old model, and recording
    // the forward zone would make the old template's next deploy read as a
    // zone REMOVAL, refused.
    let zoneKept =
      context?.desiredFromAwsReadback === true ||
      (context?.replayingState === true && (desiredZone == null || desiredZone === '')) ||
      instanceAvailabilityZoneKept(properties, previousProperties);
    // A record can lack the zone the instance sits in (deployed while
    // `--prefer-sdk-route` kept the property out of the record, or a rollback
    // that recorded none): the zone the template declares is then no change
    // when the live instance already holds it. An unreadable instance keeps
    // the refusal.
    // The live read has more answers than the zone: the instance is gone
    // (deleted outside cdkd), or the read failed (a throttle, a missing
    // grant). The refusal names either, so neither reads as "the instance
    // is elsewhere".
    // Assigned inside the callbacks, so declared wide (no narrowing to 'read').
    let liveZoneRead = 'read' as 'read' | 'not-found' | 'unreadable';
    if (!zoneKept && typeof desiredZone === 'string' && desiredZone !== '') {
      const liveZone = await this.describeDBInstance(physicalId).then(
        (instance) => {
          if (instance === undefined) liveZoneRead = 'not-found';
          return instance?.AvailabilityZone;
        },
        (err: unknown) => {
          liveZoneRead =
            (err as { name?: unknown } | null)?.name === 'DBInstanceNotFoundFault'
              ? 'not-found'
              : 'unreadable';
          this.logger.debug(
            zoneMask(
              safeMsg`DBInstance ${logicalId}: could not read the live zone: ${describeAwsFailure(err).summary}`
            )
          );
          return undefined;
        }
      );
      zoneKept = liveZone === desiredZone;
    }
    if (!zoneKept && context?.replayingState !== true) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        zoneMask(
          `AvailabilityZone cannot change on an existing DB instance — ModifyDBInstance has no ` +
            `such member, and CloudFormation refuses the same update ("Resource is immutable"). ` +
            `Nothing was applied to DB instance ${physicalId}. ` +
            (liveZoneRead === 'not-found'
              ? `RDS reports no such DB instance: it was deleted outside cdkd, so the state ` +
                `record no longer matches AWS. `
              : liveZoneRead === 'unreadable'
                ? `cdkd could not read the instance's live zone (an AWS read failed), so it ` +
                  `could not tell whether the instance already sits in the declared one; a ` +
                  `re-run may succeed. `
                : '') +
            `To keep the instance where it ` +
            `is, declare the zone the previous deploy declared (or none, if it declared none), ` +
            `or drop the zone and declare MultiAZ: true. The replace flags below apply to the ` +
            `WHOLE deploy: every other stateful resource in the same run whose in-place update ` +
            `is refused or that needs a replacement is recreated too, so run them with nothing ` +
            `else pending. To move it, ` +
            (String(previousProperties['DeletionProtection']) === 'true'
              ? protectedReplacementAdvice({
                  evidence: "cdkd's properties for this DB instance carry DeletionProtection: true",
                  replaceFlags: 'cdkd deploy --replace --force-stateful-recreation',
                  disable: {
                    before: 'aws rds modify-db-instance --db-instance-identifier',
                    identifier: physicalId,
                    after: '--no-deletion-protection --apply-immediately',
                    maskSecrets: zoneMask,
                  },
                })
              : 'note AWS::RDS::DBInstance is a stateful type: re-run with ' +
                'cdkd deploy --replace --force-stateful-recreation to recreate it in the new zone ' +
                '(this deletes the instance and its data)')
        )
      );
    }
    if (!zoneKept) {
      this.logger.warn(
        zoneMask(
          safeMsg`DBInstance ${logicalId} (${physicalId}): AvailabilityZone cannot change in place ` +
            safeMsg`(ModifyDBInstance has no such member), so the instance keeps its current zone ` +
            safeMsg`and cdkd records that zone.`
        )
      );
    }
    const effectiveProperties = zoneKept
      ? undefined
      : withPreviousAvailabilityZone(properties, previousProperties);
    // #609 backfill — 6 mutable sibling props matching DBCluster.
    // StorageEncrypted + MasterUsername are create-only per AWS RDS docs
    // and intentionally NOT forwarded here; a template change to either
    // would CFn-replace the instance, which cdkd's diff layer schedules
    // independently. Wire-format flips: CFn `Port` → SDK `DBPortNumber`
    // (different field name on the Modify shape — AWS uses `Port` on
    // Create and `DBPortNumber` on Modify), CFn `VPCSecurityGroups` →
    // SDK `VpcSecurityGroupIds`. `EngineVersion` and
    // `AllowMajorVersionUpgrade` go out only when changed
    // (`instanceModifyBackfillMembers`, go-to-k/cdkd#2762).
    // #609 — `MasterUserSecret` `{ KmsKeyId }` → scalar
    // `MasterUserSecretKmsKeyId` (same flip as create()).
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
    // go-to-k/cdkd#5640: a switch to password also carries the declared one.
    const instancePassword =
      masterUserPasswordToSend(properties, previousProperties, context) ??
      (passwordCompanion?.kind === 'password' ? passwordCompanion.password : undefined);
    // #1160 removal — ModifyDBInstance has merge semantics (an absent input
    // field means "no change"), so a property REMOVED from the template is
    // sent as its CFn reset value only where CloudFormation resets it, per
    // real A/Bs (#5004, #1160 comment 6401151077):
    //   * RESET: ManageMasterUserPassword (to false, `managedPasswordOnRemoval`).
    //     MaxAllocatedStorage (to the live allocated storage, which turns
    //     autoscaling off) is reset per the handler source, not an A/B
    //     (`instanceModifyBackfillMembers`, go-to-k/cdkd#2762).
    //   * KEPT (omitted = unchanged): DeletionProtection,
    //     EnableIAMDatabaseAuthentication, MonitoringInterval, EngineVersion,
    //     Port, PubliclyAccessible, AllocatedStorage, MonitoringRoleArn. The
    //     #2762 members are kept too, per the handler's `diff(previous,
    //     desired)`.
    // MasterUserSecret removed while the managed password stays on: the
    // credential gate re-sends ManageMasterUserPassword=true with no key.
    // CloudFormation sends neither, and the secret stays on its customer key
    // either way (#1160 comment 6484915102).
    // VPCSecurityGroups removed: CloudFormation sends the VPC's `default`
    // security group, alone and beside another change (#5542 A/B), so
    // `securityGroupsToSend` looks it up, as for a DB cluster.
    // DBInstanceClass is not required by the registry schema (no top-level
    // `required`), and a removal sends nothing: CloudFormation sends no class
    // either, and the update keeps the live one (same comment).
    const manageMasterUserPasswordOff = managedPasswordOnRemoval(properties, previousProperties);
    // go-to-k/cdkd#2762: the storage, backup, maintenance, Performance
    // Insights and other backfill members, AllocatedStorage and
    // EngineVersion, go out only when changed, as CloudFormation sends them.
    // AllocatedStorage used to be re-sent on every update, which RDS refuses
    // as a shrink once autoscaling (MaxAllocatedStorage) has grown the
    // instance past the template value; EngineVersion likewise, refused as
    // a downgrade once AWS had auto-upgraded the minor version.
    let liveInstance: Promise<number | undefined> | undefined;
    const backfillMembers = await instanceModifyBackfillMembers(
      properties,
      previousProperties,
      () =>
        (liveInstance ??= this.describeDBInstance(physicalId).then(
          (instance) => instance?.AllocatedStorage
        )),
      logicalId,
      context
    );
    // #5194: a cluster change in the same deploy can leave this member not
    // `available` for a moment; only that refusal is waited out and resent.
    await modifyDbInstanceWhenAvailable({
      send: () =>
        this.getClient().send(
          new ModifyDBInstanceCommand({
            DBInstanceIdentifier: physicalId,
            DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
            PubliclyAccessible: properties['PubliclyAccessible'] as boolean | undefined,
            ApplyImmediately: true,
            // AllocatedStorage is mutable on ModifyDBInstance (scale-up). AWS
            // rejects scale-down except in narrow cases; a changed value is
            // forwarded and AWS surfaces the rejection if any.
            ...backfillMembers,
            // Removal keeps the live value, as CFn does (#5004 A/B).
            DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
            // #5467: an Engine change CloudFormation's handler applies in place
            // (aurora to aurora-mysql, oracle-se / oracle-se1 to oracle-se2, an
            // Oracle CDB conversion) carries the new Engine, as the handler
            // sends `engine(diff(previous, desired))`. Any other change
            // replaces (`dbInstanceEngineChangeReplaces`).
            ...(previousProperties['Engine'] !== properties['Engine'] &&
              dbInstanceEngineChangeIsInPlace(
                previousProperties['Engine'],
                properties['Engine']
              ) && {
                Engine: properties['Engine'] as string,
              }),
            ...(properties['Port'] !== undefined && {
              DBPortNumber: Number(properties['Port']),
            }),
            // #5153: only a changed password; any supplied one resets credentials.
            ...(instancePassword !== undefined && { MasterUserPassword: instancePassword }),
            ...(vpcSgIds !== undefined && { VpcSecurityGroupIds: vpcSgIds }),
            // #609 security-cluster backfill — 5 mutable via ModifyDBInstance.
            // `KmsKeyId` is intentionally NOT forwarded here (storage-encryption
            // key is immutable post-create; a template change replaces the
            // instance, which cdkd's diff layer schedules independently — same
            // treatment as StorageEncrypted / MasterUsername above).
            // go-to-k/cdkd#5640: also when a switch to password turns the
            // managed secret on (`passwordAuthenticationCompanion`).
            ...((sendCredentialSettings || passwordCompanion?.kind === 'managed') &&
              masterUserSecret?.KmsKeyId !== undefined && {
                MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
              }),
            ...(sendManagedPasswordSetting &&
              properties['ManageMasterUserPassword'] !== undefined && {
                ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
              }),
            ...(manageMasterUserPasswordOff && { ManageMasterUserPassword: false }),
            ...(properties['MonitoringRoleArn'] !== undefined && {
              MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
            }),
            // Removal keeps the live interval, as CFn does (#5004 A/B).
            ...(properties['MonitoringInterval'] != null && {
              MonitoringInterval: Number(properties['MonitoringInterval']),
            }),
            // Removal keeps the live value, as CFn does (#5004 A/B).
            EnableIAMDatabaseAuthentication: properties['EnableIAMDatabaseAuthentication'] as
              | boolean
              | undefined,
            ...(logExportConfig !== undefined && {
              CloudwatchLogsExportConfiguration: logExportConfig,
            }),
            // go-to-k/cdkd#5640: only a drift revert sends it; only a change
            // sends the authentication type, beside the credential settings.
            ...(engineLifecycleSupport !== undefined && {
              EngineLifecycleSupport: engineLifecycleSupport,
            }),
            ...(authenticationType !== undefined && {
              MasterUserAuthenticationType: authenticationType,
            }),
          })
        ),
      readStatus: async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label: 'RDS DBInstance',
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });

    this.logger.debug(`Successfully updated DBInstance ${logicalId}`);

    // go-to-k/cdkd#5640: CloudFormation reports the update once no change is
    // pending; a later read of the old list would also be a phantom drift.
    if (process.env['CDKD_NO_WAIT'] !== 'true' && logExportConfig !== undefined) {
      await this.waitForInstanceState(
        logicalId,
        physicalId,
        (instance) =>
          logExportsApplied(
            logExportConfig,
            instance.EnabledCloudwatchLogsExports,
            instance.PendingModifiedValues?.PendingCloudwatchLogsExports
          ),
        'CloudWatch Logs exports change'
      );
    }

    // Describe to get updated attributes
    let described = await this.describeDBInstance(physicalId);
    // go-to-k/cdkd#2762: CloudFormation reboots after an update that leaves
    // the parameter group `pending-reboot`, which a changed group always
    // does; a group this update did not change but that already read
    // `pending-reboot` (a static parameter edited in it) is rebooted too, as
    // the handler checks on every update; one still `applying` that edit is
    // waited out first, as the handler's stabilization does.
    const sentGroup = backfillMembers.DBParameterGroupName;
    if (
      sentGroup !== undefined ||
      instanceParameterGroupPendingReboot(described) ||
      instanceParameterGroupApplying(described)
    ) {
      described = await this.rebootForPendingParameterGroup(
        logicalId,
        physicalId,
        sentGroup,
        String(properties['CertificateRotationRestart']) === 'true'
      );
    }

    // go-to-k/cdkd#5640: after the ModifyDBInstance and its reboot, as
    // CloudFormation's update handler changes them. A malformed record only
    // misses detaches: the plan reads what is live.
    await this.applyAssociatedRoles(
      'instance',
      logicalId,
      physicalId,
      roles,
      associatedRoleList(previousProperties['AssociatedRoles'], {
        featureNameRequired: true,
      }) ?? [],
      context?.maskSecrets,
      context
    );

    // Apply tag diff using the instance ARN.
    if (described?.DBInstanceArn) {
      await this.applyTagDiff(
        described.DBInstanceArn,
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
        'Endpoint.Address': described?.Endpoint?.Address,
        'Endpoint.Port': stringifyIfAssigned(described?.Endpoint?.Port),
        Arn: described?.DBInstanceArn,
      }),
      ...(effectiveProperties !== undefined && { effectiveProperties }),
    };
  } catch (error) {
    // go-to-k/cdkd#5640: the typed zone refusal reaches the deploy engine's
    // `--replace` fallback unwrapped.
    if (error instanceof ResourceUpdateNotSupportedError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update DBInstance ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
