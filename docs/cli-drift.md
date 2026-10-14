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
did set. You can record a snapshot without redeploying:

```bash
cdkd state refresh-observed MyStack
```

Drift compares only the properties that state records. Fields AWS manages and
cdkd never stored, such as timestamps and generated identifiers, are ignored.

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

The `✓` appears only when cdkd fully compared every resource it tried to read.
Otherwise the line starts with `⚠` and says how much was checked:

```text
⚠ MyStack (us-east-1): no drift detected, but 1 of 3 resources fully checked (2 only partially compared), 1 unsupported
```

Read that line as "no drift was found in the part cdkd could see". The block
below it names the resources that were not fully compared.

When cdkd could compare nothing in the stack, the line says so:

```text
⚠ MyStack (us-east-1): no drift detected, but NOTHING was compared — 0 of 1 resource checked (1 unsupported, 0 skipped)
```

Two kinds of resource are left out of the "checked" count: unsupported ones
(drift unknown) and skipped ones. Custom resources (`Custom::*`) are always
skipped. A stack where nothing could be compared still exits `0`, and only the
wording changes.

## Exit codes

In short: `0` means no drift, `1` means drift or a failed command, and `2`
means cdkd could not finish the job.

| Code | Mode | Meaning |
| --- | --- | --- |
| `0` | detection | Nothing drifted, and no comparison is missing for a reason you can fix. |
| `0` | `--accept` / `--revert` | The run completed. |
| `1` | any | Drift was detected, or the command failed. |
| `2` | detection | Nothing drifted, but a comparison is missing for a reason you can fix. |
| `2` | `--revert` | One or more resources were not reverted. |
| `2` | `--accept` / `--revert` | The run refused a [deleted resource](cli-drift-accept-revert.md#deleted-resources). |

"Detection" is a run with neither `--accept` nor `--revert`. A deleted
resource counts as drift. A failed command is one that found no state, hit an
AWS error, or was given bad arguments. The table for every command is in
[Exit codes](cli-reference-exit-codes.md).

Three rules settle the cases the table leaves open:

- Drift outranks a missing comparison, so a run with both exits `1`.
- Only some reasons for a missing comparison produce exit `2`. The
  [lookup table](cli-drift-not-compared.md#why-a-resource-was-not-compared)
  says which.
- Drift unknown and skipped resources never change the exit code.

Exit `0` from `--accept` or `--revert` says the run completed. It does not say
every resource was compared. When the comparison was incomplete, the run
prints `Comparison INCOMPLETE — nothing to accept/revert, and that is NOT a
clean bill of health` and names what was not compared.

To make CI fail unless everything was compared and nothing drifted, run
`cdkd drift` without `--accept` or `--revert` and require exit `0`. With
`--json` the same check is:

```bash
cdkd drift --all --json \
  | jq -e 'all(.[]; .drifted == [] and .deleted == [] and .notCompared == [])'
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

`--region` is deprecated. Prefer `AWS_REGION` or your AWS profile. It is still
honored if passed.

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
| `AWS::ApiGateway` | `Account`, `Authorizer`, `Deployment`, `Method`, `Resource`, `Stage` |
| `AWS::ApiGatewayV2` | `Api`, `Authorizer`, `Integration`, `Route`, `Stage` |
| `AWS::AppSync` | `ApiKey`, `DataSource`, `GraphQLApi`, `GraphQLSchema`, `Resolver` |
| `AWS::AutoScaling` | `AutoScalingGroup` |
| `AWS::BedrockAgentCore` | `Browser`, `CodeInterpreter`, `Evaluator`, `Runtime` |
| `AWS::CertificateManager` | `Certificate` |
| `AWS::CloudFormation` | `WaitConditionHandle` |
| `AWS::CloudFront` | `CloudFrontOriginAccessIdentity`, `Distribution`, `OriginAccessControl` |
| `AWS::CloudTrail` | `Trail` |
| `AWS::CloudWatch` | `Alarm` |
| `AWS::CodeBuild` | `Project` |
| `AWS::CodeCommit` | `Repository` |
| `AWS::Cognito` | `UserPool` |
| `AWS::DLM` | `LifecyclePolicy` |
| `AWS::DocDB` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::DynamoDB` | `GlobalTable`, `Table` |
| `AWS::EC2` | `EIP`, `Instance`, `InternetGateway`, `NatGateway`, `NetworkAcl`, `NetworkAclEntry`, `Route`, `RouteTable`, `SecurityGroup`, `SecurityGroupIngress`, `Subnet`, `SubnetNetworkAclAssociation`, `SubnetRouteTableAssociation`, `VPC`, `VPCGatewayAttachment` |
| `AWS::ECR` | `Repository` |
| `AWS::ECS` | `Cluster`, `Service`, `TaskDefinition` |
| `AWS::EFS` | `AccessPoint`, `FileSystem`, `MountTarget` |
| `AWS::ElastiCache` | `CacheCluster`, `SubnetGroup` |
| `AWS::ElasticLoadBalancingV2` | `Listener`, `LoadBalancer`, `TargetGroup` |
| `AWS::EMR` | `Cluster` |
| `AWS::Events` | `EventBus`, `Rule` |
| `AWS::FSx` | `FileSystem` |
| `AWS::Glue` | `Connection`, `Crawler`, `Database`, `Job`, `SecurityConfiguration`, `Table`, `Trigger`, `Workflow` |
| `AWS::IAM` | `AccessKey`, `Group`, `InstanceProfile`, `ManagedPolicy`, `Policy`, `Role`, `User`, `UserToGroupAddition` |
| `AWS::Kinesis` | `Stream`, `StreamConsumer` |
| `AWS::KinesisFirehose` | `DeliveryStream` |
| `AWS::KMS` | `Alias`, `Key` |
| `AWS::Lambda` | `EventInvokeConfig`, `EventSourceMapping`, `Function`, `LayerVersion`, `MicrovmImage`, `Permission`, `Url`, `WebFunctionEndpoint`, `WebFunctionRevision` |
| `AWS::Logs` | `LogGroup` |
| `AWS::Neptune` | `DBCluster`, `DBInstance`, `DBSubnetGroup` |
| `AWS::Pipes` | `Pipe` |
| `AWS::RDS` | `DBCluster`, `DBInstance`, `DBProxy`, `DBProxyEndpoint`, `DBProxyTargetGroup`, `DBSubnetGroup` |
| `AWS::Route53` | `HostedZone`, `RecordSet` |
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

### Types read through Cloud Control although cdkd deploys them itself

cdkd deploys five types with its own code but has no read-back for them, so
drift reads them through Cloud Control: `AWS::Budgets::Budget`,
`AWS::CloudFormation::Stack`, `AWS::CloudWatch::AnomalyDetector`,
`AWS::EMR::InstanceFleetConfig` and `AWS::EMR::InstanceGroupConfig`.

An `AWS::CloudFormation::Stack` row is a nested stack, and drift handles it as
described under [cdkd drift: nested stacks](cli-drift-nested-stacks.md).

### Types that are always drift unknown

For three types, what Cloud Control returns differs from what state holds even
when nothing changed. Comparing them would report false drift on every run, so
cdkd reports them as drift unknown.

| Type | Reason |
| --- | --- |
| `AWS::ApiGateway::RestApi` | `Body` / `BodyS3Location` are write-only inputs the response omits. |
| `AWS::EC2::LaunchTemplate` | The response carries version-bumped `LaunchTemplateData` and a synthetic `LatestVersionNumber`. |
| `AWS::CloudWatch::AnomalyDetector` | Its physical id is a cdkd-derived descriptor Cloud Control cannot address. |

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
