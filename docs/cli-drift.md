---
title: cdkd drift
description: "Detect differences between cdkd state and live AWS resources, then accept or revert them."
---

# cdkd drift

`cdkd drift` finds changes that were made to your resources outside cdkd, such
as an edit in the AWS console or a resource someone deleted. It reads every
resource cdkd manages back from AWS and reports where AWS no longer matches
what cdkd recorded at the last deploy. With `--accept` or `--revert`, the same
command resolves what it found.

```bash
# the single stack in state
cdkd drift

# one stack by name, with its nested stacks
cdkd drift MyStack

# every stack in the state bucket
cdkd drift --all

# disambiguate a multi-region name
cdkd drift MyStack --stack-region us-east-1

# machine-readable, for CI gating
cdkd drift --all --json

# state <- AWS (catch up to a console edit)
cdkd drift MyStack --accept --yes

# AWS <- state (undo a console edit)
cdkd drift MyStack --revert --yes

# preview either resolution
cdkd drift MyStack --revert --dry-run
```

`cdkd drift` works from cdkd state alone. It never synthesizes the CDK app, so
it takes no `--app` and runs without the app's source code.

## What drift compares

Drift compares two things: what cdkd state says each resource looks like, and
what AWS says it looks like now.

```text diagram=drift-compares
 cdkd state (S3)                 Live AWS
 the values AWS reported         a fresh read of each resource
 at the last deploy
            │                              │
            └──────────────┬───────────────┘
                           ▼
                       cdkd drift
            compares the keys state records
                           │
                           ▼
  clean / drifted / deleted / not compared / drift unknown
```

cdkd does not deploy through CloudFormation, so CloudFormation's own drift
detection has nothing to inspect. `cdkd drift` takes its place. The other
comparison cdkd offers is [`cdkd diff`](cli-diff.md), which compares your CDK
app with state and does not look at AWS.

The state side of the comparison is a snapshot. When cdkd deploys a resource,
it reads the resource back from AWS and stores what AWS returned. Because the
snapshot holds every property AWS reported, drift catches a console change to
a property you never set in your CDK code.

Some resources have no snapshot, for example one deployed with
`--no-capture-observed-state`. For those, drift compares against the
properties from your template, so it only catches changes to properties you
did set. A key added inside an object you set is not compared either, with one
exception: a policy document whose service returns it with no key of its own.
These are `PolicyDocument` on `AWS::IAM::Policy`, `AWS::IAM::ManagedPolicy`,
`AWS::IAM::RolePolicy`, `AWS::IAM::UserPolicy`, `AWS::IAM::GroupPolicy`,
`AWS::S3::BucketPolicy`, `AWS::SQS::QueuePolicy` and `AWS::SNS::TopicPolicy`,
`AssumeRolePolicyDocument` on `AWS::IAM::Role`, `KeyPolicy` on `AWS::KMS::Key`
and `ResourcePolicy` on `AWS::SecretsManager::ResourcePolicy`. A key only AWS
holds there, such as a `Condition` added to a single-object `Statement`, is
reported as drift. Some of these services return a single-object `Statement`
as a one-element list, and drift treats the two forms as the same value.
Inside a statement, drift also treats as one value the other spellings these
services return for what was sent: a one-element `Action`, `Resource` or
principal list and its single value, an account id under `Principal.AWS` and
its `arn:aws:iam::<id>:root`, `Effect` in another case, and a `Condition`
number or boolean and its string (`1.2` and `"1.2"`). A changed order, a
changed `Sid`, and a single `Condition` value against a one-element list are
still reported. They
also write `Version: 2008-10-17` into a document that omits `Version`, which is
what the omission means, so drift does not report that either. A live
`2012-10-17` against a template without `Version` is reported. You can record a
snapshot without redeploying:

```bash
cdkd state refresh-observed MyStack
```

Drift compares only the properties that state records. Fields AWS manages and
cdkd never stored, such as timestamps and generated identifiers, are ignored.
For a resource read through Cloud Control, the snapshot does record the
resource type's read-only fields (an `AWS::Location::Tracker`'s `UpdateTime`,
for example). Drift ignores every field the type's registry schema marks
read-only unless your template sets it, so `--revert` never tries to write one
back. Reading the schema needs `cloudformation:DescribeType`; without it, those
fields are compared too.

Secrets Manager reads a rotation schedule set as `rate(N days)` (CDK's
`automaticallyAfter`) back with `AutomaticallyAfterDays: N` as well, but
accepts only one of the two in a request. Drift ignores that echo beside the
expression, and `--revert` sends the expression alone.

For a resource managed through Cloud Control, a read never returns a
write-only value, so `--revert` generally sends the template's declared
values. A deploy can leave out a Lambda function's unchanged `Code`, because
it can compare against the previous template value. A revert takes its
previous value from the read, and so still sends a declared Lambda `Code`.
For a field AWS does not keep when it is left out, omitting it would apply the
field's default or make the update fail:

- a rotation schedule's `RotateImmediatelyOnUpdate: false` would become `true`
  and rotate the secret;
- an EventBridge connection's `AuthParameters` would arrive without its API key,
  and the update would fail.

Only the write-only fields come from the template. The rest of a property such
as `AuthParameters` is reverted to the recorded state, including a value you
took with `--accept`. The plan lists those properties on a line starting
`+ also sends the template's write-only fields of`.

A value that holds a dynamic reference (`{{resolve:...}}`) is sent resolved and
stays masked in the output. When cdkd cannot resolve it, it warns and sends
nothing for that property. When the field sits in a list whose items cannot be
matched to the template's one by one, cdkd warns and sends the template's whole
list, as a deploy does.

A field that Cloud Control refuses to receive again after creation is not sent.

Drift never compares a bucket's `NotificationConfiguration` unless your
template sets it on the bucket itself. CDK's `bucket.addEventNotification(...)`
does not set it. A `Custom::S3BucketNotifications` resource writes it after the
bucket is created, and that custom resource can be in another stack (for
example `s3.Bucket.fromBucketName(...).addEventNotification(...)`), or another
tool can write it. So drift does not report those notifications, and `--revert`
and `--accept` leave the live notifications alone. CloudFormation's drift
detection does not compare that property either, because the template does not
set it on the bucket. As in CloudFormation, a console edit to those
notifications is not reported.

An event bus's `Policy` is handled the same way. Unless your template sets
`Policy` on the `AWS::Events::EventBus` itself, drift does not compare it: an
`AWS::Events::EventBusPolicy` resource (CDK's `bus.addToResourcePolicy(...)`) or
another tool writes those statements. So `--revert` and `--accept` leave the
live policy alone, and a console edit to it is not reported.

An ECR repository's `RepositoryPolicyText` is compared only when your template
sets it on the `AWS::ECR::Repository`. Lambda can write a repository policy
itself when a function pulls its image from the repository, so drift does not
read a policy your template does not declare, and `--revert` and `--accept`
leave it alone.

A role, user or group whose template does not set `ManagedPolicyArns` or
`Policies` (or, on a role or user, `PermissionsBoundary`; on a user,
`Groups`) holds none in AWS either, so drift compares each of them anyway, on either baseline. A
managed policy, inline policy, boundary or group membership added outside
the stack is reported, and `--revert` removes that one member (one detach,
inline-policy delete, group removal or boundary delete each) without
replacing the principal. The revert plan lists each member it will remove.
A managed policy of the same stack whose template sets the list for that
kind of principal (`Roles`, `Users` or `Groups`) reports and reverts its own
attachments, so drift reports such an attachment made outside the stack on the
policy, not a second time on the principal. This holds only when that list
holds plain names; a list holding a `{{resolve:...}}` reference leaves the
attachment to the principal. In a run where the policy itself is not
compared (its read failed, or its baseline was refused), the principal
reports such an attachment instead, and `--revert` detaches it from the
principal. `--accept` in such a run records it on the principal only, so a
later run that compares the policy reports it again, on the policy.
If a member was granted on purpose, by another stack or by your
organization's automation, run `cdkd drift --accept` instead: it records the
member, and drift stops reporting it. An inline policy recorded this way is pinned to the document it
had then: if the stack or tool that owns it later changes that document,
drift reports the change and `--revert` puts the recorded document back, so
accept again instead. An inline policy that a resource of the same stack writes (an
`AWS::IAM::Policy` or `RolePolicy`) is different: drift compares it against
that resource's template, so `--accept` does not silence an out-of-band edit
of its document. `--revert` puts the template's document back; to keep the
edit, put it in that resource's template and deploy. Under these keys drift reports only a
member AWS holds that nothing recorded: a recorded member that is gone is not
reported, and `--revert` never adds one back. The exception is a recorded
permissions boundary removed outside the stack, which widens access: it is
reported, and `--revert` puts it back.

A managed policy's `Roles`, `Users` and `Groups` are compared only when your
template sets them on the `AWS::IAM::ManagedPolicy` itself. Another resource
in the stack can write each IAM list: an `AWS::IAM::UserToGroupAddition` adds
users to a group, an `AWS::IAM::ManagedPolicy` attaches itself through its
`Roles` / `Users` / `Groups`, and a role attaches a policy through its own
`ManagedPolicyArns`. Drift leaves out of each compared list the members such
a resource in the same stack currently writes, unless the template lists them
too. So `--revert` neither removes nor re-adds those members. When a deploy
makes such a resource stop writing a member (the
policy drops the principal, is replaced under a new ARN, or is deleted; the
addition drops the user; the role drops the policy), that deploy also removes
the member from the other resource's recorded snapshot, even when that
resource itself does not change. So drift does not report the member as lost,
and `--revert` does not add it back. A resource the deploy kept in AWS (a
`Retain` policy, or a replaced resource whose old copy was not deleted) still
writes its members, so they stay. A snapshot recorded before cdkd had this fix,
or left by a deploy that was killed mid-run, can still hold a member the stack
stopped writing. So can a snapshot whose member cdkd recorded as `***` or as a
`{{resolve:...}}` reference (a role, policy or group name taken from a
secret): it does not match the name the stack writes, so cdkd leaves it. Run
`cdkd state refresh-observed --yes` once to re-read either. As in CloudFormation, an
out-of-band change to a managed policy's `Roles`, `Users` or `Groups` your
template does not set is not reported.

Security-group rules work the same way. CDK writes a rule between two
security groups (`connections.allowFrom(otherGroup, ...)`,
`db.connections.allowDefaultPortFrom(fn)`) as a separate
`AWS::EC2::SecurityGroupIngress` or `AWS::EC2::SecurityGroupEgress`, and
keeps CIDR rules in the group's own `SecurityGroupIngress` /
`SecurityGroupEgress`. Drift leaves out of the group's lists every rule such a
resource in the same stack adds, unless the group's template lists it too, so
`--revert` never revokes it. Such a resource that records its rule's `sgr-`
id owns exactly the live rule carrying that id: a change to the rule's
protocol, ports or peer out of band (which keeps the id) is reported on that
resource, and a rule someone adds at the resource's declared protocol, ports
and peer under another id is reported on the group, and its `--revert` revokes
it. This reads the group's rules with `ec2:DescribeSecurityGroupRules`, once per
group that has such a resource, on every read of the stack's recorded state
(`cdkd drift`, `--revert`, `cdkd state refresh-observed` and `cdkd import`).
A deploy makes it only when it re-captures a drift baseline recorded with a
masked secret; its post-write capture
and the rollback replay's baseline refresh never do. A resource whose rule
another resource of the stack also declares, whose peer is named by group name,
or whose recorded id is no longer live is still matched by protocol, ports and
peer. Without that permission the group's rules are matched that way, the read
of such a resource fails (`cdkd drift` exits 2), and the group's `--revert`
refuses rather than revoke anything. A group provisioned through Cloud Control
is matched that way too; Cloud Control replaces a changed rule list whole, so
when such a group has these resources, its `--revert` refuses any change to its
rule lists (revert it by redeploying the stack) and reverts only its other
properties. A rule nothing in the stack declares is still
reported, as in CloudFormation, and `--revert` revokes only that one. When a deploy removes
such a resource, or replaces it with a different rule, its delete revokes the
rule and the same deploy removes it from the group's recorded snapshot, so
drift does not report it as lost and `--revert` does not re-authorize it.

A group whose template declares no `SecurityGroupEgress` keeps the allow-all
egress rule AWS creates with it, as CloudFormation's group does, and drift
compares it: revoking it out of band is reported and `--revert` re-authorizes
it. A snapshot recorded before cdkd read that rule back holds no egress rule
for such a group and reports nothing until `cdkd state refresh-observed --yes`
re-reads it. An egress rule a resource in another stack adds to such a
group is reported too, and `--revert` revokes it; only rules a resource in the
same stack adds are left out.

The same rule covers the other resources that write into another resource's
property:

| Resource in the stack | Writes into | Drift leaves out |
| --- | --- | --- |
| `AWS::SNS::Subscription` | `AWS::SNS::Topic` `Subscription` | that subscription (matched by protocol and endpoint) |
| `AWS::ECS::ClusterCapacityProviderAssociations` | `AWS::ECS::Cluster` `CapacityProviders`, `DefaultCapacityProviderStrategy` | both lists, unless the cluster's template sets them |
| `AWS::IAM::Policy`, `RolePolicy`, `UserPolicy`, `GroupPolicy` | a role's, user's or group's inline `Policies` | that policy (matched by name; where cdkd reads the principal through Cloud Control, also by the document the stack recorded, so an edited document is reported as a change) |
| `AWS::EC2::EIPAssociation` | `AWS::EC2::EIP` `InstanceId` | the instance, unless the address's template sets it |
| `AWS::EC2::VolumeAttachment`, `NetworkInterfaceAttachment` | an `AWS::EC2::Instance`'s `Volumes` / `NetworkInterfaces`, where cdkd reads the instance through Cloud Control | that volume or interface (matched by id) |
| `AWS::AutoScaling::LifecycleHook` | `AWS::AutoScaling::AutoScalingGroup` `LifecycleHookSpecificationList` | that hook (matched by name) |
| `AWS::EMR::InstanceGroupConfig`, `InstanceFleetConfig` | `AWS::EMR::Cluster` `Instances` task groups and fleets | that group (matched by name and instance type) or fleet (by name) |

A member nothing in the stack writes is still reported, and `--revert` removes
only that member: it sends the members such a resource wrote as they are live,
so they are neither removed nor added again. When a deploy removes such a
resource, or changes what it writes, the same deploy removes what it stopped
writing from the other resource's recorded snapshot.

An `AWS::Lambda::EventSourceMapping` deployed by an older cdkd can hold
`Enabled: false` in its recorded snapshot even though the mapping is enabled.
Drift does not report that difference while your template leaves `Enabled`
unset (or sets it to `true`) and the live mapping is enabled, so `--revert`
never disables the mapping because of it, and you do not need to run `--accept`
first. A template that sets `Enabled: false` is compared as usual. The old
snapshot stays in state until the next deploy that updates the mapping, or
until `cdkd state refresh-observed`. Until then, disabling such a mapping
outside cdkd is not reported either, because the snapshot already says
`false`.

An `AWS::AppSync::GraphQLSchema` changed by an older cdkd can hold the
schema the change replaced in its recorded snapshot, because that cdkd read
the schema before AppSync applied the new one. Drift does not report the
`Definition` difference while the live schema is the template's inline
`Definition`, so `--revert` never pushes the old schema back. A schema from
`DefinitionS3Location` is compared as usual; the next deploy that changes the
schema, or `cdkd state refresh-observed`, replaces the old snapshot.

## Reading the report

A stack with no drift prints one line:

```text
✓ MyStack (us-east-1): no drift detected (12 resources checked, 0 unsupported)
```

A stack with drift prints a block for the stack. This run found every kind of
entry a report can hold:

```text
⚠ MyStack (us-east-1): drift detected on 2 resources

  - LegacyTopic (AWS::SNS::Topic) — DELETED outside cdkd: AWS reports it does not exist.

  ~ AssetsBucket (AWS::S3::Bucket)
    - VersioningConfiguration.Status: Enabled
    + VersioningConfiguration.Status: Suspended


  1 resource(s) NOT fully compared — 1 not compared AT ALL (the read or comparison failed):
    ! ApiFunction (AWS::Lambda::Function) — the read or comparison threw, so NONE of its properties were compared

  1 resource(s) reported as drift unknown — provider does not yet support drift detection:
    ? WebTemplate (AWS::EC2::LaunchTemplate)
```

Reading it from the top:

- The first line counts the resources that drifted. A deleted resource counts.
- `- LegacyTopic` is a resource that no longer exists in AWS.
- `~ AssetsBucket` is a resource with a changed property. Under it, the `-`
  line is the value in cdkd state and the `+` line is the value AWS holds now.
- `! ApiFunction` is a resource cdkd could not compare. The text after the
  dash gives the reason. Here cdkd's read of the function failed, so the
  function may or may not have drifted.
- `? WebTemplate` is a resource type cdkd cannot read back at all.

Resources that matched are not listed.

### The five outcomes

Every resource ends in exactly one of these:

- **clean**: every recorded property was compared and matched.
- **drifted**: at least one property differs. Marked `~`.
- **deleted**: AWS reports that the resource does not exist. Marked `-`.
- **not compared**: nothing differed, but cdkd could not compare some or all
  of the resource's properties. Marked `!`, with the reason.
- **drift unknown**: cdkd has no way to read this resource type back from AWS.
  Marked `?` and counted as `unsupported` in the summary line.

cdkd reports a resource as deleted only when AWS itself answers that the
resource is not there. A read that was denied or throttled is reported as not
compared, never as deleted.

[cdkd drift: what was not compared](cli-drift-not-compared.md) explains each reason
on a `!` line and how to clear it.

### When there is no drift but not everything was compared

The `✓` appears only when cdkd fully compared every resource it drift-checks.
Custom resources are never drift-checked, and the line counts them separately
(see below). Otherwise the line starts with `⚠` and says how much was checked:

```text
⚠ MyStack (us-east-1): no drift detected, but 1 of 3 resources fully checked (2 only partially compared), 1 unsupported
```

Read that line as "no drift was found in the part cdkd could see". The block
below it names the resources that were not fully compared.

When cdkd could compare nothing in the stack, the line says so:

```text
⚠ MyStack (us-east-1): no drift detected, but NOTHING was compared — 0 of 1 resource checked (1 unsupported, 0 skipped)
```

A stack holding a drift unknown resource gets the `⚠` too, naming how many
could not be compared:

```text
⚠ MyStack (us-east-1): no drift detected in 4 resources checked, but 1 resource could not be compared (1 unsupported, drift unknown)
```

Two kinds of resource are left out of the "checked" count: unsupported ones
(drift unknown) and skipped ones. Custom resources (`Custom::*` and
`AWS::CloudFormation::CustomResource`) are always skipped. They get no line of
their own, but the summary line says how many it left out:

```text
✓ MyStack (us-east-1): no drift detected (3 resources checked, 0 unsupported) — excludes 1 custom resource, which cdkd does not drift-check
```

## Exit codes

In short: `0` means no drift, `1` means drift or a failed command, and `2`
means the comparison was incomplete or cdkd could not finish the job.

| Code | Mode | Meaning |
| --- | --- | --- |
| `0` | detection | Nothing drifted, and the comparison was complete, apart from the gaps listed below. |
| `0` | `--accept` / `--revert` | The run completed. |
| `1` | any | Drift was detected, or the command failed. |
| `2` | detection | Nothing drifted, but the comparison was incomplete. |
| `2` | `--revert` | One or more resources were not reverted. |
| `2` | `--accept` / `--revert` | The run refused a [deleted resource](cli-drift-accept-revert.md#deleted-resources). |

"Detection" is a run with neither `--accept` nor `--revert`. A deleted
resource counts as drift. A failed command is one that found no state, hit an
AWS error, or was given bad arguments. The table for every command is in
[Exit codes](cli-reference-exit-codes.md).

Three rules settle the cases the table leaves open:

- Drift outranks a missing comparison, so a run with both exits `1`.
- A drift unknown resource makes the comparison incomplete, so a run with one
  and no drift exits `2`.
- A few reasons for a missing comparison still exit `0`, because nothing can
  ever clear them: a skipped custom resource, a `{{resolve:...}}` spelling cdkd
  cannot resolve, and a `NoEcho` parameter value. The report still names them.
  A nested stack's row exits `0` too, because its own block compares it. The
  [lookup table](cli-drift-not-compared.md#why-a-resource-was-not-compared)
  gives the code for each reason.

Exit `0` from `--accept` or `--revert` says the run completed. It does not say
every resource was compared. When the comparison was incomplete, the run
prints `Comparison INCOMPLETE — nothing to accept/revert, and that is NOT a
clean bill of health` and names what was not compared.

To make CI fail unless everything was compared and nothing drifted, run
`cdkd drift` without `--accept` or `--revert` and require exit `0`. To accept a
known gap (for example a type cdkd cannot read yet) but still fail on drift,
treat `2` as a pass and fail on `1`. With `--json` the strict check is:

```bash
cdkd drift --all --json \
  | jq -e 'all(.[]; .drifted == [] and .deleted == [] and .notCompared == [] and .notSupported == [])'
```

## Resolving drift: `--accept` and `--revert`

Once drift is reported, you choose which side is right. `--accept` keeps the
AWS value and updates cdkd state to match. `--revert` keeps the state value
and changes AWS back.

```text diagram=drift-accept-revert
              Drift reported on a property
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   --accept                          --revert
   state <- AWS                      AWS <- state
   record the live value             push the recorded value back
   AWS is not modified               through the resource's provider
```

| | `--accept` | `--revert` |
| --- | --- | --- |
| Use when | The AWS change is intended. | The AWS change should be undone. |
| Writes to | cdkd state only. | AWS. |
| Afterwards | `cdkd drift` reports clean. | `cdkd drift` reports clean. |

The two flags cannot be combined. Both take the same per-stack lock that
`cdkd deploy` takes, so a deploy cannot run at the same time. Both print a
plan and ask for confirmation, unless you pass `--yes`. On a stack with no
drift, both do nothing.

### Worked example: undo a console edit

Someone suspended versioning on `AssetsBucket` in the console, and the drift
report shows it as in the example above. To put it back:

::: steps
1. Preview the change

   ```bash
   cdkd drift MyStack --revert --dry-run
   ```

   ```text
   Plan (--revert): push cdkd state values back into AWS for MyStack (us-east-1):
     → provider.update on AssetsBucket (AWS::S3::Bucket): revert 1 property path
       VersioningConfiguration.Status: Suspended → Enabled
   --dry-run: AWS will NOT be modified. Re-run without --dry-run to apply.
   ```

   The arrow on the property line reads "from the value AWS has now, to the
   value cdkd recorded". `--dry-run` takes no lock, writes nothing, and exits
   `0`.

2. Apply it

   ```bash
   cdkd drift MyStack --revert --yes
   ```

   The run ends with:

   ```text
   Revert summary: 1 reverted.
   ```

3. Confirm the stack is clean

   ```bash
   cdkd drift MyStack
   ```
:::

If the console edit was intended, run `cdkd drift MyStack --accept --yes`
in place of step 2. Its plan shows the same property with the arrow pointing
the other way, because state is what changes:

```text
Plan (--accept): update cdkd state for MyStack (us-east-1):
  ~ AssetsBucket (AWS::S3::Bucket)
    VersioningConfiguration.Status: Enabled → Suspended
```

### What the two flags will not do

Neither flag acts on a resource AWS reports as deleted. `--revert` can only
update a resource that exists, and `--accept` does not remove a resource from
state. To bring a deleted resource back, see
[Deleted resources](cli-drift-accept-revert.md#deleted-resources).

Each flag also declines a few specific properties and resource types, and the
plan names every one before you confirm. The lists are in
[cdkd drift: accept and revert in detail](cli-drift-accept-revert.md).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to check, as physical CloudFormation names. Each stack's [nested stacks](cli-drift-nested-stacks.md) are checked with it. |
| `--all` | off | Check every stack in the state bucket. |
| `--json` | off | Emit the structured per-stack report on stdout, and nothing else. See [cdkd drift: JSON output](cli-drift-json.md). |
| `--accept` | off | Write the AWS-current values into cdkd state. Mutually exclusive with `--revert`. |
| `--revert` | off | Push cdkd state values back into AWS. Mutually exclusive with `--accept`. |
| `--dry-run` | off | With `--accept` or `--revert`: print the planned mutations and exit, without taking a lock or writing. |
| `--concurrency <number>` | `4` | Maximum concurrent provider updates during `--revert`. No effect on `--accept`. |
| `--stack-region <region>` | — | Region of the stack record to inspect. Required when one stack name has state in more than one region. |
| `-y`, `--yes` | off | Skip the confirmation prompt of `--accept` and `--revert`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

With no stack named and `--all` unset, the single stack in state is selected,
with its nested stacks.

`--region <region>` picks the region, ahead of `AWS_REGION` and your AWS
profile. See [Region resolution](cli-reference-region.md).

## Resource type coverage

Drift detection covers every resource type that cdkd can read back from AWS.
There are two ways cdkd reads a resource:

- with its own code for that type, which exists for the types in the table
  below;
- through the AWS Cloud Control API, for every other type Cloud Control can
  read.

A type that neither route can read is reported as drift unknown.

| Service | Types |
| --- | --- |
| `AWS::ApiGateway` | `Account`, `Authorizer`, `Deployment`, `Method`, `Resource`, `RestApi`, `Stage` |
| `AWS::ApiGatewayV2` | `Api`, `Authorizer`, `Integration`, `Route`, `Stage` |
| `AWS::AppSync` | `ApiKey`, `DataSource`, `GraphQLApi`, `GraphQLSchema`, `Resolver` |
| `AWS::AutoScaling` | `AutoScalingGroup` |
| `AWS::BedrockAgentCore` | `Browser`, `CodeInterpreter`, `Evaluator`, `Runtime` |
| `AWS::Budgets` | `Budget` |
| `AWS::CertificateManager` | `Certificate` |
| `AWS::CloudFormation` | `WaitCondition`, `WaitConditionHandle` |
| `AWS::CloudFront` | `CloudFrontOriginAccessIdentity`, `Distribution`, `OriginAccessControl` |
| `AWS::CloudTrail` | `Trail` |
| `AWS::CloudWatch` | `Alarm`, `AnomalyDetector` |
| `AWS::CodeBuild` | `Project` |
| `AWS::CodeCommit` | `Repository` |
| `AWS::Cognito` | `UserPool` |
| `AWS::Connect` | `Instance` |
| `AWS::DLM` | `LifecyclePolicy` |
| `AWS::DocDB` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::DynamoDB` | `GlobalTable`, `Table` |
| `AWS::EC2` | `EIP`, `Instance`, `InternetGateway`, `NatGateway`, `NetworkAcl`, `NetworkAclEntry`, `Route`, `RouteTable`, `SecurityGroup`, `SecurityGroupIngress`, `Subnet`, `SubnetNetworkAclAssociation`, `SubnetRouteTableAssociation`, `VPC`, `VPCEndpoint`, `VPCGatewayAttachment` |
| `AWS::ECR` | `Repository` |
| `AWS::ECS` | `Cluster`, `Service`, `TaskDefinition` |
| `AWS::EFS` | `AccessPoint`, `FileSystem`, `MountTarget` |
| `AWS::ElastiCache` | `CacheCluster`, `SubnetGroup` |
| `AWS::ElasticLoadBalancingV2` | `Listener`, `LoadBalancer`, `TargetGroup` |
| `AWS::EMR` | `Cluster`, `InstanceFleetConfig`, `InstanceGroupConfig` |
| `AWS::Events` | `Archive`, `EventBus`, `Rule` |
| `AWS::FSx` | `FileSystem` |
| `AWS::Glue` | `Connection`, `Crawler`, `Database`, `Job`, `SecurityConfiguration`, `Table`, `Trigger`, `Workflow` |
| `AWS::IAM` | `AccessKey`, `Group`, `InstanceProfile`, `ManagedPolicy`, `Policy`, `Role`, `User`, `UserToGroupAddition` |
| `AWS::Kinesis` | `Stream`, `StreamConsumer` |
| `AWS::KinesisFirehose` | `DeliveryStream` |
| `AWS::KMS` | `Alias`, `Key` |
| `AWS::Lambda` | `EventInvokeConfig`, `EventSourceMapping`, `Function`, `LayerVersion`, `MicrovmImage`, `NetworkConnector`, `Permission`, `Url`, `WebFunctionEndpoint`, `WebFunctionRevision` |
| `AWS::Lightsail` | `Alarm` |
| `AWS::Logs` | `Delivery`, `DeliveryDestination`, `DeliverySource`, `LogGroup` |
| `AWS::Neptune` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::Pipes` | `Pipe` |
| `AWS::RDS` | `DBCluster`, `DBInstance`, `DBProxy`, `DBProxyEndpoint`, `DBProxyTargetGroup`, `DBSubnetGroup` |
| `AWS::Route53` | `HostedZone`, `RecordSet`, `RecordSetGroup` |
| `AWS::S3` | `Bucket`, `BucketPolicy` |
| `AWS::S3Express` | `DirectoryBucket` |
| `AWS::S3Tables` | `Namespace`, `Table`, `TableBucket` |
| `AWS::S3Vectors` | `VectorBucket` |
| `AWS::Scheduler` | `Schedule` |
| `AWS::SecretsManager` | `Secret` |
| `AWS::ServiceDiscovery` | `HttpNamespace`, `PrivateDnsNamespace`, `PublicDnsNamespace`, `Service` |
| `AWS::SNS` | `Subscription`, `Topic`, `TopicPolicy` |
| `AWS::SQS` | `Queue`, `QueuePolicy` |
| `AWS::SSM` | `Parameter` |
| `AWS::StepFunctions` | `StateMachine` |
| `AWS::WAFv2` | `WebACL` |

### Types cdkd deploys itself without a read-back

cdkd deploys one type with its own code but has no read-back for it:
`AWS::CloudFormation::Stack`. Such a row is a nested stack, and drift handles
it as described under [cdkd drift: nested stacks](cli-drift-nested-stacks.md);
drift never asks Cloud Control about it.

> [!NOTE]
> Several types above (`AWS::ApiGateway::Method`, `AWS::Route53::RecordSet`,
> `AWS::AppSync::DataSource` / `Resolver` / `ApiKey`, `AWS::Glue::Table`,
> `AWS::S3Tables::Namespace` / `Table`, and the EC2 sub-resources) have a
> composite, `|`-delimited physical id. Quote it on a shell command line. The
> per-type formats are in
> [Physical IDs in state](state-management-physical-ids.md#composite-ids-several-values-joined-with).

## What the human report does to a malformed value

The report prints text that comes from the state record and from AWS: stack
names, regions, logical ids, resource types, property paths and values. cdkd
treats all of that text as untrusted. A value crafted to look like a report
line, or to send control sequences to your terminal, is printed in a form that
cannot do either. The `--accept` and `--revert` plans follow the same rules.

| Text | What the report does |
| --- | --- |
| A control character in an identifier | Replaces it with a space. Cursor-movement and link escape sequences are removed whole. |
| An identifier longer than 255 characters | Cuts it and appends `...`. |
| A property value with a control character, edge whitespace, or a leading `"` | Prints it as a JSON string, such as `"abc\n"` or `" value "`. |
| Any other string value | Prints it unquoted and unchanged. |
| An object or list value | JSON-encodes it, with the same escaping. |
| A plan value containing `->` or an arrow character | Quotes it, so the only unquoted `→` on a plan line is the separator. |

Because of the third row, two values that differ only by a trailing newline, a
tab or padding print differently, so you can see the difference. Values that
differ only by another invisible character or a look-alike letter can still
print alike. The full rules are in
[cdkd drift internals](cli-drift-internals.md#what-the-human-report-does-to-a-malformed-value).

`--json` output is not altered this way; see
[cdkd drift: JSON output](cli-drift-json.md#streams-under-json).

## In this section

- [cdkd drift: what was not compared](cli-drift-not-compared.md): each reason on a
  `!` line, how to clear it, and the differences drift ignores on purpose.
- [cdkd drift: accept and revert in detail](cli-drift-accept-revert.md): what each
  flag declines, the revert summary, and recovering a deleted resource.
- [cdkd drift: secrets and redacted values](cli-drift-secrets.md): how drift
  compares a property that holds a secret, and why some show `***`.
- [cdkd drift: nested stacks](cli-drift-nested-stacks.md): how nested stacks appear
  in the report, and a nested stack whose record is missing.
- [cdkd drift: JSON output](cli-drift-json.md): the `--json` schema and what goes
  to stdout and stderr.

## Related

- [Detect and Fix Drift](drift.md): the same subject, summarised for a first read
- [State Store](state-management.md): the state schema, `observedProperties`, and `cdkd state refresh-observed`
- [`cdkd scrub`](cli-scrub.md): keeping secret plaintext out of the state records drift compares against
- [`cdkd diff`](cli-diff.md): the template-vs-state comparison
- [CLI Reference](cli-reference.md): every command and the full exit-code table
- [Troubleshooting](troubleshooting.md): what to do when a drift run fails
- [cdkd drift internals](cli-drift-internals.md): the rules behind the edge cases
