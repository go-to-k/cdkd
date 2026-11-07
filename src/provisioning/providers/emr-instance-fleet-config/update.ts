import type { EMRInstanceFleetConfigProvider } from '../emr-instance-fleet-config-provider.js';
import { ModifyInstanceFleetCommand, type InstanceFleetModifyConfig } from '@aws-sdk/client-emr';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { toSdkInstanceTypeConfigs } from '../../emr-configuration.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { LEFT_IN_PLACE_ON_REMOVAL, jsonEqual, leftInPlaceWarning, toNumber } from './shared.js';

export async function update(
  this: EMRInstanceFleetConfigProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const changed = (key: string): boolean => !jsonEqual(properties[key], previousProperties[key]);

  // Only the ModifyInstanceFleet surface is mutable on AWS. Every other
  // property is registry-createOnly (routed through DELETE+CREATE before
  // reaching here); a createOnly change that arrives anyway means the
  // replacement layer was bypassed — refuse it with a --replace pointer.
  // A secret-derived `Name` is recorded as its `{{resolve:...}}` reference
  // and handed here resolved, which is no change (go-to-k/cdkd#4275).
  const MUTABLE = new Set([
    'TargetOnDemandCapacity',
    'TargetSpotCapacity',
    'ResizeSpecifications',
    'InstanceTypeConfigs',
  ]);
  for (const key of Object.keys({ ...properties, ...previousProperties })) {
    if (!changed(key)) continue;
    if (
      !MUTABLE.has(key) &&
      // `ClusterId` ADDRESSES the calls below by its desired value, so a secret
      // rotated under an unchanged reference would reach another cluster:
      // never exempted.
      (key === 'ClusterId' ||
        !(await unchangedBehindSecretReference({
          resourceType,
          key,
          desired: properties[key],
          previous: previousProperties[key],
          maskSecrets: context?.maskSecrets,
        })))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS EMR InstanceFleetConfig ${key} is immutable on AWS — it is fixed when the instance fleet is created. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
      );
    }
  }

  // Issue #1160: a LEFT_IN_PLACE_ON_REMOVAL property removed from the
  // desired side has nothing to send — ModifyInstanceFleet keeps a field it
  // is not sent, and cdkd sends no reset, as CloudFormation leaves it
  // (LEFT_IN_PLACE_ON_REMOVAL). Counting it as a change only
  // issued a ModifyInstanceFleet (and a resize wait) changing nothing. Named
  // once, and only after the update SUCCEEDED (the shared caller's warning
  // has the same timing): a retried attempt would repeat it. Not on
  // `drift --revert`: its previous side is an AWS readback, so a key the
  // desired side lacks was never removed from a template.
  const removed = context?.removedProperties;
  const leftInPlaceNames = LEFT_IN_PLACE_ON_REMOVAL.filter((key) =>
    removed !== undefined
      ? removed.has(key)
      : properties[key] === undefined && previousProperties[key] !== undefined
  );
  const warnLeftInPlace = (): void => {
    if (leftInPlaceNames.length === 0 || context?.desiredFromAwsReadback) return;
    this.logger.warn(
      leftInPlaceWarning(
        logicalId,
        leftInPlaceNames,
        context?.replayingState ? 'rollback' : 'deploy'
      )
    );
  };
  const leftInPlace = new Set<string>(LEFT_IN_PLACE_ON_REMOVAL);
  const anyMutableChanged = [...MUTABLE].some(
    (k) => changed(k) && !(leftInPlace.has(k) && properties[k] === undefined)
  );
  if (!anyMutableChanged) {
    this.logger.debug(`No mutable diff for EMR instance fleet ${logicalId}, skipping update`);
    warnLeftInPlace();
    return {
      physicalId,
      wasReplaced: false,
      attributes: { Id: physicalId, InstanceFleetId: physicalId },
    };
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
      // BOTH capacities must be present, even when the template declares only
      // one. `AddInstanceFleet` tolerates an absent capacity (AWS defaults it
      // to 0), but `ModifyInstanceFleet` rejects the same payload with
      //   "The instance fleet (if-...) should have both
      //    targetOnDemandCapacity and targetSpotCapacity specified."
      // The AWS SDK v3 serializer omits `undefined` members, so forwarding the
      // template verbatim made EVERY resize of the ordinary
      // On-Demand-only / Spot-only fleet fail (found by the
      // `emr-instance-fleets` integ, issue #1400). Defaulting the absent side
      // to 0 also matches CFn desired-state semantics — an omitted capacity
      // means zero, not "leave whatever AWS has" — and matches this provider's
      // own `targetCapacity()` helper and its delete-path scale-to-0, which
      // already send both members explicitly.
      //
      // A template declaring NEITHER capacity while changing another mutable
      // field therefore scales the fleet to 0. That is the desired-state
      // reading (absent = zero) and is barely reachable — AWS requires at
      // least one capacity > 0 at create, so such a template could never have
      // produced this fleet — and it is only reachable for a TASK fleet at
      // all, since AWS refuses to scale MASTER/CORE to 0.
      TargetOnDemandCapacity: toNumber(properties['TargetOnDemandCapacity']) ?? 0,
      TargetSpotCapacity: toNumber(properties['TargetSpotCapacity']) ?? 0,
      ResizeSpecifications: properties['ResizeSpecifications'] as
        | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
        | undefined,
      InstanceTypeConfigs: toSdkInstanceTypeConfigs(properties['InstanceTypeConfigs']),
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
    // still ABOVE the new lower target). Direction is derived PER DIMENSION
    // from prev vs new target inside waitForFleetReady — a swap between
    // On-Demand and Spot at a constant total would make a summed check
    // vacuous (see its docstring).
    await this.waitForFleetReady(
      clusterId,
      physicalId,
      logicalId,
      resourceType,
      this.targetCapacities(properties),
      this.targetCapacities(previousProperties),
      // Resize path: tolerate a stale pre-modify failed state so a deploy
      // that RECOVERS a SUSPENDED fleet is not aborted by the read lag.
      // See waitForFleetReady's docstring.
      true,
      context?.maskSecrets
    );

    this.logger.debug(`Successfully updated EMR instance fleet ${logicalId}`);
    warnLeftInPlace();
    return {
      physicalId,
      wasReplaced: false,
      attributes: { Id: physicalId, InstanceFleetId: physicalId },
    };
  } catch (error) {
    if (error instanceof ProvisioningError || error instanceof ResourceUpdateNotSupportedError) {
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EMR instance fleet ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
