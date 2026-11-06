import { KinesisClient } from '@aws-sdk/client-kinesis';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  getClient,
  getCreateClient,
  wrapCaughtError,
  readStreamArnIfExists,
  readStreamStatusForDelete,
  waitForStreamActive,
  resolveStreamArn,
  getOpenShardCount,
} from './kinesis/client.js';
import { create } from './kinesis/create.js';
import {
  update,
  reconcileDistributionStrategy,
  effectiveMetricsProperties,
  applyTagDiff,
  warnUndeclaredLiveMetrics,
} from './kinesis/update.js';
import { deleteImpl } from './kinesis/delete.js';
import { isSameResource, resourceIdentity } from './kinesis/identity.js';
import {
  canonicalizeDesiredProperties,
  getDriftUnorderedPaths,
  readUnsettled,
  unsettledInTransition,
  readCurrentState,
} from './kinesis/read-state.js';
import { importImpl } from './kinesis/import.js';

/**
 * AWS Kinesis Stream Provider
 *
 * Implements resource provisioning for AWS::Kinesis::Stream using the Kinesis SDK.
 * WHY: The CC API polls with exponential backoff (1s->2s->4s->8s->10s) for stream
 * creation, but we can poll DescribeStream directly with shorter intervals (2s),
 * eliminating the CC API intermediary overhead and reducing total wait time.
 */
export class KinesisStreamProvider implements ResourceProvider {
  client: KinesisClient | undefined;
  createClient: KinesisClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('KinesisProvider');

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
        'DesiredShardLevelMetrics',
        'MaxRecordSizeInKiB',
        // go-to-k/cdkd#2762: on `CreateStream`, and on update through
        // `reconcileDistributionStrategy`.
        'RecordDistributionStrategy',
      ]),
    ],
  ]);

  /**
   * `WarmThroughputMiBps` stays on the Cloud Control route by maintainer
   * decision (go-to-k/cdkd#1695, closed as not planned): AWS refuses it on an
   * account without the minimum throughput billing commitment, so no integ can
   * prove an SDK wiring delivers it.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Kinesis::Stream',
      new Map([
        [
          'WarmThroughputMiBps',
          'AWS accepts it only on an account enrolled in the Kinesis minimum throughput billing commitment, so the SDK path is not wired (go-to-k/cdkd#1695); Cloud Control forwards it.',
        ],
      ]),
    ],
  ]);

  getClient(): KinesisClient {
    return getClient.call(this);
  }

  getCreateClient(): KinesisClient {
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

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    _resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, _resourceType, context);
  }

  resourceIdentity(
    physicalId: string,
    _resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, _resourceType, context);
  }

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  readStreamArnIfExists(streamName: string): Promise<string | undefined> {
    return readStreamArnIfExists.call(this, streamName);
  }

  readStreamStatusForDelete(streamName: string): Promise<string | undefined> {
    return readStreamStatusForDelete.call(this, streamName);
  }

  reconcileDistributionStrategy(
    physicalId: string,
    streamMode: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: MaskerFn,
    warn: (message: string) => void,
    markUnsettled: (key: string) => void
  ): Promise<void> {
    return reconcileDistributionStrategy.call(
      this,
      physicalId,
      streamMode,
      properties,
      previousProperties,
      mask,
      warn,
      markUnsettled
    );
  }

  effectiveMetricsProperties(
    properties: Record<string, unknown>,
    expanded: unknown
  ): { effectiveProperties?: Record<string, unknown> } {
    return effectiveMetricsProperties.call(this, properties, expanded);
  }

  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDesiredProperties.call(this, resourceType, properties);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  applyTagDiff(
    streamName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    unsettled?: {
      forceUpsert: boolean;
      beforeWrite: () => void;
      // go-to-k/cdkd#5498: the tag keys an accepted AddTagsToStream added that
      // the record lacked.
      afterAdded?: (keys: string[]) => void;
    }
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      streamName,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      unsettled
    );
  }

  warnUndeclaredLiveMetrics(
    physicalId: string,
    named: readonly string[],
    warn: (message: string) => void,
    mask: MaskerFn
  ): Promise<void> {
    return warnUndeclaredLiveMetrics.call(this, physicalId, named, warn, mask);
  }

  readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(
      this,
      physicalId,
      logicalId,
      resourceType,
      names,
      recordedProperties,
      desiredProperties,
      attemptedItems
    );
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
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, _properties);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  waitForStreamActive(
    streamName: string,
    maxAttempts?: number
  ): Promise<{ streamArn: string | undefined }> {
    return waitForStreamActive.call(this, streamName, maxAttempts);
  }

  resolveStreamArn(streamName: string): Promise<string> {
    return resolveStreamArn.call(this, streamName);
  }

  getOpenShardCount(streamName: string): Promise<number> {
    return getOpenShardCount.call(this, streamName);
  }
}
