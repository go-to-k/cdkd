import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Twenty resources whose SDK create would take over an existing resource of
 * the same generated name, so a NEW first deploy looks every name up before
 * its creates (go-to-k/cdkd#4705, check C): 4 queues, 4 topics, 4 log groups,
 * 3 EventBridge rules, 2 alarms, 2 target groups and 1 ECS cluster -- seven
 * lookups, one per type, all started before the first create. No name is
 * declared, so every name is generated from the per-run stack name.
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::SNS::Topic
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Events::Rule
 * covers: AWS::CloudWatch::Alarm
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 * covers: AWS::ECS::Cluster
 */
export class AdoptingMixStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const queues: sqs.Queue[] = [];
    for (let i = 1; i <= 4; i++) {
      queues.push(new sqs.Queue(this, `Queue${i}`, { removalPolicy: cdk.RemovalPolicy.DESTROY }));
      new sns.Topic(this, `Topic${i}`);
      new logs.LogGroup(this, `Logs${i}`, {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_DAY,
      });
    }
    for (let i = 1; i <= 3; i++) {
      new events.Rule(this, `Rule${i}`, { eventPattern: { source: [`cdkd.perf.${i}`] } });
    }
    for (let i = 1; i <= 2; i++) {
      new cloudwatch.Alarm(this, `Alarm${i}`, {
        metric: queues[i - 1]!.metricApproximateNumberOfMessagesVisible(),
        threshold: 1000,
        evaluationPeriods: 1,
      });
      new elbv2.ApplicationTargetGroup(this, `Targets${i}`, { targetType: elbv2.TargetType.LAMBDA });
    }
    new ecs.CfnCluster(this, 'Cluster');
  }
}

/**
 * Many CloudWatch resources in one stack: PERF_ALARMS alarms (default 200),
 * PERF_LOG_GROUPS log groups (default 50), 3 queues and 3 topics. A NEW first
 * deploy looks the alarm names up 100 per DescribeAlarms call and the log
 * groups 50 per DescribeLogGroups call, all in parallel before the first create
 * (go-to-k/cdkd#4705, check C).
 *
 * covers: AWS::CloudWatch::Alarm
 * covers: AWS::Logs::LogGroup
 * covers: AWS::SQS::Queue
 * covers: AWS::SNS::Topic
 */
export class CloudWatchHeavyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const alarms = Number(process.env.PERF_ALARMS ?? '200');
    const logGroups = Number(process.env.PERF_LOG_GROUPS ?? '50');
    const queues: sqs.Queue[] = [];
    for (let i = 1; i <= 3; i++) {
      queues.push(new sqs.Queue(this, `Queue${i}`, { removalPolicy: cdk.RemovalPolicy.DESTROY }));
      new sns.Topic(this, `Topic${i}`);
    }
    for (let i = 1; i <= alarms; i++) {
      new cloudwatch.Alarm(this, `Alarm${i}`, {
        metric: queues[i % 3]!.metricApproximateNumberOfMessagesVisible(),
        threshold: 1000 + i,
        evaluationPeriods: 1,
      });
    }
    for (let i = 1; i <= logGroups; i++) {
      new logs.LogGroup(this, `Logs${i}`, {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_DAY,
      });
    }
  }
}
