import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';

/**
 * EventBridge Scheduler (`AWS::Scheduler::Schedule` -> Lambda). Not in cdkd's
 * SDK provider set, so it routes through Cloud Control. `FlexibleTimeWindow` is
 * a required nested prop and `Target` carries a role-arn intrinsic. Confirmed
 * CLEAN by a /hunt-bugs sweep; this fixture is the regression guard.
 */
export class EventbridgeSchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>({ok:true});'),
    });
    const role = new iam.Role(this, 'SchedRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    fn.grantInvoke(role);

    new scheduler.CfnSchedule(this, 'Schedule', {
      name: `${this.stackName}-sched`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'rate(1 hour)',
      target: { arn: fn.functionArn, roleArn: role.roleArn },
    });
  }
}
