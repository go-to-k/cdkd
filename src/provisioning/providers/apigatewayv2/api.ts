import {
  CreateApiCommand,
  DeleteApiCommand,
  UpdateApiCommand,
  DeleteCorsConfigurationCommand,
  GetApiCommand,
  GetApisCommand,
  NotFoundException,
  type CreateApiCommandOutput,
  type ProtocolType,
  type IpAddressType,
  type UpdateApiCommandInput,
} from '@aws-sdk/client-apigatewayv2';
import {
  getAccountInfo,
  type AwsAccountInfo,
} from '../../../deployment/intrinsic-function-resolver.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  AccountIdUnavailableError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { collectOrphanIds, reportPossibleOrphans } from '../orphan-report.js';
import {
  isInsideWindow,
  replayedSendWindow,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';
import { createApiLatch, apisCreatedByThisProcess, ORPHAN_LIST_PAGE_SIZE } from './shared.js';

// ─── AWS::ApiGatewayV2::Api ───────────────────────────────────────
export async function createApi(
  this: ApiGatewayV2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway V2 Api ${logicalId}`);

  const name = properties['Name'] as string;
  const protocolType = properties['ProtocolType'] as string;

  if (!name || !protocolType) {
    throw new ProvisioningError(
      `Name and ProtocolType are required for API Gateway V2 Api ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  // go-to-k/cdkd#5390: a malformed Tags is refused before any call.
  const tags = ApiGatewayV2Provider.desiredTags(properties['Tags'], resourceType, logicalId);

  try {
    // Issue #2080: after an earlier ambiguous attempt, name the API it may
    // have made before a second CreateApi is sent. Detection only -- see
    // `orphan-report.ts`.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await this.orphanCommandRegionArg(aws);
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'CreateApi',
        listAction: 'GetApis',
        subject: `an API named ${log.value(name)} (protocol ${log.value(protocolType)})`,
        noun: 'API(s)',
        list: () =>
          collectOrphanIds(
            async (token) => {
              const page = await this.getClient().send(
                new GetApisCommand({
                  MaxResults: ORPHAN_LIST_PAGE_SIZE,
                  ...(token && { NextToken: token }),
                })
              );
              return { items: page.Items ?? [], next: page.NextToken };
            },
            (a) =>
              a.ApiId &&
              a.Name === name &&
              a.ProtocolType === protocolType &&
              isInsideWindow(a.CreatedDate, lookupWindow) &&
              !apisCreatedByThisProcess.has(a.ApiId)
                ? a.ApiId
                : undefined
          ),
        inspect: (id) => aws`aws apigatewayv2 get-api --api-id ${id}${regionArg}`.render(),
        remove: (id) => aws`aws apigatewayv2 delete-api --api-id ${id}${regionArg}`.render(),
      });
    };
    const orphanWindow = createApiLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }
    const attemptStartMs = Date.now();
    let response: CreateApiCommandOutput;
    try {
      response = await this.getCreateClient().send(
        new CreateApiCommand({
          Name: name,
          ProtocolType: protocolType as ProtocolType,
          Description: properties['Description'] as string | undefined,
          CorsConfiguration: properties['CorsConfiguration'] as
            | {
                AllowCredentials?: boolean;
                AllowHeaders?: string[];
                AllowMethods?: string[];
                AllowOrigins?: string[];
                ExposeHeaders?: string[];
                MaxAge?: number;
              }
            | undefined,
          DisableExecuteApiEndpoint: properties['DisableExecuteApiEndpoint'] as boolean | undefined,
          Version: properties['Version'] as string | undefined,
          RouteSelectionExpression: properties['RouteSelectionExpression'] as string | undefined,
          ApiKeySelectionExpression: properties['ApiKeySelectionExpression'] as string | undefined,
          IpAddressType: properties['IpAddressType'] as IpAddressType | undefined,
          Tags: ApiGatewayV2Provider.tagRecord(tags),
        })
      );
    } catch (error) {
      createApiLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const apiId = response.ApiId!;
    apisCreatedByThisProcess.add(apiId);
    // Issue #4687: the SDK replayed this CreateApi inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }
    const apiEndpoint = response.ApiEndpoint!;
    log.debug(`Successfully created API Gateway V2 Api ${logicalId}: ${apiId}`);

    // `ExecuteApiArn` is a read-only attribute AWS publishes on this type and
    // `CreateApi` does not return, so it is CONSTRUCTED — the shape
    // `SSMParameterProvider` established for the same problem (issue
    // [#1824](https://github.com/go-to-k/cdkd/issues/1824)). Recorded here
    // rather than resolved live because a cross-resource `Fn::GetAtt` reads
    // the CACHED `resource.attributes[<CFnName>]` and never calls
    // `getAttribute`; an absent `*Arn` reaches `guardedPhysicalIdFallback`,
    // which HARD-THROWS because the physical id is a bare api id (the issue
    // [#1179](https://github.com/go-to-k/cdkd/issues/1179) class).
    const executeApiArn = await this.buildExecuteApiArn(apiId, log);
    return {
      physicalId: apiId,
      attributes: {
        ApiId: apiId,
        ApiEndpoint: apiEndpoint,
        ...(executeApiArn !== undefined ? { ExecuteApiArn: executeApiArn } : {}),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway V2 Api ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteApi(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway V2 Api ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new DeleteApiCommand({ ApiId: physicalId }));
    this.logger.debug(`Successfully deleted API Gateway V2 Api ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway V2 Api ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway V2 Api ${logicalId}: ${text}`,
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
 * `arn:{partition}:execute-api:{region}:{account}:{apiId}` — the ARN AWS
 * documents for an API Gateway v2 API, which no API call returns.
 *
 * Records NOTHING when `getAccountInfo` cannot name the account (issue
 * #1730), exactly as `SSMParameterProvider.buildParameterArn` does: an ARN
 * naming the wrong account is worse than an absent one, because it is
 * persisted into `state.json` and outlives the deploy that produced it. The partition is
 * DERIVED through the same closed region mapping `${AWS::Partition}` uses,
 * and the region segment is canonicalized — defence in depth rather than the
 * only fold, since `getAccountInfo` already canonicalizes what it returns
 * (the issue #1795 / #1814 class: an unfolded `US-EAST-1` matches no IAM
 * policy and is persisted).
 *
 * **NEVER THROWS, and callers depend on it.** Every call site is INSIDE the
 * `try` of an operation that has already created or found the API, so an
 * escape here would report a failed create over a resource that exists —
 * an orphan. A failure means the attribute is absent, which is the state
 * every deploy before this change was in.
 *
 * Every interpolated value here is non-secret BY CONSTRUCTION — an
 * AWS-minted api id (or, on import, the CLI's own `--resource` argument), a
 * derived partition, a region, an account id — and the catch names the error
 * CLASS rather than its message. `SSMParameterProvider.buildParameterArn`
 * must mask because it interpolates `error.message`, which quotes a resolved
 * parameter value back. **Widening this catch to `error.message` therefore
 * requires masking it RAW in the same change** (`log.value`). `log` is the
 * calling `create()` / `update()`'s masked sink (issue #2177), so a warning
 * added here later is masked by construction; the import path has no
 * context and takes the identity default.
 */
export async function buildExecuteApiArn(
  this: ApiGatewayV2Provider,
  apiId: string,
  log: MaskedLogSinks = createMaskedLogSinks(this.logger, undefined)
): Promise<string | undefined> {
  try {
    // The region comes from the CLIENT that just issued the call, not from a
    // default: `getAccountInfo()` with no argument falls back to the ambient
    // `AWS_REGION`, which records an ARN for the wrong region whenever the
    // deploy targets another one.
    const region = await this.getClient().config.region();
    let accountInfo: AwsAccountInfo;
    try {
      accountInfo = await getAccountInfo(region);
    } catch (error) {
      // STS cannot name the account and `AWS_ACCOUNT_ID` is unset (issue
      // #1730). Its message is cdkd-authored and withholds AWS-authored STS
      // message text, so it is the warning's reason as written.
      if (!(error instanceof AccountIdUnavailableError)) throw error;
      log.warn(
        `The ExecuteApiArn attribute for API ${apiId} is NOT recorded: ${error.message} ` +
          `An Fn::GetAtt on it will fail until a later deploy records it.`
      );
      return undefined;
    }
    const { partition } = derivePartitionAndUrlSuffix(accountInfo.region);
    return `arn:${partition}:execute-api:${canonicalizeRegion(accountInfo.region)}:${accountInfo.accountId}:${apiId}`;
  } catch (error) {
    // WARNED, not swallowed. Silent, the only symptom is a later
    // `Fn::GetAtt ExecuteApiArn` hard-throwing from `guardedPhysicalIdFallback`
    // with a message naming the RESOLVER, and nothing in the deploy log
    // pointing at the create-time cause. The reachable throw is
    // `config.region()` rejecting.
    log.warn(
      `Could not build the ExecuteApiArn attribute for API ${apiId} ` +
        `(${error instanceof Error ? error.name : typeof error}), so it is NOT recorded. ` +
        `An Fn::GetAtt on it will fail until a later deploy records it.`
    );
    return undefined;
  }
}

export function getApiAttribute(
  this: ApiGatewayV2Provider,
  physicalId: string,
  attributeName: string
): unknown {
  if (attributeName === 'ApiId') return physicalId;
  // ApiEndpoint and ExecuteApiArn are stored in attributes at creation time.
  return undefined;
}

export async function readApi(
  this: ApiGatewayV2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  try {
    const resp = await this.getClient().send(new GetApiCommand({ ApiId: physicalId }));
    const result: Record<string, unknown> = {};
    result['Name'] = resp.Name ?? '';
    if (resp.ProtocolType !== undefined) result['ProtocolType'] = resp.ProtocolType;
    result['Description'] = resp.Description ?? '';

    // Class 1 — CorsConfiguration is HTTP-only. Emitting `{}` as a
    // placeholder on a WEBSOCKET API would have `cdkd drift --revert`
    // push the empty value back to AWS, which `UpdateApi` rejects with
    // "CORS configuration is only supported for HTTP APIs".
    // Same pattern as the SNS FifoThroughputScope guard.
    if (resp.ProtocolType === 'HTTP') {
      result['CorsConfiguration'] = resp.CorsConfiguration ?? {};
    }

    // Class 1 — RouteSelectionExpression is required (and meaningful)
    // only for WEBSOCKET. HTTP APIs default it to `$request.method
    // $request.path` server-side and the field is not user-controlled,
    // so emitting it on HTTP APIs would surface AWS-managed defaults
    // as drift.
    if (resp.ProtocolType === 'WEBSOCKET' && resp.RouteSelectionExpression !== undefined) {
      result['RouteSelectionExpression'] = resp.RouteSelectionExpression;
    }

    // Class 1 — ApiKeySelectionExpression is supported only for
    // WEBSOCKET APIs (AWS docs). Emitting it on an HTTP API would push
    // an AWS-rejected value back through `cdkd drift --revert`. Same
    // discriminator guard as RouteSelectionExpression above.
    if (resp.ProtocolType === 'WEBSOCKET' && resp.ApiKeySelectionExpression !== undefined) {
      result['ApiKeySelectionExpression'] = resp.ApiKeySelectionExpression;
    }

    // DisableExecuteApiEndpoint / Version / IpAddressType ride on both
    // protocols and are user-controllable on CreateApi/UpdateApi — emit
    // when present (no default-when-absent, matching the provider's
    // convention).
    if (resp.DisableExecuteApiEndpoint !== undefined) {
      result['DisableExecuteApiEndpoint'] = resp.DisableExecuteApiEndpoint;
    }
    if (resp.Version !== undefined) result['Version'] = resp.Version;
    if (resp.IpAddressType !== undefined) result['IpAddressType'] = resp.IpAddressType;

    // Tags from the same GetApi response, in the template's MAP shape
    // (`AWS::ApiGatewayV2::Api.Tags` is a key -> value map), so drift compares
    // like with like (go-to-k/cdkd#5390). `aws:` keys are dropped.
    result['Tags'] = ApiGatewayV2Provider.observedTags(resp.Tags);
    return result;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

// ─── Update implementations ───────────────────────────────────────

/**
 * `UpdateApi` accepts the full Update input shape (not JSON Patch).
 * Mutable fields cdkd manages: `Name` / `Description` /
 * `CorsConfiguration` / `DisableExecuteApiEndpoint` / `Version` /
 * `RouteSelectionExpression` / `ApiKeySelectionExpression` /
 * `IpAddressType`.
 * `ProtocolType` is immutable — the deploy engine handles changes via
 * the replacement path; we surface a `ResourceUpdateNotSupportedError`
 * if it ever reaches us anyway.
 */
export async function updateApi(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  if (
    properties['ProtocolType'] !== undefined &&
    previousProperties['ProtocolType'] !== undefined &&
    properties['ProtocolType'] !== previousProperties['ProtocolType']
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `ProtocolType is immutable on AWS::ApiGatewayV2::Api; re-deploy with ${deployReplaceCommand()}`
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

  const input: UpdateApiCommandInput = { ApiId: physicalId };
  let changed = false;

  // Name is required on AWS::ApiGatewayV2::Api, so it is never removed —
  // pass it through as a plain change (no reset value).
  if (properties['Name'] !== undefined && properties['Name'] !== previousProperties['Name']) {
    input.Name = properties['Name'] as string;
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
  // CorsConfiguration: CloudFormation RESETS it on removal (real CloudFormation
  // A/B, #5004), so cdkd keeps the reset. Set here on change; REMOVAL is handled
  // out-of-band via DeleteCorsConfiguration below (an empty Cors in UpdateApi does not
  // clear it — live-probed #1160).
  if (
    properties['CorsConfiguration'] !== undefined &&
    !this.deepEqual(properties['CorsConfiguration'], previousProperties['CorsConfiguration'])
  ) {
    input.CorsConfiguration = properties[
      'CorsConfiguration'
    ] as UpdateApiCommandInput['CorsConfiguration'];
    changed = true;
  }
  const corsRemoved =
    properties['CorsConfiguration'] === undefined &&
    previousProperties['CorsConfiguration'] !== undefined;
  // DisableExecuteApiEndpoint: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['DisableExecuteApiEndpoint'] !== undefined &&
    properties['DisableExecuteApiEndpoint'] !== previousProperties['DisableExecuteApiEndpoint']
  ) {
    input.DisableExecuteApiEndpoint = properties['DisableExecuteApiEndpoint'] as boolean;
    changed = true;
  }
  // Version: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['Version'] !== undefined &&
    properties['Version'] !== previousProperties['Version']
  ) {
    input.Version = properties['Version'] as string;
    changed = true;
  }
  // RouteSelectionExpression: CloudFormation KEEPS the live value when it is
  // removed, alone or beside another change (real CloudFormation A/B on a
  // WebSocket API, #1160), so removal sends nothing. Pass through on change only.
  if (
    properties['RouteSelectionExpression'] !== undefined &&
    properties['RouteSelectionExpression'] !== previousProperties['RouteSelectionExpression']
  ) {
    input.RouteSelectionExpression = properties['RouteSelectionExpression'] as string;
    changed = true;
  }
  // ApiKeySelectionExpression: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['ApiKeySelectionExpression'] !== undefined &&
    properties['ApiKeySelectionExpression'] !== previousProperties['ApiKeySelectionExpression']
  ) {
    input.ApiKeySelectionExpression = properties['ApiKeySelectionExpression'] as string;
    changed = true;
  }
  // IpAddressType: CloudFormation KEEPS the live value when it is removed (real
  // CloudFormation A/B, #5004), so removal sends nothing — an omitted member
  // means "unchanged" in this API. Pass through on change only.
  if (
    properties['IpAddressType'] !== undefined &&
    properties['IpAddressType'] !== previousProperties['IpAddressType']
  ) {
    input.IpAddressType = properties['IpAddressType'] as IpAddressType;
    changed = true;
  }

  if (!changed && !corsRemoved && !tagDiff.changed) {
    log.debug(`No mutable Api fields changed for ${logicalId}; skipping UpdateApi`);
    return { physicalId, wasReplaced: false };
  }

  log.debug(`Updating API Gateway V2 Api ${logicalId}: ${physicalId}`);

  try {
    let apiEndpoint: string | undefined;
    if (changed) {
      const updated = await this.getClient().send(new UpdateApiCommand(input));
      apiEndpoint = updated.ApiEndpoint;
    }
    if (corsRemoved) {
      log.debug(`Clearing CORS configuration for Api ${logicalId}: ${physicalId}`);
      await this.getClient().send(new DeleteCorsConfigurationCommand({ ApiId: physicalId }));
    }
    await this.applyTagDiff(`/apis/${physicalId}`, tagDiff);
    // HEAL. `ExecuteApiArn` is a NEW attribute, so no state record written by
    // an earlier binary carries it — every existing API is in that state, and
    // without re-recording here the fix would only ever help APIs created
    // after it. `UpdateApi` returns the endpoint, so this costs no extra call.
    //
    // The map is COMPLETE on purpose, and it is written ONLY when every member
    // is in hand. The engine REPLACES attributes when an update returns any
    // (`deploy-engine.ts`'s `result.attributes ?? …`), so a partial map does
    // not merge — it overwrites.
    //
    // Gating on the ARN as well as the endpoint is what stops this HEAL from
    // being destructive. `buildExecuteApiArn` yields `undefined` on a
    // REACHABLE, TRANSIENT condition: `getAccountInfo` rejects when STS
    // cannot name the account (issue #1730), and the refusal arm declines. Writing `{ ApiId, ApiEndpoint }` there would erase an
    // `ExecuteApiArn` an earlier deploy recorded correctly — and a consumer's
    // `Fn::GetAtt` reading the freshly written attributes IN THE SAME DEPLOY
    // would then hard-throw from `guardedPhysicalIdFallback`, with the loss
    // persisted. Carrying the old map forward loses nothing: `ApiEndpoint` is
    // derived from the api id and does not change on update.
    // NESTED rather than one `apiEndpoint !== undefined && executeApiArn !==
    // undefined` test: written flat, the endpoint half is TAUTOLOGICAL —
    // nothing can build an ARN without first passing the endpoint test — so
    // deleting it reds no case, and an unfalsifiable guard is the shape this
    // change removed from `resolveDefinitionInterface` in the same PR. Nested,
    // each `if` is the ONLY thing deciding its arm: the outer one gates the
    // STS call (`mockGetAccountInfo` is asserted uncalled on the CORS-only
    // arm) and the inner one gates the write.
    if (apiEndpoint !== undefined) {
      const executeApiArn = await this.buildExecuteApiArn(physicalId, log);
      if (executeApiArn !== undefined) {
        return {
          physicalId,
          wasReplaced: false,
          attributes: {
            ApiId: physicalId,
            ApiEndpoint: apiEndpoint,
            ExecuteApiArn: executeApiArn,
          },
        };
      }
      // NOT because the decline would otherwise be silent — `buildExecuteApiArn`
      // already WARNS on both of its decline arms, at default verbosity, where
      // this prints only under `--verbose`. What that warning does not say is
      // what happened HERE: that the update returned no attributes and the
      // previously recorded map was kept. This line is that half.
      log.debug(
        `Skipping the ExecuteApiArn heal for API ${physicalId}: the ARN could not be built. ` +
          `The previously recorded attributes are kept.`
      );
    }
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway V2 Api ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
