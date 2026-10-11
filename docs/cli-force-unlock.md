---
title: cdkd force-unlock
description: "Delete a stack's lock object when a crashed or cancelled run left one behind, without waiting for it to expire."
---

# cdkd force-unlock

`cdkd force-unlock` deletes the lock that a cdkd run holds while it writes to
a stack. Use it when a run was force-quit, a CI job was cancelled or a laptop
slept in the middle of a deploy, and the next command refuses to start because
the stack is still locked.

```bash
# every region where the stack has state
cdkd force-unlock MyStack

# one region
cdkd force-unlock MyStack --stack-region us-west-2

# several stacks in one run
cdkd force-unlock MyStack ApiStack
```

The command needs no CDK app. It works on the state bucket directly.

> [!WARNING]
> The delete is unconditional. If you run it against a live deploy, two
> processes end up writing to the same stack. Confirm that the lock's owner is
> gone first.

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

cdkd finds the account default bucket by probing `cdkd-state-{accountId}` and
the legacy `cdkd-state-{accountId}-{region}`.

## When you need it

Usually not, because a lock clears itself. A lock carries a 30-minute time
limit (its TTL), and a live cdkd process renews the lock well inside that
window. An abandoned lock therefore expires 30 minutes after its owner's last
renewal.

The next `cdkd deploy` normally takes an expired lock over. It prints a
warning that names the previous owner and says how long ago the lock expired.

| Situation | What to do |
| --- | --- |
| The lock will expire soon and you can wait | Nothing. The next deploy takes it over. |
| You do not want to wait out the TTL | `cdkd force-unlock` |
| The lock object is unreadable: truncated, or not a lock at all | `cdkd force-unlock` |
| The takeover was refused, and the message names this command | `cdkd force-unlock` |

The last two rows are locks that do not clear by waiting:

- **An unreadable lock.** cdkd has to read a lock's expiry time to know that
  the lock has expired, so nothing takes an unreadable lock over.
  `force-unlock` deletes the lock whether or not it can be parsed.
- **A refused takeover.** cdkd removes an expired lock only by deleting the
  exact version it just read. That way it cannot delete a lock that another
  process has taken in the meantime. cdkd refuses the takeover when it cannot
  identify that version, or when the S3 endpoint will not evaluate the
  conditional delete.

## Before you run it

The command deletes the lock whether or not the lock has expired, and whether
or not another process still holds it. Check two things first.

### The owner is gone

The command prints the lock's owner and operation before it deletes the lock.
[`cdkd events`](cli-events.md) shows whether a run is still recording events:

```bash
cdkd events MyStack
```

### You are in the right account

The command resolves the state bucket from your current profile. If you leave
out the `--profile` or `--state-bucket` that you used earlier, the command can
clear the lock of a stack with the same name in another account. When cdkd
prints a recovery command in a lock error, run that command as printed.

## Which regions it releases

The same stack name deployed to two regions has two independent locks.

| Invocation | Locks released |
| --- | --- |
| `cdkd force-unlock MyStack` | One in every region where that stack name has a state record. |
| `cdkd force-unlock MyStack --stack-region us-west-2` | That region's only. No other key is touched. |

### Edge cases

- **The stack has no state record.** `cdkd force-unlock MyStack` then releases
  the lock in the region that `--region` or `AWS_REGION` names, or in
  `us-east-1` when neither is set. The profile's own region is not consulted.
  See [Region resolution](cli-reference-region.md).
- **A legacy state record that names no region.** Its lock key has no region
  in it. The run without `--stack-region` releases that lock too. A run with
  `--stack-region` does not.

## What it deletes

The lock is one object:

```text
s3://{bucket}/{prefix}/{stackName}/{region}/lock.json
```

The command deletes that object. It then removes the older versions of the
same key that a versioned bucket keeps, so that the state bucket does not
collect one from every crashed run. Nothing else is touched: the stack's
`state.json`, its resources and its deployment events stay as they were.

The cleanup of older versions reaches the state bucket only. On a replicated
bucket, the replication destination keeps its copies. A lock holds no secret,
so this matters less here. See
[S3 replication keeps copies cdkd cannot delete](state-management-backup-and-security.md#s3-replication-keeps-copies-cdkd-cannot-delete).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every lock the command looked for was deleted, or there was none to delete. |
| `1` | A lock could not be deleted; no stack was named; credentials or the state bucket could not be resolved; or listing a stack's regions failed. |

A lock that was already absent counts as a success.

The two kinds of failure differ in how much of the run continues:

- **Deleting a lock fails.** cdkd reports the error and still attempts the
  remaining regions and stacks. The run exits `1` at the end and names every
  lock it could not release.
- **Listing a stack's regions fails.** The run stops at once with `1`. Later
  stacks in the same invocation are not attempted.

[Exit codes](cli-reference-exit-codes.md) has the table for every command.

## Related

- [Deploy: the stack lock](cli-deploy-lock.md): what the lock covers and how a deploy takes it
- [`cdkd state`](cli-state.md): inspecting the state record the lock guards
- [`cdkd events`](cli-events.md): checking whether a run is still active
- [State Management](state-management.md): the state bucket layout and the locking model
