import type { EMRInstanceFleetConfigProvider } from '../emr-instance-fleet-config-provider.js';
import {
  ListInstanceFleetsCommand,
  type InstanceFleet,
  type InstanceFleetState,
} from '@aws-sdk/client-emr';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { FAILED_STATES, READY_STATES, toNumber } from './shared.js';

/**
 * Per-dimension target capacities.
 *
 * Deliberately NOT summed into a single total: the settle check must compare
 * EACH dimension against its own provisioned counterpart. A template that
 * swaps 2 Spot units for 2 On-Demand units leaves the TOTAL unchanged, so a
 * summed comparison is satisfied by the stale pre-resize reading on the very
 * first poll and the deploy reports success while EMR is still swapping
 * instances.
 */
export function targetCapacities(
  this: EMRInstanceFleetConfigProvider,
  properties: Record<string, unknown>
): {
  onDemand: number;
  spot: number;
} {
  return {
    onDemand: toNumber(properties['TargetOnDemandCapacity']) ?? 0,
    spot: toNumber(properties['TargetSpotCapacity']) ?? 0,
  };
}

/**
 * Poll until the fleet is `RUNNING` AND its provisioned capacity
 * (On-Demand + Spot) has settled at `targetCapacity`. The capacity check is
 * load-bearing on a resize: right after `ModifyInstanceFleet` the fleet is
 * still in the PRE-resize `RUNNING` state, so a State-only wait would return
 * before the resize even starts.
 *
 * Both dimensions are compared SEPARATELY against their own provisioned
 * counterpart, with their own direction derived from `previous` -> `target`:
 *  - scale-UP (`target >= previous`, and every create, whose `previous` is
 *    `{0, 0}`): ready when `provisioned >= target` (`>=`, not `==`, because a
 *    weighted-capacity allocation may overshoot).
 *  - scale-DOWN: ready when `provisioned <= target` — the stale pre-resize
 *    provisioned capacity is ABOVE the new lower target, so a `>=` check
 *    would return instantly before instances drain.
 *
 * Summing the two dimensions instead would make the check vacuous whenever a
 * template swaps capacity between them at a constant total (`{Spot: 2}` ->
 * `{OnDemand: 2}`): the summed target equals the summed previous, so the
 * direction reads as UP and the stale pre-resize sum satisfies it on the very
 * first poll, reporting success while EMR is still swapping instances. That
 * shape only became reachable once `update()` started sending both members
 * (it previously died at `ModifyInstanceFleet`), so the per-dimension
 * comparison ships with it.
 *
 * A target of 0 on the up path (never valid for a real create — at least one
 * target must be > 0) is trivially satisfied, degrading to a State-only wait.
 *
 * `toleratesStaleFailedState` MUST be true on the resize path and false on
 * create. It exists for the RECOVERY case: `SUSPENDED` (a resize that could
 * not complete) is precisely the state a user re-runs `cdkd deploy` to fix,
 * but the same pre-resize read lag documented above means the first poll
 * after `ModifyInstanceFleet` still reports `SUSPENDED`. Enforcing
 * {@link FAILED_STATES} on that stale read would abort the very resize that
 * recovers the fleet, on every attempt, making the state permanently
 * unrecoverable through cdkd.
 *
 * So on a resize the failed-state check is suppressed until the fleet is
 * observed LEAVING whatever state it started in; from then on it is enforced
 * normally (a resize that transitions RUNNING -> RESIZING -> SUSPENDED still
 * fails fast, which is the case #1092 item 2 is about). A fleet that never
 * leaves its initial state falls through to the `maxWaitMs` timeout — the
 * pre-fix behavior, and strictly better than an unrecoverable resource.
 *
 * Note the asymmetry that makes this specific to failed states: a stale
 * pre-resize `RUNNING` is harmless because the capacity check keeps the loop
 * polling. A stale `SUSPENDED` is terminal.
 */
export async function waitForFleetReady(
  this: EMRInstanceFleetConfigProvider,
  clusterId: string,
  fleetId: string,
  logicalId: string,
  resourceType: string,
  target: { onDemand: number; spot: number },
  previous: { onDemand: number; spot: number },
  toleratesStaleFailedState = false,
  mask?: MaskerFn
): Promise<void> {
  const startTime = Date.now();
  const transientState = { count: 0 };
  let initialState: InstanceFleetState | undefined;
  let hasLeftInitialState = false;

  const settled = (provisioned: number, want: number, had: number): boolean =>
    want >= had ? provisioned >= want : provisioned <= want;

  while (Date.now() - startTime < this.maxWaitMs) {
    const fleet = await this.findFleetForPoll(clusterId, fleetId, transientState);
    const state = fleet?.Status?.State;
    const onDemand = fleet?.ProvisionedOnDemandCapacity ?? 0;
    const spot = fleet?.ProvisionedSpotCapacity ?? 0;
    const provisioned = onDemand + spot;
    const capacityReady =
      settled(onDemand, target.onDemand, previous.onDemand) &&
      settled(spot, target.spot, previous.spot);

    if (state) {
      if (initialState === undefined) initialState = state;
      else if (state !== initialState) hasLeftInitialState = true;
    }

    if (state && READY_STATES.has(state) && capacityReady) return;

    const enforceFailedStates = !toleratesStaleFailedState || hasLeftInitialState;
    if (state && enforceFailedStates && FAILED_STATES.has(state)) {
      const reason = fleet?.Status?.StateChangeReason;
      throw this.wrapStatusReasonError(
        mask,
        { code: reason?.Code, message: reason?.Message },
        'no state-change reason reported',
        (text, cause) =>
          new ProvisioningError(
            `EMR instance fleet ${fleetId} entered failed state ${state}: ${text}`,
            resourceType,
            logicalId,
            fleetId,
            cause
          )
      );
    }

    if (state && !enforceFailedStates && FAILED_STATES.has(state)) {
      this.logger.debug(
        `EMR instance fleet ${fleetId} still reads ${state} from before the resize; ` +
          `waiting for it to leave that state before treating it as failed`
      );
    }

    this.logger.debug(
      `EMR instance fleet ${fleetId} state: ${state ?? 'unknown'}, provisioned ` +
        `${onDemand}/${target.onDemand} on-demand + ${spot}/${target.spot} spot ` +
        `(${provisioned} total), waiting...`
    );
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }

  throw new ProvisioningError(
    `Timed out waiting for EMR instance fleet ${fleetId} to reach RUNNING with capacity ` +
      `${target.onDemand} on-demand / ${target.spot} spot (${Math.round(this.maxWaitMs / 60000)} min)`,
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
export async function findFleetForPoll(
  this: EMRInstanceFleetConfigProvider,
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
        `Transient ListInstanceFleets error while polling ${fleetId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
      );
      return undefined;
    }
    throw error;
  }
}
