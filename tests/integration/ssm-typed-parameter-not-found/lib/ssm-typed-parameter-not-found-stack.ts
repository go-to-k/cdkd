import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/** The Parameter Store path verify.sh deletes, then creates. */
export const PARAMETER_PATH = '/cdkd-integ-6380/topic-display-name';

/**
 * go-to-k/cdkd#6380: a topic whose display name is read through
 * `valueForStringParameter`, which synthesizes an
 * `AWS::SSM::Parameter::Value<String>` template parameter defaulting to the
 * path. With the path absent, SSM answers a message-less `ParameterNotFound`,
 * and cdkd's deploy used to fail as `UnknownError` without naming the path.
 *
 * covers: AWS::SNS::Topic
 */
export class SsmTypedParameterNotFoundStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const topic = new sns.Topic(this, 'Topic', {
      displayName: ssm.StringParameter.valueForStringParameter(this, PARAMETER_PATH),
    });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
