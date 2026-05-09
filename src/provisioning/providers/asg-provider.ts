import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  DescribeLifecycleHooksCommand,
  DescribeTrafficSourcesCommand,
  DescribeNotificationConfigurationsCommand,
  EnableMetricsCollectionCommand,
  DisableMetricsCollectionCommand,
  PutLifecycleHookCommand,
  DeleteLifecycleHookCommand,
  AttachTrafficSourcesCommand,
  DetachTrafficSourcesCommand,
  PutNotificationConfigurationCommand,
  DeleteNotificationConfigurationCommand,
  type Tag as ASGTag,
  type LaunchTemplateSpecification,
} from '@aws-sdk/client-auto-scaling';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Auto Scaling Provider
 *
 * Implements resource provisioning for `AWS::AutoScaling::AutoScalingGroup`.
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off: ASG protection has three
 *      levels (`none` / `prevent-force-deletion` / `prevent-all-deletion`)
 *      and the destroy path needs to (a) clear it via `UpdateAutoScalingGroup
 *      ({DeletionProtection: 'none'})` before the actual delete and (b) set
 *      `ForceDelete: true` on `DeleteAutoScalingGroup` so AWS terminates any
 *      running instances as part of the delete (matches the user's "I know
 *      what I'm doing" intent).
 *   2. Faster than CC API for the common case — direct Create/Update calls
 *      with no eventual-consistency polling beyond what `DescribeAutoScaling
 *      Groups` already provides.
 *
 * Update has narrower coverage than create: AWS does not support modifying
 * `AutoScalingGroupName` (immutable), `Tags` (those go through `CreateOrUpdate
 * Tags` / `DeleteTags`), or attached LB / target-group references (those go
 * through `Attach*` / `Detach*` calls). Those diffs still surface
 * `ResourceUpdateNotSupportedError` so the caller can `cdkd deploy --replace`.
 * The mutable fields handled in-place via `UpdateAutoScalingGroup` include
 * MinSize / MaxSize / DesiredCapacity / VPCZoneIdentifier / HealthCheckType /
 * HealthCheckGracePeriod / DefaultCooldown / Cooldown / NewInstancesProtected
 * FromScaleIn / MaxInstanceLifetime / TerminationPolicies / CapacityRebalance
 * / ServiceLinkedRoleARN / Context / DesiredCapacityType / DefaultInstance
 * Warmup / AvailabilityZones / AvailabilityZoneDistribution / Availability
 * ZoneImpairmentPolicy / SkipZonalShiftValidation / CapacityReservation
 * Specification / InstanceMaintenancePolicy / DeletionProtection / Mixed
 * InstancesPolicy / LaunchTemplate.
 *
 * Sub-shape diffs are applied via dedicated AWS APIs before the main
 * `UpdateAutoScalingGroup` call: `MetricsCollection` →
 * `EnableMetricsCollection` / `DisableMetricsCollection`,
 * `LifecycleHookSpecificationList` → per-entry `PutLifecycleHook` /
 * `DeleteLifecycleHook`, `TrafficSources` → `AttachTrafficSources` /
 * `DetachTrafficSources`, `NotificationConfigurations` → per-topic
 * `PutNotificationConfiguration` / `DeleteNotificationConfiguration`.
 * Each helper is a no-op when the before/after JSON is identical.
 */
export class ASGProvider implements ResourceProvider {
  private asgClient?: AutoScalingClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ASGProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::AutoScaling::AutoScalingGroup',
      new Set([
        'AutoScalingGroupName',
        'LaunchTemplate',
        'MinSize',
        'MaxSize',
        'DesiredCapacity',
        'VPCZoneIdentifier',
        'AvailabilityZones',
        'HealthCheckType',
        'HealthCheckGracePeriod',
        'Cooldown',
        'DefaultCooldown',
        'Tags',
        'TerminationPolicies',
        'NewInstancesProtectedFromScaleIn',
        'CapacityRebalance',
        'ServiceLinkedRoleARN',
        'MaxInstanceLifetime',
        'LoadBalancerNames',
        'TargetGroupARNs',
        'MetricsCollection',
        'LifecycleHookSpecificationList',
        'MixedInstancesPolicy',
        'Context',
        'DesiredCapacityType',
        'DefaultInstanceWarmup',
        'TrafficSources',
        'NotificationConfigurations',
        'AvailabilityZoneDistribution',
        'AvailabilityZoneImpairmentPolicy',
        'SkipZonalShiftValidation',
        'CapacityReservationSpecification',
        'InstanceMaintenancePolicy',
        'DeletionProtection',
      ]),
    ],
  ]);

  private getClient(): AutoScalingClient {
    if (!this.asgClient) {
      this.asgClient = new AutoScalingClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.asgClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    const groupName =
      (properties['AutoScalingGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });

    this.logger.debug(`Creating AutoScalingGroup ${logicalId}: ${groupName}`);

    try {
      const launchTemplate = this.buildLaunchTemplate(properties);
      const tags = this.buildTags(groupName, properties);
      const vpcZoneIdentifier = this.joinVpcZoneIdentifier(properties['VPCZoneIdentifier']);

      const minSize = properties['MinSize'] != null ? Number(properties['MinSize']) : 0;
      const maxSize = properties['MaxSize'] != null ? Number(properties['MaxSize']) : minSize;

      await this.getClient().send(
        new CreateAutoScalingGroupCommand({
          AutoScalingGroupName: groupName,
          MinSize: minSize,
          MaxSize: maxSize,
          ...(properties['DesiredCapacity'] != null && {
            DesiredCapacity: Number(properties['DesiredCapacity']),
          }),
          ...(launchTemplate && { LaunchTemplate: launchTemplate }),
          ...(properties['MixedInstancesPolicy'] !== undefined && {
            MixedInstancesPolicy: properties['MixedInstancesPolicy'] as never,
          }),
          ...(vpcZoneIdentifier !== undefined && { VPCZoneIdentifier: vpcZoneIdentifier }),
          ...(properties['AvailabilityZones'] !== undefined && {
            AvailabilityZones: properties['AvailabilityZones'] as string[],
          }),
          ...(properties['HealthCheckType'] !== undefined && {
            HealthCheckType: properties['HealthCheckType'] as string,
          }),
          ...(properties['HealthCheckGracePeriod'] != null && {
            HealthCheckGracePeriod: Number(properties['HealthCheckGracePeriod']),
          }),
          ...(properties['Cooldown'] != null && {
            DefaultCooldown: Number(properties['Cooldown']),
          }),
          ...(properties['DefaultCooldown'] != null && {
            DefaultCooldown: Number(properties['DefaultCooldown']),
          }),
          ...(properties['TerminationPolicies'] !== undefined && {
            TerminationPolicies: properties['TerminationPolicies'] as string[],
          }),
          ...(properties['NewInstancesProtectedFromScaleIn'] !== undefined && {
            NewInstancesProtectedFromScaleIn: properties[
              'NewInstancesProtectedFromScaleIn'
            ] as boolean,
          }),
          ...(properties['CapacityRebalance'] !== undefined && {
            CapacityRebalance: properties['CapacityRebalance'] as boolean,
          }),
          ...(properties['ServiceLinkedRoleARN'] !== undefined && {
            ServiceLinkedRoleARN: properties['ServiceLinkedRoleARN'] as string,
          }),
          ...(properties['MaxInstanceLifetime'] != null && {
            MaxInstanceLifetime: Number(properties['MaxInstanceLifetime']),
          }),
          ...(properties['LoadBalancerNames'] !== undefined && {
            LoadBalancerNames: properties['LoadBalancerNames'] as string[],
          }),
          ...(properties['TargetGroupARNs'] !== undefined && {
            TargetGroupARNs: properties['TargetGroupARNs'] as string[],
          }),
          ...(properties['Context'] !== undefined && {
            Context: properties['Context'] as string,
          }),
          ...(properties['DesiredCapacityType'] !== undefined && {
            DesiredCapacityType: properties['DesiredCapacityType'] as string,
          }),
          ...(properties['DefaultInstanceWarmup'] != null && {
            DefaultInstanceWarmup: Number(properties['DefaultInstanceWarmup']),
          }),
          ...(properties['LifecycleHookSpecificationList'] !== undefined && {
            LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'] as never,
          }),
          ...(properties['TrafficSources'] !== undefined && {
            TrafficSources: properties['TrafficSources'] as never,
          }),
          ...(properties['AvailabilityZoneDistribution'] !== undefined && {
            AvailabilityZoneDistribution: properties['AvailabilityZoneDistribution'] as never,
          }),
          ...(properties['AvailabilityZoneImpairmentPolicy'] !== undefined && {
            AvailabilityZoneImpairmentPolicy: properties[
              'AvailabilityZoneImpairmentPolicy'
            ] as never,
          }),
          ...(properties['SkipZonalShiftValidation'] !== undefined && {
            SkipZonalShiftValidation: properties['SkipZonalShiftValidation'] as boolean,
          }),
          ...(properties['CapacityReservationSpecification'] !== undefined && {
            CapacityReservationSpecification: properties[
              'CapacityReservationSpecification'
            ] as never,
          }),
          ...(properties['InstanceMaintenancePolicy'] !== undefined && {
            InstanceMaintenancePolicy: properties['InstanceMaintenancePolicy'] as never,
          }),
          ...(properties['DeletionProtection'] !== undefined && {
            DeletionProtection: properties['DeletionProtection'] as never,
          }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(`Successfully created AutoScalingGroup ${logicalId}: ${groupName}`);

      const arn = await this.fetchArn(groupName);
      const attributes: Record<string, unknown> = {};
      if (arn) attributes['Arn'] = arn;
      if (launchTemplate?.LaunchTemplateId) {
        attributes['LaunchTemplateID'] = launchTemplate.LaunchTemplateId;
      }
      return { physicalId: groupName, attributes };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create AutoScalingGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        groupName,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    this.logger.debug(`Updating AutoScalingGroup ${logicalId}: ${physicalId}`);

    // Reject diffs on fields AWS does not support modifying via
    // UpdateAutoScalingGroup. The replacement-detection layer typically
    // catches AutoScalingGroupName changes earlier; this is defense-in-
    // depth + the only place to surface the equivalent error for
    // sub-resource fields the caller may reasonably expect to round-trip.
    const stringEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    if (!stringEq(properties['AutoScalingGroupName'], previousProperties['AutoScalingGroupName'])) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'AutoScalingGroupName is immutable; use cdkd deploy --replace to replace the group'
      );
    }
    if (!stringEq(properties['Tags'] ?? [], previousProperties['Tags'] ?? [])) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'Tags updates on AWS::AutoScaling::AutoScalingGroup are not yet supported by cdkd; use cdkd deploy --replace, or update the tags via AWS console / CLI'
      );
    }
    if (
      !stringEq(
        properties['LoadBalancerNames'] ?? [],
        previousProperties['LoadBalancerNames'] ?? []
      )
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'LoadBalancerNames diffs require Attach/Detach calls; use cdkd deploy --replace'
      );
    }
    if (
      !stringEq(properties['TargetGroupARNs'] ?? [], previousProperties['TargetGroupARNs'] ?? [])
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'TargetGroupARNs diffs require Attach/Detach calls; use cdkd deploy --replace'
      );
    }
    try {
      // Sub-shape diffs are applied via separate per-shape SDK calls
      // BEFORE the main UpdateAutoScalingGroup. AWS does not expose these
      // fields on UpdateAutoScalingGroup, so each one rides its own
      // dedicated API. Each per-shape helper is a no-op when the
      // before/after JSON is identical.
      await this.applyMetricsCollectionDiff(
        physicalId,
        properties['MetricsCollection'],
        previousProperties['MetricsCollection']
      );
      await this.applyLifecycleHooksDiff(
        physicalId,
        properties['LifecycleHookSpecificationList'],
        previousProperties['LifecycleHookSpecificationList']
      );
      await this.applyTrafficSourcesDiff(
        physicalId,
        properties['TrafficSources'],
        previousProperties['TrafficSources']
      );
      await this.applyNotificationConfigurationsDiff(
        physicalId,
        properties['NotificationConfigurations'],
        previousProperties['NotificationConfigurations']
      );

      const launchTemplate = this.buildLaunchTemplate(properties);
      const vpcZoneIdentifier = this.joinVpcZoneIdentifier(properties['VPCZoneIdentifier']);

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
          ...(properties['AvailabilityZones'] !== undefined && {
            AvailabilityZones: properties['AvailabilityZones'] as string[],
          }),
          ...(properties['HealthCheckType'] !== undefined && {
            HealthCheckType: properties['HealthCheckType'] as string,
          }),
          ...(properties['HealthCheckGracePeriod'] != null && {
            HealthCheckGracePeriod: Number(properties['HealthCheckGracePeriod']),
          }),
          ...(properties['Cooldown'] != null && {
            DefaultCooldown: Number(properties['Cooldown']),
          }),
          ...(properties['DefaultCooldown'] != null && {
            DefaultCooldown: Number(properties['DefaultCooldown']),
          }),
          ...(properties['TerminationPolicies'] !== undefined && {
            TerminationPolicies: properties['TerminationPolicies'] as string[],
          }),
          ...(properties['NewInstancesProtectedFromScaleIn'] !== undefined && {
            NewInstancesProtectedFromScaleIn: properties[
              'NewInstancesProtectedFromScaleIn'
            ] as boolean,
          }),
          ...(properties['CapacityRebalance'] !== undefined && {
            CapacityRebalance: properties['CapacityRebalance'] as boolean,
          }),
          ...(properties['ServiceLinkedRoleARN'] !== undefined && {
            ServiceLinkedRoleARN: properties['ServiceLinkedRoleARN'] as string,
          }),
          ...(properties['MaxInstanceLifetime'] != null && {
            MaxInstanceLifetime: Number(properties['MaxInstanceLifetime']),
          }),
          ...(properties['Context'] !== undefined && {
            Context: properties['Context'] as string,
          }),
          ...(properties['DesiredCapacityType'] !== undefined && {
            DesiredCapacityType: properties['DesiredCapacityType'] as string,
          }),
          ...(properties['DefaultInstanceWarmup'] != null && {
            DefaultInstanceWarmup: Number(properties['DefaultInstanceWarmup']),
          }),
          ...(properties['AvailabilityZoneDistribution'] !== undefined && {
            AvailabilityZoneDistribution: properties['AvailabilityZoneDistribution'] as never,
          }),
          ...(properties['AvailabilityZoneImpairmentPolicy'] !== undefined && {
            AvailabilityZoneImpairmentPolicy: properties[
              'AvailabilityZoneImpairmentPolicy'
            ] as never,
          }),
          ...(properties['SkipZonalShiftValidation'] !== undefined && {
            SkipZonalShiftValidation: properties['SkipZonalShiftValidation'] as boolean,
          }),
          ...(properties['CapacityReservationSpecification'] !== undefined && {
            CapacityReservationSpecification: properties[
              'CapacityReservationSpecification'
            ] as never,
          }),
          ...(properties['InstanceMaintenancePolicy'] !== undefined && {
            InstanceMaintenancePolicy: properties['InstanceMaintenancePolicy'] as never,
          }),
          ...(properties['DeletionProtection'] !== undefined && {
            DeletionProtection: properties['DeletionProtection'] as never,
          }),
        })
      );

      this.logger.debug(`Successfully updated AutoScalingGroup ${logicalId}`);

      const arn = await this.fetchArn(physicalId);
      const attributes: Record<string, unknown> = {};
      if (arn) attributes['Arn'] = arn;
      if (launchTemplate?.LaunchTemplateId) {
        attributes['LaunchTemplateID'] = launchTemplate.LaunchTemplateId;
      }
      return { physicalId, wasReplaced: false, attributes };
    } catch (error) {
      if (error instanceof ResourceUpdateNotSupportedError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update AutoScalingGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
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
    this.logger.debug(`Deleting AutoScalingGroup ${logicalId}: ${physicalId}`);

    // `--remove-protection`: clear DeletionProtection in-place before the
    // actual delete, then set ForceDelete=true so AWS terminates running
    // instances as part of the delete (matches the "I know what I'm doing"
    // intent of the flag). Without `removeProtection`, ForceDelete stays
    // false and AWS rejects the delete on a group with running instances
    // or DeletionProtection set, surfacing as ProvisioningError. The
    // flip-off is idempotent — AWS accepts UpdateAutoScalingGroup
    // (DeletionProtection: 'none') even when protection is already
    // disabled, so we always issue it under the flag.
    if (context?.removeProtection === true) {
      try {
        await this.getClient().send(
          new UpdateAutoScalingGroupCommand({
            AutoScalingGroupName: physicalId,
            DeletionProtection: 'none' as never,
          })
        );
        this.logger.debug(
          `Disabled DeletionProtection on AutoScalingGroup ${logicalId} before delete`
        );
      } catch (flipError) {
        // Non-fatal: log and proceed. The actual delete below surfaces
        // any real error.
        this.logger.debug(
          `Could not disable DeletionProtection on ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
        );
      }
    }

    try {
      await this.getClient().send(
        new DeleteAutoScalingGroupCommand({
          AutoScalingGroupName: physicalId,
          ForceDelete: context?.removeProtection === true,
        })
      );

      this.logger.debug(`Successfully initiated deletion of AutoScalingGroup ${logicalId}`);

      // Wait for the group to be fully gone. ASG delete is asynchronous —
      // returning immediately would leave dependent EC2 / IAM / SG
      // resources blocked on the lingering group.
      await this.waitForGroupDeleted(physicalId);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`AutoScalingGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete AutoScalingGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const group = await this.describeGroup(physicalId);
    if (!group) {
      throw new ProvisioningError(
        `AutoScalingGroup ${physicalId} not found while resolving attribute ${attributeName}`,
        'AWS::AutoScaling::AutoScalingGroup',
        physicalId,
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
   * Returns `undefined` when the group is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    // Fire the four reads in parallel. Sub-shape failures are best-effort
    // so a single permission gap does not break the whole drift read.
    const groupPromise = (async () => {
      try {
        return await this.describeGroup(physicalId);
      } catch (err) {
        if (this.isNotFoundError(err)) return undefined;
        throw err;
      }
    })();

    const lifecycleHooksPromise = this.getClient()
      .send(new DescribeLifecycleHooksCommand({ AutoScalingGroupName: physicalId }))
      .then((r) => r.LifecycleHooks ?? [])
      .catch((err) => {
        this.logger.debug(
          `DescribeLifecycleHooks(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return [];
      });

    const trafficSourcesPromise = this.getClient()
      .send(new DescribeTrafficSourcesCommand({ AutoScalingGroupName: physicalId }))
      .then((r) => r.TrafficSources ?? [])
      .catch((err) => {
        this.logger.debug(
          `DescribeTrafficSources(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return [];
      });

    const notificationsPromise = this.getClient()
      .send(new DescribeNotificationConfigurationsCommand({ AutoScalingGroupNames: [physicalId] }))
      .then((r) => r.NotificationConfigurations ?? [])
      .catch((err) => {
        this.logger.debug(
          `DescribeNotificationConfigurations(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return [];
      });

    const [group, lifecycleHooks, trafficSources, notifications] = await Promise.all([
      groupPromise,
      lifecycleHooksPromise,
      trafficSourcesPromise,
      notificationsPromise,
    ]);

    if (!group) return undefined;

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
    result['TrafficSources'] = mapTrafficSourcesToCfn(trafficSources);
    result['NotificationConfigurations'] = mapNotificationsToCfn(notifications);

    return result;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private buildLaunchTemplate(
    properties: Record<string, unknown>
  ): LaunchTemplateSpecification | undefined {
    const lt = properties['LaunchTemplate'] as
      | { LaunchTemplateId?: string; LaunchTemplateName?: string; Version?: string | number }
      | undefined;
    if (!lt) return undefined;
    const out: LaunchTemplateSpecification = {};
    if (lt.LaunchTemplateId !== undefined) out.LaunchTemplateId = lt.LaunchTemplateId;
    if (lt.LaunchTemplateName !== undefined) out.LaunchTemplateName = lt.LaunchTemplateName;
    if (lt.Version !== undefined) {
      // Defensive coercion: AWS SDK `LaunchTemplateSpecification.Version`
      // is `string` and AWS rejects non-string forms with `Invalid
      // launch template version: either '$Default', '$Latest', or a
      // numeric version are allowed.`. cdkd's `IntrinsicResolver`
      // resolves `Fn::GetAtt <LaunchTemplate>.LatestVersionNumber`
      // through a per-type lookup; intermediate cases could surface
      // numeric values, so we coerce defensively.
      out.Version = String(lt.Version);
    }
    if (out.LaunchTemplateId === undefined && out.LaunchTemplateName === undefined) {
      return undefined;
    }
    return out;
  }

  /**
   * CFn `Tags` is `[{Key, Value, PropagateAtLaunch?}]`. AWS expects each
   * tag to also carry `ResourceId: <groupName>` and `ResourceType:
   * 'auto-scaling-group'`. We tack those on at create time so the SDK
   * input shape matches without forcing the user to template them.
   */
  private buildTags(groupName: string, properties: Record<string, unknown>): ASGTag[] {
    const raw = properties['Tags'] as
      | Array<{ Key?: string; Value?: string; PropagateAtLaunch?: boolean }>
      | undefined;
    if (!raw) return [];
    return raw
      .filter((t) => t.Key !== undefined)
      .map((t) => ({
        ResourceId: groupName,
        ResourceType: 'auto-scaling-group',
        Key: t.Key as string,
        Value: t.Value ?? '',
        PropagateAtLaunch: t.PropagateAtLaunch ?? false,
      }));
  }

  /**
   * CFn `VPCZoneIdentifier` is a list of subnet ids; the AWS SDK input
   * field is a comma-joined string.
   */
  private joinVpcZoneIdentifier(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
      const cleaned = value.map((v) => String(v).trim()).filter((v) => v.length > 0);
      if (cleaned.length === 0) return undefined;
      return cleaned.join(',');
    }
    if (typeof value === 'string') return value;
    return undefined;
  }

  private async describeGroup(groupName: string) {
    const response = await this.getClient().send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [groupName],
      })
    );
    return response.AutoScalingGroups?.[0];
  }

  private async fetchArn(groupName: string): Promise<string | undefined> {
    try {
      const group = await this.describeGroup(groupName);
      return group?.AutoScalingGroupARN;
    } catch (err) {
      this.logger.debug(
        `DescribeAutoScalingGroups(${groupName}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    // ASG returns ValidationError with message "AutoScalingGroup name not
    // found" rather than a typed NotFound exception; cover both shapes.
    return (
      name === 'ValidationError' &&
      (message.includes('autoscalinggroup name not found') ||
        message.includes('not found') ||
        message.includes('does not exist'))
    );
  }

  private async waitForGroupDeleted(groupName: string, maxWaitMs = 900_000): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const group = await this.describeGroup(groupName);
        if (!group) return;
      } catch (error) {
        if (this.isNotFoundError(error)) return;
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(
      `Timed out waiting for AutoScalingGroup ${groupName} to be deleted (15 minute cap)`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Sub-shape diff helpers ───────────────────────────────────────
  // Each helper is a no-op when before/after JSON is identical (the cheap
  // structural-equality check happens first; we only build SDK calls for
  // genuine diffs). Identity is positional within the array per CFn shape:
  // `MetricsCollection` keyed on `Granularity`, `LifecycleHookSpecification
  // List` on `LifecycleHookName`, `TrafficSources` on `Identifier`,
  // `NotificationConfigurations` on `TopicARN`.

  private async applyMetricsCollectionDiff(
    physicalId: string,
    next: unknown,
    prev: unknown
  ): Promise<void> {
    if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
    const nextEntries = (Array.isArray(next) ? next : []) as Array<{
      Granularity?: string;
      Metrics?: string[];
    }>;
    const prevEntries = (Array.isArray(prev) ? prev : []) as Array<{
      Granularity?: string;
      Metrics?: string[];
    }>;
    const prevByGranularity = new Map<string, string[] | undefined>();
    for (const e of prevEntries) {
      if (e.Granularity) prevByGranularity.set(e.Granularity, e.Metrics);
    }
    const nextByGranularity = new Map<string, string[] | undefined>();
    for (const e of nextEntries) {
      if (e.Granularity) nextByGranularity.set(e.Granularity, e.Metrics);
    }
    // Disable removed granularities first, then issue Enable for the
    // intended state of every Granularity in `next`. AWS treats Enable as
    // additive within a Granularity, so a remove-then-add pattern works
    // even when the Metrics list shrinks.
    for (const [granularity, metrics] of prevByGranularity) {
      if (!nextByGranularity.has(granularity)) {
        await this.getClient().send(
          new DisableMetricsCollectionCommand({
            AutoScalingGroupName: physicalId,
            ...(metrics && metrics.length > 0 ? { Metrics: metrics } : {}),
          })
        );
      }
    }
    for (const [granularity, metrics] of nextByGranularity) {
      const before = prevByGranularity.get(granularity);
      if (JSON.stringify(before ?? null) === JSON.stringify(metrics ?? null)) continue;
      // If the Metrics list shrunk, disable the removed metrics first
      // (AWS Enable is additive). When `metrics` is undefined or empty,
      // AWS treats that as "all metrics" — disable any prior subset
      // before re-enabling the full set.
      if (before && before.length > 0) {
        const removed = metrics ? before.filter((m) => !metrics.includes(m)) : [];
        if (removed.length > 0) {
          await this.getClient().send(
            new DisableMetricsCollectionCommand({
              AutoScalingGroupName: physicalId,
              Metrics: removed,
            })
          );
        }
      }
      await this.getClient().send(
        new EnableMetricsCollectionCommand({
          AutoScalingGroupName: physicalId,
          Granularity: granularity,
          ...(metrics && metrics.length > 0 ? { Metrics: metrics } : {}),
        })
      );
    }
  }

  private async applyLifecycleHooksDiff(
    physicalId: string,
    next: unknown,
    prev: unknown
  ): Promise<void> {
    if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
    const nextEntries = (Array.isArray(next) ? next : []) as Array<{
      LifecycleHookName?: string;
      LifecycleTransition?: string;
      RoleARN?: string;
      NotificationTargetARN?: string;
      NotificationMetadata?: string;
      HeartbeatTimeout?: number;
      DefaultResult?: string;
    }>;
    const prevEntries = (Array.isArray(prev) ? prev : []) as Array<{
      LifecycleHookName?: string;
    }>;
    const nextNames = new Set(
      nextEntries.map((e) => e.LifecycleHookName).filter((n): n is string => !!n)
    );
    // Delete hooks no longer in `next`.
    for (const e of prevEntries) {
      if (e.LifecycleHookName && !nextNames.has(e.LifecycleHookName)) {
        await this.getClient().send(
          new DeleteLifecycleHookCommand({
            AutoScalingGroupName: physicalId,
            LifecycleHookName: e.LifecycleHookName,
          })
        );
      }
    }
    // PutLifecycleHook is upsert — issue for every hook in `next` whose
    // shape differs from the matching `prev` entry.
    const prevByName = new Map<string, unknown>();
    for (const e of prevEntries) {
      if (e.LifecycleHookName) prevByName.set(e.LifecycleHookName, e);
    }
    for (const e of nextEntries) {
      if (!e.LifecycleHookName) continue;
      const prevHook = prevByName.get(e.LifecycleHookName);
      if (JSON.stringify(prevHook) === JSON.stringify(e)) continue;
      await this.getClient().send(
        new PutLifecycleHookCommand({
          AutoScalingGroupName: physicalId,
          LifecycleHookName: e.LifecycleHookName,
          ...(e.LifecycleTransition !== undefined && {
            LifecycleTransition: e.LifecycleTransition,
          }),
          ...(e.RoleARN !== undefined && { RoleARN: e.RoleARN }),
          ...(e.NotificationTargetARN !== undefined && {
            NotificationTargetARN: e.NotificationTargetARN,
          }),
          ...(e.NotificationMetadata !== undefined && {
            NotificationMetadata: e.NotificationMetadata,
          }),
          ...(e.HeartbeatTimeout !== undefined && { HeartbeatTimeout: e.HeartbeatTimeout }),
          ...(e.DefaultResult !== undefined && { DefaultResult: e.DefaultResult }),
        })
      );
    }
  }

  private async applyTrafficSourcesDiff(
    physicalId: string,
    next: unknown,
    prev: unknown
  ): Promise<void> {
    if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
    const nextEntries = (Array.isArray(next) ? next : []) as Array<{
      Identifier?: string;
      Type?: string;
    }>;
    const prevEntries = (Array.isArray(prev) ? prev : []) as Array<{
      Identifier?: string;
      Type?: string;
    }>;
    const nextIds = new Set(nextEntries.map((e) => e.Identifier).filter((i): i is string => !!i));
    const prevIds = new Set(prevEntries.map((e) => e.Identifier).filter((i): i is string => !!i));
    const toDetach = prevEntries.filter((e) => e.Identifier && !nextIds.has(e.Identifier));
    const toAttach = nextEntries.filter((e) => e.Identifier && !prevIds.has(e.Identifier));
    if (toDetach.length > 0) {
      await this.getClient().send(
        new DetachTrafficSourcesCommand({
          AutoScalingGroupName: physicalId,
          TrafficSources: toDetach.map((e) => ({
            Identifier: e.Identifier as string,
            ...(e.Type !== undefined && { Type: e.Type }),
          })),
        })
      );
    }
    if (toAttach.length > 0) {
      await this.getClient().send(
        new AttachTrafficSourcesCommand({
          AutoScalingGroupName: physicalId,
          TrafficSources: toAttach.map((e) => ({
            Identifier: e.Identifier as string,
            ...(e.Type !== undefined && { Type: e.Type }),
          })),
        })
      );
    }
  }

  private async applyNotificationConfigurationsDiff(
    physicalId: string,
    next: unknown,
    prev: unknown
  ): Promise<void> {
    if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
    // CFn `NotificationConfigurations` is an array of `{TopicARN,
    // NotificationTypes[]}`; AWS `PutNotificationConfiguration` is keyed
    // by TopicARN — one call per topic. AWS reports each notification
    // type as a separate response entry (one row per `(asgName, topicArn,
    // notificationType)` triple), but cdkd state stores the CFn shape, so
    // both sides of the diff share the per-topic key.
    const nextEntries = (Array.isArray(next) ? next : []) as Array<{
      TopicARN?: string;
      NotificationTypes?: string[];
    }>;
    const prevEntries = (Array.isArray(prev) ? prev : []) as Array<{
      TopicARN?: string;
      NotificationTypes?: string[];
    }>;
    const nextByTopic = new Map<string, string[] | undefined>();
    for (const e of nextEntries) {
      if (e.TopicARN) nextByTopic.set(e.TopicARN, e.NotificationTypes);
    }
    const prevByTopic = new Map<string, string[] | undefined>();
    for (const e of prevEntries) {
      if (e.TopicARN) prevByTopic.set(e.TopicARN, e.NotificationTypes);
    }
    for (const topic of prevByTopic.keys()) {
      if (!nextByTopic.has(topic)) {
        await this.getClient().send(
          new DeleteNotificationConfigurationCommand({
            AutoScalingGroupName: physicalId,
            TopicARN: topic,
          })
        );
      }
    }
    for (const [topic, types] of nextByTopic) {
      const before = prevByTopic.get(topic);
      if (JSON.stringify(before ?? null) === JSON.stringify(types ?? null)) continue;
      await this.getClient().send(
        new PutNotificationConfigurationCommand({
          AutoScalingGroupName: physicalId,
          TopicARN: topic,
          NotificationTypes: types ?? [],
        })
      );
    }
  }
}

// ─── File-level reverse-mappers (CFn template shape) ────────────────

/**
 * Reverse-map AWS `EnabledMetrics: [{Metric, Granularity}]` (flat list,
 * one row per enabled metric) back to the CFn array shape
 * `[{Granularity, Metrics?[]}]`. Metrics with the same Granularity are
 * grouped together; the resulting Metrics list is sorted alphabetically
 * for stable positional compare in the drift comparator.
 *
 * Always returns a placeholder `[]` per the cdkd PR #145 always-emit
 * convention so a console-side EnableMetricsCollection on a previously-
 * empty group surfaces as drift on the v3 `observedProperties` baseline.
 */
function mapEnabledMetricsToCfn(
  enabledMetrics:
    | Array<{ Metric?: string | undefined; Granularity?: string | undefined }>
    | undefined
): Array<{ Granularity: string; Metrics?: string[] }> {
  if (!enabledMetrics || enabledMetrics.length === 0) return [];
  const byGranularity = new Map<string, Set<string>>();
  for (const e of enabledMetrics) {
    const g = e.Granularity;
    if (!g) continue;
    let set = byGranularity.get(g);
    if (!set) {
      set = new Set();
      byGranularity.set(g, set);
    }
    if (e.Metric) set.add(e.Metric);
  }
  const result: Array<{ Granularity: string; Metrics?: string[] }> = [];
  // Sort by Granularity for stable positional compare.
  for (const granularity of Array.from(byGranularity.keys()).sort()) {
    const metrics = Array.from(byGranularity.get(granularity) ?? []).sort();
    result.push(
      metrics.length > 0
        ? { Granularity: granularity, Metrics: metrics }
        : { Granularity: granularity }
    );
  }
  return result;
}

/**
 * Reverse-map AWS `DescribeLifecycleHooks` response to the CFn
 * `LifecycleHookSpecificationList` shape. Each hook is surfaced under the
 * exact CFn property name. AWS-side fields cdkd state never carried
 * (`AutoScalingGroupName` — duplicated on every hook by AWS,
 * `GlobalTimeout` — AWS-derived) are filtered out. Sorted by
 * LifecycleHookName for stable positional compare.
 */
function mapLifecycleHooksToCfn(
  hooks: Array<{
    LifecycleHookName?: string | undefined;
    LifecycleTransition?: string | undefined;
    NotificationTargetARN?: string | undefined;
    RoleARN?: string | undefined;
    NotificationMetadata?: string | undefined;
    HeartbeatTimeout?: number | undefined;
    DefaultResult?: string | undefined;
  }>
): Array<Record<string, unknown>> {
  if (!hooks || hooks.length === 0) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const h of hooks) {
    if (!h.LifecycleHookName) continue;
    const entry: Record<string, unknown> = { LifecycleHookName: h.LifecycleHookName };
    if (h.LifecycleTransition !== undefined) entry['LifecycleTransition'] = h.LifecycleTransition;
    if (h.RoleARN !== undefined) entry['RoleARN'] = h.RoleARN;
    if (h.NotificationTargetARN !== undefined) {
      entry['NotificationTargetARN'] = h.NotificationTargetARN;
    }
    if (h.NotificationMetadata !== undefined) {
      entry['NotificationMetadata'] = h.NotificationMetadata;
    }
    if (h.HeartbeatTimeout !== undefined) entry['HeartbeatTimeout'] = h.HeartbeatTimeout;
    if (h.DefaultResult !== undefined) entry['DefaultResult'] = h.DefaultResult;
    result.push(entry);
  }
  result.sort((a, b) =>
    String(a['LifecycleHookName']).localeCompare(String(b['LifecycleHookName']))
  );
  return result;
}

/**
 * Reverse-map AWS `DescribeTrafficSources` response to the CFn
 * `TrafficSources` shape `[{Identifier, Type?}]`. AWS-side runtime fields
 * (`State`, the deprecated `TrafficSource` alias) are filtered out.
 * Sorted by Identifier for stable positional compare.
 */
function mapTrafficSourcesToCfn(
  trafficSources: Array<{ Identifier?: string | undefined; Type?: string | undefined }>
): Array<Record<string, unknown>> {
  if (!trafficSources || trafficSources.length === 0) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const t of trafficSources) {
    if (!t.Identifier) continue;
    const entry: Record<string, unknown> = { Identifier: t.Identifier };
    if (t.Type !== undefined) entry['Type'] = t.Type;
    result.push(entry);
  }
  result.sort((a, b) => String(a['Identifier']).localeCompare(String(b['Identifier'])));
  return result;
}

/**
 * Reverse-map AWS `DescribeNotificationConfigurations` (a flat list, one
 * row per `(topicArn, notificationType)`) into the CFn shape
 * `[{TopicARN, NotificationTypes[]}]`. NotificationTypes are grouped per
 * TopicARN and sorted alphabetically for stable positional compare.
 */
function mapNotificationsToCfn(
  configurations: Array<{ TopicARN?: string | undefined; NotificationType?: string | undefined }>
): Array<Record<string, unknown>> {
  if (!configurations || configurations.length === 0) return [];
  const byTopic = new Map<string, Set<string>>();
  for (const c of configurations) {
    if (!c.TopicARN) continue;
    let set = byTopic.get(c.TopicARN);
    if (!set) {
      set = new Set();
      byTopic.set(c.TopicARN, set);
    }
    if (c.NotificationType) set.add(c.NotificationType);
  }
  const result: Array<Record<string, unknown>> = [];
  for (const topic of Array.from(byTopic.keys()).sort()) {
    const types = Array.from(byTopic.get(topic) ?? []).sort();
    result.push({ TopicARN: topic, NotificationTypes: types });
  }
  return result;
}
