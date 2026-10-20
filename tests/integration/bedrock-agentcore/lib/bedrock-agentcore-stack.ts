import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 *
 * `agentcore.Runtime` (alpha L2) synthesizes AWS::BedrockAgentCore::Runtime.
 *
 * Issue #1160 removal phase: Phase 1 gives the code runtime a Description,
 * a JWT AuthorizerConfiguration (against the fixture's Cognito user pool),
 * ProtocolConfiguration MCP, a LifecycleConfiguration and
 * EnvironmentVariables. With CDKD_TEST_REMOVAL=true all five are REMOVED
 * from the template (the L2's default ProtocolConfiguration / empty
 * LifecycleConfiguration are deleted too, so the keys are absent). A
 * CloudFormation A/B (us-east-1) cleared each one, the lifecycle back to the
 * service defaults 900 / 28800; cdkd's full-replace UpdateAgentRuntime does
 * the same.
 *
 * covers: AWS::BedrockAgentCore::Runtime
 */
export class BedrockAgentcoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Option 1: Code Asset (S3 source) - packages code and uploads to S3
    const codeArtifact = agentcore.AgentRuntimeArtifact.fromCodeAsset({
      path: path.join(__dirname, '..', 'agent-code'),
      runtime: agentcore.AgentCoreRuntime.PYTHON_3_12,
      entrypoint: ['main.py'],
    });

    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

    // The JWT authorizer's discovery URL must resolve, so it points at a
    // user pool of this stack. The pool outlives the authorizer's removal.
    const authPool = new cognito.UserPool(this, 'AuthPool', {
      userPoolName: 'cdkd-integ-bedrock-agentcore-pool',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const codeRuntime = new agentcore.Runtime(this, 'CodeRuntime', {
      runtimeName: 'cdkd_test_code_runtime',
      agentRuntimeArtifact: codeArtifact,
      ...(isRemoval
        ? {}
        : {
            description: 'cdkd integ code runtime',
            authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingJWT(
              `https://cognito-idp.${this.region}.amazonaws.com/${authPool.userPoolId}/.well-known/openid-configuration`,
              ['cdkd-integ-client']
            ),
            protocolConfiguration: agentcore.ProtocolType.MCP,
            lifecycleConfiguration: {
              idleRuntimeSessionTimeout: cdk.Duration.seconds(600),
              maxLifetime: cdk.Duration.seconds(3600),
            },
            environmentVariables: { CDKD_INTEG: 'bedrock-agentcore' },
          }),
    });
    if (isRemoval) {
      // The L2 always renders these two; delete them so the keys are REMOVED.
      const cfnCodeRuntime = codeRuntime.node.defaultChild as cdk.CfnResource;
      cfnCodeRuntime.addPropertyDeletionOverride('ProtocolConfiguration');
      cfnCodeRuntime.addPropertyDeletionOverride('LifecycleConfiguration');
    }

    // Option 2: Docker Asset (ECR source) - builds and pushes Docker image
    const dockerArtifact = agentcore.AgentRuntimeArtifact.fromAsset(
      path.join(__dirname, '..', 'docker')
    );

    const dockerRuntime = new agentcore.Runtime(this, 'DockerRuntime', {
      runtimeName: 'cdkd_test_docker_runtime',
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
