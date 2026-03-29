import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * DynamoDB Streams example stack
 *
 * Demonstrates:
 * - DynamoDB table with stream enabled (NEW_AND_OLD_IMAGES)
 * - Lambda function with inline code triggered by DynamoDB stream
 * - Event source mapping connecting stream to Lambda
 * - IAM role with stream read permissions
 * - ApplicationAutoScaling ScalableTarget for read/write capacity
 * - ApplicationAutoScaling ScalingPolicy with target tracking (70% utilization)
 * - Fn::GetAtt for outputs (table ARN, stream ARN, function name)
 */
export class DynamodbStreamsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table with stream enabled
    const table = new dynamodb.Table(this, 'EventsTable', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Auto-scaling for read capacity
    const readScaling = table.autoScaleReadCapacity({
      minCapacity: 5,
      maxCapacity: 20,
    });
    readScaling.scaleOnUtilization({
      targetUtilizationPercent: 70,
    });

    // Auto-scaling for write capacity
    const writeScaling = table.autoScaleWriteCapacity({
      minCapacity: 5,
      maxCapacity: 20,
    });
    writeScaling.scaleOnUtilization({
      targetUtilizationPercent: 70,
    });

    // Create Lambda function with inline code to process stream records
    const fn = new lambda.Function(this, 'StreamProcessor', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json

def handler(event, context):
    for record in event.get('Records', []):
        event_name = record.get('eventName', 'UNKNOWN')
        dynamodb_record = record.get('dynamodb', {})
        keys = dynamodb_record.get('Keys', {})
        print(f"Event: {event_name}, Keys: {json.dumps(keys)}")

        if event_name == 'INSERT':
            new_image = dynamodb_record.get('NewImage', {})
            print(f"New item: {json.dumps(new_image)}")
        elif event_name == 'MODIFY':
            old_image = dynamodb_record.get('OldImage', {})
            new_image = dynamodb_record.get('NewImage', {})
            print(f"Old: {json.dumps(old_image)}")
            print(f"New: {json.dumps(new_image)}")
        elif event_name == 'REMOVE':
            old_image = dynamodb_record.get('OldImage', {})
            print(f"Deleted item: {json.dumps(old_image)}")

    return {
        'statusCode': 200,
        'body': json.dumps({'processed': len(event.get('Records', []))})
    }
`),
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    // Add DynamoDB stream as event source for Lambda
    fn.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: table.tableArn,
      description: 'DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'StreamArn', {
      value: table.tableStreamArn!,
      description: 'DynamoDB stream ARN',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Stream processor Lambda function name',
    });
  }
}
