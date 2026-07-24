import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * EventSourceMapping fresh-source race example stack.
 *
 * FAILURE-SEEKING integ for `AWS::Lambda::EventSourceMapping` created
 * against a FRESH source + a FRESH execution role in the SAME deploy.
 *
 * The bug classes this fixture hunts for:
 *
 * 1. **Fresh-source readiness race.** The ESM references the SQS queue's
 *    ARN AND the Lambda function (whose execution role + inline policy
 *    are also created in this deploy). cdkd's event-driven DAG dispatches
 *    each resource the instant its own deps complete, with NO level
 *    barrier — so the `CreateEventSourceMapping` call can fire moments
 *    after `CreateQueue` / `CreateFunction` / role-policy-attach return.
 *    If the queue ARN, the function, or the role's `sqs:ReceiveMessage`
 *    grant has not propagated yet, AWS rejects the create with
 *    `InvalidParameterValueException` ("Cannot access queue" / "provided
 *    role ... does not have permissions" / "Function not found"). The
 *    `Ref` / `Fn::GetAtt` edges from the ESM to the queue + function +
 *    the implicit role-policy dependency are what cdkd must order
 *    correctly; this fixture is the real-AWS net for that ordering and
 *    the retry-on-eventual-consistency window.
 *
 * 2. **Orphan-ESM-on-redeploy collision.** A run killed mid-deploy can
 *    leave an orphan EventSourceMapping that is NOT in cdkd state. On
 *    re-deploy cdkd's diff sees no ESM and issues a fresh CREATE, which
 *    can collide (AWS rejects a duplicate (FunctionName, EventSourceArn)
 *    pair with `ResourceConflictException`). verify.sh's pre-flight
 *    orphan scan (per the run-integ skill) catches this BEFORE deploy.
 *
 * Cheap: one Lambda (inline Python, no asset publish) + one SQS queue +
 * one ESM wiring them. No VPC, no KMS.
 *
 * covers: AWS::Lambda::EventSourceMapping, AWS::SQS::Queue
 */
export class EsmRaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // FRESH source: the SQS queue created in THIS deploy. The ESM below
    // references its ARN — the create races this queue's readiness.
    const queue = new sqs.Queue(this, 'SourceQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.minutes(5),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // FRESH role: `lambda.Function` synthesizes an execution role + the
    // SQS-consumer inline policy below comes from `addEventSource`. The
    // ESM create races that role+policy propagation.
    const fn = new lambda.Function(this, 'Consumer', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      // Marker-write handler: each invocation writes a per-message
      // CloudWatch log line `CDKD_ESM_PROCESSED <body>` that verify.sh
      // greps for to PROVE the queue -> ESM -> Lambda wiring actually
      // delivers (a created-but-broken ESM would never log this).
      code: lambda.Code.fromInline(`
import json

def handler(event, context):
    records = event.get('Records', [])
    for record in records:
        body = record.get('body', '')
        print(f"CDKD_ESM_PROCESSED {body}")
    return {'batchItemFailures': []}
`),
      timeout: cdk.Duration.seconds(30),
    });

    // Wire the FRESH queue as an event source for the FRESH function.
    // This synthesizes the AWS::Lambda::EventSourceMapping referencing
    // both the queue ARN (Fn::GetAtt) and the function + grants the
    // role `sqs:ReceiveMessage` / `DeleteMessage` / `GetQueueAttributes`.
    // `enabled: true` (the CDK default) is explicit here so verify.sh
    // can assert State == Enabled on AWS.
    fn.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 5,
        enabled: true,
        reportBatchItemFailures: true,
      })
    );

    // Assert exactly-one-ESM-in-subtree so a future fixture extension
    // that adds a second ESM fails loudly at synth instead of leaving
    // verify.sh's single-UUID resolution silently picking the wrong one.
    const esms = fn.node.findAll().filter((c) => c instanceof lambda.CfnEventSourceMapping);
    if (esms.length !== 1) {
      throw new Error(
        `Expected exactly one CfnEventSourceMapping in the Consumer subtree, found ${esms.length}`
      );
    }

    // Outputs consumed by verify.sh.
    new cdk.CfnOutput(this, 'QueueUrl', {
      value: queue.queueUrl,
      description: 'SQS queue URL (verify.sh sends a probe message here)',
    });
    new cdk.CfnOutput(this, 'QueueArn', {
      value: queue.queueArn,
      description: 'SQS queue ARN (the ESM EventSourceArn)',
    });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Consumer Lambda function name',
    });
    // issue #1190: exercise `Fn::GetAtt [Esm, EventSourceMappingArn]` on deploy.
    // Pre-fix this output failed to resolve (the ESM physical id is the UUID,
    // not ARN-shaped, and the ARN was not cached), hard-failing the resolver's
    // shape guard; the fix caches EventSourceMappingArn under its CFn name.
    new cdk.CfnOutput(this, 'EsmArn', {
      value: (esms[0] as lambda.CfnEventSourceMapping).attrEventSourceMappingArn,
      description: 'EventSourceMapping ARN (Fn::GetAtt EventSourceMappingArn; #1190)',
    });
  }
}
