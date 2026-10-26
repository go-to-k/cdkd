import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * EventBridge example stack
 *
 * Demonstrates:
 * - Custom EventBridge event bus creation, with a customer managed KMS key and
 *   a DLQ, and the removal of its optional properties (CDKD_TEST_REMOVAL)
 * - EventBridge rule with event pattern on custom bus
 * - Lambda function as rule target (inline code)
 * - Lambda `Code.SourceKMSKeyArn` on create and UpdateFunctionCode (issue #5300)
 * - IAM permissions for EventBridge to invoke Lambda
 * - EventBridge Scheduler Schedule (AWS::Scheduler::Schedule)
 * - EventBridge Pipe: SQS → Lambda (AWS::Pipes::Pipe)
 * - Fn::GetAtt for outputs
 * - Resource dependencies (Rule depends on Bus and Lambda)
 */
export class EventBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // UPDATE phase: see the rule below (issue #955) and the bus Description
    // (issue #2613).
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    // REMOVAL phase (issue #1160): the bus template drops Description,
    // KmsKeyIdentifier, LogConfig and DeadLetterConfig. CloudFormation clears
    // each one, while UpdateEventBus keeps any field it is not given. The key
    // and the queue stay in the stack; the key policy loses the EventBridge
    // grant CDK adds for a bus using the key, as in a user's app.
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

    const busKey = new kms.Key(this, 'BusKey', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
    const busDlq = new sqs.Queue(this, 'BusDlq');

    // Create custom EventBridge event bus
    // logConfig exercises the #609 LogConfig backfill — rides on
    // CreateEventBus/UpdateEventBus directly, NO separate control-plane
    // API. Default is no LogConfig at all; setting Level + IncludeDetail
    // gives unambiguous readback via `aws events describe-event-bus`.
    const bus = new events.EventBus(this, 'CustomBus', {
      eventBusName: `cdkd-test-bus-${cdk.Aws.ACCOUNT_ID}`,
      ...(isRemoval
        ? {}
        : {
            logConfig: {
              level: events.Level.INFO,
              includeDetail: events.IncludeDetail.FULL,
            },
            // Issue #2613: a changed Description is an in-place UpdateEventBus, so
            // the UPDATE phase reaches the bus provider's update() and its
            // recorded-region guard, not only the rule delete.
            description: isUpdate ? 'cdkd test bus (updated)' : 'cdkd test bus',
            kmsKey: busKey,
            deadLetterQueue: busDlq,
          }),
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

    // Issue #5300: `Code.SourceKMSKeyArn` was never sent, so the package was
    // encrypted with the AWS owned key instead. The UPDATE phase changes the
    // code, so UpdateFunctionCode must carry the key too. The REMOVAL phase
    // drops the key along with another code change: Lambda, and so
    // CloudFormation, keeps the key on an UpdateFunctionCode that names none,
    // and cdkd must leave it the same way.
    const sourceKeyFn = new lambda.Function(this, 'SourceKeyHandler', {
      functionName: `cdkd-test-source-key-fn-${cdk.Aws.ACCOUNT_ID}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `def handler(event, context):\n    return "${isRemoval ? 'v3' : isUpdate ? 'v2' : 'v1'}"\n`
      ),
    });
    // Lambda refuses a SourceKMSKeyArn key whose policy does not let the
    // Lambda service principal use it (measured: AccessDeniedException "The
    // key policy must allow Lambda to perform 'kms:GenerateDataKey' and
    // 'kms:Decrypt' operations"; CloudFormation fails the same way).
    busKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
      })
    );
    if (!isRemoval) {
      (sourceKeyFn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
        'Code.SourceKMSKeyArn',
        busKey.keyArn
      );
    }

    // UPDATE phase (issue #955): drop the rule while KEEPING the bus, so the
    // re-deploy exercises the standalone diff-driven delete of a custom-bus
    // rule — the path that silently no-oped against the default bus and
    // orphaned the rule before the fix.

    if (!isUpdate) {
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

      // Regression coverage for the Ref-returns-ARN bug (/hunt-bugs 2026-07-02):
      // CFn `Ref` on AWS::Events::Rule returns the rule NAME — `<bus>|<name>`
      // for a custom-bus rule — never the ARN. `rule.ruleName` synthesizes to
      // `{Ref: <Rule>}`, so storing it in a real resource asserts the resolved
      // value end-to-end (verify.sh compares it against AWS's actual rule name).
      new ssm.StringParameter(this, 'RuleRefParam', {
        parameterName: `/${this.stackName}/rule-ref`,
        stringValue: rule.ruleName,
      });

      new cdk.CfnOutput(this, 'RuleArn', {
        value: rule.ruleArn,
        description: 'EventBridge rule ARN',
      });
    }

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
