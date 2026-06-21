import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

/**
 * cdkd SNS -> SQS subscription with a `filterPolicy` integ.
 *
 * A daily CDK pattern: an SNS subscription carries a `FilterPolicy` — a nested
 * JSON object CFn passes through to SetSubscriptionAttributes. cdkd must forward
 * the nested object exactly (not double-stringify it / drop it). The subscription
 * also exercises the SQS queue policy that grants SNS sendMessage.
 *
 * verify.sh reads the subscription's FilterPolicy back via
 * get-subscription-attributes and asserts it matches what was synthesized.
 *
 * covers: AWS::SNS::Subscription
 * covers: AWS::SNS::Topic
 * covers: AWS::SQS::Queue
 * covers: AWS::SQS::QueuePolicy
 */
export class SnsSubscriptionFilterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'Topic', {
      topicName: 'cdkd-sns-filter-topic',
    });
    const queue = new sqs.Queue(this, 'Queue', {
      queueName: 'cdkd-sns-filter-queue',
    });

    topic.addSubscription(
      new subs.SqsSubscription(queue, {
        rawMessageDelivery: true,
        filterPolicy: {
          color: sns.SubscriptionFilter.stringFilter({
            allowlist: ['red', 'green'],
          }),
          weight: sns.SubscriptionFilter.numericFilter({
            greaterThan: 10,
          }),
        },
      }),
    );

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
  }
}
