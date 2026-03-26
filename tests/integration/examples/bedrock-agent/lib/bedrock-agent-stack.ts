import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';

/**
 * Bedrock AgentCore Runtime example stack
 *
 * Demonstrates:
 * - AgentCore Runtime with code asset (S3 source)
 * - AgentCore Runtime with Docker asset (ECR source)
 * - Runtime endpoints
 * - CfnOutputs for Runtime ARNs
 *
 * Note: AgentCore may not be available in all regions.
 */
export class BedrockAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Option 1: Code Asset (S3 source) - packages code and uploads to S3
    const codeArtifact = agentcore.AgentRuntimeArtifact.fromCodeAsset({
      path: path.join(__dirname, '..', 'agent-code'),
      runtime: agentcore.AgentCoreRuntime.PYTHON_3_12,
      entrypoint: ['python', 'main.py'],
    });

    const codeRuntime = new agentcore.Runtime(this, 'CodeRuntime', {
      runtimeName: 'cdkq_test_code_runtime',
      agentRuntimeArtifact: codeArtifact,
    });

    // Option 2: Docker Asset (ECR source) - builds and pushes Docker image
    const dockerArtifact = agentcore.AgentRuntimeArtifact.fromAsset(
      path.join(__dirname, '..', 'docker')
    );

    const dockerRuntime = new agentcore.Runtime(this, 'DockerRuntime', {
      runtimeName: 'cdkq_test_docker_runtime',
      agentRuntimeArtifact: dockerArtifact,
    });

    // Outputs
    new cdk.CfnOutput(this, 'CodeRuntimeArn', {
      value: codeRuntime.agentRuntimeArn,
      description: 'AgentCore Code Runtime ARN',
    });

    new cdk.CfnOutput(this, 'DockerRuntimeArn', {
      value: dockerRuntime.agentRuntimeArn,
      description: 'AgentCore Docker Runtime ARN',
    });
  }
}
