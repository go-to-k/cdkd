---
title: State Store
description: "cdkd records what it deployed in an S3 state store, so a whole estate can be listed, inspected and torn down by name, without the CDK app that created it."
---

# The state store

cdkd does not deploy through CloudFormation, so there is no CloudFormation
stack to ask what a deployment contains. cdkd writes that record itself, to an
S3 bucket called the **state store**. The bucket holds one JSON record for
each stack in each region.

Every later command works from that record. A diff compares your template
with it, a drift check compares AWS with it, and a destroy reads it to learn
which resources to delete.

```bash
# which bucket cdkd uses, and how many stacks are in it
cdkd state info

# every stack in the bucket, across all CDK apps
cdkd state list

# nested stacks under their parents
cdkd state list --tree

# one record: outputs and every resource
cdkd state show MyStack

# delete named stacks and their resources
cdkd state destroy StackA StackB
```

## What is in the bucket

`cdkd bootstrap` creates the bucket, and one bucket serves every CDK app in
the account. Each stack has a directory for each region it is deployed to:

```text
s3://cdkd-state-<accountId>/cdkd/
  └── MyStack/
      └── us-east-1/
          ├── state.json              # the record: resources, outputs
          ├── lock.json               # the stack lock
          └── rollback-journal.json   # what a failed deploy did
```

[State Management](state-management.md) lists every object in the bucket and
every field of a record.

## These commands need no CDK app

`cdkd state` commands read the bucket and never synthesize a CDK app. They
work on a machine that has never had your repository. That makes them the way
to clean up from a CI runner whose branch is already deleted, or to remove a
stack whose source is gone.

`cdkd state destroy` deletes resources the same way `cdkd destroy` does. The
difference is where the list of resources comes from: `cdkd state destroy`
takes it from the record, and `cdkd destroy` takes it from a fresh synth.

Without an app, you identify a stack by its physical CloudFormation name.
`cdkd destroy` also accepts CDK display paths and wildcards, but cdkd needs
the app to resolve those, so `cdkd state` commands do not accept them.

## Acting on more than one stack

The bucket holds every stack in the account, so one command can cover several
of them:

```bash
# resource count, last modified, lock
cdkd state list --long

# refresh the drift baseline of every stack
cdkd state refresh-observed --all

# only the stacks you name
cdkd state destroy StackA StackB --yes
```

`cdkd state destroy` has no `--all`. Because every CDK app in the account
shares the bucket, the command deletes only the stacks you name.

## Removing a record does not delete resources

Two commands remove a record, and only one of them deletes what the record
describes.

> [!WARNING]
> `cdkd state destroy` deletes the AWS resources and then the record.
> `cdkd state orphan` deletes only the record. The resources keep running,
> and cdkd no longer tracks them.

Use `cdkd state orphan` for a stack or resource that cdkd should stop
managing. [Orphan vs Destroy](orphan-vs-destroy.md) says which cleanup command
applies to your situation.

## One stack name per account and region

A stack name identifies one deployment in an account and region, as it does
in CloudFormation. Deploying the same stack name a second time there, under
another `--state-prefix` or another `--state-bucket`, is unsupported.

The reason is resource names. When your template leaves a resource unnamed,
cdkd builds the name from the stack name and the logical ID alone. Two
deployments of one stack name therefore ask AWS for the same names. For some
resource types, such as an SQS queue or a log group, a create call under a
taken name hands back the existing resource. Both records then list that one
resource, and a destroy or a rollback of either deployment deletes it for
both.

To run two copies of an app in one account and region, give their stacks
different names. A CDK `Stage` does this, and so does a suffix:

```ts
new ApiStack(app, 'ApiStack-alice');
new ApiStack(app, 'ApiStack-bob');
```

A `--state-prefix` separates the records. It does not separate the deployed
resources.

cdkd guards against the accident with two checks:

| Check | Runs | Refuses |
| --- | --- | --- |
| [Name check](state-store-name-check.md) | Before a create under a generated name | A create that would take over a resource this stack has no record of |
| [Stack registry](state-store-registry.md) | On a first deploy, a destructive deploy, a destroy and a rollback | A command on a stack that another prefix of the bucket holds |

Each refusal prints the command that resolves it.
[Lock and state errors](troubleshooting-locks-state.md) has an entry for both.

> [!NOTE]
> The two checks are a safety net against an accident. They are not an access
> control: an identity that can write to the state bucket can defeat both.

## Upgrading cdkd does not require migrating records

A newer cdkd reads records written by every older version, and saves a record
in the current format the next time it writes that record. There is no
migration to run for a record's contents.
[Schema versions and upgrades](state-management-schema-versions.md) has the
details.

One upgrade does ask for a command. If your installation still uses the old
default bucket name, `cdkd-state-<accountId>-<region>`, cdkd prints a
deprecation warning. Run `cdkd state migrate` once per region to copy the
state to the current bucket;
[State Management](state-management.md#move-off-the-old-bucket-name-with-cdkd-state-migrate)
shows the command.

## Related

- [`cdkd state`](cli-state.md): every subcommand, its flags, the confirmation
  and lock behavior, and the exit codes
- [State Management](state-management.md): the bucket layout and the fields of
  a record
- [State locking](state-management-locking.md): the stack lock and how to
  clear one
- [Name check before a create](state-store-name-check.md) and
  [Stack registry](state-store-registry.md): the two checks behind one stack
  name per account and region
- [Orphan vs Destroy](orphan-vs-destroy.md): choosing a cleanup command
