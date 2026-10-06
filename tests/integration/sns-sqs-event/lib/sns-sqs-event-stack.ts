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

    // CDKD_TEST_REMOVAL (issue #1160, sqs batch): the baseline template sets
    // SqsManagedSseEnabled: false on the L1 queue below; the removal phase
    // drops the property entirely. SQS SetQueueAttributes MERGES (absent =
    // "no change"), so pre-fix the live queue silently kept SSE off; the
    // provider must reset it to the SQS/CFn default (true).
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    new sqs.CfnQueue(this, 'SseRemovalQueue', {
      queueName: 'cdkd-sns-sqs-test-sse-removal',
      ...(removal ? {} : { sqsManagedSseEnabled: false }),
    });

    // CDKD_TEST_REMOVAL (issue #1160, sns batch): the baseline template sets a
    // Lambda DeliveryStatusLogging block on the L1 topic below; the removal
    // phase drops the property entirely. SNS SetTopicAttributes is
    // per-attribute merge (an attribute never sent keeps its live value), so
    // pre-fix the per-protocol feedback attributes silently survived the
    // removal; the provider must reset them (RoleArns cleared via '',
    // SampleRate reset to 0 — the CFn-parity shape, live A/B'd 2026-08-10).
    const feedbackRole = new iam.Role(this, 'DeliveryStatusRole', {
      assumedBy: new iam.ServicePrincipal('sns.amazonaws.com'),
    });
    new sns.CfnTopic(this, 'DeliveryStatusTopic', {
      topicName: 'cdkd-sns-sqs-test-delivery-status',
      ...(removal
        ? {}
        : {
            deliveryStatusLogging: [
              {
                protocol: 'lambda',
                successFeedbackRoleArn: feedbackRole.roleArn,
                successFeedbackSampleRate: '25',
                failureFeedbackRoleArn: feedbackRole.roleArn,
              },
              // issue #1529: `http/s` is the canonical CFn / CDK L2 spelling
              // (`sns.LoggingProtocol.HTTP`) of the HTTP-family protocol, and
              // it maps to the `HTTP` attribute prefix — the only HTTP-family
              // prefix AWS accepts. Pre-fix, cdkd THREW
              // `unsupported DeliveryStatusLogging protocol "http/s"` on this
              // exact block, and the `https` spelling it did accept produced
              // `HTTPS*` attribute names SetTopicAttributes rejects. The
              // fixture had only the Lambda protocol, so neither reached AWS.
              {
                protocol: 'http/s',
                successFeedbackRoleArn: feedbackRole.roleArn,
                successFeedbackSampleRate: '35',
                failureFeedbackRoleArn: feedbackRole.roleArn,
              },
            ],
          }),
    });

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

    // go-to-k/cdkd#4610: one TopicPolicy naming TWO topics, which the
    // CDKD_TEST_REMOVAL redeploy narrows to the first. The topics are created
    // OUTSIDE the stack by verify.sh (CDKD_TEST_POLICY_TOPICS=true), so their
    // policy can still be read after the destroy: the narrowed-away topic and,
    // on destroy, both must be back on SNS's default policy. Gated so a manual
    // deploy without those topics still works.
    if (process.env.CDKD_TEST_POLICY_TOPICS === 'true') {
      const policyTopics = ['cdkd-sns-sqs-test-policy-a', 'cdkd-sns-sqs-test-policy-b'].map(
        (name, i) =>
          sns.Topic.fromTopicArn(
            this,
            `PolicyTopic${i}`,
            this.formatArn({ service: 'sns', resource: name })
          )
      );
      const named = removal ? policyTopics.slice(0, 1) : policyTopics;
      new sns.TopicPolicy(this, 'MultiTopicPolicy', {
        topics: named,
        policyDocument: new iam.PolicyDocument({
          statements: [
            // `Resource: '*'`, the shape of CloudFormation's own TopicPolicy
            // example (User Guide, "Declaring an Amazon SNS topic policy").
            // SNS rejects a statement listing several topic ARNs ("Policy
            // statement must apply to a single resource"), and the same
            // document is written to every topic in Topics.
            new iam.PolicyStatement({
              sid: 'CdkdIssue4610',
              // The removal phase also changes the document, so verify.sh can
              // see that the update re-wrote the KEPT topic.
              actions: removal ? ['sns:Publish', 'sns:GetTopicAttributes'] : ['sns:Publish'],
              principals: [new iam.ServicePrincipal('events.amazonaws.com')],
              resources: ['*'],
            }),
          ],
        }),
      });
    }

    // go-to-k/cdkd#4612: a TopicPolicy over two more out-of-stack topics and
    // one that does not exist, deployed with --no-rollback: it writes the two,
    // then fails, and is journaled under them. verify.sh then checks that the
    // rollback resets only the topic still carrying its document.
    if (process.env.CDKD_TEST_FAILING_TOPIC_POLICY === 'true') {
      const topicArn = (name: string): string => this.formatArn({ service: 'sns', resource: name });
      new sns.CfnTopicPolicy(this, 'FailingTopicPolicy', {
        topics: [
          topicArn('cdkd-sns-sqs-test-orphan-c'),
          topicArn('cdkd-sns-sqs-test-orphan-d'),
          // No such topic: SetTopicAttributes fails after C and D were written.
          topicArn('cdkd-sns-sqs-test-orphan-missing'),
        ],
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'CdkdIssue4612',
              Effect: 'Allow',
              Principal: { Service: 'events.amazonaws.com' },
              Action: 'sns:Publish',
              Resource: '*',
            },
          ],
        },
      });
    }

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
