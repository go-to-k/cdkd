import { isDeepStrictEqual } from 'node:util';
import {
  RDSClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClustersCommand,
  EnableHttpEndpointCommand,
  DisableHttpEndpointCommand,
  DescribeGlobalClustersCommand,
  RemoveFromGlobalClusterCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
  RebootDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBSubnetGroupCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  AddRoleToDBClusterCommand,
  RemoveRoleFromDBClusterCommand,
  AddRoleToDBInstanceCommand,
  RemoveRoleFromDBInstanceCommand,
  type CloudwatchLogsExportConfiguration,
  type DBCluster,
  type DBInstance,
  type PendingCloudwatchLogsExports,
  type MasterUserAuthenticationType,
  type ModifyDBClusterCommandInput,
  type CreateDBClusterCommandInput,
  type ModifyDBInstanceCommandInput,
  type CreateDBInstanceCommandInput,
} from '@aws-sdk/client-rds';
import { DescribeSecurityGroupsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { enclosingDeadlineRemainingMs } from '../../deployment/resource-deadline.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  withDerivedNameMasks,
} from '../masked-retry-logger.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { markDeleteStarted, type DeleteProgress } from '../delete-started.js';
import { markNotGone } from '../not-gone.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../created-resource-sink.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  ResourceNotFound,
  UpdateContext,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { clearOnUpdateRemoval, withRemovalDefaults } from '../update-removal.js';
import { definedAttributes, stringifyIfAssigned } from '../attribute-map.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { slowCcOperationTimeoutMs } from '../slow-cc-operation-timeouts.js';
import {
  pasteableAwsCommand,
  protectedReplacementAdvice,
} from '../replacement-protection-advice.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
  deleteAfterProtectionFlipWithFinalSnapshot,
  isTerminalDbWaitStatus,
} from './deletion-protection-compensation.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from './db-instance-modify-retry.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import {
  associatedRoleArns,
  associatedRoleKey,
  associatedRoleList,
  associatedRolesNamed,
  associatedRolesReadback,
  canonicalAssociatedRoles,
  isRoleCallNotAvailableRefusal,
  planAssociatedRoleChanges,
  type AssociatedRole,
  type LiveAssociatedRole,
} from './db-associated-roles.js';
import { dbInstanceEngineChangeIsInPlace } from '../../analyzer/replacement-rules.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../deployment/secret-redaction.js';

/**
 * go-to-k/cdkd#5153: whether an update changes top-level `key`, as
 * CloudFormation decides it. The deploy's in-place update answers from
 * `changedProperties`, which compares the templates as written: the record
 * holds a secret as its `{{resolve:...}}` token or `***`, never the plaintext
 * the desired bag holds. A changed reference and a `NoEcho` value count as
 * changed there; a secret rotated under a reference the template spells
 * literally does not, as in CloudFormation (one built by `Fn::Join` counts a
 * newer read version). These types are deliberately NOT in
 * `CHANGED_PROPERTIES_CONSUMER_TYPES`: RDS never returns the password on a
 * Describe, so the readback that opt-in buys could not confirm it.
 *
 * Without that set the two bags are compared. A rollback revert hands both
 * re-resolved, so an equal value is unchanged. Under `drift --revert` both
 * sides are AWS readbacks (the desired one with the drifted keys overlaid),
 * which never hold the password, so it is not sent. A recorded
 * `{{resolve:` token or whole `***` mask is never read as equal. Compared in
 * memory only; no value is logged.
 */
function propertyChangedForUpdate(
  key: string,
  desired: unknown,
  recorded: unknown,
  context: UpdateContext | undefined
): boolean {
  const changedProperties = context?.changedProperties;
  if (changedProperties !== undefined) return changedProperties.has(key);
  return holdsRecordedStandIn(recorded) || !isDeepStrictEqual(desired, recorded);
}

/** A recorded leaf standing in for a secret: a dynamic reference, or the whole mask. */
function holdsRecordedStandIn(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === SECRET_MASK || dynamicReferenceTokens(value).length > 0;
  }
  if (Array.isArray(value)) return value.some(holdsRecordedStandIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(holdsRecordedStandIn);
  }
  return false;
}

/**
 * go-to-k/cdkd#5153: the `MasterUserPassword` a `ModifyDBCluster` /
 * `ModifyDBInstance` carries, or `undefined` to leave the live password alone.
 * RDS treats ANY supplied password as a master-credential reset, so it is sent
 * only when the template changed it, as CloudFormation does. A removed
 * password sends nothing.
 */
function masterUserPasswordToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): string | undefined {
  const desired = properties['MasterUserPassword'];
  if (desired === undefined || desired === null) return undefined;
  return propertyChangedForUpdate(
    'MasterUserPassword',
    desired,
    previousProperties['MasterUserPassword'],
    context
  )
    ? (desired as string)
    : undefined;
}

/**
 * go-to-k/cdkd#5153: whether `ManageMasterUserPassword` / `MasterUserSecret`
 * ride the Modify* call. They are sent, as before, when any of the three
 * master-credential properties changed: turning the managed password off
 * needs the (newly declared) `MasterUserPassword` beside it, and a KMS key is
 * accepted only while turning management on. Nothing changed sends neither,
 * as CloudFormation sends nothing for unchanged properties; otherwise a
 * declared `ManageMasterUserPassword: false` would travel alone once the
 * unchanged password is left out.
 */
function masterCredentialSettingsChanged(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean {
  return (
    propertyChangedForUpdate(
      'MasterUserPassword',
      properties['MasterUserPassword'],
      previousProperties['MasterUserPassword'],
      context
    ) ||
    propertyChangedForUpdate(
      'ManageMasterUserPassword',
      properties['ManageMasterUserPassword'],
      previousProperties['ManageMasterUserPassword'],
      context
    ) ||
    propertyChangedForUpdate(
      'MasterUserSecret',
      properties['MasterUserSecret'],
      previousProperties['MasterUserSecret'],
      context
    )
  );
}

/**
 * go-to-k/cdkd#5639 / #5640: whether `ManageMasterUserPassword` rides the
 * Modify* call: a master-credential change (`masterCredentialSettingsChanged`)
 * or a `MasterUserAuthenticationType` the call sends, which RDS refuses unless the
 * same call sets the managed password (below). The `MasterUserSecret` KMS
 * key rides a type change only when it switches to `password` with the managed
 * password declared, the call that turns it on
 * (`passwordAuthenticationCompanion`): RDS takes a key only then, so
 * re-sending it on a resource already managed would be refused.
 *
 * RDS refuses `iam-db-auth` beside a managed password unless the same
 * call turns it off (`ManageMasterUserPassword: false`), and refuses
 * `password` unless the same call carries a password or turns the managed one
 * on (measured with ModifyDBCluster / ModifyDBInstance, us-east-1, 2026-11-04).
 * CloudFormation's DBCluster handler sends `ManageMasterUserPassword` on every
 * update, so a switch declaring the managed password succeeds there too.
 */
function managedPasswordSettingRides(
  credentialSettingsChanged: boolean,
  authenticationType: MasterUserAuthenticationType | undefined
): boolean {
  // `authenticationType` is what the call SENDS: a rollback replay that drops
  // the type (no password declared) passes `undefined`, so no lone
  // `ManageMasterUserPassword` goes out, which RDS refuses.
  return credentialSettingsChanged || authenticationType !== undefined;
}

/**
 * go-to-k/cdkd#5639 / #5640: what a ModifyDBCluster / ModifyDBInstance that
 * switches `MasterUserAuthenticationType` to `password` must carry beside it.
 * RDS refuses `password` unless the same call carries a master password or
 * turns the managed password on ("You must specify a master password ...",
 * measured us-east-1, 2026-11-04), whichever direction the switch takes (a
 * rollback replay of a forward `password` -> `iam-db-auth` included).
 *
 * - `managed`: the template declares `ManageMasterUserPassword: true`, which
 *   rides the call (`managedPasswordSettingRides`). That call creates the
 *   managed secret, so the declared `MasterUserSecret` KMS key rides it too,
 *   or the secret would land on `aws/secretsmanager` unnoticed.
 * - `password`: the declared `MasterUserPassword` rides the call, even when
 *   unchanged. Never logged.
 * - `missing`: neither is declared; the caller refuses before any call. This
 *   includes an explicit ADD of the default `password` (the record lacks the
 *   type), e.g. on a snapshot-restored cluster: whether RDS accepts a type
 *   equal to the live one without a password is unmeasured, so cdkd refuses
 *   rather than guess. A
 *   rollback replay instead drops the type (with a warning) and reverts the
 *   other members, since RDS would reject the whole call.
 * - `undefined`: the call does not switch to `password`.
 */
function passwordAuthenticationCompanion(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  authenticationType: MasterUserAuthenticationType | undefined
): { kind: 'managed' } | { kind: 'password'; password: string } | { kind: 'missing' } | undefined {
  if (authenticationType !== 'password') return undefined;
  if (String(properties['ManageMasterUserPassword']) === 'true') {
    // Only a switch FROM another recorded type turns the managed secret on. An
    // added `password` (the record lacks the type) on a resource already
    // managed must not re-send the key, which RDS refuses there.
    const previous = previousProperties['MasterUserAuthenticationType'];
    return previous != null && previous !== '' && previous !== 'password'
      ? { kind: 'managed' }
      : undefined;
  }
  // An added `password` on a literal-password resource re-sends the unchanged
  // declared password once; RDS needs it beside the type either way.
  const password = properties['MasterUserPassword'];
  return typeof password === 'string' && password !== ''
    ? { kind: 'password', password }
    : { kind: 'missing' };
}

/** The refusal text of a switch to `password` with no password (`passwordAuthenticationCompanion`). */
function passwordAuthenticationMissingText(resourceType: string, logicalId: string): string {
  return (
    `${resourceType} ${logicalId}: MasterUserAuthenticationType changes to password, which RDS ` +
    `accepts only beside a master password or the managed one in the same call, and the ` +
    `template declares neither MasterUserPassword nor ManageMasterUserPassword: true. ` +
    `Nothing was applied. Declare one of them.`
  );
}

/**
 * go-to-k/cdkd#5639 / #5640: the `MasterUserAuthenticationType` a
 * ModifyDBCluster / ModifyDBInstance carries: the declared value when the
 * template changed it, else `undefined`. A removal sends nothing and RDS keeps
 * the live type. Measured against CloudFormation (us-east-1, 2026-11-04,
 * CloudTrail): both handlers send a changed value and nothing for a removal.
 * The property is write-only in the registry schema and absent from the
 * Describe shapes, so no readback can confirm it.
 */
function masterUserAuthenticationTypeToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): MasterUserAuthenticationType | undefined {
  return instanceValueChanged(
    properties,
    previousProperties,
    'MasterUserAuthenticationType',
    context
  )
    ? (properties['MasterUserAuthenticationType'] as MasterUserAuthenticationType)
    : undefined;
}

/**
 * Issue #1160: whether a removed `ManageMasterUserPassword` goes out as
 * `false`. The previous template declared `true` and the desired one declares
 * nothing. A real CloudFormation A/B (#1160 comment 6401151077) showed
 * CloudFormation sends `false` there on both DBCluster and DBInstance: with a
 * `MasterUserPassword` added in the same update the managed password is turned
 * off, and without one RDS refuses the update. Leaving it unsent instead kept
 * the managed password on without a word.
 */
function managedPasswordOnRemoval(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean {
  const previous = previousProperties['ManageMasterUserPassword'];
  return (
    properties['ManageMasterUserPassword'] === undefined &&
    (previous === true || previous === 'true')
  );
}

/**
 * Issue #1160: the port CloudFormation sends for a removed DBCluster `Port`,
 * per engine. Aurora was measured to reset (#1160 comment 6401151077). On a
 * Multi-AZ DB cluster (`mysql` / `postgres`) CloudFormation sends 3306 for
 * either engine, its handler's fallback default, and RDS refuses the update
 * ("You can't modify the port for a Multi-AZ DB cluster"), so the stack update
 * fails (measured on `postgres`, #1160 comment 6484915102). cdkd
 * sends the same port, so the removal fails the same way instead of keeping
 * the old port without a word.
 */
const CLUSTER_REMOVED_PORT: ReadonlyMap<string, number> = new Map([
  ['aurora-postgresql', 5432],
  ['aurora-mysql', 3306],
  ['mysql', 3306],
  ['postgres', 3306],
]);

/** A template number (CFn numbers may arrive as strings), or `undefined` when absent. */
function numberOrUndefined(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

/** The ModifyDBInstance members that change the storage itself. */
const STORAGE_MEMBERS: ReadonlySet<string> = new Set([
  'AllocatedStorage',
  'Iops',
  'StorageType',
  'StorageThroughput',
]);

/**
 * go-to-k/cdkd#2762: CloudFormation's `AWS::RDS::DBInstance` handler builds
 * ModifyDBInstance from `diff(previous, desired)`, which is the desired value
 * when the two differ and nothing otherwise. A removed property is therefore
 * never sent and RDS keeps the live value. `changedProperties`, when the caller
 * supplies it, decides, since the record holds a value from a dynamic reference
 * or a `NoEcho` parameter as its token or `***`, never the resolved desired
 * value. Otherwise the scalar is compared through its string form, since a
 * CFn number may arrive as a string on either side; a recorded stand-in never
 * equals the resolved value, so it counts as changed.
 */
function instanceValueChanged(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  key: string,
  context: UpdateContext | undefined
): boolean {
  const desired = properties[key];
  if (desired == null) return false;
  const previous = previousProperties[key];
  if (previous == null) return true;
  const differs =
    typeof desired === 'object' || typeof previous === 'object'
      ? !isDeepStrictEqual(desired, previous)
      : String(desired as string | number | boolean) !==
        String(previous as string | number | boolean);
  // A storage member recorded as the same plain value is never re-sent, even
  // when the engine forces an update that names every key (a `reput`,
  // go-to-k/cdkd#4411): RDS refuses an AllocatedStorage below an autoscaled
  // size, and any storage change starts a storage optimization that blocks
  // the next one for hours. A recorded stand-in equals only a desired stand-in,
  // which is never sent either.
  if (STORAGE_MEMBERS.has(key) && !differs) return false;
  if (context?.changedProperties !== undefined) return context.changedProperties.has(key);
  return differs;
}

/** A storage size in GiB, or 0 when absent or unreadable (a recorded stand-in). */
function sizeOrZero(value: unknown): number {
  const size = Number(value);
  return value != null && Number.isFinite(size) ? size : 0;
}

/**
 * The storage types whose ModifyDBInstance carries `AllocatedStorage` and
 * `Iops` together, as CloudFormation's handler sends them (`io1`, `io2`,
 * `gp3`, or an undeclared type beside a declared `Iops`, which RDS reads as
 * `io1`).
 */
function isProvisionedIoStorage(properties: Record<string, unknown>): boolean {
  const storageType = properties['StorageType'];
  if (typeof storageType === 'string' && storageType !== '') {
    return ['io1', 'io2', 'gp3'].includes(storageType.toLowerCase());
  }
  return properties['Iops'] != null;
}

/**
 * go-to-k/cdkd#2762: the ModifyDBInstance members for the storage, backup,
 * maintenance, parameter group, option group, certificate, Performance Insights, network type,
 * license model, promotion tier, Database Insights and dedicated log volume
 * properties, plus `AllocatedStorage` and `EngineVersion`. Each follows the
 * handler's update translation (the archived
 * `aws-cloudformation-resource-providers-rds` `Translator.
 * modifyDbInstanceRequest` and `UpdateHandler`):
 *
 * - Each is sent only when the template changed it; a removal sends nothing,
 *   so RDS keeps the live value, as CloudFormation does. The handler sends
 *   `PromotionTier` and `AllowMajorVersionUpgrade` on every update; cdkd only
 *   on a change (and the flag beside a changed `EngineVersion`), the rest
 *   being no-ops.
 * - `CertificateRotationRestart` goes out only beside a changed
 *   `CACertificateIdentifier`, as the handler sends it.
 * - A removed `MaxAllocatedStorage` turns storage autoscaling off, the one
 *   reset: the handler sends the live `AllocatedStorage` as the maximum
 *   (`unsetMaxAllocatedStorage`), the documented way to turn it off. cdkd
 *   sends the declared size instead when this update raises it past the live
 *   one, which the handler does not.
 * - On provisioned-IOPS storage `AllocatedStorage` and `Iops` travel together:
 *   a changed `AllocatedStorage`, `Iops`, `StorageThroughput` or `StorageType`
 *   sends the declared `Iops`, and the changed `AllocatedStorage` or else the
 *   larger of the live and declared one, so an autoscaled instance is never
 *   asked to shrink. The handler sends that pair on every update of such
 *   storage; cdkd only on a storage change, the rest being no-ops.
 * - A rollback replay (`replayingState`) takes the handler's rollback arm for
 *   the storage size, never sending a smaller one, and sends no
 *   `EngineVersion`, nor a `DBParameterGroupName` reverted beside it.
 * - A changed `DBParameterGroupName` is applied by `updateDBInstance`'s
 *   post-update reboot (`rebootForPendingParameterGroup`).
 * - `EnablePerformanceInsights`, `PerformanceInsightsKMSKeyId` and
 *   `PerformanceInsightsRetentionPeriod` are coupled: a changed flag or key
 *   sends both changes, an enabled flag sends the declared key, a changed key
 *   sends the declared flag, and a changed retention sends the declared flag
 *   and key beside it.
 *
 * `liveAllocatedStorage` reads the instance; it is called only when a member
 * needs it.
 */
async function instanceModifyBackfillMembers(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  liveAllocatedStorage: () => Promise<number | undefined>,
  logicalId: string,
  context: UpdateContext | undefined
): Promise<Partial<ModifyDBInstanceCommandInput>> {
  const changed = (key: string): boolean =>
    instanceValueChanged(properties, previousProperties, key, context);
  const desiredAllocated = numberOrUndefined(properties['AllocatedStorage']);
  const members: Partial<ModifyDBInstanceCommandInput> = {};

  if (changed('BackupRetentionPeriod')) {
    members.BackupRetentionPeriod = Number(properties['BackupRetentionPeriod']);
  }
  for (const key of [
    'PreferredBackupWindow',
    'PreferredMaintenanceWindow',
    'StorageType',
    'OptionGroupName',
    'CACertificateIdentifier',
  ] as const) {
    if (changed(key)) members[key] = properties[key] as string;
  }
  for (const key of ['NetworkType', 'LicenseModel'] as const) {
    if (changed(key)) members[key] = properties[key] as string;
  }
  if (changed('DatabaseInsightsMode')) {
    members.DatabaseInsightsMode = properties[
      'DatabaseInsightsMode'
    ] as ModifyDBInstanceCommandInput['DatabaseInsightsMode'];
  }
  for (const key of [
    'MultiAZ',
    'AutoMinorVersionUpgrade',
    'CopyTagsToSnapshot',
    'DedicatedLogVolume',
  ] as const) {
    if (changed(key)) members[key] = properties[key] as boolean;
  }
  if (changed('StorageThroughput')) {
    members.StorageThroughput = Number(properties['StorageThroughput']);
  }
  if (changed('PromotionTier')) members.PromotionTier = Number(properties['PromotionTier']);
  // The handler sends `CertificateRotationRestart` only beside a changed
  // `CACertificateIdentifier`: the flag is not persistent, it only says how
  // that rotation restarts the instance.
  if (changed('CACertificateIdentifier') && properties['CertificateRotationRestart'] != null) {
    members.CertificateRotationRestart = properties['CertificateRotationRestart'] as boolean;
  }

  if (changed('MaxAllocatedStorage')) {
    members.MaxAllocatedStorage = Number(properties['MaxAllocatedStorage']);
  } else if (
    properties['MaxAllocatedStorage'] == null &&
    previousProperties['MaxAllocatedStorage'] != null
  ) {
    const live = await liveAllocatedStorage();
    if (live === undefined) {
      throw new Error(
        safeMsg`DBInstance ${logicalId}: MaxAllocatedStorage was removed from the template, which turns storage autoscaling off by setting it to the allocated storage, but DescribeDBInstances did not report the allocated storage`
      );
    }
    // Never below a storage size this same update raises it to: RDS refuses a
    // maximum under the allocated storage.
    members.MaxAllocatedStorage = Math.max(live, sizeOrZero(desiredAllocated));
  }

  // A rollback replay (`replayingState`) mirrors the handler's rollback arm:
  // storage cannot shrink, so off provisioned-IOPS storage it sends neither
  // AllocatedStorage nor Iops, and on it the largest of the live, previous and
  // declared sizes.
  const rollback = context?.replayingState === true;
  // `EngineVersion` goes out only when changed, never on a rollback replay
  // (the handler's rollback arm omits it: RDS refuses an engine downgrade).
  // Re-sending an unchanged one was refused as a downgrade once AWS had
  // auto-upgraded the minor version (`AutoMinorVersionUpgrade` defaults on).
  // `AllowMajorVersionUpgrade` is the template's own value, as the handler
  // sends it: beside a changed version, or when the flag itself changed. An
  // undeclared flag sends nothing, so RDS refuses a major upgrade, as it does
  // under CloudFormation.
  if (changed('EngineVersion') && !rollback) {
    members.EngineVersion = String(properties['EngineVersion'] as string | number);
  }
  // `DBParameterGroupName` goes out only when changed, as the handler sends
  // `diff(previous, desired)`. On a rollback replay that also reverts
  // `EngineVersion` it is left out with the version: across a major version
  // the previous group belongs to the previous engine family, which RDS
  // refuses on the version the instance still runs. (The handler instead
  // checks the group's family against the reverted version, which always
  // matches, and sends it.) A minor-version revert keeps the new group too,
  // where the handler would restore the old one: no engine-neutral rule tells
  // a family change from the version strings alone (MySQL 8.0 to 8.4 is one).
  if (changed('DBParameterGroupName') && !(rollback && changed('EngineVersion'))) {
    members.DBParameterGroupName = properties['DBParameterGroupName'] as string;
  }
  if (
    changed('AllowMajorVersionUpgrade') ||
    (members.EngineVersion !== undefined && properties['AllowMajorVersionUpgrade'] != null)
  ) {
    members.AllowMajorVersionUpgrade = properties['AllowMajorVersionUpgrade'] as boolean;
  }
  if (changed('AllocatedStorage') && !rollback) members.AllocatedStorage = desiredAllocated;
  if (isProvisionedIoStorage(properties)) {
    if (
      changed('AllocatedStorage') ||
      changed('Iops') ||
      changed('StorageThroughput') ||
      changed('StorageType')
    ) {
      if (members.AllocatedStorage === undefined) {
        const live = await liveAllocatedStorage();
        const larger = Math.max(
          sizeOrZero(live),
          sizeOrZero(desiredAllocated),
          rollback ? sizeOrZero(previousProperties['AllocatedStorage']) : 0
        );
        if (larger > 0) members.AllocatedStorage = larger;
      }
      if (properties['Iops'] != null) members.Iops = Number(properties['Iops']);
    }
  } else if (changed('Iops') && !rollback) {
    members.Iops = Number(properties['Iops']);
  }

  const enableChanged = changed('EnablePerformanceInsights');
  const keyChanged = changed('PerformanceInsightsKMSKeyId');
  const enableDesired = properties['EnablePerformanceInsights'] as boolean | undefined;
  const keyDesired = properties['PerformanceInsightsKMSKeyId'] as string | undefined;
  if (enableChanged || keyChanged) {
    members.EnablePerformanceInsights = enableDesired;
    if (keyChanged || String(enableDesired) === 'true') {
      members.PerformanceInsightsKMSKeyId = keyDesired;
    }
  }
  if (changed('PerformanceInsightsRetentionPeriod')) {
    members.PerformanceInsightsRetentionPeriod = Number(
      properties['PerformanceInsightsRetentionPeriod']
    );
    members.EnablePerformanceInsights = enableDesired;
    members.PerformanceInsightsKMSKeyId = keyDesired;
  }

  return Object.fromEntries(
    Object.entries(members).filter(([, value]) => value !== undefined)
  ) as Partial<ModifyDBInstanceCommandInput>;
}

/**
 * go-to-k/cdkd#2762: whether a DB instance holds a parameter group that only a
 * reboot applies, the condition CloudFormation's update handler reboots on
 * (`UpdateHandler.shouldReboot`, with `ApplyImmediately`, which cdkd always
 * sends).
 */
function instanceParameterGroupPendingReboot(instance: DBInstance | undefined): boolean {
  return (instance?.DBParameterGroups ?? []).some(
    (group) => group.ParameterApplyStatus === 'pending-reboot'
  );
}

/**
 * go-to-k/cdkd#2762: whether a DB instance is still applying a parameter
 * group, so a reboot it may need cannot be told yet.
 */
function instanceParameterGroupApplying(instance: DBInstance | undefined): boolean {
  return (instance?.DBParameterGroups ?? []).some(
    (group) => group.ParameterApplyStatus === 'applying'
  );
}

/**
 * go-to-k/cdkd#2762: whether a ModifyDBInstance applied immediately still has
 * a change pending, CloudFormation's `isNoPendingChanges` negated (plus its
 * `isCaCertificateChangesApplied`: a pending CA certificate counts only when
 * `CertificateRotationRestart` is true). Right after the call RDS can still
 * read `available` with the change only listed here, and a reboot then is
 * refused or races the modification.
 */
function instanceHasPendingChanges(instance: DBInstance, caRotationRestarts: boolean): boolean {
  const pending = instance.PendingModifiedValues;
  if (pending === undefined) return false;
  return (
    pending.DBInstanceClass !== undefined ||
    pending.AllocatedStorage !== undefined ||
    pending.AutomationMode !== undefined ||
    pending.BackupRetentionPeriod !== undefined ||
    pending.DBInstanceIdentifier !== undefined ||
    pending.DBSubnetGroupName !== undefined ||
    pending.Engine !== undefined ||
    pending.EngineVersion !== undefined ||
    pending.IAMDatabaseAuthenticationEnabled !== undefined ||
    pending.Iops !== undefined ||
    pending.LicenseModel !== undefined ||
    pending.MasterUserPassword !== undefined ||
    pending.MultiAZ !== undefined ||
    pending.PendingCloudwatchLogsExports !== undefined ||
    pending.Port !== undefined ||
    (pending.ProcessorFeatures ?? []).length > 0 ||
    pending.ResumeFullAutomationModeTime !== undefined ||
    pending.StorageThroughput !== undefined ||
    pending.StorageType !== undefined ||
    (caRotationRestarts && pending.CACertificateIdentifier !== undefined)
  );
}

/**
 * go-to-k/cdkd#2762: whether a ModifyDBInstance has settled enough to tell if
 * it left a reboot pending, as CloudFormation's post-modify stabilization asks
 * (`isStabilizedWithChangesAppliedImmediately`, the members a reboot needs):
 * the instance is `available`, no parameter group is `applying`, and no
 * change is pending. A group this update sent must also be the one listed
 * (RDS stores the name lower-cased), so a read taken before RDS started the
 * change does not count; an instance listing no group at all has nothing to
 * wait for.
 */
function instanceParameterGroupSettled(
  instance: DBInstance,
  sentGroup: string | undefined,
  caRotationRestarts: boolean
): boolean {
  if (instance.DBInstanceStatus !== 'available') return false;
  if (instanceHasPendingChanges(instance, caRotationRestarts)) return false;
  const groups = instance.DBParameterGroups ?? [];
  if (groups.some((group) => group.ParameterApplyStatus === 'applying')) return false;
  if (sentGroup === undefined || groups.length === 0) return true;
  return groups.some(
    (group) => group.DBParameterGroupName?.toLowerCase() === sentGroup.toLowerCase()
  );
}

/**
 * go-to-k/cdkd#2762: whether a reboot has applied the instance's groups, as
 * CloudFormation's `isDBInstanceStabilizedAfterReboot` asks: `available`,
 * every parameter group and option group `in-sync`.
 */
function instanceRebootApplied(instance: DBInstance): boolean {
  return (
    instance.DBInstanceStatus === 'available' &&
    (instance.DBParameterGroups ?? []).every((group) => group.ParameterApplyStatus === 'in-sync') &&
    (instance.OptionGroupMemberships ?? []).every((group) => group.Status === 'in-sync')
  );
}

/**
 * go-to-k/cdkd#5639 / #5640: a DBCluster or DBInstance
 * `EnableCloudwatchLogsExports`, read off a desired or recorded bag:
 * `undefined` when absent, the log types without repeats, or `'malformed'`
 * for anything but a list of strings.
 */
function logExportsList(value: unknown): string[] | undefined | 'malformed' {
  if (value == null) return undefined;
  if (!Array.isArray(value) || !value.every((type) => typeof type === 'string')) {
    return 'malformed';
  }
  return [...new Set(value as string[])];
}

/**
 * go-to-k/cdkd#5639 / #5640: the desired `EnableCloudwatchLogsExports`, or a
 * non-retryable refusal before any call. Read as empty, a malformed list would
 * DISABLE every log type the record holds. It is refused on a rollback replay
 * too: RDS rejects anything but a list of log types, so the replay could not
 * have applied it either.
 */
function desiredLogExports(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): string[] | undefined {
  const desired = logExportsList(properties['EnableCloudwatchLogsExports']);
  if (desired !== 'malformed') return desired;
  throw markNonRetryable(
    new ProvisioningError(
      `${resourceType} ${logicalId}: EnableCloudwatchLogsExports must be a list of log type names`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * go-to-k/cdkd#5639 / #5640: the ModifyDBCluster / ModifyDBInstance
 * `CloudwatchLogsExportConfiguration` for an update, as CloudFormation's
 * handlers build it (the `aws-cloudformation-resource-providers-rds`
 * `Translator.cloudwatchLogsExportConfiguration` for a cluster,
 * `Translator.buildTranslateCloudwatchLogsExportConfiguration` for an
 * instance): the log types the template now declares and the previous one did
 * not are enabled, the ones it declared before and no longer does are
 * disabled. A REMOVED property therefore disables every log type the previous
 * template declared; one enabled outside the template is left alone. A
 * reorder is no change (`undefined`, nothing sent), as the instance handler
 * sends nothing for an empty delta.
 *
 * A malformed RECORDED list (never written by this provider) is read as
 * empty: the update then only enables, missing disables, never disabling a
 * log type the template still declares.
 */
function logExportsDelta(
  desired: readonly string[] | undefined,
  previousValue: unknown
): CloudwatchLogsExportConfiguration | undefined {
  const previous = logExportsList(previousValue);
  const had = previous === undefined || previous === 'malformed' ? [] : previous;
  const want = desired ?? [];
  const enable = want.filter((type) => !had.includes(type));
  const disable = had.filter((type) => !want.includes(type));
  if (enable.length === 0 && disable.length === 0) return undefined;
  return {
    ...(enable.length > 0 && { EnableLogTypes: enable }),
    ...(disable.length > 0 && { DisableLogTypes: disable }),
  };
}

/**
 * go-to-k/cdkd#5639 / #5640: the log types a cluster or instance exports once
 * its pending change applies. Right after ModifyDB* the change can still be
 * listed only in `PendingModifiedValues`, and the observed baseline captured
 * then must not record the old list.
 */
function liveLogExports(
  enabled: readonly string[] | undefined,
  pending: PendingCloudwatchLogsExports | undefined
): string[] {
  const disabled = pending?.LogTypesToDisable ?? [];
  const out = (enabled ?? []).filter((type) => !disabled.includes(type));
  for (const type of pending?.LogTypesToEnable ?? []) {
    if (!out.includes(type)) out.push(type);
  }
  return out;
}

/**
 * go-to-k/cdkd#5639 / #5640: whether a cluster or instance has applied a
 * `CloudwatchLogsExportConfiguration`: nothing pending, every enabled type
 * listed and no disabled one, as CloudFormation's stabilization waits for no
 * pending change.
 */
function logExportsApplied(
  config: CloudwatchLogsExportConfiguration,
  enabled: readonly string[] | undefined,
  pending: PendingCloudwatchLogsExports | undefined
): boolean {
  if ((pending?.LogTypesToEnable?.length ?? 0) > 0) return false;
  if ((pending?.LogTypesToDisable?.length ?? 0) > 0) return false;
  const live = enabled ?? [];
  return (
    (config.EnableLogTypes ?? []).every((type) => live.includes(type)) &&
    !(config.DisableLogTypes ?? []).some((type) => live.includes(type))
  );
}

/**
 * go-to-k/cdkd#5640: whether a DBInstance update may leave its
 * `AvailabilityZone` where it is. ModifyDBInstance has no such member, and
 * CloudFormation's update handler refuses the update ("Resource is
 * immutable", `ImmutabilityHelper.isAvailabilityZoneChangeMutable`) unless
 * the zone is unchanged, or the template drops it while declaring
 * `MultiAZ: true` (the zone is then RDS's to choose). The property is not
 * create-only in the registry schema, so the engine never replaces for it.
 */
function instanceAvailabilityZoneKept(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean {
  const desired = properties['AvailabilityZone'];
  if (desired === previousProperties['AvailabilityZone']) return true;
  return (desired == null || desired === '') && String(properties['MultiAZ']) === 'true';
}

/**
 * go-to-k/cdkd#5640: the desired bag with the zone the instance KEPT: the
 * previous side's, or no key when that side declared none. A copy.
 */
function withPreviousAvailabilityZone(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Record<string, unknown> {
  const { AvailabilityZone: _desired, ...rest } = properties;
  const previous = previousProperties['AvailabilityZone'];
  return previous === undefined ? rest : { ...rest, AvailabilityZone: previous };
}

/** An `EngineLifecycleSupport` read off a bag: `undefined` when absent or empty. */
function engineLifecycleSupportOf(bag: Record<string, unknown>): string | undefined {
  const value = bag['EngineLifecycleSupport'];
  return value == null || value === '' ? undefined : String(value as string);
}

/**
 * go-to-k/cdkd#5639 / #5640: what an update does with `EngineLifecycleSupport`
 * on a DB cluster or DB instance. CloudFormation's update handlers refuse any
 * difference between the previous and desired template values, a change, an
 * addition and a removal alike ("EngineLifecycleSupport cannot be modified.",
 * measured on both types, us-east-1, 2026-11-04), outside a rollback, and
 * their ModifyDBCluster / ModifyDBInstance never carry it. So:
 *
 * - `'unchanged'`: the two sides agree, or a rollback replay (CloudFormation's
 *   rollback skips the check and sends nothing): nothing is sent.
 * - `'send'`: `cdkd drift --revert` restoring the recorded live value, which
 *   ModifyDB* takes; CloudFormation has no revert to compare with.
 * - `'check-live'`: a declared value differing from the record. It is no
 *   change when the live resource already holds it (a record that lacks or
 *   predates it, or a value set with the AWS CLI), as for a DB instance's
 *   `AvailabilityZone`; otherwise refused, as CloudFormation refuses it.
 * - `'refuse'`: a removal, which CloudFormation refuses too.
 */
function engineLifecycleSupportAction(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): 'unchanged' | 'send' | 'check-live' | 'refuse' {
  const desired = engineLifecycleSupportOf(properties);
  if (desired === engineLifecycleSupportOf(previousProperties)) return 'unchanged';
  if (context?.replayingState === true) return 'unchanged';
  if (context?.desiredFromAwsReadback === true) return desired === undefined ? 'unchanged' : 'send';
  return desired === undefined ? 'refuse' : 'check-live';
}

/**
 * The refusal text of a changed `EngineLifecycleSupport`
 * (`engineLifecycleSupportAction`), unmasked: the caller masks it.
 */
function engineLifecycleSupportRefusalText(
  resourceType: string,
  logicalId: string,
  physicalId: string,
  kind: 'DB cluster' | 'DB instance',
  liveRead: 'read' | 'unreadable' | 'not-found'
): string {
  const cli = kind === 'DB cluster' ? 'aws rds modify-db-cluster' : 'aws rds modify-db-instance';
  return (
    `${resourceType} ${logicalId}: EngineLifecycleSupport cannot change on an existing ${kind}. ` +
    `CloudFormation refuses the same update ("EngineLifecycleSupport cannot be modified."), ` +
    `whether the value changes, is added or is removed. Nothing was applied to ${kind} ${physicalId}. ` +
    (liveRead === 'unreadable'
      ? `cdkd could not read the live setting (an AWS read failed), so it could not tell ` +
        `whether the ${kind} already holds the declared value; a re-run may succeed. `
      : liveRead === 'not-found'
        ? `RDS reports no such ${kind}: it was deleted outside cdkd, so the state record no ` +
          `longer matches AWS. `
        : '') +
    `Declare the value the previous deploy declared (or none, if it declared none). To change ` +
    `the live setting, run ${cli} with --engine-lifecycle-support and --apply-immediately, then ` +
    `declare that value: a declared value the ${kind} already holds is no change.`
  );
}

/**
 * go-to-k/cdkd#5639: how long a `--remove-protection` flip waits, across its
 * retries, for a busy DB cluster or DB instance to accept it.
 */
const PROTECTION_FLIP_RETRY_WAIT_MS = 10 * 60_000;

/**
 * go-to-k/cdkd#5639: whether `error` is RDS refusing a ModifyDBCluster because
 * the cluster is busy: "This cluster could not be modified. Please try again"
 * (`InvalidDBClusterStateFault`, read us-east-1, 2026-11-04, while a member
 * that had just joined was still taking the cluster's settings), or the
 * not-`available` wording. Read off the RAW SDK error.
 */
function isClusterBusyRefusal(error: unknown): boolean {
  if (isModifyNotAvailableRefusal(error)) return true;
  return (
    error instanceof Error &&
    error.name === 'InvalidDBClusterStateFault' &&
    /could not be modified\. Please try again/i.test(error.message)
  );
}

/** The template's `AWS::RDS::DBCluster` `ServerlessV2ScalingConfiguration`. */
interface ServerlessV2ScalingProps {
  MinCapacity?: number;
  MaxCapacity?: number;
  SecondsUntilAutoPause?: number;
}

/**
 * The `ServerlessV2ScalingConfiguration` CreateDBCluster / ModifyDBCluster
 * input: every declared member, `SecondsUntilAutoPause` included, as
 * CloudFormation's handler translates the block (issue #5466). A removed
 * `SecondsUntilAutoPause` is simply absent: measured against CloudFormation
 * (us-east-1, 2026-10-28), the block without it resets the live delay to
 * AWS's 300-second default, and this block yields the same.
 */
function serverlessV2ScalingToSend(config: ServerlessV2ScalingProps): {
  MinCapacity?: number | undefined;
  MaxCapacity?: number | undefined;
  SecondsUntilAutoPause?: number | undefined;
} {
  const seconds = numberOrUndefined(config.SecondsUntilAutoPause);
  return {
    MinCapacity: config.MinCapacity,
    MaxCapacity: config.MaxCapacity,
    ...(seconds !== undefined && { SecondsUntilAutoPause: seconds }),
  };
}

/**
 * go-to-k/cdkd#2762: the `AWS::RDS::DBCluster` string members that ride
 * CreateDBCluster and ModifyDBCluster under their CFn names. With
 * `CopyTagsToSnapshot` (a boolean) they are the cluster backfill.
 */
const CLUSTER_BACKFILL_STRING_MEMBERS = [
  'DBClusterParameterGroupName',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'StorageType',
] as const;

/** The cluster backfill members, typed as both CreateDBCluster and ModifyDBCluster name them. */
type ClusterBackfillMembers = Pick<
  ModifyDBClusterCommandInput,
  (typeof CLUSTER_BACKFILL_STRING_MEMBERS)[number] | 'CopyTagsToSnapshot'
>;

/** The cluster backfill members CreateDBCluster sends: each one the template declares. */
function clusterCreateBackfillMembers(properties: Record<string, unknown>): ClusterBackfillMembers {
  const members: ClusterBackfillMembers = {};
  for (const key of CLUSTER_BACKFILL_STRING_MEMBERS) {
    if (properties[key] != null) members[key] = properties[key] as string;
  }
  if (properties['CopyTagsToSnapshot'] != null) {
    members.CopyTagsToSnapshot = properties['CopyTagsToSnapshot'] as boolean;
  }
  return members;
}

/**
 * go-to-k/cdkd#2762: the ModifyDBCluster members for `DBClusterParameterGroupName`,
 * `PreferredBackupWindow`, `PreferredMaintenanceWindow`, `CopyTagsToSnapshot`
 * and `StorageType`, each sent only when the template changed it
 * (`instanceValueChanged`, so a recorded stand-in compares through
 * `changedProperties`, and an unchanged `StorageType` is never re-sent).
 *
 * A removal sends nothing and RDS keeps the live value, as CloudFormation
 * does: measured against CloudFormation (us-east-1, 2026-11-01, an Aurora
 * PostgreSQL Serverless v2 cluster with no instance), removing the parameter
 * group, the backup window, `CopyTagsToSnapshot` true and `StorageType`
 * `aurora-iopt1` in one update kept all four, read five minutes later. The
 * handler source agrees: its update translation (the
 * archived `aws-cloudformation-resource-providers-rds` `Translator.
 * modifyDbClusterRequest`) sends the two windows as `diff(previous, desired)`
 * and the other three as the desired value, which is `null` (unsent) for a
 * removed key, and `ModelAdapter.setDefaults` fills none of the five (it
 * fills `BackupRetentionPeriod` and `Port`, the measured resets).
 * CloudFormation re-sends an unchanged parameter group, flag or storage type
 * on every update; cdkd does not, those being no-ops. The handler does not
 * reboot member instances after a parameter group change, and neither does
 * cdkd.
 */
function clusterModifyBackfillMembers(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): ClusterBackfillMembers {
  const changed = (key: string): boolean =>
    instanceValueChanged(properties, previousProperties, key, context);
  const members: ClusterBackfillMembers = {};
  for (const key of CLUSTER_BACKFILL_STRING_MEMBERS) {
    if (changed(key)) members[key] = properties[key] as string;
  }
  if (changed('CopyTagsToSnapshot')) {
    members.CopyTagsToSnapshot = properties['CopyTagsToSnapshot'] as boolean;
  }
  return members;
}

/**
 * go-to-k/cdkd#5639: the `AWS::RDS::DBCluster` scalars that ride
 * CreateDBCluster and ModifyDBCluster, as the SDK names them. Two are renamed:
 * CFn `PerformanceInsightsEnabled` is `EnablePerformanceInsights` and CFn
 * `PerformanceInsightsKmsKeyId` is `PerformanceInsightsKMSKeyId`.
 */
type ClusterScalarMembers = Pick<
  ModifyDBClusterCommandInput,
  | 'AutoMinorVersionUpgrade'
  | 'NetworkType'
  | 'EnablePerformanceInsights'
  | 'PerformanceInsightsKMSKeyId'
  | 'PerformanceInsightsRetentionPeriod'
  | 'DatabaseInsightsMode'
  | 'EngineLifecycleSupport'
  | 'MasterUserAuthenticationType'
  | 'BacktrackWindow'
  | 'EnableLocalWriteForwarding'
>;

/** go-to-k/cdkd#5639: the CFn name of each Performance Insights member, with its SDK name. */
const CLUSTER_PERFORMANCE_INSIGHTS_MEMBERS = [
  ['PerformanceInsightsEnabled', 'EnablePerformanceInsights'],
  ['PerformanceInsightsKmsKeyId', 'PerformanceInsightsKMSKeyId'],
  ['PerformanceInsightsRetentionPeriod', 'PerformanceInsightsRetentionPeriod'],
] as const;

/** The declared Performance Insights members, under their SDK names. */
function clusterPerformanceInsightsMembers(
  properties: Record<string, unknown>
): ClusterScalarMembers {
  const members: ClusterScalarMembers = {};
  if (properties['PerformanceInsightsEnabled'] != null) {
    members.EnablePerformanceInsights = properties['PerformanceInsightsEnabled'] as boolean;
  }
  if (properties['PerformanceInsightsKmsKeyId'] != null) {
    members.PerformanceInsightsKMSKeyId = properties['PerformanceInsightsKmsKeyId'] as string;
  }
  // A malformed one is refused or skipped before any call (`retentionPeriodValue`).
  const retention = retentionPeriodValue(properties['PerformanceInsightsRetentionPeriod']);
  if (typeof retention === 'number') members.PerformanceInsightsRetentionPeriod = retention;
  return members;
}

/**
 * go-to-k/cdkd#5639: the scalars CreateDBCluster sends, each one the template
 * declares, as CloudFormation's create translation (`Translator.
 * createDbClusterRequest`) sends each declared value. `EnableHttpEndpoint`
 * rides CreateDBCluster under its own name beside these.
 */
function clusterCreateScalarMembers(properties: Record<string, unknown>): ClusterScalarMembers {
  return {
    ...(properties['AutoMinorVersionUpgrade'] != null && {
      AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean,
    }),
    ...(properties['NetworkType'] != null && {
      NetworkType: properties['NetworkType'] as string,
    }),
    ...clusterPerformanceInsightsMembers(properties),
    ...(properties['DatabaseInsightsMode'] != null && {
      DatabaseInsightsMode: properties[
        'DatabaseInsightsMode'
      ] as ClusterScalarMembers['DatabaseInsightsMode'],
    }),
    ...(engineLifecycleSupportOf(properties) !== undefined && {
      EngineLifecycleSupport: engineLifecycleSupportOf(properties),
    }),
    ...(properties['MasterUserAuthenticationType'] != null && {
      MasterUserAuthenticationType: properties[
        'MasterUserAuthenticationType'
      ] as ClusterScalarMembers['MasterUserAuthenticationType'],
    }),
    // A malformed one is refused or skipped before any call.
    ...(typeof backtrackWindowValue(properties['BacktrackWindow']) === 'number' && {
      BacktrackWindow: backtrackWindowValue(properties['BacktrackWindow']) as number,
    }),
    ...(typeof localWriteForwardingFlag(properties['EnableLocalWriteForwarding']) === 'boolean' && {
      EnableLocalWriteForwarding: localWriteForwardingFlag(
        properties['EnableLocalWriteForwarding']
      ) as boolean,
    }),
  };
}

/**
 * go-to-k/cdkd#5639: the ModifyDBCluster scalars for an update.
 * `AutoMinorVersionUpgrade` and `NetworkType` go out only when changed
 * (`instanceValueChanged`). The three Performance Insights members are
 * coupled: a change to any one sends every declared one, as CloudFormation's
 * update translation (`Translator.modifyDbClusterRequest`) sends all three
 * desired values on every update, and RDS reads the retention period and key
 * against the flag beside them.
 *
 * A removal sends nothing and RDS keeps the live value: the handler sends the
 * desired value, `null` (unsent) for a removed key, and
 * `ModelAdapter.setDefaults` fills none of these.
 *
 * `DatabaseInsightsMode` likewise goes out only when changed, with the declared
 * Performance Insights members beside it (`advanced` needs them on with a
 * 465-day retention). Measured against CloudFormation (us-east-1, 2026-11-04,
 * CloudTrail): a changed mode is sent with the trio, and a removed `advanced`
 * sends no mode and stays `advanced`.
 *
 * `BacktrackWindow` goes out only when changed, and a removal keeps the live
 * window: the handler sends the desired value, unsent when removed (read from
 * the archived `aws-cloudformation-resource-providers-rds` source, not
 * measured). `EnableLocalWriteForwarding` follows the handler's own rule
 * (`localWriteForwardingToSend`).
 *
 * `EngineLifecycleSupport` and
 * `MasterUserAuthenticationType` are not here: `engineLifecycleSupportAction`
 * and `masterUserAuthenticationTypeToSend` decide them.
 */
function clusterModifyScalarMembers(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): ClusterScalarMembers {
  const changed = (key: string): boolean =>
    instanceValueChanged(properties, previousProperties, key, context);
  const members: ClusterScalarMembers = {};
  if (changed('AutoMinorVersionUpgrade')) {
    members.AutoMinorVersionUpgrade = properties['AutoMinorVersionUpgrade'] as boolean;
  }
  if (changed('NetworkType')) members.NetworkType = properties['NetworkType'] as string;
  // `DatabaseInsightsMode` `advanced` needs Performance Insights on with a
  // 465-day retention, so a changed mode sends the declared trio beside it.
  const insightsModeChanged = changed('DatabaseInsightsMode');
  if (insightsModeChanged || CLUSTER_PERFORMANCE_INSIGHTS_MEMBERS.some(([key]) => changed(key))) {
    Object.assign(members, clusterPerformanceInsightsMembers(properties));
  }
  if (insightsModeChanged) {
    members.DatabaseInsightsMode = properties[
      'DatabaseInsightsMode'
    ] as ClusterScalarMembers['DatabaseInsightsMode'];
  }
  // A malformed one is refused or skipped before any call.
  const backtrackWindow = backtrackWindowValue(properties['BacktrackWindow']);
  if (typeof backtrackWindow === 'number' && changed('BacktrackWindow')) {
    members.BacktrackWindow = backtrackWindow;
  }
  const localWriteForwarding = localWriteForwardingToSend(properties, previousProperties, context);
  if (typeof localWriteForwarding === 'boolean') {
    members.EnableLocalWriteForwarding = localWriteForwarding;
  }
  return members;
}

/**
 * go-to-k/cdkd#5639: a DBCluster `BacktrackWindow` read off a bag, in seconds:
 * `undefined` when absent, the whole number (a number or its numeric-string
 * spelling), or `'malformed'`. The 0-259200 range is AWS's to enforce.
 */
function backtrackWindowValue(value: unknown): number | undefined | 'malformed' {
  return retentionPeriodValue(value);
}

/**
 * go-to-k/cdkd#5639: a DBCluster `EnableLocalWriteForwarding` read off a bag,
 * as {@link httpEndpointFlag} reads the Data API flag.
 */
function localWriteForwardingFlag(value: unknown): boolean | undefined | 'malformed' {
  return httpEndpointFlag(value);
}

/**
 * go-to-k/cdkd#5639: the `EnableLocalWriteForwarding` an update sends, as
 * CloudFormation's update translation (`Translator.modifyDbClusterRequest`)
 * decides it: a removed `true` sends `false`, because RDS keeps write
 * forwarding on until told otherwise; a `false` declared where the previous
 * template declared nothing sends nothing, since forwarding is off by default;
 * otherwise only a changed value goes out (`instanceValueChanged`). Any other
 * removal sends nothing. A malformed desired value is refused or skipped
 * before this runs; a malformed previous one reads as absent.
 *
 * A drift revert turns forwarding ON only when the record's template side
 * declares `EnableLocalWriteForwarding: true`
 * (`UpdateContext.declaredTrueProperties`), as `clusterHttpEndpointAction`
 * does for the Data API: the revert's desired bag is the recorded readback,
 * which can hold `true` for a template that never declared it. Otherwise it is
 * `'withheld'`; turning forwarding off still goes through.
 */
function localWriteForwardingToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean | 'withheld' | undefined {
  const desired = localWriteForwardingFlag(properties['EnableLocalWriteForwarding']);
  const previousFlag = localWriteForwardingFlag(previousProperties['EnableLocalWriteForwarding']);
  const previous = typeof previousFlag === 'boolean' ? previousFlag : undefined;
  if (desired === undefined) return previous === true ? false : undefined;
  if (desired === 'malformed') return undefined;
  if (previous === undefined && desired === false) return undefined;
  if (
    !instanceValueChanged(properties, previousProperties, 'EnableLocalWriteForwarding', context)
  ) {
    return undefined;
  }
  return desired &&
    context?.desiredFromAwsReadback === true &&
    context.declaredTrueProperties?.has('EnableLocalWriteForwarding') !== true
    ? 'withheld'
    : desired;
}

/**
 * go-to-k/cdkd#5639: whether a cluster's local write forwarding has reached
 * `enabled`. CloudFormation's stabilization
 * (`BaseHandlerStd.isLocalWriteForwardingStabilized`) waits while the status
 * is `enabling` or `disabling`, and its read handler projects `requested` and
 * `enabled` as on (`Translator.translateLocalWriteForwardingStatus`). The
 * status is matched against the value sent, not only "not in transition", so a
 * describe answering before the change starts does not end the wait.
 */
function localWriteForwardingApplied(cluster: DBCluster, enabled: boolean): boolean {
  const status = cluster.LocalWriteForwardingStatus;
  // Never reported: nothing to wait on, as CloudFormation's check waits only
  // while the status is `enabling` / `disabling`.
  if (status === undefined) return true;
  if (status === 'enabling' || status === 'disabling') return false;
  return (status === 'requested' || status === 'enabled') === enabled;
}

/**
 * go-to-k/cdkd#5639: a DBCluster `EnableHttpEndpoint` read off a bag:
 * `undefined` when absent, the flag, or `'malformed'` for anything but a
 * boolean or its CFn string spelling.
 */
function httpEndpointFlag(value: unknown): boolean | undefined | 'malformed' {
  if (value == null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return 'malformed';
}

/** go-to-k/cdkd#5639: the DBCluster booleans of the #5639 slice, as CFn names them. */
const CLUSTER_BOOLEAN_SCALARS = [
  'AutoMinorVersionUpgrade',
  'PerformanceInsightsEnabled',
  'EnableHttpEndpoint',
  'EnableLocalWriteForwarding',
] as const;

/**
 * go-to-k/cdkd#5639: a DBCluster `PerformanceInsightsRetentionPeriod` read off
 * a bag: `undefined` when absent, the whole number of days (a number or its
 * numeric-string spelling), or `'malformed'`.
 */
function retentionPeriodValue(value: unknown): number | undefined | 'malformed' {
  if (value == null) return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 'malformed';
}

/**
 * go-to-k/cdkd#5639: the RDS Data API call an update makes for
 * `EnableHttpEndpoint`, as CloudFormation's update handler decides it
 * (`BaseHandlerStd.shouldUpdateHttpEndpointV2`): only on an `aurora-mysql` or
 * `aurora-postgresql` cluster, only when the declared value differs from the
 * previous one (an absent side differs from `false`), and then
 * `EnableHttpEndpoint` when the template now declares `true`, otherwise
 * `DisableHttpEndpoint`. A REMOVED `true` therefore turns the Data API off.
 * ModifyDBCluster's own `EnableHttpEndpoint` member applies only to an
 * Aurora Serverless v1 cluster (`EngineMode: serverless`), which the SDK route
 * never creates (`EngineMode` is not handled, so such a template is
 * provisioned through Cloud Control).
 *
 * A malformed desired value is refused before any call on a template update,
 * on every engine as create refuses it:
 * read as "not true" it would turn the Data API off. On a rollback replay or a
 * drift revert it is skipped with a warning instead (`'skip'`). A malformed
 * PREVIOUS value is read as absent.
 *
 * A drift revert turns the Data API ON only when the record's template side
 * declares `EnableHttpEndpoint: true` (`UpdateContext.declaredTrueProperties`,
 * go-to-k/cdkd#5707). Otherwise it is `'withheld'`: the revert's desired bag is
 * the recorded `observedProperties` baseline, which records the readback, so
 * it can hold `true` for a template that never declared it. The revert warns
 * and leaves the setting as it is; turning it off still goes through.
 */
function clusterHttpEndpointAction(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string,
  context: UpdateContext | undefined
): 'enable' | 'disable' | 'skip' | 'withheld' | undefined {
  const desired = httpEndpointFlag(properties['EnableHttpEndpoint']);
  if (desired === 'malformed') {
    if (context?.replayingState === true || context?.desiredFromAwsReadback === true) {
      return 'skip';
    }
    throw markNonRetryable(
      new ProvisioningError(
        `${resourceType} ${logicalId}: EnableHttpEndpoint must be true or false`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  // Checked on every engine, as create checks it.
  const engine = properties['Engine'];
  if (typeof engine !== 'string') return undefined;
  if (!['aurora-mysql', 'aurora-postgresql'].includes(engine.toLowerCase())) return undefined;
  const recorded = httpEndpointFlag(previousProperties['EnableHttpEndpoint']);
  const previous = recorded === 'malformed' ? undefined : recorded;
  if (desired === previous) return undefined;
  if (desired !== true) return 'disable';
  // A drift revert's desired bag is a recorded readback, not the template: a
  // baseline captured while the Data API was on outside the template would
  // otherwise turn it back ON. A revert turns it on only when the template
  // declares it (go-to-k/cdkd#5707), and otherwise leaves it ('withheld').
  return context?.desiredFromAwsReadback === true &&
    context.declaredTrueProperties?.has('EnableHttpEndpoint') !== true
    ? 'withheld'
    : 'enable';
}

/**
 * go-to-k/cdkd#5639: the desired bag with each SKIPPED key the cluster KEPT,
 * when an update skipped a malformed value: the previous side's value when
 * `usable` accepts it, or no key. A copy.
 */
function withPreviousValues(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  skipped: ReadonlyArray<readonly [key: string, usable: (value: unknown) => boolean]>
): Record<string, unknown> {
  const out = { ...properties };
  for (const [key, usable] of skipped) {
    delete out[key];
    const previous = previousProperties[key];
    if (previous != null && usable(previous)) out[key] = previous;
  }
  return out;
}

const usableHttpEndpoint = (value: unknown): boolean =>
  typeof httpEndpointFlag(value) === 'boolean';
const usableRetentionPeriod = (value: unknown): boolean =>
  typeof retentionPeriodValue(value) === 'number';
const usableBacktrackWindow = (value: unknown): boolean =>
  typeof backtrackWindowValue(value) === 'number';
const usableLocalWriteForwarding = (value: unknown): boolean =>
  typeof localWriteForwardingFlag(value) === 'boolean';

/**
 * go-to-k/cdkd#2762: whether this cluster update changes `EngineVersion`, the
 * condition CloudFormation's handler sends `EngineVersion` and
 * `AllowMajorVersionUpgrade: true` under (`Translator.modifyDbClusterRequest`:
 * desired differs from previous, outside a rollback). Compared as the backfill
 * members are (`instanceValueChanged`), so a recorded stand-in defers to
 * `changedProperties`. A rollback replay never counts: the handler's rollback
 * arm sends neither, since RDS refuses an engine downgrade.
 */
function clusterEngineVersionChanged(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean {
  if (context?.replayingState === true) return false;
  return instanceValueChanged(properties, previousProperties, 'EngineVersion', context);
}

/** Issue #1160: the member statuses a cluster change moves an instance through. */
const SECURITY_GROUP_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying']);
const PORT_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying', 'rebooting']);

/** The ModifyDBCluster `Port`: the declared one, or the engine default on removal. */
function clusterPortToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): number | undefined {
  if (properties['Port'] != null) return Number(properties['Port']);
  if (previousProperties['Port'] == null) return undefined;
  const engine = properties['Engine'] ?? previousProperties['Engine'];
  const reset =
    typeof engine === 'string' ? CLUSTER_REMOVED_PORT.get(engine.toLowerCase()) : undefined;
  // Already the reset value: send nothing (an equal Multi-AZ port is unmeasured).
  return reset === Number(previousProperties['Port']) ? undefined : reset;
}

/**
 * How long a cluster or instance delete waits for the resource to be gone:
 * the Cloud Control route's own DELETE floor for these types, which a Cloud
 * Control-routed delete now reaches through this provider (issue #3993).
 */
const RDS_DELETE_WAIT_MS = Math.max(
  1_800_000,
  slowCcOperationTimeoutMs('AWS::RDS::DBCluster', 'DELETE'),
  slowCcOperationTimeoutMs('AWS::RDS::DBInstance', 'DELETE')
);

/**
 * The recorded `DeleteAutomatedBackups` as a `DeleteDBCluster` /
 * `DeleteDBInstance` input member (issue #3993), as CloudFormation's delete
 * handler sends the template value. A Cloud Control-routed cluster or
 * instance is deleted through this provider, so a template keeping automated
 * backups with `false` keeps them. Only a boolean or its CFn string spelling
 * is sent; anything else leaves AWS's default (delete them).
 */
function deleteAutomatedBackupsInput(properties: Record<string, unknown> | undefined): {
  DeleteAutomatedBackups?: boolean;
} {
  const value = properties?.['DeleteAutomatedBackups'];
  if (value === true || value === 'true') return { DeleteAutomatedBackups: true };
  if (value === false || value === 'false') return { DeleteAutomatedBackups: false };
  return {};
}

/**
 * The recorded `GlobalClusterIdentifier` of a cluster, when it names one
 * (issue #4029). Only a non-blank string does; anything else means the record
 * does not show the cluster in a global cluster.
 */
function recordedGlobalClusterIdentifier(
  properties: Record<string, unknown> | undefined
): string | undefined {
  const value = properties?.['GlobalClusterIdentifier'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * go-to-k/cdkd#5639: the faults a Data API call is refused with while the
 * cluster is busy (`InvalidResourceStateFault` is the one the
 * EnableHttpEndpoint / DisableHttpEndpoint models declare), retried by
 * `sendHttpEndpointChange` up to `HTTP_ENDPOINT_MAX_ATTEMPTS` sends.
 */
const HTTP_ENDPOINT_BUSY_FAULTS: ReadonlySet<string> = new Set([
  'InvalidResourceStateFault',
  'InvalidDBClusterStateFault',
]);
const HTTP_ENDPOINT_MAX_ATTEMPTS = 8;

/**
 * Faults a detach waits through rather than failing on: the cluster or the
 * global cluster is busy (`backing-up`, `modifying`), or the call was
 * throttled past the SDK's own retries (issue #4029).
 */
const TRANSIENT_DETACH_FAULTS: ReadonlySet<string> = new Set([
  'InvalidDBClusterStateFault',
  'InvalidGlobalClusterStateFault',
  'ThrottlingException',
  'Throttling',
  'RequestLimitExceeded',
]);

/**
 * A DB cluster or DB instance identifier: a letter, then letters, digits and
 * single hyphens, not ending in one, at most 63 characters. Either case, as a
 * template may spell it (RDS lower-cases it).
 */
function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

function awsErrorName(error: unknown): string {
  return (error as { name?: string } | undefined)?.name ?? '';
}

/**
 * A failure DETACHING a cluster from its global cluster (issue #4029). Its own
 * class so `deleteDBClusterOnce`'s catch rethrows it before the not-found
 * check: an AWS message about the GLOBAL cluster or the membership can read
 * "not found", and that arm would report the live cluster deleted.
 */
class GlobalClusterDetachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalClusterDetachError';
  }
}

/**
 * AWS RDS Provider
 *
 * Implements resource provisioning for RDS resources:
 * - AWS::RDS::DBSubnetGroup
 * - AWS::RDS::DBCluster
 * - AWS::RDS::DBInstance
 *
 * WHY: RDS SDK calls are direct and avoid CC API polling overhead.
 * However, DBCluster and DBInstance creation can take time, so we
 * poll with DescribeDB* until available.
 */
export class RDSProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private createClient?: RDSClient;
  private ec2Client?: EC2Client;
  private readonly providerRegion: string | undefined;
  private logger = getLogger().child('RDSProvider');
  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * Issue #1160: the CFn default a property REMOVED from the template is
   * reset to — the Modify/Update API keeps an absent field's live value.
   *
   * Empty for RDS: real CloudFormation A/Bs (issue #5004, #1160 comment
   * 6401151077) showed CFn KEEPS most removed DBCluster / DBInstance values,
   * so cdkd sends nothing for them (omission is "unchanged" on
   * ModifyDBCluster / ModifyDBInstance). The resets it does make are coerced,
   * engine-dependent or conditional, so they stay in `updateDBCluster` /
   * `updateDBInstance`.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBSubnetGroup',
      new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
    [
      'AWS::RDS::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'Engine',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'DatabaseName',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'DeletionProtection',
        'ServerlessV2ScalingConfiguration',
        'Tags',
        // #609 security-cluster backfill (managed master-password secret +
        // Enhanced Monitoring + IAM database auth + publicly-accessible).
        // 5 of the 6 ride CreateDBCluster AND ModifyDBCluster (mutable). Wire-
        // format flips: CFn `MasterUserSecret` (an object whose only create-
        // relevant member is `{ KmsKeyId }`) → SDK scalar
        // `MasterUserSecretKmsKeyId` (the create/modify shapes take the key id
        // directly — the SDK `MasterUserSecret` *type* is the read-side Describe
        // shape). `MonitoringInterval` arrives as a numeric STRING ("60"); coerce
        // via Number() at the wire boundary. `ManageMasterUserPassword` is
        // mutually exclusive with `MasterUserPassword` (AWS validates).
        // `PubliclyAccessible` IS a valid CreateDBClusterMessage field (Multi-AZ
        // DB clusters) but is ABSENT from ModifyDBClusterMessage — wired create-
        // only here (a template change replaces the cluster), distinct from
        // DBInstance's same-named mutable prop.
        'ManageMasterUserPassword',
        'MasterUserSecret',
        'MonitoringRoleArn',
        'MonitoringInterval',
        'EnableIAMDatabaseAuthentication',
        'PubliclyAccessible',
        // go-to-k/cdkd#2762: the parameter group, backup and maintenance
        // windows, snapshot tag copying and storage type. Each rides
        // CreateDBCluster and, when changed, ModifyDBCluster under the same
        // name (`clusterModifyBackfillMembers`).
        'DBClusterParameterGroupName',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'CopyTagsToSnapshot',
        'StorageType',
        // go-to-k/cdkd#5639: the list on CreateDBCluster, the
        // `CloudwatchLogsExportConfiguration` delta on ModifyDBCluster
        // (`logExportsDelta`).
        'EnableCloudwatchLogsExports',
        // go-to-k/cdkd#5639: ride CreateDBCluster and, when changed,
        // ModifyDBCluster (`clusterModifyScalarMembers`; the Performance
        // Insights trio is renamed on the wire). `EnableHttpEndpoint` rides
        // CreateDBCluster, and an update turns the Data API on or off with
        // EnableHttpEndpoint / DisableHttpEndpoint (`clusterHttpEndpointAction`).
        'AutoMinorVersionUpgrade',
        'NetworkType',
        'PerformanceInsightsEnabled',
        'PerformanceInsightsKmsKeyId',
        'PerformanceInsightsRetentionPeriod',
        'EnableHttpEndpoint',
        // go-to-k/cdkd#5639: ride CreateDBCluster and, when changed,
        // ModifyDBCluster under the same names (`clusterModifyScalarMembers`).
        'DatabaseInsightsMode',
        'EngineLifecycleSupport',
        'MasterUserAuthenticationType',
        // go-to-k/cdkd#5639: `BacktrackWindow` and `EnableLocalWriteForwarding`
        // ride CreateDBCluster and, when changed, ModifyDBCluster
        // (`clusterModifyScalarMembers`; a removed `EnableLocalWriteForwarding:
        // true` turns forwarding off). `ClusterScalabilityType` is create-only
        // and rides CreateDBCluster alone.
        'BacktrackWindow',
        'EnableLocalWriteForwarding',
        'ClusterScalabilityType',
        // go-to-k/cdkd#5639: AddRoleToDBCluster / RemoveRoleFromDBCluster once
        // the cluster is `available`, planned against the live list
        // (`applyAssociatedRoles`).
        'AssociatedRoles',
      ]),
    ],
    [
      'AWS::RDS::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'Engine',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'PubliclyAccessible',
        'Tags',
        // #609 backfill — 8 sibling props already handled on DBCluster.
        // 6 mutable (DeletionProtection / EngineVersion / Port / MasterUserPassword /
        // VPCSecurityGroups / AllocatedStorage ride both CreateDBInstance + ModifyDBInstance) +
        // 2 create-only (StorageEncrypted is set at instance creation and immutable
        // post-create per AWS RDS docs — absent from ModifyDBInstanceMessage;
        // MasterUsername is also immutable post-create — AWS rejects changes via
        // ModifyDBInstance). Two wire-format name flips: CFn `Port` → SDK `DBPortNumber`
        // (different field name entirely on the DB instance), CFn `VPCSecurityGroups`
        // → SDK `VpcSecurityGroupIds` (casing + suffix). `MasterUsername` +
        // `AllocatedStorage` are AWS-required for standalone (non-cluster) DBInstance
        // create — wired here so a standalone instance can SDK-route end-to-end.
        'AllocatedStorage',
        'DeletionProtection',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'Port',
        'StorageEncrypted',
        'VPCSecurityGroups',
        // #609 security-cluster backfill (sibling of the DBCluster set).
        // `KmsKeyId` is the storage-encryption key (pairs with the already-
        // handled StorageEncrypted) — create-only + immutable, so it is NOT
        // forwarded on update. The other 5 mirror DBCluster: `MasterUserSecret`
        // → SDK `MasterUserSecretKmsKeyId`, `ManageMasterUserPassword` (bool),
        // `MonitoringRoleArn` / `MonitoringInterval` (Number-coerced),
        // `EnableIAMDatabaseAuthentication` (bool) — all ride CreateDBInstance
        // AND ModifyDBInstance (mutable).
        'KmsKeyId',
        'MasterUserSecret',
        'ManageMasterUserPassword',
        'MonitoringRoleArn',
        'MonitoringInterval',
        'EnableIAMDatabaseAuthentication',
        // go-to-k/cdkd#2762: storage, backup, maintenance, option group,
        // certificate and Performance Insights settings. Each rides
        // CreateDBInstance and, when changed, ModifyDBInstance under the same
        // name (`instanceModifyBackfillMembers`).
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'StorageType',
        'MultiAZ',
        'MaxAllocatedStorage',
        'AutoMinorVersionUpgrade',
        'CopyTagsToSnapshot',
        'EnablePerformanceInsights',
        'PerformanceInsightsKMSKeyId',
        'PerformanceInsightsRetentionPeriod',
        'Iops',
        'StorageThroughput',
        'OptionGroupName',
        'CACertificateIdentifier',
        // go-to-k/cdkd#2762: network type, license model, promotion tier,
        // Database Insights mode and dedicated log volume ride
        // CreateDBInstance and, when changed, ModifyDBInstance under the same
        // name. `AllowMajorVersionUpgrade` and `CertificateRotationRestart`
        // are ModifyDBInstance-only flags RDS never reads back
        // (`instanceModifyBackfillMembers`).
        'NetworkType',
        'LicenseModel',
        'PromotionTier',
        'DatabaseInsightsMode',
        'DedicatedLogVolume',
        'AllowMajorVersionUpgrade',
        'CertificateRotationRestart',
        // go-to-k/cdkd#2762: rides CreateDBInstance and, when changed,
        // ModifyDBInstance; an update leaving it `pending-reboot` reboots the
        // instance, as CloudFormation does (`rebootForPendingParameterGroup`).
        'DBParameterGroupName',
        // go-to-k/cdkd#5640: the list on CreateDBInstance, the
        // `CloudwatchLogsExportConfiguration` delta on ModifyDBInstance
        // (`logExportsDelta`).
        'EnableCloudwatchLogsExports',
        // go-to-k/cdkd#5640: both ride CreateDBInstance only. `DBName` is
        // create-only (a change replaces). `AvailabilityZone` is not, but
        // ModifyDBInstance cannot move an instance, so a changed zone is
        // refused as CloudFormation refuses it (`instanceAvailabilityZoneKept`).
        'DBName',
        'AvailabilityZone',
        // go-to-k/cdkd#5640: ride CreateDBInstance and, when changed,
        // ModifyDBInstance under the same names (`instanceModifyBackfillMembers`).
        'EngineLifecycleSupport',
        'MasterUserAuthenticationType',
        // go-to-k/cdkd#5640: AddRoleToDBInstance / RemoveRoleFromDBInstance
        // once the instance is `available` (`applyAssociatedRoles`).
        'AssociatedRoles',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::RDS::DBCluster',
      new Map<string, string>([
        [
          'DeleteAutomatedBackups',
          'delete-time flag, sent on the delete when the record carries it; kept unhandled so a template declaring it keeps its Cloud Control route. Final snapshots are governed by DeletionPolicy: Snapshot, which this flag does not control',
        ],
      ]),
    ],
    [
      'AWS::RDS::DBInstance',
      new Map<string, string>([
        [
          'DBSecurityGroups',
          'EC2-Classic-only feature retired by AWS (2022-08-15); new accounts cannot use this — use VPCSecurityGroups instead',
        ],
        [
          'ApplyImmediately',
          'cdkd always applies modifications immediately (rds:ModifyDBInstance.ApplyImmediately=true is hardcoded); users wanting maintenance-window deferral should run aws rds modify-db-instance directly',
        ],
        [
          'DeleteAutomatedBackups',
          'delete-time flag, sent on the delete when the record carries it; kept unhandled so a template declaring it keeps its Cloud Control route. Final snapshots are governed by DeletionPolicy: Snapshot, which this flag does not control',
        ],
      ]),
    ],
  ]);

  /**
   * `region` pins the client instead of the ambient region: the Cloud Control
   * delete delegation (issue #3993) passes its OWN client's region, which is
   * the one its recorded-region pre-flight vetted.
   */
  constructor(options?: { region?: string }) {
    this.providerRegion = options?.region ?? ambientRegion();
  }

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new RDSClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.rdsClient;
  }

  /** Only a removed DBCluster `VpcSecurityGroupIds` reaches EC2 (issue #1160). */
  private getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.ec2Client;
  }

  /**
   * The client `CreateDBSubnetGroup` / `CreateDBCluster` / `CreateDBInstance`
   * go through: SDK retries on, except a 5xx (`withoutServerErrorRetries`,
   * issue #4639). Separate so every other call keeps the full SDK retry.
   *
   * None of the three carries an idempotency token, and each name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request
   * had succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): RDSClient {
    this.getClient();
    return this.createClient as RDSClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = context?.maskSecrets;
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.createDBSubnetGroup(logicalId, resourceType, properties, mask);
      case 'AWS::RDS::DBCluster':
        return this.createDBCluster(
          logicalId,
          resourceType,
          properties,
          mask,
          context?.replayingState === true
        );
      case 'AWS::RDS::DBInstance':
        return this.createDBInstance(
          logicalId,
          resourceType,
          properties,
          mask,
          context?.replayingState === true
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.updateDBSubnetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context?.maskSecrets
        );
      case 'AWS::RDS::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        );
      case 'AWS::RDS::DBInstance':
        return this.updateDBInstance(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::RDS::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::RDS::DBInstance':
        return this.deleteDBInstance(logicalId, physicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── DBSubnetGroup ────────────────────────────────────────────────

  private async createDBSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DBSubnetGroup ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const dbSubnetGroupName =
      (properties['DBSubnetGroupName'] as string | undefined) ||
      generatedNameFor('AWS::RDS::DBSubnetGroup', logicalId);

    try {
      const created = await this.getCreateClient().send(
        new CreateDBSubnetGroupCommand({
          DBSubnetGroupName: dbSubnetGroupName,
          DBSubnetGroupDescription:
            (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(`Successfully created DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`);

      // `DBSubnetGroupArn` read straight off the create response (issue #1824).
      // AWS added the attribute to the CFn schema after the 2026-05-16 fixture
      // capture, and an output / cross-resource `Fn::GetAtt` reads the CACHED
      // `resource.attributes[<CFnName>]` in
      // `constructAttribute` (`deployment/intrinsic-resolver/getatt.ts`) — which never calls a
      // provider's `getAttribute` — so an uncached `*Arn` name HARD-FAILS the
      // resolver's shape guard against this type's name-shaped physicalId.
      // `CreateDBSubnetGroup` reports the ARN directly, so this needs no extra
      // API call and no construction: it is the value AWS holds.
      const dbSubnetGroupArn = created.DBSubnetGroup?.DBSubnetGroupArn;

      return {
        physicalId: dbSubnetGroupName,
        attributes: {
          DBSubnetGroupName: dbSubnetGroupName,
          // Spread CONDITIONALLY rather than writing `undefined`: a
          // present-but-undefined key survives `structuredClone` into the state
          // record, so every `Object.keys` consumer sees a key carrying nothing.
          ...(dbSubnetGroupArn !== undefined && { DBSubnetGroupArn: dbSubnetGroupArn }),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create DBSubnetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            dbSubnetGroupName,
            cause
          )
      );
    }
  }

  private async updateDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DBSubnetGroup ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // Class 2 — `SubnetIds: []` would be rejected by AWS as a structurally
      // invalid input (DBSubnetGroup requires ≥ 2 subnets in distinct AZs).
      // readCurrentState emits `SubnetIds: []` as a placeholder when AWS
      // happens to return no subnets; the round-trip must NOT translate
      // that into a malformed SDK call. Skip the field when empty so the
      // ModifyDBSubnetGroup call is a no-op for the subnet list.
      const subnetIds = properties['SubnetIds'] as string[] | undefined;
      const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
      // The SDK input type marks `SubnetIds` as required; a description-
      // only update is a legitimate use case that omits the field on the
      // wire (AWS supports it). Cast the input shape to bypass the
      // type-level requirement.
      const modifyInput = {
        DBSubnetGroupName: physicalId,
        DBSubnetGroupDescription: properties['DBSubnetGroupDescription'] as string | undefined,
        ...(sendSubnetIds && { SubnetIds: subnetIds }),
      } as ConstructorParameters<typeof ModifyDBSubnetGroupCommand>[0];
      await this.getClient().send(new ModifyDBSubnetGroupCommand(modifyInput));

      // Apply tag diff. RDS uses ARN-keyed AddTagsToResource /
      // RemoveTagsFromResource. DescribeDBSubnetGroups returns the ARN.
      const desc = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      );
      const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
      if (arn) {
        await this.applyTagDiff(
          arn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      this.logger.debug(`Successfully updated DBSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          DBSubnetGroupName: physicalId,
          // Re-report `DBSubnetGroupArn` here even though an in-place update
          // cannot change it (issue #1824): an update result's `attributes`
          // REPLACE the state record's rather than merging into it, so
          // returning only `DBSubnetGroupName` would WIPE the ARN recorded at
          // create time and re-break the `Fn::GetAtt` the create-side fix
          // repairs. The value is free — the `DescribeDBSubnetGroups` above
          // already ran to key the tag diff.
          //
          // When AWS reports no ARN (or reports no group at all) the key is
          // DROPPED rather than written empty, and the reason is NOT the one the
          // SSM sibling gives (issue #1824 review round 3 corrected this). There
          // the rejected alternative — returning NO attributes, so the engine's
          // `result.attributes ?? ...` carries the PREVIOUS map forward — would
          // answer `Fn::GetAtt` from a SUPERSEDED value, because that map holds
          // the `Type` / `Value` this update just changed. Nothing here can be
          // superseded: the only other key is `DBSubnetGroupName`, which IS the
          // physicalId, and an in-place `ModifyDBSubnetGroup` cannot rename it
          // (`wasReplaced: false`), so a carried-forward value would be
          // byte-identical.
          //
          // What decides it instead is that the carry-forward makes the record's
          // contents depend on the shape of whatever map happened to be there
          // before, and after an `import()` that map holds the ARN ALONE (see
          // this provider's `importDBSubnetGroup`) — so it would DROP the one
          // key this update can state authoritatively rather than supersede
          // anything. Returning the partial map always records exactly what this
          // update observed, and degrades to the resolver's LOUD `*Arn`
          // shape-guard failure. It heals on the resource's next UPDATE, or
          // on the next deploy that resolves a `Fn::GetAtt` on it: a plain
          // re-deploy skips the provider, so the deploy engine re-reads the
          // record through `import()` on that miss (issue
          // https://github.com/go-to-k/cdkd/issues/1852).
          ...(arn !== undefined && { DBSubnetGroupArn: arn }),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update DBSubnetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted DBSubnetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete DBSubnetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
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
    for (const [skipped, key, expected, created] of [
      [backtrackSkipped, 'BacktrackWindow', 'a whole number of seconds', 'backtracking off'],
      [forwardingSkipped, 'EnableLocalWriteForwarding', 'true or false', 'write forwarding off'],
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
    ];
    const effectiveProperties =
      skippedKeys.length > 0
        ? Object.fromEntries(
            Object.entries(properties).filter(([key]) => !skippedKeys.includes(key))
          )
        : undefined;
    const logExports = desiredLogExports(properties, resourceType, logicalId);

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generatedNameFor('AWS::RDS::DBCluster', logicalId);

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

      const response = await this.getCreateClient().send(
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
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      clusterLeftBehind = true;
      createdResourceId = response.DBCluster?.DbClusterResourceId;
      // go-to-k/cdkd#5511: reported before the post-create wiring and waits.
      reportCreatedResource(logicalId, resourceType, dbClusterIdentifier, createdResourceId);

      const cluster = response.DBCluster;
      if (!cluster) {
        // Theoretical AWS SDK contract violation: CreateDBCluster returned
        // success but with no DBCluster. Cannot clean up — we have no
        // identifier to delete. Has never been observed in practice.
        throw new Error('CreateDBCluster did not return DBCluster');
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
        // Wait for cluster to become available (skip with --no-wait)
        if (process.env['CDKD_NO_WAIT'] !== 'true') {
          await this.waitForClusterAvailable(logicalId, dbClusterIdentifier);
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

        return {
          physicalId: dbClusterIdentifier,
          attributes: definedAttributes({
            'Endpoint.Address': described?.Endpoint,
            'Endpoint.Port': stringifyIfAssigned(described?.Port),
            'ReadEndpoint.Address': described?.ReaderEndpoint,
            Arn: described?.DBClusterArn,
            DBClusterResourceId: described?.DbClusterResourceId,
          }),
          ...(effectiveProperties !== undefined && { effectiveProperties }),
        };
      } catch (innerError) {
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
            `${cleanupHead}${cleanupFailure.redacted ? `${m(cleanupFailure.summary)} ` : `${m(cleanupFailure.detail)}. `}THE CLUSTER IS STILL RUNNING AND BILLING. Outside a rollback's re-create, the failed deploy's rollback journal records it for \`cdkd rollback --revert-failed\`${wantsDeletionProtection ? ', which cannot delete it while its DeletionProtection is on' : ''}; otherwise delete it yourself: ${aws`${unprotect}aws rds delete-db-cluster --db-cluster-identifier ${dbClusterIdentifier} --skip-final-snapshot`.render()}`
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

  private async updateDBCluster(
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
    const roles = this.desiredAssociatedRoles(
      properties,
      resourceType,
      logicalId,
      physicalId,
      false
    );
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

    try {
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
      //     #5639 scalars (`clusterModifyScalarMembers`).
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
      await this.getClient().send(
        new ModifyDBClusterCommand({
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
        })
      );

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
      if (
        !noWait &&
        securityGroupListChanged(vpcSgIds, previousProperties['VpcSecurityGroupIds'])
      ) {
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
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update DBCluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * The compensation boundary (issue #2204): a `--remove-protection` flip whose
   * delete then fails terminally is undone here, so a destroy that did not
   * happen does not leave a live cluster with its guard stripped.
   */
  private async deleteDBCluster(
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

  private async deleteDBClusterOnce(
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
          context?.removeProtection === true,
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  // ─── DBInstance ───────────────────────────────────────────────────

  private async createDBInstance(
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

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generatedNameFor('AWS::RDS::DBInstance', logicalId);

    // go-to-k/cdkd#4583: set once CreateDBInstance returned (no self-cleanup).
    let instanceCreated = false;
    // go-to-k/cdkd#4655: the `DbiResourceId` CreateDBInstance returned,
    // carried on the failure's mark as the orphan's identity.
    let createdResourceId: string | undefined;
    try {
      // #609 — `MasterUserSecret` `{ KmsKeyId }` → scalar
      // `MasterUserSecretKmsKeyId` (same flip as the DBCluster path).
      const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;

      const response = await this.getCreateClient().send(
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
            EnableIAMDatabaseAuthentication: properties[
              'EnableIAMDatabaseAuthentication'
            ] as boolean,
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
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      instanceCreated = true;
      createdResourceId = response.DBInstance?.DbiResourceId;
      // go-to-k/cdkd#5511: reported before the available wait.
      reportCreatedResource(logicalId, resourceType, dbInstanceIdentifier, createdResourceId);

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(`Successfully created DBInstance ${logicalId}: ${dbInstanceIdentifier}`);

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(logicalId, dbInstanceIdentifier);
      }

      // go-to-k/cdkd#5640: once the instance is available, as CloudFormation's
      // create handler attaches them (`updateAssociatedRoles`). A role's
      // failure is not this instance name's collision (#3826).
      if (roles !== 'skipped') {
        try {
          await this.applyAssociatedRoles(
            'instance',
            logicalId,
            dbInstanceIdentifier,
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

  private async updateDBInstance(
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
    const roles = this.desiredAssociatedRoles(
      properties,
      resourceType,
      logicalId,
      physicalId,
      false
    );
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
                    evidence:
                      "cdkd's properties for this DB instance carry DeletionProtection: true",
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

  /** The compensation boundary for a DBInstance; see {@link deleteDBCluster}. */
  private async deleteDBInstance(
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

  private async deleteDBInstanceOnce(
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
                readStatus: async () =>
                  (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
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
      const finalSnapshotId =
        properties?.['DBClusterIdentifier'] === undefined
          ? context?.finalSnapshotIdentifier
          : undefined;
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via RDS's
   * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
   * `ResourceName=arn`).
   */
  private async applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    // go-to-k/cdkd#3994: both sides are read through `planTagDiff`; an
    // unreadable record untags nothing.
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from RDS resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on RDS resource ${arn}`);
    }
  }

  /**
   * Issue #5426: after a failed cleanup delete of a partially-created cluster,
   * whether AWS already has it on its way out: `gone` on `DBClusterNotFoundFault`
   * by class, `deleting` on that status, `undefined` for anything else (an
   * empty read or another failure included), which keeps the caller's warning.
   */
  private async partialClusterRetiring(
    dbClusterIdentifier: string
  ): Promise<'gone' | 'deleting' | undefined> {
    try {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      return cluster?.Status === 'deleting' ? 'deleting' : undefined;
    } catch (error) {
      return error instanceof Error && error.name === 'DBClusterNotFoundFault' ? 'gone' : undefined;
    }
  }

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName || message.includes('not found') || message.includes('does not exist')
    );
  }

  /**
   * The failure wrap the DBSubnetGroup / DBCluster / DBInstance create, update
   * and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}), so a create-first
   * replacement still recognises the collision. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). The delete catches test not-found
   * before they wrap.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const m = maskerOrIdentity(mask);
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
    this.logger.debug(m(build(m(failure.detail)).message));
    const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
   * by its CLASS, and the delete classifiers read `NotFound` in a message as
   * "already deleted": a class naming ANOTHER object's not-found (this
   * resource's own not-found returned before the wrap) is marked
   * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
   */
  private wrapDeleteError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const thrown = this.wrapCaughtError(mask, error, build);
    return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
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
  private wrapGlobalClusterDetachError(
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
   * The detach is IRREVERSIBLE (a secondary becomes a standalone writer), so a
   * cluster whose deletion protection is still on is refused BEFORE it: the
   * delete could only fail after it. Under `--remove-protection` the flip just
   * made gets a short grace to show.
   *
   * A cluster that is gone surfaces as the describe's `DBClusterNotFoundFault`
   * or an empty answer, both left to the caller's region-checked not-found
   * arm. A global cluster that is gone, or a cluster that is not (or no
   * longer) a member, needs no detach. A busy cluster or global cluster, or a
   * throttle, is waited through within the delete budget. Every other failure
   * is a {@link GlobalClusterDetachError}.
   */
  private async detachFromGlobalCluster(
    logicalId: string,
    physicalId: string,
    globalClusterId: string,
    removeProtection: boolean,
    progress: DeleteProgress,
    mask: (text: string) => string
  ): Promise<boolean> {
    let cluster = await this.describeDBCluster(physicalId);
    for (let i = 0; removeProtection && cluster?.DeletionProtection === true && i < 6; i++) {
      await this.sleep(5_000);
      cluster = await this.describeDBCluster(physicalId);
    }
    if (cluster === undefined) return false;
    if (cluster.DeletionProtection === true) {
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
          safeMsg`Detaching DBCluster ${logicalId} from global cluster ${globalClusterId} before the delete`
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
        this.logger.debug(
          safeMsg`DBCluster ${physicalId} status after the detach: ${after.Status}`
        );
        if (after.Status === 'available') return true;
      }
      await backOff();
    }
  }

  /**
   * go-to-k/cdkd#5639 / #5640: the `EngineLifecycleSupport` an update sends
   * (`engineLifecycleSupportAction`), or `undefined` for none; a change
   * CloudFormation refuses throws before any call. The physical id can be
   * secret-derived, so the refusal is masked against the recorded name too
   * (go-to-k/cdkd#4339).
   */
  private async engineLifecycleSupportToSend(
    kind: 'DB cluster' | 'DB instance',
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<string | undefined> {
    const action = engineLifecycleSupportAction(properties, previousProperties, context);
    if (action === 'unchanged') return undefined;
    const desired = engineLifecycleSupportOf(properties);
    if (action === 'send') return desired;
    const idKey = kind === 'DB cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier';
    const { mask } = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [[previousProperties[idKey], physicalId]]
    );
    // `undefined` once the live resource is known to hold the declared value.
    let liveRead: 'read' | 'not-found' | undefined = 'read';
    if (action === 'check-live') {
      try {
        const resource =
          kind === 'DB cluster'
            ? await this.describeDBCluster(physicalId)
            : await this.describeDBInstance(physicalId);
        if (resource === undefined) liveRead = 'not-found';
        else if (resource.EngineLifecycleSupport === desired) liveRead = undefined;
      } catch (err) {
        if (err instanceof CdkdError) throw err;
        // Only the fault NAME proves the resource is gone (go-to-k/cdkd#4283).
        const faultName = (err as { name?: unknown } | null)?.name;
        if (faultName === 'DBClusterNotFoundFault' || faultName === 'DBInstanceNotFoundFault') {
          liveRead = 'not-found';
        } else {
          // Left retryable: a later read may succeed. AWS's text reaches the
          // message as its class only, the rest at debug (go-to-k/cdkd#2319).
          throw this.wrapCaughtError(
            mask,
            err,
            (text) =>
              new ProvisioningError(
                `${mask(engineLifecycleSupportRefusalText(resourceType, logicalId, physicalId, kind, 'unreadable'))} The read failed: ${text}`,
                resourceType,
                logicalId,
                physicalId,
                err instanceof Error ? err : undefined
              )
          );
        }
      }
    }
    if (liveRead === undefined) return undefined;
    throw markNonRetryable(
      new ProvisioningError(
        mask(
          engineLifecycleSupportRefusalText(resourceType, logicalId, physicalId, kind, liveRead)
        ),
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  private async describeDBCluster(dbClusterIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: dbClusterIdentifier,
      })
    );
    return response.DBClusters?.[0];
  }

  /**
   * The security groups a DBCluster (`VpcSecurityGroupIds`) or DBInstance
   * (`VPCSecurityGroups`) update sends as SDK `VpcSecurityGroupIds`, or
   * `undefined` to omit it (ModifyDBCluster / ModifyDBInstance keep the live
   * groups then):
   *
   * - A non-empty declared list is sent as declared.
   * - An EMPTY list is omitted: `[]` would detach every group, and
   *   `readCurrentState` emits `[]` for a cluster with none, which
   *   `drift --revert` hands back as the desired bag.
   * - A list the previous template declared and the desired one omits is a
   *   removal (issue #1160). Real CloudFormation A/Bs showed CloudFormation
   *   then attaches the VPC's `default` security group in place of the
   *   declared ones, for a DB cluster and (#5542) a DB instance alike, so cdkd
   *   looks that group up and sends it. A previous EMPTY list attached
   *   nothing, and a `drift --revert` baseline is a readback rather than a
   *   template, so neither counts as a removal.
   */
  private async securityGroupsToSend(
    target: 'DBCluster' | 'DBInstance',
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<string[] | undefined> {
    const key = target === 'DBCluster' ? 'VpcSecurityGroupIds' : 'VPCSecurityGroups';
    const noun = target === 'DBCluster' ? 'cluster' : 'instance';
    const desired = properties[key] as string[] | undefined;
    if (desired !== undefined) return desired.length > 0 ? desired : undefined;
    const previous = previousProperties[key];
    if (context?.desiredFromAwsReadback === true) return undefined;
    if (!Array.isArray(previous) || previous.length === 0) return undefined;

    // `missing` names what the lookup did not find (terminal); `awsError` is a
    // failed call (left retryable).
    let groupId: string | undefined;
    let missing: string | undefined;
    let awsError: unknown;
    try {
      // A DB instance reports its subnet group's VPC inline; a cluster names
      // only the group, so its VPC takes one more read.
      let subnetGroupName: string | undefined;
      let vpcId: string | undefined;
      if (target === 'DBInstance') {
        const subnetGroup = (await this.describeDBInstance(physicalId))?.DBSubnetGroup;
        subnetGroupName = subnetGroup?.DBSubnetGroupName;
        vpcId = subnetGroupName ? subnetGroup?.VpcId : undefined;
      } else {
        subnetGroupName = (await this.describeDBCluster(physicalId))?.DBSubnetGroup;
        vpcId = subnetGroupName
          ? (
              await this.getClient().send(
                new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: subnetGroupName })
              )
            ).DBSubnetGroups?.[0]?.VpcId
          : undefined;
      }
      if (!subnetGroupName) missing = `the ${noun} reports no DB subnet group`;
      else if (!vpcId) missing = `DB subnet group ${subnetGroupName} reports no VPC`;
      else {
        const groups = await this.getEc2Client().send(
          new DescribeSecurityGroupsCommand({
            Filters: [
              { Name: 'vpc-id', Values: [vpcId] },
              { Name: 'group-name', Values: ['default'] },
            ],
          })
        );
        groupId = groups.SecurityGroups?.[0]?.GroupId;
        if (!groupId) missing = `VPC ${vpcId} has no security group named default`;
      }
    } catch (error) {
      awsError = error;
    }
    if (groupId === undefined) {
      // go-to-k/cdkd#2319: the thrown message is persisted, so an AWS failure
      // contributes only its summary (an EC2 UnauthorizedOperation names the
      // caller's ARN). The full text goes to debug, masked, and the retry
      // classifier reads it on `cause`.
      const mask = context?.maskSecrets ?? ((text: string) => text);
      const failure = missing === undefined ? describeAwsFailure(awsError) : undefined;
      if (failure?.redacted === true) {
        this.logger.debug(
          safeMsg`${logicalId}: the VPC default security group lookup failed: ${mask(failure.detail)}`
        );
      }
      const shown = mask(failure?.summary ?? '');
      const refusal = new ProvisioningError(
        `Failed to update ${target} ${logicalId}: ${key} was removed from the template, so the ${noun} moves to its VPC's default security group (as CloudFormation does), but cdkd could not find that group: ${missing ?? shown}. Declare ${key} in the template to choose the ${noun}'s security groups.`,
        resourceType,
        logicalId,
        physicalId,
        awsError instanceof Error ? awsError : undefined
      );
      if (missing !== undefined) throw markNonRetryable(refusal);
      // Stamped whenever the message lost text the cause still holds: the
      // AWS-authored summary, or a masker edit (the classifier must not miss
      // retry wording a secret overlapped).
      const withheld =
        awsError instanceof Error &&
        (failure?.redacted === true || shown !== (failure?.summary ?? ''));
      throw withheld ? markRedactedCause(refusal) : refusal;
    }
    // A warning, not info: the default group may grant wider access.
    this.logger.warn(
      safeMsg`${logicalId}: ${key} was removed from the template; attaching the VPC's default security group ${groupId}, as CloudFormation does.`
    );
    return [groupId];
  }

  private async describeDBInstance(dbInstanceIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
      })
    );
    return response.DBInstances?.[0];
  }

  /**
   * Issue #1160: wait out a member instance's transition (`transitional`) after
   * its cluster's security groups or port changed. Only that transition is
   * waited out: a member in a lasting state (maintenance, upgrading,
   * storage-optimization, ...) or deleted out of band does not hold the update,
   * as CloudFormation reports the cluster updated in those cases too.
   */
  private async waitForMemberAfterClusterChange(
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    transitional: ReadonlySet<string>,
    change: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      let status: string | undefined;
      try {
        status = (await this.describeDBInstance(dbInstanceIdentifier))?.DBInstanceStatus;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return;
        throw error;
      }
      if (status === undefined || !transitional.has(status)) return;
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(
      // The member's identifier is another resource's physical id, which this
      // cluster's masking does not cover (it can be secret-derived): name only
      // the cluster.
      safeMsg`Timed out waiting for a member instance of DBCluster ${clusterLogicalId} to finish applying its new ${change}`
    );
  }

  /**
   * A cluster read inside an update wait (issue #5417). A vanished cluster or a
   * terminal status (`isTerminalDbWaitStatus`) never reaches the awaited state, so
   * fail now rather than after the 30-minute budget.
   */
  private requireClusterWhileWaiting(
    cluster: DBCluster | undefined,
    logicalId: string,
    change: string
  ): DBCluster {
    // A deleted cluster usually throws DBClusterNotFoundFault from the describe
    // itself; this arm covers an empty `DBClusters` list.
    if (cluster === undefined) {
      throw new Error(
        safeMsg`DescribeDBClusters returned no cluster for DBCluster ${logicalId} while waiting for its new ${change}`
      );
    }
    if (isTerminalDbWaitStatus(cluster.Status)) {
      throw new Error(
        safeMsg`DBCluster ${logicalId} entered status ${cluster.Status ?? ''} while applying its new ${change}`
      );
    }
    return cluster;
  }

  /**
   * Wait until the cluster is out of `modifying` and reports `port` (issue
   * #1160). `available` alone can still read before the port change starts;
   * the port cannot.
   */
  private async waitForClusterPortApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    port: number,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const cluster = this.requireClusterWhileWaiting(
        await this.describeDBCluster(dbClusterIdentifier),
        logicalId,
        'port'
      );
      if (cluster.Status !== 'modifying' && cluster.Port === port) return;
      this.logger.debug(
        safeMsg`DBCluster ${logicalId} port not applied yet (status ${cluster.Status ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(`Timed out waiting for DBCluster ${logicalId} to apply its new port`);
  }

  /**
   * Wait until the cluster is `available` AND reports exactly `expected` as its
   * VPC security groups, all `active` (issue #1160). `available` alone can still
   * read before the group swap has started; the group statuses cannot.
   */
  private async waitForSecurityGroupsApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    expected: readonly string[],
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const want = [...new Set(expected)].sort().join(' ');
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const cluster = this.requireClusterWhileWaiting(
        await this.describeDBCluster(dbClusterIdentifier),
        logicalId,
        'VPC security groups'
      );
      const groups = cluster.VpcSecurityGroups ?? [];
      const ids = groups
        .map((group) => group.VpcSecurityGroupId ?? '')
        .sort()
        .join(' ');
      // `modifying` is the swap's own transition; any lasting state (backing-up,
      // maintenance, ...) is not this change's to wait out.
      const settled =
        cluster.Status !== 'modifying' &&
        groups.every((group) => group.Status === 'active') &&
        ids === want;
      if (settled) return;
      this.logger.debug(
        safeMsg`DBCluster ${logicalId} security groups not settled yet (status ${cluster.Status ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(
      `Timed out waiting for DBCluster ${logicalId} to apply its new VPC security groups`
    );
  }

  /**
   * Poll a DBCluster until `done` holds, as {@link waitForInstanceState} does
   * for an instance: a missing cluster or a terminal status fails at once, and
   * the budget is the resource's own deadline, 30 minutes when none is in scope.
   */
  private async waitForClusterState(
    logicalId: string,
    dbClusterIdentifier: string,
    done: (cluster: DBCluster) => boolean,
    change: string
  ): Promise<void> {
    const remaining = enclosingDeadlineRemainingMs();
    const maxWaitMs = Number.isFinite(remaining) ? remaining : 1_800_000;
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const cluster = this.requireClusterWhileWaiting(
        await this.describeDBCluster(dbClusterIdentifier),
        logicalId,
        change
      );
      if (done(cluster)) return;
      this.logger.debug(
        safeMsg`DBCluster ${logicalId} waiting for its ${change} (status ${cluster.Status ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(safeMsg`Timed out waiting for DBCluster ${logicalId}'s ${change}`);
  }

  /**
   * go-to-k/cdkd#5639: `EnableHttpEndpoint` / `DisableHttpEndpoint` once the
   * cluster is `available`. Right after a ModifyDBCluster the describe can
   * still read `available` before the change starts, and the call is then
   * refused as busy (`HTTP_ENDPOINT_BUSY_FAULTS`), so a refusal of that kind
   * waits for `available` again and resends, at most
   * `HTTP_ENDPOINT_MAX_ATTEMPTS` times. Any other failure, or the last busy
   * one, propagates.
   */
  private async sendHttpEndpointChange(
    logicalId: string,
    physicalId: string,
    arn: string,
    enable: boolean
  ): Promise<void> {
    let delay = 5_000;
    for (let attempt = 1; ; attempt += 1) {
      await this.waitForClusterState(
        logicalId,
        physicalId,
        (cluster) => cluster.Status === 'available',
        'pending changes to settle before the Data API call'
      );
      try {
        await this.getClient().send(
          enable
            ? new EnableHttpEndpointCommand({ ResourceArn: arn })
            : new DisableHttpEndpointCommand({ ResourceArn: arn })
        );
        return;
      } catch (error) {
        const name = awsErrorName(error);
        if (!HTTP_ENDPOINT_BUSY_FAULTS.has(name) || attempt >= HTTP_ENDPOINT_MAX_ATTEMPTS) {
          throw error;
        }
        this.logger.debug(
          safeMsg`DBCluster ${logicalId}: the Data API call was refused as busy (${name}); retrying`
        );
        await this.sleep(delay);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  /**
   * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
   * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
   * and their bounds).
   */
  private async deleteAfterProtectionFlip(
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

  /**
   * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
   * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
   * and their bounds).
   */
  private async deleteInstanceAfterProtectionFlip(
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

  /**
   * go-to-k/cdkd#5639 / #5640: the template's `AssociatedRoles`, refused
   * before any call when malformed. Its gap to the record is what gets
   * DETACHED, so a malformed list never reads as empty, on an update replayed
   * from state too (`.claude/rules/provider-aws-response-reads.md`, the list
   * rule). A DB instance's entry needs a `FeatureName`: its schema requires
   * one, and AddRoleToDBInstance cannot be sent without it. Only a rollback's
   * re-create, which detaches nothing, warns and attaches none instead
   * (`'skipped'`).
   */
  private desiredAssociatedRoles(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    replayingCreate: false
  ): AssociatedRole[];
  private desiredAssociatedRoles(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    replayingCreate: boolean
  ): AssociatedRole[] | 'skipped';
  private desiredAssociatedRoles(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    replayingCreate: boolean
  ): AssociatedRole[] | 'skipped' {
    const instance = resourceType === 'AWS::RDS::DBInstance';
    const roles = associatedRoleList(properties['AssociatedRoles'], {
      featureNameRequired: instance,
    });
    if (roles !== undefined) return roles;
    const expected = instance
      ? 'a list of objects with a RoleArn and a FeatureName'
      : 'a list of objects with a RoleArn';
    if (!replayingCreate) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType} ${logicalId}: AssociatedRoles must be ${expected}; nothing was changed`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the replayed AssociatedRoles is not ${expected}, so no role is attached`
    );
    return 'skipped';
  }

  /**
   * go-to-k/cdkd#5639 / #5640: attach the `desired` roles `previous` lacks and
   * detach the `previous` ones `desired` dropped, removals first, as
   * CloudFormation's handlers do (`updateAssociatedRoles`). RDS takes neither
   * call while the cluster or instance is busy, so they wait for `available`
   * first, under `--no-wait` too, and a call refused as busy waits it out and
   * is resent (#5194's rule). The live list is read once `available`, and the
   * plan drops what AWS already holds or no longer holds
   * (`planAssociatedRoleChanges`); a Describe answering no resource changes
   * nothing. CloudFormation's handlers stabilize each call once the Describe
   * lists the attached association, whatever its `Status` (`PENDING`
   * included: `isAssociatedRoleAttached` /
   * `isDBInstanceRoleAdditionStabilized` match the role and feature only), or
   * no longer lists the detached one; so does the wait here, which
   * `--no-wait` skips. CloudFormation's instance removal predicate
   * (`isDBInstanceRoleRemovalStabilized`) matches the RoleArn alone; cdkd
   * matches the role and the feature, so the same role kept for another
   * feature does not hold the wait open. A detach is marked attempted too, for
   * `associatedRolesNamed`.
   */
  private async applyAssociatedRoles(
    target: 'cluster' | 'instance',
    logicalId: string,
    physicalId: string,
    desired: readonly AssociatedRole[],
    previous: readonly AssociatedRole[],
    mask: ((text: string) => string) | undefined,
    marks: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'> | undefined
  ): Promise<void> {
    const candidates = planAssociatedRoleChanges(desired, previous);
    if (candidates.toAdd.length === 0 && candidates.toRemove.length === 0) return;
    const label = target === 'cluster' ? 'RDS DBCluster' : 'RDS DBInstance';
    // Bounded by the resource deadline, which does not cancel this operation:
    // a wait that outlives it would attach after the engine gave up.
    const waitBudgetMs = Math.min(1_800_000, enclosingDeadlineRemainingMs() - 30_000);
    if (waitBudgetMs <= 0) {
      throw new Error(
        `the resource timeout leaves no more time to change the roles of the ${target}; re-run the deploy, or with a longer --resource-timeout`
      );
    }
    if (target === 'cluster') {
      await this.waitForClusterAvailable(logicalId, physicalId, waitBudgetMs, 'changing its roles');
    } else {
      await this.waitForInstanceAvailable(
        logicalId,
        physicalId,
        waitBudgetMs,
        'changing its roles'
      );
    }
    const resource =
      target === 'cluster'
        ? await this.describeDBCluster(physicalId)
        : await this.describeDBInstance(physicalId);
    if (resource === undefined) {
      throw new Error(
        `Describe returned no ${target} while planning its role changes; no role was attached or detached`
      );
    }
    const { toAdd, toRemove } = planAssociatedRoleChanges(
      desired,
      previous,
      resource.AssociatedRoles ?? []
    );
    if (toAdd.length === 0 && toRemove.length === 0) return;
    marks?.markUnsettled?.('AssociatedRoles');
    const readStatus =
      target === 'cluster'
        ? async () => (await this.describeDBCluster(physicalId))?.Status
        : async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus;
    const whenAvailable = (send: () => Promise<unknown>): Promise<void> =>
      modifyDbInstanceWhenAvailable({
        send,
        readStatus,
        sleep: (ms) => this.sleep(ms),
        logger: this.logger,
        label,
        subject: target,
        isRefusal: (error) =>
          isRoleCallNotAvailableRefusal(error) || isModifyNotAvailableRefusal(error),
        logicalId,
        remainingMs: enclosingDeadlineRemainingMs(),
      });
    for (const role of toRemove) {
      // A detach is an attempt too, so `associatedRolesNamed` never reads a
      // role this run detached as detached outside cdkd. Marked BEFORE the
      // call, unlike an attach (#5498): a detach AWS applied can still throw
      // (a lost response, a replay's not-found), and the mark only matters
      // for a role AWS no longer lists, so a detach that did nothing is inert.
      marks?.markAttempted?.('AssociatedRoles', [associatedRoleKey(role)]);
      await whenAvailable(() =>
        target === 'cluster'
          ? this.getClient().send(
              new RemoveRoleFromDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
            )
          : this.getClient().send(
              new RemoveRoleFromDBInstanceCommand({
                DBInstanceIdentifier: physicalId,
                RoleArn: role.RoleArn,
                FeatureName: role.FeatureName,
              })
            )
      );
    }
    for (const role of toAdd) {
      await whenAvailable(() =>
        target === 'cluster'
          ? this.getClient().send(
              new AddRoleToDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
            )
          : this.getClient().send(
              new AddRoleToDBInstanceCommand({
                DBInstanceIdentifier: physicalId,
                RoleArn: role.RoleArn,
                FeatureName: role.FeatureName,
              })
            )
      );
      marks?.markAttempted?.('AssociatedRoles', [associatedRoleKey(role)]);
    }
    if (process.env['CDKD_NO_WAIT'] === 'true') return;
    const attached = toAdd.map(associatedRoleKey);
    const detached = toRemove.map(associatedRoleKey);
    const settled = (roles: readonly LiveAssociatedRole[] | undefined): boolean => {
      const held = new Set((roles ?? []).map(associatedRoleKey));
      return attached.every((key) => held.has(key)) && detached.every((key) => !held.has(key));
    };
    const change = `IAM role associations (${maskerOrIdentity(mask)(associatedRoleArns([...attached, ...detached]))})`;
    if (target === 'cluster') {
      await this.waitForClusterState(
        logicalId,
        physicalId,
        (cluster) => settled(cluster.AssociatedRoles),
        change
      );
    } else {
      await this.waitForInstanceState(
        logicalId,
        physicalId,
        (instance) => settled(instance.AssociatedRoles),
        change
      );
    }
  }

  /**
   * Wait for a DBCluster to become available. A terminal status
   * (`isTerminalDbWaitStatus`) fails at once rather than after the
   * 30-minute budget (issue #5426).
   */
  private async waitForClusterAvailable(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000,
    doing = 'being created'
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;
      // Issue #5426: a terminal status never becomes 'available'.
      if (isTerminalDbWaitStatus(status)) {
        throw new Error(
          safeMsg`DBCluster ${logicalId} entered status ${status ?? ''} while ${doing}, which it does not leave on its own`
        );
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DBCluster ${dbClusterIdentifier} to become available`);
  }

  /**
   * Wait for a DBCluster to be deleted
   */
  private async waitForClusterDeleted(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeDBCluster(dbClusterIdentifier);
        const status = cluster?.Status;

        this.logger.debug(`DBCluster ${logicalId} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DBCluster ${logicalId} to be deleted`);
  }

  /**
   * go-to-k/cdkd#2762: CloudFormation's post-update reboot. Its
   * `UpdateHandler` waits for the ModifyDBInstance to settle, reboots when the
   * instance's parameter group then reads `pending-reboot` (`shouldReboot`),
   * and waits for `available` with every parameter and option group `in-sync`
   * (`rebootAwait`). Without the reboot a changed group never takes effect:
   * RDS keeps it `pending-reboot` until something reboots the instance.
   *
   * Under `--no-wait` the settle wait and the reboot still run, since nothing
   * else applies the group; only the wait for the reboot to finish is
   * skipped. Returns the last instance read, for the update's attributes.
   */
  private async rebootForPendingParameterGroup(
    logicalId: string,
    physicalId: string,
    sentGroup: string | undefined,
    caRotationRestarts: boolean
  ): Promise<DBInstance> {
    const settled = await this.waitForInstanceState(
      logicalId,
      physicalId,
      (instance) => instanceParameterGroupSettled(instance, sentGroup, caRotationRestarts),
      'parameter group change to settle'
    );
    if (!instanceParameterGroupPendingReboot(settled)) return settled;
    this.logger.info(
      safeMsg`Rebooting DBInstance ${logicalId} to apply its parameter group (pending-reboot), as CloudFormation does after an update`
    );
    await this.getClient().send(new RebootDBInstanceCommand({ DBInstanceIdentifier: physicalId }));
    if (process.env['CDKD_NO_WAIT'] === 'true') return settled;
    return this.waitForInstanceState(
      logicalId,
      physicalId,
      instanceRebootApplied,
      'reboot to apply its parameter group'
    );
  }

  /**
   * Poll a DBInstance until `done` holds. A missing instance or a terminal
   * status (`isTerminalDbWaitStatus`) fails at once. The budget is the
   * resource's own deadline (`--resource-timeout`), so a settle that rides a
   * long modification (a storage optimization, a major upgrade) waits as long
   * as the deploy allows; 30 minutes when no deadline is in scope.
   */
  private async waitForInstanceState(
    logicalId: string,
    dbInstanceIdentifier: string,
    done: (instance: DBInstance) => boolean,
    change: string
  ): Promise<DBInstance> {
    const remaining = enclosingDeadlineRemainingMs();
    const maxWaitMs = Number.isFinite(remaining) ? remaining : 1_800_000;
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      if (instance === undefined) {
        throw new Error(
          safeMsg`DescribeDBInstances returned no instance for DBInstance ${logicalId} while waiting for its ${change}`
        );
      }
      if (isTerminalDbWaitStatus(instance.DBInstanceStatus)) {
        throw new Error(
          safeMsg`DBInstance ${logicalId} entered status ${instance.DBInstanceStatus ?? ''} while waiting for its ${change}`
        );
      }
      if (done(instance)) return instance;
      this.logger.debug(
        safeMsg`DBInstance ${logicalId} waiting for its ${change} (status ${instance.DBInstanceStatus ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(safeMsg`Timed out waiting for DBInstance ${logicalId}'s ${change}`);
  }

  /**
   * Wait for a DBInstance to become available. A terminal status
   * (`isTerminalDbWaitStatus`) fails at once rather than after the
   * 30-minute budget (issue #5426).
   */
  private async waitForInstanceAvailable(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000,
    doing = 'being created'
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;
      // Issue #5426: a terminal status never becomes 'available'.
      if (isTerminalDbWaitStatus(status)) {
        throw new Error(
          safeMsg`DBInstance ${logicalId} entered status ${status ?? ''} while ${doing}, which it does not leave on its own`
        );
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DBInstance ${dbInstanceIdentifier} to become available`);
  }

  /**
   * Wait for a DBInstance to be deleted
   */
  private async waitForInstanceDeleted(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const instance = await this.describeDBInstance(dbInstanceIdentifier);
        const status = instance?.DBInstanceStatus;

        this.logger.debug(`DBInstance ${logicalId} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DBInstance ${logicalId} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Adopt an existing RDS resource into cdkd state.
   *
   * Supported types: `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`,
   * `AWS::RDS::DBSubnetGroup`. Resolution is by identifier name property
   * (`DBInstanceIdentifier` / `DBClusterIdentifier` / `DBSubnetGroupName`),
   * which is usually present in CDK templates, verified against the
   * corresponding `Describe*` call. A resource without one needs an
   * explicit `--resource` override (issue #1134).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::RDS::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::RDS::DBCluster':
        return this.importDBCluster(input);
      case 'AWS::RDS::DBSubnetGroup':
        return this.importDBSubnetGroup(input);
      default:
        return null;
    }
  }

  /**
   * go-to-k/cdkd#5639 / #5640: RDS answers the exported log types in its own
   * order, and the template's order means nothing to it; likewise the
   * associated IAM roles. Also what `unsettledAfterUpdate` compares by.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    return resourceType === 'AWS::RDS::DBCluster' || resourceType === 'AWS::RDS::DBInstance'
      ? ['EnableCloudwatchLogsExports', 'AssociatedRoles']
      : [];
  }

  /**
   * Issue #5466: `readCurrentState` reads `SecondsUntilAutoPause`, which
   * DescribeDBClusters returns on a cluster with `MinCapacity` 0 even when no
   * template declares it (AWS's 300-second default; measured us-east-1,
   * 2026-10-28). On the `observedProperties` baseline the comparator walks the
   * key UNION, so a record captured before this member was read would report
   * it as drift; the path is compared only where the template declares it.
   *
   * go-to-k/cdkd#2762: a DB instance's `AllowMajorVersionUpgrade` and
   * `CertificateRotationRestart` are ModifyDBInstance flags RDS keeps nowhere,
   * so DescribeDBInstances never returns them.
   */
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    if (resourceType === 'AWS::RDS::DBInstance') {
      return ['AllowMajorVersionUpgrade', 'CertificateRotationRestart'];
    }
    if (resourceType !== 'AWS::RDS::DBCluster') return [];
    // An absent or empty bag records nothing to scope by: compare.
    if (properties === undefined || Object.keys(properties).length === 0) return [];
    const scaling = properties?.['ServerlessV2ScalingConfiguration'] as
      | ServerlessV2ScalingProps
      | undefined;
    return scaling?.SecondsUntilAutoPause === undefined
      ? ['ServerlessV2ScalingConfiguration.SecondsUntilAutoPause']
      : [];
  }

  /**
   * go-to-k/cdkd#5639: a raw CFn template may spell the DBCluster booleans as
   * `'true'` / `'false'` and the retention period as a numeric string, while
   * `readCurrentState` answers a boolean and a number. On a baseline taken
   * from the recorded `properties` (no `observedProperties`) the two would
   * read as drift; both sides fold to the readback's type. Anything else is
   * left as it is.
   *
   * go-to-k/cdkd#5639 / #5640: on both types, `AssociatedRoles` folds a
   * repeated entry and an empty `FeatureName`, which AWS never holds
   * (`canonicalAssociatedRoles`).
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::RDS::DBCluster' && resourceType !== 'AWS::RDS::DBInstance') {
      return properties;
    }
    let out: Record<string, unknown> | undefined;
    const set = (key: string, value: unknown): void => {
      out ??= { ...properties };
      out[key] = value;
    };
    if (Array.isArray(properties['AssociatedRoles'])) {
      set('AssociatedRoles', canonicalAssociatedRoles(properties['AssociatedRoles']));
    }
    if (resourceType !== 'AWS::RDS::DBCluster') return out ?? properties;
    for (const key of CLUSTER_BOOLEAN_SCALARS) {
      const value = properties[key];
      if (value === 'true' || value === 'false') set(key, value === 'true');
    }
    for (const key of ['PerformanceInsightsRetentionPeriod', 'BacktrackWindow']) {
      const value = properties[key];
      if (typeof value === 'string') {
        const parsed = retentionPeriodValue(value);
        if (typeof parsed === 'number') set(key, parsed);
      }
    }
    return out ?? properties;
  }

  /** The post-update proof (#5380) compares through the same normalization. */
  canonicalizeUnsettledProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return this.canonicalizeDriftProperties(resourceType, properties);
  }

  /**
   * go-to-k/cdkd#5487: the live values of a record's unsettled names. Only
   * `AssociatedRoles` is ever marked (`applyAssociatedRoles`), and it keeps
   * only the associations the record, the template or an earlier attempt
   * (#5498) names: the convergence puts this on the previous side, so a role
   * an out-of-band change attached would otherwise read as dropped by the
   * template, and be detached.
   */
  async readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const live = await this.readCurrentState(physicalId, logicalId, resourceType);
    if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
    if (!names.has('AssociatedRoles')) return live;
    return {
      ...live,
      AssociatedRoles: associatedRolesNamed(
        live['AssociatedRoles'],
        recordedProperties?.['AssociatedRoles'],
        desiredProperties?.['AssociatedRoles'],
        attemptedItems?.get('AssociatedRoles')
      ),
    };
  }

  /**
   * Read the AWS-current RDS resource configuration in CFn-property shape.
   *
   * Dispatches by resource type:
   *   - `AWS::RDS::DBInstance` → `DescribeDBInstances`
   *   - `AWS::RDS::DBCluster` → `DescribeDBClusters`
   *   - `AWS::RDS::DBSubnetGroup` → `DescribeDBSubnetGroups`
   *
   * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
   * fields like `MasterUserPassword` are NEVER surfaced (RDS does not return
   * them in the Describe responses). `Tags` are surfaced via a follow-up
   * `ListTagsForResource(ResourceName=arn)` call (RDS uses `[{Key, Value}]`
   * shape). CDK's `aws:*` auto-tags are filtered out; the result key is
   * omitted entirely when AWS reports no user tags.
   *
   * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`*NotFoundFault`
   * or an empty describe list), `undefined` for a type with no read path.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::RDS::DBInstance':
        return this.readCurrentStateDBInstance(physicalId);
      case 'AWS::RDS::DBCluster':
        return this.readCurrentStateDBCluster(physicalId);
      case 'AWS::RDS::DBSubnetGroup':
        return this.readCurrentStateDBSubnetGroup(physicalId);
      default:
        return undefined;
    }
  }

  /**
   * go-to-k/cdkd#4606: whether the DB cluster or DB instance a failed CREATE
   * journaled is the one the record under the same logical id holds (a
   * fix-forward that created a new one there under another identifier).
   *
   * Reached on the SDK route only (Cloud Control's provider has no
   * `isSameResource`, so a Cloud Control-routed orphan is `'unknown'`). Both
   * ids must be DB identifiers; an ARN or anything else is `'unknown'`, as
   * is a DBSubnetGroup. An identifier names at most
   * one cluster (or instance) per account and region at a time, and RDS
   * compares identifiers case-insensitively (it stores them lower-cased), so
   * two spellings equal modulo case are `'same'` without a read: whatever
   * holds that identifier now is the record's resource. After the region
   * check the record's resource must read back (else `'unknown'`); the
   * journaled one is `'same'` when it reads back under the record's
   * `DbClusterResourceId` / `DbiResourceId` (immutable, unique, unchanged by
   * a rename), `'different'` under another, and `'different'` when AWS
   * reports its identifier gone: the record's resource answers to its own,
   * other, identifier, so the gone one cannot name it, and its delete
   * settles as already gone.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::RDS::DBCluster' && resourceType !== 'AWS::RDS::DBInstance') {
      return 'unknown';
    }
    if (!isDbIdentifier(journaledPhysicalId) || !isDbIdentifier(record.physicalId)) {
      return 'unknown';
    }
    if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'same';
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordResourceId = await this.readDbResourceIdIfExists(resourceType, record.physicalId);
    if (recordResourceId === undefined) return 'unknown';
    const journaledResourceId = await this.readDbResourceIdIfExists(
      resourceType,
      journaledPhysicalId
    );
    if (journaledResourceId === undefined) return 'different';
    return journaledResourceId === recordResourceId ? 'same' : 'different';
  }

  /**
   * go-to-k/cdkd#4655: the cluster's `DbClusterResourceId` or the instance's
   * `DbiResourceId`, which AWS generates, never changes (a rename keeps it)
   * and never gives a later resource. A cluster or instance re-created under
   * the identifier, in any case spelling, answers with another id, so the
   * settle keeps it rather than deleting it as the failed CREATE's orphan.
   * A failed CREATE's own token comes from its create response, on the
   * failure's mark (`markCreatedBeforeFailure`); this is the live read.
   *
   * `undefined` for another type, an id that is not a DB identifier, or a
   * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND`
   * only on the describe's not-found fault NAME (or an empty list); any
   * other failure throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::RDS::DBCluster' && resourceType !== 'AWS::RDS::DBInstance') {
      return undefined;
    }
    if (!isDbIdentifier(physicalId)) return undefined;
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
    return live === undefined ? RESOURCE_NOT_FOUND : live;
  }

  /**
   * The cluster's `DbClusterResourceId` (or the instance's `DbiResourceId`),
   * or `undefined` when AWS reports the identifier gone (its not-found fault
   * NAME, or an empty describe list). Any other failure, a response naming
   * another identifier and one naming no resource id throw: "could not read"
   * never reads as "gone".
   */
  private async readDbResourceIdIfExists(
    resourceType: 'AWS::RDS::DBCluster' | 'AWS::RDS::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    const isCluster = resourceType === 'AWS::RDS::DBCluster';
    let found: { identifier: string | undefined; resourceId: string | undefined } | undefined;
    try {
      if (isCluster) {
        const cluster = await this.describeDBCluster(identifier);
        found = cluster && {
          identifier: cluster.DBClusterIdentifier,
          resourceId: cluster.DbClusterResourceId,
        };
      } else {
        const instance = await this.describeDBInstance(identifier);
        found = instance && {
          identifier: instance.DBInstanceIdentifier,
          resourceId: instance.DbiResourceId,
        };
      }
    } catch (error) {
      const notFound = isCluster ? 'DBClusterNotFoundFault' : 'DBInstanceNotFoundFault';
      if ((error as { name?: unknown } | null)?.name === notFound) return undefined;
      throw error;
    }
    if (found === undefined) return undefined;
    const api = isCluster ? 'DescribeDBClusters' : 'DescribeDBInstances';
    if (found.identifier?.toLowerCase() !== identifier.toLowerCase()) {
      throw new Error(`${api} answered for another identifier`);
    }
    if (typeof found.resourceId !== 'string' || found.resourceId === '') {
      throw new Error(`${api} returned no resource id`);
    }
    return found.resourceId;
  }

  private async readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let inst;
    try {
      inst = await this.describeDBInstance(physicalId);
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBInstanceNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
      throw err;
    }
    if (!inst) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (inst.DBInstanceIdentifier !== undefined) {
      result['DBInstanceIdentifier'] = inst.DBInstanceIdentifier;
    }
    if (inst.DBInstanceClass !== undefined) result['DBInstanceClass'] = inst.DBInstanceClass;
    if (inst.Engine !== undefined) result['Engine'] = inst.Engine;
    if (inst.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = inst.DBClusterIdentifier;
    }
    if (inst.DBSubnetGroup?.DBSubnetGroupName !== undefined) {
      result['DBSubnetGroupName'] = inst.DBSubnetGroup.DBSubnetGroupName;
    }
    if (inst.PubliclyAccessible !== undefined) {
      result['PubliclyAccessible'] = inst.PubliclyAccessible;
    }
    // #609 backfill — AllocatedStorage + MasterUsername readbacks
    // (AWS-required sibling props, paired with the 5 below). MasterUsername
    // IS surfaced (unlike MasterUserPassword which AWS never returns).
    if (inst.AllocatedStorage !== undefined) {
      result['AllocatedStorage'] = inst.AllocatedStorage;
    }
    if (inst.MasterUsername !== undefined) result['MasterUsername'] = inst.MasterUsername;
    // #609 backfill — 5 readable sibling props matching DBCluster.
    // `MasterUserPassword` is intentionally NOT surfaced here: RDS never
    // returns the password in the Describe response (security), so any
    // value would be a phantom drift on every read.
    if (inst.DeletionProtection !== undefined) {
      result['DeletionProtection'] = inst.DeletionProtection;
    }
    if (inst.EngineVersion !== undefined) result['EngineVersion'] = inst.EngineVersion;
    // CFn `Port` → AWS Describe surface is `Endpoint.Port` (the active
    // listener port). The DBInstance shape has no top-level `Port` field
    // and no `DBPortNumber` either; the Modify-side `DBPortNumber` is a
    // request-shape oddity. Emit only when the endpoint is present
    // (briefly absent during create/modify transitions).
    if (inst.Endpoint?.Port !== undefined) result['Port'] = inst.Endpoint.Port;
    if (inst.StorageEncrypted !== undefined) {
      result['StorageEncrypted'] = inst.StorageEncrypted;
    }
    // CFn `VPCSecurityGroups` (string[]) ↔ AWS `VpcSecurityGroups[].VpcSecurityGroupId`.
    // Emit only when AWS returned a non-empty list — matches DBInstance's
    // overall "emit-when-present" pattern (vs DBCluster's "emit-always"
    // shape, which is a minor inconsistency in the cluster readback). The
    // drift calculator only descends into keys present in state, so an
    // omit-when-empty here still surfaces "state has SGs → AWS has none"
    // drift correctly via the state-side branch.
    const sgIds = (inst.VpcSecurityGroups ?? [])
      .map((sg) => sg.VpcSecurityGroupId)
      .filter((id): id is string => !!id);
    if (sgIds.length > 0) result['VPCSecurityGroups'] = sgIds;
    // #609 security-cluster backfill readbacks.
    if (inst.KmsKeyId !== undefined) result['KmsKeyId'] = inst.KmsKeyId;
    if (inst.MonitoringRoleArn !== undefined) {
      result['MonitoringRoleArn'] = inst.MonitoringRoleArn;
    }
    if (inst.MonitoringInterval !== undefined) {
      result['MonitoringInterval'] = inst.MonitoringInterval;
    }
    // AWS Describe surfaces this as `IAMDatabaseAuthenticationEnabled`; CFn /
    // cdkd state names it `EnableIAMDatabaseAuthentication`.
    if (inst.IAMDatabaseAuthenticationEnabled !== undefined) {
      result['EnableIAMDatabaseAuthentication'] = inst.IAMDatabaseAuthenticationEnabled;
    }
    // `MasterUserSecret` round-trips as `{ KmsKeyId }` (the only create-shape
    // member). Emit only when AWS reports a KmsKeyId so a non-managed-secret
    // instance (state has no such key) does not get a false-positive drift.
    // `ManageMasterUserPassword` itself is NOT a Describe field — its
    // create-time value is reflected only by the presence of MasterUserSecret,
    // so it is intentionally not read back (would be a phantom drift on every
    // read, like MasterUserPassword).
    if (inst.MasterUserSecret?.KmsKeyId !== undefined) {
      result['MasterUserSecret'] = { KmsKeyId: inst.MasterUserSecret.KmsKeyId };
    }
    // go-to-k/cdkd#2762: same names on the Describe shape, except
    // `PerformanceInsightsEnabled` and the option group membership.
    const sameName = [
      'BackupRetentionPeriod',
      'PreferredBackupWindow',
      'PreferredMaintenanceWindow',
      'StorageType',
      'MultiAZ',
      'MaxAllocatedStorage',
      'AutoMinorVersionUpgrade',
      'CopyTagsToSnapshot',
      'PerformanceInsightsKMSKeyId',
      'PerformanceInsightsRetentionPeriod',
      'Iops',
      'StorageThroughput',
      'CACertificateIdentifier',
      'NetworkType',
      'LicenseModel',
      'PromotionTier',
      'DatabaseInsightsMode',
      'DedicatedLogVolume',
    ] as const;
    for (const key of sameName) {
      if (inst[key] !== undefined) result[key] = inst[key];
    }
    if (inst.PerformanceInsightsEnabled !== undefined) {
      result['EnablePerformanceInsights'] = inst.PerformanceInsightsEnabled;
    }
    // During an option group change the old membership is listed beside the
    // new one; the new one is `pending-apply`, then `in-sync`.
    const memberships = inst.OptionGroupMemberships ?? [];
    const optionGroupName = (
      memberships.find((m) => m.Status === 'in-sync' || m.Status === 'pending-apply') ??
      memberships[0]
    )?.OptionGroupName;
    if (optionGroupName !== undefined) result['OptionGroupName'] = optionGroupName;
    // go-to-k/cdkd#2762: the first listed group, as CloudFormation's read
    // handler reports it. RDS stores the name lower-cased; no fold, as for the
    // DB cluster's group: drift compares against the `observedProperties`
    // baseline every record this route writes carries.
    const parameterGroupName = inst.DBParameterGroups?.[0]?.DBParameterGroupName;
    if (parameterGroupName !== undefined) result['DBParameterGroupName'] = parameterGroupName;
    // go-to-k/cdkd#5640: emitted only when non-empty, as an instance exporting
    // nothing reads; compared order-insensitively (`getDriftUnorderedPaths`).
    // Not for a cluster member: DescribeDBInstances reports the CLUSTER's list
    // there (read on DocDB and Neptune members, the same API), which the
    // cluster owns, so a member's baseline would go stale on a cluster change.
    if (inst.DBClusterIdentifier === undefined) {
      const instanceLogs = liveLogExports(
        inst.EnabledCloudwatchLogsExports,
        inst.PendingModifiedValues?.PendingCloudwatchLogsExports
      );
      if (instanceLogs.length > 0) result['EnableCloudwatchLogsExports'] = instanceLogs;
    }
    // go-to-k/cdkd#5640: same names on the Describe shape. The zone only for a
    // single-AZ instance: a Multi-AZ one moves to its standby's zone on every
    // failover, which no template controls.
    if (inst.DBName !== undefined) result['DBName'] = inst.DBName;
    if (inst.AvailabilityZone !== undefined && inst.MultiAZ !== true) {
      result['AvailabilityZone'] = inst.AvailabilityZone;
    }
    // go-to-k/cdkd#5640: same name on the Describe shape. Not for a cluster
    // member, whose lifecycle the CLUSTER owns (the member reports the
    // cluster's). `MasterUserAuthenticationType` is write-only in the registry
    // schema and absent from DescribeDBInstances, so it is not read back.
    if (inst.EngineLifecycleSupport !== undefined && inst.DBClusterIdentifier === undefined) {
      result['EngineLifecycleSupport'] = inst.EngineLifecycleSupport;
    }
    // go-to-k/cdkd#5640: always a list, so a role lost out of band reads as a
    // change against the recorded list (`Status` is not a template member).
    result['AssociatedRoles'] = associatedRolesReadback(inst.AssociatedRoles);
    if (inst.DBInstanceArn) await this.attachTags(result, inst.DBInstanceArn);
    return result;
  }

  private async readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let cluster;
    try {
      cluster = await this.describeDBCluster(physicalId);
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBClusterNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (cluster.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
    }
    if (cluster.Engine !== undefined) result['Engine'] = cluster.Engine;
    if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
    if (cluster.MasterUsername !== undefined) result['MasterUsername'] = cluster.MasterUsername;
    if (cluster.DatabaseName !== undefined) result['DatabaseName'] = cluster.DatabaseName;
    if (cluster.Port !== undefined) result['Port'] = cluster.Port;
    result['VpcSecurityGroupIds'] = (cluster.VpcSecurityGroups ?? [])
      .map((sg) => sg.VpcSecurityGroupId)
      .filter((id): id is string => !!id);
    if (cluster.DBSubnetGroup !== undefined) result['DBSubnetGroupName'] = cluster.DBSubnetGroup;
    if (cluster.StorageEncrypted !== undefined) {
      result['StorageEncrypted'] = cluster.StorageEncrypted;
    }
    if (cluster.KmsKeyId !== undefined) result['KmsKeyId'] = cluster.KmsKeyId;
    if (cluster.BackupRetentionPeriod !== undefined) {
      result['BackupRetentionPeriod'] = cluster.BackupRetentionPeriod;
    }
    if (cluster.DeletionProtection !== undefined) {
      result['DeletionProtection'] = cluster.DeletionProtection;
    }
    // #609 security-cluster backfill readbacks.
    if (cluster.MonitoringRoleArn !== undefined) {
      result['MonitoringRoleArn'] = cluster.MonitoringRoleArn;
    }
    if (cluster.MonitoringInterval !== undefined) {
      result['MonitoringInterval'] = cluster.MonitoringInterval;
    }
    // AWS Describe surfaces this as `IAMDatabaseAuthenticationEnabled`; CFn /
    // cdkd state names it `EnableIAMDatabaseAuthentication`.
    if (cluster.IAMDatabaseAuthenticationEnabled !== undefined) {
      result['EnableIAMDatabaseAuthentication'] = cluster.IAMDatabaseAuthenticationEnabled;
    }
    if (cluster.PubliclyAccessible !== undefined) {
      result['PubliclyAccessible'] = cluster.PubliclyAccessible;
    }
    // `MasterUserSecret` round-trips as `{ KmsKeyId }`. Emit only when AWS
    // reports a KmsKeyId. `ManageMasterUserPassword` is not a Describe field
    // (its create-time value is reflected only by MasterUserSecret presence),
    // so it is intentionally not read back — like MasterUserPassword.
    if (cluster.MasterUserSecret?.KmsKeyId !== undefined) {
      result['MasterUserSecret'] = { KmsKeyId: cluster.MasterUserSecret.KmsKeyId };
    }
    // Class 1 — ServerlessV2ScalingConfiguration is only valid for Aurora
    // Serverless v2 clusters. Emit only when AWS actually returns one or
    // more of the discriminator fields (MinCapacity / MaxCapacity); on a
    // provisioned-mode cluster AWS leaves the entire field undefined and
    // emitting `{}` here would (a) round-trip through update() into
    // `ModifyDBCluster` with `ServerlessV2ScalingConfiguration: { Min: u, Max: u }`
    // which AWS rejects with "ServerlessV2ScalingConfiguration is only
    // supported on Aurora Serverless v2 clusters", and (b) fire a
    // false-positive drift on every non-serverless cluster (state has no
    // such key). See docs/provider-rules.md#readcurrentstate-for-drift-detection.
    if (
      cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined ||
      cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined
    ) {
      const sc: Record<string, unknown> = {};
      if (cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined) {
        sc['MinCapacity'] = cluster.ServerlessV2ScalingConfiguration.MinCapacity;
      }
      if (cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined) {
        sc['MaxCapacity'] = cluster.ServerlessV2ScalingConfiguration.MaxCapacity;
      }
      // Issue #5466: drift sees the auto-pause delay too.
      if (cluster.ServerlessV2ScalingConfiguration?.SecondsUntilAutoPause !== undefined) {
        sc['SecondsUntilAutoPause'] =
          cluster.ServerlessV2ScalingConfiguration.SecondsUntilAutoPause;
      }
      result['ServerlessV2ScalingConfiguration'] = sc;
    }
    // go-to-k/cdkd#2762: same names on the Describe shape, except the
    // parameter group's. DescribeDBClusters omits `StorageType` on an Aurora
    // Standard cluster (read us-east-1, 2026-11-01); CloudFormation's read
    // handler reports `aurora` there, and so does this, on Aurora engines only.
    if (cluster.DBClusterParameterGroup !== undefined) {
      result['DBClusterParameterGroupName'] = cluster.DBClusterParameterGroup;
    }
    if (cluster.PreferredBackupWindow !== undefined) {
      result['PreferredBackupWindow'] = cluster.PreferredBackupWindow;
    }
    if (cluster.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
    }
    if (cluster.CopyTagsToSnapshot !== undefined) {
      result['CopyTagsToSnapshot'] = cluster.CopyTagsToSnapshot;
    }
    // A storage type change can sit in `PendingModifiedValues` after
    // ModifyDBCluster returns (CloudFormation's handler waits for it to clear),
    // so the pending one is what the cluster is moving to: read it first, or
    // the capture right after the update records the old type.
    const storageType =
      cluster.PendingModifiedValues?.StorageType ??
      cluster.StorageType ??
      (cluster.Engine?.toLowerCase().startsWith('aurora') ? 'aurora' : undefined);
    if (storageType !== undefined) result['StorageType'] = storageType;
    // go-to-k/cdkd#5639: as for a DB instance.
    const clusterLogs = liveLogExports(
      cluster.EnabledCloudwatchLogsExports,
      cluster.PendingModifiedValues?.PendingCloudwatchLogsExports
    );
    if (clusterLogs.length > 0) result['EnableCloudwatchLogsExports'] = clusterLogs;
    // go-to-k/cdkd#5639: the Describe names, read back under the CFn ones,
    // as CloudFormation's read handler maps them.
    if (cluster.AutoMinorVersionUpgrade !== undefined) {
      result['AutoMinorVersionUpgrade'] = cluster.AutoMinorVersionUpgrade;
    }
    if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
    if (cluster.PerformanceInsightsEnabled !== undefined) {
      result['PerformanceInsightsEnabled'] = cluster.PerformanceInsightsEnabled;
    }
    if (cluster.PerformanceInsightsKMSKeyId !== undefined) {
      result['PerformanceInsightsKmsKeyId'] = cluster.PerformanceInsightsKMSKeyId;
    }
    if (cluster.PerformanceInsightsRetentionPeriod !== undefined) {
      result['PerformanceInsightsRetentionPeriod'] = cluster.PerformanceInsightsRetentionPeriod;
    }
    if (cluster.HttpEndpointEnabled !== undefined) {
      result['EnableHttpEndpoint'] = cluster.HttpEndpointEnabled;
    }
    // go-to-k/cdkd#5639: same names on the Describe shape.
    // `MasterUserAuthenticationType` is write-only in the registry schema and
    // absent from DescribeDBClusters, so it is not read back.
    if (cluster.DatabaseInsightsMode !== undefined) {
      result['DatabaseInsightsMode'] = cluster.DatabaseInsightsMode;
    }
    if (cluster.EngineLifecycleSupport !== undefined) {
      result['EngineLifecycleSupport'] = cluster.EngineLifecycleSupport;
    }
    // go-to-k/cdkd#5639. `ClusterScalabilityType` is not read back: the
    // registry schema lists it write-only, and a recorded create-only value
    // the template never declared would read as a removal.
    if (cluster.BacktrackWindow !== undefined) {
      result['BacktrackWindow'] = cluster.BacktrackWindow;
    }
    // `requested` and `enabled` read as on, as CloudFormation's read handler
    // projects the status (`Translator.translateLocalWriteForwardingStatus`).
    if (cluster.LocalWriteForwardingStatus !== undefined) {
      result['EnableLocalWriteForwarding'] =
        cluster.LocalWriteForwardingStatus === 'requested' ||
        cluster.LocalWriteForwardingStatus === 'enabled';
    }
    // go-to-k/cdkd#5639: as for a DB instance.
    result['AssociatedRoles'] = associatedRolesReadback(cluster.AssociatedRoles);
    if (cluster.DBClusterArn) await this.attachTags(result, cluster.DBClusterArn);
    return result;
  }

  private async readCurrentStateDBSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let resp: {
      DBSubnetGroups?: Array<{
        DBSubnetGroupName?: string;
        DBSubnetGroupArn?: string;
        DBSubnetGroupDescription?: string;
        Subnets?: Array<{ SubnetIdentifier?: string }>;
      }>;
    };
    try {
      resp = (await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      )) as unknown as typeof resp;
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBSubnetGroupNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    const sg = resp.DBSubnetGroups?.[0];
    if (!sg) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (sg.DBSubnetGroupName !== undefined) result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
    if (sg.DBSubnetGroupDescription !== undefined) {
      result['DBSubnetGroupDescription'] = sg.DBSubnetGroupDescription;
    }
    result['SubnetIds'] = (sg.Subnets ?? [])
      .map((s) => s.SubnetIdentifier)
      .filter((id): id is string => !!id);
    if (sg.DBSubnetGroupArn) await this.attachTags(result, sg.DBSubnetGroupArn);
    return result;
  }

  /**
   * Fetch tags via `ListTagsForResource(ResourceName=arn)` and merge them
   * into the result under `Tags` (CFn shape, `aws:*` filtered out, omitted
   * when empty). Best-effort: tag-fetch failures are logged at debug and
   * the key is simply left out — drift detection on configuration is more
   * important than fail-closing on a missing tag permission.
   */
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceName: arn })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `RDS ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
      );
    }
  }

  private async importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
        );
        // The map `create()` records, from the describe this verification
        // already issues (issue #1852). It is what heals a record written
        // under `--no-wait` while the instance was still `creating`
        // (go-to-k/cdkd#3077): the deploy engine re-reads through `import()`
        // when a `Fn::GetAtt` misses. `definedAttributes` keeps an unassigned
        // endpoint ABSENT, so a still-`creating` instance heals nothing.
        const described = resp.DBInstances?.[0];
        return {
          physicalId: explicit,
          attributes: definedAttributes({
            'Endpoint.Address': described?.Endpoint?.Address,
            'Endpoint.Port': stringifyIfAssigned(described?.Endpoint?.Port),
            Arn: described?.DBInstanceArn,
          }),
        };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB instance reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
        );
        const described = resp.DBClusters?.[0];
        // Issue #3627: the map `create()` records; the resolver's arm builds
        // only the ARN, so the endpoints resolved to the cluster identifier.
        return {
          physicalId: explicit,
          attributes: definedAttributes({
            'Endpoint.Address': described?.Endpoint,
            'Endpoint.Port': stringifyIfAssigned(described?.Port),
            'ReadEndpoint.Address': described?.ReaderEndpoint,
            Arn: described?.DBClusterArn,
            DBClusterResourceId: described?.DbClusterResourceId,
          }),
        };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB cluster reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importDBSubnetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
    if (explicit) {
      try {
        const desc = await this.getClient().send(
          new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
        );
        // Record `DBSubnetGroupArn` on the import path too (issue #1824): the
        // state record an import writes is what a later `Fn::GetAtt` reads, so
        // leaving it empty left an ADOPTED subnet group hitting the same
        // resolver shape-guard hard-fail the create-side fix repairs. Free —
        // the existence-verification Describe above already reports the ARN.
        const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
        return {
          physicalId: explicit,
          attributes: { ...(arn !== undefined && { DBSubnetGroupArn: arn }) },
        };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB subnet group reaching here needs an explicit `--resource` override.
    return null;
  }
}

/**
 * Whether the VpcSecurityGroupIds a cluster update SENDS differs from the
 * previous template's list (order-insensitive). `sent === undefined` sends
 * nothing, so nothing changes.
 */
function securityGroupListChanged(sent: readonly string[] | undefined, previous: unknown): boolean {
  if (sent === undefined) return false;
  const before = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string')
    : [];
  return [...sent].sort().join(' ') !== [...before].sort().join(' ');
}
