import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * KMS Encryption example stack
 *
 * Demonstrates:
 * - AWS::KMS::Key with rotation enabled
 * - AWS::KMS::Alias
 * - AWS::S3::Bucket encrypted with the KMS key
 * - CfnOutputs for key ARN, alias name, bucket name
 * - Removal of KeyPolicy / RotationPeriodInDays / Enabled
 *   (CDKD_TEST_REMOVAL, issue #1160)
 * - A refused KeyUsage change (CDKD_TEST_IMMUTABLE) and a key policy put
 *   with BypassPolicyLockoutSafetyCheck (CDKD_TEST_BYPASS), issue #5299
 */
export class KmsEncryptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // REMOVAL phase (issue #1160): CloudFormation resets a removed
    // RotationPeriodInDays to 365 and a removed KeyPolicy to the KMS default
    // key policy (A/B, us-east-1), while cdkd used to send nothing for either.
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

    // KMS Key with rotation
    const key = new kms.Key(this, 'EncKey', {
      enableKeyRotation: true,
      rotationPeriod: cdk.Duration.days(90),
      description: isRemoval ? 'cdkd test encryption key (removal)' : 'cdkd test encryption key',
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // A statement only the declared policy has, so the default policy after
    // the removal is told apart from it.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Cdkd1160Extra',
        principals: [new iam.AccountRootPrincipal()],
        actions: ['kms:DescribeKey'],
        resources: ['*'],
      })
    );
    if (isRemoval) {
      const cfnKey = key.node.defaultChild as kms.CfnKey;
      cfnKey.addPropertyDeletionOverride('RotationPeriodInDays');
      cfnKey.addPropertyDeletionOverride('KeyPolicy');
    }

    // A disabled, rotating key. The removal drops Enabled and
    // RotationPeriodInDays together: the key must be enabled BEFORE the period
    // reset, which KMS refuses on a disabled key.
    new kms.CfnKey(this, 'DisabledKey', {
      description: 'cdkd test disabled key',
      enableKeyRotation: true,
      pendingWindowInDays: 7,
      ...(isRemoval ? {} : { enabled: false, rotationPeriodInDays: 90 }),
    }).applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Issue #5299: KeyUsage cannot change on an existing key. CloudFormation
    // fails the update; cdkd used to report success while the key kept
    // ENCRYPT_DECRYPT and the beside-it Description change. The IMMUTABLE
    // phase changes both and must fail with nothing applied.
    const isImmutable = process.env.CDKD_TEST_IMMUTABLE === 'true';
    new kms.CfnKey(this, 'SpecKey', {
      description: isImmutable ? 'cdkd test spec key (changed)' : 'cdkd test spec key',
      keySpec: 'RSA_2048',
      keyUsage: isImmutable ? 'SIGN_VERIFY' : 'ENCRYPT_DECRYPT',
      pendingWindowInDays: 7,
    }).applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Issue #5299: the BYPASS phase puts a policy granting the account no
    // kms:PutKeyPolicy. KMS refuses it unless BypassPolicyLockoutSafetyCheck
    // is sent, which cdkd's update used to drop. The policy keeps
    // kms:ScheduleKeyDeletion, so destroy still removes the key.
    const isBypass = process.env.CDKD_TEST_BYPASS === 'true';
    const root = `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:root`;
    new kms.CfnKey(this, 'LockKey', {
      description: 'cdkd test lockout bypass key',
      pendingWindowInDays: 7,
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          isBypass
            ? {
                Sid: 'Cdkd5299NoPutKeyPolicy',
                Effect: 'Allow',
                Principal: { AWS: root },
                Action: [
                  'kms:Describe*',
                  'kms:Get*',
                  'kms:List*',
                  'kms:ScheduleKeyDeletion',
                  'kms:CancelKeyDeletion',
                  'kms:Enable*',
                  'kms:Disable*',
                  'kms:TagResource',
                  'kms:UntagResource',
                  'kms:UpdateKeyDescription',
                ],
                Resource: '*',
              }
            : {
                Sid: 'Cdkd5299Full',
                Effect: 'Allow',
                Principal: { AWS: root },
                Action: 'kms:*',
                Resource: '*',
              },
        ],
      },
      ...(isBypass ? { bypassPolicyLockoutSafetyCheck: true } : {}),
    }).applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // KMS Alias
    key.addAlias('alias/cdkd-kms-test');

    // S3 Bucket encrypted with the KMS key
    const bucket = new s3.Bucket(this, 'EncBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Outputs
    new cdk.CfnOutput(this, 'KeyArn', {
      value: key.keyArn,
      description: 'KMS Key ARN',
    });

    new cdk.CfnOutput(this, 'AliasName', {
      value: 'alias/cdkd-kms-test',
      description: 'KMS Alias name',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Encrypted S3 bucket name',
    });
  }
}
