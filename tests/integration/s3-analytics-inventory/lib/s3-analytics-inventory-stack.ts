import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * cdkd S3 analytics + inventory DESTINATION integ (issue #1493 items 2/3).
 *
 * Both `applyAnalyticsConfigurations` and `applyInventoryConfigurations` pick
 * between two accepted destination shapes by probing member presence. Before
 * the fix a `Destination` that was a string / array / unresolved intrinsic
 * indexed every probe to `undefined` and the whole block was omitted from the
 * Put — the configuration deployed with no destination and no error anywhere.
 * The fix refuses that on the create path and warns on the update path, and
 * widened the branch probe to include `Bucket` (the readers already accepted
 * `BucketArn ?? Bucket`, so a `{ Bucket }`-only block previously dropped).
 *
 * Nothing in the integ tree exercised either configuration at all, so this
 * fixture is the live proof that the rewritten branch selection still delivers
 * a real destination to AWS — on CREATE and, via the per-id diff path where
 * the warn callback is wired, on UPDATE.
 *
 * L1 `CfnBucket` is used so the exact CFn property shapes are under test.
 *
 * SHAPE SCOPE: only the CFn FLATTENED form (`Destination: { BucketArn, Format,
 * ... }`) is covered live, because it is the only one a CDK template can
 * express — `S3BucketDestination` is the SDK spelling cdkd additionally accepts
 * for state records and hand-written templates, and aws-cdk-lib's L1 renderer
 * silently DROPS a member it does not declare, so synthesizing it would need an
 * `addPropertyOverride` whose output no user ever writes. That branch stays
 * unit-covered in `s3-bucket-provider-destination-shape.test.ts`.
 *
 * Phases:
 *   1. Deploy: analytics + inventory both pointing at the report bucket.
 *      Assert both configurations reached AWS with the declared destination.
 *   2. Re-deploy with CDKD_TEST_UPDATE=true: same destination bucket, changed
 *      prefix + format on both. This runs the per-id diff path
 *      (`diffArrayConfigById` -> the appliers with the warn callback wired).
 *      Assert the readback shows the new values.
 *   3. Destroy; assert both buckets are gone.
 */
export class S3AnalyticsInventoryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 2 changes the destination PREFIX and FORMAT, never the shape and
    // never whether a configuration exists — this fixture only ever updates,
    // so no declaration disappears between steps (the #1543 mode-gating trap).
    const updated = process.env['CDKD_TEST_UPDATE'] === 'true';
    const account = cdk.Stack.of(this).account;

    const reportBucketName = `cdkd-ai-reports-${account}`;
    const sourceBucketName = `cdkd-ai-source-${account}`;
    const reportBucketArn = `arn:aws:s3:::${reportBucketName}`;

    const reportBucket = new s3.CfnBucket(this, 'ReportBucket', {
      bucketName: reportBucketName,
    });
    reportBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // S3 REFUSES `PutBucketAnalyticsConfiguration` / `PutBucketInventoryConfiguration`
    // when the destination bucket's policy does not let the analytics/inventory
    // service write the reports — the call fails with `InvalidArgument:
    // Destination bucket policy is not configured`. So the policy is part of
    // the fixture, not incidental setup.
    const reportPolicy = new s3.CfnBucketPolicy(this, 'ReportBucketPolicy', {
      bucket: reportBucket.ref,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowS3AnalyticsAndInventoryReports',
            Effect: 'Allow',
            Principal: { Service: 's3.amazonaws.com' },
            Action: 's3:PutObject',
            Resource: `${reportBucketArn}/*`,
            Condition: {
              ArnLike: { 'aws:SourceArn': `arn:aws:s3:::${sourceBucketName}` },
              StringEquals: {
                'aws:SourceAccount': account,
                's3:x-amz-acl': 'bucket-owner-full-control',
              },
            },
          },
        ],
      },
    });

    const sourceBucket = new s3.CfnBucket(this, 'SourceBucket', {
      bucketName: sourceBucketName,

      // FLATTENED destination shape — what the CFn schema declares, and the
      // branch `resolveS3BucketDestination` picks via `BucketArn`.
      analyticsConfigurations: [
        {
          id: 'daily-analytics',
          storageClassAnalysis: {
            dataExport: {
              outputSchemaVersion: 'V_1',
              destination: {
                bucketArn: reportBucketArn,
                format: 'CSV',
                prefix: updated ? 'analytics-v2/' : 'analytics-v1/',
              },
            },
          },
        },
      ],

      inventoryConfigurations: [
        {
          id: 'daily-inventory',
          destination: {
            bucketArn: reportBucketArn,
            // Phase 2 flips the format too, so the UPDATE exercises the
            // `readConfigString(s3Dest, 'Format', 'CSV', destPath)` read whose
            // reported path item 3 corrected — not just the prefix pass-through.
            format: updated ? 'ORC' : 'CSV',
            prefix: updated ? 'inventory-v2/' : 'inventory-v1/',
          },
          enabled: true,
          includedObjectVersions: 'All',
          scheduleFrequency: 'Daily',
        },
      ],
    });
    sourceBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The destination policy must exist BEFORE the source bucket's
    // configurations are PUT, or S3 rejects them.
    sourceBucket.addResourceDependency(reportPolicy);

    new cdk.CfnOutput(this, 'SourceBucketName', { value: sourceBucketName });
    new cdk.CfnOutput(this, 'ReportBucketName', { value: reportBucketName });
  }
}
