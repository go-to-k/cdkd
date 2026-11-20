import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ fixture for issue #6712: a deploy that replaces an SQS queue and an
 * SNS topic, then FAILS later, must leave the old queue and topic whole.
 *
 * `SqsSubscription` adds an `AWS::SQS::QueuePolicy`, which cdkd records under
 * the queue URL, so the old queue's id is held by another record; the topic's
 * `AWS::SNS::TopicPolicy` is recorded under the topic ARN. With
 * `CDKD_TEST_PHASE=fail` both names change (a create-first replacement) and
 * `Breaker`, an SSM parameter whose value does not match its own
 * `AllowedPattern`, is created after the queue: AWS refuses it, so the deploy
 * fails after both replacements. Before the fix the old queue and topic were
 * deleted right after the new ones were created, and the rollback re-created
 * them empty: the queue's messages and the topic's subscriptions were gone.
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::SQS::QueuePolicy
 * covers: AWS::SNS::Topic
 * covers: AWS::SNS::TopicPolicy
 * covers: AWS::SNS::Subscription
 * covers: AWS::SSM::Parameter
 */
export class ReplacedQueueTopicFailedRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const fail = process.env.CDKD_TEST_PHASE === 'fail';
    const suffix = fail ? 'b' : 'a';

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: `${this.stackName}-q-${suffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const topic = new sns.Topic(this, 'Topic', { topicName: `${this.stackName}-t-${suffix}` });
    topic.addSubscription(new subs.SqsSubscription(queue, { rawMessageDelivery: true }));
    topic.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new cdk.aws_iam.ServicePrincipal('events.amazonaws.com')],
        resources: [topic.topicArn],
      })
    );

    if (fail) {
      // Reads the new queue's name, so it is created after the replacement.
      new ssm.CfnParameter(this, 'Breaker', {
        name: `${this.stackName}-breaker`,
        type: 'String',
        value: queue.queueName,
        allowedPattern: '^[0-9]+$',
      });
    }
  }
}
