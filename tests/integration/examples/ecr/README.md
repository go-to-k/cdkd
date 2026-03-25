# ECR Example

A practical example that builds a Docker image, pushes it to ECR, and deploys a Lambda function using that image.

## Configuration

This stack includes the following resources:

- **Lambda Function**: `DockerImageFunction` using a locally built Docker image
- **ECR Repository**: Automatically created by CDK for the Docker image asset
- **IAM Role**: Lambda execution role

## Features Tested in cdkq

1. **Docker Image Asset Publishing**: Docker image from `docker/` directory is built and pushed to ECR
2. **ECR Integration**: Image asset is published to an ECR repository via `cdk-assets-lib`
3. **DockerImageFunction**: Lambda function configured with a container image URI
4. **IAM Role Creation**: Automatic execution role for the Lambda function
5. **Fn::GetAtt**: Retrieve Lambda function name and ARN in outputs

## Prerequisites

- Docker must be running locally (required for building the image)
- AWS credentials configured with ECR push permissions
- CDK bootstrap completed (`cdk bootstrap`) to set up the ECR repository and S3 bucket

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkq
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Test Points

- [ ] Docker image is built from `docker/Dockerfile`
- [ ] Image is pushed to ECR repository
- [ ] Lambda function is created with the Docker image URI
- [ ] Environment variable `DEPLOYED_BY` is set to `cdkq`
- [ ] IAM execution role is correctly created and attached
- [ ] Outputs are correctly resolved (function name, ARN)
- [ ] Lambda function can be invoked successfully

## Invoke the Function

```bash
aws lambda invoke \
  --function-name <FunctionName from output> \
  --payload '{}' \
  response.json && cat response.json
```

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack EcrStack \
  --region us-east-1 \
  --force
```

Note: The ECR repository created by CDK bootstrap may retain images. Clean up manually if needed.
