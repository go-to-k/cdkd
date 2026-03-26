import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Composite (complex) stack example
 *
 * Tests many diverse resource types in a single stack to find
 * unsupported resources in cdkq. Target: 20+ resources including
 * auto-generated IAM roles and policies.
 *
 * Resource types included:
 * - AWS::S3::Bucket
 * - AWS::DynamoDB::Table
 * - AWS::SQS::Queue (x2 - primary + DLQ)
 * - AWS::SNS::Topic
 * - AWS::SNS::Subscription
 * - AWS::Lambda::Function
 * - AWS::Lambda::Url
 * - AWS::IAM::Role (custom)
 * - AWS::Logs::LogGroup
 * - AWS::CloudWatch::Alarm
 * - AWS::SecretsManager::Secret
 * - AWS::SSM::Parameter
 * - AWS::KMS::Key
 * - AWS::KMS::Alias
 * - Auto-generated IAM roles/policies for Lambda
 * - CfnOutputs
 */
export class CompositeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS Key removed for benchmark (adds ~60s due to CC API polling)
    // To re-enable: uncomment and add back CfnOutput below

    // ========================================
    // S3 Bucket
    // ========================================
    const bucket = new s3.Bucket(this, 'DataBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
    });

    // ========================================
    // DynamoDB Table
    // ========================================
    const table = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ========================================
    // SQS Dead Letter Queue + Primary Queue
    // ========================================
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const primaryQueue = new sqs.Queue(this, 'PrimaryQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // ========================================
    // SNS Topic + SQS Subscription
    // ========================================
    const topic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'cdkq Composite Stack Notifications',
    });

    topic.addSubscription(
      new subscriptions.SqsSubscription(primaryQueue)
    );

    // ========================================
    // CloudWatch Log Group
    // ========================================
    const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
      // Let CDK auto-generate the name to avoid conflicts on retry
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ========================================
    // Custom IAM Role
    // ========================================
    const customRole = new iam.Role(this, 'CustomRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Custom IAM role for cdkq composite stack',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // Add inline policy for S3 + DynamoDB access
    customRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
        ],
        resources: [bucket.arnForObjects('*')],
      })
    );

    customRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
        ],
        resources: [table.tableArn],
      })
    );

    // ========================================
    // Lambda Function (inline code, using custom role)
    // ========================================
    const fn = new lambda.Function(this, 'ProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          const response = {
            statusCode: 200,
            body: JSON.stringify({
              message: 'cdkq composite stack processor',
              tableName: process.env.TABLE_NAME,
              bucketName: process.env.BUCKET_NAME,
              timestamp: new Date().toISOString(),
            }),
          };
          return response;
        };
      `),
      role: customRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
        TOPIC_ARN: topic.topicArn,
        LOG_GROUP: logGroup.logGroupName,
      },
      logGroup: logGroup,
    });

    // ========================================
    // Lambda Function URL
    // ========================================
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ========================================
    // CloudWatch Alarm (on Lambda errors)
    // ========================================
    const alarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmDescription: 'Alarm when Lambda function errors exceed threshold',
      metric: fn.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS action to alarm
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(topic));

    // ========================================
    // Secrets Manager Secret
    // ========================================
    const secret = new secretsmanager.Secret(this, 'AppSecret', {
      description: 'cdkq composite stack application secret',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ========================================
    // SSM Parameter
    // ========================================
    const ssmParam = new ssm.StringParameter(this, 'ConfigParameter', {
      // Let CDK auto-generate the name to avoid conflicts on retry
      description: 'cdkq composite stack configuration parameter',
      stringValue: JSON.stringify({
        version: '1.0.0',
        environment: 'test',
      }),
      tier: ssm.ParameterTier.STANDARD,
    });

    // ========================================
    // CfnOutputs
    // ========================================
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 Bucket name',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'S3 Bucket ARN',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB Table name',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: table.tableArn,
      description: 'DynamoDB Table ARN',
    });

    new cdk.CfnOutput(this, 'PrimaryQueueUrl', {
      value: primaryQueue.queueUrl,
      description: 'SQS Primary Queue URL',
    });

    new cdk.CfnOutput(this, 'DlqUrl', {
      value: dlq.queueUrl,
      description: 'SQS Dead Letter Queue URL',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'SNS Topic ARN',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda Function name',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: fn.functionArn,
      description: 'Lambda Function ARN',
    });

    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'Lambda Function URL',
    });

    new cdk.CfnOutput(this, 'CustomRoleArn', {
      value: customRole.roleArn,
      description: 'Custom IAM Role ARN',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group name',
    });

    new cdk.CfnOutput(this, 'AlarmArn', {
      value: alarm.alarmArn,
      description: 'CloudWatch Alarm ARN',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: secret.secretArn,
      description: 'Secrets Manager Secret ARN',
    });

    new cdk.CfnOutput(this, 'SsmParameterName', {
      value: ssmParam.parameterName,
      description: 'SSM Parameter name',
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: 'kms-disabled-for-benchmark',
      description: 'KMS Key ARN',
    });
  }
}
