import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3express from 'aws-cdk-lib/aws-s3express';

export class S3DirectoryBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Express Directory Bucket
    const bucket = new s3express.CfnDirectoryBucket(this, 'DirectoryBucket', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: `${this.region}c--x-s3`, // us-east-1c (use1-az4, S3 Express supported)
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.ref,
      description: 'Directory Bucket name',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.attrArn,
      description: 'Directory Bucket ARN',
    });
  }
}
