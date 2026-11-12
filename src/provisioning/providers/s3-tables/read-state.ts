import type { S3TablesProvider } from '../s3-tables-provider.js';
import {
  GetNamespaceCommand,
  GetTableBucketCommand,
  GetTableCommand,
  GetTableBucketEncryptionCommand,
  GetTableBucketLoggingCommand,
  GetTableBucketMaintenanceConfigurationCommand,
  GetTableBucketMetricsConfigurationCommand,
  GetTableBucketReplicationCommand,
  GetTableBucketStorageClassCommand,
  GetTableMaintenanceConfigurationCommand,
  NotFoundException,
  type GetTableMaintenanceConfigurationCommandOutput,
} from '@aws-sdk/client-s3tables';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { compositeIdFormatMessage } from '../../composite-id.js';
import { type ResourceNotFound, RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  S3_TABLES_TABLE_ID_FORMAT,
  type TablePartsResolution,
  parseTableCompositeId,
  tableIdentityFromGetTable,
  type CfnObject,
  defined,
  cfnBucketStatus,
} from './shared.js';

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
export async function readCurrentState(
  this: S3TablesProvider,
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

export async function readTableBucketCurrentState(
  this: S3TablesProvider,
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
 * `ReplicationConfiguration` and `LoggingConfiguration`, each emitted only
 * while configured: their members are required, so there is no "off" value
 * to emit, and a removal deletes (turns off) it. A console-side enable is
 * still compared: {@link getDriftAbsentMeansDefaultKeys} names the key while
 * the template leaves it off. A read that fails for any other
 * reason than `NotFoundException` leaves its key out, at `debug`, as the
 * tag read does.
 */
export async function readTableBucketConfigs(
  this: S3TablesProvider,
  tableBucketARN: string,
  strict = false
): Promise<CfnObject> {
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
  // go-to-k/cdkd#6167: emitted only while logging is on, as replication is:
  // every member is required, so there is no "off" value to emit.
  await this.readConfig(
    out,
    'LoggingConfiguration',
    async () => {
      const resp = await client.send(new GetTableBucketLoggingCommand({ tableBucketARN }));
      const l = resp.tableBucketLoggingStatus?.loggingEnabled;
      if (l === undefined) return undefined;
      const partitioned = l.targetObjectKeyFormat?.partitionedPrefix;
      return defined({
        TargetBucket: l.targetBucket,
        TargetPrefix: l.targetPrefix,
        TargetObjectKeyFormat:
          l.targetObjectKeyFormat &&
          defined({
            PartitionedPrefix:
              partitioned && defined({ PartitionDateSource: partitioned.partitionDateSource }),
          }),
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
export async function readConfig(
  this: S3TablesProvider,
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

export async function readNamespaceCurrentState(
  this: S3TablesProvider,
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
export async function resolveTableParts(
  this: S3TablesProvider,
  physicalId: string
): Promise<TablePartsResolution> {
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

export async function readTableCurrentState(
  this: S3TablesProvider,
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
export async function readTableMaintenance(
  this: S3TablesProvider,
  physicalId: string,
  table: { tableBucketARN: string; namespace: string; name: string },
  strict = false
): Promise<CfnObject> {
  const result: CfnObject = {};
  let maintenance: GetTableMaintenanceConfigurationCommandOutput['configuration'];
  let maintenanceRead = true;
  try {
    maintenance = (await this.getClient().send(new GetTableMaintenanceConfigurationCommand(table)))
      .configuration;
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
export async function readUnsettled(
  this: S3TablesProvider,
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
