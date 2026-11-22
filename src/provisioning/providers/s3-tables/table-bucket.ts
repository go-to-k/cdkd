import type { S3TablesProvider } from '../s3-tables-provider.js';
import {
  CreateTableBucketCommand,
  DeleteTableBucketCommand,
  DeleteNamespaceCommand,
  DeleteTableCommand,
  GetTableBucketCommand,
  ListNamespacesCommand,
  ListTablesCommand,
  DeleteTableBucketMetricsConfigurationCommand,
  DeleteTableBucketReplicationCommand,
  PutTableBucketEncryptionCommand,
  PutTableBucketLoggingCommand,
  PutTableBucketMaintenanceConfigurationCommand,
  PutTableBucketMetricsConfigurationCommand,
  PutTableBucketReplicationCommand,
  PutTableBucketStorageClassCommand,
  PutTableMaintenanceConfigurationCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';
import { isDeepStrictEqual } from 'node:util';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { markNotGone } from '../../not-gone.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, holderRefusalMask, type DeleteContext } from '../../region-check.js';
import { compositeIdFormatMessage } from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  S3_TABLES_TABLE_ID_FORMAT,
  type CfnObject,
  desiredObject,
  recordedObject,
  refuseNonIntegers,
  sdkEncryption,
  sdkStorageClass,
  sdkReplication,
  sdkLogging,
  refuseMalformedLogging,
  sdkUnreferencedFileRemoval,
  metricsEnabled,
  type TableMaintenanceWrite,
  TABLE_MAINTENANCE,
} from './shared.js';

// ─── AWS::S3Tables::TableBucket ───────────────────────────────────

export async function createTableBucket(
  this: S3TablesProvider,
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
  const encryption = desiredObject(properties, 'EncryptionConfiguration', resourceType, logicalId);
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
  const logging = desiredObject(properties, 'LoggingConfiguration', resourceType, logicalId);
  if (logging !== undefined) refuseMalformedLogging(logging, resourceType, logicalId);
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
    // Logging is off on a new bucket, so only a declared one is sent
    // (go-to-k/cdkd#6167).
    if (logging !== undefined) {
      await this.getClient().send(
        new PutTableBucketLoggingCommand({
          tableBucketARN,
          tableBucketLoggingStatus: sdkLogging(logging),
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
 * value turns replication off) are deleted, and `LoggingConfiguration` (every
 * member required, likewise) is turned off. `EncryptionConfiguration`,
 * `StorageClassConfiguration` and `UnreferencedFileRemoval` each have a
 * declarable value for their default, and what CloudFormation sets on their
 * removal is unmeasured, so a removal leaves the AWS value in place and says
 * so (docs/provider-rules.md, "Update removal semantics").
 *
 * Each write is preceded by `markUnsettled(key)`: a failure after an
 * earlier write landed leaves the record naming what may differ on AWS
 * (docs/provider-rules.md, #5380).
 */
export async function applyTableBucketConfigUpdate(
  this: S3TablesProvider,
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

  // go-to-k/cdkd#6167: a removal sends the empty status, which turns logging
  // off (the SDK model's documented "disable"): every member of a declared
  // LoggingConfiguration is required, so no declared value says "off".
  const [logging, loggingChanged] = changed('LoggingConfiguration');
  if (loggingChanged) {
    markUnsettled('LoggingConfiguration');
    await client.send(
      new PutTableBucketLoggingCommand({
        tableBucketARN,
        tableBucketLoggingStatus: logging !== undefined ? sdkLogging(logging) : {},
      })
    );
  }
}

/**
 * The Table's maintenance properties on an update (go-to-k/cdkd#2762), each
 * written by PutTableMaintenanceConfiguration only when it changed. Both
 * have a declarable `disabled`, and what CloudFormation sets on their
 * removal is unmeasured, so a removal leaves the AWS value in place and says
 * so, as for the bucket's (see {@link applyTableBucketConfigUpdate}).
 */
export async function applyTableMaintenanceUpdate(
  this: S3TablesProvider,
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
export function warnRemovalKept(this: S3TablesProvider, logicalId: string, key: string): void {
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
export async function deleteBucketConfig(
  this: S3TablesProvider,
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

export async function deleteTableBucket(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting S3 Table Bucket ${logicalId}: ${physicalId}`);

  // go-to-k/cdkd#6749, CloudFormation parity: CFn's delete handler holds only
  // `s3tables:DeleteTableBucket`, so it never removes what the bucket holds and
  // a non-empty bucket fails its delete. The stack's own Table / Namespace
  // resources are deleted before their bucket by the DAG, so what is left here
  // was created outside the stack. It is emptied only under the deploy
  // engine's `--force-stateful-recreation` consent on a replacement delete;
  // the type has no template-borne opt-in (its registry schema declares none).
  const allowEmpty = context?.forceDataDelete === true;

  if (allowEmpty) {
    try {
      await this.emptyTableBucket(physicalId);
    } catch (error) {
      return failTableBucketDelete.call(this, logicalId, physicalId, resourceType, error, context);
    }
  }
  // Two attempts at most: the second only after the settle below saw the
  // bucket empty, i.e. what refused the first was the stack's own children.
  for (let attempt = 1; ; attempt++) {
    try {
      await this.getClient().send(
        new DeleteTableBucketCommand({
          tableBucketARN: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted S3 Table Bucket ${logicalId}`);
      return;
    } catch (error) {
      if (error instanceof NotFoundException || allowEmpty || attempt > 1) {
        return failTableBucketDelete.call(
          this,
          logicalId,
          physicalId,
          resourceType,
          error,
          context
        );
      }
      // A failed delete of a bucket that still holds something is refused with
      // what it holds, and not retried: only the user can empty it. Read only
      // after a failure, so a delete that succeeds costs no extra call; a
      // listing that fails leaves the original error to its classifiers.
      const held = await settledTableBucketContents.call(this, physicalId).catch((listError) => {
        this.logger.debug(
          safeMsg`Could not list S3 Table Bucket ${logicalId} after its delete failed: ${listError instanceof Error ? listError.name : typeof listError}`
        );
        return undefined;
      });
      if (held === 'empty') continue;
      if (held !== undefined) {
        // go-to-k/cdkd#6772: a table the stack retained can be named from a secret.
        const mask = holderRefusalMask(context, context?.maskSecrets ?? ((text: string) => text));
        throw markNonRetryable(
          new ProvisioningError(
            mask(
              `Failed to delete S3 Table Bucket ${logicalId}: table bucket ${physicalId} is not ` +
                `empty: it holds ${describeTableBucketContents(held)}. This operation did not ` +
                `delete them: they were created outside the stack, or retained by a ` +
                `DeletionPolicy. Matching CloudFormation, cdkd does not delete them. Delete them ` +
                `first (aws s3tables delete-table, then aws s3tables delete-namespace) and retry ` +
                `the operation; a replacement deletes them only under --force-stateful-recreation.`
            ),
            resourceType,
            logicalId,
            physicalId,
            error instanceof Error ? error : undefined
          )
        );
      }
      return failTableBucketDelete.call(this, logicalId, physicalId, resourceType, error, context);
    }
  }
}

/** A table bucket delete's failure, as every attempt surfaces it. */
async function failTableBucketDelete(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  error: unknown,
  context?: DeleteContext
): Promise<void> {
  if (error instanceof NotFoundException) {
    const clientRegion = await this.getClient().config.region();
    assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
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
  throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/** At most this many tables and namespaces are named by a not-empty refusal. */
const HELD_NAME_LIMIT = 5;

interface TableBucketContents {
  namespaces: string[];
  /** `<namespace>.<table>` */
  tables: string[];
  /** More exists than the names listed. */
  truncated: boolean;
}

/**
 * The not-empty refusal's settle (go-to-k/cdkd#6749): the bucket is listed
 * every {@link HELD_POLL_MS} until what it holds has stayed the same for
 * {@link HELD_STABLE_POLLS} listings in a row, or {@link HELD_MAX_POLLS} have
 * run. The stack's own `DeleteTable` / `DeleteNamespace` return before their
 * deletion shows in a listing, so right after them the bucket can still list
 * them; a set that changes is still draining, and one that empties lets the
 * delete be tried again. Only content that stays put for the whole window
 * (10 s) is refused; the cap (60 s) bounds a bucket whose content keeps
 * changing, which is then refused with what it holds last.
 */
const HELD_POLL_MS = 2000;
const HELD_STABLE_POLLS = 5;
const HELD_MAX_POLLS = 30;

/**
 * Up to {@link HELD_NAME_LIMIT} namespaces and tables of a table bucket, for a
 * not-empty refusal: one page of each listing, so a large bucket is never
 * walked in full.
 */
async function listTableBucketContents(
  this: S3TablesProvider,
  tableBucketARN: string
): Promise<TableBucketContents> {
  const namespaces = await this.getClient().send(new ListNamespacesCommand({ tableBucketARN }));
  const namespaceNames = (namespaces.namespaces ?? [])
    .map((ns) => ns.namespace?.[0])
    .filter((name): name is string => !!name);
  // No `namespace`: one listing of the whole bucket.
  const tables = await this.getClient().send(new ListTablesCommand({ tableBucketARN }));
  const tableNames = (tables.tables ?? [])
    .filter((table) => !!table.name)
    .map((table) => `${table.namespace?.[0] ?? '?'}.${table.name}`);
  return {
    namespaces: namespaceNames.slice(0, HELD_NAME_LIMIT),
    tables: tableNames.slice(0, HELD_NAME_LIMIT),
    truncated:
      namespaceNames.length > HELD_NAME_LIMIT ||
      tableNames.length > HELD_NAME_LIMIT ||
      !!namespaces.continuationToken ||
      !!tables.continuationToken,
  };
}

/**
 * What the bucket holds once it has settled (see {@link HELD_POLL_MS}), or
 * `'empty'` when a listing shows nothing (with no wait when the first does).
 */
async function settledTableBucketContents(
  this: S3TablesProvider,
  tableBucketARN: string
): Promise<TableBucketContents | 'empty'> {
  const isEmpty = (held: TableBucketContents) =>
    held.namespaces.length === 0 && held.tables.length === 0;
  const key = (held: TableBucketContents) =>
    JSON.stringify([held.namespaces, held.tables, held.truncated]);
  let held = await listTableBucketContents.call(this, tableBucketARN);
  if (isEmpty(held)) return 'empty';
  let unchanged = 0;
  for (let poll = 0; poll < HELD_MAX_POLLS && unchanged < HELD_STABLE_POLLS; poll++) {
    await new Promise((resolve) => setTimeout(resolve, HELD_POLL_MS));
    const next = await listTableBucketContents.call(this, tableBucketARN);
    if (isEmpty(next)) return 'empty';
    unchanged = key(next) === key(held) ? unchanged + 1 : 0;
    held = next;
  }
  return held;
}

function describeTableBucketContents(held: TableBucketContents): string {
  const parts: string[] = [];
  if (held.tables.length > 0) parts.push(`table(s) ${held.tables.join(', ')}`);
  if (held.namespaces.length > 0) parts.push(`namespace(s) ${held.namespaces.join(', ')}`);
  return `${parts.join('; ')}${held.truncated ? ', and more' : ''}`;
}

/**
 * Empty a table bucket by deleting all tables in all namespaces,
 * then deleting all namespaces. Called only under
 * `DeleteContext.forceDataDelete` (go-to-k/cdkd#6749).
 */
export async function emptyTableBucket(
  this: S3TablesProvider,
  tableBucketARN: string
): Promise<void> {
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
