import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';

export class S3VectorsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${this.stackName}-vector-bucket`.toLowerCase(),
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: vectorBucket.ref,
      description: 'S3 Vector Bucket name',
    });
  }
}
