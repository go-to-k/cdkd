import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Data Pipeline example stack
 *
 * Demonstrates:
 * - SQS Queue as input with a Dead Letter Queue for failures
 * - Lambda function with inline Python code processing SQS messages
 * - SQS event source mapping with batch size and DLQ configuration
 * - DynamoDB table as output store
 * - IAM permissions via grantWriteData
 * - Cross-resource references (Ref, Fn::GetAtt)
 * - CfnOutputs for queue URLs, table name, function name
 */
export class DataPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tags
    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'data-pipeline');

    // DLQ for failed messages
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${this.stackName}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Input queue with DLQ configured
    const inputQueue = new sqs.Queue(this, 'InputQueue', {
      queueName: `${this.stackName}-input`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table as output store
    const table = new dynamodb.Table(this, 'OutputTable', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda function to process SQS messages and write to DynamoDB
    const processor = new lambda.Function(this, 'Processor', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import os
import uuid
import time

def handler(event, context):
    table_name = os.environ['TABLE_NAME']
    processed = 0

    for record in event.get('Records', []):
        body = record.get('body', '{}')
        message_id = record.get('messageId', str(uuid.uuid4()))

        print(f"Processing message {message_id}: {body}")

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {'raw': body}

        item = {
            'id': {'S': message_id},
            'data': {'S': json.dumps(data)},
            'processedAt': {'S': str(int(time.time()))},
        }

        print(f"Would write to {table_name}: {json.dumps(item)}")
        processed += 1

    return {
        'statusCode': 200,
        'body': json.dumps({'processed': processed})
    }
`),
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    // Grant Lambda write access to DynamoDB table
    table.grantWriteData(processor);

    // Add SQS event source with batch size
    processor.addEventSource(
      new lambdaEventSources.SqsEventSource(inputQueue, {
        batchSize: 10,
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'InputQueueUrl', {
      value: inputQueue.queueUrl,
      description: 'Input SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'DlqUrl', {
      value: dlq.queueUrl,
      description: 'Dead Letter Queue URL',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB output table name',
    });

    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: processor.functionName,
      description: 'Processor Lambda function name',
    });
  }
}
