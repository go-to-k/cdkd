import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';

// cdkd Step Functions Express + LoggingConfiguration / TracingConfiguration
// integ probe.
//
// CREATE exercises the states.amazonaws.com assume-role IAM-propagation race:
// cdkd's fast SDK path issues CreateStateMachine ~1s after the state machine
// role's CREATE, before IAM finishes propagating the trust policy, so AWS
// rejects it with "Neither the global service principal states.amazonaws.com,
// nor the regional one is authorized to assume the provided role." The fix
// classifies that phrasing as retryable in
// src/deployment/retryable-errors.ts; this fixture proves a canonical Express
// state machine with logging (StateMachine + fresh Role + DefaultPolicy +
// LogGroup) deploys cleanly.
//
// Phase 1 (base): LoggingConfiguration level ALL + TracingConfiguration
//   enabled. CDK's L2 attaches both the CloudWatch Logs and X-Ray statements
//   to the role's default policy for logging + tracing.
// Phase 2 (CDKD_TEST_UPDATE=true): BOTH logging AND tracing are REMOVED from
//   the template (the state-machine definition is unchanged). This is the
//   issue #978 removal-clear probe: UpdateStateMachine is patch-style, so a
//   removed config would be silently kept unless cdkd sends the explicit
//   disable sentinel. Removing logs + tracing also naturally shrinks the
//   role's default policy in the same deploy, so the fixture covers that too.
export class StepfunctionsLoggingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 2: remove both logging + tracing.
    const removeConfigs = process.env.CDKD_TEST_UPDATE === 'true';

    const logGroup = new logs.LogGroup(this, 'SfnLogGroup', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sm = new sfn.StateMachine(this, 'Express', {
      stateMachineType: sfn.StateMachineType.EXPRESS,
      definitionBody: sfn.DefinitionBody.fromChainable(
        new sfn.Pass(this, 'PassIt', { result: sfn.Result.fromString('done') })
      ),
      // Phase 1 configures logging + tracing; Phase 2 drops both.
      tracingEnabled: removeConfigs ? undefined : true,
      logs: removeConfigs
        ? undefined
        : {
            destination: logGroup,
            level: sfn.LogLevel.ALL,
            includeExecutionData: true,
          },
    });

    new cdk.CfnOutput(this, 'StateMachineArn', { value: sm.stateMachineArn });
  }
}
