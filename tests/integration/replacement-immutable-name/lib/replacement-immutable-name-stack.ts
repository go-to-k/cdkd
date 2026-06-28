import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

/**
 * Immutable-Name replacement coverage across six resource types.
 *
 * Each resource's NAME is immutable in CloudFormation ("Update requires:
 * Replacement"). cdkd previously had no replacement rule for these types, so a
 * rename was attempted as an in-place update and silently diverged cdkd state
 * from AWS (the rename was dropped; for Events Rule / CloudWatch Alarm a second
 * resource was created and the old one orphaned). This fixture renames every
 * resource on UPDATE and asserts cdkd REPLACES (DELETE old + CREATE new).
 *
 *   covers: AWS::Kinesis::Stream, AWS::SecretsManager::Secret,
 *           AWS::StepFunctions::StateMachine, AWS::Events::Rule,
 *           AWS::SSM::Parameter, AWS::CloudWatch::Alarm
 *
 * removalPolicy DESTROY (-> UpdateReplacePolicy: Delete) where applicable so the
 * OLD resource is deleted on replacement instead of CDK's default Retain.
 */
export class ReplacementImmutableNameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const suffix = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1';

    const stream = new kinesis.Stream(this, 'Stream', {
      streamName: `${this.stackName}-stream-${suffix}`,
      shardCount: 1,
      streamMode: kinesis.StreamMode.PROVISIONED,
    });
    stream.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new secrets.Secret(this, 'Secret', {
      secretName: `${this.stackName}-secret-${suffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new sfn.StateMachine(this, 'SM', {
      stateMachineName: `${this.stackName}-sm-${suffix}`,
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(this, 'Pass')),
    });

    new events.Rule(this, 'Rule', {
      ruleName: `${this.stackName}-rule-${suffix}`,
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });

    new ssm.StringParameter(this, 'Param', {
      parameterName: `/${this.stackName}/param-${suffix}`,
      stringValue: 'hello',
    });

    new cw.Alarm(this, 'Alarm', {
      alarmName: `${this.stackName}-alarm-${suffix}`,
      metric: new cw.Metric({
        namespace: 'AWS/SQS',
        metricName: 'NumberOfMessagesSent',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    new cdk.CfnOutput(this, 'StreamName', { value: stream.streamName });
  }
}
