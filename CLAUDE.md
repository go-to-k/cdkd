# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**cdkd** (CDK Direct) is an experimental project that deploys AWS CDK applications directly via AWS SDK/Cloud Control API without going through CloudFormation. It aims to eliminate CloudFormation overhead and achieve faster deployments.

**Important Notes**:

- NOT recommended for production use (development/testing environments only)
- Educational and experimental project
- NOT intended as a replacement for the official AWS CDK CLI

## Architecture Overview

cdkd has a 7-layer system architecture:

```
┌─────────────────────────────────────────────┐
│ 1. CLI Layer (src/cli/)                     │ → Command-line interface
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ 2. Synthesis Layer (src/synthesis/)         │ → CDK app → CFn template conversion
└────────────────┬────────────────────────────┘
                 ▼
        ┌────────┴────────┐
        ▼                 ▼
┌──────────────┐  ┌──────────────────────────┐
│ 3. Assets    │  │ 4. Analysis Layer        │ → Dependency analysis (DAG building)
│    Layer     │  │    (src/analyzer/)       │    Template parsing
│ (src/assets/)│  └──────────┬───────────────┘
└──────────────┘             ▼
                 ┌────────────────────────────┐
                 │ 5. State Layer             │ → S3-based state management
                 │    (src/state/)            │    Optimistic locking
                 └────────────┬───────────────┘
                              ▼
                 ┌────────────────────────────┐
                 │ 6. Deployment Layer        │ → Deployment orchestration
                 │    (src/deployment/)       │    Parallel execution, diff detection
                 └────────────┬───────────────┘
                              ▼
                 ┌────────────────────────────┐
                 │ 7. Provisioning Layer      │ → Resource create/update/delete
                 │    (src/provisioning/)     │    SDK Providers + CC API fallback
                 └────────────────────────────┘
```

### Key Architectural Decisions

1. **Hybrid Provisioning Strategy**
   - Preferred: SDK Providers for common resource types - direct synchronous API calls, no polling overhead
   - Fallback: Cloud Control API for additional resource types (requires async polling)
   - Implemented with Provider Registry pattern

2. **S3-based State Management**
   - No DynamoDB required
   - Optimistic locking via S3 Conditional Writes (`If-None-Match`, `If-Match`)
   - State structure: `s3://bucket/stacks/{stackName}/state.json`
   - Lock structure: `s3://bucket/stacks/{stackName}/lock.json`

3. **DAG-based Parallel Execution**
   - Analyzes dependencies via `Ref` / `Fn::GetAtt`
   - Determines execution order with topological sort
   - Executes resources in parallel by level (resources without dependencies run concurrently)

4. **Intrinsic Function Resolution**
   - All CloudFormation intrinsic functions supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`, `Fn::FindInMap`, `Fn::Base64`, `Fn::GetAZs`

## Build and Test Commands

```bash
# Build (using esbuild)
npm run build

# Watch mode (for development)
npm run dev

# Test (using Vitest)
npm test
npm run test:ui         # UI mode
npm run test:coverage   # Coverage

# Lint/Format
npm run lint
npm run lint:fix
npm run format
npm run format:check

# Type check
npm run typecheck
```

## Key Files and Directories

### Core Directories

- **src/cli/** - CLI command implementations (deploy, destroy, diff, synth, bootstrap, force-unlock), config resolution
- **src/synthesis/** - CDK app synthesis (using @aws-cdk/toolkit-lib)
- **src/analyzer/** - DAG builder, template parser, intrinsic function resolution
- **src/state/** - S3 state backend, lock manager
- **src/deployment/** - DeployEngine (orchestration)
- **src/provisioning/** - Provider registry, Cloud Control provider, SDK providers
- **src/assets/** - Asset publisher (Lambda code, Docker images)

### Important Files

- **src/cli/config-loader.ts** - Config resolution (cdk.json, env vars for `--app` and `--state-bucket`)
- **src/provisioning/register-providers.ts** - Shared provider registration (called from deploy.ts and destroy.ts)
- **src/types/** - Type definitions (config, state, resources, etc.)
- **src/utils/** - Logger, error handler, AWS client factory
- **build.mjs** - esbuild build script (ESM modules)
- **vitest.config.ts** - Vitest configuration

### SDK Providers

Currently implemented SDK Providers (`src/provisioning/providers/`):

- `iam-role-provider.ts` - AWS::IAM::Role
- `iam-policy-provider.ts` - AWS::IAM::Policy
- `s3-bucket-provider.ts` - AWS::S3::Bucket
- `s3-bucket-policy-provider.ts` - AWS::S3::BucketPolicy
- `sqs-queue-provider.ts` - AWS::SQS::Queue
- `sqs-queue-policy-provider.ts` - AWS::SQS::QueuePolicy
- `sns-topic-provider.ts` - AWS::SNS::Topic
- `sns-subscription-provider.ts` - AWS::SNS::Subscription
- `sns-topic-policy-provider.ts` - AWS::SNS::TopicPolicy
- `lambda-function-provider.ts` - AWS::Lambda::Function
- `lambda-permission-provider.ts` - AWS::Lambda::Permission
- `lambda-url-provider.ts` - AWS::Lambda::Url
- `lambda-eventsource-provider.ts` - AWS::Lambda::EventSourceMapping
- `lambda-layer-provider.ts` - AWS::Lambda::LayerVersion
- `dynamodb-table-provider.ts` - AWS::DynamoDB::Table
- `logs-loggroup-provider.ts` - AWS::Logs::LogGroup
- `cloudwatch-alarm-provider.ts` - AWS::CloudWatch::Alarm
- `secretsmanager-secret-provider.ts` - AWS::SecretsManager::Secret
- `ssm-parameter-provider.ts` - AWS::SSM::Parameter
- `eventbridge-rule-provider.ts` - AWS::Events::Rule
- `eventbridge-bus-provider.ts` - AWS::Events::EventBus
- `iam-instance-profile-provider.ts` - AWS::IAM::InstanceProfile
- `ec2-provider.ts` - AWS::EC2::VPC, Subnet, InternetGateway, VPCGatewayAttachment, RouteTable, Route, SubnetRouteTableAssociation, SecurityGroup, SecurityGroupIngress, Instance
- `apigateway-provider.ts` - AWS::ApiGateway::Account, Authorizer, Resource, Deployment, Stage, Method
- `apigatewayv2-provider.ts` - AWS::ApiGatewayV2::Api, Stage, Integration, Route, Authorizer
- `cloudfront-oai-provider.ts` - AWS::CloudFront::CloudFrontOriginAccessIdentity
- `cloudfront-distribution-provider.ts` - AWS::CloudFront::Distribution
- `stepfunctions-provider.ts` - AWS::StepFunctions::StateMachine
- `ecs-provider.ts` - AWS::ECS::Cluster, TaskDefinition, Service
- `elbv2-provider.ts` - AWS::ElasticLoadBalancingV2::LoadBalancer, TargetGroup, Listener
- `rds-provider.ts` - AWS::RDS::DBSubnetGroup, DBCluster, DBInstance
- `route53-provider.ts` - AWS::Route53::HostedZone, RecordSet
- `wafv2-provider.ts` - AWS::WAFv2::WebACL
- `cognito-provider.ts` - AWS::Cognito::UserPool
- `elasticache-provider.ts` - AWS::ElastiCache::CacheCluster, SubnetGroup
- `servicediscovery-provider.ts` - AWS::ServiceDiscovery::PrivateDnsNamespace, Service
- `agentcore-runtime-provider.ts` - AWS::BedrockAgentCore::Runtime
- `custom-resource-provider.ts` - Custom::* (Lambda/SNS-backed, CDK Provider framework with isCompleteHandler/onEventHandler async pattern)

SDK Providers are preferred over Cloud Control API for performance -- they make direct synchronous API calls with no polling overhead. Cloud Control API is used as a fallback for resource types without an SDK Provider.

## State Schema

```typescript
interface StackState {
  version: number;
  stackName: string;
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  lastModified: number;
}

interface ResourceState {
  physicalId: string;           // AWS physical ID
  resourceType: string;         // e.g., "AWS::S3::Bucket"
  properties: Record<string, any>;
  attributes: Record<string, any>;  // For Fn::GetAtt resolution
  dependencies: string[];       // For proper deletion order
}
```

## Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>): Promise<ResourceCreateResult>;
  update(physicalId: string, logicalId: string, resourceType: string, oldProperties: Record<string, unknown>, newProperties: Record<string, unknown>): Promise<void>;
  delete(physicalId: string, logicalId: string, resourceType: string, properties: Record<string, unknown>): Promise<void>;
  getAttribute(physicalId: string, logicalId: string, resourceType: string, attributeName: string): Promise<any>;
}
```

Register Provider for each resource type in Provider Registry:

```typescript
const registry = ProviderRegistry.getInstance();
registry.register('AWS::IAM::Role', new IAMRoleProvider());
```

## Important Implementation Details

### 1. ESM Modules

- `package.json` specifies `"type": "module"`
- All imports must include `.js` extension (even in TypeScript)

  ```typescript
  import { foo } from './bar.js';  // ✅ Correct
  import { foo } from './bar';     // ❌ Wrong
  ```

### 2. Build System (esbuild)

- Uses esbuild in `build.mjs`
- CDK libraries are externalized (placed in dependencies)
- graphlib has special handling for ESM compatibility

### 3. CLI Configuration Resolution

- `--app` is optional: falls back to `CDKD_APP` env var, then `cdk.json` `"app"` field
- `--state-bucket` is optional: falls back to `CDKD_STATE_BUCKET` env var, then `cdk.json` `context.cdkd.stateBucket`
- `--context` / `-c` is optional: accepts `key=value` pairs (repeatable), merged with cdk.json context (CLI takes precedence)
- Stack names are positional arguments: `cdkd deploy MyStack` (not `--stack-name`)
- `--all` flag targets all stacks for deploy/diff/destroy (`destroy --all` only targets stacks from the current CDK app via synthesis)
- Wildcard support: `cdkd deploy 'My*'`
- Single stack auto-detected (no stack name needed)
- Implemented in `src/cli/config-loader.ts`

### 4. Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- ResponseURL uses S3 pre-signed URL for cfn-response handlers
- CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection
- Async CRUD with polling (max 1hr), pre-signed URL validity 2hr
- Implemented in `CustomResourceProvider`

### 5. Asset Publishing

- Uses `@aws-cdk/cdk-assets-lib`
- Publishes Lambda code packages to S3/ECR
- Implemented in `AssetsPublisher` class

### 6. Intrinsic Function Resolution

- Implemented in `IntrinsicResolver` class (`src/analyzer/intrinsic-resolver.ts`)
- Ref: References other resource's PhysicalId
- Fn::GetAtt: Gets resource attributes (from state.attributes)
- Fn::Join: String concatenation
- Fn::Sub: Template string substitution

### 7. Dependency Analysis

- Implemented in `DagBuilder` class (`src/analyzer/dag-builder.ts`)
- Scans template to detect `Ref` / `Fn::GetAtt` / `DependsOn`
- Builds DAG with graphlib
- Determines execution order with topological sort

## Testing Strategy

### Unit Tests

- `tests/unit/**/*.test.ts`
- Uses Vitest
- Mocking: Mock AWS SDK with vi.mock()

### Integration Tests

- `tests/integration/**`
- Uses actual AWS account
- Environment variables: `STATE_BUCKET`, `AWS_REGION`
- Examples verified with real AWS deployments (see `tests/integration/` for full list)

### UPDATE Testing

- Environment variable `CDKD_TEST_UPDATE=true` enables UPDATE test mode
- Example: `tests/integration/basic/lib/basic-stack.ts`
- Allows testing UPDATE operations without modifying code
- JSON Patch (RFC 6902) verified working for S3, Lambda, IAM resources

## Common Development Tasks

### Adding a New SDK Provider

1. Create new file in `src/provisioning/providers/`
2. Implement `ResourceProvider` interface
3. Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function
4. Write tests

See [docs/provider-development.md](docs/provider-development.md) for details.

### Supporting a New Intrinsic Function

1. Extend `resolve()` method in `src/analyzer/intrinsic-resolver.ts`
2. Implement recursive resolution
3. Write tests (`tests/unit/analyzer/intrinsic-resolver.test.ts`)

### Debugging Deploy Flow

1. Use `--verbose` flag
2. Check log level (`src/utils/logger.ts`)
3. Check State file: `aws s3 cp s3://bucket/stacks/{stackName}/state.json -`
4. See [docs/troubleshooting.md](docs/troubleshooting.md)

## Detailed Documentation

**Always refer to these documents**:

- **[docs/architecture.md](docs/architecture.md)** - Detailed architecture, deploy flows, design principles
- **[docs/state-management.md](docs/state-management.md)** - S3 state structure, locking mechanism, troubleshooting
- **[docs/provider-development.md](docs/provider-development.md)** - Provider implementation guide, best practices
- **[docs/troubleshooting.md](docs/troubleshooting.md)** - Common issues and solutions
- **[docs/implementation-plan.md](docs/implementation-plan.md)** - Implementation plan (Japanese)
- **[docs/testing.md](docs/testing.md)** - Testing guide, integration test examples

## Known Limitations

- NOT recommended for production use

**Recently Implemented** (2026-03-26):

- ✅ CLI: `--app` and `--state-bucket` optional (fallback to env vars / cdk.json)
- ✅ CLI: Positional stack names, `--all` flag, wildcard support, single stack auto-detection
- ✅ CLI: `cdkd destroy` accepts `--app` option; confirmation accepts y/yes
- ✅ Resource replacement: immutable property changes trigger DELETE then CREATE
- ✅ Custom Resource ResponseURL: S3 pre-signed URL for cfn-response handlers
- ✅ CloudFormation Parameters support (with default values and type coercion)
- ✅ Intrinsic functions: Fn::Select, Fn::Split, Fn::If, Fn::Equals, Fn::And, Fn::Or, Fn::Not, Fn::ImportValue
- ✅ Conditions evaluation (with logical operators)
- ✅ Cross-stack references (Fn::ImportValue via S3 state backend)
- ✅ Cloud Control API JSON Patch for updates (RFC 6902 compliant)
- ✅ Resource replacement detection (immutable property detection for 10+ AWS resource types)
- ✅ AWS::NoValue pseudo parameter (for conditional property omission)
- ✅ Fn::FindInMap (Mappings lookup) and Fn::Base64 (base64 encoding)
- ✅ Fn::GetAZs (all intrinsic functions now supported)
- ✅ Partial state save after each DAG level (prevents orphaned resources)
- ✅ Pre-rollback state save on failure (tracks resources from partially-failed levels)
- ✅ CREATE retry with exponential backoff (IAM propagation delays)
- ✅ CC API polling with exponential backoff (1s→2s→4s→8s→10s)
- ✅ Compact output mode (default clean output, `--verbose` for full details)
- ✅ `--state-bucket` auto-resolves from STS account ID: `cdkd-state-{accountId}-{region}`
- ✅ Attribute mapper: CC API property names mapped to GetAtt attribute names
- ✅ Unit tests, integration examples, E2E test script
- ✅ DeletionPolicy: Retain support (skip deletion for retained resources)
- ✅ Resource replacement for immutable property changes (CREATE→DELETE)
- ✅ Type safety improvements (error handling, any type elimination in custom resources)
- ✅ Dynamic References: `{{resolve:secretsmanager:...}}` and `{{resolve:ssm:...}}`
- ✅ SDK Providers: see SDK Providers section above for full list
- ✅ ALL pseudo parameters supported (7/7 including AWS::StackName/StackId)
- ✅ DELETE idempotency (not-found/No policy found treated as success)
- ✅ Destroy ordering: reverse dependency from state + implicit type-based deps
- ✅ CC API null value stripping + JSON string properties (EventPattern)
- ✅ CC API ClientToken removed (caches failure results, incompatible with retry)
- ✅ Implicit delete dependencies for VPC/IGW/EventBus/Subnet/RouteTable
- ✅ CloudFront OAI S3CanonicalUserId enrichment
- ✅ DynamoDB StreamArn enrichment via DescribeTable
- ✅ API Gateway RootResourceId enrichment via GetRestApi
- ✅ isRetryableError with HTTP status code (429/503) + cause chain
- ✅ CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection, max 1hr polling, pre-signed URL 2hr
- ✅ Lambda FunctionUrl attribute enrichment (GetFunctionUrlConfig API)
- ✅ CloudFront + Lambda Function URL integration test (6/6 CREATE+DESTROY)
- ✅ Phase C (CFn Registry Schema) completed: auto-discovery of CC API property-to-GetAtt mappings

## Dependencies

### Key Dependencies

- `@aws-cdk/toolkit-lib` - CDK synthesis (GA)
- `@aws-cdk/cdk-assets-lib` - Asset publishing
- `@aws-sdk/client-*` - AWS SDK v3 (various services)
- `graphlib` - DAG construction

### Dev Dependencies

- `esbuild` - Build tool
- `vitest` - Testing framework
- `eslint` - Linting
- `prettier` - Formatting
- `typescript` - Type checking

## Node.js Version

- **Required**: Node.js >= 20.0.0 (from `package.json` engines field)
