---
title: Core Concepts
description: "How cdkd works: the pipeline from CDK app to AWS API calls, the state it keeps in S3, and how it decides what to change."
---

# Core Concepts

cdkd deploys a CDK app by calling AWS APIs itself instead of handing a
template to CloudFormation. This page gives you the model you need to predict
what a command will do: the deploy pipeline, the state cdkd keeps, and the
handful of terms the rest of the docs use.

## How a deploy works

```text diagram=how-it-works
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

Each stage, in order:

1. **Synthesis.** cdkd runs your CDK app the way the AWS CDK CLI does and
   reads the result: an ordinary CloudFormation template per stack. This is
   why your CDK code needs no changes.
2. **Assets.** Lambda code and other file assets are zipped and uploaded to
   S3. Container images are built and pushed to ECR.
3. **Plan.** cdkd builds the dependency graph of the template's resources and
   compares the template with its state from the last deploy. Every resource
   comes out as a create, an update, a delete, or no change.
4. **Execution.** The plan runs in parallel. A resource starts the moment the
   resources it depends on have finished; nothing waits for an unrelated
   resource.

Each resource is created through one of two routes. Where cdkd has a provider
written for the resource type, it calls that service's SDK directly. For many
other types it falls back to the Cloud Control API.
[Provisioning Layers](provisioning-layers.md) explains how the route is chosen
and [Supported Resources](supported-resources.md) lists the types.

## State

CloudFormation remembers what a stack contains. cdkd has no service behind it,
so it writes that record itself: one JSON file per stack and region in an S3
bucket. The file holds each resource's logical id, type, physical id and the
properties it was last deployed with. Every later command starts from it:

| Command | Compares | Answers |
| --- | --- | --- |
| `cdkd diff` | your template with state | What will the next deploy change? |
| `cdkd deploy` | your template with state, then acts | |
| `cdkd drift` | state with live AWS | What changed outside cdkd? |
| `cdkd destroy` | reads state | What do I have to delete? |

Because the state is the record of what cdkd manages, a resource that is in
AWS but not in state is invisible to cdkd, and a resource that is in state but
gone from AWS shows up as drift.

### Where state lives

`cdkd bootstrap` creates the bucket once per account, with versioning,
AES-256 encryption and a policy that denies access from outside the account.
You do not create it yourself.

| Setting | CLI | cdk.json | Env var | Default |
| --- | --- | --- | --- | --- |
| Bucket | `--state-bucket` | `context.cdkd.stateBucket` | `CDKD_STATE_BUCKET` | `cdkd-state-{accountId}` |
| Prefix | `--state-prefix` | - | - | `cdkd` |

To use a bucket name of your own, pass the same `--state-bucket` to
`cdkd bootstrap` so that bootstrap creates it.

One bucket serves every CDK app in the account. State is keyed by stack name
and region, so the same stack deployed to two regions has two independent
state files, and two apps must not use the same stack name in the same region
unless you give them different `--state-prefix` values. `cdkd destroy --all`
only targets the stacks of the app you run it in, not everything in the
bucket.

### Locks

Two deploys of the same stack at once would corrupt its state, so a command
that changes a stack takes a lock on it first. The lock is an
object in the same bucket, taken with an S3 conditional write; there is no
DynamoDB table. A lock is renewed while its command runs and expires 30
minutes after it stops being renewed, so a killed process cannot block a stack
for long. [`cdkd force-unlock`](cli-force-unlock.md) clears one sooner.

[State Store](state-store.md) is the guide to working with state, and
[State Management](state-management.md) is the full reference.

## Terms the docs use

| Term | Meaning |
| --- | --- |
| Logical id | The resource's name in the template, such as `MyBucketF68F3FF0`. Stable across deploys. |
| Physical id | The identifier AWS gave the real resource, such as a bucket name or an ARN. Recorded in state. |
| Replacement | A change AWS cannot apply in place, so a new resource takes the old one's place. |
| Stateful resource | A resource that holds data, such as a bucket, table or log group. Replacing one loses the data, so cdkd refuses unless you pass `--force-stateful-recreation`. See [Deploy: safety & compatibility flags](cli-deploy-safety.md#stateful-resource-guard). |
| Destroy | Delete the AWS resources and the state record. |
| Orphan | Delete only the state record. The AWS resources stay, and cdkd no longer manages them. See [Orphan vs Destroy](orphan-vs-destroy.md). |
| Drift | A difference between state and live AWS, caused by a change made outside cdkd. See [Drift Detection](drift.md). |
| Rollback | Undoing what a failed deploy did, so the stack returns to its last good state. See [Rollback](rollback.md). |
| Wait mode | How long a deploy waits for a slow resource to become ready. See [Wait Modes](wait-modes.md). |

## Where to go next

- [Getting Started](getting-started.md): install cdkd and deploy a first stack.
- [Wait Modes](wait-modes.md): choose what "done" means for slow resources.
- [Stack Outputs](stack-outputs.md): read a deployed stack's outputs back.
- [Architecture](architecture.md): the pipeline layer by layer, for contributors.
