import {
  CreateStageCommand,
  DeleteStageCommand,
  GetStageCommand,
  UpdateStageCommand,
  NotFoundException,
  type AccessLogSettings,
  type RouteSettings,
  type UpdateStageCommandInput,
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
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';
import { stageTagPath } from './shared.js';

// ─── AWS::ApiGatewayV2::Stage ─────────────────────────────────────
export async function createStage(
  this: ApiGatewayV2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway V2 Stage ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  const stageName = properties['StageName'] as string;

  if (!apiId || !stageName) {
    throw new ProvisioningError(
      `ApiId and StageName are required for API Gateway V2 Stage ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  // go-to-k/cdkd#5390: a malformed Tags is refused before any call.
  const tags = ApiGatewayV2Provider.desiredTags(properties['Tags'], resourceType, logicalId);

  try {
    await this.getClient().send(
      new CreateStageCommand({
        ApiId: apiId,
        StageName: stageName,
        AutoDeploy: properties['AutoDeploy'] as boolean | undefined,
        Description: properties['Description'] as string | undefined,
        StageVariables: properties['StageVariables'] as Record<string, string> | undefined,
        DefaultRouteSettings: properties['DefaultRouteSettings'] as RouteSettings | undefined,
        AccessLogSettings: properties['AccessLogSettings'] as AccessLogSettings | undefined,
        ClientCertificateId: properties['ClientCertificateId'] as string | undefined,
        DeploymentId: properties['DeploymentId'] as string | undefined,
        RouteSettings: properties['RouteSettings'] as Record<string, RouteSettings> | undefined,
        Tags: ApiGatewayV2Provider.tagRecord(tags),
      })
    );

    log.debug(`Successfully created API Gateway V2 Stage ${logicalId}: ${log.value(stageName)}`);

    return {
      physicalId: stageName,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway V2 Stage ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteStage(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway V2 Stage ${logicalId}: ${physicalId}`);

  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required to delete Stage ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.getClient().send(new DeleteStageCommand({ ApiId: apiId, StageName: physicalId }));
    this.logger.debug(`Successfully deleted API Gateway V2 Stage ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway V2 Stage ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway V2 Stage ${logicalId}: ${text}`,
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

export function getStageAttribute(
  this: ApiGatewayV2Provider,
  physicalId: string,
  attributeName: string
): unknown {
  if (attributeName === 'StageName') return physicalId;
  return undefined;
}

export async function readStage(
  this: ApiGatewayV2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const apiId = properties?.['ApiId'] as string | undefined;
  if (!apiId) return undefined;

  try {
    const resp = await this.getClient().send(
      new GetStageCommand({ ApiId: apiId, StageName: physicalId })
    );
    const result: Record<string, unknown> = { ApiId: apiId };
    if (resp.StageName !== undefined) result['StageName'] = resp.StageName;
    result['AutoDeploy'] = resp.AutoDeploy ?? false;
    result['Description'] = resp.Description ?? '';

    // StageVariables / DefaultRouteSettings are user-controllable on
    // CreateStage/UpdateStage — emit when present (no default-when-absent,
    // matching the provider's convention). The drift comparator is
    // state-keys-only, so emit-when-present cannot cause phantom drift.
    if (resp.StageVariables !== undefined) result['StageVariables'] = resp.StageVariables;
    if (resp.DefaultRouteSettings !== undefined) {
      result['DefaultRouteSettings'] = resp.DefaultRouteSettings;
    }
    // Issue #609 backfill. Same emit-when-present convention: the drift
    // comparator only descends into keys present in the recorded baseline,
    // so a stage that never set one of these cannot drift on it.
    if (resp.AccessLogSettings !== undefined) {
      result['AccessLogSettings'] = resp.AccessLogSettings;
    }
    if (resp.ClientCertificateId !== undefined) {
      result['ClientCertificateId'] = resp.ClientCertificateId;
    }
    // DeploymentId is emitted ONLY when the template declared it. Under
    // `AutoDeploy: true` AWS mints a NEW deployment id on every route /
    // integration change, so capturing it into the observed-properties drift
    // baseline reports permanent phantom drift on an untouched stack — and
    // `--revert` then pushes the stale id back through UpdateStage, rolling
    // the live stage back to an old deployment. The value is a non-empty
    // string, so `undeclaredEmptyObservedKeys` cannot skip it.
    if (properties?.['DeploymentId'] !== undefined && resp.DeploymentId !== undefined) {
      result['DeploymentId'] = resp.DeploymentId;
    }
    if (resp.RouteSettings !== undefined) result['RouteSettings'] = resp.RouteSettings;
    // Tags ride on GetStage as a map, the template's shape (go-to-k/cdkd#5390),
    // with a `{}` placeholder like readApi's; `aws:` keys are dropped.
    result['Tags'] = ApiGatewayV2Provider.observedTags(resp.Tags);
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * `UpdateStage` keys on `(ApiId, StageName)` — `StageName` is the
 * physicalId and immutable. Mutable fields cdkd manages:
 * `AutoDeploy` / `Description` / `StageVariables` /
 * `DefaultRouteSettings` / `AccessLogSettings` / `ClientCertificateId` /
 * `DeploymentId` / `RouteSettings`. `ApiId` is also immutable (a stage
 * cannot be moved between APIs). `AccessLogSettings` and per-key
 * `RouteSettings` can only be CLEARED through their dedicated delete APIs —
 * see {@link applyStageRemovals}.
 */
export async function updateStage(
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
      `ApiId is required to update Stage ${logicalId}`,
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
      `ApiId is immutable on AWS::ApiGatewayV2::Stage; re-deploy with ${deployReplaceCommand()}`
    );
  }
  // A `StageName` taken from a secret is recorded as its `{{resolve:...}}`
  // reference and handed here resolved, so the two sides never compare
  // equal: the physical id, which IS the stage name, decides instead
  // (go-to-k/cdkd#4264).
  if (
    properties['StageName'] !== undefined &&
    previousProperties['StageName'] !== undefined &&
    properties['StageName'] !== previousProperties['StageName'] &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'StageName',
      desired: properties['StageName'],
      previous: previousProperties['StageName'],
      physicalName: physicalId,
    }))
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `StageName is immutable on AWS::ApiGatewayV2::Stage; re-deploy with ${deployReplaceCommand()}`
    );
  }

  // Planned (and a malformed desired Tags refused) before any call.
  const tagDiff = this.planTags(
    properties,
    previousProperties,
    resourceType,
    logicalId,
    physicalId,
    log
  );

  const input: UpdateStageCommandInput = { ApiId: apiId, StageName: physicalId };
  let changed = false;

  // AutoDeploy: CloudFormation RESETS it to false on removal (real CloudFormation
  // A/B, #5004), so cdkd keeps the reset.
  {
    const r = this.clearableUpdate(
      properties['AutoDeploy'] as boolean | undefined,
      previousProperties['AutoDeploy'] as boolean | undefined,
      false
    );
    if (r.changed) {
      input.AutoDeploy = r.value;
      changed = true;
    }
  }
  // Description: CloudFormation KEEPS the live value when it is removed, alone
  // or beside another change (real CloudFormation A/B, #1160), so removal sends
  // nothing. (UpdateStage also ignores an empty-string reset, live-probed #1160.)
  if (
    properties['Description'] !== undefined &&
    properties['Description'] !== previousProperties['Description']
  ) {
    input.Description = properties['Description'] as string;
    changed = true;
  }
  // StageVariables merges on the AWS side. On a deploy CloudFormation KEEPS a
  // key that is dropped from the template (real CloudFormation A/B, #5004), so
  // a removed key (or the whole block) sends nothing and stays live. Only the
  // declared map is sent, and only when it changed. `cdkd drift --revert`
  // (`restoreFromAws`) is the opposite intent: it must remove a key added
  // out-of-band, so it clears each dropped key with an empty-string value.
  if (restoreFromAws) {
    const merged = this.mapWithRemovals(
      properties['StageVariables'],
      previousProperties['StageVariables']
    );
    if (merged !== undefined) {
      input.StageVariables = merged;
      changed = true;
    }
  } else if (
    this.mapEntryAddedOrChanged(properties['StageVariables'], previousProperties['StageVariables'])
  ) {
    input.StageVariables = properties['StageVariables'] as Record<string, string>;
    changed = true;
  }
  // DefaultRouteSettings: CloudFormation KEEPS the live block when it is
  // removed, alone or beside another change (real CloudFormation A/B, #1160),
  // so removal sends nothing. Pass through on change only.
  if (
    properties['DefaultRouteSettings'] !== undefined &&
    !this.deepEqual(properties['DefaultRouteSettings'], previousProperties['DefaultRouteSettings'])
  ) {
    input.DefaultRouteSettings = properties['DefaultRouteSettings'] as RouteSettings;
    changed = true;
  }
  // AccessLogSettings / RouteSettings are OBJECT-valued blocks UpdateStage
  // MERGES, so an omitted member is a no-op — live-probed 2026-08-11: a
  // stage keeps its AccessLogSettings verbatim through an UpdateStage that
  // omits it. Both therefore have DEDICATED delete APIs, handled out-of-band
  // below exactly like CorsConfiguration on ::Api. CloudFormation RESETS both on
  // removal (real CloudFormation A/B, #5004), so cdkd keeps the deletes.
  if (
    properties['AccessLogSettings'] !== undefined &&
    !this.deepEqual(properties['AccessLogSettings'], previousProperties['AccessLogSettings'])
  ) {
    input.AccessLogSettings = properties['AccessLogSettings'] as AccessLogSettings;
    changed = true;
  }
  const accessLogRemoved =
    properties['AccessLogSettings'] === undefined &&
    previousProperties['AccessLogSettings'] !== undefined;
  if (
    properties['RouteSettings'] !== undefined &&
    !this.deepEqual(properties['RouteSettings'], previousProperties['RouteSettings'])
  ) {
    input.RouteSettings = properties['RouteSettings'] as Record<string, RouteSettings>;
    changed = true;
  }
  // Per-ROUTE-KEY removal: the map merges, so a key dropped from the
  // template (or the whole block removed) survives unless it is deleted by
  // name. Live-probed 2026-08-11: DeleteRouteSettings clears exactly one key.
  const droppedRouteSettingKeys = this.droppedKeys(
    properties['RouteSettings'],
    previousProperties['RouteSettings']
  );
  // ClientCertificateId: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['ClientCertificateId'] !== undefined &&
    properties['ClientCertificateId'] !== previousProperties['ClientCertificateId']
  ) {
    input.ClientCertificateId = properties['ClientCertificateId'] as string;
    changed = true;
  }
  // DeploymentId points at a specific Deployment resource; it is only
  // meaningful while AutoDeploy is off, and there is no "no deployment"
  // sentinel — pass through on change only.
  if (
    properties['DeploymentId'] !== undefined &&
    properties['DeploymentId'] !== previousProperties['DeploymentId']
  ) {
    input.DeploymentId = properties['DeploymentId'] as string;
    changed = true;
  }

  if (!changed) {
    // The out-of-band removals are their own API calls, so a template whose
    // ONLY change is dropping one of them still has work to do here.
    if (accessLogRemoved || droppedRouteSettingKeys.length > 0 || tagDiff.changed) {
      try {
        await this.applyStageRemovals(apiId, physicalId, accessLogRemoved, droppedRouteSettingKeys);
        await this.applyTagDiff(stageTagPath(apiId, physicalId), tagDiff);
      } catch (error) {
        const cause = error instanceof Error ? error : undefined;
        throw this.wrapMaskedError(
          log,
          error,
          (text) =>
            new ProvisioningError(
              `Failed to update API Gateway V2 Stage ${logicalId}: ${text}`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
      return { physicalId, wasReplaced: false };
    }
    log.debug(`No mutable Stage fields changed for ${logicalId}; skipping UpdateStage`);
    return { physicalId, wasReplaced: false };
  }

  log.debug(`Updating API Gateway V2 Stage ${logicalId}: ${log.value(physicalId)}`);

  try {
    await this.getClient().send(new UpdateStageCommand(input));
    await this.applyStageRemovals(apiId, physicalId, accessLogRemoved, droppedRouteSettingKeys);
    await this.applyTagDiff(stageTagPath(apiId, physicalId), tagDiff);
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway V2 Stage ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
