import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

/**
 * Fixture for issue #1301: a topic with an email subscription that is never
 * confirmed. The subscription stays in PendingConfirmation forever, and SNS
 * rejects Unsubscribe on it — `cdkd destroy` must skip it (CloudFormation
 * parity) instead of getting permanently stuck.
 */
export class SnsPendingSubscriptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'PendingSubTopic', {
      topicName: 'cdkd-sns-pending-sub-topic',
    });

    // example.com is reserved (RFC 2606); the confirmation mail goes nowhere,
    // so the subscription is guaranteed to stay PendingConfirmation.
    topic.addSubscription(new subs.EmailSubscription('cdkd-integ-nobody@example.com'));

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
