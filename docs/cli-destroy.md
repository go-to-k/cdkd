---
title: Destroy flags & guards
description: "What cdkd destroy deletes, what it keeps or refuses to delete and why, how to preview it, and the flags that change each guard."
---

# Destroy flags & guards

`cdkd destroy` deletes every resource a stack's state record lists, then the
state record itself. It asks first, and it stops short of anything that would
lose data without an opt-in: a non-empty bucket, a protected database, a
resource with `DeletionPolicy: Retain` or `Snapshot`.
[`cdkd state destroy`](cli-state.md#cdkd-state-destroy) does the same from the
state record alone, without the CDK app, and behaves the same way except where
noted.

```bash
cdkd destroy MyStack                        # one stack, with a confirmation prompt
cdkd destroy 'MyStage/*' --yes              # every stack under a Stage, no prompt
cdkd destroy --all -f                       # every top-level stack in the CDK app
cdkd destroy MyStack --remove-protection    # turn deletion protection off first
cdkd destroy MyStack --skip-final-snapshot  # skip the DeletionPolicy: Snapshot snapshots
cdkd state destroy MyStack --yes            # no CDK app needed, reads state only
```

## What a destroy removes, keeps and leaves behind

There is no `--dry-run`. To preview, run the command without `--yes`: it prints
every resource it would delete and waits. Answer `n` and nothing has been
locked or deleted.

```text
$ cdkd destroy MyStack

Resources to be deleted (3):
  - Queue (AWS::SQS::Queue)
  - Handler (AWS::Lambda::Function)
  - Uploads (AWS::S3::Bucket)

Are you sure you want to destroy stack MyStack and delete all 3 resources? (Y/n): y
  ✓ Handler (AWS::Lambda::Function) deleted
  ✓ Queue (AWS::SQS::Queue) deleted
  ⊘ Uploads (AWS::S3::Bucket) retained — DeletionPolicy: Retain

✓ Stack MyStack destroyed (2 deleted, 1 retained, 0 errors)
```

The output above is trimmed to the lines you act on.
[`cdkd state resources MyStack`](cli-state.md#cdkd-state-resources) prints the
same list without starting a destroy.

```text diagram=destroy-flow
 Select stacks (a consumer before the producers it reads from)
   │
   ▼
 Checks that refuse before anything changes
   terminationProtection, an output another stack still imports,
   a damaged state record, no --yes on a non-interactive stdin
   │
   ▼
 List the resources and ask to confirm
   │
   ▼
 Take the stack lock, delete resources (dependents first)
   Retain    → left in AWS, record dropped
   Snapshot  → final snapshot taken, then deleted
   │
   ├─ every delete confirmed ─────▶ state.json and lock.json removed, exit 0
   │                                (event history kept unless --purge-events)
   │
   └─ a delete failed or was skipped, or Ctrl-C
                                 ─▶ state.json kept with what is left, exit 2
```

Each resource ends in one of four outcomes, counted on the summary line:

| Outcome | AWS resource | State record | Summary |
| --- | --- | --- | --- |
| deleted | Gone | Dropped | `N deleted` |
| retained (`DeletionPolicy: Retain`) | Kept on purpose | Dropped | `N retained` |
| skipped | May still exist | Kept | `N skipped`, exit `2` |
| failed | May still exist | Kept | `N errors`, exit `2` |

A run with skips or errors keeps `state.json`, trimmed to the resources that
are left, so re-running the same command finishes the job.

### What is still there after a clean destroy

| Left behind | Why | To remove it |
| --- | --- | --- |
| Resources with `DeletionPolicy: Retain` | The policy asks for it. cdkd no longer tracks them. | Delete them in AWS. |
| Final snapshots of `DeletionPolicy: Snapshot` resources | The policy asks for it. They are billed. | Delete them in AWS, or pass `--skip-final-snapshot` next time. |
| The stack's deployment-event history | Kept as a post-mortem. | `--purge-events`, or [`cdkd events prune`](cli-events.md). |
| Resources an earlier rollback retained (`orphans`) | They were never in the resource list. They are listed before the prompt. | Delete them in AWS. |
| Stacks inside a CDK Stage, under `--all` | `--all` selects top-level stacks only. | `cdkd destroy 'MyStage/*'` or `'**'`. |

### What stops a destroy

| Guard | What you see | Way through |
| --- | --- | --- |
| No `--yes` on a non-interactive stdin | `NON_INTERACTIVE_CONFIRM`, exit `1` | Pass `--yes`. See [Non-interactive runs](#non-interactive-runs). |
| The stack has `terminationProtection: true` | `STACK_TERMINATION_PROTECTION`; the stack is counted as an error, exit `2` | Set it to `false` and redeploy, or pass [`--remove-protection`](#remove-protection-bypass-deletion-protection-on-destroy). |
| Another stack still imports one of its outputs | `STACK_HAS_ACTIVE_IMPORTS` | Destroy the consumer first. See [Cross-Stack References](cross-stack-references.md). |
| A non-empty S3 bucket or ECR repository | The resource fails, exit `2` | Opt in or empty it. See [the data guards](#destroy-data-guards-non-empty-s3-buckets-and-image-carrying-ecr-repositories). |
| A resource with deletion protection on | The resource fails with the AWS error, exit `2` | [`--remove-protection`](#remove-protection-bypass-deletion-protection-on-destroy). |
| A `Snapshot` resource cdkd cannot snapshot | The resource is refused, exit `2` | Snapshot by hand, then [`--skip-final-snapshot`](#when-cdkd-refuses-to-delete). |
| A nested-stack child named directly | Refused, exit `2` | Destroy the parent. See [Stack selection](#stack-selection). |
| A damaged state record | `STATE_RESOURCES_MALFORMED`, exit `1` | Repair the record. See [A damaged state record](#a-damaged-state-record-refuses-the-destroy). |

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to destroy: CDK display paths with `*` / `**`, or exact physical names. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--all` | off | Destroy every top-level stack in the CDK app (Stage stacks: `'**'`). |
| `-y`, `--yes` | off | Answer the confirmation prompts automatically. |
| `-f`, `--force` | off | Same as `--yes` on `cdkd destroy`. |
| `--remove-protection` | off | Flip deletion protection off in place before each delete. |
| `--skip-final-snapshot` | off | Delete `DeletionPolicy: Snapshot` resources without the final snapshot (data loss). |
| `--purge-events` | off | After a clean destroy, also delete the stack's deployment-event history. |
| `--allow-unsupported-types <types>` | — | Comma-separated escape hatch for the pre-flight unsupported-type rejection. |
| `--resource-warn-after <duration>` | `5m` | Warn when one resource delete runs long. Repeatable, and accepts `TYPE=DURATION`. |
| `--resource-timeout <duration>` | `30m` | Abort one resource delete that runs long. Repeatable, and accepts `TYPE=DURATION`. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--verbose` | off | Verbose logging. |

The two `--resource-*` flags share their syntax with `cdkd deploy`; see
[per-resource timeout](cli-deploy-tuning.md#per-resource-timeout).

## Stack selection

| You pass | It selects |
| --- | --- |
| Nothing, in an app with a single stack | That stack. |
| `MyStage/Api` | The stack at that CDK display path. |
| `MyStage-Api` | The stack with that exact physical CloudFormation name. |
| `'MyStage/*'` | Every stack one level under `MyStage`. `*` stays within one `/` segment. |
| `'**'` | Every stack in the app, Stage stacks included. |
| `--all` | Every top-level stack, as `cdk destroy --all` does. |

Pattern syntax is the same as everywhere else; see
[stack selection](cli-list.md#selecting-stacks). When more than one stack is
selected, a consumer stack is destroyed before the producers it reads from.

`--all` leaves stacks inside a CDK Stage running and names them in one warning
line. An app whose every stack is inside a Stage is refused under `--all`.

A name that matches nothing is reported with a warning, as in the AWS CDK CLI.
A name that is in state but is not a stack of this app (a nested child, or
another app's stack sharing the bucket), passed beside names that matched, gets
its own warning and is skipped.

### Without a working CDK app

Display paths and wildcards are matched against the synthesized app, because a
state record carries physical names only. So what works depends on whether
synthesis succeeded:

| Situation | `--all` and wildcards | An exact physical name |
| --- | --- | --- |
| The app synthesizes and has stacks | Work | Works |
| The app synthesizes but yields no stacks | Refused | Resolves from state |
| Synthesis failed, or no app is configured | Refused; a synthesis error prints as the `Caused by:` line | Resolves from state |
| A CDK Stage failed to load | Refused | Refused too, as in the AWS CDK CLI |

`--all` and wildcards never fall back to every stack in the state bucket: the
bucket can hold the stacks of every app that shares it.

`cdkd state destroy '<stack>'` never synthesizes, so it works in every row. It
matches physical names only. The failed-Stage error names that command; see
[the failed-Stage note](cli-deploy-safety.md#a-pre-synthesized-assembly-is-trusted-input).

### Nested stacks

A nested-stack child cannot be destroyed directly. `cdkd destroy '<child>'` is
refused, because the parent's `AWS::CloudFormation::Stack` row would then point
at resources that no longer exist and the parent's next deploy would try to
recreate them.

Destroy the parent, which deletes the child with it. If you do want to leave
the parent's reference dangling, use `cdkd state destroy '<child>'`.

## Confirmation prompts

`cdkd destroy` asks before deleting anything.

| Prompt | Raised by | Skipped by |
| --- | --- | --- |
| Per-stack (`Are you sure you want to destroy stack X ...`) | `cdkd destroy '<stack>'`, `cdkd destroy --all` | `-y` / `--yes`, `-f` / `--force` |
| Per-stack, same prompt | `cdkd state destroy '<stack>'` | `-y` / `--yes` only — `cdkd state destroy` does not accept `-f` / `--force` |

The default answer is yes (`Y/n`). Under `--remove-protection` the prompt names
the protected resources and its default flips to no (`y/N`):

```text
About to destroy 12 resources from stack MyStack, REMOVING DELETION PROTECTION on 2 of them. Continue? (y/N):
```

A stack whose rollback journal records resources adds
`and J recorded only in its rollback journal` after the resource count, and
the protected count includes those. A stack name that is not a plain
identifier is shown JSON-quoted with its control characters removed.

Nested-stack children are destroyed as part of their parent and never prompt
separately.

### Non-interactive runs

The prompt is interactive-only. When stdin is not a TTY (a piped, redirected or
CI run) the command refuses before creating the prompt, with the code
`NON_INTERACTIVE_CONFIRM` and exit `1`. Piping `y` in does not work. Pass
`--yes` / `-y`, or `-f` / `--force`.

```bash
cdkd destroy MyStack --yes   # CI
```

`cdkd deploy` assumes yes on a non-TTY because a deploy is recoverable. A
destroy refuses instead, since answering yes for an absent operator would
delete every resource in the stack.

A refused run has locked nothing and deleted nothing. It has read other
stacks' state records, for the check that no stack still imports from this one.

A stack whose state record holds zero resources is the exception: it never
reaches the prompt. cdkd takes the lock and deletes the empty record, so a
non-interactive run of it succeeds without `--yes`.

Ten other commands follow the same rule; see
[Every other mutating confirmation prompt is interactive-only too](#every-other-mutating-confirmation-prompt-is-interactive-only-too).

## Destroy data guards: non-empty S3 buckets and image-carrying ECR repositories

Three resource types have a delete API that refuses while they still hold
data. `cdkd destroy` and `cdkd state destroy` match CloudFormation here: the
delete fails and the data survives unless the resource opted in.

| Resource type | Without the opt-in | Opt-in | With the opt-in |
| --- | --- | --- | --- |
| `AWS::S3::Bucket` | Fails with a "bucket is not empty" error. | CDK `autoDeleteObjects: true` (the `aws-cdk:auto-delete-objects` tag). | Every object version and delete marker is deleted, then the bucket. |
| `AWS::ECR::Repository` | Fails with a "still contains images" error. | CDK `emptyOnDelete: true`, or the legacy `autoDeleteImages` (the `aws-cdk:auto-delete-images` tag). | The repository is deleted with `force: true`. |
| `AWS::S3Express::DirectoryBucket` | Fails with an "is not empty" error. | The `aws-cdk:auto-delete-objects` tag set to `true` in the bucket's `Tags`. | The bucket is emptied, then deleted. |

```ts
import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';

new s3.Bucket(this, 'Uploads', {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true, // destroy empties the bucket, then deletes it
});

new ecr.Repository(this, 'Images', {
  removalPolicy: RemovalPolicy.DESTROY,
  emptyOnDelete: true, // destroy deletes the repository with its images
});
```

CDK has no `autoDeleteObjects` for a directory bucket, so declare the tag on
the L1 `CfnDirectoryBucket`.

For both bucket types the emptying retries, so objects written while it runs
are picked up. That includes objects such as ALB access logs that land between
the auto-delete custom resource's cleanup and the bucket deletion.

### Destroying without redeploying

Empty the data by hand, then re-run the destroy:

```bash
# S3: a versioned bucket also needs every object version and delete marker deleted.
# S3 Express directory buckets have no versioning, so this is enough for them.
aws s3 rm s3://<bucket> --recursive
aws ecr batch-delete-image --repository-name <repo> --image-ids <ids>

cdkd destroy MyStack
```

### A replacement during `cdkd deploy`

When a deploy replaces one of these resources, the delete of the old copy is
governed by `--force-stateful-recreation` instead. Passing that flag accepts a
data-losing recreation, and it also authorizes emptying the replaced resource.
That applies to all three types.

### Compared with other tools

CloudFormation reports `DELETE_FAILED` in all three cases; for ECR, unless
`EmptyOnDelete: true` is set. Terraform requires `force_destroy` on a bucket
and `force_delete` on a repository.

cdkd also follows CloudFormation in two deletes that go the other way: an
`AWS::SecretsManager::Secret` is hard-deleted with no recovery window, and IAM
role policy attachments made outside the template are force-detached.

## `DeletionPolicy: Snapshot`: final snapshots on delete (`--skip-final-snapshot`)

CloudFormation takes a final snapshot before deleting a resource whose
`DeletionPolicy` is `Snapshot`, and cdkd does the same on every delete path.
You meet this with plain CDK database stacks: the RDS L2 constructs
(`DatabaseInstance`, `DatabaseCluster`) default `removalPolicy` to `SNAPSHOT`.

```bash
cdkd destroy MyStack                        # final snapshot first, per the policy
cdkd destroy MyStack --skip-final-snapshot  # delete without it (data loss)
cdkd state destroy MyStack --skip-final-snapshot --yes
cdkd rollback MyStack --skip-final-snapshot
```

`--skip-final-snapshot` is accepted by `cdkd deploy`, `cdkd destroy`,
`cdkd state destroy` and `cdkd rollback`. Use it for dev and test stacks where
the snapshot's cost and wait are unwanted, and to get past the refusal below.

> [!WARNING]
> Final snapshots are billed AWS resources that survive the destroy. Delete
> them yourself when you no longer need them.

### How the final snapshot is created, by type

| Resource type | How the final snapshot is created |
| --- | --- |
| `AWS::RDS::DBInstance` | `DeleteDBInstance` with `FinalDBSnapshotIdentifier`. A cluster member is deleted without one, as in CloudFormation. |
| `AWS::RDS::DBCluster` | `DeleteDBCluster` with `FinalDBSnapshotIdentifier`. |
| `AWS::Neptune::DBCluster` | `DeleteDBCluster` with `FinalDBSnapshotIdentifier` (Neptune). |
| `AWS::DocDB::DBCluster` | `DeleteDBCluster` with `FinalDBSnapshotIdentifier` (DocDB). |
| `AWS::ElastiCache::CacheCluster` | `DeleteCacheCluster` with `FinalSnapshotIdentifier`. Redis engine only. |
| `AWS::EC2::Volume` | `CreateSnapshot`, waited to `completed`, then `DeleteVolume`. |
| `AWS::Redshift::Cluster` | `CreateClusterSnapshot`, waited to `available`, then the delete. |
| `AWS::ElastiCache::ReplicationGroup` | ElastiCache `CreateSnapshot`, waited to `available`, then the delete. Redis only. |

A Memcached cache cluster or replication group, and a node type that cannot
snapshot, fail with AWS's rejection. CloudFormation reports `DELETE_FAILED`
for the same resources.

An EC2 volume's snapshot is tagged `cdkd:final-snapshot-of: <volumeId>`, so a
destroy re-run reuses it. For Redshift and ElastiCache, a re-run after the
snapshot completed creates a second, timestamped one, because their snapshot
names are reusable and an existing one could hold older data.
[Per-type notes](cli-destroy-internals.md#per-type-notes) has the rest.

### Finding the snapshot afterwards

The snapshot is named `<base>-final-<utcTimestamp>`. The timestamp is
`yyyymmdd-hhmmss` in UTC, and `<base>` is the physical id with these rules
applied:

| Step | Rule |
| --- | --- |
| Case | Lowercased. |
| Characters | Every character outside `a-z`, `0-9` and `-` becomes `-`; runs of `-` collapse to one; leading and trailing `-` are dropped. |
| First character | `r` is prepended when it does not start with a letter. |
| Length | ElastiCache only: cut to the first 28 characters, then any trailing `-` is dropped. |

EC2 volumes, Redshift clusters and replication groups log the identifier as
they create the snapshot. The other five types log only that the delete takes
a final snapshot, because the identifier spells the physical id, which may
come from a secret. Find those among the service's manual snapshots by prefix:

```bash
# RDS DBCluster (for DocDB and Neptune, run the same command as `aws docdb` / `aws neptune`)
aws rds describe-db-cluster-snapshots --snapshot-type manual \
  --query "DBClusterSnapshots[?starts_with(DBClusterSnapshotIdentifier, 'my-cluster-final-')].DBClusterSnapshotIdentifier"
# RDS DBInstance
aws rds describe-db-snapshots --snapshot-type manual \
  --query "DBSnapshots[?starts_with(DBSnapshotIdentifier, 'my-instance-final-')].DBSnapshotIdentifier"
# ElastiCache CacheCluster
aws elasticache describe-snapshots \
  --query "Snapshots[?starts_with(SnapshotName, 'my-cache-final-')].SnapshotName"
```

### When cdkd refuses to delete

One of the five types whose delete call takes the snapshot (RDS instances and
clusters, Neptune and DocDB clusters, ElastiCache cache clusters) can be
managed through Cloud Control instead of its SDK provider. Its state record
then says `provisionedBy: cc-api`. Cloud Control's delete has no
final-snapshot parameter, so cdkd cannot honor the policy on that route and
refuses the delete.

Snapshot the resource by hand, then re-run with `--skip-final-snapshot`.

### Which policy cdkd reads

A destroy reads the `deletionPolicy` recorded in state, never the template's
attribute. State written before schema v5 has none recorded until a redeploy
records it. A deploy that removes a resource from the template falls back to
the template's `DeletionPolicy` when none is recorded.

With no policy recorded, cdkd applies CloudFormation's default:

| Resource | Default |
| --- | --- |
| `AWS::RDS::DBCluster` | `Snapshot` |
| `AWS::RDS::DBInstance` without `DBClusterIdentifier` | `Snapshot` |
| Every other resource, including a cluster-member `AWS::RDS::DBInstance` | `Delete` |

So an L1 `CfnDBCluster` or standalone `CfnDBInstance` with no `DeletionPolicy`
gets a final snapshot on destroy, on a deploy that removes it, and on a
rollback of its creation. A Cloud-Control-routed one is refused like an
explicit `Snapshot`. Pass `--skip-final-snapshot` to delete without one.

`UpdateReplacePolicy` defaults to `Delete` for every type, so replacement
deletes are unaffected.

### Deletes outside `cdkd destroy`

The same policy applies wherever cdkd deletes a resource:

| Delete | Governing policy |
| --- | --- |
| `cdkd destroy`, `cdkd state destroy`, a deploy that removes the resource | `DeletionPolicy` |
| A rollback of its creation (automatic, `cdkd rollback`, `--revert-failed`) | `DeletionPolicy` |
| A replacement's delete of the old copy, or a rollback's delete of a replacement's new copy | `UpdateReplacePolicy`, whose default is `Delete` for every type |
| A rollback's delete of a failed replacement's new copy (its create made it, then failed) | `DeletionPolicy`, journaled with it as for a failed creation |

A type or route cdkd cannot snapshot always fails the resource, at every one
of these deletes, matching CloudFormation failing the update. What each delete
does when a snapshot fails part-way, and how the Cloud Control route behaves
under `DeletionPolicy: Delete`, is in
[Destroy internals](cli-destroy-internals.md#final-snapshots).

## `--remove-protection`: bypass deletion protection on destroy

`cdkd destroy --remove-protection` and `cdkd state destroy
--remove-protection` turn every protection flag off in place before each
delete, so the destroy proceeds without an edit, a redeploy or a console
click.

```bash
# Stack with terminationProtection: true, or a protected DynamoDB / RDS / Logs / EC2 / LB
cdkd destroy MyStack --remove-protection
cdkd destroy --all --remove-protection -y

# Without the CDK app. The resource-level flip applies the same way.
cdkd state destroy MyStack --remove-protection -y
```

Without the flag cdkd sends the delete as it is and AWS rejects it. For RDS
and Cognito that is `InvalidParameterCombination` or
`InvalidParameterException`, also when the protection was set outside cdkd
(console, AWS CLI).

The flag covers two levels:

- **Stack-level** `terminationProtection`. The bypass logs a warning naming
  the stack. `cdkd state destroy` never sees this flag, because it is a CDK
  property that only synthesis reports, so there the stack-level part is a
  no-op.
- **Resource-level** protection on the types below.

| Resource type | Protection field | Bypass call |
| --- | --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` | `PutLogGroupDeletionProtection(deletionProtectionEnabled=false)` |
| `AWS::RDS::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::RDS::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (DocDB). A DocDB instance has no such field. |
| `AWS::Neptune::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (Neptune) |
| `AWS::Neptune::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` (Neptune) |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` | `UpdateTable(DeletionProtectionEnabled=false)`, then a wait until `ACTIVE` |
| `AWS::DynamoDB::GlobalTable` | `DeletionProtectionEnabled` | `UpdateTable(DeletionProtectionEnabled=false)`, then a wait until `ACTIVE` |
| `AWS::EC2::Instance` | `DisableApiTermination` | `ModifyInstanceAttribute(DisableApiTermination={Value:false})` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` | `ModifyLoadBalancerAttributes` setting it to `false` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) | `UpdateUserPool(DeletionProtection='INACTIVE')`. See [Cognito user pools](#cognito-user-pools). |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection`, and `DisableApiTermination` on each instance it launched | `UpdateAutoScalingGroup(DeletionProtection='none')`, the per-instance flip, then `DeleteAutoScalingGroup(ForceDelete=true)` |
| `AWS::EMR::Cluster` | `Instances.TerminationProtected` | `SetTerminationProtection(TerminationProtected=false)`, then `TerminateJobFlows` |
| `AWS::DSQL::Cluster` | `DeletionProtectionEnabled` | Cloud Control `UpdateResource` patch to `false`, waited, then `DeleteResource` |
| `AWS::NeptuneGraph::Graph` | `DeletionProtection` | Same Cloud Control patch to `false` |
| `AWS::SMSVOICE::ProtectConfiguration` | `DeletionProtectionEnabled` | Same Cloud Control patch to `false` |
| `AWS::VerifiedPermissions::PolicyStore` | `DeletionProtection` (`{Mode: ENABLED\|DISABLED}`) | Same Cloud Control patch, to `{Mode: DISABLED}` |
| `AWS::EKS::Cluster` | `DeletionProtection` | Same Cloud Control patch to `false` |
| `AWS::RDS::GlobalCluster` | `DeletionProtection` | Same Cloud Control patch to `false` |
| `AWS::DocDB::GlobalCluster` | `DeletionProtection` | Same Cloud Control patch to `false` |

Protection not in the table, such as a CloudFront distribution or S3 bucket
retention, is not bypassed. The list is limited to the cases where AWS exposes
a synchronous call that turns the protection off.

An Auto Scaling group is deleted with `ForceDelete=true`, so AWS terminates
its running instances as part of the delete.

### Behaviour

- **One flag covers every type** in the table. There is no per-type variant.
- **The flip is sent whether or not protection is currently on.** AWS accepts
  the already-disabled case. A Cognito user pool is the exception, below.
- **A failed flip does not stop the delete.** It is logged at debug, and the
  delete call then reports its own error.
- **`cdkd deploy` has no counterpart.** A deploy that has to replace a
  protected resource fails at the delete whatever replace flags were passed.
  Clear the protection first; see
  [Deploy: safety & compatibility flags](cli-deploy-safety.md#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it).
- **`cdkd rollback --remove-protection`** does the same for the resources a
  rollback deletes. A deploy's automatic rollback never turns protection off.

The flag also reaches a resource that only the rollback journal records, when
cdkd can prove it is still the resource the failed deploy created. The proof
rules are in [Destroy internals](cli-destroy-internals.md#behaviour).

### Cognito user pools

`UpdateUserPool` resets every setting a call leaves out, among them self
sign-up, Lambda triggers and advanced security. So cdkd reads the pool first
and sends its own settings back with `DeletionProtection='INACTIVE'`. That
needs `cognito-idp:DescribeUserPool` beside `cognito-idp:UpdateUserPool` and
`cognito-idp:DeleteUserPool`.

| Case | What cdkd does |
| --- | --- |
| The pool already reads `INACTIVE` | Sends no `UpdateUserPool`. |
| AWS refuses the settings on validation | Warns and turns the guard off alone, so the delete can run. |
| The pool cannot be read, or AWS refuses for any other reason | Leaves the guard on and warns. The delete is then refused. |
| The delete fails after the guard was turned off | Turns the guard back on with the pool's own settings. |

The remaining cases (an SES email configuration, throttles, a timed-out
write) are in [Destroy internals](cli-destroy-internals.md#cognito-user-pools).

### Restoring a guard after a failed destroy

When cdkd turned a guard off and the delete then failed for good, cdkd turns
the guard back on before reporting the failure. A destroy that did not happen
does not leave a live resource with its protection stripped. This covers every
type in the table above, and each instance an Auto Scaling group launched.

The guard is not restored in these cases:

| Case | Result |
| --- | --- |
| Protection was already off before the run, or the read before the flip failed | Left as it was. |
| AWS accepted the delete call and a later wait gave up | Not restored: the resource is already being deleted. |
| A Cloud Control delete ended in a way that leaves "is it deleting?" open | Not restored. cdkd warns and prints the check and restore commands. |
| `--resource-timeout` fired | Guard left off. |
| The restore call itself failed | A separate ERROR line names the resource and its restore command. |

The read before the flip needs its own permission beside the flip and the
delete. A refused read leaves the delete running and restores nothing.

| Resource | Read permission |
| --- | --- |
| EC2 instance | `ec2:DescribeInstanceAttribute` |
| Load balancer | `elasticloadbalancing:DescribeLoadBalancerAttributes` |
| Auto Scaling group | `autoscaling:DescribeAutoScalingGroups`, plus `ec2:DescribeInstanceAttribute` for each instance it launched |
| A Cloud Control type | `cloudformation:GetResource`, plus whatever the type's read handler calls |

When restoring an instance's guard fails, cdkd reads the instance back with
`ec2:DescribeInstances`. With that permission, an instance that is shutting
down or terminated is reported at warn; without it, at ERROR.

To restore a guard by hand:

```bash
aws dynamodb update-table --table-name <table> --deletion-protection-enabled
aws rds modify-db-cluster --db-cluster-identifier <id> --deletion-protection --apply-immediately
aws rds modify-db-instance --db-instance-identifier <id> --deletion-protection --apply-immediately
aws logs put-log-group-deletion-protection --log-group-identifier <name> --deletion-protection-enabled
aws cognito-idp update-user-pool --user-pool-id <id> --deletion-protection ACTIVE
aws emr modify-cluster-attributes --cluster-id <id> --termination-protected
aws elbv2 modify-load-balancer-attributes --load-balancer-arn <arn> --attributes Key=deletion_protection.enabled,Value=true
aws autoscaling update-auto-scaling-group --auto-scaling-group-name <name> --deletion-protection <prevent-force-deletion|prevent-all-deletion>
aws ec2 modify-instance-attribute --instance-id <id> --disable-api-termination
aws cloudcontrol update-resource --type-name AWS::DSQL::Cluster --identifier <id> \
  --patch-document '[{"op":"add","path":"/DeletionProtectionEnabled","value":true}]'
aws cloudcontrol update-resource --type-name AWS::VerifiedPermissions::PolicyStore --identifier <id> \
  --patch-document '[{"op":"add","path":"/DeletionProtection","value":{"Mode":"ENABLED"}}]'
```

- DocDB and Neptune take the same `modify-db-cluster` / `modify-db-instance`
  form under `aws docdb` / `aws neptune`.
- The other Cloud Control types take the DSQL form with their own property
  from the table and the value `true`.
- Put an Auto Scaling group back at the level it had. The line cdkd prints
  names it.
- `update-user-pool` resets the pool settings it omits, so send the pool's
  complete configuration alongside `--deletion-protection`.
- A command cdkd prints carries the run's `--profile`, or a `'<role-profile>'`
  placeholder when the run used `--role-arn`. Add your profile to the commands
  above when you type them by hand, or they run against your default profile.

## `--purge-events`: also delete deployment-event history on destroy

By default `cdkd destroy` removes `state.json` and `lock.json` but keeps the
stack's deployment-event history (the `deployments/` store) as a post-mortem.
An object listing of the state bucket is therefore not empty after a teardown.
`--purge-events` deletes that history too:

```bash
cdkd destroy MyStack --purge-events -y
```

| Question | Answer |
| --- | --- |
| When does the purge run? | Only after a clean, uninterrupted destroy of that stack. A failed or interrupted destroy keeps its events for the retry. |
| A Ctrl-C after this stack was fully destroyed? | The purge still runs. Nothing is left to retry and the run reports success. |
| Several stacks? | Each cleanly destroyed stack is purged independently. |
| A purge failure? | Logs a warning. It never fails the destroy that already succeeded. |
| `cdkd state destroy`? | Does not take this flag. Use [`cdkd events prune '<stack>' --all`](cli-events.md), which also works for an already-destroyed stack. |

On a versioned state bucket the purge also deletes the earlier versions under
the stack's `deployments/` prefix, including streams an earlier delete left
behind a delete marker. That needs `s3:ListBucketVersions` and
`s3:DeleteObjectVersion`. Without them the destroy still succeeds and a
warning prints first. What the purge does not reach is listed in
[Deleting a run stream also purges its earlier versions](deployment-events.md#deleting-a-run-stream-also-purges-its-earlier-versions).

## Skipped resources on destroy

A skipped resource is one whose delete cdkd did not confirm, so it may still
exist and still be billing. cdkd keeps its state record on purpose: without it
you would have neither the resource deleted nor an id to delete it with. The
destroy exits `2`.

```text
⚠ Stack MyStack partially destroyed (4 deleted, 1 skipped, 0 errors). cdkd did not confirm the skipped resource(s) were deleted, so they may still exist in AWS. ...
```

Each skipped resource prints a `skipped (...)` line naming the cause, and a
warning saying what survived and how to repair it. The summary names the state
file to open.

### Custom resources

These are the skips most stacks can meet. cdkd addressed the resource
correctly, so nothing in the state record needs repair.

| Line | Meaning | What to do |
| --- | --- | --- |
| `skipped (Delete handler reported FAILED — resource unproven)` | The handler ran and refused. | Tear down what the handler manages by hand, then drop the record. |
| `skipped (Delete request to the handler did not complete — resource unproven)` | The invoke did not complete. | Same. |
| `skipped (backing Lambda function is gone — Delete handler not invoked)` | The function at the recorded `ServiceToken` no longer exists. | Redeploy a function at that exact ARN and re-run, or confirm what it managed is gone and drop the record. |

```bash
cdkd state orphan MyStack --stack-region us-east-1   # drop the record, touch nothing in AWS
```

The same destroy usually deletes the handler's Lambda too, so a second destroy
does not retry a failed handler. It finds the function gone and reports the
third line. You also get the third line when a shared provider stack was
destroyed before the stacks that use it.

CloudFormation behaves the same way: a custom resource whose delete cannot be
confirmed leaves the stack `DELETE_FAILED` until you retry with
`RetainResources`.

### A state record cdkd cannot address

In these cases cdkd sends no AWS call, because the record does not say which
resource to delete.

| Cause | What to do |
| --- | --- |
| `skipped (state record has no physical id)`: the `physicalId` is missing, empty or not a string | Repair the `physicalId` in `state.json` and re-run. |
| A composite `physicalId` that does not decode (`AWS::Glue::Table`, `AWS::AppSync::{DataSource,Resolver,ApiKey}`, `AWS::EC2::NetworkAclEntry`) | The warning names the expected format. Repair it and re-run. |
| A record missing the property its delete is addressed by (for example a Lambda permission's `FunctionName`, a custom resource's `ServiceToken`, an IAM policy's principals, a `UserToGroupAddition`'s `GroupName` / `Users`) | Repair the property and re-run. |
| A principal list that is not a list of IAM names | Repair the list and re-run. A list holding a `{{resolve:...}}` reference is resolved on destroy instead. |
| An address property stored as the `***` mask or as a secret `{{resolve:...}}` reference | Remove the resource by hand and drop the record. A redeploy records the same redaction again. |
| A nested stack whose own destroy skipped a resource or was interrupted | Repair the child's record (`<parent>~<childLogicalId>`), which the summary names. |

When the skipped resource's parent is part of the same destroy (the Lambda
function, the IAM role, group or user), deleting the parent removes it anyway.
AWS ends clean and only the cdkd record is stale. The warning says so, and
`cdkd state orphan '<stack>'` clears it.

To inspect a record, use `cdkd state show '<stack>'`. To drop one resource's
record rather than the whole stack's:

```bash
cdkd orphan 'MyStack/Handler/Permission'                                             # with the CDK app
cdkd state orphan MyStack --stack-region us-east-1 --resource HandlerPermissionABC123  # without it
```

Every record shape, what survives in each, and how a secret-derived principal
list is resolved are in
[Destroy internals](cli-destroy-internals.md#every-cause-of-a-skip).

### `N unverified` on the summary line

`N unverified` is not an outcome. The resources were deleted and their records
dropped. It counts pre-flight safety checks that ran, could not reach a
verdict, and were therefore not enforced. It does not change the exit code: a
destroy showing `1 unverified` and `0 errors` exits `0`.

A check can be suppressed by denying the permission it needs, so treat the
figure as unconfirmed rather than harmless. A warning under the summary names
the resources, and a `RESOURCE_GUARD_INDETERMINATE` event records each one;
see [Deployment Events](deployment-events.md).

### A skip on `cdkd deploy`, not just on destroy

`cdkd deploy` deletes too: resources removed from the template, and the old
copy of a replaced resource. The same skip can happen there.

| Deploy-side delete | On a skip |
| --- | --- |
| A resource removed from the template | Warns and keeps the state record, counted under `Skipped (not deleted)`. The run exits `2`. |
| The old resource of a replacement (`--replace`, `--recreate-via-*`, an in-place-unsupported UPDATE) | Fails the resource. The replacement would otherwise run beside a live old one, or collide with its name. |
| The cleanup delete after a create-first replacement | Warns. The old resource is untracked either way; delete it by hand. |
| A rollback delete (automatic, or `cdkd rollback`) | Counted as a failure, so the journal is kept and re-running `cdkd rollback` re-attempts it. |

One rollback delete is different: the delete of the new resource after the old
one was re-created. The revert itself succeeded, so a skip there only warns,
and the new resource is left untracked for you to delete by hand.

A deploy-side skip exits non-zero because the deploy did not apply the
template it was given. The kept record means the next run re-attempts the
delete. `--allow-unaddressed` restores exit `0` for callers who accept that;
see [`--allow-unaddressed` (deploy)](cli-deploy-safety.md#allow-unaddressed-deploy).

A custom resource whose backing Lambda is gone is treated differently on
deploy: the record is dropped with a warning, as CloudFormation ignores delete
failures in an update's cleanup phase.

### A nested stack whose child failed is an error, not a skip

When a resource inside a nested stack was attempted and failed, the parent's
`AWS::CloudFormation::Stack` row fails, as a failed delete of any other
resource does:

```text
✗ Failed to delete Child: Nested stack MyStack~Child failed to destroy: 1 resource(s) failed to delete.
  The child's state is PRESERVED and still lists them — inspect it with 'cdkd state show MyStack~Child',
  resolve the failure, and re-run the destroy. ...

⚠ Stack MyStack partially destroyed (2 deleted, 1 errors). State preserved ...   # exit 2
```

The remedy the summary prints names the child's state file
(`cdkd state orphan '<parent>~<child>'`), because the failed resource lives in
the child. Orphaning the parent would drop the row that keeps the child
reachable.

A run with both failures and skips prints each remedy separately. A failure is
retryable by running the destroy again. A skip needs its state record repaired
first.

`cdkd deploy` is affected too. Removing a nested stack from your template
deletes it through the deploy, so a child that fails to destroy fails the
deploy and its siblings roll back. Check that a nested stack destroys cleanly
before removing it from the template.

## Resources only the rollback journal records

A deploy can fail after a create call succeeded, for example a Kinesis stream
whose retention follow-up AWS rejected. That resource exists in AWS but has no
state record: the rollback journal is its only record, and destroying the
stack removes the journal. So when the journal is still there (under
`--no-rollback`, or when it outlived the rollback), `cdkd destroy` and
`cdkd state destroy` act on those resources first.

| Step | Behaviour |
| --- | --- |
| Before the prompt | Listed with its physical id, also on a `--yes` / `--force` run and when a nested child is destroyed with its parent. The prompt counts it. |
| Under the lock | The journal is read again. Any change to it, or a journal that can no longer be read, refuses the run before anything is deleted. |
| Before the stack's resources | Deleted per its journaled `DeletionPolicy`: `Retain` keeps it, `Snapshot` takes the final snapshot unless `--skip-final-snapshot`. |
| It may belong to something else | One that state, a later deploy or a rollback-orphan record may own is warned about and left alone. |
| A delete fails | Counted separately in the summary. State and journal are kept; re-run the destroy. |
| Only such resources remain | The stack is not empty, so it still asks for confirmation. |

When a delete can never succeed, check the resource by hand and drop that one
journal entry with the command the warning prints:

```bash
cdkd rollback MyStack --drop-failed MyStream
```

See [dropping one entry](cli-rollback.md#dropping-one-entry-cdkd-cannot-act-on).

A journal that the destroy cannot read is warned about and removed with the
state, and nothing it records is deleted. A record whose body region differs
from its key's is refused when its journal holds such a resource, as it is
when it lists resources. The rollback side is in
[Failed CREATEs that made their resource](cli-rollback.md#failed-creates-that-made-their-resource).

## Interrupting a destroy (Ctrl-C / SIGTERM)

`cdkd destroy` and `cdkd state destroy` shut down gracefully. CI cancellation
sends SIGTERM, which takes the same path as {kbd:ctrl+c}.

| Signal | What happens |
| --- | --- |
| First {kbd:ctrl+c} | No new deletes start. Deletes in flight finish, state is saved with what is left, the lock is released. Exit `2`. |
| Second {kbd:ctrl+c} | Force-quit without waiting for the in-flight call. Exit `130`. The stack lock may be left behind. |

```bash
cdkd destroy MyStack     # Ctrl-C: in-flight deletes finish, state is preserved
cdkd destroy MyStack     # the re-run picks up the remaining resources
```

After the first signal the command prints
`Destroy interrupted by Ctrl-C. State preserved`. Under `--all` it also stops
before the next stack starts.

A first signal that arrives before a stack's graceful stop is armed (the short
window after the stack is picked up) is a force-quit too.

After a force-quit, cdkd prints the command that clears the lock:

```bash
cdkd force-unlock MyStack --stack-region us-east-1
cdkd destroy MyStack
```

When the signal arrives between two stacks, or before a stack's teardown has
started, cdkd cannot know which lock to name and prints
`cdkd force-unlock <stack-name>` for you to fill in.

The non-zero exit means work was left undone. A signal that lands after the
last stack was already destroyed leaves nothing to re-run, so that run exits
`0`.

An interrupted stack keeps its `state.json` and its deployment-event history,
which is why `--purge-events` is skipped for it.

## A damaged state record refuses the destroy

A state record that was hand-edited or truncated can hold the wrong shape in a
field the destroy depends on. cdkd refuses such a record before the
confirmation prompt, with `STATE_RESOURCES_MALFORMED` and exit `1`, naming the
record and its region. It refuses rather than guesses because every guess
loses something: read as empty, a damaged resource list would delete the
record and leave every resource live in AWS.

| Field | Refused when | An absent field |
| --- | --- | --- |
| `resources` | It is not an object: a string, a list, a number, a boolean, `null`. | Refused. A stack always has a resource map. |
| One row of `resources` | It is not an object, or has no `resourceType`. | — |
| A row's `properties` | It is missing or not an object. | Refused. |
| `outputs` | It is not an object. | Fine. cdkd writes such records on purpose. |
| `orphans` | It is not a list, or holds a record no reader can use, or two records share a `logicalId`. | Fine. |

A nested child record reached through its parent's destroy is checked the same
way.

To fix it, inspect the record, repair it in the state bucket, and re-run:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

For a damaged `resources`, `outputs` or `orphans` container, when you want the
record gone and the live resources left standing, `cdkd state orphan` drops it
without touching AWS:

```bash
cdkd state orphan MyStack --stack-region us-east-1
```

Drop `--stack-region` for a legacy record that carries no region of its own.
Prefer repairing when the resources still matter, because orphaning leaves
them untracked.

The sections below say what each refusal protects. The reasoning and the
per-shape behaviour are in
[Destroy internals](cli-destroy-internals.md#damaged-state-records), and the
per-command tables are in [State Management](state-management.md).

### A malformed `resources` map refuses the destroy

The `resources` map is the list of what a destroy deletes. A map that is not
an object names nothing cdkd can delete, so the run could only remove the
record and report success with every resource still live.

A malformed child record fails the parent's destroy: the parent finishes its
other deletes, ends with errors, and keeps its own state. Repair the child's
record and re-run. Under `--all` the refusal ends the run, and the stacks not
yet reached are untouched.

The refusal prints the `cdkd state orphan` command as a template. When the
stack name or region is not a plain identifier, it prints no target at all and
points you at `cdkd state list --json` to read the exact name. See
[State Management](state-management.md#when-resources-is-not-an-object).

### An unreadable resource record refuses the destroy

One row of the map is `null`, a string, a list, or an object with no
`resourceType`. cdkd cannot choose how to delete it. The refusal names the
rows and offers no `cdkd state orphan` template, because every other row is
readable and dropping the whole record is more than one row asks for.

A row that names its type but has no usable `physicalId` is not refused. It is
skipped on its own; see
[Skipped resources on destroy](#skipped-resources-on-destroy). The per-command
table is in
[State Management](state-management.md#when-one-resources-record-cannot-be-read).

### An unreadable `properties` map refuses the destroy

A row's `properties` decide what its delete does: whether an RDS instance
takes a final snapshot, whether an ECR repository is emptied first, which
resources the `--remove-protection` prompt counts. The delete order is built
from them too. Read as empty, they would send the delete down the wrong branch
after earlier resources were already gone.

A row that its own `DeletionPolicy` retains is refused as well, because its
references still order the other deletes.

### A malformed `outputs` map refuses the destroy

The destroy uses `outputs` to decide whether to check that no other stack
still imports from this one. A damaged map would either invent exports or skip
the check and delete a record that consumers still resolve against.

### A malformed `orphans` list refuses the destroy

`orphans` records the `DeletionPolicy: Retain` resources an earlier failed
deploy left in AWS. The destroy lists them before deleting anything, which is
your only notice that they stop being tracked. A damaged list would hide them.
This refusal is checked at the first read and again under the lock. The
per-command tables are in State Management:
[the container](state-management.md#when-orphans-is-not-a-list) and
[a single record](state-management.md#when-one-orphans-record-cannot-be-read).

## Every other mutating confirmation prompt is interactive-only too

Ten more commands prompt before a mutation, and all of them follow the same
rule as the destroy prompt: on a non-TTY stdin each refuses before creating
the prompt, with the code `NON_INTERACTIVE_CONFIRM` and exit `1`. The message
names the command and the flag that avoids the prompt. Piping `y` in does not
work.

| Command | Prompt | Flag that avoids it |
| --- | --- | --- |
| `cdkd rollback` | `Roll back <stack> (<region>)?` | `--force` (or `-y` / `--yes`) |
| `cdkd state orphan` | `Remove state for <refs> from s3://...?` | `-y` / `--yes`, or `-f` / `--force` |
| `cdkd state orphan --resource` | `Remove the record(s) of <ids> from state for <stack> (<region>)?` | `-y` / `--yes` (`-f` / `--force` too, but it also enables the cached-attribute fallback) |
| `cdkd state refresh-observed` | `Refresh observedProperties for N stack(s)...?` | `-y` / `--yes` |
| `cdkd orphan` | `Orphan N resource(s) from cdkd state...?` | `-y` / `--yes`, or `-f` / `--force` |
| `cdkd import` | `Write state for <stack> with N resource(s)?` | `-y` / `--yes` |
| `cdkd export` | the rollback-journal override, the migration confirm, and the nested-stack tree-wide confirm | `-y` / `--yes` |
| `cdkd drift --accept` / `--revert` | `Update cdkd state...?` / `Push cdkd state values back into AWS...?` | `-y` / `--yes` |
| `cdkd import --migrate-from-cloudformation` | `Set DeletionPolicy=Retain ... then delete the stack?` | `-y` / `--yes` |
| `cdkd state migrate` | `Copy N object(s) from <bucket> to <bucket>...?` | `-y` / `--yes` |
| `cdkd events prune` | `Prune deployment-event history for <stack> (<region>): <scope>?` | `-y` / `--yes` |

`cdkd state refresh-observed --dry-run` and `cdkd state migrate --dry-run`
return before the prompt, so a preview needs no flag and runs unattended.

`cdkd deploy`'s asset-storage auto-create prompt is the one exception. It
assumes yes on a non-TTY, because a deploy is recoverable.

### What survives a refusal

No partial mutation survives a refusal, and no lock is leaked. Two details:

- **Four commands hold the stack lock at the prompt**: `cdkd orphan`,
  `cdkd import`, `cdkd export` (its migration and nested-tree prompts) and
  `cdkd rollback`. Each releases it on the way out, so a re-run with the flag
  is not blocked by the run that refused.
- **`cdkd import --migrate-from-cloudformation` has already written cdkd
  state** when its prompt is reached, because retiring the CloudFormation
  stack is its last step. A refusal leaves the resources recorded in cdkd
  state while the CloudFormation stack is still live. The message says so.
  Child templates it uploaded to `cdkd-migrate-tmp/` are deleted on the
  refusing path, as they are when you answer `n`.

Every other prompt refuses after read-only work only.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Everything was destroyed. |
| `1` | Hard error, including a confirmation prompt refused on a non-interactive stdin. |
| `2` | Partial: resources failed or were skipped, or the run was interrupted with work left. `state.json` is preserved; re-run to finish. |
| `130` | Force-quit by Ctrl-C: a second one, or one that arrived before the stack's own graceful stop was armed. A stack lock may be left behind; the message names `cdkd force-unlock`. |

The full cross-command table is in the [CLI Reference](cli-reference.md).

## Related

- [CLI Reference](cli-reference.md) — every command and the full exit-code table
- [`cdkd state`](cli-state.md) — the flags of `cdkd state destroy`, and the rest of the state command family
- [Orphan vs Destroy](orphan-vs-destroy.md) — when to drop state instead of deleting resources
- [`cdkd rollback`](cli-rollback.md) — reverting a failed or interrupted deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [Deployment Events](deployment-events.md) — the history `--purge-events` deletes
- [Troubleshooting](troubleshooting.md) — what to do when a destroy fails
