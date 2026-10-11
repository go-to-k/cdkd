---
title: Core Concepts
description: "How cdkd works: the pipeline from CDK app to AWS API calls, the state it keeps in S3, and how it decides what to change."
---

# Core Concepts

cdkd deploys a CDK app by calling AWS APIs itself instead of handing a
template to CloudFormation. This page explains the three ideas you need to
predict what a cdkd command will do: the steps of a deploy, the state cdkd
keeps, and the terms the rest of the docs use.

## How a deploy works

`cdkd deploy` turns your CDK code into a template, works out what has changed
since the last deploy, and applies only those changes through AWS APIs.

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

The stages, in order:

1. **Synthesis.** cdkd runs your CDK app the same way the AWS CDK CLI does.
   The result is an ordinary CloudFormation template for each stack, which is
   why your CDK code needs no changes.
2. **Assets.** cdkd zips Lambda code and other file assets and uploads them
   to S3. It builds container images and pushes them to ECR.
3. **Plan.** cdkd works out which resources depend on which, and compares the
   template with its state from the last deploy. Each resource comes out as a
   create, an update, a delete, or no change.
4. **Execution.** cdkd applies the plan in parallel. A resource starts as soon
   as the resources it depends on have finished, so it never waits for an
   unrelated resource.

cdkd creates each resource in one of two ways. For the most-used resource
types, cdkd has its own code, called an **SDK provider**, which calls that
service's API directly. For other types it uses the **Cloud Control API**, a
generic AWS API that can create most CloudFormation resource types.
[Provisioning Layers](provisioning-layers.md) explains how cdkd chooses, and
[Supported Resources](supported-resources.md) lists the types.

## State

State is cdkd's record of what it has deployed. CloudFormation keeps that
record inside the service. cdkd has no service behind it, so it writes the
record itself: one JSON file per stack and region, in an S3 bucket.

A trimmed state file for a stack with one bucket looks like this:

```json
{
  "stackName": "MyStack",
  "region": "us-east-1",
  "resources": {
    "AssetsBucket5CB76180": {
      "resourceType": "AWS::S3::Bucket",
      "physicalId": "mystack-assetsbucket5cb76180-x1y2z3",
      "properties": {
        "VersioningConfiguration": { "Status": "Enabled" }
      }
    }
  },
  "outputs": {}
}
```

For each resource, the file holds the name it has in the template (the
logical ID), its type, the identifier AWS gave it (the physical ID), and the
properties it was last deployed with.

Every later command starts from this file:

| Command | What it does with state |
| --- | --- |
| `cdkd diff` | Compares your template with state, and prints the changes |
| `cdkd deploy` | Makes the same comparison, then applies the changes |
| `cdkd drift` | Compares state with what is in AWS now |
| `cdkd destroy` | Reads state to learn what to delete |

State is the only record of what cdkd manages. A resource that exists in AWS
but is missing from state is invisible to cdkd. A resource that is in state
but has been deleted from AWS shows up as drift.

### Where state lives

`cdkd bootstrap` creates the state bucket once per account, so you do not
create it yourself. The bucket has versioning and AES-256 encryption turned
on, and a policy that denies access from outside the account.

The default bucket name is `cdkd-state-{accountId}`. To use another bucket,
name it in any of these places:

| Where | Setting |
| --- | --- |
| Command line | `--state-bucket <name>` |
| `cdk.json` | `context.cdkd.stateBucket` |
| Environment | `CDKD_STATE_BUCKET` |

Pass the same `--state-bucket` to `cdkd bootstrap`, so that bootstrap creates
the bucket you named.

Inside the bucket, every key starts with a prefix, `cdkd` by default.
`--state-prefix` changes it.

### One bucket serves every app in the account

cdkd finds a stack's state by the stack's name and region. This has four
consequences:

- The same stack deployed to two regions has two independent state files.
- Apps with different stack names share the bucket without any setting.
- One stack name is one deployment per account and region, as in
  CloudFormation. `--state-prefix` separates the records and not the deployed
  resources, so deploying one stack name under a second prefix or a second
  bucket is unsupported. See
  [One stack name per account and region](state-store.md#one-stack-name-per-account-and-region).
- `cdkd destroy --all` targets only the stacks of the app you run it in. It
  does not touch other apps' stacks in the same bucket.

### Locks

A lock stops two commands from changing the same stack at the same time,
which would corrupt the stack's state. A command that changes a stack takes
the lock first and releases it when it finishes.

The lock is a file in the state bucket, created with an S3 conditional write,
so cdkd needs no DynamoDB table. cdkd renews the lock while the command runs.
A lock that is no longer renewed expires after 30 minutes, so a killed
process cannot block a stack for long.
[`cdkd force-unlock`](cli-force-unlock.md) clears a lock sooner.

[State Store](state-store.md) is the guide to working with state, and
[State Management](state-management.md) is the full reference.

## Terms the docs use

- **Logical ID.** The resource's name in the template, such as
  `MyBucketF68F3FF0`. It stays the same across deploys.
- **Physical ID.** The identifier AWS gave the real resource, such as a
  bucket name or an ARN. cdkd records it in state.
- **Replacement.** A change that AWS cannot apply to an existing resource,
  so a new resource takes the old one's place.
- **Stateful resource.** A resource that holds data, such as a bucket, a
  table or a log group. Replacing one loses the data, so cdkd refuses unless
  you pass `--force-stateful-recreation`. See
  [Deploy: safety & compatibility flags](cli-deploy-safety.md#stateful-resource-guard).
- **Destroy.** Delete a stack's AWS resources and its state.
- **Orphan.** Remove a resource or a stack from state only. The AWS resources
  stay, and cdkd no longer manages them. See
  [Orphan vs Destroy](orphan-vs-destroy.md).
- **Drift.** A difference between state and what is in AWS, caused by a
  change made outside cdkd. See [Drift Detection](drift.md).
- **Rollback.** Undoing what a failed deploy did, so the stack returns to how
  it was before that deploy. See [Rollback](rollback.md).
- **Wait mode.** How long a deploy waits for a slow resource to become ready.
  See [Wait Modes](wait-modes.md).

## Where to go next

- [Getting Started](getting-started.md): install cdkd and deploy a first stack.
- [Wait Modes](wait-modes.md): choose what "done" means for slow resources.
- [Stack Outputs](stack-outputs.md): read a deployed stack's outputs back.
- [Architecture](architecture.md): the pipeline layer by layer, for contributors.
