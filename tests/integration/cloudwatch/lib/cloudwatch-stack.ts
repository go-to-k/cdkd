import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * CloudWatch example stack
 *
 * Demonstrates:
 * - CloudWatch Log Group with retention period
 * - Metric Filter on the log group
 * - CloudWatch Alarm based on a custom metric
 * - SNS Topic for alarm notifications
 * - Alarm action to notify the SNS topic
 * - CfnOutputs for LogGroup name, Alarm ARN, Topic ARN
 */
export class CloudWatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create SNS Topic for alarm notifications
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'CloudWatch Alarm Notifications',
    });

    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/cdkd/cloudwatch-example/${this.stackName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Metric Filter to count error log entries
    const metricFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('ERROR'),
      metricNamespace: 'CdkdCloudWatchExample',
      metricName: 'ErrorCount',
      metricValue: '1',
      defaultValue: 0,
    });

    // Create CloudWatch Alarm based on the error count metric.
    // Exercises the backfilled AWS::CloudWatch::Alarm properties (issue #609):
    //   - extendedStatistic ('p99') -> ExtendedStatistic
    //   - evaluateLowSampleCountPercentile -> EvaluateLowSampleCountPercentile
    //   - Tags (via cdk.Tags.of below)
    // ThresholdMetricId is intentionally NOT exercised here (it is an
    // anomaly-detection-only field requiring a metric-math band; left in
    // silentDrop is out of scope for this fixture).
    const alarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmDescription: 'Alarm when error count exceeds threshold',
      metric: metricFilter.metric({
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      evaluateLowSampleCountPercentile: 'ignore',
    });

    // Tag the alarm to exercise the Tags backfill (PutMetricAlarm Tags on
    // create + TagResource/UntagResource diff on update).
    cdk.Tags.of(alarm).add('Team', 'Platform');

    // go-to-k/cdkd#2762: WarmUpConfiguration / ActionConfiguration (and, with
    // go-to-k/cdkd#5524, EvaluationWindow) ride
    // PutMetricAlarm. Set through addPropertyOverride: the L1 of the pinned
    // aws-cdk-lib does not carry ActionConfiguration. verify.sh reads both back
    // from DescribeAlarms. CDKD_TEST_UPDATE=true is its second phase: a
    // changed warm-up and a REMOVED ActionConfiguration, which PutMetricAlarm
    // (a full replace) must clear on AWS.
    const updatePhase = process.env['CDKD_TEST_UPDATE'] === 'true';
    const cfnAlarm = alarm.node.defaultChild as cloudwatch.CfnAlarm;
    cfnAlarm.addPropertyOverride('WarmUpConfiguration', {
      WarmUpPeriodDurationInMinutes: updatePhase ? 30 : 15,
      OnlyStartEvaluatingAfterWarmUpPeriodEnds: !updatePhase,
    });
    if (!updatePhase) {
      cfnAlarm.addPropertyOverride('ActionConfiguration', {
        AlarmTagsPropagation: { Enabled: true, IncludedTagKeys: ['Team'] },
      });
      // go-to-k/cdkd#5524: a wall-clock window (the alarm's 5-minute period
      // is one AWS allows for it). The update phase REMOVES it, which
      // PutMetricAlarm stores as the default sliding window.
      cfnAlarm.addPropertyOverride('EvaluationWindow', { WallClockWindow: { Timezone: 'UTC' } });
    }

    // go-to-k/cdkd#5524: a PromQL alarm -- EvaluationCriteria + EvaluationInterval
    // and none of the metric members, which PutMetricAlarm refuses beside
    // them. A raw CfnResource, so no L1 prop requirement adds a metric member.
    // CDKD_TEST_PROMQL=true adds it (verify.sh phase 3); its interval comes
    // from CDKD_TEST_PROMQL_INTERVAL so phase 4 is a real in-place change.
    if (process.env['CDKD_TEST_PROMQL'] === 'true') {
      new cdk.CfnResource(this, 'PromQLAlarm', {
        type: 'AWS::CloudWatch::Alarm',
        properties: {
          AlarmName: `${this.stackName}-promql`,
          AlarmDescription: 'cdkd integ: PromQL alarm (go-to-k/cdkd#5524)',
          EvaluationCriteria: {
            PromQLCriteria: { Query: 'avg(rate(http_requests_total[5m])) > 100' },
          },
          EvaluationInterval: Number(process.env['CDKD_TEST_PROMQL_INTERVAL'] ?? '60'),
        },
      });
    }

    // Add SNS action to alarm
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // Explicit LogStream
    new logs.CfnLogStream(this, 'TestLogStream', {
      logGroupName: logGroup.logGroupName,
      logStreamName: `${this.stackName}-test-stream`,
    });

    // Outputs
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group name',
    });

    new cdk.CfnOutput(this, 'AlarmArn', {
      value: alarm.alarmArn,
      description: 'CloudWatch Alarm ARN',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS Topic ARN',
    });
  }
}
