# cdkd Architecture Documentation

## Overview

**cdkd** (CDK Direct) is a tool that deploys AWS CDK applications directly without going through CloudFormation. It leverages CDK's synthesis capabilities while using SDK Providers (preferred for performance) and Cloud Control API (fallback) for fast deployments.

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
│  - synthesizer.ts: @aws-cdk/toolkit-lib wrapper                │
│  - assembly-loader.ts: CloudAssembly loader                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 │                     │
┌────────────────▼──────┐   ┌─────────▼────────────────────────────┐
│    Assets Layer       │   │      Analysis Layer                  │
│  (src/assets/)        │   │  (src/analyzer/)                     │
│  - asset-manifest-    │   │  - template-parser.ts: Template parsing│
│    loader.ts          │   │  - dag-builder.ts: Dependency graph  │
│  - asset-publisher.ts │   │  - diff-calculator.ts: Diff calculation│
│    (@aws-cdk/cdk-     │   │  - intrinsic-function-resolver.ts    │
│     assets-lib)       │   │                                      │
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

**Responsibilities**: CDK application synthesis, CloudFormation template generation

**Main Components**:

- `synthesizer.ts`: Wraps `@aws-cdk/toolkit-lib`'s `synth()`
- `assembly-loader.ts`: Loads CloudAssembly from `cdk.out/`

**External Dependencies**:

- `@aws-cdk/toolkit-lib`: CDK official synthesis library (GA)
- `aws-cdk-lib`: User's CDK app dependency

**Synthesis Flow**:

```
1. User CDK App (--app option, CDKD_APP env var, or cdk.json "app" field)
   ↓
2. @aws-cdk/toolkit-lib.synth()
   ↓
3. Output to cdk.out/ directory
   - manifest.json
   - {StackName}.template.json
   - {StackName}.assets.json
   ↓
4. assembly-loader loads CloudAssembly
```

### 3. Assets Layer (`src/assets/`)

**Responsibilities**: Publish assets like Lambda code, Docker images to S3/ECR

**Main Components**:

- `asset-manifest-loader.ts`: Reads `{StackName}.assets.json`
- `asset-publisher.ts`: Publishes assets using `@aws-cdk/cdk-assets-lib`

**External Dependencies**:

- `@aws-cdk/cdk-assets-lib`: CDK official asset publishing library

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
│ @aws-cdk/toolkit-lib    │  CDK App → CloudFormation Template
│ synthesizer.ts          │
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

## Design Principles

### 1. Single Responsibility Principle (SRP)

Each layer has clear responsibilities

- CLI: UI/UX
- Synthesis: CDK synthesis
- Analysis: Analysis and planning
- Deployment: Execution control
- Provisioning: AWS API calls

### 2. Dependency Inversion Principle (DIP)

- Depends on `ResourceProvider` interface
- Concrete providers are interchangeable

### 3. Open/Closed Principle (OCP)

- Can add new providers (Registry pattern)
- Extensible without modifying existing code

### 4. Fail-Fast with State Recovery

- Saves partial state even on error
- Can re-run as diff on next execution

## Performance Characteristics

### Comparison with CloudFormation

| Item | CloudFormation | cdkd |
|------|----------------|------|
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
- [AWS CDK Toolkit Lib Documentation](https://docs.aws.amazon.com/cdk/api/toolkit-lib/)
- [AWS Cloud Control API Reference](https://docs.aws.amazon.com/cloudcontrolapi/latest/APIReference/Welcome.html)
