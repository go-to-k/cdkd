import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

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

    // GraphQL API
    const graphqlApi = new appsync.CfnGraphQLApi(this, 'GraphQLApi', {
      name: 'cdkd-appsync-example',
      authenticationType: 'API_KEY',
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
