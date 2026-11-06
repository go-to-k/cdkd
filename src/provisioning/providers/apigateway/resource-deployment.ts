import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  CreateResourceCommand,
  DeleteResourceCommand,
  CreateDeploymentCommand,
  DeleteDeploymentCommand,
  UpdateDeploymentCommand,
  GetDeploymentsCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import type { CreateDeploymentCommandOutput } from '@aws-sdk/client-api-gateway';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { redactedDeleteAddressFields } from '../../redacted-delete-address.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { injectiveKey } from '../../../state/record-keys.js';
import { collectOrphanIds, reportPossibleOrphans } from '../orphan-report.js';
import {
  isInsideWindow,
  replayedSendWindow,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import { replacedDeleteFailureVerdict } from '../../../deployment/rollback-executor/replaced-survivor.js';
import {
  createDeploymentLatch,
  deploymentsCreatedByThisProcess,
  ORPHAN_LIST_PAGE_SIZE,
} from './shared.js';

// ─── AWS::ApiGateway::Resource ──────────────────────────────────────

/**
 * Create an API Gateway Resource (path part)
 */
export async function createResource(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway Resource ${logicalId}`);

  const restApiId = properties['RestApiId'] as string;
  const parentId = properties['ParentId'] as string;
  const pathPart = properties['PathPart'] as string;

  if (!restApiId || !parentId || !pathPart) {
    throw new ProvisioningError(
      `RestApiId, ParentId, and PathPart are required for API Gateway Resource ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    const response = await this.apiGatewayClient.send(
      new CreateResourceCommand({
        restApiId,
        parentId,
        pathPart,
      })
    );

    const resourceId = response.id!;
    log.debug(`Successfully created API Gateway Resource ${logicalId}: ${resourceId}`);

    return {
      physicalId: resourceId,
      attributes: {
        ResourceId: resourceId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway Resource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Update an API Gateway Resource
 *
 * API Gateway Resources are immutable - if PathPart changes,
 * the resource must be replaced (returns wasReplaced: true).
 */
export async function updateResource(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  log.debug(`Updating API Gateway Resource ${logicalId}: ${physicalId}`);

  const newPathPart = properties['PathPart'] as string;
  const oldPathPart = previousProperties['PathPart'] as string;

  // PathPart is immutable - if it changed, resource must be replaced
  if (newPathPart !== oldPathPart) {
    // Both path parts are bag values, masked RAW (issue #2177).
    log.debug(
      `PathPart changed from "${log.value(oldPathPart)}" to "${log.value(newPathPart)}", replacing resource`
    );

    // Create new resource
    const createResult = await this.createResource(logicalId, resourceType, properties, log);

    // Delete old resource. What it leaves behind rides out on the update's
    // `'partial'` outcome (issue #1819): the new resource already exists so
    // the replacement cannot be aborted, and a survivor here is not inert --
    // the OLD PathPart stays routable on the deployed API while cdkd's state
    // points only at the new one.
    let orphanReason: string | undefined;
    // go-to-k/cdkd#4911: what the failed delete proves about the old one.
    let oldResourceSurvivor: 'kept' | 'unconfirmed' = 'unconfirmed';
    try {
      // go-to-k/cdkd#3952: a redacted RestApiId would answer NotFound, which
      // `deleteResource` reads as "already deleted" -- report the survivor.
      if (redactedDeleteAddressFields({ RestApiId: previousProperties['RestApiId'] }).length > 0) {
        orphanReason = `old API Gateway Resource ${physicalId} was not deleted: its recorded RestApiId is redacted`;
        // Never sent: the old resource is whole.
        oldResourceSurvivor = 'kept';
        log.warn(
          safeMsg`Old API Gateway Resource ${physicalId} was not deleted during replacement: its ` +
            `recorded RestApiId is redacted in state, which names no API. The old resource ` +
            `may be orphaned and require manual cleanup.`
        );
      } else {
        // The update's masker, so the wrap's debug line of AWS's own text is
        // masked like the warning below (go-to-k/cdkd#2319).
        await this.deleteResource(logicalId, physicalId, resourceType, previousProperties, {
          maskSecrets: log.mask,
        });
      }
    } catch (error) {
      oldResourceSurvivor = replacedDeleteFailureVerdict(error);
      // The delete error is AWS text that can quote the recorded RestApiId
      // back; the reason rides out on the update's result, so it is masked
      // here too, not only in the warning (issue #2177).
      orphanReason = log.mask(
        `old API Gateway Resource ${physicalId} could not be deleted: ${safeStringify(error)}`
      );
      log.warn(
        `Failed to delete old API Gateway Resource ${physicalId} during replacement: ${safeStringify(error)}. ` +
          `The old resource may be orphaned and require manual cleanup.`
      );
    }

    const base = {
      physicalId: createResult.physicalId,
      wasReplaced: true as const,
      attributes: createResult.attributes ?? {},
    };
    return orphanReason !== undefined
      ? {
          ...base,
          outcome: 'partial' as const,
          reason: orphanReason,
          ...(oldResourceSurvivor === 'kept' && { oldResourceSurvivor }),
        }
      : base;
  }

  // No changes needed (RestApiId and ParentId changes also require replacement,
  // but the deployment engine handles those via immutable property detection)
  return {
    physicalId,
    wasReplaced: false,
    attributes: {
      ResourceId: physicalId,
    },
  };
}

/**
 * Delete an API Gateway Resource
 */
export async function deleteResource(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway Resource ${logicalId}: ${physicalId}`);

  const restApiId = properties?.['RestApiId'] as string | undefined;

  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to delete API Gateway Resource ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.apiGatewayClient.send(
      new DeleteResourceCommand({
        restApiId,
        resourceId: physicalId,
      })
    );

    this.logger.debug(`Successfully deleted API Gateway Resource ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.apiGatewayClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway Resource ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway Resource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, which the delete classifiers
    // read as "already deleted" on a `NotFound` needle: only the typed
    // not-found above means this one is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * Get API Gateway Resource attribute
 */
export function getResourceAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  // ResourceId is the most common attribute
  if (attributeName === 'ResourceId') {
    return Promise.resolve(physicalId);
  }

  return Promise.resolve(undefined);
}

// ─── AWS::ApiGateway::Deployment ───────────────────────────────────

/**
 * Create an API Gateway Deployment
 */
export async function createDeployment(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway Deployment ${logicalId}`);

  const restApiId = properties['RestApiId'] as string;

  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required for API Gateway Deployment ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    const description = properties['Description'] as string | undefined;
    // Issue #2080: after an earlier ambiguous attempt, name the deployment
    // it may have made before a second CreateDeployment is sent. Detection
    // only -- see `reportPossibleOrphans`.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await this.orphanCommandRegionArg(aws);
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'CreateDeployment',
        listAction: 'GetDeployments',
        subject: `a deployment of REST API ${log.value(restApiId)}${description !== undefined ? ` described ${log.value(description)}` : ''}`,
        noun: 'deployment(s)',
        list: () =>
          collectOrphanIds(
            async (position) => {
              const page = await this.apiGatewayClient.send(
                new GetDeploymentsCommand({
                  restApiId,
                  limit: ORPHAN_LIST_PAGE_SIZE,
                  ...(position && { position }),
                })
              );
              return { items: page.items ?? [], next: page.position };
            },
            (d) =>
              d.id &&
              (d.description ?? '') === (description ?? '') &&
              isInsideWindow(d.createdDate, lookupWindow) &&
              !deploymentsCreatedByThisProcess.has(injectiveKey(restApiId, d.id))
                ? d.id
                : undefined
          ),
        inspect: (id) =>
          aws`aws apigateway get-deployment --rest-api-id ${restApiId} --deployment-id ${id}${regionArg}`.render(),
        remove: (id) =>
          aws`aws apigateway delete-deployment --rest-api-id ${restApiId} --deployment-id ${id}${regionArg}`.render(),
      });
    };
    const orphanWindow = createDeploymentLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }
    const createClient = await this.getCreateClient();
    const attemptStartMs = Date.now();
    let response: CreateDeploymentCommandOutput;
    try {
      response = await createClient.send(new CreateDeploymentCommand({ restApiId, description }));
    } catch (error) {
      createDeploymentLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const deploymentId = response.id!;
    deploymentsCreatedByThisProcess.add(injectiveKey(restApiId, deploymentId));
    // Issue #4687: the SDK replayed this CreateDeployment inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }
    log.debug(`Successfully created API Gateway Deployment ${logicalId}: ${deploymentId}`);

    return {
      physicalId: deploymentId,
      attributes: {
        DeploymentId: deploymentId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway Deployment ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Update an API Gateway Deployment's `Description` in place with
 * `UpdateDeployment` (`replace /description`), as CloudFormation does
 * (go-to-k/cdkd#5391). `RestApiId` is create-only, so the deploy engine
 * replaces the deployment for that change before this method is called;
 * `Description` is the only other property this provider handles.
 *
 * A removed `Description` is sent as `''`, which clears it, and is also
 * what `readCurrentStateDeployment` reports for none, so a
 * `cdkd drift --revert` of a console-side description clears it.
 */
export async function updateDeployment(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  const restApiId = properties['RestApiId'] as string | undefined;
  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to update API Gateway Deployment ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // `''` and absent are the same on AWS (no description), and
  // `readCurrentStateDeployment` reports none as `''`, so they compare equal.
  const newDesc = properties['Description'];
  const prevDesc = previousProperties['Description'];
  if ((newDesc ?? '') === (prevDesc ?? '')) {
    log.debug(`No changes detected for API Gateway Deployment ${logicalId}`);
    return { physicalId, wasReplaced: false };
  }

  log.debug(`Updating API Gateway Deployment ${logicalId}: ${physicalId}`);
  try {
    await this.apiGatewayClient.send(
      new UpdateDeploymentCommand({
        restApiId,
        deploymentId: physicalId,
        patchOperations: [
          {
            op: 'replace',
            path: '/description',
            value: newDesc !== undefined ? stringifyValue(newDesc) : '',
          },
        ],
      })
    );
    log.debug(`Successfully updated API Gateway Deployment ${logicalId}`);
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway Deployment ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Delete an API Gateway Deployment
 */
export async function deleteDeployment(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway Deployment ${logicalId}: ${physicalId}`);

  const restApiId = properties?.['RestApiId'] as string | undefined;

  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to delete API Gateway Deployment ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.apiGatewayClient.send(
      new DeleteDeploymentCommand({
        restApiId,
        deploymentId: physicalId,
      })
    );

    this.logger.debug(`Successfully deleted API Gateway Deployment ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.apiGatewayClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway Deployment ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway Deployment ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, which the delete classifiers
    // read as "already deleted" on a `NotFound` needle: only the typed
    // not-found above means this one is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * Get API Gateway Deployment attribute
 */
export function getDeploymentAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'DeploymentId') {
    return Promise.resolve(physicalId);
  }

  return Promise.resolve(undefined);
}
