import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Two-variant stack for the diff-intrinsic-target-change regression test.
 *
 *   VARIANT=v1 (default): Bucket lives at the stack root (`MyBucket`).
 *   VARIANT=v2:           Bucket is wrapped in a Construct (`Wrapper/MyBucket`),
 *                         which changes the bucket's logical ID without
 *                         touching the IAM role or its inline DefaultPolicy.
 *
 * The IAM Role and its CDK-emitted inline DefaultPolicy keep the same
 * construct path across both variants. Their PolicyDocument's `Resource`
 * field is `Fn::GetAtt: [<bucket-logical-id>, Arn]`, which has the same
 * logical Policy identity in v1 and v2 but resolves to a different bucket
 * ARN after the refactor.
 *
 * Pre-fix, cdkd's diff calculator silently dropped this diff (one side
 * intrinsic, other side resolved string → treated as equal) and the
 * inline policy stayed pointed at the deleted v1 bucket after v2 deploy.
 */
export class DiffIntrinsicTargetChangeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const variant = process.env.VARIANT ?? 'v1';

    const role = new iam.Role(this, 'MyRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Bucket scope flips between top-level and a Construct wrapper.
    const bucketScope: Construct =
      variant === 'v2' ? new Construct(this, 'Wrapper') : this;

    const bucket = new s3.Bucket(bucketScope, 'MyBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Empty bucket — no autoDeleteObjects custom resource needed for cleanup.
      autoDeleteObjects: false,
    });

    // grantReadWrite synthesizes an inline policy on the role with
    //   Resource: [Fn::GetAtt: [MyBucket, Arn], {Fn::Join: ['', [Fn::GetAtt: [...], '/*']]}]
    bucket.grantReadWrite(role);

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'RoleName', { value: role.roleName });
  }
}
