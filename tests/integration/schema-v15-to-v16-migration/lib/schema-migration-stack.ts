import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * State schema v15 -> v16 migration fixture (issue #6170).
 *
 * v16 records `StackState.stackIdFromInstance`: a stack FIRST deployed by a
 * v16 binary gets an `AWS::StackId` ending in a per-stack UUID, while any
 * EXISTING record keeps the tail `cdkd` forever, so a resource named from
 * `AWS::StackId` is never replaced on upgrade.
 *
 * The names take the bare tail segment (`Fn::Select 2` of `Fn::Split '/'`
 * over `AWS::StackId`); under v15 it resolves to `cdkd`. (The `-` group forms
 * fail under v15, so they are not used.)
 *
 * `CDKD_TEST_UPDATE=true` changes the parameter's value (`one` -> `two`), the
 * in-place edit the migration deploy applies.
 *
 * Resources: an SSM StringParameter and an SNS topic, both named from the
 * StackId tail. Output `StackIdOut` = `AWS::StackId`.
 */
export class SchemaV15ToV16MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const tail = cdk.Fn.select(2, cdk.Fn.split('/', cdk.Aws.STACK_ID));

    const param = new ssm.StringParameter(this, 'Param', {
      parameterName: `/cdkd-schema-v15-v16/${tail}`,
      stringValue: update ? 'two' : 'one',
      simpleName: false,
    });
    (param.node.defaultChild as ssm.CfnParameter).overrideLogicalId('Param');

    const topic = new sns.Topic(this, 'Topic', {
      topicName: `cdkd-schema-v15-v16-${tail}`,
    });
    (topic.node.defaultChild as sns.CfnTopic).overrideLogicalId('Topic');

    new cdk.CfnOutput(this, 'StackIdOut', { value: cdk.Aws.STACK_ID });
  }
}
