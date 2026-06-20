import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * BucketDeployment stack.
 *
 * `s3deploy.BucketDeployment` is a very common daily pattern (deploying a
 * static site / config files into a bucket). It synthesizes a heavy
 * Custom::CDKBucketDeployment custom resource backed by a Provider-framework
 * Lambda + an AwsCliLayer LayerVersion: the Lambda downloads the zipped asset
 * from the bootstrap bucket and syncs it into the destination bucket on create,
 * and prunes it on delete (RetainOnDelete defaults to false). No existing
 * fixture covers it (`s3-asset-deploy` exercises `s3_assets.Asset` /
 * `Code.fromAsset`, which is a different code path).
 *
 * This exercises cdkd's asset publishing AND a heavy custom resource end-to-end
 * on both deploy (verify.sh asserts the file landed in the bucket) and destroy.
 *
 * covers: Custom::CDKBucketDeployment
 */
export class BucketDeploymentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../assets'))],
      destinationBucket: bucket,
    });

    new cdk.CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
  }
}
