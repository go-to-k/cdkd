# Supported Features

CloudFormation feature parity for cdkd. For per-resource-type provisioning
support (SDK Providers vs Cloud Control API fallback), see
[supported-resources.md](supported-resources.md). For `cdkd local invoke`
runtime / handler support, see [cli-reference.md](cli-reference.md).

## Intrinsic Functions

| Function | Status | Notes |
|----------|--------|-------|
| `Ref` | ✅ | Resource physical IDs, Parameters, Pseudo parameters |
| `Fn::GetAtt` | ✅ | Resource attributes (ARN, DomainName, etc.) |
| `Fn::Join` | ✅ | String concatenation |
| `Fn::Sub` | ✅ | Template string substitution |
| `Fn::Select` | ✅ | Array index selection |
| `Fn::Split` | ✅ | String splitting |
| `Fn::If` | ✅ | Conditional values |
| `Fn::Equals` | ✅ | Equality comparison |
| `Fn::And` | ✅ | Logical AND (2-10 conditions) |
| `Fn::Or` | ✅ | Logical OR (2-10 conditions) |
| `Fn::Not` | ✅ | Logical NOT |
| `Fn::ImportValue` | ✅ | Cross-stack references via S3 state |
| `Fn::GetStackOutput` | ✅ (same-account) | Cross-stack / cross-region output reference via S3 state. Cross-account `RoleArn` is rejected with a clear error (not yet implemented). |
| `Fn::FindInMap` | ✅ | Mapping lookup |
| `Fn::GetAZs` | ✅ | Availability Zone list |
| `Fn::Base64` | ✅ | Base64 encoding |
| `Fn::Cidr` | ✅ | CIDR address block generation |

## Pseudo Parameters

| Parameter | Status |
|-----------|--------|
| `AWS::Region` | ✅ |
| `AWS::AccountId` | ✅ (via STS) |
| `AWS::Partition` | ✅ |
| `AWS::URLSuffix` | ✅ |
| `AWS::NoValue` | ✅ |
| `AWS::StackName` | ✅ |
| `AWS::StackId` | ✅ |

## Resource Provisioning

cdkd ships **90+ dedicated SDK Providers** (direct AWS SDK calls, no
polling overhead) covering the most-used services — IAM, Lambda, S3,
DynamoDB, EC2, RDS, ECS, API Gateway, CloudFront, Step Functions, EFS,
KMS, Cognito, AppSync, and more. **Any other CloudFormation resource
type** is handled via the Cloud Control API fallback (async polling).
Resource types not supported by either path fail at deploy time with a
clear error.

See [supported-resources.md](supported-resources.md) for the full
per-type table.

## Other Features

Rollback (`--no-rollback` opt-out) and Drift detection (`cdkd drift`) have
their own sections in the [README](../README.md) — they're surfaced as
top-level features rather than table rows.

| Feature | Status | Notes |
|---------|--------|-------|
| CloudFormation Parameters | ✅ | Default values, type coercion |
| Conditions | ✅ | With logical operators |
| Cross-stack references | ✅ | Via `Fn::ImportValue` + S3 state |
| Cross-region references | ✅ (same-account) | Via `Fn::GetStackOutput` + S3 state. Cross-account `RoleArn` not yet implemented. |
| JSON Patch updates | ✅ | RFC 6902, minimal patches; write-only properties re-included per registry schema (`cloudformation:DescribeType`, graceful fallback) |
| Resource replacement detection | ✅ | 10+ resource types |
| Dynamic References | ✅ | `{{resolve:secretsmanager:...}}`, `{{resolve:ssm:...}}` |
| DELETE idempotency | ✅ | Not-found errors treated as success |
| Asset publishing (S3) | ✅ | Lambda code packages |
| Asset publishing (ECR) | ✅ | Self-implemented Docker image publishing |
| Custom Resources (SNS-backed) | ✅ | SNS Topic ServiceToken + S3 response |
| Custom Resources (CDK Provider) | ✅ | `isCompleteHandler` / `onEventHandler` async pattern detection |
| DeletionPolicy: Retain | ✅ | Skip deletion for retained resources |
| UpdateReplacePolicy: Retain | ✅ | Keep old resource on replacement |
| Implicit delete dependencies | ✅ | VPC / IGW / EventBus / Subnet / RouteTable ordering |
| Stack dependency resolution | ✅ | Auto-deploy dependency stacks, `-e` to skip |
| Multi-stack parallel deploy | ✅ | Independent stacks deployed in parallel |
| Attribute enrichment | ✅ | CloudFront OAI, DynamoDB StreamArn, API Gateway RootResourceId, Lambda FunctionUrl, Route53 HealthCheckId, ECR Repository Arn |
| CC API null value stripping | ✅ | Removes null values before API calls |
| Retry with HTTP status codes | ✅ | 429 / 503 + cause chain inspection |
