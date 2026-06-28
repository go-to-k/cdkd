import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * An S3 bucket with lifecycle rules — a daily pattern. The fixture mixes a
 * prefix-scoped rule (CFn emits a top-level `Prefix`, the deprecated "V1" form)
 * with a rule that has NO prefix and NO filter (an
 * AbortIncompleteMultipartUpload-only rule). S3 forbids mixing V1 (top-level
 * `Prefix`) and V2 (`Filter`) rules in a single PutBucketLifecycleConfiguration
 * call ("Filter element can only be used in Lifecycle V2"). CloudFormation
 * normalizes this transparently; cdkd must too, or both CREATE and UPDATE fail.
 *
 *   covers: AWS::S3::Bucket
 *
 * Phase 1 creates the bucket with the prefix rule + the abort-only rule (this
 * alone reproduces the V1/V2 mix bug on CREATE). Phase 2 (CDKD_TEST_UPDATE=true)
 * shortens the GLACIER transition + adds a Filter-based rule (ObjectSizeGreaterThan),
 * which must be an in-place PutBucketLifecycleConfiguration UPDATE (not a bucket
 * replacement).
 */
export class S3LifecycleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const rules: s3.LifecycleRule[] = [
      {
        id: 'archive',
        enabled: true,
        prefix: 'logs/',
        transitions: [
          {
            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
            transitionAfter: cdk.Duration.days(30),
          },
          {
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(update ? 60 : 90),
          },
        ],
        expiration: cdk.Duration.days(update ? 365 : 730),
        noncurrentVersionExpiration: cdk.Duration.days(30),
      },
      // No prefix, no filter -> needs the empty V2 Filter S3 requires. Mixed with
      // the prefix rule above, this is what trips the V1/V2 mix bug.
      {
        id: 'abort-mpu',
        enabled: true,
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      },
    ];

    if (update) {
      // A rule with an explicit size Filter (V2). All three rules must end up in
      // V2 Filter form on the wire.
      rules.push({
        id: 'big-objects',
        enabled: true,
        objectSizeGreaterThan: 1024 * 1024,
        expiration: cdk.Duration.days(180),
      });
    }

    // No objects are ever written, so a plain DESTROY removal policy suffices —
    // autoDeleteObjects (a Custom Resource + Lambda) is intentionally avoided to
    // keep the fixture to a single S3 resource.
    new s3.Bucket(this, 'Bucket', {
      bucketName: `cdkd-lifecycle-test-${cdk.Stack.of(this).account}`,
      versioned: true,
      lifecycleRules: rules,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
