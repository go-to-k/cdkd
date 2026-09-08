import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

// cdkd Step Functions Express + LoggingConfiguration / TracingConfiguration
// integ probe.
//
// CREATE can hit TWO different IAM-propagation races, and which one you get
// depends on the AGE GAP between the role's trust policy and its log-delivery
// grants:
//
//   1. the states.amazonaws.com assume-role race, rejected with "Neither the
//      global service principal states.amazonaws.com, nor the regional one is
//      authorized to assume the provided role."; and
//   2. the log-destination race (issue #2783) — LoggingConfiguration makes the
//      create validate that the role can reach the destination, and the
//      logs:CreateLogDelivery / PutResourcePolicy / ... grants have not
//      propagated yet, so AWS rejects it with "The state machine IAM Role is
//      not authorized to access the Log Destination".
//
// Both phrasings are classified retryable on the dense IAM-propagation cadence
// in src/deployment/retryable-errors.ts.
//
// **Window 1 MASKS window 2, which is why #2783 went unnoticed for so long**:
// SFN checks assume-role FIRST, so against a role and policy created together
// the trust policy and the grants propagate together, window 1 absorbs the
// whole wait, and window 2 never appears. Measured us-east-1 2026-09-08 — a
// fresh role failed the assume-role check six times over ~10s and then
// succeeded outright, never reaching the log-destination check.
//
// So a single-deploy fixture CANNOT exercise window 2, and asserting on it
// "when it happens" would be a test that passes identically with the fix
// reverted. STAGE 0 is what makes it deterministic: it deploys the LogGroup
// and the execution Role ALONE and lets the trust policy settle, so the next
// deploy creates the DefaultPolicy grants ~1s before CreateStateMachine and
// window 2 is the only race left open. Measured over two runs of this shape:
// 10 and 6 consecutive log-destination rejections WITHIN one deploy (the dense
// grid's 0.25s / 0.5s / 1s / 2s-capped attempts), then the create succeeded —
// and ZERO assume-role rejections in either, which is what confirms stage 0
// closes window 1. The count varies with IAM; that it is non-zero does not,
// which is why Phase 1a asserts presence rather than a number.
//
// Stage 0 (CDKD_TEST_STAGE=role-only): LogGroup + Role only — no state
//   machine, so no log-delivery grants exist yet.
// Phase 1 (base): LoggingConfiguration level ALL + TracingConfiguration
//   enabled, bound to the Role from stage 0. CDK's L2 attaches both the
//   CloudWatch Logs and X-Ray statements to that role's default policy.
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
    // Stage 0: role + log group only, so the trust policy can settle before
    // the log-delivery grants are written. NOT a mode-gated DROP — every later
    // stage is a superset, so nothing is ever removed by omitting this token.
    const roleOnly = process.env.CDKD_TEST_STAGE === 'role-only';

    const logGroup = new logs.LogGroup(this, 'SfnLogGroup', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Declared explicitly (rather than letting the StateMachine L2 mint one)
    // so stage 0 can create it on its own and let it settle.
    const role = new iam.Role(this, 'ExpressRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    if (roleOnly) {
      new cdk.CfnOutput(this, 'ExecutionRoleArn', { value: role.roleArn });
      return;
    }

    const sm = new sfn.StateMachine(this, 'Express', {
      role,
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

    new cdk.CfnOutput(this, 'ExecutionRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: sm.stateMachineArn });
  }
}
