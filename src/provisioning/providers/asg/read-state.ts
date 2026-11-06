import type { ASGProvider } from '../asg-provider.js';
import {
  DescribeLifecycleHooksCommand,
  DescribeTrafficSourcesCommand,
  DescribeNotificationConfigurationsCommand,
} from '@aws-sdk/client-auto-scaling';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  isFoldableMetricsEntry,
  ALL_GROUP_METRICS,
  foldMetricsCollection,
  mapEnabledMetricsToCfn,
  mapLifecycleHooksToCfn,
  mapTrafficSourcesToCfn,
  mapNotificationsToCfn,
} from './shared.js';

/**
 * Fold `MetricsCollection` on BOTH drift sides (go-to-k/cdkd#4013):
 * `readCurrentState` reports one entry per granularity, while a template-
 * shaped baseline (a record deployed before observed-capture) carries one
 * entry per CDK `GroupMetrics`, so the same enabled set would otherwise
 * drift forever. Same helper as the update diff, so the two cannot disagree.
 */
export function canonicalizeDriftProperties(
  this: ASGProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') return properties;
  const key = 'MetricsCollection';
  const metrics = properties[key];
  // Fold only a list every entry of which is readable: the fold would read
  // an unreadable `Metrics` as ALL and hide the difference (and `--accept`
  // would persist that ALL).
  if (!Array.isArray(metrics) || !metrics.every(isFoldableMetricsEntry)) return properties;
  const folded = foldMetricsCollection(metrics);
  if (JSON.stringify(folded) === JSON.stringify(metrics)) return properties;
  return { ...properties, [key]: folded };
}

/**
 * Compare an ALL `MetricsCollection` baseline against the per-metric readback
 * (go-to-k/cdkd#4021). An entry with no `Metrics` enables every metric, but
 * `EnabledMetrics` lists them one by one, so a template-shaped ALL baseline
 * (a record deployed before observed-capture) never matched.
 *
 * The rule is a SUPERSET test, keyed on the BASELINE saying ALL: that
 * granularity's baseline becomes the readback's metrics UNION
 * {@link ALL_GROUP_METRICS}. A readback holding every known metric therefore
 * compares clean (a metric AWS adds later included), and one missing a known
 * metric differs by exactly the missing ones. Residual: an out-of-band
 * disable of a metric cdkd does not yet list is NOT reported.
 *
 * Only the baseline is rewritten, and only by ADDING metrics, so `--accept`
 * (which writes the readback side) persists nothing new, and `--revert`
 * (which sends this baseline as its desired side) can only Enable, never
 * Disable a metric the readback holds; `applyMetricsCollectionDiff` sends
 * that Enable as ALL (no `Metrics`), not as the expanded list.
 */
export async function canonicalizeDriftPair(
  this: ASGProvider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  const key = 'MetricsCollection';
  const unchanged = { baseline, aws };
  if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') return unchanged;
  const recorded = baseline[key];
  if (!Array.isArray(recorded) || !recorded.every(isFoldableMetricsEntry)) return unchanged;
  const folded = foldMetricsCollection(recorded);
  if (folded.every((e) => e.Metrics !== undefined)) return unchanged;
  const live = aws[key];
  const liveBy = new Map<string, string[]>();
  if (Array.isArray(live) && live.every(isFoldableMetricsEntry)) {
    for (const e of foldMetricsCollection(live)) liveBy.set(e.Granularity, e.Metrics ?? []);
  }
  const expanded = folded.map((e) =>
    e.Metrics !== undefined
      ? e
      : {
          Granularity: e.Granularity,
          Metrics: [
            ...new Set([...ALL_GROUP_METRICS, ...(liveBy.get(e.Granularity) ?? [])]),
          ].sort(),
        }
  );
  return { baseline: { ...baseline, [key]: expanded }, aws };
}

export async function getAttribute(
  this: ASGProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string,
  logicalId: string
): Promise<unknown> {
  const group = await this.describeGroup(physicalId);
  if (!group) {
    throw new ProvisioningError(
      `AutoScalingGroup ${physicalId} not found while resolving attribute ${attributeName}`,
      'AWS::AutoScaling::AutoScalingGroup',
      logicalId,
      physicalId
    );
  }
  switch (attributeName) {
    case 'Arn':
    case 'AutoScalingGroupARN':
      return group.AutoScalingGroupARN ?? '';
    case 'LaunchConfigurationName':
      return group.LaunchConfigurationName ?? '';
    case 'LaunchTemplateID':
    case 'LaunchTemplateId':
      return group.LaunchTemplate?.LaunchTemplateId ?? '';
    default:
      return '';
  }
}

/**
 * Read the AWS-current AutoScalingGroup configuration in CFn-property shape.
 *
 * Surfaces the user-controllable subset of `DescribeAutoScalingGroups`,
 * with always-emit placeholders on user-controllable top-level keys per
 * the cdkd PR #145 always-emit convention so that v3 `observedProperties`
 * baseline catches console-side ADDs to fields a clean deploy did not
 * template (e.g. a console-set `DeletionProtection: 'prevent-force-deletion'`
 * on a group originally created without it).
 *
 * Sub-shapes (LifecycleHookSpecificationList / TrafficSources /
 * NotificationConfigurations) are surfaced via three parallel Describe
 * calls fired alongside the primary `DescribeAutoScalingGroups`. Each is
 * best-effort: a per-call failure (e.g. permissions gap on
 * `autoscaling:DescribeLifecycleHooks`) is logged at debug and the
 * matching key falls back to its always-emit `[]` placeholder rather
 * than aborting the whole drift read.
 *
 * `MetricsCollection` is reverse-mapped from `EnabledMetrics` (already
 * present on the primary `DescribeAutoScalingGroups` response, so no
 * extra call is needed).
 *
 * Returns `RESOURCE_NOT_FOUND` when the group is gone.
 */
export async function readCurrentState(
  this: ASGProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // Fire the four reads in parallel. Sub-shape failures are best-effort
  // so a single permission gap does not break the whole drift read.
  const groupPromise = (async () => {
    try {
      return await this.describeGroup(physicalId);
    } catch (err) {
      // `null`, not the gone sentinel: this predicate is a generic
      // `ValidationError` plus message text, which proves nothing
      // (go-to-k/cdkd#4283). The empty describe list below is the answer.
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  })();

  const lifecycleHooksPromise = this.getClient()
    .send(new DescribeLifecycleHooksCommand({ AutoScalingGroupName: physicalId }))
    .then((r) => r.LifecycleHooks ?? [])
    .catch((err) => {
      this.logger.debug(
        `DescribeLifecycleHooks(${physicalId}) failed: ${describeAwsFailure(err).detail}`
      );
      return [];
    });

  const trafficSourcesPromise = this.getClient()
    .send(new DescribeTrafficSourcesCommand({ AutoScalingGroupName: physicalId }))
    .then((r) => r.TrafficSources ?? [])
    .catch((err) => {
      this.logger.debug(
        `DescribeTrafficSources(${physicalId}) failed: ${describeAwsFailure(err).detail}`
      );
      return [];
    });

  const notificationsPromise = this.getClient()
    .send(new DescribeNotificationConfigurationsCommand({ AutoScalingGroupNames: [physicalId] }))
    .then((r) => r.NotificationConfigurations ?? [])
    .catch((err) => {
      this.logger.debug(
        `DescribeNotificationConfigurations(${physicalId}) failed: ${describeAwsFailure(err).detail}`
      );
      return [];
    });

  const [group, lifecycleHooks, trafficSources, notifications] = await Promise.all([
    groupPromise,
    lifecycleHooksPromise,
    trafficSourcesPromise,
    notificationsPromise,
  ]);

  if (group === null) return undefined;
  if (!group) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (group.AutoScalingGroupName !== undefined) {
    result['AutoScalingGroupName'] = group.AutoScalingGroupName;
  }
  if (group.LaunchTemplate) {
    const lt: Record<string, unknown> = {};
    if (group.LaunchTemplate.LaunchTemplateId !== undefined) {
      lt['LaunchTemplateId'] = group.LaunchTemplate.LaunchTemplateId;
    }
    if (group.LaunchTemplate.LaunchTemplateName !== undefined) {
      lt['LaunchTemplateName'] = group.LaunchTemplate.LaunchTemplateName;
    }
    if (group.LaunchTemplate.Version !== undefined) {
      lt['Version'] = group.LaunchTemplate.Version;
    }
    result['LaunchTemplate'] = lt;
  }
  result['MinSize'] = group.MinSize ?? 0;
  result['MaxSize'] = group.MaxSize ?? 0;
  if (group.DesiredCapacity !== undefined) result['DesiredCapacity'] = group.DesiredCapacity;
  // VPCZoneIdentifier round-trips back to the CFn list shape so the
  // comparator sees the same array the template emitted, not the
  // SDK-side comma-joined string.
  if (group.VPCZoneIdentifier !== undefined && group.VPCZoneIdentifier !== '') {
    result['VPCZoneIdentifier'] = group.VPCZoneIdentifier.split(',').map((s) => s.trim());
  } else {
    result['VPCZoneIdentifier'] = [];
  }
  result['AvailabilityZones'] = group.AvailabilityZones ?? [];
  // AWS reports the zone ids beside the names whichever member the group
  // was created with; drift compares only the keys the baseline holds.
  result['AvailabilityZoneIds'] = group.AvailabilityZoneIds ?? [];
  if (group.PlacementGroup !== undefined && group.PlacementGroup !== '') {
    result['PlacementGroup'] = group.PlacementGroup;
  }
  if (group.InstanceLifecyclePolicy !== undefined) {
    result['InstanceLifecyclePolicy'] = group.InstanceLifecyclePolicy;
  }
  if (group.HealthCheckType !== undefined) result['HealthCheckType'] = group.HealthCheckType;
  if (group.HealthCheckGracePeriod !== undefined) {
    result['HealthCheckGracePeriod'] = group.HealthCheckGracePeriod;
  }
  if (group.DefaultCooldown !== undefined) {
    // CFn template field is `Cooldown`; SDK / Describe response calls it
    // `DefaultCooldown`. Surface under the CFn name so the comparator
    // matches state directly.
    result['Cooldown'] = group.DefaultCooldown;
  }
  result['NewInstancesProtectedFromScaleIn'] = group.NewInstancesProtectedFromScaleIn ?? false;
  result['TerminationPolicies'] = group.TerminationPolicies ?? [];
  result['CapacityRebalance'] = group.CapacityRebalance ?? false;
  if (group.ServiceLinkedRoleARN !== undefined) {
    result['ServiceLinkedRoleARN'] = group.ServiceLinkedRoleARN;
  }
  if (group.MaxInstanceLifetime !== undefined) {
    result['MaxInstanceLifetime'] = group.MaxInstanceLifetime;
  }
  result['LoadBalancerNames'] = group.LoadBalancerNames ?? [];
  result['TargetGroupARNs'] = group.TargetGroupARNs ?? [];
  if (group.Context !== undefined) result['Context'] = group.Context;
  if (group.DesiredCapacityType !== undefined) {
    result['DesiredCapacityType'] = group.DesiredCapacityType;
  }
  if (group.DefaultInstanceWarmup !== undefined) {
    result['DefaultInstanceWarmup'] = group.DefaultInstanceWarmup;
  }
  if (group.MixedInstancesPolicy !== undefined) {
    result['MixedInstancesPolicy'] = group.MixedInstancesPolicy;
  }
  if (group.AvailabilityZoneDistribution !== undefined) {
    result['AvailabilityZoneDistribution'] = group.AvailabilityZoneDistribution;
  }
  if (group.AvailabilityZoneImpairmentPolicy !== undefined) {
    result['AvailabilityZoneImpairmentPolicy'] = group.AvailabilityZoneImpairmentPolicy;
  }
  if (group.CapacityReservationSpecification !== undefined) {
    result['CapacityReservationSpecification'] = group.CapacityReservationSpecification;
  }
  if (group.InstanceMaintenancePolicy !== undefined) {
    result['InstanceMaintenancePolicy'] = group.InstanceMaintenancePolicy;
  }
  if (group.DeletionProtection !== undefined) {
    result['DeletionProtection'] = group.DeletionProtection;
  } else {
    // AWS reports `undefined` when the group has the AWS-side default
    // (`'none'`). Always-emit placeholder so the v3 `observedProperties`
    // baseline catches a console-side flip to `prevent-force-deletion`
    // / `prevent-all-deletion`.
    result['DeletionProtection'] = 'none';
  }
  // Tags: filter aws:* prefix and normalize to CFn shape sorted by Key.
  // ASG returns Tags inside the AutoScalingGroup record (already populated
  // by DescribeAutoScalingGroups — no separate ListTagsForResource call).
  result['Tags'] = normalizeAwsTagsToCfn(group.Tags);

  // Sub-shapes — reverse-map AWS responses to CFn template shape and
  // always-emit `[]` placeholders so the v3 `observedProperties` baseline
  // catches console-side ADDs to a previously-empty list.
  result['MetricsCollection'] = mapEnabledMetricsToCfn(group.EnabledMetrics);
  result['LifecycleHookSpecificationList'] = mapLifecycleHooksToCfn(lifecycleHooks);
  // Strip ALL elbv2 / elb entries from TrafficSources — the canonical
  // attachment state for these types lives in TargetGroupARNs /
  // LoadBalancerNames. TrafficSources is meant for attachment types
  // without a dedicated CFn property (VPC Lattice, VPC Endpoint
  // Service). Filtering unconditionally avoids two failure modes
  // surfaced by tests/integration/drift-revert-vpc (PR #547):
  // double-attach/detach on revert, and stale TS entries from AWS's
  // eventual-consistency window after Attach/Detach surfacing as
  // false drift on the next read.
  const dedupedTrafficSources = trafficSources.filter((t) => {
    if (t.Identifier === undefined) return false;
    if (t.Type === 'elbv2' || t.Type === 'elb') return false;
    return true;
  });
  result['TrafficSources'] = mapTrafficSourcesToCfn(dedupedTrafficSources);
  result['NotificationConfigurations'] = mapNotificationsToCfn(notifications);

  return result;
}
