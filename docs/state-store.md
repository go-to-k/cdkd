---
title: State Store
description: "cdkd records what it deployed in an S3 state store, so a whole estate can be listed, inspected and torn down by name, without the CDK app that created it."
---

# The state store

cdkd does not deploy through CloudFormation, so there is no CloudFormation
stack to ask what a deployment contains. cdkd writes that record itself, to
an S3 bucket called the **state store**: one JSON record per stack and
region. Every later command works from it. A diff compares against it, a
drift check uses it as the baseline, and a destroy reads it to know which
physical resources to delete.

```bash
cdkd state info                    # which bucket cdkd uses, and how many stacks are in it
cdkd state list                    # every stack in the bucket, across all CDK apps
cdkd state list --tree             # nested stacks under their parents
cdkd state show MyStack            # one record: outputs and every resource
cdkd state destroy StackA StackB   # delete named stacks and their resources
```

## What is in the bucket

```text
s3://cdkd-state-<accountId>/cdkd/
  └── MyStack/
      └── us-east-1/
          ├── state.json              # the record: resources, outputs
          ├── lock.json               # the stack lock
          └── rollback-journal.json   # what a failed deploy did
```

One bucket serves every CDK app in the account, and a stack deployed to two
regions has a record under each. `cdkd bootstrap` creates the bucket.

## These commands need no CDK app

`cdkd state` commands read the bucket and never synthesize. They work on a
machine that has never had your repository, which makes them the cleanup path
for a CI runner whose branch is already deleted, or for a stack whose source
is gone.

`cdkd state destroy` deletes resources the same way `cdkd destroy` does. It
takes what to delete from the record where `cdkd destroy` takes it from a
fresh synth.

Without an app, a stack is identified by its physical CloudFormation name.
The CDK display paths and wildcards `cdkd destroy` accepts need an app to
resolve, so they are not available here.

## Acting on more than one stack

The bucket holds the whole estate, so a command can cover several stacks at
once:

```bash
cdkd state list --long                   # resource count, last modified, lock
cdkd state refresh-observed --all        # refresh the drift baseline of every stack
cdkd state destroy StackA StackB --yes   # only the stacks you name
```

`cdkd state destroy` has no `--all`. The bucket is shared by every CDK app in
the account, so it deletes only the stacks you name.

## Removing a record does not delete resources

> [!WARNING]
> `cdkd state destroy` deletes the AWS resources and then the record.
> `cdkd state orphan` deletes only the record and leaves everything running,
> tracked by nothing.

Orphaning is for a resource or stack cdkd should stop managing.
[Orphan vs Destroy](orphan-vs-destroy.md) says which of the cleanup commands
applies.

## Upgrading cdkd does not require migrating records

Each record carries a schema version. A newer cdkd reads every older version
and writes the current one the next time it saves the record. You are never
asked to migrate a record's contents.

Two things outside the record's contents did change once:

| What changed | Who is affected | What happens |
| --- | --- | --- |
| The key layout gained the region | A record written before keys carried a region | The next `cdkd deploy` into that region rewrites it under the current key |
| The default bucket name lost its region suffix | An installation that still uses `cdkd-state-<accountId>-<region>` | Run `cdkd state migrate` once per region; the deprecation warning and `cdkd state info` both point at it |

## Related

- [`cdkd state`](cli-state.md): every subcommand, its flags, the confirmation
  and lock behavior, and the exit codes
- [State Management](state-management.md): the record's fields, the schema
  versions and the lock mechanism
- [Orphan vs Destroy](orphan-vs-destroy.md): choosing a cleanup command
