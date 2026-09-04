---
title: Destroy flags & guards
description: "Destroy-time data guards, DeletionPolicy: Snapshot, --remove-protection, interrupt handling, confirmation prompts, and --purge-events."
---

## Destroy data guards: non-empty S3 buckets and image-carrying ECR repositories

`cdkd destroy` (and `cdkd state destroy`) matches CloudFormation's
fail-and-protect behavior for the two resource types whose delete API
refuses by default while they still hold data:

| Resource type | Without an opt-in | With the opt-in |
| --- | --- | --- |
| `AWS::S3::Bucket` | A non-empty bucket fails the destroy with an actionable "bucket is not empty" error (CloudFormation: `DELETE_FAILED`; Terraform: requires `force_destroy`). The bucket and every object survive. | CDK `autoDeleteObjects: true` (the `aws-cdk:auto-delete-objects` tag) — cdkd auto-empties all object versions + delete markers before `DeleteBucket`, which also absorbs the race where objects (e.g. ALB access logs) land between the auto-delete custom resource's cleanup and the bucket deletion. |
| `AWS::ECR::Repository` | A repository that still contains images fails the destroy with an actionable "still contains images" error (CloudFormation: `DELETE_FAILED` unless `EmptyOnDelete: true`; Terraform: requires `force_delete`). The repository and images survive. | CDK `emptyOnDelete: true` (`EmptyOnDelete: true` in the template) or the legacy `autoDeleteImages` (`aws-cdk:auto-delete-images` tag) — cdkd deletes with `force: true`. |
| `AWS::S3Express::DirectoryBucket` | A non-empty directory bucket fails the destroy with an actionable "is not empty" error (CloudFormation: `DELETE_FAILED`, live-A/B-verified 2026-08-03). The bucket and objects survive. | Add the `aws-cdk:auto-delete-objects` tag with value `true` to the bucket's `Tags` (a handled property; CDK has no `autoDeleteObjects` sugar for directory buckets, so declare the tag explicitly on the L1). The opted-in auto-empty absorbs concurrent-write races with the same bounded empty-retry loop as the standard bucket. Alternatively empty the bucket manually (`aws s3 rm s3://<bucket> --recursive` — directory buckets have no versioning) and destroy again. `--force-stateful-recreation` replacement deletes are authorized as for the other types. |

To destroy anyway without redeploying, empty the data first (`aws s3 rm
s3://<bucket> --recursive` — for versioned buckets delete all object
versions and delete markers; `aws ecr batch-delete-image`) and re-run the
destroy.

Replacement deletes during `cdkd deploy` are governed by the existing
stateful-recreation consent instead: passing `--force-stateful-recreation`
(the flag whose documented meaning is "I accept a data-losing recreation")
also authorizes the force-cleanup on the replaced resource's delete.

Related parity notes, verified against real CloudFormation (2026-08-02): CFn
itself hard-deletes `AWS::SecretsManager::Secret` (no recovery window) and
force-detaches out-of-band IAM role policy attachments on delete — cdkd's
identical behavior for those types is parity, not a divergence.

## `DeletionPolicy: Snapshot`: final snapshots on delete (`--skip-final-snapshot`)

CloudFormation creates a **final snapshot before deleting** a resource whose
`DeletionPolicy` is `Snapshot` — and the CDK RDS L2 (`DatabaseInstance` /
`DatabaseCluster`) defaults `removalPolicy` to `SNAPSHOT`, so plain CDK
database stacks rely on it. cdkd matches this on every delete
path: `cdkd destroy`,
`cdkd state destroy`, the `cdkd deploy` DELETE of a resource removed from
the template, the rollback of a CREATE (automatic after a failed deploy, or
`cdkd rollback`), and — for `UpdateReplacePolicy: Snapshot` — the deploy
engine's replacement / recreate deletes of the OLD resource.

| Resource type | How the final snapshot is created |
| --- | --- |
| `AWS::RDS::DBInstance` | `DeleteDBInstance(SkipFinalSnapshot=false, FinalDBSnapshotIdentifier=<generated>)`. CFn nuance matched: an instance that is a **cluster member** (`DBClusterIdentifier` set) is deleted without an instance-level snapshot — cluster-level snapshots cover it. |
| `AWS::RDS::DBCluster` | `DeleteDBCluster(SkipFinalSnapshot=false, FinalDBSnapshotIdentifier=<generated>)` |
| `AWS::Neptune::DBCluster` | `DeleteDBCluster(...FinalDBSnapshotIdentifier)` (Neptune SDK) |
| `AWS::DocDB::DBCluster` | `DeleteDBCluster(...FinalDBSnapshotIdentifier)` (DocDB SDK) |
| `AWS::ElastiCache::CacheCluster` | `DeleteCacheCluster(FinalSnapshotIdentifier=<generated>)` — Redis engine only; a Memcached cluster under `Snapshot` surfaces AWS's rejection, matching CFn's `DELETE_FAILED` |
| `AWS::EC2::Volume` | Pre-delete `CreateSnapshot` (tagged `cdkd:final-snapshot-of: <volumeId>`), **waited to `completed`**, then the normal delete — the type is Cloud-Control-routed and `DeleteVolume` has no snapshot parameter. Idempotent: a destroy re-run reuses the tagged snapshot instead of creating a second one. |
| `AWS::Redshift::Cluster` | Pre-delete `CreateClusterSnapshot` (`<clusterId>-final-<ts>`), **waited to `available`**, then a bounded wait for the CLUSTER itself to settle (the fresh snapshot leaves it busy and the delete would otherwise 400 with "There is an operation running on the Cluster"), then the CC-routed delete. |
| `AWS::ElastiCache::ReplicationGroup` | Pre-delete ElastiCache `CreateSnapshot`, waited to `available`, then the CC-routed delete. The snapshot source depends on cluster mode: a cluster-mode-ENABLED (sharded) group is snapshotted by `ReplicationGroupId`, while the cluster-mode-DISABLED default must name its PRIMARY member cache cluster instead (AWS rejects the group form with "Please specify a cache cluster instead") — cdkd resolves this automatically. Redis only; Memcached / snapshot-incapable node types surface AWS's rejection, matching CFn's `DELETE_FAILED`. |

Generated snapshot identifiers are deterministic and logged:
`<physicalId>-final-<utcTimestamp>` (sanitized to the snapshot-identifier
character rules).

`--skip-final-snapshot` (on `cdkd deploy`, `cdkd destroy`, `cdkd state
destroy`, and `cdkd rollback`) is the explicit opt-out: delete WITHOUT the
final snapshot (data loss — useful for dev/test stacks where the snapshot
cost/latency is unwanted, and the escape hatch for the cc-api-routed refusal
below).

Notes:

- The recorded `state.deletionPolicy` (schema v5+) is what the destroy paths
  consult; pre-v5 state keeps the legacy plain-delete behavior until a
  redeploy records the attribute (`cdkd destroy` also falls back to the
  synth template's `DeletionPolicy` for pre-v5 state).
- A Cloud-Control-routed resource of an atomic-parameter type (state
  records `provisionedBy: cc-api` — the silent-drop auto-routing) is
  **refused**: Cloud Control's `DeleteResource` has no final-snapshot
  parameter, so cdkd cannot honor the policy on that route. Snapshot
  manually, then re-run with `--skip-final-snapshot`.
- `UpdateReplacePolicy: Snapshot` is honored on the deploy engine's
  replacement / recreate delete sites with the same mechanism
  matrix; the `--force-stateful-recreation` stateful guard still applies
  first where the replacement is data-losing. Failure handling differs by
  site, deliberately: the delete-first / recreate paths surface a snapshot
  failure as a resource failure (their delete is load-bearing for the
  re-create), while the post-replacement CLEANUP delete keeps its
  warn-and-continue policy for a TRANSIENT snapshot failure — it skips the
  delete, so the old resource is leaked with a warning rather than deleted
  un-snapshotted. A REFUSAL (a type / route cdkd cannot snapshot) always
  fails the resource, matching CloudFormation failing the update.
- Rolling back a COMPLETED CREATE (the automatic rollback after a failed
  deploy, or `cdkd rollback`) IS a delete, so `DeletionPolicy: Snapshot`
  applies to it:
  cdkd creates the final snapshot and then deletes, using the same mechanism
  matrix as the table above, and REFUSES (counting the op as a rollback
  failure, so the journal is kept for a re-run) any shape it cannot snapshot
  — pass `--skip-final-snapshot` to `cdkd rollback` to delete without
  it. Previously such a resource was ORPHANED — dropped from
  state and left running in AWS — which silently handed you an untracked,
  billing resource. `DeletionPolicy: Retain` still orphans (that is what the
  policy asks for).
- `cdkd rollback --revert-failed`'s delete of a resource whose CREATE FAILED
  mid-flight applies the SAME policy matrix: `Retain` leaves it in
  AWS, `Snapshot` snapshots then deletes (refusing what it cannot snapshot),
  `RetainExceptOnCreate` / `Delete` / absent delete plainly. That branch
  previously read no policy at all. It only engages when AWS actually provisioned
  the resource — the action requires a recorded physical id AND a matching
  state record — so the policy is never applied to a resource that never
  existed. A refusal here is recoverable rather than final: the op stays in
  the journal, so once a half-created resource settles into a snapshot-capable
  state (an RDS instance rejects a final-snapshot delete while `creating`) a
  re-run completes it, and `--skip-final-snapshot` is the opt-out if you would
  rather drop the data.
- On a ROLLBACK's delete-of-the-NEW-resource (reversing a replacement, i.e.
  `UpdateReplacePolicy`), only the atomic SDK-routed types get a final
  snapshot — the other shapes deliberately keep the plain delete (that
  delete is load-bearing for same-name re-creation).
- Snapshot reuse across a re-run resumes only an IN-FLIGHT snapshot for the
  name-keyed APIs (Redshift / ElastiCache): their identifiers are
  user-chosen and reusable, so adopting an already-`available` snapshot
  could hand you a PREVIOUS generation's data. A re-run after the snapshot
  completed therefore creates a second (timestamped, non-colliding) one.
  EC2 Volume reuses a completed snapshot safely — its tag is keyed on an
  AWS-generated volume id that is never reused.
- Final snapshots are billed AWS resources that survive the destroy by
  design — delete them manually when no longer needed.

## `--remove-protection`: bypass deletion protection on destroy

`cdkd destroy --remove-protection` and `cdkd state destroy
--remove-protection` flip every protection flag off in-place
before each provider's delete API call so the destroy proceeds
without an intermediate edit / redeploy / console click. Covers
**stack-level** `terminationProtection` (the bypass logs a WARN
line naming the stack — `cdkd state destroy` already ignores
`terminationProtection` because the flag is a CDK property
surfaced via synth, so the flag is effectively a no-op there for
that part) AND **resource-level** protection on the following
types:

| Resource type | Protection field | Bypass call |
| --- | --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` | `PutLogGroupDeletionProtection(deletionProtectionEnabled=false)` |
| `AWS::RDS::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::RDS::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (DocDB SDK) — DocDB DBInstance has no `DeletionProtection` field, so no per-instance bypass; cluster-level covers the common case |
| `AWS::Neptune::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (Neptune SDK) |
| `AWS::Neptune::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` (Neptune SDK) |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` | `UpdateTable(DeletionProtectionEnabled=false)` then `DescribeTable` poll until `ACTIVE` |
| `AWS::EC2::Instance` | `DisableApiTermination` | `ModifyInstanceAttribute(DisableApiTermination={Value:false})` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` | `ModifyLoadBalancerAttributes([{Key: 'deletion_protection.enabled', Value: 'false'}])` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) | `UpdateUserPool(DeletionProtection='INACTIVE')` |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection` (`none` / `prevent-force-deletion` / `prevent-all-deletion`) | `UpdateAutoScalingGroup(DeletionProtection='none')` followed by `DeleteAutoScalingGroup(ForceDelete=true)` so AWS terminates running instances as part of the delete |
| `AWS::DSQL::Cluster` | `DeletionProtectionEnabled` | Cloud Control `UpdateResource` patch (`[{op: add, path: /DeletionProtectionEnabled, value: false}]`), waited to completion, then `DeleteResource` — the generic CC-routed protection flip; more CC-routed types with a top-level protection property can join the registry in `src/provisioning/cc-protection-properties.ts` once live-verified |
| `AWS::NeptuneGraph::Graph` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::SMSVOICE::ProtectConfiguration` | `DeletionProtectionEnabled` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::VerifiedPermissions::PolicyStore` | `DeletionProtection` (`{Mode: ENABLED\|DISABLED}`) | Same generic CC patch flip with `value: {Mode: DISABLED}` then `DeleteResource` |
| `AWS::EKS::Cluster` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::RDS::GlobalCluster` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |
| `AWS::DocDB::GlobalCluster` | `DeletionProtection` | Same generic CC patch flip (`value: false`) then `DeleteResource` |

Behavior:

- The flip-off call is **idempotent** — providers always issue it
  when the flag is set, regardless of whether the resource
  currently has protection on. AWS accepts the no-op (already-
  disabled) case without error.
- A failure of the flip-off itself (NotFound / similar) is logged
  at debug; the actual delete API call still runs and surfaces
  its own error message.
- On the two DynamoDB types (`AWS::DynamoDB::Table` and
  `AWS::DynamoDB::GlobalTable`), a flip that is followed by a
  **terminal** delete failure — or by a Ctrl-C landing after the
  flip — is **compensated**: cdkd re-enables
  `DeletionProtectionEnabled` before reporting the failure, so a
  destroy that did not happen does not leave a live table with
  its guard stripped. Four limits are deliberate:
  it only ever restores a guard cdkd itself turned off in this
  run (a table whose protection was already disabled beforehand,
  or one whose pre-flip read failed, is left alone); it does not
  fire BETWEEN retries — the destroy loop re-enters `delete()`
  for a retryable failure and flips the guard off again, so
  compensating there would only toggle it back and forth, and
  what counts is how the delete ENDS (a throttle followed by a
  terminal refusal IS compensated); it does not fire once AWS has
  ACCEPTED the `DeleteTable`, because a failure after that point
  is a wait giving up on a table that is already being deleted;
  and it is best-effort — the delete failure stays the reported
  outcome, and a re-enable that itself fails is reported as a
  separate ERROR line naming the table plus the
  `aws dynamodb update-table --deletion-protection-enabled`
  command that restores it by hand. A re-enable that fails with
  `ResourceNotFoundException` is reported at **warn**
  instead, because cdkd cannot tell which case it is:
  DynamoDB returns that error both for a table that is gone and
  for one whose status is merely not `ACTIVE`. So the line drops
  the claim that the table is LIVE — which would be false in the
  first case — while staying visible, and names a
  `describe-table` check before the restore command. Every other
  re-enable failure keeps the ERROR line.
- The compensation survives a long retry sequence.
  It latches per table for the duration of the destroy, and that
  latch's reuse window is **sliding** — every re-entry restarts
  it — so what is bounded is idle time since the last attempt
  rather than the total lifetime of the sequence. A
  `--resource-timeout` set past the window used to let an
  accumulation of attempts age out its own latch mid-flight,
  after which the next attempt read the guard as already off
  (cdkd having turned it off itself) and compensated nothing.
  This is not unconditional. `acquire` runs once per attempt, so
  what the window measures is the previous attempt's own duration
  plus the loop backoff. That is normally comfortable — the
  26-minute delete allowance covers the WHOLE retry sequence
  rather than one attempt, and the window adds a 4-minute margin
  sized for that backoff — so what can still age out a successor
  is an attempt that OVERRUNS the allowance (a floor poll granted
  at zero remaining, an unpriced teardown), not one that merely
  spends it.
- A **terminal** delete failure releases the latch once the
  compensation above has run — UNLESS that compensating re-enable
  itself failed, in which case the latch is kept so a later delete
  can retry the re-enable cdkd still owes. Retention
  exists so a re-entered delete keeps the same record, and only a
  retryable failure is re-entered; holding it past a terminal one
  left `flippedOffByThisRun` true for a full sliding window after
  the last attempt, during which a second destroy of the same table
  in the same process could inherit it and issue an `UpdateTable`
  (`DeletionProtectionEnabled: true`) nobody asked for. The release
  runs after the compensation reads the record, so the re-enable
  above is unaffected. Two failures still RETAIN the latch. A
  retryable one — the attempt-cap case below included — does,
  because a re-entry is exactly what the record is for. So does a
  terminal one whose compensating re-enable itself FAILED: there
  the guard really is off and cdkd is the one that turned it off,
  so the latch is kept and a later destroy of the same table in the
  same process retries the re-enable cdkd still owes rather than
  finding the guard already down and leaving it there.
- Two cases it deliberately does NOT reach, both leaving the
  guard off: a retryable failure that exhausts the destroy loop's
  own attempt cap (cdkd cannot see which attempt is the last),
  and a per-resource `--resource-timeout` firing, which rejects
  without cancelling the delete, so the provider never observes a
  failure to compensate.
- The flag is **all-or-nothing for the run**: a single
  `--remove-protection` covers every protection-bearing type
  listed above. There is no per-type variant. If you need finer control, run a stack-only
  destroy and clean up the rest manually.
- The interactive confirmation prompt is updated when the flag is
  set: `About to destroy N resources from stack "X", REMOVING
  DELETION PROTECTION on K of them. Continue? (y/N)`. The
  default flips from `Y/n` to `y/N`. `--yes` / `-y` / `-f`
  skips the prompt.
- **RDS / Cognito gating change**: prior to this flag, the RDS
  DBInstance / DBCluster providers always issued
  `ModifyDB{Instance,Cluster}` with `DeletionProtection: false`
  before destroy, and the Cognito UserPool provider always issued
  `DescribeUserPool` + (if `ACTIVE`) `UpdateUserPool
  (DeletionProtection='INACTIVE')` before destroy. Both implicit
  behaviors are now gated on `--remove-protection` to match the
  other types — destroying an RDS or Cognito UserPool resource
  whose deletion protection was set externally (console / AWS CLI)
  without `--remove-protection` will surface AWS's
  `InvalidParameterCombination` / `InvalidParameterException`
  error rather than silently succeed.
- Protection types not in the table above (CloudFront
  Distributions, S3 bucket retention, etc.) are out of scope —
  the list is curated to the cases where AWS exposes a
  synchronous "flip protection off" API call.

```bash
# Stack with terminationProtection: true OR a protected DynamoDB / RDS / Logs / EC2 / LB
cdkd destroy MyStack --remove-protection
cdkd destroy --all --remove-protection -y

# CDK-app-free counterpart — the resource-level flip applies the same way;
# stack-level terminationProtection is already ignored by `state destroy`.
cdkd state destroy MyStack --remove-protection -y
```

## Interrupting a destroy (Ctrl-C / SIGTERM)

`cdkd destroy` and `cdkd state destroy` shut down gracefully. The **first**
Ctrl-C stops scheduling new deletes; the deletes already in flight are awaited,
the state file is flushed to its minimal preserved form, and the stack lock is
released. The command then exits non-zero
(`Destroy interrupted by Ctrl-C. State preserved`) so CI sees that the teardown
did not complete — re-running `cdkd destroy` picks up the remaining resources.
A **second** Ctrl-C force-quits without waiting for the in-flight call. Which
recovery command it prints depends on whether a per-stack teardown had armed
its own handler yet, which is not the same as whether a stack is "running":

- the exact **region-qualified** `cdkd force-unlock <stack> --stack-region ...`
  once that stack's teardown owns the signal, i.e. it can name the lock;
- a **hedged** `cdkd force-unlock <stack-name>` otherwise — both between two
  stacks (where the finished stack has already released its lock, unless that
  release itself failed) **and on the FIRST signal inside a stack that has not
  yet armed its teardown**, the window between the loop dispatching the stack
  and the runner registering its handler. Nothing at either point knows which
  lock to name.

CI cancellation delivers
SIGTERM rather than Ctrl-C, and it is routed through the identical path.

Under `--all`, the interrupt also stops the run **before the next stack
starts** — including a signal that lands between two stacks, or while the
interrupted stack was finishing its own teardown, which are windows the
per-stack teardown cannot observe at all. Previously a Ctrl-C
there was either swallowed, letting `--all` delete the next stack, or taken by
a last-resort force-quit that exited 130 with the lock stranded.

The non-zero exit means **work was left undone**, not merely "a signal
arrived". A Ctrl-C that lands in the tail of the run — after the last (or only)
stack has already been destroyed, while cdkd is finalizing its event record —
leaves nothing to re-run, so that case exits 0.

`cdkd state destroy --all` prompts once for the whole batch before it touches
anything. A signal at that prompt cancels it and exits 130 without reading,
locking or deleting anything.

The prompt is **interactive-only**: when stdin is not a TTY — a piped,
redirected or CI run — the command refuses **before** creating the prompt and
exits non-zero, naming `--yes` as the way through. Nothing is read, locked or
deleted. This is the same non-interactive rule `cdkd gc` and
`cdkd bootstrap --destroy` follow. Use `--yes` / `-y` to confirm the batch
non-interactively; that flag short-circuits above the check, so it never
consults stdin at all.

### The PER-STACK destroy prompt is interactive-only too

**Upgrade note — this is a behaviour change, and it adds an exit-code
contract**. The
per-stack confirmation — the `Are you sure you want to destroy stack "X" ...`
prompt that `cdkd destroy <stack>`, `cdkd destroy --all` and
`cdkd state destroy <stack>` all share — now follows the same rule as the batch
prompt above: on a non-TTY stdin it refuses **before** creating the prompt,
throwing `CdkdError` with the code `NON_INTERACTIVE_CONFIRM` and exiting
exit code `1`. Note this is NOT the same guarantee the batch prompt above carries. That one
promises nothing is read, locked or deleted; here the refusal is preceded by the
strong-reference scan, which READS other stacks' state records. Nothing is locked and
nothing is deleted on the path that refuses.

A stack whose state record holds ZERO resources never reaches the refusal at all: that
branch returns earlier, having taken the lock and deleted the record, and a non-interactive
run of it still succeeds. The two are mutually exclusive, so this is not a case of the
refusal deleting something first.

Before this change that prompt had no non-TTY guard at all, and
`rl.question` never settles once stdin is at EOF. A CI job running
`cdkd destroy MyStack` without `--yes` therefore **hung until its own
timeout** rather than failing — no signal is delivered on EOF, so nothing woke
it. Measured on Node 24.15.0, the version `.node-version` pins (and 24.19 before it): `echo y |` resolved, while `printf 'y' |` (no
trailing newline) and `< /dev/null` both hung indefinitely.

What breaks: a pipeline that answered the prompt with `printf 'y\n' | cdkd
destroy MyStack` succeeded before (piped stdin does settle `rl.question` when
the input ends in a newline) and now exits **1**. Pass `--yes` / `-y` — or
`-f` / `--force` on `cdkd destroy` — which short-circuits above the check and
never consults stdin at all. Refusing rather than auto-confirming is the
deliberate choice for a destroy: `cdkd deploy` assumes "yes" on a non-TTY
because a deploy is recoverable, whereas silently answering "yes" for an absent
operator here would delete every resource in the stack.

Not affected: nested-stack children, which are destroyed as part of their
parent's cascade and never prompt separately, and `cdkd state destroy --all`,
whose per-stack prompts are already skipped once the batch prompt above is
answered.

A stack whose deletes were interrupted keeps its `state.json` and its
deployment-event history — the events are the post-mortem for the retry, which
is why `--purge-events` below is skipped on an interrupted run.

## Every other mutating confirmation prompt is interactive-only too

**Upgrade note — this is a behaviour change on nine more prompts**. `rl.question` never
settles once stdin is at EOF, and EOF delivers no signal, so a command that
prompted without a non-TTY guard **hung until its own timeout** in CI rather
than failing. That was closed first for the destroy prompts above; these nine
were the rest of the class:

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
| `cdkd events prune` (the tenth) | `Prune deployment-event history for <stack> (<region>): <scope>?` | `-y` / `--yes` |

On a non-TTY stdin each now refuses **before** creating the prompt, throwing
`CdkdError` with the code `NON_INTERACTIVE_CONFIRM` and exiting **1**. The
message names the command and the flag that avoids the prompt.

**No partial mutation survives the refusal.** That is the guarantee, and it is
worth stating precisely rather than as "nothing has happened yet", because for
two of the nine something already has:

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

What breaks: a pipeline that answered one of these with
`printf 'y\n' | cdkd import ...` succeeded before (piped stdin does settle
`rl.question` when the input ends in a newline) and now exits **1**. Pass the
flag from the table, which short-circuits above the check and never consults
stdin at all.

Refusing rather than auto-confirming is uniform here because **every one of the
nine guards a mutation** — a rollback replay, a state-record removal, an
observed-property refresh, an orphan, an import, an export-then-delete-state, a
drift accept/revert, a CloudFormation stack retirement, a state-bucket
migration. There is no read-only command in the set, so there was no case for
the `cdkd deploy` treatment. `cdkd deploy`'s asset-storage auto-create prompt
remains the one deliberate exception (it assumes "yes" on a non-TTY), because a
deploy is recoverable.

All TEN now share ONE implementation — `confirmOrRefuse` in
`src/cli/commands/confirm-prompt.ts` — nine folded here and `cdkd events
prune` folded last (see below), so the guard
cannot be missed by the next prompt added. Each site keeps its own prompt wording and its own refusal
message; nothing about the interactive experience changed, including the two
prompts that render `(y/N): ` where the other seven render ` [y/N] `.

**`cdkd events prune` was the tenth, and it now follows the same
contract**. It had carried a
non-TTY guard since it shipped, so it never hung and it pruned nothing without
a TTY — but the guard sat at its CALLER rather than in a helper, and it refused
by logging a line and returning, which exits **0**. A CI job branching on exit
1 to detect "cdkd wanted a confirmation" could not see it, and could not tell
"cdkd refused" from "cdkd pruned nothing". It now throws
`NON_INTERACTIVE_CONFIRM` and exits 1 like the other nine, and its own copy of
the byte-identical helper — the last one — is gone.

**BREAKING for `cdkd events prune` specifically**: a non-interactive run
without `--yes` used to exit 0 and is now exit 1. Nothing was pruned in either
case, so the remedy is the same as for the other nine — pass `-y` / `--yes`.

## `--purge-events`: also delete deployment-event history on destroy

By default `cdkd destroy` removes `state.json` / `lock.json` but **keeps** the
stack's deployment-event history (the `deployments/` store) as
post-mortem context — so the state bucket does not return fully empty after a
teardown. `cdkd destroy <stack> --purge-events` opts into purging that
history too, so the bucket returns to empty:

```bash
cdkd destroy MyStack --purge-events -y
```

- The purge runs **only after a clean, non-interrupted destroy** of that
  stack. On a failed / interrupted destroy the events are kept — they are
  exactly the post-mortem you want when retrying.
- "Interrupted" here is the PER-STACK question — was this stack left with
  work to re-run — matching what the exit code asks of the run as a whole. A
  Ctrl-C that lands after this stack was fully destroyed does not keep its
  events: there is no retry to post-mortem, and the run reports success, so
  suppressing the purge there would report a clean teardown while silently
  leaving the history behind.
- Best-effort: a purge failure logs a warning but never fails the
  already-successful destroy.
- `state destroy` does NOT take this flag; for an already-destroyed stack (or
  the CDK-app-free path) use the equivalent `cdkd events prune <stack> --all`.
- Per-stack: when destroying multiple stacks, each clean stack's history is
  purged independently.

