import {
  S3VectorsClient,
  CreateVectorBucketCommand,
  DeleteVectorBucketCommand,
  ListIndexesCommand,
  DeleteIndexCommand,
  type SseType,
} from '@aws-sdk/client-s3vectors';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS S3 Vectors resources
 *
 * Supports:
 * - AWS::S3Vectors::VectorBucket
 *
 * S3 Vectors CreateVectorBucket is synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class S3VectorsProvider implements ResourceProvider {
  private client: S3VectorsClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('S3VectorsProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::S3Vectors::VectorBucket', new Set(['VectorBucketName', 'EncryptionConfiguration'])],
  ]);

  private getClient(): S3VectorsClient {
    if (!this.client) {
      this.client = new S3VectorsClient(this.providerRegion ? { region: this.providerRegion } : {});
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
      case 'AWS::S3Vectors::VectorBucket':
        return this.createVectorBucket(logicalId, resourceType, properties);
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
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::S3Vectors::VectorBucket':
        // VectorBucket does not support updates
        return Promise.resolve({ physicalId: _physicalId, wasReplaced: false });
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          _physicalId
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
    switch (resourceType) {
      case 'AWS::S3Vectors::VectorBucket':
        return this.deleteVectorBucket(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::S3Vectors::VectorBucket ─────────────────────────────────

  private async createVectorBucket(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 VectorBucket ${logicalId}`);

    const vectorBucketName = properties['VectorBucketName'] as string | undefined;
    if (!vectorBucketName) {
      throw new ProvisioningError(
        `VectorBucketName is required for S3 VectorBucket ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const encryptionConfiguration = properties['EncryptionConfiguration'] as
      | Record<string, unknown>
      | undefined;

    try {
      const result = await this.getClient().send(
        new CreateVectorBucketCommand({
          vectorBucketName,
          encryptionConfiguration: encryptionConfiguration
            ? {
                sseType: encryptionConfiguration['SSEType'] as SseType | undefined,
                kmsKeyArn: encryptionConfiguration['KMSKeyArn'] as string | undefined,
              }
            : undefined,
        })
      );

      const vectorBucketArn = result.vectorBucketArn ?? '';

      this.logger.debug(`Successfully created S3 VectorBucket ${logicalId}: ${vectorBucketName}`);

      return {
        physicalId: vectorBucketName,
        attributes: {
          VectorBucketArn: vectorBucketArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 VectorBucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteVectorBucket(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 VectorBucket ${logicalId}: ${physicalId}`);

    try {
      // Step 1: Delete all indexes in the vector bucket
      await this.emptyVectorBucket(logicalId, physicalId);

      // Step 2: Delete the vector bucket itself
      await this.getClient().send(
        new DeleteVectorBucketCommand({
          vectorBucketName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted S3 VectorBucket ${logicalId}`);
    } catch (error) {
      // Idempotency: treat not-found as success
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`S3 VectorBucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 VectorBucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Empty a vector bucket by listing and deleting all indexes.
   * Paginates through all indexes using NextToken.
   */
  private async emptyVectorBucket(logicalId: string, vectorBucketName: string): Promise<void> {
    let nextToken: string | undefined;

    do {
      const listResult = await this.getClient().send(
        new ListIndexesCommand({
          vectorBucketName,
          nextToken,
        })
      );

      const indexes = listResult.indexes ?? [];
      for (const index of indexes) {
        if (index.indexName) {
          this.logger.debug(`Deleting index ${index.indexName} from VectorBucket ${logicalId}`);
          await this.getClient().send(
            new DeleteIndexCommand({
              vectorBucketName,
              indexName: index.indexName,
            })
          );
        }
      }

      nextToken = listResult.nextToken;
    } while (nextToken);
  }

  private isNotFoundError(error: unknown): boolean {
    if (error instanceof Error) {
      const name = error.name;
      return (
        name === 'NotFoundException' ||
        name === 'ResourceNotFoundException' ||
        name === 'NoSuchVectorBucket' ||
        name === 'NoSuchBucket'
      );
    }
    return false;
  }
}
