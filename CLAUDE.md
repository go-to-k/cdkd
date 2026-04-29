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
│ 2. Synthesis Layer (src/synthesis/)         │ → CDK app subprocess execution
└────────────────┬────────────────────────────┘   Cloud Assembly parsing, context providers
                 ▼
                 ▼  (per stack, pipelined)
┌─────────────────────────────────────────────┐
│ 3. Assets Layer (src/assets/)              │ → Asset publish to S3/ECR
└────────────────┬────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────┐
│ 4. Analysis Layer (src/analyzer/)          │ → Dependency analysis (DAG building)
└────────────────┬────────────────────────────┘   Template parsing
                 ▼
┌─────────────────────────────────────────────┐
│ 5. State Layer                             │ → S3-based state management
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

3. **Event-driven DAG Execution**
   - Analyzes dependencies via `Ref` / `Fn::GetAtt` / `DependsOn`
   - Dispatches each resource as soon as ALL of its own dependencies complete (no level barrier — downstream work does not wait for unrelated siblings in the same DAG level)
   - Bounded by `--concurrency` across the whole stack
   - Implemented in `src/deployment/dag-executor.ts`

4. **Intrinsic Function Resolution**
   - All CloudFormation intrinsic functions supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`, `Fn::FindInMap`, `Fn::Base64`, `Fn::GetAZs`, `Fn::Cidr`

## Build and Test Commands

```bash
# Build (using esbuild)
pnpm run build

# Watch mode (for development)
pnpm run dev

# Test (using Vitest)
pnpm test
pnpm run test:ui         # UI mode
pnpm run test:coverage   # Coverage

# Lint/Format
pnpm run lint
pnpm run lint:fix
pnpm run format
pnpm run format:check

# Type check
pnpm run typecheck
```

## Key Files and Directories

### Core Directories

- **src/cli/** - CLI command implementations (deploy, destroy, diff, synth, bootstrap, force-unlock), config resolution
- **src/synthesis/** - CDK app synthesis (self-implemented: subprocess execution, Cloud Assembly parsing, context providers)
- **src/analyzer/** - DAG builder, template parser, intrinsic function resolution
- **src/state/** - S3 state backend, lock manager
- **src/deployment/** - DeployEngine (orchestration), WorkGraph (DAG-based asset+deploy scheduling)
- **src/provisioning/** - Provider registry, Cloud Control provider, SDK providers
- **src/assets/** - Asset publisher (self-implemented S3 file upload with ZIP packaging, ECR Docker image build & push)

### Important Files

- **src/cli/config-loader.ts** - Config resolution (cdk.json, env vars for `--app` and `--state-bucket`)
- **src/synthesis/app-executor.ts** - Executes CDK app as subprocess with proper env vars (CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION, etc.)
- **src/synthesis/assembly-reader.ts** - Reads and parses Cloud Assembly manifest.json directly
- **src/synthesis/synthesizer.ts** - Orchestrates synthesis with context provider loop
- **src/synthesis/context-providers/** - Context providers (see `src/synthesis/context-providers/` for full list) for missing context resolution
- **src/deployment/dag-executor.ts** - Generic event-driven DAG dispatcher (used inside a stack to schedule resource provisioning as soon as each resource's deps complete; no level barriers)
- **src/deployment/work-graph.ts** - WorkGraph DAG orchestrator for asset publishing and stack deployment
- **src/assets/file-asset-publisher.ts** - S3 file upload with ZIP packaging support
- **src/assets/docker-asset-publisher.ts** - ECR Docker image build & push
- **src/types/assembly.ts** - Cloud Assembly types (AssemblyManifest, MissingContext, etc.)
- **src/provisioning/register-providers.ts** - Shared provider registration (called from deploy.ts and destroy.ts)
- **src/types/** - Type definitions (config, state, resources, assembly, etc.)
- **src/utils/** - Logger, error handler, AWS client factory
- **build.mjs** - esbuild build script (ESM modules)
- **vitest.config.ts** - Vitest configuration

### SDK Providers

SDK Providers are in `src/provisioning/providers/`. See [README](../README.md) for the full list of supported resource types. Registration is centralized in `src/provisioning/register-providers.ts`.

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
- graphlib has special handling for ESM compatibility

### 3. CLI Configuration Resolution

- `--app` (`-a`) is optional: falls back to `CDKD_APP` env var, then `cdk.json` `"app"` field. Accepts either a shell command (`"npx ts-node app.ts"`) or a path to a pre-synthesized cloud assembly directory (`cdk.out`); when a directory is given, synthesis is skipped and the manifest is read directly.
- `--state-bucket` is optional: falls back to `CDKD_STATE_BUCKET` env var, then `cdk.json` `context.cdkd.stateBucket`
- `--context` / `-c` is optional: accepts `key=value` pairs (repeatable), merged with cdk.json context (CLI takes precedence)
- Stack names are positional arguments: `cdkd deploy MyStack` (not `--stack-name`)
- `--all` flag targets all stacks for deploy/diff/destroy (`destroy --all` only targets stacks from the current CDK app via synthesis)
- Wildcard support: `cdkd deploy 'My*'`
- Single stack auto-detected (no stack name needed)
- Concurrency options: `--concurrency` (resource ops, default 10), `--stack-concurrency` (stacks, default 4), `--asset-publish-concurrency` (S3+ECR, default 8), `--image-build-concurrency` (Docker builds, default 4)
- `-y` / `--yes` is a global flag (CDK CLI parity) that auto-confirms interactive prompts (e.g. `destroy`). `cdkd destroy` additionally accepts `-f` / `--force` — a destroy-specific flag with the same effect as `-y` in this context (matching CDK CLI, where `--force` is per-subcommand and overlaps with the global `--yes` only in the destroy confirmation path)
- Implemented in `src/cli/config-loader.ts`

### 4. Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- ResponseURL uses S3 pre-signed URL for cfn-response handlers
- CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection
- Async CRUD with polling (max 1hr), pre-signed URL validity 2hr
- Implemented in `CustomResourceProvider`

### 5. Synthesis

- Synthesis orchestration (no external CDK toolkit dependencies; CDK app itself generates templates)
- `AppExecutor` runs CDK app as subprocess with env vars (CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION, etc.)
- `AssemblyReader` parses Cloud Assembly manifest.json directly (recursively traverses nested assemblies for CDK Stage support)
- `Synthesizer` orchestrates synthesis with context provider loop for missing context resolution
- Context providers: see `src/synthesis/context-providers/` for full list (in `src/synthesis/context-providers/`)
- `ContextStore` manages cdk.context.json read/write

### 6. Asset Publishing

- Self-implemented (no external CDK asset libraries)
- `FileAssetPublisher` handles S3 file upload with ZIP packaging (using `archiver`)
- `DockerAssetPublisher` handles ECR Docker image build & push
- `AssetPublisher` orchestrates using above publishers (standalone `publish-assets` command)
- For `deploy`, `WorkGraph` manages asset nodes directly: file assets as `asset-publish` nodes, Docker assets as `asset-build → asset-publish` node chains
- `AssetManifestLoader` loads asset manifests from cdk.out

### 7. Intrinsic Function Resolution

- Implemented in `IntrinsicResolver` class (`src/analyzer/intrinsic-resolver.ts`)
- Ref: References other resource's PhysicalId
- Fn::GetAtt: Gets resource attributes (from state.attributes)
- Fn::Join: String concatenation
- Fn::Sub: Template string substitution

### 8. Dependency Analysis

- Implemented in `DagBuilder` class (`src/analyzer/dag-builder.ts`)
- Scans template to detect `Ref` / `Fn::GetAtt` / `DependsOn`
- Builds DAG with graphlib
- Determines execution order with topological sort
- **Implicit edge for Custom Resources**: any `AWS::IAM::Policy` / `AWS::IAM::RolePolicy` / `AWS::IAM::ManagedPolicy` attached to a Custom Resource's ServiceToken Lambda execution role automatically gets an edge to the Custom Resource, preventing the handler from being invoked before inline policy attachment returns (avoids mid-deploy AccessDenied race)
- **Implicit edge for Lambda VpcConfig**: every `AWS::EC2::Subnet` / `AWS::EC2::SecurityGroup` referenced by a Lambda's `Properties.VpcConfig.SubnetIds` / `SecurityGroupIds` gets an explicit edge to the Lambda (`src/analyzer/lambda-vpc-deps.ts`). Defense-in-depth on top of `extractDependencies`; for the reversed deletion traversal this guarantees Lambda is removed before its Subnet/SG so the asynchronous ENI detach has time to complete before EC2 rejects the subnet/SG delete with `DependencyViolation`.
- **Type-based deletion ordering rules**: `src/analyzer/implicit-delete-deps.ts` centralizes type-pair rules (e.g. VPC after Subnet, Subnet after Lambda) shared by the deploy DELETE phase and the standalone destroy command.

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

### Rollback Testing (failure injection)

- Environment variable `CDKD_TEST_FAIL=true` injects a deliberately-failing
  resource (an `AWS::SQS::Queue` with an out-of-range `MessageRetentionPeriod`)
  into the `basic` stack
- Verifies against real AWS that already-completed siblings get rolled back
  when one resource fails: `CDKD_TEST_FAIL=true cdkd deploy CdkdBasicExample`
- After rollback, S3 and SSM Document should both be deleted and state file
  should be empty

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
- ✅ Per-resource partial state save (prevents orphaned resources mid-deploy)
- ✅ Pre-rollback state save on failure (tracks resources completed concurrently with the failed one)
- ✅ Event-driven DAG dispatch (each resource starts as soon as its own deps complete; no level barrier)
- ✅ CREATE retry with exponential backoff (IAM propagation delays)
- ✅ CC API polling with exponential backoff (1s→2s→4s→8s→10s)
- ✅ Compact output mode (default clean output, `--verbose` for full details)
- ✅ `--state-bucket` auto-resolves from STS account ID: `cdkd-state-{accountId}-{region}`
- ✅ CC API GetResource returns GetAtt-compatible attribute names (no mapping needed)
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
- ✅ Implicit delete dependency: Subnet/SecurityGroup must be deleted AFTER Lambda::Function (avoids Lambda VpcConfig ENI detach race in DependencyViolation)
- ✅ CloudFront OAI S3CanonicalUserId enrichment
- ✅ DynamoDB StreamArn enrichment via DescribeTable
- ✅ API Gateway RootResourceId enrichment via GetRestApi
- ✅ isRetryableError with HTTP status code (429/503) + cause chain
- ✅ CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection, max 1hr polling, pre-signed URL 2hr
- ✅ Lambda FunctionUrl attribute enrichment (GetFunctionUrlConfig API)
- ✅ CloudFront + Lambda Function URL integration test (6/6 CREATE+DESTROY)
- ✅ Removed attribute-mapper and schema-cache (CC API returns GetAtt-compatible names directly)
- ✅ CDK synthesis orchestration without toolkit-lib (removed @aws-cdk/toolkit-lib and @aws-cdk/cloud-assembly-api)
- ✅ Self-implemented asset publishing (removed @aws-cdk/cdk-assets-lib, using archiver for ZIP)
- ✅ Context providers for missing context resolution (see `src/synthesis/context-providers/` for full list)
- ✅ Cloud Assembly manifest.json direct parsing with custom type definitions
- ✅ Nested cloud assembly traversal (CDK Stage support)
- ✅ WorkGraph DAG orchestrator for asset publishing and stack deployment (build→publish→deploy pipeline)
- ✅ Concurrency options: `--asset-publish-concurrency` (default 8), `--image-build-concurrency` (default 4)
- ✅ Lambda VpcConfig SDK provider support (avoids CC API fallback) + pre-delete VPC detach (UpdateFunctionConfiguration with empty arrays) + wait for LastUpdateStatus=Successful before DeleteFunction (otherwise the in-flight detach is aborted and ENIs stay attached) + ENI Description match by token prefix (CDK-generated function names carry an 8-char suffix that the ENI Description omits) + delstack-style ENI cleanup (filter `description=AWS Lambda VPC ENI-*` — NOT `requester-id=*:awslambda_*`, which never matches because real Lambda hyperplane ENI RequesterIds are AROA principal ids that do not contain the literal string "awslambda" — initial 10s sleep, then per-ENI parallel delete with a 30-minute retry budget) on delete — AWS's hyperplane ENI release is eventually-consistent and can take 5–30 minutes in practice, so a shorter budget races ahead and leaves ENIs attached + side-channel ENI cleanup retry on EC2 Subnet / SecurityGroup delete (last-resort sweep for cases where the Lambda-side cleanup ran out of budget) — `DeleteFunction` alone does not synchronously release Lambda hyperplane ENIs, AWS reclaims them only eventually

## Dependencies

### Key Dependencies

- `@aws-sdk/client-*` - AWS SDK v3 (various services)
- `graphlib` - DAG construction
- `archiver` - ZIP packaging for file assets

### Dev Dependencies

- `esbuild` - Build tool
- `vitest` - Testing framework
- `eslint` - Linting
- `prettier` - Formatting
- `typescript` - Type checking

## Node.js Version

- **Required**: Node.js >= 20.0.0 (from `package.json` engines field)

## Workflow Rules

- **When adding new functionality or fixing bugs**: Always add corresponding unit tests. Do not wait to be asked.
- **After modifying source code**: Always run `pnpm run build` before telling the user to test. The user runs cdkd via `node dist/cli.js`, so source changes without a build have no effect.
- **Before every commit**: Two markgate gates guard `git commit` via `.claude/hooks/check-gate.sh`. Both must be fresh:
  - `check` — recorded by `/check` (typecheck, lint, build, tests). Scope: `src/**`, `tests/**`, build/test configs (see `.markgate.yml`). Only invalidated by changes in that scope.
  - `docs` — recorded by `/check-docs` (README.md / CLAUDE.md / docs/ consistency with src). Scope: `src/**`, `docs/**`, `README.md`, `CLAUDE.md`. Only invalidated by changes in that scope.

  **Run the required skills proactively** before attempting the commit — look at `git status` / `git diff --cached --name-only` and match it against each gate's scope: a tests-only commit only needs `/check`; a docs-only commit only needs `/check-docs`; a src edit needs both; changes that fall outside both scopes (e.g. `.claude/**`, `.markgate.yml`) need neither. The hook is a safety net, not the primary trigger — if you see "Blocked by check-gate", the message names exactly which skill to re-run, but getting there means you skipped the proactive step. `/verify-pr` refreshes both markers in one shot. Install markgate via `mise install` at the repo root (see CONTRIBUTING.md).
- **Before merging any PR that touches deletion logic**: A third markgate gate, `integ-destroy`, guards `gh pr merge` via `.claude/hooks/integ-destroy-gate.sh`. Scope: `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`, `src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/implicit-delete-deps.ts`, `src/analyzer/lambda-vpc-deps.ts`. Only `/run-integ` sets it, and only when the destroy step finished with 0 errors AND the post-destroy AWS state was empty. So a PR whose destroy path has not been verified against real AWS is **physically unmergeable** — the hook blocks `gh pr merge` until you run `/run-integ <test>` and it succeeds end-to-end. This is the structural enforcement of the "never merge a PR whose destroy path is unverified" rule below.
- **Never commit or push directly to `main`**: All changes must land via a feature branch + PR. Before committing, run `git switch -c <branch>` (e.g., `fix/xxx`, `feat/xxx`, `docs/xxx`). A PreToolUse hook (`.claude/hooks/branch-gate.sh`) blocks `git commit` and `git push` when the current branch is `main` or `master` — if you see "Blocked by branch-gate", create a feature branch and retry.
- **Before creating or merging a PR**: Run `/verify-pr` (adds CI status, docs consistency, AWS resource cleanup, code review on top of `/check`)
- **When running integration tests**: Use `/run-integ` with the appropriate test name (e.g., `/run-integ lambda`). **Never bypass the skill** by manually invoking `cdkd deploy` / `cdkd destroy` from a shell — the skill encodes the deploy + destroy + orphan-resource verification in a single block, and skipping any step (e.g. relying on a successful deploy without running destroy) has historically caused us to merge changes whose destroy path was broken.
- **After running integration tests**: Verify no leftover AWS resources remain (`aws s3 ls s3://cdkd-state-{accountId}-{region}/stacks/` should return empty or error). **If the destroy step failed or left orphans, you MUST clean them up via direct AWS API calls before doing anything else** (use `/cleanup` if applicable, otherwise `aws ec2 delete-*` etc.) — leaving orphan resources after an integ run is never acceptable, regardless of whether the test passed.
- **Never merge a PR whose destroy path is unverified**: If a change touches deletion logic (any provider's `delete()`, DAG order on destroy, state cleanup, etc.), the integ test must complete the **destroy** step successfully (not just deploy) before the PR is mergeable. A green CI is necessary but not sufficient — CI does not exercise real-AWS destroy.
- **After fixing documentation or code**: Commit to a feature branch (not `main`) and push immediately. Do not leave uncommitted changes. Before reporting completion to the user, always run `git status` to verify nothing is uncommitted and that you are not on `main`.
- **English-only for committed files**: This is an OSS project. All committed files (source code, shell scripts, hook messages, config files such as `.claude/settings.json`, docs, comments, commit messages, PR titles/bodies) MUST be written in English. Do not use Japanese characters (hiragana, katakana, kanji) in any committed artifact. Conversation with the user in chat may be in Japanese — this rule applies only to files that land in the repository.
