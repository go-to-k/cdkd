# cdkq

**cdkq** (CDK Quick Deploy) - Deploy AWS CDK apps directly via SDK/Cloud Control API, bypassing CloudFormation stacks for faster deployments.

> **⚠️ WARNING: NOT PRODUCTION READY**
>
> This project is in early development and is **NOT suitable for production use**. Features are incomplete, APIs may change without notice, and there may be bugs that could affect your AWS infrastructure. Use at your own risk in development/testing environments only.
>
> **Status**: 🚧 Phase 8 Complete - Core functionality implemented, testing phase

> **Note**: This is an experimental/educational project exploring alternative deployment approaches for AWS CDK. It is **not intended to replace** the official AWS CDK CLI, but rather to experiment with direct SDK/Cloud Control API provisioning as a learning exercise and proof of concept.

## Why cdkq?

AWS CDK is great for defining infrastructure as code, but CloudFormation deployments can be slow. **cdkq** keeps the CDK developer experience while eliminating CloudFormation overhead by:

- **Direct provisioning** via AWS SDK and Cloud Control API
- **Parallel resource deployment** based on dependency analysis
- **No CloudFormation stacks** - faster deployments
- **100% CDK compatible** - use your existing CDK code

## How it works

```
┌─────────────────┐
│  Your CDK App   │  (aws-cdk-lib)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ toolkit-lib     │  Synthesis + Context Resolution
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
│ cdkq Engine     │
│ - DAG Analysis  │  Dependency graph construction
│ - Diff Calc     │  Compare with existing resources
│ - Parallel Exec │  Deploy by levels
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│ Cloud  │ │  SDK   │
│Control │ │Provider│  Lambda/S3/IAM/etc.
│  API   │ │        │
└────────┘ └────────┘
```

## Features

- **Hybrid deployment strategy**: Cloud Control API first, fallback to SDK for unsupported resources
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **Asset handling**: Leverages `@aws-cdk/cdk-assets-lib` for Lambda packages, Docker images, etc.

## Usage

```bash
# Build the project
npm run build

# Synthesize only
node dist/cli.js synth --app "npx ts-node app.ts"

# Show diff (what would change)
node dist/cli.js diff \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1

# Deploy
node dist/cli.js deploy \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --verbose

# Dry run (plan only, no changes)
node dist/cli.js deploy \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --dry-run

# Destroy resources
node dist/cli.js destroy \
  --state-bucket my-cdkq-state \
  --stack MyStack \
  --region us-east-1

# Force destroy (skip confirmation)
node dist/cli.js destroy \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --force
```

See [TESTING.md](TESTING.md) for detailed testing instructions.

## Architecture

Built on modern AWS tooling:

- **[@aws-cdk/toolkit-lib](https://docs.aws.amazon.com/cdk/api/toolkit-lib/)** - CDK synthesis (GA since Feb 2025)
- **[@aws-cdk/cdk-assets-lib](https://www.npmjs.com/package/@aws-cdk/cdk-assets-lib)** - Asset publishing
- **AWS SDK v3** - Direct resource provisioning
- **Cloud Control API** - Unified resource management where supported
- **S3 Conditional Writes** - State locking via `If-None-Match`/`If-Match`

## State Management

State is stored in S3 with the following structure:

```
s3://my-state-bucket/
  └── stacks/
      └── MyStack/
          ├── lock.json      # Exclusive lock
          └── state.json     # Resource state
```

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

## Development Roadmap

See [docs/implementation-plan.md](docs/implementation-plan.md) for detailed implementation plan.

**Completed Phases**:

- ✅ **Phase 1-2**: Foundation (CLI, logging, synthesis, assets)
- ✅ **Phase 3**: State Management (S3 backend, optimistic locking)
- ✅ **Phase 4**: Dependency Analysis (DAG builder, template parser)
- ✅ **Phase 5-6**: Resource Provisioning (Cloud Control API, SDK providers)
- ✅ **Phase 7**: Orchestration (parallel execution, DAG-based deployment)
- ✅ **Phase 8**: CLI Integration (deploy, diff, destroy commands)

**Current Phase**: Phase 9 - Testing & Documentation

**Not Yet Implemented**:

- Bootstrap command (S3 bucket creation for state)
- Progress bar / advanced UI
- Custom resource support
- Full intrinsic function support (Fn::Sub, Fn::Join, etc.)
- CloudFormation Parameters support

See [docs/implementation-plan.md](docs/implementation-plan.md) for complete roadmap.

## Contributing

This project is in early development. Contributions welcome!

## License

Apache 2.0
