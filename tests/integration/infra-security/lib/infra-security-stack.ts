import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Infrastructure & Security pattern stack
 *
 * Demonstrates:
 * - VPC with 2 AZs, 1 NAT Gateway, public + private subnets
 * - KMS Key with alias and key rotation enabled
 * - S3 Bucket encrypted with the KMS key
 * - SSM StringParameter storing config values
 * - IAM Role with inline S3 access policy + managed policy (AmazonS3ReadOnlyAccess)
 * - CfnOutputs for VPC ID, KMS key ARN, bucket name, parameter name, role ARN
 */
export class InfraSecurityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tags
    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'infra-security');

    // VPC with 2 AZs, 1 NAT Gateway, public + private subnets
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // KMS Key with alias and key rotation enabled
    const key = new kms.Key(this, 'EncryptionKey', {
      enableKeyRotation: true,
      alias: 'alias/infra-security-key',
      description: 'KMS key for infra-security example',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3 Bucket encrypted with the KMS key
    const bucket = new s3.Bucket(this, 'SecureBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // SSM StringParameter storing config values
    const parameter = new ssm.StringParameter(this, 'ConfigParameter', {
      parameterName: '/infra-security/config',
      stringValue: JSON.stringify({
        vpcId: vpc.vpcId,
        bucketName: bucket.bucketName,
      }),
      description: 'Infrastructure configuration parameter',
    });

    // IAM Role with inline policy + managed policy
    const role = new iam.Role(this, 'AppRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Application role for infra-security example',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
      ],
      inlinePolicies: {
        S3AccessPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Grant the role encrypt/decrypt on the KMS key (generates AWS::KMS::Grant)
    key.grantEncryptDecrypt(role);

    // IAM Group + User
    const group = new iam.Group(this, 'AppGroup', {
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
      ],
    });

    const user = new iam.User(this, 'AppUser');
    group.addUser(user);

    // CfnOutputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: key.keyArn,
      description: 'KMS Key ARN',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 Bucket name',
    });

    new cdk.CfnOutput(this, 'ParameterName', {
      value: parameter.parameterName,
      description: 'SSM Parameter name',
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: role.roleArn,
      description: 'IAM Role ARN',
    });
  }
}
