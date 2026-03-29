import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  ResourceNotFoundException,
  type CreateDeliveryStreamCommandInput,
  type S3DestinationConfiguration,
  type ExtendedS3DestinationConfiguration,
  type Tag,
  type HttpEndpointDestinationConfiguration,
  type RedshiftDestinationConfiguration,
  type ElasticsearchDestinationConfiguration,
  type AmazonopensearchserviceDestinationConfiguration,
  type SplunkDestinationConfiguration,
  type AmazonOpenSearchServerlessDestinationConfiguration,
  type DeliveryStreamEncryptionConfigurationInput,
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

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::KinesisFirehose::DeliveryStream',
      new Set([
        'DeliveryStreamName',
        'DeliveryStreamType',
        'S3DestinationConfiguration',
        'ExtendedS3DestinationConfiguration',
        'KinesisStreamSourceConfiguration',
        'Tags',
        'HttpEndpointDestinationConfiguration',
        'RedshiftDestinationConfiguration',
        'ElasticsearchDestinationConfiguration',
        'AmazonopensearchserviceDestinationConfiguration',
        'SplunkDestinationConfiguration',
        'AmazonOpenSearchServerlessDestinationConfiguration',
        'DeliveryStreamEncryptionConfigurationInput',
      ]),
    ],
  ]);

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

      // Map HttpEndpointDestinationConfiguration
      if (properties['HttpEndpointDestinationConfiguration']) {
        const httpConfig = properties['HttpEndpointDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        const endpointConfig = httpConfig['EndpointConfiguration'] as
          | Record<string, unknown>
          | undefined;
        input.HttpEndpointDestinationConfiguration = {
          EndpointConfiguration: endpointConfig
            ? {
                Url: endpointConfig['Url'] as string,
                Name: endpointConfig['Name'] as string | undefined,
                AccessKey: endpointConfig['AccessKey'] as string | undefined,
              }
            : undefined,
          RoleARN: (httpConfig['RoleArn'] || httpConfig['RoleARN']) as string | undefined,
          BufferingHints: httpConfig['BufferingHints'] as
            | HttpEndpointDestinationConfiguration['BufferingHints']
            | undefined,
          CloudWatchLoggingOptions: httpConfig['CloudWatchLoggingOptions'] as
            | HttpEndpointDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          RequestConfiguration: httpConfig['RequestConfiguration'] as
            | HttpEndpointDestinationConfiguration['RequestConfiguration']
            | undefined,
          ProcessingConfiguration: httpConfig['ProcessingConfiguration'] as
            | HttpEndpointDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          RetryOptions: httpConfig['RetryOptions'] as
            | HttpEndpointDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: httpConfig['S3BackupMode'] as string | undefined,
          S3Configuration: httpConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                httpConfig['S3Configuration'] as Record<string, unknown>
              )
            : undefined,
        } as HttpEndpointDestinationConfiguration;
      }

      // Map RedshiftDestinationConfiguration
      if (properties['RedshiftDestinationConfiguration']) {
        const rsConfig = properties['RedshiftDestinationConfiguration'] as Record<string, unknown>;
        input.RedshiftDestinationConfiguration = {
          ClusterJDBCURL: rsConfig['ClusterJDBCURL'] as string,
          RoleARN: (rsConfig['RoleArn'] || rsConfig['RoleARN']) as string,
          CopyCommand: rsConfig['CopyCommand'] as RedshiftDestinationConfiguration['CopyCommand'],
          Username: rsConfig['Username'] as string | undefined,
          Password: rsConfig['Password'] as string | undefined,
          S3Configuration: rsConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                rsConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: rsConfig['CloudWatchLoggingOptions'] as
            | RedshiftDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: rsConfig['ProcessingConfiguration'] as
            | RedshiftDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as RedshiftDestinationConfiguration;
      }

      // Map ElasticsearchDestinationConfiguration
      if (properties['ElasticsearchDestinationConfiguration']) {
        const esConfig = properties['ElasticsearchDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.ElasticsearchDestinationConfiguration = {
          DomainARN: (esConfig['DomainArn'] || esConfig['DomainARN']) as string | undefined,
          ClusterEndpoint: esConfig['ClusterEndpoint'] as string | undefined,
          IndexName: esConfig['IndexName'] as string,
          TypeName: esConfig['TypeName'] as string | undefined,
          IndexRotationPeriod: esConfig['IndexRotationPeriod'] as string | undefined,
          RoleARN: (esConfig['RoleArn'] || esConfig['RoleARN']) as string,
          BufferingHints: esConfig['BufferingHints'] as
            | ElasticsearchDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: esConfig['RetryOptions'] as
            | ElasticsearchDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: esConfig['S3BackupMode'] as string | undefined,
          S3Configuration: esConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                esConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: esConfig['CloudWatchLoggingOptions'] as
            | ElasticsearchDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: esConfig['ProcessingConfiguration'] as
            | ElasticsearchDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as ElasticsearchDestinationConfiguration;
      }

      // Map AmazonopensearchserviceDestinationConfiguration
      if (properties['AmazonopensearchserviceDestinationConfiguration']) {
        const aosConfig = properties['AmazonopensearchserviceDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.AmazonopensearchserviceDestinationConfiguration = {
          DomainARN: (aosConfig['DomainArn'] || aosConfig['DomainARN']) as string | undefined,
          ClusterEndpoint: aosConfig['ClusterEndpoint'] as string | undefined,
          IndexName: aosConfig['IndexName'] as string,
          TypeName: aosConfig['TypeName'] as string | undefined,
          IndexRotationPeriod: aosConfig['IndexRotationPeriod'] as string | undefined,
          RoleARN: (aosConfig['RoleArn'] || aosConfig['RoleARN']) as string,
          BufferingHints: aosConfig['BufferingHints'] as
            | AmazonopensearchserviceDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: aosConfig['RetryOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: aosConfig['S3BackupMode'] as string | undefined,
          S3Configuration: aosConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                aosConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: aosConfig['CloudWatchLoggingOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: aosConfig['ProcessingConfiguration'] as
            | AmazonopensearchserviceDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as AmazonopensearchserviceDestinationConfiguration;
      }

      // Map SplunkDestinationConfiguration
      if (properties['SplunkDestinationConfiguration']) {
        const splunkConfig = properties['SplunkDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.SplunkDestinationConfiguration = {
          HECEndpoint: splunkConfig['HECEndpoint'] as string,
          HECEndpointType: splunkConfig['HECEndpointType'] as string,
          HECToken: splunkConfig['HECToken'] as string,
          HECAcknowledgmentTimeoutInSeconds: splunkConfig['HECAcknowledgmentTimeoutInSeconds'] as
            | number
            | undefined,
          S3BackupMode: splunkConfig['S3BackupMode'] as string | undefined,
          S3Configuration: splunkConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                splunkConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          RetryOptions: splunkConfig['RetryOptions'] as
            | SplunkDestinationConfiguration['RetryOptions']
            | undefined,
          CloudWatchLoggingOptions: splunkConfig['CloudWatchLoggingOptions'] as
            | SplunkDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: splunkConfig['ProcessingConfiguration'] as
            | SplunkDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as SplunkDestinationConfiguration;
      }

      // Map AmazonOpenSearchServerlessDestinationConfiguration
      if (properties['AmazonOpenSearchServerlessDestinationConfiguration']) {
        const aossConfig = properties[
          'AmazonOpenSearchServerlessDestinationConfiguration'
        ] as Record<string, unknown>;
        input.AmazonOpenSearchServerlessDestinationConfiguration = {
          CollectionEndpoint: aossConfig['CollectionEndpoint'] as string,
          IndexName: aossConfig['IndexName'] as string,
          RoleARN: (aossConfig['RoleArn'] || aossConfig['RoleARN']) as string,
          BufferingHints: aossConfig['BufferingHints'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: aossConfig['RetryOptions'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: aossConfig['S3BackupMode'] as string | undefined,
          S3Configuration: aossConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                aossConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: aossConfig['CloudWatchLoggingOptions'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: aossConfig['ProcessingConfiguration'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as AmazonOpenSearchServerlessDestinationConfiguration;
      }

      // Map DeliveryStreamEncryptionConfigurationInput
      if (properties['DeliveryStreamEncryptionConfigurationInput']) {
        const encConfig = properties['DeliveryStreamEncryptionConfigurationInput'] as Record<
          string,
          unknown
        >;
        input.DeliveryStreamEncryptionConfigurationInput = {
          KeyARN: (encConfig['KeyArn'] || encConfig['KeyARN']) as string | undefined,
          KeyType: encConfig['KeyType'] as
            | DeliveryStreamEncryptionConfigurationInput['KeyType']
            | undefined,
        } as DeliveryStreamEncryptionConfigurationInput;
      }

      // Map Tags
      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && tags.length > 0) {
        input.Tags = tags.map((t) => ({ Key: t.Key, Value: t.Value })) as Tag[];
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

      // Wait for delivery stream to become ACTIVE before returning.
      // SubscriptionFilter and other dependents fail if the stream is still CREATING.
      await this.waitForActive(physicalId, logicalId);

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

  /**
   * Wait for a delivery stream to become ACTIVE.
   * Firehose CreateDeliveryStream returns immediately while the stream is still CREATING.
   */
  private async waitForActive(streamName: string, logicalId: string): Promise<void> {
    const { DescribeDeliveryStreamCommand } = await import('@aws-sdk/client-firehose');
    const maxAttempts = 30;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: streamName })
      );
      const status = resp.DeliveryStreamDescription?.DeliveryStreamStatus;
      if (status === 'ACTIVE') {
        this.logger.debug(`Firehose ${logicalId} is ACTIVE`);
        return;
      }
      this.logger.debug(
        `Firehose ${logicalId} status: ${status} (attempt ${attempt}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    this.logger.warn(`Firehose ${logicalId} did not reach ACTIVE after ${maxAttempts} attempts`);
  }
}
