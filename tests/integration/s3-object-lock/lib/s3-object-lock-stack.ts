import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * An S3 bucket with Object Lock enabled and a default GOVERNANCE retention
 * rule — a common compliance pattern. cdkd's S3 provider applies Object Lock
 * via PutObjectLockConfiguration and reads it back via GetObjectLockConfiguration.
 *
 *   covers: AWS::S3::Bucket
 *
 * Phase 1 creates the bucket with a 1-day default retention; Phase 2
 * (CDKD_TEST_UPDATE=true) raises it to 5 days, which must be an in-place
 * PutObjectLockConfiguration UPDATE (not a bucket replacement) and must not
 * produce phantom drift on readback.
 */
export class S3ObjectLockStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 1 baseline retention is 1 day; Phase 2 (UPDATE) raises it to 5.
    const retentionDays = process.env.CDKD_TEST_UPDATE === 'true' ? 5 : 1;

    const bucket = new s3.CfnBucket(this, 'Bucket', {
      bucketName: `cdkd-objectlock-test-${cdk.Stack.of(this).account}`,
      objectLockEnabled: true,
      objectLockConfiguration: {
        objectLockEnabled: 'Enabled',
        rule: {
          defaultRetention: {
            mode: 'GOVERNANCE',
            days: retentionDays,
          },
        },
      },
    });
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.ref });
  }
}
