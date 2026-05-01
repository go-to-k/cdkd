import {
  KinesisClient,
  CreateStreamCommand,
  DeleteStreamCommand,
  DescribeStreamCommand,
  UpdateShardCountCommand,
  AddTagsToStreamCommand,
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  ListStreamsCommand,
  ListTagsForStreamCommand,
  ResourceNotFoundException,
  type EncryptionType,
} from '@aws-sdk/client-kinesis';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('KinesisProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Kinesis::Stream',
      new Set([
        'Name',
        'StreamModeDetails',
        'ShardCount',
        'Tags',
        'RetentionPeriodHours',
        'StreamEncryption',
      ]),
    ],
  ]);

  private getClient(): KinesisClient {
    if (!this.client) {
      this.client = new KinesisClient(this.providerRegion ? { region: this.providerRegion } : {});
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

      // Apply RetentionPeriodHours if specified (default is 24 hours)
      const retentionPeriodHours = properties['RetentionPeriodHours'] as number | undefined;
      if (retentionPeriodHours !== undefined && retentionPeriodHours !== 24) {
        this.logger.debug(
          `Setting retention period to ${retentionPeriodHours} hours for ${streamName}`
        );
        if (retentionPeriodHours > 24) {
          await this.getClient().send(
            new IncreaseStreamRetentionPeriodCommand({
              StreamName: streamName,
              RetentionPeriodHours: retentionPeriodHours,
            })
          );
        } else {
          await this.getClient().send(
            new DecreaseStreamRetentionPeriodCommand({
              StreamName: streamName,
              RetentionPeriodHours: retentionPeriodHours,
            })
          );
        }
        // Wait for stream to become ACTIVE after retention period change
        await this.waitForStreamActive(streamName);
      }

      // Apply StreamEncryption if specified
      const streamEncryption = properties['StreamEncryption'] as
        | Record<string, unknown>
        | undefined;
      if (streamEncryption) {
        const encryptionType = (streamEncryption['EncryptionType'] as string) ?? 'KMS';
        const keyId = streamEncryption['KeyId'] as string;
        this.logger.debug(`Enabling stream encryption for ${streamName}`);
        await this.getClient().send(
          new StartStreamEncryptionCommand({
            StreamName: streamName,
            EncryptionType: encryptionType as EncryptionType,
            KeyId: keyId,
          })
        );
        // Wait for stream to become ACTIVE after encryption change
        await this.waitForStreamActive(streamName);
      }

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

      // Update RetentionPeriodHours if changed
      const newRetention = properties['RetentionPeriodHours'] as number | undefined;
      const oldRetention = previousProperties['RetentionPeriodHours'] as number | undefined;
      const effectiveNewRetention = newRetention ?? 24;
      const effectiveOldRetention = oldRetention ?? 24;
      if (effectiveNewRetention !== effectiveOldRetention) {
        this.logger.debug(
          `Updating retention period for ${physicalId}: ${effectiveOldRetention} -> ${effectiveNewRetention}`
        );
        if (effectiveNewRetention > effectiveOldRetention) {
          await this.getClient().send(
            new IncreaseStreamRetentionPeriodCommand({
              StreamName: physicalId,
              RetentionPeriodHours: effectiveNewRetention,
            })
          );
        } else {
          await this.getClient().send(
            new DecreaseStreamRetentionPeriodCommand({
              StreamName: physicalId,
              RetentionPeriodHours: effectiveNewRetention,
            })
          );
        }
        await this.waitForStreamActive(physicalId);
      }

      // Update StreamEncryption if changed
      const newEncryption = properties['StreamEncryption'] as Record<string, unknown> | undefined;
      const oldEncryption = previousProperties['StreamEncryption'] as
        | Record<string, unknown>
        | undefined;
      if (JSON.stringify(newEncryption) !== JSON.stringify(oldEncryption)) {
        // Remove old encryption if it existed
        if (oldEncryption) {
          await this.getClient().send(
            new StopStreamEncryptionCommand({
              StreamName: physicalId,
              EncryptionType: ((oldEncryption['EncryptionType'] as string) ??
                'KMS') as EncryptionType,
              KeyId: oldEncryption['KeyId'] as string,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
        // Apply new encryption
        if (newEncryption) {
          await this.getClient().send(
            new StartStreamEncryptionCommand({
              StreamName: physicalId,
              EncryptionType: ((newEncryption['EncryptionType'] as string) ??
                'KMS') as EncryptionType,
              KeyId: newEncryption['KeyId'] as string,
            })
          );
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
   * Adopt an existing Kinesis stream into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.Name` → verify
   *     with `DescribeStream`.
   *  2. Walk `ListStreams` (paged via `ExclusiveStartStreamName`) and
   *     match the `aws:cdk:path` tag via `ListTagsForStream(StreamName)`.
   *
   * Kinesis tags use the standard `Tag[]` array shape (`Key`/`Value`),
   * so `matchesCdkPath` from import-helpers applies directly.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        await this.getClient().send(new DescribeStreamCommand({ StreamName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let exclusiveStartStreamName: string | undefined;
    // ListStreams paginates via `ExclusiveStartStreamName` rather than
    // `NextToken` — set the next page boundary to the last name we saw
    // when `HasMoreStreams` is true.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const list = await this.getClient().send(
        new ListStreamsCommand({
          ...(exclusiveStartStreamName && { ExclusiveStartStreamName: exclusiveStartStreamName }),
        })
      );
      const names = list.StreamNames ?? [];
      for (const streamName of names) {
        const tagsResp = await this.getClient().send(
          new ListTagsForStreamCommand({ StreamName: streamName })
        );
        if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
          return { physicalId: streamName, attributes: {} };
        }
      }
      if (!list.HasMoreStreams || names.length === 0) break;
      exclusiveStartStreamName = names[names.length - 1];
    }
    return null;
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
