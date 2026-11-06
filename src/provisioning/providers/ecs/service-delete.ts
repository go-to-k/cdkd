import type { ECSProvider } from '../ecs-provider.js';
import {
  UpdateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type Tag,
} from '@aws-sdk/client-ecs';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markDeleteStarted } from '../../delete-started.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { logicalIdShown } from '../../composite-id.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { maskerOrIdentity, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import {
  isRedactedRecordedValue,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  clusterNameFromServiceArn,
  serviceInactiveWait,
  markNotGoneOnNotFoundClass,
} from './shared.js';

export async function deleteService(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting ECS service ${logicalId}: ${physicalId}`);
  const client = this.getClient();

  // go-to-k/cdkd#3952: a redacted Cluster names no cluster, and the
  // not-found arms below read a miss as "already deleted". The long-format
  // service ARN (the physicalId) carries the cluster name, so that is used
  // first; only a short-format ARN, which does not, leaves nothing to address.
  const recordedCluster = properties?.['Cluster'];
  let cluster: string | undefined;
  if (isRedactedRecordedValue(recordedCluster)) {
    cluster = clusterNameFromServiceArn(physicalId);
    if (cluster === undefined) {
      const skip = redactedDeleteAddressSkip(this.logger, logicalId, 'ECS service', ['Cluster']);
      if (skip) return skip;
    }
  } else {
    cluster = recordedCluster as string | undefined;
  }
  // go-to-k/cdkd#4946: set once the scale-down is accepted, so a refused
  // `DeleteService` is never read as a whole survivor.
  let stripped = false;
  // go-to-k/cdkd#5664: the scale-down found the service NOT ACTIVE (an
  // earlier attempt deleted it), so only the INACTIVE wait remains.
  let alreadyDeleted = false;

  try {
    // First scale down to 0
    try {
      await client.send(
        new UpdateServiceCommand({
          cluster,
          service: physicalId,
          desiredCount: 0,
        })
      );
      // A service its record already sets to 0 is what the record describes.
      const recordedCount = properties?.['DesiredCount'];
      stripped = !(recordedCount === 0 || recordedCount === '0');
      this.logger.debug(`Scaled down ECS service ${physicalId} to 0`);
    } catch (error) {
      // If service not found during scale down, it's already gone
      if (this.isServiceNotFoundException(error)) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `ECS service ${physicalId} not found during scale down, skipping deletion`
        );
        // go-to-k/cdkd#5664: NOT ACTIVE is not gone. A service an earlier
        // attempt already deleted is still DRAINING, and what depends on it
        // must not be deleted before it is INACTIVE: skip the delete and
        // fall through to the wait below (outside this try, so its failure
        // is not re-wrapped as a delete failure).
        if (!this.isServiceNotActiveException(error)) return;
        alreadyDeleted = true;
      } else {
        throw error;
      }
    }

    // Then force delete
    if (!alreadyDeleted) {
      await client.send(
        new DeleteServiceCommand({
          cluster,
          service: physicalId,
          force: true,
        })
      );
      this.logger.debug(`Successfully deleted ECS service ${logicalId}`);
    }
  } catch (error) {
    if (this.isServiceNotFoundException(error)) {
      const clientRegion = await client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`ECS service ${physicalId} not found, skipping deletion`);
      // NOT ACTIVE (#5664): already deleted and possibly still DRAINING,
      // so it falls through to the wait below instead of returning.
      if (!this.isServiceNotActiveException(error)) return;
    } else {
      const cause = error instanceof Error ? error : undefined;
      const wrapped = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete ECS service ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // A missing CLUSTER means the service is gone too, so it stays readable
      // as already deleted; any other `NotFound` class (a Service Connect
      // `NamespaceNotFoundException` from the scale-down UpdateService) is
      // not this service's.
      const failure = this.isClusterNotFoundException(error)
        ? wrapped
        : markNotGoneOnNotFoundClass(error, wrapped);
      throw stripped ? markDeleteStarted(failure) : failure;
    }
  }

  // go-to-k/cdkd#5664: DeleteService returns while the service is still
  // DRAINING. Wait for INACTIVE before reporting it deleted, as
  // CloudFormation does, so nothing that depends on it is deleted first.
  await this.waitForServiceInactive(logicalId, physicalId, cluster, resourceType);
}

/**
 * Wait for a deleted ECS service to reach `INACTIVE` (go-to-k/cdkd#5664).
 *
 * `DeleteService` (with `force`) returns while the service is still
 * `DRAINING`. CloudFormation waits for `INACTIVE` before it reports the
 * service deleted; cdkd returned at once, so a dependent's delete ran
 * against a live service. Measured: an `AWS::ECS::Gateway`'s cluster
 * association stayed `DISASSOCIATING` and the gateway delete was refused
 * ("Cannot delete gateway with active cluster associations") while the
 * service with a gateway connector drained; after `INACTIVE` (~42s for a
 * desiredCount-0 service) the disassociation and the gateway delete were
 * immediate. Every SDK-routed service waits, not only one with a connector:
 * a draining service also holds task ENIs, target-group registrations and
 * Cloud Map instances that its dependents' deletes run into, and waiting
 * is what CloudFormation does for every service.
 *
 * Like the other destroy waits (NAT gateway, Kinesis), this runs whatever
 * the deploy wait mode: `--no-wait` / `CDKD_NO_WAIT` is a deploy-time flag.
 * The cap is the create/update wait's: 600s, lifted (never lowered) by an
 * explicit `--resource-timeout`. Running out THROWS, marked delete-started
 * and non-retryable — a warning would let the destroy delete the
 * service's dependents against a still-draining service, which is the
 * defect this wait exists for, and a retry would re-run the same wait.
 * The service counts as gone once DescribeServices reports it `INACTIVE`,
 * reports it `MISSING`, or its cluster is gone.
 */
export async function waitForServiceInactive(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  cluster: string | undefined,
  resourceType: string
): Promise<void> {
  const client = this.getClient();
  const maxWaitSeconds = Math.max(
    600,
    (resolvedResourceTimeoutMs('AWS::ECS::Service') ?? 0) / 1000
  );
  const deadline = serviceInactiveWait.now() + maxWaitSeconds * 1000;
  let delay = 2_000;
  let lastStatus = 'unknown';
  for (;;) {
    try {
      const out = await client.send(
        new DescribeServicesCommand({ cluster, services: [physicalId] })
      );
      if ((out?.failures ?? []).some((failure) => failure.reason === 'MISSING')) return;
      const status = out?.services?.[0]?.status;
      if (status === 'INACTIVE') return;
      lastStatus = status ?? 'unknown';
    } catch (error) {
      if (this.isClusterNotFoundException(error)) return;
      // Anything else (a throttle, a denial) ends the wait as a failed
      // delete; the deploy engine's retry re-enters `deleteService`, whose
      // scale-down then sees the service NOT ACTIVE and comes back here.
      const readFailure = new ProvisioningError(
        `Failed to confirm ECS service ${logicalId} deletion: ${error instanceof Error ? error.name : 'unknown error'}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
      throw markDeleteStarted(readFailure);
    }
    if (serviceInactiveWait.now() >= deadline) {
      throw markNonRetryable(
        markDeleteStarted(
          new ProvisioningError(
            `ECS service ${logicalIdShown(logicalId)} was deleted but did not reach INACTIVE within ${maxWaitSeconds}s (last status: ${lastStatus}). Re-run once the service is INACTIVE, or raise the limit with --resource-timeout AWS::ECS::Service=${commandHole('duration')}.`,
            resourceType,
            logicalId,
            physicalId
          )
        )
      );
    }
    await serviceInactiveWait.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
}

export async function getServiceAttribute(
  this: ECSProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  const client = this.getClient();

  // physicalId is the service ARN (what createService stores). DescribeServices
  // scopes to the default cluster unless a cluster is given, so a Service in a
  // non-default cluster would come back MISSING; derive the cluster from the
  // ARN so the lookup is scoped correctly (issue #1170).
  const response = await client.send(
    new DescribeServicesCommand({
      cluster: clusterNameFromServiceArn(physicalId),
      services: [physicalId],
    })
  );
  const service = response.services?.[0];
  if (!service) return undefined;

  switch (attributeName) {
    case 'ServiceArn':
      return service.serviceArn;
    case 'Name':
      return service.serviceName;
    default:
      return undefined;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Apply a diff between old and new CFn-shape Tags arrays via ECS's
 * `TagResource` / `UntagResource` APIs. ECS uses lowercase camelCase
 * (`{ key, value }`) for tags. Resource ARN identifies the cluster /
 * service / task definition. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 *
 * `log` is the calling update's masked sink (issue #2177): the ARN embeds
 * the cluster or service name, which can be secret-derived.
 */
export async function applyTagDiff(
  this: ECSProvider,
  resourceArn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  log: MaskedLogSinks
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    log.warn(tagWarning);
  }
  const tagsToAdd: Tag[] = [...plan.set].map(([key, value]) => ({ key, value }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.getClient().send(new UntagResourceCommand({ resourceArn, tagKeys: tagsToRemove }));
    log.debug(`Removed ${tagsToRemove.length} tag(s) from ECS resource ${resourceArn}`);
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(new TagResourceCommand({ resourceArn, tags: tagsToAdd }));
    log.debug(`Added/updated ${tagsToAdd.length} tag(s) on ECS resource ${resourceArn}`);
  }
}
