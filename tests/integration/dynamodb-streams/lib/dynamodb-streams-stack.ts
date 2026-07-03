import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * DynamoDB Streams example stack
 *
 * Demonstrates:
 * - DynamoDB table with stream enabled (NEW_AND_OLD_IMAGES)
 * - Lambda function with inline code triggered by DynamoDB stream
 * - Event source mapping connecting stream to Lambda
 * - IAM role with stream read permissions
 * - ApplicationAutoScaling ScalableTarget for read/write capacity
 * - ApplicationAutoScaling ScalingPolicy with target tracking (70% utilization)
 * - Fn::GetAtt for outputs (table ARN, stream ARN, function name)
 *
 * `fn.addEventSource(new DynamoEventSource(...))` synthesizes
 * AWS::Lambda::EventSourceMapping.
 *
 * covers: AWS::Lambda::EventSourceMapping
 *
 * UPDATE-phase toggle (`CDKD_TEST_UPDATE=true`, issue #977): DynamoDB Streams
 * `StreamSpecification` had NO update() branch, so enabling a stream on an
 * existing table was silently dropped. To exercise the enable-on-UPDATE path
 * the table's `stream` (and everything that CONSUMES the stream — the Lambda,
 * its EventSourceMapping, and the ESM filter-KMS key) is gated behind the
 * update flag:
 *   - Phase 1 (flag unset): the table has NO stream, and no Lambda/ESM/KMS.
 *   - UPDATE phase (flag set): `stream: NEW_AND_OLD_IMAGES` is added (the
 *     update() StreamSpecification branch fires an `UpdateTable` with
 *     `StreamEnabled: true`), and the stream-consumer subtree comes along so
 *     the newly-materialized stream is actually wired to a consumer.
 * The StreamArn `Fn::GetAtt` output is only emitted in the UPDATE phase, so
 * verify.sh can assert `LatestStreamArn` resolved after the update-time enable.
 */
export class DynamodbStreamsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The UPDATE phase (issue #977) enables the DynamoDB Stream on an
    // already-deployed (Phase-1) stream-less table.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // Create DynamoDB table. The stream is enabled only in the UPDATE phase
    // (issue #977) so the enable-on-UPDATE path is exercised.
    //
    // pointInTimeRecoverySpecification + timeToLiveAttribute exercise the
    // PointInTimeRecoverySpecification / TimeToLiveSpecification properties
    // (issue #609) — both are wired via separate post-ACTIVE API calls
    // (UpdateContinuousBackups / UpdateTimeToLive), not CreateTable.
    //
    // warmThroughput exercises the WarmThroughput property (issue #609) —
    // pre-warmed read/write capacity that rides DIRECTLY on CreateTable (the
    // WarmThroughput input field), not a post-ACTIVE control-plane call. AWS
    // enforces minimums of 12000 read units / 4000 write units per second.
    const table = new dynamodb.Table(this, 'EventsTable', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(isUpdate ? { stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES } : {}),
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: 'expiresAt',
      warmThroughput: {
        readUnitsPerSecond: 12000,
        writeUnitsPerSecond: 4000,
      },
    });

    // Auto-scaling for read capacity
    const readScaling = table.autoScaleReadCapacity({
      minCapacity: 5,
      maxCapacity: 20,
    });
    readScaling.scaleOnUtilization({
      targetUtilizationPercent: 70,
    });

    // Auto-scaling for write capacity
    const writeScaling = table.autoScaleWriteCapacity({
      minCapacity: 5,
      maxCapacity: 20,
    });
    writeScaling.scaleOnUtilization({
      targetUtilizationPercent: 70,
    });

    // Outputs common to both phases.
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: table.tableArn,
      description: 'DynamoDB table ARN',
    });

    // The stream-consumer subtree (Lambda + EventSourceMapping + KMS key) and
    // the StreamArn output exist ONLY in the UPDATE phase (issue #977) — a
    // DynamoDB stream must exist before an ESM can be wired to it, so Phase 1
    // (stream-less) omits the entire consumer subtree.
    if (!isUpdate) {
      return;
    }

    // Create Lambda function with inline code to process stream records
    const fn = new lambda.Function(this, 'StreamProcessor', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json

def handler(event, context):
    for record in event.get('Records', []):
        event_name = record.get('eventName', 'UNKNOWN')
        dynamodb_record = record.get('dynamodb', {})
        keys = dynamodb_record.get('Keys', {})
        print(f"Event: {event_name}, Keys: {json.dumps(keys)}")

        if event_name == 'INSERT':
            new_image = dynamodb_record.get('NewImage', {})
            print(f"New item: {json.dumps(new_image)}")
        elif event_name == 'MODIFY':
            old_image = dynamodb_record.get('OldImage', {})
            new_image = dynamodb_record.get('NewImage', {})
            print(f"Old: {json.dumps(old_image)}")
            print(f"New: {json.dumps(new_image)}")
        elif event_name == 'REMOVE':
            old_image = dynamodb_record.get('OldImage', {})
            print(f"Deleted item: {json.dumps(old_image)}")

    return {
        'statusCode': 200,
        'body': json.dumps({'processed': len(event.get('Records', []))})
    }
`),
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    // KMS key for the EventSourceMapping filter-criteria encryption
    // (exercises the `KmsKeyArn` property — issue #609 backfill). AWS
    // only persists the KmsKeyArn on the ESM when there is FilterCriteria
    // to encrypt — without filter criteria, the key is a no-op and AWS
    // silently does not surface it on `get-event-source-mapping`. The
    // FilterCriteria below + the Lambda-service grant make the key both
    // meaningful and authorized to use.
    const esmKey = new kms.Key(this, 'EsmFilterKey', {
      description: 'Encrypts the EventSourceMapping filter criteria (cdkd #609 integ)',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
    esmKey.grantEncryptDecrypt(new iam.ServicePrincipal('lambda.amazonaws.com'));

    // Add DynamoDB stream as event source for Lambda
    fn.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
        filters: [
          // A trivial filter pattern that matches INSERT events. The
          // shape itself is unimportant — its mere presence forces AWS
          // to persist KmsKeyArn (which encrypts this very pattern).
          lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        ],
      })
    );

    // Wire the #609 backfill props onto the synthesized
    // `AWS::Lambda::EventSourceMapping` resource. The L2
    // `DynamoEventSource` does not surface `KmsKeyArn` or `MetricsConfig`
    // directly, so we walk the Lambda function's children, find the
    // single `CfnEventSourceMapping` L1, and use `addPropertyOverride`.
    // Both props are kind-agnostic (KmsKeyArn always supported;
    // MetricsConfig: `EventCount` is the only documented value as of
    // 2025 and works for every source kind).
    //
    // Assert exactly-one-ESM-in-subtree so a future fixture extension
    // that adds a second ESM fails loudly here instead of silently
    // overriding the wrong one (whichever findAll() returns first).
    const esms = fn.node.findAll().filter((c) => c instanceof lambda.CfnEventSourceMapping);
    if (esms.length !== 1) {
      throw new Error(
        `Expected exactly one CfnEventSourceMapping in the StreamProcessor subtree, found ${esms.length}`
      );
    }
    const esmL1 = esms[0] as lambda.CfnEventSourceMapping;
    esmL1.addPropertyOverride('KmsKeyArn', esmKey.keyArn);
    esmL1.addPropertyOverride('MetricsConfig', { Metrics: ['EventCount'] });

    // UPDATE-phase-only outputs (the stream + its consumer only exist here).
    new cdk.CfnOutput(this, 'StreamArn', {
      value: table.tableStreamArn!,
      description: 'DynamoDB stream ARN (resolved via Fn::GetAtt after update-time enable)',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Stream processor Lambda function name',
    });

    new cdk.CfnOutput(this, 'EsmFilterKeyArn', {
      value: esmKey.keyArn,
      description: 'KMS key ARN used by the EventSourceMapping for filter-criteria encryption',
    });
  }
}
