import type {
  AdditionalAuthenticationProvider,
  AuthenticationType,
  CognitoUserPoolConfig,
  DefaultAction,
  EnhancedMetricsConfig,
  GraphQLApiIntrospectionConfig,
  LambdaAuthorizerConfig,
  OpenIDConnectConfig,
  UserPoolConfig,
  CreateGraphqlApiCommandInput,
  UpdateGraphqlApiCommandInput,
} from '@aws-sdk/client-appsync';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { requireConfigArray } from '../../config-shape.js';
import { maskDeep, type MaskerFn } from '../../masked-retry-logger.js';
import type { ShapeGuardOptions } from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

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
export function asObject(
  this: AppSyncProvider,
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
export function toDeltaSyncTtl(
  this: AppSyncProvider,
  value: unknown,
  path: string,
  logicalId: string,
  resourceType: string,
  mask: MaskerFn
): number {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? value.trim() : undefined;
  const parsed = numeric === undefined || numeric === '' ? Number.NaN : Number(numeric);
  if (!Number.isFinite(parsed)) {
    throw new ProvisioningError(
      `${resourceType} ${path} must be a number of minutes (CFn types it as a ` +
        `string), got ${JSON.stringify(maskDeep(value, mask))} — cdkd refuses to drop it ` +
        `silently`,
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
export function toSdkUserPoolConfig(
  this: AppSyncProvider,
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
export function toSdkCognitoUserPoolConfig(
  this: AppSyncProvider,
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

export function toSdkOpenIDConnectConfig(
  this: AppSyncProvider,
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

export function toSdkLambdaAuthorizerConfig(
  this: AppSyncProvider,
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

export function toSdkAdditionalAuthProviders(
  this: AppSyncProvider,
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
    // `.detail` keeps the text byte-identical to the ternary it replaced,
    // minus that ternary's throw. There is NO substring test here -- unlike
    // the other twelve sites this sweep converted: `message` goes to
    // `options.onUnusable(...)` or into the throw below, which
    // `extractDeploymentEventError` persists (one of the ten such sites; the
    // disclosure question is go-to-k/cdkd#2319's). And per the comment above,
    // the value is cdkd-authored, not AWS's -- so the `.summary` hazard that
    // applies elsewhere does not arise. Kept for the out-throw alone.
    const message = describeAwsFailure(error).detail;
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
  // An entry-level or nested downgrade drops the WHOLE list, never one
  // member of one entry: `UpdateGraphqlApi` REPLACES the list, so sending the
  // rest would rewrite the live providers the "(leaving the live value
  // untouched)" warning promises to keep. Returning `undefined` omits the
  // member, which AppSync treats as "no change" (and a replay-create
  // proceeds without the block, as its warning says).
  let dropped = false;
  const entryOptions: ShapeGuardOptions | undefined = options?.onUnusable
    ? {
        ...options,
        onUnusable: (message: string) => {
          dropped = true;
          options.onUnusable?.(message);
        },
      }
    : options;
  const providers = entries.map((entry, index) => {
    const at = `AdditionalAuthenticationProviders[${index}]`;
    // `requireConfigArray` validates the CONTAINER, not its ELEMENTS — a
    // list of strings would index to `undefined` on every key and send an
    // empty provider object to AWS: the same silent drop one level down.
    const cfn = this.asObject(entry, at, entryOptions) ?? {};
    const provider: AdditionalAuthenticationProvider = {};
    if (cfn['AuthenticationType'] !== undefined) {
      provider.authenticationType = cfn['AuthenticationType'] as AuthenticationType;
    }
    const oidc = this.toSdkOpenIDConnectConfig(
      cfn['OpenIDConnectConfig'],
      `${at}.OpenIDConnectConfig`,
      entryOptions
    );
    if (oidc) provider.openIDConnectConfig = oidc;
    // The additional-provider variant is AWS's CognitoUserPoolConfig, which
    // has NO defaultAction member — a different shape from the top-level one.
    const pool = this.toSdkCognitoUserPoolConfig(
      cfn['UserPoolConfig'],
      `${at}.UserPoolConfig`,
      entryOptions
    );
    if (pool) provider.userPoolConfig = pool;
    const lambda = this.toSdkLambdaAuthorizerConfig(
      cfn['LambdaAuthorizerConfig'],
      `${at}.LambdaAuthorizerConfig`,
      entryOptions
    );
    if (lambda) provider.lambdaAuthorizerConfig = lambda;
    return provider;
  });
  return dropped ? undefined : providers;
}

export function toSdkEnhancedMetricsConfig(
  this: AppSyncProvider,
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
export function applyGraphQLApiConfig(
  this: AppSyncProvider,
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

  const userPool = this.toSdkUserPoolConfig(properties['UserPoolConfig'], 'UserPoolConfig', guard);
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
    input.introspectionConfig = properties['IntrospectionConfig'] as GraphQLApiIntrospectionConfig;
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
