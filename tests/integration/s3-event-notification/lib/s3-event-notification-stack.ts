import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * S3 -> Lambda event notification stack.
 *
 * A very common daily CDK pattern: `bucket.addEventNotification(...)` with a
 * `LambdaDestination`. Under the hood CDK synthesizes a
 * Custom::S3BucketNotifications custom resource (which PUTs the bucket's
 * NotificationConfiguration), an AWS::Lambda::Permission allowing S3 to invoke
 * the handler, and — because `autoDeleteObjects: true` — a
 * Custom::S3AutoDeleteObjects custom resource that empties the bucket on delete.
 *
 * The existing `event-driven` fixture DEPLOYS an addEventNotification but has no
 * verify.sh, so it never proves the notification actually FIRES. This fixture
 * closes that gap: verify.sh puts an object and asserts the handler ran by
 * checking it recorded the object key into DynamoDB — exercising the full
 * S3 -> Custom::S3BucketNotifications -> Lambda::Permission -> Lambda chain
 * end-to-end on both deploy AND destroy.
 *
 * covers: Custom::S3BucketNotifications
 */
export class S3EventNotificationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Records the keys of objects the notification delivered, so verify.sh can
    // prove the Lambda actually fired (not just that deploy succeeded).
    const table = new dynamodb.Table(this, 'Events', {
      tableName: 'cdkd-s3evt-events',
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: { TABLE_NAME: table.tableName },
      // @aws-sdk/client-dynamodb is part of the Node.js 20 Lambda runtime, so
      // inline code needs no asset bundling.
      code: lambda.Code.fromInline(
        [
          "const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');",
          'const ddb = new DynamoDBClient({});',
          'exports.handler = async (event) => {',
          '  for (const rec of event.Records || []) {',
          '    const key = rec.s3.object.key;',
          '    await ddb.send(new PutItemCommand({',
          '      TableName: process.env.TABLE_NAME,',
          '      Item: { key: { S: key } },',
          '    }));',
          "    console.log('recorded', key);",
          '  }',
          '};',
        ].join('\n')
      ),
    });
    table.grantWriteData(fn);

    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `cdkd-s3evt-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(fn));

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
