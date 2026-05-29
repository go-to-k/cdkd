import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    // TableV2 (synthesizes as AWS::DynamoDB::GlobalTable) — covers the bug-class
    // where Fn::GetAtt: [<TableV2>, 'Arn'] used to fall back to physicalId,
    // breaking IAM policy creation. Granting a Lambda below exercises the path.
    const tableV2 = new dynamodb.TableV2(this, 'HistoryTable', {
      partitionKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Lambda Layer
    const layer = new lambda.LayerVersion(this, 'UtilsLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layer')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Utils layer for cdkd test',
    });

    // Create Lambda function with layer.
    //
    // deadLetterQueueEnabled auto-creates an SQS DLQ and sets the function's
    // DeadLetterConfig.TargetArn; loggingFormat / applicationLogLevelV2 /
    // systemLogLevelV2 set the function's LoggingConfig — both are native
    // config fields backfilled in issue #609, exercised here end-to-end on
    // the SDK path. (Because DeadLetterConfig + LoggingConfig are now
    // `handled`, the function stays on the SDK provider instead of
    // auto-routing via Cloud Control API.)
    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      handler: 'index.handler',
      environment: {
        TABLE_NAME: table.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      layers: [layer],
      deadLetterQueueEnabled: true,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
    });

    // Create Lambda Alias
    const alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    // Grant Lambda permissions to access DynamoDB
    table.grantReadWriteData(fn);
    tableV2.grantReadWriteData(fn);

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

    new cdk.CfnOutput(this, 'HistoryTableName', {
      value: tableV2.tableName,
    });

    new cdk.CfnOutput(this, 'HistoryTableArn', {
      value: tableV2.tableArn,
    });

    new cdk.CfnOutput(this, 'AliasArn', {
      value: alias.functionArn,
    });

    new cdk.CfnOutput(this, 'LayerArn', {
      value: layer.layerVersionArn,
    });
  }
}
