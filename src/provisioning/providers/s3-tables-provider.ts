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
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';
import { getLogger } from '../../utils/logger.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  compositeIdFormatMessage,
  compositeIdSeparatorRefusal,
  packCompositeId,
  type CompositeIdFormat,
} from '../composite-id.js';
import { findSilentDropProperties } from '../property-coverage.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
} from '../../types/resource.js';

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
  private client: S3TablesClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('S3TablesProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::S3Tables::TableBucket', new Set(['TableBucketName', 'Tags'])],
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
      ]),
    ],
  ]);

  private getClient(): S3TablesClient {
    if (!this.client) {
      this.client = new S3TablesClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
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
        return this.createTableBucket(logicalId, resourceType, properties);
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched. For THIS provider the
      // live case is an inner ProvisioningError (the tag-diff helpers and
      // lookupTableArn raise their own, with precise messages this outer wrap
      // would replace); the guard is written against the CdkdError base so it
      // also covers a control-flow error if one is ever added here.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 Tables resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // S3 Tables RESOURCES themselves are immutable (no UpdateTable /
    // UpdateTableBucket / UpdateNamespace APIs), but TAGS ARE mutable
    // via the separate TagResource / UntagResource control-plane calls.
    // So `update()` is no longer a blanket no-op: when the only property
    // that changed is `Tags`, dispatch a tag-diff against the underlying
    // resource ARN. Table (#609 PR #739) + TableBucket (#609, this PR)
    // both have Tags wired; the Namespace case stays no-op (Namespaces
    // are not taggable per the S3Tables SDK — ListTagsForResource only
    // accepts table-bucket or table ARNs).
    if (resourceType === 'AWS::S3Tables::Table') {
      await this.applyTableTagsDiff(
        logicalId,
        physicalId,
        resourceType,
        previousProperties['Tags'],
        properties['Tags']
      );
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
        properties['Tags']
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
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Table Bucket ${logicalId}`);

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
    const tags = this.cfnTagsToSdkMap(properties['Tags']);

    try {
      const result = await this.getClient().send(
        new CreateTableBucketCommand({
          name: tableBucketName,
          ...(tags !== undefined && { tags }),
        })
      );

      const tableBucketARN = result.arn!;

      this.logger.debug(`Successfully created S3 Table Bucket ${logicalId}: ${tableBucketARN}`);

      return {
        physicalId: tableBucketARN,
        attributes: {
          TableBucketARN: tableBucketARN,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 Table Bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
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
      throw new ProvisioningError(
        `Failed to delete S3 Table Bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
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
      await this.getClient().send(
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
      throw new ProvisioningError(
        `Failed to create S3 Tables Namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
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
      throw new ProvisioningError(
        `Failed to delete S3 Tables Namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
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
    const tags = this.cfnTagsToSdkMap(properties['Tags']);

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

    try {
      const response = await this.getClient().send(
        new CreateTableCommand({
          tableBucketARN,
          namespace,
          name,
          format: format as 'ICEBERG',
          ...(tags !== undefined && { tags }),
        })
      );

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
      throw new ProvisioningError(
        `Failed to create S3 Tables Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // ─── readCurrentState dispatch ───────────────────────────────────

  /**
   * Read the AWS-current S3 Tables resource configuration in CFn-property
   * shape.
   *
   *  - **AWS::S3Tables::TableBucket**: `GetTableBucket` for the ARN; we
   *    surface `TableBucketName` (the only mutable cdkd-managed property).
   *  - **AWS::S3Tables::Namespace**: parses `tableBucketARN|namespace`
   *    from physical id and surfaces `TableBucketARN` and `Namespace`
   *    (as a `string[]` with one entry, matching `create()`'s shape).
   *    No GetNamespace call — the physical id IS the source of truth and
   *    AWS surfaces no additional managed fields cdkd cares about.
   *  - **AWS::S3Tables::Table**: parses `tableBucketARN|namespace|name`
   *    from physical id, calls `GetTable` to verify existence and recover
   *    `format`, surfaces `TableBucketARN`, `Namespace` (string), `Name`,
   *    `Format`.
   *
   * Returns `undefined` when the resource is gone (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
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
  ): Promise<Record<string, unknown> | undefined> {
    let bucket;
    try {
      const resp = await this.getClient().send(
        new GetTableBucketCommand({ tableBucketARN: physicalId })
      );
      bucket = resp;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
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
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- structural; physical id is the source of truth
  private async readNamespaceCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const [tableBucketARN, namespaceName] = physicalId.split('|');
    if (!tableBucketARN || !namespaceName) return undefined;

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
  ): Promise<Record<string, unknown> | undefined> {
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
          `(${err instanceof Error ? err.message : String(err)}); reporting drift as unknown.`
      );
      return undefined;
    }
    if (resolved === 'not-found' || resolved === 'unparseable') return undefined;
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
      if (err instanceof NotFoundException) return undefined;
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
    return result;
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
   * pre-substitutes only single-key `{Ref}` before calling a provider, and
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
    // property (`IcebergMetadata` / `Compaction` / `SnapshotManagement` /
    // `StorageClassConfiguration` / `WithoutMetadata`) is auto-routed to Cloud
    // Control by the #614 rule, and CC's Identifier for this type is the bare
    // `TableARN` — not cdkd's composite. `cdkd import` records
    // `provisionedBy: 'sdk'`, but ONLY `'cc-api'` is sticky, so the next
    // deploy / destroy re-derives the route from the template and such a table
    // lands on CC. Canonicalizing unconditionally would therefore hand Cloud
    // Control `arn|ns|name` and break exactly the tables the ARN form was
    // (accidentally) correct for before this PR.
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
      throw new ProvisioningError(
        `Failed to resolve S3 Tables Table ${logicalId} (${physicalId}): ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
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
      throw new ProvisioningError(
        `Failed to delete S3 Tables Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Tag helpers (#609 backfill for AWS::S3Tables::Table) ─────────

  /**
   * Convert CFn `Tags: [{ Key, Value }]` to the S3Tables SDK's
   * `Record<string, string>` shape. Returns `undefined` when the input
   * is absent, empty, or invalid (so the caller can omit the field
   * from CreateTableCommand — the SDK rejects an empty `tags: {}` map
   * with InvalidRequestException). Entries missing a `Key` are skipped;
   * a missing `Value` is normalized to `''` (matches the on-AWS
   * representation — empty-string tag values are legal).
   */
  private cfnTagsToSdkMap(value: unknown): Record<string, string> | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const map: Record<string, string> = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const key = (entry as { Key?: unknown }).Key;
      if (typeof key !== 'string' || key.length === 0) continue;
      const raw = (entry as { Value?: unknown }).Value;
      if (typeof raw === 'string') {
        map[key] = raw;
      } else if (raw === undefined || raw === null) {
        map[key] = '';
      } else if (typeof raw === 'number' || typeof raw === 'boolean') {
        map[key] = String(raw);
      } else {
        // Skip non-stringifiable values rather than emit '[object Object]'.
        continue;
      }
    }
    return Object.keys(map).length > 0 ? map : undefined;
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
        `readTagsBestEffort: ListTagsForResource failed for ${resourceArn}: ${err instanceof Error ? err.message : String(err)} — emitting Tags: []`
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
    newTags: unknown
  ): Promise<void> {
    const prev = this.cfnTagsToSdkMap(previousTags) ?? {};
    const next = this.cfnTagsToSdkMap(newTags) ?? {};

    const removedKeys = Object.keys(prev).filter((k) => !(k in next));
    const upserts: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (prev[k] !== v) upserts[k] = v;
    }

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
        `applyTableTagsDiff: GetTable returned no tableARN for ${physicalId} — table is gone or state is out-of-sync. Refusing to silently drop the tag update (run 'cdkd state orphan ${logicalId}' to clean up if the table was deleted out-of-band).`,
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
        throw new ProvisioningError(
          `applyTableTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${err instanceof Error ? err.message : String(err)}. State has NOT been updated so the next deploy will retry the tag-diff.`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }

    if (Object.keys(upserts).length > 0) {
      try {
        await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new ProvisioningError(
          `applyTableTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${err instanceof Error ? err.message : String(err)}. State has NOT been updated so the next deploy will retry the tag-diff.`,
          resourceType,
          logicalId,
          physicalId,
          cause
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
    newTags: unknown
  ): Promise<void> {
    const prev = this.cfnTagsToSdkMap(previousTags) ?? {};
    const next = this.cfnTagsToSdkMap(newTags) ?? {};

    const removedKeys = Object.keys(prev).filter((k) => !(k in next));
    const upserts: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (prev[k] !== v) upserts[k] = v;
    }

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
        throw new ProvisioningError(
          `applyTableBucketTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${err instanceof Error ? err.message : String(err)}. State has NOT been updated so the next deploy will retry the tag-diff.`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }

    if (Object.keys(upserts).length > 0) {
      try {
        await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new ProvisioningError(
          `applyTableBucketTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${err instanceof Error ? err.message : String(err)}. State has NOT been updated so the next deploy will retry the tag-diff.`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }
  }
}
