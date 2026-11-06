import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  type DescribeAutoScalingGroupsCommandOutput,
  type Tag as ASGTag,
  type LaunchTemplateSpecification,
} from '@aws-sdk/client-auto-scaling';
import { EC2Client } from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import {
  getClient,
  getCreateClient,
  getEc2Client,
  wrapCaughtError,
  wrapUpdateError,
  buildLaunchTemplate,
  buildTags,
  joinVpcZoneIdentifier,
  describeGroup,
  fetchArn,
  isNotFoundError,
  sleep,
} from './asg/core.js';
import { create, retireFailedCreate } from './asg/create.js';
import { update } from './asg/update.js';
import {
  deleteImpl,
  settleInstanceFlips,
  reEnableLaunchedInstance,
  releaseInstanceFlips,
  deleteGroupUnderCompensation,
  deleteOnce,
  removeInstanceTerminationProtection,
  removeInstanceTerminationProtectionForDelete,
  listGroupInstanceIds,
  waitForGroupDeleted,
} from './asg/delete.js';
import {
  canonicalizeDriftProperties,
  canonicalizeDriftPair,
  getAttribute,
  readCurrentState,
} from './asg/read-state.js';
import {
  readUpdateLists,
  recordedListRepair,
  applyTagsDiff,
  applyLoadBalancerNamesDiff,
  applyTargetGroupArnsDiff,
  applyMetricsCollectionDiff,
  applyLifecycleHooksDiff,
  applyTrafficSourcesDiff,
  applyNotificationConfigurationsDiff,
} from './asg/update-lists.js';
import type { AttachmentKind, ListKind, ListRead } from './asg/shared.js';
export {
  ALL_GROUP_METRICS,
  foldMetricsCollection,
  autoScalingGroupProtectionSite,
  LaunchedInstanceGoneError,
  autoScalingGroupInstanceProtectionSite,
} from './asg/shared.js';

export class ASGProvider implements ResourceProvider {
  asgClient?: AutoScalingClient;
  createClient?: AutoScalingClient;
  ec2Client?: EC2Client;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('ASGProvider');
  /** `--remove-protection` flips per group, kept across `delete()` re-entry (#2204). */
  readonly protectionFlips = new ProtectionFlipRegistry();
  /**
   * The `DeletionProtection` level each flip record's flip removed. Keyed by
   * the RECORD, not the group, so it lives and dies with it: the registry
   * hands a re-entered `delete()` the same record (and so this level), and a
   * released or aged-out record takes its level with it.
   */
  readonly removedProtection = new WeakMap<ProtectionFlipRecord, string>();
  /**
   * `--remove-protection` flips of `DisableApiTermination` on the instances a
   * group launched (issues #796 / #2204), one record per INSTANCE, so each
   * latches across `delete()` re-entry like the group's own record, and a
   * failed re-enable keeps its record for a later delete to retry.
   */
  readonly instanceProtectionFlips = new ProtectionFlipRegistry();
  /**
   * The instances whose flip records each GROUP record's attempts acquired,
   * keyed by that record for the reason {@link removedProtection} is: a
   * terminal failure on a re-entered attempt must still restore an instance
   * an EARLIER attempt flipped, even when the later describe no longer lists
   * it.
   */
  readonly groupInstanceFlips = new WeakMap<
    ProtectionFlipRecord,
    Map<string, ProtectionFlipRecord>
  >();

  /**
   * Issue #1160: the reset `UpdateAutoScalingGroup` is sent for a property the
   * template REMOVED (models_0.d.ts = the AWS SDK command/model doc).
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::AutoScaling::AutoScalingGroup',
      new Map<string, unknown>([
        // go-to-k/cdkd#5004 and #1160 (real CloudFormation A/Bs, us-east-1):
        // CloudFormation RESETS five members on removal, so cdkd resets them
        // too: the three below, plus MaxInstanceLifetime and
        // AvailabilityZoneImpairmentPolicy, which `update()` resets locally. The
        // other nine members of this type (HealthCheckType,
        // HealthCheckGracePeriod, Cooldown, TerminationPolicies,
        // NewInstancesProtectedFromScaleIn, CapacityRebalance,
        // DesiredCapacityType, DefaultInstanceWarmup, DeletionProtection) are
        // KEPT at their live value by CloudFormation, so they are deliberately
        // absent from this table and from the local clears in `update()`.
        // SDK doc: "To clear a previously set value, specify a value of -1."
        ['InstanceMaintenancePolicy', { MinHealthyPercentage: -1, MaxHealthyPercentage: -1 }],
        // SDK doc: "default - Auto Scaling uses the Capacity Reservation
        // preference from your launch template or an open Capacity
        // Reservation." — the behavior of a group that never set the field.
        ['CapacityReservationSpecification', { CapacityReservationPreference: 'default' }],
        // SDK doc: "The default is balanced-best-effort."
        ['AvailabilityZoneDistribution', { CapacityDistributionStrategy: 'balanced-best-effort' }],
      ]),
    ],
  ]);

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
        'AvailabilityZoneIds',
        'PlacementGroup',
        'InstanceLifecyclePolicy',
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

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::AutoScaling::AutoScalingGroup',
      new Map<string, string>([
        [
          'LaunchConfigurationName',
          'AWS Launch Configurations end-of-life 2024-10; use LaunchTemplate instead',
        ],
        [
          'NotificationConfiguration',
          'Legacy singular form; use NotificationConfigurations (plural) which cdkd already wires',
        ],
        [
          'InstanceId',
          'CreateAutoScalingGroup derives a new launch configuration from the instance, and AWS Launch Configurations are end-of-life 2024-10 like LaunchConfigurationName; use LaunchTemplate instead',
        ],
      ]),
    ],
  ]);
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDriftProperties.call(this, resourceType, properties);
  }

  canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return canonicalizeDriftPair.call(this, resourceType, baseline, aws);
  }

  getClient(): AutoScalingClient {
    return getClient.call(this);
  }

  getCreateClient(): AutoScalingClient {
    return getCreateClient.call(this);
  }

  getEc2Client(): EC2Client {
    return getEc2Client.call(this);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  retireFailedCreate(
    groupName: string,
    logicalId: string,
    properties: Record<string, unknown>,
    maskSecrets: SecretMasker
  ): Promise<string | undefined> {
    return retireFailedCreate.call(this, groupName, logicalId, properties, maskSecrets);
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

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  wrapUpdateError(
    error: unknown,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    maskSecrets: MaskerFn | undefined
  ): ProvisioningError {
    return wrapUpdateError.call(this, error, resourceType, logicalId, physicalId, maskSecrets);
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

  settleInstanceFlips(
    logicalId: string,
    groupFlip: ProtectionFlipRecord,
    error: unknown,
    region: string | undefined,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return settleInstanceFlips.call(this, logicalId, groupFlip, error, region, mask);
  }

  reEnableLaunchedInstance(instanceId: string): Promise<void> {
    return reEnableLaunchedInstance.call(this, instanceId);
  }

  releaseInstanceFlips(groupFlip: ProtectionFlipRecord, region: string | undefined): void {
    return releaseInstanceFlips.call(this, groupFlip, region);
  }

  deleteGroupUnderCompensation(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    removedValue: () => string | undefined,
    onFlip: (flip: ProtectionFlipRecord) => void
  ): Promise<void> {
    return deleteGroupUnderCompensation.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      context,
      removedValue,
      onFlip
    );
  }

  deleteOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteOnce.call(this, logicalId, physicalId, resourceType, context, flip);
  }

  getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName, logicalId);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  buildLaunchTemplate(
    properties: Record<string, unknown>
  ): LaunchTemplateSpecification | undefined {
    return buildLaunchTemplate.call(this, properties);
  }

  buildTags(groupName: string, properties: Record<string, unknown>): ASGTag[] {
    return buildTags.call(this, groupName, properties);
  }

  joinVpcZoneIdentifier(value: unknown): string | undefined {
    return joinVpcZoneIdentifier.call(this, value);
  }

  describeGroup(groupName: string) {
    return describeGroup.call(this, groupName);
  }

  removeInstanceTerminationProtection(
    groupName: string,
    logicalId: string,
    // AWS's describe error can echo the group name, which may be a resolved
    // secret on the create path.
    maskSecrets: SecretMasker,
    // Instances already flipped by an earlier pass of the same retire.
    alreadyFlipped: Set<string>
  ): Promise<void> {
    return removeInstanceTerminationProtection.call(
      this,
      groupName,
      logicalId,
      maskSecrets,
      alreadyFlipped
    );
  }

  removeInstanceTerminationProtectionForDelete(
    groupName: string,
    logicalId: string,
    groupFlip: ProtectionFlipRecord,
    region: string | undefined
  ): Promise<void> {
    return removeInstanceTerminationProtectionForDelete.call(
      this,
      groupName,
      logicalId,
      groupFlip,
      region
    );
  }

  listGroupInstanceIds(
    groupName: string,
    logicalId: string,
    maskSecrets: SecretMasker
  ): Promise<string[] | undefined> {
    return listGroupInstanceIds.call(this, groupName, logicalId, maskSecrets);
  }

  fetchArn(
    groupName: string,
    // The create path passes its masker: the name may be a resolved secret.
    maskSecrets: SecretMasker = (text) => text
  ): Promise<string | undefined> {
    return fetchArn.call(this, groupName, maskSecrets);
  }

  isNotFoundError(error: unknown): boolean {
    return isNotFoundError.call(this, error);
  }

  waitForGroupDeleted(groupName: string, maxWaitMs = 900_000): Promise<void> {
    return waitForGroupDeleted.call(this, groupName, maxWaitMs);
  }

  sleep(ms: number): Promise<void> {
    return sleep.call(this, ms);
  }

  readUpdateLists(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    desired: Record<ListKind, unknown>,
    recorded: Record<ListKind, unknown>
  ): Promise<{
    next: Record<ListKind, unknown[]>;
    prev: Record<ListKind, unknown[]>;
    /** Live entries an unreadable record hid, left attached on purpose. */
    retained: Record<AttachmentKind, string[]>;
  }> {
    return readUpdateLists.call(this, logicalId, physicalId, resourceType, desired, recorded);
  }

  recordedListRepair(kinds: ListKind[], read: Record<ListKind, ListRead>): string {
    return recordedListRepair.call(this, kinds, read);
  }

  applyTagsDiff(physicalId: string, next: unknown[], prev: unknown[]): Promise<void> {
    return applyTagsDiff.call(this, physicalId, next, prev);
  }

  applyLoadBalancerNamesDiff(
    physicalId: string,
    nextNames: string[],
    prevNames: string[]
  ): Promise<void> {
    return applyLoadBalancerNamesDiff.call(this, physicalId, nextNames, prevNames);
  }

  applyTargetGroupArnsDiff(
    physicalId: string,
    nextArns: string[],
    prevArns: string[],
    maskSecrets?: SecretMasker,
    // Live target groups a secret-derived record hid, which this update leaves
    // attached: the convergence poll must expect them too (go-to-k/cdkd#3948).
    retainedArns: string[] = []
  ): Promise<void> {
    return applyTargetGroupArnsDiff.call(
      this,
      physicalId,
      nextArns,
      prevArns,
      maskSecrets,
      retainedArns
    );
  }

  private static readonly TG_CONVERGENCE_TIMEOUT_MS = 30_000;
  private static readonly TG_CONVERGENCE_POLL_INTERVAL_MS = 1_000;

  /**
   * `maskSecrets` is the caller's secret masker (issue #1932 item 3, adopted
   * here by issue #1997), threaded from `UpdateContext` via
   * `applyTargetGroupArnsDiff`. `expected` is built from the RESOLVED
   * `TargetGroupARNs` bag, so a `{{resolve:secretsmanager:...}}` scalar in it is
   * already plaintext by the time this method names it. It defaults to IDENTITY
   * so every existing caller and unit test keeps working unchanged.
   */
  async waitForTargetGroupArnsConvergence(
    physicalId: string,
    expected: Set<string>,
    maskSecrets: SecretMasker = (text) => text
  ): Promise<void> {
    // ONE masked sink per level for every line in this method (issue #1997),
    // rather than a `maskSecrets(...)` at each call: a line added later is
    // masked by construction instead of by the author remembering. Each is the
    // OUTER of two layers — a finished message is always longer than the value
    // inside it, so it can only reach `maskSecretsInText`'s SUBSTRING arm, which
    // ignores needles below `MIN_NEEDLE_LENGTH` (4); the per-ARN mask below is
    // the inner layer, reaching the WHOLE-VALUE arm at any length.
    const warn = (message: string): void => this.logger.warn(maskSecrets(message));
    const debug = (message: string): void => this.logger.debug(maskSecrets(message));
    const deadlineMs = Date.now() + ASGProvider.TG_CONVERGENCE_TIMEOUT_MS;
    let lastObserved: Set<string> = new Set();
    while (Date.now() < deadlineMs) {
      let resp: DescribeAutoScalingGroupsCommandOutput | undefined;
      try {
        resp = await this.getClient().send(
          new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [physicalId] })
        );
      } catch (err) {
        // Transient throttle / network blip during the 30s window must
        // not throw out of applyTargetGroupArnsDiff — the Attach/Detach
        // already succeeded, and propagating would fail the whole
        // update path. Log + retry; the loop will fall through to the
        // timeout-warn path if the API is genuinely down.
        debug(
          `applyTargetGroupArnsDiff convergence poll: transient error, retrying — ${
            describeAwsFailure(err).detail
          }`
        );
        await new Promise((r) => setTimeout(r, ASGProvider.TG_CONVERGENCE_POLL_INTERVAL_MS));
        continue;
      }
      lastObserved = new Set(resp.AutoScalingGroups?.[0]?.TargetGroupARNs ?? []);
      if (lastObserved.size === expected.size && [...expected].every((a) => lastObserved.has(a))) {
        return;
      }
      await new Promise((r) => setTimeout(r, ASGProvider.TG_CONVERGENCE_POLL_INTERVAL_MS));
    }
    // Timeout — surface as a warning rather than failure so the caller
    // still sees the SDK-side success; drift can re-report if the
    // propagation is still stuck. Includes observed vs expected so
    // post-mortem doesn't need a re-deploy.
    // Sort both sides before stringify for visual symmetry — expected
    // comes from the caller's insertion order, observed from AWS-side
    // order; eyeballing the diff in logs is easier when both are sorted.
    //
    // Each ARN is masked INDIVIDUALLY before being stringified (issue #1997):
    // `JSON.stringify` escapes `"` / `\` / newlines, so a secret carrying any of
    // them no longer OCCURS in the finished line and the outer sink alone would
    // miss it. The observed side is masked too — it comes back from AWS, but a
    // resolved secret sent by an earlier deploy is exactly what AWS echoes.
    const expectedSorted = [...expected].sort().map((a) => maskSecrets(a));
    const observedSorted = [...lastObserved].sort().map((a) => maskSecrets(a));
    warn(
      `applyTargetGroupArnsDiff: TG set did not converge within ${ASGProvider.TG_CONVERGENCE_TIMEOUT_MS}ms for ASG ${physicalId}. expected=${JSON.stringify(expectedSorted)} observed=${JSON.stringify(observedSorted)}`
    );
  }
  applyMetricsCollectionDiff(physicalId: string, next: unknown[], prev: unknown[]): Promise<void> {
    return applyMetricsCollectionDiff.call(this, physicalId, next, prev);
  }

  applyLifecycleHooksDiff(physicalId: string, next: unknown[], prev: unknown[]): Promise<void> {
    return applyLifecycleHooksDiff.call(this, physicalId, next, prev);
  }

  applyTrafficSourcesDiff(physicalId: string, next: unknown[], prev: unknown[]): Promise<void> {
    return applyTrafficSourcesDiff.call(this, physicalId, next, prev);
  }

  applyNotificationConfigurationsDiff(
    physicalId: string,
    next: unknown[],
    prev: unknown[]
  ): Promise<void> {
    return applyNotificationConfigurationsDiff.call(this, physicalId, next, prev);
  }
}
