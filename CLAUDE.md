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
   - `Fn::GetStackOutput` reads the producer stack's output directly from cdkd's S3 state (`s3://{bucket}/cdkd/{StackName}/{Region}/state.json`) — no Export needed, and `Region` may differ from the consumer's deploy region (same-account cross-region works out of the box because the state bucket name is account-scoped, not region-scoped). `RoleArn` (cross-account) is supported: cdkd issues `sts:AssumeRole` against the supplied role, derives the producer's canonical state bucket from the role ARN's account ID (`cdkd-state-{producerAccountId}`), auto-detects the bucket's region via `GetBucketLocation`, and reads the producer's state through an ephemeral state backend with the assumed credentials. Assumed credentials are cached per-RoleArn for the deploy lifetime so a stack that references the same producer multiple times only pays one STS hop. The inline `RoleArn` argument must be a LITERAL string in the template — `Ref` / `Fn::GetAtt` / `Fn::Sub` are intentionally rejected since the resolver context cannot guarantee producer-account info at intrinsic-resolution time.

## Build and Test Commands

```bash
# Build (using Vite+ / tsdown)
vp run build

# Watch mode (for development)
vp run dev

# Test (using Vitest)
vp run test
vp test --ui             # UI mode
vp run test:coverage     # Coverage

# Lint/Format
vp run lint
vp run lint:fix
vp run format
vp run format:check

# Type check
vp run typecheck
```

## Key Files and Directories

### Core Directories

- **src/cli/** - CLI command implementations (deploy, destroy, diff, drift, synth, list/ls, bootstrap, force-unlock, import, export, publish-assets, state, local), config resolution.

  **Top-level vs `state` subcommand split**: top-level commands (`deploy`, `destroy`, `diff`, `synth`, `list`, `import`, `orphan`) require a CDK app — they synthesize a template to know what they're operating on. The `cdkd state ...` subcommand family (`state info`, `state list`, `state resources`, `state show`, `state orphan`, `state destroy`, `state migrate`) operates on the S3 state bucket only and does NOT need the CDK code; it's the right place to inspect / clean up state when the CDK app is missing or you don't want to synth. `cdkd drift <stack>` is also state-driven (no synth), since it compares state-recorded properties to the AWS-current snapshot returned by each provider's optional `readCurrentState` method — a CC-API fallback covers the majority of resource types out of the box; SDK Providers add their own `readCurrentState` incrementally. The two `orphan` commands operate at **different granularities** (this is the breaking change in PR #92): `cdkd orphan <constructPath>...` is **per-resource** (mirrors upstream `cdk orphan --unstable=orphan`) and rewrites every sibling reference (Ref / Fn::GetAtt / Fn::Sub / dependencies) so the next deploy doesn't re-create the orphan; `cdkd state orphan <stack>...` is **whole-stack** and removes the entire state record without touching siblings. Both orphan variants delete ONLY cdkd state; AWS resources are left intact (use `destroy` / `state destroy` to delete them).

  `cdkd import <stack> --app "..."` adopts AWS-deployed resources into cdkd state. Three modes: (1) **auto** (no flags) — every resource in the template is looked up by its `aws:cdk:path` tag (cdkd's value-add over CDK CLI for whole-stack adoption); (2) **selective** (CDK CLI parity, default whenever `--resource <logicalId>=<physicalId>`, `--resource-mapping <file.json>`, or `--resource-mapping-inline '<json>'` is supplied) — ONLY the listed resources are imported, every other template resource is reported as `out of scope` and left out of state for the next deploy to CREATE. Matches `cdk import --resource-mapping` / `--resource-mapping-inline` semantics, including refusing to silently no-op on a typo'd logical ID; `--resource-mapping` and `--resource-mapping-inline` are mutually exclusive (matches upstream); (3) **hybrid** (`--auto` with overrides) — listed resources use the explicit physical id; the rest still go through tag-based auto-import (the pre-PR default, now opt-in). `--record-resource-mapping <file>` writes cdkd's resolved `{logicalId: physicalId}` map (covers explicit overrides AND auto / hybrid mode tag-lookups) to disk before the confirmation prompt — emitted even when the user says "no" or under `--dry-run`, so the resolved data can be replayed as `--resource-mapping` in non-interactive CI re-runs (mirrors `cdk import --record-resource-mapping`). **Existing-state semantics**: selective mode is non-destructive — listed resources are merged into the existing state file and unlisted entries are preserved. `--force` is required only when the import would lose data: auto / whole-stack mode against existing state (rebuilds the resource map from the template, dropping any state entry not re-imported), or selective mode where a listed override would overwrite a resource already in state. First-time imports against an empty state never need `--force`. Outputs in the existing state are inherited by both modes (the import flow never derives outputs). `--migrate-from-cloudformation [cfn-stack-name]` (cdkd-specific) extends the import flow with an end-to-end migration path off CloudFormation. The flow: (1) **before** the import loop, `getCloudFormationResourceMapping(...)` (in `src/cli/commands/retire-cfn-stack.ts`) issues a single `DescribeStackResources` against the named CFn stack and merges the resulting `Map<logicalId, physicalId>` into the import overrides (user-supplied `--resource` / `--resource-mapping` entries take precedence). This side-steps cdkd's tag-based auto-lookup — which can't find resources deployed by upstream `cdk deploy` (that flow doesn't propagate `Metadata.aws:cdk:path` as an AWS tag, and AWS reserves the `aws:` tag prefix so cdkd can't add it on the way through either) — so a bare `cdkd import MyStack --migrate-from-cloudformation` works for both `cdk deploy`-managed and `cdkd deploy`-managed stacks. The flag also forces `selectiveMode = false` regardless of override count (the CFn-derived overrides shouldn't trigger selective mode, which would mark every other template resource `out of scope` and orphan them after `DeleteStack`). (2) Import runs and writes state. (3) **After** state write, `retireCloudFormationStack(...)` runs the standard `DescribeStacks` (verify stable terminal state, capture existing `Capabilities`) → `GetTemplate` Original-stage (parse JSON, inject `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` on every resource) → `UpdateStack` (skipped when the diff is empty or every resource already has both Retain policies) → `DeleteStack` (CFn skips every resource because they're now Retain). Runs inside the import command's lock-protected scope so a concurrent `cdkd deploy` can't race the post-write CFn calls; only runs when state was actually written (zero-imports or "no" at the prompt skip the retirement). The flag accepts an optional value: bare `--migrate-from-cloudformation` uses the cdkd stack name as the CFn stack name (typical for CDK apps where they match); pass `--migrate-from-cloudformation <name>` to override when the names differ. Templates may be JSON or YAML (CFn shorthand intrinsics like `!Ref` / `!GetAtt` / `!Sub` are preserved across parse → mutate → re-serialize via the CFn-aware codec at [src/cli/yaml-cfn.ts](src/cli/yaml-cfn.ts) — see the YAML support bullet for details). Templates up to the 51,200-byte inline `TemplateBody` ceiling are submitted directly; larger templates are uploaded to the cdkd state bucket under `cdkd-migrate-tmp/<stack>/<timestamp>.{json,yaml}` and submitted via `TemplateURL` (the transient object is deleted in a `finally` immediately after `UpdateStack`, success or failure). Templates over the 1 MB CloudFormation `TemplateURL` ceiling are structurally unsubmittable and fail with a clear error; cdkd state is already written so the user can re-run or finish manually. Not compatible with `--dry-run` (post-state-write retirement is a real side-effect). For plain (non-CDK) CloudFormation stacks (hand-authored YAML / JSON, Terraform-to-CFn output, Console-created stacks) use the dedicated `cdkd migrate --from-cfn-stack <name>` top-level command, which wraps the same end-to-end flow (upstream `cdk migrate` codegen + 2-pass `(sourceLogicalId, synthLogicalId)` mapping + cdkd state + optional `--retire-cfn-stack`). `cdkd import --migrate-from-cloudformation` is the right tool when a CDK app already exists and you want to take over an existing `cdk deploy`-managed CFn stack without re-generating the CDK code.

  **`provider.import` support coverage**: see [docs/import.md](docs/import.md) for the full per-resource-type list (auto-lookup vs override-only vs CC-API fallback vs unsupported). Single source of truth — when adding `import()` support to a provider, update that file. Keep entries one-per-line so parallel PRs don't conflict on rebase.

  **`cdkd import` vs upstream `cdk import` — parity notes** (see [docs/import.md](docs/import.md) for the full matrix; this is a quick checklist when working on the import code path):

  - **Mechanism is per-resource SDK calls, not a CloudFormation changeset.** `cdkd import` is therefore **not atomic**. `import.ts` collects per-resource outcomes (`imported` / `skipped-not-found` / `skipped-no-impl` / `skipped-out-of-scope` / `failed`) and only writes state after a final confirmation (`--yes` to skip). A partial import can be backed out with `cdkd state orphan <stack>`.
  - **No interactive prompt for missing IDs.** Upstream's TTY default prompts per resource; cdkd looks IDs up by `aws:cdk:path` tag (in `auto` / `hybrid` modes) or treats them as `out of scope` (in selective mode). The only prompt is the final "write state?" gate.
  - **`--resource-mapping <file>`: parity.** Same JSON shape (`{"LogicalId": "physical-id"}`) and same semantics — only listed resources imported, unlisted resources rejected, typo'd logical IDs abort before any AWS call.
  - **`--resource-mapping-inline '<json>'`: parity.** Same JSON shape as `--resource-mapping <file>`, mutually exclusive with it. Useful in non-TTY CI scripts that don't want a separate file.
  - **`--record-resource-mapping <file>`: parity.** cdkd writes the resolved `{logicalId: physicalId}` map to the file before the confirmation prompt (and even when the user says "no" or under `--dry-run`). Covers explicit overrides AND cdkd's tag-based auto-lookup, so this is the canonical way to capture an `auto`-mode resolution and replay it as `--resource-mapping` in CI.
  - **`--force` semantics differ.** Upstream: "continue even if the diff has updates/deletions." cdkd: "confirm a destructive write to existing state" — required for auto / whole-stack rebuild on existing state, and for overwriting a listed entry already in state during selective mode; not required for a pure selective merge that only adds new resources, nor for first-time imports. Same flag name, different meaning — do not confuse them when reading PRs / issues.
  - **`auto` and `hybrid` modes are cdkd-specific** (whole-stack tag-based import via `aws:cdk:path`). No upstream equivalent. Do not mistake them for parity features.
  - **`--migrate-from-cloudformation [name]` is cdkd-specific.** End-to-end migration off CloudFormation: pre-import `DescribeStackResources` to recover physical IDs (so cdk-deployed stacks work without `--resource`) → import → state write → post-import `UpdateStack` (inject Retain; uploaded to the cdkd state bucket via `TemplateURL` when over the 51,200-byte inline limit, hard-rejected over the 1 MB `TemplateURL` ceiling) → `DeleteStack`. No upstream equivalent — `cdk import` only adopts resources INTO a CFn stack, never out of one. Accepts JSON and YAML templates (CFn shorthand intrinsics preserved end-to-end via the codec at [src/cli/yaml-cfn.ts](src/cli/yaml-cfn.ts)); incompatible with `--dry-run` (see the import section above for the full constraint list).
  - **Nested CloudFormation stacks (`AWS::CloudFormation::Stack`) are unsupported on both sides.** cdkd has no `AWS::CloudFormation::Stack` provider, so these resources show up as `unsupported` in the import summary. CDK Stages (separate top-level stacks under one app) work fine.
  - **No CDK bootstrap version requirement.** cdkd uses its own S3 state bucket; the upstream "bootstrap v12+" caveat does not apply.

  `cdkd export <stack>` is the mirror of `cdkd import` in the reverse direction (cdkd → CloudFormation). It synthesizes the CDK app to get the template, reads cdkd state for `(logicalId, physicalId)` mappings, refuses if any template resource is in the never-importable set (`Custom::*` AND `AWS::CloudFormation::CustomResource` — the type CDK emits for `new cdk.CustomResource(...)` without `resourceType`; both are Lambda-backed Custom Resources that CFn cannot adopt — `AWS::CloudFormation::Stack`, or has no entry in cdkd state), resolves each resource type's primary identifier property via `cloudformation:DescribeType` (with a hardcoded fallback table in `src/cli/commands/export.ts` for ~30 common types — covering S3 / IAM / Lambda / DynamoDB / SQS / SNS / Logs / EC2 / RDS / Events / API Gateway etc.), acquires the stack lock, confirms with the user, preprocesses the phase-1 template (strip Outputs; inject `DeletionPolicy: Delete` on resources missing the attribute — matches the CFn type-default for resources without explicit `RemovalPolicy`; overlay each resource's `ResourceIdentifier` onto its `Properties` so CFn IMPORT's identifier-match check passes against cdkd's stack-name-prefixed physical ids), then issues `CreateChangeSet --change-set-type IMPORT` → wait → `ExecuteChangeSet` → `waitUntilStackImportComplete`, and finally deletes cdkd state for the migrated stack. AWS resources are unchanged across the migration; the stack is then managed by `cdk deploy` / `aws cloudformation`. **Context preservation guard**: refuses by default if CLI `-c key=value` overrides are supplied, because those values are not persisted to `cdk.json` / `cdk.context.json` and a subsequent `cdk deploy` without the same `-c` flags would synthesize a different template (drift / replacement on first post-migration deploy). User moves the values to `cdk.json`'s `context: {}` field (recommended) or passes `--accept-transient-context` to opt in to the risk. On success, prints the exact `cdk diff` / `cdk deploy` command including any captured `-c` flags. MVP scope: JSON and YAML templates supported (via the CFn-aware codec at [src/cli/yaml-cfn.ts](src/cli/yaml-cfn.ts) — see the YAML support bullet for details); all-or-nothing (if any resource cannot be imported, the whole command aborts — destroy or accept abandoning those resources first), inline `TemplateBody` only (51,200-byte cap), synth template used verbatim (no `observedProperties` substitution). Caveats: (1) **replacement risk on next `cdk deploy`** if the CDK code does not specify explicit physical names (`bucketName: 'my-bucket-12345'`) — same long-standing UX as upstream `cdk import`; users should set explicit names before exporting or inspect the post-import changeset before executing. (2) **cross-stack `Fn::GetStackOutput` consumers** in other cdkd stacks cannot read the exported stack's outputs anymore (CFn outputs live in CFn, cdkd's resolver reads cdkd state); plan multi-stack migrations from the leaves up. Implementation in `src/cli/commands/export.ts`.

  `state` is a parent command for inspecting and manipulating cdkd's S3 state bucket: `state info` prints bucket name, region (auto-detected via `GetBucketLocation`), the source that resolved the bucket (`cli-flag` / `env` / `cdk.json` / `default` / `default-legacy`), the schema version, and a stack count (with `--json` for tooling); `state list` (alias `ls`) lists deployed stacks (one row per `(stackName, region)` pair under the new region-prefixed key layout); `state resources <stack>` and `state show <stack>` accept `--stack-region <region>` to disambiguate when the same stackName has state in multiple regions; `state orphan <stack>...` removes cdkd's state record for every region by default, or scopes to one with `--stack-region <region>` (does NOT delete AWS resources — name mirrors aws-cdk-cli's new `cdk orphan`); `cdkd orphan <constructPath>...` is the synth-driven, **per-resource** counterpart (mirrors upstream `cdk orphan --unstable=orphan`) — it removes specific resources from a stack's state file by construct path (`MyStack/MyTable`), live-fetching every `Fn::GetAtt` it has to substitute via the resource's `provider.getAttribute()` (cached per `(orphan, attr)`) and rewriting every sibling `Ref` / `Fn::GetAtt` / `Fn::Sub` / `dependencies` reference so the next deploy doesn't try to re-create the orphan or fail on a stale reference. Path matching is **prefix-based** (matches upstream's behavior): the user's input matches every resource whose `aws:cdk:path` is exactly the input OR starts with `<input>/`, so an L2 path like `MyStack/MyConstruct/MyBucket` resolves to the synthesized L1 child `MyStack/MyConstruct/MyBucket/Resource`, and an L2 wrapper that contains multiple CFn resources orphans every child under it. The `aws:cdk:path` index in `src/cli/cdk-path.ts` excludes `AWS::CDK::Metadata` resources so the synthesized `<Stack>/CDKMetadata/Default` sentinel is never offered as an "available path" and cannot be orphaned; unresolvable references hard-fail with a one-shot list of every site, and `--force` falls back to the orphan's `state.attributes` cache (logging a per-case warning) before leaving the original intrinsic untouched if the cache also lacks the attr; `--dry-run` prints the rewrite audit table without acquiring a lock or saving state. The implementation lives in `src/analyzer/orphan-rewriter.ts` (the recursion structure mirrors `IntrinsicFunctionResolver` but in the inverse direction: only orphan references are substituted, every other intrinsic is left alone) and `src/cli/cdk-path.ts` (the shared `aws:cdk:path` index, also used by `cdkd import`). The pre-PR `cdkd orphan <stack>` whole-stack behavior is gone — the command hard-fails with a redirect message that points to `cdkd state orphan <stack>` instead of silently routing. `state destroy <stack>...` deletes AWS resources AND the state record without requiring the CDK app (the CDK-app-free counterpart to `cdkd destroy`). The per-stack destroy logic is hoisted into `src/cli/commands/destroy-runner.ts` and shared by both `cdkd destroy` and `cdkd state destroy`. `state migrate` copies all state from the legacy region-suffixed default bucket (`cdkd-state-{accountId}-{region}`) to the new region-free default (`cdkd-state-{accountId}`); refuses to run while any stack has an active lock; verifies object-count parity before any source cleanup; source bucket is kept by default and only deleted with `--remove-legacy`. The bucket-name banner is no longer printed in routine command output (it includes the AWS account id, which would leak via screenshots / public CI logs); pass `--verbose` to surface it in debug logs, or use `state info` for an explicit on-demand answer.
- **src/synthesis/** - CDK app synthesis (self-implemented: subprocess execution, Cloud Assembly parsing, context providers)
- **src/analyzer/** - DAG builder, template parser, intrinsic function resolution
- **src/state/** - S3 state backend, lock manager
- **src/deployment/** - DeployEngine (orchestration), WorkGraph (DAG-based asset+deploy scheduling)
- **src/provisioning/** - Provider registry, Cloud Control provider, SDK providers
- **src/assets/** - Asset publisher (self-implemented S3 file upload with ZIP packaging, ECR Docker image build & push)
- **src/local/** - `cdkd local invoke`, `cdkd local start-api`, `cdkd local run-task`, and `cdkd local start-service` building blocks (renamed from `src/local-invoke/` to share the directory with the rest of the `cdkd local` family — see PR #228). The ECS run-task family adds `ecs-task-resolver.ts` (synth template → `ResolvedEcsTask` with containers / volumes / DependsOn / RuntimePlatform), `ecs-secrets-resolver.ts` (`Secrets[].ValueFrom` → real values via SecretsManager / SSM), `ecs-network.ts` (per-task docker network + AWS-published metadata-endpoints sidecar lifecycle), and `ecs-task-runner.ts` (top-level orchestrator: image prep → DAG topo-sort → docker run loop → log stream → teardown). The ECS start-service family ([#466](https://github.com/go-to-k/cdkd/issues/466)) adds `ecs-service-resolver.ts` (synth template → `ResolvedEcsService` carrying DesiredCount + the underlying task descriptor) and `ecs-service-runner.ts` (long-running orchestrator: per-replica watcher loop with `docker wait` + restart-on-exit + exponential backoff + idempotent fan-out shutdown). `cdkd local invoke` modules: `lambda-resolver.ts` (target → discriminated `ResolvedLambda` (`kind: 'zip' | 'image'`) carrying StackInfo / logicalId / runtime+handler+codePath for ZIP or imageUri+imageConfig+architecture for IMAGE; reuses `cdk-path.ts` and `stack-matcher.ts`), `env-resolver.ts` (template literals + SAM-shape `--env-vars` overrides; intrinsic-valued entries warn-and-drop unless `--from-state` substituted them upstream), `state-resolver.ts` (PR 2 — pure-functional substituter that walks intrinsic-valued env-var values against `state.resources` from cdkd's S3 state file; supports `Ref` / `Fn::GetAtt` / `Fn::Sub`, reports per-key unresolved reasons), `runtime-image.ts` (`Runtime` → `public.ecr.aws/lambda/<lang>:<v>` + source-file extension; v1 supports `nodejs18.x` / `nodejs20.x` / `nodejs22.x` / `python3.11` / `python3.12` / `python3.13`), `docker-runner.ts` (thin `execFile`/`spawn` wrappers around `docker pull` / `docker run -d --rm --name <optional>` / `docker logs -f` / `docker rm -f` + free-port allocator; PR 5 extended `runDetached` with `--platform` / `--entrypoint` / `--workdir`; PR 8a added the optional `--name` for orphan-sweep), `docker-image-builder.ts` (PR 5 — local-build path for container Lambdas, wraps the shared `src/assets/docker-build.ts` helper with a stable per-context tag), `ecr-puller.ts` (PR 5 — ECR-pull fallback when the cdk.out asset lookup misses; same-account / same-region only, cross-acct/region hard-errors with a deferred-PR pointer), and `rie-client.ts` (HTTP `POST /2015-03-31/functions/function/invocations` to RIE inside the container, plus a TCP-probe-based readiness wait). `cdkd local start-api` modules (PR 8a): `route-discovery.ts` (REST v1 + HTTP API + Function URL → `DiscoveredRoute[]` with a 30-line local intrinsic resolver — no deploy-state dependency), `api-gateway-event.ts` (pure-functional v1 + v2 event-shape builders + PR 8b `applyAuthorizerOverlay`), `api-gateway-response.ts` (Lambda response → HTTP, with auto-format / error-envelope / cookies-as-multiple-Set-Cookie translation), `route-matcher.ts` (3-tier precedence: full → greedy `{proxy+}` → `$default`, with literal-segment tie-break), `container-pool.ts` (per-Lambda warm container pool with mutex-protected lazy growth, 60s idle GC, dispose-tolerates-removeContainer-failures), and `http-server.ts` (the `node:http` accept loop with PR 8b authorizer pass and PR 8c's atomic `setServerState` swap for hot reload). PR 8b additions: `authorizer-resolver.ts` (REST v1 / HTTP v2 authorizer detection + identity-source parsing — extended in #447 with the `IamAuthorizer` discriminated union member for REST v1 `AuthorizationType: 'AWS_IAM'`), `authorizer-cache.ts` (TTL-aware result cache), `lambda-authorizer.ts` (TOKEN + REQUEST authorizer invoke + IAM-policy parser), `cognito-jwt.ts` (JWKS fetch + RS256 verify + claims extraction + pass-through fallback), `sigv4-verify.ts` (#447 — REST v1 AWS_IAM SigV4 signature verification against the dev's local credentials via `STSClient`'s default credential chain; signature verification only, no IAM policy emulation; warn-and-pass on foreign-identity requests per `feedback_match_aws_default_over_opinionated.md`). PR 8c additions: `cors-handler.ts` (CFn `CorsConfiguration` parser + OPTIONS preflight matcher for HTTP API v2), `stage-resolver.ts` (per-API Stage selection + `attachStageContext` for routes; populates `event.stageVariables`), `file-watcher.ts` (chokidar-backed debounced file watcher with dynamic path-list updates), `reload-orchestrator.ts` (synth-failure-tolerant reload pipeline with chain-serialized concurrent calls). `intrinsic-image.ts` (issue #286 Gap 2) holds the shared canonical-CDK-2.x-`Fn::Join`-shape resolver for container image URIs (`lambda.DockerImageCode.fromEcr` + ECS `ContainerImage.fromEcrRepository`) — `tryResolveImageFnJoin` + `substituteImagePlaceholders` + the `ImageResolutionContext` / `FnJoinResolveOutcome` types, used by both `lambda-resolver.ts` and `ecs-task-resolver.ts`. `intrinsic-lambda-arn.ts` (issue #286 Gaps 3 / 4) is the sibling helper for Lambda ARN intrinsics in API Gateway resolvers — `resolveLambdaArnIntrinsic` accepts `Ref` / `Fn::GetAtt: [..., 'Arn']` / the REST v1 invoke-ARN `Fn::Join` wrapper (also emitted by CDK 2.x's HTTP v2 `HttpLambdaAuthorizer`) / the `Fn::Sub` invoke-ARN wrapper (both 1-arg `${LogicalId.Arn}` form and 2-arg `Fn.sub(template, vars)` form). Returns a discriminated union so each call site (`route-discovery.ts` for `IntegrationUri`, `authorizer-resolver.ts` for `AuthorizerUri`) wraps the unsupported case with its own error class. `authorizer-context.ts` (PR #515 item 9) is the per-kind shape builder consumed today by `http-server.ts`'s `buildAuthorizerContextForServiceIntegration` (HTTP API v2 service-integration `$context.authorizer.*` parameter-mapping context). Owns the bare per-kind shape (Lambda flat `principalId + context`, IAM `principalId` only, Cognito `{claims}`, JWT `{jwt: {claims, scopes}}`). The sibling `buildOverlay` in `http-server.ts` (Lambda AWS_PROXY event overlay) still uses hand-rolled per-kind branching because it wraps the result in the `AuthorizerEventOverlay` discriminated union shape (with the `lambda-http-v2` arm layering an additional `.lambda` namespace); the inner per-kind context matches the helper's output exactly, so a future kind addition can be lifted through this helper at both call sites with no behavior change. #457 additions: `vtl-engine.ts` is a hand-rolled minimal AWS API Gateway VTL evaluator (`$input` / `$context` / `$util` built-ins, `#set` / `#if` / `#elseif` / `#else` / `#foreach` / `##` directives, JSONPath subset — no external dep) used by every REST v1 non-AWS_PROXY dispatcher; `integration-response-selector.ts` resolves `IntegrationResponses[].SelectionPattern` (regex anchored `^...$`) + `ResponseParameters` header literals + `ResponseTemplates` Accept-header content negotiation; `rest-v1-integrations.ts` carries the four dispatchers (`dispatchMockIntegration` / `dispatchHttpProxyIntegration` / `dispatchHttpIntegration` / `dispatchAwsLambdaIntegration`) plus `substituteUriPlaceholders` + `applyRequestParameters`. The CLI commands live at `src/cli/commands/local-invoke.ts` (creates the `cdkd local` parent + registers `invoke`, `start-api`, `run-task`, and `start-service`), `src/cli/commands/local-start-api.ts`, `src/cli/commands/local-run-task.ts`, and `src/cli/commands/local-start-service.ts`. `src/cli/commands/local-state-loader.ts` is a shared helper (extracted from `local-invoke.ts` in PR #267) that both `cdkd local invoke --from-state` and `cdkd local run-task --from-state` route through to load cdkd's S3 state for the target stack — single impl, parameterized log prefix.

### Important Files

- **src/cli/config-loader.ts** - Config resolution (cdk.json, env vars for `--app` and `--state-bucket`)
- **src/cli/stack-matcher.ts** - Shared stack-name matcher used by deploy/diff/destroy/list. Routes patterns by whether they contain `/` (display-path) or not (physical name) and returns a deduplicated union.
- **src/cli/yaml-cfn.ts** - CFn-aware YAML codec used by `cdkd export` and `cdkd import --migrate-from-cloudformation`. Parses + serializes CloudFormation templates while preserving every CFn shorthand intrinsic tag (`!Ref` / `!GetAtt` / `!Sub` / `!Join` / `!Select` / `!Split` / `!If` / `!Equals` / `!And` / `!Or` / `!Not` / `!FindInMap` / `!Base64` / `!Cidr` / `!GetAZs` / `!ImportValue` / `!Transform` / `!Condition`). Built on the `yaml` package's custom-tag schema; each tag parses to its long-form `{Fn::Foo: <args>}` object (or `{Ref: <name>}` for `!Ref`) so every downstream consumer reads one canonical representation, and re-emits back to the same shorthand tag on YAML stringify. Format auto-detection sniffs the first non-whitespace byte (`{` / `[` → JSON; anything else → YAML).
- **src/synthesis/app-executor.ts** - Executes CDK app as subprocess with proper env vars (CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION, etc.)
- **src/synthesis/assembly-reader.ts** - Reads and parses Cloud Assembly manifest.json directly
- **src/synthesis/synthesizer.ts** - Orchestrates synthesis with context provider loop. After the loop settles, walks every synthesized stack and routes any template that {@link containsMacro} flags through `src/synthesis/macro-expander.ts` BEFORE returning to the analyzer / provisioner pipeline (Issue #463).
- **src/synthesis/macro-detector.ts** - Pure-functional `containsMacro(template)` / `enumerateMacros(template)` helpers (Issue #463). Detect top-level `Transform: [...]` AND nested `Fn::Transform: {...}` blocks anywhere under `Resources` / `Outputs` / `Mappings` / `Conditions` / `Rules`. Skip `Metadata` keys at any depth (CFn does not expand transforms inside metadata). Tolerate malformed inputs without throwing so the rest of the synthesis pipeline surfaces the malformed-template error.
- **src/synthesis/macro-expander.ts** - CloudFormation macro round-trip helper (Issue #463 Phase 2; design at [docs/design/463-cfn-macros.md](docs/design/463-cfn-macros.md)). Issues a transient `CreateChangeSet --change-set-type CREATE` (which auto-creates the stack in `REVIEW_IN_PROGRESS`, no prior `cdkd-macro-expand-*` stack needed — Q1 empirically verified 2026-05-23), waits for `ChangeSetStatus: CREATE_COMPLETE`, fetches `GetTemplate --template-stage Processed` (returns the post-expansion template; the SDK types the field as `string | undefined` but the wire shape may be a parsed object — the helper handles both), and cleans up via `DeleteChangeSet` + `DeleteStack` in a `finally` block (both NotFound-tolerant). For templates that declare `Parameters` without `Default`, passes synthetic placeholder values (CFn rejects `CreateChangeSet` otherwise; the values do NOT leak into the Processed-stage template — `Ref: <param>` survives intact for cdkd's own resolver). Inline `TemplateBody` for templates <= 51,200 bytes; uploads to the cdkd state bucket and submits `TemplateURL` for (51,200, 1 MB]; refuses outright above 1 MB. Multi-stage macros (an expanded template that still contains a macro) hard-error with a clear pointer at the design's "out of scope for v1" note. Throws `MacroExpansionError` (exit code 2) on every failure mode.
- **src/synthesis/context-providers/** - Context providers (see `src/synthesis/context-providers/` for full list) for missing context resolution
- **src/cli/commands/drift.ts** - `cdkd drift [<stack>...]` implementation. State-driven (no synth). Reads cdkd state from S3, asks each provider's optional `readCurrentState` for the AWS-current snapshot, and pipes the result through `src/analyzer/drift-calculator.ts`. Auto-selects the single stack in state when no positional arg / `--all` is given (mirrors `cdkd deploy` / `cdkd destroy`); errors with a listing when state has more than one stack. Exits 0 on no drift, 1 on drift detected, 2 on error. `--accept` / `--revert` are deferred to a follow-up PR.
- **src/analyzer/drift-calculator.ts** - State-vs-AWS property comparator used by `cdkd drift`. Only descends into keys present in cdkd state, so AWS-managed fields cdkd never set (timestamps, generated identifiers, account-wide defaults) cannot surface as false-positive drift. Accepts an optional `ignorePaths` list (sourced from each provider's `getDriftUnknownPaths`) to skip state property paths the provider deliberately cannot read back from AWS — e.g. Lambda `Code: { S3Bucket, S3Key }`, which `GetFunction` only returns as a pre-signed URL — so a clean run reports no drift on those keys instead of the guaranteed false positive that would otherwise fire on every invocation.
- **src/deployment/dag-executor.ts** - Generic event-driven DAG dispatcher (used inside a stack to schedule resource provisioning as soon as each resource's deps complete; no level barriers)
- **src/deployment/work-graph.ts** - WorkGraph DAG orchestrator for asset publishing and stack deployment
- **src/deployment/retryable-errors.ts** - Shared transient-error classifier (HTTP 429/503 + message-pattern table covering IAM/CW Logs/SQS/KMS/etc. propagation delays). Consumed by `withRetry` in `src/deployment/retry.ts` to decide whether to back off and retry vs. fail fast.
- **src/deployment/retry.ts** - Exponential-backoff retry helper used by DeployEngine; 1s -> 2s -> 4s -> 8s schedule capped at 8s for the typical AWS eventual-consistency window. Delegates retryable-error classification to `retryable-errors.ts`.
- **src/assets/file-asset-publisher.ts** - S3 file upload with ZIP packaging support
- **src/assets/docker-asset-publisher.ts** - ECR Docker image build & push
- **src/assets/docker-build.ts** - Shared `docker build` invocation reused by `docker-asset-publisher.ts` (ECR publish path), `src/local/docker-image-builder.ts` (`cdkd local invoke` container Lambda path), and `src/local/ecs-task-runner.ts` (ECS run-task `ContainerImage.fromAsset` path). Streams output via `runDockerStreaming` (no `execFile` `maxBuffer` ceiling — fixes silent kills on `# syntax=docker/dockerfile:1` Dockerfiles where BuildKit progress + frontend pull exceeds the prior 50 MB cap). Sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` in the build env (matches CDK CLI's `cdk-assets-lib`). Full BuildKit flag set forwarded from the CDK `DockerImageSource` schema (`--build-context` / `--secret` / `--ssh` / `--network` / `--cache-from` / `--cache-to` / `--no-cache` / `--platform`). Supports both `directory` and `executable` source modes (the latter runs a user-supplied build script and reads the image tag from its stdout). `Object.entries`-stable build-arg order preserved (load-bearing for layer-cache stability). Parameterized error wrapping so each consumer threads its own typed error class.
- **src/types/assembly.ts** - Cloud Assembly types (AssemblyManifest, MissingContext, etc.)
- **src/provisioning/register-providers.ts** - Shared provider registration (called from deploy.ts and destroy.ts)
- **src/types/** - Type definitions (config, state, resources, assembly, etc.)
- **src/utils/** - Logger, ANSI color helpers (`colors.ts` — `green` / `yellow` / `red` / `cyan` / `gray` / `bold` / `dim` inline wrappers; kept in a separate module from `logger.ts` so test files that `vi.mock('../../../src/utils/logger.js', ...)` don't accidentally strip color helpers and crash any code path that imports them), live progress renderer (multi-line in-flight task display), error handler (incl. `normalizeAwsError` for AWS SDK v3 synthetic UnknownError → actionable HTTP-status-keyed messages), AWS client factory, AWS region resolver (`aws-region-resolver.ts` — caches bucket-region lookups via `GetBucketLocation` so the state-bucket S3 client can be rebuilt for the bucket's actual region), stack output buffer (`stack-context.ts` — `AsyncLocalStorage`-backed per-stack log buffer used by `cdkd deploy` when more than one stack is running concurrently; the logger pushes into the active buffer instead of writing to stdout, and the deploy CLI flushes each buffer atomically when its stack finishes so per-stack output blocks don't interleave), single-flight cleanup memoizer (`single-flight.ts` — wraps an async cleanup function so concurrent / repeated callers await the SAME underlying invocation; used by `cdkd local invoke` / `local start-api` to close the SIGINT-during-outer-finally race against shared mutable state like `containerId` / `servers[]` / tmpdir sets), docker subprocess helper (`docker-cmd.ts` — `getDockerCmd()` resolves the CLI binary via `CDK_DOCKER` env var for podman / finch / nerdctl parity; `runDockerStreaming` / `spawnStreaming` route every docker subprocess call through streaming spawn so BuildKit's progress output doesn't hit Node's `execFile` `maxBuffer` ceiling, mirror chunks to stdout/stderr when the logger is at debug level (`--verbose`), and reject with a `SpawnError` carrying the captured streams)
- **vite.config.ts** - Vite+ configuration for build, test, lint, format, and tasks

### SDK Providers

SDK Providers are in `src/provisioning/providers/`. See [README](../README.md) for the full list of supported resource types. Registration is centralized in `src/provisioning/register-providers.ts`.

SDK Providers are preferred over Cloud Control API for performance -- they make direct synchronous API calls with no polling overhead. Cloud Control API is used as a fallback for resource types without an SDK Provider.

## State Schema

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5; // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties, 4 = +imports[], 5 = +deletionPolicy/updateReplacePolicy
  stackName: string;
  region?: string;      // Required on version >= 2 (load-bearing for the S3 key)
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  imports?: StateImportEntry[]; // v4+: Fn::ImportValue refs recorded for strong-reference destroy refusal
  lastModified: number;
}

interface StateImportEntry {
  sourceStack: string;   // The producer stack whose Output was imported
  sourceRegion: string;  // The producer's region (load-bearing for state-key lookup)
  exportName: string;    // The CloudFormation Output's Export.Name
}

interface ResourceState {
  physicalId: string;                       // AWS physical ID
  resourceType: string;                     // e.g., "AWS::S3::Bucket"
  properties: Record<string, any>;          // Resolved template intent (what cdkd was asked to deploy)
  observedProperties?: Record<string, any>; // AWS-current snapshot at deploy time (drift baseline)
  attributes: Record<string, any>;          // For Fn::GetAtt resolution
  dependencies: string[];                   // For proper deletion order
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'; // v5+: template attribute recorded at deploy time
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'; // v5+: template attribute recorded at deploy time
}
```

**`deletionPolicy` / `updateReplacePolicy`** (schema v5+) are the CFn template
attributes recorded at deploy time so the next `cdkd deploy` / `cdkd diff` can
detect attribute-only flips that have no AWS API impact but still matter to
cdkd's destroy-time `DeletionPolicy: Retain` skip (and to anyone reading the
diff). Pre-v5, removing `removalPolicy: RemovalPolicy.DESTROY` from a CDK
construct (= `DeletionPolicy` flips from `Delete` to `Retain` in the synth
template) silently surfaced as `No changes detected` because `DiffCalculator`
only compared `Properties`. v5 widens the diff comparator to walk these two
attribute fields too; the UPDATE classification still fires when only these
change, and the deploy engine refreshes the cdkd state record without
calling any provider (there is no per-resource AWS API for either attribute).
The destroy paths consume the recorded value through the shared
`shouldRetainResource(deletionPolicy)` helper in `src/types/state.ts`:
`cdkd destroy` (synth-driven, `DeployEngine` DELETE branch) uses
`state.deletionPolicy ?? template.Resources[<id>].DeletionPolicy` so state
wins and the template stays a back-compat fallback; `cdkd state destroy`
(template-less, `destroy-runner.ts`) reads `state.deletionPolicy` only —
pre-v5 state on `cdkd state destroy` therefore stays at the pre-fix
"delete every resource in state" behavior until a redeploy under v5
populates the field.

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
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
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

### 2. Build System (Vite+)

- New dev / build tasks (lint, format, audit scripts, codegen, etc.) are registered as Vite+ tasks in `vite.config.ts` and invoked via `vp run <task>`. This is the project convention — prefer it over `package.json` `"scripts"` entries or ad-hoc `node` invocations for anything that lives beyond a single PR.
- `vp pack` builds the ESM package through tsdown with a Node 20 runtime target
- The global `vp` CLI is pinned by `.mise.toml`; project Node.js is managed by Vite+ from `.node-version`

### 3. CLI Configuration Resolution

- `--app` (`-a`) is optional: falls back to `CDKD_APP` env var, then `cdk.json` `"app"` field. Accepts either a shell command (`"node app.ts"`) or a path to a pre-synthesized cloud assembly directory (`cdk.out`); when a directory is given, synthesis is skipped and the manifest is read directly.
- `--state-bucket` is optional: falls back to `CDKD_STATE_BUCKET` env var, then `cdk.json` `context.cdkd.stateBucket`
- `--region` is **bootstrap-only** as of PR #63 (v0.12.0). `cdkd bootstrap` uses it to pick the region of the new state bucket; every other command (`deploy`, `destroy`, `diff`, `synth`, `list`, `state`, `force-unlock`, `publish-assets`) accepts `--region` for backward compatibility but emits a deprecation warning and ignores the value — provisioning clients pick up the region from `AWS_REGION` / the AWS profile, and the state-bucket client auto-detects the bucket's region via `GetBucketLocation` (PR #60, v0.10.0).
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
4. Refresh the CFn schema fixture for the new type: `node scripts/refresh-cfn-schemas.mjs --only-missing` (requires AWS credentials with `cloudformation:DescribeType`). Then classify every unaccounted property into `handledProperties` (if `create()`/`update()` wires the field) or `unhandledByDesign` (with a one-line rationale) so the new `property-coverage` test stays green — see [docs/provider-development.md](docs/provider-development.md) §3c.
5. Write tests
6. Add the resource type to [docs/supported-resources.md](docs/supported-resources.md) (deploy/manage capability table) AND to [docs/import.md](docs/import.md) (import-side coverage: auto-lookup vs override-only vs sub-resource)

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
- **[docs/cross-stack-references.md](docs/cross-stack-references.md)** - `Fn::ImportValue` strong reference design, exports index architecture, schema v4 migration

## Known Limitations

- NOT recommended for production use

**Recently Implemented**: per-PR shipped-feature notes moved to
[docs/changelog-cdkd.md](docs/changelog-cdkd.md). Past entries are preserved
there; new entries should go to that file (not back into this CLAUDE.md). The
split is per the official Claude Code memory guidance that a CLAUDE.md should
stay around 200 lines so context-window usage and instruction adherence stay
high.

## Dependencies

### Key Dependencies

- `@aws-sdk/client-*` - AWS SDK v3 (various services)
- `graphlib` - DAG construction
- `archiver` - ZIP packaging for file assets
- `chokidar` - File watcher backing `cdkd local start-api --watch` (PR 8c)
- `yaml` - CFn-aware YAML codec for `cdkd export` / `cdkd import --migrate-from-cloudformation` (preserves `!Ref` / `!GetAtt` / `!Sub` shorthand intrinsics on round-trip — see [src/cli/yaml-cfn.ts](src/cli/yaml-cfn.ts))

### Dev Dependencies

- `esbuild` - Build tool
- `vitest` - Testing framework
- `eslint` - Linting
- `prettier` - Formatting
- `typescript` - Type checking

## Node.js Version

- **`package.json` engines**: Node.js >= 20.0.0 (the lower bound users of cdkd must meet).
- **Local dev / CI Node version**: 24.15.0, pinned by `.node-version` (managed by Vite+ / mise).
- **`vp pack` build target**: Node 20 (the runtime cdkd ships to users).
- **TypeScript type stripping**: Node 24 strips type annotations by default, so `node scripts/foo.ts` runs `.ts` files directly — no `tsx` / `ts-node` dev dependency needed. Use this for ad-hoc scripts under `scripts/`; prefer registering longer-lived scripts as Vite+ tasks in `vite.config.ts` (see "Build System" above).

## Workflow Rules

- **When adding new functionality or fixing bugs**: Always add corresponding unit tests. Do not wait to be asked.
- **After modifying source code**: Always run `vp run build` before telling the user to test. The user runs cdkd via `node dist/cli.js`, so source changes without a build have no effect.
- **Self-review before commit (4 axes)**: Once the implementation feels complete, walk these four axes BEFORE running `/check` and committing — the markgate hook checks that tests pass, not that the work is *good*:
  1. **Implementation gaps** — anything in the agreed scope still missing? (e.g. updated `deploy.ts` but forgot the parallel change in `destroy.ts` / `diff.ts`; tests not added; docs not updated)
  2. **Oddities** — anything in the diff strange or inconsistent? (dead code, leftover names from the old shape, error messages that no longer make sense, half-applied refactors)
  3. **Polish opportunities** — small in-scope improvements you noticed and dismissed as "out of scope"? Default to including them in the same PR if they touch the same files and carry no behavior-break risk; defer only when they belong to a genuinely different concern.
  4. **Regression risk** — full test suite run (not just the new tests)? Any renamed/removed exports that other call-sites might depend on? Any behavior change a reviewer might miss in the diff?

  Surface findings out loud (in chat or todos) and fix them before invoking `/check`. The cost of one more pass is small compared to a follow-up PR or a missed regression.
- **Before every commit**: Two markgate gates guard `git commit` via `.claude/hooks/check-gate.sh`. Both must be fresh:
  - `check` — recorded by `/check` (typecheck, lint, build, tests). Scope: `src/**`, `tests/**`, build/test configs (see `.markgate.yml`). Only invalidated by changes in that scope.
  - `docs` — recorded by `/check-docs` (README.md / CLAUDE.md / docs/ consistency with src). Scope: `src/**`, `docs/**`, `README.md`, `CLAUDE.md`. Only invalidated by changes in that scope.

  **Run the required skills proactively** before attempting the commit — look at `git status` / `git diff --cached --name-only` and match it against each gate's scope: a tests-only commit only needs `/check`; a docs-only commit only needs `/check-docs`; a src edit needs both; changes that fall outside both scopes (e.g. `.claude/**`, `.markgate.yml`) need neither. The hook is a safety net, not the primary trigger — if you see "Blocked by check-gate", the message names exactly which skill to re-run, but getting there means you skipped the proactive step. `/verify-pr` refreshes both markers in one shot. Install `vp` and markgate via `mise install` at the repo root (see CONTRIBUTING.md).
- **Before opening or merging any PR**: A third markgate gate, `verify-pr`, guards `gh pr create` and `gh pr merge` via `.claude/hooks/verify-pr-gate.sh`. Declared as `requires: [check, docs]` in `.markgate.yml` (markgate 0.3+ feature) so the gate is fresh **only when both children are fresh AND `/verify-pr` itself has set the parent marker** — `requires` is strict, set-time refusal of the parent when either child is stale, mirroring the skill's own workflow which runs `/check` + `/check-docs` first. Pre-0.3 the scope was a hand-duplicated `include` glob union of `check` + `docs`; the AND-of-children mechanism is the same in spirit but harder to drift from. The skill walks the full checklist — typecheck/lint/build/tests, CI status, working tree, docs consistency, leftover AWS resources, code review (incl. shared-utility caller verification), **live-test of the changed behavior against real or fixture input**, **session retrospective + proposals for new rules / hooks / skills**, and PR title + body freshness vs the diff. So opening or merging a PR whose live behavior was never exercised, or whose retrospective produced no rule proposals for surprises in the session, is **physically blocked** — the hook refuses `gh pr create` / `gh pr merge` until `/verify-pr` is re-run end-to-end. This is the structural enforcement of the "tests passing is not the same as the feature working" + "every recurring surprise should leave a rule behind" lessons.

- **Before merging any PR that touches deletion logic**: A fourth markgate gate, `integ-destroy`, guards `gh pr merge` via `.claude/hooks/integ-destroy-gate.sh`. Scope: `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`, `src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/implicit-delete-deps.ts`, `src/analyzer/lambda-vpc-deps.ts`, plus a **14-day wall-clock TTL** (markgate 0.3+ `ttl` field) — real-AWS behavior drifts even when the repo doesn't (AWS SDK updates, API behavior changes, eventual-consistency tweaks), so a marker that's been clean for two weeks no longer proves the destroy path actually works against today's AWS. Only `/run-integ` sets it (resetting the TTL countdown), and only when the destroy step finished with 0 errors AND the post-destroy AWS state was empty. So a PR whose destroy path has not been verified against real AWS recently is **physically unmergeable** — the hook blocks `gh pr merge` until you run `/run-integ <test>` and it succeeds end-to-end. This is the structural enforcement of the "never merge a PR whose destroy path is unverified" rule below.

- **Before merging any PR that touches cross-cutting deploy/destroy code**: A markgate gate, `integ-broad`, guards `gh pr merge` via `.claude/hooks/integ-broad-gate.sh`. Scope (regex in the hook + duplicated in `.claude/skills/verify-pr/SKILL.md` step 6): `src/deployment/deploy-engine.ts`, `src/deployment/intrinsic-function-resolver.ts`, `src/cli/commands/destroy-runner.ts`, `src/cli/commands/destroy.ts`, `src/cli/commands/deploy.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/template-parser.ts`, `src/provisioning/register-providers.ts`. Plus the same **14-day wall-clock TTL** as `integ-destroy` / `integ-local`. Why a separate gate from `integ-destroy`: the existing `integ-destroy` marker accepts ANY clean real-AWS destroy and flips green even on a 2-stack feature integ (e.g. `import-value-strong-ref`'s S3+SSM fixture). But cross-cutting code changes affect multi-resource VPC / Lambda / Custom-Resource paths a narrow integ never exercises — PR #348 (Issue #343, 2026-05-13) shipped that way and surfaced post-merge as an incident. The `integ-broad` marker is bound to a sentinel file `.markgate-broad-integ-test` that `/run-integ` updates ONLY when the test name is in the broad set (`bench-cdk-sample`, `lambda`, `microservices`, `drift-revert`, `drift-revert-vpc`, `multi-stack-deps`, `multi-resource`, `remove-protection`, `export`) AND the run was clean. So a narrow feature integ legitimately flips `integ-destroy` (it WAS a clean destroy) while leaving `integ-broad` stale — exactly the gradient we want. PRs that touch cross-cutting code physically cannot merge without a broad integ in addition to the feature one. The memory rule `feedback_cross_cutting_needs_broad_integ.md` records the full incident and rationale.

- **Before merging any PR that touches local-execution code**: A markgate gate, `integ-local`, guards `gh pr merge` (and `git merge`) via `.claude/hooks/integ-local-gate.sh`. Scope: `src/local/**`, `src/cli/commands/local-*.ts`, `tests/integration/local-*/**`, plus the same **14-day wall-clock TTL** as `integ-destroy` — Docker base-image behavior (`public.ecr.aws/lambda/*`, RIE binary), `dockerd` semantics, and chokidar / network plumbing drift over time, so a marker that's been clean for two weeks no longer proves today's local code path actually works against today's environment. Only `/run-integ` sets it, and only when (a) the integ test name starts with `local-` (e.g. `local-invoke` / `local-start-api` / `local-run-task` / `local-invoke-container` / `local-invoke-from-state` / `local-invoke-layers` / `local-invoke-{python,ruby,java,dotnet,provided}` / `local-start-api-cors`), (b) the test exited cleanly, AND (c) the post-run `docker ps --filter name=cdkd-local-` / `docker network ls --filter name=cdkd-local-task-` sweep is empty. So a PR whose local code path has not been verified against real Docker recently is **physically unmergeable** — the hook blocks `gh pr merge` / `git merge` until you run `/run-integ local-<test>` and it succeeds end-to-end. The two gates are independent: a non-`local-*` integ run (e.g. `lambda`, `bench-cdk-sample`) refreshes `integ-destroy` but NOT `integ-local`, and vice versa; the `local-invoke-from-state` test (which exercises a real AWS deploy + destroy on top of the Docker run) can refresh BOTH.

- **Before merging any PR that bumps the cdkd state schema version**: A markgate gate, `integ-schema-migration`, guards `gh pr merge` via `.claude/hooks/integ-schema-migration-gate.sh`. Scope: `src/types/state.ts` (the file carrying the `StackState.version` literal type + `STATE_SCHEMA_VERSIONS_READABLE` constant). The hook does a precise second-pass `gh pr diff` grep for actual version-constant additions/deletions (`version: 1 | 2 | 3 | 4 | 5` literal type changes OR `STATE_SCHEMA_VERSION = N` constant changes) so non-bump edits to state.ts (JSDoc, helper additions, comment fixes) pass through with no false-positive activation — only a real schema bump triggers enforcement. **14-day wall-clock TTL** same as integ-destroy / integ-broad / integ-local — AWS-side wire-format behavior + binary auto-migration logic drift over time. Only `/run-integ` sets the marker, and only when (a) the integ test name matches `schema-v<N>-to-v<N+1>-migration` (e.g. `schema-v5-to-v6-migration`), (b) the destroy step finished cleanly with 0 errors AND 0 orphan resources. Closes the structural enforcement gap that memory rule `feedback_schema_version_migration_integ_required.md` documents: cdkd's S3 state schema is the actual user contract (millions of state files live under v1..v5 shapes already shipped), so a vN -> vN+1 bump MUST be transparently auto-migrated by the new binary AND verified by a real-AWS integ test that proves the round-trip: deploy under vN -> swap binary -> read works -> next write upgrades to vN+1 silently -> destroy clean. Unit tests cannot catch wire-format divergences (`undefined` field stripping, key ordering, schema version coercion); only real round-trip does. **Transparent auto-migration is an absolute requirement** — users MUST NOT have to do anything for the upgrade to work (no `cdkd state migrate-schema` command, no env flag, no manual JSON edit; the next read of a vN state file by the vN+1 binary auto-upgrades in memory + the next write persists vN+1 silently). Schema bumps that violate transparent auto-migration are NOT shippable. Independent of other integ gates: a `lambda` / `bench-cdk-sample` run refreshes `integ-destroy` + `integ-broad` but NOT `integ-schema-migration`, and a `schema-vN-to-vNplus1-migration` run refreshes `integ-schema-migration` + `integ-destroy` (the migration integ ends with a clean destroy) but NOT `integ-broad` unless the migration fixture itself is broad-set-shaped.

- **Before merging large / security-sensitive PRs**: A sixth markgate gate, `pr-review`, guards `gh pr merge` via `.claude/hooks/pr-review-gate.sh`. The hook re-applies the `/review-pr` skill's size + bias heuristic to the target PR (`gh pr view <N> --json additions,deletions,changedFiles,files,headRefOid,headRefName`): `loc < 300` OR `fc < 5` → `inline` (pass-through), `300 ≤ loc < 1000` AND `5 ≤ fc < 10` → `1-reviewer`, `loc ≥ 1000` OR `fc ≥ 10` → `3-axis`; up-bias triggers (any path under `src/utils/role-arn.ts` / `src/local/cognito-jwt.ts` / `src/local/lambda-authorizer.ts` / `src/local/docker-runner.ts` / `src/local/docker-image-builder.ts` / `src/local/ecr-puller.ts` / `src/provisioning/providers/**`, OR > 1 `fix:`-prefixed commit on the PR branch) move the tier UP one step (clamped at `3-axis`); down-bias triggers (every path under docs/infra OR every path under `tests/`) move it DOWN one step (clamped at `inline`); when both fire, up wins. For PRs whose final tier is `1-reviewer` or `3-axis`, the marker must be fresh AND bound to the PR's current HEAD sha — set ONLY by `/review-pr` after the recommended reviewers complete and every blocker is addressed. The marker is sha-bound via the gitignored `.markgate-pr-review-sha` sentinel file in the gate's `include:` scope: a new push to the PR invalidates the marker naturally (next `/review-pr` run rewrites the sentinel). `inline`-tier PRs always pass through. Only `gh pr merge` is gated; `gh pr create` is intentionally NOT gated (small PRs should be openable freely). Closes the "sub-agent self-review ≠ independent review" gap surfaced by PR #267 / issue #270 (see memory rule `feedback_subagent_review_not_self_review.md` for the full pattern).

- **Other PreToolUse safety hooks**: Nine additional one-shot hooks block known foot-guns at the source. `.claude/hooks/commit-msg-heredoc-gate.sh` blocks `git commit -m "$(cat <<'EOF' ... EOF)"`-style invocations because outer-shell quote tracking miscounts when the body contains apostrophes / backticks; use `git commit -F <file>` instead. `.claude/hooks/gh-pr-edit-deprecation-gate.sh` blocks `gh pr edit --title` / `--body` because they currently fail SILENTLY on a GraphQL Projects-classic deprecation; use `gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title=... -F body=@<file>` instead. `.claude/hooks/provider-docs-gate.sh` blocks `git commit` when staged `src/provisioning/register-providers.ts` introduces a new `registry.register('AWS::Service::Type', ...)` call but the resource type does NOT appear in **both** `docs/supported-resources.md` and `docs/import.md` — closes the docs gap that the v2 drift coverage push (PRs #210-#216) shipped 7 new types without docs entries until a post-merge audit caught it (#219). `.claude/hooks/pr-body-item-number-gate.sh` blocks `gh pr create` / `gh pr edit` / `gh issue create` / `gh issue comment` / `gh api -X PATCH .../pulls|issues/...` invocations whose body file (`--body-file <FILE>` or `--field body=@<FILE>` / `-F body=@<FILE>`) contains `#N` patterns that GitHub auto-links to issue/PR `#N` — the "review-fix #4 → linked to unrelated PR #4" trap that hit PR #237. Allow-listed contexts (`closes #N` / `(#N)` / fenced code blocks / GitHub URLs / backtick code spans) pass through; bare `Must-fix #N` / `review-fix #N` / `step #N` / plain `#N` in prose are blocked with line-numbered offender output. Smoke test at `.claude/hooks/pr-body-item-number-gate.test.sh`. `.claude/hooks/internal-pr-labels-gate.sh` is the complementary check for prose-style internal dev labels in user-facing source code — it blocks `git commit` when staged `README.md` or `docs/*.md` files contain `(PR 8b)` / `(PR 6 of #224)` / `(PR 6 of #224, issue #232)` patterns in added/modified diff lines. Closes the gap that PR #251 had to clean up after — agent dispatch prompts use "PR 8b" / "PR 6 of #224" internally and that prose can leak into user-facing doc bodies. `CLAUDE.md` (developer-facing) and `tests/integration/**/README.md` (integ fixture metadata) are excluded; fenced code blocks and backtick code spans are allow-listed. Smoke test at `.claude/hooks/internal-pr-labels-gate.test.sh`. `.claude/hooks/cmd-parse-stub-gate.sh` blocks `git commit` when a staged `tests/**/*.test.ts` file calls Commander's `cmd.parse([...])` without a nearby `.action(() => {})` stub (60-line lookback) — pre-fix the test process crashed on Node 24 because the real CLI's action handler surfaces `process.exit(...)` as an unhandled rejection that Node 24 (unlike Node 20/22) escalates to a process exit AFTER the assertion passed (PR #266 trap, first caught in `tests/unit/cli/local-run-task.test.ts`). The hook passes through `cmd.parseAsync(...)` (which awaits rejections via the test runner), test files without any `cmd.parse(...)` call, and production code in `src/**`. Smoke test at `.claude/hooks/cmd-parse-stub-gate.test.sh`. `.claude/hooks/commit-prefix-scope-gate.sh` blocks `git commit` when the commit message uses a `feat:` or `fix:` conventional-commit prefix but NO file under `src/**` is staged — closes the trap that hit PR #346 / v0.97.0 where a `feat(review-pr): ...` commit on a `.claude/skills/**` file (internal dev tooling, not cdkd CLI) triggered semantic-release into a minor version bump with a misleading "Features: review-pr: add ..." CHANGELOG entry that users read as a new cdkd CLI feature. The hook also reads `-F <file>` / `--message=` / `--message ` variants of the commit subject; `revert:` passes through (inner prefix carries); `--amend` and bare `git commit` (no -m / -F — opens editor) pass through. The error message lists the staged files and suggests the right prefix (`chore:` for `.claude/**` / hooks / skills / build / CI; `docs:` for docs-only; `test:` for tests-only; `chore(deps):` for package.json / lockfile only). Smoke test at `.claude/hooks/commit-prefix-scope-gate.test.sh` (34 cases). `.claude/hooks/integ-coverage-matrix-gate.sh` blocks `git commit` when staged files touch the integ-coverage matrix's source scope (`tests/integration/<name>/{lib,bin}/*.ts` or `src/provisioning/register-providers.ts`) AND `vp run integ-coverage` would produce different `docs/integ-coverage.md` / `docs/_generated/integ-coverage.json` than what is currently in the working tree. Closes the gap between the source-scope check that `provider-integ-gate.sh` does and the CI step that runs `vp run integ-coverage` + `git diff --quiet`: pre-PR the only enforcement was CI hard-fail and `/verify-pr` step 5, both of which fire after the commit + push. The hook runs the actual regenerator (~0.1s — Node executes the script via `--experimental-strip-types`), compares output against the current snapshot, and restores the originals before blocking so the working tree is not silently modified — the user runs `vp run integ-coverage` + `git add` themselves to keep the regen step explicit in shell history. Refactors that touch the scope but don't change matrix output (e.g. comment-only edits) pass through cleanly. Smoke test at `.claude/hooks/integ-coverage-matrix-gate.test.sh` (12 cases — pass / block / restore-on-block / regenerator-crash / missing-script / refactor / `git push` pass-through / `cd <path>` routing / register-providers-alone / bin-file / hand-edited-stale-matrix). `.claude/hooks/non-english-text-gate.sh` blocks `gh pr create` / `gh pr edit` / `gh pr merge` (and their `gh -C <path>` forms) when the resolved PR diff (or local `origin/main..HEAD` when no PR exists yet) contains non-English writing-system characters — hiragana (U+3040-U+309F), katakana (U+30A0-U+30FF), CJK ideographs / kanji / Chinese (U+4E00-U+9FFF), Hangul syllables (U+AC00-U+D7AF), or CJK punctuation (U+3000-U+303F). Closes the gap that PR #521 exposed: the OSS workflow rule "English-only for committed files" was honor-system, and a verbatim Japanese session quote landed in `.markgate.yml` + the gate hook header undetected; the post-merge audit had to surface it and PR #523 fixed it up. Per-PR-level (not per-commit) by design: empirically violations are 1-2 files at most so the "accumulates across commits" risk is low, while per-PR runs (1× per `gh pr create` / `edit` / `merge`) hold developer feedback overhead at ~100-250ms instead of compounding ~30-150ms over every commit. Strength is equivalent because `gh pr merge` is the one funnel every commit lands through. Detection is via `perl -CSD -ne` (not `grep -P`) because BSD `grep` on macOS lacks PCRE; the Unicode-range character class is the same on either system. Skips binary / lockfile / asset extensions where non-ASCII bytes are normal. Fails open when `gh` is missing or unauthenticated (matches `post-merge-orphan-push-gate.sh`'s contract). Em-dashes / curly quotes / box-drawing chars / arrow glyphs pass through (the ranges are deliberately scoped to writing systems, not general-purpose Unicode). No bypass marker — the fix is trivial (translate the text); if a test fixture ever genuinely needs Japanese content, add a sidecar allow-list file like the integ-coverage gate uses. Smoke test at `.claude/hooks/non-english-text-gate.test.sh` (15 cases via `$GH_BIN` mock injection covering every Unicode range / pass-through Unicode / binary-skip / lockfile-skip / `git commit` pass-through / `gh pr merge` / `gh pr edit` / `cd <path> && gh pr create` routing / non-git dir / gh-missing fail-open). All nine produce actionable error messages with the exact replacement command.
- **Never commit or push directly to `main`**: All changes must land via a feature branch + PR. Before committing, run `git switch -c <branch>` (e.g., `fix/xxx`, `feat/xxx`, `docs/xxx`). A PreToolUse hook (`.claude/hooks/branch-gate.sh`) blocks `git commit` and `git push` when the **target git working tree** is on `main` / `master` — the hook is cwd-aware (reads `tool_input.cwd` from the hook payload + parses `cd <path>` / `git -C <path>` from the command), so worktree work that `cd /parent && git commit`s into a parent worktree on `main` is also caught. Smoke test at `.claude/hooks/branch-gate.test.sh`. If you see "Blocked by branch-gate", the message names the resolved target dir and the parsed command — create a feature branch in that dir and retry.
- **Never push to a branch whose PR has already merged**: A complementary PreToolUse hook (`.claude/hooks/post-merge-orphan-push-gate.sh`) blocks `git push <remote> <branch>` (incl. `-u` / `--set-upstream` / `git -C <path> push`) when `<remote>` is `origin` AND `gh pr list --head <branch> --state merged` returns a PR whose `headRefName` matches. Closes the PR #263 incident (memory `feedback_post_merge_orphan_push.md`): `gh pr merge` lands the PR → GitHub's `delete_branch_on_merge: true` removes the source branch → a near-simultaneous `git push` SUCCEEDS by re-creating the deleted branch as a fresh orphan ref no PR is tracking, so the commits silently never reach main. The hook is cwd-aware (same resolution as `branch-gate.sh`), and the branch name is parsed from the `git push` command line or derived from `symbolic-ref --short HEAD` against the resolved target dir when omitted. Scope guard: ONLY fires on the MERGED state (closed-not-merged passes through — that branch may be revived); ONLY fires on the `origin` remote (other remotes pass through); ONLY fires on `git push` (`git pull` / `git fetch` / etc. pass through). Fails open when `gh` is missing or unauthenticated (logs a stderr note, never blocks) so a fresh machine still works. Smoke test at `.claude/hooks/post-merge-orphan-push-gate.test.sh` (14 cases via `$GH_BIN` mock injection covering matched-merged / mismatched-head / open / closed / non-origin / `-C` / `cd` / no-gh / auth-fail / deletion-refspec / `-u` no-branch). When blocked, the error names the merged PR number and prints the "replay on a fresh branch" recipe.
- **Before creating or merging a PR**: Run `/verify-pr` (adds CI status, docs consistency, AWS resource cleanup, code review on top of `/check`)
- **Merge PRs with squash only**: This repo allows only squash merges (`mergeCommitAllowed: false`, `rebaseMergeAllowed: false`, `squashMergeAllowed: true`). Always use `gh pr merge <N> --squash --delete-branch`. Do not offer `--merge` / `--rebase` as alternatives to the user. (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed` confirms.)
- **PR review pattern**: 3 read-only review sub-agents are codified at `.claude/agents/pr-{spec,code,test}-reviewer.md`. The orchestrator (parent session) dispatches all three in parallel against a PR's diff and synthesizes the findings before merge. Use them when reviewing a non-trivial implementation PR — the 3 axes (spec compliance / code quality / test adequacy) catch different classes of issues. Each agent has read-only tools (Read / Glob / Grep / Bash) so they can never accidentally edit; their output is a structured report that the parent uses to decide whether to merge or send fixes back to the implementing agent. **Scale the reviewer count to PR size** — running all 3 on every PR is overkill (~25 min total) and the cost exceeds the catch on small changes. Heuristic: **< 300 LOC (or < 5 files)** spot-check inline by the orchestrator with no sub-agent dispatch; **300-1000 LOC** dispatch 1 reviewer (code-quality is the default single pick); **>= 1000 LOC (or >= 10 files)** dispatch all 3 in parallel. Bias upward (more rigor) for security-sensitive surfaces, multi-agent parallel writes, or new patterns future PRs will follow. Bias downward (less rigor) for mechanical refactors, small hook / skill additions, and tightly-scoped bug fixes referenced in the bug report. The thresholds are heuristics, not hard rules; when in doubt, ask "would I be comfortable spot-checking this in 5 minutes?" — if yes, skip the reviewers.
- **When running integration tests**: Use `/run-integ` with the appropriate test name (e.g., `/run-integ lambda`). **Never bypass the skill** by manually invoking `cdkd deploy` / `cdkd destroy` from a shell — the skill encodes the deploy + destroy + orphan-resource verification in a single block, and skipping any step (e.g. relying on a successful deploy without running destroy) has historically caused us to merge changes whose destroy path was broken.
- **After running integration tests**: Verify no leftover AWS resources remain (`aws s3 ls s3://cdkd-state-{accountId}/cdkd/` should return empty or error; on accounts that haven't migrated yet, the legacy `cdkd-state-{accountId}-{region}` bucket is still in use — check both). **If the destroy step failed or left orphans, you MUST clean them up via direct AWS API calls before doing anything else** (use `/cleanup` if applicable, otherwise `aws ec2 delete-*` etc.) — leaving orphan resources after an integ run is never acceptable, regardless of whether the test passed.
- **Never merge a PR whose destroy path is unverified**: If a change touches deletion logic (any provider's `delete()`, DAG order on destroy, state cleanup, etc.), the integ test must complete the **destroy** step successfully (not just deploy) before the PR is mergeable. A green CI is necessary but not sufficient — CI does not exercise real-AWS destroy.
- **After fixing documentation or code**: Commit to a feature branch (not `main`) and push immediately. Do not leave uncommitted changes. Before reporting completion to the user, always run `git status` to verify nothing is uncommitted and that you are not on `main`.
- **English-only for committed files**: This is an OSS project. All committed files (source code, shell scripts, hook messages, config files such as `.claude/settings.json`, docs, comments, commit messages, PR titles/bodies) MUST be written in English. Do not use Japanese characters (hiragana, katakana, kanji) in any committed artifact. Conversation with the user in chat may be in Japanese — this rule applies only to files that land in the repository.
