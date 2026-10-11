---
title: Rollback
description: "What cdkd undoes when a deploy fails, how to keep the partial stack with --no-rollback, and how to revert it later with cdkd rollback."
---

# Rollback behavior

When a resource fails partway through `cdkd deploy`, cdkd undoes what that
deploy had already done to the stack, updates the state record to match, and
exits non-zero. You do not have to ask for this. The rest of this page is for
when you want something else: keeping the half-deployed stack to inspect it,
or reverting a stack whose deploy was interrupted.

```bash
cdkd deploy MyStack                 # a failure rolls the stack back
cdkd deploy MyStack --no-rollback   # a failure leaves the partial stack in place
cdkd rollback MyStack               # revert a stack left partial, later
```

## What the automatic rollback undoes

```text diagram=guide-rollback-undo
                    A resource fails mid-deploy
          (resources the deploy did not touch are left alone)
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
  Created by this deploy                Updated by this deploy
    deleted                               set back to the properties
    Retain: left in AWS                   cdkd had recorded
    Snapshot: snapshotted, then deleted
              ▼                                     ▼
  Replaced by this deploy               Deleted by this deploy
    old resource re-created,              cannot be restored
    new one deleted                       the rollback warns and
    data in the old one is not            moves on
    recovered
```

| The deploy had | The rollback |
| --- | --- |
| Created the resource | Deletes it, in reverse dependency order |
| Created it with `DeletionPolicy: Retain` | Leaves it in AWS and records it as a rollback orphan |
| Created it with `DeletionPolicy: Snapshot` | Takes the final snapshot, then deletes it |
| Updated the resource | Sets it back to the properties cdkd had recorded |
| Replaced the resource | Re-creates the old one and deletes the new one |
| Deleted the resource | Cannot restore it; warns and moves on |
| Not touched the resource | Leaves it alone |

Three of these rows have a consequence worth knowing before you rely on them.

**An update is reverted to what cdkd recorded.** That is the resource's last
deployed template values. cdkd does not read the live resource first, so a
change someone made in the console before the deploy is not restored.

**A reversed replacement does not bring data back.** The re-created old
resource of a stateful type starts empty, and cdkd warns about it. The
exception is `UpdateReplacePolicy: Retain`: the new copy is left running and
dropped from state, and if the deploy had retained the old resource under
that policy, the old one is re-adopted with its data.

**A retained resource is re-adopted by the next deploy.** A rollback orphan
keeps its physical name, so the next deploy adopts it instead of colliding
with that name. This requires the template to still declare the resource with
the same type, to leave the physical name for cdkd to derive, and no other
cdkd stack to record the same resource. A type cdkd will not re-adopt is
reported and left for you to delete.

A nested stack the deploy updated is reverted from the record of what that
deploy did to the child stack. When that record is missing, the nested
stack's row is reported as a failed rollback operation.

## Keep the partial stack: `--no-rollback`

```bash
cdkd deploy MyStack --no-rollback
```

With `--no-rollback`, a failed deploy stops where it failed and keeps
everything it created. The state record describes that partial stack, so you
can look at what landed:

```bash
cdkd state show MyStack
```

Use it when you plan to inspect or repair the stack by hand. The default is
the safer choice for CI.

cdkd saves state after each resource completes. If cdkd itself
is killed between the failure and the rollback, the state record still
matches what is in AWS, and a later `cdkd destroy` deletes all of it.

## After a deploy that was not rolled back

A stack is left partial after a `--no-rollback` failure, a deploy interrupted
with {kbd:ctrl+c}, or an automatic rollback that itself failed partway. You
have three ways forward:

| You want | Run | Needs the CDK app |
| --- | --- | --- |
| To fix the cause and continue from where it stopped | `cdkd deploy MyStack` | Yes |
| The stack as it was before the failed deploy | `cdkd rollback MyStack` | No |
| The stack gone | `cdkd destroy MyStack` | Yes (`cdkd state destroy MyStack` does not) |

## Revert with `cdkd rollback`

```bash
cdkd rollback MyStack                  # print the plan, confirm, revert
cdkd rollback                          # the one stack that has a journal
cdkd rollback MyStack --force          # skip the confirmation prompt
cdkd rollback MyStack --orphan MyBucket   # revert everything except MyBucket
```

`cdkd rollback` works from a **rollback journal**: the list of operations the
failed deploy completed, which cdkd writes next to the stack's state record
whenever a deploy ends without a completed rollback. The command replays that
list in reverse, with the rules in the table above.

It does not synthesize, so it runs without the CDK app. A broken app is a
common reason to roll back.

The journal is deleted by the next successful deploy and by `cdkd destroy`.
A nested stack's journal is kept until the top-level stack's deploy succeeds.

### Flags you are likely to need

| Flag | Effect |
| --- | --- |
| `--force` | Skip the confirmation prompt |
| `--orphan <logicalId>` | Leave this resource out of the replay; repeatable |
| `--revert-failed` | Also revert the resource whose operation failed |
| `--skip-final-snapshot` | Delete a `DeletionPolicy: Snapshot` resource without the snapshot |
| `--stack-region <region>` | Pick the region when the stack name has state in several |

`--revert-failed` is off by default because the failed resource's state in
AWS is unknown. It also works after a clean automatic rollback, which keeps
the failed resource's journal entry for this purpose.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Fully reverted. The journal is deleted. |
| `1` | Hard error, such as no journal for the stack or the lock held by another run. |
| `2` | Partial. An operation failed, was skipped, or left a resource cdkd no longer tracks. |

After an exit `2` caused by a failed operation, the journal is kept and you
can run `cdkd rollback` again. Replay skips what is already reverted.

## What a rollback can leave behind

**A resource you imported after the failed deploy.** `cdkd import` marks the
resource on the journal, and the rollback skips the journal's operations for
it. The plan lists each as `adopted by cdkd import after this deploy`. An
operation that recorded a different resource under the same logical id is
also left alone, with a warning. Operations of a deploy that ran after the
import are reverted as usual.

**A resource a failed create made before it failed.** Only the journal
records such a resource. The automatic rollback deletes it, following its
`DeletionPolicy`. A later `cdkd rollback`, `cdkd destroy` or successful deploy
deletes it only when no other stack's state record holds it and, for a
resource identified by its name, AWS still reports the identity the failed
create recorded.

Types whose physical id AWS generates (a VPC, a security group, a load
balancer, a KMS key) need no identity check. Among name-identified types,
only a Kinesis stream, an S3 bucket, a DynamoDB table, and an RDS, DocumentDB
or Neptune cluster or instance record that identity. For any other
name-identified type (a Lambda function, an IAM role, an SQS queue), `cdkd
rollback` and `cdkd destroy` keep the resource, warn with its physical id,
and exit `2`. Delete it by hand if it is not in use.

The cases in between, and `--drop-failed` for an entry cdkd cannot act on,
are in [`cdkd rollback`](cli-rollback.md).

## Related

- [`cdkd rollback`](cli-rollback.md): every flag, the journal, the
  `DeletionPolicy` table and the known limitations
- [Destroy flags & guards](cli-destroy.md): tearing a stack down instead of
  reverting it
- [Deployment Events](deployment-events.md): reading back what a failed run
  did
