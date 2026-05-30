import {
  S3TablesClient,
  CreateTableBucketCommand,
  DeleteTableBucketCommand,
  CreateNamespaceCommand,
  DeleteNamespaceCommand,
  CreateTableCommand,
  DeleteTableCommand,
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
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { CDK_PATH_TAG } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
    ['AWS::S3Tables::TableBucket', new Set(['TableBucketName'])],
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
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::S3Tables::TableBucket':
        return this.createTableBucket(logicalId, resourceType, properties);
      case 'AWS::S3Tables::Namespace':
        return this.createNamespace(logicalId, resourceType, properties);
      case 'AWS::S3Tables::Table':
        return this.createTable(logicalId, resourceType, properties);
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
    // S3 Tables RESOURCES themselves are immutable (no UpdateTable /
    // UpdateTableBucket / UpdateNamespace APIs), but TAGS ARE mutable
    // via the separate TagResource / UntagResource control-plane calls.
    // So `update()` is no longer a blanket no-op: when the only property
    // that changed is `Tags`, dispatch a tag-diff against the underlying
    // resource ARN. For now only AWS::S3Tables::Table has Tags wired
    // (this PR); the TableBucket / Namespace cases stay no-op until
    // their own backfill PRs (U / V).
    if (resourceType === 'AWS::S3Tables::Table') {
      await this.applyTableTagsDiff(physicalId, previousProperties['Tags'], properties['Tags']);
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

    try {
      const result = await this.getClient().send(
        new CreateTableBucketCommand({
          name: tableBucketName,
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
    properties: Record<string, unknown>
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

    // CFn schema types `Namespace` as `List<String>`, but CDK 2.x's
    // `s3tables.CfnNamespace` accepts a plain `string` and emits it as
    // a string (not a singleton array). AWS's CreateNamespace API takes
    // an array. Accept both wire shapes from the template here.
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

    try {
      await this.getClient().send(
        new CreateNamespaceCommand({
          tableBucketARN,
          namespace: [namespaceName],
        })
      );

      const physicalId = `${tableBucketARN}|${namespaceName}`;

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
        `Invalid physical ID format for S3 Tables Namespace ${logicalId}: ${physicalId}`,
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
    properties: Record<string, unknown>
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

      const physicalId = `${tableBucketARN}|${namespace}|${name}`;
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

  private async readTableCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const parts = physicalId.split('|');
    if (parts.length < 3) return undefined;
    const [tableBucketARN, namespace, name] = parts;
    if (!tableBucketARN || !namespace || !name) return undefined;

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
   *  - **AWS::S3Tables::TableBucket**: tag-based auto-lookup via
   *    `ListTableBuckets` + `ListTagsForResource(resourceArn)` (tags map).
   *    Falls back to `--resource <id>=<arn>` or `Properties.TableBucketName`
   *    (resolved by ARN suffix match against `ListTableBuckets`).
   *  - **AWS::S3Tables::Table**: tag-based auto-lookup walks every
   *    table bucket → namespace → table and calls `ListTagsForResource`
   *    on each table ARN; matches `aws:cdk:path`.
   *  - **AWS::S3Tables::Namespace**: explicit-override only. Namespaces
   *    are not taggable in S3 Tables (`ListTagsForResource` accepts only
   *    table-bucket or table ARNs), so auto-lookup is impossible.
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

    const desiredName =
      typeof input.properties?.['TableBucketName'] === 'string'
        ? input.properties['TableBucketName']
        : undefined;

    let token: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListTableBucketsCommand({ ...(token && { continuationToken: token }) })
      );
      for (const bucket of list.tableBuckets ?? []) {
        if (!bucket.arn) continue;
        if (desiredName && bucket.name === desiredName) {
          return { physicalId: bucket.arn, attributes: {} };
        }
        if (input.cdkPath) {
          try {
            const tagsResp = await this.getClient().send(
              new ListTagsForResourceCommand({ resourceArn: bucket.arn })
            );
            if (tagsResp.tags?.[CDK_PATH_TAG] === input.cdkPath) {
              return { physicalId: bucket.arn, attributes: {} };
            }
          } catch (err) {
            if (err instanceof NotFoundException) continue;
            throw err;
          }
        }
      }
      token = list.continuationToken;
    } while (token);
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  private async importNamespace(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }

  private async importTable(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      const parts = input.knownPhysicalId.split('|');
      if (parts.length >= 3) {
        try {
          await this.getClient().send(
            new GetTableCommand({
              tableBucketARN: parts[0],
              namespace: parts[1],
              name: parts[2],
            })
          );
          return { physicalId: input.knownPhysicalId, attributes: {} };
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          throw err;
        }
      }
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }

    if (!input.cdkPath) return null;

    let bucketToken: string | undefined;
    do {
      const buckets = await this.getClient().send(
        new ListTableBucketsCommand({ ...(bucketToken && { continuationToken: bucketToken }) })
      );
      for (const bucket of buckets.tableBuckets ?? []) {
        if (!bucket.arn) continue;

        let nsToken: string | undefined;
        do {
          const namespaces = await this.getClient().send(
            new ListNamespacesCommand({
              tableBucketARN: bucket.arn,
              ...(nsToken && { continuationToken: nsToken }),
            })
          );
          for (const ns of namespaces.namespaces ?? []) {
            const namespaceName = ns.namespace?.[0];
            if (!namespaceName) continue;

            let tableToken: string | undefined;
            do {
              const tables = await this.getClient().send(
                new ListTablesCommand({
                  tableBucketARN: bucket.arn,
                  namespace: namespaceName,
                  ...(tableToken && { continuationToken: tableToken }),
                })
              );
              for (const table of tables.tables ?? []) {
                if (!table.name || !table.tableARN) continue;
                try {
                  const tagsResp = await this.getClient().send(
                    new ListTagsForResourceCommand({ resourceArn: table.tableARN })
                  );
                  if (tagsResp.tags?.[CDK_PATH_TAG] === input.cdkPath) {
                    return {
                      physicalId: `${bucket.arn}|${namespaceName}|${table.name}`,
                      attributes: {},
                    };
                  }
                } catch (err) {
                  if (err instanceof NotFoundException) continue;
                  throw err;
                }
              }
              tableToken = tables.continuationToken;
            } while (tableToken);
          }
          nsToken = namespaces.continuationToken;
        } while (nsToken);
      }
      bucketToken = buckets.continuationToken;
    } while (bucketToken);
    return null;
  }

  private async deleteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 Tables Table ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length < 3) {
      throw new ProvisioningError(
        `Invalid physical ID format for S3 Tables Table ${logicalId}: ${physicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const tableBucketARN = parts[0];
    const namespace = parts[1];
    const name = parts[2];

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
   * Tag ops are best-effort post-step in update(): a tag-side failure
   * MUST NOT flip the deploy engine into a retry that would re-issue
   * the no-op `update()` body. Log at warn instead so the user sees
   * the unapplied delta but the deploy still progresses.
   */
  private async applyTableTagsDiff(
    physicalId: string,
    previousTags: unknown,
    newTags: unknown
  ): Promise<void> {
    const parts = physicalId.split('|');
    if (parts.length < 3) {
      this.logger.warn(
        `applyTableTagsDiff: cannot derive table ARN from physicalId '${physicalId}' — skipping tag-diff`
      );
      return;
    }
    const [tableBucketARN, namespace, name] = parts;
    if (!tableBucketARN || !namespace || !name) {
      this.logger.warn(
        `applyTableTagsDiff: cannot derive table ARN from malformed physicalId '${physicalId}' (empty part after split) — skipping tag-diff`
      );
      return;
    }

    const prev = this.cfnTagsToSdkMap(previousTags) ?? {};
    const next = this.cfnTagsToSdkMap(newTags) ?? {};

    const removedKeys = Object.keys(prev).filter((k) => !(k in next));
    const upserts: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (prev[k] !== v) upserts[k] = v;
    }

    if (removedKeys.length === 0 && Object.keys(upserts).length === 0) return;

    // Tag APIs need the REAL table ARN (not cdkd's compound physical id
    // and not a guessed derivation from the parts — AWS rejects every
    // form except its own). Look it up via GetTable.
    const resourceArn = await this.lookupTableArn(tableBucketARN, namespace, name);
    if (!resourceArn) {
      this.logger.warn(
        `applyTableTagsDiff: GetTable returned no tableARN for ${physicalId} — skipping tag-diff (table gone? state out-of-sync?)`
      );
      return;
    }

    if (removedKeys.length > 0) {
      try {
        await this.getClient().send(
          new UntagResourceCommand({ resourceArn, tagKeys: removedKeys })
        );
      } catch (err) {
        this.logger.warn(
          `applyTableTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (Object.keys(upserts).length > 0) {
      try {
        await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
      } catch (err) {
        this.logger.warn(
          `applyTableTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
