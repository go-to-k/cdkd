import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';

// cdkd ScheduleGroup rename: the replaced group is deleted only after the
// deploy succeeds (issue #6374).
//
// Base: a schedule group `cdkd-sgrr-g1` holding one schedule.
// CDKD_TEST_UPDATE=true: rename the group to `cdkd-sgrr-g2`. That replaces the
//   group, and the schedule's GroupName change is refused in place (it
//   addresses the schedule), so without --replace the deploy fails and rolls
//   back.
//
// Deleting a schedule group deletes every schedule in it. Before the fix the
// old group was deleted right after the new one was created, so the failed
// deploy's rollback re-created an EMPTY g1: the schedule was gone for good.
export class ScheduleGroupRenameRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const queue = new sqs.Queue(this, 'Queue', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    const group = new scheduler.ScheduleGroup(this, 'Group', {
      scheduleGroupName: update ? 'cdkd-sgrr-g2' : 'cdkd-sgrr-g1',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new scheduler.Schedule(this, 'Schedule', {
      scheduleName: 'cdkd-sgrr-schedule',
      scheduleGroup: group,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.hours(1)),
      target: new targets.SqsSendMessage(queue),
    });
  }
}
