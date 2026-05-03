import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Stack for exercising `cdkd orphan <constructPath>` (per-resource orphan).
 *
 * Two resources, with one explicit cross-reference so the orphan
 * rewriter has something load-bearing to substitute:
 *
 *   - `MyBucket` (AWS::S3::Bucket) — the future orphan target.
 *   - `Handler` (AWS::Lambda::Function) — its `BUCKET_NAME` env var
 *     is `bucket.bucketName`, which CDK synthesizes to `{Ref: MyBucket}`.
 *
 * After `cdkd orphan CdkdOrphanResourceExample/MyBucket`, the state file
 * for the Function should have `BUCKET_NAME` rewritten to the literal
 * physical bucket name (a string), and the Bucket should no longer be
 * tracked in cdkd state — but it must still exist in AWS.
 *
 * The Bucket uses `RemovalPolicy.RETAIN` because the destroy path of
 * this test only removes the Lambda; the test driver deletes the
 * orphaned bucket out-of-band with `aws s3 rb` to leave zero leftover
 * resources.
 */
export class OrphanResourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'MyBucket', {
      // RETAIN: cdkd's destroy will respect this and skip the bucket,
      // but the orphan flow doesn't even touch destroy — this is just
      // a safety belt for the cleanup phase if someone runs `cdkd
      // destroy` *before* orphaning.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // Lambda's BUCKET_NAME env var holds `{Ref: MyBucket}` after synth.
    // After orphaning MyBucket, the rewriter must resolve that Ref via
    // S3BucketProvider.getAttribute(... 'Ref') and substitute the literal
    // bucket name string into state.
    new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      handler: 'index.handler',
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
      timeout: cdk.Duration.seconds(10),
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Physical name of the S3 bucket (the orphan target)',
    });
  }
}
