import {
  EMRClient,
  RunJobFlowCommand,
  TerminateJobFlowsCommand,
  DescribeClusterCommand,
  SetTerminationProtectionCommand,
  SetVisibleToAllUsersCommand,
  ModifyClusterCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  PutManagedScalingPolicyCommand,
  RemoveManagedScalingPolicyCommand,
  PutAutoTerminationPolicyCommand,
  RemoveAutoTerminationPolicyCommand,
  InvalidRequestException,
  type Cluster,
  type ClusterState,
  type JobFlowInstancesConfig,
  type InstanceGroupConfig,
  type InstanceFleetConfig,
  type InstanceRoleType,
  type InstanceFleetType,
  type ManagedScalingPolicy,
  type AutoTerminationPolicy,
  type Tag,
} from '@aws-sdk/client-emr';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * Default polling budget for EMR cluster lifecycle transitions. A cluster
 * create (RunJobFlow → WAITING/RUNNING) typically takes 5-15 minutes
 * (instance provisioning + bootstrap + application install), and a delete
 * (TerminateJobFlows → TERMINATED) 5-10 minutes. Mirror the Custom Resource /
 * FSx providers' 1-hour ceiling so the slowest realistic create/terminate
 * still fits inside the per-resource deadline.
 */
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Cluster states that mean "create succeeded, the cluster is up". */
const CREATE_READY_STATES: ReadonlySet<ClusterState> = new Set<ClusterState>([
  'WAITING',
  'RUNNING',
]);

/**
 * Cluster states that mean "the cluster is gone" (for delete polling and
 * delete idempotency). `TERMINATED_WITH_ERRORS` still counts as gone — the
 * cluster no longer bills — but is logged so a failed terminate is visible.
 */
const TERMINAL_STATES: ReadonlySet<ClusterState> = new Set<ClusterState>([
  'TERMINATED',
  'TERMINATED_WITH_ERRORS',
]);

/**
 * Top-level CFn properties that map to a MUTABLE EMR API surface. Every other
 * property is either registry-createOnly (routed through DELETE+CREATE by the
 * replacement-detection layer) or lives inside the `Instances` block (handled
 * specially in `update()` — only `TerminationProtected` is mutable there).
 */
const MUTABLE_TOP_LEVEL_PROPS = new Set<string>([
  'Tags',
  'VisibleToAllUsers',
  'StepConcurrencyLevel',
  'ManagedScalingPolicy',
  'AutoTerminationPolicy',
]);

const toNumber = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  // A non-numeric template value (e.g. an unresolved intrinsic that slipped
  // through) coerces to NaN; forwarding NaN to the SDK is worse than dropping
  // the field, so treat it as absent.
  return Number.isNaN(n) ? undefined : n;
};

const toBoolean = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v === 'true';
  return Boolean(v);
};

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
 *    `ModifyCluster` (`StepConcurrencyLevel`), managed-scaling / auto-
 *    termination policy APIs, and `AddTags`/`RemoveTags`. Everything else
 *    (instance topology, applications, release label, ...) is createOnly →
 *    replacement via the schema fallback; a change that reaches `update()`
 *    anyway is refused with a `--replace` pointer.
 *  - `delete` → `TerminateJobFlows` + poll until `TERMINATED`. Idempotent on
 *    an already-gone cluster (`assertRegionMatch` guards the region). Honors
 *    termination protection: under `--remove-protection` it flips
 *    `SetTerminationProtection(false)` first (mirroring the EC2/ASG pattern).
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource deadline
 * to the polling ceiling (mirrors `CustomResourceProvider` / `FSxFileSystem
 * Provider`), so slow EMR creates/terminates don't require `--resource-timeout`.
 */
export class EMRClusterProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type (`ProvisioningType:
   * NON_PROVISIONABLE`), so the deploy engine's #614 silent-drop auto-route
   * MUST NOT send an unhandled-property EMR template to CC — it would fail at
   * provisioning time with an opaque UnsupportedActionException. With this
   * opt-out the ProviderRegistry rejects such templates pre-flight with a
   * clear error instead.
   */
  readonly disableCcApiFallback = true;

  private client: EMRClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('EMRClusterProvider');

  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
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
        'Name',
        'OSReleaseLabel',
        'PlacementGroupConfigs',
        'ReleaseLabel',
        'ScaleDownBehavior',
        'SecurityConfiguration',
        'ServiceRole',
        'StepConcurrencyLevel',
        'Steps',
        'Tags',
        'VisibleToAllUsers',
      ]),
    ],
  ]);

  private getClient(): EMRClient {
    if (!this.client) {
      this.client = new EMRClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
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

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    if (resourceType !== 'AWS::EMR::Cluster') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Creating EMR Cluster ${logicalId}`);

    let clusterId: string | undefined;

    try {
      // Build the RunJobFlow input INSIDE the try so a malformed template value
      // (e.g. a bad Instances shape) surfaces as a wrapped ProvisioningError
      // rather than a raw throw.
      const tags = properties['Tags'] as Tag[] | undefined;
      const input = {
        Name: properties['Name'] as string,
        ReleaseLabel: properties['ReleaseLabel'] as string | undefined,
        ServiceRole: properties['ServiceRole'] as string | undefined,
        JobFlowRole: properties['JobFlowRole'] as string | undefined,
        LogUri: properties['LogUri'] as string | undefined,
        LogEncryptionKmsKeyId: properties['LogEncryptionKmsKeyId'] as string | undefined,
        AdditionalInfo: properties['AdditionalInfo'] as string | undefined,
        AutoScalingRole: properties['AutoScalingRole'] as string | undefined,
        ScaleDownBehavior: properties['ScaleDownBehavior'] as
          | import('@aws-sdk/client-emr').ScaleDownBehavior
          | undefined,
        CustomAmiId: properties['CustomAmiId'] as string | undefined,
        OSReleaseLabel: properties['OSReleaseLabel'] as string | undefined,
        SecurityConfiguration: properties['SecurityConfiguration'] as string | undefined,
        EbsRootVolumeSize: toNumber(properties['EbsRootVolumeSize']),
        EbsRootVolumeIops: toNumber(properties['EbsRootVolumeIops']),
        EbsRootVolumeThroughput: toNumber(properties['EbsRootVolumeThroughput']),
        StepConcurrencyLevel: toNumber(properties['StepConcurrencyLevel']),
        VisibleToAllUsers: toBoolean(properties['VisibleToAllUsers']),
        Applications: properties['Applications'] as
          | import('@aws-sdk/client-emr').Application[]
          | undefined,
        Configurations: properties['Configurations'] as
          | import('@aws-sdk/client-emr').Configuration[]
          | undefined,
        BootstrapActions: properties['BootstrapActions'] as
          | import('@aws-sdk/client-emr').BootstrapActionConfig[]
          | undefined,
        Steps: properties['Steps'] as import('@aws-sdk/client-emr').StepConfig[] | undefined,
        KerberosAttributes: properties['KerberosAttributes'] as
          | import('@aws-sdk/client-emr').KerberosAttributes
          | undefined,
        PlacementGroupConfigs: properties['PlacementGroupConfigs'] as
          | import('@aws-sdk/client-emr').PlacementGroupConfig[]
          | undefined,
        ManagedScalingPolicy: this.toManagedScalingPolicy(
          properties['ManagedScalingPolicy'] as Record<string, unknown> | undefined
        ),
        AutoTerminationPolicy: this.toAutoTerminationPolicy(
          properties['AutoTerminationPolicy'] as Record<string, unknown> | undefined
        ),
        Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
        Instances: this.toJobFlowInstancesConfig(
          properties['Instances'] as Record<string, unknown> | undefined
        ),
      };

      const response = await this.getClient().send(new RunJobFlowCommand(input));
      clusterId = response.JobFlowId;
      if (!clusterId) {
        throw new ProvisioningError(
          `EMR RunJobFlow for ${logicalId} returned no JobFlowId`,
          resourceType,
          logicalId
        );
      }

      const cluster = await this.waitForClusterReady(clusterId, logicalId, resourceType);

      this.logger.debug(`Successfully created EMR Cluster ${logicalId}: ${clusterId}`);

      return {
        physicalId: clusterId,
        attributes: this.buildAttributes(cluster),
      };
    } catch (error) {
      // Atomicity: if RunJobFlow succeeded but polling failed (the cluster
      // went TERMINATED_WITH_ERRORS, or the wait timed out), create() is
      // about to throw without returning a physicalId — the deploy engine
      // cannot roll it back, and a live EMR cluster bills per instance-hour.
      // Best-effort terminate it here.
      if (clusterId !== undefined) {
        try {
          // If the template requested Instances.TerminationProtected: true the
          // cluster is PROTECTED, and TerminateJobFlows would 400 with a
          // ValidationException — leaving a live billing cluster, the exact
          // outcome this rollback exists to prevent. Flip protection off first
          // (idempotent — EMR accepts it when already false), mirroring the
          // delete path, then terminate.
          await this.getClient().send(
            new SetTerminationProtectionCommand({
              JobFlowIds: [clusterId],
              TerminationProtected: false,
            })
          );
          await this.getClient().send(new TerminateJobFlowsCommand({ JobFlowIds: [clusterId] }));
          this.logger.warn(`Rolled back partially-created EMR Cluster ${clusterId}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to roll back partially-created EMR Cluster ${clusterId}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            } — terminate it manually to stop billing`
          );
        }
      }
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EMR Cluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Map the CFn `Instances` (`JobFlowInstancesConfig`) block to the SDK
   * `RunJobFlow.Instances` shape. Most field names are identical; the one
   * structural difference is the role-keyed CFn groups/fleets
   * (`MasterInstanceGroup` / `CoreInstanceGroup` / `TaskInstanceGroups` and
   * the `*InstanceFleet(s)` siblings) which the SDK expresses as flat
   * `InstanceGroups` / `InstanceFleets` arrays with an explicit
   * `InstanceRole` / `InstanceFleetType` discriminator per entry.
   */
  private toJobFlowInstancesConfig(
    config: Record<string, unknown> | undefined
  ): JobFlowInstancesConfig | undefined {
    if (!config) return undefined;

    const instanceGroups: InstanceGroupConfig[] = [];
    const pushGroup = (raw: unknown, role: InstanceRoleType): void => {
      if (raw === undefined || raw === null) return;
      instanceGroups.push(this.toInstanceGroupConfig(raw as Record<string, unknown>, role));
    };
    pushGroup(config['MasterInstanceGroup'], 'MASTER');
    pushGroup(config['CoreInstanceGroup'], 'CORE');
    for (const task of (config['TaskInstanceGroups'] as unknown[] | undefined) ?? []) {
      pushGroup(task, 'TASK');
    }

    const instanceFleets: InstanceFleetConfig[] = [];
    const pushFleet = (raw: unknown, type: InstanceFleetType): void => {
      if (raw === undefined || raw === null) return;
      instanceFleets.push(this.toInstanceFleetConfig(raw as Record<string, unknown>, type));
    };
    pushFleet(config['MasterInstanceFleet'], 'MASTER');
    pushFleet(config['CoreInstanceFleet'], 'CORE');
    for (const task of (config['TaskInstanceFleets'] as unknown[] | undefined) ?? []) {
      pushFleet(task, 'TASK');
    }

    return {
      InstanceGroups: instanceGroups.length > 0 ? instanceGroups : undefined,
      InstanceFleets: instanceFleets.length > 0 ? instanceFleets : undefined,
      Ec2KeyName: config['Ec2KeyName'] as string | undefined,
      Ec2SubnetId: config['Ec2SubnetId'] as string | undefined,
      Ec2SubnetIds: config['Ec2SubnetIds'] as string[] | undefined,
      HadoopVersion: config['HadoopVersion'] as string | undefined,
      Placement: config['Placement'] as import('@aws-sdk/client-emr').PlacementType | undefined,
      KeepJobFlowAliveWhenNoSteps: toBoolean(config['KeepJobFlowAliveWhenNoSteps']),
      TerminationProtected: toBoolean(config['TerminationProtected']),
      UnhealthyNodeReplacement: toBoolean(config['UnhealthyNodeReplacement']),
      EmrManagedMasterSecurityGroup: config['EmrManagedMasterSecurityGroup'] as string | undefined,
      EmrManagedSlaveSecurityGroup: config['EmrManagedSlaveSecurityGroup'] as string | undefined,
      ServiceAccessSecurityGroup: config['ServiceAccessSecurityGroup'] as string | undefined,
      AdditionalMasterSecurityGroups: config['AdditionalMasterSecurityGroups'] as
        | string[]
        | undefined,
      AdditionalSlaveSecurityGroups: config['AdditionalSlaveSecurityGroups'] as
        | string[]
        | undefined,
    };
  }

  private toInstanceGroupConfig(
    raw: Record<string, unknown>,
    role: InstanceRoleType
  ): InstanceGroupConfig {
    return {
      InstanceRole: role,
      InstanceType: raw['InstanceType'] as string,
      InstanceCount: toNumber(raw['InstanceCount']) as number,
      Name: raw['Name'] as string | undefined,
      Market: raw['Market'] as import('@aws-sdk/client-emr').MarketType | undefined,
      BidPrice: raw['BidPrice'] as string | undefined,
      Configurations: raw['Configurations'] as
        | import('@aws-sdk/client-emr').Configuration[]
        | undefined,
      EbsConfiguration: raw['EbsConfiguration'] as
        | import('@aws-sdk/client-emr').EbsConfiguration
        | undefined,
      AutoScalingPolicy: raw['AutoScalingPolicy'] as
        | import('@aws-sdk/client-emr').AutoScalingPolicy
        | undefined,
      CustomAmiId: raw['CustomAmiId'] as string | undefined,
    };
  }

  private toInstanceFleetConfig(
    raw: Record<string, unknown>,
    type: InstanceFleetType
  ): InstanceFleetConfig {
    return {
      InstanceFleetType: type,
      Name: raw['Name'] as string | undefined,
      TargetOnDemandCapacity: toNumber(raw['TargetOnDemandCapacity']),
      TargetSpotCapacity: toNumber(raw['TargetSpotCapacity']),
      InstanceTypeConfigs: raw['InstanceTypeConfigs'] as
        | import('@aws-sdk/client-emr').InstanceTypeConfig[]
        | undefined,
      LaunchSpecifications: raw['LaunchSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetProvisioningSpecifications
        | undefined,
      ResizeSpecifications: raw['ResizeSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
        | undefined,
    };
  }

  private toManagedScalingPolicy(
    config: Record<string, unknown> | undefined
  ): ManagedScalingPolicy | undefined {
    if (!config) return undefined;
    const limits = config['ComputeLimits'] as Record<string, unknown> | undefined;
    // ComputeLimits is required for a valid managed-scaling policy. Without it
    // there is nothing to PutManagedScalingPolicy — return undefined so both
    // create (no ManagedScalingPolicy set) and update (routes to
    // RemoveManagedScalingPolicy) do the right thing instead of sending an
    // empty policy AWS rejects.
    if (!limits) return undefined;
    return {
      ComputeLimits: {
        UnitType: limits['UnitType'] as
          | import('@aws-sdk/client-emr').ComputeLimitsUnitType
          | undefined,
        MinimumCapacityUnits: toNumber(limits['MinimumCapacityUnits']),
        MaximumCapacityUnits: toNumber(limits['MaximumCapacityUnits']),
        MaximumOnDemandCapacityUnits: toNumber(limits['MaximumOnDemandCapacityUnits']),
        MaximumCoreCapacityUnits: toNumber(limits['MaximumCoreCapacityUnits']),
      },
      UtilizationPerformanceIndex: toNumber(config['UtilizationPerformanceIndex']),
      ScalingStrategy: config['ScalingStrategy'] as
        | import('@aws-sdk/client-emr').ScalingStrategy
        | undefined,
    };
  }

  private toAutoTerminationPolicy(
    config: Record<string, unknown> | undefined
  ): AutoTerminationPolicy | undefined {
    if (!config) return undefined;
    return { IdleTimeout: toNumber(config['IdleTimeout']) };
  }

  // ─── UPDATE ────────────────────────────────────────────────────────

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const changed = (key: string): boolean => !jsonEqual(properties[key], previousProperties[key]);

    // The `Instances` block is NOT registry-createOnly, so a change to it
    // reaches update() instead of being routed through DELETE+CREATE. Only
    // `Instances.TerminationProtected` is mutable in place — every other
    // sub-field (topology, subnets, key name, ...) requires a replacement.
    const nextInstances = (properties['Instances'] ?? {}) as Record<string, unknown>;
    const prevInstances = (previousProperties['Instances'] ?? {}) as Record<string, unknown>;
    let terminationProtectedChanged = false;
    if (changed('Instances')) {
      const instanceKeys = new Set([...Object.keys(nextInstances), ...Object.keys(prevInstances)]);
      for (const key of instanceKeys) {
        if (jsonEqual(nextInstances[key], prevInstances[key])) continue;
        if (key === 'TerminationProtected') {
          terminationProtectedChanged = true;
          continue;
        }
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS EMR Cluster Instances.${key} is immutable on AWS — a running cluster's instance topology / networking cannot be changed in place. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    // Any changed top-level property that is neither registry-createOnly
    // (which never reaches here) nor a known mutable one is refused. This
    // guard fires only if the replacement layer is bypassed.
    for (const key of Object.keys({ ...properties, ...previousProperties })) {
      if (key === 'Instances') continue;
      if (!changed(key)) continue;
      if (!MUTABLE_TOP_LEVEL_PROPS.has(key)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS EMR Cluster ${key} is immutable on AWS — it is fixed at cluster creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    const visibleChanged = changed('VisibleToAllUsers');
    const stepConcurrencyChanged = changed('StepConcurrencyLevel');
    const managedScalingChanged = changed('ManagedScalingPolicy');
    const autoTerminationChanged = changed('AutoTerminationPolicy');
    const tagsChanged = changed('Tags');

    if (
      !terminationProtectedChanged &&
      !visibleChanged &&
      !stepConcurrencyChanged &&
      !managedScalingChanged &&
      !autoTerminationChanged &&
      !tagsChanged
    ) {
      this.logger.debug(`No mutable diff for EMR Cluster ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating EMR Cluster ${logicalId}: ${physicalId}`);

    try {
      if (terminationProtectedChanged) {
        await this.getClient().send(
          new SetTerminationProtectionCommand({
            JobFlowIds: [physicalId],
            TerminationProtected: toBoolean(nextInstances['TerminationProtected']) ?? false,
          })
        );
      }

      if (visibleChanged) {
        await this.getClient().send(
          new SetVisibleToAllUsersCommand({
            JobFlowIds: [physicalId],
            VisibleToAllUsers: toBoolean(properties['VisibleToAllUsers']) ?? false,
          })
        );
      }

      if (stepConcurrencyChanged) {
        await this.getClient().send(
          new ModifyClusterCommand({
            ClusterId: physicalId,
            StepConcurrencyLevel: toNumber(properties['StepConcurrencyLevel']),
          })
        );
      }

      if (managedScalingChanged) {
        const next = this.toManagedScalingPolicy(
          properties['ManagedScalingPolicy'] as Record<string, unknown> | undefined
        );
        if (next) {
          await this.getClient().send(
            new PutManagedScalingPolicyCommand({
              ClusterId: physicalId,
              ManagedScalingPolicy: next,
            })
          );
        } else {
          await this.getClient().send(
            new RemoveManagedScalingPolicyCommand({ ClusterId: physicalId })
          );
        }
      }

      if (autoTerminationChanged) {
        const next = this.toAutoTerminationPolicy(
          properties['AutoTerminationPolicy'] as Record<string, unknown> | undefined
        );
        if (next && next.IdleTimeout !== undefined) {
          await this.getClient().send(
            new PutAutoTerminationPolicyCommand({
              ClusterId: physicalId,
              AutoTerminationPolicy: next,
            })
          );
        } else {
          await this.getClient().send(
            new RemoveAutoTerminationPolicyCommand({ ClusterId: physicalId })
          );
        }
      }

      if (tagsChanged) {
        await this.applyTagDiff(
          physicalId,
          properties['Tags'] as Tag[] | undefined,
          previousProperties['Tags'] as Tag[] | undefined
        );
      }

      // Re-derive attributes so the deploy engine's state write keeps
      // GetAtt-served attributes (MasterPublicDNS) fresh. Best-effort: the
      // real update already succeeded, so a transient Describe failure must
      // not fail (and roll back) the whole update.
      let cluster: Cluster | undefined;
      try {
        const resp = await this.getClient().send(
          new DescribeClusterCommand({ ClusterId: physicalId })
        );
        cluster = resp.Cluster;
      } catch (describeError) {
        this.logger.debug(
          `Post-update attribute refresh for ${physicalId} failed (returning without attributes): ${
            describeError instanceof Error ? describeError.message : String(describeError)
          }`
        );
      }

      this.logger.debug(`Successfully updated EMR Cluster ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        ...(cluster && { attributes: this.buildAttributes(cluster) }),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EMR Cluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a `Tags` diff via `AddTags` / `RemoveTags`. Full-tag-removal is
   * handled explicitly (a tag present before and absent now must be removed
   * via `RemoveTags` — mirrors the #981 ECR regression class where an empty
   * desired tag set silently left the old tags in place).
   */
  private async applyTagDiff(
    physicalId: string,
    nextTags: Tag[] | undefined,
    prevTags: Tag[] | undefined
  ): Promise<void> {
    const next = new Map((nextTags ?? []).map((t) => [t.Key, t.Value]));
    const prev = new Map((prevTags ?? []).map((t) => [t.Key, t.Value]));

    const toSet: Tag[] = [];
    for (const [key, value] of next) {
      if (key === undefined) continue;
      if (prev.get(key) !== value) toSet.push({ Key: key, Value: value });
    }
    const toRemove: string[] = [];
    for (const key of prev.keys()) {
      if (key !== undefined && !next.has(key)) toRemove.push(key);
    }

    if (toRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsCommand({ ResourceId: physicalId, TagKeys: toRemove })
      );
    }
    if (toSet.length > 0) {
      await this.getClient().send(new AddTagsCommand({ ResourceId: physicalId, Tags: toSet }));
    }
  }

  // ─── DELETE ────────────────────────────────────────────────────────

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EMR Cluster ${logicalId}: ${physicalId}`);

    // Pre-check: resolve the current state so an already-terminated /
    // gone-from-a-different-region cluster is handled idempotently before
    // any terminate call.
    let current: Cluster | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeClusterCommand({ ClusterId: physicalId })
      );
      current = resp.Cluster;
    } catch (error) {
      if (error instanceof InvalidRequestException) {
        // The cluster id is not valid in this region — either truly gone or
        // the client is pointed at the wrong region. Guard with the state
        // region before trusting NotFound.
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EMR Cluster ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to describe EMR Cluster ${logicalId} before deletion: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    const currentState = current?.Status?.State;
    if (currentState && TERMINAL_STATES.has(currentState)) {
      this.logger.debug(`EMR Cluster ${physicalId} already ${currentState}, skipping deletion`);
      return;
    }

    try {
      // Honor termination protection. Under --remove-protection, flip it off
      // first (idempotent — EMR accepts the call when already false); a
      // TerminateJobFlows against a protected cluster otherwise fails with a
      // ValidationException. Mirrors the EC2/ASG --remove-protection pattern.
      if (context?.removeProtection) {
        await this.getClient().send(
          new SetTerminationProtectionCommand({
            JobFlowIds: [physicalId],
            TerminationProtected: false,
          })
        );
        this.logger.debug(
          `Disabled termination protection on EMR Cluster ${physicalId} before deletion`
        );
      }

      await this.getClient().send(new TerminateJobFlowsCommand({ JobFlowIds: [physicalId] }));
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to terminate EMR Cluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    // Termination is async — poll until TERMINATED. A timeout is a hard error
    // (never warn-and-continue): a still-running EMR cluster keeps billing
    // per instance-hour and the destroy must not report success.
    await this.waitForClusterTerminated(physicalId, logicalId, resourceType);

    this.logger.debug(`Successfully deleted EMR Cluster ${logicalId}`);
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  /**
   * Issue the polling `DescribeCluster` with bounded tolerance for TRANSIENT
   * errors (throttling / 5xx / connection resets): up to
   * `maxConsecutiveTransient` consecutive failures are absorbed before the
   * error propagates. A 10-minute poll at 15s intervals would otherwise turn
   * a single throttle into a spurious failure + rollback cycle. Non-transient
   * errors propagate immediately.
   */
  private async describeForPoll(
    clusterId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<Cluster | undefined> {
    try {
      const response = await this.getClient().send(
        new DescribeClusterCommand({ ClusterId: clusterId })
      );
      transientState.count = 0;
      return response.Cluster;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const msg = error instanceof Error ? error.message : String(error);
      const transient =
        name === 'ThrottlingException' ||
        name === 'InternalServerException' ||
        name === 'InternalServerError' ||
        name === 'TimeoutError' ||
        /rate exceeded|too many requests|throttl|timed? ?out|ECONNRESET|EPIPE|socket hang up/i.test(
          msg
        );
      if (transient && transientState.count < maxConsecutiveTransient) {
        transientState.count += 1;
        this.logger.debug(
          `Transient DescribeCluster error while polling ${clusterId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
        );
        return undefined;
      }
      throw error;
    }
  }

  private async waitForClusterReady(
    clusterId: string,
    logicalId: string,
    resourceType: string
  ): Promise<Cluster> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      const cluster = await this.describeForPoll(clusterId, transientState);
      const state = cluster?.Status?.State;

      if (cluster && state && CREATE_READY_STATES.has(state)) return cluster;

      if (state && TERMINAL_STATES.has(state)) {
        const reason =
          cluster?.Status?.StateChangeReason?.Message ?? 'no state-change reason reported';
        throw new ProvisioningError(
          `EMR Cluster ${clusterId} entered terminal state ${state} during creation: ${reason}`,
          resourceType,
          logicalId,
          clusterId
        );
      }

      this.logger.debug(`EMR Cluster ${clusterId} state: ${state ?? 'unknown'}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EMR Cluster ${clusterId} to reach WAITING/RUNNING (${Math.round(this.maxWaitMs / 60000)} min)`,
      resourceType,
      logicalId,
      clusterId
    );
  }

  private async waitForClusterTerminated(
    clusterId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      let cluster: Cluster | undefined;
      try {
        cluster = await this.describeForPoll(clusterId, transientState);
      } catch (error) {
        if (error instanceof InvalidRequestException) return; // aged out of Describe = gone
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to poll EMR Cluster ${clusterId} termination: ${error instanceof Error ? error.message : String(error)}`,
          resourceType,
          logicalId,
          clusterId,
          cause
        );
      }

      const state = cluster?.Status?.State;
      if (state && TERMINAL_STATES.has(state)) {
        if (state === 'TERMINATED_WITH_ERRORS') {
          const reason =
            cluster?.Status?.StateChangeReason?.Message ?? 'no state-change reason reported';
          this.logger.warn(
            `EMR Cluster ${clusterId} terminated with errors: ${reason} (the cluster is gone and no longer bills)`
          );
        }
        return;
      }

      this.logger.debug(
        `EMR Cluster ${clusterId} state: ${state ?? 'unknown'}, waiting for termination...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EMR Cluster ${clusterId} termination (${Math.round(this.maxWaitMs / 60000)} min) — verify and terminate it manually to stop billing`,
      resourceType,
      logicalId,
      clusterId
    );
  }

  // ─── Attributes ────────────────────────────────────────────────────

  private buildAttributes(cluster: Cluster | undefined): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    if (cluster?.Id !== undefined) attributes['Id'] = cluster.Id;
    if (cluster?.MasterPublicDnsName !== undefined) {
      attributes['MasterPublicDNS'] = cluster.MasterPublicDnsName;
    }
    return attributes;
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') return physicalId;

    const response = await this.getClient().send(
      new DescribeClusterCommand({ ClusterId: physicalId })
    );
    const cluster = response.Cluster;
    if (!cluster) return undefined;

    switch (attributeName) {
      case 'MasterPublicDNS':
        return cluster.MasterPublicDnsName;
      default:
        return undefined;
    }
  }
}
