# ECS Fargate Example

A container-based integration test that provisions ECS Fargate resources without actually running containers.

## Configuration

This stack includes the following resources:

- **VPC**: Minimal VPC with 1 AZ and a public subnet (no NAT gateway)
- **ECS Cluster**: Fargate-compatible cluster
- **Fargate Task Definition**: Task with a single container using a public ECR image
- **Fargate Service**: Service with `desiredCount: 0` (no containers actually run)
- **IAM Roles**: Task execution role and task role (auto-created by CDK)
- **Security Group**: Default security group for the service
- **CloudWatch Log Group**: For container log streaming

## Features Tested in cdkd

1. **VPC and Networking**: VPC, subnet, internet gateway, route table provisioning
2. **ECS Cluster**: Cluster creation with VPC association
3. **Fargate Task Definition**: Task definition with container image from public ECR
4. **Fargate Service**: Service creation with cluster and task definition dependencies
5. **IAM Role Auto-creation**: Execution role created automatically by CDK constructs
6. **Resource Dependencies**: Service → Cluster → VPC dependency chain
7. **Fn::GetAtt**: Retrieve cluster ARN, service name, task definition ARN in outputs

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkd
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Test Points

- [ ] VPC and public subnet are created
- [ ] ECS Cluster is created
- [ ] Fargate Task Definition is created with the correct container image
- [ ] Fargate Service is created with desiredCount: 0
- [ ] IAM execution role is correctly created and attached
- [ ] CloudWatch Log Group is created for container logs
- [ ] Outputs are correctly resolved (cluster ARN, service name, etc.)

## Design Decisions

- **Minimal VPC**: Uses 1 AZ with only a public subnet and no NAT gateway to minimize cost and resource count
- **desiredCount: 0**: No containers actually run, which avoids cost and keeps the test focused on resource provisioning
- **Public ECR image**: Uses `public.ecr.aws/amazonlinux/amazonlinux:latest` to avoid Docker build during synthesis
- **assignPublicIp: true**: Required when using public subnets without NAT for Fargate (though no tasks actually run)

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack EcsFargateStack \
  --region us-east-1 \
  --force
```
