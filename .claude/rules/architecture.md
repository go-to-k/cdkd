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
   - State bucket region is resolved dynamically via `GetBucketLocation` (`src/utils/aws-region-resolver.ts`); all four state-bucket S3 consumers — the state backend (PR #60), the lock manager (issue #803), the exports index store (issue #819), and the custom-resource response path (issue #1195 — `CustomResourceProvider` stores + pre-signs cfn-response objects in the state bucket) — rebuild their S3 client for the bucket's actual region before any state / lock / exports-index / CR-response operation, so the CLI works regardless of the profile region. The probe + same-region short-circuit + credential-reusing rebuild is a single shared helper `rebuildClientForBucketRegion(client, bucket, opts)` in `src/utils/bucket-region-client.ts` (issue #827 — extracted from the three previously near-identical `ensureClientForBucket()` copies); each store keeps its own per-instance memoization (`clientResolved` flag / single-flight `resolveInFlight` promise) and passes per-store knobs (`destroyOldClient` — the state backend owns + destroys its client, the others share `AwsClients.s3` and must not; `reuseClientCredentials` vs static `credentials`/`profile`; `tolerateNonStandardClient` for the exports store's and CR provider's test-double degradation). Provisioning clients (CC API, Lambda, IAM, etc.) keep using `env.region` — only the state-bucket S3 clients are region-corrected.

3. **Event-driven DAG Execution**
   - Analyzes dependencies via `Ref` / `Fn::GetAtt` / `DependsOn`
   - Dispatches each resource as soon as ALL of its own dependencies complete (no level barrier — downstream work does not wait for unrelated siblings in the same DAG level)
   - Bounded by `--concurrency` across the whole stack
   - Implemented in `src/deployment/dag-executor.ts`

4. **Intrinsic Function Resolution**
   - All CloudFormation intrinsic functions supported: `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Fn::ImportValue`, `Fn::GetStackOutput`, `Fn::FindInMap`, `Fn::Base64`, `Fn::GetAZs`, `Fn::Cidr`
   - **A deliberate REFUSAL propagates out of `Fn::Sub` (issue [#1740](https://github.com/go-to-k/cdkd/issues/1740)).** `Fn::Sub`'s `${LogicalId.Attribute}` form resolves through `resolveGetAtt`, and warn-and-keep-the-raw-`${...}` is the long-standing, deliberate answer for a genuinely unknown variable. It used to be the answer for EVERY failure, so the refusals the resolver raises on purpose along that path — `guardedPhysicalIdFallback`'s `*Arn` / `*Url` shape hard-fail (the #1103 class), the `--strict-getatt` rejection, `rejectPlaceholderArnAttribute` (#1729), and the fabricated-account guard (#1730) — were laundered into a literal `${Resource.Attribute}` shipped to AWS by a green deploy, i.e. the identical reference hard-failed in a resource property and silently degraded inside an `Fn::Sub`. The refusals now throw `IntrinsicResolutionRefusalError` (`src/utils/error-handler.ts`) and the `Fn::Sub` catch re-raises that class only; a genuine miss still keeps the placeholder, and its warning names the actual cause instead of asserting `not found`. Nothing else branches on the class. **Two further throw sites are NOT on that path** and use the class only so a deliberate refusal is a property of the THROW rather than of the one catch that inspects it: `resolveSplit`'s refusal of a non-string value, and its distinct refusal of an ALREADY-list value (#1874) — `Fn::Sub` cannot syntactically contain an `Fn::Split`, so neither changes behavior by being this class. Both of those ARE `markNonRetryable` (#1838), because an `Fn::Split` over a list can never succeed on a retry and the message interpolates a template-controlled logical id; the class itself stays unmarked, since the #1730 arm is genuinely time-dependent. And the class is not a guarantee against a class-AGNOSTIC catch: `evaluateConditions` absorbs any failure per condition and downgrades it to `false`, so a refusal inside a `Conditions` entry is still silently laundered. **Where the intrinsic SITS still decides what the user sees** — a refusal in a resource property fails the resource, while one in a stack Output is caught per-output by `deploy` (`keeping the previously persisted outputs`) and the deploy exits 0.
   - `Fn::GetStackOutput` reads the producer stack's output directly from cdkd's S3 state (`s3://{bucket}/cdkd/{StackName}/{Region}/state.json`) — no Export needed, and `Region` may differ from the consumer's deploy region (same-account cross-region works out of the box because the state bucket name is account-scoped, not region-scoped). `RoleArn` (cross-account) is supported: cdkd issues `sts:AssumeRole` against the supplied role, derives the producer's canonical state bucket from the role ARN's account ID (`cdkd-state-{producerAccountId}`), auto-detects the bucket's region via `GetBucketLocation`, and reads the producer's state through an ephemeral state backend with the assumed credentials. Assumed credentials are cached per-RoleArn for the deploy lifetime so a stack that references the same producer multiple times only pays one STS hop. The inline `RoleArn` argument must be a LITERAL string in the template — `Ref` / `Fn::GetAtt` / `Fn::Sub` are intentionally rejected since the resolver context cannot guarantee producer-account info at intrinsic-resolution time.
   - **CloudFormation fallback for cross-stack references (issue #1697, default on, `--no-cfn-fallback` to disable on `deploy` / `diff`)**: when an `Fn::ImportValue` / same-account `Fn::GetStackOutput` reference is in NO cdkd state record, the resolver falls back to CloudFormation — `ListExports` (paginated, consumer's region) for `Fn::ImportValue`, `DescribeStacks` outputs (target region) for `Fn::GetStackOutput` — so a cdkd-deployed consumer can reference a producer stack still managed by CloudFormation (`cdk deploy` / raw CFn). cdkd-first precedence is inherent (the fallback only runs on a cdkd miss). A CFn-sourced resolution is a WEAK reference: deliberately NOT recorded into `state.imports` / `state.outputReads` (cdkd cannot protect a producer it does not manage at destroy time, and CFn's export-in-use protection cannot see cdkd consumers), so no state schema change is involved. Lookup failures (missing `cloudformation:ListExports` / `DescribeStacks` permission) degrade gracefully: warn + the original not-found error. The `RoleArn` (cross-account) path never takes the fallback. This also relaxes `cdkd export`'s leaf-first migration ordering — remaining cdkd consumers resolve an exported producer's outputs through the fallback. Full design in [docs/cross-stack-references.md](../../docs/cross-stack-references.md).
