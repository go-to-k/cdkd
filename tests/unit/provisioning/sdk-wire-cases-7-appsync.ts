import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  TAG_THROWS,
  armFor,
  createOnlyOf,
  record,
  setOutputOverrides,
  type Bag,
  type TypeCase,
} from './sdk-wire-harness.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';

/**
 * The AppSync wire cases of the seventh batch (#3723): every type
 * `AppSyncProvider` handles. They pin go-to-k/cdkd#5359 (a643cb5a2): a
 * GraphQLApi `Name` and a DataSource `Type` are updated in place (the bag
 * probes' `update-add` / `update-vary` of each), and a GraphQLSchema `ApiId`
 * move is refused (`describeAppsyncExtras`, since no bag probe changes it on
 * both sides at once).
 */

const API_ID = 'api-1';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/appsync`;
const FN_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:f`;

/**
 * The S3 object an `*S3Location` names: its body names the bucket and key, so
 * the location itself reaches the wire through the inlined body.
 */
function armS3Object(): void {
  setOutputOverrides({
    GetObjectCommand: (input) => ({
      Body: {
        transformToString: async () => `# ${String(input['Bucket'])}/${String(input['Key'])}`,
      },
    }),
  });
}

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

// --- AWS::AppSync::GraphQLApi ---------------------------------------------------

const API_FULL: Bag = {
  Name: 'api',
  AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
  XrayEnabled: true,
  LogConfig: {
    CloudWatchLogsRoleArn: ROLE,
    ExcludeVerboseContent: true,
    FieldLogLevel: 'ERROR',
  },
  UserPoolConfig: {
    UserPoolId: 'us-east-1_pool',
    AwsRegion: 'us-east-1',
    DefaultAction: 'ALLOW',
    AppIdClientRegex: '^client$',
  },
  OpenIDConnectConfig: {
    Issuer: 'https://issuer.example.com',
    ClientId: 'cid',
    IatTTL: 100,
    AuthTTL: 200,
  },
  LambdaAuthorizerConfig: {
    AuthorizerUri: FN_ARN,
    AuthorizerResultTtlInSeconds: 60,
    IdentityValidationExpression: '^Bearer',
  },
  AdditionalAuthenticationProviders: [
    {
      AuthenticationType: 'OPENID_CONNECT',
      OpenIDConnectConfig: {
        Issuer: 'https://other.example.com',
        ClientId: 'cid2',
        IatTTL: 300,
        AuthTTL: 400,
      },
    },
    {
      AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
      UserPoolConfig: {
        UserPoolId: 'us-east-1_other',
        AwsRegion: 'us-west-2',
        AppIdClientRegex: '^other$',
      },
    },
    {
      AuthenticationType: 'AWS_LAMBDA',
      LambdaAuthorizerConfig: {
        AuthorizerUri: `${FN_ARN}2`,
        AuthorizerResultTtlInSeconds: 30,
        IdentityValidationExpression: '^Token',
      },
    },
  ],
  EnhancedMetricsConfig: {
    ResolverLevelMetricsBehavior: 'FULL_REQUEST_RESOLVER_METRICS',
    DataSourceLevelMetricsBehavior: 'PER_DATA_SOURCE_METRICS',
    OperationLevelMetricsConfig: 'ENABLED',
  },
  EnvironmentVariables: { K1: 'v1', K2: 'v2' },
  IntrospectionConfig: 'DISABLED',
  MergedApiExecutionRoleArn: ROLE,
  OwnerContact: 'owner',
  QueryDepthLimit: 5,
  ResolverCountLimit: 10,
  ApiType: 'GRAPHQL',
  Visibility: 'GLOBAL',
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
};

const GRAPHQL_API_CASE: TypeCase = {
  resourceType: 'AWS::AppSync::GraphQLApi',
  provider: () => new AppSyncProvider(),
  physicalId: API_ID,
  // The schema fixture lists no create-only path; `replacement-rules.ts`
  // replaces on an `ApiType` / `Visibility` change (no UpdateGraphqlApi member).
  createOnly: new Set([...createOnlyOf('AWS::AppSync::GraphQLApi'), 'ApiType', 'Visibility']),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    // The PUT replaces the whole map: the remaining key goes out, the removed one does not.
    {
      path: ['EnvironmentVariables', 'K1'],
      command: 'PutGraphqlApiEnvironmentVariablesCommand',
      names: 'K2',
      notNames: 'K1',
    },
  ],
  bags: [
    {
      name: 'every declared property',
      bag: API_FULL,
      expectedSilent: {
        // Not a gap: Name is required (CFn and CreateGraphqlApi), so a desired
        // bag without one keeps the API's name rather than renaming it
        // (appsync-provider.ts:1016-1020): there is nothing to send.
        'update-remove:Name': 'a desired bag without Name keeps the recorded name',
      },
      expectedRemovalThrows: {
        'create:Name': {
          why: 'CreateGraphqlApi requires a name (appsync-provider.ts:2913-2920)',
          says: /Name is required for GraphQLApi/,
        },
        ...TAG_THROWS(ALL_DIRECTIONS, 2),
      },
    },
  ],
};

// --- AWS::AppSync::GraphQLSchema ------------------------------------------------

// Not a gap: StartSchemaCreation is sent only when the SDL source changes
// (appsync-provider.ts:1213-1230). Adding or varying `ApiId` on ONE side
// leaves the definition equal, so neither side sends anything; an `ApiId`
// changed on BOTH sides is refused instead, pinned by `describeAppsyncExtras`.
const SCHEMA_APIID =
  'StartSchemaCreation follows a definition change only; an ApiId move is refused (extras)';
// Not a gap: AppSync has no schema delete, and CFn requires one of the two
// definition sources, so a removed source leaves the live schema as it is
// (appsync-provider.ts:1228-1229).
const SCHEMA_SOURCE_REMOVED = 'a removed definition source leaves the live schema in place';
const SCHEMA_ID_THROWS = {
  'create:ApiId': {
    why: 'StartSchemaCreation is addressed by the API id (appsync-provider.ts:3279-3286)',
    says: /ApiId is required for GraphQLSchema/,
  },
};

const GRAPHQL_SCHEMA_CASE: TypeCase = {
  resourceType: 'AWS::AppSync::GraphQLSchema',
  provider: () => new AppSyncProvider(),
  physicalId: API_ID,
  createOnly: createOnlyOf('AWS::AppSync::GraphQLSchema'),
  arm: () => armS3Object(),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'an inline definition',
      bag: { ApiId: API_ID, Definition: 'type Query { a: String }' },
      expectedSilent: {
        'update-add:ApiId': SCHEMA_APIID,
        'update-remove:ApiId': SCHEMA_APIID,
        'update-vary:ApiId': SCHEMA_APIID,
        'update-remove:Definition': SCHEMA_SOURCE_REMOVED,
      },
      expectedRemovalThrows: SCHEMA_ID_THROWS,
    },
    {
      name: 'a definition in S3',
      bag: { ApiId: API_ID, DefinitionS3Location: 's3://bucket/schema.graphql' },
      expectedSilent: {
        'update-add:ApiId': SCHEMA_APIID,
        'update-remove:ApiId': SCHEMA_APIID,
        'update-vary:ApiId': SCHEMA_APIID,
        'update-remove:DefinitionS3Location': SCHEMA_SOURCE_REMOVED,
      },
      expectedRemovalThrows: SCHEMA_ID_THROWS,
    },
  ],
};

// --- AWS::AppSync::DataSource ---------------------------------------------------

const DS_BASE: Bag = { ApiId: API_ID, Name: 'ds' };
const DS_REQUIRED: Record<string, { why: string; says: RegExp }> = Object.fromEntries(
  ['ApiId', 'Name', 'Type'].map((key) => [
    `create:${key}`,
    {
      why: 'CreateDataSource requires ApiId, Name and Type (appsync-provider.ts:3364-3370)',
      says: /ApiId, Name, and Type are required for DataSource/,
    },
  ])
);

const DATA_SOURCE_CASE: TypeCase = {
  resourceType: 'AWS::AppSync::DataSource',
  provider: () => new AppSyncProvider(),
  physicalId: `${API_ID}|ds`,
  createOnly: createOnlyOf('AWS::AppSync::DataSource'),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'a DynamoDB source with delta sync, description, role and metrics',
      bag: {
        ...DS_BASE,
        Type: 'AMAZON_DYNAMODB',
        Description: 'd',
        ServiceRoleArn: ROLE,
        MetricsConfig: 'ENABLED',
        DynamoDBConfig: {
          TableName: 't',
          AwsRegion: 'us-east-1',
          UseCallerCredentials: true,
          Versioned: true,
          DeltaSyncConfig: {
            BaseTableTTL: '43200',
            DeltaSyncTableName: 'delta',
            DeltaSyncTableTTL: '1440',
          },
        },
      },
      // CFn types both TTLs as numeric strings; `-alt` is refused as NaN.
      variants: {
        'DynamoDBConfig.DeltaSyncConfig.BaseTableTTL': '60',
        'DynamoDBConfig.DeltaSyncConfig.DeltaSyncTableTTL': '30',
        Type: 'HTTP',
      },
      expectedRemovalThrows: DS_REQUIRED,
    },
    {
      name: 'an IAM-signed HTTP source',
      bag: {
        ...DS_BASE,
        Type: 'HTTP',
        HttpConfig: {
          Endpoint: 'https://example.com',
          AuthorizationConfig: {
            AuthorizationType: 'AWS_IAM',
            AwsIamConfig: { SigningRegion: 'us-east-1', SigningServiceName: 'execute-api' },
          },
        },
      },
      variants: { Type: 'NONE' },
      expectedRemovalThrows: DS_REQUIRED,
    },
    {
      name: 'Lambda, Elasticsearch, OpenSearch, EventBridge and RDS blocks',
      bag: {
        ...DS_BASE,
        Type: 'RELATIONAL_DATABASE',
        LambdaConfig: { LambdaFunctionArn: FN_ARN },
        ElasticsearchConfig: { Endpoint: 'https://es.example.com', AwsRegion: 'us-east-1' },
        OpenSearchServiceConfig: { Endpoint: 'https://os.example.com', AwsRegion: 'us-west-2' },
        EventBridgeConfig: { EventBusArn: `arn:aws:events:us-east-1:${ACCOUNT}:event-bus/b` },
        RelationalDatabaseConfig: {
          RelationalDatabaseSourceType: 'RDS_HTTP_ENDPOINT',
          RdsHttpEndpointConfig: {
            AwsRegion: 'us-east-1',
            DbClusterIdentifier: `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:c`,
            DatabaseName: 'db',
            Schema: 'public',
            AwsSecretStoreArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s`,
          },
        },
      },
      variants: { Type: 'AWS_LAMBDA' },
      expectedRemovalThrows: DS_REQUIRED,
    },
  ],
};

// --- AWS::AppSync::Resolver -----------------------------------------------------

const RESOLVER_BASE: Bag = { ApiId: API_ID, TypeName: 'Query', FieldName: 'getA' };
const RESOLVER_REQUIRED: Record<string, { why: string; says: RegExp }> = Object.fromEntries(
  ['ApiId', 'TypeName', 'FieldName'].map((key) => [
    `create:${key}`,
    {
      why: 'CreateResolver is addressed by ApiId, TypeName and FieldName (appsync-provider.ts:3540-3546)',
      says: /ApiId, TypeName, and FieldName are required for Resolver/,
    },
  ])
);

const RESOLVER_CASE: TypeCase = {
  resourceType: 'AWS::AppSync::Resolver',
  provider: () => new AppSyncProvider(),
  physicalId: `${API_ID}|Query|getA`,
  createOnly: createOnlyOf('AWS::AppSync::Resolver'),
  arm: () => armS3Object(),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'a UNIT resolver with inline VTL, caching and sync',
      bag: {
        ...RESOLVER_BASE,
        Kind: 'UNIT',
        DataSourceName: 'ds',
        RequestMappingTemplate: '{"version":"2018-05-29"}',
        ResponseMappingTemplate: '$util.toJson($ctx.result)',
        CachingConfig: { Ttl: 60, CachingKeys: ['$context.arguments.id', '$context.identity.sub'] },
        SyncConfig: {
          ConflictDetection: 'VERSION',
          ConflictHandler: 'LAMBDA',
          LambdaConflictHandlerConfig: { LambdaConflictHandlerArn: FN_ARN },
        },
        MaxBatchSize: 5,
        MetricsConfig: 'ENABLED',
      },
      expectedRemovalThrows: RESOLVER_REQUIRED,
    },
    {
      name: 'a PIPELINE resolver with APPSYNC_JS code',
      bag: {
        ...RESOLVER_BASE,
        Kind: 'PIPELINE',
        PipelineConfig: { Functions: ['fn-1', 'fn-2'] },
        Runtime: { Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' },
        Code: 'export function request() {}',
      },
      expectedRemovalThrows: RESOLVER_REQUIRED,
    },
    {
      name: 'a resolver whose templates and code are in S3',
      bag: {
        ...RESOLVER_BASE,
        DataSourceName: 'ds',
        RequestMappingTemplateS3Location: 's3://bucket/req.vtl',
        ResponseMappingTemplateS3Location: 's3://bucket/res.vtl',
        CodeS3Location: 's3://bucket/code.js',
      },
      expectedRemovalThrows: RESOLVER_REQUIRED,
    },
  ],
};

// --- AWS::AppSync::ApiKey -------------------------------------------------------

const API_KEY_CASE: TypeCase = {
  resourceType: 'AWS::AppSync::ApiKey',
  provider: () => new AppSyncProvider(),
  physicalId: `${API_ID}|da2-key`,
  createOnly: createOnlyOf('AWS::AppSync::ApiKey'),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'a described key with an expiry',
      bag: { ApiId: API_ID, Description: 'd', Expires: 1_900_000_000 },
      expectedRemovalThrows: {
        'create:ApiId': {
          why: 'CreateApiKey is addressed by the API id (appsync-provider.ts:3708-3715)',
          says: /ApiId is required for ApiKey/,
        },
      },
    },
  ],
};

export const APPSYNC_CASES: TypeCase[] = [
  GRAPHQL_API_CASE,
  GRAPHQL_SCHEMA_CASE,
  DATA_SOURCE_CASE,
  RESOLVER_CASE,
  API_KEY_CASE,
];

// --- Direct calls for go-to-k/cdkd#5359 ---------------------------------------

/** The JSON bodies of every `command` request one update sent. */
async function sentBodies(
  c: TypeCase,
  next: Bag,
  prev: Bag,
  command: string
): Promise<Record<string, unknown>[]> {
  armFor(c, prev);
  const outcome = await record(() =>
    c.provider().update('L', c.physicalId, c.resourceType, next, prev)
  );
  expect(outcome).toMatchObject({ threw: false });
  return (outcome as { wire: string }).wire
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown[])
    .filter((entry) => entry[0] === command)
    .map((entry) => JSON.parse(entry[entry.length - 1] as string) as Record<string, unknown>);
}

/**
 * What a bag probe cannot observe: each probe changes a path on ONE side
 * only, so none changes `GraphQLSchema.ApiId` on both, and none changes a
 * GraphQLApi `Name` or a DataSource `Type` from one recorded value to another.
 */
export function describeAppsyncExtras(): void {
  describe('AWS::AppSync::GraphQLSchema ApiId change (go-to-k/cdkd#5359)', () => {
    it.each([
      ['an unchanged definition', 'type Query { a: String }'],
      ['a changed definition', 'type Query { b: String }'],
    ])('is refused with %s', async (_label, nextDefinition) => {
      armFor(GRAPHQL_SCHEMA_CASE, {});
      const outcome = await record(() =>
        new AppSyncProvider().update(
          'L',
          API_ID,
          'AWS::AppSync::GraphQLSchema',
          { ApiId: 'api-2', Definition: nextDefinition },
          { ApiId: API_ID, Definition: 'type Query { a: String }' }
        )
      );
      expect(outcome).toMatchObject({ threw: true });
      expect((outcome as { message: string }).message).toMatch(
        /GraphQLSchema\.ApiId cannot move a schema to another API in place/
      );
    });
  });

  describe('AWS::AppSync::GraphQLApi Name change (go-to-k/cdkd#5359)', () => {
    it('renames the API in place through UpdateGraphqlApi', async () => {
      const prev = { Name: 'old', AuthenticationType: 'API_KEY' };
      const bodies = await sentBodies(
        GRAPHQL_API_CASE,
        { ...prev, Name: 'new' },
        prev,
        'UpdateGraphqlApiCommand'
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ name: 'new', authenticationType: 'API_KEY' });
    });
  });

  describe('AWS::AppSync::DataSource Type change (go-to-k/cdkd#5359)', () => {
    it('changes the type in place through UpdateDataSource', async () => {
      // Only Type differs, so the call is made for the type change alone.
      const prev = { ...DS_BASE, Type: 'NONE', HttpConfig: { Endpoint: 'https://example.com' } };
      const bodies = await sentBodies(
        DATA_SOURCE_CASE,
        { ...prev, Type: 'HTTP' },
        prev,
        'UpdateDataSourceCommand'
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        type: 'HTTP',
        httpConfig: { endpoint: 'https://example.com' },
      });
    });
  });
}
