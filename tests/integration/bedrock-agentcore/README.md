# Bedrock AgentCore Example

This example demonstrates deploying an Amazon Bedrock AgentCore Runtime using cdkd.

## Resources Created

- **AgentCore Runtime (Code)** - Runtime with S3 code asset source
- **AgentCore Runtime (Docker)** - Runtime with ECR Docker asset source
- **Cognito User Pool** - the OIDC issuer the code runtime's JWT authorizer points at
- **VPC** (public + private subnets, one NAT gateway) - the managed VPC Lattice private endpoint the JWT authorizer uses in Phase 1; the NAT gives AgentCore the egress it needs to validate the Cognito discovery URL

## What `verify.sh` checks

1. **Phase 1 (deploy)** - the code runtime carries a Description, a JWT
   AuthorizerConfiguration, ProtocolConfiguration `MCP`, a
   LifecycleConfiguration (600 / 3600) and EnvironmentVariables. The
   authorizer's `PrivateEndpoint.ManagedVpcResource.Tags` keys (`Env`,
   `Cost-Center`, `lowerKey`) read back from AWS unchanged, and `cdkd drift`
   reports the code runtime clean (issue #5433).
2. **Phase 2 (REMOVAL, `CDKD_TEST_REMOVAL=true`)** - all five are removed from
   the template (issue #1160). A CloudFormation A/B cleared each one, the
   lifecycle back to the service defaults 900 / 28800, so the runtime must
   read back that way, in place.
3. **Phase 3 (destroy)** - both runtimes, the user pool, the VPC and the cdkd state file are gone.

## Prerequisites

- Amazon Bedrock AgentCore must be available in your target region
- A running Docker daemon (the Docker-asset runtime is built locally)

## Usage

```bash
# Full deploy -> removal -> destroy run (from the repo root, after `vp run build`)
AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash tests/integration/bedrock-agentcore/verify.sh

# Or by hand
vp install
cdkd deploy BedrockAgentcoreStack
cdkd destroy BedrockAgentcoreStack
```

## Outputs

- **CodeRuntimeArn** - The AgentCore Code Runtime ARN
- **DockerRuntimeArn** - The AgentCore Docker Runtime ARN

## Notes

- Uses `@aws-cdk/aws-bedrock-agentcore-alpha` L2 constructs
- AgentCore availability varies by region
