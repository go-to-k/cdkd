import { isDeepStrictEqual } from 'node:util';
import {
  type CloudwatchLogsExportConfiguration,
  type DBInstance,
  type PendingCloudwatchLogsExports,
  type ModifyDBInstanceCommandInput,
  type ProcessorFeature,
} from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { UpdateContext } from '../../../types/resource.js';

/** A template number (CFn numbers may arrive as strings), or `undefined` when absent. */
export function numberOrUndefined(value: unknown): number | undefined {
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
export function instanceValueChanged(
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
export async function instanceModifyBackfillMembers(
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
export function instanceParameterGroupPendingReboot(instance: DBInstance | undefined): boolean {
  return (instance?.DBParameterGroups ?? []).some(
    (group) => group.ParameterApplyStatus === 'pending-reboot'
  );
}

/**
 * go-to-k/cdkd#2762: whether a DB instance is still applying a parameter
 * group, so a reboot it may need cannot be told yet.
 */
export function instanceParameterGroupApplying(instance: DBInstance | undefined): boolean {
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
export function instanceParameterGroupSettled(
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
export function instanceRebootApplied(instance: DBInstance): boolean {
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
export function desiredLogExports(
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
export function logExportsDelta(
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
export function liveLogExports(
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
export function logExportsApplied(
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
export function instanceAvailabilityZoneKept(
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
export function withPreviousAvailabilityZone(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Record<string, unknown> {
  const { AvailabilityZone: _desired, ...rest } = properties;
  const previous = previousProperties['AvailabilityZone'];
  return previous === undefined ? rest : { ...rest, AvailabilityZone: previous };
}

/**
 * go-to-k/cdkd#5640: a `ProcessorFeatures` list read off a bag: `undefined`
 * when absent, the entries (a CFn number stringified), or `'malformed'` for
 * anything but a list of objects whose members are scalars. Neither member is
 * schema-required, so an entry lacking one goes out as declared, as
 * CloudFormation forwards it, and RDS answers for it.
 */
function processorFeatureList(value: unknown): ProcessorFeature[] | undefined | 'malformed' {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return 'malformed';
  const out: ProcessorFeature[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'malformed';
    const feature: ProcessorFeature = {};
    for (const key of ['Name', 'Value'] as const) {
      const member = (item as Record<string, unknown>)[key];
      if (member == null) continue;
      if (typeof member !== 'string' && typeof member !== 'number') return 'malformed';
      feature[key] = String(member);
    }
    out.push(feature);
  }
  return out;
}

/**
 * A `UseDefaultProcessorFeatures` read off a bag: a boolean, or its string
 * form in any case, as CloudFormation coerces it.
 */
function useDefaultProcessorFeaturesOf(value: unknown): boolean | undefined | 'malformed' {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) {
    return value.toLowerCase() === 'true';
  }
  return 'malformed';
}

type DesiredProcessorFeatures = {
  features: ProcessorFeature[] | undefined;
  useDefault: boolean | undefined;
};

/** The refusal text of a malformed processor property. */
function processorFeaturesRefusalText(
  features: unknown,
  resourceType: string,
  logicalId: string
): string {
  return features === 'malformed'
    ? `${resourceType} ${logicalId}: ProcessorFeatures must be a list of { Name, Value } objects`
    : `${resourceType} ${logicalId}: UseDefaultProcessorFeatures must be true or false`;
}

/**
 * go-to-k/cdkd#5640: the CREATE's `ProcessorFeatures` and
 * `UseDefaultProcessorFeatures`, or a non-retryable refusal before any call.
 * A create sends what is declared, so it is refused on a rollback replay too:
 * RDS takes nothing but a list of `{ Name, Value }` pairs and a boolean, so
 * the replay could not have applied it either. A declared empty list goes out
 * as declared, as CloudFormation sends it.
 */
export function desiredProcessorFeatures(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): DesiredProcessorFeatures {
  const features = processorFeatureList(properties['ProcessorFeatures']);
  const useDefault = useDefaultProcessorFeaturesOf(properties['UseDefaultProcessorFeatures']);
  if (features !== 'malformed' && useDefault !== 'malformed') return { features, useDefault };
  throw markNonRetryable(
    new ProvisioningError(
      processorFeaturesRefusalText(features, resourceType, logicalId),
      resourceType,
      logicalId
    )
  );
}

/** Whether a bag's processor property equals the other's (malformed by raw value). */
function sameProcessorValue<T>(
  read: (value: unknown) => T,
  desired: unknown,
  previous: unknown
): boolean {
  const a = read(desired);
  const b = read(previous);
  return a === 'malformed' && b === 'malformed'
    ? isDeepStrictEqual(desired, previous)
    : isDeepStrictEqual(a, b);
}

/**
 * go-to-k/cdkd#5640: the ModifyDBInstance processor members of an update, as
 * CloudFormation's handler builds them (`Translator.modifyDbInstanceRequest`,
 * `shouldSetProcessorFeatures`): when either property differs from the
 * previous template, the DESIRED values of both, each only when declared.
 * Otherwise nothing. A removed `ProcessorFeatures` therefore sends nothing and
 * the instance KEEPS its custom features, as under CloudFormation; declaring
 * `UseDefaultProcessorFeatures: true` is what restores the class defaults. A
 * malformed RECORDED side counts as a difference.
 *
 * A malformed DESIRED value is refused, before any call, only when the update
 * would send it: RDS refuses it every time, a rollback replay included. One
 * the record holds unchanged (a `cdkd import` of an unresolved intrinsic)
 * sends nothing and is no reason to fail the rest of the update.
 */
export function instanceProcessorFeatureMembers(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string
): Pick<ModifyDBInstanceCommandInput, 'ProcessorFeatures' | 'UseDefaultProcessorFeatures'> {
  if (
    sameProcessorValue(
      processorFeatureList,
      properties['ProcessorFeatures'],
      previousProperties['ProcessorFeatures']
    ) &&
    sameProcessorValue(
      useDefaultProcessorFeaturesOf,
      properties['UseDefaultProcessorFeatures'],
      previousProperties['UseDefaultProcessorFeatures']
    )
  ) {
    return {};
  }
  const features = processorFeatureList(properties['ProcessorFeatures']);
  const useDefault = useDefaultProcessorFeaturesOf(properties['UseDefaultProcessorFeatures']);
  if (features === 'malformed' || useDefault === 'malformed') {
    throw markNonRetryable(
      new ProvisioningError(
        processorFeaturesRefusalText(features, resourceType, logicalId),
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  return {
    ...(features !== undefined && { ProcessorFeatures: features }),
    ...(useDefault !== undefined && { UseDefaultProcessorFeatures: useDefault }),
  };
}

/** Two processor feature values RDS reads as the same (`'2'` and `'02'`). */
function sameFeatureValue(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  return (
    a !== undefined &&
    b !== undefined &&
    a.trim() !== '' &&
    b.trim() !== '' &&
    Number(a) === Number(b)
  );
}

/**
 * Quiet reads in a row after which a flag-only change counts as applied: RDS
 * may take a `UseDefaultProcessorFeatures` the instance already runs with no
 * restart at all.
 */
const FLAG_ONLY_QUIET_READS = 3;

/**
 * The statuses a processor change has left. `storage-optimization` counts:
 * a storage change in the same update holds the instance there for hours
 * after the restart, the instance serves meanwhile, and the update waits for
 * no storage change otherwise (as `multiAzSettledStatuses` reads it for a
 * cluster by default).
 */
const PROCESSOR_SETTLED_STATUSES: ReadonlySet<string> = new Set([
  'available',
  'storage-optimization',
]);

/** Whether an instance read shows a processor change under way. */
function processorChangeUnderWay(instance: DBInstance): boolean {
  return (
    !PROCESSOR_SETTLED_STATUSES.has(instance.DBInstanceStatus ?? '') ||
    (instance.PendingModifiedValues?.ProcessorFeatures ?? []).length > 0
  );
}

/**
 * go-to-k/cdkd#5640: a predicate for whether a processor change applied
 * immediately has settled: a settled status ({@link PROCESSOR_SETTLED_STATUSES})
 * with no processor change pending, and,
 * when the update sent a list, every sent feature listed live.
 * CloudFormation's update stabilizes the same way (`isNoPendingChanges`); a
 * read of the old features would also be a phantom drift. A flag sent alone
 * names no value to wait for, so the predicate also needs the change seen
 * under way (not `available`, or a processor change pending), on the instance
 * the ModifyDBInstance returned or on a read, or else
 * {@link FLAG_ONLY_QUIET_READS} quiet reads in a row; a single early read
 * taken before RDS registered the change does not count. One predicate per
 * wait: it keeps that count.
 */
export function processorFeaturesSettled(
  sent: ProcessorFeature[] | undefined,
  modified: DBInstance | undefined
): (instance: DBInstance) => boolean {
  let changeSeen = modified !== undefined && processorChangeUnderWay(modified);
  let quietReads = 0;
  return (instance) => {
    if (processorChangeUnderWay(instance)) {
      changeSeen = true;
      return false;
    }
    if (sent !== undefined) {
      const live = instance.ProcessorFeatures ?? [];
      return sent.every((feature) =>
        live.some(
          (item) => item.Name === feature.Name && sameFeatureValue(item.Value, feature.Value)
        )
      );
    }
    if (changeSeen) return true;
    quietReads += 1;
    return quietReads >= FLAG_ONLY_QUIET_READS;
  };
}

/**
 * go-to-k/cdkd#5640: the processor features an instance runs with once its
 * pending change applies: each pending feature over the live one of the same
 * name, live order first.
 */
export function liveProcessorFeatures(instance: DBInstance): ProcessorFeature[] | undefined {
  const pending = instance.PendingModifiedValues?.ProcessorFeatures ?? [];
  if (pending.length === 0) return instance.ProcessorFeatures;
  const out = (instance.ProcessorFeatures ?? []).map(
    (feature) => pending.find((item) => item.Name === feature.Name) ?? feature
  );
  for (const item of pending) {
    if (!out.some((feature) => feature.Name === item.Name)) out.push(item);
  }
  return out;
}

/** An `EngineLifecycleSupport` read off a bag: `undefined` when absent or empty. */
export function engineLifecycleSupportOf(bag: Record<string, unknown>): string | undefined {
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
export function engineLifecycleSupportAction(
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
export function engineLifecycleSupportRefusalText(
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
