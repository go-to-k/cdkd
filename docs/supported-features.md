---
title: Supported Features
description: "Which CloudFormation template features cdkd supports: intrinsic functions, pseudo parameters, policies and custom resources, and the one it ignores."
---

# Supported Features

cdkd deploys the CloudFormation template that your CDK app produces. Whether
your app works with cdkd therefore depends on which template features cdkd
understands. This page lists them, and starts with the few that behave
differently from CloudFormation.

Two related lists are on other pages. [Supported Resources](supported-resources.md)
has the resource types cdkd can deploy, and
[`cdkd local invoke`](local-invoke.md) has the Lambda runtimes it runs
locally.

## What behaves differently from CloudFormation

| Feature | Status | What cdkd does |
| --- | --- | --- |
| `UpdatePolicy` | ⚠️ Ignored | Applies the update directly, in one step |
| A resource type with no SDK provider and no Cloud Control support | Not supported | Fails the deploy with an error naming the type |

### `UpdatePolicy` is ignored

cdkd does not process `UpdatePolicy`, which covers
`CodeDeployLambdaAliasUpdate` and the Auto Scaling rolling-update policies.
It applies the update in one step instead.

For example, a Lambda alias with a CodeDeploy update policy switches to the
new version at once. CloudFormation would shift traffic to it gradually
through CodeDeploy. cdkd skips this on purpose, to keep dev and test deploys
fast. The CodeDeploy application and deployment group resources themselves
deploy normally.

### Waiting for slow resources

cdkd's default waits for less than CloudFormation does, and two flags change
that. See [Choose a Wait Mode](wait-modes.md).

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

`Fn::Split` refuses an attribute whose value is already a list. Two such
attributes are `NameServers` of `AWS::Route53::HostedZone` and
`Ipv6CidrBlocks` of `AWS::EC2::VPC`. Remove the `Fn::Split` and use the
`Fn::GetAtt` directly.

[Use Another Stack's Outputs](cross-stack-references.md) explains
`Fn::ImportValue` and `Fn::GetStackOutput`, including how they read from
CloudFormation-managed stacks.

### S3 bucket `DomainName` outside the commercial partition

`Fn::GetAtt <Bucket>.DomainName` on an `AWS::S3::Bucket` returns S3's global
host, `<bucket>.s3.<url-suffix>`. This is the spelling `aws-cdk-lib` uses for
the `bucketDomainName` of a bucket imported with `Bucket.fromBucketAttributes`.
The global host serves the bucket in the commercial (`aws`) partition, but not
in `aws-cn` or `aws-us-gov`:

| Partition | `DomainName` cdkd returns | Reaches the bucket? |
| --- | --- | --- |
| `aws` | `<bucket>.s3.amazonaws.com` | Yes |
| `aws-cn` | `<bucket>.s3.amazonaws.com.cn` | No: the name does not resolve |
| `aws-us-gov` | `<bucket>.s3.amazonaws.com` | No: commercial S3 answers `NoSuchBucket` |

In `aws-cn` and `aws-us-gov`, reference `RegionalDomainName` instead
(`bucket.bucketRegionalDomainName` in CDK). It returns
`<bucket>.s3.<region>.<url-suffix>`, the bucket's regional endpoint, which
exists in those partitions too.

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

cdkd deploys a resource in one of two ways. For more than 90 resource types
it has an SDK provider, which is cdkd's own code for calling that service's
API directly. These cover the most-used services: IAM, Lambda, S3, DynamoDB,
EC2, RDS, ECS, API Gateway, CloudFront, Step Functions, EFS, KMS, Cognito,
AppSync and more.

Any other CloudFormation resource type goes through the Cloud Control API,
AWS's generic resource API. If neither way supports a type, the deploy fails
with an error that names the type.

[Supported Resources](supported-resources.md) has the per-type table, and
[Provisioning Layers](provisioning-layers.md) explains how a resource is
routed.

## Template features

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

### Secrets from dynamic references stay out of state

A dynamic reference to a secret, such as `{{resolve:secretsmanager:...}}`,
is replaced by the secret's value during a deploy. cdkd never stores that
value as plaintext. For a Secrets Manager secret or an SSM `SecureString`
parameter, cdkd keeps the unresolved `{{resolve:...}}` expression in state,
its record of what it deployed.

The same holds for nested stacks, in both directions. A secret passed down
through a nested stack's `Parameters` is redacted in the child stack's state.
A redacted output of a child stack is resolved again before cdkd sends it to
AWS.

## Deploy behavior

Rollback and drift detection have their own pages: [Roll Back a Failed Deploy](rollback.md)
and [Detect and Fix Drift](drift.md).

| Feature | Status | Notes |
| --- | --- | --- |
| JSON Patch updates | ✅ | Cloud Control updates send only what changed (RFC 6902) |
| Resource replacement detection | ✅ | 10+ resource types |
| DELETE idempotency | ✅ | A resource that is already gone counts as deleted |
| Asset publishing (S3) | ✅ | Lambda code packages |
| Asset publishing (ECR) | ✅ | Self-implemented Docker image publishing |
| Implicit delete dependencies | ✅ | VPC / IGW / EventBus / Subnet / RouteTable ordering |
| Stack dependency resolution | ✅ | Stacks a stack depends on are deployed first; `-e` skips them |
| Multi-stack parallel deploy | ✅ | Independent stacks deployed in parallel |
| Attribute enrichment | ✅ | CloudFront OAI, DynamoDB StreamArn, API Gateway RootResourceId, Lambda FunctionUrl, Route53 HealthCheckId, ECR Repository Arn |
| Null value stripping | ✅ | Null values are removed before Cloud Control calls |
| Retries | ✅ | Calls that fail with HTTP 429 or 503 are retried |

A write-only property is one AWS accepts but never returns, such as a
password. On a Cloud Control update, cdkd sends such a property again, using
the type's schema from `cloudformation:DescribeType` to find it. If the
schema cannot be read, the update still proceeds.

## Related

- [Supported Resources](supported-resources.md): per-type provider coverage
- [`cdkd local invoke`](local-invoke.md): the Lambda runtimes emulated
  locally
- [Use Another Stack's Outputs](cross-stack-references.md): how `Fn::ImportValue`
  and `Fn::GetStackOutput` resolve
- [Troubleshooting](troubleshooting.md): what to do when something is not
  supported
