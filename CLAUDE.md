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
   - **Region-prefixed key layout (`version: 2`, since PR 1)**:
     - State: `s3://bucket/cdkd/{stackName}/{region}/state.json`
     - Lock:  `s3://bucket/cdkd/{stackName}/{region}/lock.json`
   - The same `stackName` in two regions has two independent state files —
     changing `env.region` no longer silently overwrites the prior region.
   - Legacy `version: 1` layout (`cdkd/{stackName}/state.json`) is still
     readable; the next write auto-migrates and deletes the legacy key.
   - An old cdkd binary fails clearly on a `version: 2` blob instead of
     silently mishandling unknown fields.
   - State bucket region is resolved dynamically via `GetBucketLocation` (`src/utils/aws-region-resolver.ts`); the state-bucket S3 client is rebuilt for the bucket's actual region before any state operation, so the CLI works regardless of the profile region. Provisioning clients (CC API, Lambda, IAM, etc.) keep using `env.region` — only the state-bucket S3 client is region-corrected.

3. **Event-driven DAG Execution**
   - Analyzes dependencies via `Ref` / `Fn::GetAtt` / `DependsOn`
   - Dispatches each resource as soon as ALL of its own dependencies complete (no level barrier — downstream work does not wait for unrelated siblings in the same DAG level)
   - Bounded by `--concurrency` across the whole stack
   - Implemented in `src/deployment/dag-executor.ts`

4. **Intrinsic Function Resolution**
   - All CloudFormation intrinsic functions supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`, `Fn::GetStackOutput`, `Fn::FindInMap`, `Fn::Base64`, `Fn::GetAZs`, `Fn::Cidr`
   - `Fn::GetStackOutput` reads the producer stack's output directly from cdkd's S3 state (`s3://{bucket}/cdkd/{StackName}/{Region}/state.json`) — no Export needed, and `Region` may differ from the consumer's deploy region (same-account cross-region works out of the box because the state bucket name is account-scoped, not region-scoped). `RoleArn` (cross-account) is rejected with a clear error: cdkd uses S3 state instead of `cloudformation:DescribeStacks`, so cross-account would require assuming the role and reading the producer account's separate state bucket — not yet implemented.

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

- **src/cli/** - CLI command implementations (deploy, destroy, diff, drift, synth, list/ls, bootstrap, force-unlock, import, publish-assets, state), config resolution.

  **Top-level vs `state` subcommand split**: top-level commands (`deploy`, `destroy`, `diff`, `synth`, `list`, `import`, `orphan`) require a CDK app — they synthesize a template to know what they're operating on. The `cdkd state ...` subcommand family (`state info`, `state list`, `state resources`, `state show`, `state orphan`, `state destroy`, `state migrate`) operates on the S3 state bucket only and does NOT need the CDK code; it's the right place to inspect / clean up state when the CDK app is missing or you don't want to synth. `cdkd drift <stack>` is also state-driven (no synth), since it compares state-recorded properties to the AWS-current snapshot returned by each provider's optional `readCurrentState` method — a CC-API fallback covers the majority of resource types out of the box; SDK Providers add their own `readCurrentState` incrementally. The two `orphan` commands operate at **different granularities** (this is the breaking change in PR #92): `cdkd orphan <constructPath>...` is **per-resource** (mirrors upstream `cdk orphan --unstable=orphan`) and rewrites every sibling reference (Ref / Fn::GetAtt / Fn::Sub / dependencies) so the next deploy doesn't re-create the orphan; `cdkd state orphan <stack>...` is **whole-stack** and removes the entire state record without touching siblings. Both orphan variants delete ONLY cdkd state; AWS resources are left intact (use `destroy` / `state destroy` to delete them).

  `cdkd import <stack> --app "..."` adopts AWS-deployed resources into cdkd state. Three modes: (1) **auto** (no flags) — every resource in the template is looked up by its `aws:cdk:path` tag (cdkd's value-add over CDK CLI for whole-stack adoption); (2) **selective** (CDK CLI parity, default whenever `--resource <logicalId>=<physicalId>`, `--resource-mapping <file.json>`, or `--resource-mapping-inline '<json>'` is supplied) — ONLY the listed resources are imported, every other template resource is reported as `out of scope` and left out of state for the next deploy to CREATE. Matches `cdk import --resource-mapping` / `--resource-mapping-inline` semantics, including refusing to silently no-op on a typo'd logical ID; `--resource-mapping` and `--resource-mapping-inline` are mutually exclusive (matches upstream); (3) **hybrid** (`--auto` with overrides) — listed resources use the explicit physical id; the rest still go through tag-based auto-import (the pre-PR default, now opt-in). `--record-resource-mapping <file>` writes cdkd's resolved `{logicalId: physicalId}` map (covers explicit overrides AND auto / hybrid mode tag-lookups) to disk before the confirmation prompt — emitted even when the user says "no" or under `--dry-run`, so the resolved data can be replayed as `--resource-mapping` in non-interactive CI re-runs (mirrors `cdk import --record-resource-mapping`). **Existing-state semantics**: selective mode is non-destructive — listed resources are merged into the existing state file and unlisted entries are preserved. `--force` is required only when the import would lose data: auto / whole-stack mode against existing state (rebuilds the resource map from the template, dropping any state entry not re-imported), or selective mode where a listed override would overwrite a resource already in state. First-time imports against an empty state never need `--force`. Outputs in the existing state are inherited by both modes (the import flow never derives outputs). `--migrate-from-cloudformation [cfn-stack-name]` (cdkd-specific) extends the import flow with an end-to-end migration path off CloudFormation. The flow: (1) **before** the import loop, `getCloudFormationResourceMapping(...)` (in `src/cli/commands/retire-cfn-stack.ts`) issues a single `DescribeStackResources` against the named CFn stack and merges the resulting `Map<logicalId, physicalId>` into the import overrides (user-supplied `--resource` / `--resource-mapping` entries take precedence). This side-steps cdkd's tag-based auto-lookup — which can't find resources deployed by upstream `cdk deploy` (that flow doesn't propagate `Metadata.aws:cdk:path` as an AWS tag, and AWS reserves the `aws:` tag prefix so cdkd can't add it on the way through either) — so a bare `cdkd import MyStack --migrate-from-cloudformation` works for both `cdk deploy`-managed and `cdkd deploy`-managed stacks. The flag also forces `selectiveMode = false` regardless of override count (the CFn-derived overrides shouldn't trigger selective mode, which would mark every other template resource `out of scope` and orphan them after `DeleteStack`). (2) Import runs and writes state. (3) **After** state write, `retireCloudFormationStack(...)` runs the standard `DescribeStacks` (verify stable terminal state, capture existing `Capabilities`) → `GetTemplate` Original-stage (parse JSON, inject `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` on every resource) → `UpdateStack` (skipped when the diff is empty or every resource already has both Retain policies) → `DeleteStack` (CFn skips every resource because they're now Retain). Runs inside the import command's lock-protected scope so a concurrent `cdkd deploy` can't race the post-write CFn calls; only runs when state was actually written (zero-imports or "no" at the prompt skip the retirement). The flag accepts an optional value: bare `--migrate-from-cloudformation` uses the cdkd stack name as the CFn stack name (typical for CDK apps where they match); pass `--migrate-from-cloudformation <name>` to override when the names differ. Limitations: JSON-only (CDK-generated templates — generic YAML libraries silently strip CFn shorthand intrinsics like `!Ref` / `!GetAtt` / `!Sub` on round-trip and corrupt the template, so YAML support is deferred until a CFn-aware codec is in scope). Templates up to the 51,200-byte inline `TemplateBody` ceiling are submitted directly; larger templates are uploaded to the cdkd state bucket under `cdkd-migrate-tmp/<stack>/<timestamp>.json` and submitted via `TemplateURL` (the transient object is deleted in a `finally` immediately after `UpdateStack`, success or failure). Templates over the 1 MB CloudFormation `TemplateURL` ceiling are structurally unsubmittable and fail with a clear error; cdkd state is already written so the user can re-run or finish manually. Not compatible with `--dry-run` (post-state-write retirement is a real side-effect). Plain (non-CDK) CloudFormation stacks are out of scope: chain `cdk migrate` (upstream L1 generation) → `cdkd import --migrate-from-cloudformation` instead.

  **`provider.import` support coverage**: see [docs/import.md](docs/import.md) for the full per-resource-type list (auto-lookup vs override-only vs CC-API fallback vs unsupported). Single source of truth — when adding `import()` support to a provider, update that file. Keep entries one-per-line so parallel PRs don't conflict on rebase.

  **`cdkd import` vs upstream `cdk import` — parity notes** (see [docs/import.md](docs/import.md) for the full matrix; this is a quick checklist when working on the import code path):

  - **Mechanism is per-resource SDK calls, not a CloudFormation changeset.** `cdkd import` is therefore **not atomic**. `import.ts` collects per-resource outcomes (`imported` / `skipped-not-found` / `skipped-no-impl` / `skipped-out-of-scope` / `failed`) and only writes state after a final confirmation (`--yes` to skip). A partial import can be backed out with `cdkd state orphan <stack>`.
  - **No interactive prompt for missing IDs.** Upstream's TTY default prompts per resource; cdkd looks IDs up by `aws:cdk:path` tag (in `auto` / `hybrid` modes) or treats them as `out of scope` (in selective mode). The only prompt is the final "write state?" gate.
  - **`--resource-mapping <file>`: parity.** Same JSON shape (`{"LogicalId": "physical-id"}`) and same semantics — only listed resources imported, unlisted resources rejected, typo'd logical IDs abort before any AWS call.
  - **`--resource-mapping-inline '<json>'`: parity.** Same JSON shape as `--resource-mapping <file>`, mutually exclusive with it. Useful in non-TTY CI scripts that don't want a separate file.
  - **`--record-resource-mapping <file>`: parity.** cdkd writes the resolved `{logicalId: physicalId}` map to the file before the confirmation prompt (and even when the user says "no" or under `--dry-run`). Covers explicit overrides AND cdkd's tag-based auto-lookup, so this is the canonical way to capture an `auto`-mode resolution and replay it as `--resource-mapping` in CI.
  - **`--force` semantics differ.** Upstream: "continue even if the diff has updates/deletions." cdkd: "confirm a destructive write to existing state" — required for auto / whole-stack rebuild on existing state, and for overwriting a listed entry already in state during selective mode; not required for a pure selective merge that only adds new resources, nor for first-time imports. Same flag name, different meaning — do not confuse them when reading PRs / issues.
  - **`auto` and `hybrid` modes are cdkd-specific** (whole-stack tag-based import via `aws:cdk:path`). No upstream equivalent. Do not mistake them for parity features.
  - **`--migrate-from-cloudformation [name]` is cdkd-specific.** End-to-end migration off CloudFormation: pre-import `DescribeStackResources` to recover physical IDs (so cdk-deployed stacks work without `--resource`) → import → state write → post-import `UpdateStack` (inject Retain; uploaded to the cdkd state bucket via `TemplateURL` when over the 51,200-byte inline limit, hard-rejected over the 1 MB `TemplateURL` ceiling) → `DeleteStack`. No upstream equivalent — `cdk import` only adopts resources INTO a CFn stack, never out of one. JSON-only, incompatible with `--dry-run` (see the import section above for the full constraint list).
  - **Nested CloudFormation stacks (`AWS::CloudFormation::Stack`) are unsupported on both sides.** cdkd has no `AWS::CloudFormation::Stack` provider, so these resources show up as `unsupported` in the import summary. CDK Stages (separate top-level stacks under one app) work fine.
  - **No CDK bootstrap version requirement.** cdkd uses its own S3 state bucket; the upstream "bootstrap v12+" caveat does not apply.

  `state` is a parent command for inspecting and manipulating cdkd's S3 state bucket: `state info` prints bucket name, region (auto-detected via `GetBucketLocation`), the source that resolved the bucket (`cli-flag` / `env` / `cdk.json` / `default` / `default-legacy`), the schema version, and a stack count (with `--json` for tooling); `state list` (alias `ls`) lists deployed stacks (one row per `(stackName, region)` pair under the new region-prefixed key layout); `state resources <stack>` and `state show <stack>` accept `--stack-region <region>` to disambiguate when the same stackName has state in multiple regions; `state orphan <stack>...` removes cdkd's state record for every region by default, or scopes to one with `--stack-region <region>` (does NOT delete AWS resources — name mirrors aws-cdk-cli's new `cdk orphan`); `cdkd orphan <constructPath>...` is the synth-driven, **per-resource** counterpart (mirrors upstream `cdk orphan --unstable=orphan`) — it removes specific resources from a stack's state file by construct path (`MyStack/MyTable`), live-fetching every `Fn::GetAtt` it has to substitute via the resource's `provider.getAttribute()` (cached per `(orphan, attr)`) and rewriting every sibling `Ref` / `Fn::GetAtt` / `Fn::Sub` / `dependencies` reference so the next deploy doesn't try to re-create the orphan or fail on a stale reference. Path matching is **prefix-based** (matches upstream's behavior): the user's input matches every resource whose `aws:cdk:path` is exactly the input OR starts with `<input>/`, so an L2 path like `MyStack/MyConstruct/MyBucket` resolves to the synthesized L1 child `MyStack/MyConstruct/MyBucket/Resource`, and an L2 wrapper that contains multiple CFn resources orphans every child under it. The `aws:cdk:path` index in `src/cli/cdk-path.ts` excludes `AWS::CDK::Metadata` resources so the synthesized `<Stack>/CDKMetadata/Default` sentinel is never offered as an "available path" and cannot be orphaned; unresolvable references hard-fail with a one-shot list of every site, and `--force` falls back to the orphan's `state.attributes` cache (logging a per-case warning) before leaving the original intrinsic untouched if the cache also lacks the attr; `--dry-run` prints the rewrite audit table without acquiring a lock or saving state. The implementation lives in `src/analyzer/orphan-rewriter.ts` (the recursion structure mirrors `IntrinsicFunctionResolver` but in the inverse direction: only orphan references are substituted, every other intrinsic is left alone) and `src/cli/cdk-path.ts` (the shared `aws:cdk:path` index, also used by `cdkd import`). The pre-PR `cdkd orphan <stack>` whole-stack behavior is gone — the command hard-fails with a redirect message that points to `cdkd state orphan <stack>` instead of silently routing. `state destroy <stack>...` deletes AWS resources AND the state record without requiring the CDK app (the CDK-app-free counterpart to `cdkd destroy`). The per-stack destroy logic is hoisted into `src/cli/commands/destroy-runner.ts` and shared by both `cdkd destroy` and `cdkd state destroy`. `state migrate` copies all state from the legacy region-suffixed default bucket (`cdkd-state-{accountId}-{region}`) to the new region-free default (`cdkd-state-{accountId}`); refuses to run while any stack has an active lock; verifies object-count parity before any source cleanup; source bucket is kept by default and only deleted with `--remove-legacy`. The bucket-name banner is no longer printed in routine command output (it includes the AWS account id, which would leak via screenshots / public CI logs); pass `--verbose` to surface it in debug logs, or use `state info` for an explicit on-demand answer.
- **src/synthesis/** - CDK app synthesis (self-implemented: subprocess execution, Cloud Assembly parsing, context providers)
- **src/analyzer/** - DAG builder, template parser, intrinsic function resolution
- **src/state/** - S3 state backend, lock manager
- **src/deployment/** - DeployEngine (orchestration), WorkGraph (DAG-based asset+deploy scheduling)
- **src/provisioning/** - Provider registry, Cloud Control provider, SDK providers
- **src/assets/** - Asset publisher (self-implemented S3 file upload with ZIP packaging, ECR Docker image build & push)

### Important Files

- **src/cli/config-loader.ts** - Config resolution (cdk.json, env vars for `--app` and `--state-bucket`)
- **src/cli/stack-matcher.ts** - Shared stack-name matcher used by deploy/diff/destroy/list. Routes patterns by whether they contain `/` (display-path) or not (physical name) and returns a deduplicated union.
- **src/synthesis/app-executor.ts** - Executes CDK app as subprocess with proper env vars (CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION, etc.)
- **src/synthesis/assembly-reader.ts** - Reads and parses Cloud Assembly manifest.json directly
- **src/synthesis/synthesizer.ts** - Orchestrates synthesis with context provider loop
- **src/synthesis/context-providers/** - Context providers (see `src/synthesis/context-providers/` for full list) for missing context resolution
- **src/cli/commands/drift.ts** - `cdkd drift [<stack>...]` implementation. State-driven (no synth). Reads cdkd state from S3, asks each provider's optional `readCurrentState` for the AWS-current snapshot, and pipes the result through `src/analyzer/drift-calculator.ts`. Auto-selects the single stack in state when no positional arg / `--all` is given (mirrors `cdkd deploy` / `cdkd destroy`); errors with a listing when state has more than one stack. Exits 0 on no drift, 1 on drift detected, 2 on error. `--accept` / `--revert` are deferred to a follow-up PR.
- **src/analyzer/drift-calculator.ts** - State-vs-AWS property comparator used by `cdkd drift`. Only descends into keys present in cdkd state, so AWS-managed fields cdkd never set (timestamps, generated identifiers, account-wide defaults) cannot surface as false-positive drift. Accepts an optional `ignorePaths` list (sourced from each provider's `getDriftUnknownPaths`) to skip state property paths the provider deliberately cannot read back from AWS — e.g. Lambda `Code: { S3Bucket, S3Key }`, which `GetFunction` only returns as a pre-signed URL — so a clean run reports no drift on those keys instead of the guaranteed false positive that would otherwise fire on every invocation.
- **src/deployment/dag-executor.ts** - Generic event-driven DAG dispatcher (used inside a stack to schedule resource provisioning as soon as each resource's deps complete; no level barriers)
- **src/deployment/work-graph.ts** - WorkGraph DAG orchestrator for asset publishing and stack deployment
- **src/deployment/retryable-errors.ts** - Shared transient-error classifier (HTTP 429/503 + message-pattern table covering IAM/CW Logs/SQS/KMS/etc. propagation delays). Consumed by `withRetry` in `src/deployment/retry.ts` to decide whether to back off and retry vs. fail fast.
- **src/deployment/retry.ts** - Exponential-backoff retry helper used by DeployEngine; 1s -> 2s -> 4s -> 8s schedule capped at 8s for the typical AWS eventual-consistency window. Delegates retryable-error classification to `retryable-errors.ts`.
- **src/assets/file-asset-publisher.ts** - S3 file upload with ZIP packaging support
- **src/assets/docker-asset-publisher.ts** - ECR Docker image build & push
- **src/types/assembly.ts** - Cloud Assembly types (AssemblyManifest, MissingContext, etc.)
- **src/provisioning/register-providers.ts** - Shared provider registration (called from deploy.ts and destroy.ts)
- **src/types/** - Type definitions (config, state, resources, assembly, etc.)
- **src/utils/** - Logger, live progress renderer (multi-line in-flight task display), error handler (incl. `normalizeAwsError` for AWS SDK v3 synthetic UnknownError → actionable HTTP-status-keyed messages), AWS client factory, AWS region resolver (`aws-region-resolver.ts` — caches bucket-region lookups via `GetBucketLocation` so the state-bucket S3 client can be rebuilt for the bucket's actual region), stack output buffer (`stack-context.ts` — `AsyncLocalStorage`-backed per-stack log buffer used by `cdkd deploy` when more than one stack is running concurrently; the logger pushes into the active buffer instead of writing to stdout, and the deploy CLI flushes each buffer atomically when its stack finishes so per-stack output blocks don't interleave)
- **build.mjs** - esbuild build script (ESM modules)
- **vitest.config.ts** - Vitest configuration

### SDK Providers

SDK Providers are in `src/provisioning/providers/`. See [README](../README.md) for the full list of supported resource types. Registration is centralized in `src/provisioning/register-providers.ts`.

SDK Providers are preferred over Cloud Control API for performance -- they make direct synchronous API calls with no polling overhead. Cloud Control API is used as a fallback for resource types without an SDK Provider.

## State Schema

```typescript
interface StackState {
  version: 1 | 2 | 3;   // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties
  stackName: string;
  region?: string;      // Required on version >= 2 (load-bearing for the S3 key)
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  lastModified: number;
}

interface ResourceState {
  physicalId: string;                       // AWS physical ID
  resourceType: string;                     // e.g., "AWS::S3::Bucket"
  properties: Record<string, any>;          // Resolved template intent (what cdkd was asked to deploy)
  observedProperties?: Record<string, any>; // AWS-current snapshot at deploy time (drift baseline)
  attributes: Record<string, any>;          // For Fn::GetAtt resolution
  dependencies: string[];                   // For proper deletion order
}
```

**`observedProperties`** is populated on each successful create / update by
calling `provider.readCurrentState` fire-and-forget after the resource flips
to its new state. The deploy critical path does NOT block on these — the
in-flight set is drained right before the final state save so the cost is
~`max(per-resource readCurrentState latency)` ≈ 200-300ms in practice.
`cdkd import` populates the same field synchronously (parallel
`Promise.all` over the imported set) right before the state write, so the
very first `cdkd drift` after adoption has a real AWS-current baseline
instead of the user's template intent. The field is the drift
comparator's preferred baseline; resources written by an older binary or
by a provider without `readCurrentState` keep `observedProperties:
undefined` and the comparator falls back to `properties` (the pre-v3
behavior). Pass `--no-capture-observed-state` (or set `cdk.json
context.cdkd.captureObservedState: false`) to disable the deploy-time
capture and regain the pre-v3 deploy time at the cost of weaker drift
detection.

## Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>): Promise<ResourceCreateResult>;
  update(physicalId: string, logicalId: string, resourceType: string, oldProperties: Record<string, unknown>, newProperties: Record<string, unknown>): Promise<void>;
  delete(physicalId: string, logicalId: string, resourceType: string, properties: Record<string, unknown>, context?: { expectedRegion?: string }): Promise<void>;
  getAttribute(physicalId: string, logicalId: string, resourceType: string, attributeName: string): Promise<any>;
}
```

The `context.expectedRegion` parameter on `delete` is the region recorded
in the stack state when the resource was created. Providers MUST verify
the AWS client's region against `context.expectedRegion` (via the shared
`assertRegionMatch()` helper in `src/provisioning/region-check.ts`)
before treating a `*NotFound` error as idempotent delete success — see
"DELETE idempotency" below and `docs/provider-development.md`.

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
- `--region` is **bootstrap-only** as of PR 5 (`docs/plans/05-region-flag-cleanup.md`). `cdkd bootstrap` uses it to pick the region of the new state bucket; every other command (`deploy`, `destroy`, `diff`, `synth`, `list`, `state`, `force-unlock`, `publish-assets`) accepts `--region` for backward compatibility but emits a deprecation warning and ignores the value — provisioning clients pick up the region from `AWS_REGION` / the AWS profile, and the state-bucket client auto-detects the bucket's region via `GetBucketLocation` (PR 3).
- `--context` / `-c` is optional: accepts `key=value` pairs (repeatable), merged with cdk.json context (CLI takes precedence)
- Stack names are positional arguments: `cdkd deploy MyStack` (not `--stack-name`)
- `--all` flag targets all stacks for deploy/diff/destroy (`destroy --all` only targets stacks from the current CDK app via synthesis)
- Wildcard support: `cdkd deploy 'My*'`
- Stack selection accepts both forms (CDK CLI parity): the **physical** CloudFormation stack name (`MyStage-MyStack`) and the **hierarchical display path** from CDK synth (`MyStage/MyStack`). Patterns containing `/` are matched against the display path; patterns without `/` are matched against the physical name. This makes Stage-scoped wildcards like `cdkd deploy 'MyStage/*'` work as expected. For `destroy`, display-path matching requires synth to succeed (state alone only carries physical names). Implemented in `src/cli/stack-matcher.ts`.
- Single stack auto-detected (no stack name needed)
- `cdkd list` (alias `ls`) — CDK CLI parity. Default output: each stack's CDK display id on its own line, ordered by dependency — `<displayPath> (<physicalStackName>)` when the two differ (Stage-scoped stacks), else just the display path. `--long` / `-l` emits structured `{id, name, environment, [dependencies]}` records (YAML, or JSON with `--json`); `--show-dependencies` / `-d` emits `{id, dependencies}` pairs (id uses the same parens form). Positional patterns filter by physical name or display path with the same routing rules as deploy/diff/destroy. No state bucket / AWS credentials needed beyond what synthesis itself requires.
- Concurrency options: `--concurrency` (resource ops, default 10), `--stack-concurrency` (stacks, default 4), `--asset-publish-concurrency` (S3+ECR, default 8), `--image-build-concurrency` (Docker builds, default 4)
- Per-resource timeout options (deploy + destroy + state destroy): `--resource-warn-after <duration_or_type=duration>` (default `5m`) and `--resource-timeout <duration_or_type=duration>` (default `30m`). Both flags are **repeatable** and accept either form per invocation: a bare `<duration>` (`30m`) sets the global default; `<TYPE>=<duration>` (`AWS::CloudFront::Distribution=1h`) adds a per-resource-type override. At each per-resource call site, resolution is `perTypeMs[resourceType] ?? max(provider.getMinResourceTimeoutMs?.(), globalMs) ?? compileTimeDefault` — per-type CLI override always wins; otherwise the provider's self-reported minimum (Custom Resource returns its 1h polling cap) lifts the deadline against the global default for that resource type only. Wraps each individual provider call (CREATE / UPDATE / DELETE in `provisionResource()` / `runDestroyForStack`'s per-resource delete loop) in a `Promise.race`-based deadline. The warn timer mutates the live renderer's task label in place (`[taking longer than expected, Nm+]`) and emits a `logger.warn` line via `printAbove`; the hard timer throws `ResourceTimeoutError` which is caught and wrapped as `ProvisioningError` at the same site as any other provider failure, so the existing rollback / state-preservation path runs unchanged. The 30m global default is intentional: most resources never need more, and long-running providers self-report their needed timeout — a Custom-Resource-heavy stack works out of the box without `--resource-timeout 1h` because the CR provider's `getMinResourceTimeoutMs()` reports its 1h polling cap, and a per-type override (`--resource-timeout AWS::CloudFormation::CustomResource=5m`) is the explicit escape hatch when a user wants to abort CR earlier. Durations accept `<n>s`/`<n>m`/`<n>h`; zero, negative, missing-unit, unknown-unit, malformed `TYPE` (must look like `AWS::Service::Resource`), and `warn >= timeout` (both globally and per-type) are all rejected at parse time. Helper at `src/deployment/resource-deadline.ts`; CLI parser at `src/cli/options.ts` (`parseResourceTimeoutToken` builds a `ResourceTimeoutOption = { globalMs?, perTypeMs }`); resolution helper `effectiveResourceTimeoutMs(resourceType, opt, fallbackMs)`. The cancellation is `Promise.race`-style — the underlying provider call keeps running for some time after the timer fires; threading `AbortController` through every provider is deferred.
- `-y` / `--yes` is a global flag (CDK CLI parity) that auto-confirms interactive prompts (e.g. `destroy`). `cdkd destroy` additionally accepts `-f` / `--force` — a destroy-specific flag with the same effect as `-y` in this context (matching CDK CLI, where `--force` is per-subcommand and overlaps with the global `--yes` only in the destroy confirmation path)
- Implemented in `src/cli/config-loader.ts`

### 4. Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- ResponseURL uses S3 pre-signed URL for cfn-response handlers
- CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection
- Async CRUD with polling (max 1hr), pre-signed URL validity 2hr
- Sets `disableOuterRetry = true` on the `ResourceProvider` interface so the deploy engine's outer `withRetry` loop does NOT re-invoke `provider.create()` on transient SDK errors. Each invocation derives a fresh pre-signed S3 URL and RequestId via `prepareInvocation()`; an outer retry would strand the first attempt's Lambda response at an S3 key nobody polls. Internal exponential-backoff polling on the response key handles eventual consistency on its own.
- Implements `getMinResourceTimeoutMs()` returning `asyncResponseTimeoutMs` (default 1h) so the deploy engine's per-resource deadline auto-lifts to the polling cap for CR resources only — Custom-Resource-heavy stacks no longer need `--resource-timeout 1h`. A user-supplied `--resource-timeout AWS::CloudFormation::CustomResource=<DURATION>` per-type override still wins as the explicit escape hatch.
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
- **CDK-defensive DependsOn relaxation (default-on)**: `src/analyzer/cdk-defensive-deps.ts` lists the (depender, dependee) type pairs CDK adds defensively for VPC-Lambda runtime egress (IAM Role / Policy / Lambda::Function / Lambda::Url / Lambda::EventSourceMapping → EC2 Route / SubnetRouteTableAssociation). The deploy code path constructs `DagBuilder({ relaxCdkVpcDefensiveDeps: true })` by default; the matching DependsOn edges are dropped at graph-build time so CloudFront Distribution + Lambda::Url + VPC Lambda dispatch in parallel with NAT Gateway stabilization (~55% faster on `bench-cdk-sample`). Pass `cdkd deploy --no-aggressive-vpc-parallel` to opt out (escape hatch for stacks where the user wants the strict CDK-defensive ordering — e.g. a Custom Resource that synchronously invokes a VPC Lambda outside cdkd's Lambda-ServiceToken Active wait). Only DependsOn entries in the allowlist are dropped — Ref / GetAtt and other DependsOn pairs are untouched.

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
5. Add the resource type to [docs/supported-resources.md](docs/supported-resources.md) (deploy/manage capability table) AND to [docs/import.md](docs/import.md) (import-side coverage: auto-lookup vs override-only vs sub-resource)

See [docs/provider-development.md](docs/provider-development.md) for details.

### Supporting a New Intrinsic Function

1. Extend `resolve()` method in `src/analyzer/intrinsic-resolver.ts`
2. Implement recursive resolution
3. Write tests (`tests/unit/analyzer/intrinsic-resolver.test.ts`)

### Debugging Deploy Flow

1. Use `--verbose` flag
2. Check log level (`src/utils/logger.ts`)
3. Check State file: `aws s3 cp s3://bucket/cdkd/{stackName}/{region}/state.json -`
4. See [docs/troubleshooting.md](docs/troubleshooting.md)

## Detailed Documentation

**Always refer to these documents**:

- **[docs/architecture.md](docs/architecture.md)** - Detailed architecture, deploy flows, design principles, end-to-end pipeline walkthrough
- **[docs/state-management.md](docs/state-management.md)** - S3 state structure, locking mechanism, troubleshooting
- **[docs/cli-reference.md](docs/cli-reference.md)** - CLI flag details (concurrency, --no-wait, per-resource timeout)
- **[docs/supported-resources.md](docs/supported-resources.md)** - Full per-type SDK Provider / Cloud Control coverage table
- **[docs/import.md](docs/import.md)** - `cdkd import` full guide (modes, flags, CFn migration, provider coverage)
- **[docs/provider-development.md](docs/provider-development.md)** - Provider implementation guide, best practices
- **[docs/troubleshooting.md](docs/troubleshooting.md)** - Common issues and solutions
- **[docs/testing.md](docs/testing.md)** - Testing guide, integration test examples

## Known Limitations

- NOT recommended for production use

**Recently Implemented** (2026-03-26):

- ✅ CLI: `--app` and `--state-bucket` optional (fallback to env vars / cdk.json)
- ✅ CLI: Positional stack names, `--all` flag, wildcard support, single stack auto-detection
- ✅ CLI: `cdkd destroy` accepts `--app` option; confirmation accepts y/yes
- ✅ CLI: `cdkd list` / `cdkd ls` (CDK CLI parity) — default per-line display path; `--long`, `--show-dependencies`, `--json` for structured output; reuses shared stack-matcher for pattern filtering
- ✅ CLI: `cdkd publish-assets` synth + build + publish (no deploy) — synthesizes the CDK app, selects target stacks via the standard chain (positional > `--stack` > `--all` > auto-detect with `matchStacks` from `src/cli/stack-matcher.ts`), and runs the same `AssetPublisher.addAssetsToGraph(...) → WorkGraph.execute(...)` pipeline that `deploy` uses — but with `stack: 0` concurrency so only `asset-build` / `asset-publish` nodes fire. No state writes, no provisioning, no lock acquisition. Per-stack accounting: a single stack's asset publish failure surfaces as `PartialFailureError` (exit 2) with the rest of the run completing, matching `cdkd destroy`'s exit-code policy. `-a/--app` accepts both a shell command and a path to a pre-synthesized cloud assembly directory (same dual semantics as `cdkd deploy`'s `-a`); pointing it at `cdk.out` skips synthesis. The legacy `--path <manifest>` flag is gone — pre-synthesized assemblies are re-used via `-a <dir>` instead, which keeps the publish-assets surface symmetric with deploy / diff / destroy. `--role-arn` plumbing is gated behind `src/utils/role-arn.ts` (TODO: PR A) — until then the SDK's standard credential chain applies. Implementation in `src/cli/commands/publish-assets.ts`.
- ✅ CLI: `cdkd import --migrate-from-cloudformation [cfn-stack-name]` — end-to-end migration off CloudFormation in a single command. Pre-import: `DescribeStackResources` recovers `(logicalId, physicalId)` pairs from the source CFn stack and merges them into the import overrides — so `cdk deploy`-managed stacks (which don't propagate `aws:cdk:path` as an AWS tag) work without per-resource `--resource` flags. The flag also forces auto mode (CFn-derived overrides don't trigger selective mode). Post-state-write: runs the AWS-recommended retirement (`DescribeStacks` → `GetTemplate` Original-stage → inject `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` → `UpdateStack` → `DeleteStack`) so the source CFn stack is retired without deleting the underlying AWS resources. JSON-only (CDK-generated templates); templates up to 51,200 bytes go inline via `TemplateBody`, larger templates are uploaded to the cdkd state bucket and submitted via `TemplateURL` (the transient object is deleted in a `finally` immediately after `UpdateStack`), templates over the 1 MB `TemplateURL` ceiling fail with a clear error (cdkd state is already written so the user can re-run or finish manually); incompatible with `--dry-run`. Helpers at `src/cli/commands/retire-cfn-stack.ts` (`getCloudFormationResourceMapping` + `retireCloudFormationStack` + `uploadTemplateForUpdateStack`)
- ✅ Resource replacement: immutable property changes trigger DELETE then CREATE
- ✅ Custom Resource ResponseURL: S3 pre-signed URL for cfn-response handlers
- ✅ CloudFormation Parameters support (with default values and type coercion)
- ✅ Intrinsic functions: Fn::Select, Fn::Split, Fn::If, Fn::Equals, Fn::And, Fn::Or, Fn::Not, Fn::ImportValue
- ✅ Conditions evaluation (with logical operators)
- ✅ Cross-stack references (Fn::ImportValue via S3 state backend)
- ✅ Cross-stack / cross-region references (Fn::GetStackOutput via S3 state backend) — same-account; cross-account RoleArn rejected with a clear error (not yet implemented)
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
- ✅ Live progress renderer (`src/utils/live-renderer.ts`) — multi-line in-flight task area at the bottom of the terminal during `deploy` / `destroy`, showing `Creating <logical-id>...` / `Deleting <logical-id>...` lines that disappear as each resource completes. Self-disables on non-TTY and when `CDKD_NO_LIVE=1` (the CLI sets this in `--verbose` mode so debug logs do not interleave with the live area). Multi-stack-aware: scopes each task by the calling stack (via `withStackName` AsyncLocalStorage) so `--stack-concurrency > 1` runs don't collide on the same `logicalId`, and switches to `[<StackName>] <label>` rows whenever more than one stack has tasks in flight (single-stack runs keep the un-prefixed clean form)
- ✅ Per-async-context stack name for resource-name generation (`src/provisioning/resource-name.ts`). Backed by `AsyncLocalStorage`; concurrent deploys (`--stack-concurrency > 1`) each have an isolated scope, so stack A's IAM Role create never picks up stack B's prefix. Use `withStackName(stackName, fn)` to wrap a deploy's body; the legacy `setCurrentStackName` setter now uses `enterWith` and is also concurrency-safe but `withStackName` is preferred at call sites for explicit scoping.
- ✅ Per-stack log buffering for parallel multi-stack deploys (`src/utils/stack-context.ts`). When `cdkd deploy` runs more than one stack at the same time (`--stack-concurrency > 1`), the CLI wraps each stack's body in `runStackBuffered(...)`; the logger detects the active `AsyncLocalStorage` buffer and pushes lines into it instead of writing to stdout. Each stack's buffered block is flushed atomically when the stack finishes, so per-stack output ("Changes: ...", `[N/N] ✅ ...`, "Deployment Summary", "✓ Deployment completed") stays grouped and stack A's "Deployment completed" never lands between stack B's progress lines. Single-stack runs do not buffer (real-time output preferred when there is no interleaving risk).
- ✅ `--state-bucket` auto-resolves from STS account ID: `cdkd-state-{accountId}` (region-free; legacy `cdkd-state-{accountId}-{region}` is still read with a deprecation warning, removed in a future PR — see `docs/plans/04-state-bucket-naming.md`). Bucket name is region-free because S3 names are globally unique; teammates with different profile regions all converge on the same bucket. The bucket's actual region is auto-detected via `GetBucketLocation` (PR 3). When **both** the new and the legacy bucket exist (typical after upgrading from v0.7.0 with a partial migration leaving an empty new bucket), the resolver picks the one that actually has state under `cdkd/` rather than always preferring new — falling back to legacy with a "run cdkd state migrate" warning when new is empty and legacy has state. This keeps `cdkd deploy` from re-creating already-deployed resources after an upgrade.
- ✅ CC API GetResource returns GetAtt-compatible attribute names (no mapping needed)
- ✅ Unit tests, integration examples, E2E test script
- ✅ DeletionPolicy: Retain support (skip deletion for retained resources)
- ✅ Resource replacement for immutable property changes (CREATE→DELETE)
- ✅ Type safety improvements (error handling, any type elimination in custom resources)
- ✅ Dynamic References: `{{resolve:secretsmanager:...}}` and `{{resolve:ssm:...}}`
- ✅ SDK Providers: see SDK Providers section above for full list
- ✅ ALL pseudo parameters supported (7/7 including AWS::StackName/StackId)
- ✅ DELETE idempotency (not-found/No policy found treated as success **only when client region matches state region** — region-mismatched destroys now surface `ProvisioningError` instead of silently stripping resources from state; helper at `src/provisioning/region-check.ts`)
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
- ✅ Custom Resource Invoke waits for the **backing Lambda** to be ready before invoking — `waitUntilFunctionActiveV2` then `waitUntilFunctionUpdatedV2` against the ServiceToken Lambda Arn, fired inside `CustomResourceProvider.sendRequest` immediately before the synchronous Invoke. Originally PR #121 placed the same wait inside `LambdaFunctionProvider.create()` to fix the "function is currently in the following state: Pending" race for Lambda-backed Custom Resources, but that doubled deploy time on benchmark stacks (every Lambda paid 5–10 min ENI-attach wait even when nothing synchronously invoked it). The follow-up moved the wait to the **one consumer** that actually breaks against a not-ready Lambda — synchronous Invoke — leaving every other downstream operation (EventSourceMapping, AddPermission, FunctionUrlConfig) free to proceed against a Pending function the way AWS already supports. Wait is gated on Lambda ServiceTokens only: SNS-backed Custom Resources skip it because SNS routes the message asynchronously and the subscribed Lambda's state is irrelevant at publish time. The post-Update wait inside `LambdaFunctionProvider.update()` (between UpdateFunctionConfiguration and UpdateFunctionCode, plus after UpdateFunctionCode) is **kept** — Update-then-Update racing is a self-inflicted in-provider problem and the wait costs ~200ms in the common case. The pre-delete `waitForLambdaUpdateCompleted` helper is intentionally separate — it accepts ANY non-`InProgress` LastUpdateStatus (including `Failed`) because the function is being deleted anyway and a prior failed update should not block the delete.
- ✅ `AWS::EC2::NatGateway` SDK provider (avoids CC API fallback). On deploy, default behavior matches CFN: `waitUntilNatGatewayAvailable` blocks until State=available (1–2 min typical). `cdkd deploy --no-wait` (env `CDKD_NO_WAIT=true`) skips the available-state wait — `CreateNatGateway` returns the `NatGatewayId` immediately and dependent Routes that only need the ID proceed against a still-`pending` gateway (AWS API allows this; the route resolves once the gateway flips to available). On destroy, `waitUntilNatGatewayDeleted` runs **unconditionally** — `--no-wait` is deploy-only and the destroy path never sets `CDKD_NO_WAIT`. The asymmetry is load-bearing: while the gateway is in `deleting` AWS keeps the ENI / EIP / route-table associations attached, so a concurrent `DeleteSubnet` / `DeleteInternetGateway` / `DeleteVpc` returns `DependencyViolation` and the deploy engine enters a retry storm (observed: ~17 min total destroy with 3 orphan resources when this guard was missing). Wait timeouts are 15-min caps (worst-case AWS provisioning time) bounded by the per-resource `--resource-timeout` outer deadline. `import` lookup uses `DescribeNatGateways` filtered by the `aws:cdk:path` tag, skipping `deleted` / `deleting` gateways which AWS retains in the API for some time post-delete.
- ✅ CDK-defensive VPC route DependsOn relaxation (**on by default** since v0.33.0; previously opt-in via `--aggressive-vpc-parallel` in v0.32.0): drops the CDK-injected defensive `DependsOn` edges from VPC Lambdas (and adjacent IAM Role / Policy / Lambda::Url / EventSourceMapping resources) onto the private subnet's `DefaultRoute` / `RouteTableAssociation`. CDK adds these conservatively for runtime egress, but `CreateFunction` / `CreateFunctionUrlConfig` / `AddPermission` / `CreateEventSourceMapping` all accept a function in `Pending` state — and cdkd's existing post-`CreateFunction` `State=Active` wait is already moved to `CustomResourceProvider.sendRequest` (PR #121 follow-up), so deploy-time downstream consumers don't break against a not-yet-ENI-attached Lambda. Relaxing the route DependsOn collapses `Distribution → Lambda::Url → Lambda::Function → DependsOn(DefaultRoute → NAT)` from a serial chain into `max(NAT, CF-propagation) ≈ CF` parallel — measured **−54.6%** on `bench-cdk-sample` (398.59s with `--no-aggressive-vpc-parallel` → 181.03s default), beating Enhanced (264s) by ~80s. v1 of this change (PR #126, v0.32.0) shipped as opt-in `--aggressive-vpc-parallel` because CloudFront `Create` / `Delete` are each ~5 min and a Lambda-side async failure incurs a high rollback cost; v2 (this entry) flips it default-on after the v0.32.0 burn-in proved the AWS-side behavior safe — the conservative-pessimist trap was that an opt-in optimization users have to know about defeats the point. Pass `cdkd deploy --no-aggressive-vpc-parallel` to opt out (escape hatch for stacks where the user wants strict CDK-defensive ordering — e.g. a Custom Resource that synchronously invokes a VPC Lambda outside cdkd's Lambda-ServiceToken Active wait). Type-pair allowlist in [src/analyzer/cdk-defensive-deps.ts](src/analyzer/cdk-defensive-deps.ts); plumbed via `DagBuilder({relaxCdkVpcDefensiveDeps})` consulted only on the deploy code path (destroy ordering is unaffected — the route DependsOn doesn't constrain delete-time correctness; Lambda hyperplane ENI release is the actual destroy bottleneck and is handled separately by `lambda-vpc-deps.ts`). Only DependsOn edges in the type-pair allowlist are dropped — Ref / GetAtt edges and DependsOn outside the list are untouched.
- ✅ `--role-arn <arn>` (env: `CDKD_ROLE_ARN`) on every cdkd command that talks to AWS (`deploy` / `destroy` / `diff` / `synth` / `list` / `bootstrap` / `force-unlock` / `import` / `orphan` / `state *` / `state migrate` / `publish-assets` / `drift`). Resolves once at command start via STS `AssumeRole` (1-hour session), then writes the temp creds into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars so every later `new AwsClients(...)` (~13 sites across the codebase) auto-picks them up via the SDK default chain. Implemented in `src/utils/role-arn.ts`; CLI option `roleArn` lives in `commonOptions` (`src/cli/options.ts`). The assumed role MUST carry admin-equivalent permissions for the resources being deployed — cdkd does NOT route through CloudFormation, so there is no cfn-exec-role to delegate to and CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT sufficient. Documented in [README.md](README.md) (Prerequisites note) and [docs/cli-reference.md](docs/cli-reference.md) (`--role-arn` section, with the role-permissions table and the why-cdkd-can't-reuse-CDK-CLI-bootstrap-roles explanation).
- ✅ `cdkd drift <stack>`: compares the `properties` recorded in cdkd state against the AWS-current snapshot returned by each provider's optional `readCurrentState` method. CC API fallback covers the majority of resource types out of the box via `GetResource`; first-class `readCurrentState` is also implemented in 34 SDK-Provider-managed resource types across three batches. **Batch 0 (PR D, 7 high-traffic types)**: `LambdaFunctionProvider` (via `GetFunction`), `S3BucketProvider` (via `GetBucketVersioning` + `GetBucketEncryption` + `GetPublicAccessBlock` + `GetBucketTagging`), `DynamoDBTableProvider` (via `DescribeTable`), `IAMRoleProvider` (via `GetRole` + `ListAttachedRolePolicies`; AssumeRolePolicyDocument is URL-decoded + JSON-parsed back to the object form cdkd state holds), `SQSQueueProvider` (via `GetQueueAttributes`; numeric / boolean strings type-coerced, RedrivePolicy JSON-parsed), `SNSTopicProvider` (via `GetTopicAttributes`; same type-coercion pattern), and `LogsLogGroupProvider` (via `DescribeLogGroups` filtered by exact name; camelCase API → PascalCase CFn property names). **Batch 1 (13 providers / 19 resource types)**: `CloudFrontOAIProvider` (`GetCloudFrontOriginAccessIdentity`), `EventBridgeBusProvider` (`DescribeEventBus`; Policy JSON-parsed), `EventBridgeRuleProvider` (`DescribeRule` + `ListTargetsByRule`; EventPattern JSON-parsed, EventBusName extracted from rule ARN), `SSMParameterProvider` (`GetParameter` + `DescribeParameters` for metadata; `WithDecryption: false` so SecureString values stay encrypted on the wire), `SecretsManagerSecretProvider` (`DescribeSecret`; ReplicationStatus → ReplicaRegions; SecretString deliberately not surfaced), `ECRProvider` (`DescribeRepositories` + `GetLifecyclePolicy`; LifecyclePolicyNotFoundException caught and key omitted), `StepFunctionsProvider` (`DescribeStateMachine`; SDK camelCase → CFn PascalCase, Definition JSON-parsed), `ECSProvider` (`DescribeClusters` / `DescribeServices` / `DescribeTaskDefinition`; Service physicalId is composite `<clusterArn>|<serviceName>`), `RDSProvider` (`DescribeDBInstances` / `DescribeDBClusters` / `DescribeDBSubnetGroups`), `KMSProvider` (`DescribeKey` for keys + `ListAliases` paginated for aliases; KeyPolicy body intentionally not retrieved), `ApiGatewayProvider` (`GetAccount` + `GetMethod`; sub-resources Authorizer / Resource / Deployment / Stage skipped because their physicalId doesn't carry parent RestApiId — interface limitation), `ApiGatewayV2Provider` (`GetApi`; same sub-resource limitation), `CognitoUserPoolProvider` (`DescribeUserPool`). **Batch 2 (this PR, 14 mid-traffic providers)**: `AppSyncProvider` (via `GetGraphqlApi` / `GetDataSource` / `GetResolver` / `ListApiKeys`; schema bodies out of scope), `EFSProvider` (via `DescribeFileSystems` + `DescribeLifecycleConfiguration` + `DescribeBackupPolicy`; per-feature errors omit individual keys), `ElastiCacheProvider` (via `DescribeCacheClusters` / `DescribeCacheSubnetGroups`), `ELBv2Provider` (via `DescribeLoadBalancers` / `DescribeTargetGroups` / `DescribeListeners`), `Route53Provider` (via `GetHostedZone` and `ListResourceRecordSets` filtered by composite physicalId), `WAFv2WebACLProvider` (via `GetWebACL`; ARN is parsed back to id/name/scope), `FirehoseProvider` (via `DescribeDeliveryStream`; destination configurations skipped due to shape divergence), `KinesisStreamProvider` (via `DescribeStream`; ShardCount derived from `Shards[]`), `GlueProvider` (via `GetDatabase` / `GetTable`), `CloudTrailProvider` (via `GetTrail` + best-effort `GetTrailStatus` + `GetEventSelectors`), `CloudWatchAlarmProvider` (via `DescribeAlarms` filtered by name), `CodeBuildProvider` (via `BatchGetProjects`; SDK camelCase → CFn PascalCase remap), `ServiceDiscoveryProvider` (via `GetNamespace` / `GetService`; `Vpc` skipped — not returned by GetNamespace), and `SNSSubscriptionProvider` (via `GetSubscriptionAttributes`; FilterPolicy JSON-parsed, RawMessageDelivery boolean-coerced). **Skipped (Batch 1)**: `CloudFrontDistributionProvider` (DistributionConfig SDK shape `Quantity + Items` vs CFn flat-array shape would balloon the diff for marginal gain over the CC API fallback). Each implementation mirrors what the same provider's `create()` accepts so the drift comparator only sees keys that are actually managed; AWS-managed fields (timestamps, FunctionArn, RevisionId, etc.) are filtered at the wire layer. Tag drift and IAM inline-policy bodies are deliberately out of scope for v1 (the `aws:cdk:path` auto-tag and per-name `GetRolePolicy` round-trips warrant a separate PR). Per-resource outcomes: `drifted` (one or more property paths differ — printed as `~ <logicalId>` with `+/-` lines), `clean` (state matches AWS), `unsupported` (provider does not implement `readCurrentState` yet — printed as `? <logicalId>` so users see what's still uncovered). Exits **0** when no drift, **1** when drift detected (signalled via a `silent: true` `DriftDetectedError` so the rich human report is the only output) OR command crashed (default error handler — same as every other cdkd command). State-driven (no synth needed) — flag set mirrors `state show`: `--all`, `--stack-region`, `--state-bucket`, `--state-prefix`, `--json`, `--profile`, `--verbose`. Comparator only descends into keys present in cdkd state, so AWS-managed fields (timestamps, generated identifiers, account-wide defaults) cannot fire false-positive drift. **Drift resolution** (mutually exclusive with each other; both honor `--dry-run`): `--accept` writes the AWS-current values back into cdkd state under the per-stack lock with `IfMatch` optimistic locking on the captured ETag (state ← AWS — use when a console edit is the intentional source of truth); `--revert` calls each drifted resource's `provider.update(logicalId, physicalId, type, stateProps /*new*/, awsProps /*old*/)` under the same lock, with the AWS-current snapshot reused from the drift read so no second read fires (AWS ← state — use to undo a console change). `--revert` failures are collected per-resource and surface as `PartialFailureError` (exit 2); state is NOT updated by `--revert` (AWS values match state once update succeeds). `-y/--yes` skips the confirm prompt; `--concurrency <n>` (default 4) caps `--revert`'s parallel `provider.update` calls. Implementation: `src/cli/commands/drift.ts` + `src/analyzer/drift-calculator.ts`; CC-API `readCurrentState` in `src/provisioning/cloud-control-provider.ts`; SDK provider `readCurrentState` impls under `src/provisioning/providers/`. **False-drift prevention for the CC API fallback (PR J)**: two guards keep the generic `GetResource` path from firing noise on resource types whose CC API response shape diverges from the CFn template shape that cdkd state stores. (1) `CC_API_FALLBACK_DENY_LIST` (`src/analyzer/drift-cc-api-deny-list.ts`) maps verified-divergent types (e.g. `AWS::IAM::ManagedPolicy` — URL-encoded `PolicyDocument`; `AWS::ApiGateway::RestApi` — write-only `Body` field; `AWS::CloudFormation::Stack`; `AWS::EC2::LaunchTemplate` — versioned `LaunchTemplateData`) to the human-readable reason, and the drift command short-circuits those types to `drift unknown` before the CC API call. The fix path for any deny-listed type is a first-class SDK-provider `readCurrentState`, not a per-entry tweak. (2) `stripCcApiAwsManagedFields` (`src/analyzer/cc-api-strip.ts`) recursively drops timestamp / owner / generated-id fields (`CreationDate`, `LastModifiedTime`, `OwnerId`, `RevisionId`, `LastUpdateStatus*`, `StackId`, ...) from CC API responses before the comparator sees them. The strip list is conservative: name-collision-prone fields that some CFn types use as legitimate inputs (`Status`, `State`, `VersionId`, `Arn`, `AccountId`, `StartTime`/`EndTime`) are intentionally NOT stripped, so a real `Status` change on `AWS::ECS::CapacityProvider.AutoScalingGroupProvider.ManagedScaling.Status` still surfaces as drift. A breadth-of-coverage fixture suite (`tests/unit/analyzer/drift-cc-api-shape-fixtures.test.ts`, ~10 representative CC-API-fallback types: `AWS::EC2::VPCEndpoint` / `AWS::SageMaker::Endpoint` / `AWS::Backup::BackupVault` / `AWS::SecurityHub::Hub` / `AWS::EC2::SecurityGroup` / `AWS::CloudWatch::Dashboard` / `AWS::SES::ConfigurationSet` / `AWS::AppRunner::Service` / `AWS::ECS::CapacityProvider` / `AWS::FSx::FileSystem` / `AWS::Pipes::Pipe`) verifies the pipeline (CC API response → strip → comparator) produces zero drift on a clean stack, so shape regressions are caught before users see them.
- ✅ `cdkd drift --revert` provider.update audit (PR I): walked every SDK Provider that has `readCurrentState` and verified that its `update()` either does the right thing or throws a new `ResourceUpdateNotSupportedError` (in `src/utils/error-handler.ts`, exit code 2 — same as `PartialFailureError`). Eight providers had silently no-op `update()` stubs that would have made `--revert` succeed without actually touching AWS — those now reject with the new error and a per-type "use cdkd deploy --replace, or destroy + redeploy" suggestion: `AppSyncProvider` (every type), `EFSProvider` (every type), `FirehoseProvider`, `ApiGatewayV2Provider` (every type), `ApiGatewayProvider` (Authorizer / Deployment / Method sub-resources), `GlueProvider` (Database), `ServiceDiscoveryProvider` (PrivateDnsNamespace + Service), `ELBv2Provider` (LoadBalancer — TargetGroup and Listener already had real updates and are unchanged). `CloudFrontOAIProvider.update` was upgraded from a no-op to a real `UpdateCloudFrontOriginAccessIdentity` call (Comment is the only mutable field; CallerReference is preserved from the existing OAI). `cdkd drift --revert`'s summary now distinguishes the two failure modes: `⊘ <stack>/<id> (<type>): could not revert — ...` for `ResourceUpdateNotSupportedError` (logged at `warn`) vs `✗ <stack>/<id>: AWS update failed — ...` for any other `provider.update` failure (logged at `error`). The summary line counts them separately ("N reverted, M update-not-supported, K failed"); both still combine into the exit-2 `PartialFailureError`. Sub-resource and policy-style providers without `readCurrentState` (lambda-permission, lambda-eventsource, lambda-layer, iam-policy, s3-bucket-policy, sns-topic-policy, sqs-queue-policy) were spot-checked but already had working `update()` (delete+add or PutPolicy) and are unchanged. Tests: 17 new unit tests, including a parameterised matrix asserting each immutable type rejects with `ResourceUpdateNotSupportedError`. Full audit results in `src/provisioning/providers/*.ts`; new error class in `src/utils/error-handler.ts`; `--revert` summary handling in `src/cli/commands/drift.ts`.
- ✅ Tags coverage in `cdkd drift` (PR H): every SDK Provider that has a tag API now surfaces `Tags` in its `readCurrentState` result. `aws:cdk:path` / `aws:cdk:metadata` (and any other `aws:`-prefixed entry) are filtered out of the AWS-current snapshot before comparison — those are CDK-internal construct metadata, not user-managed `Tags` properties, so leaving them in would fire false-positive drift on every CDK-deployed resource. The remaining user tags are normalized to the CFn `[{Key, Value}]` shape (sorted by `Key` for stable comparison; the `Tags` key is omitted entirely when AWS reports zero user tags). Helper at `normalizeAwsTagsToCfn` in `src/provisioning/import-helpers.ts` accepts every AWS-side tag shape (`{Key, Value}`, `{TagKey, TagValue}`, lower-case `{key, value}` for SFN / Glue / CodeBuild / ECS, and tag-name → value maps for Lambda / Cognito / AppSync). 28 providers were touched in this PR. IAM inline-policy bodies remain deliberately out of scope for v1 (per-name `GetRolePolicy` round-trips warrant a separate PR).
- ✅ `cdkd drift` single-stack auto-detect + `getDriftUnknownPaths` audit across providers with documented "intentionally omitted" state keys: positional stack name is now optional — when state has exactly one stack and `--all` is not set, the command auto-selects it (mirrors `cdkd deploy` / `cdkd destroy`); state with zero or multiple stacks reports a clear error with the available list. Separately, `ResourceProvider.getDriftUnknownPaths?(): string[]` lets a provider declare state property paths it deliberately cannot read back from AWS — `calculateResourceDrift` skips those paths (and any nested children under them) so they don't fire guaranteed false-positive drift on every clean run. Five providers wired up in this PR (one per kind of unreadable property): `LambdaFunctionProvider` (`['Code']` — `GetFunction` only exposes a pre-signed URL, never the original `S3Bucket` / `S3Key`); `LambdaLayerVersionProvider` (`['Content']` — same pre-signed URL story for layer versions); `SecretsManagerSecretProvider` (`['SecretString', 'GenerateSecretString']` — `DescribeSecret` does not return the secret value, and we deliberately don't call `GetSecretValue` to avoid surfacing plaintext through drift); `SNSTopicProvider` (`['DeliveryStatusLogging', 'Subscription']` — `DeliveryStatusLogging` fans out to per-protocol attributes whose round-trip is not yet implemented; `Subscription` is managed via separate `AWS::SNS::Subscription` resources); `IAMRoleProvider` (`['Policies']` — inline policy bodies need per-name `GetRolePolicy` round-trips, deferred to a dedicated PR). Implementation: `src/types/resource.ts` (interface) + `src/analyzer/drift-calculator.ts` (`ignorePaths` option, exact-match + `entry + '.'` prefix-match semantics) + `src/cli/commands/drift.ts` (auto-detect via `resolveTargetRefs` + per-resource `getDriftUnknownPaths` plumbing on the SDK-provider path; CC-API fallback path is unaffected because the deny-list / strip pipeline is the right place to add CC-API-specific exclusions).
- ✅ Drift comparator union-walk for map-shaped properties (closes the last "console-side change not detected" hole on the observed-baseline path): when the drift comparator descends into a nested object and `observedProperties` is the baseline, it now walks the **union** of `state` + `aws-current` keys instead of only `state`'s. This catches console-side **key adds** to map-shaped properties — Lambda `Environment.Variables.EXTRA`, API Gateway Stage `Variables`, anything where the AWS-current map has a key the deploy-time snapshot didn't. The pre-PR behavior (state-keys-only walk) is preserved on the v2 fallback path (when `observedProperties` is undefined and the comparator falls back to `properties`) — there the baseline is "user template intent only" and walking the union would fire false positives on every AWS-side default the user did not template. Top-level walk is intentionally state-keys-only even in union mode (the long tail of read-only top-level fields cdkd's wire-layer strip doesn't bother filtering — `FunctionArn`, `RevisionId`, etc. — would otherwise flood drift output). Implementation: `unionWalkObjects` option on `calculateResourceDrift` (`src/analyzer/drift-calculator.ts`); `cdkd drift` passes `useObserved` (= "the chosen baseline came from observedProperties") through to the option (`src/cli/commands/drift.ts`). Coverage: 6 new comparator unit tests (default-off / on-key-add / on-key-remove / top-level-key-not-leaked / ignorePaths-still-wins / arrays-still-structural) + 2 end-to-end wiring tests in `tests/unit/cli/drift.test.ts` (observed-path catches Lambda Env key add; properties-fallback path leaves it invisible).
- ✅ `cdkd state refresh-observed <stack>` + `Custom::*` drift fix: closes the upgrade gap for the v3 `observedProperties` baseline. State written before v3 has `observedProperties: undefined` on every resource; `cdkd deploy` only refreshes resources that actually go through CREATE / UPDATE (NO_CHANGE-skipped resources stay un-refreshed indefinitely). The new `cdkd state refresh-observed <stack> [<stack>...]` walks every resource in state, calls the matching provider's `readCurrentState`, and writes the result under a per-stack lock with optimistic etag locking — same baseline a fresh `cdkd deploy` would produce, but without redeploying. Flag set mirrors `state destroy`: `--all`, `--stack-region`, `--dry-run`, `-y/--yes`, plus standard state options. Per-resource errors are swallowed (logged at warn) and counted; a non-zero failed count surfaces as `PartialFailureError` (exit 2). Same companion fix: `cdkd drift` on a stack containing `Custom::*` resource types no longer crashes — previously the Custom Resource provider had no `readCurrentState` so drift fell back to the CC API, which rejects the `Custom::*` type pattern with `ValidationException`; the fix short-circuits `Custom::*` to "drift unknown" before the fallback fires. Both implemented in `src/cli/commands/state.ts` (`stateRefreshObservedCommand` + `refreshObservedForStack`) and `src/cli/commands/drift.ts`; documented end-to-end in [README.md](README.md) "Drift detection" section with the explicit upgrade-from-v2 flow.
- ✅ Tags always emitted in `readCurrentState` (even when AWS reports zero user tags): every provider that has a tag API now writes `result['Tags'] = tags;` unconditionally instead of `if (tags.length > 0) result['Tags'] = tags;`. With the v3 `observedProperties` baseline, this closes the "console-side tag added to a resource that started with zero user tags" detection gap — observed now records `Tags: []` and the next drift run sees `state=[]` vs `aws=[{Key,Value}]` and surfaces the change. Without this audit, observedProperties only had a `Tags` key when AWS happened to have user tags at deploy time, so a console-side tag addition on an initially-untagged resource was silently ignored. 27 providers touched + 25 unit-test `toEqual({...})` blocks updated to expect `Tags: []` on the no-user-tags happy path.
- ✅ User-controllable top-level keys always emitted in `readCurrentState` (generalizes the Tags-always-emit fix above to every CFn property `update()` can mutate): the drift comparator's top-level walk is intentionally state-keys-only (avoids leaking `FunctionArn` / `RevisionId` / etc. read-only fields to drift output), which means a CFn property that wasn't templated at deploy time stays absent from `observedProperties` forever — and a console-side ADD on that property is silently invisible. The fix is the PR #145 pattern applied across every SDK provider: drop the `if (X.length > 0)` / `if (X !== undefined && X !== '')` / `if (Object.keys(X).length > 0)` guards on user-controllable top-level keys and emit a placeholder (`?? []` for arrays, `?? {}` for maps, `?? ''` for optional strings, `?? <semantic-default>` for booleans/scalars — `Status: 'Suspended'` for S3 versioning, `BlockPublicAcls: false` for S3 PAB, `EncryptionType: 'AES256'` for ECR, etc.). Providers touched in this PR (Phase 1 — high-traffic + simple-pattern providers): `LambdaFunctionProvider` (Environment / Layers / Architectures / Description / VpcConfig), `IAMRoleProvider` (Description / ManagedPolicyArns), `SNSTopicProvider` (DisplayName / KmsMasterKeyId / TracingConfig / SignatureVersion / FifoThroughputScope), `S3BucketProvider` (VersioningConfiguration / BucketEncryption / PublicAccessBlockConfiguration), `EventBridgeBusProvider` (Description / KmsKeyIdentifier / DeadLetterConfig), `EventBridgeRuleProvider` (Description / Targets), `IAMInstanceProfileProvider` (Roles), `IAMUserGroupProvider` (User: ManagedPolicyArns / Groups; Group: ManagedPolicyArns), `ELBv2Provider` (LB: Subnets / SecurityGroups; TG: Matcher; Listener: Certificates / DefaultActions), `ElastiCacheProvider` (CacheCluster: VpcSecurityGroupIds; SubnetGroup: SubnetIds), `DynamoDBTableProvider` (GlobalSecondaryIndexes / LocalSecondaryIndexes / SSESpecification), `ECRProvider` (ImageScanningConfiguration / EncryptionConfiguration), `ECSProvider` (Cluster: CapacityProviders / DefaultCapacityProviderStrategy / ClusterSettings; Service: 5 array fields; TaskDefinition: 4 array fields), `EFSProvider` (FileSystem: LifecyclePolicies / FileSystemTags), `GlueProvider` (Database: Description / Parameters; Table: Description / PartitionKeys / Parameters), `RDSProvider` (DBCluster: VpcSecurityGroupIds / ServerlessV2ScalingConfiguration; DBSubnetGroup: SubnetIds), `SecretsManagerSecretProvider` (Description / KmsKeyId / ReplicaRegions), `SSMParameterProvider` (Description / AllowedPattern), `StepFunctionsProvider` (LoggingConfiguration / TracingConfiguration / EncryptionConfiguration), `WAFv2WebACLProvider` (Description / Rules / CustomResponseBodies / TokenDomains), `Route53Provider` (HostedZone: HostedZoneConfig / VPCs / HostedZoneTags; RecordSet: ResourceRecords / GeoLocation), `CloudTrailProvider` (EventSelectors), `LambdaEventSourceMappingProvider` (FunctionResponseTypes / SourceAccessConfigurations), `LambdaUrlProvider` (Cors), `KinesisStreamProvider` (StreamEncryption), `LogsLogGroupProvider` (KmsKeyId), `KMSProvider` (Description), `ServiceDiscoveryProvider` (Namespace: Description; Service: Description), `AgentCoreRuntimeProvider` (Description), `SQSQueueProvider` (KmsMasterKeyId / DeduplicationScope / FifoThroughputLimit / RedrivePolicy). 24 unit tests updated (`omits X when not configured` → `emits X placeholder`). **Phase 2a (continuation)**: `CloudWatchAlarmProvider` (full mutable surface — AlarmDescription / MetricName / Namespace / Statistic / ActionsEnabled / AlarmActions / OKActions / InsufficientDataActions / TreatMissingData / Unit / Dimensions / Metrics — both single-metric and metric-math forms emit placeholders since `PutMetricAlarm` replaces the full alarm) and `CodeBuildProjectProvider` (Description / ServiceRole / EncryptionKey / BadgeEnabled / SourceVersion / Source / Artifacts / Environment + EnvironmentVariables sub-array). Firehose's `KinesisStreamSourceConfiguration` was reviewed and intentionally NOT changed — it's create-time-only (locked by `DeliveryStreamType`, can't be added later via update or console), so the existing absence-on-DirectPut behavior is correct. **Phase 2b (continuation)**: `AppSyncProvider` (GraphQLApi: XrayEnabled / LogConfig; DataSource: Description / ServiceRoleArn — type-tagged sub-configs DynamoDBConfig / LambdaConfig / HttpConfig kept guarded since they're mutually exclusive on the data source's discriminator Type field; emitting empty placeholders for non-applicable types would surface as drift on every clean run; Resolver: DataSourceName / RequestMappingTemplate / ResponseMappingTemplate / PipelineConfig / Runtime / Code; ApiKey: Description), `ApiGatewayProvider` (Account: CloudWatchRoleArn; Authorizer: Name / ProviderARNs / AuthorizerUri / AuthorizerCredentials / IdentitySource / IdentityValidationExpression; Resource: ParentId; Deployment: Description; Stage: DeploymentId / Description; Method: AuthorizerId / Integration / MethodResponses), `ApiGatewayV2Provider` (Api: Name / Description / CorsConfiguration; Stage: AutoDeploy / Description; Integration: IntegrationUri / IntegrationMethod / PayloadFormatVersion; Route: Target / AuthorizationType / AuthorizerId; Authorizer: Name / IdentitySource / JwtConfiguration / AuthorizerUri / AuthorizerPayloadFormatVersion). **Phase 2c (this PR)**: `CognitoUserPoolProvider` (UpdateUserPool accepts every user-controllable field — UserPoolName / Schema are immutable on create and stay guarded; everything else gets a placeholder): AutoVerifiedAttributes / UsernameAttributes / AliasAttributes (`?? []`); Policies / LambdaConfig / AdminCreateUserConfig / AccountRecoverySetting / UserAttributeUpdateSettings / EmailConfiguration / SmsConfiguration / VerificationMessageTemplate / UsernameConfiguration / DeviceConfiguration / UserPoolAddOns (`?? {}`); MfaConfiguration (`?? 'OFF'`, the AWS-side default); DeletionProtection (`?? 'INACTIVE'`, the AWS-side default); EmailVerificationMessage / EmailVerificationSubject / SmsAuthenticationMessage / SmsVerificationMessage (`?? ''`); UserPoolTags (always-emit map even when filtered to empty after dropping `aws:*` auto-tags). Convention documented in `docs/provider-development.md` § 3b ("readCurrentState() for drift detection — always emit user-controllable top-level keys") with a placeholder table and the "when the guard is justified" exception list (immutable on create, AWS-managed read-only, write-only via `getDriftUnknownPaths`).
- ✅ State schema `version: 3` + `ResourceState.observedProperties` (deploy-time AWS snapshot used as drift baseline): every successful create / update kicks off `provider.readCurrentState` fire-and-forget; the deploy critical path does NOT block on these and the in-flight set is drained right before the final `saveState`, so the cost is roughly `max(per-resource readCurrentState latency)` ≈ 200-300ms in practice (measured: bench-cdk-sample +0.5-1%, lambda integ +8-11%, vs the sync-on-critical-path alternative which was +20-22%). The `cdkd drift` comparator prefers `observedProperties` as its baseline (catches console-side changes to keys the user did not template — Tags added in console, IAM policies attached out-of-band, etc.) and falls back to `properties` for resources written by an older binary or by a provider without `readCurrentState`. `--accept` mutates `observedProperties` (with a `properties` fallback for older entries) so re-running drift reports clean while preserving the user's template intent in `properties`; `--revert` passes `observedProperties ?? properties` as the desired value to `provider.update`, mirroring the comparator's baseline precedence. Schema migration is automatic: v2 reads succeed, the next write emits v3, an old binary reading v3 fails clearly with the same "Upgrade cdkd" error as the v1→v2 case. Default ON. Pass `--no-capture-observed-state` (or set `cdk.json context.cdkd.captureObservedState: false`) to disable the capture and regain pre-v3 deploy time at the cost of weaker drift detection. Implementation: `src/types/state.ts` (schema constants + `STATE_SCHEMA_VERSIONS_READABLE`) + `src/state/s3-state-backend.ts` (read-side version tolerance) + `src/deployment/deploy-engine.ts` (`kickOffObservedCapture` + `drainObservedCaptures` + `captureObservedState` option) + `src/cli/commands/drift.ts` (baseline preference + `--accept` / `--revert` semantics) + `src/cli/options.ts` (`--no-capture-observed-state`) + `src/cli/config-loader.ts` (`resolveCaptureObservedState`).
- ✅ Partial-failure exit code: `cdkd destroy` and `cdkd state destroy` exit with code **2** (not 0) when one or more per-resource deletes fail. The state.json is preserved (`destroy-runner` already handled that), but the previous behavior was to exit 0 with only a stderr warning, which was indistinguishable from a clean run for CI / bench scripts. Implemented via a `PartialFailureError` class in `src/utils/error-handler.ts` whose `exitCode` property (`= 2`) is honored by `handleError`. Both top-level `destroy` and `state destroy` aggregate `errorCount` across stacks and throw `PartialFailureError` if the total is non-zero. The per-stack summary line in `destroy-runner.ts` also switches glyphs (`✓ Stack X destroyed (N deleted, 0 errors)` vs `⚠ Stack X partially destroyed (N deleted, M errors). State preserved — re-run ...`) so the visual marker matches the exit code. Exit-code conventions (0/1/2) documented verbatim in README and `docs/cli-reference.md`. The general handler's "default to exit 1" path is unchanged for any other thrown error; only `PartialFailureError` opts into 2.

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
- **Self-review before commit (4 axes)**: Once the implementation feels complete, walk these four axes BEFORE running `/check` and committing — the markgate hook checks that tests pass, not that the work is *good*:
  1. **Implementation gaps** — anything in the agreed scope still missing? (e.g. updated `deploy.ts` but forgot the parallel change in `destroy.ts` / `diff.ts`; tests not added; docs not updated)
  2. **Oddities** — anything in the diff strange or inconsistent? (dead code, leftover names from the old shape, error messages that no longer make sense, half-applied refactors)
  3. **Polish opportunities** — small in-scope improvements you noticed and dismissed as "out of scope"? Default to including them in the same PR if they touch the same files and carry no behavior-break risk; defer only when they belong to a genuinely different concern.
  4. **Regression risk** — full test suite run (not just the new tests)? Any renamed/removed exports that other call-sites might depend on? Any behavior change a reviewer might miss in the diff?

  Surface findings out loud (in chat or todos) and fix them before invoking `/check`. The cost of one more pass is small compared to a follow-up PR or a missed regression.
- **Before every commit**: Two markgate gates guard `git commit` via `.claude/hooks/check-gate.sh`. Both must be fresh:
  - `check` — recorded by `/check` (typecheck, lint, build, tests). Scope: `src/**`, `tests/**`, build/test configs (see `.markgate.yml`). Only invalidated by changes in that scope.
  - `docs` — recorded by `/check-docs` (README.md / CLAUDE.md / docs/ consistency with src). Scope: `src/**`, `docs/**`, `README.md`, `CLAUDE.md`. Only invalidated by changes in that scope.

  **Run the required skills proactively** before attempting the commit — look at `git status` / `git diff --cached --name-only` and match it against each gate's scope: a tests-only commit only needs `/check`; a docs-only commit only needs `/check-docs`; a src edit needs both; changes that fall outside both scopes (e.g. `.claude/**`, `.markgate.yml`) need neither. The hook is a safety net, not the primary trigger — if you see "Blocked by check-gate", the message names exactly which skill to re-run, but getting there means you skipped the proactive step. `/verify-pr` refreshes both markers in one shot. Install markgate via `mise install` at the repo root (see CONTRIBUTING.md).
- **Before opening or merging any PR**: A third markgate gate, `verify-pr`, guards `gh pr create` and `gh pr merge` via `.claude/hooks/verify-pr-gate.sh`. Scope: union of `check` + `docs` (everything that could plausibly invalidate the PR-readiness checklist). Only `/verify-pr` sets it, and the skill walks the full checklist — typecheck/lint/build/tests, CI status, working tree, docs consistency, leftover AWS resources, code review (incl. shared-utility caller verification), **live-test of the changed behavior against real or fixture input**, **session retrospective + proposals for new rules / hooks / skills**, and PR title + body freshness vs the diff. So opening or merging a PR whose live behavior was never exercised, or whose retrospective produced no rule proposals for surprises in the session, is **physically blocked** — the hook refuses `gh pr create` / `gh pr merge` until `/verify-pr` is re-run end-to-end. This is the structural enforcement of the "tests passing is not the same as the feature working" + "every recurring surprise should leave a rule behind" lessons.

- **Before merging any PR that touches deletion logic**: A fourth markgate gate, `integ-destroy`, guards `gh pr merge` via `.claude/hooks/integ-destroy-gate.sh`. Scope: `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`, `src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/implicit-delete-deps.ts`, `src/analyzer/lambda-vpc-deps.ts`. Only `/run-integ` sets it, and only when the destroy step finished with 0 errors AND the post-destroy AWS state was empty. So a PR whose destroy path has not been verified against real AWS is **physically unmergeable** — the hook blocks `gh pr merge` until you run `/run-integ <test>` and it succeeds end-to-end. This is the structural enforcement of the "never merge a PR whose destroy path is unverified" rule below.

- **Other PreToolUse safety hooks**: Two additional one-shot hooks block known foot-guns at the source. `.claude/hooks/commit-msg-heredoc-gate.sh` blocks `git commit -m "$(cat <<'EOF' ... EOF)"`-style invocations because outer-shell quote tracking miscounts when the body contains apostrophes / backticks; use `git commit -F <file>` instead. `.claude/hooks/gh-pr-edit-deprecation-gate.sh` blocks `gh pr edit --title` / `--body` because they currently fail SILENTLY on a GraphQL Projects-classic deprecation; use `gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title=... -F body=@<file>` instead. Both produce actionable error messages with the exact replacement command.
- **Never commit or push directly to `main`**: All changes must land via a feature branch + PR. Before committing, run `git switch -c <branch>` (e.g., `fix/xxx`, `feat/xxx`, `docs/xxx`). A PreToolUse hook (`.claude/hooks/branch-gate.sh`) blocks `git commit` and `git push` when the **target git working tree** is on `main` / `master` — the hook is cwd-aware (reads `tool_input.cwd` from the hook payload + parses `cd <path>` / `git -C <path>` from the command), so worktree work that `cd /parent && git commit`s into a parent worktree on `main` is also caught. Smoke test at `.claude/hooks/branch-gate.test.sh`. If you see "Blocked by branch-gate", the message names the resolved target dir and the parsed command — create a feature branch in that dir and retry.
- **Before creating or merging a PR**: Run `/verify-pr` (adds CI status, docs consistency, AWS resource cleanup, code review on top of `/check`)
- **When running integration tests**: Use `/run-integ` with the appropriate test name (e.g., `/run-integ lambda`). **Never bypass the skill** by manually invoking `cdkd deploy` / `cdkd destroy` from a shell — the skill encodes the deploy + destroy + orphan-resource verification in a single block, and skipping any step (e.g. relying on a successful deploy without running destroy) has historically caused us to merge changes whose destroy path was broken.
- **After running integration tests**: Verify no leftover AWS resources remain (`aws s3 ls s3://cdkd-state-{accountId}/cdkd/` should return empty or error; on accounts that haven't migrated yet, the legacy `cdkd-state-{accountId}-{region}` bucket is still in use — check both). **If the destroy step failed or left orphans, you MUST clean them up via direct AWS API calls before doing anything else** (use `/cleanup` if applicable, otherwise `aws ec2 delete-*` etc.) — leaving orphan resources after an integ run is never acceptable, regardless of whether the test passed.
- **Never merge a PR whose destroy path is unverified**: If a change touches deletion logic (any provider's `delete()`, DAG order on destroy, state cleanup, etc.), the integ test must complete the **destroy** step successfully (not just deploy) before the PR is mergeable. A green CI is necessary but not sufficient — CI does not exercise real-AWS destroy.
- **After fixing documentation or code**: Commit to a feature branch (not `main`) and push immediately. Do not leave uncommitted changes. Before reporting completion to the user, always run `git status` to verify nothing is uncommitted and that you are not on `main`.
- **English-only for committed files**: This is an OSS project. All committed files (source code, shell scripts, hook messages, config files such as `.claude/settings.json`, docs, comments, commit messages, PR titles/bodies) MUST be written in English. Do not use Japanese characters (hiragana, katakana, kanji) in any committed artifact. Conversation with the user in chat may be in Japanese — this rule applies only to files that land in the repository.
