import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * FIFO SQS queue as a Lambda event source integ.
 *
 * A `.fifo` queue (FifoQueue + ContentBasedDeduplication) wired to a Lambda via
 * SqsEventSource synthesizes an AWS::Lambda::EventSourceMapping against a FIFO
 * source. FIFO queues are barely covered by the integ suite. The consumer
 * writes each received body + MessageGroupId to a DynamoDB table so the
 * functional check can confirm the messages were actually delivered + processed
 * (a deploy-only smoke test would not prove the ESM fires).
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::Lambda::EventSourceMapping
 * covers: AWS::Lambda::Function
 * covers: AWS::DynamoDB::Table
 */
export class FifoSqsEventSourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new ddb.Table(this, 'Seen', {
      tableName: 'cdkd-fifo-sqs-seen',
      partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fifo = new sqs.Queue(this, 'Fifo', {
      queueName: 'cdkd-fifo-sqs-source.fifo',
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Consumer', {
      functionName: 'cdkd-fifo-sqs-consumer',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      environment: { TABLE: table.tableName },
      code: lambda.Code.fromInline(
        [
          'const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");',
          'const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");',
          'const d = DynamoDBDocumentClient.from(new DynamoDBClient({}));',
          'exports.handler = async (event) => {',
          '  for (const r of event.Records) {',
          '    await d.send(new PutCommand({ TableName: process.env.TABLE, Item: { id: r.body, group: r.attributes.MessageGroupId } }));',
          '  }',
          '};',
        ].join('\n'),
      ),
    });
    table.grantWriteData(fn);
    fn.addEventSource(new SqsEventSource(fifo, { batchSize: 5 }));

    new cdk.CfnOutput(this, 'FifoUrl', { value: fifo.queueUrl });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
