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
   ├── Resolve --state-bucket (CLI > env > cdk.json > auto: cdkd-state-{accountId}-{region})
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

# Deploy your CDK app
cdkd deploy

# Check what would change
cdkd diff

# Tear down
cdkd destroy
```

That's it. cdkd reads `--app` from `cdk.json` and auto-resolves the state bucket from your AWS account ID (`cdkd-state-{accountId}-{region}`).

## Usage

Options like `--app`, `--state-bucket`, and `--context` can be omitted if configured via `cdk.json` or environment variables (`CDKD_APP`, `CDKD_STATE_BUCKET`).

```bash
# Bootstrap (create S3 bucket for state)
cdkd bootstrap \
  --state-bucket my-cdkd-state \
  --region us-east-1

# Synthesize only
cdkd synth --app "npx ts-node app.ts"

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
  --region us-east-1 \
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

# List stacks registered in the cdkd state bucket
cdkd state list
cdkd state ls --long          # include resource count, last-modified, lock status
cdkd state list --json        # JSON output (alone, or combined with --long)
```

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

## State Management

State is stored in S3. Each stack has its own `state.json` and `lock.json`:

```
s3://{state-bucket}/
  └── {prefix}/                     # Default: "cdkd" (configurable via --state-prefix)
      ├── MyStack/
      │   ├── state.json            # Resource state
      │   └── lock.json             # Exclusive deploy lock
      └── AnotherStack/
          ├── state.json
          └── lock.json
```

### Configuration

| Setting | CLI | cdk.json | Env var | Default |
|---------|-----|----------|---------|---------|
| Bucket | `--state-bucket` | `context.cdkd.stateBucket` | `CDKD_STATE_BUCKET` | `cdkd-state-{accountId}-{region}` |
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
  version: 1,
  stackName: "MyStack",
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
- cdkd: Outputs saved in S3 state file (e.g., `s3://bucket/cdkd/MyStack/state.json`)
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
