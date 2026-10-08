---
title: Rollback
description: cdkd's automatic rollback on deploy failure, the --no-rollback escape hatch, and the standalone journal-driven cdkd rollback command.
---

# Rollback behavior

When a deploy fails mid-stack (e.g. a resource hits a validation error
or AWS rejects the request), cdkd by default **rolls back the
already-completed resources in the same deploy** so the stack state
stays consistent:

- Every resource this run created is deleted, in reverse dependency
  order. `DeletionPolicy` decides the exceptions
  ([full table](cli-rollback.md#deletionpolicy-on-a-rolled-back-create)):
  `Retain` leaves the resource in AWS, and `Snapshot` takes a final
  snapshot before deleting.
  When the same stack (or, for a nested stack, its `Parent~Child` record) is
  also recorded under another state prefix, or that check fails (a create
  can take over a resource that already existed under its generated name), a
  created resource is kept instead, with a warning naming the prefix when one
  was found, and the journal keeps it
  ([One stack name per account and region](state-store.md#one-stack-name-per-account-and-region)).
- A `Retain`ed resource moves out of the record's resources into a
  rollback-orphan record. The next deploy re-adopts it — rather than
  colliding with the name it still holds — provided its template still
  declares that resource with the same type, leaves the physical name for
  cdkd to derive, and no other cdkd stack records the same resource. A
  type cdkd will not re-adopt is reported instead and left for you to
  delete.
- Every resource this run updated is reverted to the properties cdkd had
  recorded for it — its last deployed template values, not a live read,
  so drift is not restored. A replacement is undone by reversing the
  replacement rather than by reverting properties.
- A nested stack this run updated is reverted by replaying the child
  stack's own journal for this run, not by re-deploying its template: a
  nested child's successful deploy keeps what it did until the top-level
  deploy succeeds. When that record is missing, the nested stack's row
  is reported as a failed rollback operation, never as restored.
- A resource this run had already deleted cannot be brought back. The
  rollback warns and moves on.
- Resources this run did not touch are left alone.

The state record is updated to match, and the CLI exits non-zero.

Pass `cdkd deploy --no-rollback` to skip the rollback (Terraform-style:
the partial state is preserved so you can `cdkd state show '<stack>'`,
inspect what landed, fix the underlying issue, and re-run `cdkd deploy`
to continue from the half-deployed state). Recommended only when you
plan to manually inspect / repair; the default is safer for CI.

Mid-deploy state is also saved per-resource as work completes, so even
if cdkd itself crashes between the failure and the rollback, the state
file accurately reflects what's on AWS and a follow-up `cdkd destroy`
won't orphan anything.

## `cdkd rollback` — revert a failed deploy

After a `--no-rollback` failure (or a Ctrl+C-interrupted deploy, or an
automatic rollback that itself died partway), you have three options:
fix forward (`cdkd deploy` again), revert (`cdkd rollback`), or clean up
(`cdkd destroy`). The standalone `cdkd rollback` command is the "revert"
option — the cdkd equivalent of `cdk rollback` / CloudFormation
`RollbackStack`:

```bash
cdkd rollback MyStack          # revert MyStack to its pre-deploy state
cdkd rollback                  # single journaled stack (no arg)
cdkd rollback MyStack --force  # skip the confirmation prompt
```

It works from a **rollback journal** cdkd writes to
`s3://bucket/cdkd/{stack}/{region}/rollback-journal.json` (a sibling of
`state.json`) whenever a deploy ends without a completed rollback — the
journal records the exact operations that completed, so `cdkd rollback`
replays them in reverse (deleting created resources, restoring updated
ones) with no synth and no CDK app needed. It is **synth-free** on
purpose: a broken app is a common reason you want to roll back. The
journal is deleted automatically on the next successful deploy and by
`cdkd destroy`; after a clean automatic rollback it keeps only the
failed resource's record so `cdkd rollback --revert-failed` still works
in the default deploy flow. A resource a failed CREATE made before it
failed (or the new resource a failed replacement made), which only the
journal records, is deleted per its `DeletionPolicy`
by the automatic rollback, any `cdkd rollback`, `cdkd destroy` and a later
successful deploy before they drop the journal (see [Failed CREATEs that made their resource](cli-rollback.md#failed-creates-that-made-their-resource)).
`cdkd rollback`, `cdkd destroy` and a successful deploy delete it only when no
other stack's state record holds it (a later `cdkd import` into another stack,
say) and, for a resource whose physical id is a name, AWS still reports the
identity the failed CREATE recorded (it may have been deleted and its name
reused). Only a Kinesis stream and an RDS, DocumentDB or Neptune cluster or
instance record that identity today; a type whose physical id AWS generates and never
reuses (a VPC, a security group, a load balancer, a KMS key, ...) needs none.
**Every other name-keyed type (an S3 bucket, a Lambda function, an IAM role, a
DynamoDB table, an SQS queue, ...) records none, so `cdkd rollback` and `cdkd
destroy` keep its journaled orphan instead of deleting it.** A kept one is
warned about, its physical id named, and left in AWS for you to delete by hand
if it is not in use; `cdkd rollback` and `cdkd destroy` both exit `2`. When
another stack's record or the live identity cannot be read, nothing is decided:
the entry stays in the journal as a failed operation, for a re-run once the
record or the resource can be read (`cdkd rollback --drop-failed` removes only
the entry and leaves the resource in AWS). One AWS reports gone is settled with
no delete. The automatic rollback, which runs inside the failed deploy over that
attempt's own operations, deletes it without either check — but it still runs
the cross-prefix check above, and keeps the resource when another state prefix
records the stack or that check fails.
A successful deploy that cannot act on one keeps the journal (reduced to that
entry where it can), and one a state record may own, or that the checks above
keep, is warned about and left in AWS; either way it exits `2`. An automatic rollback that skipped an operation
it could not revert keeps the whole journal. A nested stack's journal is the exception:
its successful deploy keeps a record until the top-level stack's deploy
succeeds, which deletes the journals of every nested stack under it.

Flags: `--force` (skip confirm), `--orphan <logicalId>` (repeatable —
leave the resource alone during replay, like `cdk rollback --orphan`),
`--revert-failed` (also attempt to revert the resource whose operation
FAILED mid-deploy — off by default because its remote state is unknown; its
delete honors `DeletionPolicy` the same way a completed CREATE's does),
`--stack-region <region>` (disambiguate a same-named stack across
regions), `--role-arn`, `--state-bucket`.

A **replacement** is reverted by reversing it: the old resource is
re-created from its journaled pre-deploy state and the new one deleted
(for a stateful type the old resource's data is not recovered by this
rollback and the re-created one starts empty — warned loudly). The new
copy escapes that delete when `UpdateReplacePolicy: Retain` applies to
it: cdkd leaves it running, drops it from state and warns. When the
deploy had retained the *old* resource under that same attribute, the
old one is re-adopted with its data instead and the new copy is again
left running and untracked.

A resource you `cdkd import` while the journal exists is left alone: the
import marks it on the journal, and the rollback skips the journal's
operations for that resource, listing each in its plan as `adopted by cdkd
import after this deploy`. An operation that recorded a different resource
under the same logical id is also left alone, with a warning. See
[`cdkd rollback`](cli-rollback.md#interaction-with-cdkd-import) for both
cases. A deploy that runs after the import journals its own operations, and
those are reverted as usual.

Exit codes: `0` = fully clean
(journal deleted), `2` = partial (some ops failed — the journal is kept so
you can re-run — or were skipped, each recorded as a
`ROLLBACK_RESOURCE_SKIPPED` event, or left an untracked new copy behind or
were not fully reversed, recorded on its `ROLLBACK_RESOURCE_SUCCEEDED` event's `reason`), `1` = hard error. See
[`cdkd rollback`](cli-rollback.md) for the
full reference and known limitations (a DELETE that already happened
cannot be restored).

## Related

- [`cdkd rollback`](cli-rollback.md) — every flag, the journal, and the exit codes
- [Destroy flags & guards](cli-destroy.md) — tearing a stack down instead of reverting it
- [Deployment Events](deployment-events.md) — reading back what a failed run actually did
