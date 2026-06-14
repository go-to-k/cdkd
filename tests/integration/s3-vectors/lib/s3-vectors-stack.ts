import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
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

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${this.stackName}-vector-bucket`.toLowerCase(),
      tags,
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: vectorBucket.ref,
      description: 'S3 Vector Bucket name',
    });
  }
}
