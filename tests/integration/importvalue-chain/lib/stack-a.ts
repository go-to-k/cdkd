import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * Stack A — the head of the chain (pure producer).
 *
 * Creates a cheap SNS Topic and exports its ARN via the canonical
 * CloudFormation `Output.Export.Name` pattern (`ChainTopicArn`). Stack B
 * imports this value via `cdk.Fn.importValue('ChainTopicArn')`.
 *
 * SNS + SSM are deliberately the only resource types in this fixture — no
 * VPC, no NAT, no Lambda — so deploy/destroy is fast and cheap while still
 * exercising the full `Fn::ImportValue` chain + exports-index + strong-ref
 * machinery, which is type-agnostic.
 */
export class StackA extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'ChainTopic', {
      displayName: 'cdkd-importvalue-chain head topic',
    });

    new cdk.CfnOutput(this, 'ChainTopicArnOutput', {
      value: topic.topicArn,
      exportName: 'ChainTopicArn',
      description:
        'Exported by Stack A; imported by Stack B via Fn::ImportValue. ' +
        'The head of the A -> B -> C import chain.',
    });
  }
}
