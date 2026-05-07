import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type Tag,
} from '@aws-sdk/client-dynamodb';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS DynamoDB Table Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::Table using the DynamoDB SDK.
 * WHY: The CC API polls for DynamoDB table creation with exponential backoff
 * (1s->2s->4s->8s->10s), but we can poll DescribeTable directly with shorter
 * intervals, eliminating the CC API intermediary overhead and reducing total
 * wait time.
 */
export class DynamoDBTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBTableProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DynamoDB::Table',
      new Set([
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'ProvisionedThroughput',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Tags',
        'DeletionProtectionEnabled',
        'TableClass',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
  }

  /**
   * Create a DynamoDB table
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DynamoDB table ${logicalId}`);

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });
    const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
    const attributeDefinitions = properties['AttributeDefinitions'] as
      | AttributeDefinition[]
      | undefined;

    if (!keySchema) {
      throw new ProvisioningError(
        `KeySchema is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!attributeDefinitions) {
      throw new ProvisioningError(
        `AttributeDefinitions is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // BillingMode (default: PROVISIONED)
      const billingMode = (properties['BillingMode'] as string | undefined) || 'PROVISIONED';

      const createParams: CreateTableCommandInput = {
        TableName: tableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
      };

      // Provisioned throughput (required when BillingMode is PROVISIONED)
      if (billingMode === 'PROVISIONED') {
        const pt = properties['ProvisionedThroughput'] as Record<string, unknown> | undefined;
        createParams.ProvisionedThroughput = {
          ReadCapacityUnits: Number(pt?.['ReadCapacityUnits'] ?? 5),
          WriteCapacityUnits: Number(pt?.['WriteCapacityUnits'] ?? 5),
        };
      }

      // Stream specification - CDK omits StreamEnabled, SDK requires it
      if (properties['StreamSpecification']) {
        const streamSpec = properties['StreamSpecification'] as Record<string, unknown>;
        createParams.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: streamSpec['StreamViewType'] as string,
        } as StreamSpecification;
      }

      // Global secondary indexes
      if (properties['GlobalSecondaryIndexes']) {
        createParams.GlobalSecondaryIndexes = properties[
          'GlobalSecondaryIndexes'
        ] as GlobalSecondaryIndex[];
      }

      // Local secondary indexes
      if (properties['LocalSecondaryIndexes']) {
        createParams.LocalSecondaryIndexes = properties[
          'LocalSecondaryIndexes'
        ] as LocalSecondaryIndex[];
      }

      // SSE specification
      if (properties['SSESpecification']) {
        createParams.SSESpecification = properties[
          'SSESpecification'
        ] as CreateTableCommandInput['SSESpecification'];
      }

      // Tags
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
      }

      // DeletionProtectionEnabled
      if (properties['DeletionProtectionEnabled'] !== undefined) {
        createParams.DeletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
      }

      // Table class
      if (properties['TableClass']) {
        createParams.TableClass = properties['TableClass'] as
          | 'STANDARD'
          | 'STANDARD_INFREQUENT_ACCESS';
      }

      await this.dynamoDBClient.send(new CreateTableCommand(createParams));

      this.logger.debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE status`);

      // Poll until table is ACTIVE
      const tableInfo = await this.waitForTableActive(tableName);

      this.logger.debug(`Successfully created DynamoDB table ${logicalId}: ${tableName}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }
  }

  /**
   * Update a DynamoDB table
   *
   * DynamoDB tables have limited in-place update capabilities.
   * For immutable property changes (KeySchema, etc.), the deployment layer
   * handles replacement via DELETE + CREATE.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DynamoDB table ${logicalId}: ${physicalId}`);

    try {
      // Get current table description for attributes (also gives us the
      // table ARN we need for tag mutations).
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );

      const table = response.Table;

      // Apply tag diff if changed. DynamoDB's TagResource takes
      // [{ Key, Value }] arrays; UntagResource takes a TagKeys list.
      if (table?.TableArn) {
        await this.applyTagDiff(
          table.TableArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: table?.TableArn,
          TableId: table?.TableId,
          StreamArn: table?.LatestStreamArn,
          TableName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a DynamoDB table
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DynamoDB table ${logicalId}: ${physicalId}`);

    try {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
      this.logger.debug(`Successfully deleted DynamoDB table ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.dynamoDBClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DynamoDB table ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via DynamoDB's
   * `TagResource` / `UntagResource` APIs. Both take the table ARN as
   * `ResourceArn`.
   */
  private async applyTagDiff(
    tableArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.dynamoDBClient.send(
        new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from DynamoDB table ${tableArn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.dynamoDBClient.send(
        new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on DynamoDB table ${tableArn}`);
    }
  }

  /**
   * Poll DescribeTable until the table reaches ACTIVE status
   *
   * Uses a tight polling loop (1s intervals) instead of CC API's exponential
   * backoff (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForTableActive(
    tableName: string,
    maxAttempts = 60
  ): Promise<{
    tableArn: string | undefined;
    tableId: string | undefined;
    streamArn: string | undefined;
  }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );

      const status = response.Table?.TableStatus;
      this.logger.debug(`Table ${tableName} status: ${status} (attempt ${attempt}/${maxAttempts})`);

      if (status === 'ACTIVE') {
        return {
          tableArn: response.Table?.TableArn,
          tableId: response.Table?.TableId,
          streamArn: response.Table?.LatestStreamArn,
        };
      }

      if (status !== 'CREATING') {
        throw new Error(`Unexpected table status: ${status}`);
      }

      // Wait 1 second between polls
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds`);
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB table.
   *
   * CloudFormation's `AWS::DynamoDB::Table` exposes `Arn`, `StreamArn`
   * (a.k.a. `LatestStreamArn` in the SDK; CFn returns the latest enabled
   * stream's ARN), and `LatestStreamLabel`. All three are sibling fields on
   * the same `DescribeTable` response, so a single API call covers every
   * supported attr. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#aws-resource-dynamodb-table-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      switch (attributeName) {
        case 'Arn':
          return resp.Table?.TableArn;
        case 'StreamArn':
          return resp.Table?.LatestStreamArn;
        case 'LatestStreamLabel':
          return resp.Table?.LatestStreamLabel;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current DynamoDB table configuration in CFn-property shape.
   *
   * `DescribeTable` returns every field cdkd manages in one call. AWS uses
   * the same property names CFn does (KeySchema, AttributeDefinitions,
   * BillingModeSummary.BillingMode, ProvisionedThroughput, etc.) — the only
   * shape differences are wrapping:
   *  - BillingMode lives under `BillingModeSummary.BillingMode` in the API
   *    response, but the CFn property is a flat `BillingMode` string.
   *  - StreamSpecification's CFn shape includes only `StreamViewType`; the
   *    API response carries `StreamEnabled` too. We surface both since the
   *    drift comparator only descends into keys present in state.
   *  - GSI / LSI in the API response include `IndexStatus`, `ItemCount` and
   *    sizing fields that cdkd never sets; the comparator filters them.
   *
   * Returns `undefined` when the table is gone (`ResourceNotFoundException`).
   *
   * Tags are surfaced via a follow-up `ListTagsOfResource` call (DynamoDB
   * doesn't include tags in `DescribeTable`). CDK's `aws:*` auto-tags are
   * filtered out by `normalizeAwsTagsToCfn` so they don't fire false-positive
   * drift, and the result key is omitted entirely when AWS reports no user
   * tags (matches `create()`'s behavior of only sending Tags when the
   * template carries them).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const table = resp.Table;
      if (!table) return undefined;

      const result: Record<string, unknown> = {};

      if (table.TableName !== undefined) result['TableName'] = table.TableName;
      if (table.KeySchema) result['KeySchema'] = table.KeySchema;
      if (table.AttributeDefinitions) {
        result['AttributeDefinitions'] = table.AttributeDefinitions;
      }
      if (table.BillingModeSummary?.BillingMode) {
        result['BillingMode'] = table.BillingModeSummary.BillingMode;
      }
      if (table.ProvisionedThroughput) {
        // AWS returns extra read-only fields (LastIncrease/DecreaseDateTime,
        // NumberOfDecreasesToday) — drop them to keep the snapshot tight.
        result['ProvisionedThroughput'] = {
          ReadCapacityUnits: table.ProvisionedThroughput.ReadCapacityUnits,
          WriteCapacityUnits: table.ProvisionedThroughput.WriteCapacityUnits,
        };
      }
      if (table.StreamSpecification) {
        result['StreamSpecification'] = {
          StreamEnabled: table.StreamSpecification.StreamEnabled,
          StreamViewType: table.StreamSpecification.StreamViewType,
        };
      }
      result['GlobalSecondaryIndexes'] = table.GlobalSecondaryIndexes ?? [];
      result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes ?? [];
      // CFn's SSESpecification.SSEEnabled / KMSMasterKeyId / SSEType.
      const sse: Record<string, unknown> = {
        SSEEnabled: table.SSEDescription?.Status === 'ENABLED',
      };
      if (table.SSEDescription?.KMSMasterKeyArn !== undefined) {
        sse['KMSMasterKeyId'] = table.SSEDescription.KMSMasterKeyArn;
      }
      if (table.SSEDescription?.SSEType !== undefined)
        sse['SSEType'] = table.SSEDescription.SSEType;
      result['SSESpecification'] = sse;
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
      }
      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }

      // Tags via ListTagsOfResource — needs the table ARN we just got back.
      if (table.TableArn) {
        try {
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: table.TableArn })
          );
          const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
          result['Tags'] = tags;
        } catch (err) {
          // Tag fetch failures shouldn't tank the whole drift read; rethrow
          // only on hard "table gone" semantics.
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing DynamoDB table into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.TableName` → verify via `DescribeTable`.
   *  2. `ListTables` + `ListTagsOfResource`, match `aws:cdk:path` tag.
   *
   * Tags require the table ARN, which `DescribeTable` provides; the loop
   * therefore costs one `DescribeTable` per table just to read the ARN.
   * Acceptable for typical DynamoDB cardinalities.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'TableName');
    if (explicit) {
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let exclusiveStartTableName: string | undefined;
    do {
      const list = await this.dynamoDBClient.send(
        new ListTablesCommand({
          ...(exclusiveStartTableName && { ExclusiveStartTableName: exclusiveStartTableName }),
        })
      );
      for (const name of list.TableNames ?? []) {
        try {
          const desc = await this.dynamoDBClient.send(
            new DescribeTableCommand({ TableName: name })
          );
          const arn = desc.Table?.TableArn;
          if (!arn) continue;
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: arn })
          );
          if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
            return { physicalId: name, attributes: {} };
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundException) continue;
          throw err;
        }
      }
      exclusiveStartTableName = list.LastEvaluatedTableName;
    } while (exclusiveStartTableName);
    return null;
  }
}
