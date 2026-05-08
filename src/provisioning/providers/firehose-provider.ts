import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  ListDeliveryStreamsCommand,
  ListTagsForDeliveryStreamCommand,
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
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
   * Firehose delivery streams are treated as immutable by cdkd. Most
   * destination-config changes require replacement, and AWS's
   * `UpdateDestination` API surface is deep enough that the deploy engine's
   * immutable-property replacement path covers the common cases more
   * reliably. `cdkd drift --revert` therefore surfaces a clear "use
   * --replace or re-deploy" message instead of silently no-op'ing.
   */
  update(
    logicalId: string,
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'Firehose delivery streams are recreated on property changes; re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
      )
    );
  }

  /**
   * Delete a Firehose delivery stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
   * Adopt an existing Kinesis Firehose delivery stream into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.DeliveryStreamName`
   *     → verify with `DescribeDeliveryStream`.
   *  2. Walk `ListDeliveryStreams` (paged via `ExclusiveStartDeliveryStreamName`)
   *     and match the `aws:cdk:path` tag via
   *     `ListTagsForDeliveryStream(DeliveryStreamName)`.
   *
   * Firehose tags use the standard `Tag[]` array shape (`Key`/`Value`).
   */
  /**
   * Read the AWS-current Firehose delivery stream configuration in CFn-property shape.
   *
   * Surfaces top-level configuration that has a clean 1:1 mapping back to
   * cdkd state — `DeliveryStreamName`, `DeliveryStreamType`, and the
   * `KinesisStreamSourceConfiguration` parent fields when present (the
   * `DescribeDeliveryStream` response splits source under `Source.KinesisStreamSourceDescription`).
   *
   * **Destination configurations**: full coverage for S3 / ExtendedS3.
   * AWS returns destination config under `Destinations[0].*DestinationDescription`
   * (note: `Description`, not `Configuration`); the SDK reuses the same
   * type as the corresponding `*Configuration` input for the inner
   * sub-shapes, so reverse-mapping is a `pickDefinedDeep` pass-through.
   *
   * Surfaced top-level fields: `BucketARN`, `RoleARN`, `Prefix`,
   * `ErrorOutputPrefix`, `BufferingHints`, `CompressionFormat`, plus
   * `S3BackupMode` for Extended. Surfaced inner nested fields:
   * `EncryptionConfiguration`, `CloudWatchLoggingOptions` (both shapes);
   * additionally for Extended `ProcessingConfiguration`,
   * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
   * `S3BackupConfiguration` (reverse-mapped from the AWS-side
   * `S3BackupDescription`). Each inner subtree is always emitted (even
   * as `{}` placeholder) so the v3 `observedProperties` baseline catches
   * console-side ADDs to a previously-default sub-shape.
   *
   * Non-S3 destination types
   * (`Redshift`/`Elasticsearch`/`Amazonopensearchservice`/`Splunk`/`HttpEndpoint`/`AmazonOpenSearchServerless`)
   * are reverse-mapped via `mapRedshiftDescriptionToCfn` /
   * `mapHttpEndpointDescriptionToCfn` / `mapNonS3DestinationToCfn`. The
   * SDK reuses field names between Description and Configuration for
   * these destinations, so a `pickDefinedDeep` pass-through produces a
   * CFn-compatible shape. AWS-managed read-only `VpcId` is stripped
   * from `VpcConfigurationDescription`. Write-only fields AWS strips
   * from descriptions (`RedshiftDestinationConfiguration.Password`,
   * `HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey`)
   * stay drift-unknown via `getDriftUnknownPaths`.
   * `DeliveryStreamEncryptionConfigurationInput` is also still
   * drift-unknown (separate `Get*` call needed for the read-side
   * `DeliveryStreamEncryptionConfiguration`).
   *
   * Tags are surfaced via a follow-up `ListTagsForDeliveryStream` call
   * with `aws:*` filtered out and always emitted as `[]` placeholder when
   * no user tags remain.
   *
   * Returns `undefined` when the stream is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let desc;
    try {
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      desc = resp.DeliveryStreamDescription;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    if (!desc) return undefined;

    const result: Record<string, unknown> = {};
    if (desc.DeliveryStreamName !== undefined) {
      result['DeliveryStreamName'] = desc.DeliveryStreamName;
    }
    if (desc.DeliveryStreamType !== undefined) {
      result['DeliveryStreamType'] = desc.DeliveryStreamType;
    }

    // Source: only KinesisStreamSourceDescription has a clean CFn analogue.
    if (desc.Source?.KinesisStreamSourceDescription) {
      const src = desc.Source.KinesisStreamSourceDescription;
      const srcOut: Record<string, unknown> = {};
      if (src.KinesisStreamARN !== undefined) srcOut['KinesisStreamARN'] = src.KinesisStreamARN;
      if (src.RoleARN !== undefined) srcOut['RoleARN'] = src.RoleARN;
      if (Object.keys(srcOut).length > 0) {
        result['KinesisStreamSourceConfiguration'] = srcOut;
      }
    }

    // Destinations: Firehose holds at most one destination on a delivery
    // stream. CDK constructs typically emit ExtendedS3 (the modern shape)
    // even for plain S3 use cases; legacy `S3DestinationDescription` is
    // still surfaced separately for templates that pin the legacy shape.
    // The two shapes are mutually exclusive on AWS responses.
    const dest = desc.Destinations?.[0];
    if (dest?.ExtendedS3DestinationDescription) {
      result['ExtendedS3DestinationConfiguration'] = mapExtendedS3DescriptionToCfn(
        dest.ExtendedS3DestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.S3DestinationDescription) {
      result['S3DestinationConfiguration'] = mapS3DescriptionToCfn(
        dest.S3DestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.RedshiftDestinationDescription) {
      result['RedshiftDestinationConfiguration'] = mapRedshiftDescriptionToCfn(
        dest.RedshiftDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.ElasticsearchDestinationDescription) {
      result['ElasticsearchDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.ElasticsearchDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.AmazonopensearchserviceDestinationDescription) {
      result['AmazonopensearchserviceDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.AmazonopensearchserviceDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.AmazonOpenSearchServerlessDestinationDescription) {
      result['AmazonOpenSearchServerlessDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.AmazonOpenSearchServerlessDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.SplunkDestinationDescription) {
      result['SplunkDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.SplunkDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.HttpEndpointDestinationDescription) {
      result['HttpEndpointDestinationConfiguration'] = mapHttpEndpointDescriptionToCfn(
        dest.HttpEndpointDestinationDescription as unknown as Record<string, unknown>
      );
    }

    // Tags via ListTagsForDeliveryStream.
    // Always emit `Tags` (even as `[]`) per docs/provider-development.md
    // § 3b "always emit user-controllable top-level keys": omitting the
    // key on the failure path means the comparator's state-keys-only
    // walk skips Tags forever, hiding console-side tag adds from drift.
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      this.logger.debug(
        `Firehose ListTagsForDeliveryStream(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      result['Tags'] = [];
    }

    return result;
  }

  /**
   * Drift-unknown paths for `AWS::KinesisFirehose::DeliveryStream`.
   *
   * The drift comparator skips these state property paths so they never
   * fire false-positive drift on every run. See the `readCurrentState`
   * docstring for the full rationale per category.
   *
   * Categories:
   *  - Write-only fields AWS strips from descriptions: Redshift
   *    `Password`, HttpEndpoint `EndpointConfiguration.AccessKey`. State
   *    that carries these fires drift on every run otherwise; declaring
   *    them as drift-unknown is the cleanest fix.
   *  - `DeliveryStreamEncryptionConfigurationInput`: input-only shape
   *    (`KeyARN` + `KeyType`) vs. read-side `DeliveryStreamEncryptionConfiguration`
   *    (extra status / failure fields); not yet round-tripped.
   *
   * S3 / ExtendedS3 inner nested fields and non-S3 destination types
   * (Redshift / Elasticsearch / Amazonopensearchservice / Splunk /
   * HttpEndpoint / AmazonOpenSearchServerless) are now reverse-mapped
   * via `mapS3DescriptionToCfn` / `mapExtendedS3DescriptionToCfn` /
   * `mapNonS3DestinationToCfn` / `mapRedshiftDescriptionToCfn` /
   * `mapHttpEndpointDescriptionToCfn` and no longer drift-unknown at the
   * top level.
   */
  getDriftUnknownPaths(): string[] {
    return [
      // Write-only fields AWS does not return on read.
      'RedshiftDestinationConfiguration.Password',
      'HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey',
      // Encryption input shape (deferred — separate Get* call needed).
      'DeliveryStreamEncryptionConfigurationInput',
    ];
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DeliveryStreamName');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDeliveryStreamCommand({ DeliveryStreamName: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let exclusiveStartDeliveryStreamName: string | undefined;
    // ListDeliveryStreams paginates via `ExclusiveStartDeliveryStreamName`
    // (last name from previous page) when `HasMoreDeliveryStreams` is true.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const list = await this.getClient().send(
        new ListDeliveryStreamsCommand({
          ...(exclusiveStartDeliveryStreamName && {
            ExclusiveStartDeliveryStreamName: exclusiveStartDeliveryStreamName,
          }),
        })
      );
      const names = list.DeliveryStreamNames ?? [];
      for (const name of names) {
        const tagsResp = await this.getClient().send(
          new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: name })
        );
        if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
          return { physicalId: name, attributes: {} };
        }
      }
      if (!list.HasMoreDeliveryStreams || names.length === 0) break;
      exclusiveStartDeliveryStreamName = names[names.length - 1];
    }
    return null;
  }

  /**
   * Wait for a delivery stream to become ACTIVE.
   * Firehose CreateDeliveryStream returns immediately while the stream is still CREATING.
   */
  private async waitForActive(streamName: string, logicalId: string): Promise<void> {
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

// ─── Description → CFn nested-shape helpers ──────────────────────────
//
// The AWS Firehose SDK returns destination configuration under
// `*DestinationDescription` types. For most of the inner sub-shapes
// (`EncryptionConfiguration`, `CloudWatchLoggingOptions`,
// `ProcessingConfiguration`, `DataFormatConversionConfiguration`,
// `DynamicPartitioningConfiguration`) the SDK reuses the same type as
// the corresponding `*Configuration` input — so reverse-mapping is a
// pass-through that strips `undefined` fields. Per docs/provider-development.md
// § 3b "always emit user-controllable top-level keys": even though
// these are nested rather than top-level, surfacing them on every
// readCurrentState call (as `{}` placeholder when AWS reports nothing)
// keeps the v3 observedProperties baseline consistent so console-side
// ADDs to a previously-undefined sub-shape surface as drift.

type Defined<T> = { [K in keyof T]-?: T[K] extends undefined ? never : Exclude<T[K], undefined> };

/**
 * Strip `undefined` fields (and empty resulting objects) from an AWS-SDK
 * Description object so it round-trips cleanly through cdkd's drift
 * comparator. Recursive — descends through nested objects but leaves
 * arrays as-is (positional compare on AWS-returned order is stable for
 * Firehose's response shapes).
 */
function pickDefinedDeep<T>(input: T | undefined): Partial<Defined<T>> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return input as unknown as Partial<Defined<T>>;
  if (Array.isArray(input)) {
    return input.map((v) => pickDefinedDeep(v)) as unknown as Partial<Defined<T>>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cleaned = pickDefinedDeep(v as unknown);
    if (cleaned === undefined) continue;
    if (
      cleaned !== null &&
      typeof cleaned === 'object' &&
      !Array.isArray(cleaned) &&
      Object.keys(cleaned as Record<string, unknown>).length === 0
    ) {
      // Drop empty nested objects to avoid `{}` clutter — except at the
      // top level, the caller decides whether to surface a placeholder.
      continue;
    }
    out[k] = cleaned;
  }
  return out as Partial<Defined<T>>;
}

/**
 * Map S3DestinationDescription → CFn S3DestinationConfiguration.
 * Surfaces the top-level subset that has a clean reverse-mapping plus
 * the inner nested complex fields (EncryptionConfiguration /
 * CloudWatchLoggingOptions) that the SDK reuses across both shapes.
 *
 * Typed as `Record<string, unknown>` to side-step the SDK's strict
 * required/optional discriminator on `RoleARN` / `BucketARN` that
 * `exactOptionalPropertyTypes` rejects when passing a sub-object whose
 * own RoleARN/BucketARN may be undefined (e.g. the deprecated
 * S3BackupDescription form). Behavior unchanged.
 */
function mapS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (desc['BucketARN'] !== undefined) out['BucketARN'] = desc['BucketARN'];
  if (desc['RoleARN'] !== undefined) out['RoleARN'] = desc['RoleARN'];
  if (desc['Prefix'] !== undefined) out['Prefix'] = desc['Prefix'];
  if (desc['ErrorOutputPrefix'] !== undefined) {
    out['ErrorOutputPrefix'] = desc['ErrorOutputPrefix'];
  }
  if (desc['CompressionFormat'] !== undefined) {
    out['CompressionFormat'] = desc['CompressionFormat'];
  }
  if (desc['BufferingHints']) {
    const hints = pickDefinedDeep(desc['BufferingHints']);
    if (hints && typeof hints === 'object' && Object.keys(hints).length > 0) {
      out['BufferingHints'] = hints;
    }
  }
  // EncryptionConfiguration: surface always so a console-side enable on a
  // previously-default destination shows as drift on v3 baseline.
  out['EncryptionConfiguration'] = pickDefinedDeep(desc['EncryptionConfiguration']) ?? {};
  // CloudWatchLoggingOptions: same pattern.
  out['CloudWatchLoggingOptions'] = pickDefinedDeep(desc['CloudWatchLoggingOptions']) ?? {};
  return out;
}

/**
 * Map ExtendedS3DestinationDescription → CFn ExtendedS3DestinationConfiguration.
 * Adds the Extended-only inner fields (`ProcessingConfiguration`,
 * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
 * `S3BackupConfiguration`) on top of the S3 base set.
 *
 * `S3BackupDescription` (note: Description, not Configuration) is
 * delegated to `mapS3DescriptionToCfn` since AWS uses the deprecated
 * S3DestinationDescription shape for backup, but CFn input expects
 * S3DestinationConfiguration — same field names work.
 */
function mapExtendedS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out = mapS3DescriptionToCfn(desc);
  if (desc['S3BackupMode'] !== undefined) out['S3BackupMode'] = desc['S3BackupMode'];
  // Inner nested complex fields. SDK reuses the *Configuration types in
  // *Description responses, so a deep `pickDefinedDeep` produces a CFn-
  // compatible shape.
  out['ProcessingConfiguration'] = pickDefinedDeep(desc['ProcessingConfiguration']) ?? {};
  out['DataFormatConversionConfiguration'] =
    pickDefinedDeep(desc['DataFormatConversionConfiguration']) ?? {};
  out['DynamicPartitioningConfiguration'] =
    pickDefinedDeep(desc['DynamicPartitioningConfiguration']) ?? {};
  // S3BackupConfiguration: AWS returns S3BackupDescription (deprecated
  // shape); reverse-map to the modern Configuration shape via the same
  // top-level helper. Field names align since the deprecated shape and
  // the modern shape share the BucketARN / RoleARN / Prefix / etc.
  // surface, just with the EncryptionConfiguration / CloudWatchLoggingOptions
  // inner placeholders included.
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  } else {
    out['S3BackupConfiguration'] = {};
  }
  return out;
}

/**
 * Map a non-S3 destination description (Elasticsearch /
 * Amazonopensearchservice / AmazonOpenSearchServerless / Splunk) to
 * its CFn `*Configuration` shape.
 *
 * AWS reuses field names between Description and Configuration for
 * these destinations, so a `pickDefinedDeep` pass-through produces a
 * CFn-compatible shape. The exception is `VpcConfigurationDescription`
 * which carries an AWS-managed read-only `VpcId` not present in the
 * CFn `VpcConfiguration` input shape — strip it so the comparator
 * doesn't fire false drift on the read-only field.
 *
 * Always-emit pattern: every nested complex sub-shape AWS reports
 * (BufferingHints / RetryOptions / ProcessingConfiguration /
 * CloudWatchLoggingOptions / VpcConfiguration / DocumentIdOptions /
 * SecretsManagerConfiguration) that the SDK reuses across both shapes
 * is surfaced via `pickDefinedDeep`. Non-templated sub-shapes are
 * dropped to avoid `{}` clutter; the v3 baseline catches console-side
 * ADDs at the top-level destination key, not at every leaf.
 */
function mapNonS3DestinationToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const cleaned = pickDefinedDeep(desc) as Record<string, unknown> | undefined;
  if (!cleaned) return {};
  // AWS returns VpcConfigurationDescription with a read-only VpcId; the
  // CFn VpcConfiguration shape does not include it. Strip if present.
  if (cleaned['VpcConfigurationDescription']) {
    const vpc = { ...(cleaned['VpcConfigurationDescription'] as Record<string, unknown>) };
    delete vpc['VpcId'];
    // Rename to the CFn key (`VpcConfiguration`).
    delete cleaned['VpcConfigurationDescription'];
    if (Object.keys(vpc).length > 0) cleaned['VpcConfiguration'] = vpc;
  }
  return cleaned;
}

/**
 * Map RedshiftDestinationDescription → CFn RedshiftDestinationConfiguration.
 *
 * Redshift carries a nested S3DestinationDescription (deprecated shape)
 * that's required as `S3Configuration` in the CFn input. Reverse-map via
 * the shared `mapS3DescriptionToCfn` helper. `S3BackupDescription` is
 * mapped to `S3BackupConfiguration` the same way.
 *
 * `Password` is write-only — AWS never returns it on read. State that
 * carries `Password` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 */
function mapRedshiftDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'RoleARN',
    'ClusterJDBCURL',
    'CopyCommand',
    'Username',
    'RetryOptions',
    'ProcessingConfiguration',
    'S3BackupMode',
    'CloudWatchLoggingOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  // Required nested S3 destination — reverse-map via the S3 helper.
  if (desc['S3DestinationDescription']) {
    out['S3Configuration'] = mapS3DescriptionToCfn(
      desc['S3DestinationDescription'] as Record<string, unknown>
    );
  }
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  }
  return out;
}

/**
 * Map HttpEndpointDestinationDescription → CFn HttpEndpointDestinationConfiguration.
 *
 * AWS returns `EndpointConfiguration: HttpEndpointDescription` (Url +
 * Name only). The CFn input `HttpEndpointConfiguration` additionally
 * accepts `AccessKey` (write-only — redacted from the Description).
 * State that carries `AccessKey` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 *
 * `RequestConfiguration` and `SecretsManagerConfiguration` are pass-
 * through (SDK reuses the same shapes between Configuration and
 * Description).
 */
function mapHttpEndpointDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'BufferingHints',
    'CloudWatchLoggingOptions',
    'RequestConfiguration',
    'ProcessingConfiguration',
    'RoleARN',
    'RetryOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  if (desc['EndpointConfiguration']) {
    const endpoint = pickDefinedDeep(desc['EndpointConfiguration']);
    if (endpoint !== undefined) out['EndpointConfiguration'] = endpoint;
  }
  return out;
}
