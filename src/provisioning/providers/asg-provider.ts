import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
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
 * `AutoScalingGroupName`, `Tags` (those go through `CreateOrUpdateTags` /
 * `DeleteTags`), or attached LB / target-group references (those go through
 * `Attach*` / `Detach*` calls). For v1 those diffs surface
 * `ResourceUpdateNotSupportedError` so the caller can `cdkd deploy
 * --replace`. The mutable fields handled in-place include MinSize / MaxSize /
 * DesiredCapacity / VPCZoneIdentifier / HealthCheckType / HealthCheckGrace
 * Period / DefaultCooldown / Cooldown / NewInstancesProtectedFromScaleIn /
 * MaxInstanceLifetime / TerminationPolicies / CapacityRebalance / Service
 * LinkedRoleARN / Context / DesiredCapacityType / DefaultInstanceWarmup /
 * AvailabilityZones / AvailabilityZoneDistribution / AvailabilityZone
 * ImpairmentPolicy / SkipZonalShiftValidation / CapacityReservation
 * Specification / InstanceMaintenancePolicy / DeletionProtection /
 * MixedInstancesPolicy / LaunchTemplate.
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
    if (
      !stringEq(
        properties['LifecycleHookSpecificationList'] ?? [],
        previousProperties['LifecycleHookSpecificationList'] ?? []
      )
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'LifecycleHookSpecificationList diffs require PutLifecycleHook / DeleteLifecycleHook calls; use cdkd deploy --replace'
      );
    }
    if (
      !stringEq(
        properties['MetricsCollection'] ?? [],
        previousProperties['MetricsCollection'] ?? []
      )
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'MetricsCollection diffs require EnableMetricsCollection / DisableMetricsCollection calls; use cdkd deploy --replace'
      );
    }
    if (!stringEq(properties['TrafficSources'] ?? [], previousProperties['TrafficSources'] ?? [])) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'TrafficSources diffs require AttachTrafficSources / DetachTrafficSources calls; use cdkd deploy --replace'
      );
    }

    try {
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
   * Returns `undefined` when the group is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let group;
    try {
      group = await this.describeGroup(physicalId);
    } catch (err) {
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
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
    return result;
  }

  /**
   * MetricsCollection / LifecycleHookSpecificationList / TrafficSources
   * are surfaced via separate APIs (`DescribeMetricsCollectionTypes` etc.
   * + `DescribeLifecycleHooks` + `DescribeTrafficSources`) that this v1
   * does not yet wire up — declare them as drift-unknown so the comparator
   * does not fire false-positive drift on every clean run.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [
      'MetricsCollection',
      'LifecycleHookSpecificationList',
      'TrafficSources',
      'NotificationConfigurations',
    ];
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
}
