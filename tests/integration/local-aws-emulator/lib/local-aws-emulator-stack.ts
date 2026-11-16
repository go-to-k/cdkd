import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture: cdkd local pins
 * `docker --platform` to the declared `Architectures`, and the CDK default
 * X86_64 runs under emulation on an arm64 host
 * (`tests/unit/integ-fixture-host-architecture.test.ts`).
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

// Writes one item and reads it back, so a run proves both the table name
// --from-state handed in and that the call reached the emulator's DynamoDB.
const TABLE_HANDLER = `
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const ddb = new DynamoDBClient({});
exports.handler = async () => {
  const TableName = process.env.TABLE_NAME;
  await ddb.send(new PutItemCommand({ TableName, Item: { id: { S: 'k1' }, v: { S: process.env.VERSION } } }));
  const r = await ddb.send(new GetItemCommand({ TableName, Key: { id: { S: 'k1' } } }));
  return { table: TableName, stored: r.Item && r.Item.v.S, version: process.env.VERSION };
};
`;

// Sends a message carrying the request path and receives it back: the queue
// URL comes from --from-state, and the round trip only succeeds if the SQS
// calls stayed on the emulator.
const API_HANDLER = `
const { SQSClient, SendMessageCommand, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');
const sqs = new SQSClient({});
exports.handler = async (event) => {
  const QueueUrl = process.env.QUEUE_URL;
  await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'via ' + event.rawPath }));
  const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 2 }));
  return { statusCode: 200, body: JSON.stringify({ got: (r.Messages || []).map((m) => m.Body) }) };
};
`;

/**
 * The documented `--aws-emulator` loop (docs/aws-emulator.md): deploy into a
 * local AWS Emulator, run the code with `cdkd local` against what was
 * deployed, redeploy a change, destroy.
 *
 * - A table + function (`cdkd local invoke --from-state`), UPDATED in place
 *   under CDKD_TEST_UPDATE=true: a GSI, more memory, a new VERSION env value.
 * - A queue + HTTP API (`cdkd local start-api --from-state`).
 * - A bucket with `autoDeleteObjects` + a `BucketDeployment`: their custom
 *   resources run in the Lambda runtime image on the host, not in the
 *   emulator's own runtime.
 * - A NestedStack holding a second table + function.
 *
 * covers: AWS::DynamoDB::Table
 * covers: AWS::Lambda::Function
 * covers: AWS::SQS::Queue
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::S3::Bucket
 * covers: Custom::CDKBucketDeployment
 * covers: Custom::S3AutoDeleteObjects
 * covers: AWS::CloudFormation::Stack
 */
export class LocalAwsEmulatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    if (update) {
      table.addGlobalSecondaryIndex({
        indexName: 'byV',
        partitionKey: { name: 'v', type: dynamodb.AttributeType.STRING },
      });
    }
    const tableFn = new lambda.Function(this, 'TableFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(TABLE_HANDLER),
      memorySize: update ? 256 : 128,
      environment: { TABLE_NAME: table.tableName, VERSION: update ? 'v2' : 'v1' },
    });
    table.grantReadWriteData(tableFn);

    const queue = new sqs.Queue(this, 'Queue', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    const apiFn = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(API_HANDLER),
      environment: { QUEUE_URL: queue.queueUrl },
    });
    queue.grantSendMessages(apiFn);
    queue.grantConsumeMessages(apiFn);
    const api = new apigwv2.HttpApi(this, 'HttpApi');
    api.addRoutes({ path: '/send', integration: new HttpLambdaIntegration('SendInt', apiFn) });

    const bucket = new s3.Bucket(this, 'Bucket', {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new s3deploy.BucketDeployment(this, 'Site', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(path.join(import.meta.dirname, '..', 'site'))],
    });

    const inner = new cdk.NestedStack(this, 'Inner');
    const innerTable = new dynamodb.Table(inner, 'Table', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const innerFn = new lambda.Function(inner, 'TableFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(TABLE_HANDLER),
      environment: { TABLE_NAME: innerTable.tableName, VERSION: 'nested' },
    });
    innerTable.grantReadWriteData(innerFn);

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
