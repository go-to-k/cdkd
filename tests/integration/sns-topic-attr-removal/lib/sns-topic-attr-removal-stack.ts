import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/**
 * Issue #6226 — removing `TracingConfig`, `ContentBasedDeduplication` or
 * `ArchivePolicy` from an `AWS::SNS::Topic` used to fail the deploy: cdkd
 * reset the removed attribute to `''`, which SNS refuses for all three.
 * CloudFormation resets them to `PassThrough` / `false` / no archive policy.
 *
 * Every removed attribute is templated at its NON-default value in the
 * baseline, so the removal phase can tell "reset" from "never set". The
 * standard topic's `DisplayName` is the RETAINED sibling: it rides in the
 * same update and must survive.
 *
 * `CDKD_TEST_REMOVAL=true` drops the three attributes.
 */
export class SnsTopicAttrRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    const standard = new sns.Topic(this, 'StandardTopic', {
      displayName: 'cdkd-6226-kept',
      ...(removal ? {} : { tracingConfig: sns.TracingConfig.ACTIVE }),
    });

    const fifo = new sns.Topic(this, 'FifoTopic', {
      fifo: true,
      ...(removal ? {} : { contentBasedDeduplication: true, messageRetentionPeriodInDays: 7 }),
    });

    new cdk.CfnOutput(this, 'StandardTopicArn', { value: standard.topicArn });
    new cdk.CfnOutput(this, 'FifoTopicArn', { value: fifo.topicArn });
  }
}
