import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * An `AWS::S3::BucketPolicy` created on a bucket that ALREADY holds a policy
 * another owner attached (go-to-k/cdkd#6109). `PutBucketPolicy` replaces the
 * whole policy, so a create that sends it blindly drops the other owner's
 * statements (in the wild: the grant a vended-log delivery service attaches
 * for a WAF / VPC Flow Logs destination). CloudFormation refuses the create
 * with "The bucket policy already exists on bucket <name>"; cdkd must too.
 *
 *   covers: AWS::S3::Bucket
 *   covers: AWS::S3::BucketPolicy
 *
 * Without `CDKD_TEST_UPDATE` the stack is the bucket alone. With
 * `CDKD_TEST_UPDATE=policy` it adds the bucket policy (statement Sid
 * `CdkdIntegTemplateStatement`). verify.sh attaches the "other owner's"
 * policy out of band in between.
 */
export class S3BucketPolicyExistingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');

    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `cdkd-integ-bp-existing-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (modes.includes('policy')) {
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'CdkdIntegTemplateStatement',
          principals: [new iam.AccountRootPrincipal()],
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('*')],
        })
      );
    }
  }
}
