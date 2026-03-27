# Secrets Manager + Lambda Integration Test

This example demonstrates cdkd deployment of a Secrets Manager secret with a Lambda function that reads it.

## Resources

- **Secrets Manager Secret** - Secret with generated value (username + password)
- **Lambda Function** - Inline Python function that retrieves the secret
- **IAM Policy** - Grants Lambda read access to the secret (via grantRead)

## What it tests

- SecretsManager Secret creation with generateSecretString
- Lambda Function with inline code and environment variables
- IAM role and policy creation via grantRead (cross-resource permissions)
- Cross-resource references (Ref, Fn::GetAtt for secret ARN)
- RemovalPolicy.DESTROY for clean teardown
- CfnOutputs for resource attributes

## Deploy

```bash
cd tests/integration/secrets-lambda
npm install
cdkd deploy SecretsLambdaStack
```

## Destroy

```bash
cdkd destroy SecretsLambdaStack
```
