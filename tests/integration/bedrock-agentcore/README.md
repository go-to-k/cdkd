# Bedrock AgentCore Example

This example demonstrates deploying an Amazon Bedrock AgentCore Runtime using cdkd.

## Resources Created

- **AgentCore Runtime (Code)** - Runtime with S3 code asset source
- **AgentCore Runtime (Docker)** - Runtime with ECR Docker asset source

## Prerequisites

- Amazon Bedrock AgentCore must be available in your target region

## Usage

```bash
# Install dependencies
npm install

# Deploy with cdkd
cdkd deploy BedrockAgentcoreStack

# Destroy
cdkd destroy BedrockAgentcoreStack
```

## Outputs

- **CodeRuntimeArn** - The AgentCore Code Runtime ARN
- **DockerRuntimeArn** - The AgentCore Docker Runtime ARN

## Notes

- Uses `@aws-cdk/aws-bedrock-agentcore-alpha` L2 constructs
- AgentCore availability varies by region
