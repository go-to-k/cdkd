import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Basic example stack with a single S3 bucket
 *
 * This is the simplest possible cdkd deployment example.
 * It creates a single S3 bucket with no dependencies.
 */
export class BasicStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket with lifecycle, versioning, and CORS
    const bucket = new s3.Bucket(this, 'ExampleBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      versioned: true,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(90),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // Add tags to test JSON Patch updates
    cdk.Tags.of(bucket).add('Environment', 'Test');
    cdk.Tags.of(bucket).add('Project', 'cdkd');

    // Add UPDATE test tag only when CDKD_TEST_UPDATE is set
    // This allows testing UPDATE operations without code changes
    if (process.env.CDKD_TEST_UPDATE === 'true') {
      cdk.Tags.of(bucket).add('UpdateTest', 'true');
    }

    // SSM Document (simple automation)
    new ssm.CfnDocument(this, 'TestDocument', {
      content: {
        schemaVersion: '2.2',
        description: 'Test SSM document for cdkd',
        mainSteps: [{
          action: 'aws:runShellScript',
          name: 'test',
          inputs: { runCommand: ['echo "hello"'] },
        }],
      },
      documentType: 'Command',
      name: `${this.stackName}-test-doc`,
    });

    // Output the bucket name
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'ARN of the S3 bucket',
    });

    // Inject a deliberately-failing resource for rollback testing.
    // SQS messageRetentionPeriod must be in [60, 1209600]; 9999999 is invalid
    // and AWS rejects CreateQueue. The good resources above succeed in parallel
    // (event-driven dispatch), so this exercises the "sibling success then
    // rollback" path against real AWS — matches the unit-test scenario in
    // tests/unit/deployment/rollback.test.ts.
    if (process.env.CDKD_TEST_FAIL === 'true') {
      new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
    }
  }
}
