import {
  DescribeDBClusterSnapshotsCommand,
  DescribeDBSnapshotsCommand,
  type DBInstance,
  type ProcessorFeature,
  type RestoreDBInstanceFromDBSnapshotCommandInput,
  type Tag,
} from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import type { RDSProvider } from '../rds-provider.js';
import { engineLifecycleSupportOf } from './instance-members.js';

/**
 * go-to-k/cdkd#5640: `DBSnapshotIdentifier` and `DBClusterSnapshotIdentifier`
 * on `AWS::RDS::DBInstance`, the snapshot restore, following CloudFormation's
 * RDS handler (the archived `aws-cloudformation-resource-providers-rds`,
 * `aws-rds-dbinstance` `CreateHandler`, `Translator`, `ResourceModelHelper`,
 * `ImmutabilityHelper`; read from the source, not measured):
 *
 * - CREATE: a non-empty value of either key makes the create a
 *   `RestoreDBInstanceFromDBSnapshot` (`isRestoreFromSnapshot` /
 *   `isRestoreFromClusterSnapshot`), carrying both keys as declared. The
 *   point-in-time keys and a read replica's source are tested first: the
 *   point-in-time keys are still SDK-unwired (a template declaring one keeps
 *   the Cloud Control route), and a declared `SourceDBInstanceIdentifier`
 *   makes a read replica, which reads neither snapshot key.
 * - The engine, when the template declares none, is the snapshot's
 *   (`fetchEngine`: the DB snapshot when declared, else the cluster snapshot).
 *   A DB snapshot is also read when `MultiAZ` is not true: an undeclared
 *   `MultiAZ` is sent as `false`, except for `sqlserver-ee` / `sqlserver-se`,
 *   which keep RDS's default (`getDefaultMultiAzForEngine`). Any read failure
 *   fails the create before anything is made, as the handler's does.
 * - The members the restore call has no room for go out in the same
 *   after-create `ModifyDBInstance` a read replica gets
 *   (`shouldUpdateAfterCreate` covers both; `./read-replica.ts`).
 * - UPDATE: an added or changed key is refused as the handler refuses it,
 *   "Resource is immutable" (`isDBSnapshotIdentifierMutable`); a removed one
 *   changes nothing. Neither is ever sent on an update.
 * - DRIFT: neither key is read back (DescribeDBInstances names no source
 *   snapshot).
 */

/** The snapshot keys, in the order the handler tests them. */
export const SNAPSHOT_RESTORE_KEYS = [
  'DBSnapshotIdentifier',
  'DBClusterSnapshotIdentifier',
] as const;

export interface InstanceSnapshotRestore {
  /** At least one of the two is set. */
  dbSnapshotIdentifier: string | undefined;
  dbClusterSnapshotIdentifier: string | undefined;
}

/**
 * The snapshot restore a template declares, `undefined` when it declares
 * neither key (absent or empty, as the handler's `hasValue` reads them). A
 * value that is not a string (an unresolved intrinsic, a list) is refused
 * before any call, on a state replay too: falling through would create an
 * EMPTY instance where a restore was meant.
 */
export function readInstanceSnapshotRestore(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): InstanceSnapshotRestore | undefined {
  const read = (key: (typeof SNAPSHOT_RESTORE_KEYS)[number]): string | undefined => {
    const value = properties[key];
    if (value == null || value === '') return undefined;
    if (typeof value === 'string') return value;
    throw markNonRetryable(
      new ProvisioningError(
        `${resourceType} ${logicalId}: ${key} must be a string (the snapshot's identifier or ARN); nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  const dbSnapshotIdentifier = read('DBSnapshotIdentifier');
  const dbClusterSnapshotIdentifier = read('DBClusterSnapshotIdentifier');
  if (dbSnapshotIdentifier === undefined && dbClusterSnapshotIdentifier === undefined) {
    return undefined;
  }
  return { dbSnapshotIdentifier, dbClusterSnapshotIdentifier };
}

/** The declared snapshot keys, for the warning a read replica's create gives (it reads neither). */
export function declaredSnapshotKeys(properties: Record<string, unknown>): string[] {
  return SNAPSHOT_RESTORE_KEYS.filter((key) => {
    const value = properties[key];
    return value != null && value !== '';
  });
}

/** What the restore reads before its call: the engine and the `MultiAZ` it sends. */
export interface SnapshotRestoreSource {
  /** The declared engine, else the snapshot's. */
  engine: string | undefined;
  /** The declared value, else the handler's default for the engine; `undefined` sends none. */
  multiAZ: boolean | undefined;
}

const MIRRORING_SQL_SERVER_ENGINES: ReadonlySet<string> = new Set(['sqlserver-ee', 'sqlserver-se']);

/**
 * The snapshot reads CloudFormation's create makes before the restore call
 * (`fetchEngine`, then `fetchDBSnapshot` for the `MultiAZ` default). Each is
 * the handler's plain describe by the declared identifier; a snapshot it does
 * not list is refused, and any other failure stops the create before anything
 * is made.
 */
export async function readSnapshotRestoreSource(
  this: RDSProvider,
  properties: Record<string, unknown>,
  restore: InstanceSnapshotRestore,
  resourceType: string,
  logicalId: string,
  mask: ((text: string) => string) | undefined
): Promise<SnapshotRestoreSource> {
  const declaredEngine = properties['Engine'];
  let engine =
    typeof declaredEngine === 'string' && declaredEngine !== '' ? declaredEngine : undefined;
  const declaredMultiAZ = properties['MultiAZ'];
  let multiAZ = declaredMultiAZ == null ? undefined : coerceCfnBoolean(declaredMultiAZ);
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
  const refuseNotFound = (key: string, value: string, noun: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${logicalId}: ${key} ${value} does not name a ${noun} this account can read, so there is nothing to restore; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  const snapshot = restore.dbSnapshotIdentifier;
  if (snapshot !== undefined && (engine === undefined || multiAZ !== true)) {
    let snapshotEngine: string | undefined;
    let found = false;
    try {
      const response = await this.getClient().send(
        new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshot })
      );
      const described = response.DBSnapshots?.[0];
      found = described !== undefined;
      snapshotEngine = described?.Engine;
    } catch (error) {
      if (!this.isNotFoundError(error, 'DBSnapshotNotFoundFault')) {
        throw wrapReadError('restore snapshot', error);
      }
    }
    if (!found) refuseNotFound('DBSnapshotIdentifier', snapshot, 'DB snapshot');
    engine ??= snapshotEngine;
    if (declaredMultiAZ == null) {
      multiAZ =
        snapshotEngine !== undefined && MIRRORING_SQL_SERVER_ENGINES.has(snapshotEngine)
          ? undefined
          : false;
    }
  } else if (engine === undefined && snapshot === undefined) {
    const clusterSnapshot = restore.dbClusterSnapshotIdentifier as string;
    let found = false;
    try {
      const response = await this.getClient().send(
        new DescribeDBClusterSnapshotsCommand({ DBClusterSnapshotIdentifier: clusterSnapshot })
      );
      const described = response.DBClusterSnapshots?.[0];
      found = described !== undefined;
      engine = described?.Engine;
    } catch (error) {
      if (!this.isNotFoundError(error, 'DBClusterSnapshotNotFoundFault')) {
        throw wrapReadError('restore cluster snapshot', error);
      }
    }
    if (!found) {
      refuseNotFound(
        'DBClusterSnapshotIdentifier',
        clusterSnapshot,
        'Multi-AZ DB cluster snapshot'
      );
    }
  }
  return { engine, multiAZ };
}

/** The handler's `isSqlServer`: an unknown engine counts as SQL Server. */
function isSqlServer(engine: string | undefined): boolean {
  return engine === undefined || engine.includes('sqlserver');
}

function isOracleCdbEngine(engine: string | undefined): boolean {
  return engine === 'oracle-ee-cdb' || engine === 'oracle-se2-cdb';
}

/** What {@link snapshotRestoreInput} needs beyond the declared bag. */
export interface SnapshotRestoreParts {
  readonly identifier: string;
  readonly restore: InstanceSnapshotRestore;
  readonly source: SnapshotRestoreSource;
  readonly tags: Tag[];
  readonly logExports: string[] | undefined;
  readonly processor: {
    features?: ProcessorFeature[] | undefined;
    useDefault?: boolean | undefined;
  };
}

/**
 * `RestoreDBInstanceFromDBSnapshot`, as `Translator.restoreDbInstanceFromSnapshotRequest`
 * builds it from the declared members cdkd's SDK route handles (an undeclared
 * one is left out). The storage members go out unless the engine is SQL
 * Server (they then ride the after-create ModifyDBInstance), and an Oracle CDB
 * engine is left to the snapshot (the follow-up sends it).
 */
export function snapshotRestoreInput(
  properties: Record<string, unknown>,
  parts: SnapshotRestoreParts
): RestoreDBInstanceFromDBSnapshotCommandInput {
  const p = properties;
  const engine = parts.source.engine;
  const vpcSecurityGroups = p['VPCSecurityGroups'];
  const lifecycle = engineLifecycleSupportOf(p);
  return {
    DBInstanceIdentifier: parts.identifier,
    ...(parts.restore.dbSnapshotIdentifier !== undefined && {
      DBSnapshotIdentifier: parts.restore.dbSnapshotIdentifier,
    }),
    ...(parts.restore.dbClusterSnapshotIdentifier !== undefined && {
      DBClusterSnapshotIdentifier: parts.restore.dbClusterSnapshotIdentifier,
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
    ...(p['DeletionProtection'] != null && {
      DeletionProtection: p['DeletionProtection'] as boolean,
    }),
    ...(p['DedicatedLogVolume'] != null && {
      DedicatedLogVolume: p['DedicatedLogVolume'] as boolean,
    }),
    ...(parts.logExports !== undefined &&
      parts.logExports.length > 0 && { EnableCloudwatchLogsExports: parts.logExports }),
    ...(p['EnableIAMDatabaseAuthentication'] != null && {
      EnableIAMDatabaseAuthentication: p['EnableIAMDatabaseAuthentication'] as boolean,
    }),
    ...(engine !== undefined && !isOracleCdbEngine(engine) && { Engine: engine }),
    ...(p['LicenseModel'] != null && { LicenseModel: p['LicenseModel'] as string }),
    ...(parts.source.multiAZ !== undefined && { MultiAZ: parts.source.multiAZ }),
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
 * The declared keys a snapshot restore does not apply, as CloudFormation's
 * does not: neither its restore call nor the after-create ModifyDBInstance
 * carries them, so the snapshot (or nothing) decides them. `MasterUsername`
 * and `StorageEncrypted` are compared against the restored instance instead
 * ({@link snapshotRestoredDifferences}).
 */
export function unusedSnapshotRestoreKeys(properties: Record<string, unknown>): string[] {
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
 * The declared keys the restored instance does not hold, read off the restore
 * call's own answer (no extra call): the snapshot decides them.
 */
export function snapshotRestoredDifferences(
  properties: Record<string, unknown>,
  instance: DBInstance
): string[] {
  const differences: string[] = [];
  const username = properties['MasterUsername'];
  if (
    typeof username === 'string' &&
    username !== '' &&
    instance.MasterUsername !== undefined &&
    username !== instance.MasterUsername
  ) {
    differences.push('MasterUsername');
  }
  const encrypted =
    properties['StorageEncrypted'] == null
      ? undefined
      : coerceCfnBoolean(properties['StorageEncrypted']);
  if (
    encrypted !== undefined &&
    instance.StorageEncrypted !== undefined &&
    encrypted !== instance.StorageEncrypted
  ) {
    differences.push('StorageEncrypted');
  }
  return differences;
}

/**
 * The snapshot keys an update adds or changes, which the handler fails as
 * "Resource is immutable" (`isDBSnapshotIdentifierMutable`,
 * `isDBClusterSnapshotIdentifierMutable`): mutable only when unchanged or
 * removed (empty on the desired side).
 */
export function changedSnapshotRestoreKeys(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  /**
   * The deploy's own answer (`UpdateContext.changedProperties`): the record
   * keeps a secret-derived value as its `{{resolve:...}}` token and a `NoEcho`
   * one as `***`, which never equals the resolved desired value. Absent (a
   * direct call), the two bags are compared.
   */
  changedProperties?: ReadonlySet<string>
): string[] {
  return SNAPSHOT_RESTORE_KEYS.filter((key) => {
    const desired = properties[key];
    if (desired == null || desired === '') return false;
    if (changedProperties !== undefined) return changedProperties.has(key);
    return desired !== previousProperties[key];
  });
}
