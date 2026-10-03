import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ fixture for issue #4443: a deploy that destroys and re-creates a
 * fixed-name bucket under the same id, then FAILS before it reaches the
 * bucket's policy, must not leave the policy lost for good.
 *
 * The bucket's `AWS::S3::BucketPolicy` denies plain-HTTP access (the shape
 * CDK's `enforceSSL` emits) and is deleted with the bucket. It waits on
 * `Sibling` (DependsOn), which reads the bucket; with `CDKD_TEST_PHASE=fail`
 * the sibling's update is refused by SSM (its value does not match its own
 * `AllowedPattern`), so the deploy fails after the bucket's recreate and
 * before the policy. Before the fix the policy's record survived, every later
 * deploy diffed it unchanged, and the bucket stayed without its deny.
 *
 * covers: AWS::S3::Bucket
 * covers: AWS::S3::BucketPolicy
 * covers: AWS::SSM::Parameter
 */
export class LostChildAfterFailedDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const fail = process.env.CDKD_TEST_PHASE === 'fail';

    const bucket = new s3.CfnBucket(this, 'ParentBucket', {
      bucketName: `${this.stackName.toLowerCase()}-${this.account}`,
    });

    const sibling = new ssm.CfnParameter(this, 'Sibling', {
      name: `${this.stackName}-sibling`,
      type: 'String',
      value: fail ? `${bucket.ref}-bad` : bucket.ref,
      ...(fail && { allowedPattern: '^never$' }),
    });

    const policy = new s3.CfnBucketPolicy(this, 'ChildPolicy', {
      bucket: bucket.ref,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: 's3:*',
            Resource: [bucket.attrArn, `${bucket.attrArn}/*`],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
        ],
      },
    });
    policy.addDependency(sibling);
  }
}
