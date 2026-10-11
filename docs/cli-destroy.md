---
title: Destroy flags & guards
description: "What cdkd destroy deletes, what it keeps or refuses to delete, how to preview it, and what is left afterwards."
---

# Destroy flags & guards

`cdkd destroy` deletes the AWS resources of a stack and then removes cdkd's
record of that stack. It asks for confirmation first. It also refuses to
delete anything that would lose data unless you opted in: a bucket that still
holds objects, a database with deletion protection on, a resource whose
`DeletionPolicy` is `Retain` or `Snapshot`.

```bash
# one stack, with a confirmation prompt
cdkd destroy MyStack

# every stack under a Stage, no prompt
cdkd destroy 'MyStage/*' --yes

# every top-level stack in the CDK app
cdkd destroy --all -f

# turn deletion protection off first
cdkd destroy MyStack --remove-protection

# skip the DeletionPolicy: Snapshot snapshots
cdkd destroy MyStack --skip-final-snapshot

# no CDK app needed, reads state only
cdkd state destroy MyStack --yes
```

cdkd decides what to delete from the stack's **state record**: the
`state.json` file in the state bucket that lists every resource cdkd deployed
for the stack. [`cdkd state destroy`](cli-state-writing.md#cdkd-state-destroy) reads
only that record, so it works without the CDK app. These pages apply to both
commands unless a section says otherwise.

## Preview what a destroy will remove

There is no `--dry-run`. Run the command without `--yes` instead: cdkd prints
every resource it would delete and waits for your answer. If you answer `n`,
cdkd has locked nothing and deleted nothing.

```text
$ cdkd destroy MyStack

Resources to be deleted (3):
  - Queue (AWS::SQS::Queue)
  - Handler (AWS::Lambda::Function)
  - Uploads (AWS::S3::Bucket)

Are you sure you want to destroy stack MyStack and delete all 3 resources? (Y/n): y
  ✓ Handler (AWS::Lambda::Function) deleted
  ✓ Queue (AWS::SQS::Queue) deleted
  ⊘ Uploads (AWS::S3::Bucket) retained — DeletionPolicy: Retain

✓ Stack MyStack destroyed (2 deleted, 1 retained, 0 errors)
```

The output above is trimmed to the lines you act on. In this run the bucket
has `DeletionPolicy: Retain`, so cdkd left it in AWS and stopped tracking it.

To see the same list without starting a destroy, run
[`cdkd state resources MyStack`](cli-state.md#cdkd-state-resources).

## What a destroy does, in order

```text diagram=destroy-flow
 Select stacks (a stack that reads another stack's outputs goes first)
   │
   ▼
 Checks that refuse before anything changes
   terminationProtection, an output another stack still imports,
   a damaged state record, no --yes on a non-interactive stdin
   │
   ▼
 List the resources and ask to confirm
   │
   ▼
 Take the stack lock, delete resources (dependents first)
   Retain    → left in AWS, record dropped
   Snapshot  → final snapshot taken, then deleted
   │
   ├─ every delete confirmed ─────▶ state.json and lock.json removed, exit 0
   │                                (event history kept unless --purge-events)
   │
   └─ a delete failed or was skipped, or Ctrl-C
                                 ─▶ state.json kept with what is left, exit 2
```

Each resource ends in one of four ways, and the summary line counts them:

| Summary line | The resource in AWS | Its entry in the state record |
| --- | --- | --- |
| `N deleted` | Gone | Removed |
| `N retained` | Kept, because of `DeletionPolicy: Retain` | Removed |
| `N skipped` | May still exist | Kept |
| `N errors` | May still exist | Kept |

A run with skipped resources or errors exits `2` and keeps `state.json`, cut
down to the resources that are left. Running the same command again continues
from there. A failed delete is retried by the re-run. A
[skipped resource](cli-destroy-skipped.md) needs its state entry repaired
first.

## What is left after a clean destroy

A destroy that exits `0` can still leave these behind:

- **Resources with `DeletionPolicy: Retain`.** The policy asks cdkd to keep
  them. cdkd no longer tracks them, so delete them in AWS when you are done.
- **Final snapshots of `DeletionPolicy: Snapshot` resources.** AWS bills for
  them. Delete them in AWS, or pass `--skip-final-snapshot` next time. See
  [final snapshots](cli-destroy-guards.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot).
- **The stack's deployment-event history.** cdkd keeps it so you can look back
  at what happened. Remove it with
  [`--purge-events`](#purge-events-also-delete-deployment-event-history-on-destroy).
- **Resources an earlier rollback kept.** A rollback leaves a
  `DeletionPolicy: Retain` resource in AWS and notes it in the state record.
  The destroy lists these resources before the prompt and then stops tracking
  them. Delete them in AWS.
- **Stacks inside a CDK Stage, when you passed `--all`.** `--all` selects
  top-level stacks only. Use `cdkd destroy 'MyStage/*'` or `'**'`.

## What can stop a destroy

Each of these refuses or fails the destroy until you act. The linked section
says what to do.

| What stops it | What you see | Read |
| --- | --- | --- |
| No `--yes` and no terminal | `NON_INTERACTIVE_CONFIRM`, exit `1` | [Non-interactive runs](cli-destroy-prompts.md#non-interactive-runs) |
| `terminationProtection: true` on the stack | `STACK_TERMINATION_PROTECTION`, exit `2` | [`--remove-protection`](#remove-protection-bypass-deletion-protection-on-destroy) |
| Another stack imports one of its outputs | `STACK_HAS_ACTIVE_IMPORTS` | [Cross-Stack References](cross-stack-references.md) |
| A bucket or ECR repository that still holds data | That resource fails, exit `2` | [Non-empty buckets and repositories](cli-destroy-guards.md#non-empty-s3-buckets-and-ecr-repositories) |
| Deletion protection on a resource | That resource fails with the AWS error, exit `2` | [`--remove-protection`](#remove-protection-bypass-deletion-protection-on-destroy) |
| A `Snapshot` resource cdkd cannot snapshot | That resource is refused, exit `2` | [When cdkd refuses to delete](cli-destroy-guards.md#when-cdkd-refuses-to-delete) |
| A nested stack named directly | Refused, exit `2` | [Nested stacks](#nested-stacks) |
| Another `--state-prefix` records the same stack | Refused before any prompt or delete | [The same stack name under another state prefix](#the-same-stack-name-under-another-state-prefix) |
| A damaged state record | `STATE_RESOURCES_MALFORMED`, exit `1` | [A damaged state record](cli-destroy-edge-cases.md#a-damaged-state-record-refuses-the-destroy) |

For `terminationProtection`, the other way through is to set it to `false` in
your CDK code and redeploy. For an imported output, destroy the importing
stack first.

## The same stack name under another state prefix

`cdkd destroy` and `cdkd state destroy` read the stack's marker in the
[stack registry](state-store-registry.md) before any prompt or delete. They
refuse when the marker names another `--state-prefix` that holds the stack,
because that record may name the same resources.

Decide which record you are keeping, and drop the other with the command the
refusal prints. `cdkd state orphan` never deletes a resource:

```bash
cdkd state orphan MyStack --stack-region us-east-1 --state-prefix team-a
```

Then run the destroy again.

A successful destroy removes the marker with the record. A resource the
destroy keeps (`RemovalPolicy.RETAIN`) is listed in `retained.json` beside
the record's key, so the next deploy under the same prefix takes it back and
does not refuse its name. `cdkd state orphan` empties that list.

If S3 denies access to the marker, the destroy warns and falls back to
listing the bucket's prefixes.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to destroy: CDK display paths with `*` / `**`, or exact physical names. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--all` | off | Destroy every top-level stack in the CDK app (Stage stacks: `'**'`). |
| `-y`, `--yes` | off | Answer the confirmation prompts automatically. |
| `-f`, `--force` | off | Same as `--yes` on `cdkd destroy`. |
| `--remove-protection` | off | Turn deletion protection off before each delete. |
| `--skip-final-snapshot` | off | Delete `DeletionPolicy: Snapshot` resources without the final snapshot (data loss). |
| `--purge-events` | off | After a clean destroy, also delete the stack's deployment-event history. |
| `--allow-unsupported-types <types>` | — | Comma-separated resource types to attempt through Cloud Control although cdkd reports them unsupported. |
| `--resource-warn-after <duration>` | `5m` | Warn when one resource delete runs long. Repeatable, and accepts `TYPE=DURATION`. |
| `--resource-timeout <duration>` | `30m` | Abort one resource delete that runs long. Repeatable, and accepts `TYPE=DURATION`. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--verbose` | off | Verbose logging. |

The two `--resource-*` flags share their syntax with `cdkd deploy`; see
[per-resource timeout](cli-deploy-tuning.md#per-resource-timeout).

## Stack selection

You name stacks the same way as in every other command. The full pattern
syntax is in [stack selection](cli-list.md#selecting-stacks).

| You pass | It selects |
| --- | --- |
| Nothing, in an app with a single stack | That stack |
| `MyStage/Api` | The stack at that CDK display path |
| `MyStage-Api` | The stack with that exact physical CloudFormation name |
| `'MyStage/*'` | Every stack one level under `MyStage` |
| `'**'` | Every stack in the app, Stage stacks included |
| `--all` | Every top-level stack, as `cdk destroy --all` does |

When you select more than one stack, cdkd destroys a stack that reads another
stack's outputs before the stack it reads from.

`--all` does not reach into a CDK Stage. It leaves the stacks inside a Stage
running and names them in one warning line. If every stack of the app is
inside a Stage, `--all` is refused; use `'**'`.

A name that matches nothing is reported with a warning, as in the AWS CDK CLI.

Display paths and wildcards need the CDK app to synthesize. When it does not,
see [Destroying without a working CDK app](cli-destroy-edge-cases.md#destroying-without-a-working-cdk-app).

### Nested stacks

A nested stack cannot be destroyed by name. Destroy its parent, which deletes
the nested stack with it.

`cdkd destroy '<child>'` is refused because the parent would still list the
nested stack as one of its resources. The parent's next deploy would then try
to create the nested stack's resources again.

If you do want to remove only the child and leave the parent pointing at
nothing, use `cdkd state destroy '<child>'`.

### Edge cases

- **A name that belongs to another app.** A stack that is in the state bucket
  but is not a stack of this app (a nested stack, or another app's stack that
  shares the bucket) gets its own warning and is skipped. This applies when you
  pass it beside names that did match.

## Confirmation

`cdkd destroy` lists the resources and asks before it deletes anything. The
default answer is yes (`Y/n`). `--yes` / `-y` and `--force` / `-f` skip the
prompt.

```bash
cdkd destroy MyStack --yes   # CI
```

Without a terminal (a piped, redirected or CI run) cdkd cannot ask, so it
refuses with `NON_INTERACTIVE_CONFIRM` and exit `1` unless you passed `--yes`.
Piping `y` into the command does not work.

[Destroy: confirmation prompts](cli-destroy-prompts.md) covers the wording of
the prompt, what a refused run has and has not done, and the other commands
that follow the same rule. No refused prompt leaves a partial change or a held
lock behind.

## `--remove-protection`: bypass deletion protection on destroy

Without this flag, cdkd sends the delete as it is and AWS rejects it for a
resource that has deletion protection on. With the flag, cdkd turns the
protection off on each resource and then deletes it. You do not need to edit
the CDK code, redeploy, or use the console.

```bash
cdkd destroy MyStack --remove-protection
cdkd destroy --all --remove-protection -y
cdkd state destroy MyStack --remove-protection -y   # without the CDK app
```

Under this flag the prompt says how many resources will lose their protection,
and its default answer changes to no (`y/N`).

The flag turns off two kinds of protection:

- **`terminationProtection` on the stack.** cdkd logs a warning that names the
  stack and continues. `cdkd state destroy` cannot see this setting, because
  only the CDK app reports it, so the flag has nothing to do there.
- **Deletion protection on a resource** of one of the types below.

| Resource type | Protection field | Call that turns it off |
| --- | --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` | `PutLogGroupDeletionProtection` |
| `AWS::RDS::DBInstance` | `DeletionProtection` | `ModifyDBInstance` with `ApplyImmediately` |
| `AWS::RDS::DBCluster` | `DeletionProtection` | `ModifyDBCluster` with `ApplyImmediately` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` | `ModifyDBCluster` with `ApplyImmediately` (DocDB) |
| `AWS::Neptune::DBCluster` | `DeletionProtection` | `ModifyDBCluster` with `ApplyImmediately` (Neptune) |
| `AWS::Neptune::DBInstance` | `DeletionProtection` | `ModifyDBInstance` with `ApplyImmediately` (Neptune) |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` | `UpdateTable`, then a wait until `ACTIVE` |
| `AWS::DynamoDB::GlobalTable` | `DeletionProtectionEnabled` | `UpdateTable`, then a wait until `ACTIVE` |
| `AWS::EC2::Instance` | `DisableApiTermination` | `ModifyInstanceAttribute` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` | `ModifyLoadBalancerAttributes` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) | `UpdateUserPool` |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection` | `UpdateAutoScalingGroup` |
| `AWS::EMR::Cluster` | `Instances.TerminationProtected` | `SetTerminationProtection` |
| `AWS::DSQL::Cluster` | `DeletionProtectionEnabled` | Cloud Control `UpdateResource` |
| `AWS::NeptuneGraph::Graph` | `DeletionProtection` | Cloud Control `UpdateResource` |
| `AWS::SMSVOICE::ProtectConfiguration` | `DeletionProtectionEnabled` | Cloud Control `UpdateResource` |
| `AWS::VerifiedPermissions::PolicyStore` | `DeletionProtection` (`{Mode: ENABLED\|DISABLED}`) | Cloud Control `UpdateResource` |
| `AWS::EKS::Cluster` | `DeletionProtection` | Cloud Control `UpdateResource` |
| `AWS::RDS::GlobalCluster` | `DeletionProtection` | Cloud Control `UpdateResource` |
| `AWS::DocDB::GlobalCluster` | `DeletionProtection` | Cloud Control `UpdateResource` |

One flag covers every type in the table. Protection that is not in the table,
such as a CloudFront distribution or S3 bucket retention, is left on. The
table is limited to the cases where AWS offers a synchronous call that turns
the protection off.

Two rows do more than the table says:

- **An Auto Scaling group** also has `DisableApiTermination` turned off on
  each instance it launched. cdkd then deletes the group with
  `ForceDelete=true`, so AWS terminates its running instances.
- **A Cognito user pool** needs its other settings sent back with the change.
  See [Cognito user pools](cli-destroy-protection.md#cognito-user-pools).

A DocDB instance has no protection field, so only the DocDB cluster is listed.

[Destroy: deletion protection](cli-destroy-protection.md) covers what happens
when turning the protection off fails, how cdkd puts the protection back after
a failed delete, and the commands to put it back by hand.

## `--purge-events`: also delete deployment-event history on destroy

A destroy removes `state.json` and `lock.json` but keeps the stack's
deployment-event history, the log of what each deploy and destroy did. The
history lives under the stack's `deployments/` prefix in the state bucket, so
the bucket is not empty after a teardown. `--purge-events` deletes the history
too:

```bash
cdkd destroy MyStack --purge-events -y
```

The purge runs only after a clean, uninterrupted destroy of that stack. A
failed or interrupted destroy keeps its events, because you need them for the
retry. With several stacks, each cleanly destroyed stack is purged on its own.

`cdkd state destroy` does not take this flag. Use
[`cdkd events prune '<stack>' --all`](cli-events.md) instead, which also works
for a stack that is already destroyed.

### Edge cases

- **The purge fails.** cdkd logs a warning. The destroy already succeeded and
  still exits `0`.
- **{kbd:ctrl+c} after the stack was fully destroyed.** The purge still runs,
  because nothing is left to retry and the run reports success.
- **A versioned state bucket.** The purge also deletes the earlier versions
  under the stack's `deployments/` prefix, including streams an earlier delete
  left behind a delete marker. That needs `s3:ListBucketVersions` and
  `s3:DeleteObjectVersion`. Without them the destroy still succeeds and a
  warning prints first. What the purge does not reach is listed in
  [Earlier versions on the versioned state bucket](cli-events.md#earlier-versions-on-the-versioned-state-bucket).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Everything was destroyed. |
| `1` | Hard error, including a confirmation prompt refused on a non-interactive stdin. |
| `2` | Partial: resources failed or were skipped, or the run was interrupted with work left. `state.json` is preserved; re-run to finish. |
| `130` | Force-quit by {kbd:ctrl+c}. A stack lock may be left behind. See [Interrupting a destroy](cli-destroy-edge-cases.md#interrupting-a-destroy-ctrl-c-sigterm). |

The full cross-command table is in the [CLI Reference](cli-reference.md).

## In this section

- [Destroy: data guards and final snapshots](cli-destroy-guards.md): why a
  non-empty bucket or repository fails the destroy, and how
  `DeletionPolicy: Snapshot` and `--skip-final-snapshot` work.
- [Destroy: deletion protection](cli-destroy-protection.md): how
  `--remove-protection` behaves, and how to put a guard back.
- [Destroy: confirmation prompts](cli-destroy-prompts.md): the prompt, CI
  runs, and every other command that prompts before a change.
- [Destroy: skipped resources](cli-destroy-skipped.md): what `N skipped`
  means, each cause, and how to finish the destroy.
- [Destroy: interruption and damaged state](cli-destroy-edge-cases.md):
  {kbd:ctrl+c}, a state record cdkd refuses to read, and destroying without a
  working CDK app.

## Related

- [CLI Reference](cli-reference.md) — every command and the full exit-code table
- [`cdkd state`](cli-state.md) — the flags of `cdkd state destroy`, and the rest of the state command family
- [Orphan vs Destroy](orphan-vs-destroy.md) — when to drop state instead of deleting resources
- [`cdkd rollback`](cli-rollback.md) — reverting a failed or interrupted deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [Deployment Events](deployment-events.md) — the history `--purge-events` deletes
- [Troubleshooting](troubleshooting.md) — what to do when a destroy fails
