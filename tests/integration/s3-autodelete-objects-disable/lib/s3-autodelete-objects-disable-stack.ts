import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Issue #6422: a bucket whose ONLY tag is CDK's `aws-cdk:auto-delete-objects`.
 *
 * - default: `autoDeleteObjects: true` + DESTROY -> the
 *   `Custom::S3AutoDeleteObjects` resource, its provider Lambda + role, and a
 *   bucket policy.
 * - `CDKD_TEST_UPDATE=true`: `autoDeleteObjects: false` + RETAIN. One deploy
 *   strips the tag (the bucket is left with NO tag set) and deletes the custom
 *   resource, whose CDK handler then meets `NoSuchTagSet`. The deploy must
 *   exit 0 and keep the objects, as CloudFormation does.
 *
 * The bucket name is fixed so `verify.sh` can probe and clean it up.
 */
export class S3AutoDeleteObjectsDisableStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const disabled = process.env.CDKD_TEST_UPDATE === 'true';

    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `cdkd-autodel-disable-${this.account}-${this.region}`,
      removalPolicy: disabled ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !disabled,
    });

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
