import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * Monitoring pattern example stack
 *
 * Demonstrates:
 * - Lambda Function with inline Python code
 * - CloudWatch Dashboard with TextWidget and GraphWidget
 * - CloudWatch Alarm on Lambda errors
 * - CloudWatch Logs LogGroup with retention
 * - SNS Topic for alarm notifications
 * - Alarm action to send to SNS topic
 * - CfnOutputs for dashboard name, alarm name, log group name
 */
export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda Function with inline Python code
    const fn = new lambda.Function(this, 'MonitoredFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    print("Hello from monitored function")
    return {"statusCode": 200, "body": "OK"}
`),
      description: 'Monitored function for cdkd monitoring test',
    });

    // Tag all resources
    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'monitoring');

    // CloudWatch Logs LogGroup with retention
    const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/cdkd/monitoring-example/${this.stackName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SNS Topic for alarm notifications
    const topic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Monitoring Alarm Notifications',
    });

    // CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'cdkd-monitoring-test',
    });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Monitoring Test',
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [fn.metricInvocations()],
        width: 12,
      })
    );

    // CloudWatch Alarm on Lambda errors
    const alarm = fn.metricErrors().createAlarm(this, 'ErrorAlarm', {
      threshold: 1,
      evaluationPeriods: 1,
    });

    // Alarm action: send to SNS topic
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(topic));

    // Composite Alarm
    const compositeAlarm = new cloudwatch.CompositeAlarm(this, 'CompositeAlarm', {
      alarmRule: cloudwatch.AlarmRule.allOf(alarm),
    });

    // Outputs
    new cdk.CfnOutput(this, 'DashboardName', {
      value: dashboard.dashboardName,
      description: 'CloudWatch Dashboard name',
    });

    new cdk.CfnOutput(this, 'AlarmName', {
      value: alarm.alarmName,
      description: 'CloudWatch Alarm name',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group name',
    });

    new cdk.CfnOutput(this, 'CompositeAlarmName', {
      value: compositeAlarm.alarmName,
      description: 'CloudWatch Composite Alarm name',
    });
  }
}
