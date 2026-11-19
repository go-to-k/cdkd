import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Integ probe for go-to-k/cdkd#6610: a subscription a SIBLING
 * `AWS::SNS::Subscription` adds to a topic is that resource's, not the
 * topic's. A topic whose template declares an inline `Subscription` list reads
 * back every live subscription, so before the fix `cdkd drift` reported the
 * sibling's subscription as `Subscription` drift and `cdkd drift --revert`
 * UNSUBSCRIBED it.
 *
 * - The topic declares one inline subscription (queue A).
 * - `CDKD_TEST_UPDATE=sub` adds a standalone subscription to queue B while the
 *   topic is unchanged, so the topic's recorded baseline cannot hold it.
 * - `display` changes the topic's DisplayName, so the topic is UPDATED (and its
 *   baseline re-captured) while the sibling subscription exists.
 * - `nosub` removes the standalone subscription, whose delete unsubscribes
 *   queue B (the topic is unchanged).
 *
 * covers: AWS::SNS::Topic
 * covers: AWS::SNS::Subscription
 */
export class DriftSnsSiblingSubscriptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');
    const queueA = new sqs.CfnQueue(this, 'QueueA');
    const queueB = new sqs.CfnQueue(this, 'QueueB');
    const queueC = new sqs.CfnQueue(this, 'QueueC');

    const topic = new sns.CfnTopic(this, 'Topic', {
      displayName: modes.includes('display') ? 'cdkd-6610-v2' : 'cdkd-6610-v1',
      subscription: [{ protocol: 'sqs', endpoint: queueA.attrArn }],
    });

    // allow-mode-gated-drop: the removal IS the arm (its delete unsubscribes queue B, and the deploy must prune the topic's baseline).
    if (modes.includes('sub') && !modes.includes('nosub')) {
      new sns.CfnSubscription(this, 'SubscriptionB', {
        topicArn: topic.ref,
        protocol: 'sqs',
        endpoint: queueB.attrArn,
      });
    }

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.ref });
    new cdk.CfnOutput(this, 'QueueAArn', { value: queueA.attrArn });
    new cdk.CfnOutput(this, 'QueueBArn', { value: queueB.attrArn });
    new cdk.CfnOutput(this, 'QueueCArn', { value: queueC.attrArn });
  }
}
