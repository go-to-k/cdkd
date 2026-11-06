import type { FirehoseProvider } from '../firehose-provider.js';
import {
  CreateDeliveryStreamCommand,
  type CreateDeliveryStreamCommandInput,
  type S3DestinationConfiguration,
  type Tag,
  type HttpEndpointDestinationConfiguration,
  type RedshiftDestinationConfiguration,
  type ElasticsearchDestinationConfiguration,
  type AmazonopensearchserviceDestinationConfiguration,
  type SplunkDestinationConfiguration,
  type AmazonOpenSearchServerlessDestinationConfiguration,
  type DeliveryStreamEncryptionConfigurationInput,
} from '@aws-sdk/client-firehose';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { isReadableTagList } from './shared.js';
import { mapMskSourceConfiguration } from './describe-to-cfn.js';

/**
 * Create a Firehose delivery stream
 */
export async function create(
  this: FirehoseProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Firehose delivery stream ${logicalId}`);

  const deliveryStreamName = properties['DeliveryStreamName'] as string | undefined;
  const deliveryStreamType =
    (properties['DeliveryStreamType'] as string | undefined) || 'DirectPut';

  // The same Tags read the update path uses: a malformed list would reach
  // `tags.map` below (go-to-k/cdkd#3948).
  if (!isReadableTagList(properties['Tags'])) {
    throw markNonRetryable(
      new ProvisioningError(
        `Tags of Firehose delivery stream ${logicalId} is not a list of tags with a Key — the ` +
          `delivery stream was not created`,
        resourceType,
        logicalId
      )
    );
  }

  // go-to-k/cdkd#5636: a ReadFromTimestamp CloudFormation refuses (anything
  // but epoch milliseconds) is refused here, before any AWS call.
  const mskSource =
    properties['MSKSourceConfiguration'] === undefined
      ? undefined
      : mapMskSourceConfiguration(
          properties['MSKSourceConfiguration'] as Record<string, unknown>,
          maskerOrIdentity(context?.maskSecrets),
          resourceType,
          logicalId
        );

  // go-to-k/cdkd#4583: the stream's name once CreateDeliveryStream returned
  // (no self-cleanup), so a later failure can name it for rollback.
  let createdStreamName: string | undefined;
  try {
    const input: CreateDeliveryStreamCommandInput = {
      // go-to-k/cdkd#5095: a stack with an instance id generates the name;
      // a legacy stack keeps the bare logical id.
      DeliveryStreamName:
        deliveryStreamName || generatedNameFor('AWS::KinesisFirehose::DeliveryStream', logicalId),
      DeliveryStreamType:
        deliveryStreamType as CreateDeliveryStreamCommandInput['DeliveryStreamType'],
    };

    // go-to-k/cdkd#5636: create-only in the CloudFormation schema, so a
    // change plans a replacement and update() never sends it.
    if (mskSource !== undefined) input.MSKSourceConfiguration = mskSource;

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

    // go-to-k/cdkd#2762: create-only in the CloudFormation schema, so a
    // change plans a replacement and update() never sends it.
    if (properties['DirectPutSourceConfiguration'] !== undefined) {
      const directPut = properties['DirectPutSourceConfiguration'] as Record<string, unknown>;
      input.DirectPutSourceConfiguration = {
        ThroughputHintInMBs: directPut['ThroughputHintInMBs'] as number,
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
        SecretsManagerConfiguration: httpConfig['SecretsManagerConfiguration'] as
          | HttpEndpointDestinationConfiguration['SecretsManagerConfiguration']
          | undefined,
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
        RetryOptions: rsConfig['RetryOptions'] as
          | RedshiftDestinationConfiguration['RetryOptions']
          | undefined,
        S3BackupMode: rsConfig['S3BackupMode'] as string | undefined,
        S3BackupConfiguration: rsConfig['S3BackupConfiguration']
          ? this.mapS3DestinationConfiguration(
              rsConfig['S3BackupConfiguration'] as Record<string, unknown>
            )
          : undefined,
        SecretsManagerConfiguration: rsConfig['SecretsManagerConfiguration'] as
          | RedshiftDestinationConfiguration['SecretsManagerConfiguration']
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
        VpcConfiguration: esConfig['VpcConfiguration'] as
          | ElasticsearchDestinationConfiguration['VpcConfiguration']
          | undefined,
        DocumentIdOptions: esConfig['DocumentIdOptions'] as
          | ElasticsearchDestinationConfiguration['DocumentIdOptions']
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
        VpcConfiguration: aosConfig['VpcConfiguration'] as
          | AmazonopensearchserviceDestinationConfiguration['VpcConfiguration']
          | undefined,
        DocumentIdOptions: aosConfig['DocumentIdOptions'] as
          | AmazonopensearchserviceDestinationConfiguration['DocumentIdOptions']
          | undefined,
      } as AmazonopensearchserviceDestinationConfiguration;
    }

    // Map SplunkDestinationConfiguration
    if (properties['SplunkDestinationConfiguration']) {
      const splunkConfig = properties['SplunkDestinationConfiguration'] as Record<string, unknown>;
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
        BufferingHints: splunkConfig['BufferingHints'] as
          | SplunkDestinationConfiguration['BufferingHints']
          | undefined,
        SecretsManagerConfiguration: splunkConfig['SecretsManagerConfiguration'] as
          | SplunkDestinationConfiguration['SecretsManagerConfiguration']
          | undefined,
      } as SplunkDestinationConfiguration;
    }

    // Map AmazonOpenSearchServerlessDestinationConfiguration
    if (properties['AmazonOpenSearchServerlessDestinationConfiguration']) {
      const aossConfig = properties['AmazonOpenSearchServerlessDestinationConfiguration'] as Record<
        string,
        unknown
      >;
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
        VpcConfiguration: aossConfig['VpcConfiguration'] as
          | AmazonOpenSearchServerlessDestinationConfiguration['VpcConfiguration']
          | undefined,
      } as AmazonOpenSearchServerlessDestinationConfiguration;
    }

    // go-to-k/cdkd#5636
    if (properties['IcebergDestinationConfiguration']) {
      input.IcebergDestinationConfiguration = this.mapIcebergDestinationConfiguration(
        properties['IcebergDestinationConfiguration'] as Record<string, unknown>
      );
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

    const response = await this.getCreateClient().send(new CreateDeliveryStreamCommand(input));

    const physicalId =
      deliveryStreamName ||
      input.DeliveryStreamName ||
      response.DeliveryStreamARN?.split('/').pop() ||
      '';
    createdStreamName = physicalId;
    reportCreatedResource(logicalId, resourceType, physicalId); // go-to-k/cdkd#5511
    const arn = response.DeliveryStreamARN;

    this.logger.debug(`Successfully created Firehose delivery stream ${logicalId}: ${physicalId}`);

    // Wait for delivery stream to become ACTIVE before returning.
    // SubscriptionFilter and other dependents fail if the stream is still CREATING.
    await this.waitForActive(
      physicalId,
      logicalId,
      resourceType,
      maskerOrIdentity(context?.maskSecrets)
    );

    return {
      physicalId,
      attributes: {
        Arn: arn,
      },
    };
  } catch (error) {
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            maskerOrIdentity(context?.maskSecrets),
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create Firehose delivery stream ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#4583: the stream exists and no state record will hold it;
    // never before CreateDeliveryStream returned (another owner's name).
    if (createdStreamName !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdStreamName);
    }
    throw thrown;
  }
}
