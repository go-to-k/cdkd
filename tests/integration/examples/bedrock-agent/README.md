# Bedrock Agent Example

This example demonstrates deploying an Amazon Bedrock Agent using cdkq.

## Resources Created

- **IAM Role** - Service role for the Bedrock Agent with `bedrock:InvokeModel` permission
- **Bedrock Agent** - An agent using Claude 3 Haiku as the foundation model

## Prerequisites

- Amazon Bedrock must be available in your target region
- You must have access to the `anthropic.claude-3-haiku-20240307-v1:0` model in your account
  (enable model access in the Bedrock console if needed)

## Usage

```bash
# Install dependencies
npm install

# Deploy with cdkq
cdkq deploy BedrockAgentStack

# Destroy
cdkq destroy BedrockAgentStack
```

## Outputs

- **AgentId** - The Bedrock Agent ID
- **AgentArn** - The Bedrock Agent ARN

## Notes

- Uses L1 construct (`CfnAgent`) since L2 constructs for Bedrock may not be available
- The agent is created with a minimal instruction for testing purposes
- Bedrock Agent availability varies by region; us-east-1 and us-west-2 are recommended
