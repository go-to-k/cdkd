import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Real-AWS integ fixture for `cdkd local start-cloudfront --from-state`
 * (go-to-k/cdkd#2600).
 *
 *   S3 Bucket (auto-named, no BucketDeployment)
 *   CloudFront Distribution
 *   └── default behavior → S3 origin (the bucket's regional domain name)
 *
 * The origin has NO BucketDeployment, so there is nothing in the cloud
 * assembly to serve locally: the local emulator can serve it only by reading
 * the bucket's physical NAME from deployed state and fetching the object from
 * real S3. `verify.sh` uploads one object out of band and asserts
 * `start-cloudfront --from-state` serves its exact bytes, while the same run
 * without a state source returns 502 — the shape every cdkd release before
 * cdk-local 0.151.0 produced (or refused the flag outright).
 *
 * `withBucketDefaults` (no Origin Access Control) keeps the deploy to the two
 * resources under test; the deployed distribution is never requested.
 *
 * covers: AWS::S3::Bucket
 * covers: AWS::CloudFront::Distribution
 */
export class LocalStartCloudFrontFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `verify.sh` empties the bucket before destroy (the object is uploaded
    // out of band), so DESTROY without autoDeleteObjects is enough.
    const bucket = new s3.Bucket(this, 'OriginBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: { origin: origins.S3BucketOrigin.withBucketDefaults(bucket) },
      comment: 'cdkd local start-cloudfront --from-state integ fixture',
    });

    new cdk.CfnOutput(this, 'OriginBucketName', { value: bucket.bucketName });
  }
}
