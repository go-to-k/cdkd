import { CloudFrontClient, type Tag } from '@aws-sdk/client-cloudfront';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  SecretMasker,
  ResourceNotFound,
} from '../../types/resource.js';
import type { CfnTagEntry } from '../tag-list.js';
import {
  wrapCaughtError,
  create,
  orphanSearchHint,
  update,
} from './cloudfront-distribution/core.js';
import {
  deleteImpl,
  settleDistribution,
  waitForDistributionStable,
} from './cloudfront-distribution/delete.js';
import {
  readCurrentState,
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  getAttribute,
  importImpl,
} from './cloudfront-distribution/read-state.js';
import {
  mergeUpdateConfig,
  completeRequiredUpdateFields,
} from './cloudfront-distribution/update-config.js';
import {
  convertToSdkFormat,
  convertToCfnFormat,
  unwrapQuantity,
  revertCacheBehavior,
  revertOrigin,
  unwrapQuantityAtPath,
  wrapWithQuantity,
  convertCacheBehavior,
  convertOrigin,
  applyQuantityAtPath,
} from './cloudfront-distribution/convert.js';
import { toSdkTags, computeTagDiff, applyTagDiff } from './cloudfront-distribution/tags.js';

/**
 * SDK Provider for AWS::CloudFront::Distribution
 *
 * Uses the CloudFront SDK directly for reliable CRUD operations.
 * CloudFront Distribution has a complex nested DistributionConfig structure
 * requiring Quantity + Items pattern conversions for SDK compatibility.
 */
export class CloudFrontDistributionProvider implements ResourceProvider {
  cloudFrontClient: CloudFrontClient;
  logger: ConsoleLogger = getLogger().child('CloudFrontDistributionProvider');

  wrapCaughtError(
    mask: SecretMasker | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFront::Distribution', new Set(['DistributionConfig', 'Tags'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.cloudFrontClient = awsClients.cloudFront;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  orphanSearchHint(properties: Record<string, unknown>, maskSecrets: SecretMasker): string {
    return orphanSearchHint.call(this, properties, maskSecrets);
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

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, _properties);
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  settleDistribution(logicalId: string, distributionId: string): Promise<void> {
    return settleDistribution.call(this, logicalId, distributionId);
  }

  waitForDistributionStable(distributionId: string, expectedEnabled?: boolean): Promise<boolean> {
    return waitForDistributionStable.call(this, distributionId, expectedEnabled);
  }

  mergeUpdateConfig(
    currentConfig: Record<string, unknown>,
    newDistributionConfig: Record<string, unknown>,
    previousDistributionConfig: Record<string, unknown>,
    logicalId: string
  ): Record<string, unknown> {
    return mergeUpdateConfig.call(
      this,
      currentConfig,
      newDistributionConfig,
      previousDistributionConfig,
      logicalId
    );
  }

  completeRequiredUpdateFields(config: Record<string, unknown>): void {
    return completeRequiredUpdateFields.call(this, config);
  }

  convertToSdkFormat(config: Record<string, unknown>): Record<string, unknown> {
    return convertToSdkFormat.call(this, config);
  }

  convertToCfnFormat(config: Record<string, unknown>): Record<string, unknown> {
    return convertToCfnFormat.call(this, config);
  }

  unwrapQuantity(value: unknown): unknown {
    return unwrapQuantity.call(this, value);
  }

  revertCacheBehavior(behavior: Record<string, unknown>): Record<string, unknown> {
    return revertCacheBehavior.call(this, behavior);
  }

  revertOrigin(origin: Record<string, unknown>): Record<string, unknown> {
    return revertOrigin.call(this, origin);
  }

  unwrapQuantityAtPath(obj: Record<string, unknown>, path: string[]): void {
    return unwrapQuantityAtPath.call(this, obj, path);
  }

  wrapWithQuantity(value: unknown): unknown {
    return wrapWithQuantity.call(this, value);
  }

  convertCacheBehavior(behavior: Record<string, unknown>): Record<string, unknown> {
    return convertCacheBehavior.call(this, behavior);
  }

  convertOrigin(origin: Record<string, unknown>): Record<string, unknown> {
    return convertOrigin.call(this, origin);
  }

  applyQuantityAtPath(obj: Record<string, unknown>, path: string[]): void {
    return applyQuantityAtPath.call(this, obj, path);
  }

  toSdkTags(tags: CfnTagEntry[]): Tag[] | undefined {
    return toSdkTags.call(this, tags);
  }

  computeTagDiff(
    previousTags: unknown,
    newTags: unknown,
    resourceType: string,
    logicalId: string
  ): { removed: string[]; upserts: Tag[] } {
    return computeTagDiff.call(this, previousTags, newTags, resourceType, logicalId);
  }

  applyTagDiff(
    arn: string | undefined,
    previousTags: unknown,
    newTags: unknown,
    physicalId: string,
    logicalId: string,
    resourceType: string,
    mask?: SecretMasker
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      arn,
      previousTags,
      newTags,
      physicalId,
      logicalId,
      resourceType,
      mask
    );
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
