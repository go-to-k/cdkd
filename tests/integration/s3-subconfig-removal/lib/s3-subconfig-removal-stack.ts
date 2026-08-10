import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * cdkd S3 sub-config REMOVAL semantics integ (issue #1466).
 *
 *   covers: AWS::S3::Bucket
 *
 * Baseline declares four sub-configs that all used to sit on the provider's
 * unconditional "always-PUT" path. Under `CDKD_TEST_UPDATE=true` all four are
 * REMOVED from the template, which is the case that was silently broken: the
 * guarded `if (properties['X'])` branch simply never ran, so the old value
 * survived on the real bucket while cdkd reported `updated` and `drift` stayed
 * clean.
 *
 * The expected post-removal state is NOT uniform, and each verdict below was
 * pinned by a live CloudFormation A/B on this same template pair:
 *
 *   VersioningConfiguration        -> CFn SUSPENDS
 *   OwnershipControls              -> CFn DELETES
 *   BucketEncryption               -> CFn RESETS to the SSE-S3 (AES256) default
 *   PublicAccessBlockConfiguration -> CFn KEEPS it (cdkd was already at parity)
 *
 * The PublicAccessBlock row is deliberately part of the fixture: it looks
 * identical to the other three in the provider source, so this is the
 * real-AWS guard against "fixing" a behavior that is already correct.
 *
 * L1 `CfnBucket` is used so the exact CFn property shapes are under test
 * (the L2 does not expose all four).
 */
export class S3SubconfigRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Removal phase: drop every sub-config from the template.
    const removed = process.env['CDKD_TEST_UPDATE'] === 'true';
    const account = cdk.Stack.of(this).account;

    const bucket = new s3.CfnBucket(this, 'SubconfigBucket', {
      bucketName: `cdkd-subconfig-removal-${account}`,

      // -> expect Suspended after removal
      versioningConfiguration: removed ? undefined : { status: 'Enabled' },

      // -> expect deleted after removal
      ownershipControls: removed
        ? undefined
        : { rules: [{ objectOwnership: 'BucketOwnerPreferred' }] },

      // -> expect reset to AES256 after removal
      bucketEncryption: removed
        ? undefined
        : {
            serverSideEncryptionConfiguration: [
              {
                serverSideEncryptionByDefault: {
                  sseAlgorithm: 'aws:kms',
                  kmsMasterKeyId: 'alias/aws/s3',
                },
                bucketKeyEnabled: true,
              },
            ],
          },

      // -> expect UNCHANGED after removal (CloudFormation parity)
      publicAccessBlockConfiguration: removed
        ? undefined
        : {
            blockPublicAcls: true,
            blockPublicPolicy: true,
            ignorePublicAcls: true,
            restrictPublicBuckets: true,
          },
    });

    // L1 CfnBucket defaults to DeletionPolicy: Delete, but state the decision
    // explicitly so the fixture can never leak a bucket.
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.ref });
  }
}
