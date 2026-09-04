---
title: cdkd rollback
description: "Revert a failed deploy to the last known-good state with cdkd rollback."
---

# cdkd rollback

`cdkd rollback [STACK]` reverts a stack to its pre-deploy state after a deploy
that failed with `--no-rollback`, was interrupted with Ctrl-C, or whose
automatic rollback died partway. It is the cdkd equivalent of `cdk rollback` /
CloudFormation `RollbackStack`, and the third option after such a failure —
next to fixing forward with `cdkd deploy` and cleaning up with `cdkd destroy`.

```bash
cdkd rollback MyStack                         # roll back one stack
cdkd rollback                                 # the single journaled stack, if there is exactly one
cdkd rollback MyStack --force                 # skip the confirmation prompt
cdkd rollback MyStack --orphan MyBucket           # leave a resource out of the replay
cdkd rollback MyStack --revert-failed         # also revert the resource that failed mid-deploy
cdkd rollback MyStack --skip-final-snapshot   # DeletionPolicy: Snapshot -> delete without the snapshot
cdkd rollback MyStack --stack-region us-west-2 # disambiguate a multi-region stack
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to roll back. Omit it when exactly one stack has a rollback journal. |
| `--force` | off | Skip the confirmation prompt. `-y` / `--yes` does the same. |
| `--orphan <logicalId>` | — | Skip the resource during replay, like `cdk rollback --orphan`. Repeatable. |
| `--revert-failed` | off | Also attempt to revert the resource whose operation FAILED mid-deploy. |
| `--skip-final-snapshot` | off | Delete a rolled-back CREATE whose `DeletionPolicy` is `Snapshot` without the final snapshot (data loss). |
| `--stack-region <region>` | — | Region of the target stack, when the same name has state in more than one. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records and the journal. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

An orphaned CREATE is left in AWS and removed from state; an orphaned UPDATE is
left at its new properties with state kept as-is.

If the journal recorded a `--role-arn` for the failed deploy and you do not pass
one, cdkd prints an informational note — the rollback then runs with ambient
credentials.

## Synth-free

Everything `cdkd rollback` needs lives in cdkd state plus a **rollback
journal** — the exact set of completed operations from the failed deploy,
persisted to `s3://bucket/cdkd/{stack}/{region}/rollback-journal.json` (a
sibling of `state.json`) whenever a deploy ends without a completed rollback.
The command loads that journal and replays it in reverse — deleting created
resources, restoring updated ones to their previous properties — through the
same rollback executor the in-process automatic rollback uses.

No CDK app is needed, which matters because a broken app is a common reason to
roll back in the first place.

## Flow

1. Resolve the target stack and region. With no stack argument, cdkd looks for
   journaled stacks: exactly one is used, several are listed for you to pick
   from, and none is reported as "nothing to roll back".
2. Acquire the stack lock for the whole replay. A concurrent deploy holding it
   fails the command with the standard lock error; `cdkd force-unlock` applies.
3. Load the state record and the journal.
4. Print the plan, one block per journal segment, newest first.
5. Confirm (skipped by `--force` / `-y`).
6. Replay the segments newest-first, saving state after each operation and
   popping each segment once it finishes cleanly.
7. If the oldest replayed segment was the stack's first-ever deploy and state is
   now empty, delete `state.json` too, so `cdkd list` shows no ghost stack.

Replay is idempotent: re-running after a partial rollback skips the resources
that are already reverted.

## `--revert-failed`: revert the resource whose operation failed mid-deploy

By default the resource whose operation FAILED is left exactly as it is, because
its remote state is genuinely unknown — the operation died partway. The journal
still records that operation (its pre-operation state plus the properties the
deploy attempted), and `--revert-failed` opts into acting on it:

| Failed operation | With `--revert-failed` |
| --- | --- |
| UPDATE | Force-reverted to its pre-deploy properties. The journal records the *attempted* properties, so patch-based providers generate a real undo diff. |
| CREATE that recorded a physical id | Deleted, honouring its `DeletionPolicy` — see [DeletionPolicy on a rolled-back CREATE](#deletionpolicy-on-a-rolled-back-create). |
| CREATE that recorded no physical id | Skipped with a warning; there is nothing addressable to act on. |
| DELETE | Nothing to do — the resource is still in place. |

The action only engages when AWS actually provisioned the resource: it requires
both a recorded physical id and a matching state record, so the policy is never
applied to a resource that never existed.

Each handled failed operation is stripped from its journal segment immediately.
A later failure that keeps the segment for a re-run therefore re-attempts only
what is genuinely outstanding, never a revert that already succeeded.

A refusal here is recoverable rather than final. The operation stays in the
journal, so once a half-created resource settles into a snapshot-capable state —
an RDS instance rejects a final-snapshot delete while it is `creating` — a re-run
completes it. `--skip-final-snapshot` is the opt-out if you would rather drop
the data.

After a **clean automatic** rollback the journal is settled to a failed-only
segment: the completed operations are already reverted, but the failed
resource's record is kept, so `cdkd rollback --revert-failed` works in the
default deploy flow too. A plain `cdkd rollback` on such a journal is a no-op
replay that clears it; the next successful deploy also deletes it.

## Known limitations

These are surfaced in the plan rather than applied silently.

- A resource **DELETED** during the deploy cannot be restored, the same as under
  CloudFormation. Deletes run after creates and updates, so a typical mid-deploy
  failure has not deleted anything yet.
- The resource whose operation **failed** is left as-is unless you pass
  [`--revert-failed`](#revert-failed-revert-the-resource-whose-operation-failed-mid-deploy).
- **Replacements** are reverted by reversing the replacement — see below.
- Reverts that reference old **asset objects** (a Lambda `Code.S3Key`, for
  instance) need those objects to still exist, which is what `cdkd gc`'s
  retention window protects.
- A rolled-back CREATE's **`DeletionPolicy`** governs its delete — see below.
- A re-run after a snapshot succeeded but its delete failed **re-snapshots** the
  name-keyed types (Redshift, ElastiCache), which resume only an in-flight
  snapshot. EBS volumes are reused via their `cdkd:final-snapshot-of` tag. The
  rollback replay is the flow most likely to be re-run, so expect a second
  snapshot charge on those two types.

### Reversing a replacement

A replacement is undone by reversing it: the old resource is re-CREATEd from its
journaled pre-deploy state, and the new resource is deleted. The default order is
create-first; when a user-supplied physical name is still held by the new
resource, cdkd falls back to delete-new-first with a bounded name-release retry.

Under `UpdateReplacePolicy: Retain` the orphaned old resource still exists, so it
is simply re-adopted after the new one is deleted — a true clean revert.

**Data caveat.** For a stateful type (DynamoDB, RDS, S3 and so on) the old
resource's data was destroyed by the replacement and is not recovered by the
rollback: the re-created resource starts empty. The replay warns loudly, and
the plan labels these items "reverse-replace".

### DeletionPolicy on a rolled-back CREATE

The delete of a rolled-back CREATE follows its `DeletionPolicy`, matching
CloudFormation:

| `DeletionPolicy` | What the rollback does |
| --- | --- |
| `Retain` | Leaves the resource in AWS and drops it from state. The plan labels it `orphan`. |
| `Snapshot` | Takes the final snapshot, then deletes. A shape cdkd cannot snapshot is refused as a per-operation failure, and the journal is kept. |
| `RetainExceptOnCreate`, `Delete`, absent | Deletes plainly. |

The plan preview says which of these will happen **before** you confirm. A shape
cdkd cannot snapshot on the route the delete will take is labelled
`cdkd cannot snapshot this resource; the rollback will REFUSE it` rather than
promising a final snapshot. `--skip-final-snapshot` opts out of the snapshot
entirely; the per-type mechanism and the refusal rules are the same ones
[`cdkd destroy`](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot)
documents.

The same matrix governs `--revert-failed`'s delete of a CREATE that failed
in-flight, so `Retain` does not delete what the policy says to keep and
`Snapshot` does not destroy the data un-snapshotted.

## Interaction with `cdkd export`

`cdkd export` refuses — behind a confirmation gate — to hand a stack over to
CloudFormation while a rollback journal exists. The half-deployed state is
almost certainly not what you want exported; roll back or re-deploy first.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Fully clean. The journal is deleted. |
| `1` | Hard error: no journal for the named stack, several journaled stacks and no stack argument, the lock held by another run, a journal written by a newer cdkd, credentials, and so on. |
| `2` | Partial: one or more operations failed or were skipped with a warning, or the run was interrupted. The journal is kept so you can re-run. |

A bare `cdkd rollback` on an account where **no** stack has a journal is not an
error: it prints "nothing to roll back" and exits `0`. Declining the confirmation
prompt also exits `0`; reaching that prompt on a non-interactive stdin does not —
it refuses with `NON_INTERACTIVE_CONFIRM` and exits `1`. Pass `--force` (or `-y`
/ `--yes`) instead of piping `y` in.

Ctrl-C (or SIGTERM, which is routed through the same path) stops the replay after
the current operation, leaves the journal in place and exits `2`.

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Rollback](rollback.md) — how automatic and manual rollback fit together
- [Destroy flags & guards](cli-destroy.md) — the other way out of a failed deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [`cdkd gc`](cli-gc.md) — the asset retention a replay depends on
- [Troubleshooting](troubleshooting.md) — what to do when a rollback fails
