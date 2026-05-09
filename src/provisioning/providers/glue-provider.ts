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
  EntityNotFoundException,
  type DatabaseInput,
  type TableInput,
  type StorageDescriptor,
  type Column,
  type Order,
  type SerDeInfo,
  type EncryptionConfiguration,
  type S3Encryption,
  type CloudWatchEncryption,
  type JobBookmarksEncryption,
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
    ['AWS::Glue::Database', new Set(['DatabaseInput', 'CatalogId'])],
    ['AWS::Glue::Table', new Set(['DatabaseName', 'TableInput', 'CatalogId'])],
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

    const databaseName = databaseInput['Name'] as string;
    if (!databaseName) {
      throw new ProvisioningError(
        `DatabaseInput.Name is required for Glue Database ${logicalId}`,
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

    const tableName = tableInput['Name'] as string;
    if (!tableName) {
      throw new ProvisioningError(
        `TableInput.Name is required for Glue Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const catalogId = properties['CatalogId'] as string | undefined;

    try {
      await this.getClient().send(
        new CreateTableCommand({
          CatalogId: catalogId,
          DatabaseName: databaseName,
          TableInput: this.buildTableInput(tableInput),
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

    const [databaseName] = physicalId.split('|');
    if (!databaseName) {
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
          TableInput: this.buildTableInput(tableInput),
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
  private buildTableInput(tableInput: Record<string, unknown>): TableInput {
    const result: TableInput = {
      Name: tableInput['Name'] as string,
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
    return { DatabaseInput: dbInput };
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

    return { DatabaseName: databaseName, TableInput: tableInput };
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
      const tags = workflowTagsForCreate(properties['Tags']);
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
            MaxConcurrentRuns: properties['MaxConcurrentRuns'] as number,
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
            MaxConcurrentRuns: properties['MaxConcurrentRuns'] as number,
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
      'AWS::Glue::SecurityConfiguration is immutable; AWS provides no Update API. Use cdkd deploy --replace, or destroy + redeploy with the new EncryptionConfiguration.'
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

/**
 * Normalize the CFn `Tags` shape (`Array<{Key,Value}>`) into the SDK's
 * `TagsMap` (`Record<string,string>`) for `CreateWorkflow`. Returns
 * `undefined` when no tags — the caller drops the key.
 */
function workflowTagsForCreate(tags: unknown): Record<string, string> | undefined {
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const t of tags) {
    const obj = t as Record<string, unknown>;
    const k = typeof obj['Key'] === 'string' ? obj['Key'] : undefined;
    const v = typeof obj['Value'] === 'string' ? obj['Value'] : '';
    if (!k) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
