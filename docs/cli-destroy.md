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
cdkd destroy --all -f                       # every stack in the CDK app
cdkd destroy MyStack --remove-protection    # flip deletion protection off first
cdkd destroy MyStack --skip-final-snapshot  # skip the DeletionPolicy: Snapshot snapshots
cdkd state destroy MyStack --yes            # no CDK app needed — reads state only
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to destroy. Physical names, CDK display paths, or wildcards. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--all` | off | Destroy every stack in the CDK app. |
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

A stack is named by its **physical** CloudFormation name (`MyStage-Api`) or by
its **CDK display path** (`MyStage/Api`); a pattern containing `/` is matched
against the display path, one without it against the physical name. Wildcards
work in both forms (`cdkd destroy 'MyStage/*'`). Display-path matching needs
synthesis to succeed, because a state record only carries physical names — so
`cdkd state destroy`, which never synthesizes, matches physical names only.
When the app defines a single stack, no name is needed.

`--all` targets every stack in the current CDK app. Whenever more than one stack
is selected — by `--all` or by naming several — they are ordered so that a
consumer stack is destroyed before the producers it reads from.

A nested-stack **child** cannot be destroyed directly: `cdkd destroy <child>`
is refused, because the parent's `AWS::CloudFormation::Stack` row would then
point at resources that no longer exist and the parent's next deploy would try
to recreate them. Destroy the parent to cascade-delete the child, or use
`cdkd state destroy <child>` if you deliberately want to leave the parent's
reference dangling.

## Confirmation prompts

`cdkd destroy` asks before deleting anything. `--yes` / `-y` — or `-f` /
`--force`, which means the same thing here — skips the prompt.

| Prompt | Raised by | Skipped by |
| --- | --- | --- |
| Per-stack (`Are you sure you want to destroy stack "X" ...`) | `cdkd destroy <stack>`, `cdkd destroy --all` | `-y` / `--yes`, `-f` / `--force` |
| Per-stack, same prompt | `cdkd state destroy <stack>` | `-y` / `--yes` only — `cdkd state destroy` does not accept `-f` / `--force` |
| Batch — one prompt for the whole batch, asked before anything is touched | `cdkd state destroy --all` | `-y` / `--yes` |

Under `--remove-protection` the per-stack prompt names the protected resources
(`About to destroy N resources from stack "X", REMOVING DELETION PROTECTION on
K of them. Continue? (y/N)`) and its default flips from `Y/n` to `y/N`.

Nested-stack children are destroyed as part of their parent's cascade and never
prompt separately. `cdkd state destroy --all`'s per-stack prompts are skipped
once its batch prompt is answered.

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

What each refusal guarantees:

- **Batch prompt.** Nothing is read, locked or deleted. A signal delivered at
  that prompt cancels it and exits 130, also without reading, locking or
  deleting anything.
- **Per-stack prompt.** Nothing is locked and nothing is deleted, but the
  refusal is preceded by the strong-reference scan, which READS other stacks'
  state records. That is a weaker guarantee than the batch prompt's.

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
| `130` | A signal arrived at the `cdkd state destroy --all` batch prompt. Nothing was read, locked or deleted. |

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
| `AWS::EC2::Volume` | Pre-delete `CreateSnapshot`, waited to `completed`, then the normal delete. |
| `AWS::Redshift::Cluster` | Pre-delete `CreateClusterSnapshot`, waited to `available`, then the delete. |
| `AWS::ElastiCache::ReplicationGroup` | Pre-delete ElastiCache `CreateSnapshot`, waited to `available`, then the delete. Redis only. |

Generated snapshot identifiers are deterministic and logged:
`<physicalId>-final-<utcTimestamp>` (sanitized to the snapshot-identifier
character rules).

Three of those rows carry behaviour worth knowing before you rely on them:

- **`AWS::EC2::Volume`** is Cloud-Control-routed and `DeleteVolume` takes no
  snapshot parameter, which is why the snapshot is a separate pre-delete step.
  cdkd tags it `cdkd:final-snapshot-of: <volumeId>`, so a destroy re-run reuses
  the existing snapshot instead of creating and charging for a second one.
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

### Which policy cdkd reads

The recorded `state.deletionPolicy` (schema v5+) is what the destroy paths
consult. Pre-v5 state keeps the legacy plain-delete behavior until a redeploy
records the attribute; `cdkd destroy` additionally falls back to the synth
template's `DeletionPolicy` for pre-v5 state.

### Which deletes the policy covers

`UpdateReplacePolicy: Snapshot` is honored on the deploy engine's replacement
and recreate deletes with the same per-type mechanism as the table above. The
`--force-stateful-recreation` stateful guard still applies first where the
replacement is data-losing.

| Delete site | Snapshot behaviour |
| --- | --- |
| `cdkd destroy` / `cdkd state destroy` | Snapshot, then delete. |
| `cdkd deploy`'s DELETE of a resource removed from the template | Snapshot, then delete. |
| Replacement: the delete-first / recreate delete of the OLD resource | Snapshot, then delete. A snapshot failure fails the resource — that delete is load-bearing for the re-create. |
| Replacement: the post-replacement CLEANUP delete of the OLD resource | A TRANSIENT snapshot failure warns and skips the delete, leaking the old resource rather than deleting it un-snapshotted. |
| Rollback of a COMPLETED CREATE (automatic after a failed deploy, or `cdkd rollback`) | Snapshot, then delete; a refusal is a rollback failure, so the journal is kept. `Retain` orphans instead. |
| `cdkd rollback --revert-failed`'s delete of a CREATE that FAILED mid-flight | Same policy matrix — see below. |
| Rollback's delete of the NEW resource (reversing a replacement, i.e. `UpdateReplacePolicy`) | Only the atomic SDK-routed types get a final snapshot; the other shapes keep the plain delete, which is load-bearing for same-name re-creation. |

A **refusal** — a type or route cdkd cannot snapshot — always fails the
resource, at every site including the cleanup delete, matching CloudFormation
failing the update.

#### Rolling back a CREATE that failed mid-flight

`cdkd rollback --revert-failed` applies the same policy matrix: `Retain`
leaves the resource in AWS, `Snapshot` snapshots then deletes (refusing what it
cannot snapshot), and `RetainExceptOnCreate` / `Delete` / absent delete
plainly. It only engages when AWS actually provisioned the resource — the
action requires a recorded physical id AND a matching state record — so the
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
| `AWS::EC2::Instance` | `DisableApiTermination` | `ModifyInstanceAttribute(DisableApiTermination={Value:false})` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` | `ModifyLoadBalancerAttributes([{Key: 'deletion_protection.enabled', Value: 'false'}])` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) | `UpdateUserPool(DeletionProtection='INACTIVE')` |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection` (`none` / `prevent-force-deletion` / `prevent-all-deletion`) | `UpdateAutoScalingGroup(DeletionProtection='none')` followed by `DeleteAutoScalingGroup(ForceDelete=true)`, so AWS terminates running instances as part of the delete |
| `AWS::DSQL::Cluster` | `DeletionProtectionEnabled` | Cloud Control `UpdateResource` patch (`[{op: add, path: /DeletionProtectionEnabled, value: false}]`), waited to completion, then `DeleteResource` |
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
- The flip-off call is **idempotent** — providers always issue it when the flag
  is set, whether or not the resource currently has protection on. AWS accepts
  the already-disabled case without error.
- A failure of the flip-off itself (NotFound or similar) is logged at debug;
  the actual delete API call still runs and surfaces its own error message.
- **RDS and Cognito are gated on the flag like every other type.** Destroying
  an RDS or Cognito UserPool resource whose deletion protection was set
  externally (console, AWS CLI) without `--remove-protection` surfaces AWS's
  `InvalidParameterCombination` / `InvalidParameterException` error rather than
  silently succeeding.

### Restoring a DynamoDB guard after a failed destroy

On `AWS::DynamoDB::Table` and `AWS::DynamoDB::GlobalTable`, a flip followed by
a **terminal** delete failure — or by a Ctrl-C landing after the flip — is
compensated: cdkd re-enables `DeletionProtectionEnabled` before reporting the
failure, so a destroy that did not happen does not leave a live table with its
guard stripped. Four limits are deliberate:

- It only restores a guard **cdkd itself turned off in this run**. A table
  whose protection was already disabled beforehand, or whose pre-flip read
  failed, is left alone.
- It keys on how the delete ENDS, not on individual retries, and it does not
  run once AWS has ACCEPTED the `DeleteTable` — a failure after that point is a
  wait giving up on a table that is already being deleted.
- It does not run when a retryable failure exhausts the destroy loop's attempt
  cap, nor when a per-resource `--resource-timeout` fires. Both leave the guard
  off.
- It is best-effort. The delete failure stays the reported outcome, and a
  re-enable that itself fails is reported as a separate ERROR line naming the
  table and the restore command below. A re-enable that fails with
  `ResourceNotFoundException` is reported at **warn** instead and names a
  `describe-table` check first, because DynamoDB returns that error both for a
  table that is gone and for one whose status is merely not `ACTIVE`.

To restore the guard by hand:

```bash
aws dynamodb describe-table --table-name <table>
aws dynamodb update-table --table-name <table> --deletion-protection-enabled
```

## `--purge-events`: also delete deployment-event history on destroy

By default `cdkd destroy` removes `state.json` / `lock.json` but **keeps** the
stack's deployment-event history (the `deployments/` store) as post-mortem
context — so the state bucket does not return fully empty after a teardown.
`cdkd destroy <stack> --purge-events` opts into purging that history too, so
the bucket returns to empty:

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
  [`cdkd events prune <stack> --all`](cli-events.md).

## Skipped resources on destroy

A **skipped** resource is one cdkd could not address, so it may still exist and
still be billing. Three causes today:

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
  | `AWS::IAM::Policy` with neither a policy name in its `physicalId` nor a `PolicyName` property | The policy stays attached wherever it is. |
  | `AWS::IAM::Policy` naming no `Roles` / `Groups` / `Users` | An inline policy exists only as an attachment, so a record naming no principal cannot be deleted. |
  | `AWS::IAM::UserToGroupAddition` missing `GroupName` or `Users` | The users keep every permission the group grants. |

  Each warning names what survived and how to repair it. Where the resource's
  **parent** is part of the same destroy — the Lambda function, the IAM role /
  group / user — that parent's own delete removes the skipped resource anyway,
  so AWS ends clean and only the cdkd record is stale. The warning says so, and
  `cdkd state orphan <stack>` clears it.

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
figure but records no events at all.

The state record is kept on purpose: without it you would have neither the AWS
resource deleted nor an id to go and delete it with. To finish the destroy,
repair whatever the per-resource warning names — the `physicalId` for the decode
failures, the missing property (`FunctionName`, `ServiceToken`, `GroupName` /
`Users`) for the missing-field causes — in state (`cdkd state show <stack>` to
inspect) and re-run, or delete the resource by hand and drop the record with
`cdkd state orphan <stack>`. The summary line names the exact state file(s) to
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
(`cdkd state orphan <parent>~<child>`), not the parent's — the resource that
failed lives in the child, and orphaning the parent would drop the very row that
keeps the child reachable. A run with both failures and skips prints each remedy
separately, since they differ in kind: a failure is retryable (`cdkd destroy`
again), while a skip needs its state record repaired first.

The run-level exit message counts **entries**, not resources: a skipped
nested-stack row is one entry however many of the child's own resources it
covers. The per-stack summary lines above it give the exact breakdown.

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

- the exact **region-qualified** `cdkd force-unlock <stack> --stack-region ...`
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

## Every other mutating confirmation prompt is interactive-only too

Ten more commands prompt before a mutation, and all of them follow the same
non-TTY rule as the destroy prompts above:

| Command | Prompt | Flag that avoids it |
| --- | --- | --- |
| `cdkd rollback` | `Roll back '<stack>' (<region>)?` | `--force` (or `-y` / `--yes`) |
| `cdkd state orphan` | `Remove state for <refs> from s3://...?` | `-y` / `--yes`, or `-f` / `--force` |
| `cdkd state refresh-observed` | `Refresh observedProperties for N stack(s)...?` | `-y` / `--yes` |
| `cdkd orphan` | `Orphan N resource(s) from cdkd state...?` | `-y` / `--yes`, or `-f` / `--force` |
| `cdkd import` | `Write state for <stack> with N resource(s)?` | `-y` / `--yes` |
| `cdkd export` | the rollback-journal override, the migration confirm, and the nested-stack tree-wide confirm | `-y` / `--yes` |
| `cdkd drift --accept` / `--revert` | `Update cdkd state...?` / `Push cdkd state values back into AWS...?` | `-y` / `--yes` |
| `cdkd import --migrate-from-cloudformation`, `cdkd migrate --retire-cfn-stack` | `Set DeletionPolicy=Retain ... then delete the stack?` | `-y` / `--yes` |
| `cdkd state migrate` | `Copy N object(s) from <bucket> -> <bucket>...?` | `-y` / `--yes` |
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
  `cdkd import --migrate-from-cloudformation` / `cdkd migrate
  --retire-cfn-stack` — so a refusal leaves the resources recorded in cdkd
  state while the CloudFormation stack is still live. Its refusal message says
  so, and names both commands. Separately, for a nested stack whose child
  templates exceed CloudFormation's 51,200-byte inline limit, those child
  bodies have already been uploaded to `cdkd-migrate-tmp/` in the state bucket
  by the time the prompt fires; they are **deleted on the refusing path**,
  exactly as they are when you answer `n`.

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
