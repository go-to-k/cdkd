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

### Detailed Processing Flow (`cdkd deploy`)

```
1. CLI Layer
   ├── Resolve --app (CLI > CDKD_APP env > cdk.json "app")
   ├── Resolve --state-bucket (CLI > env > cdk.json > auto: cdkd-state-{accountId}, with legacy fallback to cdkd-state-{accountId}-{region})
   └── Initialize AWS clients

2. Synthesis (self-implemented, no CDK CLI dependency)
   ├── Short-circuit: if --app is an existing directory, treat it as a
   │   pre-synthesized cloud assembly and skip the steps below
   ├── Load context (merge order, later wins):
   │   ├── CDK defaults (path-metadata, asset-metadata, version-reporting, bundling-stacks)
   │   ├── ~/.cdk.json "context" field (user defaults)
   │   ├── cdk.json "context" field (project settings)
   │   ├── cdk.context.json (cached lookups, reloaded each iteration)
   │   └── CLI -c key=value (highest priority)
   ├── Execute CDK app as subprocess
   │   ├── child_process.spawn(app command)
   │   ├── Pass env: CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION/ACCOUNT
   │   └── App writes Cloud Assembly to cdk.out/
   ├── Parse cdk.out/manifest.json
   │   ├── Extract stacks (type: aws:cloudformation:stack)
   │   ├── Extract asset manifests (type: cdk:asset-manifest)
   │   └── Extract stack dependencies
   └── Context provider loop (if missing context detected):
       ├── Resolve via AWS SDK (all CDK context provider types supported)
       ├── Save to cdk.context.json
       └── Re-execute CDK app with updated context

3. Asset Publishing + Deployment (WorkGraph DAG)
   ├── Each asset is a node, each stack deploy is a node
   │   ├── asset-publish nodes: 8 concurrent (file S3 uploads + Docker build+push)
   │   ├── stack nodes: 4 concurrent deployments
   │   ├── Dependencies: asset-publish → stack (all assets complete before deploy)
   │   └── Inter-stack: stack A → stack B (CDK dependency order)
   ├── Region resolved from asset manifest destination (stack's target region)
   ├── Skip if already exists (HeadObject for S3, DescribeImages for ECR)
   ├── Per-stack deploy flow:
   │   ├── Acquire S3 lock (optimistic locking)
   │   ├── Load current state from S3
   │   ├── Build DAG from template (Ref/Fn::GetAtt/DependsOn)
   │   ├── Calculate diff (CREATE/UPDATE/DELETE)
   │   ├── Resolve intrinsic functions (Ref, Fn::Sub, Fn::Join, etc.)
   │   ├── Execute via event-driven DAG dispatch (a resource starts as
   │   │   soon as ALL of its own deps complete; no level barrier):
   │   │   ├── SDK Providers (direct API calls, preferred)
   │   │   └── Cloud Control API (fallback, async polling)
   │   ├── Save state after each successful resource (partial state save)
   │   └── Release lock
   └── synth does NOT publish assets or deploy (deploy only)
```

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
# See "Importing existing resources" below for the full guide (auto / selective /
# hybrid modes, --resource overrides, --resource-mapping CDK CLI compatibility).
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
# Synth-driven — needs --app / cdk.json. Construct paths look like the CDK
# `aws:cdk:path` tag (`<StackName>/<Path/To/Resource>`).
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

### Concurrency Options

| Option | Default | Description |
| --- | --- | --- |
| `--concurrency` | 10 | Maximum concurrent resource operations per stack |
| `--stack-concurrency` | 4 | Maximum concurrent stack deployments |
| `--asset-publish-concurrency` | 8 | Maximum concurrent asset publish operations (S3 + ECR push) |
| `--image-build-concurrency` | 4 | Maximum concurrent Docker image builds |

## `--no-wait`

By default, cdkd waits for async resources (CloudFront Distribution, RDS Cluster/Instance, ElastiCache) to reach a ready state before completing — the same behavior as CloudFormation.

Use `--no-wait` to skip this and return immediately after resource creation:

```bash
cdkd deploy --no-wait
```

This can significantly speed up deployments with CloudFront (which takes 3-15 minutes to deploy to edge locations). The resource is fully functional once AWS finishes the async deployment.

## Per-resource timeout

Both `cdkd deploy` and `cdkd destroy` (including `cdkd state destroy`) enforce a wall-clock deadline on every individual CREATE / UPDATE / DELETE so a stuck Cloud Control polling loop, hung Custom Resource handler, or slow ENI release cannot block the run forever.

| Option | Default | Description |
| --- | --- | --- |
| `--resource-warn-after <duration_or_type=duration>` | `5m` | Warn when a single resource operation has been running longer than this. The live progress line is suffixed with `[taking longer than expected, Nm+]` and a `WARN` log line is emitted (printed above the live area in TTY mode, plain stderr otherwise). Repeatable. |
| `--resource-timeout <duration_or_type=duration>` | `30m` | Abort a single resource operation that exceeds this. The deploy / destroy fails with `ResourceTimeoutError` (wrapped in `ProvisioningError`) and the existing rollback / state-preservation path runs. Repeatable. |

Durations are written as `<number>s`, `<number>m`, or `<number>h` (e.g. `30s`, `90s`, `5m`, `1.5h`). Zero, negative, missing-unit, and unknown-unit values are rejected at parse time.

Both flags accept either form on each invocation:

- **Bare duration** (`30m`) sets the global default. The last bare value wins.
- **`TYPE=DURATION`** (`AWS::CloudFront::Distribution=1h`) adds a per-resource-type override that supersedes the global default for that type only.

`TYPE` must look like `AWS::Service::Resource`; malformed types are rejected at parse time. `warn < timeout` is enforced both globally and per-type — so `--resource-warn-after AWS::X=10m --resource-timeout AWS::X=5m` is a parse-time error.

```bash
# Surface "still running" warnings sooner on a fast-feedback dev loop
cdkd deploy --resource-warn-after 90s --resource-timeout 10m

# Keep the global default tight, raise it only for resources known to take longer
cdkd deploy \
  --resource-timeout 30m \
  --resource-timeout AWS::CloudFront::Distribution=1h \
  --resource-timeout AWS::RDS::DBCluster=1h30m

# Force Custom Resources to abort earlier than their 1h self-reported polling cap
cdkd deploy --resource-timeout AWS::CloudFormation::CustomResource=5m
```

### Why the default is 30m, not 1h

cdkd's Custom Resource provider polls async handlers (`isCompleteHandler` pattern) for up to one hour before giving up. Setting the per-resource timeout to 1h by default would make a single hung non-CR resource hold the whole stack for an hour even though no other resource type ever needs more than a few minutes. The 30m global default catches stuck operations faster.

For Custom Resources specifically, the provider self-reports its 1h polling cap to the engine via the `getMinResourceTimeoutMs()` interface — the deploy engine resolves the per-resource budget as `max(provider self-report, --resource-timeout global)`, so CR resources get their full hour automatically without the user having to remember `--resource-timeout 1h`. To force CR to abort earlier than its self-reported cap, pass an explicit per-type override (`--resource-timeout AWS::CloudFormation::CustomResource=5m`). Per-type overrides always win over the provider's self-report — they're the documented escape hatch.

The error message on timeout names the resource, type, region, elapsed time, and operation, and reminds you that long-running resources self-report their needed budget — when you see CR time out, the cause is genuinely the handler, not too-tight a default:

```text
Resource MyBucket (AWS::S3::Bucket) in us-east-1 timed out after 30m during CREATE (elapsed 30m).
This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or
slow ENI provisioning. Re-run with --resource-timeout AWS::S3::Bucket=<DURATION>
to bump the budget for this resource type only, or --verbose to see the
underlying provider activity.
```

Note: `--resource-warn-after` must be less than `--resource-timeout`. Reversed values are rejected at parse time.

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

`cdkd import` adopts AWS resources that are already deployed (e.g. via
`cdk deploy`, manual creation, or another tool) into cdkd state, so the
next `cdkd deploy` updates them in-place instead of trying to CREATE
duplicates.

It reads the CDK app to find logical IDs, resource types, and
dependencies, then matches each logical ID to a real AWS resource in
one of three modes:

All examples below assume cdkd reads the CDK app command from `cdk.json`
(the typical case). Pass `--app "<command>"` only if you're running cdkd
outside the CDK project directory or want to override `cdk.json`.

### Mode 1: auto (default — no flags)

```bash
cdkd import MyStack
```

Imports **every** resource in the synthesized template by tag. cdkd
looks up each resource using its `aws:cdk:path` tag (which CDK
automatically writes), so resources deployed by `cdk deploy` are found
without any manual work. Useful for **adopting a whole stack** that was
previously deployed by `cdk deploy`. This is cdkd's value-add over
`cdk import` — CDK CLI does not have a tag-based bulk-import mode.

### Mode 2: selective (CDK CLI parity — when explicit overrides are given)

```bash
# Import ONLY MyBucket; the other resources in the template are left alone.
cdkd import MyStack --resource MyBucket=my-bucket-name

# Several resources at once (--resource is repeatable).
cdkd import MyStack \
  --resource MyBucket=my-bucket-name \
  --resource MyFn=my-function-name

# CDK CLI compat: read overrides from a JSON file.
cdkd import MyStack --resource-mapping mapping.json
# mapping.json: { "MyBucket": "my-bucket-name", "MyFn": "my-function-name" }

# CDK CLI compat: inline JSON (handy for non-TTY CI scripts).
cdkd import MyStack --resource-mapping-inline '{"MyBucket":"my-bucket-name"}'

# Capture cdkd's resolved logicalId→physicalId mapping for re-use.
# Combine with --auto (or no flags) to record the tag-based lookups.
cdkd import MyStack --record-resource-mapping ./mapping.json
# mapping.json after the run: { "MyBucket": "my-bucket-name", ... }
# Replay non-interactively in CI:
cdkd import MyStack --resource-mapping ./mapping.json --yes
```

When at least one `--resource` flag (or a `--resource-mapping` /
`--resource-mapping-inline` payload) is supplied, **only the listed
resources are imported**. Every other resource in the template is
reported as `out of scope` and left out of state — the next `cdkd
deploy` will treat them as new and CREATE them. This matches the
semantics of `cdk import --resource-mapping` /
`--resource-mapping-inline`. cdkd validates that every override key is
a real logical ID in the template; a typo aborts the run rather than
silently importing nothing. `--resource-mapping` and
`--resource-mapping-inline` are mutually exclusive — pick one source.

Use selective mode when you want to **adopt a few specific resources**
out of a larger stack — for example, you have one S3 bucket that was
created manually that you want cdkd to manage, while the rest of the
stack will be deployed fresh.

### Mode 3: hybrid (`--auto` with overrides)

```bash
cdkd import MyStack \
  --resource MyBucket=my-bucket-name \
  --auto
```

Listed resources use the explicit physical ID you supplied; **every
other resource still goes through tag-based auto-import**. Useful when
you have one resource whose tag-based lookup is unreliable (e.g. you
deleted and re-created it without the tag) but you want cdkd to find
the rest by tag automatically.

### Common flags

| Flag        | Purpose                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `--dry-run` | Preview what would be imported. State is NOT written.                         |
| `--yes`     | Skip the confirmation prompt before writing state.                            |
| `--force`   | Overwrite an existing state record. Without this, existing state aborts.      |

### After import

Run `cdkd diff` to see how the imported state lines up with the
template. If the resource's actual properties differ from the template,
the next `cdkd deploy` will UPDATE them to match. If you imported only
some resources (selective mode), the remaining template resources
appear as `to create` in the diff.

### Provider support

Tag-based auto-lookup is implemented for the most-used resource types
(S3 Bucket, Lambda Function, IAM Role, SNS Topic, SQS Queue, DynamoDB
Table, Logs LogGroup, EventBridge EventBus, KMS Key/Alias, Secrets
Manager Secret, SSM Parameter, EC2 VPC/Subnet/SecurityGroup, RDS,
ECS Cluster/Service/TaskDefinition, CloudFront Distribution, Cognito
User Pool — the full list is in [CLAUDE.md](CLAUDE.md)). For resource
types without auto-lookup support (ApiGateway sub-resources, niche
services, anything in Cloud Control API), use the explicit
`--resource <id>=<physicalId>` override mode — selective mode handles
exactly this case. Resource types whose provider does not implement
import are reported as `unsupported` and skipped.

### `cdkd import` vs upstream `cdk import`

cdkd's `import` command mirrors the surface of upstream
[`cdk import`](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-import.html)
where it can, but the underlying mechanism is fundamentally different
and a handful of upstream-only flags are not implemented. Use this
table to predict behavior when migrating from `cdk import`.

| Topic | `cdk import` (upstream) | `cdkd import` |
| --- | --- | --- |
| Mechanism | CloudFormation `CreateChangeSet` with `ResourcesToImport` — atomic, all-or-nothing. | Per-resource SDK calls (e.g. `s3:HeadBucket`, `lambda:GetFunction`, IAM `ListRoleTags`). **Not atomic.** |
| Failure mode | Failed import rolls the changeset back; the stack is left unchanged. | Per-resource: `imported` / `skipped-not-found` / `skipped-no-impl` / `skipped-out-of-scope` / `failed` rows are summarized. State is written for whatever succeeded — but only after a confirmation prompt (or `--yes`), so a partial run is opt-in. To roll a partial import back, use `cdkd state orphan <stack>` (drops the state record only). |
| Selective mode (`--resource-mapping <file>`) | Supported. Listed resources are imported; unlisted resources cause the changeset to fail. | Supported. Listed resources are imported; unlisted resources are reported as `out of scope` and left out of state (next `cdkd deploy` will CREATE them). |
| Selective mode (`--resource <id>=<physical>` repeatable) | Not supported (upstream uses interactive prompts or a mapping file). | Supported as cdkd's CLI-friendly equivalent. |
| `--resource-mapping-inline '<json>'` | Supported (use in non-TTY environments). | Supported. Same shape as `--resource-mapping <file>` but supplied as a string — useful for non-TTY CI scripts that do not want a separate file. Mutually exclusive with `--resource-mapping`. |
| `--record-resource-mapping <file>` | Supported (writes the mapping the user typed at the prompt to a file for re-use). | Supported. Writes the resolved `{logicalId: physicalId}` map (covers explicit overrides AND cdkd's tag-based auto-lookup) to the file before the confirmation prompt. The file is produced even if the user says "no" or under `--dry-run`, so the resolved data is never thrown away. |
| Interactive prompt for missing IDs | Default in TTY — prompts for every resource not covered by a mapping file. | **Not supported.** cdkd is non-interactive: missing logical IDs are looked up by `aws:cdk:path` tag in `auto` / `hybrid` modes, or skipped as `out of scope` in selective mode. The only prompt is the final "write state?" confirmation, which `--yes` skips. |
| Typo'd logical ID | Aborts with a clear error before any AWS calls. | Aborts with a clear error before any AWS calls — checked against the synthesized template. |
| Whole-stack tag-based import | **Not supported.** | **cdkd-specific.** With no flags, cdkd looks every resource up by its `aws:cdk:path` tag — the typical case for adopting a stack previously deployed by `cdk deploy`. |
| Hybrid mode (overrides + tag fallback) | **Not supported.** | **cdkd-specific.** `--auto` together with `--resource` lets listed resources use the explicit physical id while everything else still goes through tag lookup. |
| Nested stacks (`AWS::CloudFormation::Stack`) | Explicitly unsupported. | Also unsupported in practice — cdkd does not deploy nested CloudFormation stacks at all (no `AWS::CloudFormation::Stack` provider). The `Stack` resource itself would be reported as `unsupported`. CDK Stages (separate top-level stacks) are fine: pass the stack's display path or physical name as the positional argument. |
| Bootstrap requirement | Bootstrap v12+ (deploy role needs to read the encrypted staging bucket). | cdkd's own state bucket; no CDK bootstrap version requirement. |
| Resource-type coverage | Whatever [CloudFormation supports for import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html). | The set of cdkd providers that implement `import()` (see [CLAUDE.md](CLAUDE.md) for the current list). For any other CC-API-supported type, use `--resource <id>=<physical>` to drive the Cloud Control API fallback. The two lists overlap heavily but are not identical. |
| Confirmation prompt before writing state | n/a (CloudFormation operates atomically). | Yes — cdkd asks before writing the state file. Skip with `--yes`. |
| `--force` | "Continue even if the diff includes updates or deletions" — about diff strictness. | "Overwrite an existing state record" — about state safety. **Same flag name, different meaning.** |
| `--dry-run` | Implied by `--no-execute` (creates the changeset without executing). | Native: shows the import plan and exits without writing state. |

#### Practical implications when migrating from `cdk import`

- If you script around `--resource-mapping <file>`: behavior matches.
  The file format (`{"LogicalId": "physical-id"}`) is the same.
- If you script around `--resource-mapping-inline`: behavior matches.
  The JSON shape is the same as `--resource-mapping <file>`.
- If you script around `--record-resource-mapping <file>`: behavior
  matches. cdkd writes the resolved `{logicalId: physicalId}` map to
  the file before the confirmation prompt — and even if the user says
  "no" or under `--dry-run` — so you can capture cdkd's tag-based
  auto-lookup result and replay it via `--resource-mapping` in CI.
- If your workflow relies on the interactive prompt: rewrite as
  `--resource-mapping <file>`. cdkd will not prompt.
- If you rely on atomic rollback: cdkd cannot offer that — its
  per-resource model writes state only after the full pass completes
  (and after confirmation), so a partial run is bounded, but if a
  later resource fails after several earlier ones already returned
  successfully and you confirm the write, those earlier ones are
  in cdkd state. Use `cdkd state orphan <stack>` to back out.
- If you import nested stacks: neither tool supports this. Convert
  to top-level CDK stacks first.

## State Management

State is stored in S3. Keys are scoped by `(stackName, region)` so the same
stack name deployed to two regions has two independent state files:

```
s3://{state-bucket}/
  └── {prefix}/                     # Default: "cdkd" (configurable via --state-prefix)
      ├── MyStack/
      │   └── us-east-1/
      │       ├── state.json        # Resource state (version: 2)
      │       └── lock.json         # Exclusive deploy lock
      └── AnotherStack/
          ├── us-east-1/
          │   ├── state.json
          │   └── lock.json
          └── us-west-2/             # same stackName, different region
              ├── state.json
              └── lock.json
```

> **Caveat: same `stackName` in multiple regions becomes visible after
> `env.region` changes.** Before this layout shipped, changing a stack's
> `env.region` between deploys silently overwrote the prior region's state
> and `cdkd destroy` ran against the wrong region. cdkd now treats the two
> regions as independent. Use `cdkd state list` to see both, and
> `cdkd state orphan <stack> --stack-region <region>` to prune one without
> touching the other.
>
> **Legacy key-layout migration (within the same bucket):** state files
> written by cdkd before this layout (`version: 1`, flat
> `cdkd/{stackName}/state.json`) are still readable. The next cdkd write
> auto-migrates to the new region-prefixed key
> (`cdkd/{stackName}/{region}/state.json`) and removes the legacy file —
> no manual action required. An older cdkd binary reading a `version: 2`
> file fails with a clear "upgrade cdkd" error rather than silently
> mishandling it.
>
> Note: this only covers the **key layout inside an existing state
> bucket**. The separate **bucket-name migration** (legacy
> `cdkd-state-{accountId}-{region}` → new `cdkd-state-{accountId}`)
> is described below and does NOT auto-migrate.

### Bucket migration

The default state-bucket name changed in v0.11.0 from the region-suffixed
`cdkd-state-{accountId}-{region}` to the region-free
`cdkd-state-{accountId}`. The bucket name is region-free because S3 names
are globally unique, so teammates with different profile regions all
converge on the same bucket; the bucket's actual region is auto-detected
via `GetBucketLocation`.

Existing users keep working without doing anything: when only the legacy
bucket exists, cdkd transparently falls back to it and emits a
deprecation warning. To stop the warning (and consolidate state into the
new bucket) run:

```bash
# Per-region: copies all objects from cdkd-state-{accountId}-{region}
# into cdkd-state-{accountId}. Source bucket is kept by default.
cdkd state migrate --region us-east-1

# Optional: delete the legacy bucket once the copy is verified.
cdkd state migrate --region us-east-1 --remove-legacy
```

This migration is **account-wide / per-region**, not per-stack — running
it once per region clears the legacy bucket for that region in one shot.
For multi-region accounts, run it once per region (each invocation copies
into the same destination bucket).

`cdkd state migrate` refuses to run while any stack has an active
`lock.json` (an in-flight `cdkd deploy` / `destroy` would race the copy),
verifies object-count parity between source and destination before any
source cleanup, and only deletes the legacy bucket when
`--remove-legacy` is passed.

See the [Configuration](#configuration) table below for the full
precedence rules of the `--state-bucket` flag and its env-var / cdk.json
fallbacks.

### Configuration

| Setting | CLI | cdk.json | Env var | Default |
|---------|-----|----------|---------|---------|
| Bucket | `--state-bucket` | `context.cdkd.stateBucket` | `CDKD_STATE_BUCKET` | `cdkd-state-{accountId}` (legacy `cdkd-state-{accountId}-{region}` is still read with a deprecation warning) |
| Prefix | `--state-prefix` | - | - | `cdkd` |

### Multi-app isolation

The state bucket is shared across all CDK apps in the same account/region by default. To isolate apps, use different prefixes:

```bash
# App A
cdkd deploy --state-prefix app-a

# App B
cdkd deploy --state-prefix app-b
```

> **Note**: `cdkd destroy --all` only targets stacks from the current CDK app (determined by synthesis), not all stacks in the bucket.

State schema:

```typescript
{
  version: 2,
  stackName: "MyStack",
  region: "us-east-1",
  resources: {
    "MyFunction": {
      physicalId: "arn:aws:lambda:...",
      resourceType: "AWS::Lambda::Function",
      properties: { ... },
      attributes: { Arn: "...", ... },  // For Fn::GetAtt
      dependencies: ["MyBucket"]         // For proper deletion order
    }
  },
  outputs: { ... },
  lastModified: 1234567890
}
```

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
