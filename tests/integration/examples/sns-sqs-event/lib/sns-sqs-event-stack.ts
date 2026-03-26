import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';

export class SnsSqsEventStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SNS Topic
    const topic = new sns.Topic(this, 'EventTopic', {
      topicName: 'cdkq-sns-sqs-test-topic',
    });

    // Dead Letter Queue
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: 'cdkq-sns-sqs-test-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // Primary Queue (with DLQ)
    const primaryQueue = new sqs.Queue(this, 'PrimaryQueue', {
      queueName: 'cdkq-sns-sqs-test-primary',
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Secondary Queue (no DLQ, filter by attribute)
    const secondaryQueue = new sqs.Queue(this, 'SecondaryQueue', {
      queueName: 'cdkq-sns-sqs-test-secondary',
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    // Subscribe queues to topic
    topic.addSubscription(
      new subscriptions.SqsSubscription(primaryQueue)
    );

    topic.addSubscription(
      new subscriptions.SqsSubscription(secondaryQueue, {
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ['important'],
          }),
        },
      })
    );

    // Lambda processor triggered by primary queue
    const processor = new lambda.Function(this, 'Processor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          for (const record of event.Records) {
            console.log('Processing:', record.body);
          }
          return { statusCode: 200, processed: event.Records.length };
        };
      `),
    });

    processor.addEventSource(
      new eventsources.SqsEventSource(primaryQueue, {
        batchSize: 5,
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'PrimaryQueueUrl', { value: primaryQueue.queueUrl });
    new cdk.CfnOutput(this, 'SecondaryQueueUrl', { value: secondaryQueue.queueUrl });
    new cdk.CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'ProcessorFunctionName', { value: processor.functionName });
  }
}
