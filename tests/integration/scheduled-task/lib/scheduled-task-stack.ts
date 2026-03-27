import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

/**
 * Scheduled task pattern stack
 *
 * Demonstrates:
 * - EventBridge Rule with schedule expression (rate(1 hour))
 * - Lambda Function (inline Python, logs "scheduled run")
 * - EventBridge Rule targets the Lambda
 * - CloudWatch LogGroup for Lambda with 1 week retention
 * - SNS Topic for error notifications
 * - CloudWatch Alarm on Lambda errors -> SNS action
 * - CfnOutputs for rule name, function name, topic ARN
 *
 * Tests EventBridge Rule + Lambda + CloudWatch + SNS integration.
 */
export class ScheduledTaskStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SNS Topic for error notifications
    const errorTopic = new sns.Topic(this, 'ErrorNotificationTopic', {
      displayName: 'Scheduled Task Error Notifications',
    });

    // Lambda Function with inline Python code
    const fn = new lambda.Function(this, 'ScheduledFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    logger.info("scheduled run")
    logger.info(json.dumps(event))
    return {
        "statusCode": 200,
        "body": json.dumps({"message": "scheduled run completed"})
    }
`),
      timeout: cdk.Duration.seconds(30),
    });

    // CloudWatch LogGroup for Lambda with 1 week retention
    const logGroup = new logs.LogGroup(this, 'ScheduledFunctionLogGroup', {
      logGroupName: `/aws/lambda/${fn.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // EventBridge Rule with schedule expression
    const rule = new events.Rule(this, 'ScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Triggers the scheduled Lambda function every hour',
    });

    // Add Lambda function as the rule target
    rule.addTarget(new targets.LambdaFunction(fn));

    // CloudWatch Alarm on Lambda errors -> SNS action
    const errorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmDescription: 'Alarm when scheduled Lambda function has errors',
      metric: fn.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS action to alarm
    errorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(errorTopic));

    // Outputs
    new cdk.CfnOutput(this, 'RuleName', {
      value: rule.ruleName,
      description: 'EventBridge schedule rule name',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Scheduled Lambda function name',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: errorTopic.topicArn,
      description: 'Error notification SNS topic ARN',
    });
  }
}
