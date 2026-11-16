import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';

// cdkd nested-stack cleanup phase: a nested child's replaced resources are
// deleted only after the WHOLE stack tree's deploy succeeded (issue #6398),
// as CloudFormation runs every nested stack's cleanup at the end of the root
// stack's update.
//
// Child A owns a schedule group; child B owns a schedule in it, the group's
// name reaching B as a parameter the parent passes from A's output.
//
// Base: group `cdkd-ncar-g1`.
// CDKD_TEST_UPDATE=true: rename the group to `cdkd-ncar-g2`. That replaces
//   the group in A (create-first) and moves B's schedule (a replacement under
//   --replace).
// CDKD_TEST_FAIL=true: the parent also adds a queue AWS refuses
//   (`MessageRetentionPeriod` out of range), created after both children.
//
// Deleting a schedule group deletes every schedule in it. Before the fix
// child A deleted g1 when A itself finished, inside the parent's deploy and
// before B moved its schedule: a parent that then failed rolled back onto an
// old group whose schedule was gone.
class GroupStack extends cdk.NestedStack {
  readonly group: scheduler.ScheduleGroup;

  constructor(scope: Construct, id: string, update: boolean) {
    super(scope, id);
    this.group = new scheduler.ScheduleGroup(this, 'Group', {
      scheduleGroupName: update ? 'cdkd-ncar-g2' : 'cdkd-ncar-g1',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}

class ScheduleStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, group: scheduler.IScheduleGroup) {
    super(scope, id);
    const queue = new sqs.Queue(this, 'Target', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    new scheduler.Schedule(this, 'Schedule', {
      scheduleName: 'cdkd-ncar-schedule',
      scheduleGroup: group,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.hours(1)),
      target: new targets.SqsSendMessage(queue),
    });
  }
}

export class NestedCleanupAtRootStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const fail = process.env.CDKD_TEST_FAIL === 'true';

    const groups = new GroupStack(this, 'ChildA', update);
    const schedules = new ScheduleStack(this, 'ChildB', groups.group);

    if (fail) {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        // Out of range (max 1209600): AWS refuses the create.
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(schedules);
    }
  }
}
