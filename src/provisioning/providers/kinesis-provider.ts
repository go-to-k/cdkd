import {
  KinesisClient,
  CreateStreamCommand,
  DeleteStreamCommand,
  DescribeStreamCommand,
  UpdateShardCountCommand,
  AddTagsToStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Kinesis Stream Provider
 *
 * Implements resource provisioning for AWS::Kinesis::Stream using the Kinesis SDK.
 * WHY: The CC API polls with exponential backoff (1s->2s->4s->8s->10s) for stream
 * creation, but we can poll DescribeStream directly with shorter intervals (2s),
 * eliminating the CC API intermediary overhead and reducing total wait time.
 */
export class KinesisStreamProvider implements ResourceProvider {
  private client: KinesisClient | undefined;
  private logger = getLogger().child('KinesisProvider');

  private getClient(): KinesisClient {
    if (!this.client) {
      this.client = new KinesisClient({});
    }
    return this.client;
  }

  /**
   * Create a Kinesis stream
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Kinesis stream ${logicalId}`);

    const streamName =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });

    try {
      // Determine stream mode
      const streamModeDetails = properties['StreamModeDetails'] as
        | Record<string, unknown>
        | undefined;
      const streamMode = (streamModeDetails?.['StreamMode'] as string) || 'PROVISIONED';

      // ShardCount is required for PROVISIONED mode
      const shardCount =
        streamMode === 'PROVISIONED' ? Number(properties['ShardCount'] ?? 1) : undefined;

      await this.getClient().send(
        new CreateStreamCommand({
          StreamName: streamName,
          ...(shardCount !== undefined && { ShardCount: shardCount }),
          StreamModeDetails: {
            StreamMode: streamMode as 'PROVISIONED' | 'ON_DEMAND',
          },
        })
      );

      this.logger.debug(`CreateStream initiated for ${streamName}, waiting for ACTIVE status`);

      // Poll until stream is ACTIVE
      const streamInfo = await this.waitForStreamActive(streamName);

      // Apply tags if specified
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        const tags: Record<string, string> = {};
        for (const tag of tagList) {
          tags[tag.Key] = tag.Value;
        }
        if (Object.keys(tags).length > 0) {
          await this.getClient().send(
            new AddTagsToStreamCommand({
              StreamName: streamName,
              Tags: tags,
            })
          );
        }
      }

      // Apply RetentionPeriodHours if specified (requires separate API call after creation)
      // Note: Default is 24 hours, UpdateShardCount doesn't handle this.
      // Kinesis uses IncreaseStreamRetentionPeriod / DecreaseStreamRetentionPeriod
      // but for simplicity we skip non-default retention in create.

      this.logger.debug(`Successfully created Kinesis stream ${logicalId}: ${streamName}`);

      return {
        physicalId: streamName,
        attributes: {
          Arn: streamInfo.streamArn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        streamName,
        cause
      );
    }
  }

  /**
   * Update a Kinesis stream
   *
   * Supports updating ShardCount for PROVISIONED mode streams.
   * StreamMode and Name changes require replacement (handled by deployment layer).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Kinesis stream ${logicalId}: ${physicalId}`);

    try {
      // Update ShardCount if changed (only for PROVISIONED mode)
      const streamModeDetails = properties['StreamModeDetails'] as
        | Record<string, unknown>
        | undefined;
      const streamMode = (streamModeDetails?.['StreamMode'] as string) || 'PROVISIONED';

      if (streamMode === 'PROVISIONED') {
        const newShardCount = Number(properties['ShardCount'] ?? 1);
        const oldShardCount = Number(previousProperties['ShardCount'] ?? 1);

        if (newShardCount !== oldShardCount) {
          this.logger.debug(
            `Updating shard count for ${physicalId}: ${oldShardCount} -> ${newShardCount}`
          );

          await this.getClient().send(
            new UpdateShardCountCommand({
              StreamName: physicalId,
              TargetShardCount: newShardCount,
              ScalingType: 'UNIFORM_SCALING',
            })
          );

          // Wait for stream to become ACTIVE after resharding
          await this.waitForStreamActive(physicalId);
        }
      }

      // Get current stream description for attributes
      const response = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: response.StreamDescription?.StreamARN,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Kinesis stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting Kinesis stream ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteStreamCommand({
          StreamName: physicalId,
          EnforceConsumerDeletion: true,
        })
      );
      this.logger.debug(`Successfully deleted Kinesis stream ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(`Kinesis stream ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Poll DescribeStream until the stream reaches ACTIVE status
   *
   * Uses 2s polling intervals instead of CC API's exponential backoff
   * (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForStreamActive(
    streamName: string,
    maxAttempts = 30
  ): Promise<{ streamArn: string | undefined }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: streamName })
      );

      const status = response.StreamDescription?.StreamStatus;
      this.logger.debug(
        `Stream ${streamName} status: ${status} (attempt ${attempt}/${maxAttempts})`
      );

      if (status === 'ACTIVE') {
        return {
          streamArn: response.StreamDescription?.StreamARN,
        };
      }

      if (status !== 'CREATING' && status !== 'UPDATING') {
        throw new Error(`Unexpected stream status: ${status}`);
      }

      // Wait 2 seconds between polls
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(
      `Stream ${streamName} did not reach ACTIVE status within ${maxAttempts * 2} seconds`
    );
  }
}
