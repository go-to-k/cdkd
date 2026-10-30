import {
  S3TablesClient,
  CreateTableBucketCommand,
  DeleteTableBucketCommand,
  CreateNamespaceCommand,
  DeleteNamespaceCommand,
  CreateTableCommand,
  DeleteTableCommand,
  GetNamespaceCommand,
  GetTableBucketCommand,
  GetTableCommand,
  ListNamespacesCommand,
  ListTablesCommand,
  ListTableBucketsCommand,
  ListTagsForResourceCommand,
  RenameTableCommand,
  TagResourceCommand,
  UntagResourceCommand,
  DeleteTableBucketMetricsConfigurationCommand,
  DeleteTableBucketReplicationCommand,
  GetTableBucketEncryptionCommand,
  GetTableBucketMaintenanceConfigurationCommand,
  GetTableBucketMetricsConfigurationCommand,
  GetTableBucketReplicationCommand,
  GetTableBucketStorageClassCommand,
  GetTableMaintenanceConfigurationCommand,
  PutTableBucketEncryptionCommand,
  PutTableBucketMaintenanceConfigurationCommand,
  PutTableBucketMetricsConfigurationCommand,
  PutTableBucketReplicationCommand,
  PutTableBucketStorageClassCommand,
  PutTableMaintenanceConfigurationCommand,
  NotFoundException,
  type EncryptionConfiguration,
  type IcebergMetadata,
  type IcebergNullOrder,
  type IcebergPartitionField,
  type IcebergSortDirection,
  type IcebergSortField,
  type MaintenanceStatus,
  type ReplicationDestination,
  type SSEAlgorithm,
  type SchemaField,
  type SchemaV2Field,
  type SchemaV2FieldType,
  type StorageClass,
  type StorageClassConfiguration,
  type TableBucketMaintenanceConfigurationValue,
  type TableBucketReplicationConfiguration,
  type TableBucketReplicationRule,
  type TableMaintenanceConfigurationValue,
  type TableMaintenanceType,
  type GetTableMaintenanceConfigurationCommandOutput,
} from '@aws-sdk/client-s3tables';
import { isDeepStrictEqual } from 'node:util';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { markRedactedCause, relayedNameCollision } from '../../deployment/retryable-errors.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { markNotGone } from '../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  compositeIdFormatMessage,
  compositeIdSeparatorRefusal,
  packCompositeId,
  type CompositeIdFormat,
} from '../composite-id.js';
import { findSilentDropProperties } from '../property-coverage.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  type CfnTagEntry,
} from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { commandHole } from '../../utils/pasteable-command.js';
import { safeMsg } from '../../utils/display-safe.js';

/** Shapes of the two `AWS::S3Tables::*` composite physicalIds (issue #1657). */
const S3_TABLES_NAMESPACE_ID_FORMAT: CompositeIdFormat = {
  label: 'S3 Tables Namespace',
  segments: ['tableBucketARN', 'namespace'],
};

const S3_TABLES_TABLE_ID_FORMAT: CompositeIdFormat = {
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
type TablePartsResolution =
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
function readStringProperty(
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
function tableIdentityFromGetTable(
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

type CfnObject = Record<string, unknown>;

function isCfnObject(value: unknown): value is CfnObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A DESIRED object-valued property, or `undefined` when the template omits it.
 * Any other shape is refused before a call: read as absent it would skip the
 * write (or, on an update, take the removal path) for a value the template
 * does declare.
 */
function desiredObject(
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
function recordedObject(properties: CfnObject, key: string): CfnObject | undefined {
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
function refuseNonIntegers<T>(
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
function defined<T extends CfnObject>(value: T): T {
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
function sdkEncryption(cfn: CfnObject): EncryptionConfiguration {
  return defined({
    sseAlgorithm: cfn['SSEAlgorithm'] as SSEAlgorithm,
    kmsKeyArn: cfn['KMSKeyArn'] as string | undefined,
  });
}

/** CFn `StorageClassConfiguration` -> the SDK shape. */
function sdkStorageClass(cfn: CfnObject): StorageClassConfiguration {
  return defined({ storageClass: cfn['StorageClass'] as StorageClass });
}

/** CFn `ReplicationConfiguration` -> the SDK shape. */
function sdkReplication(cfn: CfnObject): TableBucketReplicationConfiguration {
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

/** CFn `UnreferencedFileRemoval` -> a maintenance configuration value. */
function sdkUnreferencedFileRemoval(cfn: CfnObject): TableBucketMaintenanceConfigurationValue {
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
function sdkIcebergMetadata(cfn: CfnObject): IcebergMetadata {
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
const UPDATABLE_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::S3Tables::TableBucket': [
    'EncryptionConfiguration',
    'StorageClassConfiguration',
    'MetricsConfiguration',
    'UnreferencedFileRemoval',
    'ReplicationConfiguration',
  ],
  'AWS::S3Tables::Table': ['Compaction', 'SnapshotManagement'],
};

/**
 * Whether a desired `MetricsConfiguration` turns metrics on. There is no
 * member to send it in (PutTableBucketMetricsConfiguration takes only the
 * bucket ARN), so the status is interpreted here, and a value the schema does
 * not allow is refused rather than read as off.
 */
function metricsEnabled(
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

interface TableMaintenanceWrite {
  type: TableMaintenanceType;
  value: TableMaintenanceConfigurationValue;
}

/** The Table's maintenance properties: CFn key, maintenance type, CFn -> SDK. */
const TABLE_MAINTENANCE: readonly [
  string,
  TableMaintenanceType,
  (cfn: CfnObject) => TableMaintenanceConfigurationValue,
][] = [
  ['Compaction', 'icebergCompaction', sdkCompaction],
  ['SnapshotManagement', 'icebergSnapshotManagement', sdkSnapshotManagement],
];

/** The updatable properties with integer members, per type, and their conversion. */
const INTEGER_BEARING_CONFIGS: Readonly<
  Record<string, readonly (readonly [string, (cfn: CfnObject) => unknown])[]>
> = {
  'AWS::S3Tables::TableBucket': [['UnreferencedFileRemoval', sdkUnreferencedFileRemoval]],
  'AWS::S3Tables::Table': TABLE_MAINTENANCE.map(([key, , toSdk]) => [key, toSdk] as const),
};

/** A bucket maintenance status read back (`enabled`) -> its CFn spelling (`Enabled`). */
function cfnBucketStatus(status: string | undefined): string | undefined {
  return status === undefined ? undefined : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

/**
 * SDK Provider for AWS S3 Tables resources
 *
 * Supports:
 * - AWS::S3Tables::TableBucket
 * - AWS::S3Tables::Namespace
 * - AWS::S3Tables::Table
 *
 * S3 Tables API calls are synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
/** `text` closed as a sentence, for a wrap that continues after it. */
function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

export class S3TablesProvider implements ResourceProvider {
  private client: S3TablesClient | undefined;
  private createClient: S3TablesClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('S3TablesProvider');

  /**
   * The failure wrap every catch that throws a `ProvisioningError` builds.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug`, and the wrap is
   * stamped `markRedactedCause`, so the retry classifiers read the withheld
   * text on the `cause` chain. That debug line goes through the operation's
   * `maskSecrets` (`mask`), since AWS can echo a resolved value back. An
   * "already exists" is restated ({@link relayedNameCollision}). A cdkd-authored or
   * transport error, or a non-`Error` throw, keeps its text, as in the
   * EventBridge bus provider's wrap (go-to-k/cdkd#5053); the thrown message is
   * masked by the deploy engine. Every delete checks `NotFoundException`
   * by type before it wraps, and stamps a wrap naming another `NotFound` class
   * `markNotGone`, so no "already deleted" reading depends on AWS's
   * wording.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
    const m = mask ?? ((text: string) => text);
    this.logger.debug(m(build(m(failure.detail)).message));
    return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3Tables::TableBucket',
      new Set([
        'TableBucketName',
        'Tags',
        // go-to-k/cdkd#2762: the first two on CreateTableBucket, the rest by
        // their own Put* call after it; on an update, each by its own Put* when
        // it changed (see applyTableBucketConfigUpdate for a removal).
        'EncryptionConfiguration',
        'StorageClassConfiguration',
        'MetricsConfiguration',
        'UnreferencedFileRemoval',
        'ReplicationConfiguration',
      ]),
    ],
    ['AWS::S3Tables::Namespace', new Set(['TableBucketARN', 'Namespace'])],
    [
      'AWS::S3Tables::Table',
      new Set([
        'TableBucketARN',
        'Namespace',
        'TableName',
        'Name',
        // `OpenTableFormat` is the canonical CFn schema name (per AWS
        // docs); `Format` is accepted as a legacy/SDK-API-style alias.
        // The handler reads either and prefers the CFn-canonical form.
        'OpenTableFormat',
        'Format',
        'Tags',
        // go-to-k/cdkd#2762: `IcebergMetadata` and `StorageClassConfiguration`
        // on CreateTable (both create-only); `Compaction` and
        // `SnapshotManagement` by PutTableMaintenanceConfiguration, after the
        // create and on an update. `WithoutMetadata` (create-only, only value
        // `Yes`) declares a table with no schema, which is CreateTable
        // without `metadata`: nothing to send.
        'IcebergMetadata',
        'StorageClassConfiguration',
        'Compaction',
        'SnapshotManagement',
        'WithoutMetadata',
      ]),
    ],
  ]);

  /**
   * What `cdkd drift` does not read back for a Table, all create-only: Iceberg
   * metadata is written once into the table's metadata file (there is no Get
   * for it), and `WithoutMetadata` is a create-time declaration with no
   * AWS-side value. The storage class IS readable (GetTableStorageClass), but
   * no API changes it, so a difference could never be reverted in place: it is
   * left out by choice, as the other create-only properties' readbacks are.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    return resourceType === 'AWS::S3Tables::Table'
      ? ['IcebergMetadata', 'StorageClassConfiguration', 'WithoutMetadata']
      : [];
  }

  /**
   * `ReplicationConfiguration` is read back only while configured (see
   * `readTableBucketConfigs`), so a baseline captured with replication off
   * has no key and a console-side enable would be compared nowhere. Named
   * while the template leaves it off: drift compares it, and `drift --revert`
   * sends it absent, which update() deletes (docs/provider-rules.md,
   * "getDriftAbsentMeansDefaultKeys()").
   */
  getDriftAbsentMeansDefaultKeys(
    resourceType: string,
    properties: Record<string, unknown>
  ): readonly string[] {
    return resourceType === 'AWS::S3Tables::TableBucket' &&
      properties['ReplicationConfiguration'] === undefined
      ? ['ReplicationConfiguration']
      : [];
  }

  private getClient(): S3TablesClient {
    if (!this.client) {
      this.client = new S3TablesClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new S3TablesClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateTableBucket` / `CreateNamespace` / `CreateTable` go through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry; built in {@link getClient}'s step, so both
   * capture the region and identity active at that ONE call.
   *
   * None of `CreateTableBucket`, `CreateNamespace` or `CreateTable` carries an
   * idempotency token, and each name is unique in its scope (account and
   * region, table bucket, namespace), so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): S3TablesClient {
    this.getClient();
    return this.createClient as S3TablesClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::S3Tables::TableBucket':
        return this.createTableBucket(logicalId, resourceType, properties, context);
      case 'AWS::S3Tables::Namespace':
        return this.createNamespace(logicalId, resourceType, properties, context);
      case 'AWS::S3Tables::Table':
        return this.createTable(logicalId, resourceType, properties, context);
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
    // go-to-k/cdkd#2613: a table or table bucket is addressed by an ARN read
    // from the state record, and every call goes through the one S3 Tables
    // client, so a client in another region than the record would send the
    // lookup and the tag writes to a region this record was not written
    // through. Refused for all three types, Namespace included although its
    // update sends nothing, so a stack whose client region disagrees with its
    // state stops at its first update rather than partway through. Outside the
    // try: a refusal is not an AWS failure to re-label. The client's region is
    // resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    // go-to-k/cdkd#3994: a malformed desired Tags on a taggable type is
    // refused before any call (read as empty, it would untag every recorded
    // key). Namespaces are not taggable.
    if (resourceType === 'AWS::S3Tables::Table' || resourceType === 'AWS::S3Tables::TableBucket') {
      refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    }
    // go-to-k/cdkd#2762: likewise a non-object configuration property.
    for (const key of UPDATABLE_CONFIG_KEYS[resourceType] ?? []) {
      desiredObject(properties, key, resourceType, logicalId, physicalId);
    }
    // ...and a non-integer member of one, converted here once before any write.
    for (const [key, convert] of INTEGER_BEARING_CONFIGS[resourceType] ?? []) {
      const value = desiredObject(properties, key, resourceType, logicalId, physicalId);
      if (value !== undefined) {
        refuseNonIntegers(() => convert(value), key, resourceType, logicalId, physicalId);
      }
    }
    if (resourceType === 'AWS::S3Tables::TableBucket') {
      metricsEnabled(
        recordedObject(properties, 'MetricsConfiguration'),
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets,
        context?.recordedAttributes,
        (key) => context?.markUnsettled?.(key)
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched. For THIS provider the
      // live case is an inner ProvisioningError (the tag-diff helpers and
      // lookupTableArn raise their own, with precise messages this outer wrap
      // would replace); the guard is written against the CdkdError base so it
      // also covers a control-flow error if one is ever added here.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update S3 Tables resource ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    recordedAttributes: Readonly<Record<string, unknown>> | undefined,
    markUnsettled: (key: string) => void
  ): Promise<ResourceUpdateResult> {
    // There is no UpdateTable / UpdateTableBucket / UpdateNamespace API.
    // TAGS are mutable via TagResource / UntagResource (Table #609 PR #739,
    // TableBucket #609), a Table's `TableName` / `Namespace` via
    // RenameTable (go-to-k/cdkd#5313), and the configuration properties by
    // their own Put* / Delete* calls (go-to-k/cdkd#2762). The Namespace case stays a no-op:
    // Namespaces are not taggable (ListTagsForResource only accepts
    // table-bucket or table ARNs) and both their properties are create-only.
    if (resourceType === 'AWS::S3Tables::Table') {
      // Planned (and refused) before any write, so a refusal changes nothing.
      const rename = await this.planTableRename(
        logicalId,
        physicalId,
        resourceType,
        properties,
        mask
      );
      // Tags against the CURRENT identity, the rename LAST: a failure before
      // the rename leaves the record naming the table AWS still has, and the
      // next deploy re-sends both (each is idempotent).
      await this.applyTableTagsDiff(
        logicalId,
        physicalId,
        resourceType,
        previousProperties['Tags'],
        properties['Tags'],
        mask
      );
      // Maintenance against the current identity too, before the rename.
      await this.applyTableMaintenanceUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        markUnsettled
      );
      if (rename === undefined) return { physicalId, wasReplaced: false };
      try {
        await this.getClient().send(rename.command);
      } catch (error) {
        if (
          !(error instanceof NotFoundException) ||
          !(await this.renameAlreadyApplied(rename.target, recordedAttributes))
        ) {
          throw error;
        }
      }
      this.logger.debug(
        safeMsg`Renamed S3 Tables Table ${logicalId}: ${physicalId} -> ${rename.physicalId}`
      );
      // In place: the table ARN ends in a table id that a rename keeps, so the
      // recorded `TableARN` attribute carries forward (measured against
      // CloudFormation 2026-10-26: TableName and Namespace changes are both
      // `Replacement: False`, and `Fn::GetAtt TableARN` is unchanged).
      return { physicalId: rename.physicalId, wasReplaced: false };
    } else if (resourceType === 'AWS::S3Tables::TableBucket') {
      // TableBucket's physicalId IS the bucket ARN, so the tag-diff path
      // can use it directly (no GetTableBucket lookup hop needed — unlike
      // Table where the compound physicalId requires GetTable to recover
      // the real ARN).
      await this.applyTableBucketTagsDiff(
        logicalId,
        physicalId,
        resourceType,
        previousProperties['Tags'],
        properties['Tags'],
        mask
      );
      await this.applyTableBucketConfigUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        markUnsettled
      );
    } else {
      this.logger.debug(`Update is no-op for ${resourceType} ${logicalId}`);
    }
    return { physicalId, wasReplaced: false };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    // go-to-k/cdkd#2613: a table bucket delete first EMPTIES the bucket
    // (deleting every namespace and table in it), so a client in another
    // region than the state record would empty and delete there. Refuse before
    // any call, for all three types, not only on NotFound; the client's region
    // is resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-delete'
    );
    switch (resourceType) {
      case 'AWS::S3Tables::TableBucket':
        return this.deleteTableBucket(logicalId, physicalId, resourceType, context);
      case 'AWS::S3Tables::Namespace':
        return this.deleteNamespace(logicalId, physicalId, resourceType, context);
      case 'AWS::S3Tables::Table':
        return this.deleteTable(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::S3Tables::TableBucket ───────────────────────────────────

  private async createTableBucket(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Table Bucket ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const tableBucketName = properties['TableBucketName'] as string | undefined;
    if (!tableBucketName) {
      throw new ProvisioningError(
        `TableBucketName is required for S3 Table Bucket ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn `Tags: [{ Key, Value }]` → SDK `tags: Record<string, string>`.
    // CreateTableBucketCommand accepts tags atomically (no separate
    // TagResource call needed); the SDK rejects an empty map with
    // InvalidRequestException, so omit the field entirely when no tags.
    const tags = this.tagListToSdkMap(desiredTags);

    // go-to-k/cdkd#2762: refused before any call, like Tags.
    const encryption = desiredObject(
      properties,
      'EncryptionConfiguration',
      resourceType,
      logicalId
    );
    const storageClass = desiredObject(
      properties,
      'StorageClassConfiguration',
      resourceType,
      logicalId
    );
    const metrics = desiredObject(properties, 'MetricsConfiguration', resourceType, logicalId);
    const metricsOn = metricsEnabled(metrics, resourceType, logicalId);
    const unreferenced = desiredObject(
      properties,
      'UnreferencedFileRemoval',
      resourceType,
      logicalId
    );
    const replication = desiredObject(
      properties,
      'ReplicationConfiguration',
      resourceType,
      logicalId
    );
    // Converted before any call: a non-integer day count is refused here.
    const unreferencedValue =
      unreferenced &&
      refuseNonIntegers(
        () => sdkUnreferencedFileRemoval(unreferenced),
        'UnreferencedFileRemoval',
        resourceType,
        logicalId
      );

    // CreateTableBucket returned: the bucket exists under its ARN, whatever a
    // later configuration call does (go-to-k/cdkd#4583's shape).
    let createdArn: string | undefined;
    try {
      const result = await this.getCreateClient().send(
        new CreateTableBucketCommand({
          name: tableBucketName,
          ...(encryption !== undefined && { encryptionConfiguration: sdkEncryption(encryption) }),
          ...(storageClass !== undefined && {
            storageClassConfiguration: sdkStorageClass(storageClass),
          }),
          ...(tags !== undefined && { tags }),
        })
      );

      const tableBucketARN = result.arn!;
      createdArn = tableBucketARN;
      reportCreatedResource(logicalId, resourceType, tableBucketARN);

      // The rest have no CreateTableBucket member. Metrics are off on a new
      // bucket (the schema's default `Disabled`), so only `Enabled` is sent.
      if (metricsOn) {
        await this.getClient().send(
          new PutTableBucketMetricsConfigurationCommand({ tableBucketARN })
        );
      }
      if (unreferencedValue !== undefined) {
        await this.getClient().send(
          new PutTableBucketMaintenanceConfigurationCommand({
            tableBucketARN,
            type: 'icebergUnreferencedFileRemoval',
            value: unreferencedValue,
          })
        );
      }
      if (replication !== undefined) {
        await this.getClient().send(
          new PutTableBucketReplicationCommand({
            tableBucketARN,
            configuration: sdkReplication(replication),
          })
        );
      }

      this.logger.debug(`Successfully created S3 Table Bucket ${logicalId}: ${tableBucketARN}`);

      return {
        physicalId: tableBucketARN,
        attributes: {
          TableBucketARN: tableBucketARN,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create S3 Table Bucket ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      if (createdArn !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, createdArn);
      }
      throw thrown;
    }
  }

  /**
   * The TableBucket's configuration properties on an update (go-to-k/cdkd#2762),
   * each written by its own call only when it changed.
   *
   * A removal is reset only where the template has no other way to say "off":
   * `MetricsConfiguration` (whose schema default is `Disabled`) and
   * `ReplicationConfiguration` (whose `Rules` are required, so no declared
   * value turns replication off) are deleted. `EncryptionConfiguration`,
   * `StorageClassConfiguration` and `UnreferencedFileRemoval` each have a
   * declarable value for their default, and what CloudFormation sets on their
   * removal is unmeasured, so a removal leaves the AWS value in place and says
   * so (docs/provider-rules.md, "Update removal semantics").
   *
   * Each write is preceded by `markUnsettled(key)`: a failure after an
   * earlier write landed leaves the record naming what may differ on AWS
   * (docs/provider-rules.md, #5380).
   */
  private async applyTableBucketConfigUpdate(
    logicalId: string,
    tableBucketARN: string,
    resourceType: string,
    properties: CfnObject,
    previousProperties: CfnObject,
    markUnsettled: (key: string) => void
  ): Promise<void> {
    const changed = (key: string): [CfnObject | undefined, boolean] => {
      const next = desiredObject(properties, key, resourceType, logicalId, tableBucketARN);
      return [next, !isDeepStrictEqual(next, recordedObject(previousProperties, key))];
    };
    const client = this.getClient();

    const [encryption, encryptionChanged] = changed('EncryptionConfiguration');
    if (encryptionChanged) {
      if (encryption !== undefined) {
        markUnsettled('EncryptionConfiguration');
        await client.send(
          new PutTableBucketEncryptionCommand({
            tableBucketARN,
            encryptionConfiguration: sdkEncryption(encryption),
          })
        );
      } else {
        this.warnRemovalKept(logicalId, 'EncryptionConfiguration');
      }
    }

    const [storageClass, storageClassChanged] = changed('StorageClassConfiguration');
    if (storageClassChanged) {
      if (storageClass !== undefined) {
        markUnsettled('StorageClassConfiguration');
        await client.send(
          new PutTableBucketStorageClassCommand({
            tableBucketARN,
            storageClassConfiguration: sdkStorageClass(storageClass),
          })
        );
      } else {
        this.warnRemovalKept(logicalId, 'StorageClassConfiguration');
      }
    }

    // Compared on what it switches, not its spelling: `{}` and an absent one
    // are both the default `Disabled`.
    const metricsOn = metricsEnabled(
      desiredObject(properties, 'MetricsConfiguration', resourceType, logicalId, tableBucketARN),
      resourceType,
      logicalId
    );
    const metricsWasOn =
      recordedObject(previousProperties, 'MetricsConfiguration')?.['Status'] === 'Enabled';
    if (metricsOn && !metricsWasOn) {
      markUnsettled('MetricsConfiguration');
      await client.send(new PutTableBucketMetricsConfigurationCommand({ tableBucketARN }));
    } else if (!metricsOn && metricsWasOn) {
      markUnsettled('MetricsConfiguration');
      await this.deleteBucketConfig(
        tableBucketARN,
        new DeleteTableBucketMetricsConfigurationCommand({ tableBucketARN })
      );
    }

    const [unreferenced, unreferencedChanged] = changed('UnreferencedFileRemoval');
    if (unreferencedChanged) {
      if (unreferenced !== undefined) {
        markUnsettled('UnreferencedFileRemoval');
        await client.send(
          new PutTableBucketMaintenanceConfigurationCommand({
            tableBucketARN,
            type: 'icebergUnreferencedFileRemoval',
            value: sdkUnreferencedFileRemoval(unreferenced),
          })
        );
      } else {
        this.warnRemovalKept(logicalId, 'UnreferencedFileRemoval');
      }
    }

    const [replication, replicationChanged] = changed('ReplicationConfiguration');
    if (replicationChanged) {
      if (replication !== undefined) {
        markUnsettled('ReplicationConfiguration');
        await client.send(
          new PutTableBucketReplicationCommand({
            tableBucketARN,
            configuration: sdkReplication(replication),
          })
        );
      } else {
        markUnsettled('ReplicationConfiguration');
        await this.deleteBucketConfig(
          tableBucketARN,
          new DeleteTableBucketReplicationCommand({ tableBucketARN })
        );
      }
    }
  }

  /**
   * The Table's maintenance properties on an update (go-to-k/cdkd#2762), each
   * written by PutTableMaintenanceConfiguration only when it changed. Both
   * have a declarable `disabled`, and what CloudFormation sets on their
   * removal is unmeasured, so a removal leaves the AWS value in place and says
   * so, as for the bucket's (see {@link applyTableBucketConfigUpdate}).
   */
  private async applyTableMaintenanceUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: CfnObject,
    previousProperties: CfnObject,
    markUnsettled: (key: string) => void
  ): Promise<void> {
    const writes: (TableMaintenanceWrite & { key: string })[] = [];
    for (const [key, type, toSdk] of TABLE_MAINTENANCE) {
      const next = desiredObject(properties, key, resourceType, logicalId, physicalId);
      if (isDeepStrictEqual(next, recordedObject(previousProperties, key))) continue;
      if (next === undefined) this.warnRemovalKept(logicalId, key);
      else writes.push({ key, type, value: toSdk(next) });
    }
    if (writes.length === 0) return;
    const table = await this.resolveTableParts(physicalId);
    if (table === 'not-found' || table === 'unparseable') {
      throw new ProvisioningError(
        table === 'not-found'
          ? safeMsg`S3 Tables Table '${physicalId}' no longer exists (state is out of sync); ` +
              `refusing to record a maintenance configuration that was not applied`
          : compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }
    for (const { key, type, value } of writes) {
      markUnsettled(key);
      await this.getClient().send(
        new PutTableMaintenanceConfigurationCommand({ ...table, type, value })
      );
    }
  }

  /** A removed configuration property left at its AWS value, said once. */
  private warnRemovalKept(logicalId: string, key: string): void {
    this.logger.warn(
      safeMsg`${logicalId}: ${key} was removed from the template; cdkd leaves its current AWS value in ` +
        `place. Declare the value you want (e.g. its default) to change it.`
    );
  }

  /**
   * A delete of a bucket configuration that may already be absent. AWS answers
   * `NotFoundException` both for an unset configuration and for a bucket that
   * is gone, so a NotFound is accepted only once `GetTableBucket` shows the
   * bucket still exists: a gone bucket is surfaced, as the Table's
   * maintenance write surfaces a gone table, rather than recorded as applied.
   */
  private async deleteBucketConfig(
    tableBucketARN: string,
    command: DeleteTableBucketMetricsConfigurationCommand | DeleteTableBucketReplicationCommand
  ): Promise<void> {
    try {
      // The union is two commands with the same client; TypeScript cannot pick
      // an overload for it.
      await this.getClient().send(command as DeleteTableBucketReplicationCommand);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      // Throws NotFoundException itself when the bucket is gone.
      await this.getClient().send(new GetTableBucketCommand({ tableBucketARN }));
    }
  }

  private async deleteTableBucket(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 Table Bucket ${logicalId}: ${physicalId}`);

    try {
      // Must empty all tables and namespaces before deleting the bucket
      await this.emptyTableBucket(physicalId);

      await this.getClient().send(
        new DeleteTableBucketCommand({
          tableBucketARN: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted S3 Table Bucket ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`S3 Table Bucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete S3 Table Bucket ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * Empty a table bucket by deleting all tables in all namespaces,
   * then deleting all namespaces.
   */
  private async emptyTableBucket(tableBucketARN: string): Promise<void> {
    this.logger.debug(`Emptying table bucket ${tableBucketARN}`);

    // List and process all namespaces
    let namespaceContinuationToken: string | undefined;
    do {
      const namespacesResult = await this.getClient().send(
        new ListNamespacesCommand({
          tableBucketARN,
          continuationToken: namespaceContinuationToken,
        })
      );

      for (const ns of namespacesResult.namespaces ?? []) {
        const namespaceName = ns.namespace?.[0];
        if (!namespaceName) continue;

        // Delete all tables in this namespace
        let tableContinuationToken: string | undefined;
        do {
          const tablesResult = await this.getClient().send(
            new ListTablesCommand({
              tableBucketARN,
              namespace: namespaceName,
              continuationToken: tableContinuationToken,
            })
          );

          for (const table of tablesResult.tables ?? []) {
            if (!table.name) continue;
            this.logger.debug(
              `Deleting table ${namespaceName}/${table.name} from bucket ${tableBucketARN}`
            );
            try {
              await this.getClient().send(
                new DeleteTableCommand({
                  tableBucketARN,
                  namespace: namespaceName,
                  name: table.name,
                })
              );
            } catch (error) {
              if (!(error instanceof NotFoundException)) {
                throw error;
              }
            }
          }

          tableContinuationToken = tablesResult.continuationToken;
        } while (tableContinuationToken);

        // Delete the namespace
        this.logger.debug(`Deleting namespace ${namespaceName} from bucket ${tableBucketARN}`);
        try {
          await this.getClient().send(
            new DeleteNamespaceCommand({
              tableBucketARN,
              namespace: namespaceName,
            })
          );
        } catch (error) {
          if (!(error instanceof NotFoundException)) {
            throw error;
          }
        }
      }

      namespaceContinuationToken = namespacesResult.continuationToken;
    } while (namespaceContinuationToken);
  }

  // ─── AWS::S3Tables::Namespace ─────────────────────────────────────

  private async createNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Tables Namespace ${logicalId}`);

    const tableBucketARN = properties['TableBucketARN'] as string | undefined;
    if (!tableBucketARN) {
      throw new ProvisioningError(
        `TableBucketARN is required for S3 Tables Namespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // The CFn schema types `Namespace` as a STRING — live `DescribeType`,
    // us-east-1, 2026-08-13: `definitions.Namespace = {"type": "string"}` —
    // and CDK 2.x's `s3tables.CfnNamespace` matches it, accepting a plain
    // `string` and emitting it as a string (not a singleton array). AWS's
    // CreateNamespace API takes an array. An array IS still reachable in a
    // template via `addPropertyOverride('Namespace', [...])`, so both wire
    // shapes are accepted here (issue #1771 corrected the earlier claim that
    // the schema itself typed this `List<String>`).
    const rawNs = properties['Namespace'];
    let namespaceName: string | undefined;
    if (Array.isArray(rawNs) && rawNs.length > 0 && typeof rawNs[0] === 'string') {
      namespaceName = rawNs[0];
    } else if (typeof rawNs === 'string' && rawNs.length > 0) {
      namespaceName = rawNs;
    }
    if (!namespaceName) {
      throw new ProvisioningError(
        `Namespace is required for S3 Tables Namespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Refuse a `|` in either segment BEFORE `CreateNamespace` runs (issue
    // #1672), so the refusal cannot orphan a namespace AWS already holds.
    // Neither segment is realistically pipe-capable — a table-bucket ARN is
    // structurally `|`-free, and S3 Tables constrains a namespace name to
    // lowercase alphanumerics and underscores — so this is uniform
    // defense-in-depth rather than a live hazard. The replay downgrade is
    // wired anyway: `.claude/rules/providers.md` records a MISSING `context`
    // parameter as its own failure mode (no type error, no warning, just a
    // refusal that still fires on a replay — the `SNSTopicProvider` case), and
    // three lines retire the burden of re-deriving the unreachability argument
    // every time this file is read.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'tableBucketARN', value: tableBucketARN },
        { name: 'namespace', value: namespaceName },
      ],
      {
        // Issue #2176: the refusal QUOTES the offending segment value, on the
        // thrown arm (durable) and the warn arm (terminal) alike, so the masker
        // goes through unconditionally -- it is absent on the paths that have no
        // context, where it degrades to identity.
        maskSecrets: context?.maskSecrets,
        ...(context?.replayingState === true && {
          onRefusal: (message: string) => this.logger.warn(message),
        }),
      }
    );

    try {
      await this.getCreateClient().send(
        new CreateNamespaceCommand({
          tableBucketARN,
          namespace: [namespaceName],
        })
      );

      this.logger.debug(`Successfully created S3 Tables Namespace ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create S3 Tables Namespace ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  private async deleteNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 Tables Namespace ${logicalId}: ${physicalId}`);

    const [tableBucketARN, namespaceName] = physicalId.split('|');
    if (!tableBucketARN || !namespaceName) {
      throw new ProvisioningError(
        compositeIdFormatMessage(S3_TABLES_NAMESPACE_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.getClient().send(
        new DeleteNamespaceCommand({
          tableBucketARN,
          namespace: namespaceName,
        })
      );
      this.logger.debug(`Successfully deleted S3 Tables Namespace ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`S3 Tables Namespace ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete S3 Tables Namespace ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  // ─── AWS::S3Tables::Table ─────────────────────────────────────────

  private async createTable(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Tables Table ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const tableBucketARN = properties['TableBucketARN'] as string | undefined;
    if (!tableBucketARN) {
      throw new ProvisioningError(
        `TableBucketARN is required for S3 Tables Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const namespace = properties['Namespace'] as string | undefined;
    if (!namespace) {
      throw new ProvisioningError(
        `Namespace is required for S3 Tables Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn schema spells this property `TableName`; the AWS API call below
    // takes it as `name`. Accept both keys from the template and prefer the
    // CFn-canonical name.
    const name =
      (properties['TableName'] as string | undefined) ?? (properties['Name'] as string | undefined);
    if (!name) {
      throw new ProvisioningError(
        `TableName is required for S3 Tables Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn schema spells this `OpenTableFormat`; the SDK API call uses
    // `format`. Accept the CFn-canonical name first, then the legacy
    // `Format` alias for state files written by older fixtures.
    const format =
      (properties['OpenTableFormat'] as string | undefined) ??
      (properties['Format'] as string | undefined);
    if (!format) {
      throw new ProvisioningError(
        `OpenTableFormat is required for S3 Tables Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn `Tags: [{ Key, Value }]` → SDK `tags: Record<string, string>`.
    // CreateTableCommand accepts tags atomically (no separate TagResource
    // call needed); the SDK errors with InvalidRequestException on an empty
    // map, so omit the field entirely when no tags are set.
    const tags = this.tagListToSdkMap(desiredTags);

    // go-to-k/cdkd#2762: refused before any call, like Tags. `WithoutMetadata`
    // asks for a table with no schema: CreateTable without `metadata`.
    const icebergCfn = desiredObject(properties, 'IcebergMetadata', resourceType, logicalId);
    const iceberg =
      icebergCfn &&
      refuseNonIntegers(
        () => sdkIcebergMetadata(icebergCfn),
        'IcebergMetadata',
        resourceType,
        logicalId
      );
    const storageClass = desiredObject(
      properties,
      'StorageClassConfiguration',
      resourceType,
      logicalId
    );
    const maintenance: TableMaintenanceWrite[] = [];
    for (const [key, type, toSdk] of TABLE_MAINTENANCE) {
      const value = desiredObject(properties, key, resourceType, logicalId);
      if (value !== undefined) {
        maintenance.push({
          type,
          value: refuseNonIntegers(() => toSdk(value), key, resourceType, logicalId),
        });
      }
    }

    // Same guard, placement and replay downgrade as `createNamespace` above
    // (issue #1672): computed before the AWS call so a refusal cannot orphan a
    // table, and structurally unreachable because a table-bucket ARN carries
    // no `|` and S3 Tables constrains namespace / table names to lowercase
    // alphanumerics and underscores.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'tableBucketARN', value: tableBucketARN },
        { name: 'namespace', value: namespace },
        { name: 'name', value: name },
      ],
      {
        // Issue #2176: the refusal QUOTES the offending segment value, on the
        // thrown arm (durable) and the warn arm (terminal) alike, so the masker
        // goes through unconditionally -- it is absent on the paths that have no
        // context, where it degrades to identity.
        maskSecrets: context?.maskSecrets,
        ...(context?.replayingState === true && {
          onRefusal: (message: string) => this.logger.warn(message),
        }),
      }
    );

    // go-to-k/cdkd#4583: CreateTable returned, so the table exists under the
    // composite id delete() takes, whatever its response lacked.
    let tableCreated = false;
    try {
      const response = await this.getCreateClient().send(
        new CreateTableCommand({
          tableBucketARN,
          namespace,
          name,
          format: format as 'ICEBERG',
          ...(iceberg !== undefined && { metadata: { iceberg } }),
          ...(storageClass !== undefined && {
            storageClassConfiguration: sdkStorageClass(storageClass),
          }),
          ...(tags !== undefined && { tags }),
        })
      );
      tableCreated = true;
      reportCreatedResource(logicalId, resourceType, physicalId);

      // CreateTable has no maintenance member.
      for (const write of maintenance) {
        await this.getClient().send(
          new PutTableMaintenanceConfigurationCommand({ tableBucketARN, namespace, name, ...write })
        );
      }

      // Capture the REAL table ARN AWS returns — its actual format is
      // NOT inferrable from the compound parts (we tried; AWS rejected
      // `<bucketArn>/table/<ns>/<name>` with BadRequestException), so
      // we store it as an attribute so the resolver can return it for
      // `Fn::GetAtt: [Table, TableARN]` without a follow-up GetTable.
      // A missing tableARN in the response would mean the SDK / AWS
      // changed something underfoot — error LOUD rather than silently
      // propagating `''` to downstream consumers (which would receive
      // an empty ARN and surface cryptic AWS-side errors much later).
      if (!response.tableARN) {
        throw new ProvisioningError(
          `CreateTable did not return a tableARN for ${logicalId} (${physicalId}) — refusing to record an empty TableARN attribute`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      const tableARN = response.tableARN;

      this.logger.debug(`Successfully created S3 Tables Table ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {
          TableARN: tableARN,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create S3 Tables Table ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      if (tableCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, physicalId);
      throw thrown;
    }
  }

  // ─── readCurrentState dispatch ───────────────────────────────────

  /**
   * Read the AWS-current S3 Tables resource configuration in CFn-property
   * shape.
   *
   *  - **AWS::S3Tables::TableBucket**: `GetTableBucket` for the ARN; we
   *    surface `TableBucketName`, `Tags`, and each configuration property
   *    by its own Get (`readTableBucketConfigs`).
   *  - **AWS::S3Tables::Namespace**: parses `tableBucketARN|namespace`
   *    from physical id and surfaces `TableBucketARN` and `Namespace`
   *    (as a `string[]` with one entry, matching `create()`'s shape).
   *    The physical id IS the source of truth for both; `GetNamespace` is
   *    called only to tell whether the namespace still exists
   *    (go-to-k/cdkd#4283).
   *  - **AWS::S3Tables::Table**: parses `tableBucketARN|namespace|name`
   *    from physical id, calls `GetTable` to verify existence and recover
   *    `format`, surfaces `TableBucketARN`, `Namespace` (string), `Name`,
   *    `Format`, `Tags`, `Compaction` and `SnapshotManagement`.
   *
   * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::S3Tables::TableBucket':
        return this.readTableBucketCurrentState(physicalId);
      case 'AWS::S3Tables::Namespace':
        return this.readNamespaceCurrentState(physicalId);
      case 'AWS::S3Tables::Table':
        return this.readTableCurrentState(physicalId);
      default:
        this.logger.debug(
          `readCurrentState: unsupported resource type ${resourceType} for ${logicalId}`
        );
        return undefined;
    }
  }

  private async readTableBucketCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let bucket;
    try {
      const resp = await this.getClient().send(
        new GetTableBucketCommand({ tableBucketARN: physicalId })
      );
      bucket = resp;
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    const result: Record<string, unknown> = {};
    if (bucket.name !== undefined) result['TableBucketName'] = bucket.name;
    // Tags: best-effort second call. physicalId IS the bucket ARN, so
    // ListTagsForResource takes it directly (no GetTableBucket → ARN
    // recovery hop, unlike Table's compound physicalId case). Emit
    // Tags: [] when AWS returns no tags or when the read itself fails
    // (matches S3Vectors / CloudFront / S3Tables::Table patterns —
    // drift comparator only descends into state-side keys, so an empty
    // array does not surface noise on a pre-PR state file that had no
    // Tags entry).
    result['Tags'] = await this.readTagsBestEffort(physicalId);
    Object.assign(result, await this.readTableBucketConfigs(physicalId));
    return result;
  }

  /**
   * The TableBucket's configuration properties in CFn shape
   * (go-to-k/cdkd#2762), each by its own Get. Every one is emitted, at its
   * AWS default when unset, so a console-side change is compared — except
   * `ReplicationConfiguration`, which is emitted only while replication is
   * configured: its `Role` and `Rules` are required, so there is no "off"
   * value to emit, and a removal deletes it. A console-side enable is still
   * compared: {@link getDriftAbsentMeansDefaultKeys} names the key while the
   * template leaves replication off. A read that fails for any other
   * reason than `NotFoundException` leaves its key out, at `debug`, as the
   * tag read does.
   */
  private async readTableBucketConfigs(tableBucketARN: string, strict = false): Promise<CfnObject> {
    const client = this.getClient();
    const out: CfnObject = {};
    await this.readConfig(
      out,
      'EncryptionConfiguration',
      async () => {
        const resp = await client.send(new GetTableBucketEncryptionCommand({ tableBucketARN }));
        const e = resp.encryptionConfiguration;
        return defined({ SSEAlgorithm: e?.sseAlgorithm ?? 'AES256', KMSKeyArn: e?.kmsKeyArn });
      },
      { SSEAlgorithm: 'AES256' },
      strict
    );
    await this.readConfig(
      out,
      'StorageClassConfiguration',
      async () => {
        const resp = await client.send(new GetTableBucketStorageClassCommand({ tableBucketARN }));
        return { StorageClass: resp.storageClassConfiguration?.storageClass ?? 'STANDARD' };
      },
      { StorageClass: 'STANDARD' },
      strict
    );
    await this.readConfig(
      out,
      'MetricsConfiguration',
      async () => {
        await client.send(new GetTableBucketMetricsConfigurationCommand({ tableBucketARN }));
        return { Status: 'Enabled' };
      },
      { Status: 'Disabled' },
      strict
    );
    await this.readConfig(
      out,
      'UnreferencedFileRemoval',
      async () => {
        const resp = await client.send(
          new GetTableBucketMaintenanceConfigurationCommand({ tableBucketARN })
        );
        const value = resp.configuration?.icebergUnreferencedFileRemoval;
        const settings = value?.settings?.icebergUnreferencedFileRemoval;
        return defined({
          // Enabled on every table bucket unless turned off.
          Status: cfnBucketStatus(value?.status) ?? 'Enabled',
          UnreferencedDays: settings?.unreferencedDays,
          NoncurrentDays: settings?.nonCurrentDays,
        });
      },
      { Status: 'Enabled' },
      strict
    );
    await this.readConfig(
      out,
      'ReplicationConfiguration',
      async () => {
        const resp = await client.send(new GetTableBucketReplicationCommand({ tableBucketARN }));
        const c = resp.configuration;
        if (c === undefined) return undefined;
        return defined({
          Role: c.role,
          Rules: (c.rules ?? []).map((rule) => ({
            Destinations: (rule.destinations ?? []).map((d) => ({
              DestinationTableBucketARN: d.destinationTableBucketARN,
            })),
          })),
        });
      },
      'absent',
      strict
    );
    return out;
  }

  /**
   * Run one configuration read into `out[key]`: `notFound` on
   * `NotFoundException` (the configuration is unset: its default, or no key),
   * and the key left out on any other failure — rethrown instead when
   * `strict` (readUnsettled, which must not read a failure as absent).
   */
  private async readConfig(
    out: CfnObject,
    key: string,
    read: () => Promise<CfnObject | undefined>,
    notFound: CfnObject | 'absent',
    strict = false
  ): Promise<void> {
    try {
      const value = await read();
      if (value !== undefined) out[key] = value;
    } catch (err) {
      if (err instanceof NotFoundException) {
        if (notFound !== 'absent') out[key] = notFound;
        return;
      }
      if (strict) throw err;
      this.logger.debug(
        safeMsg`readCurrentState: reading ${key} failed: ${describeAwsFailure(err).detail} — leaving it out`
      );
    }
  }

  private async readNamespaceCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const [tableBucketARN, namespaceName] = physicalId.split('|');
    if (!tableBucketARN || !namespaceName) return undefined;

    // Existence only: a namespace deleted outside cdkd must read as gone, not
    // as the physical id echoed back (go-to-k/cdkd#4283).
    try {
      await this.getClient().send(
        new GetNamespaceCommand({ tableBucketARN, namespace: namespaceName })
      );
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    // CDK 2.x's `s3tables.CfnNamespace` emits `Namespace` as a plain
    // string (not a singleton array as CFn docs / AWS SDK suggest); the
    // drift comparator only descends into keys present in state, so the
    // readback shape must match the template-as-written shape. Emit the
    // string form because (a) CDK is the dominant template source and
    // (b) `createNamespace`'s string-vs-array tolerance accepts both
    // inputs but state preserves the template-emitted shape. Templates
    // that explicitly use the array form would see a one-time drift on
    // the first `cdkd drift` invocation; not load-bearing for the
    // dominant CDK-authored case.
    return {
      TableBucketARN: tableBucketARN,
      Namespace: namespaceName,
    };
  }

  /**
   * Recover a table's `(bucketARN, namespace, name)` from EITHER id shape.
   *
   * cdkd's composite carries all three. CloudFormation's physicalId for this
   * type is the bare `TableARN` (single-field `primaryIdentifier`), and that
   * form reaches the SDK path in two ways worth tolerating rather than
   * rejecting:
   *
   * - every state row written by `cdkd import` before issue #1668, which
   *   stored the CFn id verbatim; and
   * - a CC-ROUTED table imported by this version, which deliberately records
   *   the ARN because Cloud Control's Identifier is the ARN — while
   *   `destroy` / `drift` route on `provisionedBy` ALONE (no properties), and
   *   `cdkd import` records `'sdk'`, so those paths land HERE with an ARN.
   *
   * Tolerating both is what makes the route-detection at import time
   * imprecision-proof: whichever shape is stored, every SDK path works.
   * `GetTable` accepts `tableArn` and returns the parts.
   */
  private async resolveTableParts(physicalId: string): Promise<TablePartsResolution> {
    const composite = parseTableCompositeId(physicalId);
    if (composite) return composite;
    // Legacy rows may carry MORE than 3 segments; keep accepting them.
    const parts = physicalId.split('|');
    if (parts.length > 3) {
      const [tableBucketARN, namespace, name] = parts;
      if (tableBucketARN && namespace && name) return { tableBucketARN, namespace, name };
    }
    if (physicalId.includes('|') || !physicalId.startsWith('arn:')) return 'unparseable';

    try {
      const resp = await this.getClient().send(new GetTableCommand({ tableArn: physicalId }));
      if (!resp.tableARN) return 'unparseable';
      return tableIdentityFromGetTable(resp.tableARN, resp.namespace, resp.name) ?? 'unparseable';
    } catch (err) {
      // 'not-found' is NOT the same answer as 'unparseable'. Collapsing them
      // makes a delete of an already-gone ARN row report
      // "Invalid physical ID format" for a perfectly valid id — which fails
      // the destroy and leaves the stack un-destroyable, the same shape of
      // breakage this PR exists to fix. Recovery paths must tolerate a stale
      // read.
      if (err instanceof NotFoundException) return 'not-found';
      throw err;
    }
  }

  private async readTableCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    // `cdkd drift` has no per-resource try/catch, so a throttle or an
    // AccessDenied on ONE bare-ARN row would abort the whole stack's drift
    // run. Report drift-unknown for this resource instead — the same answer
    // the two sentinel resolutions below already produce.
    let resolved: TablePartsResolution;
    try {
      resolved = await this.resolveTableParts(physicalId);
    } catch (err) {
      this.logger.warn(
        `S3 Tables Table ${physicalId}: could not resolve its identity for drift ` +
          `(${describeAwsFailure(err).detail}); reporting drift as unknown.`
      );
      return undefined;
    }
    if (resolved === 'not-found') return RESOURCE_NOT_FOUND;
    if (resolved === 'unparseable') return undefined;
    const { tableBucketARN, namespace, name } = resolved;

    let resp;
    try {
      resp = await this.getClient().send(
        new GetTableCommand({
          tableBucketARN,
          namespace,
          name,
        })
      );
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    // CFn schema spells this property `TableName`; AWS API uses `name`.
    // Emit BOTH so drift comparison works for state files written by
    // either name (#613 B-bucket fix).
    const tableNameValue = resp.name ?? name;
    const result: Record<string, unknown> = {
      TableBucketARN: tableBucketARN,
      Namespace: namespace,
      Name: tableNameValue,
      TableName: tableNameValue,
    };
    // Emit BOTH `OpenTableFormat` (CFn-canonical) AND `Format`
    // (legacy/SDK-API alias) so drift comparison works for state files
    // written by either name (same #613 B-bucket symmetry as TableName/Name).
    if (resp.format !== undefined) {
      result['OpenTableFormat'] = resp.format;
      result['Format'] = resp.format;
    }
    // Tags: best-effort second call. ListTagsForResource takes the REAL
    // table ARN AWS returned at create time — surfaced by `GetTable`'s
    // `tableARN` field (the SAME response we just used to verify the
    // table exists). Emit Tags: [] when AWS returned no tableARN, no
    // tags, or when the read itself fails (matches the S3Vectors /
    // CloudFront patterns; the drift comparator only descends into
    // state-side keys, so an empty array does not surface noise on a
    // pre-PR state file that had no Tags entry).
    result['Tags'] = resp.tableARN ? await this.readTagsBestEffort(resp.tableARN) : [];

    // go-to-k/cdkd#2762: the maintenance properties, each at its AWS default
    // when unset (both kinds are enabled on a new table). The create-only
    // `StorageClassConfiguration` is not emitted (readable, but no API changes
    // it; getDriftUnknownPaths), and
    // `IcebergMetadata` / `WithoutMetadata` have no read (getDriftUnknownPaths).
    Object.assign(
      result,
      await this.readTableMaintenance(physicalId, { tableBucketARN, namespace, name })
    );
    return result;
  }

  /**
   * The Table's `Compaction` / `SnapshotManagement` in CFn shape
   * (go-to-k/cdkd#2762). A read that fails for any other reason than
   * `NotFoundException` leaves both out, at `debug` — or is rethrown when
   * `strict` (readUnsettled).
   */
  private async readTableMaintenance(
    physicalId: string,
    table: { tableBucketARN: string; namespace: string; name: string },
    strict = false
  ): Promise<CfnObject> {
    const result: CfnObject = {};
    let maintenance: GetTableMaintenanceConfigurationCommandOutput['configuration'];
    let maintenanceRead = true;
    try {
      maintenance = (
        await this.getClient().send(new GetTableMaintenanceConfigurationCommand(table))
      ).configuration;
    } catch (err) {
      maintenanceRead = err instanceof NotFoundException;
      if (!maintenanceRead) {
        if (strict) throw err;
        this.logger.debug(
          safeMsg`readCurrentState: reading the maintenance configuration of ${physicalId} failed: ` +
            safeMsg`${describeAwsFailure(err).detail} — leaving Compaction / SnapshotManagement out`
        );
      }
    }
    if (maintenanceRead) {
      const compaction = maintenance?.icebergCompaction;
      const compactionSettings =
        compaction?.settings && 'icebergCompaction' in compaction.settings
          ? compaction.settings.icebergCompaction
          : undefined;
      result['Compaction'] = defined({
        Status: compaction?.status ?? 'enabled',
        TargetFileSizeMB: compactionSettings?.targetFileSizeMB,
      });
      const snapshots = maintenance?.icebergSnapshotManagement;
      const snapshotSettings =
        snapshots?.settings && 'icebergSnapshotManagement' in snapshots.settings
          ? snapshots.settings.icebergSnapshotManagement
          : undefined;
      result['SnapshotManagement'] = defined({
        Status: snapshots?.status ?? 'enabled',
        MinSnapshotsToKeep: snapshotSettings?.minSnapshotsToKeep,
        MaxSnapshotAgeHours: snapshotSettings?.maxSnapshotAgeHours,
      });
    }
    return result;
  }

  /**
   * go-to-k/cdkd#5487 / #2762: the live values of the configuration keys an
   * earlier update marked unsettled, for the engine's convergence step. The
   * same reads as `readCurrentState`, except that a failed read THROWS: left
   * out, a key would read as unset on AWS (a metrics configuration still on
   * would not be deleted).
   */
  async readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let live: CfnObject;
    if (resourceType === 'AWS::S3Tables::TableBucket') {
      // The configuration Gets answer NotFound for an unset configuration AND
      // for a gone bucket, so existence is read first.
      try {
        await this.getClient().send(new GetTableBucketCommand({ tableBucketARN: physicalId }));
      } catch (err) {
        if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
        throw err;
      }
      live = await this.readTableBucketConfigs(physicalId, true);
    } else if (resourceType === 'AWS::S3Tables::Table') {
      const table = await this.resolveTableParts(physicalId);
      if (table === 'not-found') return RESOURCE_NOT_FOUND;
      if (table === 'unparseable') {
        throw new ProvisioningError(
          compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId),
          resourceType,
          logicalId,
          physicalId
        );
      }
      // A composite id is parsed without a call, and the maintenance Get
      // answers NotFound for a gone table as for an unset configuration, so
      // existence is read first, as for the bucket.
      if ((await this.lookupTableArn(table.tableBucketARN, table.namespace, table.name)) === null) {
        return RESOURCE_NOT_FOUND;
      }
      live = await this.readTableMaintenance(physicalId, table, true);
    } else {
      return undefined;
    }
    return Object.fromEntries(Object.entries(live).filter(([key]) => names.has(key)));
  }

  // ─── Import dispatch ──────────────────────────────────────────────

  /**
   * Adopt an existing S3 Tables resource into cdkd state.
   *
   *  - **AWS::S3Tables::TableBucket**: `--resource <id>=<arn>` override, or
   *    a `Properties.TableBucketName` match against `ListTableBuckets`.
   *  - **AWS::S3Tables::Table**: explicit-override only.
   *  - **AWS::S3Tables::Namespace**: explicit-override only.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::S3Tables::TableBucket':
        return this.importTableBucket(input);
      case 'AWS::S3Tables::Namespace':
        return this.importNamespace(input);
      case 'AWS::S3Tables::Table':
        return this.importTable(input);
      default:
        return null;
    }
  }

  private async importTableBucket(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(
          new GetTableBucketCommand({ tableBucketARN: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    // The `aws:cdk:path` tag match that used to ride this walk is gone: AWS
    // rejects `aws:`-prefixed tag writes, so that tag never exists on a real
    // resource and the comparison could not match (issue #1134). The walk
    // stays only for the template physical-name match below, so skip it
    // entirely when the template supplies no `TableBucketName`.
    const desiredName =
      typeof input.properties?.['TableBucketName'] === 'string'
        ? input.properties['TableBucketName']
        : undefined;
    if (!desiredName) return null;

    let token: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListTableBucketsCommand({ ...(token && { continuationToken: token }) })
      );
      for (const bucket of list.tableBuckets ?? []) {
        if (!bucket.arn) continue;
        if (bucket.name === desiredName) {
          return { physicalId: bucket.arn, attributes: {} };
        }
      }
      token = list.continuationToken;
    } while (token);
    return null;
  }

  /**
   * Adopt an existing namespace (issue #1668).
   *
   * cdkd's physicalId is `<tableBucketARN>|<namespaceName>` and so is
   * CloudFormation's — the registry declares a two-field
   * `primaryIdentifier` (`/properties/TableBucketARN` + `/properties/Namespace`,
   * verified live us-east-1 2026-08-12) and Cloud Control joins a multi-part
   * identifier with `|`. So the two agree and no foreign form has to be
   * accepted; what was missing is that a WRONG-ARITY id was recorded verbatim,
   * after which every other method on this provider — which all split the
   * stored id on `|` — failed against a state row that looked adopted.
   *
   * A wrong-arity override is REFUSED rather than silently replaced with the
   * template's identity: `knownPhysicalId` is documented as ground truth
   * (`ResourceImportInput`), so quietly adopting a different resource than the
   * one the user named would be worse than declining. An unverifiable
   * namespace returns `null` (`skipped-not-found`), which is loud and leaves
   * state clean.
   *
   * NOTE this now issues an AWS call where it previously made none, so
   * `s3tables:GetNamespace` is newly required, and a path that could not fail
   * before can now report `failed` on a non-`NotFound` error (throttle, IAM).
   */
  private async importNamespace(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) return null;

    const identity = parseNamespaceCompositeId(input.knownPhysicalId);
    if (!identity) {
      this.logger.warn(
        `S3 Tables Namespace ${input.logicalId}: physical id '${input.knownPhysicalId}' is not ` +
          `'<tableBucketARN>|<namespace>'. CloudFormation uses the same two-field composite for ` +
          `this type, so this id names no namespace cdkd can verify; skipping import.`
      );
      return null;
    }

    try {
      await this.getClient().send(
        new GetNamespaceCommand({
          tableBucketARN: identity.tableBucketARN,
          namespace: identity.namespace,
        })
      );
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }

    // `parseNamespaceCompositeId` accepted EXACTLY two segments, so neither can
    // carry a `|` and this refusal is unreachable today (issue #1672). It is
    // applied anyway so a future relaxation of that parser cannot silently
    // start recording an ambiguous id. Warn-and-SKIP rather than throw: an
    // unverifiable id is `skipped-not-found` on this path, which is the idiom
    // every other unusable-id arm in this method already uses, and a throw
    // would abort the whole `cdkd import` over one row.
    const namespaceRefusal = compositeIdSeparatorRefusal(
      'AWS::S3Tables::Namespace',
      input.logicalId,
      [
        { name: 'tableBucketARN', value: identity.tableBucketARN },
        { name: 'namespace', value: identity.namespace },
      ]
    );
    if (namespaceRefusal !== undefined) {
      this.logger.warn(`${namespaceRefusal} Skipping import.`);
      return null;
    }

    return {
      physicalId: `${identity.tableBucketARN}|${identity.namespace}`,
      attributes: {},
    };
  }

  /**
   * Adopt an existing table (issue #1668).
   *
   * Unlike the namespace above, the two id shapes DISAGREE here: cdkd's
   * physicalId is `<tableBucketARN>|<namespace>|<name>` while the registry
   * declares a SINGLE-field `primaryIdentifier` of `/properties/TableARN`
   * (verified live us-east-1 2026-08-12), so CloudFormation's physicalId is
   * the table ARN. An auto-mode / `--migrate-from-cloudformation` import
   * merges CFn-derived ids into the overrides, so that ARN was landing in
   * state verbatim and every later update / delete / read then failed to parse
   * it — the #1651 class on a second type.
   *
   * **The identity is resolved from AWS, not from the template.** An earlier
   * draft rebuilt the composite out of `Properties.TableBucketARN` /
   * `Namespace` / `TableName`, and that is INERT for the case this exists to
   * fix: in a CDK-synthesized template `TableBucketARN` is
   * `{"Fn::GetAtt": ["TableBucket", "TableBucketARN"]}`, `import.ts`
   * pre-substitutes only overridden `{Ref}`s and account / region
   * pseudo-parameter intrinsics before calling a provider (never a GetAtt), and
   * full intrinsic resolution runs AFTER every `provider.import()`. So the
   * template read yielded `undefined` on exactly the
   * `--migrate-from-cloudformation` path that supplies the bare ARN, turning a
   * corrupt adoption into a non-adoption instead of canonicalizing it.
   *
   * `GetTable` accepts `tableArn` directly and returns `name` + `namespace`,
   * so the ARN resolves its own identity with no template involvement. The
   * bucket ARN is the table ARN's prefix (`<bucketArn>/table/<id>`); when the
   * template DOES carry a literal `TableBucketARN` it is cross-checked, and a
   * disagreement is refused rather than guessed at.
   */
  private async importTable(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const known = input.knownPhysicalId;
    if (!known) {
      // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
      // that tag never exists on a real resource and the walk could not match
      // (issue #1134). Auto-mode import resolves ids from CloudFormation's
      // `DescribeStackResources` or the template's physical-name property; a
      // table reaching here needs an explicit `--resource` override.
      return null;
    }

    const composite = parseTableCompositeId(known);
    const request = composite
      ? {
          tableBucketARN: composite.tableBucketARN,
          namespace: composite.namespace,
          name: composite.name,
        }
      : // The `|`-free test is load-bearing: cdkd's own composite STARTS with
        // the bucket ARN, so an `arn:` prefix alone would route a MALFORMED
        // composite (`<bucketArn>|ns`) into the by-ARN lookup and adopt the
        // wrong thing. A real table ARN never contains `|`.
        !known.includes('|') && known.startsWith('arn:')
        ? { tableArn: known }
        : undefined;

    if (!request) {
      this.logger.warn(
        `S3 Tables Table ${input.logicalId}: physical id '${known}' is neither cdkd's ` +
          `'<tableBucketARN>|<namespace>|<name>' composite nor a table ARN (CloudFormation's ` +
          `physicalId for this type), so it names no table cdkd can verify; skipping import.`
      );
      return null;
    }

    let response;
    try {
      response = await this.getClient().send(new GetTableCommand(request));
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }

    // Treat a response without an ARN as UNVERIFIABLE rather than adopting it:
    // `createTable` hard-errors on exactly this condition, and the ARN is what
    // the bucket-ARN derivation and the attribute cache both depend on.
    const tableARN = response.tableARN;
    if (!tableARN) {
      this.logger.warn(
        `S3 Tables Table ${input.logicalId}: GetTable returned no tableARN for '${known}', ` +
          `so the table's identity cannot be confirmed; skipping import.`
      );
      return null;
    }

    const identity =
      composite ?? tableIdentityFromGetTable(tableARN, response.namespace, response.name);
    if (!identity) {
      this.logger.warn(
        `S3 Tables Table ${input.logicalId}: GetTable('${known}') did not return a usable ` +
          `namespace / name / bucket-ARN prefix; skipping import.`
      );
      return null;
    }

    // When the template carries a LITERAL bucket ARN, it must agree with the
    // one the ARN resolves to. (It is usually an unresolved intrinsic here, in
    // which case there is nothing to cross-check — see the note above.)
    // Only compare a LITERAL that looks like the same kind of value: a
    // name-shaped `--resource` override substituted into a `{Ref}` would
    // otherwise produce a false refusal.
    const mismatch = (
      [
        [
          'TableBucketARN',
          readStringProperty(input.properties, 'TableBucketARN'),
          identity.tableBucketARN,
        ],
        ['Namespace', readStringProperty(input.properties, 'Namespace'), identity.namespace],
        [
          'TableName',
          readStringProperty(input.properties, 'TableName') ??
            readStringProperty(input.properties, 'Name'),
          identity.name,
        ],
      ] as const
    ).find(([key, declared, resolved]) => {
      if (!declared) return false;
      if (key === 'TableBucketARN' && !declared.startsWith('arn:')) return false;
      // A `{Ref}` to a SIBLING resource is substituted with that resource's
      // PHYSICAL ID before `import()` runs, and for `AWS::S3Tables::Namespace`
      // that id is the 2-field composite `<bucketArn>|<namespace>` — the very
      // shape this PR documents. So the canonical CDK spelling
      // (`namespace: ns.ref`) declares `arn:...|analytics` where the resolved
      // field is `analytics`, and comparing them raw REFUSES the adoption on
      // exactly the migration path this fix targets. Compare the field, not
      // the id that carries it: neither a namespace nor a table name may
      // contain `|`, so the last segment is unambiguous.
      const declaredField = declared.includes('|')
        ? (declared.split('|').pop() ?? declared)
        : declared;
      return declaredField !== resolved;
    });
    if (mismatch) {
      const [key, declared, resolved] = mismatch;
      this.logger.warn(
        `S3 Tables Table ${input.logicalId}: the supplied physical id '${known}' resolves to ` +
          `${key} '${resolved}', but the template declares '${declared}'; refusing to adopt a ` +
          `different table than the one the template describes.`
      );
      return null;
    }

    // ROUTE-AWARE physicalId. A table whose template carries a silent-drop
    // property (none today: the last five were wired by go-to-k/cdkd#2762, but
    // a schema refresh can add one) is auto-routed to Cloud
    // Control by the #614 rule, and CC's Identifier for this type is the bare
    // `TableARN` — not cdkd's composite. `cdkd import` records
    // `provisionedBy: 'sdk'`, but ONLY `'cc-api'` is sticky, so the next
    // deploy / destroy re-derives the route from the template and such a table
    // lands on CC. Canonicalizing unconditionally would therefore hand Cloud
    // Control `arn|ns|name` and break exactly the tables the ARN form was
    // (accidentally) correct for before this PR.
    //
    // Schema-known drops only, deliberately: a key the snapshot does not know
    // routes on a deploy only when it differs from the record (issue #3713),
    // and the record this import writes carries the template's bag, so the
    // next deploy keeps such a table on the SDK route.
    const ccRouted = findSilentDropProperties('AWS::S3Tables::Table', input.properties).length > 0;
    if (ccRouted) {
      this.logger.debug(
        `S3 Tables Table ${input.logicalId}: template carries a Cloud-Control-routing property, ` +
          `recording the bare TableARN (CC's identifier) rather than cdkd's composite.`
      );
      return { physicalId: tableARN, attributes: { TableARN: tableARN } };
    }

    // Unlike `importNamespace`, this identity is NOT always the product of a
    // fixed-arity split: when the supplied id was a bare table ARN the
    // namespace and name come from the `GetTable` RESPONSE, so they are
    // whatever AWS holds rather than something this method already validated
    // (issue #1672). Warn-and-SKIP for the same reason as the namespace arm —
    // `skipped-not-found` is this method's answer to every id it cannot use,
    // and adopting an ambiguous composite is the #1658 failure mode (a state
    // row that looks adopted and makes the stack undestroyable). Only the
    // composite arm needs it; the Cloud-Control-routed arm above records the
    // bare ARN, which has no segments.
    const tableRefusal = compositeIdSeparatorRefusal('AWS::S3Tables::Table', input.logicalId, [
      { name: 'tableBucketARN', value: identity.tableBucketARN },
      { name: 'namespace', value: identity.namespace },
      { name: 'name', value: identity.name },
    ]);
    if (tableRefusal !== undefined) {
      this.logger.warn(`${tableRefusal} Skipping import.`);
      return null;
    }

    return {
      physicalId: `${identity.tableBucketARN}|${identity.namespace}|${identity.name}`,
      // Cache the real ARN the same way `createTable` does, so a
      // `Fn::GetAtt: [Table, TableARN]` resolves for an imported table too.
      attributes: { TableARN: tableARN },
    };
  }

  private async deleteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 Tables Table ${logicalId}: ${physicalId}`);

    // Accepts cdkd's composite AND CloudFormation's bare TableARN — see
    // `resolveTableParts`. Rejecting the ARN here is what made a migrated
    // stack undestroyable (issue #1668).
    let resolved: TablePartsResolution;
    try {
      resolved = await this.resolveTableParts(physicalId);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to resolve S3 Tables Table ${logicalId} (${physicalId}): ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
    if (resolved === 'not-found') {
      // Already gone — delete is idempotent, same as the DeleteTable
      // NotFoundException arm below.
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`S3 Tables Table ${physicalId} does not exist, skipping deletion`);
      return;
    }
    if (resolved === 'unparseable') {
      throw new ProvisioningError(
        compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }

    const { tableBucketARN, namespace, name } = resolved;

    try {
      await this.getClient().send(
        new DeleteTableCommand({
          tableBucketARN,
          namespace,
          name,
        })
      );
      this.logger.debug(`Successfully deleted S3 Tables Table ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`S3 Tables Table ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete S3 Tables Table ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  // ─── Tag helpers (#609 backfill for AWS::S3Tables::Table) ─────────

  /**
   * Convert a well-formed CFn tag list (already read through `tag-list.ts`)
   * to the S3Tables SDK's `Record<string, string>` shape. Returns `undefined`
   * for an empty list so the caller can omit the field from the create call
   * — the SDK rejects an empty `tags: {}` map with InvalidRequestException.
   */
  private tagListToSdkMap(tags: CfnTagEntry[]): Record<string, string> | undefined {
    if (tags.length === 0) return undefined;
    const map: Record<string, string> = {};
    for (const t of tags) map[t.Key] = t.Value;
    return map;
  }

  /**
   * The RenameTable a Table update owes, or `undefined` when the desired
   * `TableName` (or its `Name` alias) and `Namespace` match the table the
   * record names (go-to-k/cdkd#5313).
   *
   * Compared with the PHYSICAL ID, not the previous properties: the id names
   * the table AWS holds, and a record an older cdkd wrote after a silently
   * dropped rename carries the new name in its properties only. A key the
   * template omits keeps its current value.
   *
   * The new id keeps the stored shape: a composite gets the new namespace and
   * name; a bare table ARN (an imported row) stays as it is, since a rename
   * keeps the table's ARN.
   */
  private async planTableRename(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<
    | {
        command: RenameTableCommand;
        physicalId: string;
        target: { tableBucketARN: string; namespace: string; name: string };
      }
    | undefined
  > {
    const desiredString = (key: string, value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === 'string' && value.length > 0) return value;
      throw new ProvisioningError(
        safeMsg`${key} for S3 Tables Table ${logicalId} must be a non-empty string; refusing the update`,
        resourceType,
        logicalId,
        physicalId
      );
    };
    const desiredNamespace = desiredString('Namespace', properties['Namespace']);
    const desiredName = desiredString('TableName', properties['TableName'] ?? properties['Name']);
    if (desiredNamespace === undefined && desiredName === undefined) return undefined;

    const current = await this.resolveTableParts(physicalId);
    if (current === 'not-found' || current === 'unparseable') {
      throw new ProvisioningError(
        current === 'not-found'
          ? safeMsg`S3 Tables Table '${physicalId}' no longer exists (state is out of sync); ` +
              `refusing to record a rename that did not happen`
          : compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }
    const newNamespace = desiredNamespace ?? current.namespace;
    const newName = desiredName ?? current.name;
    if (newNamespace === current.namespace && newName === current.name) return undefined;

    const newPhysicalId = physicalId.includes('|')
      ? packCompositeId(
          resourceType,
          logicalId,
          [
            { name: 'tableBucketARN', value: current.tableBucketARN },
            { name: 'namespace', value: newNamespace },
            { name: 'name', value: newName },
          ],
          { maskSecrets: mask }
        )
      : physicalId;
    return {
      physicalId: newPhysicalId,
      target: { tableBucketARN: current.tableBucketARN, namespace: newNamespace, name: newName },
      command: new RenameTableCommand({
        tableBucketARN: current.tableBucketARN,
        namespace: current.namespace,
        name: current.name,
        ...(newNamespace !== current.namespace && { newNamespaceName: newNamespace }),
        ...(newName !== current.name && { newName }),
      }),
    };
  }

  /**
   * Whether a RenameTable that answered `NotFoundException` had already been
   * applied: a replay of a rename whose first answer was lost (an SDK or
   * deploy-engine retry after a 5xx) finds the old name gone. Only on EXACT
   * attribution: the table now at the target name carries the `TableARN` the
   * record holds (its trailing table id is unique and a rename keeps it). A
   * record without one, or another table at the target name, is not this
   * table, and the NotFound is surfaced.
   */
  private async renameAlreadyApplied(
    target: { tableBucketARN: string; namespace: string; name: string },
    recordedAttributes: Readonly<Record<string, unknown>> | undefined
  ): Promise<boolean> {
    const recordedArn = recordedAttributes?.['TableARN'];
    if (typeof recordedArn !== 'string' || recordedArn.length === 0) return false;
    // A failed lookup (AccessDenied, a throttle) attributes nothing; the
    // caller then rethrows the ORIGINAL NotFound, not this read's error.
    try {
      const liveArn = await this.lookupTableArn(
        target.tableBucketARN,
        target.namespace,
        target.name
      );
      return liveArn === recordedArn;
    } catch (lookupError) {
      this.logger.debug(
        safeMsg`Could not check whether the rename of ${target.name} was already applied: ${describeAwsFailure(lookupError).summary}`
      );
      return false;
    }
  }

  /**
   * Look up a table's real AWS ARN given its cdkd-compound physical
   * id parts. The real ARN is opaque (NOT `<bucketArn>/table/<ns>/<name>`
   * — that shape returns BadRequestException) and only AWS knows it,
   * so we call `GetTable` and pull `tableARN` from the response. Used
   * by the tag-diff path in update() and the readback's tag-fetch leg.
   * Returns null if the table is gone (NotFoundException → caller can
   * skip the tag op gracefully).
   */
  private async lookupTableArn(
    tableBucketARN: string,
    namespace: string,
    name: string
  ): Promise<string | null> {
    try {
      const resp = await this.getClient().send(
        new GetTableCommand({ tableBucketARN, namespace, name })
      );
      return resp.tableARN ?? null;
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  /**
   * Best-effort tag readback. ListTagsForResource against a freshly-
   * created table can briefly 404 due to eventual consistency; emit
   * `[]` on any failure rather than propagate (matches the S3Vectors /
   * CloudFront patterns and keeps the drift comparator happy).
   */
  private async readTagsBestEffort(
    resourceArn: string
  ): Promise<Array<{ Key: string; Value: string }>> {
    try {
      const resp = await this.getClient().send(new ListTagsForResourceCommand({ resourceArn }));
      // S3Tables' ListTagsForResource returns `tags: Record<string, string>`
      // (a flat map), not an array of {Key, Value} objects. Reshape to CFn's
      // canonical array form for drift-comparison parity.
      const tags = resp.tags ?? {};
      const out: Array<{ Key: string; Value: string }> = [];
      for (const [Key, Value] of Object.entries(tags)) {
        out.push({ Key, Value });
      }
      return out;
    } catch (err) {
      this.logger.debug(
        `readTagsBestEffort: ListTagsForResource failed for ${resourceArn}: ${describeAwsFailure(err).detail} — emitting Tags: []`
      );
      return [];
    }
  }

  /**
   * Apply a tag-diff against a Table resource ARN: keys present in
   * `previousTags` but absent / value-changed in `newTags` go through
   * `UntagResource`, then the full upsert set (additions + value
   * rewrites) goes through `TagResource`. Removal runs FIRST so a
   * value-only rewrite on key K isn't accidentally cleared by a stale
   * UntagResource pass (matches the CloudFront / S3Vectors pattern).
   *
   * Tag-side failures THROW `ProvisioningError` (issue #740 fix): a
   * silent swallow would let the deploy engine write the new properties.Tags
   * to state as if applied, and the next deploy's diff (template Tags
   * vs new state Tags) sees no change → tag-diff never re-fires → AWS
   * tags stay stale forever. Throwing means: (a) state is NOT written,
   * (b) the next deploy retries the tag-diff against the still-old
   * state. The deploy engine's `withRetry` MAY pick up transient AWS
   * errors via the cause-message-pattern match in `retryable-errors.ts`,
   * but bare HTTP 429 throttles can slip past the classifier's
   * single-level `.cause` walk depending on wrapping — so the
   * **load-bearing retry guarantee is the next-deploy retry**, not
   * in-deploy retry. For the S3Tables Table case `update()` is
   * otherwise a no-op (the Table itself is immutable), so a tag-side
   * throw cleanly turns the whole update into a retry without
   * side-effects.
   *
   * The malformed-physicalId / GetTable-NotFound branches throw too
   * — both indicate a state-vs-AWS divergence the user needs to see,
   * not silently skip past.
   */
  private async applyTableTagsDiff(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    previousTags: unknown,
    newTags: unknown,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    // Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
    // unreadable record untags nothing.
    const plan = planTagDiff(previousTags, newTags);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const removedKeys = plan.remove;
    const upserts: Record<string, string> = Object.fromEntries(plan.set);

    // No tag delta → no work, no error.
    if (removedKeys.length === 0 && Object.keys(upserts).length === 0) return;

    // Accepts cdkd's composite AND CloudFormation's bare TableARN, like the
    // delete / read paths — an imported row can carry either.
    const resolvedParts = await this.resolveTableParts(physicalId);
    if (resolvedParts === 'not-found') {
      throw new ProvisioningError(
        `applyTableTagsDiff: table '${physicalId}' no longer exists (state is out of sync) — ` +
          `refusing to silently drop the tag update`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    if (resolvedParts === 'unparseable') {
      throw new ProvisioningError(
        `applyTableTagsDiff: ` +
          `${compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId)}. ` +
          `Cannot derive the table ARN for the tag update, and refusing to silently drop it.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const { tableBucketARN, namespace, name } = resolvedParts;

    // Tag APIs need the REAL table ARN (not cdkd's compound physical id
    // and not a guessed derivation from the parts — AWS rejects every
    // form except its own). Look it up via GetTable.
    const resourceArn = await this.lookupTableArn(tableBucketARN, namespace, name);
    if (!resourceArn) {
      throw new ProvisioningError(
        // The command is NOT inside the prose `'...'` span: an operator
        // selects that span WITH its quotes, and an interpolated value carrying
        // `'` then closes the wrapper so the rest runs as shell
        // (go-to-k/cdkd#3363 measured it; go-to-k/cdkd#3436 owns the class).
        //
        // It names `cdkd orphan`, and the COMMAND was wrong before review
        // caught it (M1 of the go-to-k/cdkd#3613 review): the line passed this
        // TABLE's logical id to `cdkd state orphan`, which declares
        // `<stacks...>` and drops a WHOLE stack's record -- in every region
        // when no `--stack-region` is given. Moving a command out of the
        // injection class says nothing about whether it MEANS anything, and a
        // shape fence cannot see the difference; only reading it can. It is the
        // same defect as the `cdkd import` positional this PR fixes one file
        // over.
        //
        // The per-resource command is `cdkd orphan <paths...>`, which takes
        // CONSTRUCT PATHS. This provider has a logical id and a physical id and
        // no construct path, so the target is a quoted HOLE rather than a value
        // it would have to invent -- inert when pasted, and the sentence says
        // where to read it. It names the template's `aws:cdk:path` Metadata and
        // NOT `cdkd list`: that command lists STACKS, so its paths cannot
        // supply a resource target (review caught the first wording).
        safeMsg`applyTableTagsDiff: GetTable returned no tableARN for ${physicalId} — table is gone ` +
          `or state is out-of-sync. Refusing to silently drop the tag update. If the table was ` +
          `deleted out-of-band, drop just this resource's record with the command below, ` +
          `filling in the construct path the CDK app gave this resource — its aws:cdk:path ` +
          `Metadata entry in the synthesized template.` +
          `\nClean up with: cdkd orphan ${commandHole('constructPath')}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (removedKeys.length > 0) {
      try {
        await this.getClient().send(
          new UntagResourceCommand({ resourceArn, tagKeys: removedKeys })
        );
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw this.wrapCaughtError(
          mask,
          err,
          (text) =>
            new ProvisioningError(
              `applyTableTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
    }

    if (Object.keys(upserts).length > 0) {
      try {
        await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw this.wrapCaughtError(
          mask,
          err,
          (text) =>
            new ProvisioningError(
              `applyTableTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
    }
  }

  /**
   * Apply a tag-diff against a TableBucket resource ARN. Mirrors
   * `applyTableTagsDiff` for the Table case, but simpler: TableBucket's
   * `physicalId` IS the bucket ARN, so no `GetTableBucket` lookup hop
   * is needed (the Table version needs `GetTable` to recover the real
   * ARN from the cdkd-compound `<bucketArn>|<namespace>|<name>` physical id).
   *
   * Same throw semantics as `applyTableTagsDiff` (per issue #740 / PR
   * #741): tag-side failures THROW `ProvisioningError` so state is NOT
   * written, and the next deploy retries against the still-old state.
   * `update()` for AWS::S3Tables::TableBucket is otherwise a no-op (the
   * bucket itself is immutable), so a tag-side throw cleanly turns the
   * whole update into a clean retry with no side-effects.
   */
  private async applyTableBucketTagsDiff(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    previousTags: unknown,
    newTags: unknown,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    // Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
    // unreadable record untags nothing.
    const plan = planTagDiff(previousTags, newTags);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const removedKeys = plan.remove;
    const upserts: Record<string, string> = Object.fromEntries(plan.set);

    // No tag delta → no work, no error.
    if (removedKeys.length === 0 && Object.keys(upserts).length === 0) return;

    // physicalId IS the bucket ARN — use it directly for tag ops.
    const resourceArn = physicalId;

    if (removedKeys.length > 0) {
      try {
        await this.getClient().send(
          new UntagResourceCommand({ resourceArn, tagKeys: removedKeys })
        );
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw this.wrapCaughtError(
          mask,
          err,
          (text) =>
            new ProvisioningError(
              `applyTableBucketTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
    }

    if (Object.keys(upserts).length > 0) {
      try {
        await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw this.wrapCaughtError(
          mask,
          err,
          (text) =>
            new ProvisioningError(
              `applyTableBucketTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
    }
  }
}
