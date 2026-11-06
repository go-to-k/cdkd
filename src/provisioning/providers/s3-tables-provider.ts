import {
  S3TablesClient,
  RenameTableCommand,
  DeleteTableBucketMetricsConfigurationCommand,
  DeleteTableBucketReplicationCommand,
} from '@aws-sdk/client-s3tables';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { CfnTagEntry } from '../tag-list.js';
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
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import type { TablePartsResolution, CfnObject } from './s3-tables/shared.js';
import {
  wrapCaughtError,
  getClient,
  getCreateClient,
  create,
  update,
  applyUpdate,
  deleteImpl,
} from './s3-tables/core.js';
import {
  createTableBucket,
  applyTableBucketConfigUpdate,
  applyTableMaintenanceUpdate,
  warnRemovalKept,
  deleteBucketConfig,
  deleteTableBucket,
  emptyTableBucket,
} from './s3-tables/table-bucket.js';
import { createNamespace, deleteNamespace } from './s3-tables/namespace.js';
import {
  createTable,
  deleteTable,
  planTableRename,
  renameAlreadyApplied,
  lookupTableArn,
} from './s3-tables/table.js';
import {
  readCurrentState,
  readTableBucketCurrentState,
  readTableBucketConfigs,
  readConfig,
  readNamespaceCurrentState,
  resolveTableParts,
  readTableCurrentState,
  readTableMaintenance,
  readUnsettled,
} from './s3-tables/read-state.js';
import { importImpl, importTableBucket, importNamespace, importTable } from './s3-tables/import.js';
import {
  tagListToSdkMap,
  readTagsBestEffort,
  applyTableTagsDiff,
  applyTableBucketTagsDiff,
} from './s3-tables/tags.js';
export { parseNamespaceCompositeId, parseTableCompositeId } from './s3-tables/shared.js';

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
export class S3TablesProvider implements ResourceProvider {
  client: S3TablesClient | undefined;
  createClient: S3TablesClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('S3TablesProvider');

  wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
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

  getClient(): S3TablesClient {
    return getClient.call(this);
  }

  getCreateClient(): S3TablesClient {
    return getCreateClient.call(this);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    recordedAttributes: Readonly<Record<string, unknown>> | undefined,
    markUnsettled: (key: string) => void
  ): Promise<ResourceUpdateResult> {
    return applyUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask,
      recordedAttributes,
      markUnsettled
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  createTableBucket(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createTableBucket.call(this, logicalId, resourceType, properties, context);
  }

  applyTableBucketConfigUpdate(
    logicalId: string,
    tableBucketARN: string,
    resourceType: string,
    properties: CfnObject,
    previousProperties: CfnObject,
    markUnsettled: (key: string) => void
  ): Promise<void> {
    return applyTableBucketConfigUpdate.call(
      this,
      logicalId,
      tableBucketARN,
      resourceType,
      properties,
      previousProperties,
      markUnsettled
    );
  }

  applyTableMaintenanceUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: CfnObject,
    previousProperties: CfnObject,
    markUnsettled: (key: string) => void
  ): Promise<void> {
    return applyTableMaintenanceUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      markUnsettled
    );
  }

  warnRemovalKept(logicalId: string, key: string): void {
    return warnRemovalKept.call(this, logicalId, key);
  }

  deleteBucketConfig(
    tableBucketARN: string,
    command: DeleteTableBucketMetricsConfigurationCommand | DeleteTableBucketReplicationCommand
  ): Promise<void> {
    return deleteBucketConfig.call(this, tableBucketARN, command);
  }

  deleteTableBucket(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteTableBucket.call(this, logicalId, physicalId, resourceType, context);
  }

  emptyTableBucket(tableBucketARN: string): Promise<void> {
    return emptyTableBucket.call(this, tableBucketARN);
  }

  createNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createNamespace.call(this, logicalId, resourceType, properties, context);
  }

  deleteNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteNamespace.call(this, logicalId, physicalId, resourceType, context);
  }

  createTable(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createTable.call(this, logicalId, resourceType, properties, context);
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType);
  }

  readTableBucketCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readTableBucketCurrentState.call(this, physicalId);
  }

  readTableBucketConfigs(tableBucketARN: string, strict = false): Promise<CfnObject> {
    return readTableBucketConfigs.call(this, tableBucketARN, strict);
  }

  readConfig(
    out: CfnObject,
    key: string,
    read: () => Promise<CfnObject | undefined>,
    notFound: CfnObject | 'absent',
    strict = false
  ): Promise<void> {
    return readConfig.call(this, out, key, read, notFound, strict);
  }

  readNamespaceCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readNamespaceCurrentState.call(this, physicalId);
  }

  resolveTableParts(physicalId: string): Promise<TablePartsResolution> {
    return resolveTableParts.call(this, physicalId);
  }

  readTableCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readTableCurrentState.call(this, physicalId);
  }

  readTableMaintenance(
    physicalId: string,
    table: { tableBucketARN: string; namespace: string; name: string },
    strict = false
  ): Promise<CfnObject> {
    return readTableMaintenance.call(this, physicalId, table, strict);
  }

  readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(this, physicalId, logicalId, resourceType, names);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  importTableBucket(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importTableBucket.call(this, input);
  }

  importNamespace(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importNamespace.call(this, input);
  }

  importTable(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importTable.call(this, input);
  }

  deleteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteTable.call(this, logicalId, physicalId, resourceType, context);
  }

  tagListToSdkMap(tags: CfnTagEntry[]): Record<string, string> | undefined {
    return tagListToSdkMap.call(this, tags);
  }

  planTableRename(
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
    return planTableRename.call(this, logicalId, physicalId, resourceType, properties, mask);
  }

  renameAlreadyApplied(
    target: { tableBucketARN: string; namespace: string; name: string },
    recordedAttributes: Readonly<Record<string, unknown>> | undefined
  ): Promise<boolean> {
    return renameAlreadyApplied.call(this, target, recordedAttributes);
  }

  lookupTableArn(tableBucketARN: string, namespace: string, name: string): Promise<string | null> {
    return lookupTableArn.call(this, tableBucketARN, namespace, name);
  }

  readTagsBestEffort(resourceArn: string): Promise<Array<{ Key: string; Value: string }>> {
    return readTagsBestEffort.call(this, resourceArn);
  }

  applyTableTagsDiff(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    previousTags: unknown,
    newTags: unknown,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    return applyTableTagsDiff.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      previousTags,
      newTags,
      mask
    );
  }

  applyTableBucketTagsDiff(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    previousTags: unknown,
    newTags: unknown,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    return applyTableBucketTagsDiff.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      previousTags,
      newTags,
      mask
    );
  }
}
