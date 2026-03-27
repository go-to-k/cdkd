import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

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

    // Output the bucket name
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'ARN of the S3 bucket',
    });
  }
}
