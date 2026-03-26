import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * EventBridge example stack
 *
 * Demonstrates:
 * - Custom EventBridge event bus creation
 * - EventBridge rule with schedule expression (rate)
 * - Lambda function as rule target (inline code)
 * - IAM permissions for EventBridge to invoke Lambda
 * - Fn::GetAtt for outputs
 * - Resource dependencies (Rule depends on Bus and Lambda)
 */
export class EventBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create custom EventBridge event bus
    const bus = new events.EventBus(this, 'CustomBus', {
      eventBusName: `cdkq-test-bus-${cdk.Aws.ACCOUNT_ID}`,
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

    // Create EventBridge rule on the custom bus with a schedule
    const rule = new events.Rule(this, 'ScheduledRule', {
      eventBus: bus,
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Triggers Lambda every hour for cdkq integration test',
    });

    // Add Lambda function as the rule target
    // This automatically creates the necessary Lambda invoke permission
    rule.addTarget(new targets.LambdaFunction(fn));

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
  }
}
