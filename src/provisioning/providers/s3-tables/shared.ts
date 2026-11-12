import type {
  EncryptionConfiguration,
  IcebergMetadata,
  IcebergNullOrder,
  IcebergPartitionField,
  IcebergSortDirection,
  IcebergSortField,
  LoggingEnabled,
  MaintenanceStatus,
  PartitionDateSource,
  ReplicationDestination,
  SSEAlgorithm,
  SchemaField,
  SchemaV2Field,
  SchemaV2FieldType,
  StorageClass,
  StorageClassConfiguration,
  TableBucketLoggingStatus,
  TableBucketMaintenanceConfigurationValue,
  TableBucketReplicationConfiguration,
  TableBucketReplicationRule,
  TableMaintenanceConfigurationValue,
  TableMaintenanceType,
} from '@aws-sdk/client-s3tables';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { CompositeIdFormat } from '../../composite-id.js';
import { safeMsg } from '../../../utils/display-safe.js';

/** Shapes of the two `AWS::S3Tables::*` composite physicalIds (issue #1657). */
export const S3_TABLES_NAMESPACE_ID_FORMAT: CompositeIdFormat = {
  label: 'S3 Tables Namespace',
  segments: ['tableBucketARN', 'namespace'],
};

export const S3_TABLES_TABLE_ID_FORMAT: CompositeIdFormat = {
  label: 'S3 Tables Table',
  segments: ['tableBucketARN', 'namespace', 'name'],
  alsoAccepts: 'a table ARN',
};

/**
 * Parse cdkd's composite namespace physicalId `<tableBucketARN>|<namespace>`.
 *
 * Returns `undefined` for any other shape. Exactly two non-empty segments are
 * required: every other method on the provider splits the stored id on `|` and
 * indexes segments 0 and 1, so a wrong-arity id recorded verbatim produces a
 * state row that cannot be updated, deleted or read back (issue #1668).
 */
export function parseNamespaceCompositeId(
  physicalId: string
): { tableBucketARN: string; namespace: string } | undefined {
  const parts = physicalId.split('|');
  if (parts.length !== 2) return undefined;
  const [tableBucketARN, namespace] = parts as [string, string];
  if (!tableBucketARN || !namespace) return undefined;
  return { tableBucketARN, namespace };
}

/**
 * What `resolveTableParts` could make of a stored physicalId.
 *
 * `'not-found'` and `'unparseable'` are deliberately DISTINCT: the first is a
 * valid id whose table is gone (delete must no-op), the second is an id cdkd
 * cannot interpret (delete must fail loudly).
 */
export type TablePartsResolution =
  | { tableBucketARN: string; namespace: string; name: string }
  | 'not-found'
  | 'unparseable';

/** Parse cdkd's composite table physicalId `<tableBucketARN>|<namespace>|<name>`. */
export function parseTableCompositeId(
  physicalId: string
): { tableBucketARN: string; namespace: string; name: string } | undefined {
  const parts = physicalId.split('|');
  if (parts.length !== 3) return undefined;
  const [tableBucketARN, namespace, name] = parts as [string, string, string];
  if (!tableBucketARN || !namespace || !name) return undefined;
  return { tableBucketARN, namespace, name };
}

/** Read a non-blank string property, tolerating a malformed properties bag. */
export function readStringProperty(
  properties: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = properties?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Rebuild a table's identity from what `GetTable` returned.
 *
 * Deliberately NOT from the template: a CDK-synthesized `TableBucketARN` is an
 * `Fn::GetAtt` object at import time (full intrinsic resolution runs after
 * `provider.import()`), so a template-side read is `undefined` on exactly the
 * `--migrate-from-cloudformation` path this exists to serve.
 *
 * The bucket ARN is the table ARN's prefix — S3 Tables ARNs are
 * `arn:<p>:s3tables:<region>:<acct>:bucket/<bucket>` and
 * `…:bucket/<bucket>/table/<id>` — so it is recovered by trimming at the last
 * `/table/` segment. `namespace` comes back as a single-element list.
 */
export function tableIdentityFromGetTable(
  tableARN: string,
  namespace: string[] | undefined,
  name: string | undefined
): { tableBucketARN: string; namespace: string; name: string } | undefined {
  const marker = '/table/';
  const cut = tableARN.lastIndexOf(marker);
  if (cut <= 0) return undefined;
  const tableBucketARN = tableARN.slice(0, cut);
  const ns = namespace?.[0];
  if (!tableBucketARN || !ns || !name) return undefined;
  return { tableBucketARN, namespace: ns, name };
}

// ─── Configuration properties (go-to-k/cdkd#2762) ─────────────────

export type CfnObject = Record<string, unknown>;

function isCfnObject(value: unknown): value is CfnObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A DESIRED object-valued property, or `undefined` when the template omits it.
 * Any other shape is refused before a call: read as absent it would skip the
 * write (or, on an update, take the removal path) for a value the template
 * does declare.
 */
export function desiredObject(
  properties: CfnObject,
  key: string,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): CfnObject | undefined {
  const value = properties[key];
  if (value === undefined) return undefined;
  if (isCfnObject(value)) return value;
  throw new ProvisioningError(
    `${key} for ${resourceType} ${logicalId} must be an object; refusing before any call`,
    resourceType,
    logicalId,
    physicalId
  );
}

/** A RECORDED object-valued property: an unreadable one reads as absent. */
export function recordedObject(properties: CfnObject, key: string): CfnObject | undefined {
  const value = properties[key];
  return isCfnObject(value) ? value : undefined;
}

/** A CFn integer member that is not one, named for the refusal. */
class NotAnInteger extends Error {
  readonly member: string;
  constructor(member: string) {
    super(`${member} must be an integer`);
    this.member = member;
  }
}

/**
 * A CFn integer, which a template may carry as a numeric string. Anything
 * else (a non-numeric string, a fraction, a boolean) is refused
 * ({@link NotAnInteger}, turned into a ProvisioningError by
 * {@link refuseNonIntegers} before any call) rather than sent for AWS to
 * reject after earlier writes landed.
 */
function integer(value: unknown, member: string): number | undefined {
  if (value === undefined) return undefined;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (Number.isInteger(n)) return n;
  throw new NotAnInteger(member);
}

/** Run a CFn -> SDK conversion, a {@link NotAnInteger} refused as a ProvisioningError. */
export function refuseNonIntegers<T>(
  convert: () => T,
  key: string,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): T {
  try {
    return convert();
  } catch (error) {
    if (!(error instanceof NotAnInteger)) throw error;
    throw new ProvisioningError(
      `${key}.${error.member} for ${resourceType} ${logicalId} must be an integer; refusing before any call`,
      resourceType,
      logicalId,
      physicalId,
      error
    );
  }
}

/** A CFn list member, or `undefined`: the SDK serializer refuses a non-list. */
function list(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Drop `undefined` members, so an omitted CFn member stays off the wire. */
export function defined<T extends CfnObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The maintenance APIs spell a status `enabled` / `disabled`, while the
 * TableBucket's `UnreferencedFileRemoval.Status` is `Enabled` / `Disabled` in
 * the CFn schema (the Table's `Compaction` / `SnapshotManagement` already
 * use the lowercase form).
 */
function maintenanceStatus(value: unknown): MaintenanceStatus | undefined {
  return typeof value === 'string' ? (value.toLowerCase() as MaintenanceStatus) : undefined;
}

/** CFn `EncryptionConfiguration` -> the SDK shape. */
export function sdkEncryption(cfn: CfnObject): EncryptionConfiguration {
  return defined({
    sseAlgorithm: cfn['SSEAlgorithm'] as SSEAlgorithm,
    kmsKeyArn: cfn['KMSKeyArn'] as string | undefined,
  });
}

/** CFn `StorageClassConfiguration` -> the SDK shape. */
export function sdkStorageClass(cfn: CfnObject): StorageClassConfiguration {
  return defined({ storageClass: cfn['StorageClass'] as StorageClass });
}

/** CFn `ReplicationConfiguration` -> the SDK shape. */
export function sdkReplication(cfn: CfnObject): TableBucketReplicationConfiguration {
  return defined({
    role: cfn['Role'] as string,
    rules: list(cfn['Rules'])?.map((rule) =>
      defined({
        destinations: list(isCfnObject(rule) ? rule['Destinations'] : undefined)?.map(
          (destination) =>
            defined({
              destinationTableBucketARN: (isCfnObject(destination)
                ? destination['DestinationTableBucketARN']
                : undefined) as string,
            })
        ) as ReplicationDestination[],
      })
    ) as TableBucketReplicationRule[],
  });
}

/**
 * Refuse, before any call, a `LoggingConfiguration` whose required string
 * members (`TargetBucket`, `TargetPrefix`,
 * `TargetObjectKeyFormat.PartitionedPrefix.PartitionDateSource`) are missing
 * or not strings: sent as-is, AWS would reject it only after the create or
 * the earlier configuration writes landed.
 */
export function refuseMalformedLogging(
  cfn: CfnObject,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): void {
  const keyFormat = isCfnObject(cfn['TargetObjectKeyFormat'])
    ? cfn['TargetObjectKeyFormat']
    : undefined;
  const partitioned = isCfnObject(keyFormat?.['PartitionedPrefix'])
    ? keyFormat['PartitionedPrefix']
    : undefined;
  const members: [string, unknown][] = [
    ['TargetBucket', cfn['TargetBucket']],
    ['TargetPrefix', cfn['TargetPrefix']],
    [
      'TargetObjectKeyFormat.PartitionedPrefix.PartitionDateSource',
      partitioned?.['PartitionDateSource'],
    ],
  ];
  for (const [member, value] of members) {
    if (typeof value === 'string') continue;
    throw new ProvisioningError(
      `LoggingConfiguration.${member} for ${resourceType} ${logicalId} must be a string; refusing before any call`,
      resourceType,
      logicalId,
      physicalId
    );
  }
}

/**
 * CFn `LoggingConfiguration` -> PutTableBucketLogging's status. The schema
 * requires every member, so a declared configuration always enables logging;
 * the empty status, which turns it off, is sent only for a removal.
 */
export function sdkLogging(cfn: CfnObject): TableBucketLoggingStatus {
  const keyFormat = isCfnObject(cfn['TargetObjectKeyFormat'])
    ? cfn['TargetObjectKeyFormat']
    : undefined;
  const partitioned = isCfnObject(keyFormat?.['PartitionedPrefix'])
    ? keyFormat['PartitionedPrefix']
    : undefined;
  return {
    loggingEnabled: defined({
      targetBucket: cfn['TargetBucket'] as string,
      targetPrefix: cfn['TargetPrefix'] as string,
      targetObjectKeyFormat:
        keyFormat &&
        defined({
          partitionedPrefix:
            partitioned &&
            defined({
              partitionDateSource: partitioned['PartitionDateSource'] as PartitionDateSource,
            }),
        }),
    }) as LoggingEnabled,
  };
}

/** CFn `UnreferencedFileRemoval` -> a maintenance configuration value. */
export function sdkUnreferencedFileRemoval(
  cfn: CfnObject
): TableBucketMaintenanceConfigurationValue {
  const unreferencedDays = integer(cfn['UnreferencedDays'], 'UnreferencedDays');
  const nonCurrentDays = integer(cfn['NoncurrentDays'], 'NoncurrentDays');
  return defined({
    status: maintenanceStatus(cfn['Status']),
    settings:
      unreferencedDays === undefined && nonCurrentDays === undefined
        ? undefined
        : { icebergUnreferencedFileRemoval: defined({ unreferencedDays, nonCurrentDays }) },
  });
}

/** CFn `Compaction` -> a maintenance configuration value. */
function sdkCompaction(cfn: CfnObject): TableMaintenanceConfigurationValue {
  const targetFileSizeMB = integer(cfn['TargetFileSizeMB'], 'TargetFileSizeMB');
  return defined({
    status: maintenanceStatus(cfn['Status']),
    settings:
      targetFileSizeMB === undefined ? undefined : { icebergCompaction: { targetFileSizeMB } },
  });
}

/** CFn `SnapshotManagement` -> a maintenance configuration value. */
function sdkSnapshotManagement(cfn: CfnObject): TableMaintenanceConfigurationValue {
  const minSnapshotsToKeep = integer(cfn['MinSnapshotsToKeep'], 'MinSnapshotsToKeep');
  const maxSnapshotAgeHours = integer(cfn['MaxSnapshotAgeHours'], 'MaxSnapshotAgeHours');
  return defined({
    status: maintenanceStatus(cfn['Status']),
    settings:
      minSnapshotsToKeep === undefined && maxSnapshotAgeHours === undefined
        ? undefined
        : { icebergSnapshotManagement: defined({ minSnapshotsToKeep, maxSnapshotAgeHours }) },
  });
}

/** Each element of a CFn list of objects, mapped; a non-object element is sent as `{}`. */
function mapObjects<T>(value: unknown, map: (o: CfnObject) => T): T[] | undefined {
  return list(value)?.map((element) => map(isCfnObject(element) ? element : {}));
}

/** CFn `IcebergMetadata` -> CreateTable's `metadata.iceberg`. */
export function sdkIcebergMetadata(cfn: CfnObject): IcebergMetadata {
  const schema = isCfnObject(cfn['IcebergSchema']) ? cfn['IcebergSchema'] : undefined;
  const schemaV2 = isCfnObject(cfn['IcebergSchemaV2']) ? cfn['IcebergSchemaV2'] : undefined;
  const partitionSpec = isCfnObject(cfn['IcebergPartitionSpec'])
    ? cfn['IcebergPartitionSpec']
    : undefined;
  const sortOrder = isCfnObject(cfn['IcebergSortOrder']) ? cfn['IcebergSortOrder'] : undefined;
  return defined({
    schema:
      schema &&
      defined({
        fields: mapObjects(schema['SchemaFieldList'], (f) =>
          defined({
            id: integer(f['Id'], 'IcebergSchema.SchemaFieldList.Id'),
            name: f['Name'] as string,
            type: f['Type'] as string,
            required: f['Required'] as boolean | undefined,
          })
        ) as SchemaField[],
      }),
    schemaV2:
      schemaV2 &&
      defined({
        type: schemaV2['SchemaV2FieldType'] as SchemaV2FieldType,
        fields: mapObjects(schemaV2['SchemaV2FieldList'], (f) =>
          defined({
            id: integer(f['Id'], 'IcebergSchemaV2.SchemaV2FieldList.Id') as number,
            name: f['Name'] as string,
            // A primitive type name, or a nested Iceberg type as a JSON document.
            type: f['Type'] as SchemaV2Field['type'],
            required: f['Required'] as boolean,
            doc: f['Doc'] as string | undefined,
          })
        ) as SchemaV2Field[],
        schemaId: integer(schemaV2['SchemaId'], 'IcebergSchemaV2.SchemaId'),
        identifierFieldIds: list(schemaV2['IdentifierFieldIds'])?.map(
          (id) => integer(id, 'IcebergSchemaV2.IdentifierFieldIds') as number
        ),
      }),
    partitionSpec:
      partitionSpec &&
      defined({
        fields: mapObjects(partitionSpec['Fields'], (f) =>
          defined({
            sourceId: integer(f['SourceId'], 'IcebergPartitionSpec.Fields.SourceId') as number,
            transform: f['Transform'] as string,
            name: f['Name'] as string,
            fieldId: integer(f['FieldId'], 'IcebergPartitionSpec.Fields.FieldId'),
          })
        ) as IcebergPartitionField[],
        specId: integer(partitionSpec['SpecId'], 'IcebergPartitionSpec.SpecId'),
      }),
    writeOrder:
      sortOrder &&
      defined({
        orderId: integer(sortOrder['OrderId'], 'IcebergSortOrder.OrderId') as number,
        fields: mapObjects(sortOrder['Fields'], (f) =>
          defined({
            sourceId: integer(f['SourceId'], 'IcebergSortOrder.Fields.SourceId') as number,
            transform: f['Transform'] as string,
            direction: f['Direction'] as IcebergSortDirection,
            nullOrder: f['NullOrder'] as IcebergNullOrder,
          })
        ) as IcebergSortField[],
      }),
    properties: isCfnObject(cfn['TableProperties'])
      ? (cfn['TableProperties'] as Record<string, string>)
      : undefined,
  });
}

/** The object-valued properties an update writes, per type. */
export const UPDATABLE_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::S3Tables::TableBucket': [
    'EncryptionConfiguration',
    'StorageClassConfiguration',
    'MetricsConfiguration',
    'UnreferencedFileRemoval',
    'ReplicationConfiguration',
    'LoggingConfiguration',
  ],
  'AWS::S3Tables::Table': ['Compaction', 'SnapshotManagement'],
};

/**
 * Whether a desired `MetricsConfiguration` turns metrics on. There is no
 * member to send it in (PutTableBucketMetricsConfiguration takes only the
 * bucket ARN), so the status is interpreted here, and a value the schema does
 * not allow is refused rather than read as off.
 */
export function metricsEnabled(
  metrics: CfnObject | undefined,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): boolean {
  const status = metrics?.['Status'];
  if (status === undefined || status === 'Disabled') return false;
  if (status === 'Enabled') return true;
  throw new ProvisioningError(
    safeMsg`MetricsConfiguration.Status for ${resourceType} ${logicalId} must be 'Enabled' or 'Disabled'; refusing before any call`,
    resourceType,
    logicalId,
    physicalId
  );
}

export interface TableMaintenanceWrite {
  type: TableMaintenanceType;
  value: TableMaintenanceConfigurationValue;
}

/** The Table's maintenance properties: CFn key, maintenance type, CFn -> SDK. */
export const TABLE_MAINTENANCE: readonly [
  string,
  TableMaintenanceType,
  (cfn: CfnObject) => TableMaintenanceConfigurationValue,
][] = [
  ['Compaction', 'icebergCompaction', sdkCompaction],
  ['SnapshotManagement', 'icebergSnapshotManagement', sdkSnapshotManagement],
];

/** The updatable properties with integer members, per type, and their conversion. */
export const INTEGER_BEARING_CONFIGS: Readonly<
  Record<string, readonly (readonly [string, (cfn: CfnObject) => unknown])[]>
> = {
  'AWS::S3Tables::TableBucket': [['UnreferencedFileRemoval', sdkUnreferencedFileRemoval]],
  'AWS::S3Tables::Table': TABLE_MAINTENANCE.map(([key, , toSdk]) => [key, toSdk] as const),
};

/** A bucket maintenance status read back (`enabled`) -> its CFn spelling (`Enabled`). */
export function cfnBucketStatus(status: string | undefined): string | undefined {
  return status === undefined ? undefined : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

/** `text` closed as a sentence, for a wrap that continues after it. */
export function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}
