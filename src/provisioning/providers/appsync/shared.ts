import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { CompositeIdFormat } from '../../composite-id.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { APPSYNC_APIKEY_ARN_RESOURCE_PATH, maskedSecretSegment } from '../../secret-physical-id.js';

/**
 * Retry-safety state for `CreateGraphqlApi`, which has no idempotency token
 * and whose API name AWS does not require to be unique (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `AppSyncProvider.reportPossibleOrphanApis`. Module-scoped: a provider
 * instance is per registry, and one process can build several.
 */
export const createGraphqlApiLatch = new AmbiguousCreateLatch('CreateGraphqlApi');
/** APIs this process created and recorded, never reported as orphan candidates. */
export const graphqlApisCreatedByThisProcess = new RecentIdSet();

/** Page ceiling for the `ListGraphqlApis` lookup (25 APIs a page). */
export const MAX_GRAPHQL_API_LIST_PAGES = 40;

/** Most API ids one orphan report names. */
export const MAX_REPORTED_ORPHAN_APIS = 5;

/**
 * The same for `CreateApiKey`, which has no idempotency token either and
 * whose keys carry no name at all (issue #2080); see
 * `AppSyncProvider.reportPossibleOrphanApiKeys`.
 */
export const createApiKeyLatch = new AmbiguousCreateLatch('CreateApiKey');
/** Keys this process created and recorded, as `injectiveKey(apiId, keyId)`, never reported as orphan candidates. */
export const apiKeysCreatedByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state (`CreateGraphqlApi` and `CreateApiKey`). TEST-ONLY. */
export function resetGraphqlApiCreateRetryStateForTests(): void {
  createGraphqlApiLatch.resetForTests();
  graphqlApisCreatedByThisProcess.resetForTests();
  createApiKeyLatch.resetForTests();
  apiKeysCreatedByThisProcess.resetForTests();
}

/** Shapes of the three `AWS::AppSync::*` child composite physicalIds (issue #1657). */
export const APPSYNC_DATASOURCE_ID_FORMAT: CompositeIdFormat = {
  label: 'AppSync DataSource',
  segments: ['apiId', 'name'],
};

export const APPSYNC_RESOLVER_ID_FORMAT: CompositeIdFormat = {
  label: 'AppSync Resolver',
  segments: ['apiId', 'typeName', 'fieldName'],
};

export const APPSYNC_APIKEY_ID_FORMAT: CompositeIdFormat = {
  label: 'AppSync ApiKey',
  segments: ['apiId', 'apiKeyId'],
};

/**
 * An `AWS::AppSync::ApiKey` id as a log line or message may print it. The id
 * IS the credential a client sends as `x-api-key`, so only its last four
 * characters are shown (go-to-k/cdkd#5860) — the spelling the orphan report
 * uses, enough to find the key in `list-api-keys` output.
 */
export function maskedApiKeyId(apiKeyId: string): string {
  // The engine's declaration of secret ids (go-to-k/cdkd#5868) owns the form.
  return maskedSecretSegment(apiKeyId);
}

/**
 * An ApiKey physical id (`<apiId>|<apiKeyId>`) with its key segment masked by
 * {@link maskedApiKeyId}. Any other shape is masked WHOLE: which part of a
 * malformed id is the key cannot be told, so it errs toward over-masking.
 */
export function displayApiKeyPhysicalId(physicalId: string): string {
  const parts = physicalId.split('|');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `${parts[0]}|${maskedApiKeyId(parts[1])}`;
  }
  return maskedApiKeyId(physicalId);
}

/** `physicalId` as a message may print it: masked for an ApiKey, unchanged for every other AppSync type. */
export function displayAppSyncPhysicalId(resourceType: string, physicalId: string): string {
  return resourceType === 'AWS::AppSync::ApiKey' ? displayApiKeyPhysicalId(physicalId) : physicalId;
}

/**
 * `mask`, followed by replacing every occurrence of `apiKeyId` with
 * {@link maskedApiKeyId} — for a message that may quote the key back (an AWS
 * failure's text, a composite-id refusal). No key means `mask` unchanged.
 */
export function withApiKeyMasked(mask: MaskerFn, apiKeyId: string | undefined): MaskerFn {
  if (!apiKeyId) return mask;
  const masked = maskedApiKeyId(apiKeyId);
  return (text: string) => mask(text).split(apiKeyId).join(masked);
}

/**
 * The resource path of an AppSync ARN as CloudFormation records it for each
 * type (measured with `DescribeStackResources`, go-to-k/cdkd#5364), mapped to
 * the segments of cdkd's physical id. No segment may hold `/` or `|`, so an ARN
 * whose segment would break cdkd's `|`-joined id matches nothing.
 */
export const CFN_APPSYNC_ARN_RESOURCE_PATHS: Readonly<Record<string, RegExp>> = {
  'AWS::AppSync::GraphQLApi': /^apis\/([^/|]+)$/,
  'AWS::AppSync::DataSource': /^apis\/([^/|]+)\/datasources\/([^/|]+)$/,
  'AWS::AppSync::Resolver': /^apis\/([^/|]+)\/types\/([^/|]+)\/resolvers\/([^/|]+)$/,
  // CloudFormation writes `apikeys/` (as cdkd builds since #5540); the ARN
  // AppSync documents says `apikey/`. Shared with the secret-id declaration.
  'AWS::AppSync::ApiKey': APPSYNC_APIKEY_ARN_RESOURCE_PATH,
};

/**
 * The API id a GraphQLSchema physical id names: cdkd records the bare API id,
 * CloudFormation `<apiId>GraphQLSchema` — which a record migrated before
 * go-to-k/cdkd#5364 still holds. AppSync API ids are lowercase alphanumeric,
 * so the suffix is unambiguous.
 */
export function graphQLSchemaApiId(physicalId: string): string {
  const schema = /^([a-z0-9]+)GraphQLSchema$/.exec(physicalId);
  return schema ? schema[1]! : physicalId;
}

/**
 * cdkd's physical id for an AppSync resource CloudFormation identifies
 * differently (go-to-k/cdkd#5364). `cdkd import --migrate-from-cloudformation`
 * hands `import()` the id `DescribeStackResources` reports: the ARN for the
 * API and the three ARN-identified children, and `<apiId>GraphQLSchema` for a
 * schema. cdkd's own records hold the bare API id and the `|`-joined child ids,
 * and every reader addresses AppSync with those, so a verbatim CloudFormation
 * id sends `GetGraphqlApi` / `GetIntrospectionSchema` an API that does not
 * exist. Any other shape is returned unchanged.
 *
 * An ARN in another region is REFUSED: the provider's client is the import
 * region's, so the bare id would address an API of the same id there, or none.
 */
export function appSyncPhysicalIdFromCfn(
  resourceType: string,
  logicalId: string,
  physicalId: string,
  region: string
): string {
  if (resourceType === 'AWS::AppSync::GraphQLSchema') return graphQLSchemaApiId(physicalId);
  const pathPattern = CFN_APPSYNC_ARN_RESOURCE_PATHS[resourceType];
  const arn = /^arn:[^:]+:appsync:([^:]*):[^:]*:(.+)$/.exec(physicalId);
  const segments = pathPattern && arn ? pathPattern.exec(arn[2]!) : null;
  if (!arn || !segments) return physicalId;
  if (canonicalizeRegion(arn[1]!) !== canonicalizeRegion(region)) {
    // An ApiKey ARN ends in the key itself (go-to-k/cdkd#5860).
    const shown =
      resourceType === 'AWS::AppSync::ApiKey'
        ? physicalId.split(segments[2]!).join(maskedApiKeyId(segments[2]!))
        : physicalId;
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${shown} is in region ${arn[1]}, not the import region ${region}`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  return segments.slice(1).join('|');
}

/**
 * What state records for `GraphQLApi.EnvironmentVariables` when the env-var arm
 * sent something other than the desired map (issue #3781): the map AWS holds
 * afterwards, or `undefined` to drop the key.
 */
export interface EnvironmentVariablesRecord {
  value: Record<string, unknown> | undefined;
}

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
export interface ShapeGuardOptions {
  readonly logicalId?: string;
  readonly onUnusable?: (message: string) => void;
}

export const MUTABLE_GRAPHQL_API_CONFIG_PROPERTIES = [
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
