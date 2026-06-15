import {
  GlueClient,
  CreateDatabaseCommand,
  UpdateDatabaseCommand,
  DeleteDatabaseCommand,
  CreateTableCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  GetDatabaseCommand,
  GetDatabasesCommand,
  GetTableCommand,
  GetTablesCommand,
  GetTagsCommand,
  CreateWorkflowCommand,
  UpdateWorkflowCommand,
  DeleteWorkflowCommand,
  GetWorkflowCommand,
  ListWorkflowsCommand,
  CreateSecurityConfigurationCommand,
  DeleteSecurityConfigurationCommand,
  GetSecurityConfigurationCommand,
  GetSecurityConfigurationsCommand,
  CreateJobCommand,
  UpdateJobCommand,
  DeleteJobCommand,
  GetJobCommand,
  CreateCrawlerCommand,
  UpdateCrawlerCommand,
  DeleteCrawlerCommand,
  GetCrawlerCommand,
  StartCrawlerScheduleCommand,
  StopCrawlerScheduleCommand,
  CreateConnectionCommand,
  UpdateConnectionCommand,
  DeleteConnectionCommand,
  GetConnectionCommand,
  CreateTriggerCommand,
  UpdateTriggerCommand,
  DeleteTriggerCommand,
  GetTriggerCommand,
  StartTriggerCommand,
  StopTriggerCommand,
  StopCrawlerCommand,
  EntityNotFoundException,
  CrawlerRunningException,
  type DatabaseInput,
  type TableInput,
  type OpenTableFormatInput,
  type StorageDescriptor,
  type Column,
  type Order,
  type SerDeInfo,
  type EncryptionConfiguration,
  type S3Encryption,
  type CloudWatchEncryption,
  type JobBookmarksEncryption,
  type JobUpdate,
  type JobCommand as JobCommandShape,
  type ExecutionProperty,
  type NotificationProperty,
  type SourceControlDetails,
  type CrawlerTargets,
  type SchemaChangePolicy,
  type RecrawlPolicy,
  type LineageConfiguration,
  type LakeFormationConfiguration,
  type ConnectionInput,
  type TriggerUpdate,
  type Action as TriggerAction,
  type Predicate,
  type Condition as TriggerCondition,
  type EventBatchingCondition,
} from '@aws-sdk/client-glue';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { CDK_PATH_TAG, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS Glue resources
 *
 * Supports:
 * - AWS::Glue::Database
 * - AWS::Glue::Table
 *
 * Glue CreateDatabase/CreateTable are synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class GlueProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::Database', new Set(['DatabaseInput', 'DatabaseName', 'CatalogId'])],
    [
      'AWS::Glue::Table',
      new Set(['DatabaseName', 'TableInput', 'Name', 'CatalogId', 'OpenTableFormatInput']),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
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
      case 'AWS::Glue::Database':
        return this.createDatabase(logicalId, resourceType, properties);
      case 'AWS::Glue::Table':
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
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.updateDatabase(logicalId, physicalId, resourceType, properties);
      case 'AWS::Glue::Table':
        return this.updateTable(logicalId, physicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.deleteDatabase(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::Glue::Table':
        return this.deleteTable(logicalId, physicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::Glue::Database ──────────────────────────────────────────

  private async createDatabase(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Database ${logicalId}`);

    const databaseInput = properties['DatabaseInput'] as Record<string, unknown> | undefined;
    if (!databaseInput) {
      throw new ProvisioningError(
        `DatabaseInput is required for Glue Database ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn schema accepts both top-level `DatabaseName` (the canonical
    // resource identifier) and nested `DatabaseInput.Name`. Prefer the
    // nested value when set so existing templates keep working; fall back
    // to top-level when only the resource-level identifier is provided.
    const databaseName =
      (databaseInput['Name'] as string | undefined) ??
      (properties['DatabaseName'] as string | undefined);
    if (!databaseName) {
      throw new ProvisioningError(
        `DatabaseInput.Name or top-level DatabaseName is required for Glue Database ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    try {
      await this.getClient().send(
        new CreateDatabaseCommand({
          CatalogId: catalogId,
          DatabaseInput: this.buildDatabaseInput(databaseInput, databaseName),
        })
      );

      this.logger.debug(`Successfully created Glue Database ${logicalId}: ${databaseName}`);

      return {
        physicalId: databaseName,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Database ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateDatabase(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Database ${logicalId}: ${physicalId}`);

    const databaseInput = properties['DatabaseInput'] as Record<string, unknown> | undefined;
    if (!databaseInput) {
      throw new ProvisioningError(
        `DatabaseInput is required for Glue Database update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    try {
      await this.getClient().send(
        new UpdateDatabaseCommand({
          ...(catalogId !== undefined && { CatalogId: catalogId }),
          Name: physicalId,
          DatabaseInput: this.buildDatabaseInput(databaseInput, physicalId),
        })
      );

      this.logger.debug(`Successfully updated Glue Database ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Database ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDatabase(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Database ${logicalId}: ${physicalId}`);

    try {
      const catalogId = properties?.['CatalogId'] as string | undefined;
      await this.getClient().send(
        new DeleteDatabaseCommand({
          Name: physicalId,
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
      this.logger.debug(`Successfully deleted Glue Database ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Database ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Database ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::Glue::Table ─────────────────────────────────────────────

  private async createTable(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Table ${logicalId}`);

    const databaseName = properties['DatabaseName'] as string | undefined;
    if (!databaseName) {
      throw new ProvisioningError(
        `DatabaseName is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const tableInput = properties['TableInput'] as Record<string, unknown> | undefined;
    if (!tableInput) {
      throw new ProvisioningError(
        `TableInput is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // CFn schema accepts both top-level `Name` (the canonical resource
    // identifier) and nested `TableInput.Name`. Prefer the nested value
    // when set; fall back to top-level when only the resource-level
    // identifier is provided.
    const tableName =
      (tableInput['Name'] as string | undefined) ?? (properties['Name'] as string | undefined);
    if (!tableName) {
      throw new ProvisioningError(
        `TableInput.Name or top-level Name is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    // `OpenTableFormatInput` (Apache Iceberg) is a top-level `CreateTableCommand`
    // param — a SIBLING of `TableInput`, NOT nested inside it. The CFn shape
    // (`{ IcebergInput: { MetadataOperation, Version } }`) maps 1:1 to the SDK
    // `OpenTableFormatInput` type (same PascalCase). Omit when absent.
    // Iceberg's `MetadataOperation: 'CREATE'` is a create-time directive, so it
    // is intentionally wired on create only — `UpdateTableCommandInput` does not
    // accept `OpenTableFormatInput` (verified against @aws-sdk/client-glue).
    const openTableFormatInput = properties['OpenTableFormatInput'] as
      | OpenTableFormatInput
      | undefined;

    try {
      await this.getClient().send(
        new CreateTableCommand({
          CatalogId: catalogId,
          DatabaseName: databaseName,
          TableInput: this.buildTableInput(tableInput, tableName),
          ...(openTableFormatInput !== undefined && {
            OpenTableFormatInput: openTableFormatInput,
          }),
        })
      );

      const physicalId = `${databaseName}|${tableName}`;
      this.logger.debug(`Successfully created Glue Table ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Table ${logicalId}: ${physicalId}`);

    const [databaseName, tableName] = physicalId.split('|');
    if (!databaseName || !tableName) {
      throw new ProvisioningError(
        `Invalid Glue Table physical ID format: ${physicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const tableInput = properties['TableInput'] as Record<string, unknown> | undefined;
    if (!tableInput) {
      throw new ProvisioningError(
        `TableInput is required for Glue Table update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    try {
      await this.getClient().send(
        new UpdateTableCommand({
          CatalogId: catalogId,
          DatabaseName: databaseName,
          TableInput: this.buildTableInput(tableInput, tableName),
        })
      );

      this.logger.debug(`Successfully updated Glue Table ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Table ${logicalId}: ${physicalId}`);

    const [databaseName, tableName] = physicalId.split('|');
    if (!databaseName || !tableName) {
      this.logger.warn(`Invalid Glue Table physical ID format: ${physicalId}, skipping`);
      return;
    }

    try {
      await this.getClient().send(
        new DeleteTableCommand({
          DatabaseName: databaseName,
          Name: tableName,
        })
      );
      this.logger.debug(`Successfully deleted Glue Table ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Table ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Build DatabaseInput for Glue API from CFn template properties.
   *
   * Used by both `createDatabase` and `updateDatabase` so the same
   * field-by-field shape is sent on both paths. Optional fields use
   * `!== undefined` gates (per `feedback_update_optional_field_undefined_check.md`)
   * so empty-string Description, empty Parameters map, etc. reach AWS
   * intact — `cdkd drift --revert` relies on this to clear console-side
   * additions.
   */
  private buildDatabaseInput(
    databaseInput: Record<string, unknown>,
    fallbackName: string
  ): DatabaseInput {
    const result: DatabaseInput = {
      Name: (databaseInput['Name'] as string | undefined) ?? fallbackName,
    };

    if (databaseInput['Description'] !== undefined) {
      result.Description = databaseInput['Description'] as string;
    }
    if (databaseInput['LocationUri'] !== undefined) {
      result.LocationUri = databaseInput['LocationUri'] as string;
    }
    if (databaseInput['Parameters'] !== undefined) {
      result.Parameters = databaseInput['Parameters'] as Record<string, string>;
    }

    return result;
  }

  /**
   * Build TableInput for Glue API from CFn template properties
   */
  private buildTableInput(tableInput: Record<string, unknown>, fallbackName: string): TableInput {
    const result: TableInput = {
      Name: (tableInput['Name'] as string | undefined) ?? fallbackName,
    };

    if (tableInput['Description'] !== undefined) {
      result.Description = tableInput['Description'] as string;
    }

    if (tableInput['TableType'] !== undefined) {
      result.TableType = tableInput['TableType'] as string;
    }

    if (tableInput['Parameters'] !== undefined) {
      // Convert all values to strings (CDK may pass booleans/numbers)
      const rawParams = tableInput['Parameters'] as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawParams)) {
        params[k] = String(v);
      }
      result.Parameters = params;
    }

    if (tableInput['Owner'] !== undefined) {
      result.Owner = tableInput['Owner'] as string;
    }

    if (tableInput['Retention'] !== undefined) {
      result.Retention = tableInput['Retention'] as number;
    }

    if (tableInput['ViewOriginalText'] !== undefined) {
      result.ViewOriginalText = tableInput['ViewOriginalText'] as string;
    }

    if (tableInput['ViewExpandedText'] !== undefined) {
      result.ViewExpandedText = tableInput['ViewExpandedText'] as string;
    }

    // StorageDescriptor
    if (tableInput['StorageDescriptor'] !== undefined) {
      const sd = tableInput['StorageDescriptor'] as Record<string, unknown>;
      result.StorageDescriptor = this.buildStorageDescriptor(sd);
    }

    // PartitionKeys
    if (tableInput['PartitionKeys'] !== undefined) {
      result.PartitionKeys = tableInput['PartitionKeys'] as Column[];
    }

    return result;
  }

  /**
   * Build StorageDescriptor for Glue API
   */
  private buildStorageDescriptor(sd: Record<string, unknown>): StorageDescriptor {
    const result: StorageDescriptor = {};

    if (sd['Columns'] !== undefined) {
      result.Columns = sd['Columns'] as Column[];
    }

    if (sd['Location'] !== undefined) {
      result.Location = sd['Location'] as string;
    }

    if (sd['InputFormat'] !== undefined) {
      result.InputFormat = sd['InputFormat'] as string;
    }

    if (sd['OutputFormat'] !== undefined) {
      result.OutputFormat = sd['OutputFormat'] as string;
    }

    if (sd['Compressed'] !== undefined) {
      result.Compressed = sd['Compressed'] as boolean;
    }

    if (sd['NumberOfBuckets'] !== undefined) {
      result.NumberOfBuckets = sd['NumberOfBuckets'] as number;
    }

    if (sd['SerdeInfo'] !== undefined) {
      const serde = sd['SerdeInfo'] as Record<string, unknown>;
      if (serde['Parameters']) {
        const params = serde['Parameters'] as Record<string, unknown>;
        const converted: Record<string, string> = {};
        for (const [k, v] of Object.entries(params)) {
          converted[k] = String(v);
        }
        serde['Parameters'] = converted;
      }
      result.SerdeInfo = serde as SerDeInfo;
    }

    if (sd['BucketColumns'] !== undefined) {
      result.BucketColumns = sd['BucketColumns'] as string[];
    }

    if (sd['SortColumns'] !== undefined) {
      result.SortColumns = sd['SortColumns'] as Order[];
    }

    if (sd['Parameters'] !== undefined) {
      result.Parameters = sd['Parameters'] as Record<string, string>;
    }

    if (sd['StoredAsSubDirectories'] !== undefined) {
      result.StoredAsSubDirectories = sd['StoredAsSubDirectories'] as boolean;
    }

    return result;
  }

  /**
   * Adopt an existing Glue Database or Table into cdkd state.
   *
   * Lookup order (per type):
   *  1. Explicit override / template name → verify with `GetDatabase`
   *     or `GetTable`.
   *  2. Walk `GetDatabases` / `GetTables` paginators and match the
   *     `aws:cdk:path` tag via `GetTags(ResourceArn)`. Glue tags are
   *     a `Record<string,string>` map (not a `Tag[]` array), so the
   *     match is `tags?.[CDK_PATH_TAG] === input.cdkPath`.
   *
   * Glue list APIs return only names — ARNs are constructed locally
   * for the per-item GetTags call.
   */
  /**
   * Read the AWS-current Glue resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `Database` → `GetDatabase` returning DatabaseInput-shape
   *    (`Name`, `Description`, `LocationUri`, `Parameters`).
   *  - `Table` → `GetTable` returning the same-named TableInput-shape
   *    fields (`Name`, `Description`, `Owner`, `Retention`, `TableType`,
   *    `PartitionKeys`, `Parameters`, `StorageDescriptor`, `ViewOriginalText`,
   *    `ViewExpandedText`, `TargetTable`). The table physicalId is
   *    `databaseName|tableName`; we recover both from the split.
   *
   * `CatalogId` is intentionally not surfaced — `GetDatabase` /
   * `GetTable` do not echo it back, and cdkd state's `CatalogId` is
   * usually the AWS account id (defaulted by the API). Comparator only
   * descends into keys present in state, so an absent surface key cannot
   * fire false drift here.
   *
   * Returns `undefined` when the resource is gone (`EntityNotFoundException`).
   * Other Glue resource types (`Job`, `Crawler`, `Connection`, `Trigger`,
   * `Workflow`, `SecurityConfiguration`, etc.) are out of scope for v1 —
   * the provider's `create()` only handles Database/Table; CC API picks
   * up drift detection for the rest.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.readDatabase(physicalId);
      case 'AWS::Glue::Table':
        return this.readTable(physicalId);
      default:
        return undefined;
    }
  }

  /**
   * `OpenTableFormatInput` is a create-time directive (`IcebergInput.MetadataOperation`
   * can only be `CREATE`). `GetTable` does NOT echo it back as an
   * `OpenTableFormatInput` field — an Iceberg table surfaces only via
   * `Table.Parameters['table_type'] == 'ICEBERG'`, which is not the same
   * round-trippable shape. There is therefore no clean emit-when-present
   * readback for it (and fabricating a placeholder would itself fire false
   * drift). Declaring it here keeps the drift comparator from false-positiving
   * on a state-recorded `OpenTableFormatInput` that the readback never surfaces.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::Glue::Table') {
      return ['OpenTableFormatInput'];
    }
    return [];
  }

  private async readDatabase(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let db;
    try {
      const resp = await this.getClient().send(new GetDatabaseCommand({ Name: physicalId }));
      db = resp.Database;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!db) return undefined;

    const dbInput: Record<string, unknown> = {};
    if (db.Name !== undefined) dbInput['Name'] = db.Name;
    dbInput['Description'] = db.Description ?? '';
    if (db.LocationUri !== undefined) dbInput['LocationUri'] = db.LocationUri;
    dbInput['Parameters'] = db.Parameters ?? {};
    // CFn schema accepts BOTH nested `DatabaseInput.Name` AND top-level
    // `DatabaseName` (see #613 B-bucket fix in createDatabase). Surface
    // both so drift comparison works for either template shape.
    const result: Record<string, unknown> = { DatabaseInput: dbInput };
    if (db.Name !== undefined) result['DatabaseName'] = db.Name;
    return result;
  }

  private async readTable(physicalId: string): Promise<Record<string, unknown> | undefined> {
    const [databaseName, tableName] = physicalId.split('|');
    if (!databaseName || !tableName) return undefined;

    let table;
    try {
      const resp = await this.getClient().send(
        new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
      );
      table = resp.Table;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!table) return undefined;

    const tableInput: Record<string, unknown> = {};
    if (table.Name !== undefined) tableInput['Name'] = table.Name;
    tableInput['Description'] = table.Description ?? '';
    if (table.Owner !== undefined) tableInput['Owner'] = table.Owner;
    if (table.Retention !== undefined) tableInput['Retention'] = table.Retention;
    if (table.TableType !== undefined) tableInput['TableType'] = table.TableType;
    tableInput['PartitionKeys'] = (table.PartitionKeys ?? []).map(
      (k) => k as unknown as Record<string, unknown>
    );
    tableInput['Parameters'] = table.Parameters ?? {};
    if (table.StorageDescriptor) {
      tableInput['StorageDescriptor'] = table.StorageDescriptor as unknown as Record<
        string,
        unknown
      >;
    }
    if (table.ViewOriginalText !== undefined) {
      tableInput['ViewOriginalText'] = table.ViewOriginalText;
    }
    if (table.ViewExpandedText !== undefined) {
      tableInput['ViewExpandedText'] = table.ViewExpandedText;
    }
    if (table.TargetTable) {
      tableInput['TargetTable'] = table.TargetTable as unknown as Record<string, unknown>;
    }

    // CFn schema accepts BOTH nested `TableInput.Name` AND top-level
    // `Name` (see #613 B-bucket fix in createTable). Surface both so
    // drift comparison works for either template shape.
    const result: Record<string, unknown> = {
      DatabaseName: databaseName,
      TableInput: tableInput,
    };
    if (table.Name !== undefined) result['Name'] = table.Name;
    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::Glue::Database':
        return this.importDatabase(input);
      case 'AWS::Glue::Table':
        return this.importTable(input);
      default:
        return null;
    }
  }

  private async importDatabase(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName =
      input.knownPhysicalId ??
      ((input.properties['DatabaseInput'] as Record<string, unknown> | undefined)?.['Name'] as
        | string
        | undefined);
    const catalogId = input.properties['CatalogId'] as string | undefined;

    if (explicitName) {
      try {
        await this.getClient().send(
          new GetDatabaseCommand({ Name: explicitName, ...(catalogId && { CatalogId: catalogId }) })
        );
        return { physicalId: explicitName, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new GetDatabasesCommand({
          ...(nextToken && { NextToken: nextToken }),
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
      for (const db of list.DatabaseList ?? []) {
        if (!db.Name) continue;
        const arn = await this.buildDatabaseArn(db.Name, db.CatalogId);
        if (await this.tagsMatchCdkPath(arn, input.cdkPath)) {
          return { physicalId: db.Name, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }

  private async importTable(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const databaseName = input.properties['DatabaseName'] as string | undefined;
    const tableInput = input.properties['TableInput'] as Record<string, unknown> | undefined;
    const templateTableName = tableInput?.['Name'] as string | undefined;
    const catalogId = input.properties['CatalogId'] as string | undefined;

    // Override or template name. Glue Table physicalId in cdkd is
    // `<databaseName>|<tableName>`.
    if (input.knownPhysicalId) {
      const [dbName, tName] = input.knownPhysicalId.split('|');
      if (!dbName || !tName) return null;
      try {
        await this.getClient().send(
          new GetTableCommand({
            DatabaseName: dbName,
            Name: tName,
            ...(catalogId && { CatalogId: catalogId }),
          })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    if (databaseName && templateTableName) {
      try {
        await this.getClient().send(
          new GetTableCommand({
            DatabaseName: databaseName,
            Name: templateTableName,
            ...(catalogId && { CatalogId: catalogId }),
          })
        );
        return { physicalId: `${databaseName}|${templateTableName}`, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath || !databaseName) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new GetTablesCommand({
          DatabaseName: databaseName,
          ...(nextToken && { NextToken: nextToken }),
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
      for (const t of list.TableList ?? []) {
        if (!t.Name) continue;
        const arn = await this.buildTableArn(databaseName, t.Name, catalogId);
        if (await this.tagsMatchCdkPath(arn, input.cdkPath)) {
          return { physicalId: `${databaseName}|${t.Name}`, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }

  private async tagsMatchCdkPath(arn: string, cdkPath: string): Promise<boolean> {
    try {
      const resp = await this.getClient().send(new GetTagsCommand({ ResourceArn: arn }));
      return resp.Tags?.[CDK_PATH_TAG] === cdkPath;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return false;
      throw err;
    }
  }

  private async buildDatabaseArn(databaseName: string, catalogId?: string): Promise<string> {
    const region = await this.getRegion();
    const account = catalogId ?? (await this.getAccountId());
    return `arn:aws:glue:${region}:${account}:database/${databaseName}`;
  }

  private async buildTableArn(
    databaseName: string,
    tableName: string,
    catalogId?: string
  ): Promise<string> {
    const region = await this.getRegion();
    const account = catalogId ?? (await this.getAccountId());
    return `arn:aws:glue:${region}:${account}:table/${databaseName}/${tableName}`;
  }

  private async getRegion(): Promise<string> {
    const region = await this.getClient().config.region();
    return region || this.providerRegion || 'us-east-1';
  }

  private async getAccountId(): Promise<string> {
    if (this.cachedAccountId) return this.cachedAccountId;
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) {
      throw new Error('Failed to resolve AWS account id from STS');
    }
    this.cachedAccountId = identity.Account;
    return this.cachedAccountId;
  }
}

// ─── AWS::Glue::Workflow ───────────────────────────────────────────
//
// Glue Workflow has a clean SDK update path (`UpdateWorkflow`) covering
// every mutable top-level field — `Description`, `DefaultRunProperties`,
// `MaxConcurrentRuns`. `Name` is immutable on create. Tags ride on
// `CreateWorkflow.Tags` but cdkd updates them out-of-band via
// `TagResource` / `UntagResource` (kept simple here — tag updates are
// always done by `cdkd drift --revert` against the current AWS shape).
//
// Surface used by `cdkd drift`:
//   - `readCurrentState` reads via `GetWorkflow` and reverse-maps every
//     user-controllable top-level key to the CFn shape with PR #145
//     always-emit placeholders (`Description: ''`, `DefaultRunProperties: {}`,
//     `MaxConcurrentRuns: undefined` only when AWS reports nothing — same
//     pattern used by other providers' optional integer fields).
//   - `getDriftUnknownPaths` is empty: no AWS-managed read-only fields are
//     templated into cdkd state for this type.

/**
 * SDK Provider for `AWS::Glue::Workflow`.
 *
 * Workflow is a top-level Glue catalog entry that orchestrates Triggers,
 * Jobs, and Crawlers via a DAG. The CFn shape carries `Name` (required,
 * immutable on create), `Description`, `DefaultRunProperties` (string→string
 * map), `MaxConcurrentRuns`, and `Tags`.
 *
 * Read-update round-trip: `cdkd drift --revert` calls `update(...,
 * awsCurrent, observedSnapshot)` so the same `UpdateWorkflow` payload is
 * built from either side. `Description` and `DefaultRunProperties` use
 * `!== undefined` gates so empty-string / empty-map values reach AWS
 * (matches `feedback_update_optional_field_undefined_check.md`).
 */
export class GlueWorkflowProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueWorkflowProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Workflow',
      new Set(['Name', 'Description', 'DefaultRunProperties', 'MaxConcurrentRuns', 'Tags']),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Workflow ${logicalId}`);

    const name = properties['Name'] as string | undefined;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for Glue Workflow ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Glue Workflow Tags may arrive as a CFn `{Key,Value}[]` list OR a tag map
      // (CDK can synth either shape); use the map-tolerant helper so a map shape
      // is not silently dropped. Elide the key when there are no tags.
      const tagsMap = cfnTagsToMap(properties['Tags']);
      const tags = tagsMap && Object.keys(tagsMap).length > 0 ? tagsMap : undefined;
      await this.getClient().send(
        new CreateWorkflowCommand({
          Name: name,
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['DefaultRunProperties'] !== undefined && {
            DefaultRunProperties: properties['DefaultRunProperties'] as Record<string, string>,
          }),
          ...(properties['MaxConcurrentRuns'] !== undefined && {
            MaxConcurrentRuns: coerceNumber(properties['MaxConcurrentRuns']) as number,
          }),
          ...(tags && { Tags: tags }),
        })
      );

      this.logger.debug(`Successfully created Glue Workflow ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Workflow ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Workflow ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new UpdateWorkflowCommand({
          Name: physicalId,
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['DefaultRunProperties'] !== undefined && {
            DefaultRunProperties: properties['DefaultRunProperties'] as Record<string, string>,
          }),
          ...(properties['MaxConcurrentRuns'] !== undefined && {
            MaxConcurrentRuns: coerceNumber(properties['MaxConcurrentRuns']) as number,
          }),
        })
      );

      this.logger.debug(`Successfully updated Glue Workflow ${logicalId}`);
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Workflow ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Workflow ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteWorkflowCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted Glue Workflow ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Workflow ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Workflow ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Read AWS-current Workflow shape via `GetWorkflow`. Surfaces every
   * user-controllable top-level CFn key with always-emit placeholders
   * (PR #145):
   *  - `Description` → `?? ''`
   *  - `DefaultRunProperties` → `?? {}`
   *  - `MaxConcurrentRuns` → omitted when AWS reports `undefined` (no
   *    AWS-side default to anchor a placeholder against; cdkd state may
   *    legitimately leave this unset)
   *  - `Tags` → `?? []` (filtered against `aws:cdk:path` and the rest of
   *    the `aws:`-prefixed reserved space)
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let workflow;
    try {
      const resp = await this.getClient().send(
        new GetWorkflowCommand({ Name: physicalId, IncludeGraph: false })
      );
      workflow = resp.Workflow;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!workflow) return undefined;

    const result: Record<string, unknown> = {
      Name: workflow.Name ?? physicalId,
      Description: workflow.Description ?? '',
      DefaultRunProperties: workflow.DefaultRunProperties ?? {},
    };

    if (workflow.MaxConcurrentRuns !== undefined) {
      result['MaxConcurrentRuns'] = workflow.MaxConcurrentRuns;
    }

    // Tags via separate GetTags(ResourceArn) call.
    const arn = await this.buildWorkflowArn(physicalId);
    let tags: Array<{ Key: string; Value: string }> = [];
    try {
      const tagResp = await this.getClient().send(new GetTagsCommand({ ResourceArn: arn }));
      tags = normalizeAwsTagsToCfn(tagResp.Tags);
    } catch (err) {
      // Best-effort — `GetTags` failure should not abort the drift read.
      this.logger.debug(
        `GetTags failed for Glue Workflow ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    result['Tags'] = tags;

    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);

    if (explicitName) {
      try {
        await this.getClient().send(new GetWorkflowCommand({ Name: explicitName }));
        return { physicalId: explicitName, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListWorkflowsCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const name of list.Workflows ?? []) {
        const arn = await this.buildWorkflowArn(name);
        if (await this.tagsMatchCdkPath(arn, input.cdkPath)) {
          return { physicalId: name, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }

  private async tagsMatchCdkPath(arn: string, cdkPath: string): Promise<boolean> {
    try {
      const resp = await this.getClient().send(new GetTagsCommand({ ResourceArn: arn }));
      return resp.Tags?.[CDK_PATH_TAG] === cdkPath;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return false;
      throw err;
    }
  }

  private async buildWorkflowArn(workflowName: string): Promise<string> {
    const region = await this.getRegion();
    const account = await this.getAccountId();
    return `arn:aws:glue:${region}:${account}:workflow/${workflowName}`;
  }

  private async getRegion(): Promise<string> {
    const region = await this.getClient().config.region();
    return region || this.providerRegion || 'us-east-1';
  }

  private async getAccountId(): Promise<string> {
    if (this.cachedAccountId) return this.cachedAccountId;
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) {
      throw new Error('Failed to resolve AWS account id from STS');
    }
    this.cachedAccountId = identity.Account;
    return this.cachedAccountId;
  }
}

// ─── AWS::Glue::SecurityConfiguration ──────────────────────────────
//
// SecurityConfiguration is **immutable on update** per AWS docs — the
// only mutators are `CreateSecurityConfiguration` and
// `DeleteSecurityConfiguration`. Any update path therefore surfaces
// `ResourceUpdateNotSupportedError` so `cdkd drift --revert` reports a
// clean "use cdkd deploy --replace" outcome instead of silently no-op'ing.
//
// `EncryptionConfiguration` carries three sub-configs:
//   - `S3Encryption[]` — array of `{S3EncryptionMode, KmsKeyArn}`
//   - `CloudWatchEncryption` — `{CloudWatchEncryptionMode, KmsKeyArn}`
//   - `JobBookmarksEncryption` — `{JobBookmarksEncryptionMode, KmsKeyArn}`
// AWS docs also surface `DataQualityEncryption` on the SDK shape but
// CloudFormation does NOT model it (`AWS::Glue::SecurityConfiguration`
// has only the three above), so we ignore it on read to avoid false
// drift on the v3 baseline.

/**
 * SDK Provider for `AWS::Glue::SecurityConfiguration`.
 *
 * Immutable resource — `update()` always throws
 * `ResourceUpdateNotSupportedError`. Replacement falls through to the
 * deploy engine's CREATE→DELETE replacement path.
 *
 * Tags are NOT supported on `CreateSecurityConfiguration` (verified
 * against the SDK shape — `CreateSecurityConfigurationRequest` has only
 * `Name` + `EncryptionConfiguration`), so cdkd does not surface a `Tags`
 * key in `readCurrentState` even with an always-emit placeholder.
 */
export class GlueSecurityConfigurationProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueSecurityConfigurationProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::SecurityConfiguration', new Set(['Name', 'EncryptionConfiguration'])],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue SecurityConfiguration ${logicalId}`);

    const name = properties['Name'] as string | undefined;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for Glue SecurityConfiguration ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const encryptionConfiguration = properties['EncryptionConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (!encryptionConfiguration) {
      throw new ProvisioningError(
        `EncryptionConfiguration is required for Glue SecurityConfiguration ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.getClient().send(
        new CreateSecurityConfigurationCommand({
          Name: name,
          EncryptionConfiguration: buildEncryptionConfiguration(encryptionConfiguration),
        })
      );

      this.logger.debug(`Successfully created Glue SecurityConfiguration ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue SecurityConfiguration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async update(
    logicalId: string,
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // SecurityConfiguration is immutable per AWS — no `UpdateSecurity*`
    // command exists. `cdkd drift --revert` and replacement-detection
    // both end up here; the latter expects the CREATE→DELETE replacement
    // layer to handle it. Surface the error so revert reports a clean
    // "could not revert" outcome instead of silently succeeding.
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'AWS Glue SecurityConfiguration is immutable on AWS — there is no UpdateSecurityConfiguration API; every change requires DeleteSecurityConfiguration + CreateSecurityConfiguration. Use cdkd deploy --replace, or destroy + redeploy with the new EncryptionConfiguration.'
    );
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue SecurityConfiguration ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteSecurityConfigurationCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted Glue SecurityConfiguration ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `Glue SecurityConfiguration ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue SecurityConfiguration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Read AWS-current SecurityConfiguration shape via
   * `GetSecurityConfiguration`. Always emits the three CFn-modeled
   * sub-configs (`S3Encryption: []`, `CloudWatchEncryption: {}`,
   * `JobBookmarksEncryption: {}`) per PR #145 even when AWS reports
   * nothing — closes the "console-side encryption enable on a previously
   * default config" detection gap on the v3 baseline.
   *
   * `DataQualityEncryption` is silently dropped: the CFn schema for
   * `AWS::Glue::SecurityConfiguration` does not model it, so surfacing it
   * would fire false drift on every clean run for a key cdkd state can
   * never carry.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let cfg;
    try {
      const resp = await this.getClient().send(
        new GetSecurityConfigurationCommand({ Name: physicalId })
      );
      cfg = resp.SecurityConfiguration;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!cfg) return undefined;

    return {
      Name: cfg.Name ?? physicalId,
      EncryptionConfiguration: mapEncryptionConfigurationToCfn(cfg.EncryptionConfiguration),
    };
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);

    if (explicitName) {
      try {
        await this.getClient().send(new GetSecurityConfigurationCommand({ Name: explicitName }));
        return { physicalId: explicitName, attributes: {} };
      } catch (err) {
        if (err instanceof EntityNotFoundException) return null;
        throw err;
      }
    }

    // SecurityConfiguration does NOT support tags (no GetTags arn for
    // this type), so we cannot do `aws:cdk:path` lookup. Fall back to
    // walking `GetSecurityConfigurations` + matching the explicit name
    // — but without an explicit name in the template, we have nothing
    // to match on. Return null: import users must pass `--resource
    // <logicalId>=<name>` for this type.
    if (!explicitName) {
      let nextToken: string | undefined;
      do {
        const list = await this.getClient().send(
          new GetSecurityConfigurationsCommand({ ...(nextToken && { NextToken: nextToken }) })
        );
        // No tag-based match possible — the per-name loop is documented
        // for completeness; without a known name we cannot disambiguate.
        for (const _entry of list.SecurityConfigurations ?? []) {
          // Intentional no-op: see docstring above.
        }
        nextToken = list.NextToken;
      } while (nextToken);
      return null;
    }

    return null;
  }
}

// ─── Helpers (file-level) ──────────────────────────────────────────

/** Max GetCrawler polls while waiting for a stopped crawler to settle. */
const CRAWLER_STOP_MAX_ATTEMPTS = 30;
/** Delay between GetCrawler polls while waiting for a crawler to stop. */
const CRAWLER_STOP_POLL_INTERVAL_MS = 2000;
/** Max GetTrigger polls while waiting for a trigger to reach DEACTIVATED. */
const TRIGGER_DEACTIVATE_MAX_ATTEMPTS = 30;
/** Delay between GetTrigger polls while waiting for a trigger to deactivate. */
const TRIGGER_DEACTIVATE_POLL_INTERVAL_MS = 1000;

/** Promise-based sleep used by the crawler / trigger state-machine waiters. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the SDK `EncryptionConfiguration` from the CFn-shape input
 * (`AWS::Glue::SecurityConfiguration.EncryptionConfiguration`). Each
 * sub-config (`S3Encryption[]` / `CloudWatchEncryption` /
 * `JobBookmarksEncryption`) field-renames are pure pass-through — the
 * CFn property names match the SDK member names verbatim.
 */
function buildEncryptionConfiguration(input: Record<string, unknown>): EncryptionConfiguration {
  const result: EncryptionConfiguration = {};

  if (Array.isArray(input['S3Encryption'])) {
    result.S3Encryption = input['S3Encryption'].map((entry) => {
      const e = entry as Record<string, unknown>;
      const item: S3Encryption = {};
      if (typeof e['S3EncryptionMode'] === 'string') {
        item.S3EncryptionMode = e['S3EncryptionMode'] as S3Encryption['S3EncryptionMode'];
      }
      if (typeof e['KmsKeyArn'] === 'string') {
        item.KmsKeyArn = e['KmsKeyArn'];
      }
      return item;
    });
  }

  if (input['CloudWatchEncryption'] !== undefined) {
    const cw = input['CloudWatchEncryption'] as Record<string, unknown>;
    const item: CloudWatchEncryption = {};
    if (typeof cw['CloudWatchEncryptionMode'] === 'string') {
      item.CloudWatchEncryptionMode = cw[
        'CloudWatchEncryptionMode'
      ] as CloudWatchEncryption['CloudWatchEncryptionMode'];
    }
    if (typeof cw['KmsKeyArn'] === 'string') {
      item.KmsKeyArn = cw['KmsKeyArn'];
    }
    result.CloudWatchEncryption = item;
  }

  if (input['JobBookmarksEncryption'] !== undefined) {
    const jb = input['JobBookmarksEncryption'] as Record<string, unknown>;
    const item: JobBookmarksEncryption = {};
    if (typeof jb['JobBookmarksEncryptionMode'] === 'string') {
      item.JobBookmarksEncryptionMode = jb[
        'JobBookmarksEncryptionMode'
      ] as JobBookmarksEncryption['JobBookmarksEncryptionMode'];
    }
    if (typeof jb['KmsKeyArn'] === 'string') {
      item.KmsKeyArn = jb['KmsKeyArn'];
    }
    result.JobBookmarksEncryption = item;
  }

  return result;
}

/**
 * Reverse-map AWS's `EncryptionConfiguration` SDK shape into the CFn
 * shape with always-emit placeholders (PR #145):
 *   - `S3Encryption[]` → `?? []` (so console-side ADD is detectable)
 *   - `CloudWatchEncryption` → `?? {}`
 *   - `JobBookmarksEncryption` → `?? {}`
 *   - `DataQualityEncryption` → silently dropped (not in CFn schema)
 */
function mapEncryptionConfigurationToCfn(
  cfg: EncryptionConfiguration | undefined
): Record<string, unknown> {
  const c = cfg ?? {};
  return {
    S3Encryption: (c.S3Encryption ?? []).map((entry) => {
      const out: Record<string, unknown> = {};
      if (entry.S3EncryptionMode !== undefined) out['S3EncryptionMode'] = entry.S3EncryptionMode;
      if (entry.KmsKeyArn !== undefined) out['KmsKeyArn'] = entry.KmsKeyArn;
      return out;
    }),
    CloudWatchEncryption: c.CloudWatchEncryption
      ? cleanCfnObject({
          CloudWatchEncryptionMode: c.CloudWatchEncryption.CloudWatchEncryptionMode,
          KmsKeyArn: c.CloudWatchEncryption.KmsKeyArn,
        })
      : {},
    JobBookmarksEncryption: c.JobBookmarksEncryption
      ? cleanCfnObject({
          JobBookmarksEncryptionMode: c.JobBookmarksEncryption.JobBookmarksEncryptionMode,
          KmsKeyArn: c.JobBookmarksEncryption.KmsKeyArn,
        })
      : {},
  };
}

function cleanCfnObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ─── Shared helpers for sibling Glue providers ──────────────────────────

/**
 * Build the ARN for a Glue resource. Used by tag-fetch via
 * `GetTagsCommand` which only accepts an ARN. Account id falls back
 * to STS when not provided.
 */
async function buildGlueResourceArn(
  client: GlueClient,
  stsClient: STSClient,
  resource: 'job' | 'crawler' | 'connection' | 'trigger',
  name: string,
  accountId: string | undefined
): Promise<string> {
  const region = (await client.config.region()) || process.env['AWS_REGION'] || 'us-east-1';
  const account = accountId ?? (await resolveAccountId(stsClient));
  return `arn:aws:glue:${region}:${account}:${resource}/${name}`;
}

async function resolveAccountId(stsClient: STSClient): Promise<string> {
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error('Failed to resolve AWS account id from STS');
  }
  return identity.Account;
}

/**
 * Best-effort fetch of CFn-shape `Tags: [{Key, Value}]` for a Glue resource.
 * Returns `[]` when no tags or on error (tags are non-critical for drift —
 * a permission failure should not abort the whole drift read).
 */
async function fetchGlueTags(
  client: GlueClient,
  stsClient: STSClient,
  resource: 'job' | 'crawler' | 'connection' | 'trigger',
  name: string,
  accountId: string | undefined,
  logger: ReturnType<typeof getLogger>
): Promise<Array<{ Key: string; Value: string }>> {
  try {
    const arn = await buildGlueResourceArn(client, stsClient, resource, name, accountId);
    const resp = await client.send(new GetTagsCommand({ ResourceArn: arn }));
    return normalizeAwsTagsToCfn(resp.Tags);
  } catch (err) {
    logger.debug(
      `GetTags failed for ${resource}/${name}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * SDK Provider for `AWS::Glue::Job`.
 *
 * CFn properties (subset cdkd manages on create/update):
 *   Name, Role, Command, Description, MaxCapacity, MaxRetries, Timeout,
 *   ExecutionProperty, GlueVersion, NumberOfWorkers, WorkerType,
 *   DefaultArguments, NonOverridableArguments, Connections, LogUri,
 *   SecurityConfiguration, NotificationProperty, ExecutionClass,
 *   JobMode, JobRunQueuingEnabled, MaintenanceWindow, AllocatedCapacity,
 *   SourceControlDetails, Tags.
 *
 * `physicalId` is the Glue job name. Tags on a Job are managed via the
 * separate `GetTags` / `TagResource` / `UntagResource` API since
 * `UpdateJob` / `JobUpdate` does not carry tags.
 */
export class GlueJobProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueJobProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Job',
      new Set([
        'Name',
        'Role',
        'Command',
        'Description',
        'MaxCapacity',
        'MaxRetries',
        'Timeout',
        'ExecutionProperty',
        'GlueVersion',
        'NumberOfWorkers',
        'WorkerType',
        'DefaultArguments',
        'NonOverridableArguments',
        'Connections',
        'LogUri',
        'SecurityConfiguration',
        'NotificationProperty',
        'ExecutionClass',
        'JobMode',
        'JobRunQueuingEnabled',
        'MaintenanceWindow',
        'AllocatedCapacity',
        'SourceControlDetails',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Job ${logicalId}`);
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const role = properties['Role'] as string | undefined;
    const command = properties['Command'] as Record<string, unknown> | undefined;
    if (!role) {
      throw new ProvisioningError(
        `Role is required for Glue Job ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!command) {
      throw new ProvisioningError(
        `Command is required for Glue Job ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    try {
      const tags = cfnTagsToMap(properties['Tags']);
      await this.getClient().send(
        new CreateJobCommand({
          Name: name,
          Role: role,
          Command: buildJobCommand(command),
          ...buildJobCommonFields(properties),
          ...(tags && { Tags: tags }),
        })
      );
      this.logger.debug(`Successfully created Glue Job ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Job ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
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
    this.logger.debug(`Updating Glue Job ${logicalId}: ${physicalId}`);
    try {
      const command = properties['Command'] as Record<string, unknown> | undefined;
      const update: JobUpdate = {
        ...(command !== undefined && { Command: buildJobCommand(command) }),
        ...buildJobCommonFields(properties),
        // Role is required at create but mutable on update; include only when defined
        ...(properties['Role'] !== undefined && { Role: properties['Role'] as string }),
      };
      await this.getClient().send(new UpdateJobCommand({ JobName: physicalId, JobUpdate: update }));

      // Tags are not part of JobUpdate; reconcile via TagResource diff if tags changed.
      const oldTags = cfnTagsToMap(previousProperties['Tags']) ?? {};
      const newTags = cfnTagsToMap(properties['Tags']) ?? {};
      await this.applyTagDiff(physicalId, oldTags, newTags);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Job ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Job ${logicalId}: ${physicalId}`);
    try {
      await this.getClient().send(new DeleteJobCommand({ JobName: physicalId }));
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Job ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Job ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Read the AWS-current Glue Job in CFn-property shape.
   *
   * Always-emit placeholders for user-controllable top-level keys per
   * PR #145 (`?? '' | [] | {}`) so the v3 `observedProperties` baseline
   * detects console-side ADDs to fields that weren't templated. Tags
   * always emit `[]` (PR H pattern).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let job;
    try {
      const resp = await this.getClient().send(new GetJobCommand({ JobName: physicalId }));
      job = resp.Job;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!job) return undefined;

    const result: Record<string, unknown> = {
      Name: job.Name ?? physicalId,
      Role: job.Role ?? '',
      Command: pickDefined({
        Name: job.Command?.Name,
        ScriptLocation: job.Command?.ScriptLocation,
        PythonVersion: job.Command?.PythonVersion,
        Runtime: job.Command?.Runtime,
      }),
      Description: job.Description ?? '',
      LogUri: job.LogUri ?? '',
      DefaultArguments: job.DefaultArguments ?? {},
      NonOverridableArguments: job.NonOverridableArguments ?? {},
      Connections: { Connections: job.Connections?.Connections ?? [] },
      MaxRetries: job.MaxRetries ?? 0,
      Timeout: job.Timeout ?? 0,
      ExecutionProperty: { MaxConcurrentRuns: job.ExecutionProperty?.MaxConcurrentRuns ?? 1 },
      NotificationProperty: { NotifyDelayAfter: job.NotificationProperty?.NotifyDelayAfter ?? 0 },
      GlueVersion: job.GlueVersion ?? '',
      NumberOfWorkers: job.NumberOfWorkers ?? 0,
      WorkerType: job.WorkerType ?? '',
      MaxCapacity: job.MaxCapacity ?? 0,
      AllocatedCapacity: job.AllocatedCapacity ?? 0,
      SecurityConfiguration: job.SecurityConfiguration ?? '',
      ExecutionClass: job.ExecutionClass ?? '',
      JobMode: job.JobMode ?? '',
      JobRunQueuingEnabled: job.JobRunQueuingEnabled ?? false,
      MaintenanceWindow: job.MaintenanceWindow ?? '',
      SourceControlDetails: job.SourceControlDetails
        ? pickDefined(job.SourceControlDetails as Record<string, unknown>)
        : {},
    };
    result['Tags'] = await fetchGlueTags(
      this.getClient(),
      this.getStsClient(),
      'job',
      job.Name ?? physicalId,
      this.cachedAccountId,
      this.logger
    );
    return result;
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: Record<string, string>,
    newTags: Record<string, string>
  ): Promise<void> {
    const arn = await buildGlueResourceArn(
      this.getClient(),
      this.getStsClient(),
      'job',
      physicalId,
      this.cachedAccountId
    );
    const toAdd: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [k, v] of Object.entries(newTags)) {
      if (oldTags[k] !== v) toAdd[k] = v;
    }
    for (const k of Object.keys(oldTags)) {
      if (!(k in newTags)) toRemove.push(k);
    }
    // TagResource / UntagResource use the same Glue API (TagResource for add).
    if (Object.keys(toAdd).length > 0 || toRemove.length > 0) {
      // Lazy-import to avoid bundle bloat in delete-only paths.
      const { TagResourceCommand, UntagResourceCommand } = await import('@aws-sdk/client-glue');
      if (Object.keys(toAdd).length > 0) {
        await this.getClient().send(new TagResourceCommand({ ResourceArn: arn, TagsToAdd: toAdd }));
      }
      if (toRemove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: toRemove })
        );
      }
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
    if (!explicitName) return null;
    try {
      await this.getClient().send(new GetJobCommand({ JobName: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}

// ─── helpers shared by GlueJobProvider ──────────────────────────────────

function buildJobCommand(c: Record<string, unknown>): JobCommandShape {
  const result: JobCommandShape = {};
  if (c['Name'] !== undefined) result.Name = c['Name'] as string;
  if (c['ScriptLocation'] !== undefined) result.ScriptLocation = c['ScriptLocation'] as string;
  if (c['PythonVersion'] !== undefined) result.PythonVersion = c['PythonVersion'] as string;
  if (c['Runtime'] !== undefined) result.Runtime = c['Runtime'] as string;
  return result;
}

/**
 * Fields shared by `CreateJob` and `UpdateJob.JobUpdate` (everything except
 * `Name` / `Role` / `Command`). Each is gated on `!== undefined` so empty
 * strings / `false` / `0` round-trip cleanly via `cdkd drift --revert`.
 */
function buildJobCommonFields(p: Record<string, unknown>): Partial<JobUpdate> {
  const r: Partial<JobUpdate> = {};
  // String pass-through props (CFn delivers these as strings and the SDK types
  // them as strings too).
  const stringPassThrough: Array<keyof JobUpdate> = [
    'JobMode',
    'JobRunQueuingEnabled',
    'Description',
    'LogUri',
    'DefaultArguments',
    'NonOverridableArguments',
    'WorkerType',
    'SecurityConfiguration',
    'GlueVersion',
    'ExecutionClass',
    'MaintenanceWindow',
  ];
  for (const k of stringPassThrough) {
    if (p[k as string] !== undefined) {
      // Cast to any: union of multiple field types, type-gated by AWS SDK at the wire layer.
      (r as Record<string, unknown>)[k as string] = p[k as string];
    }
  }
  // Numeric props: CFn delivers these as STRINGS (CDK synths e.g. "10"), but the
  // Glue SDK types them as int/double. `as number` is compile-only and does NOT
  // coerce at runtime, so the SDK would receive a string for a number-typed field.
  // Coerce at the wire boundary. See feedback_cfn_stringly_typed_numerics_need_coerce.
  const numericPassThrough: Array<keyof JobUpdate> = [
    'MaxRetries',
    'AllocatedCapacity',
    'Timeout',
    'MaxCapacity',
    'NumberOfWorkers',
  ];
  for (const k of numericPassThrough) {
    const v = p[k as string];
    if (v !== undefined) {
      (r as Record<string, unknown>)[k as string] = coerceNumber(v);
    }
  }
  if (p['ExecutionProperty'] !== undefined) {
    const ep = { ...(p['ExecutionProperty'] as Record<string, unknown>) };
    if (ep['MaxConcurrentRuns'] !== undefined) {
      ep['MaxConcurrentRuns'] = coerceNumber(ep['MaxConcurrentRuns']);
    }
    r.ExecutionProperty = ep as ExecutionProperty;
  }
  if (p['Connections'] !== undefined) {
    const conn = p['Connections'] as Record<string, unknown>;
    r.Connections = { Connections: (conn['Connections'] as string[] | undefined) ?? [] };
  }
  if (p['NotificationProperty'] !== undefined) {
    const np = { ...(p['NotificationProperty'] as Record<string, unknown>) };
    if (np['NotifyDelayAfter'] !== undefined) {
      np['NotifyDelayAfter'] = coerceNumber(np['NotifyDelayAfter']);
    }
    r.NotificationProperty = np as NotificationProperty;
  }
  if (p['SourceControlDetails'] !== undefined) {
    r.SourceControlDetails = p['SourceControlDetails'] as SourceControlDetails;
  }
  return r;
}

/**
 * Coerce a CFn-delivered numeric property (often a string like `"10"`) to a
 * JS number at the SDK wire boundary. Non-finite / unparseable inputs are
 * returned unchanged so AWS surfaces a clear validation error rather than
 * silently sending `NaN`.
 */
function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

/**
 * Convert CFn `Tags: [{Key,Value}]` (or a tag map) to AWS Glue's
 * `Record<string,string>` shape used by Create commands and TagResource. Returns
 * `undefined` when the input is undefined so callers can elide the key.
 */
function cfnTagsToMap(tagsInput: unknown): Record<string, string> | undefined {
  if (tagsInput === undefined) return undefined;
  const out: Record<string, string> = {};
  if (Array.isArray(tagsInput)) {
    for (const entry of tagsInput) {
      const e = entry as Record<string, unknown>;
      const k = e['Key'];
      const v = e['Value'];
      if (typeof k === 'string') out[k] = typeof v === 'string' ? v : '';
    }
    return out;
  }
  if (typeof tagsInput === 'object' && tagsInput !== null) {
    for (const [k, v] of Object.entries(tagsInput as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : '';
    }
    return out;
  }
  return out;
}

/**
 * Recursively strip undefined / null values and empty objects from a plain
 * record, returning the cleaned shape. Used by `readCurrentState` to emit
 * tight CFn-shape sub-objects without leaking SDK-injected `undefined` keys.
 */
function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = pickDefined(v as Record<string, unknown>);
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * SDK Provider for `AWS::Glue::Crawler`.
 *
 * CFn `Schedule` is the structured `{ScheduleExpression: 'cron(...)'}`
 * object; SDK `CreateCrawler.Schedule` is a bare cron string. cdkd
 * unwraps the CFn shape on create / update and re-wraps on
 * readCurrentState. Schedule START / STOP is exposed via separate
 * `StartCrawlerSchedule` / `StopCrawlerSchedule` calls (not part of
 * Update).
 *
 * `physicalId` is the crawler name.
 */
export class GlueCrawlerProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueCrawlerProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Crawler',
      new Set([
        'Name',
        'Role',
        'Targets',
        'DatabaseName',
        'Description',
        'Schedule',
        'Classifiers',
        'TablePrefix',
        'SchemaChangePolicy',
        'RecrawlPolicy',
        'LineageConfiguration',
        'LakeFormationConfiguration',
        'Configuration',
        'CrawlerSecurityConfiguration',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Crawler ${logicalId}`);
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const role = properties['Role'] as string | undefined;
    const targets = properties['Targets'] as Record<string, unknown> | undefined;
    if (!role) {
      throw new ProvisioningError(
        `Role is required for Glue Crawler ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!targets) {
      throw new ProvisioningError(
        `Targets is required for Glue Crawler ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    try {
      const tags = cfnTagsToMap(properties['Tags']);
      await this.getClient().send(
        new CreateCrawlerCommand({
          Name: name,
          Role: role,
          Targets: targets as CrawlerTargets,
          ...buildCrawlerCommonFields(properties),
          ...(tags && { Tags: tags }),
        })
      );
      this.logger.debug(`Successfully created Glue Crawler ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Crawler ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
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
    this.logger.debug(`Updating Glue Crawler ${logicalId}: ${physicalId}`);
    try {
      const updateInput = {
        Name: physicalId,
        ...(properties['Role'] !== undefined && { Role: properties['Role'] as string }),
        ...(properties['Targets'] !== undefined && {
          Targets: properties['Targets'] as CrawlerTargets,
        }),
        ...buildCrawlerCommonFields(properties),
      };
      try {
        await this.getClient().send(new UpdateCrawlerCommand(updateInput));
      } catch (err) {
        // UpdateCrawler rejects a mid-run crawler with CrawlerRunningException.
        // Stop it, wait for it to settle, then retry the update.
        if (err instanceof CrawlerRunningException) {
          this.logger.debug(
            `Glue Crawler ${physicalId} is running; stopping before update and retrying`
          );
          await this.stopCrawlerAndWait(physicalId);
          await this.getClient().send(new UpdateCrawlerCommand(updateInput));
        } else {
          throw err;
        }
      }

      const oldTags = cfnTagsToMap(previousProperties['Tags']) ?? {};
      const newTags = cfnTagsToMap(properties['Tags']) ?? {};
      await this.applyTagDiff(physicalId, oldTags, newTags);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Crawler ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Crawler ${logicalId}: ${physicalId}`);
    try {
      await this.getClient().send(new DeleteCrawlerCommand({ Name: physicalId }));
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Crawler ${physicalId} does not exist, skipping deletion`);
        return;
      }
      // A crawler that is mid-run rejects DeleteCrawler with
      // CrawlerRunningException. Stop it, wait for it to settle, then retry the
      // delete so destroy does not fail on an actively-crawling crawler.
      if (error instanceof CrawlerRunningException) {
        this.logger.debug(
          `Glue Crawler ${physicalId} is running; stopping before delete and retrying`
        );
        await this.stopCrawlerAndWait(physicalId);
        await this.getClient().send(new DeleteCrawlerCommand({ Name: physicalId }));
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Crawler ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Stop a running crawler and poll until it leaves the RUNNING / STOPPING
   * state (or until {@link CRAWLER_STOP_MAX_ATTEMPTS} is exhausted). Tolerates a
   * CrawlerStoppingException / "not running" race (the crawler may have just
   * finished on its own) so callers can unconditionally retry their delete /
   * update afterwards.
   */
  private async stopCrawlerAndWait(physicalId: string): Promise<void> {
    try {
      await this.getClient().send(new StopCrawlerCommand({ Name: physicalId }));
    } catch (err) {
      // CrawlerNotRunningException / CrawlerStoppingException etc. mean the
      // crawler is already stopping or stopped — nothing to do but wait it out.
      this.logger.debug(
        `StopCrawler for ${physicalId} returned ${
          err instanceof Error ? err.name : String(err)
        }; continuing to wait`
      );
    }
    for (let attempt = 0; attempt < CRAWLER_STOP_MAX_ATTEMPTS; attempt++) {
      try {
        const cur = await this.getClient().send(new GetCrawlerCommand({ Name: physicalId }));
        const state = cur.Crawler?.State;
        if (state !== 'RUNNING' && state !== 'STOPPING') return;
      } catch (err) {
        if (err instanceof EntityNotFoundException) return;
        // Inconclusive read — keep polling until the attempt budget is gone.
      }
      await sleep(CRAWLER_STOP_POLL_INTERVAL_MS);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let crawler;
    try {
      const resp = await this.getClient().send(new GetCrawlerCommand({ Name: physicalId }));
      crawler = resp.Crawler;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!crawler) return undefined;

    const result: Record<string, unknown> = {
      Name: crawler.Name ?? physicalId,
      Role: crawler.Role ?? '',
      Targets: crawler.Targets ? pickDefined(crawler.Targets as Record<string, unknown>) : {},
      DatabaseName: crawler.DatabaseName ?? '',
      Description: crawler.Description ?? '',
      // CFn `Schedule` is the structured wrapper; reverse-map from the
      // SDK's `Schedule { ScheduleExpression, State }` Description shape.
      Schedule: crawler.Schedule?.ScheduleExpression
        ? { ScheduleExpression: crawler.Schedule.ScheduleExpression }
        : {},
      Classifiers: crawler.Classifiers ?? [],
      TablePrefix: crawler.TablePrefix ?? '',
      SchemaChangePolicy: crawler.SchemaChangePolicy
        ? pickDefined(crawler.SchemaChangePolicy as Record<string, unknown>)
        : {},
      RecrawlPolicy: crawler.RecrawlPolicy
        ? pickDefined(crawler.RecrawlPolicy as Record<string, unknown>)
        : {},
      LineageConfiguration: crawler.LineageConfiguration
        ? pickDefined(crawler.LineageConfiguration as Record<string, unknown>)
        : {},
      LakeFormationConfiguration: crawler.LakeFormationConfiguration
        ? pickDefined(crawler.LakeFormationConfiguration as Record<string, unknown>)
        : {},
      Configuration: crawler.Configuration ?? '',
      CrawlerSecurityConfiguration: crawler.CrawlerSecurityConfiguration ?? '',
    };
    result['Tags'] = await fetchGlueTags(
      this.getClient(),
      this.getStsClient(),
      'crawler',
      crawler.Name ?? physicalId,
      this.cachedAccountId,
      this.logger
    );
    return result;
  }

  /**
   * Start (or stop) a crawler's schedule. Exposed for downstream tooling
   * — not part of `update()` because AWS treats schedule activation as a
   * separate side-effect from crawler config update.
   */
  async startSchedule(physicalId: string): Promise<void> {
    await this.getClient().send(new StartCrawlerScheduleCommand({ CrawlerName: physicalId }));
  }
  async stopSchedule(physicalId: string): Promise<void> {
    await this.getClient().send(new StopCrawlerScheduleCommand({ CrawlerName: physicalId }));
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: Record<string, string>,
    newTags: Record<string, string>
  ): Promise<void> {
    const arn = await buildGlueResourceArn(
      this.getClient(),
      this.getStsClient(),
      'crawler',
      physicalId,
      this.cachedAccountId
    );
    const toAdd: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [k, v] of Object.entries(newTags)) {
      if (oldTags[k] !== v) toAdd[k] = v;
    }
    for (const k of Object.keys(oldTags)) {
      if (!(k in newTags)) toRemove.push(k);
    }
    if (Object.keys(toAdd).length > 0 || toRemove.length > 0) {
      const { TagResourceCommand, UntagResourceCommand } = await import('@aws-sdk/client-glue');
      if (Object.keys(toAdd).length > 0) {
        await this.getClient().send(new TagResourceCommand({ ResourceArn: arn, TagsToAdd: toAdd }));
      }
      if (toRemove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: toRemove })
        );
      }
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
    if (!explicitName) return null;
    try {
      await this.getClient().send(new GetCrawlerCommand({ Name: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}

// ─── helpers shared by GlueCrawlerProvider ──────────────────────────────

/**
 * Crawler optional fields shared by `CreateCrawler` and `UpdateCrawler`.
 * `Schedule` is the bare cron string at the SDK layer, but CFn wraps it
 * in `{ ScheduleExpression: '...' }`. cdkd unwraps here.
 */
function buildCrawlerCommonFields(p: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (p['DatabaseName'] !== undefined) r['DatabaseName'] = p['DatabaseName'] as string;
  if (p['Description'] !== undefined) r['Description'] = p['Description'] as string;
  if (p['Classifiers'] !== undefined) r['Classifiers'] = p['Classifiers'] as string[];
  if (p['TablePrefix'] !== undefined) r['TablePrefix'] = p['TablePrefix'] as string;
  if (p['Schedule'] !== undefined) {
    // Accept both the CFn structured shape and a bare string for forward-compat.
    const sched = p['Schedule'];
    if (typeof sched === 'string') {
      r['Schedule'] = sched;
    } else if (typeof sched === 'object' && sched !== null) {
      const wrap = sched as Record<string, unknown>;
      if (wrap['ScheduleExpression'] !== undefined) {
        r['Schedule'] = wrap['ScheduleExpression'] as string;
      }
    }
  }
  if (p['SchemaChangePolicy'] !== undefined) {
    r['SchemaChangePolicy'] = p['SchemaChangePolicy'] as SchemaChangePolicy;
  }
  if (p['RecrawlPolicy'] !== undefined) {
    r['RecrawlPolicy'] = p['RecrawlPolicy'] as RecrawlPolicy;
  }
  if (p['LineageConfiguration'] !== undefined) {
    r['LineageConfiguration'] = p['LineageConfiguration'] as LineageConfiguration;
  }
  if (p['LakeFormationConfiguration'] !== undefined) {
    r['LakeFormationConfiguration'] = p['LakeFormationConfiguration'] as LakeFormationConfiguration;
  }
  if (p['Configuration'] !== undefined) r['Configuration'] = p['Configuration'] as string;
  if (p['CrawlerSecurityConfiguration'] !== undefined) {
    r['CrawlerSecurityConfiguration'] = p['CrawlerSecurityConfiguration'] as string;
  }
  return r;
}

/**
 * SDK Provider for `AWS::Glue::Connection`.
 *
 * `physicalId` is the connection name. `ConnectionInput.ConnectionProperties`
 * is a free-form `Record<string, string>` (e.g. `JDBC_CONNECTION_URL`,
 * `USERNAME` for JDBC), surfaced as-is on read for state-shape parity.
 */
export class GlueConnectionProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueConnectionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::Connection', new Set(['ConnectionInput', 'CatalogId'])],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Connection ${logicalId}`);
    const connectionInput = properties['ConnectionInput'] as Record<string, unknown> | undefined;
    if (!connectionInput) {
      throw new ProvisioningError(
        `ConnectionInput is required for Glue Connection ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const name = (connectionInput['Name'] as string | undefined) ?? logicalId;
    const catalogId = properties['CatalogId'] as string | undefined;
    try {
      await this.getClient().send(
        new CreateConnectionCommand({
          ...(catalogId && { CatalogId: catalogId }),
          ConnectionInput: buildConnectionInput(connectionInput, name),
        })
      );
      this.logger.debug(`Successfully created Glue Connection ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Connection ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Glue Connection ${logicalId}: ${physicalId}`);
    const connectionInput = properties['ConnectionInput'] as Record<string, unknown> | undefined;
    if (!connectionInput) {
      throw new ProvisioningError(
        `ConnectionInput is required for Glue Connection update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const catalogId = properties['CatalogId'] as string | undefined;
    try {
      await this.getClient().send(
        new UpdateConnectionCommand({
          ...(catalogId && { CatalogId: catalogId }),
          Name: physicalId,
          ConnectionInput: buildConnectionInput(connectionInput, physicalId),
        })
      );
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Connection ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Connection ${logicalId}: ${physicalId}`);
    const catalogId = properties?.['CatalogId'] as string | undefined;
    try {
      await this.getClient().send(
        new DeleteConnectionCommand({
          ConnectionName: physicalId,
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Connection ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Connection ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const catalogId = properties?.['CatalogId'] as string | undefined;
    let conn;
    try {
      const resp = await this.getClient().send(
        new GetConnectionCommand({ Name: physicalId, ...(catalogId && { CatalogId: catalogId }) })
      );
      conn = resp.Connection;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!conn) return undefined;

    const ci: Record<string, unknown> = {
      Name: conn.Name ?? physicalId,
      ConnectionType: conn.ConnectionType ?? '',
      Description: conn.Description ?? '',
      MatchCriteria: conn.MatchCriteria ?? [],
      ConnectionProperties: conn.ConnectionProperties ?? {},
      SparkProperties: conn.SparkProperties ?? {},
      AthenaProperties: conn.AthenaProperties ?? {},
      PythonProperties: conn.PythonProperties ?? {},
      PhysicalConnectionRequirements: conn.PhysicalConnectionRequirements
        ? pickDefined(conn.PhysicalConnectionRequirements as Record<string, unknown>)
        : {},
    };
    return { ConnectionInput: ci };
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName =
      input.knownPhysicalId ??
      ((input.properties['ConnectionInput'] as Record<string, unknown> | undefined)?.['Name'] as
        | string
        | undefined);
    if (!explicitName) return null;
    const catalogId = input.properties['CatalogId'] as string | undefined;
    try {
      await this.getClient().send(
        new GetConnectionCommand({
          Name: explicitName,
          ...(catalogId && { CatalogId: catalogId }),
        })
      );
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}

// ─── helpers shared by GlueConnectionProvider ───────────────────────────

function buildConnectionInput(ci: Record<string, unknown>, fallbackName: string): ConnectionInput {
  const result: ConnectionInput = {
    Name: (ci['Name'] as string | undefined) ?? fallbackName,
    ConnectionType: ci['ConnectionType'] as ConnectionInput['ConnectionType'],
    ConnectionProperties:
      (ci['ConnectionProperties'] as ConnectionInput['ConnectionProperties'] | undefined) ?? {},
  };
  if (ci['Description'] !== undefined) result.Description = ci['Description'] as string;
  if (ci['MatchCriteria'] !== undefined) result.MatchCriteria = ci['MatchCriteria'] as string[];
  if (ci['SparkProperties'] !== undefined) {
    result.SparkProperties = ci['SparkProperties'] as Record<string, string>;
  }
  if (ci['AthenaProperties'] !== undefined) {
    result.AthenaProperties = ci['AthenaProperties'] as Record<string, string>;
  }
  if (ci['PythonProperties'] !== undefined) {
    result.PythonProperties = ci['PythonProperties'] as Record<string, string>;
  }
  if (ci['PhysicalConnectionRequirements'] !== undefined) {
    result.PhysicalConnectionRequirements = ci[
      'PhysicalConnectionRequirements'
    ] as ConnectionInput['PhysicalConnectionRequirements'];
  }
  if (ci['AuthenticationConfiguration'] !== undefined) {
    result.AuthenticationConfiguration = ci[
      'AuthenticationConfiguration'
    ] as ConnectionInput['AuthenticationConfiguration'];
  }
  if (ci['ValidateCredentials'] !== undefined) {
    result.ValidateCredentials = ci['ValidateCredentials'] as boolean;
  }
  if (ci['ValidateForComputeEnvironments'] !== undefined) {
    result.ValidateForComputeEnvironments = ci[
      'ValidateForComputeEnvironments'
    ] as ConnectionInput['ValidateForComputeEnvironments'];
  }
  return result;
}

/**
 * SDK Provider for `AWS::Glue::Trigger`.
 *
 * Trigger has a state machine: `ACTIVATED` (running) ↔ `DEACTIVATED`
 * (paused). `UpdateTrigger` requires the trigger to be DEACTIVATED. If
 * the AWS-current state is ACTIVATED when an update is requested, this
 * provider:
 *   1. `StopTrigger` (DEACTIVATED).
 *   2. `UpdateTrigger`.
 *   3. `StartTrigger` (re-ACTIVATED) so the user-visible state is
 *      preserved across the update.
 *
 * `physicalId` is the trigger name. Tags are managed via the Glue
 * `GetTags` / `TagResource` / `UntagResource` API (not in
 * `TriggerUpdate`).
 */
export class GlueTriggerProvider implements ResourceProvider {
  private client: GlueClient | undefined;
  private stsClient: STSClient | undefined;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('GlueTriggerProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Trigger',
      new Set([
        'Name',
        'Type',
        'Schedule',
        'Actions',
        'Predicate',
        'Description',
        'StartOnCreation',
        'EventBatchingCondition',
        'WorkflowName',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.stsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Glue Trigger ${logicalId}`);
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const type = properties['Type'] as string | undefined;
    const actions = properties['Actions'] as TriggerAction[] | undefined;
    if (!type) {
      throw new ProvisioningError(
        `Type is required for Glue Trigger ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!actions) {
      throw new ProvisioningError(
        `Actions is required for Glue Trigger ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    try {
      const tags = cfnTagsToMap(properties['Tags']);
      await this.getClient().send(
        new CreateTriggerCommand({
          Name: name,
          Type: type as 'SCHEDULED' | 'CONDITIONAL' | 'ON_DEMAND' | 'EVENT',
          Actions: actions,
          ...(properties['Schedule'] !== undefined && {
            Schedule: properties['Schedule'] as string,
          }),
          ...(properties['Predicate'] !== undefined && {
            Predicate: properties['Predicate'] as Predicate,
          }),
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(properties['StartOnCreation'] !== undefined && {
            StartOnCreation: properties['StartOnCreation'] as boolean,
          }),
          ...(properties['WorkflowName'] !== undefined && {
            WorkflowName: properties['WorkflowName'] as string,
          }),
          ...(properties['EventBatchingCondition'] !== undefined && {
            EventBatchingCondition: properties['EventBatchingCondition'] as EventBatchingCondition,
          }),
          ...(tags && { Tags: tags }),
        })
      );
      this.logger.debug(`Successfully created Glue Trigger ${logicalId}: ${name}`);
      return { physicalId: name, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Glue Trigger ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
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
    this.logger.debug(`Updating Glue Trigger ${logicalId}: ${physicalId}`);
    try {
      // Glue requires the trigger be DEACTIVATED before UpdateTrigger. Read the
      // current state to decide whether we need to stop+restart.
      let restart = false;
      try {
        const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
        if (cur.Trigger?.State === 'ACTIVATED') {
          restart = true;
          await this.getClient().send(new StopTriggerCommand({ Name: physicalId }));
          // StopTrigger is async — UpdateTrigger fails if the trigger has not
          // yet transitioned out of ACTIVATED, so wait for DEACTIVATED first.
          await this.waitForTriggerDeactivated(physicalId);
        }
      } catch (err) {
        // If GetTrigger fails for any reason other than NotFound, fall
        // through and let UpdateTrigger surface a clear AWS error.
        if (!(err instanceof EntityNotFoundException)) {
          this.logger.debug(
            `GetTrigger pre-check failed for ${physicalId}; continuing anyway: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      const update: TriggerUpdate = {
        ...(properties['Description'] !== undefined && {
          Description: properties['Description'] as string,
        }),
        ...(properties['Schedule'] !== undefined && {
          Schedule: properties['Schedule'] as string,
        }),
        ...(properties['Actions'] !== undefined && {
          Actions: properties['Actions'] as TriggerAction[],
        }),
        ...(properties['Predicate'] !== undefined && {
          Predicate: properties['Predicate'] as Predicate,
        }),
        ...(properties['EventBatchingCondition'] !== undefined && {
          EventBatchingCondition: properties['EventBatchingCondition'] as EventBatchingCondition,
        }),
      };
      // Restore the ACTIVATED state even if UpdateTrigger throws — otherwise a
      // failed update would leave a previously-running trigger stuck
      // DEACTIVATED. Capture the update error rather than using `finally` so
      // that if BOTH the update and the re-activation throw, the root-cause
      // update error wins (a bare `finally` would let the secondary
      // "failed to re-activate" error mask it). A re-activation failure on an
      // OTHERWISE-successful update still surfaces (the trigger really is stuck
      // deactivated in that case).
      let updateError: unknown;
      try {
        await this.getClient().send(
          new UpdateTriggerCommand({ Name: physicalId, TriggerUpdate: update })
        );
      } catch (err) {
        updateError = err;
      }
      if (restart) {
        try {
          await this.getClient().send(new StartTriggerCommand({ Name: physicalId }));
        } catch (restartError) {
          if (updateError === undefined) throw restartError;
          this.logger.warn(
            `Failed to re-activate Glue Trigger ${physicalId} after a failed update: ${
              (restartError as Error).message
            }`
          );
        }
      }
      if (updateError !== undefined) throw updateError;

      const oldTags = cfnTagsToMap(previousProperties['Tags']) ?? {};
      const newTags = cfnTagsToMap(properties['Tags']) ?? {};
      await this.applyTagDiff(physicalId, oldTags, newTags);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Glue Trigger ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Poll GetTrigger until the trigger leaves the ACTIVATED / ACTIVATING state
   * (StopTrigger is async). Returns once DEACTIVATED (or any non-active state)
   * is observed, the trigger is gone, or the attempt budget is exhausted —
   * callers then proceed with UpdateTrigger / DeleteTrigger.
   */
  private async waitForTriggerDeactivated(physicalId: string): Promise<void> {
    for (let attempt = 0; attempt < TRIGGER_DEACTIVATE_MAX_ATTEMPTS; attempt++) {
      try {
        const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
        const state = cur.Trigger?.State;
        if (state !== 'ACTIVATED' && state !== 'ACTIVATING') return;
      } catch (err) {
        if (err instanceof EntityNotFoundException) return;
        // Inconclusive read — keep polling until the budget is gone.
      }
      await sleep(TRIGGER_DEACTIVATE_POLL_INTERVAL_MS);
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Trigger ${logicalId}: ${physicalId}`);
    try {
      // An ACTIVATED scheduled / conditional trigger should be stopped before
      // deletion so a firing trigger does not race the delete.
      try {
        const cur = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
        if (cur.Trigger?.State === 'ACTIVATED') {
          await this.getClient().send(new StopTriggerCommand({ Name: physicalId }));
          await this.waitForTriggerDeactivated(physicalId);
        }
      } catch (err) {
        // Pre-check is best-effort; if it fails for anything other than NotFound
        // (which DeleteTrigger handles below) let DeleteTrigger surface the error.
        if (!(err instanceof EntityNotFoundException)) {
          this.logger.debug(
            `GetTrigger pre-delete check failed for ${physicalId}; continuing: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      await this.getClient().send(new DeleteTriggerCommand({ Name: physicalId }));
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Glue Trigger ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Glue Trigger ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let trig;
    try {
      const resp = await this.getClient().send(new GetTriggerCommand({ Name: physicalId }));
      trig = resp.Trigger;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return undefined;
      throw err;
    }
    if (!trig) return undefined;

    // Predicate.Conditions[]: AWS preserves the array order on read; we
    // surface entries as-is since cdkd state holds the same shape.
    const result: Record<string, unknown> = {
      Name: trig.Name ?? physicalId,
      Type: trig.Type ?? '',
      Schedule: trig.Schedule ?? '',
      Description: trig.Description ?? '',
      WorkflowName: trig.WorkflowName ?? '',
      Actions: (trig.Actions ?? []).map((a) =>
        pickDefined(a as unknown as Record<string, unknown>)
      ),
      Predicate: trig.Predicate
        ? {
            Logical: trig.Predicate.Logical ?? '',
            Conditions: (trig.Predicate.Conditions ?? []).map((c: TriggerCondition) =>
              pickDefined(c as unknown as Record<string, unknown>)
            ),
          }
        : {},
      EventBatchingCondition: trig.EventBatchingCondition
        ? pickDefined(trig.EventBatchingCondition as unknown as Record<string, unknown>)
        : {},
    };
    result['Tags'] = await fetchGlueTags(
      this.getClient(),
      this.getStsClient(),
      'trigger',
      trig.Name ?? physicalId,
      this.cachedAccountId,
      this.logger
    );
    return result;
  }

  private async applyTagDiff(
    physicalId: string,
    oldTags: Record<string, string>,
    newTags: Record<string, string>
  ): Promise<void> {
    const arn = await buildGlueResourceArn(
      this.getClient(),
      this.getStsClient(),
      'trigger',
      physicalId,
      this.cachedAccountId
    );
    const toAdd: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [k, v] of Object.entries(newTags)) {
      if (oldTags[k] !== v) toAdd[k] = v;
    }
    for (const k of Object.keys(oldTags)) {
      if (!(k in newTags)) toRemove.push(k);
    }
    if (Object.keys(toAdd).length > 0 || toRemove.length > 0) {
      const { TagResourceCommand, UntagResourceCommand } = await import('@aws-sdk/client-glue');
      if (Object.keys(toAdd).length > 0) {
        await this.getClient().send(new TagResourceCommand({ ResourceArn: arn, TagsToAdd: toAdd }));
      }
      if (toRemove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: toRemove })
        );
      }
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
    if (!explicitName) return null;
    try {
      await this.getClient().send(new GetTriggerCommand({ Name: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }
}
