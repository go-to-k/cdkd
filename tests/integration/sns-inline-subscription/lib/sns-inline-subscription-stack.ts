import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Exercises the inline `AWS::SNS::Topic` `Subscription` property (issue #980).
 *
 * Unlike CDK's L2 `topic.addSubscription()` (which emits separate
 * `AWS::SNS::Subscription` resources), the L1 `CfnTopic` `subscription: [...]`
 * list declares the subscription INLINE on the Topic. cdkd previously dropped
 * that list on both create() and update(); this fixture proves it now reaches
 * AWS.
 *
 * Phase 1 (default): topic subscribes to queue A.
 * Phase 2 (CDKD_TEST_UPDATE=true): topic subscribes to queue B instead —
 * verifies the UPDATE diff Subscribes the new endpoint and Unsubscribes the
 * old one.
 */
export class SnsInlineSubscriptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // Two SQS queues; the inline subscription endpoint switches between them
    // across the update phase.
    const queueA = new sqs.CfnQueue(this, 'QueueA', {
      queueName: 'cdkd-sns-inline-sub-queue-a',
    });
    const queueB = new sqs.CfnQueue(this, 'QueueB', {
      queueName: 'cdkd-sns-inline-sub-queue-b',
    });

    const endpoint = isUpdate ? queueB.attrArn : queueA.attrArn;

    // L1 CfnTopic with an INLINE subscription list.
    const topic = new sns.CfnTopic(this, 'Topic', {
      topicName: 'cdkd-sns-inline-sub-topic',
      subscription: [
        {
          protocol: 'sqs',
          endpoint,
        },
      ],
    });

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.ref });
    new cdk.CfnOutput(this, 'QueueAArn', { value: queueA.attrArn });
    new cdk.CfnOutput(this, 'QueueBArn', { value: queueB.attrArn });
  }
}
