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
several stacks at once, or — with `cdkd state refresh-observed --all` — act on
every stack in the bucket. Destroying is deliberately narrower: the bucket is
shared by every CDK app in the account, so `cdkd state destroy` deletes only
the stacks you name.

```bash
cdkd state info                     # which bucket cdkd is using, and how much is in it
cdkd state list                     # every stack in the bucket, not just this app's
cdkd state list --tree              # nested-stack parents and children
cdkd state show MyStack             # one record in full, including resource properties
cdkd state destroy StackA StackB    # destroy named stacks without the CDK app
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

## One stack name per account and region

A stack name identifies one deployment per account and region, as it does in
CloudFormation. The physical names cdkd generates for resources the template
leaves unnamed derive from the stack name and logical id alone, so a second
deployment of the same stack name in the same account and region asks AWS for
the same names — and where a create hands back the existing resource (an SQS
queue, a log group, a load balancer with identical settings) both records then
claim it. A failed deploy's rollback, or a destroy, of either one deletes it.

Deploying one stack name under two state backends — a different
`--state-prefix`, or a different `--state-bucket` — in one account and region
is therefore **unsupported**. To keep two copies of an app apart, give their
stacks different names (a CDK `Stage`, or a name suffix), not different
prefixes.

cdkd refuses the case it can see, before touching any resource:

- `cdkd deploy` of a stack that has no record under this prefix yet checks the
  bucket's other top-level prefixes, and refuses when one already records the
  same stack name and region. Only that first deploy pays for the listing,
  and it starts once synthesis has finished, overlapping the rest of the
  deploy's preparation (asset publishing, the lock), so what it adds is at most
  a fraction of a second. A stack this prefix already records issues one
  parallel round of reads of its own record and lists nothing.
- `cdkd destroy`, `cdkd state destroy` and `cdkd rollback` make the same
  check and refuse, since the other record may name the same resources — a
  rollback deletes what the failed deploy created, which for such a pair can
  be the other deployment's resource. Once you know which
  record you are keeping, drop the other with `cdkd state orphan <stack>
  --stack-region <region> --state-prefix <prefix>`, which removes only the
  record.

A record under another prefix blocks only when it can own a resource: it
lists resources or rollback-orphaned resources, or its rollback journal holds a
completed operation. The empty record a failed first deploy leaves behind
blocks nothing; the command prints a note naming its prefix and the
`cdkd state orphan` command that removes it.

What the check cannot see is covered only by this contract: a record in a
**different bucket**, and a prefix that itself contains `/` (only the
bucket's top-level prefixes are listed). When S3 denies the listing or a read,
the command warns and continues.

## Records outlive the binary that wrote them

The record carries a schema version, and every older version is read and
upgraded in memory by the current binary; the next write persists the new
shape silently. Upgrading cdkd never asks you to migrate a record's *contents*.

Two things around the record are not covered by that. A record still written
under the original key layout, from before keys carried a region, is rewritten
under the current one by the next `cdkd deploy` into that region. And the
bucket *name* changed once: installations predating the region-free default
need a one-time `cdkd state migrate` per region, which both the deprecation
warning and `cdkd state info` point at.

See **[`cdkd state`](cli-state.md)** for the full reference: every subcommand,
its flags, the confirmation and lock behavior, and the exit codes. The record
schema itself — every field, the v1 → v11 history, and the lock mechanism — is
documented in [State Management](state-management.md).
