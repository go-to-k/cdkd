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
| `Fn::GetAZs` | ❌ Not yet | Availability Zone list |
| `Fn::Base64` | ✅ Supported | Base64 encoding |

### Pseudo Parameters

| Parameter | Status |
|-----------|--------|
| `AWS::Region` | ✅ |
| `AWS::AccountId` | ✅ (via STS) |
| `AWS::Partition` | ✅ |
| `AWS::URLSuffix` | ✅ |
| `AWS::NoValue` | ✅ |
| `AWS::StackName` | ✅ |
| `AWS::StackId` | ❌ Not yet |

### Resource Provisioning

| Category | Resource Type | Provider | Status |
|----------|--------------|----------|--------|
| **Compute** | AWS::Lambda::Function | Cloud Control | ✅ |
| **Storage** | AWS::S3::Bucket | Cloud Control | ✅ |
| **Database** | AWS::DynamoDB::Table | Cloud Control | ✅ |
| **Messaging** | AWS::SQS::Queue | Cloud Control | ✅ |
| **Messaging** | AWS::SNS::Topic | Cloud Control | ✅ |
| **IAM** | AWS::IAM::Role | SDK Provider | ✅ |
| **IAM** | AWS::IAM::Policy | SDK Provider | ✅ |
| **IAM** | AWS::S3::BucketPolicy | SDK Provider | ✅ |
| **IAM** | AWS::SQS::QueuePolicy | SDK Provider | ✅ |
| **Custom** | Custom::* (Lambda-backed) | SDK Provider | ✅ (sync only) |
| **Other** | 200+ resource types | Cloud Control | ✅ |

> **Note**: Cloud Control API supports 200+ resource types. Resources not listed above may work via Cloud Control API. SDK Providers are used for resources not supported by Cloud Control API.

### Other Features

| Feature | Status | Notes |
|---------|--------|-------|
| CloudFormation Parameters | ✅ | Default values, type coercion |
| Conditions | ✅ | With logical operators |
| Cross-stack references | ✅ | Via `Fn::ImportValue` + S3 state |
| JSON Patch updates | ✅ | RFC 6902, minimal patches |
| Resource replacement detection | ✅ | 10+ resource types |
| Asset publishing (S3) | ✅ | Lambda code packages |
| Asset publishing (ECR) | ✅ | Via `@aws-cdk/cdk-assets-lib` |
| Custom Resources (SNS-backed) | ❌ | Lambda-backed only |
| Custom Resources (async/SFN) | ❌ | Sync invocation only |
| Rollback | ❌ | Not yet implemented |
| `Fn::FindInMap` | ✅ | Mapping lookup |
| `Fn::Base64` | ✅ | Base64 encoding |
| `Fn::GetAZs` | ❌ | Not yet implemented |
| DeletionPolicy: Retain | ✅ | Skip deletion for retained resources |
| UpdateReplacePolicy: Retain | ✅ | Keep old resource on replacement |

## Prerequisites

- **Node.js** >= 20.0.0
- **AWS CDK Bootstrap**: You must run `cdk bootstrap` before using cdkq. cdkq uses CDK's bootstrap bucket (`cdk-hnb659fds-assets-*`) for asset uploads (Lambda code, Docker images). Custom bootstrap qualifiers are supported — CDK embeds the correct bucket/repo names in the asset manifest during synthesis.
- **AWS Credentials**: Configured via environment variables, `~/.aws/credentials`, or `--profile` option

## Installation

```bash
npm install -g cdkq
```

Or use with npx (no installation required):

```bash
npx cdkq --help
```

## Usage

Options like `--app` and `--state-bucket` can be omitted if configured via `cdk.json` or environment variables (`CDKQ_APP`, `CDKQ_STATE_BUCKET`).

```bash
# Bootstrap (create S3 bucket for state)
npx cdkq bootstrap \
  --state-bucket my-cdkq-state \
  --region us-east-1

# Synthesize only
npx cdkq synth --app "npx ts-node app.ts"

# Deploy (single stack auto-detected, reads --app from cdk.json)
npx cdkq deploy

# Deploy specific stack(s)
npx cdkq deploy MyStack
npx cdkq deploy Stack1 Stack2

# Deploy all stacks
npx cdkq deploy --all

# Deploy with wildcard
npx cdkq deploy 'My*'

# Deploy with explicit options
npx cdkq deploy MyStack \
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkq-state \
  --region us-east-1 \
  --verbose

# Show diff (what would change)
npx cdkq diff MyStack

# Dry run (plan only, no changes)
npx cdkq deploy --dry-run

# Destroy resources
npx cdkq destroy MyStack
npx cdkq destroy --all --force
```

## Examples

See the [tests/integration/examples](tests/integration/examples) directory for working examples:

- [basic](tests/integration/examples/basic) - Simple S3 bucket deployment
- [conditions](tests/integration/examples/conditions) - CloudFormation Conditions and AWS::NoValue
- [parameters](tests/integration/examples/parameters) - CloudFormation Parameters with default values
- [intrinsic-functions](tests/integration/examples/intrinsic-functions) - Intrinsic function resolution
- [lambda](tests/integration/examples/lambda) - Lambda + DynamoDB + IAM integration
- [cross-stack-references](tests/integration/examples/cross-stack-references) - Cross-stack references with Fn::ImportValue
- [ecr](tests/integration/examples/ecr) - ECR repository deployment
- [apigateway](tests/integration/examples/apigateway) - API Gateway integration

See [docs/TESTING.md](docs/TESTING.md) for detailed testing instructions including UPDATE operations.

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

**Recently Implemented** (2026-03-25):

- ✅ Custom Resource support (Lambda-backed, Create/Update/Delete)
- ✅ Real AWS Account ID resolution via STS GetCallerIdentity
- ✅ SDK Providers: IAM Role/Policy, S3 Bucket Policy, SQS Queue Policy
- ✅ Intrinsic function resolution (Ref, Fn::GetAtt, Fn::Join, Fn::Sub, Fn::Select, Fn::Split, Fn::If, Fn::Equals, Fn::And, Fn::Or, Fn::Not, Fn::ImportValue)
- ✅ Pseudo parameters: AWS::Region, AWS::AccountId, AWS::Partition, AWS::NoValue, AWS::URLSuffix
- ✅ CloudFormation Parameters support (with default values and type coercion)
- ✅ Conditions evaluation (with logical operators: And, Or, Not)
- ✅ Cross-stack references (Fn::ImportValue via S3 state backend)
- ✅ Lambda Asset publishing (code packages to S3/ECR via `@aws-cdk/cdk-assets-lib`)
- ✅ Cloud Control API JSON Patch for updates (RFC 6902 compliant, minimal patches)
- ✅ Type safety improvements (error handling, any type elimination)
- ✅ Resource replacement detection (immutable property detection for 10+ AWS resource types)
- ✅ Code quality improvements (eliminated ~80 lines of duplicate code in DeployEngine)
- ✅ Integration testing (9 examples verified with real AWS deployments)
- ✅ UPDATE operations verified (JSON Patch working for S3, Lambda, IAM resources)
- ✅ Environment variable support for UPDATE testing (`CDKQ_TEST_UPDATE=true`)

**Not Yet Implemented**:

- Custom Resources: SNS-backed and async/Step Functions patterns (Lambda sync only)
- Custom Resources: CDK internal custom resources (`Custom::S3AutoDeleteObjects` etc.) — ResponseURL issue
- Advanced intrinsic functions (`Fn::GetAZs`)
- Rollback mechanism
- Progress bar / advanced UI
- Default bootstrap bucket name (currently `--state-bucket` is required)

See [docs/implementation-plan.md](docs/implementation-plan.md) for complete roadmap.

## License

Apache 2.0
