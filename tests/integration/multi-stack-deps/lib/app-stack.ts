import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

/**
 * Application stack with Lambda function and IAM role.
 *
 * Uses Fn::ImportValue to reference the DynamoDB table name and ARN
 * exported by DataStack. This tests cross-stack reference resolution.
 */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Import values from DataStack via Fn::ImportValue
    const tableName = cdk.Fn.importValue('MultiStackDeps-TableName');
    const tableArn = cdk.Fn.importValue('MultiStackDeps-TableArn');
    const bucketName = cdk.Fn.importValue('MultiStackDeps-BucketName');

    // Create IAM role for Lambda
    const role = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'LambdaBasicExec',
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // Add inline policy for DynamoDB access using imported table ARN
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:Scan',
        ],
        resources: [tableArn],
      })
    );

    // Create Lambda function with inline code
    const fn = new lambda.Function(this, 'AppFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      role,
      environment: {
        TABLE_NAME: tableName,
        BUCKET_NAME: bucketName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Output imported values to verify cross-stack resolution
    new cdk.CfnOutput(this, 'ImportedTableName', {
      value: tableName,
      description: 'Table name imported from DataStack via Fn::ImportValue',
    });

    new cdk.CfnOutput(this, 'ImportedBucketName', {
      value: bucketName,
      description: 'Bucket name imported from DataStack via Fn::ImportValue',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: fn.functionArn,
      description: 'Lambda function ARN',
    });
  }
}
