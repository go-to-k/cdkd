import {
  EMRClient,
  AddInstanceGroupsCommand,
  ModifyInstanceGroupsCommand,
  ListInstanceGroupsCommand,
  PutAutoScalingPolicyCommand,
  RemoveAutoScalingPolicyCommand,
  InvalidRequestException,
  type InstanceGroup,
  type InstanceGroupConfig,
  type InstanceGroupState,
  type InstanceRoleType,
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
 * Default polling budget for an instance group reaching RUNNING. Adding a
 * group to an already-WAITING cluster provisions + bootstraps its EC2
 * instances (typically 2-6 minutes); a resize settles faster. Reuse the
 * EMR Cluster provider's 1-hour ceiling so the slowest realistic add still
 * fits inside the per-resource deadline.
 */
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Instance-group state that means "the group is up and idle/serving". */
const READY_STATES: ReadonlySet<InstanceGroupState> = new Set<InstanceGroupState>(['RUNNING']);

/**
 * Instance-group states that mean "the group is gone / failed" — a hard
 * error during a create/resize wait (an ARRESTED group failed to provision;
 * TERMINATED/ENDED mean it will never reach RUNNING).
 */
const FAILED_STATES: ReadonlySet<InstanceGroupState> = new Set<InstanceGroupState>([
  'ARRESTED',
  'TERMINATED',
  'ENDED',
]);

const toNumber = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * SDK Provider for `AWS::EMR::InstanceGroupConfig` (issue #1070).
 *
 * This type adds a standalone instance group (MASTER / CORE / TASK) to an
 * EXISTING EMR cluster (referenced by `JobFlowId`), rather than declaring the
 * group inline in `AWS::EMR::Cluster.Instances`. It is
 * `ProvisioningType: NON_PROVISIONABLE` in the CFn registry, so Cloud Control
 * cannot handle it — pre-flight would otherwise reject it via
 * `unsupported-types.generated.ts`.
 *
 * Lifecycle:
 *  - `create` → `AddInstanceGroups` (one group per call) + poll
 *    `ListInstanceGroups` until the new group is `RUNNING`. A failed terminal
 *    (`ARRESTED` / `TERMINATED` / `ENDED`) during the wait is a hard error.
 *  - `update` → only the two AWS-mutable properties: `InstanceCount`
 *    (`ModifyInstanceGroups`, resize; polled until settled) and
 *    `AutoScalingPolicy` (`PutAutoScalingPolicy` / `RemoveAutoScalingPolicy`).
 *    Every other property is registry-createOnly → routed through
 *    DELETE+CREATE by the replacement-detection layer; a createOnly change
 *    that reaches `update()` anyway is refused with a `--replace` pointer.
 *  - `delete` → **no standalone AWS API exists.** EMR cannot remove an
 *    instance group from a running cluster; a group's only lifecycle end is
 *    cluster termination. In the normal `cdkd destroy` the parent
 *    `AWS::EMR::Cluster` is terminated in the same run (its `TerminateJobFlows`
 *    releases every group + its EC2 instances), so this delete is a no-op that
 *    just drops cdkd state — leaving ZERO orphans. As a best effort for the
 *    less common "delete only the group, keep the cluster" case, a TASK group
 *    is scaled to 0 instances (`ModifyInstanceGroups InstanceCount: 0`) to
 *    release its instances; MASTER/CORE groups cannot be scaled to 0 and are a
 *    pure no-op. Never blocks the destroy (warn-and-continue).
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource deadline
 * to the polling ceiling (mirrors `EMRClusterProvider`) so a slow add/resize
 * does not require `--resource-timeout`.
 */
export class EMRInstanceGroupConfigProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type
   * (`ProvisioningType: NON_PROVISIONABLE`), so the deploy engine's #614
   * silent-drop auto-route MUST NOT send an unhandled-property template to CC
   * — it would fail at provisioning time with an opaque
   * UnsupportedActionException. With this opt-out the ProviderRegistry rejects
   * such templates pre-flight with a clear error instead.
   */
  readonly disableCcApiFallback = true;

  private client: EMRClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('EMRInstanceGroupConfigProvider');

  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::InstanceGroupConfig',
      new Set([
        'AutoScalingPolicy',
        'BidPrice',
        'Configurations',
        'CustomAmiId',
        'EbsConfiguration',
        'InstanceCount',
        'InstanceRole',
        'InstanceType',
        'JobFlowId',
        'Market',
        'Name',
      ]),
    ],
  ]);

  private getClient(): EMRClient {
    if (!this.client) {
      this.client = new EMRClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  getMinResourceTimeoutMs(): number {
    // Poll ceiling PLUS one interval so the internal wait times out before the
    // deploy engine's non-cancelling external deadline (see EMRClusterProvider).
    return this.maxWaitMs + this.pollIntervalMs;
  }

  // ─── CREATE ────────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    if (resourceType !== 'AWS::EMR::InstanceGroupConfig') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    const jobFlowId = properties['JobFlowId'] as string | undefined;
    if (!jobFlowId) {
      throw new ProvisioningError(
        `EMR InstanceGroupConfig ${logicalId} is missing JobFlowId (the parent cluster id)`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Adding EMR instance group ${logicalId} to cluster ${jobFlowId}`);

    try {
      const group = this.toInstanceGroupConfig(properties);
      const response = await this.getClient().send(
        new AddInstanceGroupsCommand({ JobFlowId: jobFlowId, InstanceGroups: [group] })
      );
      const groupId = response.InstanceGroupIds?.[0];
      if (!groupId) {
        throw new ProvisioningError(
          `EMR AddInstanceGroups for ${logicalId} returned no instance group id`,
          resourceType,
          logicalId
        );
      }

      await this.waitForGroupReady(
        jobFlowId,
        groupId,
        logicalId,
        resourceType,
        toNumber(properties['InstanceCount']) ?? 0
      );

      this.logger.debug(`Successfully added EMR instance group ${logicalId}: ${groupId}`);
      return { physicalId: groupId, attributes: { Id: groupId } };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to add EMR instance group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private toInstanceGroupConfig(properties: Record<string, unknown>): InstanceGroupConfig {
    return {
      InstanceRole: properties['InstanceRole'] as InstanceRoleType,
      InstanceType: properties['InstanceType'] as string,
      InstanceCount: toNumber(properties['InstanceCount']) as number,
      Name: properties['Name'] as string | undefined,
      Market: properties['Market'] as import('@aws-sdk/client-emr').MarketType | undefined,
      BidPrice: properties['BidPrice'] as string | undefined,
      Configurations: properties['Configurations'] as
        | import('@aws-sdk/client-emr').Configuration[]
        | undefined,
      EbsConfiguration: properties['EbsConfiguration'] as
        | import('@aws-sdk/client-emr').EbsConfiguration
        | undefined,
      AutoScalingPolicy: properties['AutoScalingPolicy'] as
        | import('@aws-sdk/client-emr').AutoScalingPolicy
        | undefined,
      CustomAmiId: properties['CustomAmiId'] as string | undefined,
    };
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

    // Only InstanceCount + AutoScalingPolicy are mutable on AWS. Every other
    // property is registry-createOnly (routed through DELETE+CREATE before
    // reaching here); a createOnly change that arrives anyway means the
    // replacement layer was bypassed — refuse it with a --replace pointer.
    const MUTABLE = new Set(['InstanceCount', 'AutoScalingPolicy']);
    for (const key of Object.keys({ ...properties, ...previousProperties })) {
      if (!changed(key)) continue;
      if (!MUTABLE.has(key)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS EMR InstanceGroupConfig ${key} is immutable on AWS — it is fixed when the instance group is created. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    const instanceCountChanged = changed('InstanceCount');
    const autoScalingChanged = changed('AutoScalingPolicy');

    if (!instanceCountChanged && !autoScalingChanged) {
      this.logger.debug(`No mutable diff for EMR instance group ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    const jobFlowId = properties['JobFlowId'] as string | undefined;
    this.logger.debug(`Updating EMR instance group ${logicalId}: ${physicalId}`);

    try {
      if (instanceCountChanged) {
        await this.getClient().send(
          new ModifyInstanceGroupsCommand({
            ...(jobFlowId && { ClusterId: jobFlowId }),
            InstanceGroups: [
              {
                InstanceGroupId: physicalId,
                InstanceCount: toNumber(properties['InstanceCount']),
              },
            ],
          })
        );
        // The resize is async; poll until the group has actually reached the
        // new target instance count so the update does not report success
        // while instances are still being added/removed. Waiting on group
        // State alone is NOT enough: right after ModifyInstanceGroups the group
        // is still in the PRE-resize RUNNING state (it has not transitioned to
        // RESIZING yet), so a State-only wait returns instantly without waiting
        // for the resize. Wait on RunningInstanceCount === target instead.
        // Needs the cluster id — skip the wait if absent (a hand-written
        // template without JobFlowId); the modify still applied.
        if (jobFlowId) {
          await this.waitForGroupReady(
            jobFlowId,
            physicalId,
            logicalId,
            resourceType,
            toNumber(properties['InstanceCount']) ?? 0
          );
        }
      }

      if (autoScalingChanged) {
        if (!jobFlowId) {
          throw new ProvisioningError(
            `EMR InstanceGroupConfig ${logicalId} AutoScalingPolicy update needs JobFlowId (the cluster id), which is absent`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        const policy = properties['AutoScalingPolicy'] as
          | import('@aws-sdk/client-emr').AutoScalingPolicy
          | undefined;
        if (policy) {
          await this.getClient().send(
            new PutAutoScalingPolicyCommand({
              ClusterId: jobFlowId,
              InstanceGroupId: physicalId,
              AutoScalingPolicy: policy,
            })
          );
        } else {
          await this.getClient().send(
            new RemoveAutoScalingPolicyCommand({
              ClusterId: jobFlowId,
              InstanceGroupId: physicalId,
            })
          );
        }
      }

      this.logger.debug(`Successfully updated EMR instance group ${logicalId}`);
      return { physicalId, wasReplaced: false, attributes: { Id: physicalId } };
    } catch (error) {
      if (error instanceof ProvisioningError || error instanceof ResourceUpdateNotSupportedError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EMR instance group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── DELETE ────────────────────────────────────────────────────────

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    // There is NO standalone "delete instance group" API in EMR. An instance
    // group's only lifecycle end is cluster termination — the parent
    // AWS::EMR::Cluster's delete (TerminateJobFlows) releases every group and
    // its EC2 instances. In the normal destroy this delete therefore just
    // drops cdkd state and leaves zero orphans.
    //
    // Best effort for the "delete only the group, keep the cluster" case: a
    // TASK group is scaled to 0 to release its instances (MASTER/CORE cannot
    // be scaled to 0). Warn-and-continue — never block the destroy.
    const role = properties?.['InstanceRole'] as string | undefined;
    const jobFlowId = properties?.['JobFlowId'] as string | undefined;

    if (role === 'TASK' && jobFlowId) {
      try {
        await this.getClient().send(
          new ModifyInstanceGroupsCommand({
            ClusterId: jobFlowId,
            InstanceGroups: [{ InstanceGroupId: physicalId, InstanceCount: 0 }],
          })
        );
        this.logger.debug(
          `Scaled EMR TASK instance group ${physicalId} to 0 to release its instances (no standalone delete API exists)`
        );
      } catch (error) {
        if (error instanceof InvalidRequestException) {
          // The cluster / group id is not valid in this region — either the
          // cluster is already terminating/gone, or the client points at the
          // wrong region. Guard with the state region before treating it as
          // already-cleaned-up.
          const clientRegion = await this.getClient().config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(
            `EMR instance group ${physicalId} scale-to-0 skipped (cluster/group gone): ${error.message}`
          );
        } else {
          this.logger.warn(
            `Best-effort scale-to-0 of EMR instance group ${physicalId} failed: ${
              error instanceof Error ? error.message : String(error)
            } — its instances are released when the parent cluster terminates`
          );
        }
      }
      return;
    }

    this.logger.debug(
      `EMR instance group ${physicalId} (role ${role ?? 'unknown'}) has no standalone delete API; ` +
        `its instances are released when the parent cluster terminates. Removing cdkd state only.`
    );
  }

  // ─── Attributes ────────────────────────────────────────────────────

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // The only readOnly / GetAtt-served attribute is `Id`, which equals the
    // physical id (the instance group id). `Ref` resolves to the same value.
    if (attributeName === 'Id') return physicalId;
    return undefined;
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  /**
   * Poll until the group is `RUNNING` AND its `RunningInstanceCount` equals
   * `expectedCount`. The count check is load-bearing on a resize: right after
   * `ModifyInstanceGroups` the group is still in the PRE-resize `RUNNING`
   * state (EMR has not flipped it to `RESIZING` yet), so a State-only wait
   * would return before the resize even starts. Waiting on the running count
   * reaching the requested target settles both create (0 -> N provisioning)
   * and resize (M -> N add/remove) correctly.
   */
  private async waitForGroupReady(
    clusterId: string,
    groupId: string,
    logicalId: string,
    resourceType: string,
    expectedCount: number
  ): Promise<void> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      const group = await this.findGroupForPoll(clusterId, groupId, transientState);
      const state = group?.Status?.State;

      if (state && READY_STATES.has(state) && group?.RunningInstanceCount === expectedCount) {
        return;
      }

      if (state && FAILED_STATES.has(state)) {
        const reason =
          group?.Status?.StateChangeReason?.Message ?? 'no state-change reason reported';
        throw new ProvisioningError(
          `EMR instance group ${groupId} entered failed state ${state}: ${reason}`,
          resourceType,
          logicalId,
          groupId
        );
      }

      this.logger.debug(
        `EMR instance group ${groupId} state: ${state ?? 'unknown'}, running ${
          group?.RunningInstanceCount ?? '?'
        }/${expectedCount}, waiting...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EMR instance group ${groupId} to reach RUNNING with ${expectedCount} instance(s) (${Math.round(this.maxWaitMs / 60000)} min)`,
      resourceType,
      logicalId,
      groupId
    );
  }

  /**
   * `ListInstanceGroups` (paginated) for the cluster, returning the single
   * group whose `Id` matches. Absorbs up to `maxConsecutiveTransient`
   * consecutive transient errors (throttle / 5xx / reset) so a single blip
   * during a 10-minute poll does not spuriously fail the create.
   */
  private async findGroupForPoll(
    clusterId: string,
    groupId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<InstanceGroup | undefined> {
    try {
      let marker: string | undefined;
      do {
        const resp = await this.getClient().send(
          new ListInstanceGroupsCommand({
            ClusterId: clusterId,
            ...(marker && { Marker: marker }),
          })
        );
        const found = (resp.InstanceGroups ?? []).find((g) => g.Id === groupId);
        if (found) {
          transientState.count = 0;
          return found;
        }
        marker = resp.Marker;
      } while (marker);
      transientState.count = 0;
      return undefined;
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
          `Transient ListInstanceGroups error while polling ${groupId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
        );
        return undefined;
      }
      throw error;
    }
  }
}
