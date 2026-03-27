import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class EventDrivenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'event-driven');

    // ──────────────────────────────────────────────
    // SQS Queue + Lambda with Event Source Mapping
    // ──────────────────────────────────────────────
    const queue = new sqs.Queue(this, 'EventQueue', {
      queueName: 'cdkd-event-driven-queue',
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sqsHandler = new lambda.Function(this, 'SqsHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline([
        'def handler(event, context):',
        '    for record in event["Records"]:',
        '        print(f"SQS message: {record[\"body\"]}")',
        '    return {"statusCode": 200, "processed": len(event["Records"])}',
      ].join('\n')),
      timeout: cdk.Duration.seconds(30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    sqsHandler.addEventSource(
      new eventsources.SqsEventSource(queue, {
        batchSize: 5,
      })
    );

    // ──────────────────────────────────────────────
    // SNS Topic + Lambda Subscription
    // ──────────────────────────────────────────────
    const topic = new sns.Topic(this, 'EventTopic', {
      topicName: 'cdkd-event-driven-topic',
    });

    const snsHandler = new lambda.Function(this, 'SnsHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline([
        'def handler(event, context):',
        '    for record in event["Records"]:',
        '        message = record["Sns"]["Message"]',
        '        print(f"SNS message: {message}")',
        '    return {"statusCode": 200}',
      ].join('\n')),
      timeout: cdk.Duration.seconds(30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    topic.addSubscription(
      new subscriptions.LambdaSubscription(snsHandler)
    );

    // ──────────────────────────────────────────────
    // S3 Bucket with event notification to Lambda
    // ──────────────────────────────────────────────
    const s3Handler = new lambda.Function(this, 'S3Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline([
        'def handler(event, context):',
        '    for record in event["Records"]:',
        '        bucket = record["s3"]["bucket"]["name"]',
        '        key = record["s3"]["object"]["key"]',
        '        print(f"S3 object created: s3://{bucket}/{key}")',
        '    return {"statusCode": 200}',
      ].join('\n')),
      timeout: cdk.Duration.seconds(30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const bucket = new s3.Bucket(this, 'EventBucket', {
      bucketName: `cdkd-event-driven-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(s3Handler)
    );

    // ──────────────────────────────────────────────
    // Secrets Manager Secret + Lambda env var
    // ──────────────────────────────────────────────
    const secret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: 'cdkd-event-driven-secret',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 16,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add secret ARN as env var on SQS handler
    sqsHandler.addEnvironment('SECRET_ARN', secret.secretArn);

    // ──────────────────────────────────────────────
    // Outputs
    // ──────────────────────────────────────────────
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
  }
}
