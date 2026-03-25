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

- **Broad resource support**: Supports 200+ AWS resource types via Cloud Control API
- **Hybrid deployment strategy**: Cloud Control API first, fallback to SDK for unsupported resources
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **Asset handling**: Leverages `@aws-cdk/cdk-assets-lib` for Lambda packages, Docker images, etc.

## Installation

```bash
npm install -g cdkq
```

Or use with npx (no installation required):

```bash
npx cdkq --help
```

## Usage

```bash
# Bootstrap (create S3 bucket for state)
npx cdkq bootstrap \
  --state-bucket my-cdkq-state \
  --region us-east-1

# Synthesize only
npx cdkq synth --app "npx ts-node app.ts"

# Show diff (what would change)
npx cdkq diff \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1

# Deploy
npx cdkq deploy \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --verbose

# Dry run (plan only, no changes)
npx cdkq deploy \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --dry-run

# Destroy resources
npx cdkq destroy \
  --state-bucket my-cdkq-state \
  --stack MyStack \
  --region us-east-1

# Force destroy (skip confirmation)
npx cdkq destroy \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --force
```

## Examples

See the [tests/integration/examples](tests/integration/examples) directory for working examples:

- [basic](tests/integration/examples/basic) - Simple S3 bucket deployment
- [intrinsic-functions](tests/integration/examples/intrinsic-functions) - CloudFormation intrinsic function resolution

See [docs/testing.md](docs/testing.md) for detailed testing instructions.

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

## Stack Outputs

CDK's `CfnOutput` constructs are resolved and stored in the state file:

```typescript
// In your CDK code
new cdk.CfnOutput(this, 'BucketArn', {
  value: bucket.bucketArn,  // Uses Fn::GetAtt internally
  description: 'ARN of the bucket',
});
```

After deployment, outputs are resolved and saved to state:

```json
{
  "outputs": {
    "BucketArn": "arn:aws:s3:::actual-bucket-name-xyz"
  }
}
```

**Key differences from CloudFormation**:

- CloudFormation: Outputs accessible via `aws cloudformation describe-stacks`
- cdkq: Outputs saved in S3 state file (e.g., `s3://bucket/cdkq/MyStack/state.json`)
- Both resolve intrinsic functions (Ref, Fn::GetAtt, etc.) to actual values

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

**Recently Implemented**:

- ✅ Custom Resource support (Lambda-backed, Create/Update/Delete)
- ✅ Real AWS Account ID resolution via STS GetCallerIdentity
- ✅ SDK Providers: IAM Role/Policy, S3 Bucket Policy, SQS Queue Policy
- ✅ Intrinsic function resolution (Ref, Fn::GetAtt, Fn::Join, Fn::Sub, Fn::Select, Fn::Split, Fn::If, Fn::Equals, Fn::And, Fn::Or, Fn::Not, Fn::ImportValue)
- ✅ CloudFormation Parameters support (with default values and type coercion)
- ✅ Conditions evaluation (with logical operators: And, Or, Not)
- ✅ Cross-stack references (Fn::ImportValue via S3 state backend)
- ✅ Lambda Asset publishing (code packages to S3/ECR via `@aws-cdk/cdk-assets-lib`)
- ✅ Cloud Control API JSON Patch for updates (RFC 6902 compliant, minimal patches)
- ✅ Code quality improvements (eliminated ~80 lines of duplicate code in DeployEngine)

**Not Yet Implemented**:

- Progress bar / advanced UI
- Advanced intrinsic functions (Fn::FindInMap, Fn::GetAZs, Fn::Base64)

See [docs/implementation-plan.md](docs/implementation-plan.md) for complete roadmap.

## License

Apache 2.0
