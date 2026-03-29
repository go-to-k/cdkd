import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
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
 */
export class KmsEncryptionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS Key with rotation
    const key = new kms.Key(this, 'EncKey', {
      enableKeyRotation: true,
      description: 'cdkd test encryption key',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
