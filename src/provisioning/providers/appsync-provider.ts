import {
  AppSyncClient,
  CreateGraphqlApiCommand,
  DeleteGraphqlApiCommand,
  CreateDataSourceCommand,
  DeleteDataSourceCommand,
  CreateResolverCommand,
  DeleteResolverCommand,
  CreateApiKeyCommand,
  DeleteApiKeyCommand,
  StartSchemaCreationCommand,
  GetGraphqlApiCommand,
  GetGraphqlApiEnvironmentVariablesCommand,
  PutGraphqlApiEnvironmentVariablesCommand,
  GetDataSourceCommand,
  GetIntrospectionSchemaCommand,
  GetResolverCommand,
  ListApiKeysCommand,
  NotFoundException as AppSyncNotFoundException,
  UpdateGraphqlApiCommand,
  UpdateDataSourceCommand,
  UpdateResolverCommand,
  UpdateApiKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type AdditionalAuthenticationProvider,
  type AuthenticationType,
  type AuthorizationConfig,
  type AuthorizationType,
  type CachingConfig,
  type CognitoUserPoolConfig,
  type ConflictDetectionType,
  type ConflictHandlerType,
  type DataSourceLevelMetricsConfig,
  type DataSourceType,
  type DefaultAction,
  type DeltaSyncConfig,
  type DynamodbDataSourceConfig,
  type ElasticsearchDataSourceConfig,
  type EnhancedMetricsConfig,
  type EventBridgeDataSourceConfig,
  type GraphQLApiIntrospectionConfig,
  type GraphQLApiType,
  type GraphQLApiVisibility,
  type HttpDataSourceConfig,
  type LambdaAuthorizerConfig,
  type OpenIDConnectConfig,
  type OpenSearchServiceDataSourceConfig,
  type RelationalDatabaseDataSourceConfig,
  type RelationalDatabaseSourceType,
  type ResolverLevelMetricsConfig,
  type SyncConfig,
  type UserPoolConfig,
  type CreateGraphqlApiCommandInput,
  type CreateDataSourceCommandInput,
  type CreateResolverCommandInput,
  type CreateApiKeyCommandInput,
  type UpdateGraphqlApiCommandInput,
  type UpdateDataSourceCommandInput,
  type UpdateResolverCommandInput,
  type UpdateApiKeyCommandInput,
} from '@aws-sdk/client-appsync';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parse as graphqlParse, print as graphqlPrint } from 'graphql';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { requireConfigArray } from '../config-shape.js';
import { packCompositeId } from '../composite-id.js';
import { getAccountInfo } from '../../deployment/intrinsic-function-resolver.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * `AWS::AppSync::GraphQLApi` properties that map to a member of
 * `UpdateGraphqlApi` (so a diff on any of them must fire the call).
 *
 * `ApiType` / `Visibility` are excluded on purpose — AWS fixes both at
 * creation and the SDK's update input has no member for either, so a change
 * is a REPLACEMENT (see `src/analyzer/replacement-rules.ts`).
 * `EnvironmentVariables` is excluded because it has its own API pair.
 */
// The five sentinel-less members stay in this list on purpose: their REMOVAL
// has no wire-level effect, but it must still reach `applyGraphQLApiConfig` so
// the user gets the "cannot clear X" warning instead of silence. The cost is
// one no-op UpdateGraphqlApi on a removal-only redeploy.
/**
 * Options for the nested-container shape guards.
 *
 * `onUnusable` is the DOWNGRADE seam: when the properties come from a cdkd
 * STATE record rather than the user's template (a rollback replay), a refusal
 * would leave the resource unrestorable with no template-side remedy, so the
 * caller passes a warn callback instead. Mirrors `config-shape.ts`'s
 * `ConfigStringOptions.onUnusable`.
 */
interface ShapeGuardOptions {
  readonly logicalId?: string;
  readonly onUnusable?: (message: string) => void;
}

const MUTABLE_GRAPHQL_API_CONFIG_PROPERTIES = [
  'UserPoolConfig',
  'OpenIDConnectConfig',
  'LambdaAuthorizerConfig',
  'AdditionalAuthenticationProviders',
  'EnhancedMetricsConfig',
  'IntrospectionConfig',
  'QueryDepthLimit',
  'ResolverCountLimit',
  'OwnerContact',
  'MergedApiExecutionRoleArn',
] as const;

/**
 * SDK Provider for AWS AppSync resources
 *
 * CC API doesn't support Create for AWS::AppSync::GraphQLApi.
 * This provider uses the AppSync SDK directly.
 *
 * Supported resource types:
 * - AWS::AppSync::GraphQLApi
 * - AWS::AppSync::GraphQLSchema
 * - AWS::AppSync::DataSource
 * - AWS::AppSync::Resolver
 * - AWS::AppSync::ApiKey
 */
export class AppSyncProvider implements ResourceProvider {
  private client: AppSyncClient | undefined;
  private s3Client: S3Client | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('AppSyncProvider');
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
  private arnCache = new Map<string, string>();

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
        // Issue #609 backfill: the 5 remaining DataSource silent-drop
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
        // Issue #609 backfill: the 7 remaining Resolver silent-drop
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

  private getClient(): AppSyncClient {
    if (!this.client) {
      this.client = new AppSyncClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Build a child-resource ARN from the deploy's REAL partition / region /
   * account (issue #1681).
   *
   * The three child types record an ARN attribute because CloudFormation's
   * `Ref` for each of them returns the resource ARN (docs-verified 2026-08-12)
   * and `Fn::GetAtt` serves the same value from the same cached map — this
   * provider's `getAttribute` always resolves `undefined`, so the recorded
   * attribute is the ONLY source for both intrinsics.
   *
   * Until #1681 those attributes were string-built as
   * `arn:aws:appsync:*:*:...`, i.e. with literal `*` in the region and account
   * positions, so every consumer received an ARN AWS cannot resolve. Prefer the
   * ARN the create response reports (`dataSourceArn` / `resolverArn`); this
   * helper is for `AWS::AppSync::ApiKey`, whose `CreateApiKey` response carries
   * no ARN field at all, and as the fallback for the other two when a response
   * comes back without one.
   *
   * `getAccountInfo` is the same STS-backed, process-cached resolver
   * `CloudControlProvider` uses for its own ARN reconstruction, so this costs
   * at most one `GetCallerIdentity` per deploy.
   */
  private async buildAppSyncArn(suffix: string, regionOverride?: string): Promise<string> {
    // `regionOverride` is the IMPORT path's region (issue #1728 review):
    // `import.ts` resolves it as `--region || AWS_REGION || 'us-east-1'` and
    // keys the state record by it, which can differ from the client's own
    // configured region (an unset `AWS_REGION` with a profile region set). The
    // create / update paths pass nothing and keep deriving it from the client,
    // which is the region their AWS calls actually went to.
    const region =
      regionOverride ?? this.providerRegion ?? (await this.getClient().config.region());
    const accountInfo = await getAccountInfo(region);
    // REFUSE a fabricated account rather than building an ARN from it (issue
    // #1728 review). `getAccountInfo` CATCHES its own STS failure and answers
    // the hardcoded `123456789012`, so without this the build "succeeds" and
    // every caller persists `arn:aws:appsync:<region>:123456789012:...` — a
    // value carrying no wildcard, therefore invisible to `isPlaceholderArn`,
    // therefore handed to consumers as if it were real.
    //
    // It lives HERE rather than at the import call site because the UPDATE path
    // is the worse of the two: `childRefAttributes` rebuilds the ARN on every
    // in-place update, so an STS blip mid-deploy would REPLACE a correct,
    // create-time-recorded ARN with the fabricated one — destroying a known-good
    // value, where import merely fails to write a missing one. Every caller
    // already has a degradation arm for a failed build; this just makes them
    // reachable for the failure mode that actually occurs.
    if (accountInfo.fabricated) {
      throw new Error(
        `cannot determine the AWS account (STS is unreachable, and the resolved ` +
          `account id is a placeholder), so an ARN for ${suffix} would be fabricated`
      );
    }
    // The PARTITION comes from the region, NOT from `accountInfo.partition` —
    // that field is hardcoded to `'aws'` (`intrinsic-function-resolver.ts`,
    // with its own "Could be aws-cn, aws-us-gov, etc." admission). Using it
    // would be inert on the create path (AWS reports the real ARN there) but
    // actively WRONG on the update path, where `childRefAttributes` rebuilds
    // the ARN on every in-place update: a correct `arn:aws-cn:` /
    // `arn:aws-us-gov:` value recorded at create time would be overwritten
    // with `arn:aws:`. `derivePartitionAndUrlSuffix` is the closed mapping the
    // repo already uses for `${AWS::Partition}`.
    const { partition } = derivePartitionAndUrlSuffix(accountInfo.region);
    return `arn:${partition}:appsync:${accountInfo.region}:${accountInfo.accountId}:${suffix}`;
  }

  /**
   * {@link buildAppSyncArn} for the POST-CREATE sites, where throwing is not an
   * option (issue #1681 PR review).
   *
   * Moving the ARN build outside the create `try` stops a failure being
   * re-labelled as a creation failure — but on its own it does NOT stop the
   * resource being orphaned: `create()` still throws, the engine still journals
   * no physicalId for a failed CREATE, and the resource still sits in AWS
   * untracked (the issue #1710 class). Since the ARN is bookkeeping and the
   * resource already exists, the honest answer is to never fail the create for
   * it: warn, omit the attribute, and let `Ref` fall back to the compound id
   * exactly as it does for an imported child. The resource's next update heals
   * the record via `childRefAttributes`.
   */
  private async buildAppSyncArnOrWarn(
    suffix: string,
    logicalId: string,
    physicalId: string
  ): Promise<string | undefined> {
    try {
      return await this.buildAppSyncArn(suffix);
    } catch (error) {
      this.logger.warn(
        `Created ${logicalId} (${physicalId}) but could not build its ARN attribute: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Ref will resolve to the compound physical id until the next update.`
      );
      return undefined;
    }
  }

  /**
   * Rebuild a child type's COMPLETE attribute set from its compound physical id
   * (issue #1681), for the update path to return.
   *
   * This is what heals a record written by a pre-#1681 binary. `update()`
   * previously returned no attributes, and the deploy engine carries the
   * existing ones forward when a provider reports none — so without this a
   * resource created before the fix would keep its `arn:aws:appsync:*:*:...`
   * placeholder for the rest of its life, since only a REPLACEMENT re-runs
   * `create()`. `Fn::GetAtt` reads the same cached map, so the placeholder was
   * breaking that intrinsic too, independently of the `Ref` defect #1681 is
   * about.
   *
   * It must return EVERY key the create path records, not just the ARN: an
   * `attributes` map returned from `update()` REPLACES the record's map
   * wholesale rather than merging into it (`deploy-engine.ts`), so a partial
   * answer would silently drop `Name` / `ApiKey`.
   *
   * Returns `undefined` for an id whose arity does not match the type — a
   * record that malformed cannot be healed by guessing, and carrying the
   * existing attributes forward is the safe answer.
   *
   * `omitArnOnFailure` is for the IMPORT path only (issue #1728 review). The
   * non-ARN keys — `Name`, `ApiKey` — are split straight out of the physical id
   * and involve no account at all, so dropping them because the ACCOUNT could
   * not be resolved would fail `Fn::GetAtt Name` for a reason that has nothing
   * to do with it. Import has no prior record to preserve, so keeping what it
   * can beats keeping nothing. `update()` must NOT pass it: there a partial map
   * replaces the record's wholesale and would delete a good ARN.
   */
  private async childRefAttributes(
    resourceType: string,
    physicalId: string,
    regionOverride?: string,
    omitArnOnFailure = false
  ): Promise<Record<string, unknown> | undefined> {
    const parts = physicalId.split('|');
    // Resolves to the ARN, or to `undefined` when the build refused AND the
    // caller opted into omitting it. A refusal with the flag unset propagates.
    const arn = async (suffix: string): Promise<string | undefined> => {
      try {
        return await this.buildAppSyncArn(suffix, regionOverride);
      } catch (error) {
        if (!omitArnOnFailure) throw error;
        this.logger.warn(
          `Imported ${resourceType} (${physicalId}) but its ARN attribute was NOT ` +
            `recorded: ${error instanceof Error ? error.message : String(error)}. ` +
            `Ref will resolve to the compound physical id, and Fn::GetAtt on the ARN ` +
            `will fail, until the resource's next update heals the record.`
        );
        return undefined;
      }
    };
    if (resourceType === 'AWS::AppSync::DataSource' && parts.length === 2) {
      const [apiId, name] = parts as [string, string];
      const dataSourceArn = await arn(`apis/${apiId}/datasources/${name}`);
      return { ...(dataSourceArn && { DataSourceArn: dataSourceArn }), Name: name };
    }
    if (resourceType === 'AWS::AppSync::Resolver' && parts.length === 3) {
      const [apiId, typeName, fieldName] = parts as [string, string, string];
      const resolverArn = await arn(`apis/${apiId}/types/${typeName}/resolvers/${fieldName}`);
      return { ...(resolverArn && { ResolverArn: resolverArn }) };
    }
    if (resourceType === 'AWS::AppSync::ApiKey' && parts.length === 2) {
      const [apiId, apiKeyId] = parts as [string, string];
      const apiKeyArn = await arn(`apis/${apiId}/apikey/${apiKeyId}`);
      return { ApiKey: apiKeyId, ...(apiKeyArn && { Arn: apiKeyArn }) };
    }
    return undefined;
  }

  /**
   * The no-replacement update result for a child type, carrying the healed
   * attribute set (issue #1681). Reporting none is still the correct answer for
   * an unhealable id — the engine then carries the existing attributes forward.
   *
   * An ARN that cannot be built takes the SAME answer, and it must (issue #1728
   * review). An `update()` attribute map REPLACES the record's wholesale, so
   * reporting a partial set here would DELETE the ARN a previous deploy
   * correctly recorded; reporting none carries it forward untouched. That is
   * why this arm differs from the import one below, which has no prior record
   * to preserve and therefore keeps what it can.
   */
  private async childUpdateResult(
    resourceType: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    let attributes: Record<string, unknown> | undefined;
    try {
      attributes = await this.childRefAttributes(resourceType, physicalId);
    } catch (error) {
      this.logger.warn(
        `Updated ${resourceType} (${physicalId}) but could not rebuild its ARN attribute: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `The previously recorded attributes are kept.`
      );
    }
    return { physicalId, wasReplaced: false, ...(attributes && { attributes }) };
  }

  /**
   * The child attribute set for an ADOPTED resource (issue #1728).
   *
   * `import()` used to record `attributes: {}` for every child type, so a child
   * adopted via `cdkd import` had no ARN in state and the resolver's
   * `REF_RETURNS_ARN_FROM_STATE` lookup missed — `Ref` fell back to the raw
   * compound id, i.e. the pre-#1681 behavior, and `Fn::GetAtt DataSourceArn` /
   * `ResolverArn` / `Arn` were equally unresolved. The record healed only on the
   * resource's next UPDATE (#1727), so an imported-and-untouched child stayed
   * broken indefinitely.
   *
   * RECONSTRUCTED rather than read back from AWS. Every segment is already in
   * the physical id the import receives, `childRefAttributes` is the SAME
   * mapping `create()` / `update()` use (so the three spellings cannot drift),
   * and the reconstruction costs one process-cached STS call instead of one
   * DescribeApi-family call per imported child. A readback would be
   * authoritative but cannot be more correct for a well-formed id: `import`
   * adopts a resource in the caller's own account, which is exactly the context
   * `buildAppSyncArn` derives from.
   *
   * Never throws: a failure degrades to `{}` (or to the account-independent
   * keys — see `omitArnOnFailure`), which is at worst the exact pre-#1728
   * behavior, because adopting the resource is worth more than its bookkeeping
   * attribute. `childRefAttributes` already answers `undefined` for a mis-arity
   * id, which degrades the same way rather than guessing.
   *
   * The fabricated-account refusal that makes this honest lives in
   * `buildAppSyncArn`, not here (issue #1728 review): the UPDATE path rebuilds
   * the ARN on every in-place update, so an STS blip there would REPLACE a
   * correct recorded ARN rather than merely fail to write one. Guarding only
   * this call site would have left the worse path open. The fabrication itself
   * is issue #1730.
   */
  private async childImportAttributes(
    resourceType: string,
    physicalId: string,
    region: string
  ): Promise<Record<string, unknown>> {
    try {
      // The region comes from the IMPORT input, not from the client: `import.ts`
      // resolves it as `--region || AWS_REGION || 'us-east-1'` and keys the
      // state record by it, so deriving it from the client's own config can
      // record an ARN naming a different region than the record it sits in.
      // (When neither is set that resolution is itself a default, so the ARN
      // names the same region the state key does — misregioned together rather
      // than against each other.)
      //
      // `omitArnOnFailure`: a fabricated account costs the ARN, not the whole
      // attribute set — `Name` / `ApiKey` come out of the physical id and are
      // account-independent.
      return (await this.childRefAttributes(resourceType, physicalId, region, true)) ?? {};
    } catch (error) {
      this.logger.warn(
        `Imported ${resourceType} (${physicalId}) but could not build its ARN attribute: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Ref will resolve to the compound physical id, and Fn::GetAtt on the ARN will ` +
          `fail, until the resource's next update heals the record.`
      );
      return {};
    }
  }

  /**
   * Lazy S3 client for the `*S3Location` properties (Resolver
   * `CodeS3Location` / `RequestMappingTemplateS3Location` /
   * `ResponseMappingTemplateS3Location`, GraphQLSchema
   * `DefinitionS3Location`) — CloudFormation reads the S3 object and inlines
   * its body, and cdkd mirrors that. Same construction as
   * `StepFunctionsProvider.getS3Client` (the sibling `DefinitionS3Location`
   * implementation).
   */
  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.s3Client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.createGraphQLApi(logicalId, resourceType, properties, context);
      case 'AWS::AppSync::GraphQLSchema':
        return this.createGraphQLSchema(logicalId, resourceType, properties);
      case 'AWS::AppSync::DataSource':
        return this.createDataSource(logicalId, resourceType, properties, context);
      case 'AWS::AppSync::Resolver':
        return this.createResolver(logicalId, resourceType, properties, context);
      case 'AWS::AppSync::ApiKey':
        return this.createApiKey(logicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  /**
   * Update an AppSync resource in-place via the SDK's `Update*` calls.
   *
   * Per-type API path:
   *   - `GraphQLApi`   → `UpdateGraphqlApiCommand` (`AuthenticationType` /
   *     `XrayEnabled` / `LogConfig`) + `TagResource` / `UntagResource`
   *     for `Tags` diff. `Name` is immutable on AWS.
   *   - `DataSource`   → `UpdateDataSourceCommand` (`Description` /
   *     `ServiceRoleArn` / the per-type configs — `DynamoDBConfig` /
   *     `LambdaConfig` / `HttpConfig` / `ElasticsearchConfig` /
   *     `OpenSearchServiceConfig` / `EventBridgeConfig` /
   *     `RelationalDatabaseConfig` — / `MetricsConfig`).
   *     `ApiId` / `Name` / `Type` are immutable identity fields.
   *   - `Resolver`     → `UpdateResolverCommand` (`DataSourceName` /
   *     `RequestMappingTemplate` / `ResponseMappingTemplate` / `Kind` /
   *     `PipelineConfig` / `Runtime` / `Code` / `CachingConfig` /
   *     `SyncConfig` / `MaxBatchSize` / `MetricsConfig` + the three
   *     `*S3Location` fetch-and-inline pairs). `ApiId` / `TypeName` /
   *     `FieldName` are immutable identity fields.
   *   - `ApiKey`       → `UpdateApiKeyCommand` (`Description` / `Expires`).
   *     `ApiId` is immutable; the AWS-generated key id is immutable.
   *   - `GraphQLSchema` → `StartSchemaCreationCommand` (re-upload the
   *     SDL; this is the canonical AppSync schema-update path).
   *
   * Every Update* call uses `!== undefined` field gates per
   * memory rule `feedback_update_optional_field_undefined_check.md` so
   * `cdkd drift --revert` can clear a console-side ADD via an empty
   * string / 0 / false. Identity / immutable field changes throw
   * `ResourceUpdateNotSupportedError` as defense-in-depth — the deploy
   * engine's replacement-detection layer should normally route those
   * through CREATE+DELETE.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.updateGraphQLApi(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::AppSync::GraphQLSchema':
        return this.updateGraphQLSchema(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::AppSync::DataSource':
        return this.updateDataSource(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::AppSync::Resolver':
        return this.updateResolver(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::AppSync::ApiKey':
        return this.updateApiKey(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── update helpers ────────────────────────────────────────────────

  /**
   * Structural equality for the small object / array shapes that ride on
   * AppSync update inputs. `JSON.stringify` is sufficient because none of
   * these shapes contain `undefined` keys at this layer (the create /
   * readCurrentState paths filter them out).
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private async updateGraphQLApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // `Name` is immutable on AWS — UpdateGraphqlApi REQUIRES `name` in the
    // input shape but rejects any value other than the existing one.
    // Replacement-detection should have routed the diff through
    // CREATE+DELETE; defense-in-depth here.
    if (
      properties['Name'] !== undefined &&
      previousProperties['Name'] !== undefined &&
      properties['Name'] !== previousProperties['Name']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'AWS AppSync GraphqlApi.Name is immutable — destroy + redeploy to rename'
      );
    }

    // `ApiType` / `Visibility` have NO member on `UpdateGraphqlApi` — AWS
    // fixes both at creation. `src/analyzer/replacement-rules.ts` classifies
    // them as replacement properties so the engine routes the change through
    // CREATE+DELETE; this is defense-in-depth for the direct-update path.
    for (const immutable of ['ApiType', 'Visibility']) {
      if (
        properties[immutable] !== undefined &&
        previousProperties[immutable] !== undefined &&
        properties[immutable] !== previousProperties[immutable]
      ) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS AppSync GraphqlApi.${immutable} is immutable — destroy + redeploy to change it`
        );
      }
    }

    // Build UpdateGraphqlApi input only when a mutable field diffs. `Name`
    // is REQUIRED by the SDK input shape even on no-op updates, so we
    // include it whenever we issue the call.
    //
    // Diff helpers below use explicit "is the field present on either
    // side AND do the resolved values differ?" semantics so that:
    //   - `undefined -> undefined` does NOT fire an update (the M1 fix
    //     against firing UpdateGraphqlApi on every redeploy of an API
    //     that never set XrayEnabled);
    //   - `defined -> undefined` (= the user removed the field from the
    //     template, or `cdkd drift --revert` is clearing a console add)
    //     DOES fire an update so the clearing side effect lands on AWS.
    const newAuthType = properties['AuthenticationType'] as AuthenticationType | undefined;
    const oldAuthType = previousProperties['AuthenticationType'] as AuthenticationType | undefined;
    const newXray = properties['XrayEnabled'] as boolean | undefined;
    const oldXray = previousProperties['XrayEnabled'] as boolean | undefined;
    const newLog = properties['LogConfig'] as Record<string, unknown> | undefined;
    const oldLog = previousProperties['LogConfig'] as Record<string, unknown> | undefined;

    const hasXrayDiff =
      ('XrayEnabled' in properties || 'XrayEnabled' in previousProperties) && newXray !== oldXray;
    const hasAuthDiff =
      ('AuthenticationType' in properties || 'AuthenticationType' in previousProperties) &&
      newAuthType !== oldAuthType;
    const hasLogDiff =
      ('LogConfig' in properties || 'LogConfig' in previousProperties) &&
      !this.deepEqual(newLog, oldLog);
    // The remaining mutable members of UpdateGraphqlApi. Same
    // present-on-either-side-AND-differs semantics as the three above, so a
    // REMOVAL still fires the call and reaches the reset sentinels in
    // `applyGraphQLApiConfig`.
    const hasConfigDiff = MUTABLE_GRAPHQL_API_CONFIG_PROPERTIES.some(
      (key) =>
        (key in properties || key in previousProperties) &&
        !this.deepEqual(properties[key], previousProperties[key])
    );
    const wantUpdate = hasAuthDiff || hasXrayDiff || hasLogDiff || hasConfigDiff;

    if (wantUpdate) {
      const input: UpdateGraphqlApiCommandInput = {
        apiId: physicalId,
        // Name is required by the SDK input; use the existing value
        // (state-recorded name) since Name is immutable above.
        name: (properties['Name'] ?? previousProperties['Name']) as string,
        // authenticationType is required by the SDK input shape; carry the
        // existing value through when the diff didn't include it so the
        // call shape is always valid.
        authenticationType: (newAuthType ?? oldAuthType ?? 'API_KEY') as AuthenticationType,
      };
      if (newXray !== undefined) input.xrayEnabled = newXray;
      // LogConfig has three meaningful states on update:
      //   (a) newLog is a populated object → set logConfig to the new shape.
      //   (b) newLog === undefined AND oldLog was set → user removed the
      //       field (or drift --revert is clearing a console add). AWS's
      //       UpdateGraphqlApi has NO sentinel for "drop logConfig" — omitting
      //       the field on the SDK input is treated as "no change" by the
      //       service. The canonical way to disable logging is
      //       `FieldLogLevel: NONE`, which AWS accepts as effectively-off and
      //       which leaves no further side effect. cloudWatchLogsRoleArn is
      //       still required by the input shape; reuse the existing role ARN
      //       so the call shape stays valid (the role is never actually
      //       invoked while FieldLogLevel=NONE).
      //   (c) newLog === undefined AND oldLog also undefined → no diff, no
      //       branch taken (gated above).
      if (newLog !== undefined) {
        input.logConfig = {
          cloudWatchLogsRoleArn: newLog['CloudWatchLogsRoleArn'] as string,
          fieldLogLevel: newLog['FieldLogLevel'] as 'NONE' | 'ERROR' | 'ALL',
          excludeVerboseContent: newLog['ExcludeVerboseContent'] as boolean | undefined,
        };
      } else if (oldLog !== undefined) {
        const existingRoleArn = oldLog['CloudWatchLogsRoleArn'] as string | undefined;
        if (existingRoleArn) {
          input.logConfig = {
            cloudWatchLogsRoleArn: existingRoleArn,
            fieldLogLevel: 'NONE',
          };
        } else {
          // No existing role ARN to reuse → we cannot construct a valid
          // UpdateGraphqlApi.logConfig (cloudWatchLogsRoleArn is required).
          // Warn loudly: the user removed the field but cdkd cannot push
          // the clearing call to AWS; state still records the removal.
          this.logger.warn(
            `AppSync GraphqlApi ${logicalId}: cannot clear LogConfig — previous state has no CloudWatchLogsRoleArn to reuse for the disable call`
          );
        }
      }
      this.applyGraphQLApiConfig(input, properties, {
        forUpdate: true,
        previousProperties,
        logicalId,
        // An UPDATE's desired bag is a STATE record whenever the rollback
        // executor or `drift --revert` replays it, so a malformed nested block
        // warns rather than making the resource un-rollbackable.
        shapeGuard: {
          logicalId,
          onUnusable: (message: string) =>
            this.logger.warn(`${message} (leaving the live value untouched)`),
        },
      });
      try {
        await this.getClient().send(new UpdateGraphqlApiCommand(input));
      } catch (error) {
        throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'GraphqlApi');
      }
    }

    // Separate API pair — diffs itself, so it runs whether or not the
    // UpdateGraphqlApi call above fired.
    await this.applyEnvironmentVariables(
      physicalId,
      resourceType,
      logicalId,
      properties,
      previousProperties
    );

    // Tags diff via TagResource / UntagResource. The API key is the
    // GraphqlApi ARN — recover it from a GetGraphqlApi call.
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
      properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
    );

    // `attributes` is deliberately OMITTED, not `{}`: the deploy engine
    // treats a PRESENT attributes object as authoritative
    // (`result.attributes ?? currentResource.attributes`), so returning an
    // empty one WIPES the create-time ApiId / Arn / GraphQLUrl and every
    // later `Fn::GetAtt` degrades to the physical-id fallback — observed
    // live: the stack's GraphQLApiUrl output broke on the first in-place
    // update of the API.
    return {
      physicalId,
      wasReplaced: false,
    };
  }

  private async updateGraphQLSchema(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // ApiId is immutable identity — physicalId tracks it. The mutable
    // surface is `Definition` (the SDL body) or its S3-sourced sibling
    // `DefinitionS3Location`. `StartSchemaCreation` re-uploads the SDL;
    // AWS rebuilds the schema asynchronously. `DefinitionS3Location` is
    // write-only (see getDriftUnknownPaths) and not round-trippable, so its
    // diff is on the URL: a changed URL re-fetches and re-uploads, an
    // unchanged URL is a no-op even if the S3 object content changed (CFn
    // parity — the template did not change, and CDK assets bake the content
    // hash into the key anyway). Inline `Definition` wins when both are set,
    // matching the create path.
    const newDef = properties['Definition'] as string | undefined;
    const oldDef = previousProperties['Definition'] as string | undefined;
    const newLoc = properties['DefinitionS3Location'];
    const oldLoc = previousProperties['DefinitionS3Location'];

    let definition: string | undefined;
    if (newDef !== undefined) {
      if (newLoc !== undefined) {
        // Same both-set warning the create path emits — inline wins.
        this.logger.warn(
          `${resourceType} ${logicalId}: both Definition and DefinitionS3Location are set — ` +
            'using the inline Definition and ignoring DefinitionS3Location (CFn treats them as alternatives)'
        );
      }
      if (newDef === oldDef) {
        return { physicalId, wasReplaced: false };
      }
      definition = newDef;
    } else if (newLoc !== undefined) {
      if (this.deepEqual(newLoc, oldLoc)) {
        return { physicalId, wasReplaced: false };
      }
      definition = await this.fetchS3LocationBody(
        newLoc,
        resourceType,
        logicalId,
        'DefinitionS3Location'
      );
    } else {
      return { physicalId, wasReplaced: false };
    }

    const apiId = (properties['ApiId'] ?? physicalId) as string;
    try {
      await this.getClient().send(
        new StartSchemaCreationCommand({
          apiId,
          definition: Buffer.from(definition, 'utf-8'),
        })
      );
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'GraphqlSchema');
    }
    return { physicalId, wasReplaced: false };
  }

  private async updateDataSource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Identity fields are immutable: ApiId / Name / Type. Reject diffs in
    // defense-in-depth against a missing replacement-rule entry.
    for (const field of ['ApiId', 'Name', 'Type'] as const) {
      const next = properties[field];
      const prev = previousProperties[field];
      if (next !== undefined && prev !== undefined && next !== prev) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS AppSync DataSource.${field} is immutable — destroy + redeploy to change`
        );
      }
    }

    const [apiId, name] = physicalId.split('|');
    if (!apiId || !name) {
      throw new ProvisioningError(
        `Invalid DataSource physical ID format: ${physicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // `UpdateDataSource` REQUIRES `apiId`, `name`, and `type` on every call.
    // Type is immutable; use the state-recorded value.
    const type = (properties['Type'] ?? previousProperties['Type']) as DataSourceType;

    // Present-on-either-side AND differs, so a REMOVAL (defined -> undefined)
    // still fires the call. `UpdateDataSource` is a FULL-REPLACE write: the
    // input below carries the whole desired config, and a member the
    // template dropped is simply omitted — AppSync clears it server-side, so
    // no reset sentinel is needed (see `applyDataSourceConfig`).
    const mutableKeys = [
      'Description',
      'ServiceRoleArn',
      'DynamoDBConfig',
      'LambdaConfig',
      'HttpConfig',
      'ElasticsearchConfig',
      'OpenSearchServiceConfig',
      'EventBridgeConfig',
      'RelationalDatabaseConfig',
      'MetricsConfig',
    ] as const;

    const wantUpdate = mutableKeys.some(
      (key) =>
        (key in properties || key in previousProperties) &&
        !this.deepEqual(properties[key], previousProperties[key])
    );

    if (!wantUpdate) {
      return this.childUpdateResult(resourceType, physicalId);
    }

    const input: UpdateDataSourceCommandInput = {
      apiId,
      name,
      type,
    };
    // Shared with createDataSource so create and update cannot diverge.
    this.applyDataSourceConfig(input, resourceType, logicalId, properties);

    try {
      await this.getClient().send(new UpdateDataSourceCommand(input));
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'DataSource');
    }

    return this.childUpdateResult(resourceType, physicalId);
  }

  private async updateResolver(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Identity fields are immutable: ApiId / TypeName / FieldName.
    for (const field of ['ApiId', 'TypeName', 'FieldName'] as const) {
      const next = properties[field];
      const prev = previousProperties[field];
      if (next !== undefined && prev !== undefined && next !== prev) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS AppSync Resolver.${field} is immutable — destroy + redeploy to change`
        );
      }
    }

    const parts = physicalId.split('|');
    if (parts.length < 3) {
      throw new ProvisioningError(
        `Invalid Resolver physical ID format: ${physicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const [apiId, typeName, fieldName] = parts;

    // Present-on-either-side AND differs, so a REMOVAL (defined -> undefined)
    // still fires the call. `UpdateResolver` is a FULL-REPLACE write — an
    // omitted member is cleared server-side — so no reset sentinels are
    // needed (see `applyResolverConfig`). An `*S3Location` URL change fires
    // an update too; an unchanged URL whose S3 OBJECT content changed is not
    // detected (CFn parity: the template did not change, and CDK assets bake
    // the content hash into the key anyway).
    const mutableKeys = [
      'DataSourceName',
      'RequestMappingTemplate',
      'ResponseMappingTemplate',
      'Kind',
      'PipelineConfig',
      'Runtime',
      'Code',
      'CachingConfig',
      'SyncConfig',
      'MaxBatchSize',
      'MetricsConfig',
      'CodeS3Location',
      'RequestMappingTemplateS3Location',
      'ResponseMappingTemplateS3Location',
    ] as const;

    const wantUpdate = mutableKeys.some(
      (key) =>
        (key in properties || key in previousProperties) &&
        !this.deepEqual(properties[key], previousProperties[key])
    );

    if (!wantUpdate) {
      return this.childUpdateResult(resourceType, physicalId);
    }

    const input: UpdateResolverCommandInput = {
      apiId: apiId as string,
      typeName: typeName as string,
      fieldName: fieldName as string,
    };

    // Shared with createResolver so create and update cannot diverge; the
    // `Kind` discriminator gating (never forward `dataSourceName` on a
    // PIPELINE resolver) lives inside the mapper, with the state-recorded
    // previous `Kind` as the fallback. Same shape as readCurrentState's
    // discriminator handling per memory rule
    // feedback_always_emit_check_type_discriminator.
    await this.applyResolverConfig(
      input,
      resourceType,
      logicalId,
      properties,
      previousProperties,
      true
    );

    try {
      await this.getClient().send(new UpdateResolverCommand(input));
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'Resolver');
    }

    return this.childUpdateResult(resourceType, physicalId);
  }

  private async updateApiKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // ApiId is immutable identity.
    if (
      properties['ApiId'] !== undefined &&
      previousProperties['ApiId'] !== undefined &&
      properties['ApiId'] !== previousProperties['ApiId']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'AWS AppSync ApiKey.ApiId is immutable — destroy + redeploy to change'
      );
    }

    const [apiId, apiKeyId] = physicalId.split('|');
    if (!apiId || !apiKeyId) {
      throw new ProvisioningError(
        `Invalid ApiKey physical ID format: ${physicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const newDesc = properties['Description'] as string | undefined;
    const oldDesc = previousProperties['Description'] as string | undefined;
    const newExp = properties['Expires'] as number | undefined;
    const oldExp = previousProperties['Expires'] as number | undefined;

    if (newDesc === oldDesc && newExp === oldExp) {
      return this.childUpdateResult(resourceType, physicalId);
    }

    const input: UpdateApiKeyCommandInput = {
      apiId,
      id: apiKeyId,
    };
    if (newDesc !== undefined) input.description = newDesc;
    if (newExp !== undefined) input.expires = newExp;

    try {
      await this.getClient().send(new UpdateApiKeyCommand(input));
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'ApiKey');
    }

    return this.childUpdateResult(resourceType, physicalId);
  }

  /**
   * Apply a Tags diff to a GraphqlApi via TagResource / UntagResource.
   *
   * Tags are keyed by the GraphqlApi ARN — recover it from
   * `GetGraphqlApi`. Failure to recover the ARN is a hard error (the API
   * itself just changed) rather than a silent drop, so the user knows
   * the tag diff was not applied.
   */
  private async applyTagDiff(
    apiId: string,
    resourceType: string,
    logicalId: string,
    oldTags: Array<{ Key?: string; Value?: string }> | undefined,
    newTags: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const oldMap = this.tagsToMap(oldTags ?? []);
    const newMap = this.tagsToMap(newTags ?? []);
    if (this.deepEqual(oldMap, newMap)) return;

    let arn = this.arnCache.get(apiId);
    if (!arn) {
      try {
        const resp = await this.getClient().send(new GetGraphqlApiCommand({ apiId }));
        arn = resp.graphqlApi?.arn;
      } catch (error) {
        throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi');
      }
      if (!arn) {
        throw new ProvisioningError(
          `Could not resolve ARN for AppSync GraphqlApi ${apiId} to apply tags diff`,
          resourceType,
          logicalId,
          apiId
        );
      }
      this.arnCache.set(apiId, arn);
    }

    const tagKeysToRemove = Object.keys(oldMap).filter((k) => !(k in newMap));
    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of Object.entries(newMap)) {
      if (oldMap[k] !== v) tagsToAdd[k] = v;
    }

    if (tagKeysToRemove.length > 0) {
      try {
        await this.getClient().send(
          new UntagResourceCommand({
            resourceArn: arn,
            tagKeys: tagKeysToRemove,
          })
        );
      } catch (error) {
        throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi (untag)');
      }
    }
    if (Object.keys(tagsToAdd).length > 0) {
      try {
        await this.getClient().send(
          new TagResourceCommand({
            resourceArn: arn,
            tags: tagsToAdd,
          })
        );
      } catch (error) {
        throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi (tag)');
      }
    }
  }

  private tagsToMap(tags: Array<{ Key?: string; Value?: string }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of tags) {
      if (t.Key !== undefined && t.Value !== undefined) {
        out[t.Key] = t.Value;
      }
    }
    return out;
  }

  private wrapUpdateError(
    error: unknown,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    subType: string
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `Failed to update AppSync ${subType} ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.deleteGraphQLApi(logicalId, physicalId, resourceType, context);
      case 'AWS::AppSync::GraphQLSchema':
        // Schema is deleted with the API, no-op
        this.logger.debug(`Schema ${logicalId} is deleted with its API, skipping`);
        return;
      case 'AWS::AppSync::DataSource':
        return this.deleteDataSource(logicalId, physicalId, resourceType, context);
      case 'AWS::AppSync::Resolver':
        return this.deleteResolver(logicalId, physicalId, resourceType, context);
      case 'AWS::AppSync::ApiKey':
        return this.deleteApiKey(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    this.logger.debug(`getAttribute for ${resourceType} ${physicalId}: ${attributeName}`);
    return Promise.resolve(undefined);
  }

  /**
   * Per-type drift-unknown paths for AppSync resources.
   *
   * `AWS::AppSync::GraphQLSchema.DefinitionS3Location` is a write-only
   * input — at create time AppSync downloads the S3 object and stores
   * the SDL body internally; `GetIntrospectionSchema` returns only the
   * SDL bytes, never the original S3 URL. State templates that pin
   * `DefinitionS3Location` would otherwise fire false drift on every
   * run since `readCurrentState` returns `Definition` (the canonical
   * SDL) instead. This is the same pattern as Lambda `Code` /
   * SecretsManager `SecretString` (write-only via S3 / unrecoverable
   * via the read API).
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::AppSync::GraphQLSchema') {
      return ['DefinitionS3Location'];
    }
    // Same rationale as `DefinitionS3Location` above: at create time AppSync
    // receives the RESOLVED body (cdkd fetches the S3 object and passes it as
    // `code` / `requestMappingTemplate` / `responseMappingTemplate`), and
    // `GetResolver` returns only that body — never the original S3 URL. A
    // state template pinning any of the three would otherwise fire false
    // drift on every run.
    if (resourceType === 'AWS::AppSync::Resolver') {
      return [
        'CodeS3Location',
        'RequestMappingTemplateS3Location',
        'ResponseMappingTemplateS3Location',
      ];
    }
    return [];
  }

  // ─── AWS::AppSync::GraphQLApi config-block converters ──────────────
  //
  // Every block below is hand-mapped member-by-member rather than
  // machine-cased: the AppSync SDK model is camelCase but carries
  // irregular members the mechanical first-letter flip would miss
  // (`openIDConnectConfig`, `iatTTL`, `authTTL`), and the AWS SDK v3
  // serializer silently DROPS unknown members — so a near-miss spelling
  // is a silent config drop, not an error (the #1370 class).

  /**
   * Read a nested config container.
   *
   * A present-but-NOT-an-object value (an unresolved intrinsic, a mis-nested
   * L1, a string where the template meant a block) must never fall through as
   * "absent" — that reintroduces the very silent-drop class this batch closes
   * (see `src/provisioning/config-shape.ts`'s "Never infer a default from a
   * possibly-malformed value"). An ABSENT container keeps returning
   * `undefined`, which is a legitimate "not configured".
   */
  private asObject(
    value: unknown,
    path: string,
    options?: ShapeGuardOptions,
    resourceType = 'AWS::AppSync::GraphQLApi'
  ): Record<string, unknown> | undefined {
    if (value == null) return undefined;
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    const message =
      `${resourceType} ${path} must be an object, got ` +
      `${Array.isArray(value) ? 'array' : typeof value} — cdkd refuses to drop it silently`;
    // A STATE replay (the rollback executor's reverse-replacement arm) has no
    // template-side remedy, so the refusal downgrades to a warning there —
    // otherwise the old resource becomes unrestorable. Same contract as
    // `replayWarn` in config-shape.ts; see .claude/rules/providers.md.
    if (options?.onUnusable) {
      options.onUnusable(message);
      return undefined;
    }
    throw new ProvisioningError(message, resourceType, options?.logicalId ?? '');
  }

  /**
   * CFn declares `DeltaSyncConfig.BaseTableTTL` / `.DeltaSyncTableTTL` as
   * STRINGS (CDK's L1 types them `string` too) while the SDK models both as
   * longs, so the value needs a real conversion rather than a cast — a string
   * handed to the number member is dropped by the serializer, which is the
   * silent-drop shape this batch closes.
   *
   * A non-numeric value is refused LOUDLY: `Number('abc')` is `NaN`, and NaN
   * would serialize to `null` and reach AWS as a confusing type error far from
   * the template line that caused it.
   *
   * `Number()` alone is NOT that refusal, which is the trap this guard exists
   * for: it coerces `''` / `'  '` / `null` / `[]` / `false` to `0` and `true`
   * to `1`, all of which are finite. An unresolved intrinsic or an empty CFn
   * value would therefore have deployed a live data source with a ZERO-minute
   * delta-sync TTL — the "validate the FIELD, not just the container" class in
   * .claude/rules/providers.md. So the accepted shapes are enumerated instead:
   * a finite NUMBER, or a NON-BLANK string that parses to one.
   */
  private toDeltaSyncTtl(
    value: unknown,
    path: string,
    logicalId: string,
    resourceType: string
  ): number {
    const numeric =
      typeof value === 'number' ? value : typeof value === 'string' ? value.trim() : undefined;
    const parsed = numeric === undefined || numeric === '' ? Number.NaN : Number(numeric);
    if (!Number.isFinite(parsed)) {
      throw new ProvisioningError(
        `${resourceType} ${path} must be a number of minutes (CFn types it as a ` +
          `string), got ${JSON.stringify(value)} — cdkd refuses to drop it silently`,
        resourceType,
        logicalId
      );
    }
    return parsed;
  }

  /**
   * NOTE: `awsRegion` / `defaultAction` are passed through VERBATIM, including
   * when the template omits them. cdkd deliberately does NOT substitute a
   * default: `DefaultAction` decides whether an unauthenticated request is
   * ALLOWed or DENYed, so inventing one would be a security decision made on
   * the user's behalf, and what CloudFormation itself defaults here has not
   * been A/B-verified. An omitted required member reaches AWS as a LOUD
   * validation error naming the field — not a silent drop.
   */
  private toSdkUserPoolConfig(
    value: unknown,
    path = 'UserPoolConfig',
    options?: ShapeGuardOptions
  ): UserPoolConfig | undefined {
    const cfn = this.asObject(value, path, options);
    if (!cfn) return undefined;
    return {
      userPoolId: cfn['UserPoolId'] as string,
      awsRegion: cfn['AwsRegion'] as string,
      defaultAction: cfn['DefaultAction'] as DefaultAction,
      ...(cfn['AppIdClientRegex'] !== undefined
        ? { appIdClientRegex: cfn['AppIdClientRegex'] as string }
        : {}),
    };
  }

  /**
   * The `UserPoolConfig` nested under an ADDITIONAL auth provider is a
   * DIFFERENT shape from the top-level one — AWS models it as
   * `CognitoUserPoolConfig`, which has no `defaultAction` member.
   */
  private toSdkCognitoUserPoolConfig(
    value: unknown,
    path = 'UserPoolConfig',
    options?: ShapeGuardOptions
  ): CognitoUserPoolConfig | undefined {
    const cfn = this.asObject(value, path, options);
    if (!cfn) return undefined;
    return {
      userPoolId: cfn['UserPoolId'] as string,
      awsRegion: cfn['AwsRegion'] as string,
      ...(cfn['AppIdClientRegex'] !== undefined
        ? { appIdClientRegex: cfn['AppIdClientRegex'] as string }
        : {}),
    };
  }

  private toSdkOpenIDConnectConfig(
    value: unknown,
    path = 'OpenIDConnectConfig',
    options?: ShapeGuardOptions
  ): OpenIDConnectConfig | undefined {
    const cfn = this.asObject(value, path, options);
    if (!cfn) return undefined;
    return {
      issuer: cfn['Issuer'] as string,
      ...(cfn['ClientId'] !== undefined ? { clientId: cfn['ClientId'] as string } : {}),
      // `IatTTL` / `AuthTTL` are `iatTTL` / `authTTL` on the SDK — an
      // all-caps tail the mechanical case flip would spell `iatTtl`.
      ...(cfn['IatTTL'] !== undefined ? { iatTTL: cfn['IatTTL'] as number } : {}),
      ...(cfn['AuthTTL'] !== undefined ? { authTTL: cfn['AuthTTL'] as number } : {}),
    };
  }

  private toSdkLambdaAuthorizerConfig(
    value: unknown,
    path = 'LambdaAuthorizerConfig',
    options?: ShapeGuardOptions
  ): LambdaAuthorizerConfig | undefined {
    const cfn = this.asObject(value, path, options);
    if (!cfn) return undefined;
    return {
      authorizerUri: cfn['AuthorizerUri'] as string,
      ...(cfn['AuthorizerResultTtlInSeconds'] !== undefined
        ? { authorizerResultTtlInSeconds: cfn['AuthorizerResultTtlInSeconds'] as number }
        : {}),
      ...(cfn['IdentityValidationExpression'] !== undefined
        ? { identityValidationExpression: cfn['IdentityValidationExpression'] as string }
        : {}),
    };
  }

  private toSdkAdditionalAuthProviders(
    value: unknown,
    options?: ShapeGuardOptions
  ): AdditionalAuthenticationProvider[] | undefined {
    if (value == null) return undefined;
    let entries: Array<Record<string, unknown>>;
    try {
      entries = requireConfigArray(
        value,
        'AWS::AppSync::GraphQLApi AdditionalAuthenticationProviders'
      );
    } catch (error) {
      // `requireConfigArray` throws a plain Error; convert it so it cannot
      // escape untyped into the deploy engine's retry loop.
      const message = error instanceof Error ? error.message : String(error);
      if (options?.onUnusable) {
        options.onUnusable(message);
        return undefined;
      }
      throw new ProvisioningError(
        message,
        'AWS::AppSync::GraphQLApi',
        options?.logicalId ?? '',
        undefined,
        error instanceof Error ? error : undefined
      );
    }
    return entries.map((entry, index) => {
      const at = `AdditionalAuthenticationProviders[${index}]`;
      // `requireConfigArray` validates the CONTAINER, not its ELEMENTS — a
      // list of strings would index to `undefined` on every key and send an
      // empty provider object to AWS: the same silent drop one level down.
      const cfn = this.asObject(entry, at, options) ?? {};
      const provider: AdditionalAuthenticationProvider = {};
      if (cfn['AuthenticationType'] !== undefined) {
        provider.authenticationType = cfn['AuthenticationType'] as AuthenticationType;
      }
      const oidc = this.toSdkOpenIDConnectConfig(
        cfn['OpenIDConnectConfig'],
        `${at}.OpenIDConnectConfig`,
        options
      );
      if (oidc) provider.openIDConnectConfig = oidc;
      // The additional-provider variant is AWS's CognitoUserPoolConfig, which
      // has NO defaultAction member — a different shape from the top-level one.
      const pool = this.toSdkCognitoUserPoolConfig(cfn['UserPoolConfig'], `${at}.UserPoolConfig`);
      if (pool) provider.userPoolConfig = pool;
      const lambda = this.toSdkLambdaAuthorizerConfig(
        cfn['LambdaAuthorizerConfig'],
        `${at}.LambdaAuthorizerConfig`,
        options
      );
      if (lambda) provider.lambdaAuthorizerConfig = lambda;
      return provider;
    });
  }

  private toSdkEnhancedMetricsConfig(
    value: unknown,
    options?: ShapeGuardOptions
  ): EnhancedMetricsConfig | undefined {
    const cfn = this.asObject(value, 'EnhancedMetricsConfig', options);
    if (!cfn) return undefined;
    return {
      resolverLevelMetricsBehavior: cfn[
        'ResolverLevelMetricsBehavior'
      ] as EnhancedMetricsConfig['resolverLevelMetricsBehavior'],
      dataSourceLevelMetricsBehavior: cfn[
        'DataSourceLevelMetricsBehavior'
      ] as EnhancedMetricsConfig['dataSourceLevelMetricsBehavior'],
      operationLevelMetricsConfig: cfn[
        'OperationLevelMetricsConfig'
      ] as EnhancedMetricsConfig['operationLevelMetricsConfig'],
    };
  }

  /**
   * Fill the config members shared by `CreateGraphqlApi` and
   * `UpdateGraphqlApi` from the CFn property bag.
   *
   * `ApiType` / `Visibility` are deliberately NOT here: the SDK's update
   * input has no member for either (they are create-only on AWS), so
   * `updateGraphQLApi` refuses the change and the replacement rule in
   * `src/analyzer/replacement-rules.ts` routes it through CREATE+DELETE.
   *
   * `forUpdate` turns on the removal sentinels: on UPDATE a property the
   * user DELETED from the template must be actively reset, because
   * AppSync treats an omitted member as "no change" (the same semantic
   * `LogConfig`'s clearing branch documents below). Only the members AWS
   * gives a sentinel for can be reset that way — `MergedApiExecutionRoleArn`
   * and the three auth-config blocks have none, so their removal is
   * reported to the user instead of silently no-op'ing.
   */
  private applyGraphQLApiConfig(
    input: CreateGraphqlApiCommandInput | UpdateGraphqlApiCommandInput,
    properties: Record<string, unknown>,
    options?: {
      forUpdate?: boolean;
      previousProperties?: Record<string, unknown>;
      logicalId?: string;
      shapeGuard?: ShapeGuardOptions;
    }
  ): void {
    const forUpdate = options?.forUpdate === true;
    const previous = options?.previousProperties ?? {};
    const guard: ShapeGuardOptions =
      options?.shapeGuard ??
      (options?.logicalId !== undefined ? { logicalId: options.logicalId } : {});
    const removed = (key: string): boolean =>
      forUpdate && properties[key] === undefined && previous[key] !== undefined;

    const userPool = this.toSdkUserPoolConfig(
      properties['UserPoolConfig'],
      'UserPoolConfig',
      guard
    );
    if (userPool) input.userPoolConfig = userPool;
    const oidc = this.toSdkOpenIDConnectConfig(
      properties['OpenIDConnectConfig'],
      'OpenIDConnectConfig',
      guard
    );
    if (oidc) input.openIDConnectConfig = oidc;
    const lambdaAuth = this.toSdkLambdaAuthorizerConfig(
      properties['LambdaAuthorizerConfig'],
      'LambdaAuthorizerConfig',
      guard
    );
    if (lambdaAuth) input.lambdaAuthorizerConfig = lambdaAuth;

    const additional = this.toSdkAdditionalAuthProviders(
      properties['AdditionalAuthenticationProviders'],
      guard
    );
    if (additional) {
      input.additionalAuthenticationProviders = additional;
    } else if (removed('AdditionalAuthenticationProviders')) {
      // The empty list IS the clearing sentinel for this member.
      input.additionalAuthenticationProviders = [];
    }

    const metrics = this.toSdkEnhancedMetricsConfig(properties['EnhancedMetricsConfig'], guard);
    if (metrics) input.enhancedMetricsConfig = metrics;

    if (properties['IntrospectionConfig'] !== undefined) {
      input.introspectionConfig = properties[
        'IntrospectionConfig'
      ] as GraphQLApiIntrospectionConfig;
    } else if (removed('IntrospectionConfig')) {
      // AWS's documented default when the field is unset.
      input.introspectionConfig = 'ENABLED';
    }

    if (properties['QueryDepthLimit'] !== undefined) {
      input.queryDepthLimit = properties['QueryDepthLimit'] as number;
    } else if (removed('QueryDepthLimit')) {
      input.queryDepthLimit = 0; // 0 = no depth limit (AWS's unset default)
    }

    if (properties['ResolverCountLimit'] !== undefined) {
      input.resolverCountLimit = properties['ResolverCountLimit'] as number;
    } else if (removed('ResolverCountLimit')) {
      input.resolverCountLimit = 0; // 0 = no resolver-count limit
    }

    if (properties['OwnerContact'] !== undefined) {
      input.ownerContact = properties['OwnerContact'] as string;
    } else if (removed('OwnerContact')) {
      input.ownerContact = ''; // AppSync accepts a 0-length owner contact
    }

    if (properties['MergedApiExecutionRoleArn'] !== undefined) {
      input.mergedApiExecutionRoleArn = properties['MergedApiExecutionRoleArn'] as string;
    }

    if (forUpdate) {
      for (const key of [
        'MergedApiExecutionRoleArn',
        'UserPoolConfig',
        'OpenIDConnectConfig',
        'LambdaAuthorizerConfig',
        'EnhancedMetricsConfig',
      ]) {
        if (removed(key)) {
          this.logger.warn(
            `AppSync GraphqlApi ${options?.logicalId ?? ''}: cannot clear ${key} on update — ` +
              'AppSync has no reset sentinel for it and treats an omitted member as "no change". ' +
              'Destroy + redeploy the API to drop it.'
          );
        }
      }
    }
  }

  /**
   * `EnvironmentVariables` lives on its OWN API pair
   * (`PutGraphqlApiEnvironmentVariables` / `Get...`), not on
   * Create/UpdateGraphqlApi. The PUT is whole-map replace, so a removed
   * key is cleared by re-putting the remaining map (and `{}` clears all).
   */
  private async applyEnvironmentVariables(
    apiId: string,
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties?: Record<string, unknown>,
    replayingState = false
  ): Promise<void> {
    const isUpdate = previousProperties !== undefined;
    let desired: Record<string, unknown> | undefined;
    try {
      desired = this.asObject(properties['EnvironmentVariables'], 'EnvironmentVariables', {
        logicalId,
      });
    } catch (error) {
      // The PUT is a WHOLE-MAP replace, so treating a malformed desired value
      // as "absent" would clear every live variable. On a template-path CREATE
      // refusing is right; on UPDATE — or on a create that REPLAYS a cdkd state
      // record — the user has no template-side remedy, so warn and leave AWS
      // untouched.
      if (!isUpdate && !replayingState) throw error;
      this.logger.warn(
        `AppSync GraphqlApi ${logicalId}: ${
          error instanceof Error ? error.message : String(error)
        } — leaving the live environment variables untouched`
      );
      return;
    }
    // The PREVIOUS side comes from cdkd state, never from the user's template:
    // a malformed value recorded there must not make the stack undeployable,
    // so it reads as absent rather than refusing.
    let previous: Record<string, unknown> | undefined;
    if (previousProperties) {
      const raw = previousProperties['EnvironmentVariables'];
      previous =
        raw != null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : undefined;
    }
    if (desired === undefined && previous === undefined) return;
    if (isUpdate && this.deepEqual(desired, previous)) return;

    const environmentVariables: Record<string, string> = {};
    for (const [key, value] of Object.entries(desired ?? {})) {
      // CloudFormation coerces scalars into its Map<String,String>, so an
      // unquoted YAML `RETRIES: 3` deploys under CFn and must keep working
      // here (same rationale as `coerceNumber` in config-shape.ts). An OBJECT
      // or array is a template bug — `String({})` would send the literal
      // "[object Object]" to AWS.
      if (typeof value === 'string') {
        environmentVariables[key] = value;
      } else if (
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'boolean'
      ) {
        environmentVariables[key] = String(value);
      } else {
        throw new ProvisioningError(
          `AWS::AppSync::GraphQLApi EnvironmentVariables.${key} must be a string, got ${
            Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
          }`,
          resourceType,
          logicalId,
          apiId
        );
      }
    }
    try {
      await this.getClient().send(
        new PutGraphqlApiEnvironmentVariablesCommand({ apiId, environmentVariables })
      );
    } catch (error) {
      throw this.wrapUpdateError(
        error,
        resourceType,
        logicalId,
        apiId,
        isUpdate ? 'GraphqlApi (env vars)' : 'GraphqlApi (env vars, post-create)'
      );
    }
  }

  // ─── AWS::AppSync::Resolver / DataSource config converters (#609) ──
  //
  // Same doctrine as the GraphQLApi block above: every member is
  // hand-mapped, never mechanically case-flipped, because the AWS SDK v3
  // serializer silently DROPS unknown members. The casing traps this batch
  // pins: `openSearchServiceConfig` (capital S twice), `dbClusterIdentifier`
  // (CFn spells it `DbClusterIdentifier`), `awsSecretStoreArn`, and
  // `lambdaConflictHandlerConfig.lambdaConflictHandlerArn`.

  /** CFn `CachingConfig` (`Ttl` / `CachingKeys`) -> SDK `cachingConfig`. */
  private toSdkCachingConfig(value: unknown, logicalId: string): CachingConfig | undefined {
    const cfn = this.asObject(value, 'CachingConfig', { logicalId }, 'AWS::AppSync::Resolver');
    if (!cfn) return undefined;
    const out: CachingConfig = {
      // `Ttl` is REQUIRED by both CFn and the SDK; forwarded verbatim so an
      // omission reaches AWS as a loud validation error naming the field.
      ttl: cfn['Ttl'] as number,
    };
    if (cfn['CachingKeys'] !== undefined) {
      // `requireConfigArray` validates the CONTAINER (an unresolved intrinsic
      // or a string where the template meant a list must not silently become
      // "no caching keys"); the elements are plain strings forwarded as-is.
      out.cachingKeys = requireConfigArray(
        cfn['CachingKeys'],
        'AWS::AppSync::Resolver CachingConfig.CachingKeys'
      ) as unknown as string[];
    }
    return out;
  }

  /**
   * CFn `SyncConfig` (`ConflictDetection` / `ConflictHandler` /
   * `LambdaConflictHandlerConfig.LambdaConflictHandlerArn`) -> SDK
   * `syncConfig`.
   */
  private toSdkSyncConfig(value: unknown, logicalId: string): SyncConfig | undefined {
    const cfn = this.asObject(value, 'SyncConfig', { logicalId }, 'AWS::AppSync::Resolver');
    if (!cfn) return undefined;
    const out: SyncConfig = {};
    if (cfn['ConflictDetection'] !== undefined) {
      out.conflictDetection = cfn['ConflictDetection'] as ConflictDetectionType;
    }
    if (cfn['ConflictHandler'] !== undefined) {
      out.conflictHandler = cfn['ConflictHandler'] as ConflictHandlerType;
    }
    const lambdaHandler = this.asObject(
      cfn['LambdaConflictHandlerConfig'],
      'SyncConfig.LambdaConflictHandlerConfig',
      { logicalId },
      'AWS::AppSync::Resolver'
    );
    if (lambdaHandler) {
      out.lambdaConflictHandlerConfig = {
        lambdaConflictHandlerArn: lambdaHandler['LambdaConflictHandlerArn'] as string,
      };
    }
    return out;
  }

  /**
   * Parse the `s3://bucket/key` URL the AppSync `*S3Location` string
   * properties carry.
   *
   * CDK's asset bindings (`appsync.Code.fromAsset`, `aws-s3-assets` Asset
   * `s3ObjectUrl`) emit exactly this form, and the CloudFormation examples
   * for these properties use it too. Anything else (an `https://` object
   * URL, a bare bucket, a non-string) is refused with a clear error naming
   * the property — never silently dropped.
   */
  private parseS3LocationUrl(
    location: unknown,
    resourceType: string,
    logicalId: string,
    propertyPath: string
  ): { bucket: string; key: string } {
    if (typeof location !== 'string') {
      throw new ProvisioningError(
        `${resourceType} ${propertyPath} must be a string s3://bucket/key URL, got ` +
          `${Array.isArray(location) ? 'array' : typeof location} — check for an unresolved intrinsic`,
        resourceType,
        logicalId
      );
    }
    const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(location);
    if (!match || !match[1] || !match[2]) {
      throw new ProvisioningError(
        `${resourceType} ${propertyPath} must be an s3://bucket/key URL (got '${location}')`,
        resourceType,
        logicalId
      );
    }
    return { bucket: match[1], key: match[2] };
  }

  /**
   * Fetch an `*S3Location` object body as a UTF-8 string.
   *
   * CloudFormation's behavior for these properties is to download the S3
   * object and pass its CONTENT as the corresponding inline member
   * (`code` / `requestMappingTemplate` / `responseMappingTemplate` /
   * `definition`); the URL itself never reaches AppSync. Mirrors
   * `StepFunctionsProvider.fetchDefinitionFromS3`, including the
   * empty-body refusal (AWS would reject '' with a generic validation
   * error naming nothing).
   */
  private async fetchS3LocationBody(
    location: unknown,
    resourceType: string,
    logicalId: string,
    propertyPath: string
  ): Promise<string> {
    const { bucket, key } = this.parseS3LocationUrl(
      location,
      resourceType,
      logicalId,
      propertyPath
    );
    this.logger.debug(`Fetching ${propertyPath} for ${logicalId} from s3://${bucket}/${key}`);
    let body: string;
    try {
      const resp = await this.getS3Client().send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      if (!resp.Body) {
        throw new Error(`object returned no body`);
      }
      body = await resp.Body.transformToString();
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError(
        `Failed to fetch ${propertyPath} s3://${bucket}/${key} for ${logicalId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
    if (body.length === 0) {
      throw new ProvisioningError(
        `${propertyPath} object s3://${bucket}/${key} returned an empty body`,
        resourceType,
        logicalId
      );
    }
    return body;
  }

  /**
   * Resolve an inline-or-S3 property pair to the inline SDK value.
   *
   * Precedence: the INLINE property wins when both are present, matching
   * the repo's established S3Location precedent (StepFunctions
   * `DefinitionString` over `DefinitionS3Location`, AppSync GraphQLSchema
   * `Definition` over `DefinitionS3Location`) — CFn treats the pair as
   * alternatives and CDK's bindings only ever emit one, so both-present is
   * a hand-authored template; it is honored inline-first with a loud
   * warning rather than refused.
   */
  private async resolveInlineOrS3Template(
    inline: unknown,
    s3Location: unknown,
    inlineKey: string,
    s3Key: string,
    resourceType: string,
    logicalId: string
  ): Promise<string | undefined> {
    if (inline !== undefined) {
      if (s3Location !== undefined) {
        this.logger.warn(
          `${resourceType} ${logicalId}: both ${inlineKey} and ${s3Key} are set — ` +
            `using the inline ${inlineKey} and ignoring ${s3Key} (CFn treats them as alternatives)`
        );
      }
      return inline as string;
    }
    if (s3Location !== undefined) {
      return this.fetchS3LocationBody(s3Location, resourceType, logicalId, s3Key);
    }
    return undefined;
  }

  /**
   * Fill the mutable members shared by `CreateResolver` and `UpdateResolver`
   * from the CFn property bag — the single mapper both paths use so they
   * cannot diverge (the `applyGraphQLApiConfig` pattern).
   *
   * REMOVAL semantics: unlike `UpdateGraphqlApi` (where an omitted member is
   * "no change" and removal needs reset sentinels), `UpdateResolver` is a
   * FULL-REPLACE write — the desired bag is mapped in its entirety and an
   * omitted member is cleared server-side, so "absent in template => omitted
   * from the update input => cleared by AppSync" and no sentinel is needed.
   * That semantic is pinned live by the integ fixture's REMOVAL phase
   * (tests/integration/appsync/verify.sh drops the resolver's MetricsConfig
   * and asserts AWS reset it while a sibling DataSource keeps its own).
   * MetricsConfig is the one member A/B'd against real AWS; the other
   * members rest on the same UpdateResolver full-replace API contract, not
   * on a per-member live probe (the #1160 doctrine's per-member A/B was
   * deliberately not paid here — recorded in the PR body).
   *
   * Resolver shape is `Kind`-discriminated:
   *   - Kind=UNIT     -> DataSourceName applies, PipelineConfig is N/A.
   *   - Kind=PIPELINE -> PipelineConfig applies, DataSourceName is N/A
   *                      (AWS rejects the call if it's set).
   * The gate applies ONLY on update (`forUpdate`), where the effective Kind
   * falls back to the state-recorded previous value and finally AWS's
   * default 'UNIT' — an update must not re-send the other kind's member on a
   * live resolver. On CREATE both members forward UNCONDITIONALLY when
   * present: gating there would silently drop a crossed shape (the very
   * silent-drop class this batch closes) where CFn parity is AWS's own loud
   * rejection — the same forward-don't-gate doctrine as
   * `applyDataSourceConfig`'s per-type sub-configs.
   */
  private async applyResolverConfig(
    input: CreateResolverCommandInput | UpdateResolverCommandInput,
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties?: Record<string, unknown>,
    forUpdate = false
  ): Promise<void> {
    const effectiveKind =
      (properties['Kind'] as 'UNIT' | 'PIPELINE' | undefined) ??
      (previousProperties?.['Kind'] as 'UNIT' | 'PIPELINE' | undefined) ??
      'UNIT';

    if ((!forUpdate || effectiveKind === 'UNIT') && properties['DataSourceName'] !== undefined) {
      input.dataSourceName = properties['DataSourceName'] as string;
    }
    if (properties['Kind'] !== undefined) {
      input.kind = properties['Kind'] as 'UNIT' | 'PIPELINE';
    }
    if (
      (!forUpdate || effectiveKind === 'PIPELINE') &&
      properties['PipelineConfig'] !== undefined
    ) {
      const pipelineConfig = properties['PipelineConfig'] as Record<string, unknown>;
      input.pipelineConfig = {
        functions: pipelineConfig['Functions'] as string[] | undefined,
      };
    }
    if (properties['Runtime'] !== undefined) {
      const runtime = properties['Runtime'] as Record<string, unknown>;
      input.runtime = {
        name: runtime['Name'] as 'APPSYNC_JS',
        runtimeVersion: runtime['RuntimeVersion'] as string,
      };
    }

    // The three inline-or-S3 pairs. CFn's behavior for the *S3Location
    // variants is to fetch the S3 object and pass its BODY as the inline
    // member — there is no SDK member for the URL itself. The bag reads stay
    // DIRECT at this call site (the helper takes values, not keys) so the
    // handled-property-wiring critic can see each `properties['X']` read.
    const requestTemplate = await this.resolveInlineOrS3Template(
      properties['RequestMappingTemplate'],
      properties['RequestMappingTemplateS3Location'],
      'RequestMappingTemplate',
      'RequestMappingTemplateS3Location',
      resourceType,
      logicalId
    );
    if (requestTemplate !== undefined) input.requestMappingTemplate = requestTemplate;
    const responseTemplate = await this.resolveInlineOrS3Template(
      properties['ResponseMappingTemplate'],
      properties['ResponseMappingTemplateS3Location'],
      'ResponseMappingTemplate',
      'ResponseMappingTemplateS3Location',
      resourceType,
      logicalId
    );
    if (responseTemplate !== undefined) input.responseMappingTemplate = responseTemplate;
    const code = await this.resolveInlineOrS3Template(
      properties['Code'],
      properties['CodeS3Location'],
      'Code',
      'CodeS3Location',
      resourceType,
      logicalId
    );
    if (code !== undefined) input.code = code;

    const caching = this.toSdkCachingConfig(properties['CachingConfig'], logicalId);
    if (caching) input.cachingConfig = caching;
    const sync = this.toSdkSyncConfig(properties['SyncConfig'], logicalId);
    if (sync) input.syncConfig = sync;
    if (properties['MaxBatchSize'] !== undefined) {
      input.maxBatchSize = properties['MaxBatchSize'] as number;
    }
    if (properties['MetricsConfig'] !== undefined) {
      // Scalar enum (ENABLED / DISABLED), not a block.
      input.metricsConfig = properties['MetricsConfig'] as ResolverLevelMetricsConfig;
    }
  }

  /**
   * Fill the mutable members shared by `CreateDataSource` and
   * `UpdateDataSource` from the CFn property bag — single mapper for both
   * paths (the `applyGraphQLApiConfig` pattern).
   *
   * REMOVAL semantics: `UpdateDataSource` is a FULL-REPLACE write like
   * `UpdateResolver` — an omitted member is cleared server-side, so removal
   * needs no reset sentinel (see `applyResolverConfig`'s note; pinned live
   * by the integ fixture's REMOVAL phase).
   *
   * The per-type sub-configs (`DynamoDBConfig` / `LambdaConfig` /
   * `HttpConfig` / `ElasticsearchConfig` / `OpenSearchServiceConfig` /
   * `EventBridgeConfig` / `RelationalDatabaseConfig`) are mutually exclusive
   * on the `Type` discriminator. The write side deliberately FORWARDS
   * whichever block the template carries rather than gating on `Type`:
   * gating would silently drop a mismatched block (the very silent-drop
   * class this batch closes), while AWS rejects a crossed shape with a loud
   * validation error. The read side (`readDataSource`) gates on the
   * response's own discriminator instead.
   */
  private applyDataSourceConfig(
    input: CreateDataSourceCommandInput | UpdateDataSourceCommandInput,
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): void {
    if (properties['Description'] !== undefined) {
      input.description = properties['Description'] as string;
    }
    if (properties['ServiceRoleArn'] !== undefined) {
      input.serviceRoleArn = properties['ServiceRoleArn'] as string;
    }

    const dynamo = this.asObject(
      properties['DynamoDBConfig'],
      'DynamoDBConfig',
      { logicalId },
      resourceType
    );
    if (dynamo) {
      const ddbConfig: DynamodbDataSourceConfig = {
        tableName: dynamo['TableName'] as string,
        awsRegion: dynamo['AwsRegion'] as string,
        ...(dynamo['UseCallerCredentials'] !== undefined
          ? { useCallerCredentials: dynamo['UseCallerCredentials'] as boolean }
          : {}),
        // Conflict-detection toggle for a versioned data source. Nested
        // silent drop until issue #1597 — invisible to top-level property
        // coverage because `DynamoDBConfig` itself is a handled property.
        ...(dynamo['Versioned'] !== undefined ? { versioned: dynamo['Versioned'] as boolean } : {}),
      };
      const delta = this.asObject(
        dynamo['DeltaSyncConfig'],
        'DynamoDBConfig.DeltaSyncConfig',
        { logicalId },
        resourceType
      );
      if (delta) {
        const deltaConfig: DeltaSyncConfig = {};
        // CFn types BOTH TTLs as STRING (minutes) while the SDK members are
        // longs — the one CFn->SDK divergence in this block that a verbatim
        // forward would lose (the serializer drops a string where the model
        // wants a number). `toDeltaSyncTtl` refuses a non-numeric value
        // loudly rather than sending NaN.
        if (delta['BaseTableTTL'] !== undefined) {
          deltaConfig.baseTableTTL = this.toDeltaSyncTtl(
            delta['BaseTableTTL'],
            'DynamoDBConfig.DeltaSyncConfig.BaseTableTTL',
            logicalId,
            resourceType
          );
        }
        if (delta['DeltaSyncTableName'] !== undefined) {
          deltaConfig.deltaSyncTableName = delta['DeltaSyncTableName'] as string;
        }
        if (delta['DeltaSyncTableTTL'] !== undefined) {
          deltaConfig.deltaSyncTableTTL = this.toDeltaSyncTtl(
            delta['DeltaSyncTableTTL'],
            'DynamoDBConfig.DeltaSyncConfig.DeltaSyncTableTTL',
            logicalId,
            resourceType
          );
        }
        ddbConfig.deltaSyncConfig = deltaConfig;
      }
      input.dynamodbConfig = ddbConfig;
    }
    const lambda = this.asObject(
      properties['LambdaConfig'],
      'LambdaConfig',
      { logicalId },
      resourceType
    );
    if (lambda) {
      input.lambdaConfig = {
        lambdaFunctionArn: lambda['LambdaFunctionArn'] as string,
      };
    }
    const http = this.asObject(properties['HttpConfig'], 'HttpConfig', { logicalId }, resourceType);
    if (http) {
      const httpConfig: HttpDataSourceConfig = {
        endpoint: http['Endpoint'] as string,
      };
      // IAM-signed HTTP data sources (`AuthorizationType: AWS_IAM` +
      // `AwsIamConfig`). Nested silent drop until issue #1597: without this
      // the data source reaches AWS UNSIGNED, so every request to the
      // endpoint goes out without SigV4 — a security-relevant drop, not a
      // cosmetic one.
      const auth = this.asObject(
        http['AuthorizationConfig'],
        'HttpConfig.AuthorizationConfig',
        { logicalId },
        resourceType
      );
      if (auth) {
        const authConfig: AuthorizationConfig = {
          // Required by both CFn and the SDK; forwarded verbatim so an
          // omission reaches AWS as a loud validation error naming the field
          // (same contract as `CachingConfig.Ttl`).
          authorizationType: auth['AuthorizationType'] as AuthorizationType,
        };
        const iam = this.asObject(
          auth['AwsIamConfig'],
          'HttpConfig.AuthorizationConfig.AwsIamConfig',
          { logicalId },
          resourceType
        );
        if (iam) {
          authConfig.awsIamConfig = {
            ...(iam['SigningRegion'] !== undefined
              ? { signingRegion: iam['SigningRegion'] as string }
              : {}),
            ...(iam['SigningServiceName'] !== undefined
              ? { signingServiceName: iam['SigningServiceName'] as string }
              : {}),
          };
        }
        httpConfig.authorizationConfig = authConfig;
      }
      input.httpConfig = httpConfig;
    }
    // Legacy Elasticsearch alias (Type: AMAZON_ELASTICSEARCH) — deprecated by
    // AWS in favor of OpenSearch but still a live SDK member.
    const es = this.asObject(
      properties['ElasticsearchConfig'],
      'ElasticsearchConfig',
      { logicalId },
      resourceType
    );
    if (es) {
      const esConfig: ElasticsearchDataSourceConfig = {
        endpoint: es['Endpoint'] as string,
        awsRegion: es['AwsRegion'] as string,
      };
      input.elasticsearchConfig = esConfig;
    }
    const openSearch = this.asObject(
      properties['OpenSearchServiceConfig'],
      'OpenSearchServiceConfig',
      { logicalId },
      resourceType
    );
    if (openSearch) {
      // `openSearchServiceConfig` — the interior capitals are pinned by the
      // typed literal below; an `opensearchServiceConfig` /
      // `openSearchserviceConfig` near-miss would be serializer-dropped.
      const osConfig: OpenSearchServiceDataSourceConfig = {
        endpoint: openSearch['Endpoint'] as string,
        awsRegion: openSearch['AwsRegion'] as string,
      };
      input.openSearchServiceConfig = osConfig;
    }
    const eventBridge = this.asObject(
      properties['EventBridgeConfig'],
      'EventBridgeConfig',
      { logicalId },
      resourceType
    );
    if (eventBridge) {
      const ebConfig: EventBridgeDataSourceConfig = {
        eventBusArn: eventBridge['EventBusArn'] as string,
      };
      input.eventBridgeConfig = ebConfig;
    }
    const relational = this.asObject(
      properties['RelationalDatabaseConfig'],
      'RelationalDatabaseConfig',
      { logicalId },
      resourceType
    );
    if (relational) {
      const rdsConfig: RelationalDatabaseDataSourceConfig = {
        relationalDatabaseSourceType: relational[
          'RelationalDatabaseSourceType'
        ] as RelationalDatabaseSourceType,
      };
      const rdsEndpoint = this.asObject(
        relational['RdsHttpEndpointConfig'],
        'RelationalDatabaseConfig.RdsHttpEndpointConfig',
        { logicalId },
        resourceType
      );
      if (rdsEndpoint) {
        rdsConfig.rdsHttpEndpointConfig = {
          awsRegion: rdsEndpoint['AwsRegion'] as string,
          // CFn spells it `DbClusterIdentifier` (capital D, lowercase b);
          // the SDK member is `dbClusterIdentifier`.
          dbClusterIdentifier: rdsEndpoint['DbClusterIdentifier'] as string,
          ...(rdsEndpoint['DatabaseName'] !== undefined
            ? { databaseName: rdsEndpoint['DatabaseName'] as string }
            : {}),
          ...(rdsEndpoint['Schema'] !== undefined
            ? { schema: rdsEndpoint['Schema'] as string }
            : {}),
          ...(rdsEndpoint['AwsSecretStoreArn'] !== undefined
            ? { awsSecretStoreArn: rdsEndpoint['AwsSecretStoreArn'] as string }
            : {}),
        };
      }
      input.relationalDatabaseConfig = rdsConfig;
    }
    if (properties['MetricsConfig'] !== undefined) {
      // Scalar enum (ENABLED / DISABLED), not a block.
      input.metricsConfig = properties['MetricsConfig'] as DataSourceLevelMetricsConfig;
    }
  }

  // ─── AWS::AppSync::GraphQLApi ──────────────────────────────────────

  private async createGraphQLApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating GraphQL API ${logicalId}`);

    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for GraphQLApi ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const authenticationType = properties['AuthenticationType'] as AuthenticationType | undefined;

    // Atomicity: `EnvironmentVariables` rides a SEPARATE API that can only run
    // after CreateGraphqlApi succeeds, so a failure there would throw before
    // create() returns the physicalId — the deploy engine never learns the API
    // exists and it orphans (and the next attempt collides on the name).
    // Mirrors the CognitoUserPoolProvider / DynamoDBTableProvider post-create
    // rollback pattern.
    let createdApiId: string | undefined;

    // A rollback replay hands `create()` a cdkd STATE record, which the user
    // cannot edit — so every pre-flight refusal below downgrades to a warning
    // there (.claude/rules/providers.md). An ordinary template-path create
    // keeps the refusal.
    const shapeGuard: ShapeGuardOptions = {
      logicalId,
      ...(context?.replayingState === true
        ? {
            onUnusable: (message: string) =>
              this.logger.warn(`${message} (state replay — proceeding without it)`),
          }
        : {}),
    };

    try {
      const input: CreateGraphqlApiCommandInput = {
        name,
        authenticationType: authenticationType ?? 'API_KEY',
      };

      if (properties['XrayEnabled'] !== undefined) {
        input.xrayEnabled = properties['XrayEnabled'] as boolean;
      }

      if (properties['LogConfig']) {
        const logConfig = properties['LogConfig'] as Record<string, unknown>;
        input.logConfig = {
          cloudWatchLogsRoleArn: logConfig['CloudWatchLogsRoleArn'] as string,
          fieldLogLevel: logConfig['FieldLogLevel'] as 'NONE' | 'ERROR' | 'ALL',
          excludeVerboseContent: logConfig['ExcludeVerboseContent'] as boolean | undefined,
        };
      }

      // Tags
      if (properties['Tags']) {
        const tags = properties['Tags'] as Array<{
          Key: string;
          Value: string;
        }>;
        const tagMap: Record<string, string> = {};
        for (const tag of tags) {
          tagMap[tag.Key] = tag.Value;
        }
        input.tags = tagMap;
      }

      this.applyGraphQLApiConfig(input, properties, { logicalId, shapeGuard });

      // Create-only members — no `UpdateGraphqlApi` counterpart exists,
      // which is why both are replacement properties in
      // `src/analyzer/replacement-rules.ts`.
      if (properties['ApiType'] !== undefined) {
        input.apiType = properties['ApiType'] as GraphQLApiType;
      }
      if (properties['Visibility'] !== undefined) {
        input.visibility = properties['Visibility'] as GraphQLApiVisibility;
      }

      const response = await this.getClient().send(new CreateGraphqlApiCommand(input));
      // Recorded BEFORE any other dereference: if `graphqlApi` came back
      // malformed the API may still exist, and the rollback below is the only
      // thing that keeps it from orphaning.
      createdApiId = response.graphqlApi?.apiId;

      const apiId = response.graphqlApi!.apiId!;
      const arn = response.graphqlApi!.arn!;
      const graphQLUrl = response.graphqlApi!.uris?.['GRAPHQL'] ?? '';

      // Separate API — must run AFTER the API exists.
      await this.applyEnvironmentVariables(
        apiId,
        resourceType,
        logicalId,
        properties,
        undefined,
        context?.replayingState === true
      );

      this.logger.debug(`Successfully created GraphQL API ${logicalId}: ${apiId}`);

      return {
        physicalId: apiId,
        attributes: {
          ApiId: apiId,
          Arn: arn,
          GraphQLUrl: graphQLUrl,
        },
      };
    } catch (error) {
      if (createdApiId) {
        try {
          await this.getClient().send(new DeleteGraphqlApiCommand({ apiId: createdApiId }));
          this.logger.debug(`Rolled back partially-created GraphQL API ${createdApiId}`);
        } catch (rollbackError) {
          this.logger.warn(
            `Failed to roll back partially-created GraphQL API ${createdApiId}: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`
          );
        }
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create GraphQL API ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteGraphQLApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting GraphQL API ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteGraphqlApiCommand({ apiId: physicalId }));
      this.logger.debug(`Successfully deleted GraphQL API ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`GraphQL API ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete GraphQL API ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::AppSync::GraphQLSchema ───────────────────────────────────

  private async createGraphQLSchema(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating GraphQL Schema ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required for GraphQLSchema ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const definition = properties['Definition'] as string | undefined;
    const definitionS3Location = properties['DefinitionS3Location'];

    try {
      if (definition) {
        // Inline wins when both are present — same precedence as the
        // Resolver *S3Location pairs (see resolveInlineOrS3Template).
        if (definitionS3Location !== undefined) {
          this.logger.warn(
            `${resourceType} ${logicalId}: both Definition and DefinitionS3Location are set — ` +
              'using the inline Definition and ignoring DefinitionS3Location (CFn treats them as alternatives)'
          );
        }
        await this.getClient().send(
          new StartSchemaCreationCommand({
            apiId,
            definition: new TextEncoder().encode(definition),
          })
        );
      } else if (definitionS3Location !== undefined) {
        // CloudFormation fetches the S3 object and submits its BODY as the
        // SDL — StartSchemaCreation has no S3-URL member. Same fetch helper
        // as the Resolver *S3Location properties (#609).
        const body = await this.fetchS3LocationBody(
          definitionS3Location,
          resourceType,
          logicalId,
          'DefinitionS3Location'
        );
        await this.getClient().send(
          new StartSchemaCreationCommand({
            apiId,
            definition: new TextEncoder().encode(body),
          })
        );
      }

      this.logger.debug(`Successfully started schema creation for ${logicalId}`);

      // Schema is tied to the API, use apiId as physical ID
      return {
        physicalId: apiId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create GraphQL Schema ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // ─── AWS::AppSync::DataSource ──────────────────────────────────────

  private async createDataSource(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DataSource ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const name = properties['Name'] as string;
    const type = properties['Type'] as DataSourceType;

    if (!apiId || !name || !type) {
      throw new ProvisioningError(
        `ApiId, Name, and Type are required for DataSource ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Refuse a `|` in either segment BEFORE `CreateDataSource` runs (issue
    // #1672). `Name` is the only segment cdkd's own guards would let through as
    // an arbitrary string — it is user-chosen, where `ApiId` is AWS-generated —
    // but that is NOT the same as saying AWS accepts a `|` in it: AppSync
    // documents the field as `[_A-Za-z][_0-9A-Za-z]*`, and unlike the Glue
    // sibling this has NOT been probed live, so treat the guard as
    // defense-in-depth rather than a measured hazard. Computed here so the
    // refusal cannot orphan a data source AWS has already created.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'apiId', value: apiId },
        { name: 'name', value: name },
      ],
      // A reverse-replacement rollback creates from a STATE record, so the
      // refusal downgrades to a warning — no template edit can repair a value
      // recorded by an older binary.
      context?.replayingState === true
        ? { onRefusal: (message) => this.logger.warn(message) }
        : undefined
    );

    let reportedArn: string | undefined;
    try {
      const input: CreateDataSourceCommandInput = {
        apiId,
        name,
        type,
      };

      // Shared with updateDataSource so create and update cannot diverge.
      this.applyDataSourceConfig(input, resourceType, logicalId, properties);

      const response = await this.getClient().send(new CreateDataSourceCommand(input));
      // Recorded, not consumed, inside the try — see the return below.
      reportedArn = response.dataSource?.dataSourceArn;

      this.logger.debug(`Successfully created DataSource ${logicalId}: ${physicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DataSource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }

    // OUTSIDE the try, and non-throwing: the data source EXISTS from here on.
    // Placement alone only stops the failure being MIS-LABELLED as a creation
    // failure — `create()` would still throw, and a failed CREATE journals no
    // physicalId, so the rollback executor would skip it and leave the resource
    // in AWS invisible to state (the issue #1710 class). `buildAppSyncArnOrWarn`
    // is what actually closes that: the ARN is bookkeeping, the resource is
    // already real, so a failure warns and omits rather than failing the create.
    const dataSourceArn =
      reportedArn ??
      (await this.buildAppSyncArnOrWarn(
        `apis/${apiId}/datasources/${name}`,
        logicalId,
        physicalId
      ));
    return {
      physicalId,
      attributes: {
        // CFn's `Ref` AND `Fn::GetAtt DataSourceArn` both return the data
        // source ARN `.../apis/<apiId>/datasources/<name>` (docs-verified
        // 2026-08-12). `CreateDataSource` reports the real one, so take it
        // verbatim rather than string-building; see `buildAppSyncArn` for why
        // the fallback exists and what the pre-#1681 placeholder broke.
        ...(dataSourceArn !== undefined && { DataSourceArn: dataSourceArn }),
        Name: name,
      },
    };
  }

  private async deleteDataSource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DataSource ${logicalId}: ${physicalId}`);

    const [apiId, name] = physicalId.split('|');
    if (!apiId || !name) {
      this.logger.warn(`Invalid DataSource physical ID format: ${physicalId}, skipping`);
      return;
    }

    try {
      await this.getClient().send(new DeleteDataSourceCommand({ apiId, name }));
      this.logger.debug(`Successfully deleted DataSource ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DataSource ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DataSource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::AppSync::Resolver ────────────────────────────────────────

  private async createResolver(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Resolver ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const typeName = properties['TypeName'] as string;
    const fieldName = properties['FieldName'] as string;

    if (!apiId || !typeName || !fieldName) {
      throw new ProvisioningError(
        `ApiId, TypeName, and FieldName are required for Resolver ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Refuse a `|` in any segment BEFORE `CreateResolver` runs (issue #1672).
    // `TypeName` / `FieldName` are the user-chosen pair (`ApiId` is
    // AWS-generated), but both are GraphQL identifiers — `[_A-Za-z][_0-9A-Za-z]*`
    // by the spec — so a `|` should be rejected upstream of cdkd and this
    // guard is unverified defense-in-depth, not a measured hazard like the Glue
    // sibling. Computed here so the refusal cannot orphan a resolver AWS has
    // already created.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'apiId', value: apiId },
        { name: 'typeName', value: typeName },
        { name: 'fieldName', value: fieldName },
      ],
      // A reverse-replacement rollback creates from a STATE record, so the
      // refusal downgrades to a warning.
      context?.replayingState === true
        ? { onRefusal: (message) => this.logger.warn(message) }
        : undefined
    );

    let reportedArn: string | undefined;
    try {
      const input: CreateResolverCommandInput = {
        apiId,
        typeName,
        fieldName,
      };

      // Shared with updateResolver so create and update cannot diverge
      // (incl. the Kind discriminator gating and the *S3Location fetches).
      await this.applyResolverConfig(input, resourceType, logicalId, properties);

      const response = await this.getClient().send(new CreateResolverCommand(input));
      // Recorded, not consumed, inside the try — see the return below.
      reportedArn = response.resolver?.resolverArn;

      this.logger.debug(`Successfully created Resolver ${logicalId}: ${physicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Resolver ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }

    // OUTSIDE the try, and non-throwing — see `createDataSource` for the full
    // reasoning (issue #1710: a throw after a successful create orphans the
    // resource, and placement alone does not prevent that).
    const resolverArn =
      reportedArn ??
      (await this.buildAppSyncArnOrWarn(
        `apis/${apiId}/types/${typeName}/resolvers/${fieldName}`,
        logicalId,
        physicalId
      ));
    return {
      physicalId,
      attributes: {
        // CFn's `Ref` AND `Fn::GetAtt ResolverArn` both return the resolver
        // ARN `.../apis/<apiId>/types/<type>/resolvers/<field>`
        // (docs-verified 2026-08-12); `CreateResolver` reports the real one.
        ...(resolverArn !== undefined && { ResolverArn: resolverArn }),
      },
    };
  }

  private async deleteResolver(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Resolver ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length < 3) {
      this.logger.warn(`Invalid Resolver physical ID format: ${physicalId}, skipping`);
      return;
    }
    const [apiId, typeName, fieldName] = parts;

    try {
      await this.getClient().send(new DeleteResolverCommand({ apiId, typeName, fieldName }));
      this.logger.debug(`Successfully deleted Resolver ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Resolver ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Resolver ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::AppSync::ApiKey ──────────────────────────────────────────

  private async createApiKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ApiKey ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required for ApiKey ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    let apiKeyId: string;
    try {
      const input: CreateApiKeyCommandInput = { apiId };

      if (properties['Description']) {
        input.description = properties['Description'] as string;
      }
      if (properties['Expires']) {
        input.expires = properties['Expires'] as number;
      }

      const response = await this.getClient().send(new CreateApiKeyCommand(input));

      apiKeyId = response.apiKey!.id!;
      this.logger.debug(`Successfully created ApiKey ${logicalId}: ${apiKeyId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ApiKey ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }

    // One of only two sites in this change where the guard cannot run before
    // the AWS call: `apiKeyId` is minted by `CreateApiKey`, so there is nothing
    // to check until the key exists (issue #1672). It sits OUTSIDE the try on
    // purpose — that `catch` re-wraps anything thrown as
    // `ProvisioningError('Failed to create ApiKey …')`, so a refusal raised
    // inside it would be reported as an AWS creation failure for a key AWS had
    // in fact created. Acceptable here in the first place only because neither
    // segment is pipe-capable — both are AWS-generated ids — so this is a fence
    // against a future id-shape change, not a live refusal that could strand a
    // created key.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'apiId', value: apiId },
        { name: 'apiKeyId', value: apiKeyId },
      ],
      context?.replayingState === true
        ? { onRefusal: (message) => this.logger.warn(message) }
        : undefined
    );

    // Always rebuilt — `CreateApiKey` reports no ARN at all — so this is the
    // arm most exposed to the post-create throw described in `createDataSource`.
    const apiKeyArn = await this.buildAppSyncArnOrWarn(
      `apis/${apiId}/apikey/${apiKeyId}`,
      logicalId,
      physicalId
    );

    return {
      physicalId,
      attributes: {
        ApiKey: apiKeyId,
        // CFn's `Ref` for this type returns the API key ARN, documented as
        // `arn:aws:appsync:us-east-1:123456789012:apis/graphqlapiid/apikey/apikeya1bzhi`
        // (docs-verified 2026-08-12) — note the segment is SINGULAR `apikey`.
        // Unlike its DataSource / Resolver siblings, `CreateApiKey` reports no
        // ARN at all, so this one must be reconstructed. The pre-#1681 value
        // was wrong twice over: a literal `*:*` for region / account, and the
        // plural `apikeys`.
        ...(apiKeyArn !== undefined && { Arn: apiKeyArn }),
      },
    };
  }

  private async deleteApiKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting ApiKey ${logicalId}: ${physicalId}`);

    const [apiId, apiKeyId] = physicalId.split('|');
    if (!apiId || !apiKeyId) {
      this.logger.warn(`Invalid ApiKey physical ID format: ${physicalId}, skipping`);
      return;
    }

    try {
      await this.getClient().send(new DeleteApiKeyCommand({ apiId, id: apiKeyId }));
      this.logger.debug(`Successfully deleted ApiKey ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`ApiKey ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ApiKey ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    const name = (error as { name?: string }).name ?? '';
    return (
      message.includes('not found') ||
      message.includes('does not exist') ||
      name === 'NotFoundException'
    );
  }

  /**
   * Read the AWS-current AppSync resource configuration in CFn-property shape.
   *
   * Dispatches per resource type:
   *  - `GraphQLApi` → `GetGraphqlApi` (Name, AuthenticationType, XrayEnabled,
   *    LogConfig, Tags). Tags come from the same response (`tags` map);
   *    CDK's `aws:*` auto-tags are filtered out and the result key is
   *    omitted when no user tags remain.
   *  - `DataSource` → `GetDataSource` (Name, Type, Description,
   *    ServiceRoleArn, the per-type configs — DynamoDBConfig, LambdaConfig,
   *    HttpConfig, ElasticsearchConfig, OpenSearchServiceConfig,
   *    EventBridgeConfig, RelationalDatabaseConfig — and MetricsConfig). The
   *    `ApiId` cdkd holds is recovered from the `apiId|name` physicalId.
   *  - `Resolver` → `GetResolver` (TypeName, FieldName, DataSourceName,
   *    request/response templates, Kind, PipelineConfig, Runtime, Code,
   *    CachingConfig, SyncConfig, MaxBatchSize, MetricsConfig).
   *  - `ApiKey` → `ListApiKeys` filtered by id (no `GetApiKey` SDK call;
   *    AppSync only exposes list-based access). Surfaces Description and
   *    Expires.
   *  - `GraphQLSchema` → `GetIntrospectionSchema(format=SDL)` for the
   *    AWS-current SDL. Both the state-templated `Definition` and the
   *    AWS-returned SDL are run through `graphql-js` `parse(...)` →
   *    `print(...)` to produce a canonical, comment-stripped, whitespace-
   *    stable form so cosmetic diffs (whitespace, comments, blank lines)
   *    do not fire false drift. Field-order differences are intentionally
   *    NOT normalized — `print` preserves the source AST order, so a
   *    user-side reordering of fields surfaces as drift (which is the
   *    desired behavior, since AWS retains the schema in submission
   *    order). On parse failure on either side (rare but possible —
   *    AWS could return an SDL that the local graphql-js version
   *    rejects, or state could carry pre-canonicalization input), the
   *    raw AWS SDL is returned and the comparator falls back to
   *    string-level diff (which may report whitespace drift). Logged at
   *    debug.
   *
   * Returns `undefined` when the parent resource is gone (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.readGraphQLApi(physicalId);
      case 'AWS::AppSync::DataSource':
        return this.readDataSource(physicalId);
      case 'AWS::AppSync::Resolver':
        return this.readResolver(physicalId);
      case 'AWS::AppSync::ApiKey':
        return this.readApiKey(physicalId);
      case 'AWS::AppSync::GraphQLSchema':
        return this.readGraphQLSchema(physicalId, properties);
      default:
        return undefined;
    }
  }

  /**
   * Canonicalize an SDL string via `graphql-js` `parse` → `print`.
   *
   * Strips comments and normalizes whitespace; preserves source AST
   * ordering of types and fields. Returns the raw input on parse
   * failure (logged at debug) so the caller can still produce SOMETHING
   * to diff against.
   */
  private canonicalizeSdl(sdl: string, source: 'state' | 'aws'): string {
    try {
      return graphqlPrint(graphqlParse(sdl));
    } catch (err) {
      this.logger.debug(
        `Failed to parse ${source} SDL via graphql-js (falling back to raw): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return sdl;
    }
  }

  private async readGraphQLSchema(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    let resp;
    try {
      resp = await this.getClient().send(
        new GetIntrospectionSchemaCommand({ apiId: physicalId, format: 'SDL' })
      );
    } catch (err) {
      if (err instanceof AppSyncNotFoundException) return undefined;
      throw err;
    }

    const schemaBytes = resp.schema;
    if (!schemaBytes) return undefined;

    // AWS returns SDL as Uint8Array (UTF-8). Decode and canonicalize via
    // graphql-js parse → print so cosmetic differences (whitespace,
    // comments, blank lines) do not fire false drift.
    const awsSdl = new TextDecoder().decode(schemaBytes);
    const canonicalAws = this.canonicalizeSdl(awsSdl, 'aws');

    // The drift comparator descends into keys present in state and
    // diffs leaf values byte-for-byte. To produce a no-drift result on
    // semantically-equal SDLs (state has comments / extra whitespace
    // the user authored, AWS returned the canonicalized form), we run
    // state's Definition through the SAME canonicalizer and — when the
    // two canonical forms are equal — return state's exact recorded
    // bytes as the AWS-current value. This makes the comparator see
    // `state === aws` byte-for-byte on a clean run regardless of which
    // form state happens to hold (raw user SDL on v2 fallback, or the
    // canonical form on v3 observedProperties baseline). When the
    // canonical forms genuinely differ, the canonical AWS SDL is
    // returned so the drift surfaces.
    //
    // `ApiId` is preserved from physicalId since cdkd state holds it
    // as a top-level CFn property; without it the comparator would
    // surface a false drift on every clean run.
    const stateDefinition = properties?.['Definition'];
    let definitionToReturn = canonicalAws;
    if (typeof stateDefinition === 'string' && stateDefinition.length > 0) {
      const canonicalState = this.canonicalizeSdl(stateDefinition, 'state');
      if (canonicalState === canonicalAws) {
        definitionToReturn = stateDefinition;
      }
    }

    return {
      ApiId: physicalId,
      Definition: definitionToReturn,
    };
  }

  private async readGraphQLApi(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let api;
    try {
      const resp = await this.getClient().send(new GetGraphqlApiCommand({ apiId: physicalId }));
      api = resp.graphqlApi;
    } catch (err) {
      if (err instanceof AppSyncNotFoundException) return undefined;
      throw err;
    }
    if (!api) return undefined;

    const result: Record<string, unknown> = {};
    if (api.name !== undefined) result['Name'] = api.name;
    if (api.authenticationType !== undefined) {
      result['AuthenticationType'] = api.authenticationType;
    }
    result['XrayEnabled'] = api.xrayEnabled ?? false;
    {
      const log: Record<string, unknown> = {};
      if (api.logConfig?.cloudWatchLogsRoleArn !== undefined) {
        log['CloudWatchLogsRoleArn'] = api.logConfig.cloudWatchLogsRoleArn;
      }
      if (api.logConfig?.fieldLogLevel !== undefined) {
        log['FieldLogLevel'] = api.logConfig.fieldLogLevel;
      }
      if (api.logConfig?.excludeVerboseContent !== undefined) {
        log['ExcludeVerboseContent'] = api.logConfig.excludeVerboseContent;
      }
      result['LogConfig'] = log;
    }
    const tags = normalizeAwsTagsToCfn(api.tags);
    result['Tags'] = tags;

    // Reverse map for the config members wired in issue #609. Each is
    // emitted ONLY when AWS returned it, so a property the template never
    // set stays absent from both sides of the drift comparison.
    if (api.userPoolConfig) {
      result['UserPoolConfig'] = this.userPoolConfigToCfn(api.userPoolConfig);
    }
    if (api.openIDConnectConfig) {
      result['OpenIDConnectConfig'] = this.openIDConnectConfigToCfn(api.openIDConnectConfig);
    }
    if (api.lambdaAuthorizerConfig) {
      result['LambdaAuthorizerConfig'] = this.lambdaAuthorizerConfigToCfn(
        api.lambdaAuthorizerConfig
      );
    }
    if (api.additionalAuthenticationProviders) {
      result['AdditionalAuthenticationProviders'] = api.additionalAuthenticationProviders.map(
        (provider) => {
          const entry: Record<string, unknown> = {};
          if (provider.authenticationType !== undefined) {
            entry['AuthenticationType'] = provider.authenticationType;
          }
          if (provider.openIDConnectConfig) {
            entry['OpenIDConnectConfig'] = this.openIDConnectConfigToCfn(
              provider.openIDConnectConfig
            );
          }
          if (provider.userPoolConfig) {
            entry['UserPoolConfig'] = this.userPoolConfigToCfn(provider.userPoolConfig);
          }
          if (provider.lambdaAuthorizerConfig) {
            entry['LambdaAuthorizerConfig'] = this.lambdaAuthorizerConfigToCfn(
              provider.lambdaAuthorizerConfig
            );
          }
          return entry;
        }
      );
    }
    if (api.enhancedMetricsConfig) {
      const metrics: Record<string, unknown> = {};
      if (api.enhancedMetricsConfig.resolverLevelMetricsBehavior !== undefined) {
        metrics['ResolverLevelMetricsBehavior'] =
          api.enhancedMetricsConfig.resolverLevelMetricsBehavior;
      }
      if (api.enhancedMetricsConfig.dataSourceLevelMetricsBehavior !== undefined) {
        metrics['DataSourceLevelMetricsBehavior'] =
          api.enhancedMetricsConfig.dataSourceLevelMetricsBehavior;
      }
      if (api.enhancedMetricsConfig.operationLevelMetricsConfig !== undefined) {
        metrics['OperationLevelMetricsConfig'] =
          api.enhancedMetricsConfig.operationLevelMetricsConfig;
      }
      result['EnhancedMetricsConfig'] = metrics;
    }
    if (api.apiType !== undefined) result['ApiType'] = api.apiType;
    if (api.visibility !== undefined) result['Visibility'] = api.visibility;
    if (api.introspectionConfig !== undefined) {
      result['IntrospectionConfig'] = api.introspectionConfig;
    }
    if (api.queryDepthLimit !== undefined) result['QueryDepthLimit'] = api.queryDepthLimit;
    if (api.resolverCountLimit !== undefined) result['ResolverCountLimit'] = api.resolverCountLimit;
    if (api.ownerContact !== undefined) result['OwnerContact'] = api.ownerContact;
    if (api.mergedApiExecutionRoleArn !== undefined) {
      result['MergedApiExecutionRoleArn'] = api.mergedApiExecutionRoleArn;
    }

    // Environment variables live on their own read API. Best-effort: a
    // failure here must not fail the whole drift read.
    try {
      const envResp = await this.getClient().send(
        new GetGraphqlApiEnvironmentVariablesCommand({ apiId: physicalId })
      );
      if (envResp.environmentVariables !== undefined) {
        result['EnvironmentVariables'] = envResp.environmentVariables;
      }
    } catch (err) {
      // WARN, not debug: dropping the key here makes this read asymmetric with
      // the recorded baseline, which surfaces as a phantom "EnvironmentVariables
      // removed" drift that `--revert` would then act on.
      this.logger.warn(
        `Could not read AppSync GraphqlApi ${physicalId} environment variables ` +
          `(drift on that property will not be reported): ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }

    return result;
  }

  private userPoolConfigToCfn(
    config: UserPoolConfig | CognitoUserPoolConfig
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (config.userPoolId !== undefined) out['UserPoolId'] = config.userPoolId;
    if (config.awsRegion !== undefined) out['AwsRegion'] = config.awsRegion;
    if ('defaultAction' in config && config.defaultAction !== undefined) {
      out['DefaultAction'] = config.defaultAction;
    }
    if (config.appIdClientRegex !== undefined) out['AppIdClientRegex'] = config.appIdClientRegex;
    return out;
  }

  private openIDConnectConfigToCfn(config: OpenIDConnectConfig): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (config.issuer !== undefined) out['Issuer'] = config.issuer;
    if (config.clientId !== undefined) out['ClientId'] = config.clientId;
    if (config.iatTTL !== undefined) out['IatTTL'] = config.iatTTL;
    if (config.authTTL !== undefined) out['AuthTTL'] = config.authTTL;
    return out;
  }

  private lambdaAuthorizerConfigToCfn(config: LambdaAuthorizerConfig): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (config.authorizerUri !== undefined) out['AuthorizerUri'] = config.authorizerUri;
    if (config.authorizerResultTtlInSeconds !== undefined) {
      out['AuthorizerResultTtlInSeconds'] = config.authorizerResultTtlInSeconds;
    }
    if (config.identityValidationExpression !== undefined) {
      out['IdentityValidationExpression'] = config.identityValidationExpression;
    }
    return out;
  }

  private async readDataSource(physicalId: string): Promise<Record<string, unknown> | undefined> {
    const [apiId, name] = physicalId.split('|');
    if (!apiId || !name) return undefined;

    let ds;
    try {
      const resp = await this.getClient().send(new GetDataSourceCommand({ apiId, name }));
      ds = resp.dataSource;
    } catch (err) {
      if (err instanceof AppSyncNotFoundException) return undefined;
      throw err;
    }
    if (!ds) return undefined;

    const result: Record<string, unknown> = { ApiId: apiId };
    if (ds.name !== undefined) result['Name'] = ds.name;
    if (ds.type !== undefined) result['Type'] = ds.type;
    // Description is optional; emit '' as placeholder so a console-side
    // Description add surfaces as drift on the v2-fallback path. Empty
    // string is a valid AWS input for Description.
    result['Description'] = ds.description ?? '';
    // ServiceRoleArn must be a valid IAM ARN when present. Don't emit a
    // '' placeholder — the round-trip would try to push an empty string
    // back to AWS, which fails ARN format validation. Class 2: only
    // emit when AWS reports a real value.
    if (ds.serviceRoleArn !== undefined && ds.serviceRoleArn !== '') {
      result['ServiceRoleArn'] = ds.serviceRoleArn;
    }
    // DataSource has type-tagged sub-configs (DynamoDBConfig / LambdaConfig /
    // HttpConfig / etc.) that are mutually exclusive based on `Type`. Only
    // emit the matching shape when its discriminator is non-empty so the
    // comparator doesn't surface an empty placeholder for a config that
    // doesn't apply to this data source's type.
    if (ds.dynamodbConfig) {
      const dynamo: Record<string, unknown> = {};
      if (ds.dynamodbConfig.tableName !== undefined)
        dynamo['TableName'] = ds.dynamodbConfig.tableName;
      if (ds.dynamodbConfig.awsRegion !== undefined)
        dynamo['AwsRegion'] = ds.dynamodbConfig.awsRegion;
      if (ds.dynamodbConfig.useCallerCredentials !== undefined) {
        dynamo['UseCallerCredentials'] = ds.dynamodbConfig.useCallerCredentials;
      }
      if (ds.dynamodbConfig.versioned !== undefined) {
        dynamo['Versioned'] = ds.dynamodbConfig.versioned;
      }
      const delta = ds.dynamodbConfig.deltaSyncConfig;
      if (delta) {
        const deltaOut: Record<string, unknown> = {};
        // Back to STRINGS — the CFn declared type, and therefore the shape the
        // template baseline carries. Emitting the SDK's number would show up
        // as permanent phantom drift (`"3600"` vs `3600` under the
        // stringify-based comparator) on every run.
        //
        // Known bound: the write side ALSO accepts a numeric TTL (a template
        // that already used a number), so on the `properties`-fallback drift
        // baseline — a resource with no `observedProperties`, e.g. one
        // deployed before observed-capture or whose capture failed — a
        // numeric template value compares against this string and reports
        // drift `--revert` cannot clear. Narrow (the observed baseline is
        // symmetric) and NOT fixable by matching the input's type here: the
        // read side has no access to the template value, and emitting the
        // number would break the far more common CFn-typed string case.
        if (delta.baseTableTTL !== undefined) deltaOut['BaseTableTTL'] = String(delta.baseTableTTL);
        if (delta.deltaSyncTableName !== undefined) {
          deltaOut['DeltaSyncTableName'] = delta.deltaSyncTableName;
        }
        if (delta.deltaSyncTableTTL !== undefined) {
          deltaOut['DeltaSyncTableTTL'] = String(delta.deltaSyncTableTTL);
        }
        if (Object.keys(deltaOut).length > 0) dynamo['DeltaSyncConfig'] = deltaOut;
      }
      if (Object.keys(dynamo).length > 0) result['DynamoDBConfig'] = dynamo;
    }
    if (ds.lambdaConfig?.lambdaFunctionArn !== undefined) {
      result['LambdaConfig'] = { LambdaFunctionArn: ds.lambdaConfig.lambdaFunctionArn };
    }
    if (ds.httpConfig) {
      const httpOut: Record<string, unknown> = {};
      if (ds.httpConfig.endpoint !== undefined) httpOut['Endpoint'] = ds.httpConfig.endpoint;
      const authRead = ds.httpConfig.authorizationConfig;
      if (authRead) {
        const authOut: Record<string, unknown> = {};
        if (authRead.authorizationType !== undefined) {
          authOut['AuthorizationType'] = authRead.authorizationType;
        }
        const iamRead = authRead.awsIamConfig;
        if (iamRead) {
          const iamOut: Record<string, unknown> = {};
          if (iamRead.signingRegion !== undefined) iamOut['SigningRegion'] = iamRead.signingRegion;
          if (iamRead.signingServiceName !== undefined) {
            iamOut['SigningServiceName'] = iamRead.signingServiceName;
          }
          if (Object.keys(iamOut).length > 0) authOut['AwsIamConfig'] = iamOut;
        }
        if (Object.keys(authOut).length > 0) httpOut['AuthorizationConfig'] = authOut;
      }
      if (Object.keys(httpOut).length > 0) result['HttpConfig'] = httpOut;
    }
    // Reverse maps for the configs wired in issue #609. Each block is
    // emitted ONLY when AWS returned it, which is the response-side form of
    // the Type discriminator gating (Class 1) — AWS returns exactly the
    // config matching the data source's `type`.
    if (ds.elasticsearchConfig) {
      const es: Record<string, unknown> = {};
      if (ds.elasticsearchConfig.endpoint !== undefined) {
        es['Endpoint'] = ds.elasticsearchConfig.endpoint;
      }
      if (ds.elasticsearchConfig.awsRegion !== undefined) {
        es['AwsRegion'] = ds.elasticsearchConfig.awsRegion;
      }
      if (Object.keys(es).length > 0) result['ElasticsearchConfig'] = es;
    }
    if (ds.openSearchServiceConfig) {
      const os: Record<string, unknown> = {};
      if (ds.openSearchServiceConfig.endpoint !== undefined) {
        os['Endpoint'] = ds.openSearchServiceConfig.endpoint;
      }
      if (ds.openSearchServiceConfig.awsRegion !== undefined) {
        os['AwsRegion'] = ds.openSearchServiceConfig.awsRegion;
      }
      if (Object.keys(os).length > 0) result['OpenSearchServiceConfig'] = os;
    }
    if (ds.eventBridgeConfig?.eventBusArn !== undefined) {
      result['EventBridgeConfig'] = { EventBusArn: ds.eventBridgeConfig.eventBusArn };
    }
    if (ds.relationalDatabaseConfig) {
      const rds: Record<string, unknown> = {};
      if (ds.relationalDatabaseConfig.relationalDatabaseSourceType !== undefined) {
        rds['RelationalDatabaseSourceType'] =
          ds.relationalDatabaseConfig.relationalDatabaseSourceType;
      }
      const endpoint = ds.relationalDatabaseConfig.rdsHttpEndpointConfig;
      if (endpoint) {
        const ep: Record<string, unknown> = {};
        if (endpoint.awsRegion !== undefined) ep['AwsRegion'] = endpoint.awsRegion;
        if (endpoint.dbClusterIdentifier !== undefined) {
          ep['DbClusterIdentifier'] = endpoint.dbClusterIdentifier;
        }
        if (endpoint.databaseName !== undefined) ep['DatabaseName'] = endpoint.databaseName;
        if (endpoint.schema !== undefined) ep['Schema'] = endpoint.schema;
        if (endpoint.awsSecretStoreArn !== undefined) {
          ep['AwsSecretStoreArn'] = endpoint.awsSecretStoreArn;
        }
        if (Object.keys(ep).length > 0) rds['RdsHttpEndpointConfig'] = ep;
      }
      if (Object.keys(rds).length > 0) result['RelationalDatabaseConfig'] = rds;
    }
    if (ds.metricsConfig !== undefined) {
      result['MetricsConfig'] = ds.metricsConfig;
    }
    return result;
  }

  private async readResolver(physicalId: string): Promise<Record<string, unknown> | undefined> {
    const parts = physicalId.split('|');
    if (parts.length < 3) return undefined;
    const [apiId, typeName, fieldName] = parts;
    if (!apiId || !typeName || !fieldName) return undefined;

    let resolver;
    try {
      const resp = await this.getClient().send(
        new GetResolverCommand({ apiId, typeName, fieldName })
      );
      resolver = resp.resolver;
    } catch (err) {
      if (err instanceof AppSyncNotFoundException) return undefined;
      throw err;
    }
    if (!resolver) return undefined;

    const result: Record<string, unknown> = { ApiId: apiId };
    if (resolver.typeName !== undefined) result['TypeName'] = resolver.typeName;
    if (resolver.fieldName !== undefined) result['FieldName'] = resolver.fieldName;
    if (resolver.kind !== undefined) result['Kind'] = resolver.kind;

    // Resolver shape is type-discriminator-tagged on `Kind`:
    //   - Kind=UNIT     → DataSourceName is required, PipelineConfig is N/A
    //   - Kind=PIPELINE → PipelineConfig.Functions is required, DataSourceName is N/A
    // AWS rejects `CreateResolver` / `UpdateResolver` when these are
    // crossed (e.g. PipelineConfig on a UNIT resolver, DataSourceName on
    // a PIPELINE resolver). Class 1: gate on the discriminator.
    const kind = resolver.kind ?? 'UNIT';
    if (kind === 'PIPELINE') {
      result['PipelineConfig'] = {
        Functions: resolver.pipelineConfig?.functions ? [...resolver.pipelineConfig.functions] : [],
      };
    } else {
      // UNIT (or unspecified — AWS defaults to UNIT)
      if (resolver.dataSourceName !== undefined && resolver.dataSourceName !== '') {
        result['DataSourceName'] = resolver.dataSourceName;
      }
    }

    // VTL vs JS resolver shape is discriminated by the presence of `runtime`
    // on the AWS response:
    //   - VTL → RequestMappingTemplate / ResponseMappingTemplate (strings)
    //   - JS  → Code (string) + Runtime ({ Name, RuntimeVersion })
    // AWS rejects mixing the two. Class 1: gate on whether `runtime` is
    // returned by AWS.
    if (resolver.runtime?.name) {
      // JS resolver — emit Code + Runtime; do NOT emit VTL templates.
      result['Code'] = resolver.code ?? '';
      const runtime: Record<string, unknown> = { Name: resolver.runtime.name };
      if (resolver.runtime.runtimeVersion !== undefined) {
        runtime['RuntimeVersion'] = resolver.runtime.runtimeVersion;
      }
      result['Runtime'] = runtime;
    } else {
      // VTL resolver — emit Request/ResponseMappingTemplate placeholders so
      // a console-side template change surfaces as drift; do NOT emit Code
      // / Runtime (they'd be rejected as invalid for a VTL resolver).
      result['RequestMappingTemplate'] = resolver.requestMappingTemplate ?? '';
      result['ResponseMappingTemplate'] = resolver.responseMappingTemplate ?? '';
    }

    // Reverse maps for the properties wired in issue #609. Each is emitted
    // ONLY when AWS returned it, so a property the template never set stays
    // absent from both sides of the drift comparison. The three *S3Location
    // properties have no readable AWS form (getDriftUnknownPaths).
    if (resolver.cachingConfig) {
      const caching: Record<string, unknown> = {};
      if (resolver.cachingConfig.ttl !== undefined) caching['Ttl'] = resolver.cachingConfig.ttl;
      if (resolver.cachingConfig.cachingKeys !== undefined) {
        caching['CachingKeys'] = [...resolver.cachingConfig.cachingKeys];
      }
      if (Object.keys(caching).length > 0) result['CachingConfig'] = caching;
    }
    if (resolver.syncConfig) {
      const sync: Record<string, unknown> = {};
      if (resolver.syncConfig.conflictDetection !== undefined) {
        sync['ConflictDetection'] = resolver.syncConfig.conflictDetection;
      }
      if (resolver.syncConfig.conflictHandler !== undefined) {
        sync['ConflictHandler'] = resolver.syncConfig.conflictHandler;
      }
      if (resolver.syncConfig.lambdaConflictHandlerConfig?.lambdaConflictHandlerArn !== undefined) {
        sync['LambdaConflictHandlerConfig'] = {
          LambdaConflictHandlerArn:
            resolver.syncConfig.lambdaConflictHandlerConfig.lambdaConflictHandlerArn,
        };
      }
      if (Object.keys(sync).length > 0) result['SyncConfig'] = sync;
    }
    if (resolver.maxBatchSize !== undefined) {
      result['MaxBatchSize'] = resolver.maxBatchSize;
    }
    if (resolver.metricsConfig !== undefined) {
      result['MetricsConfig'] = resolver.metricsConfig;
    }
    return result;
  }

  private async readApiKey(physicalId: string): Promise<Record<string, unknown> | undefined> {
    const [apiId, apiKeyId] = physicalId.split('|');
    if (!apiId || !apiKeyId) return undefined;

    // AppSync has no `GetApiKey` SDK command; paginate `ListApiKeys` to find
    // the matching id.
    let nextToken: string | undefined;
    do {
      let resp;
      try {
        resp = await this.getClient().send(
          new ListApiKeysCommand({ apiId, ...(nextToken && { nextToken }) })
        );
      } catch (err) {
        if (err instanceof AppSyncNotFoundException) return undefined;
        throw err;
      }
      for (const key of resp.apiKeys ?? []) {
        if (key.id === apiKeyId) {
          const result: Record<string, unknown> = { ApiId: apiId };
          result['Description'] = key.description ?? '';
          if (key.expires !== undefined) result['Expires'] = key.expires;
          return result;
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    return undefined;
  }

  /**
   * Adopt an existing AppSync resource into cdkd state.
   *
   * `AWS::AppSync::GraphQLApi` resolves an explicit `--resource` override
   * (verified via `GetGraphqlApi`). There is no `aws:cdk:path` tag walk —
   * AWS rejects `aws:`-prefixed tag writes, so that tag never exists on a
   * real resource (issue #1134); auto-mode import resolves ids from
   * CloudFormation's `DescribeStackResources` instead. AppSync sub-resources
   * (`GraphQLSchema`, `DataSource`, `Resolver`, `ApiKey`) are scoped under a
   * parent `apiId` — explicit-override only. The three ARN-`Ref` children
   * additionally record the same attribute set `create()` does, so an adopted
   * child's `Ref` / `Fn::GetAtt` resolve immediately rather than only after its
   * first update (issue #1728) — see {@link childImportAttributes}.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType !== 'AWS::AppSync::GraphQLApi') {
      if (input.knownPhysicalId) {
        return {
          physicalId: input.knownPhysicalId,
          attributes: await this.childImportAttributes(
            input.resourceType,
            input.knownPhysicalId,
            input.region
          ),
        };
      }
      return null;
    }

    const explicit = resolveExplicitPhysicalId(input, null);
    if (explicit) {
      try {
        await this.getClient().send(new GetGraphqlApiCommand({ apiId: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof AppSyncNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // GraphQL API reaching here needs an explicit `--resource` override.
    return null;
  }
}
