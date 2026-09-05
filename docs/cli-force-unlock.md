---
title: cdkd force-unlock
description: "Delete a stack's lock object when a crashed or cancelled run left one behind, without waiting for it to expire."
---

# cdkd force-unlock

Deletes the lock object a cdkd run holds while it writes to a stack. Reach for
it when a run was force-quit, a CI job was cancelled, or a laptop slept
mid-deploy, and the next command refuses to start because the stack is still
locked.

It needs no CDK app — it operates on the state bucket directly.

```bash
cdkd force-unlock MyStack                         # every region where the stack has state
cdkd force-unlock MyStack --stack-region us-west-2 # one region
cdkd force-unlock MyStack OtherStack               # several stacks in one run
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--stack-region <region>` | every region where the stack has state | Release the lock for one region only. |
| `--stack <name>` | — | Stack to unlock, as a flag instead of a positional argument. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json`, then the account default | The state bucket holding the lock. The default name is resolved by probing `cdkd-state-{accountId}` and the legacy `cdkd-state-{accountId}-{region}`. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix inside the bucket. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `-y`, `--yes` | `false` | Accepted for consistency with the other state-writing commands; `cdkd force-unlock` asks no confirmation, so it changes nothing. |
| `--verbose` | `false` | Debug-level logging. |

At least one stack is required, positionally or via `--stack`; the command
errors rather than guessing.

## Usually you do not need this

A lock usually clears itself. It carries a 30-minute TTL, and a live cdkd
process renews it well inside that window, so an abandoned lock is expired 30
minutes after its owner's last renewal — and the next `cdkd deploy` normally
takes an expired lock over on its own, printing a warning that names the
previous owner and how long ago it expired.

`cdkd force-unlock` is for the cases where that does not happen:

- You do not want to wait out the remaining TTL.
- The lock object is unreadable — truncated, or holding something that is not a
  lock. Nothing can take that over automatically, because the takeover path has
  to read `expiresAt` to decide the lock is expired, while every attempt to
  acquire still fails on the object's presence. `force-unlock` deletes it
  regardless of whether it could be parsed.
- The takeover was refused. cdkd removes an expired lock only when it can
  delete the exact version it just read; if that version cannot be identified,
  or the S3 endpoint will not evaluate the conditional delete, it declines
  rather than risk deleting a lock some other process has since taken. It says
  so and names this command. Such a lock does not clear on its own, however
  long you wait.

## The delete is unconditional

This command removes the lock whether or not it has expired, and whether or not
another process still holds it. That is deliberate — a lock cdkd cannot read is
a lock nothing else can clear, so gating the delete on reading it first would
make a corrupt lock permanent.

The cost is that **running it against a live deploy leaves two processes writing
to the same stack**. Before running it, confirm the owner is really gone: the
command prints the lock's owner and operation before deleting, and `cdkd events
<stack>` shows whether a run is still emitting events.

Confirm the *account*, too. The command re-resolves the state bucket from the
ambient profile, so a shortened invocation — dropping the `--profile` or
`--state-bucket` you used earlier — can clear the lock of a same-named stack in
a different account. When cdkd prints a recovery command in a lock error, run it
as printed.

## Which regions it releases

Without `--stack-region`, the command looks the stack up in the state bucket and
releases the lock in **every region where that stack name has a state record** —
the same stack name deployed to two regions has two independent locks. A record
written by a pre-v2 cdkd that names no region resolves to the region-less lock
key, and is released by the same walk; one that does name a region resolves to
the region-prefixed key only.

When the stack has no state record at all, the walk falls back to the region
`--region` or `AWS_REGION` names, and to the literal `us-east-1` when neither is
set — the profile's own region is not consulted. See
[`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command).

`--stack-region` narrows the walk to the one region named, and no other key is
touched — including the region-less one.

## What it deletes

The lock is a single object at
`s3://{bucket}/{prefix}/{stackName}/{region}/lock.json`. The command deletes it
and then purges that key's noncurrent versions, so a versioned state bucket does
not accumulate the leavings of every crashed run. That purge reaches the state
bucket only — on a replicated bucket the destination keeps its copies, which
matters less here than elsewhere (a lock body carries no secret) but is the
same mechanism; see
[S3 replication defeats the purge](state-management.md#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you). Nothing else in the state
record is touched: the stack's `state.json`, its resources, and its deployment
events are all left as they were.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every lock the walk reached was deleted, or there was none to delete. |
| `1` | A lock could not be deleted; no stack was named; credentials or state-bucket resolution failed; or listing a stack's regions failed. |

A lock that was **already absent** is a success, not a failure — the command's
job is that no lock remains, and an absent one already satisfies it.

The two failure kinds differ in how much of the walk still runs:

- **Failing to DELETE a lock** does not stop the walk. The error is reported,
  the remaining regions of that stack and then the remaining stacks are still
  attempted, and the run exits `1` at the end naming every lock it could not
  release. One unreachable stack therefore does not cost you the others.
- **Failing to LIST a stack's regions** aborts immediately with `1`, leaving any
  later stack in the same invocation unattempted.


The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd state`](cli-state.md) — inspecting the state record the lock guards
- [`cdkd events`](cli-events.md) — checking whether a run is still active before forcing the lock
- [State Management](state-management.md) — the state bucket layout and the locking model
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
