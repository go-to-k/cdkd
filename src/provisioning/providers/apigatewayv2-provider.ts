import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { refuseMalformedDesiredTags, tagMapAsList, type CfnTagEntry } from '../tag-list.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../masked-retry-logger.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { pasteableAwsCommand, type PasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  getClient,
  getCreateClient,
  orphanCommandRegionArg,
  wrapMaskedError,
  create,
  update,
  deleteImpl,
  getAttribute,
  getDriftUnknownPaths,
  canonicalizeDriftPair,
  readCurrentState,
  importImpl,
} from './apigatewayv2/core.js';
import {
  createApi,
  deleteApi,
  buildExecuteApiArn,
  getApiAttribute,
  readApi,
  updateApi,
} from './apigatewayv2/api.js';
import {
  createStage,
  deleteStage,
  getStageAttribute,
  readStage,
  updateStage,
} from './apigatewayv2/stage.js';
import {
  createIntegration,
  deleteIntegration,
  getIntegrationAttribute,
  readIntegration,
  updateIntegration,
} from './apigatewayv2/integration.js';
import {
  createRoute,
  deleteRoute,
  getRouteAttribute,
  readRoute,
  updateRoute,
} from './apigatewayv2/route.js';
import {
  createAuthorizer,
  deleteAuthorizer,
  readAuthorizer,
  updateAuthorizer,
} from './apigatewayv2/authorizer.js';
import {
  serviceIntegrationParameters,
  clearableUpdate,
  droppedKeys,
  sendTolerantOfNotFound,
  applyStageRemovals,
  deleteRouteRequestParameters,
  mapWithRemovals,
  mapEntryAddedOrChanged,
  warnTlsConfigIgnoredIfPublic,
  planTags,
  applyTagDiff,
  deepEqual,
} from './apigatewayv2/update-helpers.js';
import {
  toSdkResponseParameters,
  toCfnResponseParameters,
  mirrorDeclaredResponsePairs,
} from './apigatewayv2/response-parameters.js';
import type { TagChange } from './apigatewayv2/shared.js';

export { resetApiGatewayV2CreateRetryStateForTests } from './apigatewayv2/shared.js';

/**
 * AWS API Gateway V2 (HTTP API) Provider
 *
 * Implements resource provisioning for:
 * - AWS::ApiGatewayV2::Api (HTTP API)
 * - AWS::ApiGatewayV2::Stage (Stage with auto-deploy)
 * - AWS::ApiGatewayV2::Integration (Lambda/HTTP integration)
 * - AWS::ApiGatewayV2::Route (Route with route key)
 *
 * Uses local lazy init for ApiGatewayV2Client since it's not in aws-clients.ts.
 */
export class ApiGatewayV2Provider implements ResourceProvider {
  client: ApiGatewayV2Client | undefined;
  createClient: ApiGatewayV2Client | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('ApiGatewayV2Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ApiGatewayV2::Api',
      new Set([
        'Name',
        'ProtocolType',
        'Description',
        'CorsConfiguration',
        'Tags',
        'DisableExecuteApiEndpoint',
        'Version',
        'RouteSelectionExpression',
        'ApiKeySelectionExpression',
        'IpAddressType',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Stage',
      new Set([
        'ApiId',
        'StageName',
        'AutoDeploy',
        'Description',
        'Tags',
        'StageVariables',
        'DefaultRouteSettings',
        'AccessLogSettings',
        'ClientCertificateId',
        'DeploymentId',
        'RouteSettings',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Integration',
      new Set([
        'ApiId',
        'IntegrationType',
        'IntegrationUri',
        'IntegrationMethod',
        'PayloadFormatVersion',
        'TimeoutInMillis',
        'RequestParameters',
        'Description',
        'ConnectionId',
        'ConnectionType',
        'ContentHandlingStrategy',
        'CredentialsArn',
        'IntegrationSubtype',
        'PassthroughBehavior',
        'RequestTemplates',
        'ResponseParameters',
        'TemplateSelectionExpression',
        'TlsConfig',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Route',
      new Set([
        'ApiId',
        'RouteKey',
        'Target',
        'AuthorizationType',
        'AuthorizerId',
        'AuthorizationScopes',
        'OperationName',
        'ApiKeyRequired',
        'ModelSelectionExpression',
        'RequestModels',
        'RequestParameters',
        'RouteResponseSelectionExpression',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Authorizer',
      new Set([
        'ApiId',
        'AuthorizerType',
        'Name',
        'IdentitySource',
        'JwtConfiguration',
        'AuthorizerUri',
        'AuthorizerCredentialsArn',
        'AuthorizerPayloadFormatVersion',
        'AuthorizerResultTtlInSeconds',
        'EnableSimpleResponses',
        'IdentityValidationExpression',
      ]),
    ],
  ]);

  /**
   * Clear values for a property the template REMOVED (issue #1160). A removed
   * Authorizer `IdentitySource` is CLEARED by CloudFormation (real
   * CloudFormation A/B, #1160): on a REQUEST authorizer it reads back as none,
   * and on a JWT authorizer, or a REQUEST one with caching on, the update fails
   * because AWS requires it. `UpdateAuthorizer` with `IdentitySource: []` gives
   * exactly that (direct probe, same A/B); an omitted member keeps the value.
   * Every other removal in this provider is decided in its `update*` method.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    ['AWS::ApiGatewayV2::Authorizer', new Map<string, unknown>([['IdentitySource', []]])],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every Route
   * property, each removal decided in `updateRoute`, so the shared caller warns
   * about none of them. A removal `updateRoute` leaves in place is listed only
   * where a CloudFormation A/B showed CloudFormation leaves it too.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ApiGatewayV2::Route',
      new Set([
        // ApiId is create-only and RouteKey is required: neither is removable.
        'ApiId',
        'RouteKey',
        // Reset on removal, as CloudFormation resets it (#5004).
        'AuthorizationScopes',
        // Left in place, as CloudFormation leaves them (#5004, #1160, #5548).
        'Target',
        'AuthorizationType',
        'AuthorizerId',
        'OperationName',
        'ApiKeyRequired',
        'RequestModels',
        'RequestParameters',
        'ModelSelectionExpression',
        'RouteResponseSelectionExpression',
      ]),
    ],
  ]);

  /**
   * Properties this provider deliberately does NOT wire through to the SDK
   * call, with a one-line rationale per entry. Consumed by the development-
   * time coverage check (`tests/unit/provisioning/property-coverage.test.ts`,
   * issue #391) — see `ResourceProvider.unhandledByDesign` doc.
   *
   * The five OpenAPI-import fields on `AWS::ApiGatewayV2::Api` trigger an
   * entirely separate `ImportApi` AWS API code path (inline OpenAPI spec or
   * S3-hosted), not the field-by-field `CreateApi` cdkd already supports.
   * Wiring them would require parsing OpenAPI semantics + a different
   * mutation surface and is out of scope for the SDK-Provider safety net.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::ApiGatewayV2::Api',
      new Map([
        [
          'Body',
          'OpenAPI/Swagger inline spec; routed through ImportApi, not the field-by-field CreateApi path.',
        ],
        [
          'BodyS3Location',
          'OpenAPI/Swagger spec on S3; routed through ImportApi, not the field-by-field CreateApi path.',
        ],
        ['FailOnWarnings', 'OpenAPI-import-only flag; meaningful only on the ImportApi code path.'],
        [
          'DisableSchemaValidation',
          'Schema-validation toggle on CreateApi/UpdateApi that AWS docs scope to WebSocket APIs using AWS::ApiGatewayV2::Model — that resource type is not yet registered in cdkd, so the toggle has no effect to wire.',
        ],
        [
          'BasePath',
          'OpenAPI-import-only basePath override; meaningful only on the ImportApi code path.',
        ],
        [
          'RouteKey',
          'Quick-create shortcut: CreateApi inline-creates a default route+integration from RouteKey/Target/CredentialsArn. cdkd models routes/integrations as explicit AWS::ApiGatewayV2::Route/::Integration resources, so this convenience field is not wired.',
        ],
        [
          'Target',
          'Quick-create shortcut (paired with RouteKey/CredentialsArn); cdkd models the integration as an explicit AWS::ApiGatewayV2::Integration resource instead.',
        ],
        [
          'CredentialsArn',
          'Quick-create shortcut (paired with RouteKey/Target); cdkd models the integration as an explicit AWS::ApiGatewayV2::Integration resource instead.',
        ],
      ]),
    ],
  ]);

  getClient(): ApiGatewayV2Client {
    return getClient.call(this);
  }

  getCreateClient(): ApiGatewayV2Client {
    return getCreateClient.call(this);
  }

  orphanCommandRegionArg(
    aws: ReturnType<typeof pasteableAwsCommand>
  ): Promise<PasteableAwsCommand> {
    return orphanCommandRegionArg.call(this, aws);
  }

  wrapMaskedError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedError.call(this, log, error, build);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName);
  }

  createApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createApi.call(this, logicalId, resourceType, properties, log);
  }

  deleteApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteApi.call(this, logicalId, physicalId, resourceType, context);
  }

  buildExecuteApiArn(
    apiId: string,
    log: MaskedLogSinks = createMaskedLogSinks(this.logger, undefined)
  ): Promise<string | undefined> {
    return buildExecuteApiArn.call(this, apiId, log);
  }

  getApiAttribute(physicalId: string, attributeName: string): unknown {
    return getApiAttribute.call(this, physicalId, attributeName);
  }

  createStage(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createStage.call(this, logicalId, resourceType, properties, log);
  }

  deleteStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteStage.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getStageAttribute(physicalId: string, attributeName: string): unknown {
    return getStageAttribute.call(this, physicalId, attributeName);
  }

  createIntegration(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createIntegration.call(this, logicalId, resourceType, properties, log);
  }

  deleteIntegration(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteIntegration.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getIntegrationAttribute(physicalId: string, attributeName: string): unknown {
    return getIntegrationAttribute.call(this, physicalId, attributeName);
  }

  createRoute(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createRoute.call(this, logicalId, resourceType, properties, log);
  }

  deleteRoute(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteRoute.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getRouteAttribute(physicalId: string, attributeName: string): unknown {
    return getRouteAttribute.call(this, physicalId, attributeName);
  }

  createAuthorizer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createAuthorizer.call(this, logicalId, resourceType, properties, log);
  }

  deleteAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteAuthorizer.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    return getDriftUnknownPaths.call(this, resourceType, properties);
  }

  canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    properties: Record<string, unknown> = {}
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return canonicalizeDriftPair.call(this, resourceType, baseline, aws, properties);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, properties);
  }

  readApi(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readApi.call(this, physicalId);
  }

  readStage(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readStage.call(this, physicalId, properties);
  }

  readIntegration(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readIntegration.call(this, physicalId, properties);
  }

  readRoute(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readRoute.call(this, physicalId, properties);
  }

  readAuthorizer(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readAuthorizer.call(this, physicalId, properties);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  updateApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateApi.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  updateStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    restoreFromAws = false
  ): Promise<ResourceUpdateResult> {
    return updateStage.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      restoreFromAws
    );
  }

  updateIntegration(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    restoreFromAws = false,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateIntegration.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      restoreFromAws,
      context
    );
  }

  updateRoute(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    restoreFromAws = false
  ): Promise<ResourceUpdateResult> {
    return updateRoute.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      restoreFromAws
    );
  }

  updateAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateAuthorizer.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      context
    );
  }

  serviceIntegrationParameters(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    sent: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    return serviceIntegrationParameters.call(this, logicalId, physicalId, resourceType, sent);
  }

  clearableUpdate<T>(
    next: T | undefined,
    previous: T | undefined,
    resetValue: T
  ): { changed: boolean; value: T | undefined } {
    return (clearableUpdate<T>).call(this, next, previous, resetValue);
  }

  droppedKeys(next: unknown, previous: unknown): string[] {
    return droppedKeys.call(this, next, previous);
  }

  sendTolerantOfNotFound(send: () => Promise<unknown>): Promise<void> {
    return sendTolerantOfNotFound.call(this, send);
  }

  applyStageRemovals(
    apiId: string,
    stageName: string,
    accessLogRemoved: boolean,
    droppedRouteSettingKeys: readonly string[]
  ): Promise<void> {
    return applyStageRemovals.call(
      this,
      apiId,
      stageName,
      accessLogRemoved,
      droppedRouteSettingKeys
    );
  }

  deleteRouteRequestParameters(
    apiId: string,
    routeId: string,
    droppedKeys: readonly string[]
  ): Promise<void> {
    return deleteRouteRequestParameters.call(this, apiId, routeId, droppedKeys);
  }

  mapWithRemovals(next: unknown, previous: unknown): Record<string, string> | undefined {
    return mapWithRemovals.call(this, next, previous);
  }

  mapEntryAddedOrChanged(next: unknown, previous: unknown): boolean {
    return mapEntryAddedOrChanged.call(this, next, previous);
  }

  warnTlsConfigIgnoredIfPublic(
    logicalId: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): void {
    return warnTlsConfigIgnoredIfPublic.call(this, logicalId, properties, log);
  }

  toSdkResponseParameters(
    value: unknown,
    log: MaskedLogSinks
  ): Record<string, Record<string, string>> | undefined {
    return toSdkResponseParameters.call(this, value, log);
  }

  toCfnResponseParameters(
    value: Record<string, Record<string, string>> | undefined,
    declared?: unknown
  ): Record<string, unknown> | undefined {
    return toCfnResponseParameters.call(this, value, declared);
  }

  mirrorDeclaredResponsePairs(
    flat: Record<string, string>,
    declaredEntries: unknown
  ): Array<{ Destination: string; Source: unknown }> {
    return mirrorDeclaredResponsePairs.call(this, flat, declaredEntries);
  }

  planTags(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    log: MaskedLogSinks
  ): TagChange {
    return planTags.call(
      this,
      properties,
      previousProperties,
      resourceType,
      logicalId,
      physicalId,
      log
    );
  }

  applyTagDiff(path: string, change: TagChange): Promise<void> {
    return applyTagDiff.call(this, path, change);
  }

  deepEqual(a: unknown, b: unknown): boolean {
    return deepEqual.call(this, a, b);
  }

  /**
   * Refuse a malformed desired `Tags` before any call and return it as a list.
   * `AWS::ApiGatewayV2::Api.Tags` and `::Stage.Tags` are a key -> value MAP
   * (`{ "Env": "prod" }`, aws-cdk-lib's `TagType.MAP`), converted with
   * `tagMapAsList`; a `{Key,Value}[]` list (a hand-authored template, which
   * this provider has always accepted) is read as it is. `aws:` keys are
   * reserved — AWS rejects a write of one — so they are never sent
   * (go-to-k/cdkd#5390).
   */
  static desiredTags(
    raw: unknown,
    resourceType: string,
    logicalId: string,
    physicalId?: string
  ): CfnTagEntry[] {
    return refuseMalformedDesiredTags(
      tagMapAsList(raw),
      resourceType,
      logicalId,
      physicalId,
      'Tags',
      'a map of tag keys to scalar values or a list of tags with a non-empty string Key and a scalar Value'
    ).filter((t) => !t.Key.startsWith('aws:'));
  }

  /** A GetApi / GetStage tag map as the template's map, `aws:` keys dropped and keys sorted. */
  static observedTags(tags: Record<string, string> | undefined): Record<string, string> {
    return Object.fromEntries(normalizeAwsTagsToCfn(tags).map((t) => [t.Key, t.Value]));
  }

  /** The SDK's tag map for `CreateApi` / `CreateStage`; absent when there is no tag. */
  static tagRecord(tags: CfnTagEntry[]): Record<string, string> | undefined {
    return tags.length > 0 ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined;
  }
}
