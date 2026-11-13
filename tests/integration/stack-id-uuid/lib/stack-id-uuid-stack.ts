import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/**
 * Names built from `AWS::StackId` with the common CDK unique-suffix idiom
 * (go-to-k/cdkd#6170). CloudFormation's stack id ends in a per-stack UUID;
 * cdkd ended it in the constant `cdkd`, so the UUID-group form failed every
 * create with an out-of-bounds `Fn::Select` and the prefix form gave every
 * stack the same suffix. `CDKD_TEST_UPDATE=true` changes only the parameter's
 * VALUE: the names, and so the physical ids, must not change.
 */
export class StackIdUuidStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    // `<uuid>` from `arn:...:stack/<name>/<uuid>`, then its first and last groups.
    const uuid = cdk.Fn.select(2, cdk.Fn.split('/', cdk.Aws.STACK_ID));
    const firstGroup = cdk.Fn.select(0, cdk.Fn.split('-', uuid));
    const lastGroup = cdk.Fn.select(4, cdk.Fn.split('-', uuid));

    new ssm.StringParameter(this, 'Param', {
      parameterName: `/cdkd-stack-id-uuid/${lastGroup}`,
      simpleName: false,
      stringValue: update ? 'two' : 'one',
    });
    new sns.Topic(this, 'Topic', { topicName: `cdkd-stack-id-uuid-${firstGroup}` });

    new cdk.CfnOutput(this, 'StackIdOut', { value: cdk.Aws.STACK_ID });
  }
}
