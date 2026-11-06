import {
  EMRClient,
  type Cluster,
  type JobFlowInstancesConfig,
  type InstanceGroup,
  type InstanceFleet,
  type InstanceGroupConfig,
  type InstanceFleetConfig,
  type InstanceRoleType,
  type InstanceFleetType,
  type ManagedScalingPolicy,
  type AutoTerminationPolicy,
} from '@aws-sdk/client-emr';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MUTABLE_TOP_LEVEL_PROPS,
  LEFT_IN_PLACE_ON_REMOVAL,
  type InstancesInPlacePlan,
  type InstancesTargets,
} from './emr-cluster/shared.js';
import {
  wrapStatusReasonError,
  wrapCaughtError,
  cleanupFailureText,
  getClient,
  getCreateClient,
} from './emr-cluster/core.js';
import {
  create,
  toJobFlowInstancesConfig,
  toInstanceGroupConfig,
  toInstanceFleetConfig,
  toManagedScalingPolicy,
  toAutoTerminationPolicy,
} from './emr-cluster/create.js';
import {
  resolveInstancesTargets,
  applyInstancesResizes,
  update,
  applyTagDiff,
} from './emr-cluster/update.js';
import {
  deleteImpl,
  deleteOnce,
  describeForPoll,
  waitForClusterReady,
  waitForClusterTerminated,
} from './emr-cluster/delete.js';
import {
  buildAttributes,
  getAttribute,
  isSameResource,
  readClusterIdentity,
  importImpl,
  describeClusterOrUndefined,
  readCurrentState,
  listInstanceGroups,
  listInstanceFleets,
  reverseInstancesToCfn,
  reverseInstanceGroup,
  reverseInstanceFleet,
} from './emr-cluster/read-state.js';
export {
  resetEMRClusterCreateRetryStateForTests,
  emrClusterProtectionSite,
} from './emr-cluster/shared.js';

/**
 * SDK Provider for `AWS::EMR::Cluster` (EMR on EC2).
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE` in the CFn registry, so
 * cdkd's Cloud Control fallback cannot handle it (issue #1043) — pre-flight
 * would otherwise reject it via `unsupported-types.generated.ts`.
 *
 * Lifecycle — a cluster is a stateful, per-instance-hour-billed resource, so
 * every path is polled to completion:
 *  - `create` → `RunJobFlow` + poll `DescribeCluster` until `WAITING`/`RUNNING`
 *    (the cluster is up and idle / running steps). A `TERMINATED*` terminal
 *    during create is a hard error; the partially-created cluster is
 *    best-effort terminated so it does not bill.
 *  - `update` → the limited mutable surface only: `SetTerminationProtection`
 *    (`Instances.TerminationProtected`), `SetVisibleToAllUsers`,
 *    `ModifyCluster` (`StepConcurrencyLevel`; a removal is warned about and
 *    left in place, issue #1160), managed-scaling / auto-
 *    termination policy APIs, and `AddTags`/`RemoveTags`. Applications,
 *    release label, ... are schema-createOnly and most `Instances` changes
 *    are a registry-rule replacement (issue #5418), so a change that reaches
 *    `update()` anyway is refused with a `--replace` pointer. The `Instances`
 *    members CloudFormation updates in place are applied (go-to-k/cdkd#5422):
 *    `SetUnhealthyNodeReplacement`, and a core / task group's or fleet's
 *    resize and auto-scaling policy through the instance group / fleet
 *    providers' own `update()`, which wait for the resize to settle.
 *  - `delete` → `TerminateJobFlows` + poll until `TERMINATED`. Idempotent on
 *    an already-gone cluster (`assertRegionMatch` guards the region). Honors
 *    termination protection: under `--remove-protection` it flips
 *    `SetTerminationProtection(false)` first (mirroring the EC2/ASG pattern),
 *    and turns it back on if the terminate then fails terminally (#2204).
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource deadline
 * to the polling ceiling (mirrors `CustomResourceProvider` / `FSxFileSystem
 * Provider`), so slow EMR creates/terminates don't require `--resource-timeout`.
 */
export class EMRClusterProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type (`ProvisioningType:
   * NON_PROVISIONABLE`), so the deploy engine's #614 SDK-unwired auto-route
   * MUST NOT send an unhandled-property EMR template to CC — it would fail at
   * provisioning time with an opaque UnsupportedActionException. With this
   * opt-out the ProviderRegistry rejects such templates pre-flight with a
   * clear error instead.
   */
  readonly disableCcApiFallback = true;

  client: EMRClient | undefined;
  createClient: EMRClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('EMRClusterProvider');
  /** `--remove-protection` flips, keyed so a re-entered delete keeps them (#2204). */
  readonly protectionFlips = new ProtectionFlipRegistry();

  readonly pollIntervalMs: number;
  readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  wrapStatusReasonError(
    mask: MaskerFn | undefined,
    reason: { code?: string | undefined; message?: string | undefined } | undefined,
    fallback: string,
    build: (text: string, cause: Error | undefined) => ProvisioningError
  ): ProvisioningError {
    return wrapStatusReasonError.call(this, mask, reason, fallback, build);
  }

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  cleanupFailureText(head: string, error: unknown, mask: MaskerFn | undefined): string {
    return cleanupFailureText.call(this, head, error, mask);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::Cluster',
      new Set([
        'AdditionalInfo',
        'Applications',
        'AutoScalingRole',
        'AutoTerminationPolicy',
        'BootstrapActions',
        'Configurations',
        'CustomAmiId',
        'EbsRootVolumeIops',
        'EbsRootVolumeSize',
        'EbsRootVolumeThroughput',
        'Instances',
        'JobFlowRole',
        'KerberosAttributes',
        'LogEncryptionKmsKeyId',
        'LogUri',
        'ManagedScalingPolicy',
        'MonitoringConfiguration',
        'Name',
        'OSReleaseLabel',
        'PlacementGroupConfigs',
        'ReleaseLabel',
        'ScaleDownBehavior',
        'SecurityConfiguration',
        'ServiceRole',
        'SessionEnabled',
        'StepConcurrencyLevel',
        'Steps',
        'Tags',
        'VisibleToAllUsers',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()` — so the shared caller warns about
   * none of them.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::Cluster',
      new Set([
        // Create-only (a removal replaces), or `Instances`: required; a removed
        // sub-field replaces, except the in-place ones update() handles:
        // `TerminationProtected` is sent as false, `AutoScalingPolicy` is
        // removed, and a fleet capacity or `UnhealthyNodeReplacement` is
        // refused (CloudFormation fails both removals).
        ...[...(this.handledProperties.get('AWS::EMR::Cluster') ?? [])].filter(
          (key) => !MUTABLE_TOP_LEVEL_PROPS.has(key)
        ),
        // Diffed by AddTags / RemoveTags.
        'Tags',
        // Sent as false, CloudFormation's documented default for this type.
        'VisibleToAllUsers',
        // Removed through RemoveManagedScalingPolicy / RemoveAutoTerminationPolicy.
        'ManagedScalingPolicy',
        'AutoTerminationPolicy',
        // Left in place, as CloudFormation leaves it (CFn A/B 2026-10-20),
        // and named in update()'s own warning (no reset).
        ...LEFT_IN_PLACE_ON_REMOVAL,
      ]),
    ],
  ]);

  getClient(): EMRClient {
    return getClient.call(this);
  }

  getCreateClient(): EMRClient {
    return getCreateClient.call(this);
  }

  /**
   * Self-reported minimum per-resource timeout: the deploy engine resolves
   * `max(getMinResourceTimeoutMs(), globalCliDefault)` so EMR's slow
   * create/terminate polling fits inside the resource deadline without the
   * user passing `--resource-timeout`.
   *
   * Return the poll ceiling PLUS one poll interval (not exactly `maxWaitMs`):
   * the deploy engine's `withResourceDeadline` is a non-cancelling
   * `Promise.race`, so if the external deadline were exactly equal to the
   * internal poll ceiling the two could fire together and the external one
   * could win — leaving the internal timeout + best-effort rollback terminate
   * un-run and (if the CLI then exits) a live cluster billing. The extra
   * interval guarantees the internal `waitForCluster*` timeout fires first and
   * the rollback path always runs.
   */
  getMinResourceTimeoutMs(): number {
    return this.maxWaitMs + this.pollIntervalMs;
  }

  // ─── CREATE ────────────────────────────────────────────────────────

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  toJobFlowInstancesConfig(
    config: Record<string, unknown> | undefined
  ): JobFlowInstancesConfig | undefined {
    return toJobFlowInstancesConfig.call(this, config);
  }

  toInstanceGroupConfig(raw: Record<string, unknown>, role: InstanceRoleType): InstanceGroupConfig {
    return toInstanceGroupConfig.call(this, raw, role);
  }

  toInstanceFleetConfig(
    raw: Record<string, unknown>,
    type: InstanceFleetType
  ): InstanceFleetConfig {
    return toInstanceFleetConfig.call(this, raw, type);
  }

  toManagedScalingPolicy(
    config: Record<string, unknown> | undefined
  ): ManagedScalingPolicy | undefined {
    return toManagedScalingPolicy.call(this, config);
  }

  toAutoTerminationPolicy(
    config: Record<string, unknown> | undefined
  ): AutoTerminationPolicy | undefined {
    return toAutoTerminationPolicy.call(this, config);
  }

  resolveInstancesTargets(
    logicalId: string,
    clusterId: string,
    plan: InstancesInPlacePlan
  ): Promise<InstancesTargets> {
    return resolveInstancesTargets.call(this, logicalId, clusterId, plan);
  }

  applyInstancesResizes(
    logicalId: string,
    clusterId: string,
    targets: InstancesTargets,
    deadline: number,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return applyInstancesResizes.call(this, logicalId, clusterId, targets, deadline, mask);
  }

  // ─── UPDATE ────────────────────────────────────────────────────────

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

  applyTagDiff(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    prevTagsRaw: unknown,
    nextTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, physicalId, resourceType, logicalId, prevTagsRaw, nextTagsRaw);
  }

  // ─── DELETE ────────────────────────────────────────────────────────

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
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

  // ─── Lifecycle polling ─────────────────────────────────────────────

  describeForPoll(
    clusterId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<Cluster | undefined> {
    return describeForPoll.call(this, clusterId, transientState, maxConsecutiveTransient);
  }

  waitForClusterReady(
    clusterId: string,
    logicalId: string,
    resourceType: string,
    mask?: MaskerFn
  ): Promise<Cluster> {
    return waitForClusterReady.call(this, clusterId, logicalId, resourceType, mask);
  }

  waitForClusterTerminated(
    clusterId: string,
    logicalId: string,
    resourceType: string,
    mask?: MaskerFn
  ): Promise<void> {
    return waitForClusterTerminated.call(this, clusterId, logicalId, resourceType, mask);
  }

  // ─── Attributes ────────────────────────────────────────────────────

  buildAttributes(cluster: Cluster | undefined): Record<string, unknown> {
    return buildAttributes.call(this, cluster);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  // ─── IDENTITY (go-to-k/cdkd#4606) ──────────────────────────────────

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  readClusterIdentity(clusterId: string): Promise<{ id: string } | undefined> {
    return readClusterIdentity.call(this, clusterId);
  }

  // ─── IMPORT ────────────────────────────────────────────────────────

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  describeClusterOrUndefined(clusterId: string): Promise<Cluster | undefined> {
    return describeClusterOrUndefined.call(this, clusterId);
  }

  // ─── DRIFT (readCurrentState) ──────────────────────────────────────

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  /**
   * State property paths this provider cannot read back from AWS faithfully,
   * skipped by the drift comparator to avoid a guaranteed false positive on
   * the `properties`-fallback path. See `readCurrentState`'s docstring.
   *
   * NOTE on the `Instances.*` entries: `reverseInstancesToCfn` deliberately
   * reconstructs only the primary topology per group / fleet (role, type,
   * count / capacity, market, bid price, name, custom AMI) — the lossy
   * sub-specs `create()` reads (`EbsConfiguration` / `AutoScalingPolicy` /
   * per-group `Configurations`; per-fleet `InstanceTypeConfigs` /
   * `LaunchSpecifications` / `ResizeSpecifications`) and the top-level
   * `Instances` fields AWS does not report back (`HadoopVersion` /
   * `Placement` / `KeepJobFlowAliveWhenNoSteps`) are NOT reconstructed. On the
   * NORMAL drift path both the `observedProperties` baseline and the current
   * snapshot go through this same lossy reverse, so these paths are absent
   * from both sides and never drift — ignoring them there is a no-op. On the
   * `properties`-fallback path (no `observedProperties`) the baseline is the
   * full template `Instances`, which DOES carry these sub-fields, so without
   * the skip every one would fire guaranteed false-positive drift. The two
   * `Task*` arrays are ignored WHOLE (the comparator compares arrays as leaves,
   * so an element sub-field cannot be path-targeted); Master/Core groups and
   * fleets are single objects, so their lossy sub-fields are targeted directly.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [
      'AdditionalInfo',
      // Returned by readCurrentState for a richer observedProperties baseline,
      // but skipped by the comparator: AWS augments each entry with a resolved
      // `Version`/`AdditionalInfo` the template usually omits, which would fire
      // false-positive drift on the `properties`-fallback path.
      'Applications',
      'AutoTerminationPolicy',
      'BootstrapActions',
      'Configurations',
      // Top-level Instances fields readCurrentState cannot reconstruct.
      'Instances.HadoopVersion',
      'Instances.KeepJobFlowAliveWhenNoSteps',
      'Instances.Placement',
      // Master/Core instance-group lossy sub-specs (single objects → targeted).
      'Instances.CoreInstanceGroup.AutoScalingPolicy',
      'Instances.CoreInstanceGroup.Configurations',
      'Instances.CoreInstanceGroup.EbsConfiguration',
      'Instances.MasterInstanceGroup.AutoScalingPolicy',
      'Instances.MasterInstanceGroup.Configurations',
      'Instances.MasterInstanceGroup.EbsConfiguration',
      // Master/Core instance-fleet lossy sub-specs (single objects → targeted).
      'Instances.CoreInstanceFleet.InstanceTypeConfigs',
      'Instances.CoreInstanceFleet.LaunchSpecifications',
      'Instances.CoreInstanceFleet.ResizeSpecifications',
      'Instances.MasterInstanceFleet.InstanceTypeConfigs',
      'Instances.MasterInstanceFleet.LaunchSpecifications',
      'Instances.MasterInstanceFleet.ResizeSpecifications',
      // Task groups/fleets are arrays → the comparator compares them as leaves,
      // so the lossy element sub-fields force the whole array to be skipped.
      'Instances.TaskInstanceFleets',
      'Instances.TaskInstanceGroups',
      'KerberosAttributes',
      'ManagedScalingPolicy',
      // Create-only, and no EMR API changes either after RunJobFlow, so
      // neither can drift; and AWS may fill members the template omits
      // (go-to-k/cdkd#5824).
      'MonitoringConfiguration',
      'PlacementGroupConfigs',
      'SessionEnabled',
      'Steps',
    ];
  }

  listInstanceGroups(clusterId: string): Promise<InstanceGroup[]> {
    return listInstanceGroups.call(this, clusterId);
  }

  listInstanceFleets(clusterId: string): Promise<InstanceFleet[]> {
    return listInstanceFleets.call(this, clusterId);
  }

  reverseInstancesToCfn(
    cluster: Cluster,
    instanceGroups: InstanceGroup[],
    instanceFleets: InstanceFleet[]
  ): Record<string, unknown> {
    return reverseInstancesToCfn.call(this, cluster, instanceGroups, instanceFleets);
  }

  reverseInstanceGroup(g: InstanceGroup): Record<string, unknown> {
    return reverseInstanceGroup.call(this, g);
  }

  reverseInstanceFleet(f: InstanceFleet): Record<string, unknown> {
    return reverseInstanceFleet.call(this, f);
  }
}
