import type { EMRInstanceFleetConfigProvider } from '../emr-instance-fleet-config-provider.js';
import { ModifyInstanceFleetCommand, InvalidRequestException } from '@aws-sdk/client-emr';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { isRedactedRecordedValue } from '../../redacted-delete-address.js';
import { safeMsg } from '../../../utils/display-safe.js';

export async function deleteImpl(
  this: EMRInstanceFleetConfigProvider,
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

  // go-to-k/cdkd#3952: a redacted ClusterId names no cluster. The scale-to-0
  // is best-effort either way (there is no delete API; the instances go when
  // the cluster terminates), so it is not attempted, and said so.
  if (fleetType === 'TASK' && clusterId && isRedactedRecordedValue(clusterId)) {
    this.logger.warn(
      safeMsg`EMR instance fleet ${logicalId}: ClusterId is redacted in state, so the ` +
        `best-effort scale-to-0 was not attempted — its instances are released when the ` +
        `parent cluster terminates`
    );
  } else if (fleetType === 'TASK' && clusterId) {
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
        const head = `Best-effort scale-to-0 of EMR instance fleet ${physicalId} failed: `;
        this.logger.warn(
          maskerOrIdentity(context?.maskSecrets)(
            `${head}${this.cleanupFailureText(head, error, context?.maskSecrets)} — its instances are released when the parent cluster terminates`
          )
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
