import {
  ElastiCacheClient,
  type AZMode,
  type LogDeliveryConfigurationRequest,
} from '@aws-sdk/client-elasticache';
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
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import {
  wrapCaughtError,
  wrapDeleteError,
  create,
  update,
  deleteImpl,
  isNotFoundError,
} from './elasticache/core.js';
import {
  createSubnetGroup,
  updateSubnetGroup,
  deleteSubnetGroup,
  applySubnetGroupTagDiff,
} from './elasticache/subnet-group.js';
import {
  createCacheCluster,
  deleteCacheCluster,
  describeCacheCluster,
  waitForClusterAvailable,
  waitForClusterDeleted,
} from './elasticache/cache-cluster.js';
import {
  updateCacheCluster,
  warnTransitEncryptionNotApplied,
  planNodeChanges,
  warnNotAppliedInPlace,
  warnRemovalsLeftInPlace,
  buildLogDeliveryConfigurationsForUpdate,
  applyTagDiff,
} from './elasticache/cache-cluster-update.js';
import {
  readCurrentState,
  readCacheCluster,
  readSubnetGroup,
  attachTags,
} from './elasticache/read-state.js';
import { importImpl, importCacheCluster, importSubnetGroup } from './elasticache/import.js';
import { KEPT_ON_REMOVAL, PLACEMENT_ON_REMOVAL } from './elasticache/shared.js';

export { nodesToRemove } from './elasticache/shared.js';

/**
 * AWS ElastiCache Provider
 *
 * Implements resource provisioning for ElastiCache resources:
 * - AWS::ElastiCache::SubnetGroup
 * - AWS::ElastiCache::CacheCluster
 *
 * WHY: ElastiCache SDK calls are direct and avoid CC API polling overhead.
 * CacheCluster creation requires polling until available.
 */
export class ElastiCacheProvider implements ResourceProvider {
  private client?: ElastiCacheClient;
  private createClient?: ElastiCacheClient;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('ElastiCacheProvider');

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  wrapDeleteError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapDeleteError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElastiCache::SubnetGroup',
      new Set([
        'CacheSubnetGroupName',
        'CacheSubnetGroupDescription',
        'Description',
        'SubnetIds',
        'Tags',
      ]),
    ],
    [
      'AWS::ElastiCache::CacheCluster',
      new Set([
        'ClusterName',
        'Engine',
        'CacheNodeType',
        'NumCacheNodes',
        'CacheSubnetGroupName',
        'VpcSecurityGroupIds',
        'Port',
        'EngineVersion',
        'CacheParameterGroupName',
        'PreferredMaintenanceWindow',
        'AZMode',
        'PreferredAvailabilityZone',
        'PreferredAvailabilityZones',
        'SnapshotRetentionLimit',
        'SnapshotWindow',
        'AutoMinorVersionUpgrade',
        'Tags',
        'NotificationTopicArn',
        'SnapshotName',
        'SnapshotArns',
        'LogDeliveryConfigurations',
        'NetworkType',
        'IpDiscovery',
        'TransitEncryptionEnabled',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::ElastiCache::CacheCluster',
      new Map<string, string>([
        [
          'CacheSecurityGroupNames',
          'EC2-Classic-only — use VpcSecurityGroupIds for VPC-deployed clusters (EC2-Classic retired 2022-08-15)',
        ],
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every
   * CacheCluster property, each removal handled by `update()` — so the
   * shared caller warns about none of them.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElastiCache::CacheCluster',
      new Set<string>([
        // Create-only (a removal replaces the cluster).
        'CacheSubnetGroupName',
        'ClusterName',
        'Engine',
        'NetworkType',
        'Port',
        'SnapshotName',
        'SnapshotArns',
        // EC2-Classic only (unhandledByDesign): never sent, so nothing to reset.
        'CacheSecurityGroupNames',
        // Required by CloudFormation: a template cannot remove them.
        'CacheNodeType',
        'NumCacheNodes',
        // Diffed by AddTagsToResource / RemoveTagsFromResource.
        'Tags',
        // Reset: a removed log type is sent disabled (#5004).
        'LogDeliveryConfigurations',
        // Left in place, as CloudFormation leaves them, and named in
        // update()'s own warning.
        ...KEPT_ON_REMOVAL,
        // Placement: sent as nothing, the CloudFormation replacement planned
        // by the replacement rules (go-to-k/cdkd#5558), named in update()'s
        // own warning.
        ...PLACEMENT_ON_REMOVAL,
      ]),
    ],
  ]);

  getClient(): ElastiCacheClient {
    if (!this.client) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.client = new ElastiCacheClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new ElastiCacheClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateCacheSubnetGroup` / `CreateCacheCluster` go through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * Neither carries an idempotency token, and each name is unique per account
   * and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): ElastiCacheClient {
    this.getClient();
    return this.createClient as ElastiCacheClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

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

  // ─── SubnetGroup ──────────────────────────────────────────────────

  createSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask?: MaskerFn
  ): Promise<ResourceCreateResult> {
    return createSubnetGroup.call(this, logicalId, resourceType, properties, mask);
  }

  updateSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask?: MaskerFn
  ): Promise<ResourceUpdateResult> {
    return updateSubnetGroup.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask
    );
  }

  deleteSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteSubnetGroup.call(this, logicalId, physicalId, resourceType, context);
  }

  // ─── CacheCluster ────────────────────────────────────────────────

  createCacheCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask?: MaskerFn
  ): Promise<ResourceCreateResult> {
    return createCacheCluster.call(this, logicalId, resourceType, properties, mask);
  }

  updateCacheCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask?: MaskerFn,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateCacheCluster.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask,
      context
    );
  }

  deleteCacheCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteCacheCluster.call(this, logicalId, physicalId, resourceType, context);
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  warnTransitEncryptionNotApplied(
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    live: boolean | undefined
  ): void {
    return warnTransitEncryptionNotApplied.call(
      this,
      logicalId,
      properties,
      previousProperties,
      live
    );
  }

  planNodeChanges(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<{
    placement: { newAvailabilityZones: string[]; azMode: AZMode | undefined } | undefined;
    removeIds: string[];
  }> {
    return planNodeChanges.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties
    );
  }

  warnNotAppliedInPlace(
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    placement: { azMode: AZMode | undefined } | undefined
  ): void {
    return warnNotAppliedInPlace.call(this, logicalId, properties, previousProperties, placement);
  }

  warnRemovalsLeftInPlace(
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): void {
    return warnRemovalsLeftInPlace.call(this, logicalId, properties, previousProperties, context);
  }

  buildLogDeliveryConfigurationsForUpdate(
    newConfigs: LogDeliveryConfigurationRequest[] | undefined,
    previousConfigs: LogDeliveryConfigurationRequest[] | undefined
  ): LogDeliveryConfigurationRequest[] | undefined {
    return buildLogDeliveryConfigurationsForUpdate.call(this, newConfigs, previousConfigs);
  }

  applySubnetGroupTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    liveTags: Array<{ Key: string; Value: string }>
  ): Promise<void> {
    return applySubnetGroupTagDiff.call(
      this,
      arn,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      liveTags
    );
  }

  applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, arn, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }

  isNotFoundError(error: unknown, faultName: string): boolean {
    return isNotFoundError.call(this, error, faultName);
  }

  describeCacheCluster(cacheClusterId: string) {
    return describeCacheCluster.call(this, cacheClusterId);
  }

  waitForClusterAvailable(
    cacheClusterId: string,
    maxWaitMs?: number,
    expectedNodeType?: string,
    removedNodeIds?: readonly string[]
  ): Promise<void> {
    return waitForClusterAvailable.call(
      this,
      cacheClusterId,
      maxWaitMs,
      expectedNodeType,
      removedNodeIds
    );
  }

  waitForClusterDeleted(
    logicalId: string,
    cacheClusterId: string,
    maxWaitMs?: number
  ): Promise<void> {
    return waitForClusterDeleted.call(this, logicalId, cacheClusterId, maxWaitMs);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create-only seeds DescribeCacheClusters has no member for (go-to-k/cdkd#5635):
   * `readCurrentState` never emits them, so a drift run whose baseline is the
   * template `properties` (a record with no observed capture) would report
   * them as removed from AWS on every run.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    return resourceType === 'AWS::ElastiCache::CacheCluster'
      ? ['SnapshotArns', 'SnapshotName']
      : [];
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  readCacheCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCacheCluster.call(this, physicalId);
  }

  readSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readSubnetGroup.call(this, physicalId);
  }

  attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    return attachTags.call(this, result, arn);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  importCacheCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importCacheCluster.call(this, input);
  }

  importSubnetGroup(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importSubnetGroup.call(this, input);
  }
}
