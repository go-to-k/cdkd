---
description: cdkd's 7-layer architecture and key architectural decisions
paths:
  - 'src/**/*.ts'
---

# Architecture Overview

Seven layers, each feeding the next:

1. **CLI** (`src/cli/`).
2. **Synthesis** (`src/synthesis/`) — CDK app subprocess, Cloud Assembly parsing, context providers.
3. **Assets** (`src/assets/`) — publish to S3 / ECR, per stack, pipelined.
4. **Analysis** (`src/analyzer/`) — template parsing, dependency analysis, DAG building.
5. **State** (`src/state/`) — S3-based state, optimistic locking.
6. **Deployment** (`src/deployment/`) — orchestration, parallel execution, diff detection.
7. **Provisioning** (`src/provisioning/`) — create/update/delete via SDK Providers with Cloud Control fallback.

## Key Architectural Decisions

### 1. Hybrid provisioning

- SDK Providers are preferred for common resource types: direct synchronous API calls, no polling.
- Cloud Control API is the fallback for the rest (async polling).
- Routing goes through the Provider Registry.

### 2. S3-based state management

- No DynamoDB. Optimistic locking via S3 conditional writes (`If-None-Match`, `If-Match`).
- Key layout (`version: 2`+) is region-prefixed:
  - State: `s3://bucket/cdkd/{stackName}/{region}/state.json`
  - Lock: `s3://bucket/cdkd/{stackName}/{region}/lock.json`
- The same `stackName` in two regions has two independent state files, so changing `env.region` does not overwrite the prior region.
- Legacy `version: 1` layout (`cdkd/{stackName}/state.json`) is still readable; the next write auto-migrates and deletes the legacy key.
- An old cdkd binary fails clearly on a `version: 2` blob rather than mishandling it.

**State-bucket region resolution.** The bucket's region is resolved dynamically via `GetBucketLocation` (`src/utils/aws-region-resolver.ts`). All four state-bucket S3 consumers rebuild their S3 client for the bucket's actual region BEFORE any state / lock / exports-index / CR-response operation, so the CLI works regardless of the profile region:

- the state backend,
- the lock manager,
- the exports index store,
- the custom-resource response path (`CustomResourceProvider` stores + pre-signs cfn-response objects there).

The probe, same-region short-circuit and credential-reusing rebuild are one shared helper, `rebuildClientForBucketRegion(client, bucket, opts)` in `src/utils/bucket-region-client.ts` (issue [#827](https://github.com/go-to-k/cdkd/issues/827)). Each store keeps its own memoization (`clientResolved` flag / single-flight `resolveInFlight`) and passes per-store knobs:

- `destroyOldClient` — the state backend owns and destroys its client; the others share `AwsClients.s3` and must NOT destroy it.
- `reuseClientCredentials` vs static `credentials` / `profile`.
- `tolerateNonStandardClient` — for the exports store's and CR provider's test-double degradation.

Provisioning clients (CC API, Lambda, IAM, …) keep `env.region`; only the state-bucket S3 clients are region-corrected.

### 3. Event-driven DAG execution

- Dependencies come from `Ref` / `Fn::GetAtt` / `DependsOn`.
- A resource is dispatched as soon as ALL of its own dependencies complete — there is no level barrier, so downstream work never waits on unrelated siblings in the same level.
- Bounded by `--concurrency` across the whole stack.
- Implemented in `src/deployment/dag-executor.ts`.

### 4. Intrinsic function resolution

Supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`, `Fn::GetStackOutput`, `Fn::FindInMap`, `Fn::Base64`, `Fn::GetAZs`, `Fn::Cidr`.

A deliberate REFUSAL propagates out of `Fn::Sub` rather than being swallowed (issue [#1740](https://github.com/go-to-k/cdkd/issues/1740)). Which refusals, which `markNonRetryable`, and which consumer branches on the `CrossAccountSecretRefusalError` subclass: [intrinsic-refusals.md](intrinsic-refusals.md).

**`Fn::GetStackOutput`** reads the producer stack's output straight from cdkd's S3 state (`s3://{bucket}/cdkd/{StackName}/{Region}/state.json`) — no Export needed, and `Region` may differ from the consumer's deploy region (the state bucket name is account-scoped, not region-scoped). `RoleArn` (cross-account) is supported: cdkd assumes the supplied role, derives the producer's canonical state bucket from the role ARN's account ID (`cdkd-state-{producerAccountId}`), auto-detects that bucket's region, and reads through an ephemeral state backend with the assumed credentials. Assumed credentials are cached per `RoleArn` and source identity for the deploy lifetime. The inline `RoleArn` argument MUST be a literal string — `Ref` / `Fn::GetAtt` / `Fn::Sub` are rejected, because the resolver context cannot guarantee producer-account info at intrinsic-resolution time.

**CloudFormation fallback for cross-stack references** (issue [#1697](https://github.com/go-to-k/cdkd/issues/1697); default on, `--no-cfn-fallback` disables it on `deploy` / `diff`). When an `Fn::ImportValue` / same-account `Fn::GetStackOutput` reference is in NO cdkd state record, the resolver falls back to CloudFormation: `ListExports` (paginated, consumer's region) for `Fn::ImportValue`, `DescribeStacks` outputs (target region) for `Fn::GetStackOutput`. Invariants:

- cdkd-first precedence is inherent — the fallback only runs on a cdkd miss.
- A CFn-sourced resolution is a WEAK reference: deliberately NOT recorded into `state.imports` / `state.outputReads`, since cdkd cannot protect a producer it does not manage. No state schema change is involved.
- Lookup failures (missing `ListExports` / `DescribeStacks` permission) degrade to a warning plus the original not-found error.
- The `RoleArn` (cross-account) path NEVER takes the fallback.
- It relaxes `cdkd export`'s leaf-first migration ordering: remaining cdkd consumers resolve an exported producer's outputs through the fallback.

Full design: [docs/cross-stack-internals.md](../../docs/cross-stack-internals.md).
