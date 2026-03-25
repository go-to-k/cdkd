import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * ECR example stack
 *
 * Demonstrates:
 * - Docker image asset building and publishing to ECR
 * - Lambda function using DockerImageFunction
 * - ECR asset publishing pipeline via cdkq
 * - IAM role creation for Lambda execution
 */
export class EcrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function from Docker image
    const fn = new lambda.DockerImageFunction(this, 'DockerHandler', {
      code: lambda.DockerImageCode.fromImageAsset('docker'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DEPLOYED_BY: 'cdkq',
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Docker Lambda function name',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: fn.functionArn,
      description: 'Docker Lambda function ARN',
    });
  }
}
