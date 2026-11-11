import {
  DescribeDBClusterAutomatedBackupsCommand,
  DescribeDBClusterSnapshotsCommand,
  DescribeDBClustersCommand,
  ModifyDBClusterCommand,
  RestoreDBClusterFromSnapshotCommand,
  RestoreDBClusterToPointInTimeCommand,
  type DBCluster,
  type DBClusterAutomatedBackup,
  type ModifyDBClusterCommandInput,
  type RestoreDBClusterFromSnapshotCommandInput,
  type RestoreDBClusterToPointInTimeCommandInput,
  type Tag,
} from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import type { RDSProvider } from '../rds-provider.js';
import {
  type ServerlessV2ScalingProps,
  serverlessV2ScalingToSend,
  clusterCreateBackfillMembers,
  clusterCreateMultiAzMembers,
  clusterCreateScalarMembers,
  clusterSizeValue,
} from './cluster-members.js';
import { engineLifecycleSupportOf } from './instance-members.js';
import { awsErrorName } from './shared.js';

/**
 * go-to-k/cdkd#5639: a DBCluster created from another cluster's backups. Read
 * from CloudFormation's handler (the archived
 * `aws-cloudformation-resource-providers-rds` `aws-rds-dbcluster`, not
 * measured): a non-empty `SourceDBClusterIdentifier` or
 * `SourceDbClusterResourceId` makes the create a
 * `RestoreDBClusterToPointInTime` (`ResourceModelHelper.isRestoreToPointInTime`)
 * instead of a `CreateDBCluster`, whatever the other keys say.
 */
export interface ClusterPointInTimeRestore {
  kind: 'point-in-time';
  /** The one source it names: the handler refuses both. */
  source: { by: 'identifier' | 'resource-id'; value: string };
  /** Sent only when `UseLatestRestorableTime` is not true, as the handler sends it. */
  restoreToTime: Date | undefined;
  /** The declared flag, `undefined` when absent (the handler sends it as declared). */
  useLatestRestorableTime: boolean | undefined;
  restoreType: string | undefined;
}

/**
 * Otherwise a non-empty `SnapshotIdentifier` makes it a
 * `RestoreDBClusterFromSnapshot` (`isRestoreFromSnapshot`): the handler tests
 * the point-in-time sources first.
 */
export interface ClusterSnapshotRestore {
  kind: 'snapshot';
  snapshotIdentifier: string;
}

export type ClusterRestore = ClusterPointInTimeRestore | ClusterSnapshotRestore;

/** The call a restore of this kind makes, for messages. */
export function restoreCallName(restore: ClusterRestore | undefined): string {
  if (restore === undefined) return 'CreateDBCluster';
  return restore.kind === 'snapshot'
    ? 'RestoreDBClusterFromSnapshot'
    : 'RestoreDBClusterToPointInTime';
}

/**
 * The shape `java.time.ZonedDateTime.parse` takes, which the handler's
 * `Validations.validateTimestamp` applies to any non-blank `RestoreToTime`:
 * ISO 8601 date and time, either case of `T` / `Z`, a `Z` or `+hh[:mm[:ss]]`
 * offset (`appendOffsetId` parses leniently, so an hours-only `+01` passes),
 * and an optional `[Region/Zone]` suffix. No space separator and no `+hhmm`:
 * Java refuses both.
 */
const ZONED_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?)(?:\[[^\]]+\])?$/;

/** A `RestoreToTime` as the instant it names, or `undefined` when Java would refuse it. */
export function parseZonedTimestamp(text: string): Date | undefined {
  const match = ZONED_DATE_TIME.exec(text);
  if (match === null) return undefined;
  const n = (i: number): number => (match[i] === undefined ? 0 : Number(match[i]));
  const [year, month, day, hour, minute, second] = [n(1), n(2), n(3), n(4), n(5), n(6)];
  const [offsetHours, offsetMinutes, offsetSeconds] = [n(9), n(10), n(11)];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  // Java's ZoneOffset spans -18:00 to +18:00 in all.
  if (offsetMinutes > 59 || offsetSeconds > 59) return undefined;
  if (offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds > 18 * 3600) return undefined;
  // Java resolves strictly: 2026-02-30 is refused, not rolled into March.
  if (day < 1 || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return undefined;
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const offsetMs =
    (match[8] === '-' ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds) * 1000;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMs);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The restore a template declares, `undefined` for a plain create. Each
 * refusal is one CloudFormation fails the create with too (`RestoreToTime`
 * that `ZonedDateTime` cannot parse, on ANY create, as its `validateRequest`
 * reads it before choosing the call; both point-in-time sources at once), or
 * a schema type it refuses. They hold on a state replay too: CloudFormation
 * refuses each, so no record of one was written by a deploy it would accept,
 * and falling through would make an EMPTY cluster where a restore was meant.
 *
 * `UseLatestRestorableTime: true` beside a `RestoreToTime` restores to the
 * latest time and leaves the timestamp out, as the handler does; a source
 * with neither is sent as it is, AWS deciding (the handler sends it so too).
 */
export function readClusterRestore(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): ClusterRestore | undefined {
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${logicalId}: ${reason}, as CloudFormation requires; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  const declaredTime = properties['RestoreToTime'];
  let restoreToTime: Date | undefined;
  if (declaredTime != null && !(typeof declaredTime === 'string' && declaredTime.trim() === '')) {
    restoreToTime =
      typeof declaredTime === 'string' ? parseZonedTimestamp(declaredTime) : undefined;
    if (restoreToTime === undefined) {
      return refuse(
        'RestoreToTime must be an ISO 8601 timestamp with a time zone, such as 2026-01-01T00:00:00Z'
      );
    }
  }
  const declaredLatest = properties['UseLatestRestorableTime'];
  const useLatestRestorableTime =
    declaredLatest == null ? undefined : coerceCfnBoolean(declaredLatest);
  if (declaredLatest != null && useLatestRestorableTime === undefined) {
    return refuse('UseLatestRestorableTime must be true or false');
  }
  // A string key as the handler's `StringUtils.hasValue` reads it: empty is unset.
  const stringKey = (key: string): string | undefined => {
    const value = properties[key];
    if (value == null) return undefined;
    if (typeof value !== 'string') return refuse(`${key} must be a string`);
    return value === '' ? undefined : value;
  };
  const restoreType = stringKey('RestoreType');
  const source = stringKey('SourceDBClusterIdentifier');
  const sourceResourceId = stringKey('SourceDbClusterResourceId');
  const snapshotIdentifier = stringKey('SnapshotIdentifier');
  if (source !== undefined && sourceResourceId !== undefined) {
    return refuse('set either SourceDBClusterIdentifier or SourceDbClusterResourceId, not both');
  }
  if (source === undefined && sourceResourceId === undefined) {
    return snapshotIdentifier === undefined ? undefined : { kind: 'snapshot', snapshotIdentifier };
  }
  return {
    kind: 'point-in-time',
    source:
      source !== undefined
        ? { by: 'identifier', value: source }
        : { by: 'resource-id', value: sourceResourceId as string },
    restoreToTime: useLatestRestorableTime === true ? undefined : restoreToTime,
    useLatestRestorableTime,
    restoreType,
  };
}

/** The keys whose non-empty value makes a create a restore ({@link readClusterRestore}). */
const RESTORE_SOURCE_KEYS = [
  'SourceDBClusterIdentifier',
  'SourceDbClusterResourceId',
  'SnapshotIdentifier',
] as const;

/**
 * Whether a recorded bag is a restore's: its create applied no
 * `GlobalClusterIdentifier` or `WithExpressConfiguration`, which the record
 * still carries (create-only; dropping them would re-diff as an addition).
 */
export function isRestoredRecord(properties: Record<string, unknown> | undefined): boolean {
  return RESTORE_SOURCE_KEYS.some((key) => {
    const source = properties?.[key];
    return typeof source === 'string' && source !== '';
  });
}

/**
 * The declared keys a create of this kind does not apply, as CloudFormation's
 * does not: on a plain create the point-in-time keys; on a restore the keys
 * neither its restore call nor the handler's follow-up `ModifyDBCluster`
 * carries (the source decides them, or nothing does), and on a point-in-time
 * restore a `RestoreToTime` that `UseLatestRestorableTime: true` overrides and
 * the `SnapshotIdentifier` it does not read. The engine, version, master
 * user, database name and engine mode are named instead by
 * {@link restoredDifferences}, against the restored cluster.
 */
export function unusedRestoreKeys(
  properties: Record<string, unknown>,
  restore: ClusterRestore | undefined
): string[] {
  const pointInTimeKeys = ['RestoreType', 'RestoreToTime', 'UseLatestRestorableTime'];
  const restoreUnused = [
    'GlobalClusterIdentifier',
    'WithExpressConfiguration',
    'ClusterScalabilityType',
    'MasterUserAuthenticationType',
  ];
  const keys =
    restore === undefined
      ? pointInTimeKeys
      : restore.kind === 'snapshot'
        ? // Neither restore call has a StorageEncrypted member, and for a
          // snapshot CloudFormation checks it against nothing.
          [...restoreUnused, ...pointInTimeKeys, 'StorageEncrypted']
        : [
            // RestoreDBClusterFromSnapshot takes the zones; this call does not.
            'AvailabilityZones',
            ...restoreUnused,
            'SnapshotIdentifier',
            ...(restore.useLatestRestorableTime === true ? ['RestoreToTime'] : []),
          ];
  return keys.filter((key) => {
    const value = properties[key];
    if (value == null || value === '' || value === false || value === 'false') return false;
    return !(Array.isArray(value) && value.length === 0);
  });
}

/**
 * The declared keys the restored cluster does not hold, read off the restore
 * call's own answer (no extra call): a restore takes them from its source.
 * A snapshot restore sends the engine, version, mode and database name, so
 * only the master user is compared for it.
 */
export function restoredDifferences(
  properties: Record<string, unknown>,
  cluster: DBCluster,
  restore: ClusterRestore
): string[] {
  const pairs: Array<[string, string | undefined]> =
    restore.kind === 'snapshot'
      ? [['MasterUsername', cluster.MasterUsername]]
      : [
          ['Engine', cluster.Engine],
          ['EngineVersion', cluster.EngineVersion],
          ['EngineMode', cluster.EngineMode],
          ['MasterUsername', cluster.MasterUsername],
          ['DatabaseName', cluster.DatabaseName],
        ];
  return pairs
    .filter(([key, live]) => {
      const declared = properties[key];
      // A scalar the schema types as a string; anything else names nothing to compare.
      const text =
        typeof declared === 'string' || typeof declared === 'number' ? String(declared) : '';
      return text !== '' && live !== undefined && text !== live;
    })
    .map(([key]) => key);
}

/** What `DescribeDBClusters` may answer for an identifier it does not take. */
const ARN_IDENTIFIER_REFUSALS: ReadonlySet<string> = new Set([
  'InvalidParameterValue',
  'InvalidParameterCombination',
]);

/**
 * The source cluster, as CloudFormation's create reads it before restoring
 * (`fetchSourceDBCluster`; its scalability type picks the request shape, its
 * encryption is validated against the template). A cross-account ARN is not
 * found by name, so an ARN the by-name read does not find (or refuses as an
 * invalid identifier: the API does not take another account's) is looked up
 * among the clusters shared with the account, as the handler does. Any failure stops the create before
 * anything is made, as the handler's unguarded read does.
 */
export async function readRestoreSource(
  this: RDSProvider,
  source: string,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<DBCluster> {
  const wrapSourceReadError = (error: unknown): ProvisioningError =>
    this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create DBCluster ${logicalId}: reading the restore source failed, so nothing was changed: ${text}`,
          resourceType,
          logicalId,
          undefined,
          error instanceof Error ? error : undefined
        )
    );
  let found: DBCluster | undefined;
  try {
    const response = await this.getClient().send(
      new DescribeDBClustersCommand({ DBClusterIdentifier: source })
    );
    found = response.DBClusters?.[0];
  } catch (error) {
    const crossAccountRefusal =
      source.startsWith('arn:') &&
      error instanceof Error &&
      ARN_IDENTIFIER_REFUSALS.has(error.name);
    if (!crossAccountRefusal && !this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
      throw wrapSourceReadError(error);
    }
  }
  if (found === undefined && source.startsWith('arn:')) {
    try {
      let marker: string | undefined;
      do {
        const page = await this.getClient().send(
          new DescribeDBClustersCommand({ IncludeShared: true, Marker: marker })
        );
        found = page.DBClusters?.find(
          (cluster) => (cluster.DBClusterArn ?? '').toLowerCase() === source.toLowerCase()
        );
        marker = page.Marker;
      } while (found === undefined && marker !== undefined && marker !== '');
    } catch (error) {
      throw wrapSourceReadError(error);
    }
  }
  if (found !== undefined) return found;
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`${resourceType} ${logicalId}: SourceDBClusterIdentifier ${source} does not name a DB cluster this account can read, so there is nothing to restore; nothing was changed.`,
      resourceType,
      logicalId
    )
  );
}

/** What the handler reads off an automated backup's engine version (`-limitless` suffix). */
export function isLimitlessEngineVersion(engineVersion: string | undefined): boolean {
  return (engineVersion ?? '').split('-')[1] === 'limitless';
}

/** The automated backup a `SourceDbClusterResourceId` restore reads from. */
export interface RestoreBackupSource {
  StorageEncrypted?: boolean | undefined;
  limitless: boolean;
}

/**
 * The automated backups of the source cluster, as CloudFormation's create
 * reads them before a `SourceDbClusterResourceId` restore
 * (`fetchSourceDBClusterAutomatedBackup`; `DescribeDBClusterAutomatedBackups`
 * lists a live cluster's as well as a deleted one's): the engine version's
 * `-limitless` suffix picks the request shape, a `retained` limitless backup
 * is refused with the handler's message, and the encryption is validated
 * against the template. Any failure stops the create before anything is
 * made, as the handler's unguarded read does.
 *
 * The handler filters that read by the model's read-only `DBClusterResourceId`,
 * which is unset on a create, so it reads whichever backup the account lists
 * first; cdkd filters by the `SourceDbClusterResourceId` the restore names,
 * which is the backup the restore call reads.
 */
export async function readRestoreBackup(
  this: RDSProvider,
  resourceId: string,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<RestoreBackupSource> {
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${logicalId}: ${reason}; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  let backup: DBClusterAutomatedBackup | undefined;
  try {
    const response = await this.getClient().send(
      new DescribeDBClusterAutomatedBackupsCommand({
        DbClusterResourceId: resourceId,
      })
    );
    backup = response.DBClusterAutomatedBackups?.[0];
  } catch (error) {
    if (!this.isNotFoundError(error, 'DBClusterAutomatedBackupNotFoundFault')) {
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create DBCluster ${logicalId}: reading the restore source's automated backups failed, so nothing was changed: ${text}`,
            resourceType,
            logicalId,
            undefined,
            error instanceof Error ? error : undefined
          )
      );
    }
  }
  if (backup === undefined) {
    return refuse(
      `SourceDbClusterResourceId ${resourceId} does not name a DB cluster or retained automated backup this account can read, so there is nothing to restore`
    );
  }
  const limitless = isLimitlessEngineVersion(backup.EngineVersion);
  if (limitless && backup.Status === 'retained') {
    refuse(
      "SourceDbClusterResourceId names a retained automated backup of an Aurora Limitless Database cluster, which can't be restored (automated backup retention isn't supported with Aurora Limitless Database clusters; restore from a manual snapshot instead), as CloudFormation requires"
    );
  }
  return { StorageEncrypted: backup.StorageEncrypted, limitless };
}

/** What the handler's snapshot read treats as a missing permission (`ACCESS_DENIED_RULE_SET`). */
const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'NotAuthorized',
  'UnauthorizedOperation',
]);

/**
 * Whether the snapshot is an Aurora Limitless Database cluster's, as
 * CloudFormation's create reads it before a snapshot restore
 * (`getClusterScalabilityTypeFromSnapshot`; the engine version's `-limitless`
 * suffix picks the request shape). A DB instance snapshot's ARN is not read
 * (a standard restore). A denied read restores as standard, as the handler's
 * `fetchResourceForValidation` lets it; any other failure, a snapshot it does
 * not find among the account's, shared and public ones included, stops the
 * create before anything is made. The handler checks no encryption here.
 */
export async function readSnapshotIsLimitless(
  this: RDSProvider,
  snapshotIdentifier: string,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<boolean> {
  // `ArnHelper.getResourceType`: the resource type is matched exactly, before `:` or `/`.
  if (/^arn:[^:]*:rds:[^:]*:[^:]*:snapshot[:/]/.test(snapshotIdentifier)) return false;
  let found = false;
  let engineVersion: string | undefined;
  try {
    const response = await this.getClient().send(
      new DescribeDBClusterSnapshotsCommand({
        DBClusterSnapshotIdentifier: snapshotIdentifier,
        IncludeShared: true,
        IncludePublic: true,
      })
    );
    const snapshot = response.DBClusterSnapshots?.[0];
    found = snapshot !== undefined;
    engineVersion = snapshot?.EngineVersion;
  } catch (error) {
    if (ACCESS_DENIED_CODES.has(awsErrorName(error))) {
      this.logger.warn(
        safeMsg`DBCluster ${logicalId}: could not read the restore snapshot (${awsErrorName(error)}), so it is restored as a standard (not limitless) cluster, as in CloudFormation.`
      );
      return false;
    }
    if (!this.isNotFoundError(error, 'DBClusterSnapshotNotFoundFault')) {
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create DBCluster ${logicalId}: reading the restore snapshot failed, so nothing was changed: ${text}`,
            resourceType,
            logicalId,
            undefined,
            error instanceof Error ? error : undefined
          )
      );
    }
  }
  if (!found) {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${logicalId}: SnapshotIdentifier ${snapshotIdentifier} does not name a DB cluster snapshot this account can read, so there is nothing to restore; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  }
  return isLimitlessEngineVersion(engineVersion);
}

/**
 * CloudFormation's encryption checks before a restore
 * (`CreateHandler.validateStorageEncryption`), each refused with its message:
 * encrypting an unencrypted source needs a `KmsKeyId`, an encrypted source
 * cannot restore unencrypted, and a `KmsKeyId` needs `StorageEncrypted` not
 * false. Neither restore call has a `StorageEncrypted` member.
 */
export function refuseRestoreEncryption(
  properties: Record<string, unknown>,
  source: { StorageEncrypted?: boolean | undefined },
  resourceType: string,
  logicalId: string
): void {
  const desired = coerceCfnBoolean(properties['StorageEncrypted']);
  const kmsKeyId = properties['KmsKeyId'];
  const hasKey = typeof kmsKeyId === 'string' ? kmsKeyId !== '' : kmsKeyId != null;
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        `${resourceType} ${logicalId}: ${reason} Nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  if (source.StorageEncrypted === false && desired === true && !hasKey) {
    refuse(
      "StorageEncrypted is true but the restore source is not encrypted and no KmsKeyId is set: you can't create an encrypted DB cluster from an unencrypted source without a KMS key. Set KmsKeyId (alias/aws/rds is the default key), as CloudFormation requires."
    );
  }
  if (source.StorageEncrypted === true && desired === false) {
    refuse(
      'StorageEncrypted is false but the restore source is encrypted: a restore of an encrypted source is encrypted. Set StorageEncrypted to true or remove it, as CloudFormation requires.'
    );
  }
  if (desired === false && hasKey) {
    refuse(
      'a KmsKeyId is set while StorageEncrypted is false: a restore encrypts with the key. Set StorageEncrypted to true or remove the KmsKeyId, as CloudFormation requires.'
    );
  }
}

/** Whether the source is an Aurora Limitless Database cluster, which the handler restores apart. */
export function isLimitlessSource(source: DBCluster): boolean {
  return source.ClusterScalabilityType === 'limitless';
}

/**
 * The members both restore calls take from the template, each declared value
 * of the keys cdkd's SDK route handles (a key it does not routes the resource
 * to Cloud Control), as CloudFormation's `Translator` sends them in
 * `restoreDbClusterToPointInTimeRequest` and `restoreDbClusterFromSnapshotRequest`.
 */
function sharedRestoreMembers(
  properties: Record<string, unknown>,
  tags: Tag[],
  logExports: string[] | undefined
): Partial<RestoreDBClusterToPointInTimeCommandInput & RestoreDBClusterFromSnapshotCommandInput> {
  const string = (key: string): string | undefined =>
    properties[key] != null ? (properties[key] as string) : undefined;
  const scaling = properties['ServerlessV2ScalingConfiguration'] as
    | ServerlessV2ScalingProps
    | undefined;
  const multiAz = clusterCreateMultiAzMembers(properties);
  const backfill = clusterCreateBackfillMembers(properties);
  const engineLifecycleSupport = engineLifecycleSupportOf(properties);
  return {
    ...(backfill.CopyTagsToSnapshot !== undefined && {
      CopyTagsToSnapshot: backfill.CopyTagsToSnapshot,
    }),
    ...(multiAz.DBClusterInstanceClass !== undefined && {
      DBClusterInstanceClass: multiAz.DBClusterInstanceClass,
    }),
    ...(multiAz.Iops !== undefined && { Iops: multiAz.Iops }),
    ...(string('DBSubnetGroupName') !== undefined && {
      DBSubnetGroupName: string('DBSubnetGroupName'),
    }),
    ...(logExports !== undefined &&
      logExports.length > 0 && { EnableCloudwatchLogsExports: logExports }),
    ...(string('KmsKeyId') !== undefined && { KmsKeyId: string('KmsKeyId') }),
    ...(string('NetworkType') !== undefined && { NetworkType: string('NetworkType') }),
    ...(properties['Port'] != null && { Port: Number(properties['Port']) }),
    ...(properties['PubliclyAccessible'] != null && {
      PubliclyAccessible: properties['PubliclyAccessible'] as boolean,
    }),
    ...(scaling != null && {
      ServerlessV2ScalingConfiguration: serverlessV2ScalingToSend(scaling),
    }),
    ...(backfill.StorageType !== undefined && { StorageType: backfill.StorageType }),
    ...(properties['VpcSecurityGroupIds'] != null && {
      VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[],
    }),
    ...(engineLifecycleSupport !== undefined && { EngineLifecycleSupport: engineLifecycleSupport }),
    ...(tags.length > 0 && { Tags: tags }),
  };
}

/**
 * What a limitless source adds to either restore call: the monitoring and
 * Performance Insights members (`restoreLimitlessDbClusterToPointInTimeRequest`,
 * `restoreLimitlessDbClusterFromSnapshotRequest`).
 */
function limitlessRestoreMembers(
  properties: Record<string, unknown>
): Pick<
  RestoreDBClusterToPointInTimeCommandInput,
  | 'MonitoringRoleArn'
  | 'MonitoringInterval'
  | 'EnablePerformanceInsights'
  | 'PerformanceInsightsRetentionPeriod'
  | 'PerformanceInsightsKMSKeyId'
> {
  const scalars = clusterCreateScalarMembers(properties);
  return {
    ...(properties['MonitoringRoleArn'] != null && {
      MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
    }),
    ...(properties['MonitoringInterval'] != null && {
      MonitoringInterval: Number(properties['MonitoringInterval']),
    }),
    ...(scalars.EnablePerformanceInsights !== undefined && {
      EnablePerformanceInsights: scalars.EnablePerformanceInsights,
    }),
    ...(scalars.PerformanceInsightsRetentionPeriod !== undefined && {
      PerformanceInsightsRetentionPeriod: scalars.PerformanceInsightsRetentionPeriod,
    }),
    ...(scalars.PerformanceInsightsKMSKeyId !== undefined && {
      PerformanceInsightsKMSKeyId: scalars.PerformanceInsightsKMSKeyId,
    }),
  };
}

/** Drops the members a spread left `undefined`, so a request carries only what is sent. */
function definedMembers<T extends object>(members: T): T {
  return Object.fromEntries(
    Object.entries(members).filter(([, value]) => value !== undefined)
  ) as T;
}

/**
 * The `RestoreDBClusterToPointInTime` input, member for member what
 * CloudFormation's `Translator.restoreDbClusterToPointInTimeRequest` sends
 * ({@link sharedRestoreMembers}, the source and the point-in-time keys), and
 * for a limitless source {@link limitlessRestoreMembers}.
 */
export function pointInTimeRestoreInput(
  properties: Record<string, unknown>,
  restore: ClusterPointInTimeRestore,
  dbClusterIdentifier: string,
  tags: Tag[],
  logExports: string[] | undefined,
  limitless: boolean
): RestoreDBClusterToPointInTimeCommandInput {
  return definedMembers({
    ...sharedRestoreMembers(properties, tags, logExports),
    DBClusterIdentifier: dbClusterIdentifier,
    ...(restore.source.by === 'identifier'
      ? { SourceDBClusterIdentifier: restore.source.value }
      : { SourceDbClusterResourceId: restore.source.value }),
    RestoreType: restore.restoreType,
    UseLatestRestorableTime: restore.useLatestRestorableTime,
    RestoreToTime: restore.restoreToTime,
    ...(limitless && limitlessRestoreMembers(properties)),
  });
}

/**
 * The `RestoreDBClusterFromSnapshot` input, member for member what
 * CloudFormation's `Translator.restoreDbClusterFromSnapshotRequest` sends
 * ({@link sharedRestoreMembers}, the snapshot, the zones, the engine, version
 * and mode, the database name, the parameter group, deletion protection, IAM
 * authentication and the backtrack window), and for a limitless snapshot
 * {@link limitlessRestoreMembers}. `availabilityZones` is the create's
 * validated list.
 */
export function snapshotRestoreInput(
  properties: Record<string, unknown>,
  restore: ClusterSnapshotRestore,
  dbClusterIdentifier: string,
  tags: Tag[],
  logExports: string[] | undefined,
  availabilityZones: string[] | undefined,
  limitless: boolean
): RestoreDBClusterFromSnapshotCommandInput {
  const string = (key: string): string | undefined =>
    properties[key] != null ? (properties[key] as string) : undefined;
  const boolean = (key: string): boolean | undefined =>
    properties[key] != null ? (properties[key] as boolean) : undefined;
  return definedMembers({
    ...sharedRestoreMembers(properties, tags, logExports),
    DBClusterIdentifier: dbClusterIdentifier,
    SnapshotIdentifier: restore.snapshotIdentifier,
    Engine: string('Engine'),
    EngineVersion: string('EngineVersion'),
    EngineMode: string('EngineMode'),
    DatabaseName: string('DatabaseName'),
    DBClusterParameterGroupName:
      clusterCreateBackfillMembers(properties).DBClusterParameterGroupName,
    DeletionProtection: boolean('DeletionProtection'),
    EnableIAMDatabaseAuthentication: boolean('EnableIAMDatabaseAuthentication'),
    BacktrackWindow: clusterCreateScalarMembers(properties).BacktrackWindow,
    ...(availabilityZones !== undefined &&
      availabilityZones.length > 0 && { AvailabilityZones: availabilityZones }),
    ...(limitless && limitlessRestoreMembers(properties)),
  });
}

/** What a restore call is built from beside the template. */
export interface ClusterRestoreCall {
  dbClusterIdentifier: string;
  tags: Tag[];
  logExports: string[] | undefined;
  /** The create's validated `AvailabilityZones`. */
  availabilityZones: string[] | undefined;
  limitless: boolean;
}

/** Sends the restore call `restore` makes, on the create client. */
export async function sendClusterRestore(
  this: RDSProvider,
  properties: Record<string, unknown>,
  restore: ClusterRestore,
  call: ClusterRestoreCall
): Promise<{ DBCluster?: DBCluster | undefined }> {
  const { dbClusterIdentifier, tags, logExports, availabilityZones, limitless } = call;
  return restore.kind === 'snapshot'
    ? this.getCreateClient().send(
        new RestoreDBClusterFromSnapshotCommand(
          snapshotRestoreInput(
            properties,
            restore,
            dbClusterIdentifier,
            tags,
            logExports,
            availabilityZones,
            limitless
          )
        )
      )
    : this.getCreateClient().send(
        new RestoreDBClusterToPointInTimeCommand(
          pointInTimeRestoreInput(
            properties,
            restore,
            dbClusterIdentifier,
            tags,
            logExports,
            limitless
          )
        )
      );
}

/** The `ModifyDBCluster` members sent once a restored cluster is `available`. */
export type ClusterRestoreFollowUp = Omit<ModifyDBClusterCommandInput, 'DBClusterIdentifier'>;

/** What `ModelAdapter.setDefaults` fills for an absent `BackupRetentionPeriod`. */
const DEFAULT_BACKUP_RETENTION_PERIOD = 1;

/**
 * The `ModifyDBCluster` CloudFormation sends after a restore
 * (`Translator.modifyDbClusterAfterCreateRequest`, from
 * `ResourceModelHelper.shouldUpdateAfterCreate`), each declared value of the
 * keys cdkd handles: the restore call takes none of the settings below, so
 * the handler applies them here. `BackupRetentionPeriod` is always sent, 1
 * when absent, as `ModelAdapter.setDefaults` fills it. An Aurora Serverless v1
 * (`EngineMode: serverless`) cluster takes the Data API flag here instead of
 * the storage size, backtrack window, IAM authentication and backup window. A
 * limitless source drops the members its `ModifyDBCluster` refuses
 * (`modifyLimitlessDbClusterAfterCreateRequest`). The engine version, master
 * user name and database name stay the source's: no call sets them.
 */
export function restoreFollowUp(
  properties: Record<string, unknown>,
  logExports: string[] | undefined,
  limitless: boolean
): ClusterRestoreFollowUp {
  const multiAz = clusterCreateMultiAzMembers(properties);
  const backfill = clusterCreateBackfillMembers(properties);
  // Neither of the last two is a member of the handler's follow-up.
  const {
    EngineLifecycleSupport: _lifecycle,
    MasterUserAuthenticationType: _authentication,
    BacktrackWindow: backtrackWindow,
    ...scalars
  } = clusterCreateScalarMembers(properties);
  const serverlessV1 = properties['EngineMode'] === 'serverless';
  const managed = coerceCfnBoolean(properties['ManageMasterUserPassword']) === true;
  const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;
  const allocatedStorage = clusterSizeValue(properties['AllocatedStorage']);
  const members: ClusterRestoreFollowUp = {
    ...scalars,
    BackupRetentionPeriod:
      properties['BackupRetentionPeriod'] != null
        ? Number(properties['BackupRetentionPeriod'])
        : DEFAULT_BACKUP_RETENTION_PERIOD,
    ...(logExports !== undefined &&
      logExports.length > 0 && {
        CloudwatchLogsExportConfiguration: { EnableLogTypes: logExports },
      }),
    ...backfill,
    ...(multiAz.DBClusterInstanceClass !== undefined && {
      DBClusterInstanceClass: multiAz.DBClusterInstanceClass,
    }),
    ...(multiAz.Iops !== undefined && { Iops: multiAz.Iops }),
    ...(properties['DeletionProtection'] != null && {
      DeletionProtection: properties['DeletionProtection'] as boolean,
    }),
    ...(properties['MasterUserPassword'] != null && {
      MasterUserPassword: properties['MasterUserPassword'] as string,
    }),
    ...(properties['MonitoringInterval'] != null && {
      MonitoringInterval: Number(properties['MonitoringInterval']),
    }),
    ...(properties['MonitoringRoleArn'] != null && {
      MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
    }),
    ...(serverlessV1
      ? properties['EnableHttpEndpoint'] != null && {
          EnableHttpEndpoint: coerceCfnBoolean(properties['EnableHttpEndpoint']),
        }
      : {
          ...(typeof allocatedStorage === 'number' && { AllocatedStorage: allocatedStorage }),
          ...(backtrackWindow !== undefined && { BacktrackWindow: backtrackWindow }),
          ...(properties['EnableIAMDatabaseAuthentication'] != null && {
            EnableIAMDatabaseAuthentication: properties[
              'EnableIAMDatabaseAuthentication'
            ] as boolean,
          }),
        }),
    ...(managed && {
      ManageMasterUserPassword: true,
      ...(masterUserSecret?.KmsKeyId !== undefined && {
        MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
      }),
    }),
  };
  // The handler sends the backup window outside Serverless v1 only.
  if (serverlessV1) delete members.PreferredBackupWindow;
  if (limitless) {
    delete members.StorageType;
    delete members.EnablePerformanceInsights;
    delete members.PerformanceInsightsKMSKeyId;
    delete members.CloudwatchLogsExportConfiguration;
  }
  return members;
}

/**
 * How long a restore waits for `available`: as a create, or to the resource
 * deadline when `--resource-timeout` allows more, since it copies the source.
 */
export function restoreWaitMs(): number {
  const remaining = enclosingDeadlineRemainingMs() - 30_000;
  return Number.isFinite(remaining) ? Math.max(1_800_000, remaining) : 1_800_000;
}

/**
 * Sends the follow-up `ModifyDBCluster` with `ApplyImmediately`, as the
 * handler does, resending one refused as not `available` (#5194's rule). A
 * refusal fails the create, as it fails CloudFormation's.
 */
export async function sendRestoreFollowUp(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  members: ClusterRestoreFollowUp
): Promise<void> {
  await modifyDbInstanceWhenAvailable({
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
    label: 'DBCluster',
    subject: 'cluster',
    action: 'create',
    logicalId,
    remainingMs: enclosingDeadlineRemainingMs(),
  });
}
