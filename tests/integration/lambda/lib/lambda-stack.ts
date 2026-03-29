import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Lambda example stack
 *
 * Demonstrates:
 * - Lambda function deployment with Python runtime
 * - Lambda Layer Version (asset-based)
 * - Lambda Alias
 * - IAM role creation and permissions
 * - DynamoDB table with GSI
 * - Environment variables with Ref
 * - Resource dependencies (Lambda depends on DynamoDB)
 * - Fn::GetAtt for outputs
 */
export class LambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table with GSI
    const table = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
    });

    // Create Lambda Layer
    const layer = new lambda.LayerVersion(this, 'UtilsLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layer')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Utils layer for cdkd test',
    });

    // Create Lambda function with layer
    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      handler: 'index.handler',
      environment: {
        TABLE_NAME: table.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      layers: [layer],
    });

    // Create Lambda Alias
    const alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    // Grant Lambda permissions to access DynamoDB
    table.grantReadWriteData(fn);

    // Outputs using Fn::GetAtt
    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: fn.functionArn,
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
    });

    new cdk.CfnOutput(this, 'AliasArn', {
      value: alias.functionArn,
    });

    new cdk.CfnOutput(this, 'LayerArn', {
      value: layer.layerVersionArn,
    });
  }
}
