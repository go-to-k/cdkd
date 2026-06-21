import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { StartingPosition, FilterCriteria, FilterRule } from 'aws-cdk-lib/aws-lambda';

/**
 * cdkd DynamoDB stream -> Lambda event source with FilterCriteria integ.
 *
 * A daily CDK pattern: `fn.addEventSource(new DynamoEventSource(table, {
 * filters, bisectBatchOnError, reportBatchItemFailures }))`. The synthesized
 * AWS::Lambda::EventSourceMapping carries a FilterCriteria.Filters array (each
 * filter a JSON-encoded Pattern), BisectBatchOnFunctionError, and
 * FunctionResponseTypes — the under-tested ESM properties cdkd must forward to
 * CreateEventSourceMapping.
 *
 * verify.sh reads the ESM back via get-event-source-mapping and asserts the
 * filter pattern, bisect flag and response types all reached AWS.
 *
 * covers: AWS::Lambda::EventSourceMapping
 * covers: AWS::DynamoDB::Table
 */
export class DynamodbStreamFilterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'Table', {
      tableName: 'cdkd-ddb-stream-filter',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Consumer', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async () => ({ batchItemFailures: [] });`,
      ),
    });

    fn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 2,
        reportBatchItemFailures: true,
        filters: [
          FilterCriteria.filter({
            eventName: FilterRule.isEqual('INSERT'),
          }),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
