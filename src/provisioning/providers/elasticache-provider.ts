import {
  ElastiCacheClient,
  CreateCacheClusterCommand,
  DeleteCacheClusterCommand,
  DescribeCacheClustersCommand,
  DescribeCacheSubnetGroupsCommand,
  CreateCacheSubnetGroupCommand,
  DeleteCacheSubnetGroupCommand,
  ModifyCacheSubnetGroupCommand,
  ModifyCacheClusterCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  type AZMode,
  type LogDeliveryConfigurationRequest,
  type NetworkType,
  type IpDiscovery,
} from '@aws-sdk/client-elasticache';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { clearOnUpdateRemoval, withRemovalDefaults } from '../update-removal.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import {
  planTagDiff,
  readTagList,
  tagPlanWarning,
  refuseMalformedDesiredTags,
} from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { slowCcOperationTimeoutMs } from '../slow-cc-operation-timeouts.js';

/**
 * How long a cache-cluster delete waits for the cluster to be gone: the Cloud
 * Control route's own DELETE floor for the type. A Redis delete can pass ten
 * minutes, and a timeout here left the cluster `deleting` with the delete
 * reported failed (issue #4029, measured by `cc-final-snapshot-handlers`).
 */
const CACHE_DELETE_WAIT_MS = Math.max(
  600_000,
  slowCcOperationTimeoutMs('AWS::ElastiCache::CacheCluster', 'DELETE')
);

/**
 * A cache cluster id: a letter, then letters, digits and single hyphens, not
 * ending in one, at most 50 characters. Either case, as a template may spell
 * it (ElastiCache stores it lower-cased and matches it in any case).
 */
function isCacheClusterId(id: string): boolean {
  return id.length <= 50 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

/**
 * go-to-k/cdkd#4655: a cache cluster's identity token, `<ARN>@<epoch ms of
 * CacheClusterCreateTime>`, or `undefined` when the answer lacks either. The
 * ARN is built from the (lower-cased) cluster id, so a cluster re-created
 * under the id repeats it; the creation time is what tells the two apart.
 */
function cacheClusterToken(
  cluster: { ARN?: string | undefined; CacheClusterCreateTime?: Date | undefined } | undefined
): string | undefined {
  const arn = cluster?.ARN;
  const created = cluster?.CacheClusterCreateTime;
  if (typeof arn !== 'string' || arn === '') return undefined;
  if (!(created instanceof Date) || Number.isNaN(created.getTime())) return undefined;
  return `${arn}@${created.getTime()}`;
}

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
  private logger = getLogger().child('ElastiCacheProvider');

  /**
   * Issue #1160: the CFn default a property REMOVED from the template is
   * reset to — the Modify/Update API keeps an absent field's live value.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::ElastiCache::CacheCluster',
      new Map<string, unknown>([['AutoMinorVersionUpgrade', true]]),
    ],
  ]);

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

  private getClient(): ElastiCacheClient {
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
  private getCreateClient(): ElastiCacheClient {
    this.getClient();
    return this.createClient as ElastiCacheClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ElastiCache::SubnetGroup':
        return this.createSubnetGroup(logicalId, resourceType, properties);
      case 'AWS::ElastiCache::CacheCluster':
        return this.createCacheCluster(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    switch (resourceType) {
      case 'AWS::ElastiCache::SubnetGroup':
        return this.updateSubnetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ElastiCache::CacheCluster':
        return this.updateCacheCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ElastiCache::SubnetGroup':
        return this.deleteSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::ElastiCache::CacheCluster':
        return this.deleteCacheCluster(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── SubnetGroup ──────────────────────────────────────────────────

  private async createSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CacheSubnetGroup ${logicalId}`);
    // go-to-k/cdkd#3994: `Tags` was declared handled and never sent; a
    // malformed one is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const cacheSubnetGroupName =
      (properties['CacheSubnetGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255, lowercase: true });

    try {
      await this.getCreateClient().send(
        new CreateCacheSubnetGroupCommand({
          CacheSubnetGroupName: cacheSubnetGroupName,
          // CFn schema spells the description field `Description`; AWS API
          // expects `CacheSubnetGroupDescription`. Accept both keys from the
          // template and prefer the CFn-canonical name.
          CacheSubnetGroupDescription:
            (properties['Description'] as string | undefined) ??
            (properties['CacheSubnetGroupDescription'] as string | undefined) ??
            `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(
        `Successfully created CacheSubnetGroup ${logicalId}: ${cacheSubnetGroupName}`
      );

      return {
        physicalId: cacheSubnetGroupName,
        attributes: {
          CacheSubnetGroupName: cacheSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CacheSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        cacheSubnetGroupName,
        cause
      );
    }
  }

  private async updateSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CacheSubnetGroup ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // #1160 reset-on-removal — ModifyCacheSubnetGroup has merge semantics
      // (an absent CacheSubnetGroupDescription means "no change"), so a
      // description REMOVED from the template must be sent explicitly.
      // Reset value: the same `Subnet group for ${logicalId}` default that
      // `createSubnetGroup` synthesizes when the template omits the
      // description, keeping create/update parity. (CFn marks `Description`
      // required on AWS::ElastiCache::SubnetGroup, so a removal is
      // CFn-invalid anyway — but cdkd's create path tolerates the absence
      // with this default, and update must not silently keep the old value.)
      const modified = await this.getClient().send(
        new ModifyCacheSubnetGroupCommand({
          CacheSubnetGroupName: physicalId,
          CacheSubnetGroupDescription: clearOnUpdateRemoval(
            (properties['Description'] as string | undefined) ??
              (properties['CacheSubnetGroupDescription'] as string | undefined),
            (previousProperties['Description'] as string | undefined) ??
              (previousProperties['CacheSubnetGroupDescription'] as string | undefined),
            `Subnet group for ${logicalId}`
          ),
          SubnetIds: properties['SubnetIds'] as string[],
        })
      );

      // Apply the tag diff (go-to-k/cdkd#3994: `Tags` used to be ignored on
      // update). A group created before that fix never received its recorded
      // tags, so the diff is checked against the group's LIVE tag set: see
      // `applySubnetGroupTagDiff`. ModifyCacheSubnetGroup returns the ARN.
      if (properties['Tags'] != null || previousProperties['Tags'] != null) {
        const subnetGroupArn = modified.CacheSubnetGroup?.ARN;
        if (!subnetGroupArn) {
          throw new ProvisioningError(
            safeMsg`Could not resolve the ARN of CacheSubnetGroup ${logicalId}; its Tags were not updated`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        const live = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceName: subnetGroupArn })
        );
        await this.applySubnetGroupTagDiff(
          subnetGroupArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags'],
          normalizeAwsTagsToCfn(live.TagList)
        );
      }

      this.logger.debug(`Successfully updated CacheSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          CacheSubnetGroupName: physicalId,
        },
      };
    } catch (error) {
      // cdkd's own refusal (the missing-ARN one above) passes through as it is.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CacheSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CacheSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteCacheSubnetGroupCommand({
          CacheSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted CacheSubnetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error, 'CacheSubnetGroupNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`CacheSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CacheSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── CacheCluster ────────────────────────────────────────────────

  private async createCacheCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CacheCluster ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const cacheClusterId =
      (properties['ClusterName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 40, lowercase: true });

    // go-to-k/cdkd#4583: set once CreateCacheCluster returned (no self-cleanup).
    let clusterCreated = false;
    // go-to-k/cdkd#4655: the token CreateCacheCluster's answer, or a later
    // available-wait poll, names, carried on the failure's mark. Only from an
    // answer holding both the ARN and the creation time (a cluster still
    // being created may answer without the latter); with none, the deploy
    // engine's write-side read tries.
    let createdIdentity: string | undefined;
    try {
      const createResponse = await this.getCreateClient().send(
        new CreateCacheClusterCommand({
          CacheClusterId: cacheClusterId,
          Engine: properties['Engine'] as string,
          CacheNodeType: properties['CacheNodeType'] as string,
          NumCacheNodes:
            properties['NumCacheNodes'] != null ? Number(properties['NumCacheNodes']) : undefined,
          CacheSubnetGroupName: properties['CacheSubnetGroupName'] as string | undefined,
          SecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          CacheParameterGroupName: properties['CacheParameterGroupName'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AZMode: properties['AZMode'] as AZMode | undefined,
          PreferredAvailabilityZone: properties['PreferredAvailabilityZone'] as string | undefined,
          PreferredAvailabilityZones: properties['PreferredAvailabilityZones'] as
            | string[]
            | undefined,
          SnapshotRetentionLimit:
            properties['SnapshotRetentionLimit'] != null
              ? Number(properties['SnapshotRetentionLimit'])
              : undefined,
          SnapshotWindow: properties['SnapshotWindow'] as string | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          NotificationTopicArn: properties['NotificationTopicArn'] as string | undefined,
          SnapshotName: properties['SnapshotName'] as string | undefined,
          LogDeliveryConfigurations: properties['LogDeliveryConfigurations'] as
            | LogDeliveryConfigurationRequest[]
            | undefined,
          NetworkType: properties['NetworkType'] as NetworkType | undefined,
          IpDiscovery: properties['IpDiscovery'] as IpDiscovery | undefined,
          TransitEncryptionEnabled: properties['TransitEncryptionEnabled'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      clusterCreated = true;
      createdIdentity = cacheClusterToken(createResponse.CacheCluster);

      this.logger.debug(`Successfully created CacheCluster ${logicalId}: ${cacheClusterId}`);

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(cacheClusterId, undefined, (cluster) => {
          if (cluster?.CacheClusterId?.toLowerCase() !== cacheClusterId.toLowerCase()) return;
          // The first answer naming one wins: a later one never replaces it.
          createdIdentity ??= cacheClusterToken(cluster);
        });
      }

      // Describe to get final attributes
      const described = await this.describeCacheCluster(cacheClusterId);

      const attributes: Record<string, unknown> = {};

      // Redis endpoint attributes
      if (described?.CacheNodes?.[0]?.Endpoint) {
        const endpoint = described.CacheNodes[0].Endpoint;
        if (endpoint.Address !== undefined) attributes['RedisEndpoint.Address'] = endpoint.Address;
        if (endpoint.Port !== undefined) attributes['RedisEndpoint.Port'] = String(endpoint.Port);
      }

      // Configuration endpoint (for Memcached clusters)
      if (described?.ConfigurationEndpoint) {
        const configurationEndpoint = described.ConfigurationEndpoint;
        if (configurationEndpoint.Address !== undefined) {
          attributes['ConfigurationEndpoint.Address'] = configurationEndpoint.Address;
        }
        if (configurationEndpoint.Port !== undefined) {
          attributes['ConfigurationEndpoint.Port'] = String(configurationEndpoint.Port);
        }
      }

      return {
        physicalId: cacheClusterId,
        attributes,
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : new ProvisioningError(
              `Failed to create CacheCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
              resourceType,
              logicalId,
              cacheClusterId,
              error instanceof Error ? error : undefined
            );
      // go-to-k/cdkd#4583: the cluster exists and no state record will hold
      // it; never before CreateCacheCluster returned (another owner's name).
      if (clusterCreated) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, cacheClusterId, createdIdentity);
      }
      throw thrown;
    }
  }

  private async updateCacheCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CacheCluster ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // Class 2 sanitization: `readCurrentState` always-emits
      // `VpcSecurityGroupIds: []` for clusters without VPC SGs (legacy
      // EC2-Classic, or transient state). Round-tripping an empty array
      // through `ModifyCacheClusterCommand.SecurityGroupIds` makes AWS
      // reject with "must specify at least one security group" — pass
      // `undefined` instead so AWS treats the field as "no change".
      // Drift detection is unaffected: state `[]` vs AWS `[sg-1]` still
      // surfaces as drift on the read side.
      const rawSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
      const sgIds = rawSgIds && rawSgIds.length > 0 ? rawSgIds : undefined;

      // #1160 reset-on-removal — ModifyCacheCluster has merge semantics (an
      // absent input field means "no change"), so a property REMOVED from
      // the template must be sent as its explicit CFn-default reset value
      // via `removalDefaults` or a local `clearOnUpdateRemoval`. Deliberately
      // NOT reset here:
      //   * EngineVersion — removal would imply moving to the engine's
      //     default version, a risky version change cdkd must not
      //     synthesize (ModifyCacheClusterMessage doc: downgrade is
      //     impossible without recreate); leave unchanged.
      //   * CacheParameterGroupName — the `default.<family>` name is
      //     engine + version dependent; synthesizing it risks targeting the
      //     wrong family (RDS-batch analog, #1222).
      //   * PreferredMaintenanceWindow / SnapshotWindow — AWS assigns a
      //     random per-cluster window when omitted; no documented reset
      //     sentinel exists, so removal keeps the current window.
      //   * IpDiscovery — a removal is only meaningful on `dual_stack`
      //     clusters (ipv4 / ipv6 NetworkType forces the matching value),
      //     and AWS does not document the dual-stack default; a wrong reset
      //     flips client DNS resolution, so leave unchanged.
      //   * VpcSecurityGroupIds — deliberate empty-guard above
      //     (readCurrentState placeholder defense); classified UNCERTAIN in
      //     the #1160 audit, out of this batch's scope.

      // NotificationTopicArn has no "clear to empty" input; the documented
      // disable sentinel is NotificationTopicStatus=inactive
      // (ModifyCacheClusterMessage doc: "Notifications are sent only if the
      // status is active"). On removal keep the ARN absent and send the
      // inactive status; when an ARN is present, send active explicitly so
      // re-adding a topic after a removal reactivates delivery.
      const notificationTopicArn = properties['NotificationTopicArn'] as string | undefined;
      // `!= null` (not `!== undefined`) so an explicit-null / never-really-set
      // previous side does not fire a spurious inactive sentinel — matches the
      // numeric fields' previous-side checks below (PR #1256 review nit).
      const notificationRemoved =
        notificationTopicArn === undefined && previousProperties['NotificationTopicArn'] != null;

      await this.getClient().send(
        new ModifyCacheClusterCommand({
          CacheClusterId: physicalId,
          NumCacheNodes:
            properties['NumCacheNodes'] != null ? Number(properties['NumCacheNodes']) : undefined,
          SecurityGroupIds: sgIds,
          CacheParameterGroupName: properties['CacheParameterGroupName'] as string | undefined,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          // CFn default: 0 — automatic backups off (SnapshotRetentionLimit
          // doc: "If the value ... is set to zero (0), backups are turned
          // off").
          SnapshotRetentionLimit: clearOnUpdateRemoval(
            properties['SnapshotRetentionLimit'] != null
              ? Number(properties['SnapshotRetentionLimit'])
              : undefined,
            previousProperties['SnapshotRetentionLimit'] != null
              ? Number(previousProperties['SnapshotRetentionLimit'])
              : undefined,
            0
          ),
          SnapshotWindow: properties['SnapshotWindow'] as string | undefined,
          // Service default when omitted at create: enabled (live-verified
          // 2026-07-27 — a bare CreateCacheCluster reports
          // AutoMinorVersionUpgrade=true on DescribeCacheClusters).
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          NotificationTopicArn: notificationTopicArn,
          ...(notificationRemoved && { NotificationTopicStatus: 'inactive' }),
          ...(notificationTopicArn !== undefined && {
            NotificationTopicStatus: 'active',
          }),
          // Per-LogType merge semantics: each request entry modifies ONLY
          // its own LogType, so a log type dropped from the template (or the
          // whole property removed) must be sent as an explicit
          // `{ LogType, Enabled: false }` disable entry
          // (LogDeliveryConfigurationRequest doc: "Specify if log delivery
          // is enabled. Default true.").
          LogDeliveryConfigurations: this.buildLogDeliveryConfigurationsForUpdate(
            properties['LogDeliveryConfigurations'] as
              | LogDeliveryConfigurationRequest[]
              | undefined,
            previousProperties['LogDeliveryConfigurations'] as
              | LogDeliveryConfigurationRequest[]
              | undefined
          ),
          IpDiscovery: properties['IpDiscovery'] as IpDiscovery | undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated CacheCluster ${logicalId}`);

      // Wait for cluster to become available after modification
      await this.waitForClusterAvailable(physicalId);

      // Describe to get updated attributes
      const described = await this.describeCacheCluster(physicalId);

      // Apply tag diff. ElastiCache uses ARN-keyed AddTagsToResource /
      // RemoveTagsFromResource.
      if (described?.ARN) {
        await this.applyTagDiff(
          described.ARN,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      const attributes: Record<string, unknown> = {};

      if (described?.CacheNodes?.[0]?.Endpoint) {
        const endpoint = described.CacheNodes[0].Endpoint;
        if (endpoint.Address !== undefined) attributes['RedisEndpoint.Address'] = endpoint.Address;
        if (endpoint.Port !== undefined) attributes['RedisEndpoint.Port'] = String(endpoint.Port);
      }

      if (described?.ConfigurationEndpoint) {
        const configurationEndpoint = described.ConfigurationEndpoint;
        if (configurationEndpoint.Address !== undefined) {
          attributes['ConfigurationEndpoint.Address'] = configurationEndpoint.Address;
        }
        if (configurationEndpoint.Port !== undefined) {
          attributes['ConfigurationEndpoint.Port'] = String(configurationEndpoint.Port);
        }
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CacheCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteCacheCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CacheCluster ${logicalId}`);

    try {
      // `DeletionPolicy: Snapshot` (issue #1352): pass the atomic
      // final-snapshot parameter when the destroy call site passed an id.
      // ElastiCache only supports snapshots on Redis-engine clusters; a
      // Memcached cluster under `Snapshot` gets AWS's InvalidParameter
      // rejection surfaced as-is — matching CloudFormation's DELETE_FAILED
      // for the same template.
      const finalSnapshotId = context?.finalSnapshotIdentifier;
      try {
        await this.getClient().send(
          new DeleteCacheClusterCommand({
            CacheClusterId: physicalId,
            ...(finalSnapshotId ? { FinalSnapshotIdentifier: finalSnapshotId } : {}),
          })
        );
      } catch (deleteError) {
        // A delete already under way (an earlier attempt whose wait ran out)
        // is waited on, not failed: AWS refuses a second DeleteCacheCluster
        // with InvalidCacheClusterState. Confirmed by the cluster's STATUS,
        // never by the message. NOT when this delete asked for a final
        // snapshot: the delete in flight never took THIS request, so waiting
        // on it would report a snapshot that may not exist (#1352).
        if (
          finalSnapshotId !== undefined ||
          (deleteError as { name?: string } | undefined)?.name !==
            'InvalidCacheClusterStateFault' ||
          (await this.describeCacheCluster(physicalId))?.CacheClusterStatus !== 'deleting'
        ) {
          throw deleteError;
        }
        this.logger.debug(safeMsg`CacheCluster ${logicalId} is already deleting; waiting for it`);
      }
      // Not the identifier: it embeds the physical id, which may be secret-derived
      // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/cli-destroy.md).
      if (finalSnapshotId) {
        this.logger.info(
          `Deleting CacheCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
        );
      }

      this.logger.debug(`Successfully initiated deletion of CacheCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(logicalId, physicalId, CACHE_DELETE_WAIT_MS);
    } catch (error) {
      if (this.isNotFoundError(error, 'CacheClusterNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  ElastiCache cache cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`CacheCluster ${logicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CacheCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Build the `LogDeliveryConfigurations` input for ModifyCacheCluster so a
   * log type REMOVED from the template is explicitly disabled (issue #1160).
   *
   * ModifyCacheCluster applies each request entry to ONLY its own LogType
   * (per-entry merge semantics), so both a whole-property removal and a
   * per-entry removal would silently keep the live delivery config. The
   * documented disable sentinel is `{ LogType, Enabled: false }`
   * (LogDeliveryConfigurationRequest doc: "Specify if log delivery is
   * enabled. Default true."). Kept / added entries pass through unchanged;
   * previously-configured log types missing from the new template get a
   * disable entry appended. Returns `undefined` when there is nothing to
   * send (no change).
   */
  private buildLogDeliveryConfigurationsForUpdate(
    newConfigs: LogDeliveryConfigurationRequest[] | undefined,
    previousConfigs: LogDeliveryConfigurationRequest[] | undefined
  ): LogDeliveryConfigurationRequest[] | undefined {
    const kept = newConfigs ?? [];
    const keptLogTypes = new Set(
      kept.map((c) => c.LogType).filter((t): t is NonNullable<typeof t> => t !== undefined)
    );
    const disables: LogDeliveryConfigurationRequest[] = (previousConfigs ?? [])
      .filter((c) => c.LogType !== undefined && !keptLogTypes.has(c.LogType))
      .map((c) => ({ LogType: c.LogType, Enabled: false }));
    const merged = [...kept, ...disables];
    return merged.length > 0 ? merged : undefined;
  }

  /**
   * The subnet group's tag diff (go-to-k/cdkd#3994). REMOVALS come from the
   * record, as everywhere else, so a tag cdkd never recorded (an operator's,
   * a tag policy's) is never untagged; the LIVE set only narrows them to keys
   * AWS actually holds (no `TagNotFoundFault` for a group created before the
   * fix, which never received its recorded tags). ADDS are every desired tag
   * whose live value differs, so such a group gets its tags now.
   */
  private async applySubnetGroupTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    liveTags: Array<{ Key: string; Value: string }>
  ): Promise<void> {
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const live = new Map(liveTags.map((t) => [t.Key, t.Value]));
    const desired = readTagList(newTagsRaw, 'desired');
    const tagsToAdd =
      desired.kind === 'tags' ? desired.tags.filter((t) => live.get(t.Key) !== t.Value) : [];
    const tagsToRemove = plan.remove.filter((k) => live.has(k));
    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromResourceCommand({
          ResourceName: arn,
          TagKeys: tagsToRemove,
        })
      );
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via ElastiCache's
   * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
   * `ResourceName=arn`).
   */
  private async applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    // go-to-k/cdkd#3994: both sides are read through `planTagDiff`; an
    // unreadable record untags nothing.
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromResourceCommand({
          ResourceName: arn,
          TagKeys: tagsToRemove,
        })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from ElastiCache resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on ElastiCache resource ${arn}`);
    }
  }

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName || message.includes('not found') || message.includes('does not exist')
    );
  }

  private async describeCacheCluster(cacheClusterId: string) {
    const response = await this.getClient().send(
      new DescribeCacheClustersCommand({
        CacheClusterId: cacheClusterId,
        ShowCacheNodeInfo: true,
      })
    );
    return response.CacheClusters?.[0];
  }

  /**
   * Wait for a CacheCluster to become available. `onCluster` sees each
   * poll's answer (go-to-k/cdkd#4655: the create path takes the identity
   * token from it, so a later poll that fails still leaves the token).
   */
  private async waitForClusterAvailable(
    cacheClusterId: string,
    maxWaitMs = 600_000,
    onCluster?: (cluster: Awaited<ReturnType<ElastiCacheProvider['describeCacheCluster']>>) => void
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeCacheCluster(cacheClusterId);
      onCluster?.(cluster);
      const status = cluster?.CacheClusterStatus;

      this.logger.debug(`CacheCluster ${cacheClusterId} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for CacheCluster ${cacheClusterId} to become available`);
  }

  /**
   * Wait for a CacheCluster to be deleted
   */
  private async waitForClusterDeleted(
    logicalId: string,
    cacheClusterId: string,
    maxWaitMs = 600_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeCacheCluster(cacheClusterId);
        const status = cluster?.CacheClusterStatus;

        this.logger.debug(`CacheCluster ${logicalId} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'CacheClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for CacheCluster ${logicalId} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Read the AWS-current ElastiCache resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `CacheCluster` → `DescribeCacheClusters` filtered by `CacheClusterId`,
   *    surfacing `Engine`, `CacheNodeType`, `NumCacheNodes`,
   *    `CacheSubnetGroupName`, `Port`, `EngineVersion`,
   *    `CacheParameterGroupName`, `PreferredMaintenanceWindow`,
   *    `PreferredAvailabilityZone`, `SnapshotRetentionLimit`,
   *    `SnapshotWindow`, `AutoMinorVersionUpgrade`, `NotificationTopicArn`,
   *    `IpDiscovery`, `NetworkType`, `TransitEncryptionEnabled`, plus
   *    `VpcSecurityGroupIds` derived from the cluster's `SecurityGroups[]`.
   *  - `SubnetGroup` → `DescribeCacheSubnetGroups` filtered by name,
   *    surfacing `CacheSubnetGroupName`, `CacheSubnetGroupDescription`,
   *    and `SubnetIds` derived from `Subnets[].SubnetIdentifier`.
   *
   * Tags are surfaced via a follow-up `ListTagsForResource(ResourceName=arn)`
   * for both types (ARN derived from `cluster.ARN` / `group.ARN`). CDK's
   * `aws:*` auto-tags are filtered out and the result key is omitted when
   * AWS reports no user tags. Returns `RESOURCE_NOT_FOUND` when the resource
   * is gone (`*NotFoundFault` or an empty describe list).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::ElastiCache::CacheCluster':
        return this.readCacheCluster(physicalId);
      case 'AWS::ElastiCache::SubnetGroup':
        return this.readSubnetGroup(physicalId);
      default:
        return undefined;
    }
  }

  /**
   * go-to-k/cdkd#4606: whether the cache cluster a failed CREATE journaled is
   * the one the record under the same logical id holds (a fix-forward that
   * created a new one there under another cluster id).
   *
   * Reached on the SDK route only (Cloud Control's provider has no
   * `isSameResource`, so a Cloud Control-routed orphan is `'unknown'`). Both
   * ids must be cache cluster ids; an ARN or anything else is `'unknown'`, as
   * is a SubnetGroup. A cluster id names at most one cluster per account and
   * region at a time, a cluster cannot be renamed, and ElastiCache matches ids
   * case-insensitively (it stores them lower-cased), so two spellings equal
   * modulo case are `'same'` without a read: whatever holds that id now is
   * the record's cluster. After the region check the record's cluster must
   * read back (else `'unknown'`); the journaled one is `'same'` when it reads
   * back under the record's ARN, `'different'` under another, and
   * `'different'` when AWS reports it gone: the record's cluster answers to
   * its own, other, id, so the gone one cannot name it, and its delete
   * settles as already gone.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::ElastiCache::CacheCluster') return 'unknown';
    if (!isCacheClusterId(journaledPhysicalId) || !isCacheClusterId(record.physicalId)) {
      return 'unknown';
    }
    if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'same';
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordCluster = await this.readCacheClusterIfExists(record.physicalId);
    if (recordCluster === undefined) return 'unknown';
    const journaledCluster = await this.readCacheClusterIfExists(journaledPhysicalId);
    if (journaledCluster === undefined) return 'different';
    return journaledCluster.arn === recordCluster.arn ? 'same' : 'different';
  }

  /**
   * go-to-k/cdkd#4655: the cluster's ARN and creation time, `<arn>@<epoch
   * ms>`. ElastiCache generates no immutable id for a cache cluster, and the
   * ARN is built from the cluster id, so a cluster re-created under the id
   * (in any case spelling) repeats it; the creation time is what tells the
   * two apart, so the settle keeps such a cluster rather than deleting it as
   * the failed CREATE's orphan.
   *
   * `undefined` for another type, an id that is not a cache cluster id, a
   * client in another region than `expectedRegion`, and an answer without
   * both fields (`CacheClusterCreateTime` may be absent while the cluster is
   * still being created). `RESOURCE_NOT_FOUND` only on the describe's
   * not-found fault NAME (or an empty list); any other failure throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::ElastiCache::CacheCluster') return undefined;
    if (!isCacheClusterId(physicalId)) return undefined;
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const live = await this.readCacheClusterIfExists(physicalId);
    if (live === undefined) return RESOURCE_NOT_FOUND;
    return live.token;
  }

  /**
   * The cluster's ARN (and its identity token, when the answer carries the
   * creation time), or `undefined` when AWS reports the id gone (its
   * not-found fault NAME, or an empty describe list). Any other failure, an
   * answer naming another cluster id and one naming no ARN throw: "could not
   * read" never reads as "gone".
   */
  private async readCacheClusterIfExists(
    cacheClusterId: string
  ): Promise<{ arn: string; token: string | undefined } | undefined> {
    let cluster;
    try {
      const response = await this.getClient().send(
        new DescribeCacheClustersCommand({ CacheClusterId: cacheClusterId })
      );
      cluster = response.CacheClusters?.[0];
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'CacheClusterNotFoundFault') {
        return undefined;
      }
      throw error;
    }
    if (cluster === undefined) return undefined;
    if (cluster.CacheClusterId?.toLowerCase() !== cacheClusterId.toLowerCase()) {
      throw new Error('DescribeCacheClusters answered for another cluster id');
    }
    if (typeof cluster.ARN !== 'string' || cluster.ARN === '') {
      throw new Error('DescribeCacheClusters returned no ARN');
    }
    return { arn: cluster.ARN, token: cacheClusterToken(cluster) };
  }

  private async readCacheCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let cluster;
    try {
      const resp = await this.getClient().send(
        new DescribeCacheClustersCommand({
          CacheClusterId: physicalId,
          ShowCacheNodeInfo: true,
        })
      );
      cluster = resp.CacheClusters?.[0];
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'CacheClusterNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'CacheClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (cluster.CacheClusterId !== undefined) result['ClusterName'] = cluster.CacheClusterId;
    if (cluster.Engine !== undefined) result['Engine'] = cluster.Engine;
    if (cluster.CacheNodeType !== undefined) result['CacheNodeType'] = cluster.CacheNodeType;
    if (cluster.NumCacheNodes !== undefined) result['NumCacheNodes'] = cluster.NumCacheNodes;
    if (cluster.CacheSubnetGroupName !== undefined) {
      result['CacheSubnetGroupName'] = cluster.CacheSubnetGroupName;
    }
    if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
    if (cluster.CacheParameterGroup?.CacheParameterGroupName !== undefined) {
      result['CacheParameterGroupName'] = cluster.CacheParameterGroup.CacheParameterGroupName;
    }
    if (cluster.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
    }
    if (cluster.PreferredAvailabilityZone !== undefined) {
      result['PreferredAvailabilityZone'] = cluster.PreferredAvailabilityZone;
    }
    if (cluster.SnapshotRetentionLimit !== undefined) {
      result['SnapshotRetentionLimit'] = cluster.SnapshotRetentionLimit;
    }
    if (cluster.SnapshotWindow !== undefined) result['SnapshotWindow'] = cluster.SnapshotWindow;
    if (cluster.AutoMinorVersionUpgrade !== undefined) {
      result['AutoMinorVersionUpgrade'] = cluster.AutoMinorVersionUpgrade;
    }
    // AWS keeps the topic ARN visible on DescribeCacheClusters after the
    // #1160 removal reset (NotificationTopicStatus=inactive) — semantically
    // "no notification topic configured" — so gate the emit on the status
    // to keep the post-removal read round-trip clean.
    if (
      cluster.NotificationConfiguration?.TopicArn !== undefined &&
      cluster.NotificationConfiguration.TopicStatus !== 'inactive'
    ) {
      result['NotificationTopicArn'] = cluster.NotificationConfiguration.TopicArn;
    }
    if (cluster.IpDiscovery !== undefined) result['IpDiscovery'] = cluster.IpDiscovery;
    if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
    // Class 1 gate: `TransitEncryptionEnabled` is redis-only on
    // CreateCacheClusterCommand. AWS DescribeCacheClusters returns the
    // field for both engines (false for memcached), but emitting it on
    // a memcached cluster would, if any future `update()` change ships
    // it to ModifyCacheClusterCommand, get rejected with "TransitEncryption
    // is only valid for Redis". Gate the read-side emit on the engine
    // discriminator so the placeholder cannot leak through round-trip.
    if (cluster.Engine === 'redis' && cluster.TransitEncryptionEnabled !== undefined) {
      result['TransitEncryptionEnabled'] = cluster.TransitEncryptionEnabled;
    }
    if (cluster.CacheNodes?.[0]?.Endpoint?.Port !== undefined) {
      result['Port'] = cluster.CacheNodes[0].Endpoint.Port;
    }
    const sgIds = (cluster.SecurityGroups ?? [])
      .map((sg) => sg.SecurityGroupId)
      .filter((id): id is string => !!id);
    result['VpcSecurityGroupIds'] = sgIds;

    if (cluster.ARN) await this.attachTags(result, cluster.ARN);
    return result;
  }

  private async readSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let group;
    try {
      const resp = await this.getClient().send(
        new DescribeCacheSubnetGroupsCommand({
          CacheSubnetGroupName: physicalId,
        })
      );
      group = resp.CacheSubnetGroups?.[0];
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'CacheSubnetGroupNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'CacheSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    if (!group) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (group.CacheSubnetGroupName !== undefined) {
      result['CacheSubnetGroupName'] = group.CacheSubnetGroupName;
    }
    if (group.CacheSubnetGroupDescription !== undefined) {
      // CFn schema spells the description `Description`; AWS API uses
      // `CacheSubnetGroupDescription`. Emit BOTH so drift comparison
      // works for state files written by either name (#613 B-bucket fix).
      result['CacheSubnetGroupDescription'] = group.CacheSubnetGroupDescription;
      result['Description'] = group.CacheSubnetGroupDescription;
    }
    const subnetIds = (group.Subnets ?? [])
      .map((s) => s.SubnetIdentifier)
      .filter((id): id is string => !!id);
    result['SubnetIds'] = subnetIds;
    if (group.ARN) await this.attachTags(result, group.ARN);
    return result;
  }

  /** Best-effort tag fetch — failures omit the key without breaking the read. */
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceName: arn })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `ElastiCache ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
      );
    }
  }

  /**
   * Adopt an existing ElastiCache resource into cdkd state.
   *
   * Supported types (both resolve from an explicit `--resource` override
   * or the template's physical-name property, verified via the matching
   * `Describe*` call):
   *  - `AWS::ElastiCache::CacheCluster` — `Properties.ClusterName`.
   *  - `AWS::ElastiCache::SubnetGroup` — `Properties.CacheSubnetGroupName`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::ElastiCache::CacheCluster':
        return this.importCacheCluster(input);
      case 'AWS::ElastiCache::SubnetGroup':
        return this.importSubnetGroup(input);
      default:
        return null;
    }
  }

  private async importCacheCluster(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'ClusterName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeCacheClustersCommand({ CacheClusterId: explicit })
        );
        const c = resp.CacheClusters?.[0];
        return c?.CacheClusterId ? { physicalId: c.CacheClusterId, attributes: {} } : null;
      } catch (err) {
        if (this.isNotFoundError(err, 'CacheClusterNotFoundFault')) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // cache cluster reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importSubnetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'CacheSubnetGroupName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeCacheSubnetGroupsCommand({
            CacheSubnetGroupName: explicit,
          })
        );
        const g = resp.CacheSubnetGroups?.[0];
        return g?.CacheSubnetGroupName
          ? { physicalId: g.CacheSubnetGroupName, attributes: {} }
          : null;
      } catch (err) {
        if (this.isNotFoundError(err, 'CacheSubnetGroupNotFoundFault')) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // subnet group reaching here needs an explicit `--resource` override.
    return null;
  }
}
