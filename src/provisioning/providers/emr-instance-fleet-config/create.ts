import type { EMRInstanceFleetConfigProvider } from '../emr-instance-fleet-config-provider.js';
import {
  AddInstanceFleetCommand,
  ListInstanceFleetsCommand,
  type InstanceFleetConfig,
  type InstanceFleetType,
  type AddInstanceFleetCommandOutput,
} from '@aws-sdk/client-emr';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { toSdkInstanceTypeConfigs } from '../../emr-configuration.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { createMaskedLogSinks } from '../../masked-retry-logger.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from '../orphan-report.js';
import {
  isInsideWindow,
  replayedSendWindow,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { addInstanceFleetLatch, fleetsCreatedByThisProcess, toNumber } from './shared.js';

export async function create(
  this: EMRInstanceFleetConfigProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
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

  let createdFleetId: string | undefined;
  try {
    const fleet = this.toInstanceFleetConfig(properties);
    // Issue #2080: after an earlier ambiguous attempt, name the instance fleet
    // it may have added before a second AddInstanceFleet is sent. Detection
    // only -- see `orphan-report.ts`. Only a TASK instance fleet can
    // be duplicated: a cluster holds at most one MASTER and one CORE, so a
    // replay of either cannot add a second one.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await orphanCommandRegionArg(this.getClient(), aws);
      const name = fleet.Name;
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'AddInstanceFleet',
        service: 'EMR',
        listAction: 'ListInstanceFleets',
        subject: `a TASK instance fleet${name !== undefined ? ` named ${log.value(name)}` : ''} in cluster ${log.value(clusterId)}`,
        noun: 'TASK instance fleet(s)',
        list: () =>
          collectOrphanIds(
            async (marker) => {
              const page = await this.getClient().send(
                new ListInstanceFleetsCommand({
                  ClusterId: clusterId,
                  ...(marker && { Marker: marker }),
                })
              );
              return { items: page.InstanceFleets ?? [], next: page.Marker };
            },
            (item) =>
              item.Id &&
              item.InstanceFleetType === 'TASK' &&
              (name === undefined || item.Name === name) &&
              isInsideWindow(item.Status?.Timeline?.CreationDateTime, lookupWindow) &&
              !fleetsCreatedByThisProcess.has(item.Id)
                ? item.Id
                : undefined
          ),
        // No call reads one instance fleet by id: list the cluster's.
        inspect: () =>
          aws`aws emr list-instance-fleets --cluster-id ${clusterId}${regionArg}`.render(),
        remove: (id) =>
          aws`aws emr modify-instance-fleet --cluster-id ${clusterId} --instance-fleet InstanceFleetId=${id},TargetOnDemandCapacity=0,TargetSpotCapacity=0${regionArg}`.render(),
        removeVerb:
          'scale it to zero, which releases its instances (EMR has no call that removes an instance fleet; it ends with its cluster)',
      });
    };
    const orphanWindow = addInstanceFleetLatch.take(logicalId);
    if (orphanWindow !== undefined && fleet.InstanceFleetType === 'TASK') {
      await reportOrphans(orphanWindow);
    }
    const attemptStartMs = Date.now();
    let response: AddInstanceFleetCommandOutput;
    try {
      response = await this.getCreateClient().send(
        new AddInstanceFleetCommand({
          ClusterId: clusterId,
          InstanceFleet: fleet,
        })
      );
    } catch (error) {
      addInstanceFleetLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }
    const fleetId = response.InstanceFleetId;
    if (fleetId) fleetsCreatedByThisProcess.add(fleetId);
    // Before the lookup below, so a throw in it still marks the fleet created.
    createdFleetId = fleetId;
    reportCreatedResource(logicalId, resourceType, fleetId ?? ''); // go-to-k/cdkd#5511
    // Issue #4687: the SDK replayed this AddInstanceFleet inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined && fleet.InstanceFleetType === 'TASK') {
      await reportOrphans(replayWindow);
    }
    if (!fleetId) {
      throw new ProvisioningError(
        `EMR AddInstanceFleet for ${logicalId} returned no instance fleet id`,
        resourceType,
        logicalId
      );
    }

    // create always ramps capacity UP from 0, so the previous side is {0, 0}
    // and every dimension settles on `provisioned >= target`.
    await this.waitForFleetReady(
      clusterId,
      fleetId,
      logicalId,
      resourceType,
      this.targetCapacities(properties),
      { onDemand: 0, spot: 0 },
      false,
      context?.maskSecrets
    );

    this.logger.debug(`Successfully added EMR instance fleet ${logicalId}: ${fleetId}`);
    return { physicalId: fleetId, attributes: { Id: fleetId, InstanceFleetId: fleetId } };
  } catch (error) {
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            context?.maskSecrets,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to add EMR instance fleet ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#4583: the fleet exists once AddInstanceFleet returned its
    // id (the id delete() takes); name it for --revert-failed.
    if (createdFleetId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdFleetId);
      // go-to-k/cdkd#4945: terminal. A cluster holds one fleet per type, so a
      // replayed AddInstanceFleet can only collide with this one, and the
      // engine's retry would replace this error with that collision.
      markNonRetryable(thrown);
    }
    throw thrown;
  }
}

export function toInstanceFleetConfig(
  this: EMRInstanceFleetConfigProvider,
  properties: Record<string, unknown>
): InstanceFleetConfig {
  return {
    InstanceFleetType: properties['InstanceFleetType'] as InstanceFleetType,
    Name: properties['Name'] as string | undefined,
    TargetOnDemandCapacity: toNumber(properties['TargetOnDemandCapacity']),
    TargetSpotCapacity: toNumber(properties['TargetSpotCapacity']),
    InstanceTypeConfigs: toSdkInstanceTypeConfigs(properties['InstanceTypeConfigs']),
    LaunchSpecifications: properties['LaunchSpecifications'] as
      | import('@aws-sdk/client-emr').InstanceFleetProvisioningSpecifications
      | undefined,
    ResizeSpecifications: properties['ResizeSpecifications'] as
      | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
      | undefined,
  };
}
