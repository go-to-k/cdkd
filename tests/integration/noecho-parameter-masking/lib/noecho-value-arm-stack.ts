import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#4831, the two-binary arm: a stack of its own, deployed first
 * by the release before #4830 (0.297.0) and then, unchanged, by this binary.
 *
 * `NoEchoValueArmName` is declared `NoEcho` in the STRING form (`"true"`).
 * `NoEchoValueArmTopic` reads it by position in `DisplayName` (which 0.297.0
 * already stored as `***`, marking the record) and holds the same value as a
 * LITERAL `TopicName`, which no template position reads: 0.297.0 stored that
 * copy in plaintext. This binary must not replace the topic, and must store
 * that copy as `***` named in `noEchoLeaves`.
 *
 * `NoEchoValueArmReader` reads the topic's ARN with `Fn::GetAtt` (security
 * review m1 on #4848): the topic is NAMED from the value, so the ARN carries
 * it. `CDKD_TEST_NOECHO_VALUE_ARM_EDIT=true` edits the reader, so a later
 * deploy re-resolves `NoEchoValueArmTopic.TopicArn` from state, which must
 * hold the ARN, not the mask (go-to-k/cdkd#4849).
 */
export class NoechoValueArmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const value = process.env['CDKD_TEST_NOECHO_VALUE_ARM_NAME'] ?? 'cdkd-noecho-value-arm-unset';
    const name = new cdk.CfnParameter(this, 'NoEchoValueArmName', {
      type: 'String',
      default: value,
    });
    // CDK emits only the boolean; the declaration is rewritten to the string.
    const declaration = name as unknown as { _toCloudFormation(): unknown };
    const synthesize = declaration._toCloudFormation.bind(name);
    declaration._toCloudFormation = () => {
      const out = synthesize() as { Parameters: Record<string, Record<string, unknown>> };
      for (const body of Object.values(out.Parameters)) body['NoEcho'] = 'true';
      return out;
    };
    const topic = new sns.CfnTopic(this, 'NoEchoValueArmTopic', {
      topicName: value,
      displayName: name.valueAsString,
    });
    new ssm.CfnParameter(this, 'NoEchoValueArmReader', {
      name: process.env['CDKD_TEST_NOECHO_VALUE_ARM_READER'] ?? '/cdkd-test/noecho-value-arm/unset',
      type: 'String',
      value: topic.attrTopicArn,
      description: process.env['CDKD_TEST_NOECHO_VALUE_ARM_EDIT'] === 'true' ? 'edited' : 'initial',
    });
  }
}
