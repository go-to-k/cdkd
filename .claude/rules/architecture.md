---
description: cdkd's 7-layer architecture and key architectural decisions
paths:
  - 'src/**/*.ts'
---

# Architecture Overview

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

## Key Architectural Decisions

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
   - State bucket region is resolved dynamically via `GetBucketLocation` (`src/utils/aws-region-resolver.ts`); both state-bucket S3 consumers — the state backend (PR #60) and the lock manager (issue #803) — rebuild their S3 client for the bucket's actual region before any state or lock operation, so the CLI works regardless of the profile region. Provisioning clients (CC API, Lambda, IAM, etc.) keep using `env.region` — only the state-bucket S3 clients are region-corrected.

3. **Event-driven DAG Execution**
   - Analyzes dependencies via `Ref` / `Fn::GetAtt` / `DependsOn`
   - Dispatches each resource as soon as ALL of its own dependencies complete (no level barrier — downstream work does not wait for unrelated siblings in the same DAG level)
   - Bounded by `--concurrency` across the whole stack
   - Implemented in `src/deployment/dag-executor.ts`

4. **Intrinsic Function Resolution**
   - All CloudFormation intrinsic functions supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`, `Fn::GetStackOutput`, `Fn::FindInMap`, `Fn::Base64`, `Fn::GetAZs`, `Fn::Cidr`
   - `Fn::GetStackOutput` reads the producer stack's output directly from cdkd's S3 state (`s3://{bucket}/cdkd/{StackName}/{Region}/state.json`) — no Export needed, and `Region` may differ from the consumer's deploy region (same-account cross-region works out of the box because the state bucket name is account-scoped, not region-scoped). `RoleArn` (cross-account) is supported: cdkd issues `sts:AssumeRole` against the supplied role, derives the producer's canonical state bucket from the role ARN's account ID (`cdkd-state-{producerAccountId}`), auto-detects the bucket's region via `GetBucketLocation`, and reads the producer's state through an ephemeral state backend with the assumed credentials. Assumed credentials are cached per-RoleArn for the deploy lifetime so a stack that references the same producer multiple times only pays one STS hop. The inline `RoleArn` argument must be a LITERAL string in the template — `Ref` / `Fn::GetAtt` / `Fn::Sub` are intentionally rejected since the resolver context cannot guarantee producer-account info at intrinsic-resolution time.
