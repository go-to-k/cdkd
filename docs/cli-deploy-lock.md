---
title: "Deploy: the stack lock"
description: "What the cdkd deploy stack lock covers, what a deploy does when the stack is locked, and what a second deploy runs into while resources are still provisioning."
---

# Deploy: the stack lock

cdkd takes a lock on a stack while it works on it, so that two runs do not
change the same stack at once. The lock covers one stack in one region. A run
over several stacks releases each stack's lock as that stack finishes.

```text diagram=cli-stack-lock
  $ cdkd deploy MyStack
          |
          v
    Take the lock  <----------------------------+  try again
          |                                     |
          +--------------------+                |
          | free, or expired   | held by another run
          v                    v                |
  Work on the stack       Wait 2 seconds -------+
  (lock renewed)               |
          |                    | still held after 3 retries
          v                    v
  Release the lock           Fail
  (work finished)        (names the holder)
```

## When a deploy finds the stack locked

A deploy that finds the lock held does not queue behind the other run. It
tries again three times, two seconds apart, and then fails. The error names
the holder when cdkd can read the lock.

If the lock disappears between two attempts, the deploy tries again at once,
up to three extra times.

When the holder is a run that is still working, wait for it to finish. When
the holder crashed or was cancelled, see
[`cdkd force-unlock`](cli-force-unlock.md).

## A second deploy can start before resources finish

cdkd releases the lock when its own work on the stack finishes. It does not
hold the lock until every resource has finished provisioning in AWS. A second
`cdkd deploy` on the same stack can therefore start while resources that the
first deploy created are still coming up.

This is true in every wait mode. `--no-wait` makes the gap longer and
`--full-wait` makes it shorter, but the gap exists in the default mode too.
The default mode returns before a CloudFront distribution is `Deployed` or an
ECS service is steady. No mode waits for the network interface of a Lambda
function in a VPC to attach.

## What a second deploy started too early runs into

An update to a resource that is still provisioning is likely to fail, and the
failure rolls the second deploy back. cdkd does not wait for a resource to
become available before it updates it.

cdkd retries an operation only when the error is transient. It retries on:

- throttling, HTTP 429 included;
- HTTP 500, 502, 503 and 504;
- an AWS message that matches a fixed list of transient patterns.

Any other rejection is not retried, and neither is a transient error that
lasts longer than the retries do. The retries for one operation span roughly
47 to 64 seconds, and up to about ten minutes where a replacement nests one
retry inside another. Nested stacks and custom resources handle their own
transient errors.

### What the rollback does

[Rollback](rollback.md) reverts what the second deploy had done, while the
first deploy's resources keep coming up. It deletes what the second deploy
created and undoes its updates, with two limits:

- `DeletionPolicy` decides what survives the delete, per the table under
  [`cdkd rollback`](cli-rollback.md#deletionpolicy-on-a-rolled-back-create).
- A resource that the second deploy had already deleted cannot be brought
  back.

`--no-rollback` leaves the partial deploy in place.

### What the second deploy reads

What the second deploy finds in state depends on how the first one ended. A
deploy that succeeded wrote its final state, physical IDs included, before it
released the lock. A deploy that failed or was interrupted wrote what it
could.

## A second deploy that changes nothing

A second deploy whose template produces no diff updates nothing, so AWS has
nothing to reject. Two things still happen in such a deploy.

First, cdkd adopts back a resource that a rollback left in AWS. It does this
before it computes the diff, when the template still declares the resource
with the same type and leaves the physical name for cdkd to derive. The
adoption adds no entry to the diff.

Second, cdkd resolves the stack's Outputs again. An attribute that the first
deploy did not have yet is read from AWS at that point. Two attributes can
still be missing when the first deploy used `--no-wait`.

### The public address of a `--no-wait` EC2 instance

This applies to `PublicIp` and `PublicDnsName`.

- If the address is available by then, cdkd uses the real value and caches it
  for the rest of the deploy.
- If the address is still not available, cdkd refuses to resolve the
  reference, and caches nothing.

What the refusal does depends on where the reference is:

| Reference in | Result |
| --- | --- |
| A resource property | That resource fails. |
| An Output | cdkd warns and skips the Output. The next deploy resolves it again. |
| An Output, under `--strict-getatt` | The deploy fails. |

A `DescribeInstances` call that fails gets the same refusal, and the message
names the error class. `--verbose` shows the AWS error text.

A running instance that has no public address, as in a private subnet, is a
different case. Both attributes resolve to the empty string, which is what
CloudFormation reports. See
["Cannot resolve" a GetAtt on a resource an older cdkd deployed](troubleshooting-references.md#cannot-resolve-a-getatt-on-a-resource-an-older-cdkd-deployed).

### The endpoint of a `--no-wait` database instance

This applies to `Endpoint.Address` and `Endpoint.Port` of an RDS, DocDB or
Neptune `DBInstance`.

- If the endpoint is available by then, cdkd uses the real endpoint and
  records it in state.
- If the endpoint is still not available, the reference resolves to the
  instance identifier, and cdkd warns. Nothing is recorded. Under
  `--strict-getatt`, the deploy fails instead.

### An Output that cannot be resolved

When a deploy that changes nothing cannot resolve an Output, the Output keeps
the value stored for it before, and cdkd warns and names the Output. The
Outputs that did resolve are saved.
[Deploy internals](cli-deploy-internals.md#outputs-a-no-change-deploy-cannot-resolve)
has the rules for the Output's export name.

## The lock does not guarantee exclusion

The lock is a safeguard against ordinary overlap. It is not a guarantee,
because a lock can change hands while its holder is still working:

- **The holder's renewals fail.** A live run renews its lock. If the renewals
  fail until the lock's time limit passes, another process can take the lock.
- **Someone runs [`cdkd force-unlock`](cli-force-unlock.md).** It removes the
  lock even when the holder is alive.
- **Someone runs `cdkd state orphan --force` without `--resource`.** It
  force-releases the lock before it drops the state record.

A holder that notices the loss warns, and does not delete a lock it no longer
owns. From that point two processes can be writing one stack's state.

A lock can also outlive its command. That happens after a second
{kbd:ctrl+c}, after a `SIGKILL`, or when cdkd refuses to release a lock
because it cannot confirm the lock is still its own. Such a lock expires once
its time limit passes, and `cdkd force-unlock` clears it immediately.

## Related

- [`cdkd force-unlock`](cli-force-unlock.md): deleting a lock that a dead run left behind
- [Deploy: wait mode details](cli-deploy-waits.md): what is still provisioning when a deploy returns
- [Rollback](rollback.md): what the automatic rollback reverts
- [State Management](state-management.md): the lock's layout, time limit and renewal
- [Deploy: waits & concurrency](cli-deploy.md): every deploy flag
