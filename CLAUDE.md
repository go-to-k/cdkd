# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**cdkq** (CDK Quick Deploy) is an experimental project that deploys AWS CDK applications directly via AWS SDK/Cloud Control API without going through CloudFormation. It aims to eliminate CloudFormation overhead and achieve faster deployments.

**Important Notes**:

- NOT recommended for production use (development/testing environments only)
- Educational and experimental project
- NOT intended as a replacement for the official AWS CDK CLI

## Architecture Overview

cdkq has a 7-layer system architecture:

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
                 │    (src/provisioning/)     │    Cloud Control API + SDK
                 └────────────────────────────┘
```

### Key Architectural Decisions

1. **Hybrid Provisioning Strategy**
   - Default: Cloud Control API (supports 200+ resource types)
   - Fallback: SDK Provider (for CC API unsupported resources)
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
   - Fully supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`
   - Not yet supported: `Fn::FindInMap`, `Fn::GetAZs`, `Fn::Base64`

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

- **src/cli/** - CLI command implementations (deploy, destroy, diff, synth, bootstrap)
- **src/synthesis/** - CDK app synthesis (using @aws-cdk/toolkit-lib)
- **src/analyzer/** - DAG builder, template parser, intrinsic function resolution
- **src/state/** - S3 state backend, lock manager
- **src/deployment/** - DeployEngine (orchestration)
- **src/provisioning/** - Provider registry, Cloud Control provider, SDK providers
- **src/assets/** - Asset publisher (Lambda code, Docker images)

### Important Files

- **src/types/** - Type definitions (config, state, resources, etc.)
- **src/utils/** - Logger, error handler, AWS client factory
- **build.mjs** - esbuild build script (ESM modules)
- **vitest.config.ts** - Vitest configuration

### SDK Providers

Currently implemented SDK Providers (`src/provisioning/providers/`):

- `iam-role-provider.ts` - AWS::IAM::Role
- `iam-policy-provider.ts` - AWS::IAM::Policy
- `s3-bucket-policy-provider.ts` - AWS::S3::BucketPolicy
- `sqs-queue-policy-provider.ts` - AWS::SQS::QueuePolicy

These are custom implementations for resources not supported by Cloud Control API.

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

### 3. Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- Implemented in `CustomResourceProvider`

### 4. Asset Publishing

- Uses `@aws-cdk/cdk-assets-lib`
- Publishes Lambda code packages to S3/ECR
- Implemented in `AssetsPublisher` class

### 5. Intrinsic Function Resolution

- Implemented in `IntrinsicResolver` class (`src/analyzer/intrinsic-resolver.ts`)
- Ref: References other resource's PhysicalId
- Fn::GetAtt: Gets resource attributes (from state.attributes)
- Fn::Join: String concatenation
- Fn::Sub: Template string substitution

### 6. Dependency Analysis

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

- `tests/integration/examples/**`
- Uses actual AWS account
- Environment variables: `STATE_BUCKET`, `AWS_REGION`
- 7 examples verified with real AWS deployments (as of 2026-03-25):
  - basic: S3 bucket (CREATE + UPDATE verified)
  - conditions: Conditional resources with AWS::NoValue
  - parameters: CloudFormation Parameters with default values
  - intrinsic-functions: Ref, GetAtt, Join, Sub
  - lambda: Lambda + DynamoDB + IAM (CREATE + UPDATE verified)
  - cross-stack-references: Fn::ImportValue (Exporter + Consumer)
  - multi-resource: Known issue with Custom Resource CloudFormation integration

### UPDATE Testing

- Environment variable `CDKQ_TEST_UPDATE=true` enables UPDATE test mode
- Example: `tests/integration/examples/basic/lib/basic-stack.ts`
- Allows testing UPDATE operations without modifying code
- JSON Patch (RFC 6902) verified working for S3, Lambda, IAM resources

## Common Development Tasks

### Adding a New SDK Provider

1. Create new file in `src/provisioning/providers/`
2. Implement `ResourceProvider` interface
3. Register with `ProviderRegistry.getInstance().register()` (in `src/provisioning/provider-registry.ts`)
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

- Some intrinsic functions not supported (Fn::FindInMap, Fn::GetAZs, Fn::Base64)
- NOT recommended for production use

**Recently Implemented** (2026-03-25):

- ✅ CloudFormation Parameters support (with default values and type coercion)
- ✅ Intrinsic functions: Fn::Select, Fn::Split, Fn::If, Fn::Equals, Fn::And, Fn::Or, Fn::Not, Fn::ImportValue
- ✅ Conditions evaluation (with logical operators)
- ✅ Cross-stack references (Fn::ImportValue via S3 state backend)
- ✅ Cloud Control API JSON Patch for updates (RFC 6902 compliant)
- ✅ Resource replacement detection (immutable property detection for 10+ AWS resource types)
- ✅ AWS::NoValue pseudo parameter (for conditional property omission)
- ✅ Type safety improvements (error handling, any type elimination in custom resources)

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
