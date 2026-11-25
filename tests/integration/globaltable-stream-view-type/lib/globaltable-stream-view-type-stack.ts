import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
 *   (unset)     NEW_IMAGE
 *   `viewtype`  NEW_AND_OLD_IMAGES — a new stream arn
 */
export class GlobalTableStreamViewTypeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = new Set((process.env.CDKD_TEST_UPDATE ?? '').split(','));
    const table = new dynamodb.TableV2(this, 'Table', {
      tableName: 'CdkdGlobalTableStreamViewType',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      dynamoStream: modes.has('viewtype')
        ? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
        : dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
