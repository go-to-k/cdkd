import {
  GlueClient,
  CreateDatabaseCommand,
  DeleteDatabaseCommand,
  CreateTableCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  GetDatabaseCommand,
  GetDatabasesCommand,
  GetTableCommand,
  GetTablesCommand,
  GetTagsCommand,
  EntityNotFoundException,
  type TableInput,
  type StorageDescriptor,
  type Column,
  type Order,
  type SerDeInfo,
} from '@aws-sdk/client-glue';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
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
        // AWS exposes UpdateDatabase but cdkd does not yet plumb the
        // DatabaseInput delta through. `cdkd drift --revert` surfaces a
        // clear immutable-error rather than silently no-op'ing.
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          'Glue Database updates are not yet implemented in cdkd; re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
        );
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
          DatabaseInput: {
            Name: databaseName,
            Description: databaseInput['Description'] as string | undefined,
            LocationUri: databaseInput['LocationUri'] as string | undefined,
            Parameters: databaseInput['Parameters'] as Record<string, string> | undefined,
          },
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
    if (db.Description !== undefined && db.Description !== '') {
      dbInput['Description'] = db.Description;
    }
    if (db.LocationUri !== undefined) dbInput['LocationUri'] = db.LocationUri;
    if (db.Parameters && Object.keys(db.Parameters).length > 0) {
      dbInput['Parameters'] = db.Parameters;
    }
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
    if (table.Description !== undefined && table.Description !== '') {
      tableInput['Description'] = table.Description;
    }
    if (table.Owner !== undefined) tableInput['Owner'] = table.Owner;
    if (table.Retention !== undefined) tableInput['Retention'] = table.Retention;
    if (table.TableType !== undefined) tableInput['TableType'] = table.TableType;
    if (table.PartitionKeys && table.PartitionKeys.length > 0) {
      tableInput['PartitionKeys'] = table.PartitionKeys.map(
        (k) => k as unknown as Record<string, unknown>
      );
    }
    if (table.Parameters && Object.keys(table.Parameters).length > 0) {
      tableInput['Parameters'] = table.Parameters;
    }
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
