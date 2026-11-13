import {
  CreateIntegrationCommand,
  DeleteIntegrationCommand,
  GetIntegrationCommand,
  UpdateIntegrationCommand,
  GetIntegrationsCommand,
  NotFoundException,
  type CreateIntegrationCommandOutput,
  type IntegrationType,
  type ConnectionType,
  type ContentHandlingStrategy,
  type PassthroughBehavior,
  type TlsConfigInput,
  type UpdateIntegrationCommandInput,
} from '@aws-sdk/client-apigatewayv2';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
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
  createIntegrationLatch,
  integrationsCreatedByThisProcess,
  ORPHAN_LIST_PAGE_SIZE,
} from './shared.js';

// ─── AWS::ApiGatewayV2::Integration ───────────────────────────────
export async function createIntegration(
  this: ApiGatewayV2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway V2 Integration ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  const integrationType = properties['IntegrationType'] as string;

  if (!apiId || !integrationType) {
    throw new ProvisioningError(
      `ApiId and IntegrationType are required for API Gateway V2 Integration ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  this.warnTlsConfigIgnoredIfPublic(logicalId, properties, log);

  try {
    const integrationUri = properties['IntegrationUri'] as string | undefined;
    // Issue #2080: after an earlier ambiguous attempt, name the integration
    // it may have made before a second CreateIntegration is sent. Detection
    // only -- see `orphan-report.ts`.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await this.orphanCommandRegionArg(aws);
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'CreateIntegration',
        listAction: 'GetIntegrations',
        subject: `an integration of type ${log.value(integrationType)}${integrationUri !== undefined ? ` to ${log.value(integrationUri)}` : ''} in API ${log.value(apiId)}`,
        noun: 'integration(s)',
        list: () =>
          collectOrphanIds(
            async (token) => {
              const page = await this.getClient().send(
                new GetIntegrationsCommand({
                  ApiId: apiId,
                  MaxResults: ORPHAN_LIST_PAGE_SIZE,
                  ...(token && { NextToken: token }),
                })
              );
              return { items: page.Items ?? [], next: page.NextToken };
            },
            (i) =>
              i.IntegrationId &&
              i.IntegrationType === integrationType &&
              (i.IntegrationUri ?? '') === (integrationUri ?? '') &&
              !integrationsCreatedByThisProcess.has(injectiveKey(apiId, i.IntegrationId))
                ? i.IntegrationId
                : undefined
          ),
        inspect: (id) =>
          aws`aws apigatewayv2 get-integration --api-id ${apiId} --integration-id ${id}${regionArg}`.render(),
      });
    };
    const orphanWindow = createIntegrationLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }
    const attemptStartMs = Date.now();
    let response: CreateIntegrationCommandOutput;
    try {
      response = await this.getCreateClient().send(
        new CreateIntegrationCommand({
          ApiId: apiId,
          IntegrationType: integrationType as IntegrationType,
          IntegrationUri: integrationUri,
          IntegrationMethod: properties['IntegrationMethod'] as string | undefined,
          PayloadFormatVersion: properties['PayloadFormatVersion'] as string | undefined,
          TimeoutInMillis: properties['TimeoutInMillis'] as number | undefined,
          RequestParameters: properties['RequestParameters'] as Record<string, string> | undefined,
          Description: properties['Description'] as string | undefined,
          ConnectionId: properties['ConnectionId'] as string | undefined,
          ConnectionType: properties['ConnectionType'] as ConnectionType | undefined,
          ContentHandlingStrategy: properties['ContentHandlingStrategy'] as
            | ContentHandlingStrategy
            | undefined,
          CredentialsArn: properties['CredentialsArn'] as string | undefined,
          IntegrationSubtype: properties['IntegrationSubtype'] as string | undefined,
          PassthroughBehavior: properties['PassthroughBehavior'] as PassthroughBehavior | undefined,
          RequestTemplates: properties['RequestTemplates'] as Record<string, string> | undefined,
          ResponseParameters: this.toSdkResponseParameters(properties['ResponseParameters'], log),
          TemplateSelectionExpression: properties['TemplateSelectionExpression'] as
            | string
            | undefined,
          TlsConfig: properties['TlsConfig'] as TlsConfigInput | undefined,
        })
      );
    } catch (error) {
      createIntegrationLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const integrationId = response.IntegrationId!;
    integrationsCreatedByThisProcess.add(injectiveKey(apiId, integrationId));
    // Issue #4687: the SDK replayed this CreateIntegration inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }
    log.debug(`Successfully created API Gateway V2 Integration ${logicalId}: ${integrationId}`);

    return {
      physicalId: integrationId,
      attributes: {
        IntegrationId: integrationId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway V2 Integration ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteIntegration(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway V2 Integration ${logicalId}: ${physicalId}`);

  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to delete Integration ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.getClient().send(
      new DeleteIntegrationCommand({ ApiId: apiId, IntegrationId: physicalId })
    );
    this.logger.debug(`Successfully deleted API Gateway V2 Integration ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        `API Gateway V2 Integration ${physicalId} does not exist, skipping deletion`
      );
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway V2 Integration ${logicalId}: ${text}`,
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

export function getIntegrationAttribute(
  this: ApiGatewayV2Provider,
  physicalId: string,
  attributeName: string
): unknown {
  if (attributeName === 'IntegrationId') return physicalId;
  return undefined;
}

export async function readIntegration(
  this: ApiGatewayV2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) return undefined;

  try {
    const resp = await this.getClient().send(
      new GetIntegrationCommand({ ApiId: apiId, IntegrationId: physicalId })
    );
    const result: Record<string, unknown> = { ApiId: apiId };
    if (resp.IntegrationType !== undefined) result['IntegrationType'] = resp.IntegrationType;

    // Class 1 — IntegrationUri is meaningless on MOCK integrations.
    // AWS rejects an empty-string placeholder on MOCK with "Integration
    // URI is not supported for MOCK integrations". Only emit when the
    // discriminator (IntegrationType) requires a URI.
    const uriRequired =
      resp.IntegrationType === 'AWS' ||
      resp.IntegrationType === 'AWS_PROXY' ||
      resp.IntegrationType === 'HTTP' ||
      resp.IntegrationType === 'HTTP_PROXY';
    if (uriRequired) {
      result['IntegrationUri'] = resp.IntegrationUri ?? '';
    }

    result['IntegrationMethod'] = resp.IntegrationMethod ?? '';
    result['PayloadFormatVersion'] = resp.PayloadFormatVersion ?? '';

    // TimeoutInMillis / RequestParameters / Description are
    // user-controllable on CreateIntegration/UpdateIntegration — emit
    // when present (no default-when-absent, matching the provider's
    // convention). The drift comparator is state-keys-only, so
    // emit-when-present cannot cause phantom drift.
    if (resp.TimeoutInMillis !== undefined) result['TimeoutInMillis'] = resp.TimeoutInMillis;
    if (resp.RequestParameters !== undefined) {
      result['RequestParameters'] = resp.RequestParameters;
    }
    if (resp.Description !== undefined) result['Description'] = resp.Description;

    // Issue #609 backfill, same emit-when-present convention as above. These
    // reads are not optional extras: the write side now delivers each of
    // these properties, so a read side that stayed silent would leave every
    // one of them permanently un-comparable — and `ResponseParameters` would
    // additionally report phantom drift forever, because AWS returns the
    // FLAT SDK map while the cdkd baseline holds the CFn list-of-pairs.
    if (resp.ConnectionId !== undefined) result['ConnectionId'] = resp.ConnectionId;
    if (resp.ConnectionType !== undefined) result['ConnectionType'] = resp.ConnectionType;
    if (resp.ContentHandlingStrategy !== undefined) {
      result['ContentHandlingStrategy'] = resp.ContentHandlingStrategy;
    }
    if (resp.CredentialsArn !== undefined) result['CredentialsArn'] = resp.CredentialsArn;
    if (resp.IntegrationSubtype !== undefined) {
      result['IntegrationSubtype'] = resp.IntegrationSubtype;
    }
    if (resp.PassthroughBehavior !== undefined) {
      result['PassthroughBehavior'] = resp.PassthroughBehavior;
    }
    if (resp.RequestTemplates !== undefined) result['RequestTemplates'] = resp.RequestTemplates;
    if (resp.ResponseParameters !== undefined) {
      result['ResponseParameters'] = this.toCfnResponseParameters(
        resp.ResponseParameters,
        properties?.['ResponseParameters']
      );
    }
    if (resp.TemplateSelectionExpression !== undefined) {
      result['TemplateSelectionExpression'] = resp.TemplateSelectionExpression;
    }
    if (resp.TlsConfig !== undefined) result['TlsConfig'] = resp.TlsConfig;
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * `UpdateIntegration` keys on `(ApiId, IntegrationId)`. Mutable
 * fields cdkd manages: `IntegrationType` / `IntegrationUri` /
 * `IntegrationMethod` / `PayloadFormatVersion` / `TimeoutInMillis` /
 * `RequestParameters` / `Description`, plus the issue #609 backfill
 * (`ConnectionId` / `ConnectionType` / `ContentHandlingStrategy` /
 * `CredentialsArn` / `IntegrationSubtype` / `PassthroughBehavior` /
 * `RequestTemplates` / `ResponseParameters` / `TemplateSelectionExpression`
 * / `TlsConfig`).
 */
export async function updateIntegration(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  restoreFromAws = false,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to update Integration ${logicalId}`,
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
      `ApiId is immutable on AWS::ApiGatewayV2::Integration; re-deploy with ${deployReplaceCommand()}`
    );
  }

  const input: UpdateIntegrationCommandInput = { ApiId: apiId, IntegrationId: physicalId };
  let changed = false;

  if (
    properties['IntegrationType'] !== undefined &&
    properties['IntegrationType'] !== previousProperties['IntegrationType']
  ) {
    input.IntegrationType = properties['IntegrationType'] as IntegrationType;
    changed = true;
  }
  if (
    properties['IntegrationUri'] !== undefined &&
    properties['IntegrationUri'] !== previousProperties['IntegrationUri']
  ) {
    input.IntegrationUri = properties['IntegrationUri'] as string;
    changed = true;
  }
  if (
    properties['IntegrationMethod'] !== undefined &&
    properties['IntegrationMethod'] !== previousProperties['IntegrationMethod']
  ) {
    input.IntegrationMethod = properties['IntegrationMethod'] as string;
    changed = true;
  }
  if (
    properties['PayloadFormatVersion'] !== undefined &&
    properties['PayloadFormatVersion'] !== previousProperties['PayloadFormatVersion']
  ) {
    input.PayloadFormatVersion = properties['PayloadFormatVersion'] as string;
    changed = true;
  }
  if (
    properties['TimeoutInMillis'] !== undefined &&
    properties['TimeoutInMillis'] !== previousProperties['TimeoutInMillis']
  ) {
    input.TimeoutInMillis = properties['TimeoutInMillis'] as number;
    changed = true;
  }
  // IntegrationUri / IntegrationMethod / PayloadFormatVersion /
  // TimeoutInMillis above: CloudFormation KEEPS the live value when each is
  // removed, alone or beside another change (real CloudFormation A/B on
  // HTTP_PROXY, Lambda AWS_PROXY and WebSocket MOCK integrations, #1160), so
  // removal sends nothing. They pass through on change only.
  // RequestParameters merges per key on the AWS side. On a deploy CloudFormation
  // KEEPS a key that is dropped from the template (real CloudFormation A/B,
  // #5004), so a removed key (or the whole block) sends nothing and stays live.
  // `cdkd drift --revert` (`restoreFromAws`) clears a dropped key with an
  // empty-string value instead (live-probed #1160 — `{}` does NOT clear).
  if (restoreFromAws) {
    const merged = this.mapWithRemovals(
      properties['RequestParameters'],
      previousProperties['RequestParameters']
    );
    if (merged !== undefined) {
      input.RequestParameters = merged;
      changed = true;
    }
  } else if (
    this.mapEntryAddedOrChanged(
      properties['RequestParameters'],
      previousProperties['RequestParameters']
    )
  ) {
    input.RequestParameters = properties['RequestParameters'] as Record<string, string>;
    changed = true;
  }
  // Description: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['Description'] !== undefined &&
    properties['Description'] !== previousProperties['Description']
  ) {
    input.Description = properties['Description'] as string;
    changed = true;
  }

  // Issue #609 backfill — the ten properties below were previously DECLARED
  // nowhere and delivered nowhere, so a template using any of them lost it
  // silently. They pass through ON CHANGE ONLY.
  //
  // Removal: CloudFormation KEEPS the live value of ConnectionId /
  // ConnectionType (on a VPC_LINK integration), ContentHandlingStrategy,
  // CredentialsArn, PassthroughBehavior, RequestTemplates, ResponseParameters,
  // TemplateSelectionExpression and TlsConfig, alone or beside another change
  // (real CloudFormation A/B, #1160), so a removed one sends nothing.
  // IntegrationSubtype is the exception, handled below.
  if (
    properties['ConnectionId'] != null &&
    properties['ConnectionId'] !== previousProperties['ConnectionId']
  ) {
    input.ConnectionId = properties['ConnectionId'] as string;
    changed = true;
  }
  if (
    properties['ConnectionType'] != null &&
    properties['ConnectionType'] !== previousProperties['ConnectionType']
  ) {
    input.ConnectionType = properties['ConnectionType'] as ConnectionType;
    changed = true;
  }
  if (
    properties['ContentHandlingStrategy'] != null &&
    properties['ContentHandlingStrategy'] !== previousProperties['ContentHandlingStrategy']
  ) {
    input.ContentHandlingStrategy = properties[
      'ContentHandlingStrategy'
    ] as ContentHandlingStrategy;
    changed = true;
  }
  if (
    properties['CredentialsArn'] != null &&
    properties['CredentialsArn'] !== previousProperties['CredentialsArn']
  ) {
    input.CredentialsArn = properties['CredentialsArn'] as string;
    changed = true;
  }
  if (
    properties['IntegrationSubtype'] != null &&
    properties['IntegrationSubtype'] !== previousProperties['IntegrationSubtype']
  ) {
    input.IntegrationSubtype = properties['IntegrationSubtype'] as string;
    changed = true;
  }
  // ...and IntegrationSubtype is ALSO re-sent when it did NOT change, which
  // is the one place this provider's send-only-what-differs rule does not
  // hold. `IntegrationSubtype` is the DISCRIMINATOR that makes an AWS_PROXY
  // integration a service integration rather than a URI-based one, and
  // UpdateIntegration re-validates the whole shape against the patch: with
  // the subtype absent AWS reads the integration as URI-based and rejects
  // the call with `Invalid integration URI specified`.
  //
  // Live A/B, 2026-08-11 us-east-1, on an EventBridge-PutEvents integration
  // (found by the apigatewayv2-update-removal integ, not by the unit tests —
  // a mocked client agrees with either shape):
  //   RequestParameters alone                  -> BadRequestException
  //   RequestParameters + IntegrationSubtype   -> OK
  //
  // The PREVIOUS side is the fallback because the constraint is about the
  // LIVE integration, which stays a service integration while nothing turns it
  // into a URI-based one.
  //
  // A REMOVED IntegrationSubtype follows CloudFormation (real CloudFormation
  // A/B, #1160): removed alone or beside another change, its update FAILS with
  // `Invalid integration URI specified`, and so does every UpdateIntegration
  // without the subtype on a service integration, even an empty one (direct
  // probe, same A/B). Removed in an update that also declares an
  // IntegrationUri, it succeeds and the integration becomes URI-based. So a
  // deploy refuses the first shape before any call, and for the second sends
  // the update WITHOUT the live subtype (and with the declared URI, even when
  // it equals the previous one). A rollback replay (`replayingState`) whose
  // record declares an IntegrationUri restores that URI-based shape the same
  // way; one whose record has no URI cannot be edited by the user, so it keeps
  // the live subtype and warns. `cdkd drift --revert` names no removed
  // property, so it keeps the fallback.
  const subtypeRemoved =
    context?.removedProperties !== undefined
      ? context.removedProperties.has('IntegrationSubtype')
      : previousProperties['IntegrationSubtype'] != null &&
        properties['IntegrationSubtype'] == null;
  // Set when a rollback replay keeps a subtype its state record omits: what
  // stays live is recorded, or the next deploy's previous side loses it and
  // a later update would send no subtype (AWS refuses that).
  let effectiveProperties: Record<string, unknown> | undefined;
  if (
    subtypeRemoved &&
    (context?.replayingState !== true || properties['IntegrationUri'] != null)
  ) {
    if (properties['IntegrationUri'] == null) {
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`${logicalId} (${resourceType}): the previous deploy recorded IntegrationSubtype and this template does not declare it. CloudFormation fails that update (AWS refuses a service integration without its subtype: Invalid integration URI specified). Keep IntegrationSubtype declared, or declare an IntegrationUri to turn this into a URI-based integration. The integration was not updated.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    input.IntegrationUri = properties['IntegrationUri'] as string;
    changed = true;
  } else if (subtypeRemoved) {
    // A rollback replay whose record has neither the subtype nor a URI. The
    // PREVIOUS bag is not proof the subtype is live: on the revert-failed arm
    // it is the FAILED attempt's bag, which never applied, and the context
    // does not tell the two arms apart. So AWS is asked: only a subtype the
    // integration really has is re-sent, recorded and warned about.
    let liveSubtype: string | undefined;
    try {
      liveSubtype = (
        await this.getClient().send(
          new GetIntegrationCommand({ ApiId: apiId, IntegrationId: physicalId })
        )
      ).IntegrationSubtype;
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to read API Gateway V2 Integration ${logicalId} before restoring it: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
    if (liveSubtype) {
      input.IntegrationSubtype = liveSubtype;
      effectiveProperties = { ...properties, IntegrationSubtype: liveSubtype };
      log.warn(
        safeMsg`${logicalId} (${resourceType}): the state being restored does not declare IntegrationSubtype; the rollback keeps the integration's current subtype, because AWS refuses a service integration without it.`
      );
    }
  } else if (input.IntegrationSubtype === undefined) {
    const liveSubtype =
      properties['IntegrationSubtype'] ?? previousProperties['IntegrationSubtype'];
    if (liveSubtype !== undefined) input.IntegrationSubtype = liveSubtype as string;
  }
  if (
    properties['PassthroughBehavior'] != null &&
    properties['PassthroughBehavior'] !== previousProperties['PassthroughBehavior']
  ) {
    input.PassthroughBehavior = properties['PassthroughBehavior'] as PassthroughBehavior;
    changed = true;
  }
  if (
    properties['RequestTemplates'] != null &&
    !this.deepEqual(properties['RequestTemplates'], previousProperties['RequestTemplates'])
  ) {
    input.RequestTemplates = properties['RequestTemplates'] as Record<string, string>;
    changed = true;
  }
  // ResponseParameters is COMPARED on the CFn side (the shape both the
  // template and cdkd state carry) and converted only on the way out, so a
  // no-op deploy does not re-send it.
  if (
    properties['ResponseParameters'] != null &&
    !this.deepEqual(properties['ResponseParameters'], previousProperties['ResponseParameters'])
  ) {
    input.ResponseParameters = this.toSdkResponseParameters(properties['ResponseParameters'], log);
    changed = true;
  }
  if (
    properties['TemplateSelectionExpression'] != null &&
    properties['TemplateSelectionExpression'] !== previousProperties['TemplateSelectionExpression']
  ) {
    input.TemplateSelectionExpression = properties['TemplateSelectionExpression'] as string;
    changed = true;
  }
  if (
    properties['TlsConfig'] != null &&
    !this.deepEqual(properties['TlsConfig'], previousProperties['TlsConfig'])
  ) {
    this.warnTlsConfigIgnoredIfPublic(logicalId, properties, log);
    input.TlsConfig = properties['TlsConfig'] as TlsConfigInput;
    changed = true;
  }
  if (changed && input.IntegrationSubtype !== undefined) {
    input.RequestParameters = this.serviceIntegrationParameters(
      logicalId,
      physicalId,
      resourceType,
      input.RequestParameters ??
        (properties['RequestParameters'] as Record<string, string> | undefined)
    );
  }

  if (!changed) {
    log.debug(`No mutable Integration fields changed for ${logicalId}; skipping UpdateIntegration`);
    return {
      physicalId,
      wasReplaced: false,
      ...(effectiveProperties && { effectiveProperties }),
    };
  }

  log.debug(`Updating API Gateway V2 Integration ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new UpdateIntegrationCommand(input));
    return {
      physicalId,
      wasReplaced: false,
      ...(effectiveProperties && { effectiveProperties }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway V2 Integration ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
