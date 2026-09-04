---
title: Core Concepts
description: How cdkd deploys CDK apps without CloudFormation — the pipeline, S3-based state, stack outputs, orphan vs destroy, and VPC DependsOn relaxation.
---

# Core Concepts

cdkd deploys AWS CDK applications directly via the AWS SDK and Cloud Control API, skipping CloudFormation. This page covers the concepts you need to reason about what a deploy actually does: the pipeline, state, outputs, and the two ways a resource leaves cdkd's management.

## How it works

```
┌─────────────────┐
│  Your CDK App   │  (aws-cdk-lib)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Synthesis  │  Subprocess + Cloud Assembly parser
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
│ Asset Build &   │  S3 ZIP upload / ECR image build & push
│   Publish       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Engine     │
│ - DAG Analysis  │  Dependency graph construction
│ - Diff Calc     │  Compare with existing resources
│ - Parallel Exec │  Dispatch on deps complete (no level barrier)
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│  SDK   │ │ Cloud  │
│Provider│ │Control │  Fallback for many
│        │ │  API   │  additional types
└────────┘ └────────┘
```

Your CDK app synthesizes to an ordinary CloudFormation template — cdkd requires zero CDK code changes. cdkd then builds and publishes assets, analyzes the template's dependency graph, diffs it against the current state, and executes the plan in parallel, dispatching each resource the moment its dependencies complete. Each resource is provisioned by a hand-written SDK Provider where one exists, with Cloud Control API as the fallback for many additional types.

For a deeper look at each layer and a step-by-step walkthrough of the full `cdkd deploy` pipeline (CLI parsing, synthesis, asset publishing, per-stack deploy), see [Architecture](architecture.md).

## State Management

State is stored in S3 with optimistic locking via S3 Conditional Writes
(no DynamoDB required). Keys are scoped by `(stackName, region)` so the
same stack deployed to two regions has two independent state files.

**You do not create this bucket yourself** — `cdkd bootstrap` creates it once
per account (see [`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap)), with
versioning, AES-256 encryption, and a deny-external-access bucket policy. The
settings below are only for pointing cdkd at a non-default name; pass that same
name to `cdkd bootstrap --state-bucket` so bootstrap creates it for you there too.

| Setting | CLI | cdk.json | Env var | Default |
|---------|-----|----------|---------|---------|
| Bucket | `--state-bucket` | `context.cdkd.stateBucket` | `CDKD_STATE_BUCKET` | `cdkd-state-{accountId}` (legacy `cdkd-state-{accountId}-{region}` is still read with a deprecation warning — run `cdkd state migrate` to consolidate) |
| Prefix | `--state-prefix` | - | - | `cdkd` |

The state bucket is shared across all CDK apps in the same account by
default. To isolate apps, pass different `--state-prefix` values.
`cdkd destroy --all` only targets stacks from the current CDK app
(determined by synthesis), not all stacks in the bucket.

See **[State Management](state-management.md)** for the full
spec: S3 key layout, optimistic-locking mechanism (ETag-based), state
schema, legacy `version: 1` migration, bucket-name migration via
`cdkd state migrate`, and troubleshooting.

## Where to go next

- [Stack Outputs](stack-outputs.md) — how `CfnOutput` values are resolved and stored
- [Orphan vs Destroy](orphan-vs-destroy.md) — the two ways a resource leaves cdkd's management
- [Wait Modes](wait-modes.md) — choose what "done" means per deploy
- [CLI Reference](cli-reference.md) — every flag, including the
  [VPC route DependsOn relaxation](cli-deploy-tuning.md#vpc-route-dependson-relaxation-default-on)
