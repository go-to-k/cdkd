import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * EventBridge example stack
 *
 * Demonstrates:
 * - Custom EventBridge event bus creation
 * - EventBridge rule with event pattern on custom bus
 * - Lambda function as rule target (inline code)
 * - IAM permissions for EventBridge to invoke Lambda
 * - EventBridge Scheduler Schedule (AWS::Scheduler::Schedule)
 * - EventBridge Pipe: SQS → Lambda (AWS::Pipes::Pipe)
 * - Fn::GetAtt for outputs
 * - Resource dependencies (Rule depends on Bus and Lambda)
 */
export class EventBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create custom EventBridge event bus
    const bus = new events.EventBus(this, 'CustomBus', {
      eventBusName: `cdkd-test-bus-${cdk.Aws.ACCOUNT_ID}`,
    });

    // Create Lambda function with inline code as the rule target
    const fn = new lambda.Function(this, 'ScheduledHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json

def handler(event, context):
    print("Received scheduled event:")
    print(json.dumps(event))
    return {
        "statusCode": 200,
        "body": json.dumps({"message": "Scheduled event processed"})
    }
`),
      timeout: cdk.Duration.seconds(30),
      environment: {
        EVENT_BUS_NAME: bus.eventBusName,
      },
    });

    // Create EventBridge rule on the custom bus with an event pattern
    const rule = new events.Rule(this, 'EventRule', {
      eventBus: bus,
      eventPattern: {
        source: ['cdkd.test'],
        detailType: ['TestEvent'],
      },
      description: 'Routes cdkd test events to Lambda',
    });

    // Add Lambda function as the rule target
    // This automatically creates the necessary Lambda invoke permission
    rule.addTarget(new targets.LambdaFunction(fn));

    // EventBridge Scheduler: runs every hour (disabled to avoid costs)
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    fn.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, 'HourlySchedule', {
      name: `${this.stackName}-hourly`,
      scheduleExpression: 'rate(1 hour)',
      state: 'DISABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    // EventBridge Pipes: SQS → Lambda
    const pipeSource = new sqs.Queue(this, 'PipeSourceQueue', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pipeRole = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    pipeSource.grantConsumeMessages(pipeRole);
    fn.grantInvoke(pipeRole);

    new pipes.CfnPipe(this, 'SqsToLambdaPipe', {
      name: `${this.stackName}-sqs-to-lambda`,
      source: pipeSource.queueArn,
      target: fn.functionArn,
      roleArn: pipeRole.roleArn,
      desiredState: 'STOPPED',
    });

    // Outputs
    new cdk.CfnOutput(this, 'EventBusName', {
      value: bus.eventBusName,
      description: 'Custom EventBridge bus name',
    });

    new cdk.CfnOutput(this, 'RuleArn', {
      value: rule.ruleArn,
      description: 'EventBridge rule ARN',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: schedulerRole.roleArn,
      description: 'EventBridge Scheduler role ARN',
    });

    new cdk.CfnOutput(this, 'PipeSourceQueueUrl', {
      value: pipeSource.queueUrl,
      description: 'Pipe source SQS queue URL',
    });
  }
}
