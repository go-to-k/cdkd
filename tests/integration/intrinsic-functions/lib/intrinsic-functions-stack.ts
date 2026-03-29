import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Example stack demonstrating CloudFormation intrinsic function resolution
 *
 * This stack tests cdkd's ability to resolve:
 * - Ref: References to resource physical IDs
 * - Fn::GetAtt: Get resource attributes
 * - Fn::Join: String concatenation
 * - Fn::Sub: String substitution
 *
 * Resources are created with dependencies to test the DAG builder.
 */
export class IntrinsicFunctionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket (no dependencies)
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Create IAM role (uses Ref to bucket name)
    const role = new iam.Role(this, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Test role for cdkd intrinsic functions',
    });

    // Add inline policy (uses Fn::GetAtt for bucket ARN)
    // This tests:
    // 1. Ref: bucket.bucketName -> { "Ref": "TestBucket..." }
    // 2. Fn::GetAtt: bucket.bucketArn -> { "Fn::GetAtt": ["TestBucket...", "Arn"] }
    // 3. Fn::Join: bucket.bucketArn/* -> { "Fn::Join": ["", [{"Fn::GetAtt": ...}, "/*"]] }
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          bucket.bucketArn, // Fn::GetAtt for ARN
          `${bucket.bucketArn}/*`, // Fn::Join with ARN
        ],
      })
    );

    // Outputs test intrinsic function resolution
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName, // Ref
      description: 'Bucket name (Ref)',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn, // Fn::GetAtt
      description: 'Bucket ARN (Fn::GetAtt)',
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: role.roleArn, // Fn::GetAtt
      description: 'Role ARN (Fn::GetAtt)',
    });
  }
}
