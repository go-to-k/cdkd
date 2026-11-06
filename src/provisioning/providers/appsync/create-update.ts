import {
  GetGraphqlApiCommand,
  UpdateGraphqlApiCommand,
  type AuthenticationType,
  type UpdateGraphqlApiCommandInput,
} from '@aws-sdk/client-appsync';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { type ShapeGuardOptions, MUTABLE_GRAPHQL_API_CONFIG_PROPERTIES } from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

// ─── Dispatch ─────────────────────────────────────────────────────

export async function create(
  this: AppSyncProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  switch (resourceType) {
    case 'AWS::AppSync::GraphQLApi':
      return this.createGraphQLApi(logicalId, resourceType, properties, context);
    case 'AWS::AppSync::GraphQLSchema':
      return this.createGraphQLSchema(logicalId, resourceType, properties, context);
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
 *   - `GraphQLApi`   → `UpdateGraphqlApiCommand` (`Name` /
 *     `AuthenticationType` / `XrayEnabled` / `LogConfig` / the other
 *     config members) + `TagResource` / `UntagResource` for `Tags` diff.
 *   - `DataSource`   → `UpdateDataSourceCommand` (`Type` / `Description` /
 *     `ServiceRoleArn` / the per-type configs — `DynamoDBConfig` /
 *     `LambdaConfig` / `HttpConfig` / `ElasticsearchConfig` /
 *     `OpenSearchServiceConfig` / `EventBridgeConfig` /
 *     `RelationalDatabaseConfig` — / `MetricsConfig`).
 *     `ApiId` / `Name` are immutable identity fields.
 *   - `Resolver`     → `UpdateResolverCommand` (`DataSourceName` /
 *     `RequestMappingTemplate` / `ResponseMappingTemplate` / `Kind` /
 *     `PipelineConfig` / `Runtime` / `Code` / `CachingConfig` /
 *     `SyncConfig` / `MaxBatchSize` / `MetricsConfig` + the three
 *     `*S3Location` fetch-and-inline pairs). `ApiId` / `TypeName` /
 *     `FieldName` are immutable identity fields.
 *   - `ApiKey`       → `UpdateApiKeyCommand` (`Description` / `Expires`).
 *     `ApiId` is immutable; the AWS-generated key id is immutable.
 *   - `GraphQLSchema` → `StartSchemaCreationCommand` (re-upload the
 *     SDL; this is the canonical AppSync schema-update path). `ApiId`
 *     cannot move a schema to another API in place.
 *
 * Every Update* call uses `!== undefined` field gates per
 * memory rule `feedback_update_optional_field_undefined_check.md` so
 * `cdkd drift --revert` can clear a console-side ADD via an empty
 * string / 0 / false. Identity / immutable field changes throw
 * `ResourceUpdateNotSupportedError` as defense-in-depth — the deploy
 * engine's replacement-detection layer should normally route those
 * through CREATE+DELETE.
 */
export async function update(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::AppSync::GraphQLApi':
      return this.updateGraphQLApi(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::AppSync::GraphQLSchema':
      return this.updateGraphQLSchema(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        maskerOrIdentity(context?.maskSecrets)
      );
    case 'AWS::AppSync::DataSource':
      return this.updateDataSource(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        // Issue #2178: `applyDataSourceConfig` quotes a resolved
        // `DeltaSyncConfig` TTL back at the user, so the masker has to reach
        // it from BOTH operations. Absent means unmasked.
        maskerOrIdentity(context?.maskSecrets)
      );
    case 'AWS::AppSync::Resolver':
      return this.updateResolver(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        maskerOrIdentity(context?.maskSecrets)
      );
    case 'AWS::AppSync::ApiKey':
      return this.updateApiKey(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        maskerOrIdentity(context?.maskSecrets)
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
 * The template-path pre-flight for `updateGraphQLApi` (issue
 * [#3740](https://github.com/go-to-k/cdkd/issues/3740)): throw the refusal a
 * template-path create raises for a malformed nested block, or return.
 *
 * It runs the SAME converters the update arms run — the ones behind
 * `applyGraphQLApiConfig` and `applyEnvironmentVariables`'s container and
 * per-key reads —
 * so each refuses exactly where its arm would warn, with the sentence a
 * template-path create throws.
 * Only a block that CHANGED from the recorded one is asked: an unchanged
 * malformed block is not a pending operation (the arm drops the WHOLE block —
 * for `AdditionalAuthenticationProviders` the whole list, even when only one
 * nested member is malformed — and AppSync treats the omitted member as "no
 * change"), so refusing it would fail an update that changes something else.
 */
export function refuseChangedMalformedGraphQLApiBlocks(
  this: AppSyncProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  logicalId: string,
  physicalId: string,
  resourceType: string
): void {
  const changed = (key: string): boolean =>
    !this.deepEqual(properties[key], previousProperties[key]);
  // The converters' own `onUnusable` seam COLLECTS the refusal instead of
  // warning: it receives the very sentence the no-callback arm would throw,
  // and no `catch` is needed to re-word it (a catch here could also capture
  // an unrelated typed throw and re-label it).
  const refusals: string[] = [];
  const guard: ShapeGuardOptions = {
    logicalId,
    onUnusable: (message: string) => refusals.push(message),
  };
  if (changed('UserPoolConfig')) {
    this.toSdkUserPoolConfig(properties['UserPoolConfig'], 'UserPoolConfig', guard);
  }
  if (changed('OpenIDConnectConfig')) {
    this.toSdkOpenIDConnectConfig(properties['OpenIDConnectConfig'], 'OpenIDConnectConfig', guard);
  }
  if (changed('LambdaAuthorizerConfig')) {
    this.toSdkLambdaAuthorizerConfig(
      properties['LambdaAuthorizerConfig'],
      'LambdaAuthorizerConfig',
      guard
    );
  }
  if (changed('AdditionalAuthenticationProviders')) {
    this.toSdkAdditionalAuthProviders(properties['AdditionalAuthenticationProviders'], guard);
  }
  if (changed('EnhancedMetricsConfig')) {
    this.toSdkEnhancedMetricsConfig(properties['EnhancedMetricsConfig'], guard);
  }
  if (changed('EnvironmentVariables')) {
    const env = this.asObject(properties['EnvironmentVariables'], 'EnvironmentVariables', guard);
    // Per-KEY values too (issue #3781): the PUT runs after `UpdateGraphqlApi`
    // has landed, so a value it cannot carry must be refused here, not there.
    for (const [key, value] of Object.entries(env ?? {})) {
      const refusal = this.environmentVariableRefusal(key, value);
      if (refusal !== undefined) refusals.push(refusal);
    }
  }
  if (refusals.length > 0) {
    throw new ProvisioningError(
      `${refusals[0]}. Nothing was applied to GraphQL API ${logicalId}; fix the template value`,
      resourceType,
      logicalId,
      physicalId
    );
  }
}

/**
 * Structural equality for the small object / array shapes that ride on
 * AppSync update inputs. `JSON.stringify` is sufficient because none of
 * these shapes contain `undefined` keys at this layer (the create /
 * readCurrentState paths filter them out).
 */
export function deepEqual(this: AppSyncProvider, a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The `name` an `UpdateGraphqlApi` that is NOT a rename must carry (the SDK
 * requires it on every call): the recorded name when it is the desired one,
 * or the desired bag carries none. Otherwise the record holds a secret
 * reference or mask whose resolved value may have rotated since, and sending
 * that value would rename the API although its template did not change, so
 * the API's live name is read instead (go-to-k/cdkd#5359).
 */
export async function unchangedGraphqlApiName(
  this: AppSyncProvider,
  apiId: string,
  resourceType: string,
  logicalId: string,
  desired: unknown,
  recorded: unknown,
  mask: MaskerFn
): Promise<string> {
  if (desired === undefined || desired === recorded) return recorded as string;
  let liveName: string | undefined;
  try {
    const resp = await this.getClient().send(new GetGraphqlApiCommand({ apiId }));
    liveName = resp.graphqlApi?.name;
  } catch (error) {
    throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi', mask);
  }
  if (liveName === undefined || liveName === '') {
    throw new ProvisioningError(
      `Could not read the current name of AppSync GraphqlApi ${apiId} to update it without renaming it`,
      resourceType,
      logicalId,
      apiId
    );
  }
  return liveName;
}

export async function updateGraphQLApi(
  this: AppSyncProvider,
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
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

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

  // The template-path half of the nested-block shape guards (issue #3740,
  // the #3728 shape), before ANY call. `applyGraphQLApiConfig` and
  // `applyEnvironmentVariables` warn-and-drop a malformed block on every
  // caller, leaving the live value untouched; that stays for the two
  // state-borne callers (`replayingState`, `desiredFromAwsReadback`), whose
  // bag the user cannot edit from the template. On a template-path update the
  // block is template-borne and mutable in place, so it is refused the way a
  // template-path create refuses it — and HERE, because the
  // `EnvironmentVariables` arm runs after `UpdateGraphqlApi` has landed.
  if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
    this.refuseChangedMalformedGraphQLApiBlocks(
      properties,
      previousProperties,
      logicalId,
      physicalId,
      resourceType
    );
  }

  // Build UpdateGraphqlApi input only when a mutable field diffs. `Name`
  // is REQUIRED by the SDK input shape on every call, so it is sent
  // whenever the call is issued.
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
  // A rename is an in-place `UpdateGraphqlApi`: the API id and every child
  // keyed by it stay, as CloudFormation renames it (go-to-k/cdkd#5359,
  // measured: same API id, new name). Name is required, so a desired bag
  // without one keeps the recorded name rather than diffing.
  //
  // A secret-derived name is recorded as its `{{resolve:...}}` reference (or
  // `***`) and handed here resolved, so the two bags always differ. The
  // deploy's `changedProperties` compares the templates as written, so a
  // secret rotated under an unchanged reference is no rename there, as in
  // CloudFormation, which re-resolves only when the reference changes. The
  // one exception is an update the engine forces with nothing changed (a
  // `reput`), which names every key: the call then carries the resolved name,
  // the one the template asks for. Other callers (a rollback revert,
  // `drift --revert`) hand comparable bags. This type stays out of
  // `CHANGED_PROPERTIES_CONSUMER_TYPES` on purpose: an unconfirmed `NoEcho`
  // name then stays in the set and is re-sent as the same name, a harmless
  // no-op, rather than costing a readback on every deploy.
  const hasNameDiff =
    properties['Name'] !== undefined &&
    (context?.changedProperties !== undefined
      ? context.changedProperties.has('Name')
      : properties['Name'] !== previousProperties['Name']);
  const wantUpdate = hasNameDiff || hasAuthDiff || hasXrayDiff || hasLogDiff || hasConfigDiff;

  if (wantUpdate) {
    const input: UpdateGraphqlApiCommandInput = {
      apiId: physicalId,
      // Name is required by the SDK input: the desired name on a rename,
      // otherwise the name the API already has.
      name: hasNameDiff
        ? (properties['Name'] as string)
        : await this.unchangedGraphqlApiName(
            physicalId,
            resourceType,
            logicalId,
            properties['Name'],
            previousProperties['Name'],
            maskerOrIdentity(context?.maskSecrets)
          ),
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
      // warns rather than making the resource un-rollbackable. On a
      // template-path update a CHANGED malformed block never gets here
      // (`refuseChangedMalformedGraphQLApiBlocks` refused it above); what
      // still warns there is an UNCHANGED one, which this call leaves alone.
      shapeGuard: {
        logicalId,
        onUnusable: (message: string) =>
          this.logger.warn(`${message} (leaving the live value untouched)`),
      },
    });
    try {
      await this.getClient().send(new UpdateGraphqlApiCommand(input));
    } catch (error) {
      throw this.wrapUpdateError(
        error,
        resourceType,
        logicalId,
        physicalId,
        'GraphqlApi',
        maskerOrIdentity(context?.maskSecrets)
      );
    }
  }

  // Separate API pair — diffs itself, so it runs whether or not the
  // UpdateGraphqlApi call above fired.
  const envRecord = await this.applyEnvironmentVariables(
    physicalId,
    resourceType,
    logicalId,
    properties,
    previousProperties,
    false,
    maskerOrIdentity(context?.maskSecrets)
  );

  // Tags diff via TagResource / UntagResource. The API key is the
  // GraphqlApi ARN — recover it from a GetGraphqlApi call.
  await this.applyTagDiff(
    physicalId,
    resourceType,
    logicalId,
    previousProperties['Tags'],
    properties['Tags'],
    maskerOrIdentity(context?.maskSecrets)
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
    // A skipped env-var PUT (a state-borne caller's malformed map) records
    // what AWS still holds, not the map it could not send.
    ...(envRecord && {
      effectiveProperties: this.withEnvironmentVariablesRecord(properties, envRecord),
    }),
  };
}
