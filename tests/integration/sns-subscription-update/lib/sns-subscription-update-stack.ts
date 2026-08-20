import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * cdkd standalone `AWS::SNS::Subscription` UPDATE integ (issue
 * [#1967](https://github.com/go-to-k/cdkd/issues/1967)).
 *
 * `SNSSubscriptionProvider.update` replaces DELETE-first: it unsubscribes the
 * old subscription and subscribes a new one, even for a change AWS itself
 * would accept in place. Nothing in the integ tree drove that method before
 * this fixture, which is how the thrown-delete arm of #1967 — where the
 * unsubscribe fails and cdkd subscribed anyway, leaving TWO live subscriptions
 * delivering every message twice — reached main.
 *
 * ## Why the mutated property is `RawMessageDelivery` and NOT `Endpoint`
 *
 * MEASURED, not assumed. `Endpoint` / `Protocol` / `TopicArn` are
 * `createOnlyProperties` in the live CloudFormation registry schema
 * (`aws cloudformation describe-type --type-name AWS::SNS::Subscription`
 * returns exactly those three). `diff-calculator.ts` applies the schema as a
 * fallback wherever `ReplacementRulesRegistry` has no explicit opinion — and it
 * has none for this type — so an endpoint change sets `requiresReplacement`,
 * which routes to `deploy-engine.ts`'s OWN replacement branch. That branch
 * calls `provider.delete()` + `provider.create()` directly; the only
 * `provider.update()` call site in the engine sits in the `else` of that same
 * `if`. An endpoint-change fixture would therefore never execute one line of
 * the method under test, while looking exactly like a test of it.
 *
 * `RawMessageDelivery` is mutable per the same schema, so it lands in the
 * `else` branch and drives `update()` — which then performs its own
 * delete-then-create anyway. That is the behaviour worth pinning: a one-word
 * property flip silently destroys and recreates the subscription, so a failed
 * unsubscribe there is a duplicate for a change the user thinks is trivial.
 *
 * ## Shape
 *
 * One topic, one queue, one L1 `CfnSubscription`. L1 rather than
 * `topic.addSubscription()` deliberately: the L2 embeds the target's node path
 * in the logical id, so any change to the target yields a DIFFERENT logical id
 * — a create + delete pair, not an update. A stable logical id across both
 * modes is what makes this an UPDATE at all.
 *
 * No queue policy: this fixture asserts SUBSCRIPTION TOPOLOGY (how many, which
 * ARN, which attributes), never message delivery, so a policy would add
 * resources no assertion reads and more surface for destroy to leak.
 *
 * covers: AWS::SNS::Subscription
 * covers: AWS::SNS::Topic
 * covers: AWS::SQS::Queue
 */
export class SnsSubscriptionUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'Topic', {
      topicName: 'cdkd-sub-update-topic',
    });

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: 'cdkd-sub-update-queue',
    });

    // A scalar PROPERTY of an always-present resource, never the presence of a
    // resource: a mode-gated RESOURCE is deleted by every later step whose mode
    // list omits the token, and here that would delete the subscription this
    // fixture exists to UPDATE.
    const rawDelivery = (process.env['CDKD_TEST_UPDATE'] ?? '').includes('raw-delivery');

    // BOTH polarities are explicit. Leaving the false arm to the AWS default
    // would make the mode-off deploy indistinguishable from one where cdkd
    // dropped the property entirely, so the phase-1 assertion could not tell a
    // forwarded `false` from a silent drop.
    new sns.CfnSubscription(this, 'StandaloneSubscription', {
      topicArn: topic.topicArn,
      protocol: 'sqs',
      endpoint: queue.queueArn,
      rawMessageDelivery: rawDelivery,
    });

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'QueueArn', { value: queue.queueArn });
  }
}
