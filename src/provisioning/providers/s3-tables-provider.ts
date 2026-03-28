import {
  S3TablesClient,
  CreateTableBucketCommand,
  DeleteTableBucketCommand,
  CreateNamespaceCommand,
  DeleteNamespaceCommand,
  CreateTableCommand,
  DeleteTableCommand,
  ListNamespacesCommand,
  ListTablesCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
  private logger = getLogger().child('S3TablesProvider');

  private getClient(): S3TablesClient {
    if (!this.client) {
      this.client = new S3TablesClient({});
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

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // All S3 Tables resources are immutable - no update supported
    this.logger.debug(`Update is no-op for ${resourceType} ${logicalId}`);
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::S3Tables::TableBucket':
        return this.deleteTableBucket(logicalId, physicalId, resourceType);
      case 'AWS::S3Tables::Namespace':
        return this.deleteNamespace(logicalId, physicalId, resourceType);
      case 'AWS::S3Tables::Table':
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
    resourceType: string
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

    const namespace = properties['Namespace'] as string[] | undefined;
    if (!namespace || namespace.length === 0) {
      throw new ProvisioningError(
        `Namespace is required for S3 Tables Namespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const namespaceName = namespace[0]!;

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
    resourceType: string
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

    const name = properties['Name'] as string | undefined;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for S3 Tables Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const format = properties['Format'] as string | undefined;
    if (!format) {
      throw new ProvisioningError(
        `Format is required for S3 Tables Table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.getClient().send(
        new CreateTableCommand({
          tableBucketARN,
          namespace,
          name,
          format: format as 'ICEBERG',
        })
      );

      const physicalId = `${tableBucketARN}|${namespace}|${name}`;

      this.logger.debug(`Successfully created S3 Tables Table ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
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

  private async deleteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string
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
}
