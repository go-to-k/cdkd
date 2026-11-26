import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ fixture for issue #7079: `cdkd deploy --replace-resource <logicalId>`
 * plans the named resource's update as a replacement, as a template
 * create-only change is.
 *
 * L1 constructs at the stack root, so the logical ids are exactly the ones the
 * flag names. The topic has no name, so cdkd generates one and the replacement
 * takes the next name generation: a new topic, created first. With
 * `CDKD_TEST_PHASE=display` only its mutable `DisplayName` changes, which
 * updates in place without the flag. Its readers: an SSM parameter holding
 * its ARN (mutable `Value`, updated in place) and an SQS subscription to it
 * (create-only `TopicArn`, replaced onto the new topic).
 *
 * covers: AWS::SNS::Topic
 * covers: AWS::SNS::Subscription
 * covers: AWS::SQS::Queue
 * covers: AWS::SSM::Parameter
 */
export class ReplaceResourceFlagStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const display = process.env.CDKD_TEST_PHASE === 'display';

    const topic = new sns.CfnTopic(this, 'Topic', {
      displayName: display ? 'cdkd-integ-display-b' : 'cdkd-integ-display-a',
    });

    const queue = new sqs.CfnQueue(this, 'Queue', {});
    queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new sns.CfnSubscription(this, 'Sub', {
      topicArn: topic.ref,
      protocol: 'sqs',
      endpoint: queue.attrArn,
    });

    new ssm.CfnParameter(this, 'TopicArnParam', {
      name: `/cdkd-integ/${this.stackName}/topic-arn`,
      type: 'String',
      value: topic.ref,
    });
  }
}
