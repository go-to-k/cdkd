import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

/**
 * Bedrock Agent example stack
 *
 * Demonstrates:
 * - Bedrock Agent creation using L1 construct (CfnAgent)
 * - IAM role with bedrock.amazonaws.com trust policy
 * - bedrock:InvokeModel permission on foundation models
 * - CfnOutputs for Agent ID and Agent ARN
 *
 * Note: Bedrock Agent may not be available in all regions.
 * Ensure your target region supports Amazon Bedrock Agents.
 */
export class BedrockAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create IAM role for Bedrock Agent
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'IAM role for cdkq test Bedrock Agent',
    });

    // Grant permission to invoke foundation models
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/*'],
      })
    );

    // Create Bedrock Agent using L1 construct
    const agent = new bedrock.CfnAgent(this, 'Agent', {
      agentName: 'cdkq-test-agent',
      foundationModel: 'anthropic.claude-3-haiku-20240307-v1:0',
      instruction: 'You are a test agent for cdkq integration testing.',
      agentResourceRoleArn: agentRole.roleArn,
    });

    // Ensure agent is created after the role
    agent.node.addDependency(agentRole);

    // Outputs
    new cdk.CfnOutput(this, 'AgentId', {
      value: agent.attrAgentId,
      description: 'Bedrock Agent ID',
    });

    new cdk.CfnOutput(this, 'AgentArn', {
      value: agent.attrAgentArn,
      description: 'Bedrock Agent ARN',
    });
  }
}
