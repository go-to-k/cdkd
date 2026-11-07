import { EMRClient, type InstanceFleet, type InstanceFleetConfig } from '@aws-sdk/client-emr';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure, describeAwsStatusReason } from '../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markRedactedCause, relayedNameCollision } from '../../deployment/retryable-errors.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  LEFT_IN_PLACE_ON_REMOVAL,
  addInstanceFleetLatch,
  fleetsCreatedByThisProcess,
} from './emr-instance-fleet-config/shared.js';
import { create, toInstanceFleetConfig } from './emr-instance-fleet-config/create.js';
import { update } from './emr-instance-fleet-config/update.js';
import { deleteImpl } from './emr-instance-fleet-config/delete.js';
import {
  targetCapacities,
  waitForFleetReady,
  findFleetForPoll,
} from './emr-instance-fleet-config/wait.js';

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetEMRInstanceFleetCreateRetryStateForTests(): void {
  addInstanceFleetLatch.resetForTests();
  fleetsCreatedByThisProcess.resetForTests();
}

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
 *    (all via `ModifyInstanceFleet`; the resize is polled until settled). A
 *    removed capacity is sent as 0; a removed `ResizeSpecifications` /
 *    `InstanceTypeConfigs` is warned about and left in place (issue #1160).
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
 * No `isSameResource` (go-to-k/cdkd#4606), deliberately: no EMR call reads a
 * fleet by its `if-…` id alone (`ListInstanceFleets` needs the cluster id, which
 * that check is not given), and with no delete API a `'different'` would let a
 * successful deploy drop a journaled fleet that stays in its cluster. A
 * fix-forward's earlier fleet keeps the warning and exit 2.
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource deadline
 * to the polling ceiling (mirrors `EMRClusterProvider`) so a slow add/resize
 * does not require `--resource-timeout`.
 */
export class EMRInstanceFleetConfigProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type
   * (`ProvisioningType: NON_PROVISIONABLE`), so the deploy engine's #614
   * SDK-unwired auto-route MUST NOT send an unhandled-property template to CC
   * — it would fail at provisioning time with an opaque
   * UnsupportedActionException. With this opt-out the ProviderRegistry rejects
   * such templates pre-flight with a clear error instead.
   */
  readonly disableCcApiFallback = true;

  private client: EMRClient | undefined;
  private createClient: EMRClient | undefined;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('EMRInstanceFleetConfigProvider');

  readonly pollIntervalMs: number;
  readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /**
   * The failure wrap the create and update catches build.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}). A cdkd-authored or transport error, or a
   * non-`Error` throw, keeps its text; the deploy engine masks a thrown
   * message.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  /**
   * The error a FAILED / terminal state read off a successful Describe throws
   * (go-to-k/cdkd#2319). AWS's reason (`Status.StateChangeReason`) reaches the
   * same persisted sink as a caught failure, and a validation reason names IAM
   * role ARNs, so the message carries the reason's code (if any) plus the
   * `--verbose` pointer ({@link describeAwsStatusReason}). The reason goes to
   * `debug` through the operation's masker, and becomes the `cause` the wrap
   * is stamped `markRedactedCause` over, so the retry classifiers still read it
   * as they read the message before. No reason keeps cdkd's fallback text.
   *
   * `build` runs twice, so it must stay a side-effect-free constructor call
   * threading `cause`.
   */
  wrapStatusReasonError(
    mask: MaskerFn | undefined,
    reason: { code?: string | undefined; message?: string | undefined } | undefined,
    fallback: string,
    build: (text: string, cause: Error | undefined) => ProvisioningError
  ): ProvisioningError {
    const text = describeAwsStatusReason(reason, fallback);
    if (!text.redacted) return build(text.detail, undefined);
    const m = maskerOrIdentity(mask);
    const cause = new Error(text.detail);
    this.logger.debug(m(build(m(text.detail), cause).message));
    return markRedactedCause(build(m(text.summary), cause));
  }

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
    const m = maskerOrIdentity(mask);
    this.logger.debug(m(build(m(failure.detail)).message));
    return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
  }

  /**
   * The cleanup-failure text a best-effort `warn` quotes after `head`
   * (go-to-k/cdkd#2319). An AWS-authored failure is named by its CLASS at
   * warn, since a denied call names the caller's assumed-role ARN; AWS's own
   * text goes to `debug` under the same `head`, masked. A cdkd-authored or
   * transport error keeps its text, masked.
   */
  cleanupFailureText(head: string, error: unknown, mask: MaskerFn | undefined): string {
    const m = maskerOrIdentity(mask);
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return m(failure.detail);
    this.logger.debug(m(`${head}${m(failure.detail)}`));
    return m(failure.summary);
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

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()` — so the shared caller warns about
   * none of them.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EMR::InstanceFleetConfig',
      new Set([
        // Required or create-only: a removal is refused or replaces.
        'ClusterId',
        'InstanceFleetType',
        'LaunchSpecifications',
        'Name',
        // Sent as 0: ModifyInstanceFleet needs both capacities.
        'TargetOnDemandCapacity',
        'TargetSpotCapacity',
        // Left in place, as CloudFormation leaves them (CFn A/B 2026-10-20),
        // and named in update()'s own warning (no reset).
        ...LEFT_IN_PLACE_ON_REMOVAL,
      ]),
    ],
  ]);

  getClient(): EMRClient {
    if (!this.client) {
      this.client = new EMRClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * The client `AddInstanceFleet` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #2080). Separate so every other call
   * keeps the full SDK retry.
   */
  getCreateClient(): EMRClient {
    if (!this.createClient) {
      this.createClient = withoutServerErrorRetries(
        new EMRClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.createClient;
  }

  getMinResourceTimeoutMs(): number {
    // Poll ceiling PLUS one interval so the internal wait times out before the
    // deploy engine's non-cancelling external deadline (see EMRClusterProvider).
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

  toInstanceFleetConfig(properties: Record<string, unknown>): InstanceFleetConfig {
    return toInstanceFleetConfig.call(this, properties);
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

  // ─── DELETE ────────────────────────────────────────────────────────

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  // ─── Attributes ────────────────────────────────────────────────────

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // The only readOnly / GetAtt-served attribute is the instance fleet id,
    // which equals the physical id. `Ref` resolves to the same value. The CFn
    // schema renamed it `Id` -> `InstanceFleetId`; templates from an older
    // aws-cdk-lib still read `Id` (`attrId`), so both names are served.
    if (attributeName === 'Id' || attributeName === 'InstanceFleetId') return physicalId;
    return undefined;
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  targetCapacities(properties: Record<string, unknown>): { onDemand: number; spot: number } {
    return targetCapacities.call(this, properties);
  }

  waitForFleetReady(
    clusterId: string,
    fleetId: string,
    logicalId: string,
    resourceType: string,
    target: { onDemand: number; spot: number },
    previous: { onDemand: number; spot: number },
    toleratesStaleFailedState?: boolean,
    mask?: MaskerFn
  ): Promise<void> {
    return waitForFleetReady.call(
      this,
      clusterId,
      fleetId,
      logicalId,
      resourceType,
      target,
      previous,
      toleratesStaleFailedState,
      mask
    );
  }

  findFleetForPoll(
    clusterId: string,
    fleetId: string,
    transientState: { count: number },
    maxConsecutiveTransient?: number
  ): Promise<InstanceFleet | undefined> {
    return findFleetForPoll.call(this, clusterId, fleetId, transientState, maxConsecutiveTransient);
  }
}
