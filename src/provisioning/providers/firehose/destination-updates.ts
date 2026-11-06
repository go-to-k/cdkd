import type { FirehoseProvider } from '../firehose-provider.js';
import {
  DescribeDeliveryStreamCommand,
  UpdateDestinationCommand,
  type RedshiftDestinationUpdate,
  type SplunkDestinationUpdate,
  type AmazonopensearchserviceDestinationUpdate,
  type AmazonOpenSearchServerlessDestinationUpdate,
  type HttpEndpointDestinationUpdate,
  type ElasticsearchDestinationUpdate,
  type IcebergDestinationConfiguration,
  type IcebergDestinationUpdate,
  type SnowflakeDestinationUpdate,
} from '@aws-sdk/client-firehose';
import { ProvisioningError } from '../../../utils/error-handler.js';

/**
 * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
 * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
 * Redshift shape. The reverse-mapper at
 * {@link mapRedshiftConfigToUpdate} produces the
 * `RedshiftDestinationUpdate` payload — only fields present in the
 * input are forwarded so omitted CFn keys don't clobber AWS-side
 * state. Mirrors {@link applyExtendedS3DestinationUpdate} (#549).
 */
export async function applyRedshiftDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const currentDestination = desc?.Destinations?.[0];
  const destinationId = currentDestination?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      RedshiftDestinationUpdate: this.mapRedshiftConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `RedshiftDestinationConfiguration` to the
 * `RedshiftDestinationUpdate` shape used by AWS
 * `UpdateDestinationCommand` (#549). Every field is `!== undefined`
 * gated so omitted CFn keys do not clobber AWS-side state. The CFn
 * `S3Configuration` field is mapped through
 * {@link mapS3ConfigToUpdate} into the SDK-side `S3Update` slot;
 * `S3BackupConfiguration` likewise into `S3BackupUpdate`.
 */
export function mapRedshiftConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): RedshiftDestinationUpdate {
  const result: RedshiftDestinationUpdate = {};
  const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  const clusterJdbcUrl = (config['ClusterJDBCURL'] ?? config['ClusterJdbcUrl']) as
    | string
    | undefined;
  if (clusterJdbcUrl !== undefined) result.ClusterJDBCURL = clusterJdbcUrl;
  if (config['CopyCommand'] !== undefined) {
    result.CopyCommand = config['CopyCommand'] as RedshiftDestinationUpdate['CopyCommand'];
  }
  if (config['Username'] !== undefined) result.Username = config['Username'] as string;
  if (config['Password'] !== undefined) result.Password = config['Password'] as string;
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config['RetryOptions'] as RedshiftDestinationUpdate['RetryOptions'];
  }
  // CFn property is `S3Configuration`; SDK Update shape uses `S3Update`.
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as RedshiftDestinationUpdate['ProcessingConfiguration'];
  }
  if (config['S3BackupMode'] !== undefined) {
    result.S3BackupMode = config['S3BackupMode'] as RedshiftDestinationUpdate['S3BackupMode'];
  }
  // CFn property is `S3BackupConfiguration`; SDK Update shape uses
  // `S3BackupUpdate`. Mirrors the ExtendedS3 pattern.
  if (config['S3BackupConfiguration'] !== undefined) {
    result.S3BackupUpdate = this.mapS3ConfigToUpdate(
      config['S3BackupConfiguration'] as Record<string, unknown>
    );
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as RedshiftDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['SecretsManagerConfiguration'] !== undefined) {
    result.SecretsManagerConfiguration = config[
      'SecretsManagerConfiguration'
    ] as RedshiftDestinationUpdate['SecretsManagerConfiguration'];
  }
  return result;
}

/**
 * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
 * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
 * Splunk shape. The reverse-mapper at
 * {@link mapSplunkConfigToUpdate} produces the
 * `SplunkDestinationUpdate` payload — only fields present in the
 * input are forwarded so omitted CFn keys don't clobber AWS-side
 * state. Mirrors {@link applyRedshiftDestinationUpdate} (#549).
 */
export async function applySplunkDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const currentDestination = desc?.Destinations?.[0];
  const destinationId = currentDestination?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      SplunkDestinationUpdate: this.mapSplunkConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `SplunkDestinationConfiguration` to the
 * `SplunkDestinationUpdate` shape used by AWS
 * `UpdateDestinationCommand` (#549). Every field is `!== undefined`
 * gated so omitted CFn keys do not clobber AWS-side state. The CFn
 * `S3Configuration` field is mapped through
 * {@link mapS3ConfigToUpdate} into the SDK-side `S3Update` slot.
 * Splunk has no `S3BackupConfiguration` field (unlike Redshift /
 * ExtendedS3).
 */
export function mapSplunkConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): SplunkDestinationUpdate {
  const result: SplunkDestinationUpdate = {};
  if (config['HECEndpoint'] !== undefined) {
    result.HECEndpoint = config['HECEndpoint'] as string;
  }
  if (config['HECEndpointType'] !== undefined) {
    result.HECEndpointType = config[
      'HECEndpointType'
    ] as SplunkDestinationUpdate['HECEndpointType'];
  }
  if (config['HECToken'] !== undefined) {
    result.HECToken = config['HECToken'] as string;
  }
  if (config['HECAcknowledgmentTimeoutInSeconds'] !== undefined) {
    result.HECAcknowledgmentTimeoutInSeconds = config[
      'HECAcknowledgmentTimeoutInSeconds'
    ] as number;
  }
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config['RetryOptions'] as SplunkDestinationUpdate['RetryOptions'];
  }
  if (config['S3BackupMode'] !== undefined) {
    result.S3BackupMode = config['S3BackupMode'] as SplunkDestinationUpdate['S3BackupMode'];
  }
  // CFn property is `S3Configuration`; SDK Update shape uses `S3Update`.
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as SplunkDestinationUpdate['ProcessingConfiguration'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as SplunkDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config['BufferingHints'] as SplunkDestinationUpdate['BufferingHints'];
  }
  if (config['SecretsManagerConfiguration'] !== undefined) {
    result.SecretsManagerConfiguration = config[
      'SecretsManagerConfiguration'
    ] as SplunkDestinationUpdate['SecretsManagerConfiguration'];
  }
  return result;
}

/**
 * Apply UpdateDestination for `AmazonopensearchserviceDestinationConfiguration` (#549).
 * Mirrors {@link applyRedshiftDestinationUpdate}.
 */
export async function applyAmazonopensearchserviceDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      AmazonopensearchserviceDestinationUpdate:
        this.mapAmazonopensearchserviceConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `AmazonopensearchserviceDestinationConfiguration` to the
 * `AmazonopensearchserviceDestinationUpdate` shape (#549). Every field
 * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
 * `VpcConfiguration` is intentionally NOT included — the SDK Update
 * shape has no field for it (AWS treats Vpc placement as immutable
 * post-create), and the CloudFormation schema lists it as create-only,
 * so a change there plans a replacement. `S3BackupMode` has no field
 * either and is not create-only: see {@link warnUnappliedS3BackupMode}.
 */
export function mapAmazonopensearchserviceConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): AmazonopensearchserviceDestinationUpdate {
  const result: AmazonopensearchserviceDestinationUpdate = {};
  const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  const domainArn = (config['DomainARN'] ?? config['DomainArn']) as string | undefined;
  if (domainArn !== undefined) result.DomainARN = domainArn;
  if (config['ClusterEndpoint'] !== undefined) {
    result.ClusterEndpoint = config['ClusterEndpoint'] as string;
  }
  if (config['IndexName'] !== undefined) result.IndexName = config['IndexName'] as string;
  if (config['TypeName'] !== undefined) result.TypeName = config['TypeName'] as string;
  if (config['IndexRotationPeriod'] !== undefined) {
    result.IndexRotationPeriod = config[
      'IndexRotationPeriod'
    ] as AmazonopensearchserviceDestinationUpdate['IndexRotationPeriod'];
  }
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config[
      'BufferingHints'
    ] as AmazonopensearchserviceDestinationUpdate['BufferingHints'];
  }
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config[
      'RetryOptions'
    ] as AmazonopensearchserviceDestinationUpdate['RetryOptions'];
  }
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as AmazonopensearchserviceDestinationUpdate['ProcessingConfiguration'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as AmazonopensearchserviceDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['DocumentIdOptions'] !== undefined) {
    result.DocumentIdOptions = config[
      'DocumentIdOptions'
    ] as AmazonopensearchserviceDestinationUpdate['DocumentIdOptions'];
  }
  return result;
}

/**
 * Apply UpdateDestination for `AmazonOpenSearchServerlessDestinationConfiguration` (#549).
 * Mirrors {@link applyRedshiftDestinationUpdate}.
 */
export async function applyAmazonOpenSearchServerlessDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      AmazonOpenSearchServerlessDestinationUpdate:
        this.mapAmazonOpenSearchServerlessConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `AmazonOpenSearchServerlessDestinationConfiguration` to the
 * `AmazonOpenSearchServerlessDestinationUpdate` shape (#549). Every
 * field `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
 * Simpler than the service variant — no VpcConfiguration / TypeName /
 * IndexRotationPeriod / DocumentIdOptions.
 */
export function mapAmazonOpenSearchServerlessConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): AmazonOpenSearchServerlessDestinationUpdate {
  const result: AmazonOpenSearchServerlessDestinationUpdate = {};
  const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  if (config['CollectionEndpoint'] !== undefined) {
    result.CollectionEndpoint = config['CollectionEndpoint'] as string;
  }
  if (config['IndexName'] !== undefined) result.IndexName = config['IndexName'] as string;
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config[
      'BufferingHints'
    ] as AmazonOpenSearchServerlessDestinationUpdate['BufferingHints'];
  }
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config[
      'RetryOptions'
    ] as AmazonOpenSearchServerlessDestinationUpdate['RetryOptions'];
  }
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as AmazonOpenSearchServerlessDestinationUpdate['ProcessingConfiguration'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as AmazonOpenSearchServerlessDestinationUpdate['CloudWatchLoggingOptions'];
  }
  return result;
}

/**
 * Apply UpdateDestination for `HttpEndpointDestinationConfiguration` (#549).
 * Mirrors {@link applyRedshiftDestinationUpdate}.
 */
export async function applyHttpEndpointDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      HttpEndpointDestinationUpdate: this.mapHttpEndpointConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `HttpEndpointDestinationConfiguration` to the
 * `HttpEndpointDestinationUpdate` shape (#549). Every field
 * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
 * `EndpointConfiguration` (Url / Name / AccessKey) and
 * `SecretsManagerConfiguration` are both pass-through (AWS accepts
 * either auth mode on Update).
 */
export function mapHttpEndpointConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): HttpEndpointDestinationUpdate {
  const result: HttpEndpointDestinationUpdate = {};
  if (config['EndpointConfiguration'] !== undefined) {
    result.EndpointConfiguration = config[
      'EndpointConfiguration'
    ] as HttpEndpointDestinationUpdate['EndpointConfiguration'];
  }
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config[
      'BufferingHints'
    ] as HttpEndpointDestinationUpdate['BufferingHints'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as HttpEndpointDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['RequestConfiguration'] !== undefined) {
    result.RequestConfiguration = config[
      'RequestConfiguration'
    ] as HttpEndpointDestinationUpdate['RequestConfiguration'];
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as HttpEndpointDestinationUpdate['ProcessingConfiguration'];
  }
  const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config['RetryOptions'] as HttpEndpointDestinationUpdate['RetryOptions'];
  }
  if (config['S3BackupMode'] !== undefined) {
    result.S3BackupMode = config['S3BackupMode'] as HttpEndpointDestinationUpdate['S3BackupMode'];
  }
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['SecretsManagerConfiguration'] !== undefined) {
    result.SecretsManagerConfiguration = config[
      'SecretsManagerConfiguration'
    ] as HttpEndpointDestinationUpdate['SecretsManagerConfiguration'];
  }
  return result;
}

/**
 * Apply UpdateDestination for `ElasticsearchDestinationConfiguration` (#549).
 * Mirrors {@link applyRedshiftDestinationUpdate}. Elasticsearch is the
 * legacy variant — AWS still accepts it for stacks that pre-date the
 * Amazonopensearchservice rename.
 */
export async function applyElasticsearchDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      ElasticsearchDestinationUpdate: this.mapElasticsearchConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `ElasticsearchDestinationConfiguration` to the
 * `ElasticsearchDestinationUpdate` shape (#549). Every field
 * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
 * Field set mirrors {@link mapAmazonopensearchserviceConfigToUpdate}
 * — Elasticsearch is the legacy variant of the same destination.
 */
export function mapElasticsearchConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): ElasticsearchDestinationUpdate {
  const result: ElasticsearchDestinationUpdate = {};
  const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  const domainArn = (config['DomainARN'] ?? config['DomainArn']) as string | undefined;
  if (domainArn !== undefined) result.DomainARN = domainArn;
  if (config['ClusterEndpoint'] !== undefined) {
    result.ClusterEndpoint = config['ClusterEndpoint'] as string;
  }
  if (config['IndexName'] !== undefined) result.IndexName = config['IndexName'] as string;
  if (config['TypeName'] !== undefined) result.TypeName = config['TypeName'] as string;
  if (config['IndexRotationPeriod'] !== undefined) {
    result.IndexRotationPeriod = config[
      'IndexRotationPeriod'
    ] as ElasticsearchDestinationUpdate['IndexRotationPeriod'];
  }
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config[
      'BufferingHints'
    ] as ElasticsearchDestinationUpdate['BufferingHints'];
  }
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config['RetryOptions'] as ElasticsearchDestinationUpdate['RetryOptions'];
  }
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as ElasticsearchDestinationUpdate['ProcessingConfiguration'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as ElasticsearchDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['DocumentIdOptions'] !== undefined) {
    result.DocumentIdOptions = config[
      'DocumentIdOptions'
    ] as ElasticsearchDestinationUpdate['DocumentIdOptions'];
  }
  return result;
}

/**
 * Apply UpdateDestination for `IcebergDestinationConfiguration` (#549).
 * Mirrors {@link applyRedshiftDestinationUpdate}.
 */
export async function applyIcebergDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      IcebergDestinationUpdate: this.mapIcebergConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `IcebergDestinationConfiguration` to the SDK create shape
 * (go-to-k/cdkd#5636): the members {@link mapIcebergConfigToUpdate} sends,
 * plus `CatalogConfiguration`. CloudFormation spells the catalog ARN
 * `CatalogArn`; the SDK member is `CatalogARN`, so the block is rebuilt,
 * not forwarded.
 */
export function mapIcebergDestinationConfiguration(
  this: FirehoseProvider,
  config: Record<string, unknown>
): IcebergDestinationConfiguration {
  const result = this.mapIcebergConfigToUpdate(config) as IcebergDestinationConfiguration;
  const catalog = config['CatalogConfiguration'] as Record<string, unknown> | undefined;
  if (catalog !== undefined) {
    result.CatalogConfiguration = {
      ...(catalog['CatalogArn'] !== undefined && { CatalogARN: catalog['CatalogArn'] as string }),
      ...(catalog['WarehouseLocation'] !== undefined && {
        WarehouseLocation: catalog['WarehouseLocation'] as string,
      }),
    };
  }
  return result;
}

/**
 * Map CFn `IcebergDestinationConfiguration` to the
 * `IcebergDestinationUpdate` shape (#549). Every field
 * `!== undefined` gated. **Quirk vs every other destination**: the
 * SDK Update shape's S3 field is `S3Configuration` (a full
 * `S3DestinationConfiguration`), NOT `S3Update`. Iceberg is a newer
 * destination type and AWS chose to keep the field name aligned with
 * the create shape; this reverse-mapper forwards it verbatim.
 *
 * CloudFormation spells the backup mode `s3BackupMode` here, unlike every
 * other destination; the SDK member is `S3BackupMode`. `CatalogConfiguration`
 * is never sent: it is create-only in the CloudFormation schema, so a
 * change plans a replacement, and `UpdateDestination` keeps what it omits
 * (go-to-k/cdkd#5636).
 */
export function mapIcebergConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): IcebergDestinationUpdate {
  const result: IcebergDestinationUpdate = {};
  if (config['DestinationTableConfigurationList'] !== undefined) {
    result.DestinationTableConfigurationList = config[
      'DestinationTableConfigurationList'
    ] as IcebergDestinationUpdate['DestinationTableConfigurationList'];
  }
  if (config['SchemaEvolutionConfiguration'] !== undefined) {
    result.SchemaEvolutionConfiguration = config[
      'SchemaEvolutionConfiguration'
    ] as IcebergDestinationUpdate['SchemaEvolutionConfiguration'];
  }
  if (config['TableCreationConfiguration'] !== undefined) {
    result.TableCreationConfiguration = config[
      'TableCreationConfiguration'
    ] as IcebergDestinationUpdate['TableCreationConfiguration'];
  }
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config['BufferingHints'] as IcebergDestinationUpdate['BufferingHints'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as IcebergDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as IcebergDestinationUpdate['ProcessingConfiguration'];
  }
  if (config['s3BackupMode'] !== undefined) {
    result.S3BackupMode = config['s3BackupMode'] as IcebergDestinationUpdate['S3BackupMode'];
  }
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config['RetryOptions'] as IcebergDestinationUpdate['RetryOptions'];
  }
  const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  if (config['AppendOnly'] !== undefined) {
    result.AppendOnly = config['AppendOnly'] as boolean;
  }
  // Iceberg's S3 field is named `S3Configuration` on the Update shape
  // (a full S3DestinationConfiguration), unlike the other destinations
  // which use the partial `S3Update` shape. Route through the shared
  // `mapS3DestinationConfiguration` helper so `BucketArn` / `RoleArn`
  // (the CDK-emitted lowercase aliases) get renamed to `BucketARN` /
  // `RoleARN` — verbatim forwarding would send the lowercase keys to
  // AWS, which rejects them on the Update API.
  if (config['S3Configuration'] !== undefined) {
    result.S3Configuration = this.mapS3DestinationConfiguration(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  return result;
}

/**
 * Apply UpdateDestination for `SnowflakeDestinationConfiguration` (#549).
 * Mirrors {@link applyRedshiftDestinationUpdate}.
 */
export async function applySnowflakeDestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      SnowflakeDestinationUpdate: this.mapSnowflakeConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Map CFn `SnowflakeDestinationConfiguration` to the
 * `SnowflakeDestinationUpdate` shape (#549). Every field
 * `!== undefined` gated. CFn `S3Configuration` → SDK `S3Update`.
 * Snowflake carries many connector-side credential / target-table
 * fields (`AccountUrl` / `PrivateKey` / `KeyPassphrase` / `User` /
 * `Database` / `Schema` / `Table`) all pass-through.
 */
export function mapSnowflakeConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): SnowflakeDestinationUpdate {
  const result: SnowflakeDestinationUpdate = {};
  if (config['AccountUrl'] !== undefined) result.AccountUrl = config['AccountUrl'] as string;
  if (config['PrivateKey'] !== undefined) result.PrivateKey = config['PrivateKey'] as string;
  if (config['KeyPassphrase'] !== undefined) {
    result.KeyPassphrase = config['KeyPassphrase'] as string;
  }
  if (config['User'] !== undefined) result.User = config['User'] as string;
  if (config['Database'] !== undefined) result.Database = config['Database'] as string;
  if (config['Schema'] !== undefined) result.Schema = config['Schema'] as string;
  if (config['Table'] !== undefined) result.Table = config['Table'] as string;
  if (config['SnowflakeRoleConfiguration'] !== undefined) {
    result.SnowflakeRoleConfiguration = config[
      'SnowflakeRoleConfiguration'
    ] as SnowflakeDestinationUpdate['SnowflakeRoleConfiguration'];
  }
  if (config['DataLoadingOption'] !== undefined) {
    result.DataLoadingOption = config[
      'DataLoadingOption'
    ] as SnowflakeDestinationUpdate['DataLoadingOption'];
  }
  if (config['MetaDataColumnName'] !== undefined) {
    result.MetaDataColumnName = config['MetaDataColumnName'] as string;
  }
  if (config['ContentColumnName'] !== undefined) {
    result.ContentColumnName = config['ContentColumnName'] as string;
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as SnowflakeDestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as SnowflakeDestinationUpdate['ProcessingConfiguration'];
  }
  const roleArn = (config['RoleARN'] ?? config['RoleArn']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  if (config['RetryOptions'] !== undefined) {
    result.RetryOptions = config['RetryOptions'] as SnowflakeDestinationUpdate['RetryOptions'];
  }
  if (config['S3BackupMode'] !== undefined) {
    result.S3BackupMode = config['S3BackupMode'] as SnowflakeDestinationUpdate['S3BackupMode'];
  }
  if (config['S3Configuration'] !== undefined) {
    result.S3Update = this.mapS3ConfigToUpdate(
      config['S3Configuration'] as Record<string, unknown>
    );
  }
  if (config['SecretsManagerConfiguration'] !== undefined) {
    result.SecretsManagerConfiguration = config[
      'SecretsManagerConfiguration'
    ] as SnowflakeDestinationUpdate['SecretsManagerConfiguration'];
  }
  if (config['BufferingHints'] !== undefined) {
    result.BufferingHints = config[
      'BufferingHints'
    ] as SnowflakeDestinationUpdate['BufferingHints'];
  }
  return result;
}
