import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SnsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * SNS -> Lambda via SnsEventSource.
 *
 * `fn.addEventSource(new SnsEventSource(topic))` is a very common daily pattern.
 * It synthesizes an AWS::SNS::Subscription with Protocol=lambda plus an
 * AWS::Lambda::Permission allowing SNS to invoke the handler. This is a
 * DIFFERENT construct from `topic.addSubscription(new LambdaSubscription(fn))`
 * (the only SNS->Lambda shape the integ suite had, in `event-driven`, which also
 * has no verify.sh). This fixture proves the subscription actually delivers:
 * publish a message and assert the handler ran by checking it recorded the SNS
 * MessageId into DynamoDB.
 *
 * covers: AWS::SNS::Subscription
 */
export class SnsEventSourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'Msgs', {
      tableName: 'cdkd-sns-evt-msgs',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: { TABLE_NAME: table.tableName },
      code: lambda.Code.fromInline(
        [
          "const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');",
          'const ddb = new DynamoDBClient({});',
          'exports.handler = async (event) => {',
          '  for (const rec of event.Records || []) {',
          '    const id = rec.Sns.MessageId;',
          '    await ddb.send(new PutItemCommand({ TableName: process.env.TABLE_NAME, Item: { id: { S: id } } }));',
          "    console.log('sns msg', id);",
          '  }',
          '};',
        ].join('\n')
      ),
    });
    table.grantWriteData(fn);

    const topic = new sns.Topic(this, 'Topic', { topicName: 'cdkd-sns-evt-topic' });
    fn.addEventSource(new SnsEventSource(topic));

    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
