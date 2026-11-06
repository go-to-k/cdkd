import type { ASGProvider } from '../asg-provider.js';
import {
  UpdateAutoScalingGroupCommand,
  type AvailabilityZoneDistribution,
  type AvailabilityZoneImpairmentPolicy,
  type CapacityReservationSpecification,
  type DeletionProtection,
  type InstanceLifecyclePolicy,
  type InstanceMaintenancePolicy,
} from '@aws-sdk/client-auto-scaling';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { clearOnUpdateRemoval, withRemovalDefaults } from '../../update-removal.js';
import { protectedReplacementAdvice } from '../../replacement-protection-advice.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import { zoneMembers } from './shared.js';

/**
 * The `context` parameter is read for ONE thing today: `maskSecrets` (issue
 * #1932 item 3, adopted here by issue #1997). It is paired with the RECORDED
 * group name (go-to-k/cdkd#4339) into one masker, `mask`, which every reader
 * of the name or a resolved value in this method uses: the updating line, the
 * immutable-name refusal's pasted command, `applyTargetGroupArnsDiff`'s
 * convergence warning, `fetchArn`'s failure line and `wrapUpdateError`.
 *
 * `create()` takes the masker too — see its own doc for why the original
 * "nothing to mask there" reading was wrong.
 */
export async function update(
  this: ASGProvider,
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
  if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') {
    throw new ProvisioningError(
      `Unsupported resource type: ${resourceType}`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  // The physical id is the group name, which can be secret-derived. Paired
  // with the RECORDED name (go-to-k/cdkd#4339): after a secret rotation the
  // physical id is the PRE-rotation value, which this deploy's masker never
  // resolved, and a previous side still spelling `{{resolve:` makes it a
  // needle. (An unrotated secret-derived name IS the resolved value, which
  // the deploy's masker already holds.) Every line, the refusal's pasted
  // command, and the failure wrap of this update read this one masker.
  const { mask } = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [[previousProperties['AutoScalingGroupName'], physicalId]]
  );
  this.logger.debug(`Updating AutoScalingGroup ${logicalId}: ${mask(physicalId)}`);

  // Reject diffs on fields AWS does not support modifying via
  // UpdateAutoScalingGroup. The replacement-detection layer typically
  // catches AutoScalingGroupName changes earlier; this is defense-in-
  // depth + the only place to surface the equivalent error for
  // sub-resource fields the caller may reasonably expect to round-trip.
  // A secret-derived name is recorded as its `{{resolve:...}}` reference
  // and handed here resolved, which is no change: the physical id, which IS
  // the group name, decides instead (go-to-k/cdkd#4275).
  const stringEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (
    !stringEq(properties['AutoScalingGroupName'], previousProperties['AutoScalingGroupName']) &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'AutoScalingGroupName',
      desired: properties['AutoScalingGroupName'],
      previous: previousProperties['AutoScalingGroupName'],
      physicalName: physicalId,
    }))
  ) {
    // Issue [#2610] site 8. `--replace` alone cannot succeed on a group whose
    // recorded `DeletionProtection` is `'prevent-all-deletion'` (see the
    // level analysis below for why that is the ONLY blocking level): the
    // replacement's DELETE runs from the deploy engine, which never sets
    // `DeleteContext.removeProtection` — `delete()` below gates BOTH its
    // flip-off and its `ForceDelete: true` on exactly that field. See
    // `../replacement-protection-advice.ts`.
    //
    // Read the RECORDED bag: this guard fires before any
    // `UpdateAutoScalingGroup` in this method, so AWS still holds what
    // `previousProperties` records.
    //
    // The value is a THREE-level string enum, and only the strictest level
    // blocks a deploy-side replacement. AWS's own wording: the setting
    // controls whether `DeleteAutoScalingGroup` is allowed "according to the
    // specified protection level" -- `prevent-force-deletion` withholds only
    // the FORCE delete, and the deploy engine's replacement issues
    // `ForceDelete: false` (see `delete()` below, where the flag rides
    // `context?.removeProtection`). So on `prevent-force-deletion` the delete
    // is not refused BECAUSE of protection, and telling the user to clear it
    // would name a remedy that fixes nothing -- the exact defect issue
    // [#2610] is about, reintroduced by an over-wide predicate. An ABSENT
    // value is the AWS-side default, which `readCurrentState` writes back as
    // the explicit `'none'` placeholder.
    const recordedProtection = previousProperties['DeletionProtection'];
    const remedy =
      recordedProtection === 'prevent-all-deletion'
        ? protectedReplacementAdvice({
            evidence:
              "cdkd's recorded properties for this group carry " +
              'DeletionProtection: prevent-all-deletion',
            replaceFlags: 'cdkd deploy --replace',
            disable: {
              before: 'aws autoscaling update-auto-scaling-group --auto-scaling-group-name',
              identifier: physicalId,
              after: '--deletion-protection none',
              // A secret-derived name (the pre-rotation one included)
              // withholds the command (go-to-k/cdkd#4339).
              maskSecrets: mask,
            },
          })
        : 'Use cdkd deploy --replace to replace the group.';
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      'AutoScalingGroupName is immutable on AWS — UpdateAutoScalingGroup does not accept a new name; the name is fixed at creation. ' +
        remedy
    );
  }
  // BOTH sides before any call (go-to-k/cdkd#3948): a rollback replays this
  // method with a recorded bag as the DESIRED side, and the previous side is
  // always the state record.
  const { next, prev, retained } = await this.readUpdateLists(
    logicalId,
    physicalId,
    resourceType,
    {
      Tags: properties['Tags'],
      LoadBalancerNames: properties['LoadBalancerNames'],
      TargetGroupARNs: properties['TargetGroupARNs'],
      MetricsCollection: properties['MetricsCollection'],
      LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'],
      TrafficSources: properties['TrafficSources'],
      NotificationConfigurations: properties['NotificationConfigurations'],
    },
    {
      Tags: previousProperties['Tags'],
      LoadBalancerNames: previousProperties['LoadBalancerNames'],
      TargetGroupARNs: previousProperties['TargetGroupARNs'],
      MetricsCollection: previousProperties['MetricsCollection'],
      LifecycleHookSpecificationList: previousProperties['LifecycleHookSpecificationList'],
      TrafficSources: previousProperties['TrafficSources'],
      NotificationConfigurations: previousProperties['NotificationConfigurations'],
    }
  );
  try {
    // Sub-shape diffs are applied via separate per-shape SDK calls
    // BEFORE the main UpdateAutoScalingGroup. AWS does not expose these
    // fields on UpdateAutoScalingGroup, so each one rides its own
    // dedicated API. Each per-shape helper is a no-op when the
    // before/after JSON is identical.
    await this.applyTagsDiff(physicalId, next.Tags, prev.Tags);
    await this.applyLoadBalancerNamesDiff(
      physicalId,
      next.LoadBalancerNames as string[],
      prev.LoadBalancerNames as string[]
    );
    await this.applyTargetGroupArnsDiff(
      physicalId,
      next.TargetGroupARNs as string[],
      prev.TargetGroupARNs as string[],
      mask,
      retained.TargetGroupARNs
    );
    await this.applyMetricsCollectionDiff(
      physicalId,
      next.MetricsCollection,
      prev.MetricsCollection
    );
    await this.applyLifecycleHooksDiff(
      physicalId,
      next.LifecycleHookSpecificationList,
      prev.LifecycleHookSpecificationList
    );
    await this.applyTrafficSourcesDiff(physicalId, next.TrafficSources, prev.TrafficSources);
    await this.applyNotificationConfigurationsDiff(
      physicalId,
      next.NotificationConfigurations,
      prev.NotificationConfigurations
    );

    const launchTemplate = this.buildLaunchTemplate(properties);
    const vpcZoneIdentifier = this.joinVpcZoneIdentifier(properties['VPCZoneIdentifier']);

    // issue #1160: `UpdateAutoScalingGroup` has merge semantics — an absent
    // input field means "no change". Per the #5004 CloudFormation A/B,
    // CloudFormation resets only InstanceMaintenancePolicy, MaxInstanceLifetime,
    // CapacityReservationSpecification and AvailabilityZoneDistribution when
    // removed, plus AvailabilityZoneImpairmentPolicy per the #1160 A/B and
    // PlacementGroup per the #2762 A/B (the rest keep the live value; see
    // below). A constant reset arrives in
    // `properties` from `removalDefaults` (see its declaration for each
    // value's doc basis); the coerced / aliased fields below resolve theirs
    // locally through `clearOnUpdateRemoval`.
    //
    // go-to-k/cdkd#1160 (real CloudFormation A/B, us-east-1, with the
    // UpdateAutoScalingGroup input CloudFormation sent read from CloudTrail):
    //   - AvailabilityZoneImpairmentPolicy: RESET. CloudFormation sends
    //     `ZonalShiftEnabled: false` with the PREVIOUS
    //     `ImpairedZoneHealthCheckBehavior`, and AWS then reports no policy.
    //     cdkd sends the same shape (below).
    //   - DesiredCapacity, ServiceLinkedRoleARN (a custom-suffix role):
    //     KEPT — CloudFormation sends nothing and the live value stays, so
    //     cdkd sends nothing either. MinSize / MaxSize are required.
    //   - LaunchTemplate <-> MixedInstancesPolicy and VPCZoneIdentifier ->
    //     AvailabilityZones: CloudFormation sends only the member the
    //     template now declares, exactly as cdkd does. AWS then drops the
    //     other launch member, but KEEPS the subnets on a switch to
    //     AvailabilityZones — parity either way.
    //   - AvailabilityZoneIds <-> AvailabilityZones (go-to-k/cdkd#2762 A/B):
    //     CloudFormation sends only the zone member the template now
    //     declares (AWS refuses both in one request), exactly as cdkd does.
    //   - SkipZonalShiftValidation: write-only in the CloudFormation schema
    //     (a per-request flag, never read back) — nothing to reset.
    //   - Context: "Reserved." AWS refuses any value an account sets ("is
    //     not allowed to access Context"), so no deployable template can
    //     remove one.
    //
    // Sub-field removal inside a KEPT config object (issue #1225 — the
    // #1160 bug class one level down) is deliberately passed through
    // verbatim here:
    //   - InstanceMaintenancePolicy: a kept-but-partial object (one of the
    //     two percentages dropped) is REJECTED by AWS — the SDK doc requires
    //     "Both MinHealthyPercentage and MaxHealthyPercentage must be
    //     specified". CloudFormation submits the same partial object, so the
    //     loud failure IS the CFn-parity behavior; there is no silent drop
    //     to normalize away.
    //   - CapacityReservationSpecification: whether AWS keeps or clears a
    //     previously-set CapacityReservationTarget when only the preference
    //     is re-sent is UNPROBED (a live probe needs a billed Capacity
    //     Reservation); the kept-partial object passes through unchanged.
    //   - AvailabilityZoneDistribution: single sub-field — no partial shape
    //     exists.
    // go-to-k/cdkd#5004: HealthCheckType, HealthCheckGracePeriod, Cooldown,
    // TerminationPolicies, NewInstancesProtectedFromScaleIn,
    // CapacityRebalance, DesiredCapacityType, DefaultInstanceWarmup and
    // DeletionProtection are KEPT by CloudFormation when removed from the
    // template (real A/B), so a removal sends nothing for them and the live
    // value stays. `Cooldown` / `DefaultCooldown` are one logical field.
    const healthCheckTypeInput = properties['HealthCheckType'] as string | undefined;
    const healthCheckGracePeriodInput =
      properties['HealthCheckGracePeriod'] != null
        ? Number(properties['HealthCheckGracePeriod'])
        : undefined;
    const cooldownRaw = properties['Cooldown'] ?? properties['DefaultCooldown'];
    const defaultCooldownInput = cooldownRaw != null ? Number(cooldownRaw) : undefined;
    const terminationPoliciesInput = properties['TerminationPolicies'] as string[] | undefined;
    const newInstancesProtectedInput = properties['NewInstancesProtectedFromScaleIn'] as
      | boolean
      | undefined;
    const capacityRebalanceInput = properties['CapacityRebalance'] as boolean | undefined;
    // RESET by CloudFormation (#5004 A/B): SDK doc "To clear a previously
    // set value, specify a new value of 0."
    const maxInstanceLifetimeInput = clearOnUpdateRemoval(
      properties['MaxInstanceLifetime'] != null
        ? Number(properties['MaxInstanceLifetime'])
        : undefined,
      previousProperties['MaxInstanceLifetime'] != null
        ? Number(previousProperties['MaxInstanceLifetime'])
        : undefined,
      0
    );
    const desiredCapacityTypeInput = properties['DesiredCapacityType'] as string | undefined;
    const defaultInstanceWarmupInput =
      properties['DefaultInstanceWarmup'] != null
        ? Number(properties['DefaultInstanceWarmup'])
        : undefined;
    const instanceMaintenancePolicyInput = properties['InstanceMaintenancePolicy'] as
      | InstanceMaintenancePolicy
      | undefined;
    const capacityReservationSpecInput = properties['CapacityReservationSpecification'] as
      | CapacityReservationSpecification
      | undefined;
    const availabilityZoneDistributionInput = properties['AvailabilityZoneDistribution'] as
      | AvailabilityZoneDistribution
      | undefined;
    const deletionProtectionInput = properties['DeletionProtection'] as
      | DeletionProtection
      | undefined;
    // go-to-k/cdkd#2762 (real CloudFormation A/B, us-east-1, the
    // UpdateAutoScalingGroup input read from CloudTrail): a removed
    // PlacementGroup is RESET — CloudFormation sends `PlacementGroup: ""` and
    // AWS then reports no placement group — while a removed
    // InstanceLifecyclePolicy is KEPT: CloudFormation sends nothing and the
    // live retention trigger stays.
    const placementGroupInput = clearOnUpdateRemoval(
      properties['PlacementGroup'] as string | undefined,
      previousProperties['PlacementGroup'] as string | undefined,
      ''
    );
    const instanceLifecyclePolicyInput = properties['InstanceLifecyclePolicy'] as
      | InstanceLifecyclePolicy
      | undefined;
    const zones = zoneMembers(
      properties,
      context?.desiredFromAwsReadback === true || context?.replayingState === true,
      previousProperties
    );
    // RESET by CloudFormation (#1160 A/B): zonal shift off, the previous
    // health-check behavior re-sent (the CloudFormation schema requires
    // both members; AWS then reports no policy).
    const previousImpairmentPolicy = previousProperties['AvailabilityZoneImpairmentPolicy'];
    const previousImpairedBehavior =
      typeof previousImpairmentPolicy === 'object' && previousImpairmentPolicy !== null
        ? (previousImpairmentPolicy as Record<string, unknown>)['ImpairedZoneHealthCheckBehavior']
        : undefined;
    const availabilityZoneImpairmentPolicyInput =
      clearOnUpdateRemoval<AvailabilityZoneImpairmentPolicy>(
        properties['AvailabilityZoneImpairmentPolicy'] as
          | AvailabilityZoneImpairmentPolicy
          | undefined,
        previousImpairmentPolicy as AvailabilityZoneImpairmentPolicy | undefined,
        {
          ZonalShiftEnabled: false,
          ...(typeof previousImpairedBehavior === 'string' && {
            ImpairedZoneHealthCheckBehavior:
              previousImpairedBehavior as AvailabilityZoneImpairmentPolicy['ImpairedZoneHealthCheckBehavior'],
          }),
        }
      );

    await this.getClient().send(
      new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: physicalId,
        ...(properties['MinSize'] != null && { MinSize: Number(properties['MinSize']) }),
        ...(properties['MaxSize'] != null && { MaxSize: Number(properties['MaxSize']) }),
        ...(properties['DesiredCapacity'] != null && {
          DesiredCapacity: Number(properties['DesiredCapacity']),
        }),
        ...(launchTemplate && { LaunchTemplate: launchTemplate }),
        ...(properties['MixedInstancesPolicy'] !== undefined && {
          MixedInstancesPolicy: properties['MixedInstancesPolicy'] as never,
        }),
        ...(vpcZoneIdentifier !== undefined && { VPCZoneIdentifier: vpcZoneIdentifier }),
        ...(zones.AvailabilityZones !== undefined && {
          AvailabilityZones: zones.AvailabilityZones,
        }),
        ...(zones.AvailabilityZoneIds !== undefined && {
          AvailabilityZoneIds: zones.AvailabilityZoneIds,
        }),
        ...(placementGroupInput !== undefined && { PlacementGroup: placementGroupInput }),
        ...(instanceLifecyclePolicyInput !== undefined && {
          InstanceLifecyclePolicy: instanceLifecyclePolicyInput,
        }),
        ...(healthCheckTypeInput !== undefined && {
          HealthCheckType: healthCheckTypeInput,
        }),
        ...(healthCheckGracePeriodInput !== undefined && {
          HealthCheckGracePeriod: healthCheckGracePeriodInput,
        }),
        ...(defaultCooldownInput !== undefined && {
          DefaultCooldown: defaultCooldownInput,
        }),
        ...(terminationPoliciesInput !== undefined && {
          TerminationPolicies: terminationPoliciesInput,
        }),
        ...(newInstancesProtectedInput !== undefined && {
          NewInstancesProtectedFromScaleIn: newInstancesProtectedInput,
        }),
        ...(capacityRebalanceInput !== undefined && {
          CapacityRebalance: capacityRebalanceInput,
        }),
        ...(properties['ServiceLinkedRoleARN'] !== undefined && {
          ServiceLinkedRoleARN: properties['ServiceLinkedRoleARN'] as string,
        }),
        ...(maxInstanceLifetimeInput !== undefined && {
          MaxInstanceLifetime: maxInstanceLifetimeInput,
        }),
        ...(properties['Context'] !== undefined && {
          Context: properties['Context'] as string,
        }),
        ...(desiredCapacityTypeInput !== undefined && {
          DesiredCapacityType: desiredCapacityTypeInput,
        }),
        ...(defaultInstanceWarmupInput !== undefined && {
          DefaultInstanceWarmup: defaultInstanceWarmupInput,
        }),
        ...(availabilityZoneDistributionInput !== undefined && {
          AvailabilityZoneDistribution: availabilityZoneDistributionInput,
        }),
        ...(availabilityZoneImpairmentPolicyInput !== undefined && {
          AvailabilityZoneImpairmentPolicy: availabilityZoneImpairmentPolicyInput,
        }),
        ...(properties['SkipZonalShiftValidation'] !== undefined && {
          SkipZonalShiftValidation: properties['SkipZonalShiftValidation'] as boolean,
        }),
        ...(capacityReservationSpecInput !== undefined && {
          CapacityReservationSpecification: capacityReservationSpecInput,
        }),
        ...(instanceMaintenancePolicyInput !== undefined && {
          InstanceMaintenancePolicy: instanceMaintenancePolicyInput,
        }),
        ...(deletionProtectionInput !== undefined && {
          DeletionProtection: deletionProtectionInput,
        }),
      })
    );

    this.logger.debug(`Successfully updated AutoScalingGroup ${logicalId}`);

    const arn = await this.fetchArn(physicalId, mask);
    const attributes: Record<string, unknown> = {};
    if (arn) attributes['Arn'] = arn;
    if (launchTemplate?.LaunchTemplateId) {
      attributes['LaunchTemplateID'] = launchTemplate.LaunchTemplateId;
    }
    return { physicalId, wasReplaced: false, attributes };
  } catch (error) {
    if (error instanceof ResourceUpdateNotSupportedError) throw error;
    throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, mask);
  }
}
