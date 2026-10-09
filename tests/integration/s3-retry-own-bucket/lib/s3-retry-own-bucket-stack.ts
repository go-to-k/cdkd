import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * go-to-k/cdkd#4758: one bucket with an EXPLICIT name and a tag. verify.sh
 * deploys it as a role that may create the bucket but, at first, may neither
 * tag nor delete it: the CREATE makes the bucket, fails on its tagging call
 * (retried as IAM propagation) and cannot clean the bucket up. verify.sh then
 * allows tagging, and the retry of the same CREATE must take the bucket its
 * own first attempt made instead of refusing it as an explicit name already
 * held.
 */
export class S3RetryOwnBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const bucket = new s3.CfnBucket(this, 'Bucket', {
      bucketName: `cdkd-s3rob-${cdk.Stack.of(this).account}`,
      // A configuration write before the denied tagging call: outside
      // us-east-1 it moves the bucket's CreationDate, so the identity the
      // failed attempt records must be read after it.
      versioningConfiguration: { status: 'Enabled' },
      tags: [{ key: 'cdkd:integ-fixture', value: 's3-retry-own-bucket' }],
    });
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
