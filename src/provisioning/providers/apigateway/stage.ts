import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  CreateStageCommand,
  UpdateStageCommand,
  DeleteStageCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import type { CacheClusterSize } from '@aws-sdk/client-api-gateway';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import {
  type CfnStageAccessLogSetting,
  type CfnStageCanarySetting,
  isPlainObjectBlock,
  normalizeAccessLogDestinationArn,
  toSdkCanarySettings,
  type CfnStageMethodSetting,
  buildMethodSettingsPatchOps,
} from './shared.js';

// ─── AWS::ApiGateway::Stage ──────────────────────────────────────

/**
 * Create an API Gateway Stage
 */
export async function createStage(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway Stage ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const restApiId = properties['RestApiId'] as string;
  const stageName = properties['StageName'] as string;
  const deploymentId = properties['DeploymentId'] as string;

  if (!restApiId || !stageName || !deploymentId) {
    throw new ProvisioningError(
      `RestApiId, StageName, and DeploymentId are required for API Gateway Stage ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // #1471/#1493 class: a present-but-malformed nested block (a string,
  // array, or unresolved intrinsic) indexes every sub-field to undefined,
  // which would silently create the stage WITHOUT the declared config.
  // Create is template-borne, so refuse loudly (the update path warns and
  // skips instead — see updateStage).
  for (const key of ['AccessLogSetting', 'CanarySetting'] as const) {
    const block = properties[key];
    if (block != null && !isPlainObjectBlock(block)) {
      throw new ProvisioningError(
        `AWS::ApiGateway::Stage ${key} for ${logicalId} must be an object block; got ${Array.isArray(block) ? 'an array' : typeof block}. Fix the template value instead of letting cdkd drop the config.`,
        resourceType,
        logicalId
      );
    }
  }

  // go-to-k/cdkd#4583: set when the post-create cleanup could not delete the
  // stage, which then exists with no state record.
  let stageLeftBehind = false;
  try {
    // CFn declares CacheClusterSize as a string enum ('0.5' | '1.6' | ...)
    // and so does the SDK, but an unquoted YAML template legitimately
    // carries the NUMBER 0.5 — stringify so both shapes reach AWS as the
    // enum string instead of being rejected by the serializer.
    const rawCacheClusterSize = properties['CacheClusterSize'] as string | number | undefined;
    await this.apiGatewayClient.send(
      new CreateStageCommand({
        restApiId,
        stageName,
        deploymentId,
        description: properties['Description'] as string | undefined,
        tracingEnabled: properties['TracingEnabled'] as boolean | undefined,
        variables: properties['Variables'] as Record<string, string> | undefined,
        tags:
          properties['Tags'] != null
            ? Object.fromEntries(desiredTags.map((t) => [t.Key, t.Value]))
            : undefined,
        cacheClusterEnabled: properties['CacheClusterEnabled'] as boolean | undefined,
        cacheClusterSize:
          rawCacheClusterSize != null
            ? (String(rawCacheClusterSize) as CacheClusterSize)
            : undefined,
        documentationVersion: properties['DocumentationVersion'] as string | undefined,
        canarySettings: toSdkCanarySettings(
          properties['CanarySetting'] as CfnStageCanarySetting | undefined
        ),
      })
    );
    // go-to-k/cdkd#5511: report before the post-create patch.
    reportCreatedResource(logicalId, resourceType, stageName);

    // MethodSettings (issue #966), AccessLogSetting and ClientCertificateId
    // (#609 backfill): CreateStage does not accept any of these — they are
    // applied via UpdateStage patch operations, merged into ONE post-create
    // UpdateStage call so the create-failure cleanup below covers them all.
    const methodSettings = properties['MethodSettings'] as CfnStageMethodSetting[] | undefined;
    const postCreateOps = buildMethodSettingsPatchOps(undefined, methodSettings);
    const accessLogSetting = properties['AccessLogSetting'] as CfnStageAccessLogSetting | undefined;
    if (accessLogSetting != null) {
      if (accessLogSetting.DestinationArn !== undefined) {
        postCreateOps.push({
          op: 'replace',
          path: '/accessLogSettings/destinationArn',
          value: normalizeAccessLogDestinationArn(String(accessLogSetting.DestinationArn)),
        });
      }
      if (accessLogSetting.Format !== undefined) {
        postCreateOps.push({
          op: 'replace',
          path: '/accessLogSettings/format',
          value: String(accessLogSetting.Format),
        });
      }
    }
    const clientCertificateId = properties['ClientCertificateId'] as string | undefined;
    if (clientCertificateId !== undefined) {
      postCreateOps.push({
        op: 'replace',
        path: '/clientCertificateId',
        value: clientCertificateId,
      });
    }
    if (postCreateOps.length > 0) {
      try {
        await this.apiGatewayClient.send(
          new UpdateStageCommand({
            restApiId,
            stageName,
            patchOperations: postCreateOps,
          })
        );
      } catch (patchError) {
        // The stage was already created but no state record will be
        // written — without cleanup the corpse holds the stage name and
        // every retry dies with ConflictException (same class as the
        // Cloud Control create-remnant fix, PR #957). Best-effort delete,
        // then rethrow the original failure.
        try {
          await this.apiGatewayClient.send(new DeleteStageCommand({ restApiId, stageName }));
          retractCreatedResource(logicalId, resourceType, stageName);
        } catch (cleanupError) {
          stageLeftBehind = true;
          // An AWS-authored failure is named by its class at warn, and AWS's
          // text (a denied `DeleteStage` names the caller) goes to `debug`
          // under the same head (go-to-k/cdkd#2319).
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up stage ${log.value(stageName)} after a post-create patch failure: `;
          if (cleanupFailure.redacted) log.debug(`${cleanupHead}${cleanupFailure.detail}`);
          log.warn(
            `${cleanupHead}${cleanupFailure.redacted ? cleanupFailure.summary : cleanupFailure.detail}`
          );
        }
        // The stage itself was created: an "already exists" from the patch is
        // not this stage's name collision (#3826).
        throw markAuxiliaryFailure(patchError, logicalId);
      }
    }

    log.debug(`Successfully created API Gateway Stage ${logicalId}: ${log.value(stageName)}`);

    return {
      physicalId: stageName,
      attributes: {
        StageName: stageName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway Stage ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (stageLeftBehind) markCreatedBeforeFailure(thrown, logicalId, resourceType, stageName);
    throw thrown;
  }
}

/**
 * Update an API Gateway Stage
 *
 * Uses UpdateStageCommand with patch operations for changed properties.
 */
export async function updateStage(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  log.debug(`Updating API Gateway Stage ${logicalId}: ${log.value(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  const restApiId = properties['RestApiId'] as string;

  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to update API Gateway Stage ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // Build patch operations for changed properties. UpdateStage supports
  // both `replace` (deploymentId / description / tracingEnabled, and
  // adding/replacing a single variables key) and `remove` (dropping a
  // variables key), so the patch op type covers both.
  const patchOperations: Array<{ op: 'replace' | 'remove'; path: string; value?: string }> = [];

  const deploymentId = properties['DeploymentId'] as string | undefined;
  const prevDeploymentId = previousProperties['DeploymentId'] as string | undefined;
  if (deploymentId && deploymentId !== prevDeploymentId) {
    patchOperations.push({ op: 'replace', path: '/deploymentId', value: deploymentId });
  }

  const description = properties['Description'] as string | undefined;
  const prevDescription = previousProperties['Description'] as string | undefined;
  if (description !== prevDescription) {
    patchOperations.push({
      op: 'replace',
      path: '/description',
      value: description ?? '',
    });
  }

  // TracingEnabled — X-Ray. UpdateStage renders the boolean as a string
  // value ('true' / 'false') under the `/tracingEnabled` path.
  const tracingEnabled = properties['TracingEnabled'] as boolean | undefined;
  const prevTracingEnabled = previousProperties['TracingEnabled'] as boolean | undefined;
  if (tracingEnabled !== prevTracingEnabled) {
    patchOperations.push({
      op: 'replace',
      path: '/tracingEnabled',
      value: String(tracingEnabled ?? false),
    });
  }

  // CacheClusterEnabled — response cache cluster (#609 backfill). Boolean
  // renders as a string 'true' / 'false' patch value (the /tracingEnabled
  // pattern). Removal semantics (#1160 class): the field dropped from the
  // template patches 'false' — the CFn default — instead of silently
  // keeping the live cache cluster running (and billing).
  const cacheClusterEnabled = properties['CacheClusterEnabled'] as boolean | undefined;
  const prevCacheClusterEnabled = previousProperties['CacheClusterEnabled'] as boolean | undefined;
  if (cacheClusterEnabled !== prevCacheClusterEnabled) {
    patchOperations.push({
      op: 'replace',
      path: '/cacheClusterEnabled',
      value: String(cacheClusterEnabled ?? false),
    });
  }

  // CacheClusterSize — only patched when PRESENT and changed (#609
  // backfill). Removal semantics (#1160 class): deliberately NOT cleared
  // on removal — the size is only meaningful while a cache cluster
  // exists, `/cacheClusterSize` accepts only valid enum values (no empty
  // clear), and dropping CacheClusterEnabled already tears the cluster
  // down, taking the size with it. Stringified because an unquoted YAML
  // template carries the NUMBER 0.5 for the CFn string enum '0.5'.
  const rawCacheClusterSize = properties['CacheClusterSize'] as string | number | undefined;
  const prevRawCacheClusterSize = previousProperties['CacheClusterSize'] as
    | string
    | number
    | undefined;
  if (
    rawCacheClusterSize != null &&
    (prevRawCacheClusterSize == null ||
      String(rawCacheClusterSize) !== String(prevRawCacheClusterSize))
  ) {
    patchOperations.push({
      op: 'replace',
      path: '/cacheClusterSize',
      value: String(rawCacheClusterSize),
    });
  }

  // ClientCertificateId — scalar (#609 backfill). Removal semantics
  // (#1160 class): the field dropped from the template patches '' —
  // UpdateStage supports `remove` only for map keys / whole nested
  // blocks, and API Gateway treats an empty-string replace as detaching
  // the certificate (the same scalar-clear pattern Account uses for
  // /cloudwatchRoleArn) — instead of silently keeping the live value.
  const clientCertificateId = properties['ClientCertificateId'] as string | undefined;
  const prevClientCertificateId = previousProperties['ClientCertificateId'] as string | undefined;
  if (clientCertificateId !== prevClientCertificateId) {
    patchOperations.push({
      op: 'replace',
      path: '/clientCertificateId',
      value: clientCertificateId ?? '',
    });
  }

  // DocumentationVersion — scalar (#609 backfill). Removal semantics
  // (#1160 class): the field dropped from the template patches '' (the
  // same scalar-clear-on-removal approach as ClientCertificateId above)
  // instead of silently keeping the live documentation version.
  const documentationVersion = properties['DocumentationVersion'] as string | undefined;
  const prevDocumentationVersion = previousProperties['DocumentationVersion'] as string | undefined;
  if (documentationVersion !== prevDocumentationVersion) {
    patchOperations.push({
      op: 'replace',
      path: '/documentationVersion',
      value: documentationVersion ?? '',
    });
  }

  // AccessLogSetting — nested {DestinationArn, Format} block applied via
  // field-level replace ops (#609 backfill). Removal semantics (#1160
  // class): the WHOLE block dropped from the template emits
  // `remove /accessLogSettings` — access logging is disabled, matching
  // CFn's absent-block behavior — instead of silently keeping the live
  // config. A sub-field dropped while the block remains is cleared with
  // an empty-string replace (the scalar-clear pattern above).
  // #1471/#1493 class guard (DESIRED side only — the previous side comes
  // from cdkd state): a present-but-malformed block would index every
  // sub-field to undefined and emit CLEAR patches, silently disabling a
  // live config from a broken template. On the update path we WARN and
  // SKIP the property (a rollback replays update() with a state record as
  // the desired bag, so a refusal would make the stage un-rollbackable;
  // emitting the remove op would be the very harm the guard exists for).
  const rawAccessLog = properties['AccessLogSetting'];
  const accessLogMalformed = rawAccessLog != null && !isPlainObjectBlock(rawAccessLog);
  if (accessLogMalformed) {
    log.warn(
      `AWS::ApiGateway::Stage AccessLogSetting for ${logicalId} is not an object block (got ${Array.isArray(rawAccessLog) ? 'an array' : typeof rawAccessLog}); leaving the live access-log config untouched.`
    );
  }
  const accessLog = accessLogMalformed
    ? undefined
    : (rawAccessLog as CfnStageAccessLogSetting | undefined);
  const prevAccessLog = previousProperties['AccessLogSetting'] as
    | CfnStageAccessLogSetting
    | undefined;
  if (accessLogMalformed) {
    // Skip both the patch and the removal arm for this property.
  } else if (accessLog == null) {
    if (prevAccessLog != null) {
      patchOperations.push({ op: 'remove', path: '/accessLogSettings' });
    }
  } else {
    if (accessLog.DestinationArn !== prevAccessLog?.DestinationArn) {
      patchOperations.push({
        op: 'replace',
        path: '/accessLogSettings/destinationArn',
        value:
          accessLog.DestinationArn !== undefined
            ? normalizeAccessLogDestinationArn(String(accessLog.DestinationArn))
            : '',
      });
    }
    if (accessLog.Format !== prevAccessLog?.Format) {
      patchOperations.push({
        op: 'replace',
        path: '/accessLogSettings/format',
        value: accessLog.Format !== undefined ? String(accessLog.Format) : '',
      });
    }
  }

  // CanarySetting — nested canary release block (#609 backfill). Removal
  // semantics (#1160 class): the WHOLE block dropped from the template
  // emits `remove /canarySettings` — the canary is torn down, matching
  // CFn's absent-block behavior — instead of silently leaving a live
  // canary diverting traffic. Sub-field changes patch the individual
  // /canarySettings/* paths; a scalar sub-field dropped while the block
  // remains reverts to its CFn/API default (0 / '' / false).
  // Same #1471/#1493 guard as AccessLogSetting above: warn and skip a
  // present-but-malformed desired block instead of emitting clear patches.
  const rawCanary = properties['CanarySetting'];
  const canaryMalformed = rawCanary != null && !isPlainObjectBlock(rawCanary);
  if (canaryMalformed) {
    log.warn(
      `AWS::ApiGateway::Stage CanarySetting for ${logicalId} is not an object block (got ${Array.isArray(rawCanary) ? 'an array' : typeof rawCanary}); leaving the live canary config untouched.`
    );
  }
  const canary = canaryMalformed ? undefined : (rawCanary as CfnStageCanarySetting | undefined);
  const prevCanary = previousProperties['CanarySetting'] as CfnStageCanarySetting | undefined;
  if (canaryMalformed) {
    // Skip both the patch and the removal arm for this property.
  } else if (canary == null) {
    if (prevCanary != null) {
      patchOperations.push({ op: 'remove', path: '/canarySettings' });
    }
  } else {
    if (canary.PercentTraffic !== prevCanary?.PercentTraffic) {
      patchOperations.push({
        op: 'replace',
        path: '/canarySettings/percentTraffic',
        value: String(canary.PercentTraffic ?? 0),
      });
    }
    if (canary.DeploymentId !== prevCanary?.DeploymentId) {
      patchOperations.push({
        op: 'replace',
        path: '/canarySettings/deploymentId',
        value: canary.DeploymentId ?? '',
      });
    }
    if (canary.UseStageCache !== prevCanary?.UseStageCache) {
      // Boolean renders as a string 'true' / 'false' patch value.
      patchOperations.push({
        op: 'replace',
        path: '/canarySettings/useStageCache',
        value: String(canary.UseStageCache ?? false),
      });
    }
    // StageVariableOverrides — per-key replace / remove, mirroring the
    // /variables/{key} pattern below. Removal semantics (#1160 class): a
    // key dropped from the map emits
    // `remove /canarySettings/stageVariableOverrides/{key}`.
    const overrides = canary.StageVariableOverrides ?? {};
    const prevOverrides = prevCanary?.StageVariableOverrides ?? {};
    for (const [key, value] of Object.entries(overrides)) {
      if (prevOverrides[key] !== value) {
        patchOperations.push({
          op: 'replace',
          path: `/canarySettings/stageVariableOverrides/${key}`,
          value,
        });
      }
    }
    for (const key of Object.keys(prevOverrides)) {
      // `Object.hasOwn`, not `in` (issue #2776's sweep): a key named
      // `constructor` / `toString` answers `in` through the prototype chain,
      // so dropping it from the template emitted no `remove` op.
      if (!Object.hasOwn(overrides, key)) {
        patchOperations.push({
          op: 'remove',
          path: `/canarySettings/stageVariableOverrides/${key}`,
        });
      }
    }
  }

  // Variables — stage variables map. UpdateStage takes one patch op per
  // key: `replace /variables/{key}` to add or change, `remove
  // /variables/{key}` to delete a key that is no longer declared.
  const variables = (properties['Variables'] as Record<string, string> | undefined) ?? {};
  const prevVariables =
    (previousProperties['Variables'] as Record<string, string> | undefined) ?? {};
  for (const [key, value] of Object.entries(variables)) {
    if (prevVariables[key] !== value) {
      patchOperations.push({ op: 'replace', path: `/variables/${key}`, value });
    }
  }
  for (const key of Object.keys(prevVariables)) {
    // `Object.hasOwn` for the reason given at the overrides twin above.
    if (!Object.hasOwn(variables, key)) {
      patchOperations.push({ op: 'remove', path: `/variables/${key}` });
    }
  }

  // MethodSettings (issue #966) — per-method-path overrides
  // (throttling / metrics / logging / caching) ride the same UpdateStage
  // call as field-level replace/remove ops; a whole entry dropped from the
  // template removes every override for that method path.
  patchOperations.push(
    ...buildMethodSettingsPatchOps(
      previousProperties['MethodSettings'] as CfnStageMethodSetting[] | undefined,
      properties['MethodSettings'] as CfnStageMethodSetting[] | undefined
    )
  );

  try {
    if (patchOperations.length > 0) {
      await this.apiGatewayClient.send(
        new UpdateStageCommand({
          restApiId,
          stageName: physicalId,
          patchOperations,
        })
      );
    }

    // Apply tag diff. API Gateway Stage tags require a constructed ARN:
    // arn:{partition}:apigateway:{region}::/restapis/{restApiId}/stages/{stageName}
    const stageArn = await this.buildStageArn(restApiId, physicalId);
    if (stageArn) {
      await this.applyTagDiff(
        stageArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        log,
        // Display-only (issue #2177): the RestApiId segment is a bag value,
        // masked RAW like the Method ids; the raw ARN still goes to AWS.
        stageArn.replace(`/restapis/${restApiId}/`, `/restapis/${log.value(restApiId)}/`)
      );
    }

    log.debug(`Successfully updated API Gateway Stage ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        StageName: physicalId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway Stage ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Delete an API Gateway Stage
 */
export async function deleteStage(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway Stage ${logicalId}: ${physicalId}`);

  const restApiId = properties?.['RestApiId'] as string | undefined;

  if (!restApiId) {
    throw new ProvisioningError(
      `RestApiId is required to delete API Gateway Stage ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.apiGatewayClient.send(
      new DeleteStageCommand({
        restApiId,
        stageName: physicalId,
      })
    );

    this.logger.debug(`Successfully deleted API Gateway Stage ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.apiGatewayClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway Stage ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway Stage ${logicalId}: ${text}`,
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
 * Get API Gateway Stage attribute
 */
export function getStageAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'StageName') {
    return Promise.resolve(physicalId);
  }

  return Promise.resolve(undefined);
}
