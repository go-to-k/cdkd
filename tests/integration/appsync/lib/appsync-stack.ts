import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * AppSync GraphQL API example stack
 *
 * Demonstrates:
 * - AppSync GraphQL API (L1 CfnGraphQLApi)
 * - Inline GraphQL schema (CfnGraphQLSchema)
 * - DynamoDB table as data source (CfnDataSource)
 * - Resolver connecting query to DynamoDB (CfnResolver)
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

    // Inline GraphQL schema
    const schema = new appsync.CfnGraphQLSchema(this, 'GraphQLSchema', {
      apiId: graphqlApi.attrApiId,
      definition: `
type Item {
  id: ID!
  name: String
}

type Query {
  getItem(id: ID!): Item
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

    // Resolver for getItem query
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
    });

    // Ensure resolver is created after schema and data source
    resolver.addDependency(schema);
    resolver.addDependency(dataSource);

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
  }
}
