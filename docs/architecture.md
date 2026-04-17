# cdkd Architecture Documentation

## Overview

**cdkd** (CDK Direct) is a tool that deploys AWS CDK applications directly without going through CloudFormation. It implements its own synthesis and asset publishing pipeline, then uses SDK Providers (preferred for performance) and Cloud Control API (fallback) for fast deployments.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Layer                               │
│  (src/cli/)                                                     │
│  - commands/: deploy, diff, destroy, synth, bootstrap          │
│  - options.ts: CLI option definitions                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                    Synthesis Layer                              │
│  (src/synthesis/)                                               │
│  - app-executor.ts: CDK app execution via child_process        │
│  - assembly-reader.ts: manifest.json/template parser           │
│  - synthesizer.ts: Context provider loop orchestrator          │
│  - context-store.ts: cdk.context.json read/write               │
│  - context-provider-registry.ts: Context provider registry     │
│  - context-providers/: AZ, SSM, HostedZone, VPC, CC API       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 │                     │
┌────────────────▼──────┐   ┌─────────▼────────────────────────────┐
│    Assets Layer       │   │      Analysis Layer                  │
│  (src/assets/)        │   │  (src/analyzer/)                     │
│  - file-asset-        │   │  - template-parser.ts: Template parsing│
│    publisher.ts       │   │  - dag-builder.ts: Dependency graph  │
│  - docker-asset-      │   │  - diff-calculator.ts: Diff calculation│
│    publisher.ts       │   │  - intrinsic-function-resolver.ts    │
│  - asset-publisher.ts │   │                                      │
│    (orchestrator)     │   │                                      │
└───────────────────────┘   └──────────┬───────────────────────────┘
                                       │
                            ┌──────────┴──────────┐
                            │                     │
┌───────────────────────────▼─────┐   ┌──────────▼──────────────────┐
│       State Layer               │   │   Deployment Layer          │
│  (src/state/)                   │   │  (src/deployment/)          │
│  - s3-state-backend.ts          │   │  - deploy-engine.ts         │
│  - lock-manager.ts              │   │  - intrinsic-function-      │
│  - State schema (types/state.ts)│   │    resolver.ts              │
└─────────────────────────────────┘   └──────────┬──────────────────┘
                                                 │
                                      ┌──────────▼──────────────────┐
                                      │   Provisioning Layer        │
                                      │  (src/provisioning/)        │
                                      │  - provider-registry.ts     │
                                      │  - cloud-control-provider.ts│
                                      │  - providers/:              │
                                      │    - See src/provisioning/  │
                                      │      providers/ for full    │
                                      │      list                   │
                                      │  - json-patch-generator.ts  │
                                      └─────────────────────────────┘
```

## Layer Details

### 1. CLI Layer (`src/cli/`)

**Responsibilities**: User interface, command-line argument processing

**Main Components**:

- `commands/deploy.ts`: Deploy command implementation
- `commands/diff.ts`: Diff display command implementation
- `commands/destroy.ts`: Resource deletion command implementation
- `commands/synth.ts`: Synthesis only execution
- `commands/bootstrap.ts`: State bucket initialization
- `options.ts`: Common CLI option definitions
- `config-loader.ts`: Config resolution (cdk.json, env vars for `--app` and `--state-bucket`)

**Design Pattern**: Command pattern

**Entry Point**: `src/cli/index.ts`

### 2. Synthesis Layer (`src/synthesis/`)

**Responsibilities**: CDK application execution, CloudFormation template generation, context provider resolution

cdkd implements its own synthesis pipeline without external CDK toolkit dependencies. The synthesis layer executes the user's CDK app as a child process, reads the resulting cloud assembly output, and handles context provider resolution through an iterative loop.

**Main Components**:

#### `app-executor.ts` - AppExecutor

Executes the CDK app command via `child_process.spawn()` with the following environment variables:

- `CDK_OUTDIR`: Output directory for synthesized templates (e.g., `cdk.out`)
- `CDK_CONTEXT`: Serialized JSON context (includes cached context from `cdk.context.json`)
- `CDK_DEFAULT_REGION`: AWS region
- `CDK_DEFAULT_ACCOUNT`: AWS account ID

#### `assembly-reader.ts` - AssemblyReader

Reads the cloud assembly output directly from the `cdk.out/` directory:

- Parses `manifest.json` to discover stack artifacts and asset manifests
- Extracts CloudFormation templates (`{StackName}.template.json`)
- Extracts asset manifests (`{StackName}.assets.json`)
- Resolves artifact dependencies and metadata

#### `synthesizer.ts` - Synthesizer

Orchestrates the context provider loop:

```
1. Execute CDK app (AppExecutor)
   ↓
2. Read cloud assembly (AssemblyReader)
   ↓
3. Check for missing context in manifest
   ↓  (if missing context found)
4. Resolve missing context via ContextProviderRegistry
   ↓
5. Save resolved context to cdk.context.json (ContextStore)
   ↓
6. Re-execute CDK app with updated context → go to step 1
   ↓  (if no missing context)
7. Return final cloud assembly
```

This iterative loop mirrors the behavior of the CDK CLI: when a CDK app encounters a construct that requires runtime context (e.g., `Vpc.fromLookup()`), it records the missing context key and exits. The synthesizer detects these missing keys, resolves them via AWS SDK calls, caches the results, and re-runs synthesis until all context is satisfied.

#### `context-store.ts` - ContextStore

Reads and writes `cdk.context.json` for context caching. This file persists resolved context values across synthesis runs, avoiding redundant AWS API calls.

#### `context-provider-registry.ts` - ContextProviderRegistry

Registry of context providers that resolve missing context during synthesis. Each provider handles a specific context type.

**Built-in Context Providers** (`context-providers/`):

| Provider | Context Key | Description |
| -------- | ----------- | ----------- |
| Availability Zones | `availability-zones` | Lists AZs for a region via EC2 DescribeAvailabilityZones |
| SSM | `ssm` | Reads SSM Parameter Store values |
| Hosted Zone | `hosted-zone` | Looks up Route53 hosted zone IDs |
| VPC Provider | `vpc-provider` | Looks up VPC details (ID, subnets, route tables, etc.) |
| CC API Provider | `cc-api-provider` | Generic Cloud Control API-based context lookups |

**Synthesis Flow**:

```
1. User CDK App (--app option, CDKD_APP env var, or cdk.json "app" field)
   ↓
2. AppExecutor.execute() via child_process.spawn()
   ↓  (with CDK_OUTDIR, CDK_CONTEXT, CDK_DEFAULT_REGION/ACCOUNT env vars)
3. Output to cdk.out/ directory
   - manifest.json
   - {StackName}.template.json
   - {StackName}.assets.json
   ↓
4. AssemblyReader parses manifest.json
   ↓
5. Check for missing context → resolve via providers → re-synthesize if needed
   ↓
6. Return final assembly with stacks and asset manifests
```

### 3. Assets Layer (`src/assets/`)

**Responsibilities**: Publish assets like Lambda code, Docker images to S3/ECR

cdkd implements its own asset publishing without external dependencies.

**Main Components**:

#### `file-asset-publisher.ts` - FileAssetPublisher

Publishes file assets (Lambda code packages, etc.) to S3:

- Checks for existing assets via `HeadObject` (skips if already published)
- Supports ZIP packaging for directory assets
- Uploads to the CDK asset bucket

#### `docker-asset-publisher.ts` - DockerAssetPublisher

Publishes Docker image assets to ECR:

- Authenticates with ECR via `GetAuthorizationToken`
- Builds Docker images from source
- Tags and pushes images to the ECR repository

#### `asset-publisher.ts` - AssetPublisher

Orchestrator that reads asset manifests and delegates to the appropriate publisher (file or Docker) based on asset type.

**Asset Types**:

- **File Assets**: Lambda code zip, CloudFormation templates
- **Docker Image Assets**: Container image publishing to ECR

**Publish Destinations**:

- S3: `cdk-hnb659fds-assets-${AccountId}-${Region}/`
- ECR: `cdk-hnb659fds-container-assets-${AccountId}-${Region}`

### 4. Analysis Layer (`src/analyzer/`)

**Responsibilities**: Template analysis, dependency analysis, diff calculation

**Main Components**:

#### `template-parser.ts`

Parses CloudFormation templates and extracts resource information

```typescript
parseTemplate(template: CloudFormationTemplate): ParsedResource[]
```

#### `dag-builder.ts`

Analyzes dependencies between resources and builds a DAG (Directed Acyclic Graph)

```typescript
buildDAG(resources: ParsedResource[]): ResourceDAG
```

**Dependency Detection**:

- `DependsOn` attribute
- `Ref` function (`{ "Ref": "LogicalId" }`)
- `Fn::GetAtt` function (`{ "Fn::GetAtt": ["LogicalId", "Attribute"] }`)

**Determining Parallel Execution Levels**:

```
Level 0: Resources without dependencies (S3 Bucket, DynamoDB Table)
Level 1: Depends on Level 0 (IAM Role)
Level 2: Depends on Level 1 (Lambda Function)
```

#### `diff-calculator.ts`

Compares current state (S3) with template and calculates changes

```typescript
calculateDiff(
  currentState: StackState,
  template: CloudFormationTemplate
): ResourceDiff[]
```

**Diff Types**:

- `CREATE`: New resource
- `UPDATE`: Property change
- `DELETE`: Resource deletion
- `NO_CHANGE`: No change

#### `intrinsic-function-resolver.ts`

Resolves CloudFormation intrinsic functions

**Supported Functions**:

- `Ref`: Logical ID → Physical ID / value
- `Fn::GetAtt`: Attribute reference (e.g., `BucketName`, `Arn`)
- `Fn::Join`: String concatenation
- `Fn::Sub`: Template string substitution
- `Fn::Select`, `Fn::Split`: List and string operations
- `Fn::If`, `Fn::Equals`: Conditional evaluation
- `Fn::And`, `Fn::Or`, `Fn::Not`: Logical operators for Conditions
- `Fn::ImportValue`: Cross-stack references
- `Fn::FindInMap`: Mapping lookup
- `Fn::GetAZs`: Availability Zone list
- `Fn::Base64`: Base64 encoding

All CloudFormation intrinsic functions are now supported.

### 5. State Layer (`src/state/`)

**Responsibilities**: State persistence, mutual exclusion control

#### `s3-state-backend.ts`

State management with S3 as backend

**State Structure**:

```
s3://{STATE_BUCKET}/{STATE_PREFIX}/
  └── {StackName}/
      ├── lock.json      # Exclusive lock
      └── state.json     # Resource state
```

**Main Methods**:

```typescript
interface S3StateBackend {
  getState(stackName: string): Promise<StackState | null>
  saveState(stackName: string, state: StackState): Promise<void>
  deleteState(stackName: string): Promise<void>
  listStacks(): Promise<string[]>
}
```

**State Schema** (`types/state.ts`):

```typescript
interface StackState {
  version: number
  stackName: string
  resources: Record<string, ResourceState>
  outputs: Record<string, string>
  lastModified: number
}

interface ResourceState {
  physicalId: string          // AWS physical ID (arn:aws:...)
  resourceType: string        // AWS::Lambda::Function
  properties: Record<string, any>
  attributes: Record<string, any>  // For Fn::GetAtt
  dependencies: string[]      // For deletion order
}
```

#### `lock-manager.ts`

Optimistic locking using S3 Conditional Writes

**Locking Method**:

- **Acquire**: `PutObject` with `If-None-Match: *` (create only if doesn't exist)
- **Release**: `DeleteObject` with `If-Match: {ETag}` (delete only if ETag matches)

**Timeout**: Default 5 minutes (configurable)

**Lock Schema**:

```typescript
interface LockInfo {
  lockId: string       // UUID
  timestamp: number    // Unix timestamp
  owner: string        // Process identifier
}
```

### 6. Deployment Layer (`src/deployment/`)

**Responsibilities**: Deployment execution control, intrinsic function resolution

#### `deploy-engine.ts`

Main deployment engine

**Deployment Flow**:

```typescript
async deploy(options: DeployOptions): Promise<void> {
  1. Acquire lock
  2. Get current state
  3. Publish assets (can skip with --skip-assets)
  4. Parse template
  5. Build DAG
  6. Calculate diff
  7. Display execution plan
  8. Exit here if --dry-run
  9. Execute in parallel by level
     - CREATE: Create resource via provider
     - UPDATE: Generate JSON Patch → Provider update
     - DELETE: Delete in reverse dependency order
  10. Resolve Outputs
  11. Save state
  12. Release lock
}
```

**Parallel Execution**:

```typescript
for (const level of executionLevels) {
  await Promise.all(
    level.resources.map(resource =>
      this.provisionResource(resource)
    )
  )
}
```

**Error Handling**:

- Catch errors per resource
- Continue with other resources even if some fail
- Save only successful resources to state

#### `intrinsic-function-resolver.ts`

Intrinsic function resolution (shared with Analysis Layer)

**Resolution Context**:

```typescript
interface ResolutionContext {
  resources: Record<string, ResourceState>  // From state
  pseudoParameters: Record<string, string>  // AWS::AccountId, etc.
}
```

**Pseudo Parameters**:

- `AWS::AccountId`: Retrieved from STS `GetCallerIdentity`
- `AWS::Region`: From CLI options
- `AWS::Partition`: "aws" (fixed)
- `AWS::StackId`: Generated unique identifier
- `AWS::StackName`: From stack configuration
- `AWS::URLSuffix`: "amazonaws.com"
- `AWS::NoValue`: For conditional property omission

### 7. Provisioning Layer (`src/provisioning/`)

**Responsibilities**: AWS resource creation, update, deletion

#### Architecture Pattern: Strategy + Registry

**Provider Registry** (`provider-registry.ts`):

```typescript
class ProviderRegistry {
  private providers: Map<string, ResourceProvider>

  register(resourceType: string, provider: ResourceProvider): void
  getProvider(resourceType: string): ResourceProvider
}
```

**Provider Interface**:

```typescript
interface ResourceProvider {
  create(logicalId: string, properties: any): Promise<string>
  update(physicalId: string, oldProps: any, newProps: any): Promise<void>
  delete(physicalId: string): Promise<void>
  getAttribute(physicalId: string, attrName: string): Promise<any>
}
```

#### Cloud Control Provider (`cloud-control-provider.ts`)

**Fallback Provider**: Handles resource types without a registered SDK Provider (async polling)

**AWS API**:

- `CreateResource`
- `UpdateResource`
- `DeleteResource`
- `GetResource`

**Update Method**: JSON Patch (RFC 6902)

```typescript
// json-patch-generator.ts
generatePatch(oldProps: any, newProps: any): JSONPatchOperation[]
```

**Limitations**:

- Some resources not supported by Cloud Control API
- Some properties require replacement when updated

#### SDK Providers (`providers/`)

**Preferred Providers**: SDK Providers make direct synchronous API calls with no polling overhead, making them significantly faster than Cloud Control API.

**Implemented Providers**: IAM, S3, SQS, SNS, Lambda, DynamoDB, CloudWatch, Secrets Manager, SSM, EventBridge, EC2 (VPC/Subnet/SecurityGroup etc.), API Gateway, CloudFront, StepFunctions, ECS, ELBv2, RDS, Route53, WAFv2, Cognito, BedrockAgentCore, Custom Resources. See `src/provisioning/providers/` and [README](../README.md) for full list.

**How to Add Providers**: See [provider-development.md](./provider-development.md)

### 8. Utilities (`src/utils/`)

**logger.ts**: Winston-based logging

```typescript
logger.info('message')
logger.debug('verbose message')  // Shown with --verbose
logger.error('error', error)
```

**error-handler.ts**: Error classification and handling

```typescript
handleProvisioningError(error: Error, resource: Resource): void
```

**aws-clients.ts**: AWS SDK v3 client management

```typescript
getClient<T>(ClientClass: new (...) => T, region: string): T
```

## Deployment Flow Details

### 1. Initial Deployment (CREATE)

```
┌─────────────┐
│ User        │
│ $ cdkd      │
│   deploy    │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ CLI Layer       │
│ config-loader   │  --app (or CDKD_APP / cdk.json), --state-bucket (or env/cdk.json)
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ Synthesis Layer         │
│ AppExecutor             │  Execute CDK app via child_process.spawn()
│ AssemblyReader          │  Parse manifest.json from cdk.out/
│ Synthesizer             │  Context provider loop (resolve missing context)
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌─────────┐  ┌──────────────────┐
│ Assets  │  │ Analysis Layer   │
│ Layer   │  │ - Template Parse │
│         │  │ - DAG Build      │
│ Publish │  │ - Diff Calc      │
│ to S3/  │  │   (all CREATE)   │
│ ECR     │  └────────┬─────────┘
└─────────┘           │
                      ▼
         ┌─────────────────────────┐
         │ State Layer             │
         │ - Lock Acquire          │
         │ - Get State (null)      │
         └────────┬────────────────┘
                  │
                  ▼
         ┌─────────────────────────┐
         │ Deployment Layer        │
         │ - Deploy Engine         │
         │ - Execute by Levels     │
         └────────┬────────────────┘
                  │
         ┌────────┴─────────┐
         │                  │
         ▼                  ▼
┌─────────────────┐  ┌──────────────────┐
│ SDK Providers   │  │ Cloud Control    │
│ (preferred)     │  │ Provider         │
│ - S3, Lambda    │  │ (fallback)       │
│ - IAM, DynamoDB │  │ - Many types     │
│ - SQS, SNS, etc│  │ - Async polling  │
└────────┬────────┘  └──────────────────┘
         │
         │
         ▼
┌─────────────────────────┐
│ State Layer             │
│ - Resolve Outputs       │
│ - Save State            │
│ - Release Lock          │
└─────────────────────────┘
```

### 2. Update Deployment (UPDATE)

```
... (Same until Synthesis)
         │
         ▼
┌──────────────────┐
│ Analysis Layer   │
│ - Diff Calc      │
│   Current State  │
│   vs Template    │
│   → UPDATE       │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────┐
│ Provisioning Layer       │
│ - JSON Patch Generator   │
│   oldProps → newProps    │
│ - Cloud Control API      │
│   UpdateResource()       │
└──────────────────────────┘
```

### 3. Deletion (DESTROY)

```
┌─────────────┐
│ User        │
│ $ cdkd      │
│   destroy   │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ CLI Layer       │
│ destroy.ts      │  <stackName>, --app, --force, --all (synth-based)
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ State Layer             │
│ - Get State             │
│ - Rebuild DAG from      │
│   state.dependencies    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Deployment Layer        │
│ - Reverse Topology Sort │
│   (delete in reverse)   │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Provisioning Layer      │
│ - Provider.delete()     │
│   Execute in reverse    │
│   dependency order      │
└─────────────────────────┘
```

### 4. Context Provider Resolution Loop

```
┌───────────────────────┐
│ Synthesizer           │
│ synthesize()          │
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│ AppExecutor           │
│ spawn(cdkApp)         │◄──────────────────────┐
│ env: CDK_OUTDIR,      │                       │
│   CDK_CONTEXT,        │                       │
│   CDK_DEFAULT_REGION  │                       │
└──────────┬────────────┘                       │
           │                                    │
           ▼                                    │
┌───────────────────────┐                       │
│ AssemblyReader        │                       │
│ read manifest.json    │                       │
└──────────┬────────────┘                       │
           │                                    │
           ▼                                    │
┌───────────────────────┐     ┌─────────────────┴───────┐
│ Missing context?      │─Yes→│ ContextProviderRegistry │
│ (check manifest       │     │ resolve(key, props)     │
│  missing entries)     │     │ - AZ provider           │
└──────────┬────────────┘     │ - SSM provider          │
           │ No               │ - HostedZone provider   │
           ▼                  │ - VPC provider           │
┌───────────────────────┐     │ - CC API provider       │
│ Return final assembly │     └─────────────┬───────────┘
└───────────────────────┘                   │
                                            ▼
                              ┌─────────────────────────┐
                              │ ContextStore             │
                              │ save to cdk.context.json │
                              └─────────────┬───────────┘
                                            │
                                            │ (re-synthesize)
                                            └───────────────┘
```

## Design Principles

### 1. Single Responsibility Principle (SRP)

Each layer has clear responsibilities

- CLI: UI/UX
- Synthesis: CDK app execution and context resolution
- Analysis: Analysis and planning
- Deployment: Execution control
- Provisioning: AWS API calls

### 2. Dependency Inversion Principle (DIP)

- Depends on `ResourceProvider` interface
- Concrete providers are interchangeable

### 3. Open/Closed Principle (OCP)

- Can add new providers (Registry pattern)
- Can add new context providers (ContextProviderRegistry pattern)
- Extensible without modifying existing code

### 4. Fail-Fast with State Recovery

- Saves partial state even on error
- Can re-run as diff on next execution

### 5. Zero External CDK Dependencies

- Synthesis, assembly reading, and asset publishing are all implemented internally
- No dependency on `@aws-cdk/toolkit-lib`, `@aws-cdk/cloud-assembly-api`, or `@aws-cdk/cdk-assets-lib`
- Only `aws-cdk-lib` is required as the user's CDK app dependency

## Performance Characteristics

### Comparison with CloudFormation

| Item | CloudFormation | cdkd |
| ---- | -------------- | ---- |
| **Small Stack (5 resources)** | 60-90 seconds | 15-25 seconds |
| **Medium Stack (20 resources)** | 3-5 minutes | 40-80 seconds |
| **Parallel Execution** | Mainly sequential | Fully parallel by DAG level |
| **Rollback** | Automatic | Manual (recover from state) |

### Bottlenecks

1. **Asset Publishing**: S3 upload of Lambda code (seconds to tens of seconds)
2. **Cloud Control API Polling**: CC API requires async polling for resource operations (mitigated by using SDK Providers for common types)
3. **Cloud Control API Rate Limits**: Limits per resource type
4. **Dependency Chains**: More levels reduce parallelism

## Security Considerations

### 1. Authentication & Authorization

- Uses AWS SDK default authentication chain
- IAM role or environment variables (`AWS_ACCESS_KEY_ID`, etc.)

### 2. State File Security

- Recommend S3 bucket encryption (SSE-S3 or SSE-KMS)
- Bucket policy with principle of least privilege

### 3. Lock Mechanism

- Prevents race conditions
- Prevents inconsistency from concurrent execution

### 4. Sensitive Information

- CloudFormation Parameters supported (with default values and type coercion)
- Dynamic References supported: `{{resolve:secretsmanager:...}}` and `{{resolve:ssm:...}}`

## Limitations and Future Extensions

### Current Limitations

1. **CloudFormation Macros**: Not supported
2. **Nested Stacks**: Not supported
3. **Change Sets**: No concept (always executes immediately)
4. All intrinsic functions are now supported (15/15)
5. All pseudo parameters are now supported (7/7)

### Phase 9 and Beyond Plans

- CloudWatch metrics integration
- Progress bar/Rich UI

## References

- [Implementation Plan](./implementation-plan.md)
- [State Management Specification](./state-management.md)
- [Provider Development Guide](./provider-development.md)
- [Troubleshooting](./troubleshooting.md)
- [AWS Cloud Control API Reference](https://docs.aws.amazon.com/cloudcontrolapi/latest/APIReference/Welcome.html)
