import type { ModifyDBClusterCommandInput } from '@aws-sdk/client-neptune';
import { isDeepStrictEqual } from 'node:util';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { UpdateContext } from '../../../types/resource.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isProceedDbStatus } from '../deletion-protection-compensation.js';

/**
 * The attribute map a Neptune DB cluster records (issue #3650), under
 * CloudFormation's `Fn::GetAtt` names (`Endpoint`, `Port`, `ReadEndpoint`,
 * `ClusterResourceId`). The RDS-style dotted keys (`Endpoint.Address`, ...)
 * are kept for records and readers that already use them; no
 * `Fn::GetAtt` names them for this service, so on their own they left
 * `Fn::GetAtt [Cluster, Endpoint]` resolving to the cluster identifier.
 */
export function clusterAttributes(
  cluster:
    | {
        Endpoint?: string | undefined;
        Port?: number | undefined;
        ReaderEndpoint?: string | undefined;
        DBClusterArn?: string | undefined;
        DbClusterResourceId?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: cluster?.Endpoint,
    Port: stringifyIfAssigned(cluster?.Port),
    ReadEndpoint: cluster?.ReaderEndpoint,
    'Endpoint.Address': cluster?.Endpoint,
    'Endpoint.Port': stringifyIfAssigned(cluster?.Port),
    'ReadEndpoint.Address': cluster?.ReaderEndpoint,
    ClusterResourceId: cluster?.DbClusterResourceId,
  });
}

/**
 * The attribute map a Neptune DB instance records (issue #3650): `Endpoint` /
 * `Port` are CloudFormation's `Fn::GetAtt` names, the dotted keys are kept.
 */
export function instanceAttributes(
  instance:
    | {
        Endpoint?: { Address?: string | undefined; Port?: number | undefined } | undefined;
        DBInstanceArn?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: instance?.Endpoint?.Address,
    Port: stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    Arn: instance?.DBInstanceArn,
  });
}

/**
 * A DB cluster or DB instance identifier: a letter, then letters, digits and
 * single hyphens, not ending in one, at most 63 characters. Either case, as a
 * template may spell it (Neptune lower-cases it).
 */
export function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

/**
 * DBCluster properties CloudFormation KEEPS at their live value when the
 * template drops them (ModifyDBCluster merges, and CloudFormation sends
 * nothing for them), so `update()` sends nothing either and names them in a
 * warning. Measured by real CloudFormation A/Bs in us-east-1:
 *
 * - #5004: `DeletionProtection`, `IamAuthEnabled`, `BackupRetentionPeriod`.
 * - #1160: `DBPort` (8183 stayed 8183, not the 8182 default); `Port` is its
 *   legacy spelling.
 * - #5544 (2026-10-30): engine 1.4.7.0 (default 1.4.8.0), backup window
 *   `03:00-03:30`, maintenance window `sun:05:00-sun:05:30` and a custom
 *   cluster parameter group, all dropped at once, alone and beside a
 *   `BackupRetentionPeriod` 7 -> 8 change: every one read back unchanged for
 *   nine minutes (the version not upgraded, the group not moved back to
 *   `default.neptune1.4`), while the companion change applied.
 * - #2762: `CopyTagsToSnapshot` (true stayed true, read at once and after four
 *   minutes).
 */
export const CLUSTER_KEPT_ON_REMOVAL = [
  'EngineVersion',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
  'DeletionProtection',
  'IamAuthEnabled',
  'BackupRetentionPeriod',
  'DBPort',
  'Port',
  'CopyTagsToSnapshot',
] as const;

/**
 * DBInstance properties CloudFormation KEEPS on removal (see
 * {@link CLUSTER_KEPT_ON_REMOVAL}): `AutoMinorVersionUpgrade` (#5004), and
 * (#5544, the same A/B) a custom `DBParameterGroupName`, which stayed
 * attached and `in-sync`, and a maintenance window `mon:06:00-mon:06:30`,
 * beside an `AutoMinorVersionUpgrade` true -> false change that applied.
 */
export const INSTANCE_KEPT_ON_REMOVAL = [
  'DBParameterGroupName',
  'PreferredMaintenanceWindow',
  'AutoMinorVersionUpgrade',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list of strings, or `undefined` when unusable; absent or `null` is empty. */
export function stringList(value: unknown): string[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

/**
 * The ModifyDBCluster `CloudwatchLogsExportConfiguration` taking the cluster
 * from `previous` to `desired`, or `undefined` when they name the same types.
 * ModifyDBCluster takes a delta where CreateDBCluster takes the list.
 */
export function logExportChange(
  desired: readonly string[],
  previous: readonly string[]
): { EnableLogTypes?: string[]; DisableLogTypes?: string[] } | undefined {
  const enable = desired.filter((type) => !previous.includes(type));
  const disable = previous.filter((type) => !desired.includes(type));
  if (enable.length === 0 && disable.length === 0) return undefined;
  return {
    ...(enable.length > 0 && { EnableLogTypes: enable }),
    ...(disable.length > 0 && { DisableLogTypes: disable }),
  };
}

/**
 * The SDK's `ServerlessV2ScalingConfiguration` for the template's
 * `ServerlessScalingConfiguration`: `undefined` when absent, `null` when the
 * block is unusable. The schema requires both capacities, and a CFn number may
 * arrive as a numeric string; anything else is no capacity (`Number` would read
 * `''` as 0 and `true` as 1, and send a value nobody declared).
 */
export function serverlessScalingToSend(
  value: unknown
): { MinCapacity: number; MaxCapacity: number } | null | undefined {
  if (value == null) return undefined;
  if (!isPlainObject(value)) return null;
  const min = cfnCapacity(value['MinCapacity']);
  const max = cfnCapacity(value['MaxCapacity']);
  if (min === undefined || max === undefined) return null;
  return { MinCapacity: min, MaxCapacity: max };
}

function cfnCapacity(value: unknown): number | undefined {
  const usable = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  const capacity = usable ? Number(value) : Number.NaN;
  return Number.isFinite(capacity) ? capacity : undefined;
}

/**
 * Whether a change of `EngineVersion` crosses a Neptune major version (the
 * first two segments: 1.3 -> 1.4). Unknown when either side is not a string.
 */
export function isMajorEngineChange(previous: unknown, desired: unknown): boolean {
  if (typeof previous !== 'string' || typeof desired !== 'string') return false;
  const major = (version: string): string => version.split('.').slice(0, 2).join('.');
  return major(previous) !== major(desired);
}

/**
 * Whether a `PendingModifiedValues` holds anything: AWS answers an idle
 * resource with `{}` or with an empty `PendingCloudwatchLogsExports` inside.
 */
export function holdsPendingValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'object') return Object.values(value).some(holdsPendingValue);
  return true;
}

/**
 * A status no change of ours is moving through. `backing-up` counts: a nightly
 * backup must not refuse a deploy, and if AWS refuses the Modify during one,
 * that refusal names it. Whether it does is not measured.
 */
export function isUnmovingDbStatus(status: string | undefined): boolean {
  return isProceedDbStatus(status) || status === 'backing-up';
}

/** How long an accepted change (a role, a log type, ...) is waited on before a warning. */
export const SETTLE_MAX_WAIT_MS = 300_000;

/** The longest role changes wait for the cluster to read `available`. */
export const ROLE_AVAILABLE_MAX_WAIT_MS = 1_800_000;

/** The longest a create waits for the cluster to read `available`. */
export const CLUSTER_AVAILABLE_MAX_WAIT_MS = 1_800_000;

/**
 * A restored cluster's Modify refused while it settles (measured, #5638):
 * "DB cluster isn't available for modification with status creating."
 */
export function isRestoringClusterRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidDBClusterStateFault' &&
    /(?:isn't|is not|isn’t) available for modification with status/i.test(error.message)
  );
}

/** Budget kept back from the enclosing resource deadline. */
export const DEADLINE_MARGIN_MS = 30_000;

/** `DBPort`'s schema default, which a restore sends in place of the source's. */
export const DEFAULT_CLUSTER_PORT = 8182;

/** What CloudFormation sends for `StorageEncrypted: true` with no `KmsKeyId`. */
export const DEFAULT_STORAGE_KEY = 'alias/aws/rds';

/** The retention a CloudFormation snapshot restore sets when none is declared. */
const DEFAULT_RESTORED_BACKUP_RETENTION = 1;

/**
 * How long a restore waits for `available`: as a create, or to the resource
 * deadline when `--resource-timeout` allows more.
 */
export function restoreWaitMs(): number {
  const remaining = enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS;
  return Number.isFinite(remaining)
    ? Math.max(CLUSTER_AVAILABLE_MAX_WAIT_MS, remaining)
    : CLUSTER_AVAILABLE_MAX_WAIT_MS;
}

/** What `ModifyDBCluster` answers for a value it refuses (measured, #5638). */
export const RESTORE_VALUE_REFUSALS: ReadonlySet<string> = new Set([
  'InvalidParameterValue',
  'InvalidParameterCombination',
]);

/** Which of the two restore calls a template's keys select. */
export type ClusterRestore =
  | { kind: 'snapshot'; snapshotIdentifier: string }
  | {
      kind: 'point-in-time';
      sourceDBClusterIdentifier: string;
      restoreToTime: Date | undefined;
    };

/**
 * The restore a template declares, `undefined` for a plain create. Measured
 * against CloudFormation (#5638): `SourceDBClusterIdentifier` selects
 * `RestoreDBClusterToPointInTime` and wins over a `SnapshotIdentifier` beside
 * it, `SnapshotIdentifier` alone selects `RestoreDBClusterFromSnapshot`, and
 * neither means `CreateDBCluster`, whatever the other three keys say. An empty
 * identifier counts as none. A malformed key the selection reads is
 * refused, on a replay too: falling through would make an EMPTY cluster, and
 * AWS rejects each shape outright. A `RestoreToTime` with no offset reads as
 * UTC, not as this host's zone.
 */
export function readClusterRestore(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): ClusterRestore | undefined {
  const refuse = (key: string, expected: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`Neptune DBCluster ${logicalId}: ${key} must be ${expected}; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  const identifier = (key: string): string | undefined => {
    const value = properties[key];
    if (value == null) return undefined;
    return typeof value === 'string' ? value : refuse(key, 'a string');
  };
  const snapshotIdentifier = identifier('SnapshotIdentifier') || undefined;
  const sourceDBClusterIdentifier = identifier('SourceDBClusterIdentifier') || undefined;
  if (sourceDBClusterIdentifier !== undefined) {
    const declared = properties['RestoreToTime'];
    const restoreToTime =
      declared == null
        ? undefined
        : new Date(
            typeof declared !== 'string'
              ? NaN
              : /(?:z|[+-]\d{2}:?\d{2})$/i.test(declared)
                ? declared
                : `${declared}Z`
          );
    if (restoreToTime !== undefined && Number.isNaN(restoreToTime.getTime())) {
      return refuse('RestoreToTime', 'a timestamp');
    }
    return { kind: 'point-in-time', sourceDBClusterIdentifier, restoreToTime };
  }
  return snapshotIdentifier === undefined ? undefined : { kind: 'snapshot', snapshotIdentifier };
}

/** The keys a create of this kind does not read ({@link readClusterRestore}). */
export function ignoredRestoreKeys(restore: ClusterRestore | undefined): readonly string[] {
  if (restore?.kind === 'point-in-time') return ['SnapshotIdentifier', 'AvailabilityZones'];
  const pointInTimeKeys = ['RestoreToTime', 'RestoreType', 'UseLatestRestorableTime'];
  // Only an empty one reaches either list: anything else selects its restore.
  return restore === undefined
    ? ['SnapshotIdentifier', 'SourceDBClusterIdentifier', ...pointInTimeKeys]
    : ['SourceDBClusterIdentifier', ...pointInTimeKeys];
}

/** Whether the keys hold a snapshot to restore: an empty one means none. */
export function declaresSnapshot(properties: Record<string, unknown>): boolean {
  return properties['SnapshotIdentifier'] != null && properties['SnapshotIdentifier'] !== '';
}

/** Whether a record is a restored cluster's, so its update follows {@link sentOnUpdate}. */
function isRestoredRecord(previous: Record<string, unknown>): boolean {
  return (
    declaresSnapshot(previous) ||
    (previous['SourceDBClusterIdentifier'] != null && previous['SourceDBClusterIdentifier'] !== '')
  );
}

/**
 * What an update's `ModifyDBCluster` reads for a key CloudFormation sends only
 * once it changes. On a restored cluster these can hold a declared value AWS
 * refused after the restore ({@link restoreFollowUp}), so resending an
 * unchanged one would fail every later update of it, a tags-only one included.
 * Measured: CloudFormation's update leaves them out, and sends
 * `BackupRetentionPeriod`, `CopyTagsToSnapshot` and
 * `DBClusterParameterGroupName` whether or not they changed (#5638), so a group
 * AWS refused fails that update there too. A cluster not restored keeps
 * sending what the template declares.
 */
export function sentOnUpdate(
  properties: Record<string, unknown>,
  previous: Record<string, unknown>
): (key: string) => unknown {
  return (key) =>
    isRestoredRecord(previous) && isDeepStrictEqual(previous[key], properties[key])
      ? undefined
      : properties[key];
}

/** The `ModifyDBCluster` members sent after a restore; empty parts are `undefined`. */
export interface RestoreFollowUp {
  /** What CloudFormation sends too: a refusal fails the create, as it fails there. */
  parity: Omit<ModifyDBClusterCommandInput, 'DBClusterIdentifier'> | undefined;
  /**
   * What CloudFormation drops, grouped by what AWS accepts or refuses together:
   * a refusal is a warning, see {@link restoreFollowUp}.
   */
  declared: Omit<ModifyDBClusterCommandInput, 'DBClusterIdentifier'>[];
}

/**
 * What a restore call has no member for, so `ModifyDBCluster` sends it once
 * the cluster exists.
 *
 * CloudFormation sends a `Modify` only when `SnapshotIdentifier` is declared,
 * with `BackupRetentionPeriod` (1 when omitted, whatever the snapshot held) and
 * `CopyTagsToSnapshot`. Elsewhere it DROPS a declared value: both windows on
 * either restore; `BackupRetentionPeriod`, `CopyTagsToSnapshot`, `EngineVersion`,
 * `DBClusterParameterGroupName` and `DeletionProtection` on a point-in-time one
 * (measured, #5638).
 * cdkd sends those declared values instead of recording what AWS does not hold,
 * so parity gives way there, and only there: an omitted key stays what
 * CloudFormation makes it. AWS can refuse such a value (a window overlapping
 * the inherited one, an older engine) where CloudFormation succeeds, so that
 * half goes in a call of its own whose refusal only warns, and one refused
 * group does not cost the others. A point-in-time
 * `DBClusterParameterGroupName` goes here too, off a restore member: AWS
 * refuses another family's group, failing a restore CloudFormation completes.
 */
export function restoreFollowUp(
  properties: Record<string, unknown>,
  restore: ClusterRestore,
  restoredEngineVersion: string | undefined
): RestoreFollowUp {
  const nonEmpty = <T extends object>(members: T): T | undefined =>
    Object.keys(members).length > 0 ? members : undefined;
  const declaredRetention = properties['BackupRetentionPeriod'];
  const retention = declaredRetention != null ? Number(declaredRetention) : undefined;
  const snapshotDeclared = declaresSnapshot(properties);
  const pointInTime = restore.kind === 'point-in-time';
  const engineVersion = properties['EngineVersion'] as string | undefined;
  const engineChange =
    pointInTime && engineVersion != null && engineVersion !== restoredEngineVersion;
  const majorUpgrade = engineChange && isMajorEngineChange(restoredEngineVersion, engineVersion);
  return {
    parity: nonEmpty({
      ...(snapshotDeclared && {
        BackupRetentionPeriod: retention ?? DEFAULT_RESTORED_BACKUP_RETENTION,
      }),
    }),
    declared: [
      nonEmpty({
        ...(!snapshotDeclared && retention !== undefined && { BackupRetentionPeriod: retention }),
      }),
      nonEmpty({
        ...(properties['PreferredBackupWindow'] != null && {
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string,
        }),
        ...(properties['PreferredMaintenanceWindow'] != null && {
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string,
        }),
      }),
      nonEmpty({
        ...(pointInTime &&
          properties['CopyTagsToSnapshot'] != null && {
            CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean,
          }),
      }),
      // One group: a group of another family may be the new engine's own.
      nonEmpty({
        ...(pointInTime &&
          properties['DBClusterParameterGroupName'] != null && {
            DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as string,
          }),
        ...(engineChange && { EngineVersion: engineVersion }),
        ...(majorUpgrade && { AllowMajorVersionUpgrade: true }),
        ...(majorUpgrade &&
          properties['DBInstanceParameterGroupName'] != null && {
            DBInstanceParameterGroupName: properties['DBInstanceParameterGroupName'] as string,
          }),
      }),
    ].filter((group) => group !== undefined),
  };
}

/**
 * The top-level properties a ModifyDBCluster / ModifyDBInstance carries: a
 * change to one is in flight once the call is accepted, whatever fails later.
 */
export const CLUSTER_MODIFY_KEYS = [
  'EngineVersion',
  'DeletionProtection',
  'BackupRetentionPeriod',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
  'IamAuthEnabled',
  'VpcSecurityGroupIds',
  'DBPort',
  'Port',
  'CopyTagsToSnapshot',
  'NetworkType',
  'ServerlessScalingConfiguration',
  'EnableCloudwatchLogsExports',
] as const;

export const INSTANCE_MODIFY_KEYS = [
  'DBInstanceClass',
  'DBParameterGroupName',
  'PreferredMaintenanceWindow',
  'AutoMinorVersionUpgrade',
  'DeletionProtection',
  'PubliclyAccessible',
] as const;

/** go-to-k/cdkd#5380: mark each of `keys` the update changes, just before the call. */
export function markChangedUnsettled(
  keys: readonly string[],
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  for (const key of keys) {
    if (!isDeepStrictEqual(properties[key], previousProperties[key])) {
      context?.markUnsettled?.(key);
    }
  }
}

/**
 * Properties `update()` leaves at the live value when the template drops them
 * (ModifyDB* keeps a setting it is not sent) but whose CloudFormation
 * behaviour no A/B has measured yet (go-to-k/cdkd#2762), so the warning names
 * them without claiming parity.
 */
export const CLUSTER_UNMEASURED_ON_REMOVAL = [
  'NetworkType',
  'ServerlessScalingConfiguration',
] as const;

/**
 * Whether the VpcSecurityGroupIds a cluster update SENDS differs from the
 * previous template's list (order-insensitive). `sent === undefined` sends
 * nothing, so nothing changes.
 */
export function securityGroupListChanged(
  sent: readonly string[] | undefined,
  previous: unknown
): boolean {
  if (sent === undefined) return false;
  const before = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string')
    : [];
  return [...sent].sort().join(' ') !== [...before].sort().join(' ');
}
