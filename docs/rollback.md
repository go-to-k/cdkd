---
title: Rollback
description: "What cdkd undoes when a deploy fails, how to keep the partial stack with --no-rollback, and how to revert it later with cdkd rollback."
---

# Rollback behavior

When a resource fails partway through `cdkd deploy`, cdkd undoes what that
deploy had already done to the stack and exits with a non-zero code. The
stack returns to how it was before the deploy. This is called a rollback, and
it happens without you asking for it.

For example, suppose `MyStack` is already deployed and you add a queue and a
Lambda function to it. On the next deploy the queue is created and the
function fails. cdkd deletes the new queue, leaves the rest of the stack as
it was, and reports the function's error. You fix the cause and deploy again.

The rest of this page is for when you want something else:

```bash
cdkd deploy MyStack                 # a failure rolls the stack back
cdkd deploy MyStack --no-rollback   # a failure leaves the partial stack
cdkd rollback MyStack               # roll back a partial stack later
```

## What the automatic rollback undoes

The rollback handles each resource according to what the failed deploy had
done to it. It works through them in the reverse of the order the deploy
used.

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
| Created the resource | Deletes it |
| Updated the resource | Sets it back to its previous properties |
| Replaced the resource | Re-creates the old one and deletes the new one |
| Deleted the resource | Cannot restore it; warns and moves on |
| Not touched the resource | Leaves it alone |

cdkd also updates the stack's state, its record of what is deployed, so that
state matches AWS after the rollback.

### What a rollback cannot bring back

A rollback restores the stack's resources and their configuration. Three
things are outside its reach:

- **A deleted resource.** Once the deploy has deleted a resource, the
  rollback cannot restore it. It prints a warning and continues.
- **Data in a replaced resource.** The rollback re-creates the old resource,
  but a re-created bucket, table or other data-holding resource starts empty.
  cdkd warns when this happens.
- **A change made outside cdkd.** An updated resource is set back to the
  properties cdkd recorded at the last deploy. cdkd does not read the live
  resource first. If someone edited the resource in the console before the
  failed deploy, that edit is not restored.

### Resources with a `DeletionPolicy`

A `DeletionPolicy` on a resource the failed deploy created changes how the
rollback removes it:

| `DeletionPolicy` | The rollback |
| --- | --- |
| `Delete` | Deletes the resource |
| `Snapshot` | Takes the final snapshot, then deletes the resource |
| `Retain` | Leaves the resource in AWS |

A resource with no `DeletionPolicy` is deleted. The exception is an RDS
cluster or a standalone RDS instance, which gets a final snapshot first, as
it does in CloudFormation.

A retained resource keeps its physical name, so creating it again on the next
deploy would normally fail on that name. To avoid this, cdkd records the
retained resource in state, and the next deploy takes the existing resource
back under management.

The next deploy takes the resource back only when all of these hold:

- the template still declares the resource, with the same type,
- the template leaves the physical name for cdkd to generate,
- no other cdkd stack has the same resource in its state.

For a resource type that cdkd cannot take back this way, cdkd reports the
resource and leaves it for you to delete.

### A stack that another state prefix also records

The rollback keeps a resource the failed deploy created, and does not delete
it, in one more case: the same stack is also recorded under another state
prefix, or cdkd cannot check whether it is. For a nested stack, the check is
on its `Parent~Child` record.

The reason is that a create can take over a resource that already existed
under the same generated name. That resource may belong to the other
deployment. cdkd warns, names the other prefix when it found one, and leaves
the resource in the rollback journal.
[One stack name per account and region](state-store.md#one-stack-name-per-account-and-region)
explains the rule and the fix.

### A replacement under `UpdateReplacePolicy: Retain`

When the resource declares `UpdateReplacePolicy: Retain`, the rollback
deletes nothing. The new copy is left running and removed from state. If the
deploy had kept the old resource under that policy, cdkd takes the old
resource back under management, with its data.

### Nested stacks

A nested stack that the deploy updated is rolled back from cdkd's record of
what the deploy did to the child stack. When that record is missing, cdkd
reports the nested stack as a failed rollback operation.

## Keep the partial stack: `--no-rollback`

With `--no-rollback`, a failed deploy stops where it failed and keeps
everything it created:

```bash
cdkd deploy MyStack --no-rollback
```

Use it when you want to inspect or repair the stack by hand. State describes
the partial stack, so you can see which resources were created:

```bash
cdkd state show MyStack
```

In CI, the default rollback is the safer choice.

cdkd saves state after each resource completes. So even if cdkd itself is
killed between the failure and the rollback, state still matches what is in
AWS, and a later `cdkd destroy` deletes all of it.

## After a deploy that was not rolled back

A stack is left partial in three cases: a failure under `--no-rollback`, a
deploy you interrupted with {kbd:ctrl+c}, and an automatic rollback that
itself failed partway. From there you have three ways forward:

| You want | Run | Needs the CDK app |
| --- | --- | --- |
| To fix the cause and continue | `cdkd deploy MyStack` | Yes |
| The stack as it was before the failed deploy | `cdkd rollback MyStack` | No |
| The stack gone | `cdkd destroy MyStack` | Yes |

`cdkd state destroy MyStack` also deletes the stack, and it does not need the
CDK app.

## Roll back later with `cdkd rollback`

`cdkd rollback` does for a partial stack what the automatic rollback would
have done. It prints what it is about to undo, asks you to confirm, and then
undoes it:

```bash
# print the plan, confirm, roll back
cdkd rollback MyStack

# the only stack that has a journal
cdkd rollback

# skip the confirmation prompt
cdkd rollback MyStack --force

# roll back everything except MyBucket
cdkd rollback MyStack --orphan MyBucket
```

The command works from the **rollback journal**. This is a file in the state
bucket, next to the stack's state, that lists every operation the failed
deploy completed. cdkd writes it whenever a deploy ends without a completed
rollback. `cdkd rollback` goes through the journal in reverse and applies the
rules described above.

Because the journal has everything the command needs, `cdkd rollback` does
not synthesize your app. It works even when the app no longer compiles, which
is a common reason to roll back.

The next successful deploy deletes the journal, and so does `cdkd destroy`. A
nested stack's journal is kept until the top-level stack deploys
successfully.

### Flags you are likely to need

| Flag | Effect |
| --- | --- |
| `--force` | Skip the confirmation prompt |
| `--orphan <logicalId>` | Leave this resource out of the rollback; repeatable |
| `--revert-failed` | Also roll back the resource whose operation failed |
| `--skip-final-snapshot` | Delete a `DeletionPolicy: Snapshot` resource without the snapshot |
| `--stack-region <region>` | Pick the region when the stack name has state in several |

By default the rollback skips the resource whose operation failed, because
that resource is in an unknown condition in AWS. `--revert-failed` includes
it. The flag also works after a clean automatic rollback, because cdkd keeps
the failed resource's journal entry for this purpose.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Fully rolled back. The journal is deleted. |
| `1` | The command could not run, for example no journal exists or another run holds the lock. |
| `2` | Partly rolled back. An operation failed or was skipped, or a resource was left that cdkd no longer tracks. |

After an exit `2` caused by a failed operation, cdkd keeps the journal. Run
`cdkd rollback` again, and it skips what is already rolled back.

## Edge cases

### A resource you imported after the failed deploy

If you run `cdkd import` on a resource after the failed deploy, the rollback
leaves that resource alone. `cdkd import` marks the resource in the journal,
and the rollback skips the journal's operations for it. The plan lists each
skipped operation as `adopted by cdkd import after this deploy`.

The rollback also leaves an operation alone, with a warning, when the journal
recorded a different resource under the same logical ID. Operations of a
deploy that ran after the import are rolled back as usual.

### A failed create that still made its resource

A create call can fail after AWS has already made the resource. Such a
resource is not in the stack's state, and only the journal lists it.

The automatic rollback deletes it, following its `DeletionPolicy`. The one
exception is a stack that
[another state prefix also records](#a-stack-that-another-state-prefix-also-records).

When the automatic rollback did not run, a later `cdkd rollback`,
`cdkd destroy` or successful deploy deletes it instead, but only when cdkd
can tell that the resource in AWS is the one the failed create made. That
requires two things:

- no other stack's state holds the resource,
- for a resource identified by a name you can choose, AWS still reports the
  identity that the failed create recorded.

The second check depends on the resource type:

| Resource type | What happens |
| --- | --- |
| The ID is generated by AWS: a VPC, a security group, a load balancer, a KMS key | No identity check is needed; the resource is deleted |
| Kinesis stream, S3 bucket, DynamoDB table, and an RDS, DocumentDB or Neptune cluster or instance | cdkd recorded the identity, checks it, then deletes the resource |
| Any other type identified by name: a Lambda function, an IAM role, an SQS queue | cdkd keeps the resource |

When cdkd keeps the resource, `cdkd rollback` and `cdkd destroy` print a
warning with its physical ID and exit `2`. Delete the resource by hand if
nothing uses it.

[`cdkd rollback`](cli-rollback.md) covers the remaining cases, and
`--drop-failed` for a journal entry cdkd cannot act on.

## Related

- [`cdkd rollback`](cli-rollback.md): every flag, the journal, the
  `DeletionPolicy` table and the known limitations
- [Destroy flags & guards](cli-destroy.md): tearing a stack down instead of
  rolling it back
- [Deployment Events](deployment-events.md): reading back what a failed run
  did
