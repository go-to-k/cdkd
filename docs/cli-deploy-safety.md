---
title: "cdkd deploy: safety & compatibility flags"
description: "What cdkd deploy refuses by default, whether your data is at risk when it does, and the flag that gets each refusal through."
---

# cdkd deploy: safety & compatibility flags

`cdkd deploy` refuses a few things up front instead of failing halfway or
losing data: an unsupported resource type, a replacement that would delete a
database, a name that is already taken. This page says what each refusal
means and where to read about the way through. It also holds the
stateful-resource guard, which is the refusal that protects your data.

```bash
# replace what AWS cannot update in place
cdkd deploy MyStack --replace --yes

# same, and accept the data loss
cdkd deploy MyStack --replace --force-stateful-recreation

# destroy + recreate one resource via Cloud Control
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh

# fail on any guessed Fn::GetAtt value
cdkd deploy MyStack --strict-getatt

# ask before replacing or deleting anything
cdkd deploy --require-approval=destructive
```

The other deploy flags are under
[cdkd deploy](cli-deploy.md) and
[cdkd deploy: tuning](cli-deploy-tuning.md).

## When a deploy is refused

Find the text or the code from your error in the first column. In each of
these refusals, the resource the message names has not been deleted.

| The deploy says | What it means | Read |
| --- | --- | --- |
| `The following resource types are not supported by cdkd` | cdkd has no way to manage the type | [`--allow-unsupported-types`](cli-deploy-safety-routing.md#allow-unsupported-types-deploy-destroy) |
| `STATEFUL_REPLACE_BLOCKED`, or `requires replacement ... but it is a stateful resource` | A template change replaces a resource that holds data | [Property-driven replacement](#property-driven-replacement-and-stateful-replace-blocked) |
| `cannot be updated in place by the provisioning layer` | A rejected update would replace a resource that holds data | [An update the route cannot apply in place](#an-update-the-route-cannot-apply-in-place) |
| `ResourceUpdateNotSupportedError` | AWS has no update call for the type | [`--replace`](cli-deploy-safety-replacement.md#replace-deploy) |
| `NAMED_REPLACEMENT_COLLISION`, `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` | The old resource still holds the name the new one needs | [Same-name replacement](cli-deploy-safety-replacement.md#same-name-replacement-delete-first-ordering) |
| `NAMED_CREATE_COLLISION` | A resource with that explicit name already exists | [A create under a taken name](cli-deploy-safety-replacement.md#a-create-under-a-name-that-is-already-taken) |
| `CREATE_ONLY_DROP_NEEDS_REPLACEMENT` | A property that was kept off AWS now needs a replacement | [`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`](cli-deploy-safety-recreate.md#create-only-drop-needs-replacement) |
| `TYPE_CHANGE_NESTED_STACK` | A resource changes type into or out of a nested stack | [Type changes and nested stacks](cli-deploy-safety-replacement.md#type-changes-into-or-out-of-a-nested-stack-type-change-nested-stack) |
| AWS refuses the delete of a protected resource | Deletion protection is on, and deploy cannot turn it off | [Deletion protection](#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it) |
| Exit `2` with `Skipped (not deleted)` or `orphaned predecessor` | The deploy finished and left a resource alive | [`--allow-unaddressed`](cli-deploy-safety-ci-flags.md#allow-unaddressed-deploy) |
| `SynthesisError` about a nested template or a path | The cloud assembly is malformed | [Checks on the cloud assembly](cli-deploy-safety-assembly-checks.md) |

A warning that `--prefer-sdk-route had no effect` also points at this page.
It is explained under
[When the flag does not do what you expect](cli-deploy-safety-routing.md#when-the-flag-does-not-do-what-you-expect).

Most of these refusals come from one situation. The deploy has to delete a
resource and create a new one, and that can cost you something:

- `--force-stateful-recreation` lets cdkd delete a resource that holds data.
  The data is lost.
- `--replace` and the `--recreate-via-*` flags delete and re-create a
  resource. Data is lost only when the resource is stateful, and cdkd then
  asks for `--force-stateful-recreation` as well.
- `--replace` on a resource that keeps its name causes a short outage.
- The other ways through leave your data untouched.

## Options

| Flag | Applies to | Description |
| --- | --- | --- |
| [`--allow-unsupported-types <types>`](cli-deploy-safety-routing.md#allow-unsupported-types-deploy-destroy) | deploy, destroy, state destroy | Attempt a resource type cdkd refuses as unsupported. |
| [`--prefer-sdk-route <entries>`](cli-deploy-safety-routing.md#prefer-sdk-route-deploy) | deploy | Keep a resource on cdkd's SDK provider and accept that the named property is not written to AWS. |
| [`--pin-cc-api <LogicalId>`](cli-deploy-safety-routing.md#pin-cc-api-deploy) | deploy | Keep one resource on Cloud Control for this deploy when it would return to the SDK provider. |
| [`--recreate-via-cc-api <LogicalId>`](cli-deploy-safety-recreate.md#recreate-via-cc-api-deploy) | deploy | Destroy and recreate one resource through Cloud Control API. |
| [`--recreate-via-sdk-provider <LogicalId>`](cli-deploy-safety-recreate.md#recreate-via-sdk-provider-deploy) | deploy | Destroy and recreate one resource through cdkd's SDK provider. |
| [`--replace`](cli-deploy-safety-replacement.md#replace-deploy) | deploy | Replace (delete and create) a resource that AWS has no update call for. |
| [`--force-stateful-recreation`](#force-stateful-recreation) | deploy | Confirm the data loss when any replacement in the run targets a [stateful resource](#stateful-resource-guard). |
| [`--strict-getatt`](cli-deploy-safety-ci-flags.md#strict-getatt-deploy) | deploy | Fail on any `Fn::GetAtt` that falls back to a physical ID, and on any unresolvable Output. |
| [`--allow-unaddressed`](cli-deploy-safety-ci-flags.md#allow-unaddressed-deploy) | deploy | Exit 0 instead of 2 when the deploy left a resource alive that it no longer tracks. |
| [`--no-cfn-fallback`](cli-deploy-safety-ci-flags.md#no-cfn-fallback-deploy-diff) | deploy, diff | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. |
| [`--require-approval <level>`](cli-deploy-safety-ci-flags.md#require-approval-deploy) | deploy | Ask before deploying a stack with any change (`any-change`) or a destructive one (`destructive`). Default `never`. |

## In this section

- [cdkd deploy: provisioning route flags](cli-deploy-safety-routing.md): how cdkd
  chooses between its SDK providers and Cloud Control, and the flags that
  change the choice.
- [cdkd deploy: recreating a resource on the other route](cli-deploy-safety-recreate.md):
  when you need `--recreate-via-cc-api` or `--recreate-via-sdk-provider`, and
  what a recreate costs.
- [cdkd deploy: replacements and name collisions](cli-deploy-safety-replacement.md):
  when cdkd replaces a resource, what `--replace` adds, and what to do about a
  name that is already taken.
- [cdkd deploy: strictness and approval flags](cli-deploy-safety-ci-flags.md):
  `--strict-getatt`, `--allow-unaddressed`, `--no-cfn-fallback` and
  `--require-approval`.
- [cdkd deploy: checks on the cloud assembly](cli-deploy-safety-assembly-checks.md):
  what cdkd checks in `cdk.out` before a deploy starts.

## Stateful-resource guard

cdkd refuses to delete and re-create a resource that holds data unless you
pass `--force-stateful-recreation`.

Deleting and re-creating most resources loses nothing. An IAM role or a Lambda
function comes back identical. A **stateful** resource holds data that the
delete destroys and that AWS does not copy to the new resource: rows in a
DynamoDB table, objects in a bucket, lines in a log group, images in an ECR
repository. [Always-stateful types](#always-stateful-types) lists them.

This is how cdkd decides when a template change or a rejected update makes it
replace a resource:

```text diagram=safety-replacement-guard
A deploy has to replace a resource (delete the old one, create a new one)
        |
        v
Is the type stateful? ------------- no --> Replaced, no flag needed
        | yes
        v
UpdateReplacePolicy: Retain? ------ yes -> New one created, old one kept
        | no                               in AWS, no longer tracked
        v
--force-stateful-recreation? ------ no --> Refused, nothing is deleted
        | yes
        v
Deleted and re-created: all data in the old resource is lost
```

### `--force-stateful-recreation`

`--force-stateful-recreation` confirms that you accept the data loss.

```bash
cdkd deploy MyStack --force-stateful-recreation

# In CI, recreating a stateful resource takes three flags
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes
```

> [!CAUTION]
> The flag has no per-resource form. It clears the guard for every replacement
> in the run, nested stacks included. All data in each replaced resource is
> lost, and nothing migrates it.

Because the flag covers nested stacks too, check what a deploy would replace
before you pass it:

```bash
cdkd diff MyStack --recursive
```

The diff shows the replacements that a template change causes. It cannot show
a replacement that follows a rejected update, because cdkd decides that one
during the deploy.

Inside a nested stack the flag also changes how a delete treats a resource
that holds data. cdkd normally refuses to delete a non-empty S3 bucket or an
ECR repository that has images, unless the resource opted in itself through
CDK's `autoDeleteObjects`, `emptyOnDelete` or `autoDeleteImages`. With the
flag, cdkd deletes the bucket's objects first and deletes the repository with
its images.

### Where the guard applies

A replacement can come about in several ways, and the guard checks all of
them. Every path that consults this guard:

| What replaces the resource | The guard runs |
| --- | --- |
| `--recreate-via-cc-api` | Before anything is touched |
| `--recreate-via-sdk-provider` | Before anything is touched |
| A resource that reads a recreated resource through create-only properties | Before anything is touched |
| `--replace`, after an update AWS has no call for | Mid-deploy |
| The Cloud Control fallback, after an update it cannot perform | Mid-deploy |
| A create-only property changed in the template | Mid-deploy |

The last two rows need no other flag, so a plain `cdkd deploy` can ask you for
`--force-stateful-recreation`.

The timing matters in two ways. A refusal mid-deploy can come after other
resources have already changed. And mid-deploy, cdkd cannot check whether a
bucket or a log group is empty, so it treats every one of them as stateful.
See
[How the conditional types are judged, per path](#how-the-conditional-types-are-judged-per-path).

The third row covers a direct chain of create-only references. A resource
reached another way is checked mid-deploy instead. See
[Resources that reference the target](cli-deploy-safety-recreate.md#resources-that-reference-the-target).
A named recreate refuses `AWS::DynamoDB::GlobalTable` even with the flag
([Limits](cli-deploy-safety-recreate.md#limits)).

### Property-driven replacement and `STATEFUL_REPLACE_BLOCKED`

This refusal means your template changed a property that AWS can only set when
a resource is created, on a resource that holds data. Applying the change
means replacing the resource, and that would destroy the data.

```text
MyFileSystem (AWS::EFS::FileSystem) requires replacement (immutable property
changed: PerformanceMode) but it is a stateful resource — destroy loses all data
in the resource. Re-run with --force-stateful-recreation to confirm the data
loss, or change the resource definition to avoid the immutable-property change.
```

The message names the properties that changed. Undo the change if you did not
intend a replacement, or pass `--force-stateful-recreation` and lose the data.
Declaring [`UpdateReplacePolicy: Retain`](#under-updatereplacepolicy-retain)
on the resource is the third way: cdkd then keeps the old resource.

Three exemptions apply to this trigger specifically:

| Case | Guarded? |
| --- | --- |
| `UpdateReplacePolicy: Retain` | No. The old resource and its data stay in AWS. |
| `UpdateReplacePolicy: Snapshot` | Yes. cdkd takes the final snapshot, but the live resource is still destroyed. |
| A resource named by a `--recreate-via-*` flag | No. That flag checked it before the deploy started. |

### An update the route cannot apply in place

This refusal means the update itself was rejected, cdkd's fallback is a
replacement, and the resource holds data.

```text
MyTable (AWS::DynamoDB::Table) cannot be updated in place by the provisioning
layer it routes through, so applying this change would DELETE + CREATE it —
but it is a stateful resource: destroy loses all data in the resource. Re-run
with --force-stateful-recreation to confirm the data loss, or change the
resource definition to avoid the update.
```

A plain `cdkd deploy` reaches this refusal when Cloud Control rejects an
update because the type has no update handler (`UnsupportedActionException`).
cdkd then falls back to a replacement by itself. For a resource that is not
stateful, the replacement goes ahead.

[`--replace`](cli-deploy-safety-replacement.md#replace-deploy) is refused on
the same terms when the resource it would replace is stateful.

### Under `UpdateReplacePolicy: Retain`

`Retain` exempts a resource from the guard, because the old resource is kept.
cdkd creates the new resource and leaves the old one in AWS with its data.
You do not need `--force-stateful-recreation`, and passing it does not make
cdkd delete a resource the template asked to keep.

cdkd no longer tracks the old resource in its state. The old resource keeps
costing money, `cdkd destroy` will not remove it, and deleting it is up to
you. The deploy reports the replacement as partial:

- the resource's row prints `partial (…)`;
- the summary counts it under `of which left an orphaned predecessor`, or
  `Left an orphaned predecessor in a nested stack` for a nested stack;
- `cdkd events` records the old resource's physical ID;
- the deploy exits `2` unless you pass
  [`--allow-unaddressed`](cli-deploy-safety-ci-flags.md#allow-unaddressed-deploy).

#### When the old resource holds the name

The new resource is created beside the old one, so it cannot reuse a physical
name the old one holds. That collision fails the deploy:

```text
MyTable (AWS::DynamoDB::Table) requires replacement because the provisioning
layer cannot update it in place — but its physical name is still held by the
existing resource AND UpdateReplacePolicy: Retain pins that resource in place.
The resource has a user-supplied physical name (my-table). Either rename the
resource in your CDK code (a fresh name lets the safe create-first order
proceed) — with Retain, the old resource keeps the name, so a same-name
replacement can never proceed. Removing UpdateReplacePolicy: Retain lets cdkd
delete the old resource first, which destroys it and any data it holds.
```

Rename the resource in your CDK code. Removing `Retain` also lets the
replacement proceed, but it destroys the old resource and its data.

### What the recreate prompt shows

The `--recreate-via-*` flags print a plan and ask before they destroy
anything. A stateful target's row carries a `**DATA LOSS**` prefix and the
line
`DATA: all data in <logical id> will be lost (no automatic data migration)`.

Under `--force-stateful-recreation` cdkd skips the emptiness checks, so every
S3 bucket and every log group in the plan is shown that way.

A bucket whose emptiness check ran and failed is shown differently. The check
fails on a missing permission, a rate limit or a region mismatch, for example.
The recreate still proceeds, and the row says that cdkd does not know:

```text
  - MyBucket (AWS::S3::Bucket) [SDK → CC] — emptiness NOT established: the live probe failed, so cdkd does not know whether this resource holds data
    UNKNOWN: if MyBucket holds data, the destroy + recreate loses it (no automatic data migration)
```

The prompt lists only the targets of the stack you deploy. It does not show
replacements inside nested stacks. The prompt itself is described under
[Confirmation prompt](cli-deploy-safety-recreate.md#confirmation-prompt).

### Deletion protection blocks a replacement, and deploy cannot clear it

`--force-stateful-recreation` clears cdkd's guard. It does not clear AWS's. A
resource with deletion protection on refuses every delete, and a replacement
includes a delete. `cdkd destroy` has `--remove-protection` for this, but
`cdkd deploy` has no such flag. So no combination of replace flags deletes a
protected resource.

Turn protection off yourself, then run the deploy that replaces the resource:

```bash
# CloudWatch Logs: the log group whose LogGroupClass you are changing
aws logs put-log-group-deletion-protection \
  --log-group-identifier /my/log/group --no-deletion-protection-enabled

cdkd deploy MyStack --replace --force-stateful-recreation
```

Do it immediately before that deploy, or after a deploy that failed at the
delete. You are turning protection off on the resource that is about to be
deleted. The new resource is created from your template and gets whatever
protection the template declares, so there is nothing to turn back on.

> [!WARNING]
> If the deploy does not complete, protection stays off and no later
> `cdkd deploy` notices: the template and the state record both still say it
> is on. [`cdkd drift`](cli-drift.md) shows it, and `cdkd drift --revert`
> restores it.

#### What happens while protection is on

The outcome depends on whether the replacement deletes first or creates first.

- **Delete first: the deploy fails at the delete.** This order is used by the
  `--recreate-via-*` flags and by the fallback after a rejected update
  (`--replace`, or the Cloud Control fallback). `--replace` also uses it when
  it retries after a name collision, or after a create that returned the
  existing resource.
- **Create first: the deploy completes with a warning** that the old resource
  could not be deleted. This order is used by a property-driven replacement.
  The delete-first cases above also use it when the template renames the
  resource. The old resource and its data stay in AWS, no longer tracked by
  cdkd. Delete it yourself once protection is off.

#### Turning protection off in the template takes two deploys

For most types cdkd refuses the immutable change before it applies any
property. So removing the protection property in the same deploy has no
effect. Deploy once with protection off and the immutable change reverted,
then again with the change and the replace flags.

`AWS::Cognito::UserPool` is the exception. Its refusal comes after the update
applied `DeletionProtection`, so the failed deploy already turned protection
off and the next run succeeds.

#### Under `UpdateReplacePolicy: Retain`, leave protection on

A replacement under `Retain` never deletes the old resource, so protection
blocks nothing. When the replacement would land on the same physical name, as
it does for an `AWS::Logs::LogGroup`, it cannot complete either. It fails with
`NAMED_REPLACEMENT_IDEMPOTENT_CREATE` or `NAMED_REPLACEMENT_COLLISION`.

If you turned protection off, you would end up with the original resource, its
protection removed by hand, and the change still unapplied. Remove the
`Retain` policy or revert the immutable change instead.

#### Refusals that mention protection

When cdkd's records show protection on, the guard's refusals add a note, and
six types print the command that turns protection off. The note can be
missing when protection was enabled outside cdkd, while AWS still refuses the
delete. For an Auto Scaling group only the `prevent-all-deletion` level blocks
a replacement. The details are in
[cdkd deploy safety internals](cli-deploy-safety-internals.md#deletion-protection-what-each-refusal-reads).

### Always-stateful types

Deleting one of these loses all data in it, whatever its state.

| Category | Types |
| --- | --- |
| Database | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::RDS::DBSnapshot`, `AWS::RDS::ClusterSnapshot`, `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::DocDBElastic::Cluster`, `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::NeptuneGraph::Graph`, `AWS::NeptuneGraph::GraphSnapshot`, `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable`, `AWS::DynamoDB::Backup`, `AWS::Cassandra::Table`, `AWS::Lightsail::Database`, `AWS::Timestream::Database`, `AWS::Timestream::Table`, `AWS::Timestream::InfluxDBCluster`, `AWS::Timestream::InfluxDBInstance`, `AWS::ODB::CloudVmCluster`, `AWS::ODB::CloudAutonomousVmCluster` |
| Data warehouse | `AWS::Redshift::Cluster`, `AWS::RedshiftServerless::Namespace`, `AWS::RedshiftServerless::Snapshot` |
| In-memory data store | `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::ReplicationGroup`, `AWS::ElastiCache::ServerlessCache`, `AWS::MemoryDB::Cluster`, `AWS::MemoryDB::MultiRegionCluster` |
| Filesystem / blob | `AWS::EFS::FileSystem`, `AWS::FSx::FileSystem`, `AWS::FSx::Volume`, `AWS::ECR::Repository`, `AWS::ECR::PublicRepository`, `AWS::EC2::Volume`, `AWS::WorkspacesInstances::Volume`, `AWS::S3Express::DirectoryBucket`, `AWS::Lightsail::Bucket`, `AWS::S3Outposts::Bucket`, `AWS::HealthImaging::Datastore`, `AWS::HealthLake::FHIRDatastore` |
| Table / vector storage | `AWS::S3Tables::TableBucket`, `AWS::S3Tables::Table`, `AWS::S3Vectors::VectorBucket`, `AWS::S3Vectors::Index` |
| Managed compute with local storage | `AWS::EMR::Cluster`, `AWS::EKS::Cluster`, `AWS::SageMaker::Cluster` |
| Streaming / messaging | `AWS::Kinesis::Stream`, `AWS::KinesisVideo::Stream`, `AWS::MSK::Cluster`, `AWS::MSK::ServerlessCluster`, `AWS::MSK::Channel`, `AWS::AmazonMQ::Broker`, `AWS::OSIS::Pipeline`, `AWS::Events::Archive` |
| Search / index / collection | `AWS::Elasticsearch::Domain`, `AWS::OpenSearchService::Domain`, `AWS::OpenSearchServerless::Collection`, `AWS::OpenSearchServerless::Index`, `AWS::OpenSearchServerless::CollectionIndex`, `AWS::Kendra::Index`, `AWS::QBusiness::Index`, `AWS::QBusiness::Application`, `AWS::Rekognition::Collection`, `AWS::Location::GeofenceCollection`, `AWS::Bedrock::KnowledgeBase`, `AWS::Bedrock::DataAutomationLibrary` |
| Analytics pipelines | `AWS::IoTAnalytics::Channel`, `AWS::IoTAnalytics::Datastore`, `AWS::IoTAnalytics::Dataset`, `AWS::CleanRooms::IdMappingTable`, `AWS::CleanRooms::IntermediateTable` |
| Identity / config | `AWS::Cognito::UserPool`, `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter`, `AWS::AppConfig::ConfigurationProfile` |
| Runtime-written stores | `AWS::CloudFront::KeyValueStore`, `AWS::Connect::DataTable` |
| Backup vaults | `AWS::Backup::BackupVault`, `AWS::Backup::LogicallyAirGappedBackupVault` |
| Service domains holding records | `AWS::Cases::Domain`, `AWS::CustomerProfiles::Domain`, `AWS::DataZone::Domain`, `AWS::SageMaker::Domain` |
| Encryption keys | `AWS::CloudHSM::Cluster`, `AWS::KMS::Key`, `AWS::KMS::ReplicaKey` |
| Source control / artifacts | `AWS::CodeCommit::Repository`, `AWS::CodeArtifact::Repository`, `AWS::CodeArtifact::Domain` |
| Metadata catalog | `AWS::Glue::Database`, `AWS::Glue::Table` |
| Retained records | `AWS::IoTSiteWise::Workspace`, `AWS::AIOps::InvestigationGroup`, `AWS::SES::MailManagerArchive`, `AWS::Rbin::Rule` |
| Nested stacks | `AWS::CloudFormation::Stack` |
| Edge / identifier immutability | `AWS::CloudFront::Distribution`, `AWS::SMSVOICE::PhoneNumber`, `AWS::SMSVOICE::SenderId` |

Some entries are less obvious than a database:

- **A nested stack.** Replacing it destroys the whole child stack and every
  resource the child owns, with no guard for each resource. Its `StackName`
  cannot change, so a `StackName` edit deployed with
  `--prefer-sdk-route AWS::CloudFormation::Stack:StackName` is a replacement.
- **A KMS key.** The delete schedules the key for deletion. Once the waiting
  period ends, everything encrypted under the key is unrecoverable, including
  data in other stacks that only reference the key.
- **A CloudFront distribution.** A new distribution has a new URL, which
  breaks whatever uses the old one, and it takes roughly 20 minutes to
  propagate.
- **An SMS phone number or sender ID.** Releasing one returns it to the pool,
  and the replacement gets a different one.
- **An EKS or EMR cluster.** The replacement comes back empty: the Kubernetes
  objects you created, or the HDFS volumes on the core nodes, are gone.
- **A table bucket or a vector bucket.** Deleting one empties it first,
  whether or not you opted in.

The list only grows, and [the changelog](changelog-cdkd.md) records when each
type joined. When cdkd cannot know from outside whether a delete destroys
data, it guards the type. The reason for every category is in
[cdkd deploy safety internals](cli-deploy-safety-internals.md#why-each-category-is-on-the-list).

#### Types that are not guarded

cdkd replaces these without asking, as CloudFormation does:

- `AWS::EC2::Instance`. Its root volume is temporary by design. Keep
  persistent data on an `AWS::EC2::Volume`, which is guarded.
- `AWS::SQS::Queue`. The messages waiting in a queue are transient.
- `AWS::KMS::Alias`. Deleting an alias removes a pointer, and the key material
  stays.
- `AWS::S3Tables::Namespace`. AWS refuses to delete a namespace that still
  holds a table, so a replacement cannot take a table with it. A create-first
  replacement warns `Failed to delete old resource` and leaves the old
  namespace and its tables in AWS, untracked. A delete-first replacement fails
  at the delete.

### Conditionally stateful types

A bucket or a log group counts as stateful only when it may hold data.

| Type | Counts as stateful when |
| --- | --- |
| `AWS::S3::Bucket` | It holds at least one object version or delete marker |
| `AWS::Logs::LogGroup` | cdkd recorded a positive `RetentionInDays` for it, or it has at least one log stream |

### How the conditional types are judged, per path

Whether you need `--force-stateful-recreation` for a bucket or a log group
depends on when the guard runs
([Where the guard applies](#where-the-guard-applies)).

| The guard runs | Paths | A bucket or log group is stateful |
| --- | --- | --- |
| Before anything is touched | `--recreate-via-cc-api`, `--recreate-via-sdk-provider` | When a live check finds data |
| Mid-deploy | `--replace`, property-driven replacement, the Cloud Control fallback | Always |

Mid-deploy no check can run, so every bucket and every log group needs the
flag. The one exemption there is `UpdateReplacePolicy: Retain`. The old
resource stays, so there is no data loss to confirm.

Before a named recreate, cdkd asks AWS once for each target.

For a bucket, cdkd lists one object version or delete marker. Deleted objects
that a versioned bucket still keeps as old versions therefore count as data.
A listing that comes back incomplete also counts as data.

For a log group, cdkd lists one log stream. A group that has a stream counts
as holding data, even when the stream is empty.

> [!WARNING]
> The two checks differ when they fail. If cdkd cannot check a log group, it
> warns and treats the group as stateful. If cdkd cannot check a bucket (a
> missing `s3:ListBucketVersions` permission, for example), it warns and lets
> the recreate proceed without the flag. Decide for yourself whether that
> bucket holds data before you confirm.

#### Edge cases

- **AWS answers that the bucket or the log group does not exist.** That counts
  as empty.
- **AWS throttles the check.** cdkd retries up to three times first.
- **A log group with `RetentionInDays` unset or zero.** That setting means the
  log group never expires, so it says nothing about the group being empty.
  Before a named recreate the stream check decides, and mid-deploy the group
  counts as stateful.
- **A positive retention that cdkd did not set.** It counts wherever cdkd
  recorded it. That includes one set outside cdkd, in the console or with
  `aws logs put-retention-policy`, and a string such as `'30'`.

The exact rules of the two checks, and how `RetentionInDays` values are read,
are in
[cdkd deploy safety internals](cli-deploy-safety-internals.md#the-emptiness-probes).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The deploy finished and every resource cdkd was responsible for was addressed. |
| `1` | A guard refused the run, a `--require-approval` question was declined or could not be asked, or the deploy failed. |
| `2` | A partial outcome: a resource left unaddressed, a macro that failed to expand, or an update rejected as unsupported. |

[`--allow-unaddressed`](cli-deploy-safety-ci-flags.md#allow-unaddressed-deploy)
turns the first of those `2` cases back into `0`. The other two are unaffected
by it.

## Related

- [cdkd deploy](cli-deploy.md): concurrency flags and the wait-semantics table
- [cdkd deploy: tuning](cli-deploy-tuning.md): timeouts, name prefixing, observed-state capture
- [cdkd destroy](cli-destroy.md): the destroy-side data guards and `--remove-protection`
- [Provisioning Layers](provisioning-layers.md): the SDK provider and Cloud Control routes
- [Supported Resources](supported-resources.md): the per-type tier table and property-level coverage
- [cdkd deploy safety internals](cli-deploy-safety-internals.md): the exact rules behind the guards on this page
