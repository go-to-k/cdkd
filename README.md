# cdkd

**cdkd** (CDK Direct) - Deploy AWS CDK apps directly via SDK/Cloud Control API, bypassing CloudFormation stacks for faster deployments.

> **⚠️ WARNING: NOT PRODUCTION READY**
>
> This project is in early development and is **NOT suitable for production use**. Features are incomplete, APIs may change without notice, and there may be bugs that could affect your AWS infrastructure. Use at your own risk in development/testing environments only.

> **Note**: This is an experimental/educational project exploring alternative deployment approaches for AWS CDK. It is **not intended to replace** the official AWS CDK CLI, but rather to experiment with direct SDK/Cloud Control API provisioning as a learning exercise and proof of concept.

## Why cdkd?

AWS CDK is great for defining infrastructure as code, but all deployments go through CloudFormation. **cdkd** is an experimental alternative that deploys CDK apps directly via AWS SDK, bypassing CloudFormation entirely:

- **Direct provisioning** via AWS SDK and Cloud Control API
- **No CloudFormation stacks** - no change sets, no stack limits
- **Parallel resource deployment** based on dependency analysis (DAG)
- **100% CDK compatible** - use your existing CDK code as-is

## How cdkd differs from CloudFormation

| | CloudFormation | cdkd |
| --- | --- | --- |
| Stack creation | Required | N/A (no stacks) |
| Change set creation | Required | N/A (direct diff) |
| Resource provisioning | Sequential | Parallel (DAG levels) |
| State management | CloudFormation service | S3 (self-managed) |

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
│ - Parallel Exec │  Deploy by levels
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

## Features

cdkd uses a hybrid provisioning strategy: hand-written **SDK Providers** call AWS SDK APIs directly for fast provisioning, while **Cloud Control API** (a generic AWS API that can operate on any resource type) is used as a fallback for resource types without an SDK Provider.

- **Fast SDK Providers**: Direct synchronous API calls for common resource types
- **Broad resource coverage**: Cloud Control API fallback for additional resource types
- **Hybrid deployment strategy**: SDK Providers preferred for performance, Cloud Control API as fallback
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **Asset handling**: Self-implemented asset publisher for Lambda packages (S3 with ZIP packaging) and Docker images (ECR)

> **Note**: Resource types not covered by either SDK Providers or Cloud Control API cannot be deployed with cdkd. If you encounter an unsupported resource type, deployment will fail with a clear error message.

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

```bash
git clone https://github.com/goto-bus-stop/cdkd.git
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

# Deploy (single stack auto-detected, reads --app from cdk.json)
cdkd deploy

# Deploy specific stack(s)
cdkd deploy MyStack
cdkd deploy Stack1 Stack2

# Deploy all stacks
cdkd deploy --all

# Deploy with wildcard
cdkd deploy 'My*'

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
```

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

Resources without dependencies (ServiceRole and Table) are created in parallel.

## Architecture

Built on modern AWS tooling:

- **Self-implemented synthesis** - Subprocess execution of CDK app + Cloud Assembly (manifest.json) direct parsing + context provider loop (missing context → SDK lookup → re-synthesize)
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
