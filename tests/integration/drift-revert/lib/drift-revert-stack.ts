import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Drift-revert E2E test stack.
 *
 * Resources whose providers have first-class readCurrentState +
 * provider.update support, exercised end-to-end:
 *
 *  - S3 Bucket with two user tags. inject-drift.ts adds a third tag.
 *    Drift comparator sees the new tag, provider.update reverts via
 *    PutBucketTagging.
 *  - SNS Topic with DisplayName. inject-drift.ts mutates DisplayName via
 *    SetTopicAttributes. Drift comparator sees the changed scalar,
 *    provider.update reverts via SetTopicAttributes.
 *  - IAM Role with a templated inline policy. inject-drift.ts (a) adds a
 *    PermissionsBoundary that wasn't templated (exercises the always-emit
 *    fix — observedProperties carries `PermissionsBoundary: ''` so the
 *    console-side ADD is detectable), and (b) overwrites the inline
 *    policy body via PutRolePolicy (exercises the GetRolePolicy
 *    round-trip in readCurrentState). Drift comparator sees both;
 *    provider.update reverts inline policies via PutRolePolicy diff and
 *    boundary via DeleteRolePermissionsBoundary.
 *  - KMS Key with EnableKeyRotation: false. inject-drift.ts toggles
 *    rotation ON via EnableKeyRotation (exercises the
 *    GetKeyRotationStatus round-trip; Class 1 discriminator-gated on
 *    KeySpec=SYMMETRIC_DEFAULT). Drift comparator sees the toggle;
 *    provider.update reverts via DisableKeyRotation.
 */
export class DriftRevertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'DriftBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    cdk.Tags.of(bucket).add('Owner', 'cdkd-integ');
    cdk.Tags.of(bucket).add('Component', 'drift-revert');

    const topic = new sns.Topic(this, 'DriftTopic', {
      displayName: 'integ-display',
    });

    const role = new iam.Role(this, 'DriftRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'drift-revert E2E test role',
      inlinePolicies: {
        InitialPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: ['arn:aws:s3:::cdkd-drift-revert-placeholder/*'],
            }),
          ],
        }),
      },
    });

    const key = new kms.Key(this, 'DriftKey', {
      description: 'drift-revert E2E test key',
      enableKeyRotation: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the S3 bucket targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'ARN of the SNS topic targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'RoleName', {
      value: role.roleName,
      description: 'Name of the IAM role targeted by inject-drift.ts',
    });

    new cdk.CfnOutput(this, 'KeyId', {
      value: key.keyId,
      description: 'Id of the KMS key targeted by inject-drift.ts',
    });
  }
}
