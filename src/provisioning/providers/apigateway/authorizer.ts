import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  CreateAuthorizerCommand,
  UpdateAuthorizerCommand,
  DeleteAuthorizerCommand,
  GetAuthorizersCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import type { CreateAuthorizerCommandOutput } from '@aws-sdk/client-api-gateway';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { injectiveKey } from '../../../state/record-keys.js';
import { collectOrphanIds, reportPossibleOrphans } from '../orphan-report.js';
import { replayedSendWindow, type AmbiguousCreateWindow } from '../ambiguous-create.js';
import {
  createAuthorizerLatch,
  authorizersCreatedByThisProcess,
  ORPHAN_LIST_PAGE_SIZE,
  listPatchOps,
} from './shared.js';

// ─── AWS::ApiGateway::Authorizer ────────────────────────────────────

/**
 * Create an API Gateway Authorizer
 *
 * Physical ID is the authorizer ID (not composite), so that Ref resolves
 * to the authorizer ID that API Gateway Methods expect for AuthorizerId.
 */
export async function createAuthorizer(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway Authorizer ${logicalId}`);

  const restApiId = properties['RestApiId'] as string;
  const name = properties['Name'] as string;
  const type = properties['Type'] as string;

  if (!restApiId || !name || !type) {
    throw new ProvisioningError(
      `RestApiId, Name, and Type are required for API Gateway Authorizer ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    const providerArns = properties['ProviderARNs'] as string[] | undefined;

    // Issue #2080: after an earlier ambiguous attempt, name the authorizer
    // it may have made before a second CreateAuthorizer is sent. Detection
    // only -- see `reportPossibleOrphans`.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await this.orphanCommandRegionArg(aws);
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'CreateAuthorizer',
        listAction: 'GetAuthorizers',
        subject: `an authorizer named ${log.value(name)} (type ${log.value(type)}) in REST API ${log.value(restApiId)}`,
        noun: 'authorizer(s)',
        list: () =>
          collectOrphanIds(
            async (position) => {
              const page = await this.apiGatewayClient.send(
                new GetAuthorizersCommand({
                  restApiId,
                  limit: ORPHAN_LIST_PAGE_SIZE,
                  ...(position && { position }),
                })
              );
              return { items: page.items ?? [], next: page.position };
            },
            (a) =>
              a.id &&
              a.name === name &&
              a.type === type &&
              !authorizersCreatedByThisProcess.has(injectiveKey(restApiId, a.id))
                ? a.id
                : undefined
          ),
        inspect: (id) =>
          aws`aws apigateway get-authorizer --rest-api-id ${restApiId} --authorizer-id ${id}${regionArg}`.render(),
      });
    };
    const orphanWindow = createAuthorizerLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }
    const createClient = await this.getCreateClient();
    const attemptStartMs = Date.now();
    let response: CreateAuthorizerCommandOutput;
    try {
      response = await createClient.send(
        new CreateAuthorizerCommand({
          restApiId,
          name,
          type: type as 'TOKEN' | 'REQUEST' | 'COGNITO_USER_POOLS',
          authType: properties['AuthType'] as string | undefined,
          providerARNs: providerArns,
          authorizerUri: properties['AuthorizerUri'] as string | undefined,
          authorizerCredentials: properties['AuthorizerCredentials'] as string | undefined,
          identitySource: properties['IdentitySource'] as string | undefined,
          identityValidationExpression: properties['IdentityValidationExpression'] as
            | string
            | undefined,
          authorizerResultTtlInSeconds: properties['AuthorizerResultTtlInSeconds'] as
            | number
            | undefined,
        })
      );
    } catch (error) {
      createAuthorizerLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const authorizerId = response.id!;
    authorizersCreatedByThisProcess.add(injectiveKey(restApiId, authorizerId));
    // Issue #4687: the SDK replayed this CreateAuthorizer inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }
    log.debug(`Successfully created API Gateway Authorizer ${logicalId}: ${authorizerId}`);

    return {
      physicalId: authorizerId,
      attributes: {
        AuthorizerId: authorizerId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway Authorizer ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Update an API Gateway Authorizer via `UpdateAuthorizerCommand` (RFC 6902
 * JSON Patch operations).
 *
 * Mutable fields (per AWS API Gateway PATCH operations docs):
 *   `/name`, `/type`, `/authType`, `/authorizerUri`, `/authorizerCredentials`,
 *   `/identitySource`, `/identityValidationExpression`,
 *   `/authorizerResultTtlInSeconds`, `/providerARNs`.
 *
 * Only `RestApiId` is create-only (the deploy engine replaces the
 * authorizer for that change before this method is called). A `Type`
 * change is updated in place, as CloudFormation updates it
 * (go-to-k/cdkd#5391).
 *
 * The `gate on !== undefined` pattern (NOT truthy) is load-bearing for
 * `cdkd drift --revert`: an empty placeholder coming from
 * `readCurrentStateAuthorizer` (e.g. `IdentitySource: ''` on a Cognito
 * authorizer) MUST reach AWS as `replace /<field> ''` so a console-side
 * change away from "" is actually cleared on revert. A truthy gate would
 * silently drop the empty placeholder and the next drift run would
 * re-detect the same divergence forever.
 */
export async function updateAuthorizer(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  log.debug(`Updating API Gateway Authorizer ${logicalId}: ${physicalId}`);

  const restApiId = properties['RestApiId'] as string | undefined;
  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to update API Gateway Authorizer ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // ProviderARNs is a list API Gateway patches only element by element:
  // `replace /providerARNs` is refused (go-to-k/cdkd#5408). The adds go
  // FIRST and the removes LAST because AWS applies the operations in
  // order and refuses one that leaves a Cognito authorizer's list empty
  // ("The list of providerARNs cannot be empty"), so swapping the only
  // pool, and a TOKEN/REQUEST -> COGNITO_USER_POOLS switch, need the add
  // before the `/type` replace, while a COGNITO_USER_POOLS ->
  // TOKEN/REQUEST switch needs the remove after it.
  const arnOps = listPatchOps(
    '/providerARNs',
    properties['ProviderARNs'] as string[] | undefined,
    previousProperties['ProviderARNs'] as string[] | undefined
  );
  const patchOperations: Array<{
    op: 'replace' | 'add' | 'remove';
    path: string;
    value: string;
  }> = [...arnOps.adds];

  // Simple `replace` ops for primitive / single-value string fields.
  const primitiveFields: Array<{ key: string; path: string }> = [
    { key: 'Name', path: '/name' },
    { key: 'Type', path: '/type' },
    { key: 'AuthType', path: '/authType' },
    { key: 'AuthorizerUri', path: '/authorizerUri' },
    { key: 'AuthorizerCredentials', path: '/authorizerCredentials' },
    { key: 'IdentitySource', path: '/identitySource' },
    { key: 'IdentityValidationExpression', path: '/identityValidationExpression' },
    { key: 'AuthorizerResultTtlInSeconds', path: '/authorizerResultTtlInSeconds' },
  ];

  for (const { key, path } of primitiveFields) {
    const newVal = properties[key];
    const prevVal = previousProperties[key];
    if (newVal !== prevVal) {
      // A REMOVED AuthorizerUri is left on the authorizer, as
      // CloudFormation leaves it: a CFn A/B in us-east-1 kept the URI both
      // when the property was dropped from a TOKEN authorizer and on a
      // TOKEN -> COGNITO_USER_POOLS switch (go-to-k/cdkd#5408), and
      // API Gateway refuses an empty URI on a TOKEN / REQUEST authorizer
      // ("URI is a required field in an Authorizer"). An explicit `''`
      // (a `cdkd drift --revert` placeholder) still clears it.
      if (key === 'AuthorizerUri' && newVal === undefined) continue;
      // `!== undefined` gate (not truthy) — see method docstring.
      patchOperations.push({
        op: 'replace',
        path,
        value: newVal !== undefined ? stringifyValue(newVal) : '',
      });
    }
  }

  patchOperations.push(...arnOps.removes);

  if (patchOperations.length === 0) {
    log.debug(`No changes detected for API Gateway Authorizer ${logicalId}`);
    return { physicalId, wasReplaced: false };
  }

  try {
    // Not idempotent: should the SDK retry a call AWS already applied, a
    // repeated `add /providerARNs` appends a duplicate and a repeated
    // `remove` fails with "doesn't contain the value".
    await this.apiGatewayClient.send(
      new UpdateAuthorizerCommand({
        restApiId,
        authorizerId: physicalId,
        patchOperations,
      })
    );
    log.debug(
      `Successfully updated API Gateway Authorizer ${logicalId} (${patchOperations.length} patch ops)`
    );
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway Authorizer ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Delete an API Gateway Authorizer
 */
export async function deleteAuthorizer(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway Authorizer ${logicalId}: ${physicalId}`);

  const restApiId = properties?.['RestApiId'] as string | undefined;

  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to delete API Gateway Authorizer ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.apiGatewayClient.send(
      new DeleteAuthorizerCommand({
        restApiId,
        authorizerId: physicalId,
      })
    );

    this.logger.debug(`Successfully deleted API Gateway Authorizer ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.apiGatewayClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway Authorizer ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway Authorizer ${logicalId}: ${text}`,
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
 * Get API Gateway Authorizer attribute
 */
export function getAuthorizerAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'AuthorizerId') {
    return Promise.resolve(physicalId);
  }

  return Promise.resolve(undefined);
}
