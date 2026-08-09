import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';

export class S3VectorsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Exercise the #609 Tags backfill: the bucket gains user tags wired
    // through `CreateVectorBucket.tags` and read back via
    // `ListTagsForResource`. The L1 `CfnVectorBucket` accepts a standard
    // `Array<cdk.CfnTag>`.
    //
    // CDKD_TEST_UPDATE=true mutates the tag set so a second deploy exercises
    // the in-place Tags UPDATE path (TagResource for env-changed + owner-added,
    // UntagResource for team-removed) — the path that was a silent no-op before
    // this fix. VectorBucketName is held constant (it is create-only; changing
    // it would force a replacement, not an update).
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const tags = isUpdate
      ? [
          { key: 'env', value: 'cdkd-integ-updated' }, // changed value
          { key: 'owner', value: 'cdkd' }, // added
          // 'team' removed
        ]
      : [
          { key: 'env', value: 'cdkd-integ' },
          { key: 'team', value: 'platform' },
        ];

    // Issue #1385: the provider read the encryption sub-keys with the WRONG
    // CFn spellings (`SSEType` / `KMSKeyArn`), so both lookups were always
    // `undefined` and CreateVectorBucket silently shipped the account-default
    // encryption instead of this customer-managed key. `EncryptionConfiguration`
    // is create-only, so it is held CONSTANT across the CDKD_TEST_UPDATE branch
    // above (a change would force a replacement, not the Tags in-place update
    // that phase exercises).
    // Default key policy (account root) only — deliberately NO
    // `s3vectors.amazonaws.com` grant. This fixture proves the CONFIGURATION
    // reaches AWS (CreateVectorBucket / GetVectorBucket both succeed and echo
    // the key back); it writes no vectors, so it would not catch an
    // AccessDenied on the actual encrypt path. That is out of scope for #1385,
    // which is purely about the CFn key spelling never reaching the SDK call.
    const key = new kms.Key(this, 'VectorBucketKey', {
      description: 'cdkd s3-vectors integ CMK (issue #1385)',
      enableKeyRotation: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${this.stackName}-vector-bucket`.toLowerCase(),
      encryptionConfiguration: {
        sseType: 'aws:kms',
        kmsKeyArn: key.keyArn,
      },
      tags,
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: vectorBucket.ref,
      description: 'S3 Vector Bucket name',
    });

    new cdk.CfnOutput(this, 'VectorBucketKeyArn', {
      value: key.keyArn,
      description: 'CMK the vector bucket must be encrypted with',
    });
  }
}
