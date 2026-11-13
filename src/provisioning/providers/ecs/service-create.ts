import type { ECSProvider } from '../ecs-provider.js';
import {
  ECSClient,
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  waitUntilServicesStable,
  type Deployment,
  type LaunchType,
  type SchedulingStrategy,
  type PropagateTags,
  type AvailabilityZoneRebalancing,
} from '@aws-sdk/client-ecs';
import { describeAwsFailure, verbosePointerTail } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markRedactedCause } from '../../../deployment/retryable-errors.js';
import { generatedNameFor } from '../../resource-name.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { logicalIdShown } from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import {
  hasErrorName,
  nameHeldBefore,
  skippedCleanupText,
  type NameHeldBefore,
} from '../create-ownership.js';
import {
  convertTags,
  settleRolloutDelays,
  type RequestedRollout,
  requestedRolloutOf,
  failedRequestedDeployment,
  describeRollout,
  EcsCircuitBreakerVerdict,
  wrapBreakerFailedError,
  controllerSkipsWait,
  rolloutSupersededBy,
} from './shared.js';

// ─── AWS::ECS::Service ──────────────────────────────────────────

export async function createService(
  this: ECSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks,
  /** `CreateContext.replayingState`: a rollback's reverse-replacement re-create. */
  replayingState: boolean
): Promise<ResourceCreateResult> {
  log.debug(`Creating ECS service ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const client = this.getClient();

  const serviceName =
    (properties['ServiceName'] as string | undefined) ||
    generatedNameFor('AWS::ECS::Service', logicalId);
  // go-to-k/cdkd#4583: the ARN of a service CreateService returned that the
  // cleanup below could not delete, named for the failed-CREATE journal.
  let survivorArn: string | undefined;

  try {
    // Whether the cleanup below may delete what CreateService returns: with
    // identical parameters it hands back an ACTIVE service already holding
    // the name (go-to-k/cdkd#4403). Asked only when the wait can fail the
    // create: not under --no-wait, not for a controller ECS does not
    // settle (no wait runs), and not on a rollback replay, which warns and
    // keeps the service instead (see the catch below).
    const skipReason = controllerSkipsWait(properties);
    const heldBefore: NameHeldBefore =
      process.env['CDKD_NO_WAIT'] !== 'true' && skipReason === undefined && !replayingState
        ? await nameHeldBefore(
            () => this.serviceNameHeld(properties['Cluster'] as string | undefined, serviceName),
            (error) => hasErrorName(error, ['ClusterNotFoundException'])
          )
        : 'free';

    const response = await client.send(
      new CreateServiceCommand({
        cluster: properties['Cluster'] as string | undefined,
        serviceName,
        taskDefinition: properties['TaskDefinition'] as string | undefined,
        desiredCount: properties['DesiredCount'] as number | undefined,
        launchType: properties['LaunchType'] as LaunchType | undefined,
        networkConfiguration: this.convertNetworkConfiguration(
          properties['NetworkConfiguration'] as Record<string, unknown> | undefined
        ),
        loadBalancers: this.convertLoadBalancers(
          properties['LoadBalancers'] as Array<Record<string, unknown>> | undefined
        ),
        capacityProviderStrategy: this.convertCapacityProviderStrategy(
          properties['CapacityProviderStrategy'] as Array<Record<string, unknown>> | undefined
        ),
        deploymentConfiguration: this.convertDeploymentConfiguration(
          properties['DeploymentConfiguration'] as Record<string, unknown> | undefined
        ),
        placementConstraints: this.convertPlacementConstraints(
          properties['PlacementConstraints'] as Array<Record<string, unknown>> | undefined
        ),
        placementStrategy: this.convertPlacementStrategies(
          (properties['PlacementStrategies'] ?? properties['PlacementStrategy']) as
            | Array<Record<string, unknown>>
            | undefined
        ),
        platformVersion: properties['PlatformVersion'] as string | undefined,
        healthCheckGracePeriodSeconds: properties['HealthCheckGracePeriodSeconds'] as
          | number
          | undefined,
        schedulingStrategy: properties['SchedulingStrategy'] as SchedulingStrategy | undefined,
        enableECSManagedTags: properties['EnableECSManagedTags'] as boolean | undefined,
        propagateTags: properties['PropagateTags'] as PropagateTags | undefined,
        enableExecuteCommand: properties['EnableExecuteCommand'] as boolean | undefined,
        serviceRegistries: this.convertServiceRegistries(
          properties['ServiceRegistries'] as Array<Record<string, unknown>> | undefined
        ),
        tags: convertTags(desiredTags),
        // issue #609 backfill — previously SDK-unwired Service members.
        // `ForceNewDeployment` is deliberately NOT mapped here: it is a
        // CFn-only rollout trigger with no CreateService counterpart (the
        // SDK's `forceNewDeployment` boolean exists only on UpdateService),
        // so it is a create-path no-op — see `resolveForceNewDeployment`.
        availabilityZoneRebalancing: properties['AvailabilityZoneRebalancing'] as
          | AvailabilityZoneRebalancing
          | undefined,
        deploymentController: this.convertDeploymentController(
          properties['DeploymentController'] as Record<string, unknown> | undefined
        ),
        // `Role` is the legacy classic-ELB service role override — a real
        // create-only CFn property (createOnlyProperties in the registry
        // schema), passed through verbatim; a change classifies as
        // replacement via the create-only fallback in the diff layer.
        role: properties['Role'] as string | undefined,
        serviceConnectConfiguration: this.convertServiceConnectConfiguration(
          properties['ServiceConnectConfiguration'] as Record<string, unknown> | undefined
        ),
        volumeConfigurations: this.convertServiceVolumeConfigurations(
          properties['VolumeConfigurations'] as Array<Record<string, unknown>> | undefined
        ),
        vpcLatticeConfigurations: this.convertVpcLatticeConfigurations(
          properties['VpcLatticeConfigurations'] as Array<Record<string, unknown>> | undefined
        ),
        monitoring: this.convertMonitoringConfiguration(
          properties['Monitoring'] as Record<string, unknown> | undefined
        ),
        // go-to-k/cdkd#5634: the 2026-10-20 schema-refresh addition.
        gatewayConnectors: this.convertGatewayConnectors(
          properties['GatewayConnectors'] as Array<Record<string, unknown>> | undefined
        ),
      })
    );

    const service = response.service;
    if (!service || !service.serviceArn) {
      throw new Error('CreateService did not return service ARN');
    }

    log.debug(`Successfully created ECS service ${logicalId}: ${service.serviceArn}`);
    // go-to-k/cdkd#5511: only a service this create made (not a held one).
    if (heldBefore === 'free') {
      reportCreatedResource(logicalId, resourceType, service.serviceArn);
    }

    // A steady-state failure (timeout or circuit breaker) has to fail the
    // resource, which means throwing AFTER AWS has already created the service. The
    // throw aborts before the success-return, so cdkd state would not carry
    // the service while AWS does, and the next deploy's CreateService would
    // collide on the name. Clean up best-effort first, mirroring the
    // partial-create handling in the ELBv2 / EC2 Instance providers.
    // `force: true` deletes without a separate scale-to-0 round trip.
    // The cleanup NARROWS the collision window rather than closing it:
    // DeleteService returns with the service in DRAINING, which outlives
    // the call, so an immediate retry can still hit a name conflict until
    // draining completes (issue #1291 item 4).
    //
    // The UPDATE path deliberately does NOT delete on the same timeout,
    // and the asymmetry is about STATE OWNERSHIP, not about whether AWS
    // holds the service. Both cases end with AWS holding a service that is
    // not steady, so "AWS has it" alone cannot explain the difference:
    //
    //   - CREATE: cdkd has no state record and, because the throw skips the
    //     success-return, never will. The service is unreachable from cdkd
    //     forever after — an orphan that also blocks the retry, since the
    //     next CreateService hits the name. Deleting it is the only way back
    //     to a consistent pair.
    //   - UPDATE: the state record already exists and keeps pointing at this
    //     same serviceArn. The failure leaves a live, previously-working
    //     service mid-rollout; cdkd can still see it, `cdkd destroy` still
    //     removes it, and the next deploy retries UpdateService against it.
    //     Deleting there would DESTROY a running service (dropping every
    //     task serving traffic) to react to a wait that timed out — turning
    //     a recoverable stall into an outage.
    //
    // So the rule is "delete only what cdkd is about to lose track of",
    // which is exactly the create case.
    try {
      await this.settleService(
        logicalId,
        service.serviceName ?? service.serviceArn,
        properties['Cluster'] as string | undefined,
        log,
        requestedRolloutOf(service),
        skipReason
      );
    } catch (waitError) {
      if (replayingState) {
        // A rollback's reverse-replacement re-create (go-to-k/cdkd#5571):
        // the desired bag is a STATE record, restoring what the stack held
        // before the failed deploy. Deleting the never-stable service or
        // failing here would leave the rollback unfinished and the stack
        // un-rollbackable over a rollout the user cannot fix through the
        // template; whether the restored service runs is the next deploy's
        // question. Warn and record it, so state carries what AWS holds.
        log.warn(
          `${this.wrapSteadyStateError(logicalId, waitError, properties['Cluster'], log, false).message} Continuing the rollback: the restored service stays recorded.`
        );
        return {
          physicalId: service.serviceArn,
          attributes: {
            ServiceArn: service.serviceArn,
            Name: service.serviceName,
          },
        };
      }
      // Include --cluster: a service in a non-default cluster cannot be
      // addressed without it, and the ARN alone is not documented to imply
      // the cluster. Matches the INFO hint's shape.
      //
      // Every command below renders through `pasteableAwsCommand` (issue
      // #3136): the cluster is a TEMPLATE value, so it is sanitized and
      // shell-quoted, and one that cannot be printed exactly withholds the
      // command. The service ARN is AWS-minted but embeds the
      // template-chosen service name, so it takes the same gate. The
      // operation's masker withholds a command naming a secret (issue #2177).
      const aws = pasteableAwsCommand(log.mask);
      // A truthy NON-string reaches the tag and withholds the command:
      // dropping `--cluster` would address the default cluster instead.
      const cleanupCluster = properties['Cluster'] as string | undefined;
      const clusterArg = cleanupCluster ? aws` --cluster ${cleanupCluster}` : aws``;
      const listStopped = aws`aws ecs list-tasks${clusterArg} --desired-status STOPPED`;
      const deleteCommand = aws`aws ecs delete-service${clusterArg} --service ${service.serviceArn} --force`;
      if (heldBefore !== 'free') {
        log.warn(
          skippedCleanupText(
            heldBefore,
            `ECS service ${logicalIdShown(logicalId)} ${isPlainImportValue(service.serviceArn) ? `(${service.serviceArn})` : VALUE_NOT_SHOWN}`,
            deleteCommand.render()
          )
        );
      } else {
        try {
          await client.send(
            new DeleteServiceCommand({
              cluster: properties['Cluster'] as string | undefined,
              service: service.serviceArn,
              force: true,
            })
          );
          retractCreatedResource(logicalId, resourceType, service.serviceArn);
          // warn, not debug: the dominant steady-state failure is a crashing
          // container, and this delete removes the service the user would
          // reach for first when asking "why". Say where the evidence
          // still lives (issue #1291 item 2).
          log.warn(
            `Deleted partially-created ECS service ${logicalId} (${service.serviceArn}) after the steady-state wait failed, so the next deploy's CreateService does not collide on the name. Its stopped tasks remain inspectable for about an hour: ${listStopped.render()}`
          );
        } catch (cleanupError) {
          survivorArn = service.serviceArn;
          // An AWS-authored failure is named by its class at warn, and AWS's
          // text (a denied `DeleteService` names the caller) goes to `debug`
          // under the same head (go-to-k/cdkd#2319).
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up partially-created ECS service ${logicalIdShown(logicalId)} ${isPlainImportValue(service.serviceArn) ? `(${service.serviceArn})` : VALUE_NOT_SHOWN}: `;
          if (cleanupFailure.redacted) log.debug(`${cleanupHead}${cleanupFailure.detail}`);
          log.warn(
            `${cleanupHead}${cleanupFailure.redacted ? `${cleanupFailure.summary} ` : `${cleanupFailure.detail}. `}Manual deletion may be required before the next deploy: ${deleteCommand.render()}`
          );
        }
      }
      // The SDK waiter's bare "Waiter has timed out" explains nothing.
      // Carry the diagnosis path in the thrown message; the wrapping
      // ProvisioningError in the outer catch preserves it verbatim, and
      // the cause chain keeps the original waiter error reachable for
      // `cdkd events` metadata extraction.
      throw this.wrapSteadyStateError(logicalId, waitError, properties['Cluster'], log);
    }

    return {
      physicalId: service.serviceArn,
      attributes: {
        ServiceArn: service.serviceArn,
        Name: service.serviceName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(log.mask, error, (text) => {
      const wrapped = new ProvisioningError(
        // The wrapped text can be the steady-state refusal, with its `aws`
        // commands, so the logical id is shown only when plain
        // (go-to-k/cdkd#4295).
        `Failed to create ECS service ${logicalIdShown(logicalId)}: ${text}`,
        resourceType,
        logicalId,
        serviceName,
        cause
      );
      // The ARN is what delete() takes (the success physicalId).
      if (survivorArn !== undefined) {
        markCreatedBeforeFailure(wrapped, logicalId, resourceType, survivorArn);
      }
      return wrapped;
    });
  }
}

/**
 * Does a service that is not INACTIVE already hold `serviceName` in
 * `cluster`? The by-name lookup before CreateService (go-to-k/cdkd#4403):
 * CreateService hands back an ACTIVE service with identical parameters, and
 * refuses the name while one is DRAINING, so both read as held. An INACTIVE
 * service is gone (a create under its name makes a new one), as is a
 * `MISSING` failure. Any other answer throws, which reads as `unknown`.
 */
export async function serviceNameHeld(
  this: ECSProvider,
  cluster: string | undefined,
  serviceName: string
): Promise<boolean> {
  const response = await this.getClient().send(
    new DescribeServicesCommand({ cluster, services: [serviceName] })
  );
  const services = response.services ?? [];
  const failures = response.failures ?? [];
  if (services.length === 0 && failures.length === 1 && failures[0]?.reason === 'MISSING') {
    return false;
  }
  if (failures.length > 0 || services.length !== 1) {
    throw new Error('DescribeServices gave no readable answer for the service name');
  }
  return services[0]!.status !== 'INACTIVE';
}

/**
 * The error a `waitUntilServicesStable` that did not succeed throws, with
 * AWS's text withheld (go-to-k/cdkd#2319). `@smithy/util-waiter` throws a
 * plain `Error` whose message is the JSON of the waiter's result: every
 * DescribeServices answer it saw (service, task-definition and role ARNs)
 * and every failure's text (a denied call quotes the caller's assumed-role
 * ARN). It carries no AWS-authored signal, so the failure wrap would keep it
 * whole and persist it to `deployments/{runId}.jsonl`. The thrown message
 * names the waiter's state and error name plus the `--verbose` pointer; the
 * result goes to `debug`, masked, and stays on the stamped `cause` chain for
 * the retry classifiers. Any other error is returned as it is.
 */
export function wrapWaiterResultError(
  this: ECSProvider,
  error: unknown,
  logicalId: string,
  log: MaskedLogSinks
): unknown {
  if (!(error instanceof Error)) return error;
  let state: unknown;
  try {
    state = (JSON.parse(error.message) as { state?: unknown } | null)?.state;
  } catch {
    return error;
  }
  if (typeof state !== 'string' || !/^[A-Z]+$/.test(state)) return error;
  log.debug(`ECS service ${logicalId} ServicesStable waiter result: ${error.message}`);
  const reduced = new Error(
    `the ServicesStable waiter ended in state ${state}${error.name && error.name !== 'Error' ? ` (${error.name})` : ''}.${verbosePointerTail()}`,
    { cause: error }
  );
  // Keep the waiter's name (`TimeoutError`): `isAmbiguousOutcomeError` and
  // the chain walks read it, and this adds a link to the cause chain.
  reduced.name = error.name;
  return markRedactedCause(reduced);
}

/**
 * The failure `createService` / `updateService` throw when `settleService`
 * did not settle: the waiter's (or the breaker check's) reason, plus the two
 * commands that show why the service's tasks stopped. Names `--no-wait` only
 * where the invoking command declares it (`CDKD_WAIT_FLAGS_AVAILABLE`), and
 * the logical id only when plain (go-to-k/cdkd#4295).
 *
 * An AWS-authored failure (the rollout poll's DescribeServices) is named by
 * its class here, its text at `debug` and on the stamped `cause` chain
 * (go-to-k/cdkd#2319); the outer wrap keeps this cdkd-authored sentence.
 */
export function wrapSteadyStateError(
  this: ECSProvider,
  logicalId: string,
  waitError: unknown,
  cluster: unknown,
  log: MaskedLogSinks,
  /** `false` where the failure is only warned about (a state-borne replay). */
  offerNoWait = true
): Error {
  const aws = pasteableAwsCommand(log.mask);
  // A truthy NON-string reaches the tag and withholds the command:
  // dropping `--cluster` would address the default cluster instead.
  const clusterArg = cluster ? aws` --cluster ${cluster as string}` : aws``;
  const listStopped = aws`aws ecs list-tasks${clusterArg} --desired-status STOPPED`;
  const waitFailure = describeAwsFailure(waitError);
  if (waitFailure.redacted) {
    log.debug(`ECS service ${logicalId} steady-state wait failed: ${waitFailure.detail}`);
  }
  // Flags are named only where the invoking command declares them. A
  // breaker verdict is final, so a longer wait is offered only for a wait
  // that ran out (or failed otherwise), never for the verdict.
  const flagsAvailable = offerNoWait && process.env['CDKD_WAIT_FLAGS_AVAILABLE'] === 'true';
  const timeoutHint =
    flagsAvailable && !(waitError instanceof EcsCircuitBreakerVerdict)
      ? ` To wait longer, raise the limit with --resource-timeout AWS::ECS::Service=${commandHole('duration')}.`
      : '';
  const noWaitHint = flagsAvailable
    ? ' To deploy without waiting for steady state, pass --no-wait.'
    : '';
  const steadyStateError = new Error(
    `ECS service ${logicalIdShown(logicalId)} did not reach steady state: ${waitFailure.summary.replace(/\.$/, '')}. Inspect why its tasks stopped (stopped tasks stay visible for about an hour): ${listStopped.render()}, then ${aws`aws ecs describe-tasks${clusterArg} --tasks '<task-arn>' --query 'tasks[].[stoppedReason,containers[].reason]'`.render()}.${timeoutHint}${noWaitHint}`,
    { cause: waitError }
  );
  return waitFailure.redacted ? markRedactedCause(steadyStateError) : steadyStateError;
}

/**
 * Settle an ECS Service according to the run's wait mode.
 *
 * cdkd WAITS for steady state by default (go-to-k/cdkd#5571, superseding
 * the fire-and-forget default of #1275), as CloudFormation does. Steady
 * state is the one signal that tells a healthy rollout from a failing one
 * (a crash-looping container, an image that cannot be pulled), which is the
 * failure detection the default wait tier exists for; Terraform's
 * `wait_for_steady_state = false` default gives way here. `--no-wait`
 * (`CDKD_NO_WAIT`) is the escape hatch and keeps the old early return with
 * its manual-wait INFO line. `--full-wait` changes nothing for this type.
 *
 * `requested` is the rollout this create / update started, read off the
 * `CreateService` / `UpdateService` response. Two circuit-breaker checks
 * use it (go-to-k/cdkd#5571): a requested deployment observed `FAILED`
 * during the wait ends it at once (`failedRequestedDeployment`), and after
 * steady state a service that settled on a DIFFERENT deployment — what a
 * breaker with `rollback: true` leaves once the failed deployment drains,
 * one `COMPLETED` deployment the waiter accepts — throws too
 * (`rolloutSupersededBy`). Both fail open on an unreadable response.
 */
export async function settleService(
  this: ECSProvider,
  logicalId: string,
  serviceRef: string,
  cluster: string | undefined,
  log: MaskedLogSinks,
  requested: RequestedRollout | undefined,
  /**
   * Why this service is not waited for whatever the mode (an ECS-unsettled
   * `DeploymentController`, a `drift --revert`), or `undefined` to follow
   * the run's wait mode.
   */
  skipReason: string | undefined
): Promise<void> {
  if (skipReason !== undefined) {
    // INFO has no masked sink; the finished line goes through the same
    // mask. No `--no-wait` hint: the flag would change nothing here.
    this.logger.info(
      log.mask(
        `ECS service ${logicalIdShown(logicalId)} accepted (not waiting for steady state: ${skipReason}).`
      )
    );
    return;
  }
  if (process.env['CDKD_NO_WAIT'] !== 'true') {
    log.debug(`Waiting for ECS service ${logicalId} to reach steady state...`);
    // 600s matches Terraform's `aws_ecs_service` default create timeout, and
    // stays the floor on purpose even though the default now waits
    // (go-to-k/cdkd#5571): a breaker-less crash loop must not hold a dev
    // deploy for the generic 30m resource timeout. An explicit
    // `--resource-timeout` (per-type or global) lifts the cap so the inner
    // waiter can never undercut the outer per-resource deadline the same
    // flag raises (issue #1280) — but never lowers it below the 600s floor;
    // the timeout failure names that flag.
    const maxWaitTime = Math.max(600, (resolvedResourceTimeoutMs('AWS::ECS::Service') ?? 0) / 1000);
    // A circuit breaker's verdict ends the wait early: every DescribeServices
    // answer the waiter reads is checked for the requested deployment
    // turning `FAILED`, which aborts the waiter (no extra AWS call). Without
    // this, a breaker with `rollback: false` leaves the FAILED deployment in
    // place, which never stabilizes, and the wait would run to its cap.
    const client = this.getClient();
    const breakerVerdict = new AbortController();
    let failedRollout: Deployment | undefined;
    const watchedClient = {
      send: async (command: DescribeServicesCommand) => {
        const output = await client.send(command);
        if (failedRollout === undefined) {
          failedRollout = failedRequestedDeployment(requested, output?.services?.[0]?.deployments);
          if (failedRollout !== undefined) breakerVerdict.abort();
        }
        return output;
      },
    } as unknown as ECSClient;
    try {
      await waitUntilServicesStable(
        // minDelay/maxDelay override the AWS SDK defaults (15s / 120s) per the
        // #1177 poll-cap sweep.
        {
          client: watchedClient,
          maxWaitTime,
          minDelay: 5,
          maxDelay: 10,
          abortSignal: breakerVerdict.signal,
        },
        { cluster, services: [serviceRef] }
      );
    } catch (waiterError) {
      if (failedRollout !== undefined) {
        // `rolloutStateReason` is AWS-authored text: `debug` only
        // (go-to-k/cdkd#2319).
        log.debug(
          `ECS service ${logicalId} deployment ${failedRollout.id ?? '(no id)'} FAILED: ${failedRollout.rolloutStateReason ?? '(no rollout reason)'}`
        );
        throw wrapBreakerFailedError(failedRollout);
      }
      throw this.wrapWaiterResultError(waiterError, logicalId, log);
    }
    // The waiter can also RESOLVE on the very answer that showed the
    // requested deployment FAILED: a `rollback: false` breaker leaves it in
    // place, and once ECS's replacement tasks count as running,
    // `runningCount == desiredCount` with one deployment satisfies the
    // waiter. A FAILED ever seen is the verdict either way.
    if (failedRollout !== undefined) throw wrapBreakerFailedError(failedRollout);
    // waitUntilServicesStable's condition (a single deployment whose
    // runningCount matches desiredCount) is satisfied a few seconds BEFORE
    // ECS flips the PRIMARY deployment's rolloutState to COMPLETED — a race
    // the ecs-fargate fixture lost on the update path the moment #609
    // flipped its Service from the CC route (whose CFn handler waits for
    // rollout completion) to this SDK route. The default wait promises the
    // CloudFormation-equivalent doneness, so close the gap with a short
    // bounded poll; NONE (no rollout tracking, e.g. EXTERNAL controller)
    // counts as settled.
    const rolloutDeadline = Date.now() + 120_000;
    let settledDeployment: Deployment | undefined;
    for (;;) {
      const settled = await this.getClient().send(
        new DescribeServicesCommand({
          cluster,
          services: [serviceRef],
        })
      );
      const deployments = settled?.services?.[0]?.deployments;
      // FAILED here is the breaker's verdict, not a rollout still in
      // progress: it never turns COMPLETED.
      const failedNow = failedRequestedDeployment(requested, deployments);
      if (failedNow !== undefined) throw wrapBreakerFailedError(failedNow);
      settledDeployment = deployments && deployments.length === 1 ? deployments[0] : undefined;
      const rolloutState = settledDeployment?.rolloutState;
      if (settledDeployment !== undefined && rolloutState === 'FAILED') {
        throw wrapBreakerFailedError(settledDeployment);
      }
      if (rolloutState === undefined || rolloutState === 'COMPLETED') break;
      if (Date.now() >= rolloutDeadline) {
        log.warn(
          `ECS service ${logicalId} is steady but its rollout is still ${rolloutState} after the post-stability grace window; continuing`
        );
        break;
      }
      await settleRolloutDelays.sleep(3_000);
    }
    const supersededBy = rolloutSupersededBy(requested, settledDeployment);
    if (supersededBy !== undefined) {
      // `rolloutStateReason` is AWS-authored text: `debug` only
      // (go-to-k/cdkd#2319).
      log.debug(
        `ECS service ${logicalId} settled deployment ${settledDeployment?.id ?? '(no id)'}: ${settledDeployment?.rolloutStateReason ?? '(no rollout reason)'}`
      );
      throw new EcsCircuitBreakerVerdict(
        `its deployment circuit breaker rolled the rollout back: the service settled on ${supersededBy}, not on the deployment this update started (${describeRollout({ id: requested!.deploymentId, taskDefinition: requested!.taskDefinition })}). The new tasks failed to start or failed their health checks`
      );
    }
    log.debug(`ECS service ${logicalId} reached steady state`);
    return;
  }

  // `--no-wait`. Rendered through `pasteableAwsCommand` (issue #3136): the
  // cluster and the service name are TEMPLATE values, and the operation's
  // masker withholds a command naming a secret (issue #2177).
  const aws = pasteableAwsCommand(log.mask);
  const clusterArg = cluster ? aws` --cluster ${cluster}` : aws``;
  // INFO has no masked sink; the finished line goes through the same mask.
  this.logger.info(
    log.mask(
      `ECS service ${logicalIdShown(logicalId)} accepted (not waiting for steady state under --no-wait). ` +
        `To wait manually: ${aws`aws ecs wait services-stable${clusterArg} --services ${serviceRef}`.render()}`
    )
  );
}
