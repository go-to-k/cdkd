import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * A `TableV2` (`AWS::DynamoDB::GlobalTable`) whose stream view type changes
 * under a Lambda consumer (issue #7000).
 *
 * DynamoDB refuses a new view type on an enabled stream, so cdkd must disable
 * the stream and enable the new one, as CloudFormation does. The change mints
 * a new stream arn, and the consumer's event source mapping must move onto it
 * in the same deploy (issue #6999).
 *
 * go-to-k/cdkd#7132: the replica also streams to a Kinesis data stream, with
 * `ApproximateCreationDateTimePrecision` MILLISECOND. An
 * `UpdateKinesisStreamingDestination` leaves the destination UPDATING for
 * minutes, which the update now waits out (and a later update first waits for
 * a destination still UPDATING).
 *
 * `CDKD_TEST_UPDATE` (comma-separated, cumulative):
 *   (unset)     NEW_IMAGE, Kinesis precision MILLISECOND
 *   `viewtype`  NEW_AND_OLD_IMAGES — a new stream arn
 *   `micro`     Kinesis precision MICROSECOND
 *   `back`      Kinesis precision MILLISECOND again
 */
export class GlobalTableStreamViewTypeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = new Set((process.env.CDKD_TEST_UPDATE ?? '').split(','));
    const kinesisStream = new kinesis.Stream(this, 'KinesisDestination7132', {
      streamName: 'cdkd-gt-stream-view-type-7132',
      streamMode: kinesis.StreamMode.ON_DEMAND,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const table = new dynamodb.TableV2(this, 'Table', {
      tableName: 'CdkdGlobalTableStreamViewType',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      dynamoStream: modes.has('viewtype')
        ? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
        : dynamodb.StreamViewType.NEW_IMAGE,
      kinesisStream,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // TableV2 does not expose the precision; the one replica is the stack's.
    (table.node.defaultChild as dynamodb.CfnGlobalTable).addPropertyOverride(
      'Replicas.0.KinesisStreamSpecification.ApproximateCreationDateTimePrecision',
      modes.has('micro') && !modes.has('back') ? 'MICROSECOND' : 'MILLISECOND'
    );

    const consumer = new lambda.Function(this, 'Consumer', {
      functionName: 'cdkd-gt-stream-view-type-consumer',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
    consumer.addEventSource(
      new DynamoEventSource(table, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 1 })
    );
  }
}
