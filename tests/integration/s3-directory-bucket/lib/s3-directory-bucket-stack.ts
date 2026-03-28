import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class S3DirectoryBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Express Directory Bucket
    const bucket = new s3.CfnDirectoryBucket(this, 'DirectoryBucket', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: `${this.region}a--x-s3`, // first AZ
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
