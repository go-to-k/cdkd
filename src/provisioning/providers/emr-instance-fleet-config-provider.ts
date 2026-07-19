import {
  EMRClient,
  AddInstanceFleetCommand,
  ModifyInstanceFleetCommand,
  ListInstanceFleetsCommand,
  InvalidRequestException,
  type InstanceFleet,
  type InstanceFleetConfig,
  type InstanceFleetModifyConfig,
  type InstanceFleetState,
  type InstanceFleetType,
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
 * Default polling budget for an instance fleet reaching RUNNING. Adding a
 * fleet to an already-WAITING cluster provisions + bootstraps its EC2
 * instances (typically 2-6 minutes); a resize settles faster. Reuse the
 * EMR Cluster provider's 1-hour ceiling so the slowest realistic add still
 * fits inside the per-resource deadline.
 */
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Instance-fleet state that means "the fleet is up and idle/serving". */
const READY_STATES: ReadonlySet<InstanceFleetState> = new Set<InstanceFleetState>(['RUNNING']);

/**
 * Instance-fleet states that mean "the fleet will never reach the requested
 * capacity" — a hard error during a create/resize wait.
 *
 * `TERMINATED` means the fleet is gone. `SUSPENDED` means a resize could not
 * complete: the existing instances keep running but AWS can no longer add or
 * remove any, so the wait would poll to the full `maxWaitMs` timeout instead of
 * failing fast with the service's own state-change reason. Mirrors the
 * instance-group provider's ARRESTED/TERMINATED/ENDED set (issue #1092 item 2).
 */
const FAILED_STATES: ReadonlySet<InstanceFleetState> = new Set<InstanceFleetState>([
  'SUSPENDED',
  'TERMINATED',
]);

const toNumber = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * SDK Provider for `AWS::EMR::InstanceFleetConfig` (issue #1070).
 *
 * This type adds a standalone instance fleet (MASTER / CORE / TASK) to an
 * EXISTING EMR cluster (referenced by `ClusterId`), rather than declaring the
 * fleet inline in `AWS::EMR::Cluster.Instances`. It is
 * `ProvisioningType: NON_PROVISIONABLE` in the CFn registry, so Cloud Control
 * cannot handle it — pre-flight would otherwise reject it via
 * `unsupported-types.generated.ts`.
 *
 * Lifecycle:
 *  - `create` → `AddInstanceFleet` + poll `ListInstanceFleets` until the new
 *    fleet is `RUNNING`. A `TERMINATED` terminal during the wait is a hard
 *    error.
 *  - `update` → only the AWS-mutable properties: `TargetOnDemandCapacity`,
 *    `TargetSpotCapacity`, `ResizeSpecifications`, and `InstanceTypeConfigs`
 *    (all via `ModifyInstanceFleet`; the resize is polled until settled).
 *    `Name` / `LaunchSpecifications` / `InstanceFleetType` are
 *    registry-createOnly → routed through DELETE+CREATE by the
 *    replacement-detection layer; a createOnly change that reaches `update()`
 *    anyway is refused with a `--replace` pointer.
 *  - `delete` → **no standalone AWS API exists.** EMR cannot remove an
 *    instance fleet from a running cluster; a fleet's only lifecycle end is
 *    cluster termination. In the normal `cdkd destroy` the parent
 *    `AWS::EMR::Cluster` is terminated in the same run (its `TerminateJobFlows`
 *    releases every fleet + its EC2 instances), so this delete is a no-op that
 *    just drops cdkd state — leaving ZERO orphans. As a best effort for the
 *    less common "delete only the fleet, keep the cluster" case, a TASK fleet
 *    is scaled to 0 target capacity (`ModifyInstanceFleet`) to release its
 *    instances; MASTER/CORE fleets cannot be scaled to 0 and are a pure no-op.
 *    Never blocks the destroy (warn-and-continue).
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource deadline
 * to the polling ceiling (mirrors `EMRClusterProvider`) so a slow add/resize
 * does not require `--resource-timeout`.
 */
export class EMRInstanceFleetConfigProvider implements ResourceProvider {
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
  private logger = getLogger().child('EMRInstanceFleetConfigProvider');

  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::InstanceFleetConfig',
      new Set([
        'ClusterId',
        'InstanceFleetType',
        'InstanceTypeConfigs',
        'LaunchSpecifications',
        'Name',
        'ResizeSpecifications',
        'TargetOnDemandCapacity',
        'TargetSpotCapacity',
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
    if (resourceType !== 'AWS::EMR::InstanceFleetConfig') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    const clusterId = properties['ClusterId'] as string | undefined;
    if (!clusterId) {
      throw new ProvisioningError(
        `EMR InstanceFleetConfig ${logicalId} is missing ClusterId (the parent cluster id)`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Adding EMR instance fleet ${logicalId} to cluster ${clusterId}`);

    try {
      const fleet = this.toInstanceFleetConfig(properties);
      const response = await this.getClient().send(
        new AddInstanceFleetCommand({ ClusterId: clusterId, InstanceFleet: fleet })
      );
      const fleetId = response.InstanceFleetId;
      if (!fleetId) {
        throw new ProvisioningError(
          `EMR AddInstanceFleet for ${logicalId} returned no instance fleet id`,
          resourceType,
          logicalId
        );
      }

      // create always ramps capacity UP from 0, so wait for provisioned >= target.
      await this.waitForFleetReady(
        clusterId,
        fleetId,
        logicalId,
        resourceType,
        this.targetCapacity(properties),
        true
      );

      this.logger.debug(`Successfully added EMR instance fleet ${logicalId}: ${fleetId}`);
      return { physicalId: fleetId, attributes: { Id: fleetId } };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to add EMR instance fleet ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private toInstanceFleetConfig(properties: Record<string, unknown>): InstanceFleetConfig {
    return {
      InstanceFleetType: properties['InstanceFleetType'] as InstanceFleetType,
      Name: properties['Name'] as string | undefined,
      TargetOnDemandCapacity: toNumber(properties['TargetOnDemandCapacity']),
      TargetSpotCapacity: toNumber(properties['TargetSpotCapacity']),
      InstanceTypeConfigs: properties['InstanceTypeConfigs'] as
        | import('@aws-sdk/client-emr').InstanceTypeConfig[]
        | undefined,
      LaunchSpecifications: properties['LaunchSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetProvisioningSpecifications
        | undefined,
      ResizeSpecifications: properties['ResizeSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
        | undefined,
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

    // Only the ModifyInstanceFleet surface is mutable on AWS. Every other
    // property is registry-createOnly (routed through DELETE+CREATE before
    // reaching here); a createOnly change that arrives anyway means the
    // replacement layer was bypassed — refuse it with a --replace pointer.
    const MUTABLE = new Set([
      'TargetOnDemandCapacity',
      'TargetSpotCapacity',
      'ResizeSpecifications',
      'InstanceTypeConfigs',
    ]);
    for (const key of Object.keys({ ...properties, ...previousProperties })) {
      if (!changed(key)) continue;
      if (!MUTABLE.has(key)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS EMR InstanceFleetConfig ${key} is immutable on AWS — it is fixed when the instance fleet is created. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    const anyMutableChanged = [...MUTABLE].some((k) => changed(k));
    if (!anyMutableChanged) {
      this.logger.debug(`No mutable diff for EMR instance fleet ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    const clusterId = properties['ClusterId'] as string | undefined;
    if (!clusterId) {
      throw new ProvisioningError(
        `EMR InstanceFleetConfig ${logicalId} update needs ClusterId (the cluster id), which is absent`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    this.logger.debug(`Updating EMR instance fleet ${logicalId}: ${physicalId}`);

    try {
      const modify: InstanceFleetModifyConfig = {
        InstanceFleetId: physicalId,
        TargetOnDemandCapacity: toNumber(properties['TargetOnDemandCapacity']),
        TargetSpotCapacity: toNumber(properties['TargetSpotCapacity']),
        ResizeSpecifications: properties['ResizeSpecifications'] as
          | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
          | undefined,
        InstanceTypeConfigs: properties['InstanceTypeConfigs'] as
          | import('@aws-sdk/client-emr').InstanceTypeConfig[]
          | undefined,
      };
      await this.getClient().send(
        new ModifyInstanceFleetCommand({ ClusterId: clusterId, InstanceFleet: modify })
      );
      // The resize is async; poll until the fleet has actually reached the new
      // target capacity. Waiting on fleet State alone is NOT enough: right
      // after ModifyInstanceFleet the fleet is still in the PRE-resize RUNNING
      // state, so a State-only wait returns instantly. Wait on provisioned
      // capacity meeting the target instead — and on a scale-DOWN wait for
      // provisioned to DRAIN to the target (a State-only or `>=`-only wait would
      // return immediately because the stale pre-resize provisioned capacity is
      // still ABOVE the new lower target). Direction from prev vs new target.
      const newTarget = this.targetCapacity(properties);
      const prevTarget = this.targetCapacity(previousProperties);
      await this.waitForFleetReady(
        clusterId,
        physicalId,
        logicalId,
        resourceType,
        newTarget,
        newTarget >= prevTarget
      );

      this.logger.debug(`Successfully updated EMR instance fleet ${logicalId}`);
      return { physicalId, wasReplaced: false, attributes: { Id: physicalId } };
    } catch (error) {
      if (error instanceof ProvisioningError || error instanceof ResourceUpdateNotSupportedError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EMR instance fleet ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    // There is NO standalone "delete instance fleet" API in EMR. An instance
    // fleet's only lifecycle end is cluster termination — the parent
    // AWS::EMR::Cluster's delete (TerminateJobFlows) releases every fleet and
    // its EC2 instances. In the normal destroy this delete therefore just
    // drops cdkd state and leaves zero orphans.
    //
    // Best effort for the "delete only the fleet, keep the cluster" case: a
    // TASK fleet is scaled to 0 target capacity to release its instances
    // (MASTER/CORE cannot be scaled to 0). Warn-and-continue — never block the
    // destroy.
    const fleetType = properties?.['InstanceFleetType'] as string | undefined;
    const clusterId = properties?.['ClusterId'] as string | undefined;

    if (fleetType === 'TASK' && clusterId) {
      try {
        await this.getClient().send(
          new ModifyInstanceFleetCommand({
            ClusterId: clusterId,
            InstanceFleet: {
              InstanceFleetId: physicalId,
              TargetOnDemandCapacity: 0,
              TargetSpotCapacity: 0,
            },
          })
        );
        this.logger.debug(
          `Scaled EMR TASK instance fleet ${physicalId} to 0 to release its instances (no standalone delete API exists)`
        );
      } catch (error) {
        if (error instanceof InvalidRequestException) {
          // The cluster / fleet id is not valid in this region — either the
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
            `EMR instance fleet ${physicalId} scale-to-0 skipped (cluster/fleet gone): ${error.message}`
          );
        } else {
          this.logger.warn(
            `Best-effort scale-to-0 of EMR instance fleet ${physicalId} failed: ${
              error instanceof Error ? error.message : String(error)
            } — its instances are released when the parent cluster terminates`
          );
        }
      }
      return;
    }

    this.logger.debug(
      `EMR instance fleet ${physicalId} (type ${fleetType ?? 'unknown'}) has no standalone delete API; ` +
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
    // physical id (the instance fleet id). `Ref` resolves to the same value.
    if (attributeName === 'Id') return physicalId;
    return undefined;
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  /** Total target capacity (On-Demand + Spot) requested for the fleet. */
  private targetCapacity(properties: Record<string, unknown>): number {
    return (
      (toNumber(properties['TargetOnDemandCapacity']) ?? 0) +
      (toNumber(properties['TargetSpotCapacity']) ?? 0)
    );
  }

  /**
   * Poll until the fleet is `RUNNING` AND its provisioned capacity
   * (On-Demand + Spot) has settled at `targetCapacity`. The capacity check is
   * load-bearing on a resize: right after `ModifyInstanceFleet` the fleet is
   * still in the PRE-resize `RUNNING` state, so a State-only wait would return
   * before the resize even starts.
   *
   * `atLeast` selects the settle direction:
   *  - `true` (create / scale-UP): ready when `provisioned >= targetCapacity`
   *    (`>=`, not `==`, because a weighted-capacity allocation may overshoot).
   *  - `false` (scale-DOWN): ready when `provisioned <= targetCapacity` — the
   *    stale pre-resize provisioned capacity is ABOVE the new lower target, so
   *    an `>=` check would return instantly before instances drain.
   *
   * A `targetCapacity` of 0 on the up path (never valid for a real create —
   * at least one target must be > 0) degrades to a State-only wait.
   */
  private async waitForFleetReady(
    clusterId: string,
    fleetId: string,
    logicalId: string,
    resourceType: string,
    targetCapacity: number,
    atLeast: boolean
  ): Promise<void> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      const fleet = await this.findFleetForPoll(clusterId, fleetId, transientState);
      const state = fleet?.Status?.State;
      const provisioned =
        (fleet?.ProvisionedOnDemandCapacity ?? 0) + (fleet?.ProvisionedSpotCapacity ?? 0);
      const capacityReady = atLeast ? provisioned >= targetCapacity : provisioned <= targetCapacity;

      if (state && READY_STATES.has(state) && capacityReady) return;

      if (state && FAILED_STATES.has(state)) {
        const reason =
          fleet?.Status?.StateChangeReason?.Message ?? 'no state-change reason reported';
        throw new ProvisioningError(
          `EMR instance fleet ${fleetId} entered failed state ${state}: ${reason}`,
          resourceType,
          logicalId,
          fleetId
        );
      }

      this.logger.debug(
        `EMR instance fleet ${fleetId} state: ${state ?? 'unknown'}, provisioned ${provisioned}/${targetCapacity}, waiting...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EMR instance fleet ${fleetId} to reach RUNNING with capacity ${targetCapacity} (${Math.round(this.maxWaitMs / 60000)} min)`,
      resourceType,
      logicalId,
      fleetId
    );
  }

  /**
   * `ListInstanceFleets` (paginated) for the cluster, returning the single
   * fleet whose `Id` matches. Absorbs up to `maxConsecutiveTransient`
   * consecutive transient errors (throttle / 5xx / reset) so a single blip
   * during a 10-minute poll does not spuriously fail the create.
   */
  private async findFleetForPoll(
    clusterId: string,
    fleetId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<InstanceFleet | undefined> {
    try {
      let marker: string | undefined;
      do {
        const resp = await this.getClient().send(
          new ListInstanceFleetsCommand({
            ClusterId: clusterId,
            ...(marker && { Marker: marker }),
          })
        );
        const found = (resp.InstanceFleets ?? []).find((f) => f.Id === fleetId);
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
          `Transient ListInstanceFleets error while polling ${fleetId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
        );
        return undefined;
      }
      throw error;
    }
  }
}
