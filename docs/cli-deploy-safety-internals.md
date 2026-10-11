---
title: cdkd deploy safety internals
description: "The exact rules behind cdkd deploy's guards: recreate propagation, name-collision proofs, the stateful list's derivation, the emptiness probes and assembly path checks."
unlisted: true
---

# cdkd deploy safety internals

The rules behind the guards that
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) and its sub-pages
summarise. Those pages say what a refusal means and which flag gets through
it. This page records the edge cases and the reasoning, for someone changing
the code or chasing an unusual result.

## When the auto-route needs a recreate

Adding a silent-drop property to an already-deployed `provisionedBy: 'sdk'`
resource does not by itself require `--recreate-via-cc-api`: the routing
decision is re-made every deploy, so the next one auto-routes that resource
through Cloud Control. Where the type's SDK-stored physical id is also a valid
Cloud Control identifier, the property reaches AWS as an update in place, with
the physical id preserved. Where it is not, that update fails rather than
silently doing nothing.

This is measured on a live resource by
[`tests/integration/sdk-to-cc-autoroute/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/sdk-to-cc-autoroute/),
which adds `EvaluationWindow` to a deployed `AWS::CloudWatch::Alarm` with no
flag and then asserts: the deploy renders the per-resource verb `updated` and
not `replaced`, the record moved to `'cc-api'`, the physical id is unchanged,
the property reads back from `DescribeAlarms`, and a tag attached out of band
before the redeploy survived. A later phase deliberately recreates the alarm
and checks that tag dies, so its survival above means something.

**An earlier opt-out deploy does not defeat this, with one exception.** cdkd
records only what the SDK provider actually sent, so after a
[`--prefer-sdk-route`](cli-deploy-safety-routing.md#prefer-sdk-route-deploy) deploy a removable drop is
simply absent from the record: the later flag-less deploy sees a genuine
addition, re-routes the resource, and Cloud Control sends the field. The same
`sdk-to-cc-autoroute` fixture measures that pair — its `--prefer-sdk-route`
phase asserts the record does NOT carry `EvaluationWindow`, and the flag-less
phase after it reads the property back off the live alarm.

**The exception is a create-only drop.** cdkd keeps such a property IN the
record, so a redeploy that still passes the flag sees no difference and does not
replace the resource. A deploy WITHOUT the flag does see one: AWS never held
the value, and an added create-only property is a replacement. cdkd refuses
that replacement rather than doing it on its own — see
[`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`](cli-deploy-safety-recreate.md#create-only-drop-needs-replacement).
The same `sdk-to-cc-autoroute` fixture measures it on an `AWS::EC2::Subnet`'s
`AvailabilityZoneId`.

The flag is for the cases the auto-routed update cannot deliver:

- **The property is create-only.** No update on either layer can set it, so the
  resource has to be created again with the property present. The CFn resource
  schema's `createOnlyProperties` is what to check. Whether you need the flag
  depends on what the record holds. If it does NOT already claim the value —
  the ordinary case, where you just added the property — the change reads as an
  addition, and unless one of cdkd's own rules says that property can change in
  place it becomes a
  [property-driven replacement](cli-deploy-safety.md#property-driven-replacement-and-stateful-replace-blocked),
  so cdkd recreates the resource for you with no flag. (Where cdkd has no rule
  of its own, that verdict is read from the type's CFn schema through
  `cloudformation:DescribeType`. Without that permission cdkd warns and reads
  the verdict from its bundled schema snapshot, for the types it ships one
  for. For any other type it classifies the change as in-place instead, so that
  property-driven replacement does not happen — and where nothing rejects the
  in-place update, the deploy can report success with the property
  unapplied.) A stateful type
  is refused until `--force-stateful-recreation`, **unless** it declares
  `UpdateReplacePolicy: Retain` — that is exempt from the consent flag, because
  the old resource is orphaned rather than deleted. Where the record DOES claim
  the value — the `--prefer-sdk-route` sequence above — the deploy refuses
  instead, and `--recreate-via-cc-api` (or `--replace`) is how to opt in.
- **The SDK-created resource's physical id is not a valid Cloud Control
  identifier.** Cloud Control addresses a resource by the `Identifier` its
  schema's `primaryIdentifier` defines, while an SDK provider stores whatever
  its create returned; the two agree per type or they do not, and cdkd treats
  that as an empirical per-type fact rather than a guarantee (see the
  `STICKY_CC_MIGRATION_EXEMPT` admission bar in
  `src/provisioning/provider-registry.ts`). Where they disagree, the auto-routed
  update fails and the recreate is the way through.

Both bullets are reasoned from the routing model, not measured — unlike the
`sdk-to-cc-autoroute` paragraph that opens this section. They do not fail the
same way, so they are not reached for the same way. The second one fails
loudly: the auto-routed update errors, and the flag is a remedy you reach for
after a failure rather than a precaution you take before one. The first one
fails loudly too: when the record does not already claim the property the
replacement is planned (and refused for a stateful type without
`UpdateReplacePolicy: Retain`), and when it does the deploy refuses with
`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`, naming the flag.

## Resources that follow a recreated resource

### Readers of the target

A recreated resource whose physical id AWS assigns (an
`AWS::EC2::SecurityGroup`, an `AWS::ApiGateway::RestApi`) comes back under a
new id, and the resources in the same stack that read it through `Ref` or
`Fn::GetAtt` follow it in the same deploy, as they do for a replacement a
property change causes:

- A reader whose referencing property can be updated in place is updated to
  the new id.
- A reader whose referencing property is create-only (an `AWS::EC2::Volume`'s
  `KmsKeyId`, say) is **replaced**, and so are the create-only readers of that
  reader in turn. The confirmation prompt lists them under "Replaced if the id
  changes", with **DATA LOSS** on a stateful one.
- A stateful reader that would be replaced needs `--force-stateful-recreation`
  exactly as a stateful target does, and the same flag covers both. Without
  it, the deploy (and `--dry-run`) is refused after the diff and before any
  resource is touched (`STATEFUL_REPLACE_BLOCKED`), naming the reader. A
  reader with `UpdateReplacePolicy: Retain` keeps its old resource and is not
  refused, and neither is one a false `Condition` removes from the deploy or
  one that reads the target only on an untaken `Fn::If` arm. The prompt's list
  is read before conditions are evaluated, so it can name such a reader.
- A target whose physical id is its name, fixed as a literal in the template
  and equal to the recorded one (a function with an explicit
  `FunctionName`), keeps that id across the recreate. A reader that
  references it only by `Ref` (or `${Target}` in an `Fn::Sub`) is neither
  listed nor refused, and the deploy leaves it as it is. A reader of one of
  its attributes (`Fn::GetAtt`, `${Target.Attr}`) still is: a fixed-name
  recreate keeps the id but can change an attribute, such as a DynamoDB
  table's `StreamArn` or a database's endpoint. Any other target (an
  AWS-assigned id, a generated or computed name, a type whose name cdkd
  rewrites) is treated as one whose id moves.
- The list and that early refusal cover a direct chain of create-only
  references only. A stateful resource reached through an in-place hop (it
  reads a custom resource's `Data`, and the custom resource reads the
  target), through a nested stack's `Parameters` into a resource of the child
  stack, or replaced by the Cloud Control `UnsupportedActionException`
  update fallback, is neither listed nor refused early: the replacement guard
  refuses it mid-deploy, after the target was recreated, and
  `--force-stateful-recreation` covers it there too.

The plan, `--dry-run` included, counts every reader as an update, since whether
the id moves is known for certain only once the target is recreated. Where the
recreate keeps the id after all, a create-only reader that the plan (and, for a
target not known to keep it, the prompt) shows as a possible replacement is
left in place, and a reader with nothing to change is skipped. Readers in other
stacks are covered by
[Other stacks that read the target](cli-deploy-safety-recreate.md#other-stacks-that-read-the-target).

### Children deleted with the target

Some resources live inside another one and are deleted with it: a Lambda
function's permissions, versions, aliases and event invoke config, an SNS
topic's subscriptions and policies, an SQS queue's or S3 bucket's policy, a log
group's streams and metric and subscription filters, an IAM role's, user's or
group's inline policies.

When a deploy destroys such a parent and re-creates it under the same physical
id (a fixed-name function recreated by `--recreate-via-cc-api`, or the
delete-first `--replace` of a replacement), each of those children in the same
stack is re-created too, without a delete: the old one went with the old
parent.

- A child the same deploy moves from another parent onto the recreated one is
  replaced as usual, which removes its copy from the parent it left.
- A policy that names several parents (a topic or queue policy, an IAM policy
  on several roles, users or groups) is written again in place instead.
- What is merely attached to a re-created IAM role, user or group (a managed
  policy, an instance profile's role, a group's members through a user's
  `Groups` or a `UserToGroupAddition`) survives it, but IAM refuses to delete a
  principal that still has one. cdkd detaches it first, then updates the
  attached resource in place, which attaches it to the re-created principal
  again (also when the same deploy edits the list).
- A Lambda function URL is not handled this way.

The same holds when the parent is re-created by the update-failure fallback (an
in-place update the provider refuses, re-created under `--replace`, or
automatically when Cloud Control reports `UnsupportedAction`): its children are
re-created as soon as it is, before any pending resource that reads them.

If the deploy fails after re-creating the parent and before restoring such a
child:

- cdkd drops the child's state record, since AWS no longer has it, and the next
  deploy creates it again. Until then the parent runs without it.
- A policy that also names parents the deploy did not re-create keeps its
  record, minus the re-created ones, so the next deploy writes it to them
  again.
- A child whose own restore was attempted and then failed may be in AWS after
  all. It keeps its record when a `--recreate-via-*` flag can write it again,
  and the warning names that flag. Otherwise its record is dropped as above,
  and the warning says the write may still be on the parent, to be removed by
  hand if the child leaves the template before the next deploy.
- An attached resource's record is never dropped. It is kept minus the
  re-created principals (a `UserToGroupAddition` on a re-created group keeps no
  members), so the next deploy attaches it to them again.

## The recreate prompt's three display states

The plan the `--recreate-via-*` prompt prints shows a target's data in one of
three ways.

- Stateful targets — those that reached pre-flight only because
  `--force-stateful-recreation` was passed — get a `**DATA LOSS**` prefix on
  their plan row plus an explicit `DATA: all data in <logical id> will be lost
  (no automatic data migration)` line. That is the third stop-and-think moment
  on top of the two-flag opt-in.
- The two **conditionally** stateful types get that prefix too, even though
  `--force-stateful-recreation` skips the emptiness probes entirely: with no
  probe result to go on, every S3 bucket and every log group in the plan is
  shown as data-bearing. The plan errs toward warning, because an emptiness
  nothing measured is not an emptiness.
- A bucket whose emptiness probe **ran and failed** is shown as a third case,
  neither of the two above — a role without `s3:ListBucketVersions`, a rate
  limit that outlived the retries, a region mismatch, or anything else that
  stops the call from answering. It still proceeds, because the S3 probe fails
  open by design, but its row says so:

  ```text
    - MyBucket (AWS::S3::Bucket) [SDK → CC] — emptiness NOT established: the live probe failed, so cdkd does not know whether this resource holds data
      UNKNOWN: if MyBucket holds data, the destroy + recreate loses it (no automatic data migration)
  ```

  No `**DATA LOSS**` prefix, because cdkd observed no contents and will not
  assert any; no silence either, which would have made it indistinguishable
  from a bucket the probe measured and found empty. A bucket AWS reports as
  **not existing** is not this case — that is an answer, so it passes through
  silently like a measured-empty one. A log group cannot reach this case at
  all: its probe promotes on both failure paths.

## Name collisions

### Creates that adopt a taken name

Some create APIs do not collide at all: SQS `CreateQueue`, SNS `CreateTopic`,
Step Functions `CreateStateMachine` and ECS `CreateCluster` return the resource
already holding the name, as do ELBv2 `CreateLoadBalancer` and
`CreateTargetGroup` when the settings match, EventBridge `PutRule` and
CloudWatch `PutMetricAlarm` overwrite it, and
cdkd's CloudWatch Logs provider reads `ResourceAlreadyExistsException` as
success, as its S3 provider reads `BucketAlreadyOwnedByYou` for a generated
bucket name (an explicit `BucketName` a bucket already holds is refused, except the bucket an earlier attempt of the same create made and could not delete, which its retry takes back while that bucket's name, region and creation date are unchanged). For those types
on cdkd's SDK providers, a replacement that changes the name — or moves an
EventBridge rule to another bus, or changes `Type` onto one of these types, or,
for an ELBv2 load balancer or target group, sends another name only because
`--prefix-user-supplied-names` differs from the deploy that created it —
first looks the new name up. When another resource holds it, the deploy fails
with `NAMED_REPLACEMENT_COLLISION` and nothing is created or deleted — the
create would otherwise take that resource over and record it as the stack's,
for a later `cdkd destroy` to delete. A lookup that cannot run fails the same
way.

A plain create of one of these types with an explicit name looks the name up
too. When a resource already holds it, or the lookup cannot run, the deploy
fails with `NAMED_CREATE_COLLISION` and nothing is created, as
CloudFormation's create fails with "already exists". This holds even when the resource is this stack's
own, left by an earlier interrupted deploy or kept by a `cdkd destroy` under
`DeletionPolicy: Retain`: nothing in AWS tells the two apart. Delete it, or
adopt it with [`cdkd import`](import.md), then re-run; the error ends on the
`cdkd import <stack> --resource <logicalId>=<physicalId>` command for the
resource it found — confirm the resource is yours before running it. An S3
bucket gets no command, since the lookup also finds a bucket another account
owns and lets you list. When the
holder is this stack's own resource under another logical id (a construct moved
or renamed, keeping its name), the error names that id: give the new resource
another name, or deploy that id's removal first. A log group declared
explicitly that something else already created — for example a Lambda
function's `/aws/lambda/<name>` group, created on its first invocation — is
refused the same way. A create under a name cdkd generates is not looked up.
An ELBv2 load balancer or target group is looked up under the name the create
sends, which carries the stack-name prefix under `--prefix-user-supplied-names`.

### How `--replace` proves the old resource holds the name

A collision says a name is taken, not who holds it. An orphan left by an earlier
failed attempt, a retried create, or a resource made outside the stack collides
exactly like the old resource does. So before `--replace` deletes anything, cdkd
checks that the old resource holds the name the create actually sent:

| The create sent | Shown to be the old resource's when |
| --- | --- |
| An explicit name from the template | State records that name for the old resource, or its physical id names it |
| No name (cdkd generates one) | The old resource's physical id names the name cdkd generates for this deploy — for types whose generated name cdkd can predict |
| A name the provider rewrites (IAM, ELBv2 prefix the stack name) | The old resource's physical id names the rewritten name this deploy sends |
| A type cdkd has no name property for (Cloud Control only) | Both were created through Cloud Control, the create sent the old physical id itself as a `...Name` / `...Identifier` property, and every such property it sent matches the old resource's |

A name placed inside a parent (an API's stage, a cluster's service) must also
be in the same parent, and the old resource's state record and its last
read-back must not name it differently (a resource renamed outside cdkd). When the check fails or cannot decide, the deploy fails
with `NAMED_REPLACEMENT_COLLISION` and **nothing is deleted** — with or without
`--replace`, and without advising `--replace`, which would refuse the same way.
Remove or rename whatever holds the name if it is yours — if that is the
resource being replaced, delete it by hand — then re-run the deploy.

`UpdateReplacePolicy: Retain` hard-fails in both shapes **regardless of
`--replace`**: with Retain the old resource keeps the name, so a same-name
replacement can never proceed. The same two shapes, and the same two error
codes, are reachable from the update-failure fallback — under `Retain` that
path also creates first, so it inherits the same constraint.

### Equal physical ids across a type change

Two physical ids that happen to be equal across the two types — an SSM parameter
and a log group can share a bare name — are treated as two resources. The
exception is a change between two custom resource types (`Custom::*`,
`AWS::CloudFormation::CustomResource`), whose handler picks the id: there an
equal id is the existing resource, and the replacement is refused with
`NAMED_REPLACEMENT_IDEMPOTENT_CREATE` rather than deleting what it just created
(`--replace` deletes the old resource first instead, as for any name-idempotent
create).
Within one type an equal id is the same resource, with one exception: two
`AWS::Glue::Table` records in DIFFERENT databases can share an id when either
name contains `|` (table `db|orders` in database `my`, table `orders` in
database `my|db`). When both records' `DatabaseName` prefix the shared id and
differ, cdkd treats them as two tables, so such a replacement keeps the new
table and deletes the old one through its own record, and a rollback reverses
it.
When the new resource's create collides on a name instead, the error says that
the holder may be an unrelated resource of the new type, which `--replace`
cannot free. Under `--replace`, cdkd deletes the old resource first only
between two types that share one name space (RDS, DocumentDB and Neptune
clusters, instances and subnet groups; DynamoDB tables and global tables);
any other pair fails with nothing deleted.

`cdkd rollback` and the automatic rollback reverse such a replacement the same
way: the old resource is re-created through its own type's provider and the new
one deleted through its own. A rollback journal written by an older cdkd names
only the new type on the operation, so the old type is read from the previous
resource record the journal also carries. When a journal names no old type at
all, or names two different ones, that one operation is refused with
`ROLLBACK_REPLACEMENT_UNROUTABLE` and the journal is kept; fix forward with
`cdkd deploy`, or pass `--orphan <LogicalId>` to leave the resource as it is and
let the rest of the rollback proceed.

## Deletion protection: what each refusal reads

Deletion protection blocks a replacement and `cdkd deploy` cannot clear it.
Two kinds of refusal say so explicitly:

- **The stateful-resource guard's refusals** on `--recreate-via-*`, `--replace`,
  the Cloud Control auto-fallback and a property-driven replacement add a note
  for any stateful type in
  [`--remove-protection`'s table](cli-destroy.md)
  whose protection flag is on. The note names the flag, both outcomes (a failed
  delete-first deploy, an untracked old resource after a create-first one) and
  the public section, and leaves turning the flag off to the console or the
  service's own API. A target under `UpdateReplacePolicy: Retain` gets no note.
- **Some types' own refusals** read their own protection property and name the
  command that turns it off: `AWS::Logs::LogGroup`,
  `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::EMR::Cluster`,
  `AWS::Cognito::UserPool`, `AWS::DynamoDB::GlobalTable` and
  `AWS::AutoScaling::AutoScalingGroup`. They point at the console instead when
  the resource's id cannot be printed safely on a command line: it would be
  changed by sanitizing, it holds whitespace or a character a shell acts on
  (a quote, a backtick), or something the AWS CLI itself acts on (a leading
  `file://` or `-`).

The guard's note does not ask AWS: it reads the properties cdkd recorded and
the AWS read-back it stored after its last write. Protection you enabled out of
band after that read is in neither, so such a resource gets the guard's shorter
message. The six types' own refusals do not read the stored read-back at all:
they read the properties cdkd recorded (`AWS::Cognito::UserPool` reads the
template's value first), so protection that only the read-back shows gets their
shorter message. AWS refuses the delete either way, for every type in
`--remove-protection`'s table whenever a deploy has to replace one, whether or
not its refusal says so.

`AWS::AutoScaling::AutoScalingGroup` is the one whose refusal is narrower than
the type's protection setting, and deliberately: the group's three levels are
`none`, `prevent-force-deletion` and `prevent-all-deletion`, and only the last
blocks a replacement, because the deploy path's delete does not pass
`ForceDelete`. At `prevent-force-deletion` there is nothing to disable.

`AWS::Cognito::UserPool` is the one exception to the two-deploys rule.
Its refusal fires AFTER `UpdateUserPool` has already applied the template's
`DeletionProtection`, so clearing it in the template DOES take effect in that
same (failed) deploy — the next run with the replace flags then succeeds. Its
refusal reads the desired value first for exactly that reason. Do not
generalize it: every other type above refuses before applying anything.

## How the stateful list is kept complete

The list has mechanical lower bounds cdkd enforces in unit tests, so it is
checked rather than only hand-curated.

- **Every type cdkd takes a final snapshot of before a destroy is on it.** cdkd
  snapshots the types CloudFormation lets you tag `DeletionPolicy: Snapshot`,
  and CloudFormation permits that attribute exactly where deleting the resource
  destroys data worth capturing first — so a type cdkd snapshots on destroy
  must not be replaceable mid-deploy without consent. `AWS::Redshift::Cluster`,
  `AWS::ElastiCache::CacheCluster` and `AWS::ElastiCache::ReplicationGroup`
  joined the guard for that reason.
- **Every type whose delete consumes the `--force-stateful-recreation` consent
  is on it.** A resource whose deletion needs that flag to clear its own data
  guard is by definition data-bearing. `AWS::S3Express::DirectoryBucket` joined
  for that reason.
- **Every type a tier-2 sweep proposes is either on it or written off with a
  reason.** The two bounds above are derived from cdkd's own SDK providers, so
  neither can see the 1371 CloudFormation types that have no provider and route
  a replacement through Cloud Control API — the larger population by two orders
  of magnitude, and the one the guard was reaching with no flag at all. cdkd now
  reads every one of their registry schemas and proposes the types that declare
  an immutable property (so a rename replaces the resource on a plain
  `cdkd deploy`) and look like they store something. Each proposal must end up
  on this list or be written off in the sweep's own file with the reason; a
  proposal in neither fails the build. Most of the always-stateful table joined
  this way.

Unlike the first two, that third bound is a **heuristic**: no AWS-published
artifact says "deleting this destroys user data", so what it buys is that the
next widening is checkable, not that the current list is complete. Where it
proposes a type whose answer is not knowable from the outside, the type is
guarded — an unprovable emptiness must not read as empty. The write-offs are
the cases where the schema settles it: `AWS::RDS::GlobalCluster`,
`AWS::Neptune::GlobalCluster` and `AWS::DocDB::GlobalCluster` group regional
clusters that outlive them; `AWS::RedshiftServerless::Workgroup` is compute
against a namespace that is guarded; `AWS::Amplify::Domain`,
`AWS::Cognito::UserPoolDomain` and `AWS::Lightsail::Domain` are DNS rather than
stores; `AWS::EC2::TransitGatewayRouteTable` and its siblings hold nothing but
tags, their routes being separate template resources. The full list of
write-offs, each with its reason, is in
`scripts/audit-stateful-candidates.ts`, and the proposals themselves — with the
immutable properties that make each one reachable — in
[`docs/_generated/stateful-candidates.md`](_generated/stateful-candidates.md).

The rest are hand-curated, because no lower bound can see a delete that
destroys data with **no opt-in at all**: `AWS::S3Tables::TableBucket` and
`AWS::S3Vectors::VectorBucket` empty themselves first, `AWS::S3Tables::Table`
holds the rows themselves rather than a catalog entry, `AWS::KMS::Key`
schedules the key material for deletion (`AWS::KMS::ReplicaKey` is guarded on
the same footing, but routes through Cloud Control and is unmeasured here), and
`AWS::CodeCommit::Repository` drops the git history. `AWS::KMS::Alias` is
deliberately not guarded — deleting an alias removes a pointer, not key
material.

`AWS::EC2::Instance` and `AWS::SQS::Queue` are deliberately not guarded either.
An instance's root volume is ephemeral by design — keep persistent data on an
`AWS::EC2::Volume`, which is guarded — and a queue's backlog is transient.
Asking for `--force-stateful-recreation` on every AMI refresh or queue rename
would cost a dev/test workflow more than it protects, and CloudFormation
replaces both without asking as well.

`AWS::S3Tables::Namespace` is deliberately **not** guarded: AWS refuses to delete a namespace that still holds a
table, answering `BadRequestException: The namespace that you tried to delete
is not empty.`, and the Cloud Control delete fails the same way. cdkd's own
delete for a namespace issues a bare `DeleteNamespace` and enumerates no
tables, so a namespace rename (a replacement a plain `cdkd deploy` reaches with
no flag) cannot take a table with it. The replacement creates the new
namespace first; if the old one still holds tables, its delete is refused and
cdkd warns `Failed to delete old resource` and carries on. The old namespace
and its tables stay in AWS, no longer tracked in state, for you to move or
delete by hand. A delete-first replacement (`--recreate-via-*`, or `--replace`
when the create collides) fails at that delete instead — unless the template
also renames the resource, which makes `--recreate-via-*` create first and warn
the same way.

### Why each category is on the list

The public table lists the types by category without comment. These are the
reasons, for the categories where the data is not obvious:

- **Data warehouse.** An `AWS::RedshiftServerless::Namespace` owns the
  databases, and a snapshot is a copy of them.
- **Table / vector storage.** Deleting a table bucket or a vector bucket
  empties it first, with no opt-in. A namespace is not guarded, as described
  above.
- **Managed compute with local storage.** Terminating an `AWS::EMR::Cluster`
  destroys the HDFS volumes on its core nodes, and the replacement comes back
  empty. `AWS::EKS::Cluster` is guarded for the same reason one level up: the
  etcd store behind it holds every Kubernetes object the user created, and
  nothing in the template describes it. `AWS::SageMaker::Cluster` carries
  local and tiered storage holding training checkpoints.
- **Streaming / messaging.** Each type retains records on its own storage
  rather than passing them straight through.
- **Search / index / collection.** The indexed documents, face vectors and
  geofences are written through the service API, never from the template.
- **Identity / config.** An `AWS::AppConfig::ConfigurationProfile` whose
  location is `hosted` owns its configuration versions.
- **Runtime-written stores.** `AWS::CloudFront::KeyValueStore` and
  `AWS::Connect::DataTable` are seeded from the template at most once, then
  written through the service API.
- **Backup vaults.** A vault holds the recovery points, the data whose whole
  purpose is to outlive the resource it was taken from.
- **Service domains holding records.** These hold cases, profiles, a catalog
  and every user's home directory.
- **Encryption keys.** Deleting an `AWS::CloudHSM::Cluster` destroys the key
  material inside it, and every ciphertext produced under those keys with it.
  An `AWS::KMS::Key` delete schedules the key for deletion, and once the
  window elapses every ciphertext encrypted under it is unrecoverable,
  including data in other stacks that merely reference the key.
  `AWS::KMS::ReplicaKey` is guarded on the same terms, though whether a
  destroyed replica's ciphertexts survive through another key in its
  multi-region set is unmeasured, so the guard assumes they do not.
- **Source control / artifacts.** An `AWS::CodeCommit::Repository` delete
  destroys the repository's entire git history. `AWS::CodeArtifact::Repository`
  holds the packages, and `AWS::CodeArtifact::Domain` is not a mere grouping:
  it owns the deduplicated asset storage every repository in it references.
- **Retained records.** `AWS::IoTSiteWise::Workspace` is guarded on an open
  question: AWS makes encryption at rest required on it, but whether deleting
  one cascades to the datasets inside is unmeasured.
  `AWS::AIOps::InvestigationGroup` and `AWS::SES::MailManagerArchive` both
  retain content for a configured period. `AWS::Rbin::Rule` joins them on the
  fail-safe side of an open question: the rule itself is fully
  template-declared, but what happens to the snapshots and AMIs already
  sitting in the Recycle Bin under it when it is deleted is unmeasured.
- **Nested stacks.** Replacing an `AWS::CloudFormation::Stack` destroys the
  whole child stack, every resource it owns, with no per-resource guard. Its
  `StackName` is immutable, so a `StackName` edit deployed with
  `--prefer-sdk-route AWS::CloudFormation::Stack:StackName` is a replacement.
- **Edge / identifier immutability.** For an `AWS::CloudFront::Distribution`
  the URL changes, which breaks consumers, and propagation takes roughly 20
  minutes. `AWS::SMSVOICE::PhoneNumber` and `AWS::SMSVOICE::SenderId` are the
  same class: a release returns the identifier to the pool, the replacement
  gets a different one, and the original may be unobtainable.

## Log group retention

**Retention is not an emptiness signal.** An unset or zero `RetentionInDays`
is CloudWatch Logs' **never expire** setting — the most data-bearing
configuration the type has, and the one cdkd records as `0`. An unset retention
therefore defers: at pre-flight the emptiness probe below decides, and
mid-deploy, where no probe can run, the log group counts as stateful.

**Which retention cdkd reads.** A state record carries two property bags —
`properties`, what the last deploy applied, and `observedProperties`, what it
read back from AWS — and a positive `RetentionInDays` in EITHER settles the
guard. Neither bag takes precedence; either one proving a retention is
enough. That is what lets a retention set OUT OF BAND (the console,
`aws logs put-retention-policy`) count, and a record imported by
`cdkd import --migrate-from-cloudformation` whose template never declared the
property. The value is COERCED rather than type-tested, so the stringly-typed
`RetentionInDays: '30'` a hand-written L1 or an `Fn::Sub` result produces
counts as 30 rather than as no retention. A zero recorded in one bag never
cancels a positive recorded in the other: zero is never-expire, which is not a
statement that the group is empty.

The guard's coercion is JavaScript's `Number()`, filtered to finite values.
That is wider than CloudFormation's own Integer parsing — `Number()` also
accepts `'0x1e'`, `'0o36'`, `'1e3'` and `'30.5'` — and in the GUARD the
difference is safe in the only direction that matters: a wider accepted set
can only produce MORE `has-retention` verdicts, i.e. more refusals.

The **provider** is the half that forwards the number to
`logs:PutRetentionPolicy`, and it reads the property
the way CloudFormation does, measured rather than assumed (live A/B on
`AWS::Logs::LogGroup`, us-east-1, 2026-09-14): an optional sign and decimal
digits, with surrounding whitespace trimmed — `30`, `'30'`, `'+30'` and
`' 30 '` all deploy as 30 — while `'0x1e'`, `'1e3'`, `'30.5'` and `'30.0'`
are REFUSED before any AWS call, as CloudFormation refuses them. The falsy
family was measured in the same pass: an absent property, an
empty string and a whitespace-only string are CloudFormation's spellings of
"no retention" and remove the live policy on an update, while `0`, `'0'`,
`false` and `null` are rejected by CloudFormation and are refused by cdkd
rather than silently removing a retention you set on purpose. The one
cdkd-side exception is `cdkd drift --revert`, where a numeric `0` is cdkd's
own readback spelling of a never-expiring log group and reverts a
console-added retention as expected.

## The emptiness probes

**At pre-flight** (`--recreate-via-cc-api` / `--recreate-via-sdk-provider`)
cdkd issues a single-page `s3:ListObjectVersions(MaxKeys=1)` against each
targeted bucket's recorded physical id, in the stack's deploy region. Empty
buckets pass through; non-empty ones are refused. cdkd uses
`ListObjectVersions` rather than `ListObjectsV2` so the probe's view of "empty"
matches what the destroy-and-recreate cycle would actually wipe — a versioned
bucket whose current keys are all soft-deleted still holds prior versions and
delete-markers.

A page carrying a continuation marker with no entry in either list does not
settle the question — the listing is unfinished, so that page's emptiness is
not the bucket's — and such a bucket is refused rather than passed. A page
that simply OMITS the version and delete-marker lists is different, and does
count as empty: S3 omits an empty collection rather than sending an empty
list, so omission is how an empty bucket answers.

Both emptiness probes retry a throttling response — a throttling error code,
or HTTP 429 / 503 — up to three times with exponential backoff, at most
3.5 seconds per target. Every other failure goes straight to the per-type
behaviour described below, because it is either an answer or something an
identical retry will not change. When the retries are exhausted the probe
lands in that same per-type behaviour.

If the probe itself fails — permission denied, bucket not found mid-flight, a
transient network error — cdkd logs a warning and leaves the target
**un-promoted**, which means the guard does not fire and the recreate proceeds
without `--force-stateful-recreation`. The probe fails open, so treat that
warning as a prompt to decide for yourself: pass
`--force-stateful-recreation` if the bucket might hold data.

For a log group, the same pre-flight issues a single-page
`logs:DescribeLogStreams(limit=1)` against the recorded log group name. A log
group with no log stream can hold no log event — every event belongs to a
stream — so zero streams is the one signal that proves the group empty, and
cdkd uses it rather than a byte count: `LogStream.storedBytes` has been
reported as zero by the API since June 2019, and stream presence needs no size
semantics at all. A group holding only empty streams therefore counts as
non-empty, which is the safe direction.

Only one answer clears the guard: a log group whose response carries a
**present, empty** stream list and **no continuation token**. A response with
no stream list at all, or an empty page that still carries a `nextToken`, has
not settled the question, so cdkd warns and treats the group as stateful — the
same direction a failed probe takes.

**Unlike the bucket probe, the log-group probe fails CLOSED**: if
`DescribeLogStreams` errors, cdkd warns and treats the log group as stateful,
so you get a refusal naming `--force-stateful-recreation` rather than a silent
recreate. The asymmetry is deliberate — the whole point of the log-group
condition is that an emptiness cdkd cannot prove must not read as empty.

One error is the exception, because it is an answer rather than a failure to
get one: a `ResourceNotFoundException` means AWS says the log group does not
exist, so it provably holds no events and the guard is cleared. cdkd trusts
that only after confirming the CloudWatch Logs client is pointing at the region
cdkd's state records for the resource — a not-found from the wrong region says
nothing about the log group. When that check cannot be satisfied, the group is
treated as not provably empty like any other unsettled answer.

## `--pin-cc-api`: why an unknown id is an error

**A logical id present in no stack of the run is an error, not a no-op.** The
flag produces no output when it works, so a typo would otherwise give you
exactly the routing change you passed it to decline, indistinguishable from
success. The check is run-level rather than per-stack on purpose: under
`--all`, an id that belongs to one stack is legitimately absent from the
others, and failing per-stack would abort the run over a correct invocation.
It is raised before any stack deploys.

## `Fn::GetAtt` attributes read live

**An attribute cdkd reads live never falls back to the physical ID.** A
few attributes are read from AWS at resolution time when the state record
does not hold them: an EC2 instance's `PrivateIp` / `PublicIp` /
`PrivateDnsName` / `PublicDnsName` / `AvailabilityZone`, a VPC's
`DefaultSecurityGroup`, a CloudFront distribution's `DomainName`, a
security group's `VpcId` (recorded at create from `DescribeSecurityGroups`,
so a group declared without `VpcId` resolves to the default VPC's id as
CloudFormation answers, and re-read when the record lacks it — or holds
`''`, which an older cdkd wrote for such a group; that record keeps `''`
until the group's next update, only the resolution changes — so on such a
record `cdkd diff` issues one `DescribeSecurityGroups` and shows a one-time
`'' → vpc-…` Output delta, which `--fail` exits 1 on once and the next
deploy's Outputs persist heals; if the read is refused, the Output lands in
the failed keys and the Outputs section is suppressed with a warning). When
the read finds the value not yet assigned (an instance still `pending`
under `--no-wait`) or the read fails, cdkd refuses to resolve the reference
rather than substituting the instance / VPC / distribution / group ID,
which can never be the right value there; the message names the resource, the
attribute, what was observed (the instance state, or the error class —
`--verbose` shows the AWS text) and the remedy. Nothing is cached, so the
next deploy re-reads. An RDS `DBProxy` / `DBProxyEndpoint` `VpcId` the
record lacks is refused the same way without a live read. The
`--no-wait` section of [`cdkd deploy`](cli-deploy.md)
says what the refusal does in a resource property versus an Output.

## Cloud assembly checks

### The nested-template walk

The check runs for every stack in the deploy set, including stacks pulled in as
dependencies, and before anything else happens to any of them: no macro is
expanded, no asset is published, no lock is taken, no state record is written
and no resource of the parent stack is created. One malformed stack stops the
whole run, `--dry-run` included, with exit code 1. A stack outside the deploy
set is not checked.

The whole tree is checked up front, however deep the cycle sits. Each nested
level is a real deployment, which is why the check does not wait until the walk
reaches the repeat.

The nested-stack provider repeats the same walk on the subtree under its own
row before it deploys the first nested level. With the check above in place that
second walk finds nothing; it is what still refuses the tree if a nested deploy
is ever started some other way, and its message begins with
`NestedStackProvider:` and ends with `Refusing to deploy any level of it.`

### Asset paths

**The two asset rows of the path table (a file asset's `source.path`, a Docker
asset's `source.directory`) are measured against the app's output directory,
not the manifest's own.** A `Stage`'s assets are staged into the app's `cdk.out` while
the Stage's asset manifest sits in `cdk.out/assembly-<Stage>/`, so CDK writes
`source.path: "../asset.<hash>"` there by design — and a nested Stage reaches
up further still. Those paths load normally. What is refused is a **relative**
path leaving the output directory, from a Stage manifest and a top-level one
alike.

**An ABSOLUTE `source.path` or `source.directory` is accepted, and nothing
refuses it.** `cdk synth --no-staging` emits exactly that shape — under
`aws:cdk:disable-asset-staging` CDK writes each asset's absolute SOURCE
directory instead of a staged copy — and the CDK CLI publishes such a path
without any containment check of its own, so refusing would reject the output
of a documented flag and be stricter than the tool cdkd complements.

**For an absolute path the warning is the entire protection.** cdkd prints one
when the path falls outside the output directory, naming the directory and
naming where the bytes go — the destination bucket and key, or the image build.
There is no second gate behind it. A Cloud Assembly you did not synthesize can
name any directory your user account can read, and cdkd will package it and
upload it to a bucket that same manifest names, using your credentials.

A value naming the output directory itself is warned about "by any spelling",
and that is meant literally: a symbolic link to the output directory,
or the path a `realpath` would print for it, is that directory, and cdkd says
so for all of them.

The relative refusal catches an accidental or legacy `..` and costs nothing,
which is why it stays. It is not a boundary against a value someone chose: the
absolute spelling of the same path is accepted with a warning.

The `cdkd local *` commands apply the same rule to SOME of the assembly they
read — including a path the deploy side has no equivalent of, a Lambda's
`Handler` for an inline `Code.ZipFile`, which cdkd materializes as a file
before running it. **`cdkd local invoke`, `cdkd local start-api`,
`cdkd local start-alb` and `cdkd local start-cloudfront`** — every command that
bind-mounts Lambda code — refuse a **relative** escaping `aws:asset:path`
before mounting it into the container, and accept an **absolute** one with the
same warning, for the same reason. Other assembly-supplied paths are not
covered yet; [Local Execution](local-emulation.md) states the trade and lists
which are which.

### Why a pre-synthesized assembly is not refused

Each distinct command is announced once per run, not once per build: a
long-running `cdkd local start-service` rebuilds per replica and again after a
crash-loop restart, and repeating a paragraph that size would bury it. Repeats
go to `--verbose`.

The destination check is a **name-shape** check, not a proof of ownership: a
bucket named like a CDK bootstrap bucket for your account can still live in
someone else's. It narrows what a careless manifest gets away with, nothing
more.

Pointing `-a` at an assembly you did not produce is the same decision as running
someone else's build output. cdkd cannot make that decision for you: anyone who
can rewrite a manifest can equally rewrite the Dockerfile, the Lambda asset and
the template, so a refusal here would stop nothing while breaking the
split-synth/deploy pipelines that are the normal shape. Synthesize it yourself,
or read it first.

The nested-stack walk separately refuses an **absolute** `aws:asset:path`, which
is a "not CDK-generated" tripwire rather than an escape. It is a different
question from the asset rows above and keeps a different answer: there the value
is a nested-stack TEMPLATE that CDK always writes into the output directory, so
`--no-staging` does not relocate it and an absolute one means the assembly was
not CDK-generated. Its message says `which is absolute` where the containment
one says `which resolves to ...`, so the two are told apart at a glance. Also refused is a tree nested more than 512 levels
deep, which could not deploy anyway: each level lengthens the child's state key,
and S3 caps a key at 1024 bytes. A tree with more than 10,000 nested-stack rows to
follow is refused as well. That is far beyond any CDK-generated assembly; in
practice it takes symlinked directories, which give one template file many
paths.

