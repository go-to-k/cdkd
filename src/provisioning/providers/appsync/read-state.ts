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
import { safeMsg } from '../../../utils/display-safe.js';
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
 *    do not fire false drift. A default `schema { query: Query }` block is
 *    normalized away on both sides (the spec allows omitting it, AWS's SDL
 *    always has it; a non-default root name or a directive on it is kept).
 *    Field-order differences are intentionally
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

/** The root type name each operation takes when a schema definition is omitted. */
const DEFAULT_ROOT_TYPE_NAMES: Record<string, string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
};

/**
 * Canonicalize an SDL string via `graphql-js` `parse` → `print`.
 *
 * A DEFAULT schema definition is dropped: one with no description and no
 * directives whose every operation maps to `Query` / `Mutation` /
 * `Subscription`. The GraphQL spec lets that block be omitted, so it carries
 * no information; but AWS's `GetIntrospectionSchema` SDL always includes it
 * (`schema { query: Query }`) while a CDK schema file usually omits it, which
 * made every such stack drift right after deploy (#6779). A schema definition
 * naming a non-default root type, or carrying directives, is kept so a real
 * change still shows as drift. It is also kept when it lists fewer roots than
 * the document has default-named object types (`schema { query: Query }` plus
 * `type Mutation`), since dropping it would promote Mutation to a root.
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
  const { parse, print, Kind } = await import('graphql');
  try {
    const doc = parse(sdl);
    // With a schema block present ONLY the operations it lists are roots, so
    // dropping it is lossless only when, per operation, "the block lists it"
    // equals "the document defines the default-named object type": otherwise
    // `schema { query: Query }` + `type Mutation` would collapse onto a
    // schema-less document whose Mutation IS a root.
    const objectTypeNames = new Set<string>();
    for (const def of doc.definitions) {
      if (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) {
        objectTypeNames.add(def.name.value);
      }
    }
    const definitions = doc.definitions.filter((def) => {
      if (def.kind !== Kind.SCHEMA_DEFINITION) return true;
      const listed = new Map<string, string>(
        def.operationTypes.map((op) => [op.operation, op.type.name.value])
      );
      const isDefault =
        !def.description &&
        (def.directives?.length ?? 0) === 0 &&
        [...listed].every(([op, name]) => name === DEFAULT_ROOT_TYPE_NAMES[op]) &&
        Object.entries(DEFAULT_ROOT_TYPE_NAMES).every(
          ([op, name]) => listed.has(op) === objectTypeNames.has(name)
        );
      return !isDefault;
    });
    return print({ ...doc, definitions });
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

/**
 * go-to-k/cdkd#7139: the `DefinitionS3Location` half of the pre-#7127 schema
 * heal (`preFixBaselineUncomparedDriftKeys` covers an inline `Definition`).
 * Before #7127 the observed baseline was read while AppSync still served the
 * schema the deploy replaced, so drift reported `Definition` on an untouched
 * schema and `drift --revert` pushed the previous one back, dropping the
 * resolvers of the fields it lacked. A template sourcing the SDL from S3
 * declares no SDL to compare with, so the declared object is read: when the
 * live SDL is its body (both through {@link canonicalizeSdl}) the baseline
 * takes the live `Definition`, and `drift --revert`, which passes its desired
 * bag through this hook, sends the live schema rather than the stale one.
 *
 * One `GetObject`, and only when the comparison would otherwise report
 * `Definition`: an observed baseline whose `Definition` is not the live one,
 * on a template with no inline `Definition`. A clean schema, a template
 * baseline (no `Definition` recorded) and an inline schema read nothing. A
 * failed read heals nothing (the difference stays visible) and does not fail
 * drift; its debug line names the error class only, since the AWS text is not
 * masked here. A live SDL other than the declared body stays compared.
 *
 * "Declared" is the object's CURRENT body, and the rule applies to any
 * observed baseline meeting the gate, not only a pre-#7127 one: state is not
 * rewritten, so each drift run pays the read until the next capture or
 * `cdkd state refresh-observed`. A CDK asset key is content-hashed, so its
 * body is what was deployed; an object overwritten at a mutable key and then
 * applied out of band reads as declared (CloudFormation does not see that
 * either). A template declaring both `Definition` and `DefinitionS3Location`
 * deploys the inline one, so it is left to the inline rule. A stale baseline
 * beside an out-of-band change (recorded v1, declared v2, live v3) is not
 * healed, since the live SDL is not the declared body: `drift --revert` then
 * sends the recorded v1, as it does for any baseline it cannot tell from an
 * accepted one.
 */
export async function canonicalizeDriftPair(
  this: AppSyncProvider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties?: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  const unchanged = { baseline, aws };
  if (resourceType !== 'AWS::AppSync::GraphQLSchema' || properties === undefined) {
    return unchanged;
  }
  const location = properties['DefinitionS3Location'];
  const recorded = baseline['Definition'];
  const live = aws['Definition'];
  if (
    properties['Definition'] !== undefined ||
    typeof location !== 'string' ||
    location === '' ||
    typeof recorded !== 'string' ||
    typeof live !== 'string' ||
    live === '' ||
    recorded === live
  ) {
    return unchanged;
  }
  let body: string;
  try {
    body = await this.fetchS3LocationBody(
      location,
      resourceType,
      // A label, not a logical id: it reaches the helper's fetch debug line
      // and its error, which only feeds the class-only debug line below.
      '(drift baseline heal)',
      'DefinitionS3Location'
    );
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    this.logger.debug(
      safeMsg`Could not read the declared GraphQL schema object (${
        cause instanceof Error ? cause.name : 'unknown error'
      }); comparing Definition against the recorded baseline`
    );
    return unchanged;
  }
  const [declared, current] = await Promise.all([
    this.canonicalizeSdl(body, 'state'),
    this.canonicalizeSdl(live, 'aws'),
  ]);
  return declared === current ? { baseline: { ...baseline, Definition: live }, aws } : unchanged;
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

  // Environment variables live on their own read API. An API gone under the
  // read (`NotFoundException`) leaves the key out; any other failure throws
  // (go-to-k/cdkd#6759): dropping the key made this read asymmetric with the
  // recorded baseline, a phantom "EnvironmentVariables removed" drift that
  // `--revert` would then act on, so `cdkd drift` reports `readFailed` instead.
  try {
    const envResp = await this.getClient().send(
      new GetGraphqlApiEnvironmentVariablesCommand({ apiId: physicalId })
    );
    if (envResp.environmentVariables !== undefined) {
      result['EnvironmentVariables'] = envResp.environmentVariables;
    }
  } catch (err) {
    if (!(err instanceof AppSyncNotFoundException)) throw err;
    this.logger.debug(
      `AppSync GraphqlApi ${physicalId} environment variables read answered NotFoundException: ${describeAwsFailure(err).detail}`
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
