import type { EMRClusterProvider } from '../emr-cluster-provider.js';
import {
  TerminateJobFlowsCommand,
  DescribeClusterCommand,
  SetTerminationProtectionCommand,
  InvalidRequestException,
  type Cluster,
} from '@aws-sdk/client-emr';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { CREATE_READY_STATES, TERMINAL_STATES, emrClusterProtectionSite } from './shared.js';

/**
 * Terminate an EMR cluster.
 *
 * The compensation boundary (issue #2204): a `--remove-protection` flip of
 * `TerminationProtected` whose `TerminateJobFlows` then fails terminally is
 * undone here, so a destroy that did not happen does not leave a live cluster
 * with its guard stripped.
 */
export async function deleteImpl(
  this: EMRClusterProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) => this.deleteOnce(logicalId, physicalId, resourceType, context, flip),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site: emrClusterProtectionSite(physicalId, context?.expectedRegion),
      reEnable: async () => {
        await this.getClient().send(
          new SetTerminationProtectionCommand({
            JobFlowIds: [physicalId],
            TerminationProtected: true,
          })
        );
      },
    },
  });
}

export async function deleteOnce(
  this: EMRClusterProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting EMR Cluster ${logicalId}: ${physicalId}`);

  // Pre-check: resolve the current state so an already-terminated /
  // gone-from-a-different-region cluster is handled idempotently before
  // any terminate call.
  let current: Cluster | undefined;
  try {
    const resp = await this.getClient().send(new DescribeClusterCommand({ ClusterId: physicalId }));
    current = resp.Cluster;
  } catch (error) {
    if (error instanceof InvalidRequestException) {
      // The cluster id is not valid in this region — either truly gone or
      // the client is pointed at the wrong region. Guard with the state
      // region before trusting NotFound.
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone is named once.
        this.logger.info(
          safeMsg`  EMR cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`EMR Cluster ${physicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to describe EMR Cluster ${logicalId} before deletion: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }

  const currentState = current?.Status?.State;
  if (currentState && TERMINAL_STATES.has(currentState)) {
    if (context?.failedCreateOrphan === true) {
      // go-to-k/cdkd#4606: the usual journaled cluster — its create's wait
      // saw it terminate, then the cleanup call failed.
      this.logger.info(
        safeMsg`  EMR cluster ${physicalId} (${logicalId}), which a failed deploy created, is already ${currentState}; nothing to delete`
      );
    } else {
      this.logger.debug(`EMR Cluster ${physicalId} already ${currentState}, skipping deletion`);
    }
    return;
  }

  try {
    // Honor termination protection. Under --remove-protection, flip it off
    // first (idempotent — EMR accepts the call when already false); a
    // TerminateJobFlows against a protected cluster otherwise fails with a
    // ValidationException. Mirrors the EC2/ASG --remove-protection pattern.
    //
    // The pre-check `DescribeCluster` above is this attempt's readback of the
    // guard, so a terminal failure below restores ONLY a guard this run
    // turned off. A rejected flip still fails the delete, as before: it is
    // wrapped by the `catch` below, and nothing is recorded for it.
    if (context?.removeProtection) {
      await observeThenDisableProtection({
        flip,
        logger: this.logger,
        physicalId,
        mask: context?.maskSecrets,
        guardName: 'TerminationProtected',
        observe: () => Promise.resolve(current?.TerminationProtected === true),
        disable: async () => {
          await this.getClient().send(
            new SetTerminationProtectionCommand({
              JobFlowIds: [physicalId],
              TerminationProtected: false,
            })
          );
        },
      });
      this.logger.debug(
        `Disabled termination protection on EMR Cluster ${physicalId} before deletion`
      );
    }

    await this.getClient().send(new TerminateJobFlowsCommand({ JobFlowIds: [physicalId] }));
    // AWS took the terminate. What can still throw after this is the
    // termination WAIT (a poll failure or its timeout), against a cluster
    // that is already shutting down, so it must not re-enable the guard.
    flip.deleteAccepted = true;
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to terminate EMR Cluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }

  // Termination is async — poll until TERMINATED. A timeout is a hard error
  // (never warn-and-continue): a still-running EMR cluster keeps billing
  // per instance-hour and the destroy must not report success.
  await this.waitForClusterTerminated(physicalId, logicalId, resourceType, context?.maskSecrets);

  this.logger.debug(`Successfully deleted EMR Cluster ${logicalId}`);
}

/**
 * Issue the polling `DescribeCluster` with bounded tolerance for TRANSIENT
 * errors (throttling / 5xx / connection resets): up to
 * `maxConsecutiveTransient` consecutive failures are absorbed before the
 * error propagates. A 10-minute poll at 15s intervals would otherwise turn
 * a single throttle into a spurious failure + rollback cycle. Non-transient
 * errors propagate immediately.
 */
export async function describeForPoll(
  this: EMRClusterProvider,
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
    // `.detail`, never `.summary`: the substring test below is what keeps this
    // degradation alive, and it matches AWS's OWN wording. Byte-identical to
    // the ternary it replaced, minus that ternary's throw.
    const msg = describeAwsFailure(error).detail;
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

export async function waitForClusterReady(
  this: EMRClusterProvider,
  clusterId: string,
  logicalId: string,
  resourceType: string,
  mask?: MaskerFn
): Promise<Cluster> {
  const startTime = Date.now();
  const transientState = { count: 0 };

  while (Date.now() - startTime < this.maxWaitMs) {
    const cluster = await this.describeForPoll(clusterId, transientState);
    const state = cluster?.Status?.State;

    if (cluster && state && CREATE_READY_STATES.has(state)) return cluster;

    if (state && TERMINAL_STATES.has(state)) {
      const reason = cluster?.Status?.StateChangeReason;
      throw this.wrapStatusReasonError(
        mask,
        { code: reason?.Code, message: reason?.Message },
        'no state-change reason reported',
        (text, cause) =>
          new ProvisioningError(
            `EMR Cluster ${clusterId} entered terminal state ${state} during creation: ${text}`,
            resourceType,
            logicalId,
            clusterId,
            cause
          )
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

export async function waitForClusterTerminated(
  this: EMRClusterProvider,
  clusterId: string,
  logicalId: string,
  resourceType: string,
  mask?: MaskerFn
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
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to poll EMR Cluster ${clusterId} termination: ${text}`,
            resourceType,
            logicalId,
            clusterId,
            cause
          )
      );
    }

    const state = cluster?.Status?.State;
    if (state && TERMINAL_STATES.has(state)) {
      if (state === 'TERMINATED_WITH_ERRORS') {
        // The reason's code at warn, its text at debug (go-to-k/cdkd#2319): a
        // validation reason names IAM role ARNs and the account id.
        const m = maskerOrIdentity(mask);
        const head = `EMR Cluster ${clusterId} terminated with errors: `;
        const stateReason = cluster?.Status?.StateChangeReason;
        const reason = describeAwsStatusReason(
          { code: stateReason?.Code, message: stateReason?.Message },
          'no state-change reason reported'
        );
        if (reason.redacted) this.logger.debug(m(`${head}${m(reason.detail)}`));
        this.logger.warn(
          m(`${head}${m(reason.summary)} (the cluster is gone and no longer bills)`)
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
