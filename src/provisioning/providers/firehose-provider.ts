import {
  FirehoseClient,
  type DescribeDeliveryStreamCommandOutput,
  type DeliveryStreamDescription,
  type DeliveryStreamEncryptionConfiguration,
  type S3DestinationConfiguration,
  type ExtendedS3DestinationConfiguration,
  type ExtendedS3DestinationUpdate,
  type RedshiftDestinationUpdate,
  type S3DestinationUpdate,
  type SplunkDestinationUpdate,
  type AmazonopensearchserviceDestinationUpdate,
  type AmazonOpenSearchServerlessDestinationUpdate,
  type HttpEndpointDestinationUpdate,
  type ElasticsearchDestinationUpdate,
  type IcebergDestinationConfiguration,
  type IcebergDestinationUpdate,
  type SnowflakeDestinationUpdate,
} from '@aws-sdk/client-firehose';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  wrapCaughtError,
  getClient,
  getCreateClient,
  findDestinationKey,
  waitForActive,
  describeBeforeDeadline,
} from './firehose/core.js';
import { create } from './firehose/create.js';
import {
  update,
  applyUpdate,
  warnUnappliedS3BackupMode,
  withRecordedEncryption,
  applyExtendedS3DestinationUpdate,
  applyS3DestinationUpdate,
  applyTagsDiff,
} from './firehose/update.js';
import {
  applyEncryptionUpdate,
  warnIfUnfinished,
  refuseToStartTransition,
  waitForEncryption,
} from './firehose/encryption.js';
import { deleteImpl, readDeliveryStreamStatusForDelete } from './firehose/delete.js';
import {
  mapS3DestinationConfiguration,
  mapExtendedS3DestinationConfiguration,
  mapExtendedS3ConfigToUpdate,
  mapS3ConfigToUpdate,
} from './firehose/s3-destination.js';
import {
  applyRedshiftDestinationUpdate,
  mapRedshiftConfigToUpdate,
  applySplunkDestinationUpdate,
  mapSplunkConfigToUpdate,
  applyAmazonopensearchserviceDestinationUpdate,
  mapAmazonopensearchserviceConfigToUpdate,
  applyAmazonOpenSearchServerlessDestinationUpdate,
  mapAmazonOpenSearchServerlessConfigToUpdate,
  applyHttpEndpointDestinationUpdate,
  mapHttpEndpointConfigToUpdate,
  applyElasticsearchDestinationUpdate,
  mapElasticsearchConfigToUpdate,
  applyIcebergDestinationUpdate,
  mapIcebergDestinationConfiguration,
  mapIcebergConfigToUpdate,
  applySnowflakeDestinationUpdate,
  mapSnowflakeConfigToUpdate,
} from './firehose/destination-updates.js';
import {
  unsettledInTransition,
  readCurrentState,
  getDriftUnknownPaths,
  importImpl,
} from './firehose/read-state.js';

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
  client: FirehoseClient | undefined;
  createClient: FirehoseClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('FirehoseProvider');

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::KinesisFirehose::DeliveryStream',
      new Set([
        'DeliveryStreamName',
        'DeliveryStreamType',
        'S3DestinationConfiguration',
        'ExtendedS3DestinationConfiguration',
        'KinesisStreamSourceConfiguration',
        'DirectPutSourceConfiguration',
        'Tags',
        'HttpEndpointDestinationConfiguration',
        'RedshiftDestinationConfiguration',
        'ElasticsearchDestinationConfiguration',
        'AmazonopensearchserviceDestinationConfiguration',
        'SplunkDestinationConfiguration',
        'AmazonOpenSearchServerlessDestinationConfiguration',
        'DeliveryStreamEncryptionConfigurationInput',
        'IcebergDestinationConfiguration',
        'MSKSourceConfiguration',
      ]),
    ],
  ]);

  // go-to-k/cdkd#5636: these stay on the Cloud Control route. A by-design row
  // still auto-routes the resource there, so nothing is dropped.
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::KinesisFirehose::DeliveryStream',
      new Map<string, string>([
        [
          'DatabaseSourceConfiguration',
          'Database as a source was a public preview AWS removed on 2025-09-24 (Firehose document history); CreateDeliveryStream refused DeliveryStreamType DatabaseAsSource in every region probed, so an SDK path could not be verified. Stays on Cloud Control',
        ],
        [
          'SnowflakeDestinationConfiguration',
          'Proving the wire shape live needs a real Snowflake account, and the block carries key material (PrivateKey, KeyPassphrase). Stays on Cloud Control',
        ],
      ]),
    ],
  ]);

  getClient(): FirehoseClient {
    return getClient.call(this);
  }

  getCreateClient(): FirehoseClient {
    return getCreateClient.call(this);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    return applyUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  warnUnappliedS3BackupMode(
    logicalId: string,
    properties: Record<string, unknown>,
    destKey: string | undefined,
    live: DeliveryStreamDescription | undefined
  ): void {
    return warnUnappliedS3BackupMode.call(this, logicalId, properties, destKey, live);
  }

  withRecordedEncryption(
    properties: Record<string, unknown>,
    previous: unknown,
    live: DeliveryStreamEncryptionConfiguration | undefined
  ): Record<string, unknown> {
    return withRecordedEncryption.call(this, properties, previous, live);
  }

  applyExtendedS3DestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyExtendedS3DestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  applyS3DestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyS3DestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  applyTagsDiff(physicalId: string, next: unknown, prev: unknown): Promise<void> {
    return applyTagsDiff.call(this, physicalId, next, prev);
  }

  applyEncryptionUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    desired: { kind: 'absent' } | { kind: 'usable'; keyType: string; keyArn?: string },
    mask: MaskerFn,
    markUnsettled: ((propertyName: string) => void) | undefined
  ): Promise<void> {
    return applyEncryptionUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      desired,
      mask,
      markUnsettled
    );
  }

  warnIfUnfinished<T>(
    logicalId: string,
    call: 'StartDeliveryStreamEncryption' | 'StopDeliveryStreamEncryption',
    markUnsettled: ((propertyName: string) => void) | undefined,
    wait: () => Promise<T>
  ): Promise<T> {
    return (warnIfUnfinished<T>).call(this, logicalId, call, markUnsettled, wait);
  }

  refuseToStartTransition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    what: 'enable' | 'disable'
  ): void {
    return refuseToStartTransition.call(this, logicalId, physicalId, resourceType, what);
  }

  waitForEncryption(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    mask: MaskerFn,
    opts: {
      what: 'settle' | 'enable' | 'disable';
      done: (enc: DeliveryStreamEncryptionConfiguration | undefined) => boolean;
      inProgress?: 'ENABLING' | 'DISABLING';
      failed?: 'ENABLING_FAILED' | 'DISABLING_FAILED';
      staleFailure?: boolean;
    }
  ): Promise<DeliveryStreamEncryptionConfiguration | undefined> {
    return waitForEncryption.call(this, logicalId, physicalId, resourceType, mask, opts);
  }

  findDestinationKey(properties: Record<string, unknown>): string | undefined {
    return findDestinationKey.call(this, properties);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  readDeliveryStreamStatusForDelete(streamName: string): Promise<string | undefined> {
    return readDeliveryStreamStatusForDelete.call(this, streamName);
  }

  mapS3DestinationConfiguration(config: Record<string, unknown>): S3DestinationConfiguration {
    return mapS3DestinationConfiguration.call(this, config);
  }

  mapExtendedS3DestinationConfiguration(
    config: Record<string, unknown>
  ): ExtendedS3DestinationConfiguration {
    return mapExtendedS3DestinationConfiguration.call(this, config);
  }

  mapExtendedS3ConfigToUpdate(config: Record<string, unknown>): ExtendedS3DestinationUpdate {
    return mapExtendedS3ConfigToUpdate.call(this, config);
  }

  applyRedshiftDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyRedshiftDestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  mapRedshiftConfigToUpdate(config: Record<string, unknown>): RedshiftDestinationUpdate {
    return mapRedshiftConfigToUpdate.call(this, config);
  }

  applySplunkDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applySplunkDestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  mapSplunkConfigToUpdate(config: Record<string, unknown>): SplunkDestinationUpdate {
    return mapSplunkConfigToUpdate.call(this, config);
  }

  applyAmazonopensearchserviceDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyAmazonopensearchserviceDestinationUpdate.call(
      this,
      logicalId,
      physicalId,
      nextConfig
    );
  }

  mapAmazonopensearchserviceConfigToUpdate(
    config: Record<string, unknown>
  ): AmazonopensearchserviceDestinationUpdate {
    return mapAmazonopensearchserviceConfigToUpdate.call(this, config);
  }

  applyAmazonOpenSearchServerlessDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyAmazonOpenSearchServerlessDestinationUpdate.call(
      this,
      logicalId,
      physicalId,
      nextConfig
    );
  }

  mapAmazonOpenSearchServerlessConfigToUpdate(
    config: Record<string, unknown>
  ): AmazonOpenSearchServerlessDestinationUpdate {
    return mapAmazonOpenSearchServerlessConfigToUpdate.call(this, config);
  }

  applyHttpEndpointDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyHttpEndpointDestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  mapHttpEndpointConfigToUpdate(config: Record<string, unknown>): HttpEndpointDestinationUpdate {
    return mapHttpEndpointConfigToUpdate.call(this, config);
  }

  applyElasticsearchDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyElasticsearchDestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  mapElasticsearchConfigToUpdate(config: Record<string, unknown>): ElasticsearchDestinationUpdate {
    return mapElasticsearchConfigToUpdate.call(this, config);
  }

  applyIcebergDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applyIcebergDestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  mapIcebergDestinationConfiguration(
    config: Record<string, unknown>
  ): IcebergDestinationConfiguration {
    return mapIcebergDestinationConfiguration.call(this, config);
  }

  mapIcebergConfigToUpdate(config: Record<string, unknown>): IcebergDestinationUpdate {
    return mapIcebergConfigToUpdate.call(this, config);
  }

  applySnowflakeDestinationUpdate(
    logicalId: string,
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    return applySnowflakeDestinationUpdate.call(this, logicalId, physicalId, nextConfig);
  }

  mapSnowflakeConfigToUpdate(config: Record<string, unknown>): SnowflakeDestinationUpdate {
    return mapSnowflakeConfigToUpdate.call(this, config);
  }

  mapS3ConfigToUpdate(config: Record<string, unknown>): S3DestinationUpdate {
    return mapS3ConfigToUpdate.call(this, config);
  }

  unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    return unsettledInTransition.call(this, physicalId, _logicalId, _resourceType, names);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType, properties);
  }

  getDriftUnknownPaths(): string[] {
    return getDriftUnknownPaths.call(this);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  waitForActive(
    streamName: string,
    logicalId: string,
    resourceType: string,
    mask: MaskerFn
  ): Promise<void> {
    return waitForActive.call(this, streamName, logicalId, resourceType, mask);
  }

  describeBeforeDeadline(
    streamName: string
  ): Promise<DescribeDeliveryStreamCommandOutput | 'deadline'> {
    return describeBeforeDeadline.call(this, streamName);
  }
}
