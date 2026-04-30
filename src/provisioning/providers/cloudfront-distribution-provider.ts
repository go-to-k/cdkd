import {
  CloudFrontClient,
  CreateDistributionCommand,
  UpdateDistributionCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  NoSuchDistribution,
  type DistributionConfig,
} from '@aws-sdk/client-cloudfront';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * Fields in the DistributionConfig that follow the { Quantity, Items } pattern.
 * The CDK template may provide just Items (an array); we wrap it with Quantity.
 */
const QUANTITY_ITEM_FIELDS = [
  'Origins',
  'CacheBehaviors',
  'CustomErrorResponses',
  'Aliases',
  'OriginGroups',
];

/**
 * Nested fields inside each CacheBehavior / DefaultCacheBehavior that use
 * the Quantity + Items pattern.
 */
const CACHE_BEHAVIOR_QUANTITY_FIELDS = [
  'AllowedMethods',
  'CachedMethods',
  'LambdaFunctionAssociations',
  'FunctionAssociations',
  'ForwardedValues.Headers',
  'ForwardedValues.QueryStringCacheKeys',
  'ForwardedValues.Cookies.WhitelistedNames',
  'TrustedSigners',
  'TrustedKeyGroups',
];

/**
 * SDK Provider for AWS::CloudFront::Distribution
 *
 * Uses the CloudFront SDK directly for reliable CRUD operations.
 * CloudFront Distribution has a complex nested DistributionConfig structure
 * requiring Quantity + Items pattern conversions for SDK compatibility.
 */
export class CloudFrontDistributionProvider implements ResourceProvider {
  private cloudFrontClient: CloudFrontClient;
  private logger = getLogger().child('CloudFrontDistributionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFront::Distribution', new Set(['DistributionConfig'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.cloudFrontClient = awsClients.cloudFront;
  }

  /**
   * Create a CloudFront Distribution
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudFront Distribution ${logicalId}`);

    try {
      const distributionConfig =
        (properties['DistributionConfig'] as Record<string, unknown>) ?? {};
      const sdkConfig = this.convertToSdkFormat({
        ...distributionConfig,
        CallerReference: `${Date.now()}-${logicalId}-${Math.random().toString(36).slice(2, 8)}`,
      });

      const response = await this.cloudFrontClient.send(
        new CreateDistributionCommand({
          DistributionConfig: sdkConfig as unknown as DistributionConfig,
        })
      );

      const distribution = response.Distribution!;
      const distributionId = distribution.Id!;
      const domainName = distribution.DomainName!;

      this.logger.debug(`Created CloudFront Distribution: ${distributionId} (${domainName})`);

      // Wait for distribution to be fully deployed (like CloudFormation does)
      // Skip with --no-wait or CDKD_NO_WAIT=true
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        this.logger.debug(`Waiting for Distribution ${distributionId} to reach Deployed status...`);
        await this.waitForDistributionStable(distributionId);
      }

      return {
        physicalId: distributionId,
        attributes: {
          Id: distributionId,
          DistributionId: distributionId,
          DomainName: domainName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudFront Distribution ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a CloudFront Distribution
   *
   * Gets the current config via GetDistributionConfigCommand, merges new properties,
   * then calls UpdateDistributionCommand with the required IfMatch ETag.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CloudFront Distribution ${logicalId}: ${physicalId}`);

    try {
      // Get current config and ETag
      const getConfigResponse = await this.cloudFrontClient.send(
        new GetDistributionConfigCommand({ Id: physicalId })
      );
      const etag = getConfigResponse.ETag!;
      const currentConfig = getConfigResponse.DistributionConfig!;

      // Merge new properties into existing config, preserving CallerReference
      const newDistributionConfig =
        (properties['DistributionConfig'] as Record<string, unknown>) ?? {};
      const sdkConfig = this.convertToSdkFormat({
        ...newDistributionConfig,
        CallerReference: currentConfig.CallerReference,
      });

      await this.cloudFrontClient.send(
        new UpdateDistributionCommand({
          Id: physicalId,
          IfMatch: etag,
          DistributionConfig: sdkConfig as unknown as DistributionConfig,
        })
      );

      // Get updated distribution for attributes
      const getResponse = await this.cloudFrontClient.send(
        new GetDistributionCommand({ Id: physicalId })
      );
      const domainName = getResponse.Distribution?.DomainName ?? '';

      this.logger.debug(`Updated CloudFront Distribution ${physicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
          DistributionId: physicalId,
          DomainName: domainName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudFront Distribution ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a CloudFront Distribution
   *
   * CloudFront requires distributions to be disabled before deletion.
   * Steps:
   * 1. Get current config + ETag
   * 2. If Enabled, update to Enabled=false and wait
   * 3. Delete with the latest ETag
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CloudFront Distribution ${logicalId}: ${physicalId}`);

    try {
      // Step 1: Get current config
      let etag: string;
      let config;
      try {
        const getConfigResponse = await this.cloudFrontClient.send(
          new GetDistributionConfigCommand({ Id: physicalId })
        );
        etag = getConfigResponse.ETag!;
        config = getConfigResponse.DistributionConfig!;
      } catch (error) {
        if (error instanceof NoSuchDistribution) {
          const clientRegion = await this.cloudFrontClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Distribution ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Step 2: Disable the distribution if it is currently enabled
      if (config.Enabled) {
        this.logger.debug(`Disabling CloudFront Distribution ${physicalId} before deletion`);
        config.Enabled = false;

        const updateResponse = await this.cloudFrontClient.send(
          new UpdateDistributionCommand({
            Id: physicalId,
            IfMatch: etag,
            DistributionConfig: config,
          })
        );
        etag = updateResponse.ETag!;

        // Wait until the disable is fully propagated. We must check BOTH
        // Status==='Deployed' AND DistributionConfig.Enabled===false, because
        // CloudFront's read-after-write is eventually consistent: a GetDistribution
        // call made shortly after UpdateDistribution can still return the previous
        // (Enabled=true, Status=Deployed) snapshot, which would otherwise cause us
        // to exit the wait loop on the very first poll and fire DeleteDistribution
        // against an enabled distribution (yielding DistributionNotDisabled).
        await this.waitForDistributionStable(physicalId, false);

        // Re-fetch ETag after waiting (state may have changed)
        const refreshResponse = await this.cloudFrontClient.send(
          new GetDistributionConfigCommand({ Id: physicalId })
        );
        etag = refreshResponse.ETag!;
      }

      // Step 3: Delete the distribution
      await this.cloudFrontClient.send(
        new DeleteDistributionCommand({
          Id: physicalId,
          IfMatch: etag,
        })
      );

      this.logger.debug(`Successfully deleted CloudFront Distribution ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchDistribution) {
        const clientRegion = await this.cloudFrontClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Distribution ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudFront Distribution ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution)
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id' || attributeName === 'DistributionId') {
      return physicalId;
    }

    if (attributeName === 'DomainName') {
      const response = await this.cloudFrontClient.send(
        new GetDistributionCommand({ Id: physicalId })
      );
      return response.Distribution?.DomainName;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::CloudFront::Distribution`);
  }

  /**
   * Wait for a distribution to reach a stable state.
   *
   * "Stable" means Status === 'Deployed'. When `expectedEnabled` is provided,
   * we additionally require DistributionConfig.Enabled === expectedEnabled —
   * this guards against CloudFront's eventually-consistent reads that can
   * briefly return the pre-update snapshot after UpdateDistribution returns.
   *
   * Uses exponential backoff polling.
   */
  private async waitForDistributionStable(
    distributionId: string,
    expectedEnabled?: boolean
  ): Promise<void> {
    const maxAttempts = 60;
    let delay = 5000; // start at 5s
    const maxDelay = 30000;
    let interrupted = false;

    const sigintHandler = () => {
      interrupted = true;
    };
    process.on('SIGINT', sigintHandler);

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (interrupted) {
          this.logger.debug(
            `Distribution ${distributionId} wait interrupted by SIGINT, proceeding`
          );
          return;
        }

        const response = await this.cloudFrontClient.send(
          new GetDistributionCommand({ Id: distributionId })
        );
        const status = response.Distribution?.Status;
        const enabled = response.Distribution?.DistributionConfig?.Enabled;

        const enabledMatches = expectedEnabled === undefined || enabled === expectedEnabled;

        if (status === 'Deployed' && enabledMatches) {
          this.logger.debug(
            `Distribution ${distributionId} is stable (Status=Deployed, Enabled=${enabled})`
          );
          return;
        }

        this.logger.debug(
          `Distribution ${distributionId} status: ${status}, enabled: ${enabled}` +
            (expectedEnabled === undefined ? '' : ` (waiting for Enabled=${expectedEnabled})`) +
            ` (attempt ${attempt}/${maxAttempts})`
        );

        // Interruptible sleep: check SIGINT every second
        const sleepEnd = Date.now() + delay;
        while (Date.now() < sleepEnd && !interrupted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        delay = Math.min(delay * 1.5, maxDelay);
      }

      this.logger.debug(
        `Distribution ${distributionId} did not reach stable state within timeout, proceeding with next step`
      );
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }
  }

  /**
   * Convert CDK/CloudFormation DistributionConfig format to SDK format.
   *
   * The main transformation is adding Quantity fields where the SDK expects
   * the { Quantity: N, Items: [...] } pattern, while CDK templates typically
   * provide just the Items array or an object with only Items.
   */
  private convertToSdkFormat(config: Record<string, unknown>): Record<string, unknown> {
    const result = { ...config };

    // Ensure Comment is never null (SDK requires non-null string)
    if (result['Comment'] === null || result['Comment'] === undefined) {
      result['Comment'] = '';
    }

    // Ensure Logging has IncludeCookies and Enabled defaults
    if (result['Logging'] && typeof result['Logging'] === 'object') {
      const logging = result['Logging'] as Record<string, unknown>;
      if (logging['IncludeCookies'] === undefined) logging['IncludeCookies'] = false;
      if (logging['Enabled'] === undefined) logging['Enabled'] = true;
      if (logging['Prefix'] === undefined) logging['Prefix'] = '';
    }

    // Convert top-level Quantity + Items fields
    for (const field of QUANTITY_ITEM_FIELDS) {
      if (result[field] !== undefined) {
        result[field] = this.wrapWithQuantity(result[field]);
      }
    }

    // Convert nested Quantity + Items fields inside DefaultCacheBehavior
    if (result['DefaultCacheBehavior'] && typeof result['DefaultCacheBehavior'] === 'object') {
      result['DefaultCacheBehavior'] = this.convertCacheBehavior(
        result['DefaultCacheBehavior'] as Record<string, unknown>
      );
    }

    // Convert nested Quantity + Items fields inside each CacheBehavior
    if (result['CacheBehaviors'] && typeof result['CacheBehaviors'] === 'object') {
      const cacheBehaviors = result['CacheBehaviors'] as Record<string, unknown>;
      if (Array.isArray(cacheBehaviors['Items'])) {
        cacheBehaviors['Items'] = (cacheBehaviors['Items'] as Record<string, unknown>[]).map((cb) =>
          this.convertCacheBehavior(cb)
        );
      }
    }

    // Convert Origins items - nested Quantity + Items fields (e.g., CustomHeaders)
    if (result['Origins'] && typeof result['Origins'] === 'object') {
      const origins = result['Origins'] as Record<string, unknown>;
      if (Array.isArray(origins['Items'])) {
        origins['Items'] = (origins['Items'] as Record<string, unknown>[]).map((origin) =>
          this.convertOrigin(origin)
        );
      }
    }

    return result;
  }

  /**
   * Wrap a value with the Quantity + Items pattern if needed.
   *
   * Handles three cases:
   * - Array: wrap as { Quantity: len, Items: array }
   * - Object with Items but no Quantity: add Quantity
   * - Already has Quantity: leave as-is
   */
  private wrapWithQuantity(value: unknown): unknown {
    if (Array.isArray(value)) {
      return { Quantity: value.length, Items: value };
    }

    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj['Items']) && obj['Quantity'] === undefined) {
        return { ...obj, Quantity: (obj['Items'] as unknown[]).length };
      }
    }

    return value;
  }

  /**
   * Convert Quantity + Items fields nested inside a CacheBehavior.
   */
  private convertCacheBehavior(behavior: Record<string, unknown>): Record<string, unknown> {
    const result = { ...behavior };

    for (const fieldPath of CACHE_BEHAVIOR_QUANTITY_FIELDS) {
      const parts = fieldPath.split('.');
      this.applyQuantityAtPath(result, parts);
    }

    return result;
  }

  /**
   * Convert nested Quantity + Items fields inside an Origin.
   * Handles CustomHeaders and S3OriginConfig/CustomOriginConfig nested fields.
   */
  private convertOrigin(origin: Record<string, unknown>): Record<string, unknown> {
    const result = { ...origin };

    // CustomHeaders uses the Quantity + Items pattern
    if (result['CustomHeaders'] !== undefined) {
      result['CustomHeaders'] = this.wrapWithQuantity(result['CustomHeaders']);
    }

    // S3OriginConfig does not need Quantity wrapping (it's a simple object)
    // CustomOriginConfig.OriginSslProtocols uses Quantity + Items
    if (result['CustomOriginConfig'] && typeof result['CustomOriginConfig'] === 'object') {
      const customOriginConfig = { ...(result['CustomOriginConfig'] as Record<string, unknown>) };
      if (customOriginConfig['OriginSslProtocols'] !== undefined) {
        customOriginConfig['OriginSslProtocols'] = this.wrapWithQuantity(
          customOriginConfig['OriginSslProtocols']
        );
      }
      // Ensure HTTPPort and HTTPSPort have defaults (SDK requires non-null values)
      if (customOriginConfig['HTTPPort'] === null || customOriginConfig['HTTPPort'] === undefined) {
        customOriginConfig['HTTPPort'] = 80;
      }
      if (
        customOriginConfig['HTTPSPort'] === null ||
        customOriginConfig['HTTPSPort'] === undefined
      ) {
        customOriginConfig['HTTPSPort'] = 443;
      }
      result['CustomOriginConfig'] = customOriginConfig;
    }

    return result;
  }

  /**
   * Apply Quantity wrapping at a nested path (e.g., "ForwardedValues.Headers").
   */
  private applyQuantityAtPath(obj: Record<string, unknown>, path: string[]): void {
    if (path.length === 0) return;

    if (path.length === 1) {
      const key = path[0]!;
      if (obj[key] !== undefined) {
        obj[key] = this.wrapWithQuantity(obj[key]);
      }
      return;
    }

    const [head, ...rest] = path;
    const headKey = head!;
    if (obj[headKey] && typeof obj[headKey] === 'object') {
      // Shallow copy the nested object to avoid mutating the original
      const nested = { ...(obj[headKey] as Record<string, unknown>) };
      obj[headKey] = nested;
      this.applyQuantityAtPath(nested, rest);
    }
  }
}
