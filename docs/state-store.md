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
  bucket's other prefixes, and refuses when one already records the same stack
  name and region.
- `cdkd deploy` of a stack this prefix already records checks the same, but
  only when its plan may destroy something: a resource deleted, a resource
  replaced, a resource that MAY be replaced (the deploy only learns once a
  value resolves), or a nested stack updated (whose own plan is only known once
  it runs; a nested stack deleted is a resource deleted). The check runs before
  the `--require-approval` prompt, so a refused deploy never asks first. A plan
  that only creates, updates in place, creates a nested stack, or removes a
  retained resource is not checked, and lists nothing. A replacement the deploy
  decides only on reading a resource back (a create-only value fed by a `NoEcho`
  parameter) is checked then: a refusal keeps that resource, warns, and lets
  the rest of the deploy go on.
- `cdkd destroy`, `cdkd state destroy` and `cdkd rollback` make the same check
  every time and refuse, since the other record may name the same resources —
  a rollback deletes what the failed deploy created, which for such a pair can
  be the other deployment's resource. Once you know which record you are
  keeping, drop the other with `cdkd state orphan <stack> --stack-region
  <region> --state-prefix <prefix>`, which removes only the record.
- A successful deploy that is about to delete a resource a failed earlier
  deploy left behind (recorded only in its rollback journal) asks the same
  question first. When another prefix records the stack, or the check fails,
  it keeps that resource, warns, and exits 2. When S3 refuses the check (403),
  it warns and deletes the resource as it did before the check existed.

A record under another prefix blocks only when it can own a resource: it lists
resources or rollback-orphaned resources, or its rollback journal holds a
completed operation or a failed one that recorded a resource's physical id (a
resource that failed deploy created). The empty record a failed first deploy
that created nothing leaves behind blocks nothing; the command prints a note
naming its prefix and the `cdkd state orphan` command that removes it.

**What the check costs.** One listing of the bucket's top-level prefixes. Then,
for each top-level prefix `p`, one listing of `p/<stack>/`; only where that
finds something are the stack's record, legacy record and rollback journal read
(three reads, in parallel). The trailing-slash forms `p/` are probed the same
way in a second pass, only when no `p` held the stack. So the work grows with
the number of top-level prefixes in the bucket. A deploy runs it only when a
check above needs it: for a first deploy it starts once synthesis has
finished, overlapping asset publishing and the lock; for a plan that destroys,
and before the deletion of a journaled orphan, it runs then. An ordinary
redeploy lists nothing. A destroy and a rollback run it each time; `destroy
--all` starts every stack's scan at once.

**Keep the bucket small.** Because that cost grows with the bucket's top-level
prefixes, a large shared bucket slows every destroy and rollback and every
deploy that deletes. Give the state a dedicated bucket rather than one shared
with unrelated data. In CI, a fresh `--state-prefix` per run with stable stack
names accumulates prefixes and leaves records behind that refuse the next first
deploy of the same stack name: prefer a stable prefix, or remove a finished
run's records (`cdkd state orphan <stack> --state-prefix <prefix>`, or a
destroy) before the next run.

**What it sees, and what it does not.** It sees a record under any top-level
prefix of the same bucket, including one written with a trailing slash
(`--state-prefix team-a/`) and the empty prefix. It does not see:

- a record in a **different bucket**;
- a prefix with a `/` before its end (`team/a`): only the first segment of each
  key is listed;
- a second deployment whose first deploy runs at the same moment as this one's,
  under another prefix: neither has a record yet when the other looks.

When S3 refuses the check — the bucket listing (an identity whose policy only
covers its own prefix) or a read under another prefix — the command warns
whenever the check runs, and continues. A read that fails otherwise (a server
error, a record that will not parse, an empty object, which cdkd never writes)
refuses, naming the object it could not read. A record whose `resources` is missing or not an
object proves nothing and blocks.

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
