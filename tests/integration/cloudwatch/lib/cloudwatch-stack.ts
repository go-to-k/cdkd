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

    // Create CloudWatch Alarm based on the error count metric
    const alarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmDescription: 'Alarm when error count exceeds threshold',
      metric: metricFilter.metric({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS action to alarm
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

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
