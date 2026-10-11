---
title: cdkd force-unlock
description: "Delete a stack's lock object when a crashed or cancelled run left one behind, without waiting for it to expire."
---

# cdkd force-unlock

`cdkd force-unlock` deletes the lock a cdkd run holds while it writes to a
stack. Use it when a run was force-quit, a CI job was cancelled or a laptop
slept mid-deploy, and the next command refuses to start because the stack is
still locked.

```bash
cdkd force-unlock MyStack                           # every region where the stack has state
cdkd force-unlock MyStack --stack-region us-west-2  # one region
cdkd force-unlock MyStack ApiStack                  # several stacks in one run
```

It needs no CDK app; it works on the state bucket directly.

> [!WARNING]
> The delete is unconditional. Run against a live deploy, it leaves two
> processes writing to the same stack. Confirm the lock's owner is gone first.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | | Stacks to unlock. At least one is required, here or through `--stack`. |
| `--stack <name>` | | A stack to unlock, as a flag. |
| `--stack-region <region>` | every region where the stack has state | Release the lock for one region only. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json`, then the account default | The state bucket holding the lock. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix inside the bucket. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | Role to assume before any AWS call. |
| `-y`, `--yes` | `false` | Accepted, but `cdkd force-unlock` asks no confirmation. |
| `--verbose` | `false` | Debug-level logging. |

The account default bucket is found by probing `cdkd-state-{accountId}` and
the legacy `cdkd-state-{accountId}-{region}`.

## Do you need it?

A lock usually clears itself. It carries a 30-minute TTL, and a live cdkd
process renews it well inside that window. An abandoned lock therefore expires
30 minutes after its owner's last renewal. The next `cdkd deploy` normally
takes an expired lock over, with a warning that names the previous owner and
how long ago the lock expired.

| Situation | What to do |
| --- | --- |
| The lock will expire soon and you can wait | Nothing. The next deploy takes it over. |
| You do not want to wait out the TTL | `cdkd force-unlock` |
| The lock object is unreadable: truncated, or not a lock at all | `cdkd force-unlock`. Nothing takes such a lock over. |
| The takeover was refused, and the message names this command | `cdkd force-unlock`. Such a lock does not clear by waiting. |

An unreadable lock cannot be taken over, because cdkd has to read its expiry
time to know it has expired. `force-unlock` deletes it whether or not it can
be parsed.

cdkd removes an expired lock only by deleting the exact version it just read.
A takeover is refused when that version cannot be identified, or when the S3
endpoint will not evaluate the conditional delete. cdkd declines so that it
does not delete a lock another process has since taken.

## Before you run it

The command deletes the lock whether or not it has expired and whether or not
another process still holds it. Check two things first.

**The owner is gone.** The command prints the lock's owner and operation
before deleting, and [`cdkd events`](cli-events.md) shows whether a run is
still recording events:

```bash
cdkd events MyStack
```

**You are in the right account.** The command resolves the state bucket from
your current profile. If you drop the `--profile` or `--state-bucket` you used
earlier, it can clear the lock of a stack with the same name in another
account. When cdkd prints a recovery command in a lock error, run it as
printed.

## Which regions it releases

The same stack name deployed to two regions has two independent locks.

| Invocation | Locks released |
| --- | --- |
| `cdkd force-unlock MyStack` | One in every region where that stack name has a state record. |
| `cdkd force-unlock MyStack --stack-region us-west-2` | That region's only. No other key is touched. |
| `cdkd force-unlock MyStack`, and the stack has no state record | The region `--region` or `AWS_REGION` names, or `us-east-1` when neither is set. |

In the last row the profile's own region is not consulted. See
[`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command).

A legacy state record that names no region has a lock key with no region in
it. The walk over every region releases that lock too. `--stack-region` does
not.

## What it deletes

The lock is one object:

```text
s3://{bucket}/{prefix}/{stackName}/{region}/lock.json
```

The command deletes it and then purges that key's noncurrent versions, so a
versioned state bucket does not accumulate one from every crashed run. Nothing
else is touched: the stack's `state.json`, its resources and its deployment
events stay as they were.

The purge reaches the state bucket only. On a replicated bucket the
destination keeps its copies. A lock holds no secret, so this matters less
here; see
[S3 replication defeats the purge](state-management.md#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every lock the command looked for was deleted, or there was none to delete. |
| `1` | A lock could not be deleted; no stack was named; credentials or the state bucket could not be resolved; or listing a stack's regions failed. |

A lock that was already absent is a success.

The two kinds of failure differ in how much of the run continues:

| Failure | What happens next |
| --- | --- |
| Deleting a lock fails | The error is reported and the remaining regions and stacks are still attempted. The run exits `1` at the end, naming every lock it could not release. |
| Listing a stack's regions fails | The run stops at once with `1`. Later stacks in the same invocation are not attempted. |

The table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd state`](cli-state.md): inspecting the state record the lock guards
- [`cdkd events`](cli-events.md): checking whether a run is still active
- [Deploy: waits & concurrency](cli-deploy.md#what-the-stack-lock-covers-and-when-a-second-deploy-can-start): what the lock covers and how a deploy takes it
- [State Management](state-management.md): the state bucket layout and the locking model
