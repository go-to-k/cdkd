import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Exporter stack that exports values for cross-stack references
 *
 * This stack creates resources and exports their values using CfnOutput
 * with exportName. These values can be imported by other stacks using
 * Fn::ImportValue.
 */
export class ExporterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a S3 bucket
    const bucket = new s3.Bucket(this, 'SharedBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Export bucket name
    new cdk.CfnOutput(this, 'BucketNameExport', {
      value: bucket.bucketName,
      description: 'Name of the shared S3 bucket',
      exportName: 'SharedBucketName',
    });

    // Export bucket ARN
    new cdk.CfnOutput(this, 'BucketArnExport', {
      value: bucket.bucketArn,
      description: 'ARN of the shared S3 bucket',
      exportName: 'SharedBucketArn',
    });
  }
}
