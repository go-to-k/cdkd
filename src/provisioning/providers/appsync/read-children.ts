import {
  GetGraphqlApiCommand,
  GetDataSourceCommand,
  GetResolverCommand,
  ListApiKeysCommand,
  NotFoundException as AppSyncNotFoundException,
} from '@aws-sdk/client-appsync';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { definedAttributes } from '../../attribute-map.js';
import { appSyncPhysicalIdFromCfn } from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

export async function readDataSource(
  this: AppSyncProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const [apiId, name] = physicalId.split('|');
  if (!apiId || !name) return undefined;

  let ds;
  try {
    const resp = await this.getClient().send(new GetDataSourceCommand({ apiId, name }));
    ds = resp.dataSource;
  } catch (err) {
    if (err instanceof AppSyncNotFoundException) return RESOURCE_NOT_FOUND;
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

export async function readResolver(
  this: AppSyncProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
    if (err instanceof AppSyncNotFoundException) return RESOURCE_NOT_FOUND;
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

export async function readApiKey(
  this: AppSyncProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
      if (err instanceof AppSyncNotFoundException) return RESOURCE_NOT_FOUND;
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
  // Every page listed and the key is not among them: it was deleted.
  return RESOURCE_NOT_FOUND;
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
export async function importImpl(
  this: AppSyncProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  // A CloudFormation-shaped id (a migration's `DescribeStackResources`, or
  // one pasted into `--resource`) is recorded in cdkd's shape (#5364).
  const known =
    input.knownPhysicalId &&
    appSyncPhysicalIdFromCfn(
      input.resourceType,
      input.logicalId,
      input.knownPhysicalId,
      input.region
    );
  if (input.resourceType !== 'AWS::AppSync::GraphQLApi') {
    if (known) {
      return {
        physicalId: known,
        attributes: await this.childImportAttributes(input.resourceType, known, input.region),
      };
    }
    return null;
  }

  const explicit = resolveExplicitPhysicalId(
    known ? { ...input, knownPhysicalId: known } : input,
    null
  );
  if (explicit) {
    try {
      const response = await this.getClient().send(new GetGraphqlApiCommand({ apiId: explicit }));
      // The same attribute set `createGraphQLApi` records (issue #1728's
      // rule for the children, applied to the parent by issue #3414): an
      // adopted API's `Arn` is what `cdkd export` sends CloudFormation as
      // the type's identifier now that AWS declares it by ARN, and a record
      // written with `attributes: {}` blocked that export until the API's
      // next update happened to heal it. `definedAttributes` drops any
      // member the read did not report rather than recording `''`.
      return {
        physicalId: explicit,
        attributes: definedAttributes({
          ApiId: explicit,
          Arn: response.graphqlApi?.arn,
          GraphQLUrl: response.graphqlApi?.uris?.['GRAPHQL'],
          GraphQLDns: response.graphqlApi?.dns?.['GRAPHQL'],
          RealtimeDns: response.graphqlApi?.dns?.['REALTIME'],
        }),
      };
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
