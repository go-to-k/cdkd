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
 * go-to-k/cdkd#4612: two more RETAINED queues, C and D. `overlapfail` adds a
 * QueuePolicy over [C, D, a queue that does not exist]: it writes C and D,
 * then fails, and is journaled under `C,D` (deployed with --no-rollback).
 * `overlapown` adds another QueuePolicy over [C]. Deleting the failed entry
 * must clear only the queues still carrying its document (verify.sh 1d).
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

    // go-to-k/cdkd#4612: the shared-queue arm.
    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');
    const overlapQueueC = new sqs.Queue(this, 'OverlapQueueC', {
      queueName: 'cdkd-sns-filter-overlap-c',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const overlapQueueD = new sqs.Queue(this, 'OverlapQueueD', {
      queueName: 'cdkd-sns-filter-overlap-d',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Each statement names ONE queue ARN: SQS rejected this document when its
    // two statements each named both queues ("Each statement in the policy
    // should have exactly one resource"). The same document goes to both
    // queues, so one queue's policy names the other's ARN, as
    // MultiQueuePolicy's does (Phase 1 shows SQS accepts that).
    const sendStatement = (sid: string, queue: sqs.IQueue = overlapQueueC): Record<string, unknown> => ({
      Sid: sid,
      Effect: 'Allow',
      Principal: { Service: 'sns.amazonaws.com' },
      Action: 'sqs:SendMessage',
      Resource: queue.queueArn,
      Condition: { ArnEquals: { 'aws:SourceArn': topic.topicArn } },
    });
    // allow-mode-gated-drop: its CREATE always fails, so no record exists for a later deploy to delete.
    if (modes.includes('overlapfail')) {
      new sqs.CfnQueuePolicy(this, 'OverlapFailPolicy', {
        queues: [
          overlapQueueC.queueUrl,
          overlapQueueD.queueUrl,
          // No such queue: SetQueueAttributes fails after C and D were written.
          `https://sqs.${this.region}.${this.urlSuffix}/${this.account}/cdkd-sns-filter-overlap-missing`,
        ],
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            sendStatement('OverlapFail'),
            sendStatement('OverlapFailD', overlapQueueD),
            // A RAW account-id principal (L1, so CDK does not rewrite it):
            // SQS stores it as its root ARN; the failed entry's delete must
            // still match it (an IAM-equivalent compare). verify.sh notes it.
            {
              Sid: 'RawAccount',
              Effect: 'Allow',
              Principal: { AWS: this.account },
              Action: 'sqs:GetQueueAttributes',
              Resource: overlapQueueC.queueArn,
            },
          ],
        },
      });
    }
    if (modes.includes('overlapown')) {
      new sqs.CfnQueuePolicy(this, 'OverlapOwnPolicy', {
        queues: [overlapQueueC.queueUrl],
        // `overlapownv2` changes the document, so the update rewrites C.
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            sendStatement('OverlapOwn'),
            ...(modes.includes('overlapownv2') ? [sendStatement('OverlapOwnV2')] : []),
          ],
        },
      });
    }

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
  }
}
