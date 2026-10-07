---
title: Destroy flags & guards
description: "cdkd destroy — stack selection, confirmation prompts, the S3 / ECR data guards, DeletionPolicy: Snapshot, --remove-protection, --purge-events, and interrupt handling."
---

# Destroy flags & guards

`cdkd destroy` deletes every resource a stack's state record lists, then the
state record itself. This page is the reference for the command and for the
guards that can stop a delete: the S3 and ECR data guards, `DeletionPolicy:
Snapshot`, deletion protection, and the confirmation prompts.
[`cdkd state destroy`](cli-state.md#cdkd-state-destroy) is the CDK-app-free
counterpart and behaves the same way except where noted.

```bash
cdkd destroy MyStack                        # one stack, with a confirmation prompt
cdkd destroy 'MyStage/*' --yes              # every stack under a Stage, no prompt
cdkd destroy --all -f                       # every top-level stack in the CDK app
cdkd destroy MyStack --remove-protection    # flip deletion protection off first
cdkd destroy MyStack --skip-final-snapshot  # skip the DeletionPolicy: Snapshot snapshots
cdkd state destroy MyStack --yes            # no CDK app needed — reads state only
```

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

A stack is named by its **CDK display path** (`MyStage/Api`) or, exactly, by its
**physical** CloudFormation name (`MyStage-Api`). `*` stays within one `/`
segment (`cdkd destroy 'MyStage/*'`) and `'**'` selects every stack; see
[stack selection](cli-list.md#selecting-stacks). Display-path matching needs
synthesis to succeed, because a state record only carries physical names — so
`cdkd state destroy`, which never synthesizes, matches physical names only.
When the app defines a single stack, no name is needed.

`--all` targets the **top-level** stacks of the current CDK app, as
`cdk destroy --all` does. Stacks inside a CDK Stage are left running and named
in one warning line; destroy them with `'MyStage/*'` or `'**'`. An app whose every stack
is inside a Stage is refused under `--all`. Whenever more than one stack
is selected — by `--all` or by naming several — they are ordered so that a
consumer stack is destroyed before the producers it reads from. When the app
synthesizes but yields no stacks, `--all` and any wildcard pattern (`'*'`,
`'Cdkd*'`) are refused: neither falls back to every stack in the state bucket. They are
refused the same way when there is no synthesized app at all — synthesis failed,
or no app is configured (`--app`, `CDKD_APP` or `cdk.json`) — because the state
bucket can hold the stacks of every app sharing it; after a failed synthesis
the synthesis error is printed beneath the refusal as its `Caused by:` line. In
either case an exact physical stack name still resolves from state without a
working app, and so does `cdkd state destroy '<stack>'`. A CDK Stage that
failed to load is different: the app is there but incomplete, so `destroy`
stops with that error whatever was selected, an exact name included, as the
AWS CDK CLI does; the error names `cdkd state destroy '<stack>'`, which still
needs no app
([the failed-Stage note](cli-deploy-safety.md#a-pre-synthesized-assembly-is-trusted-input)).
Each name that matches nothing is reported with a warning, as in the AWS CDK
CLI. A name that IS in state but is not a stack of this app (a nested child,
or another app's stack sharing the bucket), named beside ones that matched, is
reported with its own warning and skipped.

A nested-stack **child** cannot be destroyed directly: `cdkd destroy '<child>'`
is refused, because the parent's `AWS::CloudFormation::Stack` row would then
point at resources that no longer exist and the parent's next deploy would try
to recreate them. Destroy the parent to cascade-delete the child, or use
`cdkd state destroy '<child>'` if you deliberately want to leave the parent's
reference dangling.

## Confirmation prompts

`cdkd destroy` asks before deleting anything. `--yes` / `-y` — or `-f` /
`--force`, which means the same thing here — skips the prompt.

| Prompt | Raised by | Skipped by |
| --- | --- | --- |
| Per-stack (`Are you sure you want to destroy stack X ...`) | `cdkd destroy '<stack>'`, `cdkd destroy --all` | `-y` / `--yes`, `-f` / `--force` |
| Per-stack, same prompt | `cdkd state destroy '<stack>'` | `-y` / `--yes` only — `cdkd state destroy` does not accept `-f` / `--force` |

Under `--remove-protection` the per-stack prompt names the protected resources
(`About to destroy N resources from stack X, REMOVING DELETION PROTECTION on
K of them. Continue? (y/N)`; a stack whose rollback journal records resources
adds `and J recorded only in its rollback journal` after `N resources`, and K
counts those too) and its default flips from `Y/n` to `y/N`. A
stack name that is not a plain identifier is shown JSON-quoted with its control
characters removed.

Nested-stack children are destroyed as part of their parent's cascade and never
prompt separately.

### Non-interactive runs

Every one of these prompts is **interactive-only**. When stdin is not a TTY — a
piped, redirected or CI run — the command refuses **before** creating the
prompt, throwing `CdkdError` with the code `NON_INTERACTIVE_CONFIRM` and
exiting **1**. Piping `y` into the prompt is not a substitute; pass `--yes` /
`-y` (or `-f` / `--force`), which short-circuits above the check and never
consults stdin at all.

Refusing rather than auto-confirming is the deliberate choice for a destroy:
`cdkd deploy` assumes "yes" on a non-TTY because a deploy is recoverable,
whereas silently answering "yes" for an absent operator here would delete every
resource in the stack.

What the refusal guarantees: nothing is locked and nothing is deleted, but the
refusal is preceded by the strong-reference scan, which READS other stacks'
state records.

A stack whose state record holds ZERO resources never reaches the per-stack
refusal at all: that branch returns earlier, having taken the lock and deleted
the record, so a non-interactive run of it still succeeds. The two are mutually
exclusive, so this is not a case of the refusal deleting something first.

The same rule covers ten other mutating commands — see
[Every other mutating confirmation prompt is interactive-only
too](#every-other-mutating-confirmation-prompt-is-interactive-only-too).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Everything was destroyed. |
| `1` | Hard error, including a confirmation prompt refused on a non-interactive stdin. |
| `2` | Partial: resources failed or were skipped, or the run was interrupted with work left. `state.json` is preserved; re-run to finish. |
| `130` | Force-quit by Ctrl-C: a second one, or one that arrived before the stack's own graceful stop was armed. A stack lock may be left behind; the message names `cdkd force-unlock`. |

The full cross-command table is in the [CLI Reference](cli-reference.md).

## Destroy data guards: non-empty S3 buckets and image-carrying ECR repositories

`cdkd destroy` (and `cdkd state destroy`) matches CloudFormation's
fail-and-protect behavior for the two resource types whose delete API
refuses by default while they still hold data:

| Resource type | Without an opt-in | With the opt-in |
| --- | --- | --- |
| `AWS::S3::Bucket` | A non-empty bucket fails the destroy with a "bucket is not empty" error. The bucket and every object survive. | cdkd empties every object version and delete marker, then deletes the bucket. |
| `AWS::ECR::Repository` | A repository that still contains images fails the destroy with a "still contains images" error. The repository and images survive. | cdkd deletes the repository with `force: true`. |
| `AWS::S3Express::DirectoryBucket` | A non-empty directory bucket fails the destroy with an "is not empty" error. The bucket and objects survive. | cdkd empties the bucket, then deletes it. |

### How to opt in

| Resource type | Opt-in |
| --- | --- |
| `AWS::S3::Bucket` | CDK `autoDeleteObjects: true`, which templates as the `aws-cdk:auto-delete-objects` tag. |
| `AWS::ECR::Repository` | CDK `emptyOnDelete: true` (`EmptyOnDelete: true` in the template), or the legacy `autoDeleteImages` (the `aws-cdk:auto-delete-images` tag). |
| `AWS::S3Express::DirectoryBucket` | The `aws-cdk:auto-delete-objects` tag set to `true` in the bucket's `Tags` — a handled property. CDK has no `autoDeleteObjects` sugar here, so declare the tag on the L1. |

Both bucket types share a bounded empty-retry loop, so the auto-empty absorbs
concurrent writes — including the race where objects (ALB access logs, for
instance) land between the auto-delete custom resource's cleanup and the bucket
deletion.

### Destroying without redeploying

Empty the data by hand, then re-run the destroy:

```bash
# S3: a versioned bucket also needs every object version and delete marker deleted.
# S3 Express directory buckets have no versioning, so this is enough for them.
aws s3 rm s3://<bucket> --recursive
aws ecr batch-delete-image --repository-name <repo> --image-ids <ids>

cdkd destroy MyStack
```

Replacement deletes during `cdkd deploy` are governed by the existing
stateful-recreation consent instead: passing `--force-stateful-recreation`
(the flag whose documented meaning is "I accept a data-losing recreation")
also authorizes the force-cleanup on the replaced resource's delete. That
applies to all three types above.

**Compared with other tools.** CloudFormation reports `DELETE_FAILED` in all
three cases — for ECR, unless `EmptyOnDelete: true` is set. Terraform requires
`force_destroy` on a bucket and `force_delete` on a repository. Two related
parity notes: CloudFormation itself hard-deletes
`AWS::SecretsManager::Secret` (no recovery window) and force-detaches
out-of-band IAM role policy attachments on delete, so cdkd's identical
behavior for those types is parity, not a divergence.

## `DeletionPolicy: Snapshot`: final snapshots on delete (`--skip-final-snapshot`)

CloudFormation creates a **final snapshot before deleting** a resource whose
`DeletionPolicy` is `Snapshot` — and the CDK RDS L2 (`DatabaseInstance` /
`DatabaseCluster`) defaults `removalPolicy` to `SNAPSHOT`, so plain CDK
database stacks rely on it. cdkd matches this on every delete path.

```bash
cdkd destroy MyStack                        # final snapshot first, per the policy
cdkd destroy MyStack --skip-final-snapshot  # delete without it (DATA LOSS)
cdkd state destroy MyStack --skip-final-snapshot --yes
cdkd rollback MyStack --skip-final-snapshot
```

`--skip-final-snapshot` is accepted by `cdkd deploy`, `cdkd destroy`,
`cdkd state destroy` and `cdkd rollback`. It is the explicit opt-out: delete
WITHOUT the final snapshot — useful for dev/test stacks where the snapshot's
cost and latency are unwanted, and the escape hatch for the refusal below.

### How the final snapshot is created, by type

| Resource type | How the final snapshot is created |
| --- | --- |
| `AWS::RDS::DBInstance` | `DeleteDBInstance(SkipFinalSnapshot=false, FinalDBSnapshotIdentifier=<generated>)`. CFn nuance matched: an instance that is a **cluster member** (`DBClusterIdentifier` set) is deleted without an instance-level snapshot — cluster-level snapshots cover it. |
| `AWS::RDS::DBCluster` | `DeleteDBCluster(SkipFinalSnapshot=false, FinalDBSnapshotIdentifier=<generated>)` |
| `AWS::Neptune::DBCluster` | `DeleteDBCluster(...FinalDBSnapshotIdentifier)` (Neptune SDK) |
| `AWS::DocDB::DBCluster` | `DeleteDBCluster(...FinalDBSnapshotIdentifier)` (DocDB SDK) |
| `AWS::ElastiCache::CacheCluster` | `DeleteCacheCluster(FinalSnapshotIdentifier=<generated>)` — Redis engine only |
| `AWS::EC2::Volume` | Pre-delete `CreateSnapshot`, waited to `completed`, then EC2 `DeleteVolume`. |
| `AWS::Redshift::Cluster` | Pre-delete `CreateClusterSnapshot`, waited to `available`, then the delete. |
| `AWS::ElastiCache::ReplicationGroup` | Pre-delete ElastiCache `CreateSnapshot`, waited to `available`, then the delete. Redis only. |

Generated snapshot identifiers are deterministic:
`<base>-final-<utcTimestamp>`, where the timestamp is `yyyymmdd-hhmmss` in UTC
and `<base>` is the physical id with these rules applied:

| Step | Rule |
| --- | --- |
| Case | Lowercased. |
| Characters | Every character outside `a-z`, `0-9` and `-` becomes `-`; runs of `-` collapse to one; leading and trailing `-` are dropped. |
| First character | `r` is prepended when it does not start with a letter. |
| Length | ElastiCache only: cut to the first 28 characters, then any trailing `-` is dropped. |

The three pre-delete types log the identifier as they create it. The five
atomic-parameter types log only that the delete takes a final snapshot, under
the resource's logical id: the identifier spells the physical id, which may
come from a secret. Find that snapshot among the service's manual snapshots by
its `<base>-final-` prefix:

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

Three of those rows carry behaviour worth knowing before you rely on them:

- **`AWS::EC2::Volume`** is Cloud-Control-routed and `DeleteVolume` takes no
  snapshot parameter, which is why the snapshot is a separate pre-delete step.
  cdkd tags it `cdkd:final-snapshot-of: <volumeId>`, so a destroy re-run reuses
  the existing snapshot instead of creating and charging for a second one. The
  delete itself is always EC2 `DeleteVolume`, never Cloud Control: the Cloud
  Control delete handler has been seen taking a second, untagged snapshot of
  its own and then leaving the volume stuck in `deleting` past cdkd's wait.
- **`AWS::Redshift::Cluster`** waits a second time after the snapshot, for the
  cluster itself to settle: a fresh snapshot leaves it busy and the delete would
  otherwise fail with `There is an operation running on the Cluster`.
- **`AWS::ElastiCache::ReplicationGroup`** picks its snapshot source by cluster
  mode. A cluster-mode-enabled (sharded) group is snapshotted by
  `ReplicationGroupId`; the cluster-mode-disabled default must name its primary
  member cache cluster instead, because AWS rejects the group form with
  `Please specify a cache cluster instead`. cdkd resolves this for you.
  Memcached and snapshot-incapable node types surface AWS's rejection, matching
  CloudFormation's `DELETE_FAILED` — the same is true of a Memcached
  `AWS::ElastiCache::CacheCluster`.

Final snapshots are billed AWS resources that survive the destroy by design —
delete them manually when no longer needed.

### When cdkd refuses to delete

A Cloud-Control-routed resource of an atomic-parameter type (its state record
says `provisionedBy: cc-api` — the silent-drop auto-routing) is **refused**:
Cloud Control's `DeleteResource` has no final-snapshot parameter, so cdkd
cannot honor the policy on that route. Snapshot manually, then re-run with
`--skip-final-snapshot`.

### No snapshot under `DeletionPolicy: Delete`

The Cloud Control delete handlers for `AWS::RDS::DBCluster`,
`AWS::RDS::DBInstance` and `AWS::Neptune::DBCluster` take an untagged final
snapshot on every delete, because Cloud Control cannot tell them the policy. So
a Cloud-Control-routed one is deleted with RDS or Neptune `DeleteDBCluster` /
`DeleteDBInstance` (`SkipFinalSnapshot=true`) instead whenever the policy
governing that delete is `Delete`, or `--skip-final-snapshot`
opts out of a `Snapshot` one (except on a rollback's delete of a replacement's
new copy, which the flag does not govern). A `DeleteAutomatedBackups` in the
template is sent with the delete. An RDS cluster in a global cluster is first
detached from it, as CloudFormation does. The `AWS::ElastiCache::CacheCluster`
handler takes no such snapshot and stays on Cloud Control.

| Delete | Governing policy |
| --- | --- |
| `cdkd destroy`, `cdkd state destroy`, a deploy that removes the resource | `DeletionPolicy` |
| A rollback of its creation (automatic, `cdkd rollback`, `--revert-failed`) | `DeletionPolicy` |
| A replacement's delete of the old copy, or a rollback's delete of a replacement's new copy | `UpdateReplacePolicy`, whose default is `Delete` for every type |
| A rollback's delete of a failed replacement's new copy (its create made it, then failed) | `DeletionPolicy`, journaled with it as for a failed creation |

These cases still go through Cloud Control:

| Case | Delete |
| --- | --- |
| An RDS cluster or standalone RDS instance with no `DeletionPolicy` | CloudFormation's default, `Snapshot`, applies: refused on the Cloud Control route unless `--skip-final-snapshot` (see [Which policy cdkd reads](#which-policy-cdkd-reads)). A Neptune cluster's absent default is `Delete`, so it goes through Neptune. |
| A Neptune cluster that sets `GlobalClusterIdentifier`, or an RDS cluster whose recorded `GlobalClusterIdentifier` is not a plain name | Through Cloud Control, whose handler removes it from the global cluster first; cdkd warns that a snapshot can be left behind. |
| A rollback's delete of a replacement's new copy under `UpdateReplacePolicy: Snapshot` | Through Cloud Control, whose handler takes the snapshot, with or without `--skip-final-snapshot`. |

### Which policy cdkd reads

The recorded `state.deletionPolicy` (schema v5+) is what the destroy paths
consult; they never read the template's attribute. Pre-v5 state has none
recorded until a redeploy records the attribute, so it takes the default
below. A deploy that removes a resource from the template falls back to the
template's `DeletionPolicy` when none is recorded.

With no policy recorded, cdkd applies CloudFormation's default:

| Resource | Default |
| --- | --- |
| `AWS::RDS::DBCluster` | `Snapshot` |
| `AWS::RDS::DBInstance` without `DBClusterIdentifier` | `Snapshot` |
| Every other resource, including a cluster-member `AWS::RDS::DBInstance` | `Delete` |

So an L1 `CfnDBCluster` or standalone `CfnDBInstance` with no
`DeletionPolicy` gets a final snapshot on destroy, on a deploy that removes
it, and on a rollback of its creation. A Cloud-Control-routed one is refused
like an explicit `Snapshot` (see above). Pass `--skip-final-snapshot` to
delete without one. `UpdateReplacePolicy` defaults to `Delete` for every
type, so replacement deletes are unaffected.

### Which deletes the policy covers

`UpdateReplacePolicy: Snapshot` is honored on the deploy engine's replacement
and recreate deletes with the same per-type mechanism as the table above. The
`--force-stateful-recreation` stateful guard still applies first where the
replacement is data-losing.

| Delete site | Snapshot behaviour |
| --- | --- |
| `cdkd destroy` / `cdkd state destroy` | Snapshot, then delete. |
| `cdkd deploy`'s DELETE of a resource removed from the template | Snapshot, then delete. |
| Replacement: the delete-first / recreate delete of the OLD resource | Snapshot, then delete. A snapshot failure fails the resource — that delete is load-bearing for the re-create. When the template also renames the resource, `--recreate-via-*` and the update-failure fallback create first instead: a snapshot cdkd must take BEFORE the delete is still refused before anything is created, but a snapshot the delete itself takes (RDS instances and clusters, DocumentDB and Neptune clusters, ElastiCache cache clusters) belongs to that delete, which is then the cleanup's — its failure warns, as in the row below. |
| Replacement: the post-replacement CLEANUP delete of the OLD resource | A TRANSIENT snapshot failure warns and skips the delete, leaking the old resource rather than deleting it un-snapshotted. |
| Rollback of a COMPLETED CREATE (automatic after a failed deploy, or `cdkd rollback`) | Snapshot, then delete; a refusal is a rollback failure, so the journal is kept. `Retain` orphans instead. |
| A delete of a CREATE that FAILED mid-flight (`cdkd rollback --revert-failed`; for one that made its resource also the automatic rollback, a plain `cdkd rollback` and `cdkd destroy`) | Same policy matrix — see below. |
| Rollback's delete of the NEW resource (reversing a replacement, i.e. `UpdateReplacePolicy`) | Only the atomic SDK-routed types get a final snapshot; the other shapes keep the plain delete, which is load-bearing for same-name re-creation. |

A **refusal** — a type or route cdkd cannot snapshot — always fails the
resource, at every site including the cleanup delete, matching CloudFormation
failing the update.

#### Rolling back a CREATE that failed mid-flight

Every delete of a failed CREATE applies the same policy matrix: `Retain`
leaves the resource in AWS, `Snapshot` snapshots then deletes (refusing what it
cannot snapshot), `RetainExceptOnCreate` / `Delete` delete plainly, and absent
takes CloudFormation's default (see [Which policy cdkd reads](#which-policy-cdkd-reads)).
`cdkd rollback --revert-failed` deletes one whose recorded physical id state
still records. A CREATE whose provider proved it made the resource before
failing has no state record and is deleted on the journaled policy by every
rollback, by `cdkd destroy` and, when no state record may own it, by a later
successful deploy (see
[Resources only the rollback journal records](#resources-only-the-rollback-journal-records)).
Either way it only engages when AWS actually provisioned the resource, so the
policy is never applied to a resource that never existed.

A refusal here is recoverable rather than final: the operation stays in the
journal, so once a half-created resource settles into a snapshot-capable state
(an RDS instance rejects a final-snapshot delete while `creating`) a re-run
completes it. `--skip-final-snapshot` is the opt-out if you would rather drop
the data.

### Snapshot reuse across a re-run

For the name-keyed APIs (Redshift, ElastiCache) a re-run resumes only an
IN-FLIGHT snapshot: their identifiers are user-chosen and reusable, so adopting
an already-`available` snapshot could hand you a PREVIOUS generation's data. A
re-run after the snapshot completed therefore creates a second, timestamped,
non-colliding one. EC2 Volume reuses a completed snapshot safely — its tag is
keyed on an AWS-generated volume id that is never reused.

## `--remove-protection`: bypass deletion protection on destroy

`cdkd destroy --remove-protection` and `cdkd state destroy
--remove-protection` flip every protection flag off in place before each
provider's delete API call, so the destroy proceeds without an intermediate
edit, redeploy or console click.

```bash
# Stack with terminationProtection: true, or a protected DynamoDB / RDS / Logs / EC2 / LB
cdkd destroy MyStack --remove-protection
cdkd destroy --all --remove-protection -y

# CDK-app-free counterpart — the resource-level flip applies the same way.
cdkd state destroy MyStack --remove-protection -y
```

It covers **stack-level** `terminationProtection` (the bypass logs a WARN line
naming the stack) and **resource-level** protection on the types below.
`cdkd state destroy` already ignores `terminationProtection`, because that flag
is a CDK property surfaced via synth, so for the stack-level part the flag is
effectively a no-op there.

| Resource type | Protection field | Bypass call |
| --- | --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` | `PutLogGroupDeletionProtection(deletionProtectionEnabled=false)` |
| `AWS::RDS::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::RDS::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (DocDB SDK). DocDB DBInstance has no `DeletionProtection` field, so there is no per-instance bypass; cluster-level covers the common case. |
| `AWS::Neptune::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (Neptune SDK) |
| `AWS::Neptune::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` (Neptune SDK) |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` | `UpdateTable(DeletionProtectionEnabled=false)` then `DescribeTable` poll until `ACTIVE` |
| `AWS::DynamoDB::GlobalTable` | `DeletionProtectionEnabled` | `UpdateTable(DeletionProtectionEnabled=false)` then a wait until the table is `ACTIVE`. If the delete then fails, protection is turned back on, but only when it was on before the flip. |
| `AWS::EC2::Instance` | `DisableApiTermination` | `DescribeInstanceAttribute` read, then `ModifyInstanceAttribute(DisableApiTermination={Value:false})` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` | `ModifyLoadBalancerAttributes([{Key: 'deletion_protection.enabled', Value: 'false'}])` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) | `UpdateUserPool(DeletionProtection='INACTIVE')` with the pool's own settings from `DescribeUserPool` sent back alongside. See [the Cognito notes](#cognito-user-pools) below. |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection` (`none` / `prevent-force-deletion` / `prevent-all-deletion`), and `DisableApiTermination` on each instance the group launched | `DescribeAutoScalingGroups` read, then `UpdateAutoScalingGroup(DeletionProtection='none')`; then a second `DescribeAutoScalingGroups` to list the instances the group holds, and for each one a `DescribeInstanceAttribute` read and `ModifyInstanceAttribute(DisableApiTermination={Value:false})`; then `DeleteAutoScalingGroup(ForceDelete=true)`, so AWS terminates running instances as part of the delete |
| `AWS::EMR::Cluster` | `Instances.TerminationProtected` | `SetTerminationProtection(TerminationProtected=false)`, then `TerminateJobFlows` |
| `AWS::DSQL::Cluster` | `DeletionProtectionEnabled` | Cloud Control `GetResource` read, then an `UpdateResource` patch (`[{op: add, path: /DeletionProtectionEnabled, value: false}]`), waited to completion, then `DeleteResource` |
| `AWS::NeptuneGraph::Graph` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::SMSVOICE::ProtectConfiguration` | `DeletionProtectionEnabled` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::VerifiedPermissions::PolicyStore` | `DeletionProtection` (`{Mode: ENABLED\|DISABLED}`) | Same generic CC patch flip with `value: {Mode: DISABLED}` then `DeleteResource` |
| `AWS::EKS::Cluster` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::RDS::GlobalCluster` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::DocDB::GlobalCluster` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |

Protection types not in the table — CloudFront distributions, S3 bucket
retention, and so on — are out of scope. The list is curated to the cases where
AWS exposes a synchronous "flip protection off" API call.

### Behaviour

- The flag is **all-or-nothing for the run**: a single `--remove-protection`
  covers every protection-bearing type listed above, and there is no per-type
  variant. If you need finer control, run a stack-only destroy and clean up the
  rest manually.
- The flip-off call is **idempotent** — providers issue it when the flag is
  set, whether or not the resource currently has protection on, and AWS accepts
  the already-disabled case without error. The Cognito user pool is the
  exception: see [Cognito user pools](#cognito-user-pools).
- A failure of the flip-off itself (NotFound or similar) is logged at debug;
  the actual delete API call still runs and surfaces its own error message.
  (Cognito: see [Cognito user pools](#cognito-user-pools).)
- **RDS and Cognito are gated on the flag like every other type.** Destroying
  an RDS or Cognito UserPool resource whose deletion protection was set
  externally (console, AWS CLI) without `--remove-protection` surfaces AWS's
  `InvalidParameterCombination` / `InvalidParameterException` error rather than
  silently succeeding.
- **It reaches a resource only the rollback journal records** too (a failed
  CREATE's resource, see
  [Resources only the rollback journal records](#resources-only-the-rollback-journal-records)):
  a protected one is deleted with its protection turned off, and the prompt
  counts it when its journaled properties turn protection on. Only when cdkd
  can prove it is still the resource the failed deploy created — its type's id
  is never reused (an EC2 instance, a load balancer), or a live read returns the
  identity the journal recorded — and no other stack's state record holds it
  now (a later `cdkd import` may have adopted it). One it cannot prove (a
  DynamoDB table whose name another table may have taken since), or one
  another stack holds or whose holders cannot be read, keeps its protection,
  with a warning. Without the flag, or unproven, a protected one's delete is
  refused and the journal keeps it for a re-run. `cdkd rollback
  --remove-protection` does the same for the resources it deletes that a
  failed CREATE left behind (a journaled orphan, or under `--revert-failed` the
  failed CREATE itself). On a journaled failed nested stack, the flag
  cascades to that child stack's resources. A deploy's automatic rollback and the settle a
  successful deploy runs never turn protection off.
- **`cdkd deploy` has no counterpart.** A deploy that has to REPLACE a
  protected resource — a replacement is a delete plus a create — fails at the
  delete whatever replace flags were passed. Clear the protection flag first:
  [Deploy: safety & compatibility flags](cli-deploy-safety.md#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it).

### Cognito user pools

`UpdateUserPool` resets the settings a call leaves out, among them the pool's
self sign-up setting (`AllowAdminCreateUserOnly`), its Lambda triggers and
advanced security. So cdkd does not turn the guard off with that flag alone:

| Case | What cdkd does |
| --- | --- |
| The pool reads `INACTIVE` already | Sends no `UpdateUserPool`. |
| The pool reads `ACTIVE` | Sends `DeletionProtection='INACTIVE'` with the pool's own reset-prone settings sent back, so nothing else changes. |
| AWS refuses the write while it carries a `DEVELOPER` (SES) email configuration | Sends the settings again without that email configuration (the refusal may have been about it), and warns that the email configuration may have been reset. |
| AWS refuses those settings on validation | Warns and turns the guard off alone, so the delete can still run. If that delete then fails, cdkd reports at ERROR which settings the pool held, since the pool stays live without them. |
| AWS refuses for any other reason, or the pool cannot be read first | Leaves the guard on and warns. The delete is then refused. |
| The read or the `UpdateUserPool` is throttled or hits a server error | Retries the whole delete, without deleting anything first. A server error on the `UpdateUserPool` may still have landed, so it is remembered for the retry. |
| The `UpdateUserPool` gets no answer from AWS (a timeout), so it may have landed | Warns that the outcome is unknown. |
| The delete then fails after a write that may have landed | Reads the pool again and writes the guard back on, with the pool's own settings. Reports at ERROR any settings a lone `DeletionProtection` write reset. If the pool reads the guard on but the write-back is refused, it warns and names the check command. |

Reading the pool first needs `cognito-idp:DescribeUserPool` alongside
`cognito-idp:UpdateUserPool` and `cognito-idp:DeleteUserPool`.

### Restoring a guard after a failed destroy

On these types a flip followed by a **terminal** delete failure is
compensated: cdkd turns the guard back on before reporting the failure, so a
destroy that did not happen does not leave a live resource with its guard
stripped.

| Type | Guard |
| --- | --- |
| `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` | `DeletionProtectionEnabled` |
| `AWS::RDS::DBCluster`, `AWS::RDS::DBInstance` | `DeletionProtection` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` |
| `AWS::Neptune::DBCluster`, `AWS::Neptune::DBInstance` | `DeletionProtection` |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` |
| `AWS::Cognito::UserPool` | `DeletionProtection` |
| `AWS::EMR::Cluster` | `Instances.TerminationProtected` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection`, restored to the level the flip removed (`prevent-force-deletion` or `prevent-all-deletion`) |
| `AWS::EC2::Instance` (SDK and Cloud Control routes) | `DisableApiTermination` |
| The instances an `AWS::AutoScaling::AutoScalingGroup` launched | `DisableApiTermination`, per instance |
| `AWS::DSQL::Cluster`, `AWS::SMSVOICE::ProtectConfiguration` (Cloud Control) | `DeletionProtectionEnabled` |
| `AWS::NeptuneGraph::Graph`, `AWS::EKS::Cluster`, `AWS::RDS::GlobalCluster`, `AWS::DocDB::GlobalCluster` (Cloud Control) | `DeletionProtection` |
| `AWS::VerifiedPermissions::PolicyStore` (Cloud Control) | `DeletionProtection`, value `{"Mode":"ENABLED"}` |

The instances of an Auto Scaling group are restored when the group's own
delete fails terminally, each one from its own pre-flip
`DescribeInstanceAttribute` read: only an instance whose guard that read saw
on is turned back on. Nothing is put back once AWS has accepted
`DeleteAutoScalingGroup(ForceDelete=true)`, because the instances are then
being terminated with the group. When a re-enable fails and cdkd reads the
instance back (`DescribeInstances`) as `shutting-down` or `terminated` (the
group may have replaced it after the flip), it reports the instance as gone at
**warn**, as for a not-found error below. An instance detached from the group
out of band after the flip is not restored when the group is then deleted or
already gone: the delete counts as done and the detached, live instance keeps
its guard off.

On the DynamoDB pair a Ctrl-C landing in a wait after the flip is compensated
too. Four limits are deliberate:

- It only restores a guard **cdkd itself turned off in this run**. A resource
  whose protection was already disabled beforehand, or whose pre-flip read
  failed, is left alone.
- It keys on how the delete ENDS, not on individual retries: a retryable
  failure is compensated only on the destroy loop's last attempt, when no retry
  follows. It does not run once AWS has ACCEPTED the delete call — a failure
  after that point is a wait giving up on a resource that is already being
  deleted. On a Cloud Control-routed delete this is decided per delete attempt,
  and "accepted" means the handler may already be deleting: an abandoned
  wait, or a failure whose handler code leaves that open (`NotStabilized`,
  `ServiceTimeout`, `InternalFailure`, `GeneralServiceException` and the
  like), or a conflict after an earlier attempt that may have been deleting.
  cdkd then does not write the guard back, and warns that it cannot tell,
  naming the check and restore commands. Any other handler failure is a
  refusal and is compensated, as is an EC2 instance's termination-protection
  refusal under any code.
- It does not run when a per-resource `--resource-timeout` fires, which leaves
  the guard off.
- It is best-effort. The delete failure stays the reported outcome, and a
  re-enable that itself fails is reported as a separate ERROR line naming the
  resource and its restore command. A re-enable that fails with the service's
  not-found error is reported at **warn** instead and names a check command
  first (`describe-*`, or `aws cloudcontrol get-resource` on a Cloud Control
  type), because that error also covers a resource that is still live —
  in another region, or (DynamoDB) whose status is merely not `ACTIVE`.

The pre-flip read needs its own read permission beside the flip and the
delete: `ec2:DescribeInstanceAttribute` for an EC2 instance,
`elasticloadbalancing:DescribeLoadBalancerAttributes` for a load balancer,
`autoscaling:DescribeAutoScalingGroups` for an Auto Scaling group plus
`ec2:DescribeInstanceAttribute` for each instance it launched (one read per
instance; a failed re-enable reads the instance back with
`ec2:DescribeInstances`, and without it an instance that is shutting down or
terminated is reported at ERROR rather than warn), and
`cloudformation:GetResource` (the IAM action behind Cloud Control's
`GetResource`), plus whatever the type's read handler calls, for a Cloud
Control type. A read that is refused leaves the delete running and
compensates nothing.

For a Cloud Control-routed EC2 instance the flip goes through EC2, so cdkd
refuses the delete, before flipping anything, when its EC2 client targets a
different region than the Cloud Control client the region check vetted.

To restore the guard by hand:

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

A command cdkd prints carries the run's `--profile` when you passed one
(`aws --profile prod rds modify-db-cluster ...`), or a `'<role-profile>'`
placeholder to fill in when the run assumed a role with `--role-arn` (with or without
`--profile`); add yours to the commands above
when you type them by hand, or they run against your default profile. DocDB and
Neptune take the same `modify-db-cluster` / `modify-db-instance` form under
`aws docdb` / `aws neptune`. The other Cloud Control types take the DSQL
form with their own property from the table and the value `true`. Put an Auto
Scaling group back at the level it had; the line cdkd prints names it.
`update-user-pool` resets the pool
settings it omits (self sign-up, Lambda triggers and advanced security among
them), so send the pool's complete configuration alongside
`--deletion-protection` rather than the flag alone.

## `--purge-events`: also delete deployment-event history on destroy

By default `cdkd destroy` removes `state.json` / `lock.json` but **keeps** the
stack's deployment-event history (the `deployments/` store) as post-mortem
context — so an object listing of the state bucket is not empty after a
teardown. `cdkd destroy '<stack>' --purge-events` opts into deleting that history
too, so the listing comes back empty and, on a versioned bucket, every earlier
version under the stack's `deployments/` prefix is purged as well:

```bash
cdkd destroy MyStack --purge-events -y
```

- The purge runs **only after a clean, non-interrupted destroy** of that
  stack. On a failed or interrupted destroy the events are kept — they are
  exactly the post-mortem you want when retrying.
- "Interrupted" here is the PER-STACK question — was this stack left with
  work to re-run — matching what the exit code asks of the run as a whole. A
  Ctrl-C that lands after this stack was fully destroyed does not keep its
  events: there is no retry to post-mortem, and the run reports success, so
  suppressing the purge there would report a clean teardown while silently
  leaving the history behind.
- Best-effort: a purge failure logs a warning but never fails the
  already-successful destroy.
- Per-stack: when destroying multiple stacks, each clean stack's history is
  purged independently.
- `cdkd state destroy` does NOT take this flag. For an already-destroyed stack,
  or on the CDK-app-free path, use the equivalent
  [`cdkd events prune '<stack>' --all`](cli-events.md).
- **Every earlier version under the stack's `deployments/` prefix is purged
  too.** The state bucket is versioned, so the purge also deletes the
  noncurrent versions under that exact prefix, including streams an earlier
  delete left behind a delete marker. That needs `s3:ListBucketVersions` and
  `s3:DeleteObjectVersion`; without them the destroy still succeeds and a
  warning prints first. What it does not reach is listed in
  [Deleting a run stream also purges its earlier versions](deployment-events.md#deleting-a-run-stream-also-purges-its-earlier-versions).

## Skipped resources on destroy

A **skipped** resource is one whose delete cdkd did not confirm, so it may
still exist and still be billing. Most causes are a state record cdkd could not
address, and issue no AWS call; the custom-resource handler cause below
attempted the delete. The per-resource `skipped (...)` line names which applies.
The causes:

- **A state record with no physical id**: `skipped (state record has no
  physical id)`. The row names its type, but its `physicalId` is missing, not a
  string, empty, or only whitespace, so cdkd cannot address the resource and
  issues no AWS call. Before, the provider was called with whatever the field
  held, and the `NotFound` that came back read as already deleted, dropping the
  record of a resource that may still be live. The record is kept; repair the
  `physicalId` in `state.json` and re-run. A nested stack row
  (`AWS::CloudFormation::Stack`) is exempt: its delete finds the child by
  `<parent>~<logicalId>` and never reads the id.

- **A composite `physicalId` that does not decode** (`AWS::Glue::Table`,
  `AWS::AppSync::{DataSource,Resolver,ApiKey}`, `AWS::EC2::NetworkAclEntry`).
  No AWS call is issued at all, and the per-resource warning names the expected
  format.

- **A state record missing the id or the property the delete call is addressed
  by**, in every source cdkd can read it from. No AWS call is issued here
  either. The cases:

  | Record | What survives |
  | --- | --- |
  | `AWS::Lambda::LayerVersion` with a malformed version ARN | The layer version stays published. |
  | `AWS::Lambda::Permission` with neither a `FunctionName` property nor a function ARN in its `physicalId` | The statement stays on the function's resource policy — an invoke grant outliving the stack. |
  | `AWS::Lambda::Permission` whose `physicalId` carries no StatementId | As above. |
  | A Custom Resource with no properties, or no `ServiceToken` | Its handler never receives a `Delete` request, so whatever it manages elsewhere is untouched. |
  | A Custom Resource whose recorded `ServiceToken` is the redaction mask `***` — it read a `NoEcho` value equal to, or contained in, its own `ServiceToken` | As above. A re-deploy masks it again, so restore the ARN while the handler still exists, or tear the resource down by hand. |
  | A Custom Resource whose recorded `ServiceToken` holds a `{{resolve:...}}` reference — cdkd keeps a secret (`secretsmanager` / `ssm-secure`) reference's expression, not its value, and does not resolve it on delete | As above. A deploy of that template is refused (CloudFormation does not support secure dynamic references in custom resources), so restore the ARN while the handler still exists, or tear the resource down by hand. |
  | A Custom Resource whose recorded properties hold `***` where a `NoEcho` value stood (a `NoEcho` parameter, or an attribute declared `NoEcho`) | As above: its handler would receive the mask in `ResourceProperties`. Tear down what it manages by hand, then drop the record with `cdkd state orphan`. |
  | `AWS::IAM::Policy` with neither a policy name in its `physicalId` nor a `PolicyName` property | The policy stays attached wherever it is. |
  | `AWS::IAM::Policy` naming no `Roles` / `Groups` / `Users` | An inline policy exists only as an attachment, so a record naming no principal cannot be deleted. |
  | `AWS::IAM::UserToGroupAddition` missing `GroupName` or `Users` | The users keep every permission the group grants. |

  Each warning names what survived and how to repair it. Where the resource's
  **parent** is part of the same destroy — the Lambda function, the IAM role /
  group / user — that parent's own delete removes the skipped resource anyway,
  so AWS ends clean and only the cdkd record is stale. The warning says so, and
  `cdkd state orphan '<stack>'` clears it.

- **A state record whose principal list is not a list of IAM names** — a
  string or object where a list belongs, or an entry that is not an IAM name.
  cdkd refuses to guess which principals it names, so no AWS call is issued
  (a secret-derived list is the exception, below):

  | Record | What survives |
  | --- | --- |
  | `AWS::IAM::Policy` whose `Roles` / `Groups` / `Users` is not a list of IAM names | The inline policy stays attached wherever it is. |
  | `AWS::IAM::UserToGroupAddition` whose `Users` is not a list of IAM user names | The users keep every permission the group grants. |

  A plain malformed list is repaired in `state.json`, after which a re-run
  deletes it.

  A list holding a `{{resolve:...}}` reference is secret-derived: cdkd keeps
  the reference in state by design, so there is nothing to repair.
  `cdkd destroy` and `cdkd state destroy`, and the nested stacks they cascade
  into, resolve it to the principals the secret's CURRENT value names and
  remove the inline policy or the memberships from them (a membership is read
  first with `iam:ListGroupsForUser`, which the destroy's credentials then
  need; without it the delete fails rather than skips). Every printed name is
  masked, except that a name shorter than 4 characters can still show inside
  an AWS error message. A `cdkd deploy` that drops the resource from the
  template still skips it: that delete runs after the new resources are
  created, so on a logical-id move it would strip the grant the new resource
  just made. A destroy still skips, keeping the record and exiting 2, when:

  - the list holds the `***` mask, which names nothing;
  - a plain entry in the list, or another principal list of the record, is
    not an IAM name;
  - the state record has no region;
  - a reference names another region, or is region-less while the stack reads
    a value from another region (it is then ambiguous);
  - the reference cannot be resolved (no access to the secret, or it is gone);
    a throttle or server error is retried instead;
  - the resolved value is not an IAM name.

  The warning says when resolution was attempted and failed; fix that and
  re-run. Otherwise remove the attachment or the memberships by hand, then
  drop the record with
  `cdkd state orphan '<stack>' --stack-region <region> --resource <logicalId>`;
  the rest of the stack is still destroyed, so once this is the stack's last
  record the same command without `--resource` clears it too. While a record whose list can still
  be resolved remains (not one holding the mask), the stack keeps its
  cross-stack read records, so a producer stack's destroy still refuses to go
  first.

  **If the secret's value changed since the attachment, or a principal it
  names lacks the grant**, the destroy acts on the CURRENT value:

  - A principal the current value names that does not hold the policy or
    membership makes the delete skip and keep the record: a principal only the
    OLD value named may still hold it. The same skip follows when an earlier
    cdkd run already removed it there, or when that principal was deleted
    before the policy or membership (a retry within one destroy does not
    count). Remove it from any old principal by hand, then drop the record
    with `cdkd orphan '<stack>/<path>'`, or, without the CDK app,
    `cdkd state orphan '<stack>' --stack-region <region> --resource <logicalId>`.
  - A principal only the current value names loses a same-named inline policy
    or membership it holds from elsewhere. cdkd cannot tell that apart.

  A nested child destroyed on its own (`cdkd state destroy '<parent>~<child>'`)
  does not see the regions its parent reads from, so it resolves nothing and
  skips such a record: destroy it through the parent. One case the evidence
  cannot cover: a stack whose cross-stack read records an earlier cdkd version
  already dropped in a partial destroy. There, a region-less reference is
  resolved against a same-named secret in the stack's own region, and a
  principal its value names that holds the policy or membership loses it (one
  that does not makes the delete skip, as above).

- **A state record whose address property cdkd redacted** — a property the
  delete names the resource by (an API id, a cluster, a group, a Route 53 record
  value, a security-group rule, an anomaly detector's metric) that is stored as
  the `***` mask of a `NoEcho` value the resource read, or as a secret
  `{{resolve:...}}` reference. Neither names anything in AWS, and on several of
  these APIs an unknown name answers "not found", which used to read as already
  deleted and drop the record over a live resource. Where a second source holds
  the value (a Lambda permission's function or an ECS service's cluster in its
  `physicalId`, an IAM policy's name, an access key's owner looked up from IAM,
  a Route 53 record's hosted zone in its `physicalId`, a Scheduler schedule's
  recorded creation date, target and role, which find it in whichever group
  holds it) it is used instead;
  otherwise no AWS call is issued. A schedule records its creation date when it
  is created, imported or updated by a cdkd with that change; one whose record
  predates it, carries no stack region, or matches only a schedule whose
  target or role was edited outside cdkd, is still skipped. A re-deploy records
  the same redaction again, so remove the resource by hand and drop the record
  with `cdkd orphan '<construct path>'` (that resource only) or
  `cdkd state orphan '<stack>'` (every record of the stack).

- **A custom resource whose Delete handler reported `FAILED`, or whose handler
  invoke did not complete**:
  `skipped (Delete handler reported FAILED — resource unproven)` or
  `skipped (Delete request to the handler did not complete — resource unproven)`.
  cdkd addressed the resource and sent (or attempted to send) the `Delete`, so
  the record is correct and there is nothing to repair in `state.json`. The
  same destroy usually deletes the handler's Lambda too, so the next destroy
  does not retry it: it finds the handler gone and skips the resource again
  (the next cause). Tear down what the handler manages by hand, then drop the
  record with `cdkd state orphan '<stack>' --stack-region <region>`.

- **A custom resource whose backing Lambda no longer exists**:
  `skipped (backing Lambda function is gone — Delete handler not invoked)`.
  `GetFunction` on the recorded `ServiceToken` answered "not found", so the
  handler can never receive the `Delete`, and cdkd cannot know whether what it
  manages is gone. The record is kept and the destroy exits `2`, matching
  CloudFormation, where a custom resource whose delete cannot be confirmed
  leaves the stack `DELETE_FAILED` until you retry with `RetainResources`.
  This is the usual second run after the cause above, and also the shape where
  a shared provider stack was destroyed before the stacks that use it. Either
  redeploy a function at that exact ARN and re-run, or confirm by hand that
  what the handler manages is gone (or tear it down) and drop the record with
  `cdkd state orphan '<stack>' --stack-region <region>`. Earlier versions
  treated this as already deleted, dropping the record and exiting `0`. A
  `cdkd deploy` that deletes such a custom resource (removed from the
  template, replaced, or rolled back) still does that, with a warning, as
  CloudFormation ignores delete failures in an update's cleanup phase.

- **A nested stack** (`AWS::CloudFormation::Stack`) whose own destroy skipped a
  resource or was interrupted. Here the child's *other* resources were deleted
  first, so "skipped" means the child stack as a whole was not destroyed — not
  that nothing happened. The record to repair lives in the child's state file
  (`<parent>~<childLogicalId>`), which the summary names.

A skip is distinct from the neighbouring outcomes:

| | AWS resource | cdkd state record | Counts as |
| --- | --- | --- | --- |
| deleted | Gone | Dropped | `N deleted` |
| retained (`DeletionPolicy: Retain`) | Kept **on purpose** | Dropped | `N retained` |
| **skipped** | **May still exist** | **Kept** | `N skipped`, exit `2` |
| failed | May still exist | Kept | `N errors`, exit `2` |

`N unverified` is a fifth figure on the same summary line and deliberately not a
row in that table, because it is not an outcome: the resource was deleted and
its record dropped exactly as the `deleted` row says. What it counts is
**pre-flight safety guards that ran, could not reach a verdict, and were
therefore not enforced**. cdkd proceeds anyway — refusing on an unanswerable
probe would strand every least-privilege destroy — but the fact must not be
invisible afterwards, since the attack such a guard exists to catch works by
denying the permission the probe needs. So it moves no other counter, forces no
state preservation, and does **not** change the exit code: a destroy showing
`1 unverified` and `0 errors` exits `0`. It appears on every summary arm and
only when non-zero. A warning beneath the line names the resources; the durable
half is a `RESOURCE_GUARD_INDETERMINATE` event, which outlives the run — see
[Deployment Events](deployment-events.md). `cdkd state destroy` prints the same
figure and records the same event.

The state record is kept on purpose: without it you would have neither the AWS
resource deleted nor an id to go and delete it with. To finish the destroy,
repair whatever the per-resource warning names — the `physicalId` for the decode
failures, the missing property (`FunctionName`, `ServiceToken`, `GroupName` /
`Users`) for the missing-field causes — in state (`cdkd state show '<stack>'` to
inspect) and re-run, or delete the resource by hand and drop the record with
`cdkd state orphan '<stack>'`. The summary line names the exact state file(s) to
open, which for a nested-stack skip is the child's.

### A skip on `cdkd deploy`, not just on destroy

The same provider outcome reaches `cdkd deploy`, which issues a DELETE for every
resource removed from the template plus one for the old resource of a
replacement. Each site handles it in the way that resource's situation allows:

| Deploy-side site | On a skip |
| --- | --- |
| A resource removed from the template | **Warns and keeps the state record**, counting it under `Skipped (not deleted)`. The run exits `2`. |
| The old resource of a replacement (`--replace`, `--recreate-via-*`, an in-place-unsupported UPDATE) | **Fails the resource** — the replacement create would otherwise run beside a live old one, or collide with its name. |
| The cleanup delete after a create-first replacement | **Warns.** The old resource is untracked either way; delete it by hand. |
| A rollback delete (automatic, or `cdkd rollback`) | Counted as a per-op **failure** at four of the five arms, so the journal segment is kept and re-running `cdkd rollback` re-attempts it. |

The rollback exception is the delete of the **new** resource after the old one
was re-created. That arm's delete is already best-effort — the revert itself
succeeded and state points at the old resource — so a skip warns and counts as a
warning. The new resource is left untracked and must be deleted by hand.

A deploy-side skip is a non-zero outcome. The deploy did not apply the template
it was given, and a pipeline reading only the exit code must not be told that it
did. The kept state record still means the next run re-attempts the delete, which
is the real difference between deploy and destroy — but self-healing later does
not make the current run a success. `--allow-unaddressed` restores exit `0` for
callers who accept that (see
[`--allow-unaddressed` (deploy)](cli-deploy-safety.md#allow-unaddressed-deploy)).

### A nested stack whose child failed is an error, not a skip

The third outcome a child stack's destroy can report is a resource that was
**attempted and failed**. That is not a skip — a skip asserts no AWS call was
issued — so the parent's `AWS::CloudFormation::Stack` row fails, exactly as a
failed delete of any other resource type does:

```text
✗ Failed to delete Child: Nested stack MyStack~Child failed to destroy: 1 resource(s) failed to delete.
  The child's state is PRESERVED and still lists them — inspect it with 'cdkd state show MyStack~Child',
  resolve the failure, and re-run the destroy. ...

⚠ Stack MyStack partially destroyed (2 deleted, 1 errors). State preserved ...   # exit 2
```

**`cdkd deploy` is affected too.** Removing an `AWS::CloudFormation::Stack` from
your template routes that row through the deploy engine's DELETE path, so a
child that fails to destroy **fails the deploy**, and its siblings roll back.
Verify that a nested stack destroys cleanly before removing it from the
template.

The remedy the summary prints names the **child's** state file
(`cdkd state orphan '<parent>~<child>'`), not the parent's — the resource that
failed lives in the child, and orphaning the parent would drop the very row that
keeps the child reachable. A run with both failures and skips prints each remedy
separately, since they differ in kind: a failure is retryable (`cdkd destroy`
again), while a skip needs its state record repaired first.

The run-level exit message counts **entries**, not resources: a skipped
nested-stack row is one entry however many of the child's own resources it
covers. The per-stack summary lines above it give the exact breakdown.

## Resources only the rollback journal records

A deploy that fails after a CREATE made its resource (the provider proved its
create call returned, e.g. a Kinesis stream whose retention follow-up AWS
rejected) leaves that resource with no state record: the rollback journal is
its only record, and destroying the stack removes the journal. Under
`--no-rollback`, or when the journal outlives the rollback, `cdkd destroy` and
`cdkd state destroy` therefore act on it first:

| Step | Behaviour |
| --- | --- |
| Before the prompt | Listed with its physical id, also on a `--yes` / `--force` run and in a nested child's cascade. The prompt counts it. |
| Under the lock | The journal is read again; any change to what it records, or a journal that can no longer be read, refuses the run before anything is deleted, so you re-run against what is there now. |
| Before the stack's resources | Deleted per its journaled `DeletionPolicy` — `Retain` keeps it in AWS, `Snapshot` takes the final snapshot unless `--skip-final-snapshot`; `--remove-protection` turns its deletion protection off first when it is proven to be the resource the failed deploy created. One that state, a later deploy or a rollback-orphan record may own is warned about and left alone. |
| A delete fails | Counted separately in the summary; the state and the journal are kept, and the hint is to re-run the destroy, never to drop this stack's record. A warning also prints `cdkd rollback <stack> --drop-failed <logicalId>` for each such resource: when the cause can never be fixed, check the resource by hand and drop just that entry ([details](cli-rollback.md#dropping-one-entry-cdkd-cannot-act-on)). |
| Only such resources remain | The stack is not empty: it takes the confirmed path, not the empty-stack fast path. |

A journal destroy cannot read is warned about and removed with the state, and
nothing it records is deleted. A record whose body region differs from its
key's is refused when its journal holds such a resource, as when it lists
resources. See [Failed CREATEs that made their resource](cli-rollback.md#failed-creates-that-made-their-resource)
for the rollback side.

## Interrupting a destroy (Ctrl-C / SIGTERM)

`cdkd destroy` and `cdkd state destroy` shut down gracefully. The **first**
Ctrl-C stops scheduling new deletes; the deletes already in flight are awaited,
the state file is flushed to its minimal preserved form, and the stack lock is
released. The command then exits non-zero
(`Destroy interrupted by Ctrl-C. State preserved`) so CI sees that the teardown
did not complete. CI cancellation delivers SIGTERM rather than Ctrl-C, and it
is routed through the identical path.

```bash
cdkd destroy MyStack     # Ctrl-C: in-flight deletes finish, state is preserved
cdkd destroy MyStack     # re-run picks up the remaining resources
```

A **second** Ctrl-C force-quits without waiting for the in-flight call, which
can leave the stack lock behind. cdkd prints the recovery command; which one it
prints depends on whether a per-stack teardown had armed its own handler yet,
which is not the same as whether a stack is "running":

- the exact **region-qualified** `cdkd force-unlock '<stack>' --stack-region ...`
  once that stack's teardown owns the signal, i.e. it can name the lock;
- a **hedged** `cdkd force-unlock <stack-name>` otherwise — both between two
  stacks (where the finished stack has already released its lock, unless that
  release itself failed) **and on the FIRST signal inside a stack that has not
  yet armed its teardown**, the window between the loop dispatching the stack
  and the runner registering its handler. Nothing at either point knows which
  lock to name.

```bash
cdkd force-unlock MyStack --stack-region us-east-1
cdkd destroy MyStack
```

Under `--all`, the interrupt also stops the run **before the next stack
starts** — including a signal that lands between two stacks, or while the
interrupted stack was finishing its own teardown, which are windows the
per-stack teardown cannot observe at all.

The non-zero exit means **work was left undone**, not merely "a signal
arrived". A Ctrl-C that lands in the tail of the run — after the last (or only)
stack has already been destroyed, while cdkd is finalizing its event record —
leaves nothing to re-run, so that case exits 0.

A stack whose deletes were interrupted keeps its `state.json` and its
deployment-event history. The events are the post-mortem for the retry, which
is why `--purge-events` is skipped on an interrupted run.

## A malformed `resources` map refuses the destroy

The `resources` map is the list of what a destroy deletes, and a state record is
used as typed data without a field-by-field shape check — so a hand-edited or
truncated one can hold a string, a list, a number, a boolean or `null` there.

Counting such a map answers three different ways, and the middle answer was the
damaging one:

| Stored shape | What the count used to conclude |
| --- | --- |
| `[]`, a number, a boolean | "this stack has no resources" — the run took the **empty-stack fast path**, deleted `state.json` with no confirmation, and reported **success having deleted nothing**. Every resource the record named was left live in AWS with nothing left to say what it was |
| A string | one fabricated logical id per character, and the run proceeded against resources that do not exist |
| `null`, or an absent field | a bare `TypeError` naming no stack, no key and no remedy |

`cdkd destroy` and `cdkd state destroy` refuse before the per-stack
confirmation prompt and before the lock (`STATE_RESOURCES_MALFORMED`, exit `1`),
naming the record and the region. Every route into a destroy inherits it —
including a nested **child** record reached through its parent's destroy — and
it runs again on the record the fast path re-reads under the lock, which is a
second object the first check never saw.

A malformed **child** record fails the parent's destroy rather than passing
silently: the child's delete is one resource in the parent's graph, so the
parent finishes its other deletes, ends with errors, and **keeps** its own state
trimmed to what is left. Repair the child's record and re-run; the parent's
destroy is idempotent over what it already removed.

Under `--all` the refusal ends the run — one malformed record stops the stacks
not yet reached. Those are untouched, so a re-run after the repair proceeds.

Reading the map as empty — the repair `cdkd diff` and `cdkd state show` apply —
**is** the first row above, so there is no safe repair here. A legitimately
empty `{}` still takes the fast path exactly as before: the two are separated by
the container's shape, never by its size, since both count zero.

Refusing does not leave you with no way to tear the stack down, because
proceeding never tore anything down either — the list of what to delete is
precisely what is unreadable. A `[]`, a number or a boolean names no resource
at all; a string names one logical id per character, and each of those entries
is a single character carrying neither a resource type nor a physical id — so
cdkd cannot even choose how to delete it, no AWS call is issued, and the run
ends with one error per invented id and the record still in place. If what you
want is the record gone with the live resources
left standing, that is what the refusal points at:

```bash
cdkd state orphan '<stack>' --stack-region '<region>'
```

Drop `--stack-region` for a legacy record that carries no region of its own —
with the flag, nothing matches it.

The refusal prints that as a template rather than a ready-to-paste command, and
it withholds the target entirely when the stack name or region does not render
exactly. Both are deliberate: `cdkd state orphan` deletes a record; the region
in the message is the one in the record's S3 key (the CLI's own region for a
legacy record), and a key segment is chosen by anyone who can write the bucket;
and a name that needed sanitizing can render identically to a healthy one.

When the target renders exactly, the refusal names it and tells you to confirm
the key with `cdkd state list --long`, which shows that name faithfully.

When it withholds the target, the refusal prints no `cdkd state orphan` line,
and points at `cdkd state list --json` instead — `--long` trims a padded name,
so it would show the healthy one's spelling. `--json` keeps the padding, but it
prints each stack name and region as a JSON string, which escapes a `"`, a `\`
and control, format and separator characters (ESC prints as `\u001b`). Decode
the value from its JSON string first, then replace each quoted hole in the
`Inspect the record:` command the refusal prints, or in the `cdkd state orphan`
template above, quotes included, with the shell-quoted result: the escaped spelling,
shell-quoted, names a record that does not exist. A record listed with
`"region": null` is a legacy one — leave `--stack-region` out of the
`cdkd state orphan` template rather than filling its hole, as above.

Every command the refusal prints carries the `--profile`, `--state-bucket` and
non-default `--state-prefix` the destroy ran with, so pasted it reads the same
bucket. When the refusal withholds the target and carries any of them, the
listing is printed as its own `Find the exact name:` line with them. A value that is not a plain identifier
is printed as a quoted hole such as `'<profile>'`, and the message says why;
fill it with the value you passed.

To act on the resources instead, inspect the record with `cdkd state show
'<stack>' --stack-region '<region>' --json`, repair it, and re-run the destroy. An
**absent** `resources` field is a defect and is refused too — a stack always has
a resource map, even an empty one. Full per-command table in
[State Management](state-management.md#when-resources-is-not-an-object).

## An unreadable resource record refuses the destroy

The map being an object says nothing about the records in it. A row that is
`null`, a string, a list, or an object with no `resourceType` is read by every
walk the destroy makes — the *Resources to be deleted* listing above the
prompt, then the dependency graph, the implicit delete order, and the delete
itself after the lock — and validated by none of them. A `null` row died in
that listing with a bare `TypeError`. A `false`, `0` or `""` row was **skipped**
by the delete loop as "not found in state", and the run then removed the record
with that row's resource still live in AWS and success reported. Any other
unreadable row was listed with whatever its type field held — nothing, so
`- <id> ()`, or a non-string rendered as itself — and then, unless its own
`DeletionPolicy` retained it, routed to a provider on that same value with a
physical id nothing had checked, so its delete either failed on a type-lookup
error that named the row but not what was wrong with its record, after every
readable row not retained was deleted, or was counted done, the record removed,
and success reported with its resource still live.

`cdkd destroy` and `cdkd state destroy` refuse such a record before the prompt
and before the lock (`STATE_RESOURCES_MALFORMED`, exit `1`), naming the rows it
could not read, and again on the record the empty-stack path re-reads under the
lock. A nested **child** record reached through its parent's destroy inherits
it, as the map refusal above is inherited.

The refusal offers no `cdkd state orphan` template, unlike the map refusal:
every other row is readable, and dropping the whole record with its resources
left standing is more than one row asks for. Inspect the record with
`cdkd state show '<stack>' --stack-region '<region>' --json`, repair the row,
and re-run. A row that names its type but no usable `physicalId` is not refused
here: it is skipped on its own (see
[Skipped resources on destroy](#skipped-resources-on-destroy)). Full per-command
table in
[State Management](state-management.md#when-one-resources-record-cannot-be-read).

## An unreadable `properties` map refuses the destroy

Each readable row's `properties` map is handed to that resource's delete, and
what the delete does is read off it: whether an RDS DB instance takes a final
snapshot, whether an ECR repository is emptied first, how many resources the
`--remove-protection` prompt counts. The delete order is built from it too,
since the dependency graph reads each row's `Ref` / `Fn::GetAtt` edges out of
the map. A map that is missing, a string, a list, a number, a boolean or `null`
used to reach the delete as it stood. Reading it as empty is not the safe answer:
every one of those keys then reads as absent, so the delete fails or takes the
wrong branch after every resource ordered before it was already deleted.

`cdkd destroy` and `cdkd state destroy` therefore refuse such a record before
the prompt and before the lock (`STATE_RESOURCES_MALFORMED`, exit `1`), naming
the rows whose map they could not read. A row whose own `DeletionPolicy`
retains it is refused too, because its edges still order the others. A nested
**child** record reached through its parent's destroy inherits the refusal.
When a row is unreadable as a whole, the refusal above names it instead.

Inspect the record with
`cdkd state show '<stack>' --stack-region '<region>' --json`, repair the map,
and re-run.

## A malformed `outputs` map refuses the destroy

`cdkd destroy` and `cdkd state destroy` refuse to delete a stack another stack
still imports from, and they decide whether to run that cross-stack check by
asking whether the record's `outputs` map holds anything.

A state record is used as typed data without a field-by-field shape check, so a
hand-edited or truncated one can hold a string, a list, a number, a boolean or
`null` there. Both answers are then wrong, and one of them is dangerous:

| Stored shape | What the check used to conclude |
| --- | --- |
| A string or a list | "this stack exports things", inventing one name per character or element |
| `null`, a number, a boolean, `[]` | "this stack exports nothing" — the cross-stack check was **skipped** and the record deleted while consumers still resolved against it |

The destroy therefore refuses before the per-stack confirmation prompt
(`STATE_RESOURCES_MALFORMED`, exit `1`), naming the record and the region.
The refusal sits inside
`runDestroyForStack`, so every route into a destroy inherits it — including a
nested **child** record reached through its parent's destroy.
Reading the bag as empty — the repair `cdkd diff` and `cdkd state show` apply —
is the second row above, so there is no safe repair here.

Inspect the record with `cdkd state show '<stack>' --stack-region '<region>'
--json`, repair or remove it, then re-run. Note what "remove" means here: with
`deploy`, `destroy`, `state destroy`, `orphan`, `import` and `scrub` all
refusing such a record, the command that will still remove it is
`cdkd state orphan`, which drops the record without touching AWS —

```bash
cdkd state orphan '<stack>' --stack-region '<region>'
```

— which orphans whatever the record described, so prefer repairing the bag when
the resources still matter. An **absent** `outputs` field is not
a defect and is never refused: cdkd writes such records on purpose. The full
per-command table is in [State Management](state-management.md#when-outputs-is-not-an-object).

## A malformed `orphans` list refuses the destroy

The `orphans` field records the `DeletionPolicy: Retain` resources an earlier
failed deploy left standing in AWS, and the destroy reads it twice: to LIST them
for you before deleting anything — the only notice that those resources stop
being tracked — and to decide whether a record with no resources left is empty
enough to delete outright.

It is a LIST, and the same absent shape check lets a hand-edited or truncated
record hold a string, a number, an object or `null` there:

| How the field reads | What the destroy would do unguarded |
| --- | --- |
| As length 0 — `null`, `""`, `{"length": 0}` | Counts as no orphans: the listing is skipped and, on a stack with nothing else left, the record is **removed** outright, taking the evidence that retained resources are still live in AWS with it |
| Every other unreadable shape | Dies in the listing with a `TypeError` that names nothing (a string is walked one **character** at a time; the other shapes are not iterable), or skips the listing and finishes the destroy without ever reporting the orphans — removing the record on a clean run, or writing it back with the damaged field intact when resources failed, were skipped, or the run was interrupted |

Reading the field as empty is the FIRST of those rows rather than an
alternative to it, so there is no safe repair here either.

`cdkd destroy` therefore refuses at its first read AND at the under-lock re-read
(`STATE_RESOURCES_MALFORMED`, exit `1`) — the re-read matters because a
concurrent writer or a hand edit between the two is exactly what the lock is
there to catch, and the re-read record is the one the deletion acts on.

To drop such a record deliberately and leave every live resource standing, the
route is the one the `outputs` refusal above names — `cdkd state orphan`, which
removes the record without reading either field, and whose caveats are the same
here. An **absent** `orphans` field is not a defect and is never refused.

A readable list holding a record no reader can use is refused the same way, at
both reads. The listing prints each record's own `logicalId`, resource type and
physical id, and validates none of them, so without the refusal the damage
decides what you see: a row can abort the listing before the confirmation, or be
printed with a field missing from it and approved. Two records sharing one
`logicalId` are refused too, though the listing would print both: no cdkd
command writes that (the rollback save merges by id, and every other save
carries the list unchanged), so the record is damaged, and deleting it would discard it
before anyone decides which of the two resources the stack still owns. Every field the listing
prints is sanitized, so a stored value cannot forge a row or redraw the lines
above it — and so is the list of resources to be deleted above it.

The per-command tables are in State Management — one for
[the container](state-management.md#when-orphans-is-not-a-list), one for
[a single record](state-management.md#when-one-orphans-record-cannot-be-read).

## Every other mutating confirmation prompt is interactive-only too

Ten more commands prompt before a mutation, and all of them follow the same
non-TTY rule as the destroy prompts above:

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

On a non-TTY stdin each refuses **before** creating the prompt, throwing
`CdkdError` with the code `NON_INTERACTIVE_CONFIRM` and exiting **1**. The
message names the command and the flag that avoids the prompt. Piping `y` in is
not a substitute: pass the flag from the table, which short-circuits above the
check and never consults stdin at all.

Two rows carry a second escape. `cdkd state refresh-observed` and
`cdkd state migrate` return at their `--dry-run` check before the prompt block,
so a preview needs no flag from the table and runs unattended.

Refusing rather than auto-confirming is uniform here because **every one of
these guards a mutation** — a rollback replay, a state-record removal, an
observed-property refresh, an orphan, an import, an export-then-delete-state, a
drift accept/revert, a CloudFormation stack retirement, a state-bucket
migration, an event-history prune. There is no read-only command in the set, so
there was no case for the `cdkd deploy` treatment. `cdkd deploy`'s
asset-storage auto-create prompt remains the one deliberate exception (it
assumes "yes" on a non-TTY), because a deploy is recoverable.

### What survives a refusal

**No partial mutation survives it.** That is the guarantee, and it is worth
stating precisely rather than as "nothing has happened yet", because for two of
these something already has:

- **A state lock IS held at the prompt on four of them.** `cdkd orphan`,
  `cdkd import`, `cdkd export` (its migration and nested-tree prompts) and
  `cdkd rollback` acquire the stack's lock before building the plan they are
  about to ask you to confirm. Every one of them releases it in a `finally`, so
  the refusal releases it on the way out and **no lock is leaked** — a re-run
  with the flag is not blocked by the run that refused. No lock is held at
  `cdkd drift`'s two prompts or at `cdkd export`'s rollback-journal override
  (all three acquire *after* the prompt), nor at either `cdkd state` prompt
  (they only READ lock state), `cdkd state migrate`, or the CloudFormation
  retirement.
- **The CloudFormation retirement has already written, in two senses.** cdkd
  state is written *before* it is reached at all — it is the last step of
  `cdkd import --migrate-from-cloudformation` — so a refusal leaves the
  resources recorded in cdkd state while the CloudFormation stack is still
  live. Its refusal message says so, and names that command. Separately, for a
  nested stack whose child templates exceed CloudFormation's 51,200-byte inline
  limit, those child bodies have already been uploaded to `cdkd-migrate-tmp/`
  in the state bucket by the time the prompt fires; they are **deleted on the
  refusing path**, exactly as they are when you answer `n`.

Every other prompt refuses after read-only work only — the plan it was about to
ask you to confirm, and nothing else.

## Related

- [CLI Reference](cli-reference.md) — every command and the full exit-code table
- [`cdkd state`](cli-state.md) — the flags of `cdkd state destroy`, and the rest of the state command family
- [Orphan vs Destroy](orphan-vs-destroy.md) — when to drop state instead of deleting resources
- [`cdkd rollback`](cli-rollback.md) — reverting a failed or interrupted deploy
- [State Management](state-management.md) — state records, locks, and force-unlock
- [Deployment Events](deployment-events.md) — the history `--purge-events` deletes
- [Troubleshooting](troubleshooting.md) — what to do when a destroy fails
