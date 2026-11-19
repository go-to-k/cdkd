import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Template-only drift baseline probe for go-to-k/cdkd#6624 and #6627.
 *
 * Every resource policy here is written with an OBJECT-form `Statement` and no
 * `Id` / `Sid`, so a key the service adds on its own shows in the readback as
 * a key the template never submitted. verify.sh records each resource's
 * deploy-time readback (`observedProperties`) beside its template properties.
 *
 * - #6624: one resource policy per service (S3, SQS, SNS, KMS, Secrets
 *   Manager; ECR's readback carries no repository policy, so it is not here) and the Cloud Control-routed IAM inline policies (RolePolicy,
 *   UserPolicy, GroupPolicy), plus an `AWS::IAM::Policy` and an
 *   `AWS::IAM::ManagedPolicy` attaching to the same principals.
 * - #6627: a role, a user and a group that declare no `ManagedPolicyArns`,
 *   `PermissionsBoundary` or `Policies` (the Bare* principals), so the readback
 *   shows which of those keys AWS fills on its own. The Sibling* principals
 *   are the ones the inline and managed policies above attach to, so their
 *   readback shows what a sibling's write looks like on the principal.
 *
 * Each `Deny` names an action nothing in the deploy / drift / destroy path
 * calls, so the policies cannot lock the fixture out of its own teardown.
 *
 * covers: AWS::S3::BucketPolicy
 * covers: AWS::SQS::QueuePolicy
 * covers: AWS::SNS::TopicPolicy
 * covers: AWS::KMS::Key
 * covers: AWS::SecretsManager::ResourcePolicy
 * covers: AWS::IAM::RolePolicy
 * covers: AWS::IAM::UserPolicy
 * covers: AWS::IAM::GroupPolicy
 * covers: AWS::IAM::Policy
 * covers: AWS::IAM::ManagedPolicy
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::User
 * covers: AWS::IAM::Group
 */
export class DriftVerbatimReadbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const root = { AWS: `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:root` };
    const doc = (statement: Record<string, unknown>) => ({
      Version: '2012-10-17',
      Statement: statement,
    });

    // --- #6624: service resource policies -------------------------------
    const bucket = new s3.CfnBucket(this, 'ProbeBucket', {
      bucketName: `cdkd-dvr-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
    });
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    new s3.CfnBucketPolicy(this, 'ProbeBucketPolicy', {
      bucket: bucket.ref,
      policyDocument: doc({
        Effect: 'Deny',
        Principal: root,
        Action: 's3:PutObjectLegalHold',
        Resource: `${bucket.attrArn}/*`,
      }),
    });

    const queue = new sqs.CfnQueue(this, 'ProbeQueue', { queueName: 'cdkd-dvr-queue' });
    queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    new sqs.CfnQueuePolicy(this, 'ProbeQueuePolicy', {
      queues: [queue.ref],
      policyDocument: doc({
        Effect: 'Deny',
        Principal: root,
        Action: 'sqs:PurgeQueue',
        Resource: queue.attrArn,
      }),
    });

    const topic = new sns.CfnTopic(this, 'ProbeTopic', { topicName: 'cdkd-dvr-topic' });
    new sns.CfnTopicPolicy(this, 'ProbeTopicPolicy', {
      topics: [topic.ref],
      policyDocument: doc({
        Effect: 'Deny',
        Principal: root,
        Action: 'sns:ListSubscriptionsByTopic',
        Resource: topic.ref,
      }),
    });

    // A key policy must keep the account's own access, so this one is the
    // single root `Allow` (object form) rather than a `Deny`.
    const key = new kms.CfnKey(this, 'ProbeKey', {
      pendingWindowInDays: 7,
      keyPolicy: doc({
        Effect: 'Allow',
        Principal: root,
        Action: 'kms:*',
        Resource: '*',
      }),
    });
    key.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const secret = new secretsmanager.CfnSecret(this, 'ProbeSecret', {
      name: 'cdkd-dvr-secret',
      generateSecretString: { passwordLength: 16 },
    });
    secret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    new secretsmanager.CfnResourcePolicy(this, 'ProbeSecretPolicy', {
      secretId: secret.ref,
      resourcePolicy: doc({
        Effect: 'Deny',
        Principal: root,
        Action: 'secretsmanager:RestoreSecret',
        Resource: '*',
      }),
    });

    // --- #6624: IAM inline / attached policies on the Sibling* principals --
    const trust = doc({
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    });
    const siblingRole = new iam.CfnRole(this, 'SiblingRole', {
      roleName: 'cdkd-dvr-sibling-role',
      assumeRolePolicyDocument: trust,
    });
    const siblingUser = new iam.CfnUser(this, 'SiblingUser', { userName: 'cdkd-dvr-sibling-user' });
    const siblingGroup = new iam.CfnGroup(this, 'SiblingGroup', {
      groupName: 'cdkd-dvr-sibling-group',
    });
    const denyLegalHold = doc({
      Effect: 'Deny',
      Action: 's3:PutObjectLegalHold',
      Resource: '*',
    });
    new iam.CfnRolePolicy(this, 'ProbeRolePolicy', {
      roleName: siblingRole.ref,
      policyName: 'cdkd-dvr-role-policy',
      policyDocument: denyLegalHold,
    });
    new iam.CfnUserPolicy(this, 'ProbeUserPolicy', {
      userName: siblingUser.ref,
      policyName: 'cdkd-dvr-user-policy',
      policyDocument: denyLegalHold,
    });
    new iam.CfnGroupPolicy(this, 'ProbeGroupPolicy', {
      groupName: siblingGroup.ref,
      policyName: 'cdkd-dvr-group-policy',
      policyDocument: denyLegalHold,
    });
    new iam.CfnPolicy(this, 'ProbePolicy', {
      policyName: 'cdkd-dvr-policy',
      roles: [siblingRole.ref],
      users: [siblingUser.ref],
      groups: [siblingGroup.ref],
      policyDocument: denyLegalHold,
    });
    new iam.CfnManagedPolicy(this, 'ProbeManagedPolicy', {
      managedPolicyName: 'cdkd-dvr-managed-policy',
      roles: [siblingRole.ref],
      users: [siblingUser.ref],
      groups: [siblingGroup.ref],
      policyDocument: denyLegalHold,
    });

    // --- #6627: principals declaring no attachment-class key ---------------
    new iam.CfnRole(this, 'BareRole', {
      roleName: 'cdkd-dvr-bare-role',
      assumeRolePolicyDocument: trust,
    });
    new iam.CfnUser(this, 'BareUser', { userName: 'cdkd-dvr-bare-user' });
    new iam.CfnGroup(this, 'BareGroup', { groupName: 'cdkd-dvr-bare-group' });
  }
}
