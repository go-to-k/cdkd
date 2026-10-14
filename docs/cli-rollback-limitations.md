---
title: "cdkd rollback: limitations"
description: "What cdkd rollback cannot fully undo: a replaced resource's data, NoEcho values, nested stacks, resource names, and stacks touched by cdkd import or export."
---

# cdkd rollback: limitations

A rollback puts resources back, but some changes cannot be undone completely.
This page covers the cases that need explaining. The short list of every
limitation is on [`cdkd rollback`](cli-rollback.md#known-limitations), and the
plan that `cdkd rollback` prints shows which ones apply before you confirm.

## Reversing a replacement

When the failed deploy replaced a resource, the rollback re-creates the old
resource from the properties the journal saved and deletes the new one. The
plan labels such an operation `reverse-replace`.

> [!WARNING]
> For a type that holds data (DynamoDB, RDS, S3 and so on), the replacement
> destroyed the old resource's data. The rollback does not recover it: the
> re-created resource starts empty. This does not apply under
> `UpdateReplacePolicy: Retain`, where the old resource was kept.

The rollback works in the same order the deploy did:

| The deploy | The rollback |
| --- | --- |
| Created the new resource, then deleted the old one | Re-creates the old one, then deletes the new one |
| Deleted the old one first | Deletes the new one, then re-creates the old one |
| Kept the old one (`UpdateReplacePolicy: Retain`) | Adopts the old one again; re-creates nothing |

A deploy deletes the old resource first under `--recreate-via-*`, on the
delete-first path of `--replace`, and when it falls back to a replacement
after AWS rejected an update.

### When the old name is still taken

If the deploy created the new resource first, the old resource's name may
still be held by the new one when the rollback tries to re-create the old
one.

cdkd deletes the new resource first in that case, but only when it can show
that the new resource is what holds the name. If something else holds the
name, or cdkd cannot tell, the operation fails. Nothing is deleted, the
message gives the name, and the journal is kept. Then do one of these:

- Remove or rename whatever holds the name, and run `cdkd rollback` again.
- If the new resource itself holds the name, delete it by hand and run
  `cdkd rollback` again.
- Pass `--orphan <logicalId>` to leave that resource alone.

### `UpdateReplacePolicy: Retain` also protects the new resource

If the resource the replacement created declares
`UpdateReplacePolicy: Retain`, the rollback does not delete that new copy. The
copy keeps running and is removed from the state record. The rollback warns
and exits `2`, and `cdkd events` records the copy's physical ID.

CloudFormation does the same and reports `DELETE_SKIPPED` for the new copy.
Only `UpdateReplacePolicy` has this effect; `DeletionPolicy` does not.

So when the deploy kept the old resource, both copies survive the rollback,
and the state record names the old one.

One combination fails: the old resource has to be re-created, and its name is
held by a new resource that is retained. The operation fails and the journal
is kept. Delete the new resource yourself, or remove
`UpdateReplacePolicy: Retain`, then run the rollback again.

### Edge cases

- **A failed delete on the delete-first order.** The state record keeps naming
  the new resource, and the journal is kept.
- **A failed re-create on the delete-first order.** The resource is then
  absent, and the message says so. Run `cdkd deploy` to fix it forward.
- **A re-create that fails after it made the resource.** The rollback deletes
  what the re-create made, unless the old resource's `DeletionPolicy` is
  `Retain` or `Snapshot`. A resource it keeps or cannot delete is named in a
  warning.
- **A replacement that changed the resource's `Type`.** The rollback reverses
  it through both types, and the plan shows the pair as `from NEW to OLD`. If
  the journal cannot name the old type, the plan shows the operation as
  `(REFUSED)`, and it fails during the rollback with the journal kept. See
  [Type changes on an existing logical id](cli-deploy-safety-replacement.md#type-changes-on-an-existing-logical-id).

The rules for what counts as a replacement, when the order changes, and how
cdkd decides who holds a name are in
[cdkd rollback internals](cli-rollback-internals.md#reversing-a-replacement).

## `NoEcho` values are not reverted

A property that takes its value from a `NoEcho` parameter is left as AWS holds
it. If the failed deploy changed that value, it stays changed after the
rollback. Run `cdkd deploy` with the old value to restore it.

The reason is that cdkd never stores a `NoEcho` value. The state record holds
only the mask `***` for it, so the rollback has no old value to send. When it
reverts the resource, it reads that property back from AWS and leaves it as
AWS holds it. The same applies to a `NoEcho` attribute read through
`Fn::GetAtt`.

The value never appears in the state record, the events or the log in the
clear, and cdkd never sends `***` to AWS. There are two exceptions: a name or
other identifier is stored as resolved, and a value shorter than 4 characters
can appear inside a longer log line. See
[State Store](state-management.md).

### Edge cases

- **The value cannot be read back.** This happens for a write-only property,
  a type that offers no read, or a read that failed. The operation fails with
  `ROLLBACK_REDACTED_BASELINE`, sends nothing, and the journal is kept.
  Restore the property with `cdkd deploy`.
- **Reversing a replacement** fails the same way, because there is no live
  resource to read the value from.
- **A nested stack that receives the value as a `Parameters` entry** reverts
  as usual.

## Nested stacks

A nested stack has its own rollback journal. To revert a nested stack, the
parent's rollback replays the nested stack's journal for the same deploy run,
and the plan lists that replay under the parent's entry.

Run the rollback on the top-level stack:

```bash
cdkd rollback MyStack
```

If the nested stack's own deploy failed in that run, a plain rollback of the
parent refuses. Pass `--revert-failed`, which replays the nested stack's
completed operations. The resource that failed inside the nested stack then
needs its own rollback:

```bash
cdkd rollback MyStack --revert-failed
cdkd rollback 'MyStack~MyNestedStack' --revert-failed
```

A plain `cdkd rollback 'MyStack~MyNestedStack'` is enough for the second
command when that resource is a
[failed CREATE that made its resource](cli-rollback-failed-operations.md#failed-creates-that-made-their-resource).

### Edge cases

- **The nested stack has no journal for the run.** An older cdkd wrote it, or
  the journal was removed. The parent's entry fails and the journal is kept.
- **The nested stack's replay skipped an operation.** The parent's entry is
  reported as partial, and the rollback exits `2`.
- **You roll back the nested stack directly while the parent's journal still
  holds the run.** The command is refused, and the message names the top-level
  stack to roll back. It is also refused while the parent's journal cannot be
  read, or while a running deploy holds the top-level stack's lock.
- **A nested stack's journal for a run the parent no longer holds.** The plan
  lists it, and cdkd discards it after you confirm.
- **`cdkd rollback` without a stack name** does not offer a nested stack's
  journal separately when its parent has one.
- **A secret reference that names no region.** A reference written as a name
  carries no region; an ARN does. A record a deploy wrote since state schema
  v12 also says which region resolved it, and the rollback resolves it there.
  Without that, such a reference is refused when a stack above the nested
  stack reads a value from another region, and always in a direct rollback of
  the nested stack. The operation fails and the journal is kept. Set the
  property yourself, or write the reference as a full ARN.

## Names of re-created resources

A resource the rollback re-creates gets the physical name the failed deploy
would have given it. You do not pass
[`--prefix-user-supplied-names`](cli-deploy-tuning.md) again: the journal
records whether the deploy ran with that flag, and the rollback uses the same
setting.

### Edge cases

- **A journal written by an older cdkd** does not record the setting. The
  rollback then takes it from `CDKD_PREFIX_USER_SUPPLIED_NAMES`, then from the
  `cdk.json` in the current directory, then uses the default (no prefix). It
  prints a warning that says which one it chose. If the failed deploy ran with
  the prefix, run:

  ```bash
  CDKD_PREFIX_USER_SUPPLIED_NAMES=true cdkd rollback MyStack
  ```

- **A resource an earlier deploy created under the other setting** keeps its
  name. This concerns the types whose names the setting rewrites: IAM roles,
  users, groups, instance profiles and managed policies, and ELBv2 load
  balancers and target groups. For those the rollback goes by the resource's
  physical ID. It prints a line when that differs from the failed deploy's
  setting, and a warning when neither setting produces the name.

## Interaction with `cdkd import`

If you ran `cdkd import` on a stack after its failed deploy, the rollback
leaves the imported resources alone.

This protects a resource you re-created by hand. Suppose a resource has an
explicit name, so its physical ID is that name. The deploy created it and
failed. You then deleted it, created it again by hand under the same name, and
imported it. The journal still says "this deploy created that name". Without
protection, the rollback would delete your resource.

So `cdkd import` marks each resource it adopts in the journal, before it
writes state. The rollback then runs none of the journaled operations for that
logical ID. What you see depends on what the journal recorded:

- **The same resource the import adopted** (same physical ID and type; for a
  delete, the entry the import removed). The rollback leaves it alone. Plan
  line: `adopted by cdkd import after this deploy, left as it is`.
- **A different resource under the same logical ID** (another physical ID or
  type). The rollback leaves it alone, warns, and exits `2`. Plan line:
  `recorded <its physical id>, which cdkd import has since replaced under this id; not reverted, check that resource by hand`.
- **A replacement whose new resource the import adopted, while the old one was
  kept or may have been kept.** The rollback leaves it alone, warns, and exits
  `2`. The plan line starts with `replaced <old physical id> but kept it` or
  `and may have kept it`, and ends with
  `not reverted, check that resource by hand`.

"May have been kept" applies when the journal recorded no verdict, as on a
failed operation. A replacement here includes a `Type` change that kept the
resource's name.

### Edge cases

- **A replacement.** Only its new resource counts as what the operation
  recorded. If the import put the old resource back, the replacement is left
  running and reported as in the third case.
- **Failed operations** follow the same rules, with or without
  `--revert-failed`.
- **Events.** An operation that is passed over records a
  `ROLLBACK_RESOURCE_SKIPPED` event. Once its segment is removed from the
  journal, the plan line, which names the physical ID, is the record to act
  on.
- **`--orphan`.** Completed operations of an ID you pass to `--orphan` are not
  covered by the mark. The flag is honoured.
- **Later deploys.** Segments that later deploys add carry no mark and are
  replayed as usual.
- **The import cannot read or write the journal.** It refuses and writes no
  state.
- **An import by an older cdkd** wrote no mark. A failed create whose physical
  ID such an import replaced is still left alone with a warning (exit `2`),
  but the plan line cannot say that an import caused it.

## Interaction with `cdkd export`

`cdkd export` hands a stack over to CloudFormation. While a rollback journal
exists for the stack, it refuses to do so unless you confirm. Roll back or
re-deploy first.

## Related

- [`cdkd rollback`](cli-rollback.md) — what a rollback reverts and how to run it
- [cdkd rollback: failed operations](cli-rollback-failed-operations.md) — `--revert-failed` and `--drop-failed`
- [cdkd rollback internals](cli-rollback-internals.md) — the exact ownership and ordering rules
