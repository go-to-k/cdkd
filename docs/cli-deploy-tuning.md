---
title: "Deploy: tuning"
description: "cdkd deploy tuning flags: per-resource warn and timeout budgets, physical name prefixing, observed-state capture, VPC dependency relaxation, and CDK annotation handling."
---

# Deploy: tuning

These `cdkd deploy` flags change how long one resource may run, what cdkd names
resources, how much it records for drift detection, and how it orders VPC
work. None of them change what the template means. For the full list of
deploy flags, see [Deploy: waits & concurrency](cli-deploy.md#options).

```bash
cdkd deploy MyStack --resource-timeout 10m                 # abort a stuck resource sooner
cdkd deploy MyStack --resource-timeout AWS::RDS::DBCluster=1h30m
cdkd deploy MyStack --prefix-user-supplied-names           # prefix declared names with the stack name
cdkd deploy MyStack --no-capture-observed-state            # skip the drift baseline
cdkd deploy MyStack --no-aggressive-vpc-parallel           # keep CDK's VPC route ordering
cdkd deploy MyStack --strict                               # fail on CDK warning annotations too
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--resource-warn-after <duration>` or `<TYPE>=<duration>` | `5m` | Warn when one resource operation runs longer than this. Repeatable. |
| `--resource-timeout <duration>` or `<TYPE>=<duration>` | `30m` | Abort one resource operation that runs longer than this. Repeatable. |
| `--prefix-user-supplied-names` | `false` | Prefix physical names you declared with the stack name. |
| `--no-capture-observed-state` | capture on | Skip recording each resource's current AWS properties as the drift baseline. |
| `--no-aggressive-vpc-parallel` | relaxation on | Keep CDK's `DependsOn` edges from VPC Lambdas onto private-subnet routes. |
| `--strict` | `false` | Also fail when a stack carries CDK warning annotations. |
| `--ignore-errors` | `false` | Print CDK annotations but never fail the run. |

Which other commands accept them:

| Flags | Also accepted by |
| --- | --- |
| `--resource-warn-after`, `--resource-timeout` | `cdkd destroy`, `cdkd state destroy` |
| `--strict`, `--ignore-errors` | `cdkd synth` |
| The rest | `cdkd deploy` only |

## Per-resource timeout

`cdkd deploy`, `cdkd destroy` and `cdkd state destroy` put a wall-clock
deadline on every create, update and delete. A stuck Cloud Control poll, a hung
custom resource handler or a slow ENI release then cannot block the run
forever.

```bash
# Warn sooner and give up sooner in a fast dev loop
cdkd deploy MyStack --resource-warn-after 90s --resource-timeout 10m

# Keep the default, and raise it only for types known to take longer
cdkd deploy MyStack \
  --resource-timeout AWS::CloudFront::Distribution=1h \
  --resource-timeout AWS::RDS::DBCluster=1h30m
```

| Threshold | What happens when it passes |
| --- | --- |
| `--resource-warn-after` | The progress line gains `[taking longer than expected, Nm+]` and a `WARN` line is logged. |
| `--resource-timeout` | The deploy or destroy fails, and the usual rollback and state-preservation path runs. |

The timeout error names the resource, type, region, elapsed time and operation:

```text
Resource MyBucket (AWS::S3::Bucket) in us-east-1 timed out after 30m during CREATE (elapsed 30m).
This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or
slow ENI provisioning. Re-run with --resource-timeout AWS::S3::Bucket='<DURATION>'
to bump the budget for this resource type only, or --verbose to see the
underlying provider activity.
```

### Value format

Both flags are repeatable and take either form on each use:

| Form | Example | Effect |
| --- | --- | --- |
| A bare duration | `30m` | Sets the default for every type. The last one wins. |
| `TYPE=DURATION` | `AWS::CloudFront::Distribution=1h` | Overrides the default for that type only. |

Durations are a number followed by `s`, `m` or `h`: `30s`, `90s`, `5m`, `1.5h`.
cdkd rejects these before anything runs:

- a zero or negative duration, or one with a missing or unknown unit;
- a `TYPE` that does not look like `AWS::Service::Resource`;
- a warn threshold that is not less than its timeout, for the default or for
  one type.

If you lower `--resource-timeout` below `5m` and pass no
`--resource-warn-after`, cdkd lowers the warn threshold to
`min(5m, half the timeout)` and logs the value it chose.

### Which deadline applies to a resource

A `TYPE=DURATION` override always wins. Without one, the deadline is the
largest of your default and the minimum cdkd carries for that type:

| Types | Built-in minimum | Why |
| --- | --- | --- |
| `AWS::CloudFormation::CustomResource` | 1 hour | cdkd polls asynchronous handlers (the `isCompleteHandler` pattern) for up to an hour. |
| `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` | 30 minutes | A delete stacks several polling waits that share one allowance. |
| Slow types such as `AWS::OpenSearchService::Domain`, and Redshift, ElastiCache and RDS clusters | 60 minutes | Deleting one routinely runs 15-30 minutes. |

Consequences:

- Custom resources get their full hour under the default `30m`. To make them
  abort sooner, name the type:

  ```bash
  cdkd deploy MyStack --resource-timeout AWS::CloudFormation::CustomResource=5m
  ```

- A minimum is per type, not per operation. `--resource-timeout 5m` does not
  shorten a DynamoDB table's create or update deadline either. Use
  `--resource-timeout AWS::DynamoDB::Table=5m` for that.
- The 60-minute minimum also raises the Cloud Control provider's own poll
  limit, which is otherwise 15 minutes. A slow delete routed through Cloud
  Control is then not cut off before the deadline.

The default is `30m` and not `1h` so that one stuck resource of an ordinary
type does not hold the stack for an hour.

### Waits under `--full-wait`

`--resource-timeout` also reaches the waits inside cdkd's SDK providers, so an
inner wait does not give up before the deadline you raised. Under
[`--full-wait`](cli-deploy.md#what-full-wait-adds):

| Wait | Limit |
| --- | --- |
| ECS service steady state | The larger of 600 seconds and the resolved `--resource-timeout`. |
| CloudFront `Deployed` | The larger of 20 minutes and the resolved `--resource-timeout`. |

## `--prefix-user-supplied-names`

By default cdkd creates a resource with the exact name you declared in CDK
code. This role, in stack `MyStack`, is named `my-role`:

```ts
new iam.Role(this, 'DeployRole', {
  roleName: 'my-role',
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
```

`--prefix-user-supplied-names` prefixes declared names with the stack name on
the types below, giving `MyStack-my-role`.

| Types | Default | With the flag |
| --- | --- | --- |
| IAM Role, User, Group, InstanceProfile, ManagedPolicy; ELBv2 LoadBalancer, TargetGroup | `my-role` | `MyStack-my-role` |
| Lambda Function, S3 Bucket, SNS Topic, SQS Queue, DynamoDB Table, Logs LogGroup, Events Rule, and the rest | `my-bucket` | No effect |
| Any type, when you declared no name | `MyStack-LogicalId-<hash>` | No effect |

Names cdkd generates keep the stack-name prefix either way, because they rely
on it to be unique across stacks.

### Where to set it

| Where | Setting |
| --- | --- |
| Command line | `--prefix-user-supplied-names` |
| Environment | `CDKD_PREFIX_USER_SUPPLIED_NAMES=true` |
| `cdk.json` | `context.cdkd.prefixUserSuppliedNames: true` |

The first one set wins, in that order.

```json
{
  "context": {
    "cdkd": { "prefixUserSuppliedNames": true }
  }
}
```

### What the flag does not do

- It cannot be scoped to one resource. It is decided once per deploy and
  applies to every name generated in that run.
- It does not rename an existing resource. The name is recorded as the
  resource's physical ID, so changing the setting later proposes a
  replacement.

A deploy that fails records the setting in its rollback journal.
[`cdkd rollback`](cli-rollback.md) then creates resources again under the names
that deploy would have used, without the flag being passed again.

`--no-prefix-user-supplied-names`, `CDKD_NO_PREFIX_USER_SUPPLIED_NAMES` and
`context.cdkd.noPrefixUserSuppliedNames` are deprecated. They ask for what is
already the default, so setting one prints a deprecation warning and changes
nothing.

### Stacks deployed before v0.94.0

Changed in v0.94.0: declared names are used as written. Earlier versions
prefixed them on the types in the first row of the table above.

For a stack deployed under the old convention, the first deploy on v0.94.0 or
later proposes a replacement of every affected resource. The deployed name is
`MyStack-my-role`, the template now means `my-role`, and a name cannot change
in place. You have three options, most conservative first:

| Option | Effect |
| --- | --- |
| Pass `--prefix-user-supplied-names` for that stack | Nothing in AWS changes. |
| Accept the replacement | One replacement per affected resource, after the prompt below. |
| Remove the explicit `roleName`, `userName` and so on from your CDK code | Also one replacement, and CDK generates a stable name from then on. |

Before any provider call, `cdkd deploy` lists the resources that would be
replaced and asks:

```text
WARNING: --no-prefix-user-supplied-names will REPLACE 2 resource(s) whose
AWS physical name is still prefixed with the stack name:
  - MyRole (AWS::IAM::Role): from MyStack-my-role to my-role
  - MyLb (AWS::ElasticLoadBalancingV2::LoadBalancer): from MyStack-my-lb to my-lb
These resources will be REPLACED because the new naming convention drops
the stack-name prefix.

Continue? (y/N):
```

The prompt defaults to no, and declining exits with nothing modified. Pass
`-y` / `--yes` to confirm it in CI. Without it, a non-interactive run is
refused.

A resource is listed only when its physical name is exactly the prefixed form
of the name you declared. A name you built from the stack name yourself, such
as `` roleName: `${this.stackName}-role` ``, was already used as written and is
not listed. The check does nothing on a first deploy, on a stack that never
used the prefix, or when `--prefix-user-supplied-names` is set.

The stack lock is held while the prompt is open. Declining releases it.

## `--no-capture-observed-state`

After each create or update succeeds, `cdkd deploy` reads the resource back
from AWS and records its current properties in state. That snapshot is the
baseline [`cdkd drift`](drift.md) compares against.

```bash
cdkd deploy MyStack --no-capture-observed-state
```

Without the baseline, drift can compare only the properties you put in the
template. A console change to a property you never set is then invisible. Use
the flag when deploy speed matters more than that.

The capture costs little. The read-backs run in the background and the deploy
waits for the outstanding ones once, just before the final state save, which
adds roughly 200-300 ms in total.

To turn the capture off for a whole project, set it in `cdk.json`:

```json
{
  "context": {
    "cdkd": { "captureObservedState": false }
  }
}
```

The command-line flag wins over `cdk.json`, which wins over the default of
`true`.

One read-back is not affected by the flag. When a
[`NoEcho` custom resource](state-management.md#noecho-custom-resource-responses)
runs again and a resource holds its value in a property that cannot change in
place, cdkd reads that resource back to decide whether a replacement is
needed. That read is compared in memory and never stored.

### Resources with no baseline yet

A resource record written by a cdkd earlier than v0.47 has no baseline. The
first deploy that loads such a record fills the baseline in, with the same
background read-backs, and later deploys are unaffected.
`--no-capture-observed-state` skips this as well.

To refresh the baseline without deploying, for resources no upcoming deploy
will touch, run:

```bash
cdkd state refresh-observed MyStack
```

## `--no-aggressive-vpc-parallel`

CDK adds defensive `DependsOn` edges from VPC Lambdas, and from the resources
around them, onto the private subnet's default route and route-table
association. By default cdkd drops those edges, so work that does not need the
route can start while the NAT gateway is still coming up.

```bash
cdkd deploy MyStack --no-aggressive-vpc-parallel   # keep CDK's ordering
```

The case that gains most is a CloudFront distribution whose origin is a Lambda
Function URL. With the edges dropped, the distribution and the NAT route are
created in parallel.

Dropping the edges is safe because the deploy-time consumers of a VPC Lambda
accept the function while its ENI is still being provisioned:
`CreateFunctionUrlConfig`, `AddPermission` and `CreateEventSourceMapping` all
succeed. A Lambda-backed custom resource, which invokes the function, waits
for it to report `Active` first, whatever this flag says.

### When to opt out

- **A custom resource invokes a VPC Lambda indirectly**, through SNS or as a
  Step Functions task, and you want the NAT route up before the function is
  hit. cdkd's own `Active` wait covers only a Lambda used directly as the
  `ServiceToken`.
- **You want to avoid a slow rollback.** If a Lambda's ENI provisioning fails
  after the deploy has started creating a distribution against its Function
  URL, the rollback has to delete both, and deleting a distribution takes
  around five minutes.

How much the default saves depends on the wait mode:

| Wait mode | With the edges dropped |
| --- | --- |
| `--full-wait` | The deploy takes the longer of the NAT and CloudFront waits, not their sum. |
| default | The deploy finishes at about the same time, but CloudFront propagation starts minutes earlier. |

### Which edges are dropped

Only `DependsOn` edges between these type pairs. `Ref` and `Fn::GetAtt` edges
are untouched, and so is any other `DependsOn`.

| Depender (`from`) | Dependee (`to`) |
| --- | --- |
| `AWS::IAM::Role` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::IAM::Policy` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::Function` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::Url` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::EventSourceMapping` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |

The flag affects deploys only. `cdkd destroy` orders deletes the same way with
or without it.

## CDK annotation messages

`cdkd synth` and `cdkd deploy` handle CDK `Annotations` the way the CDK CLI
does.

```ts
import { Annotations } from 'aws-cdk-lib';

Annotations.of(this).addWarning('Bucket has no lifecycle rule');
Annotations.of(this).addError('A retention period is required');
```

| Annotation | Printed as | Effect |
| --- | --- | --- |
| `addError(...)` | `[Error at /Construct/Path] message` | The run prints `Found errors` and exits non-zero. Nothing is deployed. |
| `addWarning(...)` | `[Warning at /Construct/Path] message` | The run proceeds, unless `--strict` is set. |
| `addInfo(...)` | `[Info at /Construct/Path] message` | The run proceeds. |

Which stacks are checked:

| Command | Stacks checked |
| --- | --- |
| `cdkd deploy` | The stacks it will deploy, dependencies it pulled in included, before any AWS change. |
| `cdkd synth` | Every stack, or only the stack you named. |
| `cdkd diff`, `cdkd list`, `cdkd import` and the other commands that synthesize | They do not fail on error annotations. |

An error annotation on a stack outside a deploy's selection does not block the
deploy, as with `cdk deploy`.

### `--strict`

Also fail when any warning annotation exists, with
`Found warnings (--strict mode)` and a non-zero exit. Info messages never fail
a run. When errors and warnings are both present, the run fails with
`Found errors`.

### `--ignore-errors`

Print every annotation but never fail the run. As the CDK CLI says of its own
flag, this ignores synthesis errors, "which will likely produce an invalid
deployment". With `--strict` as well, `--strict` wins and both warnings and
errors fail the run.

## Related

- [Deploy: waits & concurrency](cli-deploy.md): every deploy flag, wait modes and the stack lock
- [Deploy: safety & compatibility flags](cli-deploy-safety.md): the guards and their escape hatches
- [Destroy flags & guards](cli-destroy.md): the destroy side of the timeout flags
- [Drift Detection](drift.md): what the observed-state baseline is for
