---
title: Supported Features
description: "Which CloudFormation template features cdkd supports: intrinsic functions, pseudo parameters, policies and custom resources, and the one it ignores."
---

# Supported Features

cdkd deploys the CloudFormation template your CDK app synthesizes, so what
matters is which template features it understands. This page lists them,
starting with the exceptions.

For which resource types cdkd can deploy, see
[Supported Resources](supported-resources.md). For the Lambda runtimes
`cdkd local invoke` runs, see [`cdkd local invoke`](local-invoke.md).

## What behaves differently from CloudFormation

| Feature | Status | What cdkd does |
| --- | --- | --- |
| `UpdatePolicy` | ⚠️ Ignored | Applies the update directly, in one step |
| A resource type with no SDK provider and no Cloud Control support | Not supported | Fails the deploy with an error naming the type |

**`UpdatePolicy` is ignored.** `CodeDeployLambdaAliasUpdate` and Auto Scaling
rolling-update policies are not processed. A Lambda alias, for example, flips
to the new version at once, where CloudFormation would shift traffic
gradually through CodeDeploy. This is intended for dev and test iteration
speed. The CodeDeploy application and deployment group resources themselves
deploy normally.

Wait behavior also differs by design; see [Wait Modes](wait-modes.md).

## Intrinsic Functions

| Function | Status | Notes |
| --- | --- | --- |
| `Ref` | ✅ | Resource physical IDs, parameters, pseudo parameters |
| `Fn::GetAtt` | ✅ | Resource attributes (ARN, DomainName, etc.) |
| `Fn::Join` | ✅ | String concatenation |
| `Fn::Sub` | ✅ | Template string substitution |
| `Fn::Select` | ✅ | Array index selection |
| `Fn::Split` | ✅ | String splitting; a non-string value is refused, as in CloudFormation |
| `Fn::If` | ✅ | Conditional values |
| `Fn::Equals` | ✅ | Equality comparison |
| `Fn::And` | ✅ | Logical AND (2-10 conditions) |
| `Fn::Or` | ✅ | Logical OR (2-10 conditions) |
| `Fn::Not` | ✅ | Logical NOT |
| `Fn::ImportValue` | ✅ | Strong cross-stack reference, resolved from cdkd state, then CloudFormation exports |
| `Fn::GetStackOutput` | ✅ | Weak cross-stack, cross-region or cross-account reference |
| `Fn::FindInMap` | ✅ | Mapping lookup |
| `Fn::GetAZs` | ✅ | Availability Zone list |
| `Fn::Base64` | ✅ | Base64 encoding |
| `Fn::Cidr` | ✅ | CIDR address block generation |

`Fn::Split` on a list-valued attribute is refused because the value is
already a list. `Fn::GetAtt` of `AWS::Route53::HostedZone.NameServers` or
`AWS::EC2::VPC.Ipv6CidrBlocks` is such a value: drop the `Fn::Split` and use
the `Fn::GetAtt` directly.

The two cross-stack intrinsics, their CloudFormation fallback and the
`--no-cfn-fallback` flag are explained in
[Cross-Stack References](cross-stack-references.md).

## Pseudo Parameters

| Parameter | Status |
| --- | --- |
| `AWS::Region` | ✅ |
| `AWS::AccountId` | ✅ (via STS) |
| `AWS::Partition` | ✅ |
| `AWS::URLSuffix` | ✅ |
| `AWS::NoValue` | ✅ |
| `AWS::StackName` | ✅ |
| `AWS::StackId` | ✅ |

## Resource Provisioning

cdkd ships more than 90 SDK providers, which call the service's AWS SDK
client directly. They cover the most-used services: IAM, Lambda, S3,
DynamoDB, EC2, RDS, ECS, API Gateway, CloudFront, Step Functions, EFS, KMS,
Cognito, AppSync and more. Any other CloudFormation resource type goes
through the Cloud Control API. A type neither path supports fails the deploy
with an error.

[Supported Resources](supported-resources.md) has the per-type table, and
[Provisioning Layers](provisioning-layers.md) explains how a resource is
routed.

## Other Features

Rollback and drift detection have their own pages: [Rollback](rollback.md)
and [Drift Detection](drift.md).

### Template features

| Feature | Status | Notes |
| --- | --- | --- |
| CloudFormation Parameters | ✅ | Default values, type coercion |
| Conditions | ✅ | With logical operators |
| Cross-stack references | ✅ | `Fn::ImportValue`, with a CloudFormation `ListExports` fallback |
| Cross-region references | ✅ | `Fn::GetStackOutput`; cross-account with `RoleArn` |
| Dynamic References | ✅ | `{{resolve:secretsmanager:...}}`, `{{resolve:ssm:...}}` |
| DeletionPolicy: Retain | ✅ | Skips deletion of the retained resource |
| UpdateReplacePolicy: Retain | ✅ | Keeps the old resource on replacement |
| UpdatePolicy | ⚠️ Ignored | See [above](#what-behaves-differently-from-cloudformation) |
| Custom Resources (SNS-backed) | ✅ | SNS Topic ServiceToken + S3 response |
| Custom Resources (CDK Provider) | ✅ | `isCompleteHandler` / `onEventHandler` async pattern detection |

A dynamic reference to a secret (Secrets Manager, or an SSM `SecureString`
parameter) is never stored as plaintext. cdkd keeps the unresolved
`{{resolve:...}}` expression in state. This also holds across a nested-stack
boundary in both directions: a secret passed down through a nested stack's
`Parameters` is redacted in the child's state, and a redacted child output is
resolved again before it is sent to AWS.

### Deploy behavior

| Feature | Status | Notes |
| --- | --- | --- |
| JSON Patch updates | ✅ | RFC 6902, minimal patches; write-only properties re-included per registry schema (`cloudformation:DescribeType`, graceful fallback) |
| Resource replacement detection | ✅ | 10+ resource types |
| DELETE idempotency | ✅ | Not-found errors treated as success |
| Asset publishing (S3) | ✅ | Lambda code packages |
| Asset publishing (ECR) | ✅ | Self-implemented Docker image publishing |
| Implicit delete dependencies | ✅ | VPC / IGW / EventBus / Subnet / RouteTable ordering |
| Stack dependency resolution | ✅ | Auto-deploy dependency stacks, `-e` to skip |
| Multi-stack parallel deploy | ✅ | Independent stacks deployed in parallel |
| Attribute enrichment | ✅ | CloudFront OAI, DynamoDB StreamArn, API Gateway RootResourceId, Lambda FunctionUrl, Route53 HealthCheckId, ECR Repository Arn |
| CC API null value stripping | ✅ | Removes null values before API calls |
| Retry with HTTP status codes | ✅ | 429 / 503 + cause chain inspection |

## Related

- [Supported Resources](supported-resources.md): per-type provider coverage
- [`cdkd local invoke`](local-invoke.md): the Lambda runtimes emulated
  locally
- [Cross-Stack References](cross-stack-references.md): how `Fn::ImportValue`
  and `Fn::GetStackOutput` resolve
- [Troubleshooting](troubleshooting.md): what to do when something is not
  supported
