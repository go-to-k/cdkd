import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';

/**
 * Regression guard for issue #961: a schedule in a CUSTOM ScheduleGroup is
 * unaddressable via Cloud Control (the handlers resolve a bare Name against
 * the default group), so before the SDK provider every post-create operation
 * broke — UPDATE failed NotFound, and a schedule-only removal silently
 * orphaned the LIVE schedule (the delete's NotFound was swallowed as
 * idempotent success). The SDK provider threads GroupName from the resource
 * properties.
 *
 * Phase envs (per-phase, set by verify.sh):
 * - CDKD_TEST_UPDATE=true    -> schedule expression rate(1 hour) -> rate(2 hours)
 * - CDKD_TEST_REMOVE_SCHED=true -> the schedule is REMOVED from the template
 *   while the group stays (the exact silent-orphan shape from the issue).
 */
export class SchedulerCustomGroupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const targetQ = new sqs.Queue(this, 'TargetQ', { queueName: `${this.stackName}-tgt` });
    const dlq = new sqs.Queue(this, 'Dlq', { queueName: `${this.stackName}-dlq` });

    const role = new iam.Role(this, 'SchedRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    targetQ.grantSendMessages(role);
    dlq.grantSendMessages(role);

    const group = new scheduler.CfnScheduleGroup(this, 'Group', {
      name: `${this.stackName}-grp`,
    });

    if (process.env.CDKD_TEST_REMOVE_SCHED !== 'true') {
      const expr = process.env.CDKD_TEST_UPDATE === 'true' ? 'rate(2 hours)' : 'rate(1 hour)';
      new scheduler.CfnSchedule(this, 'Sched', {
        name: `${this.stackName}-sched`,
        groupName: group.ref,
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: expr,
        target: {
          arn: targetQ.queueArn,
          roleArn: role.roleArn,
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
          deadLetterConfig: { arn: dlq.queueArn },
        },
      });
    }
  }
}
