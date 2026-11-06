import {
  AppSyncClient,
  type AdditionalAuthenticationProvider,
  type CachingConfig,
  type CognitoUserPoolConfig,
  type EnhancedMetricsConfig,
  type LambdaAuthorizerConfig,
  type OpenIDConnectConfig,
  type SyncConfig,
  type UserPoolConfig,
  type CreateGraphqlApiCommandInput,
  type CreateDataSourceCommandInput,
  type CreateResolverCommandInput,
  type CreateApiKeyCommandInput,
  type UpdateGraphqlApiCommandInput,
  type UpdateDataSourceCommandInput,
  type UpdateResolverCommandInput,
} from '@aws-sdk/client-appsync';
import { S3Client } from '@aws-sdk/client-s3';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { maskerOrIdentity, type MaskedLogSinks, type MaskerFn } from '../masked-retry-logger.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import type { AmbiguousCreateWindow } from './ambiguous-create.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import type { EnvironmentVariablesRecord, ShapeGuardOptions } from './appsync/shared.js';
import {
  getClient,
  getCreateClient,
  buildAppSyncArn,
  buildAppSyncArnOrWarn,
  childRefAttributes,
  childUpdateResult,
  childImportAttributes,
  getS3Client,
} from './appsync/clients.js';
import {
  create,
  update,
  refuseChangedMalformedGraphQLApiBlocks,
  deepEqual,
  unchangedGraphqlApiName,
  updateGraphQLApi,
} from './appsync/create-update.js';
import {
  updateGraphQLSchema,
  updateDataSource,
  updateResolver,
  updateApiKey,
} from './appsync/update-children.js';
import {
  applyTagDiff,
  wrapUpdateError,
  wrapCaughtError,
  withheldAwsFailure,
  deleteImpl,
  getAttribute,
  getDriftUnknownPaths,
} from './appsync/errors-delete.js';
import {
  asObject,
  toDeltaSyncTtl,
  toSdkUserPoolConfig,
  toSdkCognitoUserPoolConfig,
  toSdkOpenIDConnectConfig,
  toSdkLambdaAuthorizerConfig,
  toSdkAdditionalAuthProviders,
  toSdkEnhancedMetricsConfig,
  applyGraphQLApiConfig,
} from './appsync/api-config.js';
import {
  applyEnvironmentVariables,
  environmentVariableRefusal,
  withEnvironmentVariablesRecord,
  toSdkCachingConfig,
  toSdkSyncConfig,
  parseS3LocationUrl,
  fetchS3LocationBody,
  resolveInlineOrS3Template,
  applyResolverConfig,
} from './appsync/env-resolver-config.js';
import { applyDataSourceConfig } from './appsync/datasource-config.js';
import {
  createGraphQLApi,
  regionArg,
  reportPossibleOrphanApis,
  deleteGraphQLApi,
} from './appsync/graphql-api.js';
import {
  createGraphQLSchema,
  createDataSource,
  deleteDataSource,
  createResolver,
  deleteResolver,
} from './appsync/children.js';
import {
  createApiKey,
  reportPossibleOrphanApiKeys,
  deleteApiKey,
  isNotFoundError,
} from './appsync/api-key.js';
import {
  readCurrentState,
  canonicalizeSdl,
  readGraphQLSchema,
  readGraphQLApi,
  userPoolConfigToCfn,
  openIDConnectConfigToCfn,
  lambdaAuthorizerConfigToCfn,
} from './appsync/read-state.js';
import { readDataSource, readResolver, readApiKey, importImpl } from './appsync/read-children.js';

export {
  resetGraphqlApiCreateRetryStateForTests,
  appSyncPhysicalIdFromCfn,
} from './appsync/shared.js';

/**
 * SDK Provider for AWS AppSync resources
 *
 * A direct AppSync SDK provider. Cloud Control manages AWS::AppSync::GraphQLApi
 * correctly (create, update and delete re-measured for issue #4091), so it is
 * NOT a `'cc-broken'` sticky exemption.
 *
 * Supported resource types:
 * - AWS::AppSync::GraphQLApi
 * - AWS::AppSync::GraphQLSchema
 * - AWS::AppSync::DataSource
 * - AWS::AppSync::Resolver
 * - AWS::AppSync::ApiKey
 */
export class AppSyncProvider implements ResourceProvider {
  client: AppSyncClient | undefined;
  createClient: AppSyncClient | undefined;
  s3Client: S3Client | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('AppSyncProvider');
  /**
   * Cache of `apiId -> GraphqlApi ARN` for the lifetime of this provider
   * instance. Populated lazily by `applyTagDiff` and reused on subsequent
   * tag-diff updates against the same API so we don't pay an extra
   * `GetGraphqlApi` round-trip per call. Mirrors the existing
   * `attributeCache` pattern used elsewhere in this provider family.
   *
   * Invalidation: the ARN of a GraphqlApi is stable for the life of the
   * API (it embeds the apiId), so the cache never needs to be invalidated
   * within a process — the only way the ARN changes is if the API itself
   * is replaced, in which case a new `physicalId` flows through `update()`
   * and the old entry simply becomes unreachable.
   */
  arnCache = new Map<string, string>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::AppSync::GraphQLApi',
      new Set([
        'Name',
        'AuthenticationType',
        'XrayEnabled',
        'LogConfig',
        'Tags',
        'AdditionalAuthenticationProviders',
        'ApiType',
        'EnhancedMetricsConfig',
        'EnvironmentVariables',
        'IntrospectionConfig',
        'LambdaAuthorizerConfig',
        'MergedApiExecutionRoleArn',
        'OpenIDConnectConfig',
        'OwnerContact',
        'QueryDepthLimit',
        'ResolverCountLimit',
        'UserPoolConfig',
        'Visibility',
      ]),
    ],
    ['AWS::AppSync::GraphQLSchema', new Set(['ApiId', 'Definition', 'DefinitionS3Location'])],
    [
      'AWS::AppSync::DataSource',
      new Set([
        'ApiId',
        'Name',
        'Type',
        'Description',
        'ServiceRoleArn',
        'DynamoDBConfig',
        'LambdaConfig',
        'HttpConfig',
        // Issue #609 backfill: the 5 remaining DataSource SDK-unwired
        // properties. `ElasticsearchConfig` is the legacy alias for the
        // AMAZON_ELASTICSEARCH data-source type — deprecated by AWS in favor
        // of OpenSearch, but still a live SDK member templates can carry, so
        // it is wired rather than declared unhandledByDesign.
        'ElasticsearchConfig',
        'EventBridgeConfig',
        'MetricsConfig',
        'OpenSearchServiceConfig',
        'RelationalDatabaseConfig',
      ]),
    ],
    [
      'AWS::AppSync::Resolver',
      new Set([
        'ApiId',
        'TypeName',
        'FieldName',
        'DataSourceName',
        'RequestMappingTemplate',
        'ResponseMappingTemplate',
        'Kind',
        'PipelineConfig',
        'Runtime',
        'Code',
        // Issue #609 backfill: the 7 remaining Resolver SDK-unwired
        // properties. The three *S3Location members have NO SDK member —
        // cdkd fetches the S3 object body and inlines it, mirroring
        // CloudFormation (see resolveInlineOrS3Template).
        'CachingConfig',
        'CodeS3Location',
        'MaxBatchSize',
        'MetricsConfig',
        'RequestMappingTemplateS3Location',
        'ResponseMappingTemplateS3Location',
        'SyncConfig',
      ]),
    ],
    ['AWS::AppSync::ApiKey', new Set(['ApiId', 'Description', 'Expires'])],
  ]);
  getClient(): AppSyncClient {
    return getClient.call(this);
  }
  getCreateClient(): AppSyncClient {
    return getCreateClient.call(this);
  }
  buildAppSyncArn(suffix: string, regionOverride?: string): Promise<string> {
    return buildAppSyncArn.call(this, suffix, regionOverride);
  }
  buildAppSyncArnOrWarn(
    suffix: string,
    logicalId: string,
    physicalId: string
  ): Promise<string | undefined> {
    return buildAppSyncArnOrWarn.call(this, suffix, logicalId, physicalId);
  }
  childRefAttributes(
    resourceType: string,
    physicalId: string,
    regionOverride?: string,
    omitArnOnFailure = false
  ): Promise<Record<string, unknown> | undefined> {
    return childRefAttributes.call(
      this,
      resourceType,
      physicalId,
      regionOverride,
      omitArnOnFailure
    );
  }
  childUpdateResult(
    resourceType: string,
    physicalId: string,
    // The composite physical id can carry a secret-derived name
    // (go-to-k/cdkd#4275); absent means unmasked.
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<ResourceUpdateResult> {
    return childUpdateResult.call(this, resourceType, physicalId, mask);
  }
  childImportAttributes(
    resourceType: string,
    physicalId: string,
    region: string
  ): Promise<Record<string, unknown>> {
    return childImportAttributes.call(this, resourceType, physicalId, region);
  }
  getS3Client(): S3Client {
    return getS3Client.call(this);
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
  refuseChangedMalformedGraphQLApiBlocks(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): void {
    return refuseChangedMalformedGraphQLApiBlocks.call(
      this,
      properties,
      previousProperties,
      logicalId,
      physicalId,
      resourceType
    );
  }
  deepEqual(a: unknown, b: unknown): boolean {
    return deepEqual.call(this, a, b);
  }
  unchangedGraphqlApiName(
    apiId: string,
    resourceType: string,
    logicalId: string,
    desired: unknown,
    recorded: unknown,
    mask: MaskerFn
  ): Promise<string> {
    return unchangedGraphqlApiName.call(
      this,
      apiId,
      resourceType,
      logicalId,
      desired,
      recorded,
      mask
    );
  }
  updateGraphQLApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    // Read for the ORIGIN of the desired bag only (`replayingState` /
    // `desiredFromAwsReadback`): it decides whether a malformed nested block
    // refuses (a template-path update) or warns (a rollback revert or
    // `cdkd drift --revert`) — issue #3740.
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateGraphQLApi.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  updateGraphQLSchema(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<ResourceUpdateResult> {
    return updateGraphQLSchema.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask
    );
  }
  updateDataSource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: MaskerFn
  ): Promise<ResourceUpdateResult> {
    return updateDataSource.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask
    );
  }
  updateResolver(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: MaskerFn
  ): Promise<ResourceUpdateResult> {
    return updateResolver.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask
    );
  }
  updateApiKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: MaskerFn
  ): Promise<ResourceUpdateResult> {
    return updateApiKey.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask
    );
  }
  applyTagDiff(
    apiId: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<void> {
    return applyTagDiff.call(this, apiId, resourceType, logicalId, oldTagsRaw, newTagsRaw, mask);
  }
  wrapUpdateError(
    error: unknown,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    subType: string,
    // AWS can quote a child's secret-derived name back (go-to-k/cdkd#4275);
    // absent means unmasked.
    mask: MaskerFn = maskerOrIdentity(undefined),
    // A post-create step's failure (go-to-k/cdkd#2319): no "already exists"
    // restatement, which would read as this resource's collision.
    auxiliary = false
  ): ProvisioningError {
    return wrapUpdateError.call(
      this,
      error,
      resourceType,
      logicalId,
      physicalId,
      subType,
      mask,
      auxiliary
    );
  }
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }
  withheldAwsFailure(
    mask: MaskerFn,
    detail: string,
    summary: string,
    build: (text: string) => ProvisioningError,
    auxiliary = false
  ): ProvisioningError {
    return withheldAwsFailure.call(this, mask, detail, summary, build, auxiliary);
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName);
  }
  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }
  asObject(
    value: unknown,
    path: string,
    options?: ShapeGuardOptions,
    resourceType = 'AWS::AppSync::GraphQLApi'
  ): Record<string, unknown> | undefined {
    return asObject.call(this, value, path, options, resourceType);
  }
  toDeltaSyncTtl(
    value: unknown,
    path: string,
    logicalId: string,
    resourceType: string,
    mask: MaskerFn
  ): number {
    return toDeltaSyncTtl.call(this, value, path, logicalId, resourceType, mask);
  }
  toSdkUserPoolConfig(
    value: unknown,
    path = 'UserPoolConfig',
    options?: ShapeGuardOptions
  ): UserPoolConfig | undefined {
    return toSdkUserPoolConfig.call(this, value, path, options);
  }
  toSdkCognitoUserPoolConfig(
    value: unknown,
    path = 'UserPoolConfig',
    options?: ShapeGuardOptions
  ): CognitoUserPoolConfig | undefined {
    return toSdkCognitoUserPoolConfig.call(this, value, path, options);
  }
  toSdkOpenIDConnectConfig(
    value: unknown,
    path = 'OpenIDConnectConfig',
    options?: ShapeGuardOptions
  ): OpenIDConnectConfig | undefined {
    return toSdkOpenIDConnectConfig.call(this, value, path, options);
  }
  toSdkLambdaAuthorizerConfig(
    value: unknown,
    path = 'LambdaAuthorizerConfig',
    options?: ShapeGuardOptions
  ): LambdaAuthorizerConfig | undefined {
    return toSdkLambdaAuthorizerConfig.call(this, value, path, options);
  }
  toSdkAdditionalAuthProviders(
    value: unknown,
    options?: ShapeGuardOptions
  ): AdditionalAuthenticationProvider[] | undefined {
    return toSdkAdditionalAuthProviders.call(this, value, options);
  }
  toSdkEnhancedMetricsConfig(
    value: unknown,
    options?: ShapeGuardOptions
  ): EnhancedMetricsConfig | undefined {
    return toSdkEnhancedMetricsConfig.call(this, value, options);
  }
  applyGraphQLApiConfig(
    input: CreateGraphqlApiCommandInput | UpdateGraphqlApiCommandInput,
    properties: Record<string, unknown>,
    options?: {
      forUpdate?: boolean;
      previousProperties?: Record<string, unknown>;
      logicalId?: string;
      shapeGuard?: ShapeGuardOptions;
    }
  ): void {
    return applyGraphQLApiConfig.call(this, input, properties, options);
  }
  applyEnvironmentVariables(
    apiId: string,
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties?: Record<string, unknown>,
    replayingState = false,
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<EnvironmentVariablesRecord | undefined> {
    return applyEnvironmentVariables.call(
      this,
      apiId,
      resourceType,
      logicalId,
      properties,
      previousProperties,
      replayingState,
      mask
    );
  }
  environmentVariableRefusal(key: string, value: unknown): string | undefined {
    return environmentVariableRefusal.call(this, key, value);
  }
  withEnvironmentVariablesRecord(
    properties: Record<string, unknown>,
    record: EnvironmentVariablesRecord
  ): Record<string, unknown> {
    return withEnvironmentVariablesRecord.call(this, properties, record);
  }
  toSdkCachingConfig(value: unknown, logicalId: string): CachingConfig | undefined {
    return toSdkCachingConfig.call(this, value, logicalId);
  }
  toSdkSyncConfig(value: unknown, logicalId: string): SyncConfig | undefined {
    return toSdkSyncConfig.call(this, value, logicalId);
  }
  parseS3LocationUrl(
    location: unknown,
    resourceType: string,
    logicalId: string,
    propertyPath: string
  ): { bucket: string; key: string } {
    return parseS3LocationUrl.call(this, location, resourceType, logicalId, propertyPath);
  }
  fetchS3LocationBody(
    location: unknown,
    resourceType: string,
    logicalId: string,
    propertyPath: string,
    // AWS can echo a template value back; absent means unmasked.
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<string> {
    return fetchS3LocationBody.call(this, location, resourceType, logicalId, propertyPath, mask);
  }
  resolveInlineOrS3Template(
    inline: unknown,
    s3Location: unknown,
    inlineKey: string,
    s3Key: string,
    resourceType: string,
    logicalId: string,
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<string | undefined> {
    return resolveInlineOrS3Template.call(
      this,
      inline,
      s3Location,
      inlineKey,
      s3Key,
      resourceType,
      logicalId,
      mask
    );
  }
  applyResolverConfig(
    input: CreateResolverCommandInput | UpdateResolverCommandInput,
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties?: Record<string, unknown>,
    forUpdate = false,
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): Promise<void> {
    return applyResolverConfig.call(
      this,
      input,
      resourceType,
      logicalId,
      properties,
      previousProperties,
      forUpdate,
      mask
    );
  }
  applyDataSourceConfig(
    input: CreateDataSourceCommandInput | UpdateDataSourceCommandInput,
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>,
    mask: MaskerFn
  ): void {
    return applyDataSourceConfig.call(this, input, resourceType, logicalId, properties, mask);
  }
  createGraphQLApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createGraphQLApi.call(this, logicalId, resourceType, properties, context);
  }
  regionArg(
    aws: ReturnType<typeof pasteableAwsCommand>
  ): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
    return regionArg.call(this, aws);
  }
  reportPossibleOrphanApis(
    logicalId: string,
    input: CreateGraphqlApiCommandInput,
    window: AmbiguousCreateWindow,
    mask: MaskerFn,
    returnedId?: string
  ): Promise<void> {
    return reportPossibleOrphanApis.call(this, logicalId, input, window, mask, returnedId);
  }
  deleteGraphQLApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteGraphQLApi.call(this, logicalId, physicalId, resourceType, context);
  }
  createGraphQLSchema(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createGraphQLSchema.call(this, logicalId, resourceType, properties, context);
  }
  createDataSource(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createDataSource.call(this, logicalId, resourceType, properties, context);
  }
  deleteDataSource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteDataSource.call(this, logicalId, physicalId, resourceType, context);
  }
  createResolver(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createResolver.call(this, logicalId, resourceType, properties, context);
  }
  deleteResolver(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteResolver.call(this, logicalId, physicalId, resourceType, context);
  }
  createApiKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createApiKey.call(this, logicalId, resourceType, properties, context);
  }
  reportPossibleOrphanApiKeys(
    logicalId: string,
    input: CreateApiKeyCommandInput,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks
  ): Promise<void> {
    return reportPossibleOrphanApiKeys.call(this, logicalId, input, window, log);
  }
  deleteApiKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteApiKey.call(this, logicalId, physicalId, resourceType, context);
  }
  isNotFoundError(error: unknown): boolean {
    return isNotFoundError.call(this, error);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, properties);
  }
  canonicalizeSdl(sdl: string, source: 'state' | 'aws'): Promise<string> {
    return canonicalizeSdl.call(this, sdl, source);
  }
  readGraphQLSchema(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readGraphQLSchema.call(this, physicalId, properties);
  }
  readGraphQLApi(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readGraphQLApi.call(this, physicalId);
  }
  userPoolConfigToCfn(config: UserPoolConfig | CognitoUserPoolConfig): Record<string, unknown> {
    return userPoolConfigToCfn.call(this, config);
  }
  openIDConnectConfigToCfn(config: OpenIDConnectConfig): Record<string, unknown> {
    return openIDConnectConfigToCfn.call(this, config);
  }
  lambdaAuthorizerConfigToCfn(config: LambdaAuthorizerConfig): Record<string, unknown> {
    return lambdaAuthorizerConfigToCfn.call(this, config);
  }
  readDataSource(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readDataSource.call(this, physicalId);
  }
  readResolver(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readResolver.call(this, physicalId);
  }
  readApiKey(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readApiKey.call(this, physicalId);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
