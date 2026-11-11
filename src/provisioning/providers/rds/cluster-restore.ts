import {
  DescribeDBClustersCommand,
  ModifyDBClusterCommand,
  type DBCluster,
  type ModifyDBClusterCommandInput,
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

/**
 * go-to-k/cdkd#5639: a DBCluster created from another cluster's backups. Read
 * from CloudFormation's handler (the archived
 * `aws-cloudformation-resource-providers-rds` `aws-rds-dbcluster`, not
 * measured): a non-empty `SourceDBClusterIdentifier` makes the create a
 * `RestoreDBClusterToPointInTime` (`ResourceModelHelper.isRestoreToPointInTime`)
 * instead of a `CreateDBCluster`, whatever the other keys say.
 */
export interface ClusterPointInTimeRestore {
  sourceDBClusterIdentifier: string;
  /** Sent only when `UseLatestRestorableTime` is not true, as the handler sends it. */
  restoreToTime: Date | undefined;
  /** The declared flag, `undefined` when absent (the handler sends it as declared). */
  useLatestRestorableTime: boolean | undefined;
  restoreType: string | undefined;
}

/**
 * The shape `java.time.ZonedDateTime.parse` takes, which the handler's
 * `Validations.validateTimestamp` applies to any non-blank `RestoreToTime`:
 * ISO 8601 date and time, either case of `T` / `Z`, a `Z` or `+hh:mm[:ss]`
 * offset, and an optional `[Region/Zone]` suffix. No space separator and no
 * `+hhmm`: Java refuses both.
 */
const ZONED_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2}):(\d{2})(?::(\d{2}))?)(?:\[[^\]]+\])?$/;

/** A `RestoreToTime` as the instant it names, or `undefined` when Java would refuse it. */
export function parseZonedTimestamp(text: string): Date | undefined {
  const match = ZONED_DATE_TIME.exec(text);
  if (match === null) return undefined;
  const n = (i: number): number => (match[i] === undefined ? 0 : Number(match[i]));
  const [year, month, day, hour, minute, second] = [n(1), n(2), n(3), n(4), n(5), n(6)];
  const [offsetHours, offsetMinutes, offsetSeconds] = [n(9), n(10), n(11)];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  if (offsetHours > 18 || offsetMinutes > 59 || offsetSeconds > 59) return undefined;
  // Java resolves strictly: 2026-02-30 is refused, not rolled into March.
  if (day < 1 || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return undefined;
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const offsetMs =
    (match[8] === '-' ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds) * 1000;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMs);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The point-in-time restore a template declares, `undefined` for a plain
 * create. Each refusal is one CloudFormation fails the create with too
 * (`RestoreToTime` that `ZonedDateTime` cannot parse, on ANY create, as its
 * `validateRequest` reads it before choosing the call), or a schema type it
 * refuses. They hold on a state replay too: CloudFormation refuses each, so no
 * record of one was written by a deploy it would accept, and falling through
 * would make an EMPTY cluster where a restore was meant.
 *
 * `UseLatestRestorableTime: true` beside a `RestoreToTime` restores to the
 * latest time and leaves the timestamp out, as the handler does; a source
 * with neither is sent as it is, AWS deciding (the handler sends it so too).
 */
export function readClusterRestore(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): ClusterPointInTimeRestore | undefined {
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
  const restoreType = properties['RestoreType'];
  if (restoreType != null && typeof restoreType !== 'string') {
    return refuse('RestoreType must be a string');
  }
  const source = properties['SourceDBClusterIdentifier'];
  if (source == null) return undefined;
  if (typeof source !== 'string') return refuse('SourceDBClusterIdentifier must be a string');
  if (source === '') return undefined;
  return {
    sourceDBClusterIdentifier: source,
    restoreToTime: useLatestRestorableTime === true ? undefined : restoreToTime,
    useLatestRestorableTime,
    restoreType: restoreType === '' ? undefined : (restoreType as string | undefined),
  };
}

/**
 * The declared keys a create of this kind does not apply, as CloudFormation's
 * does not: on a plain create the point-in-time keys; on a restore the keys
 * neither `RestoreDBClusterToPointInTime` nor the handler's follow-up
 * `ModifyDBCluster` carries (the source decides them, or nothing does), and a
 * `RestoreToTime` that `UseLatestRestorableTime: true` overrides. The engine,
 * version, master user, database name and engine mode are named instead by
 * {@link restoredDifferences}, against the restored cluster.
 */
export function unusedRestoreKeys(
  properties: Record<string, unknown>,
  restore: ClusterPointInTimeRestore | undefined
): string[] {
  const keys =
    restore === undefined
      ? ['RestoreType', 'RestoreToTime', 'UseLatestRestorableTime']
      : [
          'AvailabilityZones',
          'GlobalClusterIdentifier',
          'WithExpressConfiguration',
          'ClusterScalabilityType',
          'MasterUserAuthenticationType',
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
 */
export function restoredDifferences(
  properties: Record<string, unknown>,
  cluster: DBCluster
): string[] {
  const pairs: Array<[string, string | undefined]> = [
    ['Engine', cluster.Engine],
    ['EngineVersion', cluster.EngineVersion],
    ['EngineMode', cluster.EngineMode],
    ['MasterUsername', cluster.MasterUsername],
    ['DatabaseName', cluster.DatabaseName],
  ];
  return pairs
    .filter(
      ([key, live]) =>
        properties[key] != null &&
        properties[key] !== '' &&
        live !== undefined &&
        String(properties[key]) !== live
    )
    .map(([key]) => key);
}

/**
 * The source cluster, as CloudFormation's create reads it before restoring
 * (`fetchSourceDBCluster`; its scalability type picks the request shape, its
 * encryption is validated against the template). A cross-account ARN is not
 * found by name, so an ARN not found is looked up among the clusters shared
 * with the account, as the handler does. Any failure stops the create before
 * anything is made, as the handler's unguarded read does.
 */
export async function readRestoreSource(
  this: RDSProvider,
  source: string,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<DBCluster> {
  const failed = (error: unknown): ProvisioningError =>
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
    if (!this.isNotFoundError(error, 'DBClusterNotFoundFault')) throw failed(error);
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
      throw failed(error);
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

/**
 * CloudFormation's encryption checks before a restore
 * (`CreateHandler.validateStorageEncryption`), each refused with its message:
 * encrypting an unencrypted source needs a `KmsKeyId`, an encrypted source
 * cannot restore unencrypted, and a `KmsKeyId` needs `StorageEncrypted` not
 * false. Neither restore call has a `StorageEncrypted` member.
 */
export function refuseRestoreEncryption(
  properties: Record<string, unknown>,
  source: DBCluster,
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
 * The `RestoreDBClusterToPointInTime` input, member for member what
 * CloudFormation's `Translator.restoreDbClusterToPointInTimeRequest` sends,
 * limited to the keys cdkd's SDK route handles (a key it does not routes the
 * resource to Cloud Control): each declared value. A limitless source also
 * takes the monitoring and Performance Insights members
 * (`restoreLimitlessDbClusterToPointInTimeRequest`).
 */
export function pointInTimeRestoreInput(
  properties: Record<string, unknown>,
  restore: ClusterPointInTimeRestore,
  dbClusterIdentifier: string,
  tags: Tag[],
  logExports: string[] | undefined,
  limitless: boolean
): RestoreDBClusterToPointInTimeCommandInput {
  const string = (key: string): string | undefined =>
    properties[key] != null ? (properties[key] as string) : undefined;
  const scaling = properties['ServerlessV2ScalingConfiguration'] as
    | ServerlessV2ScalingProps
    | undefined;
  const multiAz = clusterCreateMultiAzMembers(properties);
  const backfill = clusterCreateBackfillMembers(properties);
  const scalars = clusterCreateScalarMembers(properties);
  const engineLifecycleSupport = engineLifecycleSupportOf(properties);
  return {
    DBClusterIdentifier: dbClusterIdentifier,
    SourceDBClusterIdentifier: restore.sourceDBClusterIdentifier,
    ...(restore.restoreType !== undefined && { RestoreType: restore.restoreType }),
    ...(restore.useLatestRestorableTime !== undefined && {
      UseLatestRestorableTime: restore.useLatestRestorableTime,
    }),
    ...(restore.restoreToTime !== undefined && { RestoreToTime: restore.restoreToTime }),
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
    ...(limitless && {
      ...(string('MonitoringRoleArn') !== undefined && {
        MonitoringRoleArn: string('MonitoringRoleArn'),
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
    }),
  };
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
export function pointInTimeRestoreFollowUp(
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
