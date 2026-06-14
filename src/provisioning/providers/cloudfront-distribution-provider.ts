import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateDistributionWithTagsCommand,
  UpdateDistributionCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  ListDistributionsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NoSuchDistribution,
  type DistributionConfig,
  type Tag,
} from '@aws-sdk/client-cloudfront';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
    ['AWS::CloudFront::Distribution', new Set(['DistributionConfig', 'Tags'])],
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

      // CFn shape: `Tags: [{ Key, Value }]`. CloudFront's SDK wraps tags in
      // a separate `CreateDistributionWithTagsCommand` whose request shape
      // is `{ DistributionConfigWithTags: { DistributionConfig, Tags: { Items: Tag[] } } }`.
      // Switch command class when tags are present so the create is atomic
      // (a post-create `TagResource` race would leave a tag-less window).
      const sdkTags = this.toSdkTags(properties['Tags']);

      const response = sdkTags
        ? await this.cloudFrontClient.send(
            new CreateDistributionWithTagsCommand({
              DistributionConfigWithTags: {
                DistributionConfig: sdkConfig as unknown as DistributionConfig,
                Tags: { Items: sdkTags },
              },
            })
          )
        : await this.cloudFrontClient.send(
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
    previousProperties: Record<string, unknown>
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

      // Get updated distribution for attributes (and ARN for tag ops)
      const getResponse = await this.cloudFrontClient.send(
        new GetDistributionCommand({ Id: physicalId })
      );
      const domainName = getResponse.Distribution?.DomainName ?? '';
      const arn = getResponse.Distribution?.ARN;

      // Apply tag diff via TagResource / UntagResource. CloudFront has no
      // single SDK call that overlays a tag map atomically — adds /
      // updates use TagResource (TagResource overwrites a key's value
      // when re-tagged), removals use UntagResource. Run the removal
      // first so a renamed key (e.g. value-only edit on key K) is not
      // accidentally cleared by a stale UntagResource pass.
      //
      // Tag-side failures THROW (issue #740 fix): a swallow leaves state
      // recording the new Tags as applied while AWS-side tags stay stale
      // forever (next deploy sees no diff → no retry). The trade-off is
      // that a TagResource throttle flips the whole update into a deploy
      // failure; the retry will re-issue UpdateDistribution against the
      // already-current config (AWS accepts as a no-op) before re-firing
      // the tag-diff. That secondary noise is much cheaper than the
      // silent tag drift the pre-#740 swallow caused.
      await this.applyTagDiff(
        arn,
        previousProperties['Tags'],
        properties['Tags'],
        physicalId,
        logicalId,
        resourceType
      );

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
   * Read the AWS-current `DistributionConfig` for drift detection.
   *
   * Calls the read-only `GetDistributionConfigCommand` and inverts the
   * provider's own `convertToSdkFormat` (the CFn-shape → SDK-shape
   * `{ Quantity, Items }` mapping the create / update path applies) back
   * into the CloudFormation `DistributionConfig` shape that cdkd state
   * stores — so the drift comparator sees the same structure on both
   * the deploy-time observed snapshot and a later drift read.
   *
   * The comparator only descends into keys present in cdkd state (or the
   * union of state + AWS when an observed baseline exists), so this does
   * not need to surface every AWS-injected field; it returns the same
   * `DistributionConfig` / `Tags` keys the provider manages.
   *
   * `CallerReference` (a create-time idempotency token AWS echoes back
   * but CDK never templates) is dropped so it cannot fire phantom drift.
   * The remaining write-only / never-readable sub-fields are declared in
   * `getDriftUnknownPaths`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::CloudFront::Distribution') return undefined;

    let config: DistributionConfig | undefined;
    try {
      const response = await this.cloudFrontClient.send(
        new GetDistributionConfigCommand({ Id: physicalId })
      );
      config = response.DistributionConfig;
    } catch (error) {
      if (error instanceof NoSuchDistribution) return undefined;
      throw error;
    }
    if (!config) return undefined;

    const result: Record<string, unknown> = {
      DistributionConfig: this.convertToCfnFormat(config as unknown as Record<string, unknown>),
    };

    // Surface AWS-current tags so a console-side tag edit is detectable.
    // CloudFront tags live on the distribution's ARN, fetched separately
    // via ListTagsForResource. A tag read failure is non-fatal — the
    // DistributionConfig drift is still meaningful on its own.
    try {
      const getResponse = await this.cloudFrontClient.send(
        new GetDistributionCommand({ Id: physicalId })
      );
      const arn = getResponse.Distribution?.ARN;
      if (arn) {
        const tagsResponse = await this.cloudFrontClient.send(
          new ListTagsForResourceCommand({ Resource: arn })
        );
        const items = tagsResponse.Tags?.Items ?? [];
        const cfnTags = items
          .filter((t) => typeof t.Key === 'string' && !t.Key.startsWith('aws:cdk:'))
          .map((t) => ({ Key: t.Key as string, Value: t.Value ?? '' }));
        if (cfnTags.length > 0) {
          result['Tags'] = cfnTags;
        }
      }
    } catch (error) {
      this.logger.debug(
        `Tag read for CloudFront Distribution ${physicalId} failed during drift read: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return result;
  }

  /**
   * State property paths cdkd cannot read back faithfully from AWS, so
   * the drift comparator skips them rather than firing a guaranteed
   * false positive every run (mirrors the Lambda `Code.S3*` precedent).
   *
   * - `DistributionConfig.CallerReference`: a create-time idempotency
   *   token. cdkd generates it internally (`<ts>-<logicalId>-<rand>`);
   *   AWS echoes it back, but it is never templated by CDK, so comparing
   *   it would diff cdkd's generated value on every run. `convertToCfnFormat`
   *   already drops it from the AWS side; declaring it here also excludes
   *   it from the observed-baseline side.
   * - `DistributionConfig.Logging.Bucket`: CloudFront normalizes the S3
   *   logging bucket to its `<bucket>.s3.amazonaws.com` regional domain on
   *   read, which never matches the bare bucket domain a template may
   *   carry; treat it as drift-unknown to avoid a guaranteed mismatch.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::CloudFront::Distribution') return [];
    return ['DistributionConfig.CallerReference', 'DistributionConfig.Logging.Bucket'];
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
   * Invert {@link convertToSdkFormat}: map an AWS-returned SDK-shape
   * `DistributionConfig` ({@link GetDistributionConfigCommand} output) back
   * into the CloudFormation `DistributionConfig` shape cdkd state stores.
   *
   * The inversion is the mirror image of the create / update conversion:
   * every `{ Quantity, Items }` wrapper becomes its bare `Items` array
   * (top-level list fields + the nested cache-behavior / origin fields),
   * and `CallerReference` is dropped (a create-time idempotency token CDK
   * never templates — see `getDriftUnknownPaths`).
   *
   * Lossiness note: the conversion is NOT perfectly lossless because
   * `convertToSdkFormat` injects SDK-required defaults the CFn template may
   * omit (`Comment: ''`, `Logging.{Enabled,IncludeCookies,Prefix}`,
   * `CustomOriginConfig.HTTP{,S}Port`). Those defaults are preserved on the
   * inverted side, which is correct for the drift comparator: the
   * deploy-time observed baseline (also produced by THIS method) carries the
   * same defaults, so they compare equal. They would only matter against the
   * `properties` fallback baseline (resources with no observedProperties),
   * where an AWS-injected default the template omitted is legitimately a
   * key cdkd never set — but the comparator's state-keys-only walk in that
   * mode never descends into a key absent from the template, so the extra
   * defaults cannot fire false drift there either.
   */
  private convertToCfnFormat(config: Record<string, unknown>): Record<string, unknown> {
    const result = { ...config };

    // Drop the create-time idempotency token (never templated by CDK).
    delete result['CallerReference'];

    // Unwrap top-level Quantity + Items fields back to bare arrays.
    for (const field of QUANTITY_ITEM_FIELDS) {
      if (result[field] !== undefined) {
        result[field] = this.unwrapQuantity(result[field]);
      }
    }

    // Unwrap nested Quantity + Items inside DefaultCacheBehavior.
    if (result['DefaultCacheBehavior'] && typeof result['DefaultCacheBehavior'] === 'object') {
      result['DefaultCacheBehavior'] = this.revertCacheBehavior(
        result['DefaultCacheBehavior'] as Record<string, unknown>
      );
    }

    // Unwrap nested Quantity + Items inside each CacheBehavior (now a bare array).
    if (Array.isArray(result['CacheBehaviors'])) {
      result['CacheBehaviors'] = (result['CacheBehaviors'] as Record<string, unknown>[]).map((cb) =>
        this.revertCacheBehavior(cb)
      );
    }

    // Unwrap nested Quantity + Items inside each Origin (now a bare array).
    if (Array.isArray(result['Origins'])) {
      result['Origins'] = (result['Origins'] as Record<string, unknown>[]).map((origin) =>
        this.revertOrigin(origin)
      );
    }

    return result;
  }

  /**
   * Inverse of {@link wrapWithQuantity}: a `{ Quantity, Items }` object
   * becomes its bare `Items` array; anything else is returned unchanged.
   */
  private unwrapQuantity(value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj['Items'])) {
        return obj['Items'];
      }
    }
    return value;
  }

  /**
   * Inverse of {@link convertCacheBehavior}: unwrap the Quantity + Items
   * fields nested inside a CacheBehavior back to bare arrays.
   */
  private revertCacheBehavior(behavior: Record<string, unknown>): Record<string, unknown> {
    const result = { ...behavior };

    // AWS nests `CachedMethods` INSIDE the `AllowedMethods` wrapper
    // ({ Quantity, Items, CachedMethods: { Quantity, Items } }), whereas the
    // CFn shape carries them as SIBLINGS (AllowedMethods + CachedMethods both
    // bare arrays — `convertToSdkFormat` only wraps the two CFn arrays
    // independently and never re-nests). Hoist CachedMethods back out to a
    // sibling before the generic unwrap so the inverted shape matches CFn and
    // a console-side CachedMethods change stays detectable.
    if (result['AllowedMethods'] && typeof result['AllowedMethods'] === 'object') {
      const allowed = result['AllowedMethods'] as Record<string, unknown>;
      if (allowed['CachedMethods'] !== undefined && result['CachedMethods'] === undefined) {
        result['CachedMethods'] = allowed['CachedMethods'];
        const allowedCopy = { ...allowed };
        delete allowedCopy['CachedMethods'];
        result['AllowedMethods'] = allowedCopy;
      }
    }

    for (const fieldPath of CACHE_BEHAVIOR_QUANTITY_FIELDS) {
      const parts = fieldPath.split('.');
      this.unwrapQuantityAtPath(result, parts);
    }

    return result;
  }

  /**
   * Inverse of {@link convertOrigin}: unwrap CustomHeaders and
   * CustomOriginConfig.OriginSslProtocols back to bare arrays.
   */
  private revertOrigin(origin: Record<string, unknown>): Record<string, unknown> {
    const result = { ...origin };

    if (result['CustomHeaders'] !== undefined) {
      result['CustomHeaders'] = this.unwrapQuantity(result['CustomHeaders']);
    }

    if (result['CustomOriginConfig'] && typeof result['CustomOriginConfig'] === 'object') {
      const customOriginConfig = { ...(result['CustomOriginConfig'] as Record<string, unknown>) };
      if (customOriginConfig['OriginSslProtocols'] !== undefined) {
        customOriginConfig['OriginSslProtocols'] = this.unwrapQuantity(
          customOriginConfig['OriginSslProtocols']
        );
      }
      result['CustomOriginConfig'] = customOriginConfig;
    }

    return result;
  }

  /**
   * Inverse of {@link applyQuantityAtPath}: unwrap a `{ Quantity, Items }`
   * value at a nested path (e.g. "ForwardedValues.Headers") back to a bare
   * array.
   */
  private unwrapQuantityAtPath(obj: Record<string, unknown>, path: string[]): void {
    if (path.length === 0) return;

    if (path.length === 1) {
      const key = path[0]!;
      if (obj[key] !== undefined) {
        obj[key] = this.unwrapQuantity(obj[key]);
      }
      return;
    }

    const [head, ...rest] = path;
    const headKey = head!;
    if (obj[headKey] && typeof obj[headKey] === 'object') {
      const nested = { ...(obj[headKey] as Record<string, unknown>) };
      obj[headKey] = nested;
      this.unwrapQuantityAtPath(nested, rest);
    }
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

  /**
   * Convert CFn `Tags: [{ Key, Value }]` to the CloudFront SDK's `Tag[]`
   * shape (which happens to be the same `{ Key, Value }` per-entry shape),
   * dropping entries missing a Key and normalizing missing-Value to `''`
   * (matching `tagsArrayToMap`'s shape so the create-path and update-diff-
   * path agree on what counts as "the same tag"). Returns `undefined`
   * when the input is absent or empty so the caller can route to
   * `CreateDistributionCommand` instead of `CreateDistributionWithTagsCommand`
   * — passing an empty `Tags.Items: []` to the latter is a silent no-op
   * but uses the tags-enabled control-plane path for nothing.
   */
  private toSdkTags(value: unknown): Tag[] | undefined {
    const map = this.tagsArrayToMap(value);
    if (map.size === 0) return undefined;
    return [...map.entries()].map(([Key, Value]) => ({ Key, Value }));
  }

  /**
   * Compute the (removed-keys, upserted-tags) diff between two CFn `Tags`
   * snapshots. Pure function — does NOT touch AWS, so the caller can
   * decide on the basis of the result whether the ARN is actually needed
   * (no diff = no ARN required).
   */
  private computeTagDiff(
    previousTags: unknown,
    newTags: unknown
  ): { removed: string[]; upserts: Tag[] } {
    const prev = this.tagsArrayToMap(previousTags);
    const next = this.tagsArrayToMap(newTags);

    const removed = [...prev.keys()].filter((k) => !next.has(k));
    const upserts: Tag[] = [];
    for (const [k, v] of next.entries()) {
      if (prev.get(k) !== v) upserts.push({ Key: k, Value: v });
    }
    return { removed, upserts };
  }

  /**
   * Apply a tag diff to a distribution.
   *
   * CloudFront has no atomic overlay API for tags — `TagResource` adds /
   * overwrites and `UntagResource` removes. Run the removal first, then
   * the upsert, so a same-key value rewrite (which lands in `upserts`)
   * is not accidentally cleared by a stale Untag.
   *
   * Errors are RETHROWN as `ProvisioningError` (issue #740 fix) so the
   * deploy engine sees a failed update() and (a) does NOT write the new
   * properties.Tags into state — the next deploy retries the tag-diff
   * against the still-old state, (b) surfaces the failure to the user
   * via the standard error path. The deploy engine's `withRetry` MAY
   * pick up some transient AWS errors via the cause-message-pattern
   * match (`retryable-errors.ts`'s `RETRYABLE_ERROR_MESSAGE_PATTERNS`),
   * but bare HTTP 429 throttles wrapped by update()'s outer catch reach
   * the classifier two levels deep and slip past its single-level
   * `.cause` walk — so the **load-bearing retry guarantee is the
   * next-deploy retry**, not in-deploy retry. This is acceptable: the
   * user sees the failure, can react, and the next `cdkd deploy`
   * re-fires the tag-diff against the still-old state cleanly.
   *
   * Trade-off: a tag-side failure flips an otherwise-successful
   * `UpdateDistribution` into a deploy failure, and the retry will
   * re-issue UpdateDistribution against the (now-current) config —
   * AWS accepts the no-op idempotently. The cost of that secondary
   * noise is much lower than the cost of silent tag drift the pre-#740
   * swallow caused.
   *
   * The ARN is unexpectedly absent only on a hypothetical SDK regression
   * (`GetDistribution` returns ARN as a required string in every SDK
   * shape verified so far). When that happens AND a tag delta exists,
   * THROW so the silent-drop does not silently resurface; when no delta
   * exists, return without needing ARN.
   */
  private async applyTagDiff(
    arn: string | undefined,
    previousTags: unknown,
    newTags: unknown,
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const { removed, upserts } = this.computeTagDiff(previousTags, newTags);
    if (removed.length === 0 && upserts.length === 0) return;

    if (!arn) {
      throw new ProvisioningError(
        `CloudFront Distribution ${physicalId}: GetDistribution returned no ARN; ` +
          `cannot apply tag diff (removed=${removed.length}, upserts=${upserts.length}). ` +
          `Refusing to silently drop the tag update — retry on next deploy or check SDK version.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      if (removed.length > 0) {
        this.logger.debug(`Untagging CloudFront Distribution ${arn}: ${removed.join(', ')}`);
        await this.cloudFrontClient.send(
          new UntagResourceCommand({
            Resource: arn,
            TagKeys: { Items: removed },
          })
        );
      }
      if (upserts.length > 0) {
        this.logger.debug(
          `Tagging CloudFront Distribution ${arn}: ${upserts.map((t) => t.Key).join(', ')}`
        );
        await this.cloudFrontClient.send(
          new TagResourceCommand({
            Resource: arn,
            Tags: { Items: upserts },
          })
        );
      }
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new ProvisioningError(
        `CloudFront Distribution ${physicalId}: tag diff failed (removed=${removed.length}, ` +
          `upserts=${upserts.length}): ${err instanceof Error ? err.message : String(err)}. ` +
          `UpdateDistribution succeeded but TagResource/UntagResource did not — state has NOT been updated so the next deploy will retry the tag-diff.`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Convert a CFn `Tags: [{ Key, Value }]` array to a plain map. Entries
   * missing a `Key` are dropped; a missing `Value` becomes `''` so the
   * diff treats `{ Key: 'k' }` and `{ Key: 'k', Value: '' }` the same.
   */
  private tagsArrayToMap(value: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(value)) return map;
    for (const entry of value as Array<Record<string, unknown>>) {
      const key = entry['Key'];
      if (typeof key !== 'string') continue;
      const val = entry['Value'];
      map.set(key, typeof val === 'string' ? val : '');
    }
    return map;
  }

  /**
   * Adopt an existing CloudFront distribution into cdkd state.
   *
   * CloudFront distributions don't carry a template-supplied name
   * (physical id is the AWS-generated `E...` distribution id), so the
   * lookup is either explicit-override or `aws:cdk:path` tag match
   * via `ListDistributions` + `ListTagsForResource(ARN)`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.cloudFrontClient.send(new GetDistributionCommand({ Id: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NoSuchDistribution) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.cloudFrontClient.send(
        new ListDistributionsCommand({ ...(marker && { Marker: marker }) })
      );
      for (const d of list.DistributionList?.Items ?? []) {
        if (!d.Id || !d.ARN) continue;
        try {
          const tagsResp = await this.cloudFrontClient.send(
            new ListTagsForResourceCommand({ Resource: d.ARN })
          );
          if (matchesCdkPath(tagsResp.Tags?.Items, input.cdkPath)) {
            return { physicalId: d.Id, attributes: {} };
          }
        } catch (err) {
          if (err instanceof NoSuchDistribution) continue;
          throw err;
        }
      }
      marker = list.DistributionList?.IsTruncated ? list.DistributionList?.NextMarker : undefined;
    } while (marker);
    return null;
  }
}
