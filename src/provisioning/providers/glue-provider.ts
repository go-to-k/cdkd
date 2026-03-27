import {
  GlueClient,
  CreateDatabaseCommand,
  DeleteDatabaseCommand,
  CreateTableCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  EntityNotFoundException,
  type TableInput,
  type StorageDescriptor,
  type Column,
  type Order,
  type SerDeInfo,
} from '@aws-sdk/client-glue';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
  private logger = getLogger().child('GlueProvider');

  private getClient(): GlueClient {
    if (!this.client) {
      this.client = new GlueClient({});
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
        // Database update is mostly no-op for basic properties
        this.logger.debug(
          `Update for ${resourceType} ${logicalId} (${physicalId}) - no-op, immutable`
        );
        return { physicalId, wasReplaced: false };
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
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::Glue::Database':
        return this.deleteDatabase(logicalId, physicalId, resourceType);
      case 'AWS::Glue::Table':
        return this.deleteTable(logicalId, physicalId, resourceType);
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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting Glue Database ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDatabaseCommand({
          Name: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted Glue Database ${logicalId}`);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
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
    resourceType: string
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
      result.Parameters = tableInput['Parameters'] as Record<string, string>;
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
      result.SerdeInfo = sd['SerdeInfo'] as SerDeInfo;
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
}
