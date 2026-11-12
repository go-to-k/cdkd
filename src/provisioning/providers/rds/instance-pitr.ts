import {
  DescribeDBInstanceAutomatedBackupsCommand,
  DescribeDBInstancesCommand,
  type DBInstanceAutomatedBackup,
  type ProcessorFeature,
  type RestoreDBInstanceToPointInTimeCommandInput,
  type Tag,
} from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import {
  POINT_IN_TIME_NO_SOURCE_REASON,
  declaresInstancePointInTime,
  pointInTimeTemplateRefusal,
} from '../../restore-source-guard.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../types/resource.js';
import type { RDSProvider } from '../rds-provider.js';
import { parseZonedTimestamp } from './zoned-timestamp.js';
import { engineLifecycleSupportOf } from './instance-members.js';
import { describeReplicaSource } from './read-replica.js';

/**
 * go-to-k/cdkd#5640: the point-in-time restore of an `AWS::RDS::DBInstance`,
 * following CloudFormation's RDS handler (the archived
 * `aws-cloudformation-resource-providers-rds`, `aws-rds-dbinstance`
 * `CreateHandler`, `Translator`, `ResourceModelHelper`, `ImmutabilityHelper`;
 * read from the source, not measured):
 *
 * - CREATE: `UseLatestRestorableTime: true`, or a non-empty `RestoreTime`,
 *   `SourceDBInstanceAutomatedBackupsArn` or `SourceDbiResourceId`, makes the
 *   create a `RestoreDBInstanceToPointInTime`
 *   (`ResourceModelHelper.isRestoreToPointInTime`), tested BEFORE a read
 *   replica's source and the snapshot keys: a `SourceDBInstanceIdentifier`
 *   beside one of them is the restore's source, not a replica's.
 * - A `RestoreTime` that `java.time.ZonedDateTime` cannot parse fails any
 *   create (`Validations.validateTimestamp` in `validateRequest`).
 * - The engine, when the template declares none, is the source's
 *   (`fetchEngine`): the source instance, else the instance holding the
 *   `SourceDbiResourceId`, else the automated backup. With none of the three
 *   the handler fails the create ("Cannot fetch the engine").
 * - The members the restore call has no room for go out in the same
 *   after-create `ModifyDBInstance` a replica or a snapshot restore gets
 *   (`shouldUpdateAfterCreate` covers all three; `./read-replica.ts`).
 * - UPDATE: an added or changed key fails "Resource is immutable"
 *   (`isRestoreTimeMutable`, `isUseLatestRestorableTimeMutable`,
 *   `isSourceDBInstanceAutomatedBackupsArnMutable`, `isSourceDbiResourceIdMutable`);
 *   a removed one (or `UseLatestRestorableTime` turned false) changes nothing.
 *   None is ever sent on an update.
 * - DRIFT: none is read back.
 */

/** The keys whose value makes a create a point-in-time restore. */
export const POINT_IN_TIME_KEYS = [
  'RestoreTime',
  'UseLatestRestorableTime',
  'SourceDBInstanceAutomatedBackupsArn',
  'SourceDbiResourceId',
] as const;

export interface InstancePointInTimeRestore {
  /** The parsed `RestoreTime`; sent beside `UseLatestRestorableTime` too, as the handler sends both. */
  restoreTime: Date | undefined;
  /** The declared flag, `undefined` when absent (sent as declared). */
  useLatestRestorableTime: boolean | undefined;
  sourceDBInstanceIdentifier: string | undefined;
  sourceDbiResourceId: string | undefined;
  sourceDBInstanceAutomatedBackupsArn: string | undefined;
}

/**
 * Whether a bag declares a point-in-time restore, as
 * `ResourceModelHelper.isRestoreToPointInTime` reads it. No refusal: the
 * update, drift and replacement paths ask it of recorded bags. The predicate
 * lives in the restore-source guard, a leaf the deploy engine loads.
 */
export function declaresPointInTimeRestore(
  properties: Record<string, unknown> | undefined
): boolean {
  return properties !== undefined && declaresInstancePointInTime(properties);
}

/**
 * The point-in-time restore a template declares, `undefined` when it declares
 * none. Each refusal is one CloudFormation fails the create with too (a
 * `RestoreTime` `ZonedDateTime` cannot parse, on ANY create, as its
 * `validateRequest` reads it first) or a schema type it refuses. They hold on
 * a state replay too: no record of one was written by a deploy CloudFormation
 * would accept, and falling through would create an EMPTY instance where a
 * restore was meant.
 */
export function readInstancePointInTimeRestore(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): InstancePointInTimeRestore | undefined {
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${logicalId}: ${reason}, as CloudFormation requires; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  // The template-only checks the replacement guard also runs before a delete
  // (`pointInTimeTemplateRefusal`); a missing engine source is the engine
  // read's to refuse.
  const reason = pointInTimeTemplateRefusal(properties);
  if (reason !== undefined && reason !== POINT_IN_TIME_NO_SOURCE_REASON) return refuse(reason);
  const declaredTime = properties['RestoreTime'];
  // A blank one passes `validateTimestamp` (`isNotBlank`) and goes out as no
  // time (the Translator's `isNotBlank`), yet still makes the create a
  // point-in-time restore (`hasValue`), as below.
  const restoreTime =
    typeof declaredTime === 'string' && declaredTime.trim() !== ''
      ? parseZonedTimestamp(declaredTime)
      : undefined;
  const useLatestRestorableTime =
    properties['UseLatestRestorableTime'] == null
      ? undefined
      : coerceCfnBoolean(properties['UseLatestRestorableTime']);
  // A string key as the handler's `StringUtils.hasValue` reads it: empty is unset.
  const stringKey = (key: string): string | undefined => {
    const value = properties[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const sourceDBInstanceAutomatedBackupsArn = stringKey('SourceDBInstanceAutomatedBackupsArn');
  const sourceDbiResourceId = stringKey('SourceDbiResourceId');
  // The handler's predicate (`hasValue`: a blank `RestoreTime` counts), shared
  // with the update, drift and replacement paths.
  if (!declaresInstancePointInTime(properties)) return undefined;
  // `refuseMalformedReplicaSource` already refused a non-string.
  const source = properties['SourceDBInstanceIdentifier'];
  return {
    restoreTime,
    useLatestRestorableTime,
    sourceDBInstanceIdentifier: typeof source === 'string' && source !== '' ? source : undefined,
    sourceDbiResourceId,
    sourceDBInstanceAutomatedBackupsArn,
  };
}

/**
 * The engine a point-in-time restore sends: the declared one, else the
 * source's, read as the handler's `fetchEngine` reads it (the source instance
 * from its own region, then the instance holding the resource id, then the
 * automated backup). A source the read does not list is refused before
 * anything is made; any other failure stops the create the same way, as the
 * handler's `DB_INSTANCE_FETCH_ENGINE_RULE_SET` fails it.
 */
export async function pointInTimeRestoreEngine(
  this: RDSProvider,
  properties: Record<string, unknown>,
  restore: InstancePointInTimeRestore,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<string | undefined> {
  const declaredEngine = properties['Engine'];
  if (typeof declaredEngine === 'string' && declaredEngine !== '') return declaredEngine;
  const masked = mask ?? ((text: string) => text);
  const wrapReadError = (what: string, error: unknown): ProvisioningError =>
    this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create DBInstance ${logicalId}: reading the ${what} failed, so nothing was changed: ${text}`,
          resourceType,
          logicalId,
          undefined,
          error instanceof Error ? error : undefined
        )
    );
  const refuseNotFound = (key: string, value: string, noun: string, why?: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        masked(
          why === undefined
            ? safeMsg`${resourceType} ${logicalId}: ${key} ${value} does not name ${noun} this account can read, so there is nothing to restore; nothing was changed.`
            : safeMsg`${resourceType} ${logicalId}: ${key} ${value} ${why}; nothing was changed.`
        ),
        resourceType,
        logicalId
      )
    );
  };
  const read = async <T>(
    what: string,
    notFoundFault: string,
    call: () => Promise<T | undefined>
  ): Promise<T | undefined> => {
    try {
      return await call();
    } catch (error) {
      if (this.isNotFoundError(error, notFoundFault)) return undefined;
      throw wrapReadError(what, error);
    }
  };
  if (restore.sourceDBInstanceIdentifier !== undefined) {
    const source = restore.sourceDBInstanceIdentifier;
    const instance = await read('restore source', 'DBInstanceNotFoundFault', () =>
      describeReplicaSource.call(this, source)
    );
    if (instance === undefined) {
      return refuseNotFound('SourceDBInstanceIdentifier', source, 'a DB instance');
    }
    return instance.Engine;
  }
  if (restore.sourceDbiResourceId !== undefined) {
    const resourceId = restore.sourceDbiResourceId;
    const instance = await read('restore source', 'DBInstanceNotFoundFault', async () => {
      const response = await this.getClient().send(
        new DescribeDBInstancesCommand({
          Filters: [{ Name: 'dbi-resource-id', Values: [resourceId] }],
        })
      );
      return response.DBInstances?.[0];
    });
    if (instance === undefined) {
      // A deleted instance's retained backups are a valid source, but the
      // handler's `fetchEngine` reads only a live instance and fails here too.
      return refuseNotFound(
        'SourceDbiResourceId',
        resourceId,
        'a DB instance',
        "names no live DB instance this account can read, so cdkd cannot read the engine to restore; declare Engine (a deleted instance's retained automated backups restore with it declared), as CloudFormation requires"
      );
    }
    return instance.Engine;
  }
  if (restore.sourceDBInstanceAutomatedBackupsArn !== undefined) {
    const arn = restore.sourceDBInstanceAutomatedBackupsArn;
    const backup = await read(
      'restore automated backup',
      'DBInstanceAutomatedBackupNotFoundFault',
      async () => {
        const response = await this.getClient().send(
          new DescribeDBInstanceAutomatedBackupsCommand({ DBInstanceAutomatedBackupsArn: arn })
        );
        return response.DBInstanceAutomatedBackups?.[0];
      }
    );
    if (backup === undefined) {
      return refuseNotFound('SourceDBInstanceAutomatedBackupsArn', arn, 'an automated backup');
    }
    return backup.Engine;
  }
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`${resourceType} ${logicalId}: ${POINT_IN_TIME_NO_SOURCE_REASON}. Nothing was changed.`,
      resourceType,
      logicalId
    )
  );
}

/** The handler's `isSqlServer`: an unknown engine counts as SQL Server. */
function isSqlServer(engine: string | undefined): boolean {
  return engine === undefined || engine.includes('sqlserver');
}

function isOracleCdbEngine(engine: string | undefined): boolean {
  return engine === 'oracle-ee-cdb' || engine === 'oracle-se2-cdb';
}

/** What {@link pointInTimeRestoreInput} needs beyond the declared bag. */
export interface PointInTimeRestoreParts {
  readonly identifier: string;
  readonly restore: InstancePointInTimeRestore;
  readonly engine: string | undefined;
  readonly tags: Tag[];
  readonly logExports: string[] | undefined;
  readonly processor: {
    features?: ProcessorFeature[] | undefined;
    useDefault?: boolean | undefined;
  };
}

/**
 * `RestoreDBInstanceToPointInTime`, as `Translator.restoreDbInstanceToPointInTimeRequest`
 * builds it from the declared members cdkd's SDK route handles (an undeclared
 * one is left out). The storage members go out unless the engine is SQL
 * Server (they then ride the after-create ModifyDBInstance), and an Oracle CDB
 * engine is left to the source (the follow-up sends it). `MultiAZ` goes out
 * only as declared: unlike the snapshot restore, the handler sets no default.
 */
export function pointInTimeRestoreInput(
  properties: Record<string, unknown>,
  parts: PointInTimeRestoreParts
): RestoreDBInstanceToPointInTimeCommandInput {
  const p = properties;
  const { restore, engine } = parts;
  const vpcSecurityGroups = p['VPCSecurityGroups'];
  const lifecycle = engineLifecycleSupportOf(p);
  return {
    TargetDBInstanceIdentifier: parts.identifier,
    ...(restore.sourceDBInstanceIdentifier !== undefined && {
      SourceDBInstanceIdentifier: restore.sourceDBInstanceIdentifier,
    }),
    ...(restore.sourceDbiResourceId !== undefined && {
      SourceDbiResourceId: restore.sourceDbiResourceId,
    }),
    ...(restore.sourceDBInstanceAutomatedBackupsArn !== undefined && {
      SourceDBInstanceAutomatedBackupsArn: restore.sourceDBInstanceAutomatedBackupsArn,
    }),
    ...(restore.restoreTime !== undefined && { RestoreTime: restore.restoreTime }),
    ...(restore.useLatestRestorableTime !== undefined && {
      UseLatestRestorableTime: restore.useLatestRestorableTime,
    }),
    ...(p['AutoMinorVersionUpgrade'] != null && {
      AutoMinorVersionUpgrade: p['AutoMinorVersionUpgrade'] as boolean,
    }),
    ...(p['AvailabilityZone'] != null && { AvailabilityZone: p['AvailabilityZone'] as string }),
    ...(p['CopyTagsToSnapshot'] != null && {
      CopyTagsToSnapshot: p['CopyTagsToSnapshot'] as boolean,
    }),
    ...(p['DBInstanceClass'] != null && { DBInstanceClass: p['DBInstanceClass'] as string }),
    ...(p['DBName'] != null && { DBName: p['DBName'] as string }),
    ...(p['DBParameterGroupName'] != null && {
      DBParameterGroupName: p['DBParameterGroupName'] as string,
    }),
    ...(p['DBSubnetGroupName'] != null && {
      DBSubnetGroupName: p['DBSubnetGroupName'] as string,
    }),
    ...(p['DedicatedLogVolume'] != null && {
      DedicatedLogVolume: p['DedicatedLogVolume'] as boolean,
    }),
    ...(p['DeletionProtection'] != null && {
      DeletionProtection: p['DeletionProtection'] as boolean,
    }),
    ...(parts.logExports !== undefined &&
      parts.logExports.length > 0 && { EnableCloudwatchLogsExports: parts.logExports }),
    ...(p['EnableIAMDatabaseAuthentication'] != null && {
      EnableIAMDatabaseAuthentication: p['EnableIAMDatabaseAuthentication'] as boolean,
    }),
    ...(engine !== undefined && !isOracleCdbEngine(engine) && { Engine: engine }),
    ...(p['LicenseModel'] != null && { LicenseModel: p['LicenseModel'] as string }),
    ...(p['MaxAllocatedStorage'] != null && {
      MaxAllocatedStorage: Number(p['MaxAllocatedStorage']),
    }),
    ...(p['MultiAZ'] != null && { MultiAZ: p['MultiAZ'] as boolean }),
    ...(p['NetworkType'] != null && { NetworkType: p['NetworkType'] as string }),
    ...(p['OptionGroupName'] != null && { OptionGroupName: p['OptionGroupName'] as string }),
    ...(p['Port'] != null && { Port: Number(p['Port']) }),
    ...(parts.processor.features !== undefined && { ProcessorFeatures: parts.processor.features }),
    ...(parts.processor.useDefault !== undefined && {
      UseDefaultProcessorFeatures: parts.processor.useDefault,
    }),
    ...(p['PubliclyAccessible'] != null && {
      PubliclyAccessible: p['PubliclyAccessible'] as boolean,
    }),
    ...(Array.isArray(vpcSecurityGroups) &&
      vpcSecurityGroups.length > 0 && { VpcSecurityGroupIds: vpcSecurityGroups as string[] }),
    ...(lifecycle !== undefined && { EngineLifecycleSupport: lifecycle }),
    ...(!isSqlServer(engine) && {
      ...(p['AllocatedStorage'] != null && { AllocatedStorage: Number(p['AllocatedStorage']) }),
      ...(p['Iops'] != null && { Iops: Number(p['Iops']) }),
      ...(p['StorageThroughput'] != null && { StorageThroughput: Number(p['StorageThroughput']) }),
      ...(p['StorageType'] != null && { StorageType: p['StorageType'] as string }),
    }),
    ...(parts.tags.length > 0 && { Tags: parts.tags }),
  };
}

/**
 * The declared keys a point-in-time restore does not apply: cdkd does not send
 * them on the restore, and the after-create ModifyDBInstance does not carry
 * them, so the source (or nothing) decides them (CloudFormation's archived
 * handler sends none of them either; some are newer
 * RestoreDBInstanceToPointInTime members than it). `MasterUsername` and
 * `StorageEncrypted` are compared against the restored instance instead
 * (`snapshotRestoredDifferences`).
 */
export function unusedPointInTimeRestoreKeys(properties: Record<string, unknown>): string[] {
  return [
    'KmsKeyId',
    'CharacterSetName',
    'NcharCharacterSetName',
    'Timezone',
    'AdditionalStorageVolumes',
    'DBClusterIdentifier',
    'PromotionTier',
    'MasterUserAuthenticationType',
  ].filter((key) => {
    const value = properties[key];
    if (value == null || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
  });
}

/**
 * The `DbiResourceId` of the instance an automated backups ARN backs up
 * (`DescribeDBInstanceAutomatedBackups`), for the replacement guard
 * (`deployment/restore-source-identity.ts`, through the provider's
 * `resourceIdentity`): `RESOURCE_NOT_FOUND` only on the not-found fault's
 * NAME or an empty list; `undefined` when the answer names no id, the ARN is
 * not an automated backup's, or the ARN or the client is in another region
 * than `expectedRegion` (as `resourceIdentity` answers); any other failure
 * throws. "Could not read" never reads as "gone": the caller lets the delete
 * through on `RESOURCE_NOT_FOUND`.
 */
export async function automatedBackupResourceId(
  this: RDSProvider,
  arn: string,
  expectedRegion: string
): Promise<string | ResourceNotFound | undefined> {
  if (!isAutomatedBackupsArn(arn)) return undefined;
  const arnRegion = arn.split(':')[3];
  if (arnRegion !== '' && arnRegion !== expectedRegion) return undefined;
  if ((await this.getClient().config.region()) !== expectedRegion) return undefined;
  let backups: DBInstanceAutomatedBackup[] | undefined;
  try {
    const response = await this.getClient().send(
      new DescribeDBInstanceAutomatedBackupsCommand({ DBInstanceAutomatedBackupsArn: arn })
    );
    backups = response.DBInstanceAutomatedBackups;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'DBInstanceAutomatedBackupNotFoundFault') {
      return RESOURCE_NOT_FOUND;
    }
    throw error;
  }
  if (backups === undefined || backups.length === 0) return RESOURCE_NOT_FOUND;
  const id = backups[0]?.DbiResourceId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** An RDS automated backups ARN (`arn:<partition>:rds:<region>:<account>:auto-backup:<id>`). */
export function isAutomatedBackupsArn(value: string): boolean {
  return /^arn:[^:]+:rds:[^:]*:[^:]*:auto-backup:.+$/.test(value);
}
