import type {
  AuthorizationConfig,
  AuthorizationType,
  DataSourceLevelMetricsConfig,
  DeltaSyncConfig,
  DynamodbDataSourceConfig,
  ElasticsearchDataSourceConfig,
  EventBridgeDataSourceConfig,
  HttpDataSourceConfig,
  OpenSearchServiceDataSourceConfig,
  RelationalDatabaseDataSourceConfig,
  RelationalDatabaseSourceType,
  CreateDataSourceCommandInput,
  UpdateDataSourceCommandInput,
} from '@aws-sdk/client-appsync';
import type { MaskerFn } from '../../masked-retry-logger.js';
import type { AppSyncProvider } from '../appsync-provider.js';

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
export function applyDataSourceConfig(
  this: AppSyncProvider,
  input: CreateDataSourceCommandInput | UpdateDataSourceCommandInput,
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>,
  mask: MaskerFn
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
          resourceType,
          mask
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
          resourceType,
          mask
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
        ...(rdsEndpoint['Schema'] !== undefined ? { schema: rdsEndpoint['Schema'] as string } : {}),
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
