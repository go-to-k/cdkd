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
