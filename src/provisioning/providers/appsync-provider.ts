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
  type AuthenticationType,
  type DataSourceType,
  type CreateGraphqlApiCommandInput,
  type CreateDataSourceCommandInput,
  type CreateResolverCommandInput,
  type CreateApiKeyCommandInput,
  type UpdateGraphqlApiCommandInput,
  type UpdateDataSourceCommandInput,
  type UpdateResolverCommandInput,
  type UpdateApiKeyCommandInput,
} from '@aws-sdk/client-appsync';
import { parse as graphqlParse, print as graphqlPrint } from 'graphql';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
      new Set(['Name', 'AuthenticationType', 'XrayEnabled', 'LogConfig', 'Tags']),
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
      ]),
    ],
    ['AWS::AppSync::ApiKey', new Set(['ApiId', 'Description', 'Expires'])],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::AppSync::DataSource',
      new Map<string, string>([
        [
          'ElasticsearchConfig',
          'Legacy Elasticsearch alias; use OpenSearchServiceConfig (AppSync deprecated the Elasticsearch DataSource type in favor of OpenSearch)',
        ],
      ]),
    ],
  ]);

  private getClient(): AppSyncClient {
    if (!this.client) {
      this.client = new AppSyncClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.createGraphQLApi(logicalId, resourceType, properties);
      case 'AWS::AppSync::GraphQLSchema':
        return this.createGraphQLSchema(logicalId, resourceType, properties);
      case 'AWS::AppSync::DataSource':
        return this.createDataSource(logicalId, resourceType, properties);
      case 'AWS::AppSync::Resolver':
        return this.createResolver(logicalId, resourceType, properties);
      case 'AWS::AppSync::ApiKey':
        return this.createApiKey(logicalId, resourceType, properties);
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
   *     `ServiceRoleArn` / `DynamoDBConfig` / `LambdaConfig` / `HttpConfig`).
   *     `ApiId` / `Name` / `Type` are immutable identity fields.
   *   - `Resolver`     → `UpdateResolverCommand` (`DataSourceName` /
   *     `RequestMappingTemplate` / `ResponseMappingTemplate` / `Kind` /
   *     `PipelineConfig` / `Runtime` / `Code`). `ApiId` / `TypeName` /
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
    const wantUpdate = hasAuthDiff || hasXrayDiff || hasLogDiff;

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
      try {
        await this.getClient().send(new UpdateGraphqlApiCommand(input));
      } catch (error) {
        throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'GraphqlApi');
      }
    }

    // Tags diff via TagResource / UntagResource. The API key is the
    // GraphqlApi ARN — recover it from a GetGraphqlApi call.
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
      properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: {},
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
    // surface is `Definition` (the SDL body). `StartSchemaCreation`
    // re-uploads the SDL; AWS rebuilds the schema asynchronously.
    // `DefinitionS3Location` is write-only (see getDriftUnknownPaths)
    // and not round-trippable.
    const newDef = properties['Definition'] as string | undefined;
    const oldDef = previousProperties['Definition'] as string | undefined;

    if (newDef === undefined || newDef === oldDef) {
      return { physicalId, wasReplaced: false, attributes: {} };
    }

    const apiId = (properties['ApiId'] ?? physicalId) as string;
    try {
      await this.getClient().send(
        new StartSchemaCreationCommand({
          apiId,
          definition: Buffer.from(newDef, 'utf-8'),
        })
      );
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'GraphqlSchema');
    }
    return { physicalId, wasReplaced: false, attributes: {} };
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

    const newDesc = properties['Description'] as string | undefined;
    const oldDesc = previousProperties['Description'] as string | undefined;
    const newRole = properties['ServiceRoleArn'] as string | undefined;
    const oldRole = previousProperties['ServiceRoleArn'] as string | undefined;
    const newDDB = properties['DynamoDBConfig'] as Record<string, unknown> | undefined;
    const oldDDB = previousProperties['DynamoDBConfig'] as Record<string, unknown> | undefined;
    const newLambda = properties['LambdaConfig'] as Record<string, unknown> | undefined;
    const oldLambda = previousProperties['LambdaConfig'] as Record<string, unknown> | undefined;
    const newHttp = properties['HttpConfig'] as Record<string, unknown> | undefined;
    const oldHttp = previousProperties['HttpConfig'] as Record<string, unknown> | undefined;

    const wantUpdate =
      newDesc !== oldDesc ||
      newRole !== oldRole ||
      !this.deepEqual(newDDB, oldDDB) ||
      !this.deepEqual(newLambda, oldLambda) ||
      !this.deepEqual(newHttp, oldHttp);

    if (!wantUpdate) {
      return { physicalId, wasReplaced: false, attributes: {} };
    }

    const input: UpdateDataSourceCommandInput = {
      apiId,
      name,
      type,
    };
    if (newDesc !== undefined) input.description = newDesc;
    if (newRole !== undefined) input.serviceRoleArn = newRole;
    if (newDDB !== undefined) {
      input.dynamodbConfig = {
        tableName: newDDB['TableName'] as string,
        awsRegion: newDDB['AwsRegion'] as string,
        useCallerCredentials: newDDB['UseCallerCredentials'] as boolean | undefined,
      };
    }
    if (newLambda !== undefined) {
      input.lambdaConfig = {
        lambdaFunctionArn: newLambda['LambdaFunctionArn'] as string,
      };
    }
    if (newHttp !== undefined) {
      input.httpConfig = {
        endpoint: newHttp['Endpoint'] as string,
      };
    }

    try {
      await this.getClient().send(new UpdateDataSourceCommand(input));
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'DataSource');
    }

    return { physicalId, wasReplaced: false, attributes: {} };
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

    const mutableKeys = [
      'DataSourceName',
      'RequestMappingTemplate',
      'ResponseMappingTemplate',
      'Kind',
      'PipelineConfig',
      'Runtime',
      'Code',
    ] as const;

    const wantUpdate = mutableKeys.some(
      (key) => !this.deepEqual(properties[key], previousProperties[key])
    );

    if (!wantUpdate) {
      return { physicalId, wasReplaced: false, attributes: {} };
    }

    const input: UpdateResolverCommandInput = {
      apiId: apiId as string,
      typeName: typeName as string,
      fieldName: fieldName as string,
    };

    // Resolver shape is type-discriminator-gated on `Kind`:
    //   - Kind=UNIT     → DataSourceName is required, PipelineConfig is N/A.
    //   - Kind=PIPELINE → PipelineConfig.Functions is required, DataSourceName
    //                     is N/A (AWS rejects the call if it's set).
    // The effective Kind comes from `properties.Kind` (the new template
    // intent) falling back to `previousProperties.Kind` (state-recorded)
    // and finally to AWS's default 'UNIT' so we never forward
    // `dataSourceName` on a PIPELINE resolver. Same shape as
    // readCurrentState's discriminator handling per memory rule
    // feedback_always_emit_check_type_discriminator.
    const effectiveKind =
      (properties['Kind'] as 'UNIT' | 'PIPELINE' | undefined) ??
      (previousProperties['Kind'] as 'UNIT' | 'PIPELINE' | undefined) ??
      'UNIT';

    if (effectiveKind === 'UNIT' && properties['DataSourceName'] !== undefined) {
      input.dataSourceName = properties['DataSourceName'] as string;
    }
    if (properties['RequestMappingTemplate'] !== undefined) {
      input.requestMappingTemplate = properties['RequestMappingTemplate'] as string;
    }
    if (properties['ResponseMappingTemplate'] !== undefined) {
      input.responseMappingTemplate = properties['ResponseMappingTemplate'] as string;
    }
    if (properties['Kind'] !== undefined) {
      input.kind = properties['Kind'] as 'UNIT' | 'PIPELINE';
    }
    if (effectiveKind === 'PIPELINE' && properties['PipelineConfig'] !== undefined) {
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
    if (properties['Code'] !== undefined) {
      input.code = properties['Code'] as string;
    }

    try {
      await this.getClient().send(new UpdateResolverCommand(input));
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, physicalId, 'Resolver');
    }

    return { physicalId, wasReplaced: false, attributes: {} };
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
      return { physicalId, wasReplaced: false, attributes: {} };
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

    return { physicalId, wasReplaced: false, attributes: {} };
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
    return [];
  }

  // ─── AWS::AppSync::GraphQLApi ──────────────────────────────────────

  private async createGraphQLApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
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

      const response = await this.getClient().send(new CreateGraphqlApiCommand(input));

      const apiId = response.graphqlApi!.apiId!;
      const arn = response.graphqlApi!.arn!;
      const graphQLUrl = response.graphqlApi!.uris?.['GRAPHQL'] ?? '';

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
    const definitionS3Location = properties['DefinitionS3Location'] as string | undefined;

    try {
      if (definition) {
        await this.getClient().send(
          new StartSchemaCreationCommand({
            apiId,
            definition: new TextEncoder().encode(definition),
          })
        );
      } else if (definitionS3Location) {
        // For S3-based schema, pass as definition bytes
        // In practice, CDK usually inlines the schema
        this.logger.warn(`S3-based schema definition for ${logicalId} - using inline only`);
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
    properties: Record<string, unknown>
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

    try {
      const input: CreateDataSourceCommandInput = {
        apiId,
        name,
        type,
      };

      if (properties['Description']) {
        input.description = properties['Description'] as string;
      }
      if (properties['ServiceRoleArn']) {
        input.serviceRoleArn = properties['ServiceRoleArn'] as string;
      }
      if (properties['DynamoDBConfig']) {
        const config = properties['DynamoDBConfig'] as Record<string, unknown>;
        input.dynamodbConfig = {
          tableName: config['TableName'] as string,
          awsRegion: config['AwsRegion'] as string,
          useCallerCredentials: config['UseCallerCredentials'] as boolean | undefined,
        };
      }
      if (properties['LambdaConfig']) {
        const config = properties['LambdaConfig'] as Record<string, unknown>;
        input.lambdaConfig = {
          lambdaFunctionArn: config['LambdaFunctionArn'] as string,
        };
      }
      if (properties['HttpConfig']) {
        const config = properties['HttpConfig'] as Record<string, unknown>;
        input.httpConfig = {
          endpoint: config['Endpoint'] as string,
        };
      }

      await this.getClient().send(new CreateDataSourceCommand(input));

      const physicalId = `${apiId}|${name}`;
      this.logger.debug(`Successfully created DataSource ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {
          DataSourceArn: `arn:aws:appsync:*:*:apis/${apiId}/datasources/${name}`,
          Name: name,
        },
      };
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
    properties: Record<string, unknown>
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

    try {
      const input: CreateResolverCommandInput = {
        apiId,
        typeName,
        fieldName,
      };

      if (properties['DataSourceName']) {
        input.dataSourceName = properties['DataSourceName'] as string;
      }
      if (properties['RequestMappingTemplate']) {
        input.requestMappingTemplate = properties['RequestMappingTemplate'] as string;
      }
      if (properties['ResponseMappingTemplate']) {
        input.responseMappingTemplate = properties['ResponseMappingTemplate'] as string;
      }
      if (properties['Kind']) {
        input.kind = properties['Kind'] as 'UNIT' | 'PIPELINE';
      }
      if (properties['PipelineConfig']) {
        const pipelineConfig = properties['PipelineConfig'] as Record<string, unknown>;
        input.pipelineConfig = {
          functions: pipelineConfig['Functions'] as string[] | undefined,
        };
      }
      if (properties['Runtime']) {
        const runtime = properties['Runtime'] as Record<string, unknown>;
        input.runtime = {
          name: runtime['Name'] as 'APPSYNC_JS',
          runtimeVersion: runtime['RuntimeVersion'] as string,
        };
      }
      if (properties['Code']) {
        input.code = properties['Code'] as string;
      }

      await this.getClient().send(new CreateResolverCommand(input));

      const physicalId = `${apiId}|${typeName}|${fieldName}`;
      this.logger.debug(`Successfully created Resolver ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {
          ResolverArn: `arn:aws:appsync:*:*:apis/${apiId}/types/${typeName}/resolvers/${fieldName}`,
        },
      };
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
    properties: Record<string, unknown>
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

    try {
      const input: CreateApiKeyCommandInput = { apiId };

      if (properties['Description']) {
        input.description = properties['Description'] as string;
      }
      if (properties['Expires']) {
        input.expires = properties['Expires'] as number;
      }

      const response = await this.getClient().send(new CreateApiKeyCommand(input));

      const apiKeyId = response.apiKey!.id!;
      this.logger.debug(`Successfully created ApiKey ${logicalId}: ${apiKeyId}`);

      return {
        physicalId: `${apiId}|${apiKeyId}`,
        attributes: {
          ApiKey: response.apiKey!.id!,
          Arn: `arn:aws:appsync:*:*:apis/${apiId}/apikeys/${apiKeyId}`,
        },
      };
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
   *    ServiceRoleArn, DynamoDBConfig, LambdaConfig, HttpConfig). The
   *    `ApiId` cdkd holds is recovered from the `apiId|name` physicalId.
   *  - `Resolver` → `GetResolver` (TypeName, FieldName, DataSourceName,
   *    request/response templates, Kind, PipelineConfig, Runtime, Code).
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
    return result;
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
      if (Object.keys(dynamo).length > 0) result['DynamoDBConfig'] = dynamo;
    }
    if (ds.lambdaConfig?.lambdaFunctionArn !== undefined) {
      result['LambdaConfig'] = { LambdaFunctionArn: ds.lambdaConfig.lambdaFunctionArn };
    }
    if (ds.httpConfig?.endpoint !== undefined) {
      result['HttpConfig'] = { Endpoint: ds.httpConfig.endpoint };
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
   * parent `apiId` — explicit-override only.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType !== 'AWS::AppSync::GraphQLApi') {
      if (input.knownPhysicalId) {
        return { physicalId: input.knownPhysicalId, attributes: {} };
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
