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
| `Fn::Split` | ✅ | String splitting. A non-string value is refused, matching CloudFormation — in particular a list-valued `Fn::GetAtt` (`AWS::Route53::HostedZone.NameServers`, `AWS::EC2::VPC.Ipv6CidrBlocks`) is already a list, so drop the `Fn::Split` and use the `Fn::GetAtt` directly (issue [#1874](https://github.com/go-to-k/cdkd/issues/1874)) |
| `Fn::If` | ✅ | Conditional values |
| `Fn::Equals` | ✅ | Equality comparison |
| `Fn::And` | ✅ | Logical AND (2-10 conditions) |
| `Fn::Or` | ✅ | Logical OR (2-10 conditions) |
| `Fn::Not` | ✅ | Logical NOT |
| `Fn::ImportValue` | ✅ | Cross-stack references via S3 state, falling back to CloudFormation `ListExports` on a cdkd-state miss (issue #1697) so CloudFormation-managed producers can be referenced; disable with `--no-cfn-fallback` |
| `Fn::GetStackOutput` | ✅ | Cross-stack / cross-region output reference via S3 state, falling back to CloudFormation `DescribeStacks` outputs on a cdkd-state miss (same-account; issue #1697). Cross-account via `RoleArn` (reads the producer account's cdkd state; no CFn fallback). |
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
| Cross-stack references | ✅ | Via `Fn::ImportValue` + S3 state, with a CloudFormation `ListExports` fallback for CFn-managed producers (issue #1697) |
| Cross-region references | ✅ | Via `Fn::GetStackOutput` + S3 state, with a same-account CloudFormation `DescribeStacks` fallback (issue #1697). Cross-account via `RoleArn` (producer-account cdkd state only). |
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
| UpdatePolicy | ⚠️ Ignored | `CodeDeployLambdaAliasUpdate` / ASG rolling-update policies are not processed — updates apply directly in one step (e.g. a Lambda alias flips instantly instead of CFn's gradual CodeDeploy canary shift). Intentional for dev/test iteration speed; the CodeDeploy application/deployment group resources themselves deploy fine (see `tests/integration/codedeploy-lambda-deployment-group`) |
| Implicit delete dependencies | ✅ | VPC / IGW / EventBus / Subnet / RouteTable ordering |
| Stack dependency resolution | ✅ | Auto-deploy dependency stacks, `-e` to skip |
| Multi-stack parallel deploy | ✅ | Independent stacks deployed in parallel |
| Attribute enrichment | ✅ | CloudFront OAI, DynamoDB StreamArn, API Gateway RootResourceId, Lambda FunctionUrl, Route53 HealthCheckId, ECR Repository Arn |
| CC API null value stripping | ✅ | Removes null values before API calls |
| Retry with HTTP status codes | ✅ | 429 / 503 + cause chain inspection |
