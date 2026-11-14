import {
  CreateRouteCommand,
  DeleteRouteCommand,
  GetRouteCommand,
  UpdateRouteCommand,
  NotFoundException,
  type AuthorizationType,
  type ParameterConstraints,
  type UpdateRouteCommandInput,
} from '@aws-sdk/client-apigatewayv2';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import { markNotGone } from '../../not-gone.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';

// ─── AWS::ApiGatewayV2::Route ─────────────────────────────────────
export async function createRoute(
  this: ApiGatewayV2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway V2 Route ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  const routeKey = properties['RouteKey'] as string;

  if (!apiId || !routeKey) {
    throw new ProvisioningError(
      `ApiId and RouteKey are required for API Gateway V2 Route ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    const response = await this.getClient().send(
      new CreateRouteCommand({
        ApiId: apiId,
        RouteKey: routeKey,
        Target: properties['Target'] as string | undefined,
        AuthorizationType: properties['AuthorizationType'] as AuthorizationType | undefined,
        AuthorizerId: properties['AuthorizerId'] as string | undefined,
        AuthorizationScopes: properties['AuthorizationScopes'] as string[] | undefined,
        OperationName: properties['OperationName'] as string | undefined,
        ApiKeyRequired: properties['ApiKeyRequired'] as boolean | undefined,
        ModelSelectionExpression: properties['ModelSelectionExpression'] as string | undefined,
        RequestModels: properties['RequestModels'] as Record<string, string> | undefined,
        RequestParameters: properties['RequestParameters'] as
          | Record<string, ParameterConstraints>
          | undefined,
        RouteResponseSelectionExpression: properties['RouteResponseSelectionExpression'] as
          | string
          | undefined,
      })
    );

    const routeId = response.RouteId!;
    log.debug(`Successfully created API Gateway V2 Route ${logicalId}: ${routeId}`);

    return {
      physicalId: routeId,
      attributes: {
        RouteId: routeId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway V2 Route ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteRoute(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway V2 Route ${logicalId}: ${physicalId}`);

  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to delete Route ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.getClient().send(new DeleteRouteCommand({ ApiId: apiId, RouteId: physicalId }));
    this.logger.debug(`Successfully deleted API Gateway V2 Route ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway V2 Route ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway V2 Route ${logicalId}: ${text}`,
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

export function getRouteAttribute(
  this: ApiGatewayV2Provider,
  physicalId: string,
  attributeName: string
): unknown {
  if (attributeName === 'RouteId') return physicalId;
  return undefined;
}

export async function readRoute(
  this: ApiGatewayV2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) return undefined;

  try {
    const resp = await this.getClient().send(
      new GetRouteCommand({ ApiId: apiId, RouteId: physicalId })
    );
    const result: Record<string, unknown> = { ApiId: apiId };
    if (resp.RouteKey !== undefined) result['RouteKey'] = resp.RouteKey;
    result['Target'] = resp.Target ?? '';

    // Class 2 — AuthorizationType empty placeholder. AWS uses `'NONE'`
    // (not `''`) as the no-auth sentinel; emitting `''` would have
    // `cdkd drift --revert` push an AWS-rejected value back. Map the
    // missing case to `'NONE'`, matching the AWS-documented default.
    result['AuthorizationType'] = resp.AuthorizationType ?? 'NONE';

    // Class 1 — AuthorizerId and AuthorizationScopes are meaningful
    // only when AuthorizationType is not NONE. Emitting empty
    // placeholders on a no-auth route would push AWS-rejected values
    // back through `--revert`.
    if (resp.AuthorizationType && resp.AuthorizationType !== 'NONE') {
      result['AuthorizerId'] = resp.AuthorizerId ?? '';
      result['AuthorizationScopes'] = resp.AuthorizationScopes ? [...resp.AuthorizationScopes] : [];
    }

    // OperationName is a free-form label valid on any route regardless
    // of AuthorizationType. Emit-when-present so a route that never set
    // it does not grow a phantom-drift key.
    if (resp.OperationName !== undefined) result['OperationName'] = resp.OperationName;
    // Issue #609 backfill, same emit-when-present convention as above.
    // `ApiKeyRequired` gets its AWS default (false) rather than being
    // omitted: it is a boolean whose absence AWS reads as false, so the
    // observed baseline always records it and `cdkd drift --revert` can
    // restore it either way.
    result['ApiKeyRequired'] = resp.ApiKeyRequired ?? false;
    if (resp.ModelSelectionExpression !== undefined) {
      result['ModelSelectionExpression'] = resp.ModelSelectionExpression;
    }
    if (resp.RequestModels !== undefined) result['RequestModels'] = resp.RequestModels;
    if (resp.RequestParameters !== undefined) {
      result['RequestParameters'] = resp.RequestParameters;
    }
    if (resp.RouteResponseSelectionExpression !== undefined) {
      result['RouteResponseSelectionExpression'] = resp.RouteResponseSelectionExpression;
    }
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * `UpdateRoute` keys on `(ApiId, RouteId)`. Mutable fields cdkd
 * manages: `RouteKey` / `Target` / `AuthorizationType` /
 * `AuthorizerId` / `AuthorizationScopes` / `OperationName` /
 * `ApiKeyRequired` / `RequestModels` / `RequestParameters` /
 * `ModelSelectionExpression` / `RouteResponseSelectionExpression`.
 */
export async function updateRoute(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  restoreFromAws = false
): Promise<ResourceUpdateResult> {
  const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to update Route ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  if (
    properties['ApiId'] !== undefined &&
    previousProperties['ApiId'] !== undefined &&
    properties['ApiId'] !== previousProperties['ApiId']
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `ApiId is immutable on AWS::ApiGatewayV2::Route; re-deploy with ${deployReplaceCommand()}`
    );
  }

  const input: UpdateRouteCommandInput = { ApiId: apiId, RouteId: physicalId };
  let changed = false;

  // RouteKey is required (a route cannot exist without a key), so it is never
  // removed. Target: CloudFormation KEEPS the live target when it is removed,
  // alone or beside another change (real CloudFormation A/B, #1160), so
  // removal sends nothing. Both pass through on change only.
  if (
    properties['RouteKey'] !== undefined &&
    properties['RouteKey'] !== previousProperties['RouteKey']
  ) {
    input.RouteKey = properties['RouteKey'] as string;
    changed = true;
  }
  if (properties['Target'] !== undefined && properties['Target'] !== previousProperties['Target']) {
    input.Target = properties['Target'] as string;
    changed = true;
  }
  // AuthorizationType: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['AuthorizationType'] !== undefined &&
    properties['AuthorizationType'] !== previousProperties['AuthorizationType']
  ) {
    input.AuthorizationType = properties['AuthorizationType'] as AuthorizationType;
    changed = true;
  }
  // AuthorizerId: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['AuthorizerId'] !== undefined &&
    properties['AuthorizerId'] !== previousProperties['AuthorizerId']
  ) {
    input.AuthorizerId = properties['AuthorizerId'] as string;
    changed = true;
  }
  // AuthorizationScopes: CloudFormation RESETS it on removal (real CloudFormation
  // A/B, #5004), so cdkd keeps the reset: clears on [] when removed.
  {
    const r = this.clearableUpdate(
      properties['AuthorizationScopes'] as string[] | undefined,
      previousProperties['AuthorizationScopes'] as string[] | undefined,
      []
    );
    if (r.changed) {
      input.AuthorizationScopes = r.value;
      changed = true;
    }
  }
  // OperationName: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['OperationName'] !== undefined &&
    properties['OperationName'] !== previousProperties['OperationName']
  ) {
    input.OperationName = properties['OperationName'] as string;
    changed = true;
  }
  // ApiKeyRequired: CloudFormation KEEPS the live value when it is removed,
  // alone or beside another change, and reads stay `true` for minutes (real
  // CloudFormation A/B on a WebSocket route, #5548), so removal sends nothing
  // and key enforcement stays on. `cdkd drift --revert` (`restoreFromAws`)
  // reverts to its baseline instead, resetting to false when that baseline
  // lacks the key.
  if (restoreFromAws) {
    const r = this.clearableUpdate(
      properties['ApiKeyRequired'] as boolean | undefined,
      previousProperties['ApiKeyRequired'] as boolean | undefined,
      false
    );
    if (r.changed) {
      input.ApiKeyRequired = r.value;
      changed = true;
    }
  } else if (
    properties['ApiKeyRequired'] !== undefined &&
    properties['ApiKeyRequired'] !== previousProperties['ApiKeyRequired']
  ) {
    input.ApiKeyRequired = properties['ApiKeyRequired'] as boolean;
    changed = true;
  }
  // RequestModels merges on the AWS side. On a deploy CloudFormation KEEPS a key
  // dropped from the template (real CloudFormation A/B, #5004), so a removed key
  // (or the whole block) sends nothing and stays live. `cdkd drift --revert`
  // (`restoreFromAws`) clears a dropped key with an empty-string value.
  if (restoreFromAws) {
    const merged = this.mapWithRemovals(
      properties['RequestModels'],
      previousProperties['RequestModels']
    );
    if (merged !== undefined) {
      input.RequestModels = merged;
      changed = true;
    }
  } else if (
    this.mapEntryAddedOrChanged(properties['RequestModels'], previousProperties['RequestModels'])
  ) {
    input.RequestModels = properties['RequestModels'] as Record<string, string>;
    changed = true;
  }
  // RequestParameters here is Record<string, ParameterConstraints>, merged by
  // UpdateRoute. On a deploy CloudFormation KEEPS a parameter dropped from the
  // template (real CloudFormation A/B, #5004), so a dropped key stays live.
  // `cdkd drift --revert` (`restoreFromAws`) removes it with the per-key
  // DeleteRouteRequestParameter, applied after the update below.
  if (
    restoreFromAws
      ? properties['RequestParameters'] !== undefined &&
        !this.deepEqual(properties['RequestParameters'], previousProperties['RequestParameters'])
      : this.mapEntryAddedOrChanged(
          properties['RequestParameters'],
          previousProperties['RequestParameters']
        )
  ) {
    input.RequestParameters = properties[
      'RequestParameters'
    ] as UpdateRouteCommandInput['RequestParameters'];
    changed = true;
  }
  const droppedRequestParameterKeys = restoreFromAws
    ? this.droppedKeys(properties['RequestParameters'], previousProperties['RequestParameters'])
    : [];
  // ModelSelectionExpression / RouteResponseSelectionExpression: CloudFormation
  // KEEPS the live value when they are removed, alone or beside another change
  // (real CloudFormation A/B on a WebSocket route, #1160), so removal sends
  // nothing. Pass through on change only.
  if (
    properties['ModelSelectionExpression'] !== undefined &&
    properties['ModelSelectionExpression'] !== previousProperties['ModelSelectionExpression']
  ) {
    input.ModelSelectionExpression = properties['ModelSelectionExpression'] as string;
    changed = true;
  }
  if (
    properties['RouteResponseSelectionExpression'] !== undefined &&
    properties['RouteResponseSelectionExpression'] !==
      previousProperties['RouteResponseSelectionExpression']
  ) {
    input.RouteResponseSelectionExpression = properties[
      'RouteResponseSelectionExpression'
    ] as string;
    changed = true;
  }

  if (!changed) {
    // The per-key parameter deletes are their own API calls, so a revert whose
    // ONLY change is dropping one still has work to do here.
    if (droppedRequestParameterKeys.length > 0) {
      try {
        await this.deleteRouteRequestParameters(apiId, physicalId, droppedRequestParameterKeys);
      } catch (error) {
        const cause = error instanceof Error ? error : undefined;
        throw this.wrapMaskedError(
          log,
          error,
          (text) =>
            new ProvisioningError(
              `Failed to update API Gateway V2 Route ${logicalId}: ${text}`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
      return { physicalId, wasReplaced: false };
    }
    log.debug(`No mutable Route fields changed for ${logicalId}; skipping UpdateRoute`);
    return { physicalId, wasReplaced: false };
  }

  log.debug(`Updating API Gateway V2 Route ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new UpdateRouteCommand(input));
    await this.deleteRouteRequestParameters(apiId, physicalId, droppedRequestParameterKeys);
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway V2 Route ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
