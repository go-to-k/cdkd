import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as assets from 'aws-cdk-lib/aws-s3-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AppSync GraphQL API example stack
 *
 * Demonstrates:
 * - AppSync GraphQL API (L1 CfnGraphQLApi)
 * - Inline GraphQL schema (CfnGraphQLSchema)
 * - DynamoDB table as data source (CfnDataSource)
 * - Resolver connecting query to DynamoDB (CfnResolver)
 * - EventBridge data source (EventBridgeConfig + MetricsConfig, #609)
 * - IAM-signed HTTP data source (HttpConfig.AuthorizationConfig, #1597)
 * - Versioned DynamoDB data source (DynamoDBConfig.Versioned +
 *   .DeltaSyncConfig, #1597)
 * - Resolver with S3-sourced mapping templates
 *   (Request/ResponseMappingTemplateS3Location via aws-s3-assets, #609)
 * - IAM Role for AppSync to access DynamoDB
 * - CfnOutputs for API URL and API ID
 */
export class AppSyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Issue #609: the 13 config properties cdkd used to silently drop.
    //
    // Three phases drive the fixture:
    //   - baseline  (no env)            — every property present
    //   - update    (CDKD_TEST_UPDATE)  — every property CHANGED
    //   - removal   (CDKD_TEST_REMOVAL) — the properties with a reset
    //                                     sentinel are DROPPED, while
    //                                     EnhancedMetricsConfig is RETAINED
    //                                     so a blanket reset cannot pass
    const updateMode = process.env['CDKD_TEST_UPDATE'] === 'true';
    const removalMode = process.env['CDKD_TEST_REMOVAL'] === 'true';

    // An extra Cognito user pool + Lambda authorizer, so the two nested auth
    // blobs (CognitoUserPoolConfig / LambdaAuthorizerConfig) are exercised
    // against real AWS rather than only in unit tests.
    const userPool = new cognito.CfnUserPool(this, 'AppSyncUserPool', {
      userPoolName: 'cdkd-appsync-example-pool',
    });

    const authorizerRole = new iam.CfnRole(this, 'AppSyncAuthorizerRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    });

    const authorizerFn = new lambda.CfnFunction(this, 'AppSyncAuthorizerFunction', {
      runtime: 'nodejs22.x',
      handler: 'index.handler',
      role: authorizerRole.attrArn,
      code: {
        zipFile: 'exports.handler = async () => ({ isAuthorized: true });',
      },
    });

    new lambda.CfnPermission(this, 'AppSyncAuthorizerPermission', {
      action: 'lambda:InvokeFunction',
      functionName: authorizerFn.attrArn,
      principal: 'appsync.amazonaws.com',
    });

    // GraphQL API
    const graphqlApi = new appsync.CfnGraphQLApi(this, 'GraphQLApi', {
      name: 'cdkd-appsync-example',
      authenticationType: 'API_KEY',
      // Create-only on AWS (no UpdateGraphqlApi member) — a change here is a
      // REPLACEMENT, so the fixture keeps both constant across all phases.
      apiType: 'GRAPHQL',
      visibility: 'GLOBAL',
      // Removable members: each has an AWS reset sentinel the provider must
      // send on removal, since an omitted member means "no change" here.
      ...(removalMode
        ? {}
        : {
            introspectionConfig: updateMode ? 'ENABLED' : 'DISABLED',
            queryDepthLimit: updateMode ? 8 : 5,
            resolverCountLimit: updateMode ? 200 : 100,
            ownerContact: updateMode ? 'cdkd-integ-updated' : 'cdkd-integ',
            environmentVariables: updateMode
              ? { CdkdStage: 'updated', CdkdExtra: 'added' }
              : { CdkdStage: 'baseline' },
            additionalAuthenticationProviders: [
              {
                authenticationType: 'AWS_IAM',
              },
              {
                // `openIDConnectConfig` / `iatTTL` / `authTTL` are the
                // irregular SDK spellings — if the mapper gets any of them
                // wrong the serializer drops the block and the readback below
                // fails.
                authenticationType: 'OPENID_CONNECT',
                openIdConnectConfig: {
                  issuer: 'https://accounts.google.com',
                  clientId: updateMode ? 'cdkd-updated-client' : 'cdkd-client',
                  iatTtl: 60000,
                  authTtl: 120000,
                },
              },
              {
                authenticationType: 'AMAZON_COGNITO_USER_POOLS',
                userPoolConfig: {
                  userPoolId: userPool.ref,
                  awsRegion: this.region,
                },
              },
              {
                authenticationType: 'AWS_LAMBDA',
                lambdaAuthorizerConfig: {
                  authorizerUri: authorizerFn.attrArn,
                  authorizerResultTtlInSeconds: updateMode ? 60 : 30,
                },
              },
            ],
          }),
      // RETAINED through the removal phase: proves the removal resets only
      // what the template dropped rather than clearing the whole config.
      enhancedMetricsConfig: {
        resolverLevelMetricsBehavior: 'PER_RESOLVER_METRICS',
        dataSourceLevelMetricsBehavior: 'PER_DATA_SOURCE_METRICS',
        operationLevelMetricsConfig: 'DISABLED',
      },
    });

    // API Key
    const apiKey = new appsync.CfnApiKey(this, 'ApiKey', {
      apiId: graphqlApi.attrApiId,
    });

    // Inline GraphQL schema. `getItemV2` backs the S3-sourced-template
    // resolver added by the #609 Resolver/DataSource batch (present in ALL
    // phases so no phase ever deletes the resolver).
    const schema = new appsync.CfnGraphQLSchema(this, 'GraphQLSchema', {
      apiId: graphqlApi.attrApiId,
      definition: `
type Item {
  id: ID!
  name: String
}

type Query {
  getItem(id: ID!): Item
  getItemV2(id: ID!): Item
}

schema {
  query: Query
}
`,
    });

    // DynamoDB table for data source
    const table = new dynamodb.Table(this, 'AppSyncDataTable', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM Role for AppSync to access DynamoDB
    const appsyncRole = new iam.Role(this, 'AppSyncDynamoDBRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });

    table.grantReadWriteData(appsyncRole);

    // DynamoDB data source
    const dataSource = new appsync.CfnDataSource(this, 'DynamoDBDataSource', {
      apiId: graphqlApi.attrApiId,
      name: 'ItemsTableDataSource',
      type: 'AMAZON_DYNAMODB',
      dynamoDbConfig: {
        awsRegion: this.region,
        tableName: table.tableName,
      },
      serviceRoleArn: appsyncRole.roleArn,
    });

    // Resolver for getItem query.
    //
    // #609 Resolver batch: `MetricsConfig` is live-asserted here (the API's
    // EnhancedMetricsConfig above is PER_RESOLVER_METRICS in every phase, so
    // the per-resolver flag is meaningful). The REMOVAL phase drops it —
    // `UpdateResolver` is a full-replace write, so cdkd omits the member and
    // AppSync must clear it to DISABLED server-side (the live pin of the
    // no-reset-sentinel removal story; the EventBridge data source below
    // RETAINS its own MetricsConfig so a blanket wipe cannot pass).
    const resolver = new appsync.CfnResolver(this, 'GetItemResolver', {
      apiId: graphqlApi.attrApiId,
      typeName: 'Query',
      fieldName: 'getItem',
      dataSourceName: dataSource.attrName,
      requestMappingTemplate: `{
  "version": "2017-02-28",
  "operation": "GetItem",
  "key": {
    "id": $util.dynamodb.toDynamoDBJson($ctx.args.id)
  }
}`,
      responseMappingTemplate: '$util.toJson($ctx.result)',
      ...(removalMode ? {} : { metricsConfig: 'ENABLED' }),
    });

    // Ensure resolver is created after schema and data source
    resolver.addDependency(schema);
    resolver.addDependency(dataSource);

    // #609 Resolver batch: a second resolver whose mapping templates come
    // from S3 (`RequestMappingTemplateS3Location` /
    // `ResponseMappingTemplateS3Location` — `aws-s3-assets` Assets, so the
    // files ride the asset-publishing pipeline with no custom resource).
    // cdkd must fetch the S3 bodies and inline them, mirroring CFn; the
    // UPDATE phase points the request template at a v2 asset (a different
    // key), which must re-fetch and re-upload the body.
    const requestTemplateAsset = new assets.Asset(this, 'GetItemV2RequestTemplate', {
      path: path.join(
        __dirname,
        'templates',
        updateMode ? 'get-item-request-v2.vtl' : 'get-item-request-v1.vtl'
      ),
    });
    const responseTemplateAsset = new assets.Asset(this, 'GetItemV2ResponseTemplate', {
      path: path.join(__dirname, 'templates', 'get-item-response.vtl'),
    });
    const s3TemplateResolver = new appsync.CfnResolver(this, 'GetItemV2Resolver', {
      apiId: graphqlApi.attrApiId,
      typeName: 'Query',
      fieldName: 'getItemV2',
      dataSourceName: dataSource.attrName,
      requestMappingTemplateS3Location: requestTemplateAsset.s3ObjectUrl,
      responseMappingTemplateS3Location: responseTemplateAsset.s3ObjectUrl,
    });
    s3TemplateResolver.addDependency(schema);
    s3TemplateResolver.addDependency(dataSource);

    // #609 DataSource batch: an EventBridge data source (EventBridgeConfig +
    // MetricsConfig). The bus is a cheap L1; the role lets AppSync PutEvents.
    // MetricsConfig here is deliberately RETAINED through the removal phase —
    // it is the sibling that proves the resolver's MetricsConfig removal is
    // targeted rather than a blanket metrics wipe.
    const eventBus = new events.CfnEventBus(this, 'AppSyncEventBus', {
      name: 'cdkd-appsync-example-bus',
    });
    const eventBridgeRole = new iam.Role(this, 'AppSyncEventBridgeRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    eventBridgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [eventBus.attrArn],
      })
    );
    new appsync.CfnDataSource(this, 'EventBridgeDataSource', {
      apiId: graphqlApi.attrApiId,
      name: 'EventBridgeDataSource',
      type: 'AMAZON_EVENTBRIDGE',
      description: updateMode ? 'cdkd-integ-updated' : 'cdkd-integ',
      serviceRoleArn: eventBridgeRole.roleArn,
      eventBridgeConfig: { eventBusArn: eventBus.attrArn },
      metricsConfig: 'ENABLED',
    });

    // #1597 DataSource NESTED-config batch: the two nested blobs the
    // nested-key critic opt-in exposed. Both live INSIDE a config block that
    // top-level property coverage already counted as handled, which is why
    // neither was visible until `AWS::AppSync::DataSource` became a critic
    // target.
    //
    // 1. `HttpConfig.AuthorizationConfig` — an IAM-signed HTTP data source.
    //    Dropping it does not fail the deploy: the data source is created
    //    UNSIGNED, so every request to the endpoint goes out without SigV4.
    //    The endpoint is a real AWS service endpoint, which costs nothing to
    //    point at and makes the signing config meaningful.
    const httpRole = new iam.Role(this, 'AppSyncHttpRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    httpRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: ['*'],
      })
    );
    new appsync.CfnDataSource(this, 'HttpDataSource', {
      apiId: graphqlApi.attrApiId,
      name: 'HttpDataSource',
      type: 'HTTP',
      serviceRoleArn: httpRole.roleArn,
      httpConfig: {
        // Endpoint is the RETAINED sibling of the removal phase below, so it
        // is deliberately CONSTANT across all three phases: it proves the
        // removal targets `AuthorizationConfig` rather than wiping the whole
        // `HttpConfig` block.
        endpoint: `https://states.${this.region}.amazonaws.com`,
        ...(removalMode
          ? {}
          : {
              authorizationConfig: {
                authorizationType: 'AWS_IAM',
                awsIamConfig: {
                  // The UPDATE phase moves the signing region off the deploy
                  // region — a real change to a member two levels deep, which
                  // an update path wired only for the top-level block drops.
                  // DERIVED from the deploy region rather than hardcoded: a
                  // literal would equal the baseline value whenever the
                  // harness runs in that region, silently making the update
                  // assertion vacuous.
                  signingRegion:
                    updateMode === false
                      ? this.region
                      : this.region === 'us-west-2'
                        ? 'us-east-2'
                        : 'us-west-2',
                  signingServiceName: 'states',
                },
              },
            }),
      },
    });

    // 2. `DynamoDBConfig.DeltaSyncConfig` + `.Versioned` — a versioned
    //    (conflict-detection) DynamoDB data source. The two TTLs are the one
    //    CFn->SDK TYPE divergence in the batch: CFn declares them as STRINGS
    //    and the SDK models them as longs, so a verbatim forward is dropped
    //    by the serializer and a number on readback would be phantom drift.
    const deltaSyncTable = new dynamodb.Table(this, 'AppSyncDeltaSyncTable', {
      partitionKey: { name: 'ds_pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ds_sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const versionedRole = new iam.Role(this, 'AppSyncVersionedRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    table.grantReadWriteData(versionedRole);
    deltaSyncTable.grantReadWriteData(versionedRole);
    new appsync.CfnDataSource(this, 'VersionedDynamoDBDataSource', {
      apiId: graphqlApi.attrApiId,
      name: 'VersionedItemsDataSource',
      type: 'AMAZON_DYNAMODB',
      serviceRoleArn: versionedRole.roleArn,
      dynamoDbConfig: {
        awsRegion: this.region,
        tableName: table.tableName,
        // `Versioned` is the RETAINED sibling of the removal phase: it stays
        // true while `DeltaSyncConfig` is dropped, so a reset that cleared
        // the whole DynamoDBConfig block cannot pass.
        versioned: true,
        ...(removalMode
          ? {}
          : {
              deltaSyncConfig: {
                baseTableTtl: updateMode ? '86400' : '43200',
                deltaSyncTableName: deltaSyncTable.tableName,
                deltaSyncTableTtl: updateMode ? '2880' : '1440',
              },
            }),
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'GraphQLApiUrl', {
      value: graphqlApi.attrGraphQlUrl,
      description: 'AppSync GraphQL API URL',
    });

    new cdk.CfnOutput(this, 'GraphQLApiId', {
      value: graphqlApi.attrApiId,
      description: 'AppSync GraphQL API ID',
    });

    new cdk.CfnOutput(this, 'ApiKeyValue', {
      value: apiKey.attrApiKey,
      description: 'AppSync API Key',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    // Issue #1681: `Ref` to any of the three AppSync CHILD types returns the
    // resource ARN (all docs-verified), while cdkd stores a compound
    // physicalId (`<apiId>|<name>`, `<apiId>|<typeName>|<fieldName>`,
    // `<apiId>|<apiKeyId>`). The ARN is no SEGMENT of that id, so it cannot be
    // extracted — the resolver recovers it from the ARN attribute the provider
    // records at create time. Pre-fix these outputs resolved to the raw
    // compound id.
    //
    // These also fence the SECOND half of #1681: the recorded attribute was
    // string-built as `arn:aws:appsync:*:*:...`, with a literal `*` in the
    // region AND account positions, so `Fn::GetAtt` on the same attribute was
    // broken too. Asserting the output carries the real account / region is
    // what distinguishes the fix from the bug — a placeholder ARN is produced
    // by exactly the same code path.
    new cdk.CfnOutput(this, 'DataSourceRef', {
      value: dataSource.ref,
      description: 'Ref of the DynamoDB DataSource — must be its real ARN',
    });

    new cdk.CfnOutput(this, 'ResolverRef', {
      value: resolver.ref,
      description: 'Ref of the GetItem Resolver — must be its real ARN',
    });

    new cdk.CfnOutput(this, 'ApiKeyRef', {
      value: apiKey.ref,
      description: 'Ref of the ApiKey — must be its real ARN (singular apikey segment)',
    });
  }
}
