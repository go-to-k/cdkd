---
title: State locking
description: "Which cdkd commands lock a stack, how long a lock is held, what an interrupted command leaves behind, and how to clear a lock whose owner is gone."
---

# State locking

cdkd locks a stack while a command changes it, so that two commands cannot
write the same state record at once. The lock is a small object, `lock.json`,
stored next to the stack's record. The command that takes the lock deletes it
when it finishes.

```bash
# which stacks are locked
cdkd state list --long

# the record and its lock
cdkd state show MyStack --json

# delete a lock whose owner is gone
cdkd force-unlock MyStack --stack-region us-east-1
```

This page is part of [State Management](state-management.md).

## Which commands take the lock

A lock covers one stack in one region. Every command that writes the stack's
record takes it:

- `cdkd deploy`, `cdkd destroy` and `cdkd rollback`
- `cdkd import`, `cdkd export`, `cdkd orphan` and `cdkd scrub`
- the `cdkd state` and `cdkd drift` forms that write

`cdkd diff` takes no lock.

## The life of a lock

```text diagram=state-lock-lifecycle
        A command starts work on a stack
                      │  writes lock.json only if the key is absent
                      ▼
                  Lock held
                      │  renewed about every 2 minutes;
                      │  each renewal moves expiresAt 30 minutes ahead
          ┌───────────┴─────────────┐
          ▼                         ▼
      Released                  Left behind
 the command finished,       SIGKILL, a crash, a second
 failed, or took a first     Ctrl-C, a cancelled CI job
 Ctrl-C or SIGTERM                  │
                                    ▼
                                 Cleared
                    the next command takes it over once
                    expiresAt passes, or cdkd force-unlock
                    deletes it now
```

`lock.json` names the process that holds the lock:

```json
{
  "owner": "goto@macbook:12345",
  "timestamp": 1710835200000,
  "expiresAt": 1710837000000,
  "operation": "deploy"
}
```

| Field | Meaning |
| --- | --- |
| `owner` | `user@hostname:pid` of the holding process |
| `timestamp` | When the lock was taken, in Unix milliseconds |
| `expiresAt` | The time by which the holder must renew the lock |
| `operation` | The command holding the lock, such as `deploy` |

## How long a lock is held

A command holds the lock for as long as it works on that stack. A run that
covers several stacks releases each stack's lock as that stack finishes.

The lock expires 30 minutes after its last renewal, and the holder renews it
about every 2 minutes for as long as it runs. The 30 minutes therefore measure
how long the holder has been silent. They do not limit how long an operation
can run: a deploy that takes two hours stays locked for two hours.

The lock is released when cdkd's own work ends, which can be before the
resources have finished coming up. A second deploy can therefore start while
resources from the first are still provisioning.
[Deploy: waits & concurrency](cli-deploy.md) describes what that second deploy
meets.

## When another command holds the lock

A command that finds a lock whose `expiresAt` has not passed does not proceed.
`cdkd deploy` and `cdkd rollback` try three more times, 2 seconds apart, and
then fail. Most other commands fail at once.

The error names the lock's owner, its operation and its expiry time. It also
prints the `cdkd force-unlock` command for that exact lock.

If the owner is a deploy that is still running, wait for it to finish.

## What an interrupted command leaves behind

Whether a lock is left behind depends on how the command stopped. This table
applies to `cdkd deploy`, `cdkd destroy`, `cdkd state destroy` and
`cdkd rollback`.

| How the command stops | Lock | State record |
| --- | --- | --- |
| It finishes or fails | Released | Saved |
| First {kbd:ctrl+c} or `SIGTERM` | Released | Saved |
| Second {kbd:ctrl+c} or `SIGTERM` | May be left behind | As of the last save |
| `SIGKILL`, a crash, a machine that sleeps | Left behind | As of the last save |

On the first {kbd:ctrl+c} or `SIGTERM`, cdkd lets the operations already in
progress finish, saves the record and releases the lock. A deploy also writes
the rollback journal, the file [`cdkd rollback`](cli-rollback.md) reads. You
can run the command again immediately.

On the second {kbd:ctrl+c} or `SIGTERM`, the process exits with code 130
without waiting. The record holds whatever the last save after a resource
operation wrote.

An interrupted destroy leaves a record that lists only the resources that
still exist. Running the destroy again does not repeat the deletes that
completed.

### A cancelled CI job

A cancelled CI job can leave the lock behind even though the runner sends
`SIGTERM` first. Runners follow `SIGTERM` with `SIGKILL` after a short grace
period, about 10 seconds on GitHub Actions, and a long AWS call may not finish
in that time.
[Troubleshooting](troubleshooting.md) has
workflow patterns that avoid this.

## Clear a lock whose owner is gone

A lock that was left behind is no longer renewed. The next command that needs
the lock takes it over once `expiresAt` passes, and warns with the name of the
previous owner.

To clear it sooner, find the locked stack and delete the lock:

```bash
cdkd state list --long                               # which stacks are locked
cdkd force-unlock MyStack --stack-region us-east-1   # delete the lock now
```

> [!CAUTION]
> `cdkd force-unlock` deletes the lock whether or not its owner is alive.
> If you run it against a live deploy, two processes end up writing the same
> stack. Confirm the owner is gone first.

[`cdkd force-unlock`](cli-force-unlock.md) covers the cases where a lock does
not clear by itself.

## Related

- [`cdkd force-unlock`](cli-force-unlock.md): the command that deletes a lock
- [Troubleshooting](troubleshooting.md): lock errors and what to do about
  them
- [State Management](state-management.md): where `lock.json` sits in the
  bucket, and how a deploy uses the lock
