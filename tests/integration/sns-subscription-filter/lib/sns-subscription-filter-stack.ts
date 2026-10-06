import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';

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
 * A second, standalone `sqs.QueuePolicy` names TWO queues (go-to-k/cdkd#4594).
 * `CDKD_TEST_UPDATE=shrink` drops the second queue from its list, so the
 * update must clear the policy from the dropped queue; destroy must clear it
 * from both. The two queues are RETAINED, so verify.sh can read their `Policy`
 * attribute after the destroy (and deletes them itself).
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

    // go-to-k/cdkd#4594: a multi-queue QueuePolicy. Retained so the queues
    // outlive the destroy and verify.sh can assert the policy was cleared.
    const shrink = (process.env.CDKD_TEST_UPDATE ?? '').split(',').includes('shrink');
    const policyQueueA = new sqs.Queue(this, 'PolicyQueueA', {
      queueName: 'cdkd-sns-filter-policy-a',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const policyQueueB = new sqs.Queue(this, 'PolicyQueueB', {
      queueName: 'cdkd-sns-filter-policy-b',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const multiQueuePolicy = new sqs.QueuePolicy(this, 'MultiQueuePolicy', {
      queues: shrink ? [policyQueueA] : [policyQueueA, policyQueueB],
    });
    multiQueuePolicy.document.addStatements(
      new iam.PolicyStatement({
        sid: 'TopicSend',
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [policyQueueA.queueArn, policyQueueB.queueArn],
        conditions: { ArnEquals: { 'aws:SourceArn': topic.topicArn } },
      }),
    );

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
  }
}
