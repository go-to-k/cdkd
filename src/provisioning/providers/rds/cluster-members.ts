import { type DBCluster, type ModifyDBClusterCommandInput } from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { UpdateContext } from '../../../types/resource.js';
import { isModifyNotAvailableRefusal } from '../db-instance-modify-retry.js';
import {
  numberOrUndefined,
  instanceValueChanged,
  engineLifecycleSupportOf,
} from './instance-members.js';

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

/**
 * go-to-k/cdkd#5639: whether `error` is RDS refusing a ModifyDBCluster because
 * the cluster is busy: "This cluster could not be modified. Please try again"
 * (`InvalidDBClusterStateFault`, read us-east-1, 2026-11-04, while a member
 * that had just joined was still taking the cluster's settings), or the
 * not-`available` wording. Read off the RAW SDK error.
 */
export function isClusterBusyRefusal(error: unknown): boolean {
  if (isModifyNotAvailableRefusal(error)) return true;
  return (
    error instanceof Error &&
    error.name === 'InvalidDBClusterStateFault' &&
    /could not be modified\. Please try again/i.test(error.message)
  );
}

/** The template's `AWS::RDS::DBCluster` `ServerlessV2ScalingConfiguration`. */
export interface ServerlessV2ScalingProps {
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
export function serverlessV2ScalingToSend(config: ServerlessV2ScalingProps): {
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
export function clusterCreateBackfillMembers(
  properties: Record<string, unknown>
): ClusterBackfillMembers {
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
export function clusterModifyBackfillMembers(
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
 * go-to-k/cdkd#5639: the Multi-AZ DB cluster (non-Aurora `mysql` /
 * `postgres`) compute and storage members, under their CFn names on both
 * CreateDBCluster and ModifyDBCluster.
 */
type ClusterMultiAzMembers = Pick<
  ModifyDBClusterCommandInput,
  'DBClusterInstanceClass' | 'AllocatedStorage' | 'Iops'
>;

/**
 * go-to-k/cdkd#5639: a Multi-AZ DB cluster `AllocatedStorage` or `Iops` read
 * off a bag: `undefined` when absent, the whole number (a number or its
 * numeric-string spelling), or `'malformed'`, which the create and update
 * refuse before any call (a replay skips it) rather than send as NaN.
 */
export function clusterSizeValue(value: unknown): number | undefined | 'malformed' {
  return retentionPeriodValue(value);
}

/**
 * go-to-k/cdkd#5639: a `DBClusterInstanceClass` or
 * `DBInstanceParameterGroupName` that is present but not a string, which the
 * create and update refuse before any call (a replay skips it) rather than
 * send as whatever it stringifies to.
 */
export function malformedInstanceClass(value: unknown): boolean {
  return value != null && typeof value !== 'string';
}

/** Whether a recorded value of either can stand in for a skipped one. */
export const usableInstanceClass = (value: unknown): boolean => typeof value === 'string';

/** Whether a recorded `AllocatedStorage` / `Iops` can stand in for a skipped one. */
export const usableClusterSize = (value: unknown): boolean =>
  typeof clusterSizeValue(value) === 'number';

/**
 * go-to-k/cdkd#5639: the Multi-AZ DB cluster members CreateDBCluster sends,
 * each one the template declares, as CloudFormation's create translation
 * (`Translator.createDbClusterRequest`) sends each declared value. A
 * malformed size is refused or skipped before the call (`clusterSizeValue`).
 */
export function clusterCreateMultiAzMembers(
  properties: Record<string, unknown>
): ClusterMultiAzMembers {
  const members: ClusterMultiAzMembers = {};
  const instanceClass = properties['DBClusterInstanceClass'];
  if (typeof instanceClass === 'string') members.DBClusterInstanceClass = instanceClass;
  const allocated = clusterSizeValue(properties['AllocatedStorage']);
  if (typeof allocated === 'number') members.AllocatedStorage = allocated;
  const iops = clusterSizeValue(properties['Iops']);
  if (typeof iops === 'number') members.Iops = iops;
  return members;
}

/**
 * go-to-k/cdkd#5639: the ModifyDBCluster Multi-AZ DB cluster members for an
 * update. CloudFormation's update translation (`Translator.
 * modifyDbClusterRequest`) sends the desired `DBClusterInstanceClass`,
 * `AllocatedStorage`, `Iops` and `StorageType` on every update, `null`
 * (unsent) for a removed key, and `ModelAdapter.setDefaults` fills none of
 * them (read from the `aws-cloudformation-resource-providers-rds` source, not
 * measured). So:
 *
 * - A changed `DBClusterInstanceClass` is sent; an unchanged one is not, that
 *   re-send being a no-op.
 * - The storage members travel together: a changed `AllocatedStorage`,
 *   `Iops` or `StorageType` sends the declared `AllocatedStorage` and `Iops`
 *   (`StorageType` itself rides `clusterModifyBackfillMembers`), as the
 *   handler always sends the set; RDS reads `Iops` against the storage size
 *   (0.5 to 50 IOPS per GiB) and needs it beside a Multi-AZ `StorageType`.
 * - A removal sends nothing and RDS keeps the live value.
 * - A rollback replay (`replayingState`) or a `drift --revert`
 *   (`desiredFromAwsReadback`) never sends an `AllocatedStorage` smaller than
 *   the previous one: RDS storage cannot shrink, so the revert would refuse
 *   the whole ModifyDBCluster and leave every other member unreverted; the
 *   larger size is kept and `onShrinkSkipped` is told. CloudFormation's
 *   cluster handler has no such arm (its DB instance handler does; unlike
 *   that rule there is no live read, a Multi-AZ DB cluster having no storage
 *   autoscaling). A template-path update sends the smaller size, which RDS
 *   refuses, as it does under CloudFormation.
 */
export function clusterModifyMultiAzMembers(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  onShrinkSkipped: (desired: number, previous: number) => void = () => {}
): ClusterMultiAzMembers {
  const changed = (key: string): boolean =>
    instanceValueChanged(properties, previousProperties, key, context);
  const members: ClusterMultiAzMembers = {};
  // A malformed one is refused or skipped before any call.
  const instanceClass = properties['DBClusterInstanceClass'];
  if (typeof instanceClass === 'string' && changed('DBClusterInstanceClass')) {
    members.DBClusterInstanceClass = instanceClass;
  }
  // A malformed one is refused or skipped before any call.
  const allocated = clusterSizeValue(properties['AllocatedStorage']);
  const previousAllocated = clusterSizeValue(previousProperties['AllocatedStorage']);
  const stateBorne = context?.replayingState === true || context?.desiredFromAwsReadback === true;
  const shrinkSkipped =
    stateBorne &&
    changed('AllocatedStorage') &&
    typeof allocated === 'number' &&
    typeof previousAllocated === 'number' &&
    allocated < previousAllocated;
  if (shrinkSkipped) onShrinkSkipped(allocated, previousAllocated);
  // A skipped shrink is no storage change of its own: with nothing else
  // changed, no storage member is sent. Otherwise the kept (larger) size
  // rides beside the IOPS, keeping the pair CloudFormation always sends.
  if (
    (changed('AllocatedStorage') && !shrinkSkipped) ||
    changed('Iops') ||
    changed('StorageType')
  ) {
    if (shrinkSkipped) members.AllocatedStorage = previousAllocated as number;
    else if (typeof allocated === 'number') members.AllocatedStorage = allocated;
    const iops = clusterSizeValue(properties['Iops']);
    if (typeof iops === 'number') members.Iops = iops;
  }
  return members;
}

/**
 * go-to-k/cdkd#5639: the statuses a Multi-AZ DB cluster settles in after an
 * instance class or storage change. CloudFormation's update stabilizes only on
 * `available` with no pending `AllocatedStorage`, `Iops` or `StorageType`
 * (`BaseHandlerStd.isDBClusterStabilized` / `isNoPendingChanges`), and so
 * does `--full-wait`. By default `storage-optimization` counts too: RDS can
 * hold a cluster there for hours after the new size is in place, and the
 * cluster serves meanwhile, as a CloudFront distribution serves before it is
 * `Deployed` (docs/wait-modes.md).
 */
export function multiAzSettledStatuses(fullWait: boolean): ReadonlySet<string> {
  return new Set(fullWait ? ['available'] : ['available', 'storage-optimization']);
}

/**
 * go-to-k/cdkd#5639: whether the Multi-AZ members an update sent have
 * applied, read once. The cluster is in a settled status
 * (`multiAzSettledStatuses`), no storage change is pending, and the values sent
 * read back: the instance class (RDS lists no pending class), the size, and
 * the IOPS on `io1` / `io2` storage, where it is the value provisioned.
 * Comparing what was sent, beyond CloudFormation's pending-only check, also
 * covers a read taken before RDS lists the change as pending. Off `io1` /
 * `io2`, an IOPS that does not read back is settled by `multiAzAppliedProbe`.
 */
export function multiAzMembersApplied(
  cluster: DBCluster,
  sent: ClusterMultiAzMembers,
  fullWait = false
): boolean {
  return multiAzReadState(cluster, sent, fullWait) === 'applied';
}

type MultiAzReadState = 'applied' | 'pending' | 'iops-unconfirmed';

function multiAzReadState(
  cluster: DBCluster,
  sent: ClusterMultiAzMembers,
  fullWait: boolean
): MultiAzReadState {
  if (
    sent.DBClusterInstanceClass === undefined &&
    sent.AllocatedStorage === undefined &&
    sent.Iops === undefined
  ) {
    return 'applied';
  }
  if (!multiAzSettledStatuses(fullWait).has(cluster.Status ?? '')) return 'pending';
  if (
    sent.DBClusterInstanceClass !== undefined &&
    cluster.DBClusterInstanceClass !== sent.DBClusterInstanceClass
  ) {
    return 'pending';
  }
  if (sent.AllocatedStorage === undefined && sent.Iops === undefined) return 'applied';
  if (sent.AllocatedStorage !== undefined && cluster.AllocatedStorage !== sent.AllocatedStorage) {
    return 'pending';
  }
  const pending = cluster.PendingModifiedValues;
  if (
    pending?.AllocatedStorage !== undefined ||
    pending?.Iops !== undefined ||
    pending?.StorageType !== undefined
  ) {
    return 'pending';
  }
  if (sent.Iops === undefined || cluster.Iops === sent.Iops) return 'applied';
  const provisionedIops = ['io1', 'io2'].includes(cluster.StorageType?.toLowerCase() ?? '');
  return provisionedIops ? 'pending' : 'iops-unconfirmed';
}

/** Consecutive settled reads that accept an IOPS that did not read back (gp3). */
export const MULTI_AZ_IOPS_CONFIRM_READS = 3;

/**
 * go-to-k/cdkd#5639: the stateful wait predicate for one update. On storage
 * other than `io1` / `io2` RDS may report a different IOPS figure than the
 * one sent, which a plain comparison would wait on until the deadline, while
 * accepting the first settled read could return before RDS lists the change
 * as pending. So an IOPS that does not read back is accepted only once
 * `MULTI_AZ_IOPS_CONFIRM_READS` settled reads in a row agree, the same
 * consecutive-probe count CloudFormation's stabilization uses
 * (`Probing.withProbing(..., 3, ...)`).
 */
export function multiAzAppliedProbe(
  sent: ClusterMultiAzMembers,
  fullWait: boolean
): (cluster: DBCluster) => boolean {
  let unconfirmedReads = 0;
  return (cluster) => {
    const state = multiAzReadState(cluster, sent, fullWait);
    if (state !== 'iops-unconfirmed') {
      unconfirmedReads = 0;
      return state === 'applied';
    }
    unconfirmedReads += 1;
    return unconfirmedReads >= MULTI_AZ_IOPS_CONFIRM_READS;
  };
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
  | 'EnableGlobalWriteForwarding'
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
export function clusterCreateScalarMembers(
  properties: Record<string, unknown>
): ClusterScalarMembers {
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
    ...(typeof globalWriteForwardingFlag(properties['EnableGlobalWriteForwarding']) ===
      'boolean' && {
      EnableGlobalWriteForwarding: globalWriteForwardingFlag(
        properties['EnableGlobalWriteForwarding']
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
 * (`localWriteForwardingToSend`). `EnableGlobalWriteForwarding` goes out only
 * when changed, and a removal sends nothing (RDS keeps the live setting): the
 * handler sends the desired value, unsent when removed, and no default fills
 * it (read from the same archived source, not measured). The handler re-sends
 * an unchanged value on every update, which would also undo an out-of-band
 * change; cdkd skips that no-op, as for the other scalars here.
 *
 * `EngineLifecycleSupport` and
 * `MasterUserAuthenticationType` are not here: `engineLifecycleSupportAction`
 * and `masterUserAuthenticationTypeToSend` decide them.
 */
export function clusterModifyScalarMembers(
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
  const globalWriteForwarding = globalWriteForwardingFlag(
    properties['EnableGlobalWriteForwarding']
  );
  if (typeof globalWriteForwarding === 'boolean' && changed('EnableGlobalWriteForwarding')) {
    members.EnableGlobalWriteForwarding = globalWriteForwarding;
  }
  return members;
}

/**
 * go-to-k/cdkd#5639: a DBCluster `BacktrackWindow` read off a bag, in seconds:
 * `undefined` when absent, the whole number (a number or its numeric-string
 * spelling), or `'malformed'`. The 0-259200 range is AWS's to enforce.
 */
export function backtrackWindowValue(value: unknown): number | undefined | 'malformed' {
  return retentionPeriodValue(value);
}

/**
 * go-to-k/cdkd#5639: a DBCluster `EnableLocalWriteForwarding` read off a bag,
 * as {@link httpEndpointFlag} reads the Data API flag.
 */
export function localWriteForwardingFlag(value: unknown): boolean | undefined | 'malformed' {
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
export function localWriteForwardingToSend(
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
export function localWriteForwardingApplied(cluster: DBCluster, enabled: boolean): boolean {
  const status = cluster.LocalWriteForwardingStatus;
  // Never reported: nothing to wait on, as CloudFormation's check waits only
  // while the status is `enabling` / `disabling`.
  if (status === undefined) return true;
  if (status === 'enabling' || status === 'disabling') return false;
  return (status === 'requested' || status === 'enabled') === enabled;
}

/**
 * go-to-k/cdkd#5639: a DBCluster `EnableGlobalWriteForwarding` read off a bag,
 * as {@link httpEndpointFlag} reads the Data API flag.
 */
export function globalWriteForwardingFlag(value: unknown): boolean | undefined | 'malformed' {
  return httpEndpointFlag(value);
}

/**
 * go-to-k/cdkd#5639: whether a cluster's global write forwarding has settled,
 * exactly as CloudFormation's stabilization decides it
 * (`BaseHandlerStd.isGlobalWriteForwardingStabilized`, read from the handler
 * source, not measured): once forwarding is not requested, or its status is
 * neither `enabling` nor `disabling`. The handler's own comment says
 * forwarding does not start until a reader exists; this predicate takes no
 * view on that and only mirrors the handler. The request flag is deliberately
 * NOT matched against the value sent: a request RDS does not report would
 * otherwise hold a deploy CloudFormation completes until its timeout.
 */
export function globalWriteForwardingApplied(cluster: DBCluster): boolean {
  if (cluster.GlobalWriteForwardingRequested !== true) return true;
  const status = cluster.GlobalWriteForwardingStatus;
  return status !== 'enabling' && status !== 'disabling';
}

/**
 * go-to-k/cdkd#5639: a DBCluster `EnableHttpEndpoint` read off a bag:
 * `undefined` when absent, the flag, or `'malformed'` for anything but a
 * boolean or its CFn string spelling.
 */
export function httpEndpointFlag(value: unknown): boolean | undefined | 'malformed' {
  if (value == null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return 'malformed';
}

/** go-to-k/cdkd#5639: the DBCluster booleans of the #5639 slice, as CFn names them. */
export const CLUSTER_BOOLEAN_SCALARS = [
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
export function retentionPeriodValue(value: unknown): number | undefined | 'malformed' {
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
export function clusterHttpEndpointAction(
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
export function withPreviousValues(
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

export const usableHttpEndpoint = (value: unknown): boolean =>
  typeof httpEndpointFlag(value) === 'boolean';

export const usableRetentionPeriod = (value: unknown): boolean =>
  typeof retentionPeriodValue(value) === 'number';

export const usableBacktrackWindow = (value: unknown): boolean =>
  typeof backtrackWindowValue(value) === 'number';

export const usableLocalWriteForwarding = (value: unknown): boolean =>
  typeof localWriteForwardingFlag(value) === 'boolean';

export const usableGlobalWriteForwarding = (value: unknown): boolean =>
  typeof globalWriteForwardingFlag(value) === 'boolean';

/**
 * go-to-k/cdkd#5639: absent, or a DBCluster `AvailabilityZones` list of names
 * (each a non-blank string; an empty name would fail only at RDS).
 */
export const usableAvailabilityZones = (value: unknown): boolean =>
  value == null ||
  (Array.isArray(value) && value.every((zone) => typeof zone === 'string' && zone.trim() !== ''));

/**
 * go-to-k/cdkd#2762: whether this cluster update changes `EngineVersion`, the
 * condition CloudFormation's handler sends `EngineVersion` and
 * `AllowMajorVersionUpgrade: true` under (`Translator.modifyDbClusterRequest`:
 * desired differs from previous, outside a rollback). Compared as the backfill
 * members are (`instanceValueChanged`), so a recorded stand-in defers to
 * `changedProperties`. A rollback replay never counts: the handler's rollback
 * arm sends neither, since RDS refuses an engine downgrade.
 */
export function clusterEngineVersionChanged(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean {
  if (context?.replayingState === true) return false;
  return instanceValueChanged(properties, previousProperties, 'EngineVersion', context);
}

/**
 * go-to-k/cdkd#5639: the `DBInstanceParameterGroupName` a cluster update
 * sends, only beside a changed `EngineVersion` (`clusterEngineVersionChanged`)
 * and only when the template changed it, as CloudFormation's handler sends it
 * (`Translator.modifyDbClusterRequest`: `diff(previous, desired)` inside the
 * engine-version arm). RDS applies it to every instance of the cluster during
 * a major upgrade, and refuses it beside a minor one ("can only be specified
 * for a major version upgrade", measured us-east-1, 2026-11-09), failing
 * CloudFormation's identical request the same way. CreateDBCluster has no
 * such member, so a create never sends it, and a change without an
 * engine-version change, or a removal, sends nothing, as CloudFormation sends
 * nothing then. A malformed one is refused or skipped before any call.
 */
export function clusterInstanceParameterGroupToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  engineVersionChanged: boolean,
  context: UpdateContext | undefined
): string | undefined {
  const desired = properties['DBInstanceParameterGroupName'];
  if (!engineVersionChanged || typeof desired !== 'string') return undefined;
  return instanceValueChanged(
    properties,
    previousProperties,
    'DBInstanceParameterGroupName',
    context
  )
    ? desired
    : undefined;
}

/** Issue #1160: the member statuses a cluster change moves an instance through. */
export const SECURITY_GROUP_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying']);

export const PORT_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying', 'rebooting']);

/** The ModifyDBCluster `Port`: the declared one, or the engine default on removal. */
export function clusterPortToSend(
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
