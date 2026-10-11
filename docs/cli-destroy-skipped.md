---
title: "cdkd destroy: skipped resources"
description: "What it means when cdkd destroy reports a skipped resource, each cause, and how to finish the destroy."
---

# cdkd destroy: skipped resources

A skipped resource is one that cdkd could not confirm it deleted. The resource
may still exist in AWS and may still cost money. cdkd keeps its entry in the
state record, because without that entry you would have neither a deleted
resource nor an ID to delete it with. The destroy exits `2`.

```text
⚠ Stack MyStack partially destroyed (4 deleted, 1 skipped, 0 errors). cdkd did not confirm the skipped resource(s) were deleted, so they may still exist in AWS. ...
```

Each skipped resource prints a `skipped (...)` line that names the cause, and
a warning that says what survived and how to repair it. The summary names the
state file to open.

A skip is different from a failed delete. Running the destroy again retries a
failed delete. A skipped resource is skipped again until you fix its cause,
which is what this page covers. It is part of
[cdkd destroy](cli-destroy.md).

## Custom resources

A custom resource is deleted by sending a `Delete` request to its handler, a
Lambda function. When cdkd cannot confirm that the handler did its work, it
skips the resource. These are the skips most stacks can meet.

In all three cases below cdkd found the resource correctly, so nothing in the
state record needs repair.

### `Delete handler reported FAILED — resource unproven`

The handler ran and refused the delete. Tear down by hand whatever the handler
manages, then drop the stack's record:

```bash
# drop the record, touch nothing in AWS
cdkd state orphan MyStack --stack-region us-east-1
```

### `Delete request to the handler did not complete — resource unproven`

cdkd could not complete the call to the handler. Do the same: tear down what
the handler manages, then drop the record.

### `backing Lambda function is gone — Delete handler not invoked`

The Lambda function named by the resource's recorded `ServiceToken` no longer
exists, so nothing can receive the `Delete` request. You have two options:

- Redeploy a function at that exact ARN and run the destroy again.
- Confirm that what the handler managed is gone, then drop the record with
  the command above.

You usually see this line on the second run after one of the first two. The
same destroy that skipped the custom resource normally deleted the handler's
Lambda function too, so a second destroy does not retry the handler. It finds
the function gone.

You also see it when a shared provider stack was destroyed before the stacks
that use it.

CloudFormation behaves the same way: a custom resource whose delete cannot be
confirmed leaves the stack `DELETE_FAILED` until you retry with
`RetainResources`.

## A state record cdkd cannot address

Each entry in the state record says which AWS resource it stands for. When an
entry no longer says that, cdkd sends no AWS call for it and skips it. Most
causes are a state record that was edited by hand or cut short. One is a value
that cdkd stores masked on purpose.

Look at the entry with `cdkd state show MyStack`. For most causes the fix is
to repair the entry in `state.json` and run the destroy again.

| The `skipped (...)` line or warning says | Fix |
| --- | --- |
| `state record has no physical id` | Repair the entry's `physicalId` |
| A composite `physicalId` does not decode | Repair it to the format the warning names |
| A property the delete needs is missing | Repair the property |
| A principal list is not a list of IAM names | Repair the list |
| A property is stored as `***` or as a secret reference | Delete the resource by hand, then drop the entry |
| A nested stack's own destroy skipped a resource or was interrupted | Repair the nested stack's record |

More on each row:

- **No physical ID.** The `physicalId` is missing, empty or not a string.
- **A composite `physicalId`.** This applies to `AWS::Glue::Table`,
  `AWS::AppSync::{DataSource,Resolver,ApiKey}` and
  `AWS::EC2::NetworkAclEntry`, whose ID is built from several parts.
- **A missing property.** Examples are a Lambda permission's `FunctionName`,
  a custom resource's `ServiceToken`, an IAM policy's principals, and the
  `GroupName` or `Users` of a `UserToGroupAddition`.
- **A principal list.** A list that holds a `{{resolve:...}}` reference is not
  skipped. cdkd resolves the reference during the destroy.
- **`***` or a secret reference.** cdkd stores a secret as the mask `***` or
  as its `{{resolve:...}}` expression, and neither names anything in AWS.
  Repairing does not help here, because a redeploy records the same thing
  again.
- **A nested stack.** Its record is named `<parent>~<childLogicalId>`, and
  the summary names it.

### When the parent resource is deleted in the same destroy

Some skipped resources belong to a parent in the same stack: a permission to
its Lambda function, an inline policy to its IAM role, group or user. Deleting
the parent removes them too. AWS then ends clean, and only cdkd's entry is out
of date. The warning says so, and `cdkd state orphan '<stack>'` clears the
entry.

### Dropping one entry

To drop one resource's entry and keep the rest of the stack's record:

```bash
# with the CDK app
cdkd orphan 'MyStack/Handler/Permission'

# without it
cdkd state orphan MyStack --stack-region us-east-1 \
  --resource HandlerPermissionABC123
```

Every shape of damaged entry, what survives in each case, and how a principal
list built from a secret is resolved are in
[cdkd destroy internals](cli-destroy-internals.md#every-cause-of-a-skip).

## Resources only the rollback journal records

A failed deploy can leave a resource that is not in the state record. A
destroy deletes such a resource too, before the stack's other resources.

This happens when a create call succeeded and the deploy then failed on that
same resource. One example is a Kinesis stream whose follow-up retention call
AWS rejected. The stream exists, but cdkd never wrote it to the state record.
Its only record is the **rollback journal**: a file beside `state.json` that
lists what the failed deploy did. Destroying the stack removes the journal, so
the destroy has to deal with the resource first.

The journal is still there when the deploy ran with `--no-rollback`, or when
the journal outlived the rollback. Both `cdkd destroy` and
`cdkd state destroy` then do the following:

1. **List the resource before the prompt**, with its physical ID. This also
   happens on a `--yes` / `--force` run, and when a nested stack is destroyed
   with its parent. The prompt counts the resource.
2. **Read the journal again once the stack is locked.** If the journal changed
   or can no longer be read, cdkd refuses the run before it deletes anything.
3. **Delete the resource before the stack's other resources**, following the
   `DeletionPolicy` the journal recorded. `Retain` keeps the resource.
   `Snapshot` takes the final snapshot, unless you passed
   `--skip-final-snapshot`.

A stack that has only such resources left is not empty, so cdkd still asks
for confirmation.

### Edge cases

- **The resource may belong to something else.** cdkd warns and leaves the
  resource alone when the state record, a later deploy or a record of a
  resource a rollback kept may own it.
- **The delete fails.** The summary counts it separately. cdkd keeps the state
  record and the journal, so run the destroy again.
- **The delete can never succeed.** Check the resource by hand, then drop that
  one journal entry with the command the warning prints:

  ```bash
  cdkd rollback MyStack --drop-failed MyStream
  ```

  See [dropping one entry](cli-rollback-failed-operations.md#dropping-one-entry-cdkd-cannot-act-on).
- **The journal cannot be read at the start.** cdkd warns, removes the journal
  with the state, and deletes nothing the journal records.
- **A record whose region disagrees with its location.** A state record whose
  own `region` field differs from the region in its S3 key is refused when its
  journal holds such a resource, as it is when the record lists resources.

How a rollback treats the same resource is in
[Failed CREATEs that made their resource](cli-rollback-failed-operations.md#failed-creates-that-made-their-resource).

## `N unverified` on the summary line

`N unverified` does not mean a resource was left behind. Those resources were
deleted and their entries removed. The figure counts safety checks that ran
before the delete, could not reach an answer, and were therefore not enforced.

It does not change the exit code. A destroy that shows `1 unverified` and
`0 errors` exits `0`.

Treat the figure as unconfirmed and not as harmless, because a check can be
made to fail by denying the permission it needs. A warning under the summary
names the resources. A `RESOURCE_GUARD_INDETERMINATE` event records each one;
see [Deployment Events](deployment-events.md).

## A nested stack whose child failed is an error

When a resource inside a nested stack fails to delete, the destroy reports an
error and not a skip. The nested stack is one resource of its parent, and that
resource fails like any other failed delete:

```text
✗ Failed to delete Child: Nested stack MyStack~Child failed to destroy: 1 resource(s) failed to delete.
  The child's state is PRESERVED and still lists them — inspect it with 'cdkd state show MyStack~Child',
  resolve the failure, and re-run the destroy. ...

⚠ Stack MyStack partially destroyed (2 deleted, 1 errors). State preserved ...   # exit 2
```

The command the summary prints targets the child's state file
(`cdkd state orphan '<parent>~<child>'`), because the failed resource lives in
the child. Do not orphan the parent instead: that would drop the entry that
keeps the child reachable.

A run with both errors and skips prints each remedy separately.

`cdkd deploy` is affected too. Removing a nested stack from your template
makes the deploy delete it. If a resource in the nested stack then fails to
delete, the deploy fails and the resources deployed beside it roll back.
Check that a nested stack destroys cleanly before you remove it from the
template.

## Skips during `cdkd deploy`

`cdkd deploy` deletes resources too: the ones you removed from the template,
and the old copy of a resource it replaced. The same skip can happen there.

A deploy with a skip exits `2`, because it did not apply the template it was
given. cdkd keeps the entry, so the next deploy tries the delete again. Pass
`--allow-unaddressed` to get exit `0` if you accept that; see
[`--allow-unaddressed` (deploy)](cli-deploy-safety-ci-flags.md#allow-unaddressed-deploy).

What the deploy does depends on which delete was skipped:

- **A resource removed from the template.** The deploy warns, keeps the entry
  and counts it under `Skipped (not deleted)`.
- **The old resource of a replacement** (`--replace`, `--recreate-via-*`, or
  an update AWS cannot apply in place). The resource fails. Otherwise the new
  resource would run beside a live old one, or collide with its name.
- **The cleanup delete after a replacement that created the new resource
  first.** The deploy warns. The old resource is no longer tracked; delete it
  by hand.
- **A delete made by a rollback**, automatic or `cdkd rollback`. It counts as
  a failure, so the rollback journal is kept and running `cdkd rollback` again
  retries it.

### Edge cases

- **A rollback that already re-created the old resource.** When a rollback
  reverses a replacement, it re-creates the old resource and then deletes the
  new one. A skip of that last delete only warns, because the revert itself
  succeeded. The new resource is left untracked for you to delete by hand.
- **A custom resource whose Lambda function is gone.** On a deploy cdkd drops
  the entry with a warning. CloudFormation likewise ignores delete failures in
  the cleanup phase of an update.

## Related

- [cdkd destroy](cli-destroy.md) — the command, its options and what can stop it
- [cdkd destroy: interruption and damaged state](cli-destroy-edge-cases.md) — a record cdkd refuses before it starts
- [Orphan vs Destroy](orphan-vs-destroy.md) — dropping a record without deleting the resource
- [`cdkd rollback`](cli-rollback.md) — the rollback journal and what replays it
