import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Minimal stack for exercising `cdkd state destroy`.
 *
 * Single S3 bucket — small enough to deploy/destroy quickly, distinct enough
 * from `basic` that it survives even if `basic` is mid-deploy. The point of
 * this integ test is the destroy *command surface*, not the destroy provider
 * implementation, so the resource shape stays intentionally trivial.
 */
export class StateDestroyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'StateDestroyBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket',
    });
  }
}
