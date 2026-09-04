---
title: "Deploy: tuning"
description: "Deploy-time tuning flags — VPC dependency relaxation, observed-state capture, physical name prefixing, per-resource warn/timeout budgets, and CDK annotation handling."
---

# Deploy: tuning

`cdkd deploy` takes a handful of flags that change how it orders work, how much
it records, what it names resources, and how long it lets a single resource run.
None of them change what the template means — they change what the deploy costs
and what it leaves behind. The rest of the deploy flags live under
[Deploy: waits & concurrency](cli-deploy.md) and
[Deploy: safety & compatibility flags](cli-deploy-safety.md).

```bash
cdkd deploy --no-aggressive-vpc-parallel        # keep CDK's defensive VPC ordering
cdkd deploy --no-capture-observed-state         # skip the drift baseline capture
cdkd deploy --prefix-user-supplied-names        # prefix declared names with the stack name
cdkd deploy --resource-warn-after 90s --resource-timeout 10m
cdkd deploy --resource-timeout AWS::CloudFront::Distribution=1h
cdkd deploy --strict                            # fail on warning annotations too
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--no-aggressive-vpc-parallel` | off (relaxation on) | Keep the CDK-injected defensive `DependsOn` edges from VPC Lambdas onto private-subnet routes. |
| `--no-capture-observed-state` | off (capture on) | Skip recording each resource's AWS-current properties as the drift baseline. |
| `--prefix-user-supplied-names` | off | Prefix user-declared physical names with the stack name. |
| `--no-prefix-user-supplied-names` | — | Deprecated. Already the default; setting it warns and changes nothing. |
| `--resource-warn-after <duration>` or `<TYPE>=<duration>` | `5m` | Warn when one resource operation has been running longer than this. Repeatable. |
| `--resource-timeout <duration>` or `<TYPE>=<duration>` | `30m` | Abort one resource operation that exceeds this. Repeatable. |
| `--strict` | off | Also fail when a stack carries CDK warning annotations. |
| `--ignore-errors` | off | Print CDK annotations but never fail the run. |

`--resource-warn-after` and `--resource-timeout` are also accepted by
`cdkd destroy` and `cdkd state destroy`. `--strict` and `--ignore-errors` are
also accepted by `cdkd synth`. The rest are deploy-only.

## `--no-aggressive-vpc-parallel`

CDK injects defensive `DependsOn` edges from VPC Lambdas — and from the IAM
Role / Policy, `AWS::Lambda::Url` and `AWS::Lambda::EventSourceMapping`
resources around them — onto the private subnet's default route and route-table
association. By default cdkd drops those edges, so downstream consumers can
start while the NAT gateway is still stabilizing. The consumer this matters most
for is a `AWS::CloudFront::Distribution` whose origin is a Lambda Function URL:
without the relaxation, creating the distribution waits for the NAT route; with
it, the two proceed in parallel.

The relaxation is safe because every deploy-time consumer of a VPC Lambda
accepts the function while its ENI is still being provisioned —
`CreateFunctionUrlConfig`, `AddPermission` and `CreateEventSourceMapping` all
succeed before ENI provisioning finishes. The one consumer that synchronously
invokes the function, a Lambda-backed Custom Resource, waits for the function to
report `Active` immediately before the invoke, regardless of this flag.

```bash
cdkd deploy --no-aggressive-vpc-parallel
```

### When to opt out

Opt out when your stack has a Custom Resource that synchronously invokes a VPC
Lambda **outside** cdkd's own `Active` wait — through SNS, or as a Step
Functions task — and you want CDK's strict ordering to guarantee the NAT route
is up before the function is hit. Most stacks do not need this: cdkd's Custom
Resource provider already covers the standard Lambda-ServiceToken case.

There is one other reason. If a Lambda's asynchronous ENI provisioning fails
*after* the deploy has already started a `CreateDistribution` against its
Function URL, the rollback has to delete both, and deleting a distribution takes
around five minutes on its own. Opting out keeps that worst case off the table.

How much the relaxation saves depends on your wait mode. Under
[`--full-wait`](cli-deploy.md#what-full-wait-adds), cdkd waits for the
distribution to reach `Deployed`, so the difference is a serial
NAT-then-CloudFront critical path versus the longer of the two. On the default
wait mode the distribution's create call returns in seconds, so the deploy
itself finishes at about the same time either way — but propagation starts
minutes earlier, because the create was issued without waiting for NAT.

### Which edges are dropped

Only `DependsOn` edges matching one of these type pairs. `Ref` and `Fn::GetAtt`
edges are untouched, and so is any `DependsOn` outside the list.

| Depender (`from`) | Dependee (`to`) |
| --- | --- |
| `AWS::IAM::Role` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::IAM::Policy` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::Function` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::Url` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::EventSourceMapping` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |

The relaxation is **deploy-only**. `cdkd destroy` orders deletes the same way
with or without the flag: the route `DependsOn` does not constrain delete-time
correctness, and the real destroy bottleneck — releasing a Lambda's hyperplane
ENIs — is handled separately.

## `--no-capture-observed-state`

Immediately after each create or update succeeds, `cdkd deploy` reads the
resource back from AWS and records its current properties on the state record.
That snapshot is the baseline [`cdkd drift`](drift.md) compares against. Without
it, drift can only compare what you templated, so a console-side change to a key
you never templated is invisible.

The readbacks are fire-and-forget: the deploy critical path never blocks on
them. The in-flight set is drained just before the final state save, so the cost
is roughly one readback's latency — around 200-300 ms in practice — not one per
resource.

```bash
# Skip the capture for one deploy
cdkd deploy --no-capture-observed-state

# Pin it off for the whole project, in cdk.json
# {
#   "context": {
#     "cdkd": { "captureObservedState": false }
#   }
# }
```

Highest wins: `--no-capture-observed-state` on the command line, then `cdk.json`
`context.cdkd.captureObservedState`, then the default `true`. With the capture
off, drift compares state-recorded properties only. Use the flag when deploy
speed matters more than drift fidelity.

### Backfilling the baseline after an upgrade

A stack deployed by cdkd earlier than 0.47 — the release where observed-state
capture shipped — has state records with no baseline at
all. The first deploy after the upgrade backfills them: when `cdkd deploy` loads
state and finds resources without one, it starts the same readbacks in parallel
with the rest of the deploy and drains them into state at the final save. The
critical path does not wait on them, the cost is again bounded by the longest
single readback, and it happens once — later deploys are unaffected.
`--no-capture-observed-state` skips the backfill along with the regular capture.

`cdkd state refresh-observed <stack>` is the manual equivalent, for refreshing
the baseline without deploying — useful for resources no upcoming deploy will
touch.

## `--prefix-user-supplied-names`

cdkd creates AWS resources with the **exact name you declared** in CDK code.
`new iam.Role(this, 'CRRole', { roleName: 'my-role' })` in stack `MyStack`
produces a role named `my-role`, and that holds for every resource type.

`--prefix-user-supplied-names` switches the affected types back to prefixing
those names with the stack name (`MyStack-my-role`). Auto-generated names — the
ones you did *not* declare — keep the prefix either way, because they rely on it
for cross-stack uniqueness.

```bash
# One invocation
cdkd deploy --prefix-user-supplied-names

# Per shell
export CDKD_PREFIX_USER_SUPPLIED_NAMES=true
cdkd deploy

# Per project, in cdk.json
# {
#   "context": {
#     "cdkd": { "prefixUserSuppliedNames": true }
#   }
# }
```

Highest wins: the `--prefix-user-supplied-names` flag, then
`CDKD_PREFIX_USER_SUPPLIED_NAMES=true`, then `cdk.json`
`context.cdkd.prefixUserSuppliedNames: true`, then the default (no prefix).

Two things the flag does not do. It is decided once per deploy and applied to
every name generated in that run — you cannot scope it to one resource. And it
controls only **what cdkd asks AWS to create**: once a resource exists, its name
is recorded as the state record's physical ID, and flipping the flag afterwards
does not rename it. It proposes a replacement instead — see below.

The old `--no-prefix-user-supplied-names` flag, its
`CDKD_NO_PREFIX_USER_SUPPLIED_NAMES` env var, and its
`context.cdkd.noPrefixUserSuppliedNames` cdk.json entry are deprecated: they now
say the same thing as the default, so setting any of them prints a deprecation
warning and changes nothing. Remove them from your config.

### Affected resource types

Only the types in the first row ever prefixed a user-declared name. Everything
else was always unprefixed and is unchanged by the flag.

| Types | Default | With `--prefix-user-supplied-names` |
| --- | --- | --- |
| IAM Role, User, Group, InstanceProfile; ELBv2 LoadBalancer, TargetGroup | `my-role` | `MyStack-my-role` |
| Lambda Function, S3 Bucket, SNS Topic, SQS Queue, DynamoDB Table, Logs LogGroup, Events Rule, and the rest | `my-bucket` | No effect — already unprefixed |
| Any type, name not declared in CDK code | `MyStack-LogicalId-<hash>` | No effect — prefix kept for uniqueness |

### Migrating from pre-0.94.0

Changed in v0.94.0: names you declare are used verbatim. Before that, cdkd
prefixed them on the types in the first row above and left every other type
alone — an inconsistency that surfaced through `cdkd export`, whose
CloudFormation import check rejected a template declaring `RoleName: 'my-role'`
against a deployed role actually named `MyStack-my-role`.

For a stack deployed under the old convention, the first deploy on 0.94.0 or
later proposes a **replacement** of every affected resource: the deployed name
is `MyStack-my-role` and the template now means `my-role`, which is an immutable
property change. Three ways out, most conservative first:

1. **Pin `--prefix-user-supplied-names`** for that stack. Nothing in AWS is
   touched.
2. **Accept the one-time replacement.** The pre-flight prompt below makes it
   explicit before anything runs.
3. **Drop the explicit `roleName` / `userName` / … from your CDK code** and let
   CDK generate the name. Also a one-time replacement, but the resulting name is
   stable from then on.

Because that replacement would otherwise be silent, `cdkd deploy` runs a
pre-flight check. When a state record holds an affected resource whose physical
name is exactly the prefixed form of the name you declared, the deploy lists
them and asks before any provider call runs:

```text
WARNING: --no-prefix-user-supplied-names will REPLACE 2 resource(s) whose
AWS physical name is still prefixed with the stack name:
  - MyRole (AWS::IAM::Role): MyStack-my-role -> my-role
  - MyLb (AWS::ElasticLoadBalancingV2::LoadBalancer): MyStack-my-lb -> my-lb
These resources will be REPLACED because the new naming convention drops
the stack-name prefix.

Continue? (y/N):
```

The prompt defaults to **no**, because the side effect is destructive.
Declining exits cleanly with nothing modified. Pass `-y` / `--yes` to confirm it
in CI; without it, a non-interactive run is refused rather than left hanging.

The match is exact, not a "starts with `MyStack-`" test, and that matters if you
follow the common convention of building the name from the stack name — setting
`roleName` to `${this.stackName}-role`, for instance. Such a name was
already taken verbatim, so its physical ID equals what the next deploy will ask
for, no replacement is pending, and it is not flagged. The check is also a no-op
on a first deploy, on a stack that never used the prefix, and whenever
`--prefix-user-supplied-names` is set.

The check reads the state cdkd has already loaded under the stack lock, so it
sees exactly what the diff will consume and no concurrent deploy can change it
in between. The lock is held while the prompt is open; declining releases it,
and accepting keeps it for the deploy that follows.

## Per-resource timeout

`cdkd deploy` and `cdkd destroy` (including `cdkd state destroy`) put a
wall-clock deadline on every individual CREATE / UPDATE / DELETE, so a stuck
Cloud Control polling loop, a hung Custom Resource handler, or a slow ENI
release cannot block the run forever.

| Option | Default | Description |
| --- | --- | --- |
| `--resource-warn-after <duration_or_type=duration>` | `5m` | Warn when one resource operation has been running longer than this. Repeatable. |
| `--resource-timeout <duration_or_type=duration>` | `30m` | Abort one resource operation that exceeds this. Repeatable. |

When the warn threshold passes, the live progress line gains a
`[taking longer than expected, Nm+]` suffix and a `WARN` line is logged — above
the live area on a terminal, on plain stderr otherwise. When the timeout passes,
the deploy or destroy fails and the usual rollback and state-preservation path
runs.

Durations are `<number>s`, `<number>m` or `<number>h` — `30s`, `90s`, `5m`,
`1.5h`. Zero, negative, missing-unit and unknown-unit values are rejected before
anything runs. Both flags take either form on each use:

- **A bare duration** (`30m`) sets the global default. The last one wins.
- **`TYPE=DURATION`** (`AWS::CloudFront::Distribution=1h`) overrides the global
  default for that type only.

`TYPE` must look like `AWS::Service::Resource`; anything else is rejected at
parse time. So is a warn threshold that is not less than its timeout, globally
or per type — `--resource-warn-after AWS::X=10m --resource-timeout AWS::X=5m` is
a parse error.

```bash
# Surface "still running" warnings sooner on a fast-feedback dev loop
cdkd deploy --resource-warn-after 90s --resource-timeout 10m

# Keep the global default tight, raise it only for resources known to take longer
cdkd deploy \
  --resource-timeout 30m \
  --resource-timeout AWS::CloudFront::Distribution=1h \
  --resource-timeout AWS::RDS::DBCluster=1h30m

# Force Custom Resources to abort earlier than their 1h self-reported cap
cdkd deploy --resource-timeout AWS::CloudFormation::CustomResource=5m
```

If you lower `--resource-timeout` below the inherited 5m warn default and do not
pass a matching `--resource-warn-after`, cdkd lowers the warn threshold for you
to `min(5m, half the timeout)` and logs the value it chose. Passing both flags
explicitly turns that off — and an explicitly reversed pair is a hard parse
error, not something cdkd repairs.

The timeout error names the resource, type, region, elapsed time and operation:

```text
Resource MyBucket (AWS::S3::Bucket) in us-east-1 timed out after 30m during CREATE (elapsed 30m).
This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or
slow ENI provisioning. Re-run with --resource-timeout AWS::S3::Bucket=<DURATION>
to bump the budget for this resource type only, or --verbose to see the
underlying provider activity.
```

### Why the default is 30m, not 1h

cdkd's Custom Resource provider polls asynchronous handlers (the
`isCompleteHandler` pattern) for up to an hour before giving up. Setting the
global default to 1h would let a single stuck resource of any other type hold
the stack for an hour, when no other type ever needs more than a few minutes.
30m catches stuck operations sooner, and the types that genuinely need longer
ask for it themselves — the next three sections.

### Custom Resource self-report

The Custom Resource provider reports its 1h polling cap to the deploy engine,
and the engine takes the larger of that and your global `--resource-timeout`. So
Custom Resources get their full hour without you having to remember
`--resource-timeout 1h`.

To make them abort sooner, pass an explicit per-type override:

```bash
cdkd deploy --resource-timeout AWS::CloudFormation::CustomResource=5m
```

A per-type override always wins over a provider's self-report. That is what it
is for.

### DynamoDB self-report

`AWS::DynamoDB::Table` and `AWS::DynamoDB::GlobalTable` both self-report 30
minutes, for the same reason: their DELETE path stacks several polling waits —
replica removal, an index-settle gate, an index-busy `DeleteTable` retry, and a
confirm-gone wait — that share one allowance sized to fit inside it.

At the default `--resource-timeout 30m` this changes nothing. But the
self-report is per **type**, not per operation, so lowering the global default
for fail-fast CI (`--resource-timeout 5m`) does not shorten these types' CREATE
or UPDATE deadline either. Use a per-type override to get the shorter deadline
back:

```bash
cdkd deploy --resource-timeout AWS::DynamoDB::Table=5m
```

### The slow-type floor

Some resource types are slow to create or delete no matter which provider
handles them. Deleting an `AWS::OpenSearchService::Domain` routinely runs 15-30
minutes, and Redshift, ElastiCache and RDS clusters are the same class. cdkd
carries a built-in 60-minute floor for these, folded into the same "largest
wins" resolution, so a plain `cdkd destroy` waits long enough for the delete to
actually finish instead of aborting mid-delete.

The floor also lifts the Cloud Control provider's internal poll cap, which is
otherwise a flat 15 minutes — so a Cloud-Control-routed slow delete is not cut
off before the outer deadline. An explicit
`--resource-timeout <TYPE>=<DURATION>` still wins over the floor.

### Inner waiters under `--full-wait`

`--resource-timeout` also reaches the waits inside cdkd's SDK providers, so an
inner waiter can never abort before the outer deadline you raised. Under
[`--full-wait`](cli-deploy.md#what-full-wait-adds):

- the ECS Service steady-state waiter's 600s cap becomes the larger of 600s and
  the resolved `--resource-timeout`;
- the CloudFront `Deployed` wait budget becomes the larger of 20 minutes and the
  resolved `--resource-timeout`.

## CDK annotation messages

`cdkd synth` and `cdkd deploy` surface CDK `Annotations` with the same semantics
as the CDK CLI.

`Annotations.of(scope).addError(...)` prints each error as
`[Error at /Construct/Path] message`, appends `Found errors`, and exits non-zero
**without deploying anything**. `deploy` checks the final stack selection —
including dependency stacks it pulled in automatically — before any AWS
mutation; an error annotation on a stack *outside* the selection does not block
the deploy, matching `cdk deploy`.

`addWarning(...)` and `addInfo(...)` print as `[Warning at /path] ...` and
`[Info at /path] ...`, and the run proceeds.

`cdkd synth` checks every synthesized stack, since it has no stack selection.
Other synth-driven commands — `diff`, `list`, `import` and friends — do not fail
on error annotations, matching the upstream CLI.

### `--strict`

Also fail when any warning annotation exists, with `Found warnings (--strict
mode)` and a non-zero exit. Info messages never fail a run. Errors still fail
with `Found errors`; when both are present, the error check wins.

### `--ignore-errors`

Display every annotation but never fail the run. As with the CDK CLI flag, this
"ignores synthesis errors, which will likely produce an invalid deployment".
Combined with `--strict`, strict wins and warnings and errors fail again —
again matching CDK CLI precedence.

## Related

- [Deploy: waits & concurrency](cli-deploy.md) — concurrency knobs and what "done" means per resource type
- [Deploy: safety & compatibility flags](cli-deploy-safety.md) — the guards and their escape hatches
- [Destroy flags & guards](cli-destroy.md) — the destroy side of the timeout flags
- [`cdkd drift`](drift.md) — what the observed-state baseline is for
