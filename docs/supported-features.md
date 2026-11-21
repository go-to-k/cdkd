---
title: Supported Features
description: "Which CloudFormation template features cdkd supports: intrinsic functions, pseudo parameters, policies and custom resources, and the one it ignores."
---

# Supported Features

cdkd deploys the CloudFormation template that your CDK app produces. Whether
your app works with cdkd therefore depends on which template features cdkd
understands. This page lists them, and starts with the few that behave
differently from CloudFormation.

Two related lists are on other pages. [Supported Resources](supported-resources.md)
has the resource types cdkd can deploy, and
[`cdkd local invoke`](local-invoke.md) has the Lambda runtimes it runs
locally.

## What behaves differently from CloudFormation

| Feature | Status | What cdkd does |
| --- | --- | --- |
| `UpdatePolicy` | ⚠️ Opt-in, partial | Skipped by default; honored with `--update-policy` (the Auto Scaling group policies and `CodeDeployLambdaAliasUpdate`) |
| `CreationPolicy` | ✅ | Waits for `cfn-signal` through the stack's signal receiver; see [`CreationPolicy` and `cfn-init`](#creationpolicy-and-cfn-init) |
| A resource type with no SDK provider and no Cloud Control support | Not supported | Fails the deploy with an error naming the type |

### `UpdatePolicy` is opt-in

`UpdatePolicy` is skipped by default; it is honored with `--update-policy`.
Skipped, cdkd applies an update in one step. Pass `--update-policy` to
`cdkd deploy`, or set
`"context": { "cdkd": { "updatePolicy": true } }` in `cdk.json`, to honor the
policies cdkd supports. `--no-update-policy` turns it off for one deploy when
`cdk.json` turns it on.

With `--update-policy`, cdkd honors:

- `AutoScalingScheduledAction` with `IgnoreUnmodifiedGroupSizeProperties: true`
  on an Auto Scaling group: an update sends only the `MinSize`, `MaxSize` and
  `DesiredCapacity` values the template changed, so a size a scheduled action
  set is kept. A size given as a dynamic reference (`{{resolve:...}}`) is
  always sent. The CDK `AutoScalingGroup` construct declares this policy
  unless `ignoreUnmodifiedSizeProperties` is `false`.
- `AutoScalingRollingUpdate`: when the update changes the group's
  `LaunchTemplate`, `LaunchConfigurationName`, `VPCZoneIdentifier` or
  `PlacementGroup`, cdkd updates the group and then replaces its instances
  with an instance refresh, waiting for it to succeed. See
  [Rolling updates as an instance refresh](#rolling-updates-as-an-instance-refresh).
- `AutoScalingInstanceRefresh`: when the update changes the group's
  `LaunchTemplate`, `MixedInstancesPolicy`, `VPCZoneIdentifier`,
  `AvailabilityZones`, `AvailabilityZoneIds` or `PlacementGroup`, cdkd starts
  the instance refresh the policy declares (its `Strategy` and `Preferences`)
  and waits for it to succeed. Missing percentages default as in
  CloudFormation: the group's `InstanceMaintenancePolicy`, else `100` / `110`
  (`Rolling`) or `90` / `100` (`ReplaceRootVolume`); `SkipMatching` defaults
  to `true`. A group that declares both this policy and
  `AutoScalingRollingUpdate` fails the update before anything changes, as in
  CloudFormation, with or without `AutoScalingReplacingUpdate`.
- `AutoScalingReplacingUpdate` with `WillReplace: true`: when the update
  changes one of the rolling update's four properties above, cdkd creates a
  new group, waits until the new group's desired capacity of instances is
  `InService` and healthy, then deletes the old group, the same create-first
  replacement it uses when an immutable property changes. The replacement is
  planned with the rest of the deploy, so `cdkd diff --update-policy` and
  `--require-approval` show it, and resources that refer to the group, such
  as a scaling policy or a lifecycle hook, move to the new group.
  `WillReplace: true` takes precedence over an `AutoScalingRollingUpdate` on
  the same group, as CloudFormation documents, and cdkd applies the same
  precedence over `AutoScalingInstanceRefresh`. A group the template names
  with `AutoScalingGroupName` cannot be created beside the old one, so the
  update fails before anything changes, as CloudFormation refuses to replace
  a custom-named resource. So does a group on a stack whose state was first
  written by a cdkd release without replacement names, since its new group
  would get the old one's name.

  The wait reads only the group's instance states: cdkd receives no
  `cfn-signal` and does not read target-group health. It runs under
  `--no-wait` too, because deleting the old group before the new one has
  instances drops the capacity. It is bounded like a refresh (below); when
  the new instances are not in service in time, cdkd deletes the new group,
  keeps the old one, and fails the update. A new group that would be created
  through Cloud Control, which cannot wait, is refused before anything
  changes, at the plan. An instance held in `Pending:Wait` by a lifecycle hook declared as
  its own resource never counts as in service, because the hook moves to the
  new group only after the group's create returns; such a replacement fails
  at the wait.

  A replacement cdkd cannot make (a named group, a stack without
  replacement names, the policy pair above, or a new group Cloud Control
  would create) stops `cdkd deploy` before
  any resource changes, and `cdkd diff --update-policy` reports it as a
  reason the deploy would refuse. A replacement that depends on a value
  read through `Fn::GetAtt`, such as a launch template's latest version, is
  shown as "may be replaced" and is refused, when it stands, at the group
  itself.
- `CodeDeployLambdaAliasUpdate` on a Lambda alias: when the update changes
  the alias's `FunctionVersion`, cdkd shifts the alias's traffic to the new
  version through a CodeDeploy deployment on the policy's deployment group,
  with its `BeforeAllowTrafficHook` and `AfterAllowTrafficHook`, and waits for
  it to succeed. See
  [Lambda alias traffic shifting](#lambda-alias-traffic-shifting).

The Auto Scaling policies apply when the group is updated through cdkd's SDK
provider; on a group updated through Cloud Control the refresh policies log
a warning that cdkd does not apply them. `AutoScalingReplacingUpdate` also
applies to a group recorded on Cloud Control, when its new group can be
created through the SDK provider; one whose new group would be created
through Cloud Control is refused at the plan, and `cdkd diff
--update-policy` reports it. cdkd decides from
the template and its own record: a refresh or a replacement starts only when
one of the properties listed for the policy changes, whatever launch
configuration the running instances have.

Every other `UpdatePolicy` is skipped, with or without the flag: cdkd applies
the update in one step.

#### Lambda alias traffic shifting

With `--update-policy`, an alias update that changes `FunctionVersion` runs in
this order:

1. cdkd reads the version the alias serves now, and fails the update before
   anything changes when the deployment group already runs a deployment
   (one started by hand, or one an interrupted deploy left): CodeDeploy runs
   one at a time. It also fails the update before anything changes when the
   alias cannot be read, or when the deployment group's configuration's
   traffic time, plus 5 minutes for the deployment's start-up and hooks, does
   not fit what the resource timeout leaves (a linear configuration such as
   10% every 10 minutes takes 90 minutes, 10% every 3 minutes 27); the error
   names the `--resource-timeout AWS::Lambda::Alias=<duration>` that fits.
2. It creates a CodeDeploy deployment whose AppSpec shifts the alias from that
   version to the new one, with the policy's hooks, and waits until it
   `Succeeded`. The deployment group's configuration (canary, linear or all at
   once) sets the pace.
3. It applies the alias's other changed properties, such as `Description` or
   `ProvisionedConcurrencyConfig`. CodeDeploy has already moved
   `FunctionVersion`, so it is not written again.

When the deployment does not succeed:

- A deployment that ends `Failed` or `Stopped` fails the update before step
  3, so the alias's other properties are unchanged. cdkd first waits for the
  deployment group's rollback deployment, if it has one, to finish; the error
  names the version the alias then serves and whether its traffic is still
  split.
- A deployment still running two minutes before the resource timeout
  (`--resource-timeout`, 30 minutes by default; a tenth of a timeout shorter
  than 20 minutes) is stopped with CodeDeploy's rollback and fails the
  update.
- Ctrl-C stops the deployment too, and waits up to a minute for CodeDeploy's
  rollback of it.

The policy's names and the other cases:

- `ApplicationName`, `DeploymentGroupName` and the hook names are resolved
  like properties, so `Ref`s to resources in the same stack work, and the
  alias waits for those resources to be created first.
- A secret there (a dynamic reference such as `{{resolve:...}}`, or a `NoEcho`
  parameter) fails the update before anything changes.
- An alias created or replaced is created at its version directly, as in
  CloudFormation.
- The deployment is waited for under `--no-wait` too; see
  [cdkd deploy: wait mode details](cli-deploy-waits.md#lambda-alias-codedeploy-deployment).
- `cdkd diff` shows the version change as an ordinary update.

The deployment needs `codedeploy:CreateDeployment` (with its dependent
actions `codedeploy:GetDeploymentConfig`, `codedeploy:GetApplicationRevision`
and `codedeploy:RegisterApplicationRevision`), `codedeploy:GetDeployment`,
`codedeploy:GetDeploymentGroup`, `codedeploy:GetDeploymentConfig`,
`codedeploy:ListDeployments`, `codedeploy:StopDeployment`,
`lambda:GetAlias` and `lambda:UpdateAlias`.

#### Rolling updates as an instance refresh

CloudFormation replaces `MaxBatchSize` instances at a time (default 1) while
keeping `MinInstancesInService` (default 0) in service, and pauses
`PauseTime` after each batch. An instance refresh is shaped by percentages of
the desired capacity instead, so cdkd translates:

| Rolling update | Instance refresh |
| --- | --- |
| `MinInstancesInService` below the desired capacity | Terminate, then launch, at most `MaxBatchSize` instances at a time (`MinHealthyPercentage` rounded down, `MaxHealthyPercentage` 100) |
| `MinInstancesInService` at or above the desired capacity | Launch up to `MaxBatchSize` extra instances before terminating (`MinHealthyPercentage` 100, `MaxHealthyPercentage` above 100, at most 200) |
| `PauseTime` | `InstanceWarmup`: AWS waits that long after a new instance is in service; no `PauseTime` is 0 |
| Every instance replaced | `SkipMatching: false` |

Where the percentages round, a batch can be smaller than `MaxBatchSize`, never
larger. `WaitOnResourceSignals` cannot be honored, because `cfn-signal`
signals a CloudFormation stack: cdkd logs a warning and waits `PauseTime`
(`PT5M` when unset) after each new instance instead. A refresh has no setting
for `MinActiveInstancesPercent`, `MinSuccessfulInstancesPercent` or
`SuspendProcesses`; when the template sets one, cdkd logs one line naming it.

A refresh that fails or is cancelled fails the update, and so does one still
running two minutes before the resource timeout (`--resource-timeout`, 30
minutes by default; a tenth of a timeout shorter than 20 minutes), which cdkd
cancels. The group already holds the new
launch template, so the deploy's rollback puts the previous one back and
starts a refresh. When only the launch template (or `MixedInstancesPolicy`)
moved, that refresh replaces only the instances on the new one; a subnet or
placement group change, or a group restored to a launch configuration,
replaces every instance. The rollback's refresh does not use the
`AlarmSpecification`, `CheckpointPercentages` or `CheckpointDelay` of an
`AutoScalingInstanceRefresh`, since the alarm may be what failed the forward
refresh. A deploy that would start a refresh on a group already running one
(an earlier `--no-wait` deploy's, or one started by hand) fails before
anything changes.
`--no-wait` starts the refresh and returns without checking its outcome. The
refresh needs the `autoscaling:StartInstanceRefresh`,
`autoscaling:DescribeInstanceRefreshes` and `autoscaling:CancelInstanceRefresh`
permissions.

#### Rollback

A rollback reverts an Auto Scaling group with the same rollout: a
rolling-update or instance-refresh group gets a refresh back to its previous
launch template, and a replaced group returns to the old group. Every recorded
size is sent again, because CloudFormation ignores
`IgnoreUnmodifiedGroupSizeProperties` during a rollback. CloudFormation rolls
back under the policy of the template before the update; cdkd keeps no
earlier template, so it uses the policy of the deploy it reverts. The two
differ only when that deploy also changed the group's `UpdatePolicy`.

A rollback reverts a Lambda alias the same way: an alias whose version moved
through CodeDeploy is shifted back to its previous version by a second
deployment on the same deployment group, which takes as long as the first.
An alias CodeDeploy's own rollback already returned to the previous version
is not shifted again. When a deployment ended mid-shift without CodeDeploy's
rollback, the alias still splits traffic; the rollback clears that split
before it reverts, unless the restored alias declares its own
`RoutingConfig`. Two cases switch the alias directly, without the gradual
shift and without running the hooks, where CloudFormation's rollback would
run the deployment: a rollback that cannot read the alias, and one whose
deployment configuration does not fit the resource timeout (the same check
as a deploy's). `cdkd rollback` takes no `--resource-timeout`, so it always
uses the 30-minute default, and a configuration that does not fit it is
switched directly there.
A rollback that meets a deployment the failed deploy started and left running
(its wait was cut short) stops it first; any other running deployment fails
the rollback, which can be run again once it ends.

`EnableVersionUpgrade` (OpenSearch domain) and `UseOnlineResharding`
(ElastiCache replication group) need no flag: cdkd changes an OpenSearch
domain's engine version and a replication group's shard count in place.

When a template declares a policy that `--update-policy` would honor and
neither flag nor the `cdk.json` key is set, cdkd prints a one-line hint on
each update the policy would apply to: for a rolling, instance-refresh or
replacing update, one that changes a property listed above, and for
`CodeDeployLambdaAliasUpdate`, one that changes the alias's
`FunctionVersion`.

### `CreationPolicy` and `cfn-init`

`cfn-signal --stack <name> --resource <id>` and `cfn-init --stack <name>
--resource <id>` talk to the CloudFormation API, which only a CloudFormation
stack can answer. A stack whose template declares a `CreationPolicy`
`ResourceSignal` or `AWS::CloudFormation::Init` metadata, read by signed
`cfn-init` / `cfn-signal` calls, gets a small
**signal receiver**: a CloudFormation stack with the cdkd stack's exact name,
tagged `cdkd:signal-receiver=true`, that lives as long as the cdkd stack.

```bash
cdkd deploy MyStack    # first deploy: creates the receiver stack "MyStack"
cdkd destroy MyStack   # deletes the receiver with the stack
```

| When | What happens |
| --- | --- |
| The first deploy that needs it | cdkd creates the receiver (about 30 seconds, once) and records it in state |
| Every deploy | `AWS::StackId` resolves to the receiver's ARN, so CDK's grant to call `cfn-signal` / `cfn-init` names it |
| A resource with a `ResourceSignal` is created or replaced | The receiver holds a wait condition under its logical id, with its signal count and `Metadata` |
| At the instance's boot | `cfn-init` reads the metadata and `cfn-signal` signals the receiver, as under CloudFormation |
| After the resource is created | Its dependents wait for the signals; a `FAILURE` signal or the policy's `Timeout` fails the deploy and rolls the resource back |
| `cdkd destroy` | Deletes the receiver after the stack's resources |
| `cdkd export` | Deletes the receiver right before the export's own CloudFormation stack takes the name |
| `cdkd state orphan` | Keeps the receiver and prints the command that deletes it |

A stack declaring neither never gets a receiver and makes no CloudFormation
call. Otherwise a deploy checks the receiver with a `DescribeStacks` call, and
updates it only when it creates, replaces or changes a resource that declares
a signal or `cfn-init` metadata. Secret dynamic references in `Metadata` stay
`{{resolve:...}}` tokens in the receiver's template, as in CloudFormation's.

> [!IMPORTANT]
> `cfn-init` and `cfn-signal` must sign their calls: pass `--role` (with the
> AWS CDK, `initOptions: { includeRole: true }`). Without it they call
> CloudFormation unsigned, which it answers only for instances of its own
> stacks, so cdkd cannot serve them: such a resource warns and is created
> without waiting, and does not get a receiver.

```ts
new ec2.Instance(this, 'Web', {
  // ...
  init: ec2.CloudFormationInit.fromElements(/* ... */),
  initOptions: { includeRole: true, timeout: Duration.minutes(10) },
});
```

A `WaitConditionHandle` with a `WaitCondition` that names it never needs a
receiver: the handle's URL is answered by cdkd's state bucket.

In these cases cdkd creates the resource without waiting and logs a warning;
the warning does not change the exit code or fail `--strict`:

- `cfn-init` / `cfn-signal` in its user data run without `--role` (above).

- A CloudFormation stack with the cdkd stack's name already exists and is not
  a receiver (for example the same app deployed with the AWS CDK CLI). cdkd
  never touches it.
- The credentials may not call CloudFormation.
- The resource is in a nested stack (its name cannot be a CloudFormation
  stack's).
- The resource's `Metadata` reads a `NoEcho` parameter or attribute, or
  something not created yet.
- The receiver stays mid-update or rolled back (for example after someone
  changed it by hand) for more than ten minutes. A receiver a killed deploy
  left waiting is cancelled, and one whose creation failed is made again.
- The stack's `cfn-init` metadata adds up to more than 51,200 bytes (the
  receiver's template is sent inline).
- The replacement is decided only while the deploy runs (an update the
  provider cannot make in place).
- `--dry-run`: no receiver is made, and the preview keeps cdkd's own
  `AWS::StackId`.

When a stack that already exists starts declaring one of these, its
`AWS::StackId` moves to the receiver's ARN once; resources reading it update
in that deploy.

A change to a resource's `Metadata` alone reaches the receiver with the next
deploy that changes that resource, since `cdkd` plans by properties. A
`CreationPolicy`-signalled `AWS::CloudFormation::WaitCondition` (no `Handle`)
that no receiver waits on is refused rather than created unenforced.

Signals may name the stack by `${AWS::StackName}` (as CDK's
`applyCloudFormationInit` and `signals` do) or `${AWS::StackId}`. An Auto
Scaling group's `MinSuccessfulInstancesPercent` is not applied: the receiver
waits for the full `Count`.

### Waiting for slow resources

cdkd's default waits for less than CloudFormation does, and two flags change
that. See [Choose a Wait Mode](wait-modes.md).

## Intrinsic Functions

| Function | Status | Notes |
| --- | --- | --- |
| `Ref` | ✅ | Resource physical IDs, parameters, pseudo parameters |
| `Fn::GetAtt` | ✅ | Resource attributes (ARN, DomainName, etc.) |
| `Fn::Join` | ✅ | String concatenation |
| `Fn::Sub` | ✅ | Template string substitution |
| `Fn::Select` | ✅ | Array index selection |
| `Fn::Split` | ✅ | String splitting; a non-string value is refused, as in CloudFormation |
| `Fn::If` | ✅ | Conditional values |
| `Fn::Equals` | ✅ | Equality comparison |
| `Fn::And` | ✅ | Logical AND (2-10 conditions) |
| `Fn::Or` | ✅ | Logical OR (2-10 conditions) |
| `Fn::Not` | ✅ | Logical NOT |
| `Fn::ImportValue` | ✅ | Strong cross-stack reference, resolved from cdkd state, then CloudFormation exports |
| `Fn::GetStackOutput` | ✅ | Weak cross-stack, cross-region or cross-account reference |
| `Fn::FindInMap` | ✅ | Mapping lookup |
| `Fn::GetAZs` | ✅ | Availability Zone list |
| `Fn::Base64` | ✅ | Base64 encoding |
| `Fn::Cidr` | ✅ | CIDR address block generation |

`Fn::Split` refuses an attribute whose value is already a list. Two such
attributes are `NameServers` of `AWS::Route53::HostedZone` and
`Ipv6CidrBlocks` of `AWS::EC2::VPC`. Remove the `Fn::Split` and use the
`Fn::GetAtt` directly.

[Use Another Stack's Outputs](cross-stack-references.md) explains
`Fn::ImportValue` and `Fn::GetStackOutput`, including how they read from
CloudFormation-managed stacks.

### S3 bucket `DomainName` outside the commercial partition

`Fn::GetAtt <Bucket>.DomainName` on an `AWS::S3::Bucket` returns S3's global
host, `<bucket>.s3.<url-suffix>`. This is the spelling `aws-cdk-lib` uses for
the `bucketDomainName` of a bucket imported with `Bucket.fromBucketAttributes`.
The global host serves the bucket in the commercial (`aws`) partition, but not
in `aws-cn` or `aws-us-gov`:

| Partition | `DomainName` cdkd returns | Reaches the bucket? |
| --- | --- | --- |
| `aws` | `<bucket>.s3.amazonaws.com` | Yes |
| `aws-cn` | `<bucket>.s3.amazonaws.com.cn` | No: the name does not resolve |
| `aws-us-gov` | `<bucket>.s3.amazonaws.com` | No: commercial S3 answers `NoSuchBucket` |

In `aws-cn` and `aws-us-gov`, reference `RegionalDomainName` instead
(`bucket.bucketRegionalDomainName` in CDK). It returns
`<bucket>.s3.<region>.<url-suffix>`, the bucket's regional endpoint, which
exists in those partitions too.

## Pseudo Parameters

| Parameter | Status |
| --- | --- |
| `AWS::Region` | ✅ |
| `AWS::AccountId` | ✅ (via STS) |
| `AWS::Partition` | ✅ |
| `AWS::URLSuffix` | ✅ |
| `AWS::NoValue` | ✅ |
| `AWS::StackName` | ✅ |
| `AWS::StackId` | ✅ |

## Resource Provisioning

cdkd deploys a resource in one of two ways. For more than 90 resource types
it has an SDK provider, which is cdkd's own code for calling that service's
API directly. These cover the most-used services: IAM, Lambda, S3, DynamoDB,
EC2, RDS, ECS, API Gateway, CloudFront, Step Functions, EFS, KMS, Cognito,
AppSync and more.

Any other CloudFormation resource type goes through the Cloud Control API,
AWS's generic resource API. If neither way supports a type, the deploy fails
with an error that names the type.

[Supported Resources](supported-resources.md) has the per-type table, and
[Provisioning Layers](provisioning-layers.md) explains how a resource is
routed.

## Template features

| Feature | Status | Notes |
| --- | --- | --- |
| CloudFormation Parameters | ✅ | Default values, type coercion |
| Conditions | ✅ | With logical operators |
| Cross-stack references | ✅ | `Fn::ImportValue`, with a CloudFormation `ListExports` fallback |
| Cross-region references | ✅ | `Fn::GetStackOutput`; cross-account with `RoleArn` |
| Dynamic References | ✅ | `{{resolve:secretsmanager:...}}`, `{{resolve:ssm:...}}` |
| DeletionPolicy: Retain | ✅ | Skips deletion of the retained resource |
| UpdateReplacePolicy: Retain | ✅ | Keeps the old resource on replacement |
| UpdatePolicy | ⚠️ Opt-in, partial | See [`UpdatePolicy` is opt-in](#updatepolicy-is-opt-in) |
| CreationPolicy | ✅ | See [`CreationPolicy` and `cfn-init`](#creationpolicy-and-cfn-init) |
| Custom Resources (SNS-backed) | ✅ | SNS Topic ServiceToken + S3 response |
| Custom Resources (CDK Provider) | ✅ | `isCompleteHandler` / `onEventHandler` async pattern detection |

### Secrets from dynamic references stay out of state

A dynamic reference to a secret, such as `{{resolve:secretsmanager:...}}`,
is replaced by the secret's value during a deploy. cdkd never stores that
value as plaintext. For a Secrets Manager secret or an SSM `SecureString`
parameter, cdkd keeps the unresolved `{{resolve:...}}` expression in state,
its record of what it deployed.

The same holds for nested stacks, in both directions. A secret passed down
through a nested stack's `Parameters` is redacted in the child stack's state.
A redacted output of a child stack is resolved again before cdkd sends it to
AWS.

## Deploy behavior

Rollback and drift detection have their own pages: [Roll Back a Failed Deploy](rollback.md)
and [Detect and Fix Drift](drift.md).

| Feature | Status | Notes |
| --- | --- | --- |
| JSON Patch updates | ✅ | Cloud Control updates send only what changed (RFC 6902) |
| Resource replacement detection | ✅ | 10+ resource types |
| DELETE idempotency | ✅ | A resource that is already gone counts as deleted |
| Asset publishing (S3) | ✅ | Lambda code packages |
| Asset publishing (ECR) | ✅ | Self-implemented Docker image publishing |
| Implicit delete dependencies | ✅ | VPC / IGW / EventBus / Subnet / RouteTable ordering |
| Stack dependency resolution | ✅ | Stacks a stack depends on are deployed first; `-e` skips them |
| Multi-stack parallel deploy | ✅ | Independent stacks deployed in parallel |
| Attribute enrichment | ✅ | CloudFront OAI, DynamoDB StreamArn, API Gateway RootResourceId, Lambda FunctionUrl, Route53 HealthCheckId, ECR Repository Arn |
| Null value stripping | ✅ | Null values are removed before Cloud Control calls |
| Retries | ✅ | Calls that fail with HTTP 429 or 503 are retried |

A write-only property is one AWS accepts but never returns, such as a
password. On a Cloud Control update, cdkd sends such a property again, using
the type's schema from `cloudformation:DescribeType` to find it. If the
schema cannot be read, the update still proceeds.

## Related

- [Supported Resources](supported-resources.md): per-type provider coverage
- [`cdkd local invoke`](local-invoke.md): the Lambda runtimes emulated
  locally
- [Use Another Stack's Outputs](cross-stack-references.md): how `Fn::ImportValue`
  and `Fn::GetStackOutput` resolve
- [Troubleshooting](troubleshooting.md): what to do when something is not
  supported
