import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  ResourceNotFoundException,
  type CreateDeliveryStreamCommandInput,
  type S3DestinationConfiguration,
  type ExtendedS3DestinationConfiguration,
} from '@aws-sdk/client-firehose';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS Kinesis Firehose resources
 *
 * Supports:
 * - AWS::KinesisFirehose::DeliveryStream
 *
 * CreateDeliveryStream is synchronous - the CC API adds unnecessary
 * polling overhead for an operation that completes immediately.
 */
export class FirehoseProvider implements ResourceProvider {
  private client: FirehoseClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('FirehoseProvider');

  private getClient(): FirehoseClient {
    if (!this.client) {
      this.client = new FirehoseClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Create a Firehose delivery stream
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Firehose delivery stream ${logicalId}`);

    const deliveryStreamName = properties['DeliveryStreamName'] as string | undefined;
    const deliveryStreamType =
      (properties['DeliveryStreamType'] as string | undefined) || 'DirectPut';

    try {
      const input: CreateDeliveryStreamCommandInput = {
        DeliveryStreamName: deliveryStreamName || logicalId,
        DeliveryStreamType: deliveryStreamType as
          | 'DirectPut'
          | 'KinesisStreamAsSource'
          | 'MSKAsSource',
      };

      // Map S3DestinationConfiguration (CFn PascalCase -> SDK format)
      if (properties['S3DestinationConfiguration']) {
        const s3Config = properties['S3DestinationConfiguration'] as Record<string, unknown>;
        input.S3DestinationConfiguration = this.mapS3DestinationConfiguration(s3Config);
      }

      // Map ExtendedS3DestinationConfiguration
      if (properties['ExtendedS3DestinationConfiguration']) {
        const extS3Config = properties['ExtendedS3DestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.ExtendedS3DestinationConfiguration =
          this.mapExtendedS3DestinationConfiguration(extS3Config);
      }

      // Map KinesisStreamSourceConfiguration
      if (properties['KinesisStreamSourceConfiguration']) {
        const kinesisConfig = properties['KinesisStreamSourceConfiguration'] as Record<
          string,
          unknown
        >;
        input.KinesisStreamSourceConfiguration = {
          KinesisStreamARN: (kinesisConfig['KinesisStreamArn'] ||
            kinesisConfig['KinesisStreamARN']) as string,
          RoleARN: (kinesisConfig['RoleArn'] || kinesisConfig['RoleARN']) as string,
        };
      }

      const response = await this.getClient().send(new CreateDeliveryStreamCommand(input));

      const physicalId =
        deliveryStreamName ||
        input.DeliveryStreamName ||
        response.DeliveryStreamARN?.split('/').pop() ||
        '';
      const arn = response.DeliveryStreamARN;

      this.logger.debug(
        `Successfully created Firehose delivery stream ${logicalId}: ${physicalId}`
      );

      return {
        physicalId,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Firehose delivery stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a Firehose delivery stream
   *
   * Most changes require replacement, so this is a no-op.
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(
      `Update for ${resourceType} ${logicalId} (${physicalId}) - no-op, most changes require replacement`
    );
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  /**
   * Delete a Firehose delivery stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting Firehose delivery stream ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted Firehose delivery stream ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(
          `Firehose delivery stream ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Firehose delivery stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Map CFn S3DestinationConfiguration to SDK format
   *
   * CFn uses PascalCase (BucketArn, RoleArn) while SDK uses uppercase ARN
   * (BucketARN, RoleARN).
   */
  private mapS3DestinationConfiguration(
    config: Record<string, unknown>
  ): S3DestinationConfiguration {
    const result: S3DestinationConfiguration = {
      BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
      RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
    };

    if (config['Prefix'] !== undefined) {
      result.Prefix = config['Prefix'] as string;
    }

    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }

    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as S3DestinationConfiguration['CompressionFormat'];
    }

    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }

    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as S3DestinationConfiguration['EncryptionConfiguration'];
    }

    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as S3DestinationConfiguration['CloudWatchLoggingOptions'];
    }

    return result;
  }

  /**
   * Map CFn ExtendedS3DestinationConfiguration to SDK format
   */
  private mapExtendedS3DestinationConfiguration(
    config: Record<string, unknown>
  ): ExtendedS3DestinationConfiguration {
    const result: ExtendedS3DestinationConfiguration = {
      BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
      RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
    };

    if (config['Prefix'] !== undefined) {
      result.Prefix = config['Prefix'] as string;
    }

    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }

    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as ExtendedS3DestinationConfiguration['CompressionFormat'];
    }

    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }

    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as ExtendedS3DestinationConfiguration['EncryptionConfiguration'];
    }

    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as ExtendedS3DestinationConfiguration['CloudWatchLoggingOptions'];
    }

    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as ExtendedS3DestinationConfiguration['ProcessingConfiguration'];
    }

    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config[
        'S3BackupMode'
      ] as ExtendedS3DestinationConfiguration['S3BackupMode'];
    }

    if (config['S3BackupConfiguration'] !== undefined) {
      const backupConfig = config['S3BackupConfiguration'] as Record<string, unknown>;
      result.S3BackupConfiguration = this.mapS3DestinationConfiguration(backupConfig);
    }

    if (config['DataFormatConversionConfiguration'] !== undefined) {
      result.DataFormatConversionConfiguration = config[
        'DataFormatConversionConfiguration'
      ] as ExtendedS3DestinationConfiguration['DataFormatConversionConfiguration'];
    }

    return result;
  }
}
