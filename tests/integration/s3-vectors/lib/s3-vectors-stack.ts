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
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${this.stackName}-vector-bucket`.toLowerCase(),
      tags: [
        { key: 'env', value: 'cdkd-integ' },
        { key: 'team', value: 'platform' },
      ],
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: vectorBucket.ref,
      description: 'S3 Vector Bucket name',
    });
  }
}
