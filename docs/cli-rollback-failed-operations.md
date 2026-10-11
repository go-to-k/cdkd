---
title: "cdkd rollback: failed operations"
description: "What cdkd rollback does with the resource whose operation failed mid-deploy: --revert-failed, a resource a failed create left behind, and --drop-failed."
---

# cdkd rollback: failed operations

A failed deploy has one operation that stopped partway: the one that failed.
A plain `cdkd rollback` undoes the operations that completed and leaves the
failed one alone, because cdkd cannot know how far that operation got. This
page covers the flags that act on it. It is part of
[`cdkd rollback`](cli-rollback.md).

The **rollback journal** used throughout is the file beside `state.json` that
lists what the failed deploy did, including the operation that failed.

## `--revert-failed`: revert the resource whose operation failed mid-deploy

`--revert-failed` makes the rollback act on the failed operation as well as
the completed ones.

```bash
cdkd rollback MyStack --revert-failed
```

What cdkd does depends on the kind of operation that failed:

| Failed operation | With `--revert-failed` |
| --- | --- |
| Update | Forced back to the properties it had before the deploy |
| Create | The resource is deleted, following its `DeletionPolicy` |
| Delete | Nothing to do: the resource is still in place |

A create is deleted only when AWS did provision the resource. cdkd needs a
recorded physical ID and one of two proofs: a matching entry in the state
record, or evidence from the create call that it returned. The ID named in a
failed create's error message is not proof, because that ID can also be the
name of an existing resource the create collided with.

The delete of a failed create follows
[DeletionPolicy on a rolled-back CREATE](cli-rollback.md#deletionpolicy-on-a-rolled-back-create).

Once cdkd has handled a failed operation, it removes that operation from the
journal. A re-run therefore attempts only what is still outstanding.

### After an automatic rollback

`--revert-failed` also works after a deploy's automatic rollback finished
cleanly. That rollback reverts the completed operations and keeps a journal
that holds only the failed operation, so you can still revert it:

```bash
cdkd rollback MyStack --revert-failed
```

If you do not want to, a plain `cdkd rollback` clears that journal, and so
does the next successful deploy.

An automatic rollback that failed or skipped an operation keeps the whole
segment instead.

### Edge cases

- **A failed update that changed the resource's `Type`.** It is skipped with a
  warning. The update was a replacement in progress, and a replacement cannot
  be reverted in place.
- **A failed update that was a replacement, and the new resource was made.**
  The update is not forced back, because nothing was applied to the old
  resource. cdkd acts on the new resource's own journal entry instead; see
  [below](#failed-creates-that-made-their-resource).
  - If the replacement created the new resource first, the old one is
    untouched and nothing more is done.
  - If it deleted the old resource first, the rollback warns (exit `2`) that
    the resource the state record names is gone. A deploy whose template still
    replaces the resource creates it again. A deploy whose template was put
    back to the old properties sees no change and does not. `cdkd destroy`
    drops the entry.
- **A failed create with no entry left in the state record.** Nothing to do.
  It was already cleaned up.
- **A failed create whose recorded physical ID differs from the one in the
  state record.** It is skipped with a warning (exit `2`) and nothing is
  deleted. The resource the journal recorded may still exist, untracked. The
  plan line names it:
  `recorded <its physical id>, which is not the resource state tracks under this id; not reverted, needs manual attention`.
- **A failed create that recorded no physical ID.** It is skipped with a
  warning, because there is nothing to delete.
- **A failed update whose state entry has no usable `physicalId`.** It is
  skipped with a warning (exit `2`). See
  [An operation cdkd cannot address is skipped](#an-operation-cdkd-cannot-address-is-skipped).
- **AWS refuses the delete for now.** The operation stays in the journal, so
  you can run the rollback again. An RDS instance, for example, rejects a
  delete with a final snapshot while it is still `creating`; a re-run succeeds
  once the instance has settled. Pass `--skip-final-snapshot` if you would
  rather drop the data.

The exact rule for each kind of failed operation is in
[cdkd rollback internals](cli-rollback-internals.md#revert-failed-per-failed-operation).

## Failed CREATEs that made their resource

Some creates make the resource in AWS and then fail. A rollback deletes such
a resource even without `--revert-failed`.

One example is a Kinesis stream whose follow-up retention call AWS rejected.
The stream exists, but the deploy failed before cdkd wrote it to the state
record. The journal entry is the only record of the stream. So every command
that would discard the entry deals with the resource first, as
CloudFormation's rollback deletes a failed create:

| What runs next | What happens to the resource |
| --- | --- |
| The deploy's automatic rollback | Deleted, before the completed operations are reverted |
| Nothing, under `--no-rollback` | Kept; the journal keeps the entry for later |
| `cdkd rollback`, with or without `--revert-failed` | Deleted, after the checks below |
| `cdkd destroy` | Deleted first, after the same checks, before the journal is removed with the state |
| A later successful `cdkd deploy` | Deleted before the deploy removes the journal, when nothing else owns it |

Every delete in the table follows the resource's `DeletionPolicy`. The
automatic rollback skips the checks below: it runs inside the failed deploy,
over that attempt's own operations. Other failed operations in the same
journal still need `--revert-failed`.

A replacement whose new resource was made before the failure is recorded the
same way, beside the replacement's failed update, and every row above applies
to it.

> [!TIP]
> Roll the stack back before you redeploy. A redeploy that creates a resource
> with the same name gives that name a new owner. cdkd then only warns about
> the earlier resource and leaves it for you to delete.

### When cdkd deletes the resource and when it does not

cdkd deletes the resource only when it can show two things:

1. **Nothing else owns the resource.** No state record of this stack or
   another lists it, no newer journal entry covers it, and it is not a
   resource an earlier rollback kept.
2. **It is the same resource.** For a type whose physical ID is a name, the
   resource that answers to that name today must be the one the failed create
   made. cdkd compares it with an identity the failed deploy recorded, such as
   a stream's ARN and creation time or a table's `TableId`.

When cdkd shows that something else owns the resource, or that it is not the
same one, it deletes nothing. It warns with the physical ID, drops the entry,
and exits `2`. Look at the resource yourself and delete it by hand unless a
state record tracks it.

When cdkd cannot answer at all — another stack's record cannot be read, or the
live identity read gives no answer for a type that recorded one — it deletes
nothing and keeps the entry in the journal as a failed operation for a re-run.
Its failure message names `--drop-failed`, which removes only the record and leaves the
resource in AWS.

Two cases settle without a warning: a resource that a state record already
tracks (cdkd drops its entry from the journal), and one that AWS reports gone
(cdkd settles the entry with no delete and prints an info line).

### Edge cases

- **`DeletionPolicy: Retain`.** The resource stays in AWS. cdkd keeps no
  record of it, so a later deploy cannot adopt it again.
- **`DeletionPolicy: Snapshot`.** The final snapshot is taken first.
- **An S3 bucket.** The bucket is never emptied, even with
  `autoDeleteObjects`. If something wrote to it, cdkd keeps the bucket, names
  it in a warning, and leaves its entry in the journal.
- **An `AWS::SQS::QueuePolicy` or `AWS::SNS::TopicPolicy`.** cdkd clears the
  policy of each queue or topic only while that policy still matches the one
  the failed create wrote. A different policy is left in place with a warning.
  The rollback then exits `2`; `cdkd destroy` only warns.
- **The delete fails.** The entry is kept for a re-run. A deploy that
  otherwise succeeded then exits `2` (`0` with `--allow-unaddressed`), and the
  next deploy retries the delete.
- **A journal that cannot be read.** cdkd warns and removes the journal.
  Nothing it records is deleted.

The identity check for each type and the policy comparison are in
[cdkd rollback internals](cli-rollback-internals.md#failed-creates-that-made-their-resource).

## Dropping one entry cdkd cannot act on

`--drop-failed <logicalId>` removes one such entry from the journal when its
delete can never succeed. It changes nothing in AWS.

You need it when the delete fails for a cause you cannot fix, such as a secret
or KMS key you cannot read, or a policy that denies the delete. Until the
entry is gone, every `cdkd deploy` keeps exiting `2` and every `cdkd destroy`
keeps the state. Their warnings print one command for each entry whose delete
failed:

```bash
cdkd rollback MyStack --stack-region us-east-1 --drop-failed MyQueuePolicy
```

The command prints the entry and asks for confirmation. The entry shows the
physical ID and, for a queue or topic policy, the queues or topics the policy
was attached to. `--force` / `-y` skips the prompt, and without a terminal the
prompt is refused.

When you answer `y`, cdkd removes that entry from the journal and keeps every
other entry. If the entry belongs to a failed replacement, the replacement's
failed update is removed with it.

> [!WARNING]
> `--drop-failed` reverts nothing and deletes nothing in AWS. Check the
> resource by hand and delete it yourself if it should not stay. After the
> drop, no cdkd command acts on it.

### When `--drop-failed` refuses

The command changes nothing in these cases:

- **The journal holds no entry with that ID.**
- **The ID names a completed operation.** Use `--orphan` for that.
- **The ID names a failed operation of another kind**, or one that a newer
  journal entry may own. Neither blocks `cdkd deploy` or `cdkd destroy`, so
  you do not need to drop it.
- **The ID has more than one such entry.** Remove the one you mean from
  `rollback-journal.json` by hand.
- **You passed `--orphan`, `--revert-failed` or `--skip-final-snapshot` with
  it.** Run them separately.
- **The state record cannot be read.** cdkd needs it to mask the names it
  prints.

## An operation cdkd cannot address is skipped

A rollback skips an operation, with a warning and exit `2`, when the physical
ID it needs is unusable. Unusable means absent, empty, only whitespace, or not
a string. Only a `state.json` or journal that was edited by hand or cut short
has that shape.

cdkd sends nothing to AWS for that operation and leaves the resource and its
entry as they are. To fix it, repair the entry's `physicalId`
(`cdkd state show` displays it) and run `cdkd deploy` to bring the stack back
in line.

The same rule applies under `--revert-failed` and in a deploy's automatic
rollback.

### Edge cases

- **A nested stack's entry** is not skipped, because cdkd finds a nested stack
  by name. It is skipped like any other when it is recorded as managed through
  Cloud Control.
- **Adopting a kept old resource again.** One case fails instead of skipping
  (exit `1`, journal kept): a replacement kept the old resource, only the
  journal names it, and the rollback has to adopt it again. The message says
  which ID to repair the entry to. When nothing proves which resource is
  which, it tells you to check both by hand. The cases are in
  [cdkd rollback internals](cli-rollback-internals.md#an-operation-cdkd-cannot-address).

## Related

- [`cdkd rollback`](cli-rollback.md) — what a rollback reverts and how to run it
- [cdkd rollback: limitations](cli-rollback-limitations.md) — replacements, `NoEcho` values and nested stacks
- [cdkd destroy: skipped resources](cli-destroy-skipped.md#resources-only-the-rollback-journal-records) — how a destroy treats a resource only the journal records
