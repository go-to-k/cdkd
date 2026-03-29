import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';

/**
 * ECR example stack
 *
 * Demonstrates:
 * - Docker image asset building and publishing to ECR
 * - Lambda function using DockerImageFunction
 * - ECR asset publishing pipeline via cdkd
 * - IAM role creation for Lambda execution
 * - Explicit AWS::ECR::Repository resource
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
        DEPLOYED_BY: 'cdkd',
      },
    });

    // Explicit ECR Repository
    const repo = new ecr.Repository(this, 'TestRepo', {
      repositoryName: `${this.stackName}-test-repo`.toLowerCase(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
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

    new cdk.CfnOutput(this, 'RepoUri', {
      value: repo.repositoryUri,
      description: 'ECR Repository URI',
    });
  }
}
