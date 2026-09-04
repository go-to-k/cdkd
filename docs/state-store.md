---
title: State Store
description: cdkd records what it deployed in an S3 state store, so a whole estate can be listed, inspected, and torn down by name — without the CDK app that created it.
---

# The state store

Because cdkd does not deploy through CloudFormation, there is no server-side
stack to ask about a deployment. What cdkd created is recorded in an S3
**state store** instead — one JSON record per `(stack, region)` pair, under
`s3://<bucket>/cdkd/<stackName>/<region>/state.json`. That record is the
source of truth for every later operation: what a diff compares against, what
a drift check baselines on, and what a destroy walks to know which physical
resources to delete.

The consequence worth knowing is that this store is addressable on its own.
CloudFormation ties every operation to a stack you name; the cdkd state store
holds the whole estate in one place, so `cdkd state` can enumerate it, act on
several stacks at once, or — with `cdkd state destroy --all` and
`cdkd state refresh-observed --all` — act on every stack in the bucket:

```bash
cdkd state info                     # which bucket cdkd is using, and how much is in it
cdkd state list                     # every stack in the bucket, not just this app's
cdkd state list --tree              # nested-stack parents and children
cdkd state show MyStack             # one record in full, including resource properties
cdkd state destroy --all --yes      # tear the entire estate down in one command
```

## No CDK app required

None of these commands synthesizes. They read the bucket, so they work from a
machine that never had the repository — which is what makes them the cleanup
path for a CI runner whose branch has been deleted, or for a stack whose source
is simply gone. `cdkd state destroy` runs the identical deletion pipeline as
`cdkd destroy`, sourced from the record rather than from a fresh synth.

The price of that independence is that stacks are identified by their physical
CloudFormation names — the CDK display paths and wildcards `cdkd destroy`
accepts are not available without an app to resolve them against.

## Removing a record is not deleting resources

Two operations look similar and are not: `cdkd state destroy` deletes the AWS
resources and then the record, while `cdkd state orphan` deletes only the
record and leaves everything running. Orphaning is the escape hatch for a
resource cdkd can no longer manage — and it is a sharp one, because the
resources it leaves behind are no longer tracked by anything. See
[Orphan vs Destroy](orphan-vs-destroy.md) for which of the four cleanup
commands applies.

## Records outlive the binary that wrote them

The record carries a schema version, and every older version is read and
upgraded in memory by the current binary; the next write persists the new
shape silently. Upgrading cdkd never asks you to migrate a record's *contents*.

Two things around the record are not covered by that. A record still on the
original pre-region key layout is upgraded by the next `cdkd deploy` — until
then, `cdkd state resources`, `show`, and `refresh-observed` refuse it and say
so. And the bucket *name* changed once: installations predating the region-free
default need a one-time `cdkd state migrate` per region, which both the
deprecation warning and `cdkd state info` point at.

See **[`cdkd state`](cli-state.md)** for the full reference: every subcommand,
its flags, the confirmation and lock behavior, and the exit codes. The record
schema itself — every field, the v1 → v9 history, and the lock mechanism — is
documented in [State Management](state-management.md).
