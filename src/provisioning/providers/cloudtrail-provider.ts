import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import type { MaskerFn } from '../masked-retry-logger.js';
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
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { UNORDERED_LIST_BLOCKS } from './cloudtrail/shared.js';
import { wrapCaughtError, create } from './cloudtrail/core.js';
import { update, readLiveForRecord } from './cloudtrail/update.js';
import { deleteImpl } from './cloudtrail/delete.js';
import { applyTagDiff } from './cloudtrail/tags.js';
import { readCurrentState, importImpl } from './cloudtrail/read-state.js';

/**
 * SDK Provider for AWS CloudTrail resources
 *
 * Supports:
 * - AWS::CloudTrail::Trail
 *
 * CloudTrail CreateTrail/UpdateTrail are synchronous - the CC API adds
 * unnecessary polling overhead for operations that complete immediately.
 */
export class CloudTrailProvider implements ResourceProvider {
  client: CloudTrailClient | undefined;
  createClient: CloudTrailClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('CloudTrailProvider');

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  /**
   * Issue #1160: the CFn default a property REMOVED from the template is
   * reset to — the Modify/Update API keeps an absent field's live value.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::CloudTrail::Trail',
      new Map<string, unknown>([
        ['IsMultiRegionTrail', false],
        ['EnableLogFileValidation', false],
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every Trail
   * property, each removal handled by `update()` — so the shared caller warns
   * about none of them.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudTrail::Trail',
      new Set<string>([
        // Required by CloudFormation (a template cannot remove them) or
        // create-only (a removal replaces the trail).
        'S3BucketName',
        'IsLogging',
        'TrailName',
        // Reset to '' on removal (#1160, #1533 A/Bs).
        'S3KeyPrefix',
        'SnsTopicName',
        'KMSKeyId',
        // Kept, as CloudFormation keeps them (#1160 A/B): no warning.
        'CloudWatchLogsLogGroupArn',
        'CloudWatchLogsRoleArn',
        // Diffed: a removal resets or clears them through their own Put call.
        'EventSelectors',
        'AdvancedEventSelectors',
        'InsightSelectors',
        'AggregationConfigurations',
        // Diffed by AddTags / RemoveTags.
        'Tags',
        // Reset on a single-region trail; otherwise kept and named in
        // update()'s own warning (removalsLeftInPlace).
        'IncludeGlobalServiceEvents',
        // Kept and named in update()'s own warning. CFn behaviour unmeasured:
        // the A/B needs an Organizations management/delegated-admin account
        // (Refs #5541).
        'IsOrganizationTrail',
        // Kept and named in update()'s own warning when the removed value was
        // not AWS's default `true`. CFn behaviour unmeasured (#6166).
        'RecursiveLogging',
      ]),
    ],
  ]);

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudTrail::Trail',
      new Set([
        'S3BucketName',
        'TrailName',
        'S3KeyPrefix',
        'IsMultiRegionTrail',
        'IncludeGlobalServiceEvents',
        'EnableLogFileValidation',
        'IsLogging',
        'Tags',
        'CloudWatchLogsLogGroupArn',
        'CloudWatchLogsRoleArn',
        'KMSKeyId',
        'SnsTopicName',
        'EventSelectors',
        'InsightSelectors',
        'IsOrganizationTrail',
        'AdvancedEventSelectors',
        'AggregationConfigurations',
        'RecursiveLogging',
      ]),
    ],
  ]);

  getClient(): CloudTrailClient {
    if (!this.client) {
      this.client = new CloudTrailClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new CloudTrailClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateTrail` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry; built in {@link getClient}'s step, so both
   * capture the region and identity active at that ONE call.
   *
   * `CreateTrail` carries no idempotency token, and a trail name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): CloudTrailClient {
    this.getClient();
    return this.createClient as CloudTrailClient;
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
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  readLiveForRecord(
    physicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    return readLiveForRecord.call(this, physicalId, resourceType);
  }

  /**
   * Both comparison sides of `cdkd drift` sort these blocks' lists
   * ({@link UNORDERED_LIST_BLOCKS}): AWS reads `FieldSelectors` back sorted
   * by `Field`, so a template declaring them in another order would otherwise
   * report drift on every clean deploy.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::CloudTrail::Trail') return [];
    return [...UNORDERED_LIST_BLOCKS];
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Arn is stored in attributes during create
    return Promise.resolve(attributeName);
  }

  applyTagDiff(
    trailArn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, trailArn, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
