# cdkd

**cdkd** (CDK Direct) - A from-scratch CDK CLI with its own deployment engine — provisions via AWS SDK instead of CloudFormation.

- **Direct provisioning** via AWS SDK instead of CloudFormation
- **From-scratch CDK CLI** - synthesis orchestration, asset publishing, context resolution (no aws-cdk / toolkit-lib dependency)
- **CDK compatible** - use your existing CDK app code as-is
- **Own deployment engine** - diff calculation, dependency graph, parallel execution, state management (what CloudFormation handles internally)

![cdkd demo](https://github.com/user-attachments/assets/0128730d-186d-4bd3-abea-aabc80ba4dd5)

> **⚠️ WARNING: NOT PRODUCTION READY**
>
> This project is in early development and is **NOT suitable for production use**. Features are incomplete, APIs may change without notice, and there may be bugs that could affect your AWS infrastructure. Use at your own risk in development/testing environments only.

> **Note**: This is an experimental/educational project exploring alternative deployment approaches for AWS CDK. It is **not intended to replace** the official AWS CDK CLI, but rather to experiment with direct SDK provisioning as a learning exercise and proof of concept.

## Features

- **Synthesis orchestration**: CDK app subprocess execution, Cloud Assembly parsing, context provider loop
- **Asset handling**: Self-implemented asset publisher for S3 file assets (ZIP packaging) and Docker images (ECR)
- **Context resolution**: Self-implemented context provider loop for Vpc.fromLookup(), AZ, SSM, HostedZone, etc.
- **Hybrid provisioning**: SDK Providers for fast direct API calls, Cloud Control API fallback for broad resource coverage
- **Diff calculation**: Self-implemented resource/property-level diff between desired template and current state
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **`--no-wait` for async resources**: Skip the multi-minute wait on CloudFront / RDS / ElastiCache and return as soon as the create call returns (CloudFormation always blocks)

> **Note**: Resource types not covered by either SDK Providers or Cloud Control API cannot be deployed with cdkd. If you encounter an unsupported resource type, deployment will fail with a clear error message.

## Benchmark

**cdkd deploys up to ~5x faster than AWS CDK (CloudFormation).**

Measured on `us-east-1` with 5 independent resources per stack (fully parallelized by cdkd's DAG scheduler).

### SDK Provider path — **4.8x faster** (20.5s vs 98.4s)

Stack: S3 Bucket, DynamoDB Table, SQS Queue, SNS Topic, SSM Parameter.

| Phase | cdkd | AWS CDK (CFn) | Speedup |
| --- | --- | --- | --- |
| Synthesis | 3.5s | 4.1s | 1.2x |
| Deploy | 17.0s | 94.4s | **5.5x** |
| **Total** | **20.5s** | **98.4s** | **4.8x** |

### Cloud Control API fallback path — **1.5x faster** (44.6s vs 69.1s)

Stack: SSM Document × 3 + Athena WorkGroup × 2 (no SDK provider — CC API fallback).

| Phase | cdkd | AWS CDK (CFn) | Speedup |
| --- | --- | --- | --- |
| Synthesis | 3.7s | 4.2s | 1.1x |
| Deploy | 40.9s | 64.9s | **1.6x** |
| **Total** | **44.6s** | **69.1s** | **1.5x** |

Reproduce with `./tests/benchmark/run-benchmark.sh all`. See [tests/benchmark/README.md](tests/benchmark/README.md) for details.

## How it works

```
┌─────────────────┐
│  Your CDK App   │  (aws-cdk-lib)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Synthesis  │  Subprocess + Cloud Assembly parser
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CloudFormation  │
│   Template      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Engine     │
│ - DAG Analysis  │  Dependency graph construction
│ - Diff Calc     │  Compare with existing resources
│ - Parallel Exec │  Event-driven dispatch
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│  SDK   │ │ Cloud  │
│Provider│ │Control │  Fallback for many
│        │ │  API   │  additional types
└────────┘ └────────┘
```

For a step-by-step walkthrough of the full `cdkd deploy` pipeline (CLI
parsing → synthesis → asset publishing → per-stack deploy), see
[docs/architecture.md](docs/architecture.md#5-end-to-end-pipeline-walkthrough-cdkd-deploy).

## Supported Features

### Intrinsic Functions

| Function | Status | Notes |
|----------|--------|-------|
| `Ref` | ✅ Supported | Resource physical IDs, Parameters, Pseudo parameters |
| `Fn::GetAtt` | ✅ Supported | Resource attributes (ARN, DomainName, etc.) |
| `Fn::Join` | ✅ Supported | String concatenation |
| `Fn::Sub` | ✅ Supported | Template string substitution |
| `Fn::Select` | ✅ Supported | Array index selection |
| `Fn::Split` | ✅ Supported | String splitting |
| `Fn::If` | ✅ Supported | Conditional values |
| `Fn::Equals` | ✅ Supported | Equality comparison |
| `Fn::And` | ✅ Supported | Logical AND (2-10 conditions) |
| `Fn::Or` | ✅ Supported | Logical OR (2-10 conditions) |
| `Fn::Not` | ✅ Supported | Logical NOT |
| `Fn::ImportValue` | ✅ Supported | Cross-stack references via S3 state |
| `Fn::GetStackOutput` | ✅ Supported (same-account) | Cross-stack / cross-region output reference via S3 state. Cross-account `RoleArn` is rejected with a clear error (not yet implemented). |
| `Fn::FindInMap` | ✅ Supported | Mapping lookup |
| `Fn::GetAZs` | ✅ Supported | Availability Zone list |
| `Fn::Base64` | ✅ Supported | Base64 encoding |
| `Fn::Cidr` | ✅ Supported | CIDR address block generation |

### Pseudo Parameters

| Parameter | Status |
|-----------|--------|
| `AWS::Region` | ✅ |
| `AWS::AccountId` | ✅ (via STS) |
| `AWS::Partition` | ✅ |
| `AWS::URLSuffix` | ✅ |
| `AWS::NoValue` | ✅ |
| `AWS::StackName` | ✅ |
| `AWS::StackId` | ✅ |

### Resource Provisioning

| Category | Resource Type | Provider | Status |
|----------|--------------|----------|--------|
| **IAM** | AWS::IAM::Role | SDK Provider | ✅ |
| **IAM** | AWS::IAM::Policy | SDK Provider | ✅ |
| **IAM** | AWS::IAM::InstanceProfile | SDK Provider | ✅ |
| **IAM** | AWS::IAM::User | SDK Provider | ✅ |
| **IAM** | AWS::IAM::Group | SDK Provider | ✅ |
| **IAM** | AWS::IAM::UserToGroupAddition | SDK Provider | ✅ |
| **Storage** | AWS::S3::Bucket | SDK Provider | ✅ |
| **Storage** | AWS::S3::BucketPolicy | SDK Provider | ✅ |
| **Messaging** | AWS::SQS::Queue | SDK Provider | ✅ |
| **Messaging** | AWS::SQS::QueuePolicy | SDK Provider | ✅ |
| **Messaging** | AWS::SNS::Topic | SDK Provider | ✅ |
| **Messaging** | AWS::SNS::Subscription | SDK Provider | ✅ |
| **Messaging** | AWS::SNS::TopicPolicy | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::Function | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::Permission | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::Url | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::EventSourceMapping | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::LayerVersion | SDK Provider | ✅ |
| **Database** | AWS::DynamoDB::Table | SDK Provider | ✅ |
| **Monitoring** | AWS::Logs::LogGroup | SDK Provider | ✅ |
| **Monitoring** | AWS::CloudWatch::Alarm | SDK Provider | ✅ |
| **Secrets** | AWS::SecretsManager::Secret | SDK Provider | ✅ |
| **Config** | AWS::SSM::Parameter | SDK Provider | ✅ |
| **Events** | AWS::Events::Rule | SDK Provider | ✅ |
| **Events** | AWS::Events::EventBus | SDK Provider | ✅ |
| **Networking** | AWS::EC2::VPC | SDK Provider | ✅ |
| **Networking** | AWS::EC2::Subnet | SDK Provider | ✅ |
| **Networking** | AWS::EC2::InternetGateway | SDK Provider | ✅ |
| **Networking** | AWS::EC2::VPCGatewayAttachment | SDK Provider | ✅ |
| **Networking** | AWS::EC2::RouteTable | SDK Provider | ✅ |
| **Networking** | AWS::EC2::Route | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SubnetRouteTableAssociation | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SecurityGroup | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SecurityGroupIngress | SDK Provider | ✅ |
| **Networking** | AWS::EC2::NetworkAcl | SDK Provider | ✅ |
| **Networking** | AWS::EC2::NetworkAclEntry | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SubnetNetworkAclAssociation | SDK Provider | ✅ |
| **Compute** | AWS::EC2::Instance | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Account | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Resource | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Deployment | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Stage | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Method | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Authorizer | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Api | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Stage | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Integration | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Route | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Authorizer | SDK Provider | ✅ |
| **CDN** | AWS::CloudFront::CloudFrontOriginAccessIdentity | SDK Provider | ✅ |
| **CDN** | AWS::CloudFront::Distribution | SDK Provider | ✅ |
| **Orchestration** | AWS::StepFunctions::StateMachine | SDK Provider | ✅ |
| **Container** | AWS::ECS::Cluster | SDK Provider | ✅ |
| **Container** | AWS::ECS::TaskDefinition | SDK Provider | ✅ |
| **Container** | AWS::ECS::Service | SDK Provider | ✅ |
| **Load Balancing** | AWS::ElasticLoadBalancingV2::LoadBalancer | SDK Provider | ✅ |
| **Load Balancing** | AWS::ElasticLoadBalancingV2::TargetGroup | SDK Provider | ✅ |
| **Load Balancing** | AWS::ElasticLoadBalancingV2::Listener | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBSubnetGroup | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBCluster | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBInstance | SDK Provider | ✅ |
| **DNS** | AWS::Route53::HostedZone | SDK Provider | ✅ |
| **DNS** | AWS::Route53::RecordSet | SDK Provider | ✅ |
| **Security** | AWS::WAFv2::WebACL | SDK Provider | ✅ |
| **Auth** | AWS::Cognito::UserPool | SDK Provider | ✅ |
| **Cache** | AWS::ElastiCache::CacheCluster | SDK Provider | ✅ |
| **Cache** | AWS::ElastiCache::SubnetGroup | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::PrivateDnsNamespace | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::Service | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::GraphQLApi | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::GraphQLSchema | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::DataSource | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::Resolver | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::ApiKey | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Database | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Table | SDK Provider | ✅ |
| **Encryption** | AWS::KMS::Key | SDK Provider | ✅ |
| **Encryption** | AWS::KMS::Alias | SDK Provider | ✅ |
| **Streaming** | AWS::Kinesis::Stream | SDK Provider | ✅ |
| **Streaming** | AWS::KinesisFirehose::DeliveryStream | SDK Provider | ✅ |
| **Storage** | AWS::EFS::FileSystem | SDK Provider | ✅ |
| **Storage** | AWS::EFS::MountTarget | SDK Provider | ✅ |
| **Storage** | AWS::EFS::AccessPoint | SDK Provider | ✅ |
| **Storage** | AWS::S3Express::DirectoryBucket | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::TableBucket | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::Namespace | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::Table | SDK Provider | ✅ |
| **Storage** | AWS::S3Vectors::VectorBucket | SDK Provider | ✅ |
| **Audit** | AWS::CloudTrail::Trail | SDK Provider | ✅ |
| **CI/CD** | AWS::CodeBuild::Project | SDK Provider | ✅ |
| **AI/ML** | AWS::BedrockAgentCore::Runtime | SDK Provider | ✅ |
| **Custom** | Custom::* (Lambda/SNS-backed) | SDK Provider | ✅ |
| **Other** | All other resource types | Cloud Control | ✅ |

### Other Features

| Feature | Status | Notes |
|---------|--------|-------|
| CloudFormation Parameters | ✅ | Default values, type coercion |
| Conditions | ✅ | With logical operators |
| Cross-stack references | ✅ | Via `Fn::ImportValue` + S3 state |
| Cross-region references | ✅ (same-account) | Via `Fn::GetStackOutput` + S3 state. Cross-account `RoleArn` not yet implemented. |
| JSON Patch updates | ✅ | RFC 6902, minimal patches |
| Resource replacement detection | ✅ | 10+ resource types |
| Dynamic References | ✅ | `{{resolve:secretsmanager:...}}`, `{{resolve:ssm:...}}` |
| DELETE idempotency | ✅ | Not-found errors treated as success |
| Asset publishing (S3) | ✅ | Lambda code packages |
| Asset publishing (ECR) | ✅ | Self-implemented Docker image publishing |
| Custom Resources (SNS-backed) | ✅ | SNS Topic ServiceToken + S3 response |
| Custom Resources (CDK Provider) | ✅ | isCompleteHandler/onEventHandler async pattern detection |
| Rollback | ✅ | --no-rollback flag to skip |
| DeletionPolicy: Retain | ✅ | Skip deletion for retained resources |
| UpdateReplacePolicy: Retain | ✅ | Keep old resource on replacement |
| Implicit delete dependencies | ✅ | VPC/IGW/EventBus/Subnet/RouteTable ordering |
| Stack dependency resolution | ✅ | Auto-deploy dependency stacks, `-e` to skip |
| Multi-stack parallel deploy | ✅ | Independent stacks deployed in parallel |
| Attribute enrichment | ✅ | CloudFront OAI, DynamoDB StreamArn, API Gateway RootResourceId, Lambda FunctionUrl, Route53 HealthCheckId, ECR Repository Arn |
| CC API null value stripping | ✅ | Removes null values before API calls |
| Retry with HTTP status codes | ✅ | 429/503 + cause chain inspection |

## Prerequisites

- **Node.js** >= 20.0.0
- **AWS CDK Bootstrap**: You must run `cdk bootstrap` before using cdkd. cdkd uses CDK's bootstrap bucket (`cdk-hnb659fds-assets-*`) for asset uploads (Lambda code, Docker images). Custom bootstrap qualifiers are supported — CDK embeds the correct bucket/repo names in the asset manifest during synthesis.
- **AWS Credentials**: Configured via environment variables, `~/.aws/credentials`, or `--profile` option

## Installation

### From npm

```bash
npm i -g @go-to-k/cdkd          # latest release
npm i -g @go-to-k/cdkd@0.0.2    # pin to a specific version
```

The installed binary is `cdkd` — run it the same way in either install path.

> cdkd is an experimental / educational project and is not intended for production use — see the warning at the top of this README. Pin to a specific version if you need reproducible installs.

### From source

```bash
git clone https://github.com/go-to-k/cdkd.git
cd cdkd
pnpm install
pnpm run build
npm link
```

If `cdkd` is not found after `npm link`, set an alias in the current shell:

```bash
alias cdkd="node $(pwd)/dist/cli.js"
```

## Quick Start

```bash
# Bootstrap (creates S3 state bucket - only needed once per account/region)
cdkd bootstrap

# List stacks in the CDK app
cdkd list

# Deploy your CDK app
cdkd deploy

# Check what would change
cdkd diff

# Tear down
cdkd destroy
```

That's it. cdkd reads `--app` from `cdk.json` and auto-resolves the state bucket from your AWS account ID (`cdkd-state-{accountId}`). If you bootstrapped under a previous cdkd version, the legacy region-suffixed name (`cdkd-state-{accountId}-{region}`) is still picked up automatically with a deprecation warning.

## Usage

Options like `--app`, `--state-bucket`, and `--context` can be omitted if configured via `cdk.json` or environment variables (`CDKD_APP`, `CDKD_STATE_BUCKET`).

```bash
# Bootstrap (create S3 bucket for state)
cdkd bootstrap \
  --state-bucket my-cdkd-state \
  --region us-east-1

# Synthesize only
cdkd synth --app "npx ts-node app.ts"

# List all stacks in the CDK app (alias: ls)
cdkd list
cdkd ls
cdkd list --long              # YAML records with id/name/environment
cdkd list --long --json       # same, but JSON
cdkd list --show-dependencies # id + dependency list per stack
cdkd list 'MyStage/*'         # filter by display path (CDK CLI parity)

# Deploy from a pre-synthesized cloud assembly directory
cdkd deploy --app cdk.out

# Deploy (single stack auto-detected, reads --app from cdk.json)
cdkd deploy

# Deploy specific stack(s)
cdkd deploy MyStack
cdkd deploy Stack1 Stack2

# Deploy all stacks
cdkd deploy --all

# Deploy with wildcard (matched against the physical CloudFormation stack name)
cdkd deploy 'My*'

# Deploy stacks under a CDK Stage using the hierarchical path (CDK CLI parity)
# Patterns containing '/' are routed to the CDK display path; both forms work:
cdkd deploy 'MyStage/*'        # all stacks under MyStage
cdkd deploy MyStage/Api        # specific stack by display path
cdkd deploy MyStage-Api        # same stack by physical CloudFormation name

# Deploy with context values
cdkd deploy -c env=staging -c featureFlag=true

# Deploy with explicit options
cdkd deploy MyStack \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkd-state \
  --verbose

# Show diff (what would change)
cdkd diff MyStack

# Dry run (plan only, no changes)
cdkd deploy --dry-run

# Deploy with no rollback on failure (Terraform-style)
cdkd deploy --no-rollback

# Deploy only the specified stack (skip dependency auto-inclusion)
cdkd deploy -e MyStack

# Destroy resources
cdkd destroy MyStack
cdkd destroy --all --force

# Force-unlock a stale lock from interrupted deploy
cdkd force-unlock MyStack

# Adopt already-deployed AWS resources into cdkd state.
# See docs/import.md for the full guide (auto / selective / hybrid modes,
# --resource overrides, --resource-mapping CDK CLI compatibility).
cdkd import MyStack --dry-run
cdkd import MyStack --yes

# Inspect state-bucket info on demand (bucket name, region, source, schema version, stack count).
# Routine commands (deploy / destroy / etc.) no longer print the bucket banner by default —
# pass --verbose to surface it in their debug logs, or use this subcommand for an explicit answer.
cdkd state info
cdkd state info --json        # JSON output for tooling
cdkd state info --state-bucket my-bucket  # explicit bucket; reports Source: --state-bucket flag

# List stacks registered in the cdkd state bucket
cdkd state list
cdkd state ls --long          # include resource count, last-modified, lock status
cdkd state list --json        # JSON output (alone, or combined with --long)

# List resources of a single stack from state
cdkd state resources MyStack          # aligned columns: LogicalID, Type, PhysicalID
cdkd state resources MyStack --long   # per-resource block with dependencies and attributes
cdkd state resources MyStack --json   # full JSON array

# Show full state record for a stack (metadata, outputs, all resources incl. properties)
cdkd state show MyStack
cdkd state show MyStack --json        # raw {state, lock} JSON

# Orphan one or more RESOURCES from cdkd's state (does NOT delete AWS resources).
# Per-resource, mirrors aws-cdk-cli's `cdk orphan --unstable=orphan`.
# Synth-driven — needs --app / cdk.json. Construct paths use CDK's L2-style form
# (`<StackName>/<Path/To/Construct>`); the synthesized `/Resource` suffix is
# matched implicitly. Passing an L2 wrapper that contains multiple CFn resources
# orphans every child under it (matches upstream's prefix-match semantics).
cdkd orphan MyStack/MyTable                    # confirmation prompt (y/N)
cdkd orphan MyStack/MyTable --yes
cdkd orphan MyStack/MyTable MyStack/MyBucket   # multiple resources, same stack
cdkd orphan MyStack/MyTable --dry-run          # print rewrite audit, no save
cdkd orphan MyStack/MyTable --force            # also fall back to cached
                                               # attributes when live fetch fails

# State-driven counterpart that orphans a WHOLE STACK's state record
# (no CDK app needed — works against the bucket).
cdkd state orphan MyStack             # confirmation prompt (y/N)
cdkd state orphan MyStack --yes       # skip confirmation
cdkd state orphan StackA StackB --force # also bypass the locked-stack refusal

# Destroy a stack's AWS resources AND remove its state record, without
# requiring the CDK app (no synth — works from any working directory).
cdkd state destroy MyStack            # per-stack confirmation prompt
cdkd state destroy MyStack OtherStack --yes
cdkd state destroy --all -y           # every stack in the bucket
cdkd state destroy MyStack --region us-east-1
```

> **`destroy` vs `orphan`** (matches aws-cdk-cli's new `cdk orphan`):
> `destroy` deletes the AWS resources AND the state record. `orphan` deletes
> ONLY the state record — AWS resources remain intact, just no longer
> tracked by cdkd.
>
> The two `orphan` variants now operate at different granularities:
>
> - `cdkd orphan <constructPath>...` — synth-driven, **per-resource**.
>   Removes specific resources from a stack's state file and rewrites every
>   sibling reference (Ref / Fn::GetAtt / Fn::Sub / dependencies) so the
>   next deploy doesn't re-create the orphan or fail on a stale reference.
>   Mirrors `cdk orphan --unstable=orphan`.
> - `cdkd state orphan <stack>...` — state-driven, **whole-stack**. Removes
>   the entire state record for a stack from the bucket. Works without the
>   CDK app.
>
> `cdkd destroy` (synth-driven, deletes AWS resources + state) and
> `cdkd state destroy` (state-driven, same effect) round out the matrix.

## `--no-wait`: skip async-resource waits

CloudFront Distributions, RDS Clusters/Instances, and ElastiCache
typically take 3–15 minutes for AWS to fully propagate. By default
cdkd waits for them to reach a ready state — the same behavior as
CloudFormation. Pass `--no-wait` to return as soon as the create call
returns:

```bash
cdkd deploy --no-wait
```

The resource is fully functional once AWS finishes the async
deployment in the background. CloudFormation has no equivalent — once
you submit a stack, you wait for everything.

## Other CLI flags

For concurrency knobs (`--concurrency`, `--stack-concurrency`,
`--asset-publish-concurrency`, `--image-build-concurrency`) and
per-resource timeout flags (`--resource-warn-after`,
`--resource-timeout` — including the per-resource-type override syntax
and the rationale for the 30m default), see
**[docs/cli-reference.md](docs/cli-reference.md)**.

## Example

```typescript
const table = new dynamodb.Table(stack, 'Table', {
  partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
});
const fn = new lambda.Function(stack, 'Handler', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  environment: { TABLE_NAME: table.tableName },
});
table.grantReadWriteData(fn);
```

```bash
$ cdkd deploy
LambdaStack
  ServiceRole     CREATE  AWS::IAM::Role             ✓  (2.1s)
  Table           CREATE  AWS::DynamoDB::Table        ✓  (1.8s)
  DefaultPolicy   CREATE  AWS::IAM::Policy            ✓  (1.5s)
  Handler         CREATE  AWS::Lambda::Function       ✓  (3.4s)

✓ Deployed LambdaStack (4 resources, 7.2s)
```

Resources are dispatched as soon as their own dependencies complete (event-driven DAG). ServiceRole and Table run in parallel; DefaultPolicy starts the moment ServiceRole is done — without waiting for Table — and Handler starts the moment DefaultPolicy is done.

## Architecture

Built on modern AWS tooling:

- **Synthesis orchestration** - Executes CDK app as subprocess (synthesis itself is done by aws-cdk-lib), parses Cloud Assembly (manifest.json) directly, context provider loop (missing context → SDK lookup → re-synthesize)
- **Self-implemented asset publisher** - S3 file upload with ZIP packaging (via `archiver`) and ECR Docker image publishing
- **AWS SDK v3** - Direct resource provisioning
- **Cloud Control API** - Fallback resource management for types without SDK Providers
- **S3 Conditional Writes** - State locking via `If-None-Match`/`If-Match`

## Importing existing resources

`cdkd import` adopts AWS resources that are already deployed (via
`cdk deploy`, manual creation, or another tool) into cdkd state so the
next `cdkd deploy` updates them in-place instead of CREATEing duplicates.

```bash
# Adopt a whole stack previously deployed by cdk deploy (tag-based auto-lookup).
cdkd import MyStack --yes

# Adopt only specific resources (CDK CLI parity).
cdkd import MyStack --resource MyBucket=my-bucket-name

# Migrate off CloudFormation in one shot — adopt + retire the source CFn stack.
cdkd import MyStack --migrate-from-cloudformation --yes
```

See **[docs/import.md](docs/import.md)** for the full guide: three import
modes (auto / selective / hybrid), `--resource-mapping` CDK CLI
compatibility, CloudFormation migration flow, provider coverage, and the
parity matrix vs upstream `cdk import`.

## State Management

State is stored in S3 with optimistic locking via S3 Conditional Writes
(no DynamoDB required). Keys are scoped by `(stackName, region)` so the
same stack deployed to two regions has two independent state files.

| Setting | CLI | cdk.json | Env var | Default |
|---------|-----|----------|---------|---------|
| Bucket | `--state-bucket` | `context.cdkd.stateBucket` | `CDKD_STATE_BUCKET` | `cdkd-state-{accountId}` (legacy `cdkd-state-{accountId}-{region}` is still read with a deprecation warning — run `cdkd state migrate` to consolidate) |
| Prefix | `--state-prefix` | - | - | `cdkd` |

The state bucket is shared across all CDK apps in the same account by
default. To isolate apps, pass different `--state-prefix` values.
`cdkd destroy --all` only targets stacks from the current CDK app
(determined by synthesis), not all stacks in the bucket.

See **[docs/state-management.md](docs/state-management.md)** for the full
spec: S3 key layout, optimistic-locking mechanism (ETag-based), state
schema, legacy `version: 1` migration, bucket-name migration via
`cdkd state migrate`, and troubleshooting.

## Stack Outputs

CDK's `CfnOutput` constructs are resolved and stored in the state file:

```typescript
// In your CDK code
new cdk.CfnOutput(this, 'BucketArn', {
  value: bucket.bucketArn,  // Uses Fn::GetAtt internally
  description: 'ARN of the bucket',
});
```

After deployment, outputs are resolved and saved to the S3 state file:

```json
{
  "outputs": {
    "BucketArn": "arn:aws:s3:::actual-bucket-name-xyz"
  }
}
```

**Key differences from CloudFormation**:

- CloudFormation: Outputs accessible via `aws cloudformation describe-stacks`
- cdkd: Outputs saved in S3 state file (e.g., `s3://bucket/cdkd/MyStack/us-east-1/state.json`)
- Both resolve intrinsic functions (Ref, Fn::GetAtt, etc.) to actual values

## Testing

- Unit tests covering all layers
- Integration examples verified with real AWS deployments (see `tests/integration/`)
- E2E test script for automated deploy/diff/update/destroy cycles

```bash
pnpm test                # Run unit tests
pnpm run test:coverage   # With coverage report
```

See [docs/testing.md](docs/testing.md) for integration and E2E testing instructions.

## License

Apache 2.0
