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

cdkd enforces this with two checks. They are a safety net against an
accident, not an access control: an identity that can write the state bucket
can defeat both.

### A create never takes over a resource it cannot account for

The SDK creates of these types hand back, or overwrite, an existing resource
of the same name instead of failing: `AWS::SQS::Queue`, `AWS::SNS::Topic`,
`AWS::Logs::LogGroup`, `AWS::CloudWatch::Alarm`, `AWS::Events::Rule`,
`AWS::S3::Bucket`, `AWS::ECS::Cluster`,
`AWS::ElasticLoadBalancingV2::LoadBalancer`,
`AWS::ElasticLoadBalancingV2::TargetGroup` and
`AWS::StepFunctions::StateMachine`. Every other type's create fails on a
taken name (or matches only its own idempotency token), and a create through
Cloud Control refuses an existing name.

When one of those creates would use a name cdkd generated, cdkd looks the name
up first. If a resource already holds it, the create goes ahead only when this
stack's own evidence names that resource:

- its state record (under any logical id), or its rollback orphans;
- its rollback journal: a completed operation, or a failed one that recorded
  the resource's physical id;
- its create-token ledger, which records the names of the deploy's planned
  creates as the stack's intent, one write per resource type after the
  approval prompt and under the deploy's lock, before the first of that
  type's creates is sent, so a
  re-run after a crash between a create and its record takes the resource
  back. When the deploy ends, it drops the intents of creates that were not
  sent, that came back (their resource is then in the record, or the
  rollback deleted it), or that AWS rejected outright (a 4xx such as a
  validation error); an intent stays only for a create whose outcome is
  unknown (a crash, a timeout, a 5xx), stamped with when that create came
  back failed. An intent licenses only a holder created no earlier than it
  was written and, once its create came back failed, no later than that,
  for a type that reports a creation time (a creation time this identity is
  not granted to read counts as none); for one that does not, an intent
  whose create came back failed licenses nothing -- the create is refused,
  the refusal names that likely cause (this stack's own resource from that
  create), and it gives the `cdkd import` remedy -- while an intent a hard
  crash left for a create that was never sent licenses by name (a
  crash-only residual). If the deploy's end cannot drop the intents (the
  write is retried once), it records the run as ended at that moment, so
  they are bounded as below; only if that write fails too does the residual
  extend past a crash, and the deploy warns. When
  the re-run knows when the crashed run stopped -- it took over that run's
  expired lock, or `cdkd force-unlock` released it, and the bound is the
  lock's last renewal plus its renewal interval (two minutes at the default
  TTL), since the run kept creating between renewals -- the intent
  licenses only a holder created by then, and for a type without a creation
  time it licenses nothing: the create is refused with the `cdkd import`
  remedy rather than taking a name another backend may have created since.
  A run still alive whose lock renewals keep failing can create past that
  bound; those resources of its own are refused on a later re-run, with the
  `cdkd import` remedy, never adopted;
- `retained.json`, the resources this stack let go of under this prefix while
  they still exist (`RemovalPolicy.RETAIN`): kept by `cdkd destroy`, or by a
  deploy that removed them from the template. The next deploy under the same
  prefix that creates them again takes them back, and drops them from that
  list once its record names them. Another prefix or another bucket does not
  see the list, so a redeploy there is refused. A deploy records what it
  kept in one write when it ends, beside its final state save; a destroy,
  once its record is gone, beside the marker's release. A crash before that
  write -- after a deploy's partial state save already dropped the
  resource's row, or after a destroy deleted its record -- leaves the kept
  resource in neither the record nor the list: its re-create is then refused
  with the `cdkd import` remedy (the safe direction). `cdkd state orphan` empties
  it, with or without a record left, and so does a destroy that keeps nothing:
  the empty list is a tombstone, never deleted. One destroy (or orphan) by this
  cdkd therefore ends the older-cdkd history license below for that stack and
  region for good;
- only when this prefix has NO `retained.json` for the stack (it was last
  destroyed by an older cdkd), this prefix's own history: one of the newest 10
  earlier versions of the stack's record that names the resource with a
  Retain policy (needs a versioned state bucket and `s3:ListBucketVersions` /
  `s3:GetObjectVersion`; a custom bucket without versioning has none), or the
  event history's newest 20 runs, where a `RESOURCE_RETAINED` row follows a
  create that recorded the resource's physical id (no extra permission). A
  nested stack's rows are read from its top-level stack's runs. Read only for
  a held name nothing else licenses.

A kept resource (`retained.json`, the history) licenses only a holder created
no later than it was kept (within a minute's clock skew), for a type that
reports a creation time (an SQS queue, a log group, a state machine, a load
balancer; a creation time this identity may not read counts as none): a
resource of the same name re-created later, after the kept one
was deleted out of band, is someone else's. The keep time in `retained.json`
is S3's clock (the write that recorded the entry), or this machine's clock at
that write when reading S3's back failed (a warning says so); an entry without
one, which only a hand edit produces, is trusted by its name alone.

Otherwise the deploy refuses before that create, as CloudFormation refuses a
name that already exists; that resource is not created (resources the deploy
created before are rolled back as with any failure). The message names the
holder, the likely cause (the stack is also deployed under another state
backend), and `cdkd import <stack> --resource <logicalId>=<physicalId>` for a
resource that is in fact this stack's own. This covers a second deployment in
another prefix, another bucket and another account's bucket alike. A name the
template declares is not looked up: declaring a name is choosing it.

**How it looks.** Every lookup is an exact read by name, never a listing: a
listing such as `ListQueues` is eventually consistent and can omit a resource
created a minute earlier. Where the service reads many names in one call it
is used: alarms 100 names per `DescribeAlarms` call (both alarm kinds), log
groups 50 per `DescribeLogGroups` call, ECS clusters 100 per
`DescribeClusters`, the calls in parallel. Queues (`GetQueueUrl`), topics
(`GetTopicAttributes`), rules (`DescribeRule`, on the rule's own event bus),
load balancers and target groups (`Describe...` by name), state machines
(`DescribeStateMachine`) and S3 buckets (`HeadBucket`; S3 has no batch read)
are read one name per call, in parallel (topics at most 4 at a time). A
resource being deleted (an `INACTIVE` ECS cluster, a `DELETING` state
machine, a queue or bucket already gone) reads as absent, so its create waits
out the deletion as before. A queue or bucket can still read as present for
up to a minute after its delete: a held, unlicensed one is read again every
10 seconds for about 65 seconds before its create is refused. Only that create
waits; each create's answer is ready as soon as its own type's lookup
answers. A rule
whose `EventBusName` is an intrinsic is looked up at its create, on the
resolved bus, never on the default one.

**What it costs.** Nothing on a redeploy: only a CREATE row is looked up, so an
update, a no-change deploy and a destroy make no lookup. For the creates, every
name is looked up once the plan is known, all at once, and each create waits
only for its own answer, so a first deploy pays about one round trip whatever
its size. Each API has one concurrency limit across the whole run,
`deploy --all` included, so a burst queues instead of throttling. The
intents cost one ledger write per resource type the deploy creates by name
(plus one for a name that frees up only later, and one per nested stack),
each written as soon as that type's lookups answer, so a slow type never
delays another type's creates; and the
success path's ledger cleanup runs beside the other writes that follow the
state save. Only when a `--require-approval` prompt ran (up front, or for a
replacement decided late) are the verdicts decided before its answer read
again, at once, in one batched pass per type; a deploy without a prompt
(`--yes` included, which asks no one) re-reads nothing, however long it runs. A re-read that cannot answer keeps
the earlier verdict, with a warning.

**Permissions.** The lookups need the read permission of each type a stack
creates: `sqs:GetQueueUrl`, `sns:GetTopicAttributes`,
`logs:DescribeLogGroups`, `cloudwatch:DescribeAlarms`, `events:DescribeRule`,
`ecs:DescribeClusters`, `elasticloadbalancing:DescribeLoadBalancers` /
`elasticloadbalancing:DescribeTargetGroups`, `states:DescribeStateMachine`,
and `s3:ListBucket` on the bucket for an S3 bucket. A lookup refused with 403
(S3 also answers 403 for a bucket another account owns) warns and creates,
as before the check existed; any other lookup failure refuses that create.
Two more permissions are optional, beside the registry's below:
`s3:ListBucketVersions` and `s3:GetObjectVersion` on the state bucket, for the
earlier record versions after an upgrade; without them that source licenses
nothing.

**After `cdkd state orphan`.** The orphan drops the record and empties the
kept list, so nothing this stack records names its resources any more: a
redeploy under the same prefix that would create one of them again by its
generated name is refused, and `cdkd import <stack> --resource
<logicalId>=<physicalId>` (the command the refusal prints) adopts it. This is
deliberate: the orphan is how a record is handed over, and cdkd does not take
the resources back on its own.

**What it does not see.** A holder created between the lookup and the create:
two first deploys of the same stack name at the same moment. In one bucket the
stack registry below serializes them; in two buckets that window remains, and
it lasts as long as the deploy runs: the verdicts are read again only after a
`--require-approval` prompt, never on a timer. And
a resource this stack let go of that no source above names any more -- for
example kept by a deploy of an older cdkd that removed it from the template,
once the history has rotated past it, or at once without the optional
permissions or bucket versioning: re-adding it is refused, and
`cdkd import <stack> --resource <logicalId>=<physicalId>` (the command the
refusal prints) adopts it. For a type that reports no creation time -- an S3
bucket, an SNS topic, a CloudWatch alarm, an EventBridge rule, an ECS cluster
and an ELBv2 target group -- a kept resource deleted out of band and
re-created by another backend under the same name is licensed by its name.
(`ListBuckets` reports a bucket's `CreationDate`, but AWS documents that it
can change when the bucket is edited, so it does not prove when the bucket was
made.) A bucket of the name in another region (S3 answers 301) is held. The
deletion-cooldown wait for a queue or bucket ends at once on Ctrl-C. And a create that threw a 4xx after its
provider had already made the resource without saying so loses its intent.

### The stack registry

For each top-level stack and region, the state bucket keeps one marker at
`_cdkd-registry/<region>/<stack>.json` naming the one state prefix that stack
belongs to. A nested stack is covered by its top-level stack's marker.

- A first deploy under a prefix claims the marker before its first provider
  call, with a conditional write that only succeeds when there is none. When
  the marker names another prefix, the deploy refuses as described below.
- `cdkd deploy` of a stack this prefix already records reads the marker only
  when its plan may destroy something: a resource deleted, a resource
  replaced, a resource that MAY be replaced, or a nested stack added or
  updated. The read runs before the `--require-approval` prompt. A plan that
  only creates resources, updates in place, or removes a retained resource
  makes no registry request. A replacement the deploy decides only on reading
  a resource back is checked then: a refusal keeps that resource, warns, and
  counts as unaddressed (exit 2 unless `--allow-unaddressed`).
- `cdkd destroy`, `cdkd state destroy` and `cdkd rollback` read it every time,
  and refuse when another prefix holds the stack, since its record may name
  the same resources. Once you know which record you are keeping, drop the
  other with `cdkd state orphan <stack> --stack-region <region> --state-prefix
  <prefix>`, which removes only the record (and releases the marker).
- A successful deploy about to delete a resource a failed earlier deploy left
  in its rollback journal, and a failed deploy's automatic rollback about to
  delete a resource it created, ask the same question first. When another
  prefix holds the stack, or the question cannot be answered, the resource is
  kept, with a warning, and stays in the journal (the successful deploy exits
  2).
- `cdkd destroy` removes the marker after removing the record, with a delete
  conditional on the version it read, so another prefix's re-claim in between
  is left alone (an endpoint without conditional deletes re-reads it right
  before an unconditional delete). The marker's delete (by the version this run
already read) and the retained-list write run beside the exports-index
update every destroy already makes, so they add no round trip of their own;
when this run claimed the marker itself, it re-reads it first.
Every other path that removes a stack's record
  removes the marker after it the same way, non-fatally: `cdkd state orphan`
  of a whole stack, `cdkd export` (the stack moves to CloudFormation),
  `cdkd rollback` of a first deploy that removes the record, and a first
  deploy that fails and leaves no record (it releases the marker it claimed,
  under its lock). So a marker names a prefix that records the stack. After
  `cdkd state orphan` a redeploy under the same prefix is still refused for
  the resources it would take back: that comes from the emptied kept list,
  not from the marker. `cdkd import` claims it (after the one-time scan below
  when no marker exists, and only once its record is saved), and
  `cdkd state migrate` copies it with the records.

A marker naming another prefix is weighed against what that prefix holds. A
record there that can own a resource (it lists resources or rollback-orphaned
resources, or its rollback journal holds a completed operation or a failed one
that recorded a physical id) refuses, naming the prefix and the remedies. Only
a lock there means a deploy is in progress: the command refuses and names
`cdkd force-unlock` for a lock a crashed run left. Nothing there at all is a
stale marker (its owner was removed without the marker, for example by an
older cdkd): this prefix claims it, but only after the one-time prefix scan
below answers clear, so a pair that predates the registry cannot hide behind
it. The empty record a failed first deploy
that created nothing leaves behind blocks nothing; the command prints a note
naming its prefix and the `cdkd state orphan` command that removes it.

**What it costs.** One read of one small object, once per command run, only on
the commands above (a destroy starts it beside its own state read); a first
deploy adds one conditional write, overlapped with its diff. A destroy ends
with two writes run beside the exports-index update it always made, so no
round trip of their own: `retained.json` -- what it kept, or, kept nothing,
the empty one (written only when there is none) -- and the marker's release, conditional on the version read earlier. Records written
before the registry existed have no marker: the first command that needs the
answer for such a stack lists the bucket's top-level prefixes once (50
listings in parallel, a single pass), then claims the marker, so every later
command is one read again. A dry run reads the registry and never writes it.

**Permissions.** `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on
`<bucket>/_cdkd-registry/*`. When S3 refuses the marker (403), or an
S3-compatible endpoint does not implement its conditional write
(`NotImplemented`), the command warns and falls back to the prefix listing,
whose own 403 also warns and continues. A read that fails otherwise (a server error, a record or marker that
will not parse) refuses, naming the object it could not read.

**What it does not see.** A record in a different bucket (the create check
above still refuses its takeovers, but a pair that predates this version keeps
both records until one is removed); a pair one stack name already formed
before this version under a prefix with a `/` before its end (`team/a`) when no
marker exists yet; and a deploy by an older cdkd, which neither claims nor
reads markers.

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
