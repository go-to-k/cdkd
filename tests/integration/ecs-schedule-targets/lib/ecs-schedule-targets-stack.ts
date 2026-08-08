import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';

/**
 * ECS Fargate task targets on `AWS::Events::Rule` and
 * `AWS::Scheduler::Schedule` (issues #1381 / #1382).
 *
 * Both providers forward the target blob to APIs whose ECS sub-shapes are
 * camelCase islands in otherwise-PascalCase SDK models
 * (`awsvpcConfiguration`, `PlacementStrategy`, `Tags`, item-level
 * `type`/`field`/`expression`/`capacityProvider`). Before the fix, the SDK
 * serializer dropped the CFn-spelled keys and BOTH creates failed with
 * "Parameter NetworkConfiguration must be specified ... when launch type is
 * FARGATE" — the canonical CDK "scheduled Fargate task" pattern was
 * undeployable. The rules/schedules here never actually fire (rate of 365
 * days); the assertions read the stored target config back.
 */
export class EcsScheduleTargetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'pub', subnetType: ec2.SubnetType.PUBLIC }],
      restrictDefaultSecurityGroup: false,
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskDef.addContainer('Main', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest'),
      command: ['sh', '-c', 'echo hello'],
    });

    // EventBridge Rule -> ECS Fargate task target: synthesizes
    // Targets[].EcsParameters.NetworkConfiguration.AwsVpcConfiguration + TagList.
    const rule = new events.Rule(this, 'Rule', {
      ruleName: `${this.stackName}-rule`,
      schedule: events.Schedule.rate(cdk.Duration.days(365)),
    });
    rule.addTarget(
      new eventsTargets.EcsTask({
        cluster,
        taskDefinition: taskDef,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        tags: [{ key: 'cdkd-integ', value: 'events-ecs-target' }],
      })
    );

    // Scheduler Schedule -> ECS Fargate run-task target: synthesizes
    // Target.EcsParameters.NetworkConfiguration.AwsvpcConfiguration
    // (note the CFn spelling differs from Events' AwsVpcConfiguration).
    new scheduler.Schedule(this, 'Sched', {
      scheduleName: `${this.stackName}-sched`,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.days(365)),
      target: new schedulerTargets.EcsRunFargateTask(cluster, {
        taskDefinition: taskDef,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
      }),
    });

    new cdk.CfnOutput(this, 'RuleName', { value: rule.ruleName });
    new cdk.CfnOutput(this, 'ScheduleName', { value: `${this.stackName}-sched` });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}
