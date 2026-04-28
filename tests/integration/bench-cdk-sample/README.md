# Bench CDK Sample

Integration test mirroring the benchmark CDK app shipped with
[`cfn-deployment-speed-beta-toolkit`](https://github.com/aws-samples/cfn-deployment-speed-beta-toolkit).

The original toolkit uses this stack to benchmark the CloudFormation
"deployment speed beta" feature. We deploy the same shape with cdkd to act
as a regression test for issues that surfaced while running the toolkit
through cdkd:

- Lambda `VpcConfig` (SubnetIds + SecurityGroupIds) resolution
- `SecurityGroupEgress` emission for `allowAllOutbound: true`
- Subnet / Security Group destroy ordering when VPC Lambdas hold ENIs
- CloudFront + Function URL with Origin Access Control (OAC)
- SQS event source mapping wiring

## Resources

- VPC (`10.0.0.0/16`, 2 AZs, 1 NAT Gateway, Public + PrivateEgress subnets)
- Security Group for Lambda (`allowAllOutbound: true`)
- SQS Queue (visibility 60s, retention 4d)
- Lambda `ApiFunction` (NODEJS_20_X / ARM_64) inside the VPC
- Lambda Function URL (`AWS_IAM` auth, `BUFFERED` invoke mode)
- Lambda `ConsumerFunction` (NODEJS_20_X / ARM_64) consuming the SQS queue
- CloudFront Distribution fronting the Function URL via OAC
  (`REDIRECT_TO_HTTPS`, `CACHING_DISABLED`, `ALL_VIEWER_EXCEPT_HOST_HEADER`)
- `CfnOutput` for `DistributionDomainName` and `QueueUrl`

Stack name: `CdkdBenchCdkSample`.

## Run

From the repository root:

```bash
# Deploy + destroy via the harness skill
/run-integ bench-cdk-sample
```

Manual run:

```bash
cd tests/integration/bench-cdk-sample
pnpm install   # or npm install
node ../../../dist/cli.js deploy --region us-east-1 --verbose
node ../../../dist/cli.js destroy --region us-east-1 --force
```

CloudFront distribution creation dominates wall-clock time, so expect a
few minutes per deploy / destroy cycle.
