---
title: cdkd rollback
description: "Revert a stack to its pre-deploy state after a failed or interrupted cdkd deploy, and what the rollback cannot undo."
---

# cdkd rollback

`cdkd rollback [STACK]` reverts a stack to its pre-deploy state after a deploy
that failed with `--no-rollback`, was interrupted with {kbd:ctrl+c}, or whose
automatic rollback died partway. It is the cdkd equivalent of `cdk rollback` /
CloudFormation `RollbackStack`. The other two ways out of such a failure are
fixing forward with `cdkd deploy` and cleaning up with `cdkd destroy`.

```bash
cdkd rollback MyStack                              # roll back one stack
cdkd rollback                                      # the single journaled stack, if there is exactly one
cdkd rollback MyStack --force                      # skip the confirmation prompt
cdkd rollback MyStack --orphan MyBucket            # leave a resource out of the replay
cdkd rollback MyStack --revert-failed              # also revert the resource that failed mid-deploy
cdkd rollback MyStack --skip-final-snapshot        # DeletionPolicy: Snapshot -> delete without the snapshot
cdkd rollback MyStack --remove-protection          # also delete protected resources the failed deploy left
cdkd rollback MyStack --stack-region us-west-2     # disambiguate a multi-region stack
cdkd rollback MyStack --drop-failed MyQueuePolicy  # forget one failed CREATE cdkd can never delete
```

## What a rollback reverts

A deploy that ends without a completed rollback leaves a **rollback journal**:
the list of operations it completed, stored beside the stack's state file. The
rollback replays that journal in reverse. No CDK app is needed, which matters
because a broken app is a common reason to roll back.

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
| Created a resource | Deletes it, following its [`DeletionPolicy`](#deletionpolicy-on-a-rolled-back-create) |
| Updated a resource | Restores its previous properties |
| Replaced a resource | Re-creates the old one and deletes the new one. The old resource's data is not recovered. See [Reversing a replacement](#reversing-a-replacement). |
| Deleted a resource | Nothing. A deleted resource cannot be restored, as under CloudFormation. |
| Failed on a resource | Leaves it as it is, unless you pass [`--revert-failed`](#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy) |

Deletes run after creates and updates, so a typical mid-deploy failure has not
deleted anything yet.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to roll back. Omit it when exactly one stack has a rollback journal. |
| `--force` | off | Skip the confirmation prompt. `-y` / `--yes` does the same. |
| `--orphan <logicalId>` | — | Skip the resource during replay, like `cdk rollback --orphan`. Repeatable. |
| `--revert-failed` | off | Also attempt to revert the resource whose operation failed mid-deploy. |
| `--drop-failed <logicalId>` | — | Remove one journaled failed CREATE from the journal after you check its resource by hand. See [below](#dropping-one-entry-cdkd-cannot-act-on). |
| `--skip-final-snapshot` | off | Delete a rolled-back CREATE whose `DeletionPolicy` is `Snapshot` without the final snapshot (data loss). |
| `--remove-protection` | off | Turn deletion protection off before the rollback deletes a resource the failed deploy left. |
| `--stack-region <region>` | — | Region of the target stack, when the same name has state in more than one. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records and the journal. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

- **`--orphan`** leaves an orphaned CREATE in AWS and removes it from state. An
  orphaned UPDATE stays at its new properties, with state kept as it is.
- **`--remove-protection`** covers the types
  [`cdkd destroy --remove-protection`](cli-destroy.md) covers. It applies to a
  resource state records from a completed CREATE, and to one a failed CREATE
  left behind when cdkd can prove it is that resource and no other stack holds
  it. A nested stack the rollback deletes or reverts carries the flag to its
  own resources.
- **`--role-arn`**: if the journal recorded a role for the failed deploy and
  you pass none, cdkd prints a note and the rollback runs with your ambient
  credentials.

## How a rollback runs

The journal lives at `s3://<bucket>/<prefix>/<stack>/<region>/rollback-journal.json`,
next to `state.json`.

1. Resolve the stack and region. With no stack argument cdkd looks for
   journaled stacks: exactly one is used, several are listed for you to pick
   from, and none is reported as "nothing to roll back".
2. Take the stack lock for the whole replay. If a deploy holds it, the command
   fails with the usual lock error.
3. Load the state record and the journal. A record whose own `region` field
   disagrees with the region of its key, while it still lists resources, is
   refused here ([State Management](state-management.md)).
4. Print the plan, one block per journal segment, newest first.
5. Ask for confirmation (skipped by `--force` / `-y`).
6. Replay the segments newest first, saving state after each operation and
   removing each segment once it finishes cleanly.
7. If the oldest segment was the stack's first deploy and state is now empty,
   delete `state.json` too, so `cdkd list` shows no ghost stack.

Replay is idempotent. Re-running after a partial rollback skips what is already
reverted.

A stack name or region that is not a plain identifier (possible only with a
hand-written state key) is described instead of printed in the plan and prompt,
with a pointer to `cdkd state list --long`.

### Names of re-created resources

A re-created resource gets the physical name the failed deploy would have given
it. The journal records whether that deploy ran with
[`--prefix-user-supplied-names`](cli-deploy-tuning.md), and the rollback
replays under that setting, so you do not pass the flag again.

A journal written by an older cdkd does not carry the setting. The rollback
then takes it from `CDKD_PREFIX_USER_SUPPLIED_NAMES`, then the `cdk.json` in
the current directory, then the default (no prefix), and prints a warning
saying which it chose. If the failed deploy ran with the prefix, re-run with:

```bash
CDKD_PREFIX_USER_SUPPLIED_NAMES=true cdkd rollback MyStack
```

A resource an earlier deploy created under the other setting keeps its name.
For the types the setting rewrites (IAM roles, users, groups, instance profiles
and managed policies; ELBv2 load balancers and target groups) the rollback
follows the resource's physical ID. It prints a line when that differs from the
failed deploy's setting, and a warning when neither setting produces the name.

### An operation cdkd cannot address is skipped

An operation is skipped with a warning (exit `2`) when the physical id it
needs is absent, empty, whitespace-only or not a string. Only a hand-edited or
torn `state.json` or journal has that shape. Nothing is sent to AWS, and the
resource and its record are left as they are.

Repair the record's `physicalId` (`cdkd state show` displays it) and
re-converge with `cdkd deploy`. A nested stack's record is exempt, since its
child is found by name, unless it is recorded on Cloud Control. The same
applies under `--revert-failed` and in the automatic rollback.

One case fails instead (exit `1`, journal kept): re-adopting an old resource
that a replacement retained, which only the journal names. The message says
which id to repair the record to, or tells you to check both resources by hand
when nothing proves which is which. The cases are in
[cdkd rollback internals](cli-rollback-internals.md#an-operation-cdkd-cannot-address).

## `--revert-failed`: revert the resource whose operation failed mid-deploy

By default the resource whose operation failed is left exactly as it is,
because the operation died partway and its remote state is unknown. The journal
still records that operation, and `--revert-failed` acts on it.

```bash
cdkd rollback MyStack --revert-failed
```

| Failed operation | With `--revert-failed` |
| --- | --- |
| UPDATE | Force-reverted to its pre-deploy properties |
| UPDATE that changed the resource's `Type` | Skipped with a warning. It was a replacement in flight, and there is no in-place revert of one. |
| UPDATE that was a replacement whose new resource was made | Not force-reverted, since nothing was applied to the old resource. The new resource's own entry is acted on. |
| UPDATE whose state record has no usable `physicalId` | Skipped with a warning (exit `2`). See [above](#an-operation-cdkd-cannot-address-is-skipped). |
| CREATE that recorded a physical id state still records | Deleted, following its [`DeletionPolicy`](#deletionpolicy-on-a-rolled-back-create) |
| CREATE that made its resource and then failed | Deleted, with or without the flag. See [below](#failed-creates-that-made-their-resource). |
| CREATE that recorded a physical id, with no state record left | Nothing to do. It was already cleaned up. |
| CREATE that recorded a different physical id than state now holds | Skipped with a warning (exit `2`); nothing is deleted |
| CREATE that recorded no physical id | Skipped with a warning; there is nothing to address |
| DELETE | Nothing to do. The resource is still in place. |

For the replacement row: when the replacement created the new resource first,
the old one is untouched and nothing is done. When it deleted the old resource
first, the rollback warns (exit `2`) that the resource state records is gone. A
deploy whose template still replaces it creates it again (one whose template
was reverted to the old properties sees no change and does not), and
`cdkd destroy` drops the record.

For the different-physical-id row, the resource the journal recorded may still
exist untracked. The plan line names it:
`recorded <its physical id>, which is not the resource state tracks under this id; not reverted, needs manual attention`.

Three more things hold for every row:

- **The policy is applied only to a resource AWS provisioned.** A delete needs
  a recorded physical id and either a matching state record or the provider's
  proof that its create call returned. The id a failed create's error names is
  not proof: it is also the name of a resource the create collided with.
- **A handled operation is removed from the journal immediately**, so a re-run
  attempts only what is still outstanding.
- **A refusal is recoverable.** The operation stays in the journal. An RDS
  instance rejects a final-snapshot delete while it is `creating`, for example,
  and a re-run completes once it settles. `--skip-final-snapshot` is the
  opt-out if you would rather drop the data.

`--revert-failed` also works after a clean automatic rollback. That rollback
reverts the completed operations and keeps a journal holding only the failed
operation. A plain `cdkd rollback` on such a journal clears it, and so does the
next successful deploy. An automatic rollback that failed or skipped an
operation keeps the full segment instead.

### Failed CREATEs that made their resource

Some creates make the resource and then fail, for example a Kinesis stream
whose follow-up retention call AWS rejected. That resource has no state record;
the journal entry is the only record of it. So every path that would drop the
entry acts on it first, as CloudFormation's rollback deletes a failed CREATE:

| Path | What happens to the resource |
| --- | --- |
| Automatic rollback | Deleted before the completed operations are reverted, per its `DeletionPolicy`. |
| `--no-rollback` failure | Nothing is deleted; the journal keeps the entry for a later `cdkd rollback`. |
| `cdkd rollback`, with or without `--revert-failed` | Deleted, per its `DeletionPolicy`. Other failed operations still need the flag. |
| `cdkd destroy` | Deleted first, per its `DeletionPolicy`, before the journal is removed with the state. |
| A later successful `cdkd deploy` | Deleted, per its `DeletionPolicy`, before the deploy removes the journal, when cdkd can show nothing else owns it. |

A replacement whose new resource was made before the failure is journaled the
same way, beside the replacement's failed UPDATE, and every path above acts on
it.

> [!TIP]
> Roll the stack back before you redeploy. A redeploy that re-creates the same
> name gives that name a new owner, and the earlier resource is then only
> warned about and left for you to delete.

**cdkd deletes the resource only when two things are shown.** Nothing else may
own it: no state record of this stack or another, no newer journal entry, no
rollback-orphan record. And for a type whose physical id is a name, the
resource now answering to that name must be the one the failed create made,
compared against an identity the failed deploy recorded (a stream's ARN and
creation time, a table's `TableId`).

When either cannot be shown, nothing is deleted. cdkd warns with the physical
id, drops the entry, and exits `2`. Delete the resource by hand if it is not
the one a record tracks. A resource that a state record already tracks is
dropped from the journal silently.

| Case | Behaviour |
| --- | --- |
| `DeletionPolicy: Retain` | The resource stays in AWS. It gets no rollback-orphan record, so a later deploy cannot re-adopt it. |
| `DeletionPolicy: Snapshot` | The final snapshot is taken first |
| An S3 bucket | Never emptied, even with `autoDeleteObjects`. A bucket something wrote to is kept, named in a warning, and stays in the journal. |
| An `AWS::SQS::QueuePolicy` or `AWS::SNS::TopicPolicy` | Each queue or topic is cleared only while its policy still matches the one the failed create wrote. A different policy is left, with a warning (exit `2`; `cdkd destroy` warns only). |
| The delete fails | The entry is kept for a re-run. A successful deploy then exits `2` (`--allow-unaddressed` exits `0`) and the next one retries. |
| A journal that cannot be read | Warned about and removed; nothing it records is deleted |

The per-type identity checks and the policy comparison are in
[cdkd rollback internals](cli-rollback-internals.md#failed-creates-that-made-their-resource).

### Dropping one entry cdkd cannot act on

When such a delete fails for a cause you cannot fix (a secret or KMS key you
cannot read, a policy that denies the delete), every `cdkd deploy` keeps
exiting `2` and every `cdkd destroy` keeps the state. Their warnings then
print a command per entry whose delete failed:

```bash
cdkd rollback MyStack --stack-region us-east-1 --drop-failed MyQueuePolicy
```

It prints the entry (its physical id, and for a queue or topic policy the
queues or topics it was attached to) and asks for confirmation. `--force` /
`-y` skip the prompt; without a terminal it is refused.

On `y` it removes that entry from the journal, with the failed replacement
UPDATE journaled beside it, and keeps every other entry.

> [!WARNING]
> `--drop-failed` replays nothing and deletes nothing in AWS. Check the
> resource by hand and delete it yourself if it should not stay. After the
> drop no cdkd command acts on it.

It refuses, changing nothing, in these cases:

| Refused | Instead |
| --- | --- |
| An id the journal does not hold | — |
| A completed operation | Use `--orphan` |
| A failed operation of another kind, or one a newer journal entry may own | Neither blocks `cdkd deploy` or `cdkd destroy` |
| An id with more than one such entry | Remove the one you mean from `rollback-journal.json` by hand |
| `--orphan`, `--revert-failed` or `--skip-final-snapshot` beside it | Run them separately |
| A state record that cannot be read | It is what masks the printed names |

## Known limitations

The plan shows each of these before you confirm.

- A resource **deleted** during the deploy cannot be restored.
- The resource whose operation **failed** is left as it is unless you pass
  [`--revert-failed`](#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy).
  A [failed CREATE that made its resource](#failed-creates-that-made-their-resource)
  is the exception.
- A **replacement** is undone by [reversing it](#reversing-a-replacement), and
  the old resource's data does not come back.
- A revert that references old **asset objects** (a Lambda `Code.S3Key`) needs
  those objects to still exist. `cdkd gc`'s retention window protects them.
- A value fed by a **`NoEcho` parameter** is not reverted. See
  [below](#noecho-values-are-not-reverted).
- A **nested stack** is reverted through its own journal. See
  [below](#nested-stacks).
- A re-run after a snapshot succeeded but its delete failed takes a **second
  snapshot** for Redshift and ElastiCache, which you are charged for. EBS
  volumes reuse the first one.
- An **IAM inline policy name** moved between resources on one role, group or
  user in the failed deploy can leave that principal without the policy. The
  rollback warns when it cannot put it back; the next change to the resource or
  `cdkd drift --revert` restores it
  ([details](cli-rollback-internals.md#iam-inline-policy-names-moved-between-resources)).

### Reversing a replacement

A replacement is undone by re-creating the old resource from its journaled
pre-deploy state and deleting the new one.

> [!WARNING]
> For a stateful type (DynamoDB, RDS, S3 and so on) the replacement destroyed
> the old resource's data, and the rollback does not recover it: the re-created
> resource starts empty. The plan labels these items `reverse-replace`. Under
> `UpdateReplacePolicy: Retain` the old resource was kept, and this does not
> apply.

The order follows the deploy:

| The deploy | The rollback |
| --- | --- |
| Created the new resource, then deleted the old one | Re-creates the old one first, then deletes the new one |
| Deleted the old one first (`--recreate-via-*`, `--replace`'s delete-first path, a rejected-update fallback) | Deletes the new one first, then re-creates the old one |
| Kept the old one under `UpdateReplacePolicy: Retain` | Re-adopts the old resource; nothing is re-created |

On the delete-first order, a failed delete leaves state naming the new resource
and keeps the journal. If the re-create then fails, the resource is absent and
the message says so; re-deploy to fix it forward.

**A name collision.** On the create-first order the old resource's name may
still be held by the new one. cdkd deletes the new resource first only when it
can show the new resource is what holds the name. A collision with anything
else, or one cdkd cannot attribute, fails the operation: nothing is deleted,
the message names the colliding name, and the journal is kept. Then either:

- remove or rename whatever holds the name and re-run `cdkd rollback`;
- if the holder is the new resource itself, delete it by hand and re-run; or
- pass `--orphan <logicalId>` to leave that resource alone.

**`UpdateReplacePolicy: Retain` also protects the new resource.** If the
resource the replacement created declares it, the rollback does not delete that
copy. It is left running and dropped from state, the run warns and exits `2`,
and `cdkd events` records its physical id. This matches CloudFormation, which
reports `DELETE_SKIPPED` for the new copy. Only `UpdateReplacePolicy` has this
effect; `DeletionPolicy` does not.

So when the deploy retained the old resource, both copies survive the rollback
and state names the old one. If the old resource has to be re-created and its
name is held by a retained new resource, the operation fails with the journal
kept. Delete the new resource yourself, or drop `UpdateReplacePolicy: Retain`,
then re-run.

**Type changes.** A replacement that changed the resource's `Type` is reversed
through both types, and the plan shows the pair as `from NEW to OLD`. An
operation whose old type the journal cannot name is shown as `(REFUSED)` and
fails on replay with the journal kept. See
[Type changes on an existing logical id](cli-deploy-safety.md#type-changes-on-an-existing-logical-id).

If the re-create fails after its provider made the resource, the rollback
deletes what it made, unless the old resource's `DeletionPolicy` is `Retain` or
`Snapshot`. A resource it keeps or cannot delete is named in a warning.

The rules for what counts as a replacement, when the order changes, and how a
name is attributed are in
[cdkd rollback internals](cli-rollback-internals.md#reversing-a-replacement).

### DeletionPolicy on a rolled-back CREATE

The delete of a rolled-back CREATE follows its `DeletionPolicy`, matching
CloudFormation:

| `DeletionPolicy` | What the rollback does |
| --- | --- |
| `Retain` | Leaves the resource in AWS and moves it into a rollback-orphan record a later deploy can re-adopt. The plan labels it `orphan`. |
| `Snapshot` | Takes the final snapshot, then deletes. A shape cdkd cannot snapshot is refused as a per-operation failure, and the journal is kept. |
| `RetainExceptOnCreate`, `Delete` | Deletes plainly. |
| absent | CloudFormation's default: `Snapshot` for an `AWS::RDS::DBCluster` or a standalone `AWS::RDS::DBInstance`, otherwise a plain delete. |

The plan says which of these will happen before you confirm. A shape cdkd
cannot snapshot is labelled
`cdkd cannot snapshot this resource; the rollback will REFUSE it`.
`--skip-final-snapshot` opts out of the snapshot; the per-type mechanism is the
one [`cdkd destroy`](cli-destroy.md) documents.

The same table governs the delete of a CREATE that failed in flight, on every
path that deletes one.

### `NoEcho` values are not reverted

A property fed by a `NoEcho` template parameter (or a `NoEcho` attribute read
through `Fn::GetAtt`) is recorded in state only as the mask `***`. A revert
reads that property back from AWS and leaves it as AWS holds it. So a `NoEcho`
value the failed deploy changed stays changed; the next `cdkd deploy` with the
old value restores it.

| Case | Result |
| --- | --- |
| The value cannot be read back (a write-only property, a type with no readback, a failed read) | The operation fails with `ROLLBACK_REDACTED_BASELINE`, sends nothing, and the journal is kept. Restore the property with `cdkd deploy`. |
| Reversing a replacement | Fails the same way: there is no live resource to read the value from |
| A nested stack passing the value as a `Parameters` entry | Reverts as usual |

The value never reaches state, the events or the log in the clear, and `***`
is never sent to AWS. Two exceptions: a name or other identifier is stored as
resolved, and a value shorter than 4 characters can appear inside a longer log
line ([State Management](state-management.md)).

### Nested stacks

A nested stack row is reverted by replaying the child stack's own journal for
the same deploy run. The plan lists that replay under the row.

| Situation | Result |
| --- | --- |
| The child has no journal for the run (an older cdkd wrote it, or it was removed) | The row fails and the journal is kept |
| The child replay skipped an operation | The row is reported partial and the rollback exits `2` |
| The child's own deploy failed in that run | A plain rollback of the parent refuses. `--revert-failed` replays the child's completed operations. |
| You roll back the child directly while the parent's journal still holds the run | Refused; the message names the top-level stack to roll back |

After a parent `--revert-failed`, the child's failed resource needs its own
rollback:

```bash
cdkd rollback 'MyStack~MyNestedStack' --revert-failed
```

A plain `cdkd rollback 'MyStack~MyNestedStack'` is enough when that resource is
a failed CREATE that made its resource.

- A direct rollback of the child is also refused while the parent's journal
  cannot be read or the top-level stack is locked by a running deploy.
- A child journal whose run the parent no longer holds is listed in the plan
  and discarded after you confirm.
- Run without a stack name, `cdkd rollback` does not offer a child's journal
  separately when its parent has one.
- A secret reference that names no region (a name, where an ARN would carry
  one) is refused when a stack above reads a value from another region, and
  always in a direct rollback of the child. The operation fails and the journal
  is kept. Set the property yourself, or spell the reference as a full ARN.

## Interaction with `cdkd export`

`cdkd export` refuses, behind a confirmation, to hand a stack over to
CloudFormation while a rollback journal exists. Roll back or re-deploy first.

## Interaction with `cdkd import`

Before it writes state, `cdkd import` marks each resource it adopts on every
journal segment that holds an operation for that logical id. The rollback then
runs none of those segments' operations for that id:

| The operation recorded | The rollback | Plan line |
| --- | --- | --- |
| The resource the import adopted (same physical id and type; for a DELETE, the record it removed) | Leaves it alone | `adopted by cdkd import after this deploy, left as it is` |
| Another resource under the id (another physical id or type) | Leaves it alone, warns, exits 2 | `recorded <its physical id>, which cdkd import has since replaced under this id; not reverted, check that resource by hand` |
| A replacement (including a Type change that kept its name) whose new resource the import adopted, while the old one was kept or may have been (no verdict recorded, as on a failed operation) | Leaves it alone, warns, exits 2 | `replaced <old physical id> but kept it ...` or `... and may have kept it ...`; `not reverted, check that resource by hand` |

The mark matters for a resource with an explicit name, whose physical id is
that name. Without it, a resource re-created by hand under the same name and
then imported would match the journal's CREATE, and the rollback would delete
it.

- For a replacement, only its new resource counts as what it recorded. If the
  import put the old resource back, the replacement is left running and
  reported as in the last row.
- Failed operations follow the same table, with or without `--revert-failed`.
- A displaced operation records a `ROLLBACK_RESOURCE_SKIPPED` event. Once its
  segment is removed, the plan line, which names the physical id, is the record
  to act on.
- Completed operations of an id you pass to `--orphan` are not covered: the
  flag is honoured.
- Segments that later deploys add carry no mark and replay as usual.
- If the import cannot read or write the journal, it refuses and writes no
  state.

An import by a cdkd older than the mark wrote none. A failed CREATE whose
physical id such an import replaced is still left alone with a warning (exit
`2`), but the plan line cannot say an import caused it.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Fully clean. The journal is deleted. |
| `1` | Hard error: no journal for the named stack, several journaled stacks and no stack argument, the lock held by another run, a journal written by a newer cdkd, credentials, and so on. |
| `2` | Partial. See the cases below. |

Exit `2` covers three outcomes:

| Outcome | Journal | Recorded as |
| --- | --- | --- |
| An operation failed, or the run was interrupted | Kept, so you can re-run | — |
| An operation was skipped with a warning | Its segment is cleared, since a re-run would skip it again | A `ROLLBACK_RESOURCE_SKIPPED` event |
| An operation was reverted but left an untracked resource or was not fully reversed | Cleared | A `ROLLBACK_RESOURCE_SUCCEEDED` event carrying a `reason` |

The third row is a new copy kept by `UpdateReplacePolicy: Retain`, a new copy
whose delete failed, or a reversed replacement whose re-create returned the
live new resource. `cdkd events` shows the events.

Other cases:

- A bare `cdkd rollback` when no stack has a journal prints "nothing to roll
  back" and exits `0`.
- Declining the confirmation prompt exits `0`.
- Reaching the prompt without a terminal is refused with
  `NON_INTERACTIVE_CONFIRM` (exit `1`). Pass `--force` or `-y` instead of piping
  `y` in.
- {kbd:ctrl+c} or SIGTERM stops the replay after the current operation, leaves
  the journal in place and exits `2`.

The full cross-command table is in the [CLI Reference](cli-reference.md).

## Related

- [Rollback](rollback.md) — how automatic and manual rollback fit together
- [Destroy flags & guards](cli-destroy.md) — the other way out of a failed deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [`cdkd gc`](cli-gc.md) — the asset retention a replay depends on
- [Troubleshooting](troubleshooting.md) — what to do when a rollback fails
- [cdkd rollback internals](cli-rollback-internals.md) — the exact ownership and ordering rules
