import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';

export class SnsSqsEventStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SNS Topic
    const topic = new sns.Topic(this, 'EventTopic', {
      topicName: 'cdkd-sns-sqs-test-topic',
    });

    // Dead Letter Queue.
    // `redriveAllowPolicy` exercises the SQS RedriveAllowPolicy backfill
    // (issue #609): ALLOW_ALL lets any source queue use this queue as its DLQ.
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: 'cdkd-sns-sqs-test-dlq',
      retentionPeriod: cdk.Duration.days(14),
      redriveAllowPolicy: {
        redrivePermission: sqs.RedrivePermission.ALLOW_ALL,
      },
    });

    // Subscription dead-letter queue — referenced by the secondary
    // subscription's `deadLetterQueue` option below, which produces a
    // `RedrivePolicy` ON THE SUBSCRIPTION (exercises the SNS Subscription
    // RedrivePolicy backfill, issue #609).
    const subscriptionDlq = new sqs.Queue(this, 'SubscriptionDlq', {
      queueName: 'cdkd-sns-sqs-test-sub-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // Primary Queue (with DLQ)
    const primaryQueue = new sqs.Queue(this, 'PrimaryQueue', {
      queueName: 'cdkd-sns-sqs-test-primary',
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Secondary Queue (no DLQ, filter by attribute)
    const secondaryQueue = new sqs.Queue(this, 'SecondaryQueue', {
      queueName: 'cdkd-sns-sqs-test-secondary',
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    // Subscribe queues to topic.
    // `rawMessageDelivery: true` exercises the SNS Subscription
    // RawMessageDelivery backfill (issue #609).
    topic.addSubscription(
      new subscriptions.SqsSubscription(primaryQueue, {
        rawMessageDelivery: true,
      })
    );

    // The secondary subscription carries a `deadLetterQueue`, which CDK
    // synthesizes as a `RedrivePolicy` on the AWS::SNS::Subscription
    // (exercises the SNS Subscription RedrivePolicy backfill, issue #609).
    topic.addSubscription(
      new subscriptions.SqsSubscription(secondaryQueue, {
        deadLetterQueue: subscriptionDlq,
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ['important'],
          }),
        },
      })
    );

    // FIFO Topic + Queue (ordered message delivery)
    const fifoTopic = new sns.Topic(this, 'FifoTopic', {
      topicName: `cdkd-sns-sqs-test-fifo-${this.account}.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
    });

    const fifoQueue = new sqs.Queue(this, 'FifoQueue', {
      queueName: `cdkd-sns-sqs-test-fifo-${this.account}.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    fifoTopic.addSubscription(new subscriptions.SqsSubscription(fifoQueue));

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

    // SNS Topic Policy
    new sns.TopicPolicy(this, 'TopicPolicy', {
      topics: [topic],
      policyDocument: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['sns:Publish'],
            principals: [new iam.ServicePrincipal('events.amazonaws.com')],
            resources: [topic.topicArn],
          }),
        ],
      }),
    });

    // Outputs
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'PrimaryQueueUrl', { value: primaryQueue.queueUrl });
    new cdk.CfnOutput(this, 'SecondaryQueueUrl', { value: secondaryQueue.queueUrl });
    new cdk.CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'ProcessorFunctionName', { value: processor.functionName });
    new cdk.CfnOutput(this, 'FifoQueueUrl', { value: fifoQueue.queueUrl });
    new cdk.CfnOutput(this, 'FifoTopicArn', { value: fifoTopic.topicArn });
  }
}
