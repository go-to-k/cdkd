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
 *
 * Both phases also declare `DefaultRetention.DefaultEventHold` (PR #3002),
 * the member the 2026-09-11 CFn schema capture added. It rides an
 * `addPropertyOverride` rather than the L1 prop because aws-cdk-lib 2.268.0
 * does not model it yet -- which is also the ONLY shape a user can declare it
 * in today, so the fixture exercises the real one. Declared in BOTH phases on
 * purpose: gating it on the UPDATE token would make the Phase-2 template DROP
 * it and turn the arm into a removal test (.claude/rules/testing.md).
 *
 * go-to-k/cdkd#5395: `LateFlagBucket` is a versioned bucket without Object
 * Lock in Phase 1 and declares only the top-level `ObjectLockEnabled: true` in
 * Phase 2 (what CDK's `objectLockEnabled: true` synthesizes). The flag reaches
 * S3 only through `CreateBucket`, and CloudFormation (A/B on the issue)
 * finishes that update in place without enabling Object Lock. cdkd does the
 * same and warns; the bucket must keep its identity and stay without Object
 * Lock. It holds no objects, so it deletes like any empty versioned bucket.
 * Phase 2b (`CDKD_TEST_SUSPEND=true`, on top of the UPDATE token) suspends its
 * versioning while the never-applied flag stays declared: the bucket has no
 * Object Lock, so the suspend must reach S3, as in CloudFormation.
 */
export class S3ObjectLockStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 1 baseline retention is 1 day; Phase 2 (UPDATE) raises it to 5.
    // The event hold must stay <= the retention period: S3 refuses the whole
    // Put with `InvalidRequest: Default retention period must always be
    // greater than or equal to default event hold duration` (measured
    // us-east-1, 2026-09-12). So these two pairs move together.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const retentionDays = isUpdate ? 5 : 1;
    const eventHoldDays = isUpdate ? 3 : 1;

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
    bucket.addPropertyOverride(
      'ObjectLockConfiguration.Rule.DefaultRetention.DefaultEventHold.Days',
      eventHoldDays
    );
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.ref });

    // go-to-k/cdkd#5395 Phase 2: the top-level flag alone, on an existing bucket.
    const lateFlagBucket = new s3.CfnBucket(this, 'LateFlagBucket', {
      bucketName: `cdkd-objectlock-late-${cdk.Stack.of(this).account}`,
      versioningConfiguration: {
        status: process.env.CDKD_TEST_SUSPEND === 'true' ? 'Suspended' : 'Enabled',
      },
      ...(isUpdate ? { objectLockEnabled: true } : {}),
    });
    lateFlagBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
