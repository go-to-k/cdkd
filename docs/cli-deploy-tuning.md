---
title: "cdkd deploy: tuning"
description: "cdkd deploy tuning flags: per-resource warn and timeout budgets, physical name prefixing, observed-state capture, VPC dependency relaxation, and CDK annotation handling."
---

# cdkd deploy: tuning

These `cdkd deploy` flags change how long one resource may run, what cdkd
names resources, how much it records for drift detection, and how it orders
VPC work. None of them change what the template means. For the full list of
deploy flags, see [cdkd deploy](cli-deploy.md#options).

```bash
# abort a stuck resource sooner
cdkd deploy MyStack --resource-timeout 10m
cdkd deploy MyStack --resource-timeout AWS::RDS::DBCluster=1h30m

# prefix declared names with the stack name
cdkd deploy MyStack --prefix-user-supplied-names

# skip the drift baseline
cdkd deploy MyStack --no-capture-observed-state

# keep CDK's VPC route ordering
cdkd deploy MyStack --no-aggressive-vpc-parallel

# fail on CDK warning annotations too
cdkd deploy MyStack --strict
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

Some of these flags work on other commands too:

| Flags | Also accepted by |
| --- | --- |
| `--resource-warn-after`, `--resource-timeout` | `cdkd destroy`, `cdkd state destroy` |
| `--strict`, `--ignore-errors` | `cdkd synth` |
| The rest | `cdkd deploy` only |

## Per-resource timeout

cdkd puts a time limit on every create, update and delete, so that one stuck
resource cannot block the run forever. Two flags set the limit:
`--resource-warn-after` prints a warning, and `--resource-timeout` gives up.
They apply to `cdkd deploy`, `cdkd destroy` and `cdkd state destroy`.

```bash
# Warn sooner and give up sooner in a fast dev loop
cdkd deploy MyStack --resource-warn-after 90s --resource-timeout 10m

# Keep the default, and raise it only for types known to take longer
cdkd deploy MyStack \
  --resource-timeout AWS::CloudFront::Distribution=1h \
  --resource-timeout AWS::RDS::DBCluster=1h30m
```

When an operation passes the `--resource-warn-after` threshold, its progress
line gains `[taking longer than expected, Nm+]` and cdkd logs a `WARN` line.
The operation keeps running.

When an operation passes the `--resource-timeout` threshold, the deploy or
destroy fails. The usual handling of a failure follows: a deploy rolls back,
and state is kept. The error names the resource, its type, the region, the
elapsed time and the operation:

```text
Resource MyBucket (AWS::S3::Bucket) in us-east-1 timed out after 30m during CREATE (elapsed 30m).
This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or
slow ENI provisioning. Re-run with --resource-timeout AWS::S3::Bucket='<DURATION>'
to bump the budget for this resource type only, or --verbose to see the
underlying provider activity.
```

### Value format

Both flags are repeatable, and each use takes one of two forms:

| Form | Example | Effect |
| --- | --- | --- |
| A bare duration | `30m` | Sets the default for every type. The last one wins. |
| `TYPE=DURATION` | `AWS::CloudFront::Distribution=1h` | Overrides the default for that type only. |

A duration is a number followed by `s`, `m` or `h`, such as `30s`, `90s`, `5m`
or `1.5h`. cdkd rejects these values before anything runs:

- a zero or negative duration, or one with a missing or unknown unit;
- a `TYPE` that does not look like `AWS::Service::Resource`;
- a warn threshold that is not less than its timeout, for the default or for
  one type.

If you lower `--resource-timeout` below `5m` and pass no
`--resource-warn-after`, cdkd lowers the warn threshold to
`min(5m, half the timeout)` and logs the value it chose.

### Which limit applies to a resource

A `TYPE=DURATION` override always wins. Without one, cdkd compares your
default with a minimum it keeps for certain slow types, and uses the larger of
the two.

| Types | Built-in minimum |
| --- | --- |
| `AWS::CloudFormation::CustomResource` | 1 hour |
| `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` | 30 minutes |
| Slow types such as `AWS::OpenSearchService::Domain`, and Redshift, ElastiCache and RDS clusters | 60 minutes |

The minimums exist for these reasons:

- cdkd polls an asynchronous custom-resource handler (the `isCompleteHandler`
  pattern) for up to an hour.
- A DynamoDB table delete stacks several polling waits that share one
  allowance.
- Deleting one of the slow types routinely takes 15 to 30 minutes.

The default is `30m` and not `1h` so that one stuck resource of an ordinary
type does not hold the stack for an hour.

#### Edge cases

- **Custom resources get their full hour under the default `30m`.** To make
  them abort sooner, name the type:

  ```bash
  cdkd deploy MyStack --resource-timeout AWS::CloudFormation::CustomResource=5m
  ```

- **A minimum applies to the type, whatever the operation.** The DynamoDB
  minimum exists for deletes, but `--resource-timeout 5m` does not shorten a
  table's create or update limit either. Use
  `--resource-timeout AWS::DynamoDB::Table=5m` for that.
- **The 60-minute minimum also covers resources routed through Cloud
  Control.** Cloud Control is the AWS API cdkd uses for resource types it has
  no direct support for. cdkd normally stops polling it after 15 minutes. For
  the slow types, the minimum raises that to 60 minutes, so a slow delete is
  not cut off early.

### Waits under `--full-wait`

`--resource-timeout` also reaches the waits that
[`--full-wait`](cli-deploy-waits.md#what-full-wait-adds) adds, so that a wait
does not give up before the limit you raised:

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

With `--prefix-user-supplied-names`, cdkd puts the stack name in front of the
declared name, which gives `MyStack-my-role`. The flag affects only the types
in the first row:

| Types | Default | With the flag |
| --- | --- | --- |
| IAM Role, User, Group, InstanceProfile, ManagedPolicy; ELBv2 LoadBalancer, TargetGroup | `my-role` | `MyStack-my-role` |
| Lambda Function, S3 Bucket, SNS Topic, SQS Queue, DynamoDB Table, Logs LogGroup, Events Rule, and the rest | `my-bucket` | No effect |
| Any type, when you declared no name | `MyStack-LogicalId-<hash>` | No effect |

Names that cdkd generates keep the stack-name prefix either way, because the
prefix is what makes them unique across stacks.

### Where to set it

| Where | Setting |
| --- | --- |
| Command line | `--prefix-user-supplied-names` |
| Environment | `CDKD_PREFIX_USER_SUPPLIED_NAMES=true` |
| `cdk.json` | `context.cdkd.prefixUserSuppliedNames: true` |

cdkd uses the first one that is set, in that order.

```json
{
  "context": {
    "cdkd": { "prefixUserSuppliedNames": true }
  }
}
```

### What the flag does not do

- **It cannot be limited to one resource.** cdkd decides it once per deploy,
  and it applies to every name generated in that run.
- **It does not rename an existing resource.** The name is recorded as the
  resource's physical ID, so changing the setting later makes cdkd propose a
  replacement.

### Edge cases

- **Rollback after a failed deploy.** A deploy that fails records the setting
  in its rollback journal, the file in the state bucket that lists what the
  failed deploy did. [`cdkd rollback`](cli-rollback.md) then creates resources
  again under the names that deploy would have used, and you do not pass the
  flag again.
- **The deprecated opposite flag.** `--no-prefix-user-supplied-names`,
  `CDKD_NO_PREFIX_USER_SUPPLIED_NAMES` and
  `context.cdkd.noPrefixUserSuppliedNames` ask for what is already the
  default. Setting one prints a deprecation warning and changes nothing.
- **A stack first deployed before v0.94.0.** Earlier versions prefixed
  declared names by default, so the first deploy on a newer version proposes
  replacements. See
  [cdkd deploy: names prefixed before v0.94.0](cli-deploy-tuning-name-migration.md).

## `--no-capture-observed-state`

After each create or update succeeds, `cdkd deploy` reads the resource back
from AWS and records its current properties in state. That record is the
**drift baseline**: the picture of the resource that
[`cdkd drift`](drift.md) later compares AWS against.
`--no-capture-observed-state` skips the read.

```bash
cdkd deploy MyStack --no-capture-observed-state
```

Without the baseline, drift can compare only the properties you put in the
template. A change made in the console to a property you never set is then
invisible. Use the flag when deploy speed matters more than that.

The capture costs little. The reads run in the background, and the deploy
waits for the outstanding ones once, just before the final state save. That
adds roughly 200 to 300 ms in total.

To turn the capture off for a whole project, set it in `cdk.json`:

```json
{
  "context": {
    "cdkd": { "captureObservedState": false }
  }
}
```

The command-line flag wins over `cdk.json`, and `cdk.json` wins over the
default of `true`.

### Refreshing the baseline without deploying

To record a fresh baseline for resources that no upcoming deploy will touch,
run:

```bash
cdkd state refresh-observed MyStack
```

### Edge cases

- **Resources recorded by cdkd before v0.47.** Those records have no baseline.
  The first deploy that loads such a record fills the baseline in, with the
  same background reads, and later deploys are unaffected.
  `--no-capture-observed-state` skips this as well.
- **One read that the flag does not skip.** When a
  [`NoEcho` custom resource](state-management-secrets.md#custom-resource-responses-marked-noecho)
  runs again, and another resource holds its value in a property that cannot
  change in place, cdkd reads that resource back to decide whether it must be
  replaced. cdkd compares the result in memory and never stores it.

## `--no-aggressive-vpc-parallel`

By default cdkd starts work on a Lambda function in a VPC without waiting for
the private subnet's NAT route. `--no-aggressive-vpc-parallel` restores the
order that CDK asked for.

```bash
cdkd deploy MyStack --no-aggressive-vpc-parallel   # keep CDK's ordering
```

The background is that CDK adds defensive `DependsOn` edges from VPC Lambdas,
and from the resources around them, onto the private subnet's default route
and route-table association. cdkd drops those edges by default, so work that
does not need the route can start while the NAT gateway is still coming up.

The case that gains most is a CloudFront distribution whose origin is a Lambda
Function URL. With the edges dropped, the distribution and the NAT route are
created in parallel. How much time that saves depends on the wait mode:

| Wait mode | With the edges dropped |
| --- | --- |
| `--full-wait` | The deploy takes the longer of the NAT and CloudFront waits, not their sum. |
| default | The deploy finishes at about the same time, but CloudFront propagation starts minutes earlier. |

Dropping the edges is safe because the calls that use a VPC Lambda during a
deploy accept the function while its network interface is still being
provisioned. `CreateFunctionUrlConfig`, `AddPermission` and
`CreateEventSourceMapping` all succeed. A Lambda-backed custom resource, which
invokes the function, waits for the function to report `Active` first,
whatever this flag says.

### When to opt out

- **A custom resource invokes a VPC Lambda indirectly**, through SNS or as a
  Step Functions task, and you want the NAT route up before the function is
  hit. cdkd's own `Active` wait covers only a Lambda used directly as the
  `ServiceToken`.
- **You want to avoid a slow rollback.** Suppose a Lambda's network interface
  fails to provision after the deploy has started creating a distribution
  against its Function URL. The rollback then has to delete both, and deleting
  a distribution takes around five minutes.

### Which edges are dropped

cdkd drops only the `DependsOn` edges between these type pairs. It leaves
`Ref` and `Fn::GetAtt` edges alone, and every other `DependsOn` as well.

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
does: an error annotation stops the run, and a warning or info annotation is
printed.

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

Which stacks cdkd checks depends on the command:

- `cdkd deploy` checks the stacks it will deploy, including dependencies it
  pulled in, before it changes anything in AWS. An error annotation on a stack
  outside that selection does not block the deploy, as with `cdk deploy`.
- `cdkd synth` checks every stack, or only the stack you named.
- `cdkd diff`, `cdkd list`, `cdkd import` and the other commands that
  synthesize do not fail on error annotations.

### `--strict`

`--strict` makes a warning annotation fail the run too. The run prints
`Found warnings (--strict mode)` and exits non-zero. Info messages never fail
a run. When errors and warnings are both present, the run fails with
`Found errors`.

### `--ignore-errors`

`--ignore-errors` prints every annotation but never fails the run. As the CDK
CLI says of its own flag, this ignores synthesis errors, "which will likely
produce an invalid deployment". When you pass `--strict` as well, `--strict`
wins, and both warnings and errors fail the run.

## Related

- [cdkd deploy](cli-deploy.md): every deploy flag, and the wait modes
- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): the guards and their escape hatches
- [cdkd destroy](cli-destroy.md): the destroy side of the timeout flags
- [Drift Detection](drift.md): what the observed-state baseline is for
