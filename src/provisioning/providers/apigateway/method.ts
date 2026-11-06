import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  PutMethodCommand,
  UpdateMethodCommand,
  DeleteMethodCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodResponseCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { replayWarn, requireConfigString } from '../../config-shape.js';
import { compositeIdFormatMessage, packCompositeId } from '../../composite-id.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { getPriorAttempts } from '../../../deployment/prior-attempt-scope.js';
import {
  APIGW_METHOD_ID_FORMAT,
  isMethodAlreadyExists,
  appendMapPatchOps,
  listPatchOps,
  putIntegrationInput,
  putMethodResponseInput,
  putIntegrationResponseInput,
  methodChildCalls,
} from './shared.js';

// ─── AWS::ApiGateway::Method ──────────────────────────────────────

/**
 * Create an API Gateway Method
 *
 * Creates a method on a resource and optionally sets up the integration
 * (and per-status-code integration responses) plus method responses.
 * PhysicalId format: `{restApiId}|{resourceId}|{httpMethod}`
 *
 * All mutable Method-level fields supported by `PutMethodRequest` are
 * forwarded (`ApiKeyRequired`, `OperationName`, `RequestParameters`,
 * `RequestModels`, `RequestValidatorId`, `AuthorizationScopes`).
 *
 * All mutable Integration-level fields supported by
 * `PutIntegrationRequest` are forwarded (`ConnectionType`,
 * `ConnectionId`, `Credentials`, `RequestParameters`, `RequestTemplates`,
 * `PassthroughBehavior`, `ContentHandling`, `TimeoutInMillis`,
 * `CacheNamespace`, `CacheKeyParameters`, `TlsConfig`,
 * `ResponseTransferMode`). Pre-fix only `Type` / `IntegrationHttpMethod`
 * / `Uri` were forwarded — silently dropping every other field. This
 * surfaced as e.g. `responseTransferMode: 'STREAM'` being lost,
 * producing the AWS rejection
 *   "Invalid ResponseTransferMode. Cannot use ResponseTransferMode
 *    BUFFERED for Lambda functions invoked by InvokeWithResponseStream
 *    for AWS_PROXY integrations."
 * when CDK's `LambdaIntegration({ responseTransferMode: STREAM })` was
 * used together with the streaming `response-streaming-invocations` URI.
 *
 * `MethodResponses` and `IntegrationResponses` are applied as separate
 * per-entry calls (`PutMethodResponseCommand` /
 * `PutIntegrationResponseCommand`). Order matters: every
 * `MethodResponse` is put BEFORE any `IntegrationResponse`, because AWS
 * validates that the matching method response already exists when
 * accepting an integration response (the integration response's
 * `ResponseParameters` / `ResponseTemplates` map onto headers declared
 * by the method response). The inverse order surfaces as
 * `Invalid mapping expression specified: ... [No method response exists
 * for method.]` — the canonical trigger is a CORS preflight OPTIONS
 * method emitted by `RestApi({ defaultCorsPreflightOptions: ... })`.
 *
 * Partial-failure cleanup: if any AWS call AFTER `PutMethodCommand`
 * fails, the method has already been created on AWS but cdkd state
 * does NOT record it (the throw happens before the success return).
 * A subsequent redeploy would then attempt CREATE again and AWS would
 * reject with `Method already exists for this resource`. To prevent
 * this orphan, the post-`PutMethod` block is wrapped in an inner
 * try/catch that issues a best-effort `DeleteMethodCommand` before
 * re-throwing the original error. Cleanup failures are logged at warn
 * (the underlying create failure is what matters; we don't mask it by
 * promoting a cleanup error). The class of bug — partial AWS-side
 * commit on `createMethod` failure — was first seen via the
 * `PutIntegrationResponse`-before-`PutMethodResponse` ordering bug
 * fixed in PR #373; this cleanup makes any future shape of
 * post-`PutMethod` failure self-healing on the next redeploy.
 */
export async function createMethod(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  log.debug(`Creating API Gateway Method ${logicalId}`);

  const restApiId = properties['RestApiId'] as string;
  const resourceId = properties['ResourceId'] as string;
  const httpMethod = properties['HttpMethod'] as string;
  // The highest-value site of issue #1513: the default is NO AUTHORIZATION,
  // so a null / mis-nested value used to silently publish a PUBLIC method.
  const authorizationType = requireConfigString(
    properties['AuthorizationType'],
    'NONE',
    'AWS::ApiGateway::Method AuthorizationType',
    replayWarn(log, context)
  );
  const authorizerId = properties['AuthorizerId'] as string | undefined;
  const apiKeyRequired = properties['ApiKeyRequired'] as boolean | undefined;
  const operationName = properties['OperationName'] as string | undefined;
  const methodRequestParameters = properties['RequestParameters'] as
    | Record<string, boolean>
    | undefined;
  const requestModels = properties['RequestModels'] as Record<string, string> | undefined;
  const requestValidatorId = properties['RequestValidatorId'] as string | undefined;
  // Deduplicated: PutMethod stores a repeated scope twice, but the update
  // path diffs scopes as a SET (see `updateMethod`), which is exact only
  // while AWS holds no duplicate (go-to-k/cdkd#5408).
  const declaredScopes = properties['AuthorizationScopes'] as string[] | undefined;
  const authorizationScopes = declaredScopes ? [...new Set(declaredScopes)] : undefined;

  if (!restApiId || !resourceId || !httpMethod) {
    throw new ProvisioningError(
      `RestApiId, ResourceId, and HttpMethod are required for API Gateway Method ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Refuse a `|` in any segment BEFORE `PutMethod` runs (issue #1672).
  // `RestApiId` / `ResourceId` are AWS-generated and `HttpMethod` is a verb
  // from a closed set, so no segment is realistically pipe-capable — this is
  // uniform defense-in-depth. Computed here so the refusal cannot orphan a
  // method AWS has already put (this method's own inner failure path already
  // has to `DeleteMethod` for exactly that reason).
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'restApiId', value: restApiId },
      { name: 'resourceId', value: resourceId },
      { name: 'httpMethod', value: httpMethod },
    ],
    // A reverse-replacement rollback creates from a STATE record, so the
    // refusal downgrades to a warning — the same `context` this method
    // already consults for its `AuthorizationType` guard.
    {
      // Issue #2176: the refusal QUOTES the offending segment value, on the
      // thrown arm (durable) and the warn arm (terminal) alike, so the masker
      // goes through unconditionally -- it is absent on the paths that have no
      // context, where it degrades to identity.
      maskSecrets: log.mask,
      ...(context?.replayingState === true && {
        onRefusal: (message: string) => log.warn(message),
      }),
    }
  );
  // Issue #2177: the three ids are bag values (resolved `Ref`s and the
  // verb), each masked RAW before it joins a line, so a secret shorter than
  // the masker's substring floor is caught too.
  const maskedIds = [restApiId, resourceId, httpMethod].map((id) => log.value(id));
  const methodPath = maskedIds.join('/');
  // go-to-k/cdkd#4583: set when the wiring cleanup could not delete the
  // method, which then exists with no state record.
  let methodLeftBehind = false;

  try {
    const putMethod = () =>
      this.apiGatewayClient.send(
        new PutMethodCommand({
          restApiId,
          resourceId,
          httpMethod,
          authorizationType,
          authorizerId,
          apiKeyRequired,
          operationName,
          requestParameters: methodRequestParameters,
          requestModels,
          requestValidatorId,
          authorizationScopes,
        })
      );
    try {
      await putMethod();
    } catch (putError) {
      // go-to-k/cdkd#5294: the method may be what an earlier attempt of THIS
      // resource left behind when its wiring cleanup also failed (below).
      // Replaced only on the stack's own evidence; anything else keeps
      // AWS's refusal.
      if (
        !isMethodAlreadyExists(putError) ||
        !(await this.priorAttemptLeftMethod(logicalId, physicalId, log))
      ) {
        throw putError;
      }
      log.warn(
        `Replacing API Gateway Method ${logicalId} (${methodPath}), which an earlier failed attempt of it left behind`
      );
      try {
        await this.apiGatewayClient.send(
          new DeleteMethodCommand({ restApiId, resourceId, httpMethod })
        );
      } catch (deleteError) {
        // Gone in the meantime: the slot is free, which is what the delete was for.
        if (!(deleteError instanceof NotFoundException)) throw deleteError;
      }
      await putMethod();
    }
    // go-to-k/cdkd#5511: report before the wiring calls.
    reportCreatedResource(logicalId, resourceType, physicalId);

    // PutMethodCommand has succeeded — AWS has now committed the
    // Method resource. Every subsequent call wires sub-resources onto
    // it; if any of them fail, the method exists on AWS but cdkd state
    // will NOT (the throw aborts before the success-return). The next
    // redeploy would then re-try CREATE and AWS would reject with
    // `Method already exists for this resource`. Wrap the rest of the
    // wiring in an inner try/catch that issues a best-effort
    // `DeleteMethodCommand` before re-throwing, so the failed attempt
    // is self-healing on the next redeploy.
    try {
      // If Integration property exists, set up the integration. All
      // fields supported by `PutIntegrationRequest` are forwarded — see
      // the JSDoc on this method for the full list and the
      // `ResponseTransferMode` regression that motivated the fix.
      const integration = properties['Integration'] as Record<string, unknown> | undefined;
      if (integration) {
        await this.apiGatewayClient.send(
          new PutIntegrationCommand(
            putIntegrationInput({ restApiId, resourceId, httpMethod }, integration)
          )
        );
      }

      // MethodResponses must be created BEFORE IntegrationResponses:
      // `PutIntegrationResponse` validates that the `MethodResponse` for the
      // same `statusCode` already exists (because IntegrationResponse's
      // ResponseParameters / ResponseTemplates map onto headers declared by
      // the MethodResponse). Inverting the order makes AWS reject with
      // `Invalid mapping expression specified: ... [No method response
      // exists for method.]` — the canonical failure mode is a CORS
      // preflight OPTIONS method emitted by
      // `RestApi({ defaultCorsPreflightOptions: ... })`.
      const methodResponses = properties['MethodResponses'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (methodResponses) {
        for (const resp of methodResponses) {
          await this.apiGatewayClient.send(
            new PutMethodResponseCommand(
              putMethodResponseInput({ restApiId, resourceId, httpMethod }, resp)
            )
          );
        }
      }

      if (integration) {
        // IntegrationResponses (CFn shape:
        //   [{StatusCode, SelectionPattern?, ResponseParameters?,
        //     ResponseTemplates?, ContentHandling?}, ...])
        // requires per-entry `PutIntegrationResponseCommand` calls after
        // the integration itself is created AND after the matching
        // MethodResponses are in place (see comment above).
        const integrationResponses = integration['IntegrationResponses'] as
          | Array<Record<string, unknown>>
          | undefined;
        if (integrationResponses) {
          for (const ir of integrationResponses) {
            await this.apiGatewayClient.send(
              new PutIntegrationResponseCommand(
                putIntegrationResponseInput({ restApiId, resourceId, httpMethod }, ir)
              )
            );
          }
        }
      }
    } catch (innerError) {
      // Best-effort cleanup of the AWS-side Method that PutMethodCommand
      // committed. Failures here are logged at warn but do NOT mask the
      // original error — the user needs to see what actually broke.
      try {
        await this.apiGatewayClient.send(
          new DeleteMethodCommand({ restApiId, resourceId, httpMethod })
        );
        retractCreatedResource(logicalId, resourceType, physicalId);
        log.debug(
          `Cleaned up partially-created API Gateway Method ${logicalId} (${methodPath}) after wiring failure`
        );
      } catch (cleanupError) {
        methodLeftBehind = true;
        // The engine's retry of this dispatch meets the method before any
        // journal names it (go-to-k/cdkd#5294).
        getPriorAttempts(logicalId)?.notePossiblyLanded();
        // All three ids are TEMPLATE values (resolved `Ref`s and the
        // method), so the command renders through `pasteableAwsCommand`
        // (issue #3136): quoted, or withheld when one cannot be printed
        // exactly.
        // An AWS-authored failure is named by its class at warn, and AWS's
        // text goes to `debug` under the same head (go-to-k/cdkd#2319).
        const cleanupFailure = describeAwsFailure(cleanupError);
        const cleanupHead = `Failed to clean up partially-created API Gateway Method ${logicalId} (${methodPath}): `;
        if (cleanupFailure.redacted) log.debug(`${cleanupHead}${cleanupFailure.detail}`);
        log.warn(
          `${cleanupHead}${cleanupFailure.redacted ? `${cleanupFailure.summary} ` : `${cleanupFailure.detail}. `}Manual deletion may be required before the next deploy: ${pasteableAwsCommand(log.mask)`aws apigateway delete-method --rest-api-id ${restApiId} --resource-id ${resourceId} --http-method ${httpMethod}`.render()}`
        );
      }
      // The method itself was created: an "already exists" from its wiring
      // (a method or integration response) is not this method's (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    log.debug(`Successfully created API Gateway Method ${logicalId}: ${maskedIds.join('|')}`);

    return {
      physicalId,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create API Gateway Method ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (methodLeftBehind) markCreatedBeforeFailure(thrown, logicalId, resourceType, physicalId);
    throw thrown;
  }
}

/**
 * Whether an earlier attempt of `logicalId` left THIS method (`physicalId`,
 * its `restApiId|resourceId|httpMethod`) behind: its wiring failed and so
 * did its cleanup delete (go-to-k/cdkd#5294). Two sources, both the stack's
 * own proof:
 *
 * - an earlier deploy's failed CREATE journaled with that id as one its
 *   provider proved it made (`markCreatedBeforeFailure` below), via
 *   `provenOrphanIds`;
 * - an earlier attempt of THIS dispatch (the engine's retry), noted with
 *   `notePossiblyLanded` where the cleanup failed. Nothing else notes it
 *   for a Method.
 *
 * Never the bare attempted bags: a create AWS refused because another
 * owner's method held the keys, or one whose cleanup succeeded, also leaves
 * one, and replacing on it would delete a method this stack never made. An
 * unreadable journal or a caller that bound none is no evidence.
 *
 * Residual: a cleanup delete that failed ambiguously yet applied, followed
 * by another owner putting a method on the same keys before the re-run.
 * Those keys are this stack's own `RestApiId` / `ResourceId`, so the other
 * owner would be writing into this stack's REST API resource.
 */
export async function priorAttemptLeftMethod(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  log: MaskedLogSinks
): Promise<boolean> {
  const lookup = getPriorAttempts(logicalId);
  if (lookup === undefined) return false;
  if (lookup.possiblyLanded()) return true;
  if (lookup.provenOrphanIds === undefined) return false;
  try {
    return (await lookup.provenOrphanIds()).includes(physicalId);
  } catch (error) {
    log.debug(
      `API Gateway Method ${logicalId}: rollback journal read failed: ${describeAwsFailure(error).detail}`
    );
    return false;
  }
}

/**
 * Update an API Gateway Method via `UpdateMethodCommand` (RFC 6902 JSON
 * Patch operations).
 *
 * Mutable top-level fields:
 *   `/authorizationType`, `/authorizerId`, `/apiKeyRequired`,
 *   `/operationName`, `/requestValidatorId`.
 *
 * Map fields (`RequestParameters`, `RequestModels`) emit per-key
 * `add` / `remove` / `replace` ops with paths like
 *   `/requestParameters/method.request.querystring.foo`
 *   `/requestModels/application~1json` (slashes escaped per RFC 6901).
 *
 * `AuthorizationScopes` is a list, patched per element with `add` /
 * `remove /authorizationScopes` ops (see {@link listPatchOps}; same as
 * Authorizer's `ProviderARNs`).
 *
 * `HttpMethod`, `ResourceId`, `RestApiId` are immutable (replacement
 * layer handles them via DELETE + CREATE).
 *
 * `Integration` and `MethodResponses` are separate API Gateway
 * sub-resources, applied after the patch by {@link methodChildCalls}
 * (go-to-k/cdkd#5140), as CloudFormation updates them in place.
 *
 * The `gate on !== undefined` pattern (NOT truthy) is load-bearing for
 * `cdkd drift --revert`: `ApiKeyRequired: false` and empty-string
 * placeholders must reach AWS as a real `replace` op so a console-
 * side toggle is actually cleared on revert.
 */
export async function updateMethod(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  previousIsLiveReadback = false
): Promise<ResourceUpdateResult> {
  const parts = physicalId.split('|');
  // Issue #2177: the recorded ids came off a resolved bag, each masked RAW,
  // on the updating line and in the malformed-id refusal alike.
  const maskedId = parts.map((p) => log.value(p)).join('|');
  log.debug(`Updating API Gateway Method ${logicalId}: ${maskedId}`);

  if (parts.length !== 3) {
    throw new ProvisioningError(
      compositeIdFormatMessage(APIGW_METHOD_ID_FORMAT, logicalId, maskedId),
      resourceType,
      logicalId,
      physicalId
    );
  }
  const [restApiId, resourceId, httpMethod] = parts;

  const patchOperations: Array<{
    op: 'replace' | 'add' | 'remove';
    path: string;
    value?: string;
  }> = [];

  const primitiveFields: Array<{ key: string; path: string }> = [
    { key: 'AuthorizationType', path: '/authorizationType' },
    { key: 'AuthorizerId', path: '/authorizerId' },
    { key: 'ApiKeyRequired', path: '/apiKeyRequired' },
    { key: 'OperationName', path: '/operationName' },
    { key: 'RequestValidatorId', path: '/requestValidatorId' },
  ];

  for (const { key, path } of primitiveFields) {
    const newVal = properties[key];
    const prevVal = previousProperties[key];
    if (newVal !== prevVal) {
      patchOperations.push({
        op: 'replace',
        path,
        value: newVal !== undefined ? stringifyValue(newVal) : '',
      });
    }
  }

  // Map fields: per-key add / remove / replace.
  appendMapPatchOps(
    patchOperations,
    '/requestParameters',
    (properties['RequestParameters'] as Record<string, unknown> | undefined) ?? {},
    (previousProperties['RequestParameters'] as Record<string, unknown> | undefined) ?? {}
  );
  appendMapPatchOps(
    patchOperations,
    '/requestModels',
    (properties['RequestModels'] as Record<string, unknown> | undefined) ?? {},
    (previousProperties['RequestModels'] as Record<string, unknown> | undefined) ?? {}
  );

  // AuthorizationScopes is a list API Gateway patches only element by
  // element: `replace /authorizationScopes` is refused ("Must be one of:
  // [add, remove]"; go-to-k/cdkd#5408). Diffed as a SET: an `add` of a scope
  // already present is a no-op on AWS (measured), so an occurrence count
  // would drift from what AWS holds, and a later remove could then take
  // out a scope the template still declares. createMethod deduplicates.
  // A dropped scope is removed once per occurrence AWS holds when the
  // previous side IS the live readback (`cdkd drift --revert`), since a
  // method created elsewhere can hold a repeat; a template previous side is
  // a set on AWS, so one remove each.
  const scopeOps = listPatchOps(
    '/authorizationScopes',
    properties['AuthorizationScopes'] as string[] | undefined,
    previousProperties['AuthorizationScopes'] as string[] | undefined,
    { asSet: true, removeEveryPrevOccurrence: previousIsLiveReadback }
  );
  patchOperations.push(...scopeOps.adds, ...scopeOps.removes);

  const ids = { restApiId: restApiId!, resourceId: resourceId!, httpMethod: httpMethod! };
  const childCalls = methodChildCalls(ids, properties, previousProperties);
  if (patchOperations.length === 0 && childCalls.length === 0) {
    log.debug(`No changes detected for API Gateway Method ${logicalId}`);
    return { physicalId, wasReplaced: false };
  }

  try {
    if (patchOperations.length > 0) {
      // Not idempotent: should the SDK retry a call AWS already applied, a
      // repeated `remove /authorizationScopes` fails with "doesn't contain
      // the value".
      await this.apiGatewayClient.send(
        new UpdateMethodCommand({
          restApiId,
          resourceId,
          httpMethod,
          patchOperations,
        })
      );
    }
    // go-to-k/cdkd#5140: the integration and the method / integration
    // responses are sub-resources UpdateMethod does not reach.
    for (const call of childCalls) {
      try {
        await this.apiGatewayClient.send(call.command as never);
      } catch (error) {
        // A delete of what is already gone has done its job.
        if (!(call.kind === 'delete' && error instanceof NotFoundException)) throw error;
      }
    }
    log.debug(
      `Successfully updated API Gateway Method ${logicalId} (${patchOperations.length} patch ops, ${childCalls.length} sub-resource calls)`
    );
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update API Gateway Method ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Delete an API Gateway Method
 *
 * Parses the composite physicalId (`restApiId|resourceId|httpMethod`) and
 * calls DeleteMethodCommand. Handles NotFoundException gracefully.
 */
export async function deleteMethod(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting API Gateway Method ${logicalId}: ${physicalId}`);

  const parts = physicalId.split('|');
  if (parts.length !== 3) {
    throw new ProvisioningError(
      compositeIdFormatMessage(APIGW_METHOD_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  const [restApiId, resourceId, httpMethod] = parts;

  try {
    await this.apiGatewayClient.send(
      new DeleteMethodCommand({
        restApiId,
        resourceId,
        httpMethod,
      })
    );

    this.logger.debug(`Successfully deleted API Gateway Method ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.apiGatewayClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`API Gateway Method ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete API Gateway Method ${logicalId}: ${text}`,
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
 * Get API Gateway Method attribute
 */
export function getMethodAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  const parts = physicalId.split('|');
  if (parts.length === 3) {
    if (attributeName === 'RestApiId') return Promise.resolve(parts[0]);
    if (attributeName === 'ResourceId') return Promise.resolve(parts[1]);
    if (attributeName === 'HttpMethod') return Promise.resolve(parts[2]);
  }

  return Promise.resolve(undefined);
}
