import {
  GetGraphqlApiCommand,
  GetGraphqlApiEnvironmentVariablesCommand,
  GetIntrospectionSchemaCommand,
  NotFoundException as AppSyncNotFoundException,
  type CognitoUserPoolConfig,
  type LambdaAuthorizerConfig,
  type OpenIDConnectConfig,
  type UserPoolConfig,
} from '@aws-sdk/client-appsync';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { type ResourceNotFound, RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { graphQLSchemaApiId } from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

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
 * Returns `RESOURCE_NOT_FOUND` when AWS reports the resource gone
 * (`NotFoundException`, or an ApiKey no longer listed).
 */
export async function readCurrentState(
  this: AppSyncProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
 *
 * `graphql` is imported here, not at module scope: every provider module
 * is evaluated whenever a command registers providers, and graphql-js is
 * ~70 ms of CPU that only an AppSync schema drift read needs. The import
 * sits OUTSIDE the `try` so a failure to load it is not mistaken for an
 * unparseable SDL.
 */
export async function canonicalizeSdl(
  this: AppSyncProvider,
  sdl: string,
  source: 'state' | 'aws'
): Promise<string> {
  const { parse, print } = await import('graphql');
  try {
    return print(parse(sdl));
  } catch (err) {
    this.logger.debug(
      `Failed to parse ${source} SDL via graphql-js (falling back to raw): ${
        describeAwsFailure(err).detail
      }`
    );
    return sdl;
  }
}

export async function readGraphQLSchema(
  this: AppSyncProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const apiId = graphQLSchemaApiId(physicalId);
  let resp;
  try {
    resp = await this.getClient().send(new GetIntrospectionSchemaCommand({ apiId, format: 'SDL' }));
  } catch (err) {
    if (err instanceof AppSyncNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }

  const schemaBytes = resp.schema;
  if (!schemaBytes) return undefined;

  // AWS returns SDL as Uint8Array (UTF-8). Decode and canonicalize via
  // graphql-js parse → print so cosmetic differences (whitespace,
  // comments, blank lines) do not fire false drift.
  const awsSdl = new TextDecoder().decode(schemaBytes);
  const canonicalAws = await this.canonicalizeSdl(awsSdl, 'aws');

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
    const canonicalState = await this.canonicalizeSdl(stateDefinition, 'state');
    if (canonicalState === canonicalAws) {
      definitionToReturn = stateDefinition;
    }
  }

  return {
    ApiId: apiId,
    Definition: definitionToReturn,
  };
}

export async function readGraphQLApi(
  this: AppSyncProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let api;
  try {
    const resp = await this.getClient().send(new GetGraphqlApiCommand({ apiId: physicalId }));
    api = resp.graphqlApi;
  } catch (err) {
    if (err instanceof AppSyncNotFoundException) return RESOURCE_NOT_FOUND;
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
    result['LambdaAuthorizerConfig'] = this.lambdaAuthorizerConfigToCfn(api.lambdaAuthorizerConfig);
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
        `(drift on that property will not be reported): ${describeAwsFailure(err).detail}`
    );
  }

  return result;
}

export function userPoolConfigToCfn(
  this: AppSyncProvider,
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

export function openIDConnectConfigToCfn(
  this: AppSyncProvider,
  config: OpenIDConnectConfig
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.issuer !== undefined) out['Issuer'] = config.issuer;
  if (config.clientId !== undefined) out['ClientId'] = config.clientId;
  if (config.iatTTL !== undefined) out['IatTTL'] = config.iatTTL;
  if (config.authTTL !== undefined) out['AuthTTL'] = config.authTTL;
  return out;
}

export function lambdaAuthorizerConfigToCfn(
  this: AppSyncProvider,
  config: LambdaAuthorizerConfig
): Record<string, unknown> {
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
