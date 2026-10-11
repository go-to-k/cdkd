---
title: cdkd rollback
description: "Revert a stack to its pre-deploy state after a failed or interrupted cdkd deploy, and what the rollback cannot undo."
---

# cdkd rollback

`cdkd rollback [STACK]` puts a stack back the way it was before a deploy that
failed and was not rolled back. That is a deploy that failed under
`--no-rollback`, one you interrupted with {kbd:ctrl+c}, or one whose automatic
rollback stopped partway. It is the cdkd equivalent of `cdk rollback` and
CloudFormation's `RollbackStack`.

```bash
# roll back one stack
cdkd rollback MyStack

# the single journaled stack, if there is exactly one
cdkd rollback

# skip the confirmation prompt
cdkd rollback MyStack --force

# leave a resource out of the replay
cdkd rollback MyStack --orphan MyBucket

# also revert the resource that failed mid-deploy
cdkd rollback MyStack --revert-failed

# DeletionPolicy: Snapshot -> delete without the snapshot
cdkd rollback MyStack --skip-final-snapshot

# also delete protected resources the failed deploy left
cdkd rollback MyStack --remove-protection

# disambiguate a multi-region stack
cdkd rollback MyStack --stack-region us-west-2

# forget one failed CREATE cdkd can never delete
cdkd rollback MyStack --drop-failed MyQueuePolicy
```

Rolling back is one of three ways out of a failed deploy. The other two are
to fix the cause and run `cdkd deploy` again, or to remove the stack with
`cdkd destroy`. [Rollback](rollback.md) explains how automatic and manual
rollback fit together.

## What a rollback reverts

A deploy that ends without a completed rollback leaves a **rollback journal**:
a file beside the stack's `state.json` that lists every operation the deploy
completed. `cdkd rollback` reads that journal and undoes the operations,
newest first.

The rollback needs no CDK app, because it works from the journal and the
state record. That matters when a broken app is the reason you are rolling
back.

```text diagram=rollback-replay
A deploy fails and is not rolled back
  (--no-rollback, Ctrl-C, or an automatic rollback that died partway)
        |
        v
Rollback journal: every operation the deploy completed
        |
        v
cdkd rollback replays it, newest first
        |
        +--> Reverted                      +--> Left as it is
             Created:  deleted                  Deleted: cannot be restored
             Updated:  old properties           The operation that failed,
             Replaced: old one re-created,        unless --revert-failed
                       new one deleted          Anything named by --orphan
```

| The failed deploy | The rollback |
| --- | --- |
| Created a resource | Deletes it |
| Updated a resource | Restores its previous properties |
| Replaced a resource | Re-creates the old one and deletes the new one |
| Deleted a resource | Does nothing |
| Failed on a resource | Leaves that resource as it is |

Four of these rows have more to them:

- **Created.** The delete follows the resource's `DeletionPolicy`, so a
  `Retain` resource stays in AWS. See
  [DeletionPolicy on a rolled-back CREATE](#deletionpolicy-on-a-rolled-back-create).
- **Replaced.** The old resource comes back empty. Its data is not recovered.
  See [Reversing a replacement](cli-rollback-limitations.md#reversing-a-replacement).
- **Deleted.** A deleted resource cannot be restored, as under CloudFormation.
  A deploy runs its deletes after its creates and updates, so a typical
  mid-deploy failure has not deleted anything yet.
- **Failed.** The operation stopped partway, so cdkd does not know what state
  the resource is in. Pass
  [`--revert-failed`](cli-rollback-failed-operations.md#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy)
  to revert it as well.

## Run a rollback

```bash
cdkd rollback MyStack
```

The command prints a plan of what it will do and waits for your answer. Read
the plan before you confirm: it shows each limitation that applies to this
rollback. Nothing has changed in AWS until you answer yes.

In order, the command does the following:

1. **Finds the stack.** With no stack argument, cdkd looks for stacks that
   have a journal. If there is exactly one, it uses that stack. If there are
   several, it lists them for you to pick from. If there are none, it prints
   "nothing to roll back".
2. **Locks the stack** for the whole rollback. If a deploy holds the lock, the
   command fails with the usual lock error.
3. **Prints the plan.** The journal holds one segment for each failed deploy
   attempt. The plan has one block per segment, newest first.
4. **Asks for confirmation.** `--force` or `-y` skips the prompt.
5. **Undoes the segments**, newest first. cdkd saves the state record after
   each operation and removes a segment from the journal once the segment
   finishes cleanly.

You can run the command again after a partial rollback. It skips what is
already reverted.

The journal is stored at
`s3://<bucket>/<prefix>/<stack>/<region>/rollback-journal.json`, next to
`state.json`.

### Edge cases

- **The stack's first deploy.** If the oldest segment was the stack's first
  deploy and the state record is empty after the rollback, cdkd deletes
  `state.json` too. `cdkd list` then no longer shows the stack.
- **A record in the wrong region.** A state record whose own `region` field
  disagrees with the region of its S3 key is refused while it still lists
  resources. See [State Management](state-management.md).
- **An unusual stack name or region.** A name that is not a plain identifier
  is possible only with a hand-written state key. The plan and the prompt
  describe it instead of printing it, and point you at
  `cdkd state list --long`.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to roll back. Omit it when exactly one stack has a rollback journal. |
| `--force` | off | Skip the confirmation prompt. `-y` / `--yes` does the same. |
| `--orphan <logicalId>` | — | Skip the resource during replay, like `cdk rollback --orphan`. Repeatable. |
| `--revert-failed` | off | Also attempt to revert the resource whose operation failed mid-deploy. |
| `--drop-failed <logicalId>` | — | Remove one failed CREATE from the journal after you checked its resource by hand. |
| `--skip-final-snapshot` | off | Delete a rolled-back CREATE whose `DeletionPolicy` is `Snapshot` without the final snapshot (data loss). |
| `--remove-protection` | off | Turn deletion protection off before the rollback deletes a resource the failed deploy left. |
| `--stack-region <region>` | — | Region of the target stack, when the same name has state in more than one. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records and the journal. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

`--revert-failed` and `--drop-failed` are described in
[cdkd rollback: failed operations](cli-rollback-failed-operations.md).

### `--orphan`

`--orphan <logicalId>` tells the rollback to leave one resource alone. What
that means depends on what the deploy did to the resource:

- A resource the deploy created stays in AWS, and cdkd removes it from the
  state record.
- A resource the deploy updated keeps its new properties, and the state record
  is kept as it is.

### `--remove-protection`

`--remove-protection` turns deletion protection off on a resource before the
rollback deletes it. It covers the same types as
[`cdkd destroy --remove-protection`](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy).

The flag applies to a resource the failed deploy finished creating. It also
applies to a resource that a failed create left behind, when cdkd can prove it
is that resource and no other stack holds it. When the rollback deletes or
reverts a nested stack, the flag applies to that nested stack's own resources
too.

### `--role-arn`

The journal records the role the failed deploy ran with. If it recorded one
and you pass none, cdkd prints a note and the rollback runs with your current
credentials.

## DeletionPolicy on a rolled-back CREATE

When a rollback deletes a resource the failed deploy created, it follows that
resource's `DeletionPolicy`, as CloudFormation does. A resource you marked
`Retain` is therefore kept.

| `DeletionPolicy` | What the rollback does |
| --- | --- |
| `Retain` | Leaves the resource in AWS |
| `Snapshot` | Takes the final snapshot, then deletes |
| `RetainExceptOnCreate`, `Delete` | Deletes |
| Absent | Applies CloudFormation's default |

The plan says which of these will happen before you confirm.

- **`Retain`.** cdkd notes the kept resource in the state record, so that a
  later deploy can adopt it again. The plan labels it `orphan`.
- **`Snapshot`.** `--skip-final-snapshot` deletes without the snapshot. How
  each type is snapshotted is the same as for a destroy; see
  [final snapshots](cli-destroy-guards.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot).
- **Absent.** CloudFormation's default is `Snapshot` for an
  `AWS::RDS::DBCluster` or a standalone `AWS::RDS::DBInstance`, and a plain
  delete for everything else.

The same table applies to the delete of a CREATE that failed partway, on every
path that deletes one.

### Edge cases

- **A resource cdkd cannot snapshot.** The plan labels it
  `cdkd cannot snapshot this resource; the rollback will REFUSE it`. The
  rollback then fails that one operation and keeps the journal. See
  [When cdkd refuses to delete](cli-destroy-guards.md#when-cdkd-refuses-to-delete).

## The same stack name under another state prefix

`cdkd rollback` refuses when the state bucket also records the stack and
region under another `--state-prefix`. It refuses under the lock, before the
plan, the prompt and any replay.

A rollback deletes what the failed deploy created. When two prefixes record
one stack name, a create may have been handed the other deployment's
resource, so deleting it is not safe.

Drop the record you are not keeping with the `cdkd state orphan ...
--state-prefix <prefix>` command the refusal prints, and run the rollback
again. The answer comes from the [stack registry](state-store-registry.md).
If S3 denies access to the stack's marker, the rollback warns and falls back
to listing the bucket's prefixes.

## Known limitations

A rollback cannot undo everything. The plan shows each of these before you
confirm.

- **A deleted resource** cannot be restored.
- **The resource whose operation failed** is left as it is unless you pass
  `--revert-failed`. See
  [failed operations](cli-rollback-failed-operations.md).
- **A replaced resource** is re-created, and its data does not come back. See
  [Reversing a replacement](cli-rollback-limitations.md#reversing-a-replacement).
- **Old asset objects** must still exist. A revert that points at an old asset
  (a Lambda function's `Code.S3Key`) needs that object to still exist. The
  retention window of [`cdkd gc`](cli-gc.md) protects it.
- **A value fed by a `NoEcho` parameter** is not reverted. See
  [`NoEcho` values are not reverted](cli-rollback-limitations.md#noecho-values-are-not-reverted).
- **A nested stack** is reverted through its own journal. See
  [Nested stacks](cli-rollback-limitations.md#nested-stacks).
- **A second snapshot.** For Redshift and ElastiCache, running the rollback
  again after a snapshot succeeded and its delete failed takes a second
  snapshot, which AWS bills for. EBS volumes reuse the first one.
- **An IAM inline policy name moved between resources.** If the failed deploy
  moved a policy name between resources on one role, group or user, the
  rollback can leave that principal without the policy. The rollback warns
  when it cannot put the policy back. The next change to the resource, or
  `cdkd drift --revert`, restores it
  ([details](cli-rollback-internals.md#iam-inline-policy-names-moved-between-resources)).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Fully clean. The journal is deleted. |
| `1` | Hard error. |
| `2` | Partial. See below. |

Exit `1` covers these among others: no journal for the stack you named,
several journaled stacks and no stack argument, the lock held by another run,
a journal written by a newer cdkd, and a credentials error.

Exit `2` covers three outcomes. They differ in whether running the rollback
again helps:

- **An operation failed, or the run was interrupted.** The journal is kept, so
  run the rollback again.
- **An operation was skipped with a warning.** Its segment is removed from the
  journal, because a re-run would skip it again. A
  `ROLLBACK_RESOURCE_SKIPPED` event records it.
- **An operation was reverted but left something behind.** The segment is
  removed. A `ROLLBACK_RESOURCE_SUCCEEDED` event with a `reason` records it.

The third outcome is one of these: a new copy that
`UpdateReplacePolicy: Retain` kept, a new copy whose delete failed, or a
reversed replacement whose re-create returned the live new resource.
`cdkd events` shows the events.

### Edge cases

- **No stack has a journal.** A bare `cdkd rollback` prints "nothing to roll
  back" and exits `0`.
- **You decline the prompt.** The command exits `0`.
- **No terminal.** Reaching the prompt without a terminal is refused with
  `NON_INTERACTIVE_CONFIRM` and exit `1`. Pass `--force` or `-y`; piping `y`
  in does not work.
- **{kbd:ctrl+c} or SIGTERM.** The rollback stops after the current operation,
  keeps the journal and exits `2`.

The full cross-command table is in the [CLI Reference](cli-reference.md).

## In this section

- [cdkd rollback: failed operations](cli-rollback-failed-operations.md): what
  `--revert-failed` does, what happens to a resource a failed create left
  behind, and `--drop-failed`.
- [cdkd rollback: limitations](cli-rollback-limitations.md): reversing a
  replacement, `NoEcho` values, nested stacks, resource names, and how a
  rollback interacts with `cdkd import` and `cdkd export`.

## Related

- [Rollback](rollback.md) — how automatic and manual rollback fit together
- [Destroy flags & guards](cli-destroy.md) — the other way out of a failed deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [`cdkd gc`](cli-gc.md) — the asset retention a replay depends on
- [Troubleshooting](troubleshooting.md) — what to do when a rollback fails
- [cdkd rollback internals](cli-rollback-internals.md) — the exact ownership and ordering rules
