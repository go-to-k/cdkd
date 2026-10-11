---
title: cdkd destroy internals
description: "The mechanics behind cdkd destroy: final-snapshot routing, how --remove-protection restores a guard, every cause of a skipped delete, and how a damaged state record is refused."
unlisted: true
---

# cdkd destroy internals

This page holds the detail behind [cdkd destroy](cli-destroy.md)
and its sub-pages: the cases those pages summarize in one line each. It is
written for someone debugging an unusual destroy or changing cdkd itself.
Start from the public pages; every section here is linked from the place it
expands.

| Section here | Public page |
| --- | --- |
| [Final snapshots](#final-snapshots) | [cdkd destroy: data guards and final snapshots](cli-destroy-guards.md) |
| [`--remove-protection`](#remove-protection) | [cdkd destroy: deletion protection](cli-destroy-protection.md) |
| [Skipped resources](#skipped-resources) | [cdkd destroy: skipped resources](cli-destroy-skipped.md) |
| [Damaged state records](#damaged-state-records) | [cdkd destroy: interruption and damaged state](cli-destroy-edge-cases.md) |
| [Confirmation prompts on a non-interactive stdin](#confirmation-prompts-on-a-non-interactive-stdin) | [cdkd destroy: confirmation prompts](cli-destroy-prompts.md) |

## Final snapshots

### Per-type notes

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
| An RDS cluster or standalone RDS instance with no `DeletionPolicy` | CloudFormation's default, `Snapshot`, applies: refused on the Cloud Control route unless `--skip-final-snapshot` (see [Which policy cdkd reads](cli-destroy-guards.md#which-policy-cdkd-reads)). A Neptune cluster's absent default is `Delete`, so it goes through Neptune. |
| A Neptune cluster that sets `GlobalClusterIdentifier`, or an RDS cluster whose recorded `GlobalClusterIdentifier` is not a plain name | Through Cloud Control, whose handler removes it from the global cluster first; cdkd warns that a snapshot can be left behind. |
| A rollback's delete of a replacement's new copy under `UpdateReplacePolicy: Snapshot` | Through Cloud Control, whose handler takes the snapshot, with or without `--skip-final-snapshot`. |

### Which deletes the policy covers

`UpdateReplacePolicy: Snapshot` is honored on the deploy engine's replacement
and recreate deletes with the same per-type mechanism as
[the per-type table](cli-destroy-guards.md#how-the-final-snapshot-is-created-by-type). The
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

### Rolling back a CREATE that failed mid-flight

Every delete of a failed CREATE applies the same policy matrix: `Retain`
leaves the resource in AWS, `Snapshot` snapshots then deletes (refusing what it
cannot snapshot), `RetainExceptOnCreate` / `Delete` delete plainly, and absent
takes CloudFormation's default (see [Which policy cdkd reads](cli-destroy-guards.md#which-policy-cdkd-reads)).
`cdkd rollback --revert-failed` deletes one whose recorded physical id state
still records. A CREATE whose provider proved it made the resource before
failing has no state record and is deleted on the journaled policy by every
rollback, by `cdkd destroy` and, when no state record may own it, by a later
successful deploy (see
[Resources only the rollback journal records](cli-destroy-skipped.md#resources-only-the-rollback-journal-records)).
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

## `--remove-protection`

### The exact call per type

[The public table](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy)
names the call that turns protection off. The arguments and the follow-up
steps are:

| Resource type | Call and arguments |
| --- | --- |
| `AWS::Logs::LogGroup` | `PutLogGroupDeletionProtection(deletionProtectionEnabled=false)` |
| `AWS::RDS::DBInstance`, `AWS::Neptune::DBInstance` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::RDS::DBCluster`, `AWS::DocDB::DBCluster`, `AWS::Neptune::DBCluster` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` | `UpdateTable(DeletionProtectionEnabled=false)`, then a wait until `ACTIVE` |
| `AWS::EC2::Instance` | `ModifyInstanceAttribute(DisableApiTermination={Value:false})` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | `ModifyLoadBalancerAttributes` setting `deletion_protection.enabled` to `false` |
| `AWS::Cognito::UserPool` | `UpdateUserPool(DeletionProtection='INACTIVE')` |
| `AWS::AutoScaling::AutoScalingGroup` | `UpdateAutoScalingGroup(DeletionProtection='none')`, the per-instance `DisableApiTermination` flip, then `DeleteAutoScalingGroup(ForceDelete=true)` |
| `AWS::EMR::Cluster` | `SetTerminationProtection(TerminationProtected=false)`, then `TerminateJobFlows` |
| `AWS::DSQL::Cluster`, `AWS::SMSVOICE::ProtectConfiguration` | Cloud Control `UpdateResource` patch of `DeletionProtectionEnabled` to `false`, waited, then `DeleteResource` |
| `AWS::NeptuneGraph::Graph`, `AWS::EKS::Cluster`, `AWS::RDS::GlobalCluster`, `AWS::DocDB::GlobalCluster` | The same Cloud Control patch, of `DeletionProtection` to `false` |
| `AWS::VerifiedPermissions::PolicyStore` | The same Cloud Control patch, of `DeletionProtection` to `{Mode: DISABLED}` |

### Behaviour

- The flag is **all-or-nothing for the run**: a single `--remove-protection`
  covers every protection-bearing type in
  [the table](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy), and there is no per-type
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
  [Resources only the rollback journal records](cli-destroy-skipped.md#resources-only-the-rollback-journal-records)):
  a protected one is deleted with its protection turned off, and the prompt
  counts it when its journaled properties turn protection on. Only when cdkd
  can prove it is still the resource the failed deploy created — its type's id
  is never reused (an EC2 instance, a load balancer), or a live read returns the
  identity the journal recorded — and no other stack's state record holds it
  now (a later `cdkd import` may have adopted it). One it cannot prove (a
  DynamoDB global table whose name another table may have taken since), or one
  another stack holds or whose holders cannot be read, keeps its protection,
  with a warning. Without the flag, a protected one's delete is refused and the
  journal keeps it for a re-run; one that is unproven or another stack holds is
  not deleted at all. `cdkd rollback
  --remove-protection` does the same for the resources it deletes that a
  failed CREATE left behind (a journaled orphan, or under `--revert-failed` the
  failed CREATE itself), and for a resource whose CREATE the failed deploy
  completed: that one is this stack's own state record, matched to the id the
  journal recorded, so it is deleted with its protection off as `cdkd destroy
  --remove-protection` deletes any resource in state. On a nested stack it
  deletes, the flag cascades to that child stack's resources, and so it does to
  a resource the rollback reverts inside an existing nested stack, through that
  child's own journal: a CREATE the failed deploy completed in the child is
  that child's own state record, deleted with its protection off. A deploy's
  automatic rollback and the settle a successful deploy runs never turn
  protection off.
- **`cdkd deploy` has no counterpart.** A deploy that has to REPLACE a
  protected resource — a replacement is a delete plus a create — fails at the
  delete whatever replace flags were passed. Clear the protection flag first:
  [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it).

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

The compensation covers every type `--remove-protection` flips, plus the
instances an Auto Scaling group launched.

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

## Skipped resources

### Every cause of a skip

Most causes are a state record cdkd could not address, and issue no AWS call.
The custom-resource handler causes attempted the delete. The per-resource
`skipped (...)` line names which applies.

- **A state record with no physical id**: `skipped (state record has no
  physical id)`. The row names its type, but its `physicalId` is missing, not a
  string, empty, or only whitespace, so cdkd cannot address the resource and
  issues no AWS call. The record is kept; repair the
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
  | A Custom Resource whose recorded properties hold `***` where a `NoEcho` value stood, and cdkd could not re-resolve it, for example: `cdkd state destroy` (no template), an attribute a producer declared `NoEcho`, or a template whose text there changed. `cdkd destroy` with the app re-resolves a `NoEcho` parameter and sends the delete; every case it refuses is in [the details](state-management-secrets.md#custom-resources-that-read-a-noecho-parameter) | As above: its handler would receive the mask in `ResourceProperties`. Tear down what it manages by hand, then drop the record with `cdkd state orphan`. |
  | A Custom Resource whose recorded properties hold `***` at a position no `NoEcho` coordinate of the record names (a mask embedded through `Fn::Join`, or a record an earlier cdkd wrote) | As above. A `cdkd deploy` of the app (or a `cdkd scrub` of the stack) first records the `NoEcho` positions, after which `cdkd destroy` sends the delete. |
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
  these APIs an unknown name answers "not found", which would otherwise read as
  already deleted and drop the record over a live resource. Where a second source holds
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
  `cdkd state orphan '<stack>' --stack-region <region>`. A
  `cdkd deploy` that deletes such a custom resource (removed from the
  template, replaced, or rolled back) still does that, with a warning, as
  CloudFormation ignores delete failures in an update's cleanup phase.

- **A nested stack** (`AWS::CloudFormation::Stack`) whose own destroy skipped a
  resource or was interrupted. Here the child's *other* resources were deleted
  first, so "skipped" means the child stack as a whole was not destroyed — not
  that nothing happened. The record to repair lives in the child's state file
  (`<parent>~<childLogicalId>`), which the summary names. A child whose only
  skips are resources only its rollback journal recorded is not one of these:
  it deleted its own state, so the parent deletes the nested stack's entry and
  counts those resources as skips that keep no record
  ([Resources only the rollback journal records](cli-destroy-skipped.md#resources-only-the-rollback-journal-records)).

### The `N unverified` figure

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

### What the run-level message counts

The run-level exit message counts **entries**, not resources: a skipped
nested-stack row is one entry however many of the child's own resources it
covers. The per-stack summary lines above it give the exact breakdown.
Resources a failed deploy created that were left in AWS with no state record
(journaled orphans, including those a nested child left) are counted
separately, as resources, and the message says no state records them.

## Damaged state records

Each refusal below is `STATE_RESOURCES_MALFORMED`, exit `1`, raised before the
prompt and before the lock.

### A malformed `resources` map

The `resources` map is the list of what a destroy deletes, and a state record is
used as typed data without a field-by-field shape check — so a hand-edited or
truncated one can hold a string, a list, a number, a boolean or `null` there.

Counting such a map answers three different ways, and the first row is the
damaging one:

| Stored shape | What counting it would conclude |
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
[State Management](state-management-malformed-records.md#resources-is-not-an-object).

### An unreadable resource record

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
[cdkd destroy: skipped resources](cli-destroy-skipped.md#a-state-record-cdkd-cannot-address)). Full per-command
table in
[State Management](state-management-malformed-records.md#one-resources-entry-cannot-be-read).

### An unreadable `properties` map

Each readable row's `properties` map is handed to that resource's delete, and
what the delete does is read off it: whether an RDS DB instance takes a final
snapshot, whether an ECR repository is emptied first, how many resources the
`--remove-protection` prompt counts. The delete order is built from it too,
since the dependency graph reads each row's `Ref` / `Fn::GetAtt` edges out of
the map. A map that is missing, a string, a list, a number, a boolean or `null`
would otherwise reach the delete as it stands. Reading it as empty is not the safe answer:
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

### A malformed `outputs` map

`cdkd destroy` and `cdkd state destroy` refuse to delete a stack another stack
still imports from, and they decide whether to run that cross-stack check by
asking whether the record's `outputs` map holds anything.

A state record is used as typed data without a field-by-field shape check, so a
hand-edited or truncated one can hold a string, a list, a number, a boolean or
`null` there. Both answers are then wrong, and one of them is dangerous:

| Stored shape | What the check would conclude |
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
per-command table is in [State Management](state-management-malformed-records.md#outputs-is-not-an-object).

### A malformed `orphans` list

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
[the container](state-management-malformed-records.md#orphans-is-not-a-list), one for
[a single record](state-management-malformed-records.md#one-orphans-entry-cannot-be-read).

## Confirmation prompts on a non-interactive stdin

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
