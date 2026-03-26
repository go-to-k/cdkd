import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';

/**
 * Multi-resource example stack with complex dependencies
 *
 * This example demonstrates a realistic microservice architecture with:
 * - S3 bucket for data storage
 * - DynamoDB table for metadata
 * - Lambda function for processing
 * - SQS queue for event buffering
 * - IAM roles and policies
 * - Complex dependency graph
 *
 * Architecture:
 * S3 Bucket → SQS Queue → Lambda Function → DynamoDB Table
 */
export class MultiResourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create DynamoDB table for metadata storage
    const metadataTable = new dynamodb.Table(this, 'MetadataTable', {
      partitionKey: {
        name: 'fileId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    // Add a Global Secondary Index
    metadataTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });

    // 2. Create S3 bucket for data storage
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'TransitionToIA',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // 3. Create SQS queue for event buffering
    const processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      retentionPeriod: cdk.Duration.days(4),
    });

    // Create Dead Letter Queue
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
    });

    processingQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [processingQueue.queueArn],
        conditions: {
          ArnLike: {
            'aws:SourceArn': dataBucket.bucketArn,
          },
        },
      })
    );

    // 4. Create Lambda execution role with specific permissions
    const lambdaRole = new iam.Role(this, 'ProcessorLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for data processor Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // Grant permissions to Lambda role
    dataBucket.grantRead(lambdaRole);
    metadataTable.grantWriteData(lambdaRole);
    processingQueue.grantConsumeMessages(lambdaRole);

    // Add custom policy for SQS message deletion
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [processingQueue.queueArn],
      })
    );

    // 5. Create Lambda function for processing
    const processorFunction = new lambda.Function(this, 'ProcessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        DATA_BUCKET_NAME: dataBucket.bucketName,
        DLQ_URL: dlq.queueUrl,
      },
      reservedConcurrentExecutions: 10,
    });

    // Add SQS event source to Lambda
    processorFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(processingQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(10),
        reportBatchItemFailures: true,
      })
    );

    // 6. Configure S3 event notifications to SQS
    dataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(processingQueue),
      { prefix: 'uploads/', suffix: '.json' }
    );

    dataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(processingQueue),
      { prefix: 'uploads/', suffix: '.csv' }
    );

    // 7. Add tags to all resources
    cdk.Tags.of(this).add('Project', 'cdkd-multi-resource');
    cdk.Tags.of(this).add('Environment', 'Test');
    cdk.Tags.of(this).add('ManagedBy', 'cdkd');

    // 8. Create outputs
    new cdk.CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
      description: 'Name of the S3 data bucket',
      exportName: 'CdkdMultiResourceDataBucket',
    });

    new cdk.CfnOutput(this, 'DataBucketArn', {
      value: dataBucket.bucketArn,
      description: 'ARN of the S3 data bucket',
    });

    new cdk.CfnOutput(this, 'MetadataTableName', {
      value: metadataTable.tableName,
      description: 'Name of the DynamoDB metadata table',
      exportName: 'CdkdMultiResourceMetadataTable',
    });

    new cdk.CfnOutput(this, 'MetadataTableArn', {
      value: metadataTable.tableArn,
      description: 'ARN of the DynamoDB metadata table',
    });

    new cdk.CfnOutput(this, 'ProcessingQueueUrl', {
      value: processingQueue.queueUrl,
      description: 'URL of the SQS processing queue',
    });

    new cdk.CfnOutput(this, 'ProcessingQueueArn', {
      value: processingQueue.queueArn,
      description: 'ARN of the SQS processing queue',
    });

    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: processorFunction.functionName,
      description: 'Name of the Lambda processor function',
    });

    new cdk.CfnOutput(this, 'ProcessorFunctionArn', {
      value: processorFunction.functionArn,
      description: 'ARN of the Lambda processor function',
      exportName: 'CdkdMultiResourceProcessorFunction',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: dlq.queueUrl,
      description: 'URL of the Dead Letter Queue',
    });
  }
}
