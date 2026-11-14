import type { ElastiCacheProvider } from '../elasticache-provider.js';
import {
  ModifyCacheClusterCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  type AZMode,
  type LogDeliveryConfigurationRequest,
  type IpDiscovery,
} from '@aws-sdk/client-elasticache';
import { isDeepStrictEqual } from 'node:util';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import {
  NODE_TYPE_MODIFY_WAIT_MS,
  availabilityZonesNotCovered,
  nodesToRemove,
  KEPT_ON_REMOVAL,
  PLACEMENT_ON_REMOVAL,
  removalWarnings,
} from './shared.js';
import { cacheClusterAttributes } from './cache-cluster-attributes.js';

export async function updateCacheCluster(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask?: MaskerFn,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating CacheCluster ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // An absent or empty desired `VpcSecurityGroupIds` sends no
    // `SecurityGroupIds` (an absent Modify member = unchanged), so the
    // cluster keeps its live groups. That is what CloudFormation does
    // (#5491, real CloudFormation A/B, us-east-1, a redis cluster in a VPC
    // with one template security group): removing the property sent a
    // ModifyCacheCluster with no `securityGroupIds`, `[]` sent
    // `securityGroupIds: []`, and in both the cluster kept the group.
    // `undefined` for `[]` also covers `readCurrentState`, which always
    // emits `VpcSecurityGroupIds: []` for a cluster without VPC groups.
    // Drift detection is unaffected: state `[]` vs AWS `[sg-1]` still
    // surfaces as drift on the read side.
    const rawSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
    const sgIds = rawSgIds && rawSgIds.length > 0 ? rawSgIds : undefined;

    // #1160 reset-on-removal — ModifyCacheCluster has merge semantics (an
    // absent input field means "no change"), so a removed property is
    // sent as an explicit reset ONLY where CloudFormation resets it
    // (LogDeliveryConfigurations; see #5004 below). Every other mutable
    // property CloudFormation was measured to KEEP on removal, so it is
    // sent as absent and named in update()'s own warning
    // (KEPT_ON_REMOVAL; the #5545 A/B is recorded there).

    // #5004 (real CloudFormation A/B, us-east-1): CloudFormation KEEPS the
    // live value when SnapshotRetentionLimit, AutoMinorVersionUpgrade or
    // NotificationTopicArn is removed from the template, so a removed one
    // sends nothing (an absent Modify field = unchanged) -- in particular
    // no NotificationTopicStatus=inactive. The one measured RESET is
    // LogDeliveryConfigurations (CloudFormation disables delivery), below.
    const notificationTopicArn = properties['NotificationTopicArn'] as string | undefined;

    // go-to-k/cdkd#5438 (real CloudFormation runs, us-east-1, redis and
    // memcached): a CacheNodeType change is an in-place ModifyCacheCluster
    // with ApplyImmediately for both engines, same cluster id. CloudFormation
    // sends it on every update, so a cluster whose live type drifted from
    // the template is scaled back by the next update; an unchanged live type
    // is a no-op for AWS.
    const desiredNodeType = properties['CacheNodeType'] as string | undefined;
    const nodeChanges = await this.planNodeChanges(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties
    );
    const placement = nodeChanges.placement;
    this.warnNotAppliedInPlace(logicalId, properties, previousProperties, placement);

    await this.getClient().send(
      new ModifyCacheClusterCommand({
        CacheClusterId: physicalId,
        NumCacheNodes:
          properties['NumCacheNodes'] != null ? Number(properties['NumCacheNodes']) : undefined,
        ...(desiredNodeType !== undefined && { CacheNodeType: desiredNodeType }),
        ...(placement && {
          NewAvailabilityZones: placement.newAvailabilityZones,
          ...(placement.azMode !== undefined && { AZMode: placement.azMode }),
        }),
        ...(nodeChanges.removeIds.length > 0 && {
          CacheNodeIdsToRemove: nodeChanges.removeIds,
        }),
        SecurityGroupIds: sgIds,
        CacheParameterGroupName: properties['CacheParameterGroupName'] as string | undefined,
        EngineVersion: properties['EngineVersion'] as string | undefined,
        PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string | undefined,
        SnapshotRetentionLimit:
          properties['SnapshotRetentionLimit'] != null
            ? Number(properties['SnapshotRetentionLimit'])
            : undefined,
        SnapshotWindow: properties['SnapshotWindow'] as string | undefined,
        AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
        NotificationTopicArn: notificationTopicArn,
        ...(notificationTopicArn !== undefined && { NotificationTopicStatus: 'active' }),
        // #5004 A/B: CloudFormation DISABLES delivery on removal (RESET).
        // Per-LogType merge semantics: each request entry modifies ONLY
        // its own LogType, so a log type dropped from the template (or the
        // whole property removed) must be sent as an explicit
        // `{ LogType, Enabled: false }` disable entry
        // (LogDeliveryConfigurationRequest doc: "Specify if log delivery
        // is enabled. Default true.").
        LogDeliveryConfigurations: this.buildLogDeliveryConfigurationsForUpdate(
          properties['LogDeliveryConfigurations'] as LogDeliveryConfigurationRequest[] | undefined,
          previousProperties['LogDeliveryConfigurations'] as
            | LogDeliveryConfigurationRequest[]
            | undefined
        ),
        IpDiscovery: properties['IpDiscovery'] as IpDiscovery | undefined,
        ApplyImmediately: true,
      })
    );

    this.logger.debug(`Successfully updated CacheCluster ${logicalId}`);

    // Wait for cluster to become available after modification, and until
    // it REPORTS the template node type: the status can still read
    // `available` right after the Modify returns, and a scale measured about
    // ten minutes on cache.t4g, so this wait's cap is longer.
    if (desiredNodeType !== undefined || nodeChanges.removeIds.length > 0) {
      await this.waitForClusterAvailable(
        physicalId,
        NODE_TYPE_MODIFY_WAIT_MS,
        desiredNodeType,
        nodeChanges.removeIds
      );
    } else {
      await this.waitForClusterAvailable(physicalId);
    }

    // Describe to get updated attributes
    const described = await this.describeCacheCluster(physicalId);
    this.warnTransitEncryptionNotApplied(
      logicalId,
      properties,
      previousProperties,
      described?.TransitEncryptionEnabled
    );

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

    this.warnRemovalsLeftInPlace(logicalId, properties, previousProperties, context);

    const attributes = cacheClusterAttributes(described);

    return {
      physicalId,
      wasReplaced: false,
      attributes,
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update CacheCluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Warn when the template's `TransitEncryptionEnabled` changed and the
 * cluster does not have it (issue #5438): ModifyCacheCluster has no such
 * member, and a real CloudFormation update completed with encryption in
 * transit still off. An absent previous value is the create default
 * (`false`), so adding `false` is no change. `live` is the value the
 * post-update describe reports; when it reports none, the previous
 * template value stands in for it.
 */
export function warnTransitEncryptionNotApplied(
  this: ElastiCacheProvider,
  logicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  live: boolean | undefined
): void {
  const next = properties['TransitEncryptionEnabled'];
  if (next === undefined) return;
  const prev = previousProperties['TransitEncryptionEnabled'] ?? false;
  if (isDeepStrictEqual(next, prev)) return;
  const current = live ?? prev;
  if (isDeepStrictEqual(next, current)) return;
  const state = current === true ? 'ENABLED' : 'DISABLED';
  this.logger.warn(
    safeMsg`CacheCluster ${logicalId}: the cluster still has encryption in transit ${state} ` +
      safeMsg`(the template now says TransitEncryptionEnabled: ${String(next)}). ` +
      `ModifyCacheCluster cannot change it, and CloudFormation leaves it unchanged too; ` +
      `to change it, replace the cluster, for example by changing its logical ID.`
  );
}

/**
 * The node additions and removals an update sends, from one describe of
 * the live nodes (issues #5438, #5441). Real CloudFormation runs on
 * memcached, us-east-1:
 *
 * - Added nodes: CloudFormation sends `NewAvailabilityZones` -- the desired
 *   `PreferredAvailabilityZones` minus the zones the live nodes occupy --
 *   with the desired `AZMode`, and nothing when that difference is empty
 *   (1 node in us-east-1c to `[us-east-1c, us-east-1b]` sent
 *   `NewAvailabilityZones: [us-east-1b]`). A difference with no node added
 *   is sent as well, and AWS refuses it, as it refused CloudFormation's.
 * - Removed nodes: AWS refuses a lower `NumCacheNodes` without
 *   `CacheNodeIdsToRemove`. CloudFormation keeps the nodes with the HIGHEST
 *   ids and removes the rest, first any node in a zone the desired
 *   `PreferredAvailabilityZones` no longer lists (`nodesToRemove`).
 *
 * The describe is made only when the desired zone list or `NumCacheNodes`
 * changed from the previous template.
 */
export async function planNodeChanges(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Promise<{
  placement: { newAvailabilityZones: string[]; azMode: AZMode | undefined } | undefined;
  removeIds: string[];
}> {
  const none = { placement: undefined, removeIds: [] };
  const desiredZones = properties['PreferredAvailabilityZones'];
  const zones =
    Array.isArray(desiredZones) && desiredZones.length > 0 ? (desiredZones as string[]) : undefined;
  const countChanged =
    String(properties['NumCacheNodes']) !== String(previousProperties['NumCacheNodes']);
  if (
    !countChanged &&
    (zones === undefined ||
      isDeepStrictEqual(zones, previousProperties['PreferredAvailabilityZones']))
  ) {
    return none;
  }
  // Without a zone list, only a decrease needs the live nodes (their ids).
  if (
    zones === undefined &&
    !(Number(properties['NumCacheNodes']) < Number(previousProperties['NumCacheNodes']))
  ) {
    return none;
  }
  const live = await this.describeCacheCluster(physicalId);
  const liveNodes = (live?.CacheNodes ?? []).map((n) => ({
    id: n.CacheNodeId,
    zone: n.CustomerAvailabilityZone,
  }));
  const desiredCount =
    properties['NumCacheNodes'] != null ? Number(properties['NumCacheNodes']) : undefined;

  // Nodes are removed only when the TEMPLATE lowered the count (every
  // measured CloudFormation removal was one), and only from a cluster whose
  // live node count is the previous template count: a cluster scaled
  // outside the template would lose more nodes than the template change
  // asks for, so it is refused, never trimmed.
  const previousCount = Number(previousProperties['NumCacheNodes']);
  const templateLowered = Number(properties['NumCacheNodes']) < previousCount;
  let removeIds: string[] = [];
  if (templateLowered && desiredCount !== undefined && desiredCount < liveNodes.length) {
    if (liveNodes.length !== previousCount) {
      throw new ProvisioningError(
        safeMsg`Cannot update CacheCluster ${logicalId}: the template lowers NumCacheNodes from ${String(previousCount)} ` +
          safeMsg`to ${String(desiredCount)}, but the cluster has ${String(liveNodes.length)} nodes, so ` +
          `the removal would delete nodes the template change does not account for. Deploy ` +
          `NumCacheNodes set to the live count first, then lower it.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const plan = nodesToRemove(liveNodes, desiredCount, zones);
    if (plan === undefined) {
      // A list sharing no zone with the PREVIOUS template list never gets
      // here: the deploy replaces the cluster for it, as CloudFormation
      // does (issue #5458, `replacement-rules.ts`).
      throw new ProvisioningError(
        safeMsg`Cannot update CacheCluster ${logicalId}: lowering NumCacheNodes to ${String(desiredCount)} ` +
          `with this PreferredAvailabilityZones list needs a node removed and a node added in a ` +
          `zone no live node occupies, in one update, which ModifyCacheCluster cannot do. ` +
          `Replace the cluster (for example by changing its logical ID), or list only zones the kept nodes occupy.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    removeIds = plan;
    this.logger.info(
      safeMsg`CacheCluster ${logicalId}: NumCacheNodes ${String(previousProperties['NumCacheNodes'])} -> ${String(desiredCount)}, removing cache nodes ${removeIds.join(', ')}`
    );
  }

  // A removal and an addition cannot share one Modify (AWS refuses it), so
  // a decrease sends no new zones.
  const newAvailabilityZones =
    zones === undefined || removeIds.length > 0
      ? []
      : availabilityZonesNotCovered(
          zones,
          liveNodes
            .filter((n) => n.id === undefined || !removeIds.includes(n.id))
            .map((n) => n.zone)
            .filter((z): z is string => typeof z === 'string')
        );
  const placement =
    newAvailabilityZones.length > 0
      ? { newAvailabilityZones, azMode: properties['AZMode'] as AZMode | undefined }
      : undefined;
  return { placement, removeIds };
}

/**
 * Warn about template changes ModifyCacheCluster cannot carry (issue
 * #5438). `PreferredAvailabilityZone` has no ModifyCacheCluster member, and
 * `AZMode` reaches AWS only beside zones for nodes to add
 * (`TransitEncryptionEnabled` is reported after the Modify, against the
 * live value: `warnTransitEncryptionNotApplied`). Real CloudFormation runs completed each such update with
 * the cluster unchanged, so cdkd completes it too, but says so: the
 * template and the cluster now disagree until the cluster is replaced.
 */
export function warnNotAppliedInPlace(
  this: ElastiCacheProvider,
  logicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  placement: { azMode: AZMode | undefined } | undefined
): void {
  const changed = (next: unknown, prev: unknown): boolean =>
    next !== undefined && !isDeepStrictEqual(next, prev);
  const notApplied: string[] = [];
  if (
    changed(
      properties['PreferredAvailabilityZone'],
      previousProperties['PreferredAvailabilityZone']
    )
  ) {
    notApplied.push('PreferredAvailabilityZone');
  }
  if (
    placement?.azMode === undefined &&
    changed(properties['AZMode'], previousProperties['AZMode'])
  ) {
    notApplied.push('AZMode');
  }
  if (notApplied.length === 0) return;
  this.logger.warn(
    safeMsg`CacheCluster ${logicalId}: the ${notApplied.join(', ')} change is not applied to the ` +
      `existing cluster (ModifyCacheCluster cannot change it, and CloudFormation leaves it ` +
      `unchanged too). To apply it, replace the cluster, for example by changing its logical ID.`
  );
}

/**
 * Name the {@link KEPT_ON_REMOVAL} and {@link PLACEMENT_ON_REMOVAL}
 * properties this update removed, after the update succeeded. The caller's
 * `removedProperties` is the template-to-template set; a direct call (no
 * set) falls back to comparing the two bags, which is why a direct
 * `drift --revert`-shaped call is excluded here too: its previous side is an
 * AWS readback, so a key the desired side lacks was never removed from a
 * template.
 */
export function warnRemovalsLeftInPlace(
  this: ElastiCacheProvider,
  logicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  if (context?.desiredFromAwsReadback) return;
  const removed = context?.removedProperties;
  const wasRemoved = (key: string): boolean =>
    removed !== undefined
      ? removed.has(key)
      : properties[key] === undefined && previousProperties[key] !== undefined;
  const lines = removalWarnings(
    logicalId,
    KEPT_ON_REMOVAL.filter(wasRemoved),
    PLACEMENT_ON_REMOVAL.filter(wasRemoved),
    context?.replayingState ? 'rollback' : 'deploy'
  );
  for (const line of lines) this.logger.warn(line);
}

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
export function buildLogDeliveryConfigurationsForUpdate(
  this: ElastiCacheProvider,
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
 * Apply a diff between old and new CFn-shape Tags arrays via ElastiCache's
 * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
 * `ResourceName=arn`).
 */
export async function applyTagDiff(
  this: ElastiCacheProvider,
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
      new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
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
