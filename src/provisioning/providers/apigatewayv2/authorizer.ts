import {
  CreateAuthorizerCommand,
  DeleteAuthorizerCommand,
  GetAuthorizerCommand,
  UpdateAuthorizerCommand,
  GetAuthorizersCommand,
  NotFoundException,
  type CreateAuthorizerCommandOutput,
  type AuthorizerType,
  type UpdateAuthorizerCommandInput,
} from '@aws-sdk/client-apigatewayv2';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { injectiveKey } from '../../../state/record-keys.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { collectOrphanIds, reportPossibleOrphans } from '../orphan-report.js';
import { replayedSendWindow, type AmbiguousCreateWindow } from '../ambiguous-create.js';
import type { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';
import {
  createAuthorizerLatch,
  authorizersCreatedByThisProcess,
  ORPHAN_LIST_PAGE_SIZE,
} from './shared.js';

// ─── AWS::ApiGatewayV2::Authorizer ────────────────────────────────
export async function createAuthorizer(
  this: ApiGatewayV2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway V2 Authorizer ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  const authorizerType = properties['AuthorizerType'] as string;
  const name = (properties['Name'] as string) || logicalId;

  if (!apiId || !authorizerType) {
    throw new ProvisioningError(
      `ApiId and AuthorizerType are required for API Gateway V2 Authorizer ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    // Issue #2080: after an earlier ambiguous attempt, name the authorizer
    // it may have made before a second CreateAuthorizer is sent. Detection
    // only -- see `orphan-report.ts`.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await this.orphanCommandRegionArg(aws);
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'CreateAuthorizer',
        listAction: 'GetAuthorizers',
        subject: `an authorizer named ${log.value(name)} (type ${log.value(authorizerType)}) in API ${log.value(apiId)}`,
        noun: 'authorizer(s)',
        list: () =>
          collectOrphanIds(
            async (token) => {
              const page = await this.getClient().send(
                new GetAuthorizersCommand({
                  ApiId: apiId,
                  MaxResults: ORPHAN_LIST_PAGE_SIZE,
                  ...(token && { NextToken: token }),
                })
              );
              return { items: page.Items ?? [], next: page.NextToken };
            },
            (a) =>
              a.AuthorizerId &&
              a.Name === name &&
              a.AuthorizerType === authorizerType &&
              !authorizersCreatedByThisProcess.has(injectiveKey(apiId, a.AuthorizerId))
                ? a.AuthorizerId
                : undefined
          ),
        inspect: (id) =>
          aws`aws apigatewayv2 get-authorizer --api-id ${apiId} --authorizer-id ${id}${regionArg}`.render(),
      });
    };
    const orphanWindow = createAuthorizerLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }
    const attemptStartMs = Date.now();
    let response: CreateAuthorizerCommandOutput;
    try {
      response = await this.getCreateClient().send(
        new CreateAuthorizerCommand({
          ApiId: apiId,
          AuthorizerType: authorizerType as AuthorizerType,
          Name: name,
          IdentitySource: (properties['IdentitySource'] as string | string[] | undefined)
            ? typeof properties['IdentitySource'] === 'string'
              ? [properties['IdentitySource']]
              : (properties['IdentitySource'] as string[])
            : undefined,
          JwtConfiguration: properties['JwtConfiguration'] as
            | { Audience?: string[]; Issuer?: string }
            | undefined,
          AuthorizerUri: properties['AuthorizerUri'] as string | undefined,
          // REQUEST-only create-time scalar (IAM role ARN API Gateway assumes
          // to invoke the REQUEST Lambda authorizer). AWS rejects it on JWT
          // authorizers and CDK only emits it for REQUEST; passing undefined
          // when absent is a no-op, so no AuthorizerType gate is needed here.
          AuthorizerCredentialsArn: properties['AuthorizerCredentialsArn'] as string | undefined,
          AuthorizerPayloadFormatVersion: properties['AuthorizerPayloadFormatVersion'] as
            | string
            | undefined,
          AuthorizerResultTtlInSeconds: properties['AuthorizerResultTtlInSeconds'] as
            | number
            | undefined,
          EnableSimpleResponses: properties['EnableSimpleResponses'] as boolean | undefined,
          IdentityValidationExpression: properties['IdentityValidationExpression'] as
            | string
            | undefined,
        })
      );
    } catch (error) {
      createAuthorizerLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const authorizerId = response.AuthorizerId!;
    authorizersCreatedByThisProcess.add(injectiveKey(apiId, authorizerId));
    // Issue #4687: the SDK replayed this CreateAuthorizer inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }
    log.debug(`Successfully created API Gateway V2 Authorizer ${logicalId}: ${authorizerId}`);

    return {
      physicalId: authorizerId,
      attributes: {
        AuthorizerId: authorizerId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway V2 Authorizer ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteAuthorizer(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway V2 Authorizer ${logicalId}: ${physicalId}`);

  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to delete Authorizer ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.getClient().send(
      new DeleteAuthorizerCommand({ ApiId: apiId, AuthorizerId: physicalId })
    );
    this.logger.debug(`Successfully deleted API Gateway V2 Authorizer ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        `API Gateway V2 Authorizer ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway V2 Authorizer ${logicalId}: ${text}`,
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

export async function readAuthorizer(
  this: ApiGatewayV2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) return undefined;

  try {
    const resp = await this.getClient().send(
      new GetAuthorizerCommand({ ApiId: apiId, AuthorizerId: physicalId })
    );
    const result: Record<string, unknown> = { ApiId: apiId };
    if (resp.AuthorizerType !== undefined) result['AuthorizerType'] = resp.AuthorizerType;
    result['Name'] = resp.Name ?? '';
    result['IdentitySource'] = resp.IdentitySource ? [...resp.IdentitySource] : [];

    // Class 1 — JwtConfiguration / AuthorizerUri / AuthorizerPayloadFormatVersion
    // are AuthorizerType-discriminated. JwtConfiguration is JWT-only;
    // AuthorizerUri / AuthorizerPayloadFormatVersion are REQUEST-only.
    // Emitting placeholders on the wrong type would have
    // `cdkd drift --revert` push AWS-rejected values back through
    // `UpdateAuthorizer` ("JwtConfiguration is only valid for JWT
    // authorizers" / "AuthorizerUri is only valid for REQUEST
    // authorizers"). Same pattern as the SNS FifoThroughputScope
    // guard.
    if (resp.AuthorizerType === 'JWT') {
      result['JwtConfiguration'] = resp.JwtConfiguration ?? {};
    } else if (resp.AuthorizerType === 'REQUEST') {
      result['AuthorizerUri'] = resp.AuthorizerUri ?? '';
      result['AuthorizerPayloadFormatVersion'] = resp.AuthorizerPayloadFormatVersion ?? '';

      // AuthorizerCredentialsArn / AuthorizerResultTtlInSeconds /
      // EnableSimpleResponses / IdentityValidationExpression are valid
      // only for REQUEST authorizers. Emit-when-present (gate each on
      // `!== undefined`) so a REQUEST authorizer that never set them
      // does not grow a phantom-drift key, and a JWT authorizer never
      // surfaces them at all.
      if (resp.AuthorizerCredentialsArn !== undefined)
        result['AuthorizerCredentialsArn'] = resp.AuthorizerCredentialsArn;
      if (resp.AuthorizerResultTtlInSeconds !== undefined)
        result['AuthorizerResultTtlInSeconds'] = resp.AuthorizerResultTtlInSeconds;
      if (resp.EnableSimpleResponses !== undefined)
        result['EnableSimpleResponses'] = resp.EnableSimpleResponses;
      if (resp.IdentityValidationExpression !== undefined)
        result['IdentityValidationExpression'] = resp.IdentityValidationExpression;
    }
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * `UpdateAuthorizer` keys on `(ApiId, AuthorizerId)`. Mutable fields
 * cdkd manages: `AuthorizerType` / `Name` / `IdentitySource` /
 * `JwtConfiguration` / `AuthorizerUri` / `AuthorizerCredentialsArn` /
 * `AuthorizerPayloadFormatVersion` / `AuthorizerResultTtlInSeconds` /
 * `EnableSimpleResponses`.
 */
export async function updateAuthorizer(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // A removed IdentitySource arrives as its `removalDefaults` clear value,
  // `[]` (the caller injects it; this covers a direct call).
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to update Authorizer ${logicalId}`,
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
      `ApiId is immutable on AWS::ApiGatewayV2::Authorizer; re-deploy with ${deployReplaceCommand()}`
    );
  }

  const input: UpdateAuthorizerCommandInput = { ApiId: apiId, AuthorizerId: physicalId };
  let changed = false;

  if (
    properties['AuthorizerType'] !== undefined &&
    properties['AuthorizerType'] !== previousProperties['AuthorizerType']
  ) {
    input.AuthorizerType = properties['AuthorizerType'] as AuthorizerType;
    changed = true;
  }
  if (properties['Name'] !== undefined && properties['Name'] !== previousProperties['Name']) {
    input.Name = properties['Name'] as string;
    changed = true;
  }
  // IdentitySource: CloudFormation CLEARS it on removal (real CloudFormation
  // A/B, #1160), so a removed one arrives here as its `removalDefaults` value,
  // `[]`, and is sent like any change. AWS then refuses it for a JWT
  // authorizer or a cached REQUEST one, as it does for CloudFormation.
  if (properties['IdentitySource'] !== undefined) {
    const next = Array.isArray(properties['IdentitySource'])
      ? (properties['IdentitySource'] as string[])
      : [properties['IdentitySource'] as string];
    const prev = Array.isArray(previousProperties['IdentitySource'])
      ? (previousProperties['IdentitySource'] as string[])
      : previousProperties['IdentitySource'] !== undefined
        ? [previousProperties['IdentitySource'] as string]
        : undefined;
    if (!this.deepEqual(next, prev)) {
      input.IdentitySource = next;
      changed = true;
    }
  }
  // JwtConfiguration: CloudFormation KEEPS the live value when it is removed,
  // alone or beside another change (real CloudFormation A/B, #1160), so
  // removal sends nothing. Pass through on change only.
  if (
    properties['JwtConfiguration'] !== undefined &&
    !this.deepEqual(properties['JwtConfiguration'], previousProperties['JwtConfiguration'])
  ) {
    input.JwtConfiguration = properties[
      'JwtConfiguration'
    ] as UpdateAuthorizerCommandInput['JwtConfiguration'];
    changed = true;
  }
  // AuthorizerUri: CloudFormation KEEPS the live value when it is removed,
  // alone or beside another change (real CloudFormation A/B on a REQUEST
  // authorizer, #1160), so removal sends nothing. Pass through on change only.
  if (
    properties['AuthorizerUri'] !== undefined &&
    properties['AuthorizerUri'] !== previousProperties['AuthorizerUri']
  ) {
    input.AuthorizerUri = properties['AuthorizerUri'] as string;
    changed = true;
  }
  // AuthorizerCredentialsArn: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['AuthorizerCredentialsArn'] !== undefined &&
    properties['AuthorizerCredentialsArn'] !== previousProperties['AuthorizerCredentialsArn']
  ) {
    input.AuthorizerCredentialsArn = properties['AuthorizerCredentialsArn'] as string;
    changed = true;
  }
  // AuthorizerPayloadFormatVersion: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['AuthorizerPayloadFormatVersion'] !== undefined &&
    properties['AuthorizerPayloadFormatVersion'] !==
      previousProperties['AuthorizerPayloadFormatVersion']
  ) {
    input.AuthorizerPayloadFormatVersion = properties['AuthorizerPayloadFormatVersion'] as string;
    changed = true;
  }
  // AuthorizerResultTtlInSeconds: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['AuthorizerResultTtlInSeconds'] !== undefined &&
    properties['AuthorizerResultTtlInSeconds'] !==
      previousProperties['AuthorizerResultTtlInSeconds']
  ) {
    input.AuthorizerResultTtlInSeconds = properties['AuthorizerResultTtlInSeconds'] as number;
    changed = true;
  }
  // EnableSimpleResponses: CloudFormation KEEPS the live value when it is
  // removed, alone or beside another change (real CloudFormation A/B, #1160),
  // so removal sends nothing. Pass through on change only.
  if (
    properties['EnableSimpleResponses'] !== undefined &&
    properties['EnableSimpleResponses'] !== previousProperties['EnableSimpleResponses']
  ) {
    input.EnableSimpleResponses = properties['EnableSimpleResponses'] as boolean;
    changed = true;
  }
  // IdentityValidationExpression: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['IdentityValidationExpression'] !== undefined &&
    properties['IdentityValidationExpression'] !==
      previousProperties['IdentityValidationExpression']
  ) {
    input.IdentityValidationExpression = properties['IdentityValidationExpression'] as string;
    changed = true;
  }

  if (!changed) {
    log.debug(`No mutable Authorizer fields changed for ${logicalId}; skipping UpdateAuthorizer`);
    return { physicalId, wasReplaced: false };
  }

  log.debug(`Updating API Gateway V2 Authorizer ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new UpdateAuthorizerCommand(input));
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway V2 Authorizer ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
