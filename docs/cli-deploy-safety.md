---
title: "Deploy: safety & compatibility flags"
description: "Safety and compatibility flags for cdkd deploy — unsupported types and properties, recreate/replace escape hatches, strict GetAtt, unaddressed resources, and the CloudFormation-fallback opt-out."
---

# Deploy: safety & compatibility flags

cdkd refuses a few things by default rather than letting them fail halfway
through a deploy or succeed with a resource that is quietly missing a field.
This page covers those guards and the flags that open them, plus the two flags
that make a deploy stricter (`--strict-getatt`) or more permissive
(`--allow-unaddressed`) than the default. The rest of the deploy flags live
under [Deploy: waits & concurrency](cli-deploy.md) and
[Deploy: tuning](cli-deploy-tuning.md).

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh
cdkd deploy MyStack --allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes
cdkd deploy MyStack --replace --yes
cdkd deploy MyStack --strict-getatt          # fail on any guessed Fn::GetAtt value
cdkd deploy MyStack --no-cfn-fallback        # cdkd-state-only cross-stack resolution
```

## Options

| Flag | Applies to | Description |
| --- | --- | --- |
| `--allow-unsupported-types <types>` | deploy, destroy, state destroy | Attempt a resource type cdkd rejects at pre-flight as unsupported. |
| `--allow-unsupported-properties <entries>` | deploy | Pin a resource to the SDK provider and accept a silently dropped property, instead of the default Cloud Control auto-route. |
| `--recreate-via-cc-api <LogicalId>` | deploy | Destroy + recreate one resource via Cloud Control API, so a dropped property reaches AWS. |
| `--recreate-via-sdk-provider <LogicalId>` | deploy | The reverse: destroy + recreate one resource via cdkd's SDK provider. |
| `--replace` | deploy | Replace (DELETE + CREATE) a resource whose in-place update AWS has no API for. |
| `--force-stateful-recreation` | deploy | Bypass the [stateful-resource guard](#stateful-resource-guard) for every target in the run. |
| `--strict-getatt` | deploy | Fail on any `Fn::GetAtt` that falls back to a physical ID, and on any unresolvable Output. |
| `--allow-unaddressed` | deploy | Exit 0 instead of 2 when the deploy left a resource alive that it no longer tracks. |
| `--no-cfn-fallback` | deploy, diff | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. |

## `--allow-unsupported-types` (deploy + destroy)

cdkd rejects genuinely-unsupported resource types at **pre-flight** — before
any resource is touched — instead of letting them fail mid-deploy with an
opaque Cloud Control error. A type is "unsupported" when AWS reports it as
`ProvisioningType: NON_PROVISIONABLE` (the provider-coverage **Tier 3** set:
Cloud Control API cannot create, update or delete it) AND cdkd has no SDK
provider for it.

When pre-flight hits one, the error names each type, the reason, a one-click
pre-filled GitHub issue link to request support, and the exact re-run command:

```text
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

`--allow-unsupported-types <types>` is the **escape hatch**: a comma-separated
(and repeatable) list of types to attempt via Cloud Control anyway. It is
per-type rather than a blanket override so you explicitly acknowledge each
type. It is most useful for a type cdkd's bundled coverage data marks Tier 3
that AWS has since made provisionable — the permanent fix ships with the cdkd
release that refreshes that data.

The flag is accepted by `cdkd deploy`, `cdkd destroy` and `cdkd state destroy`,
so a stack deployed with it can also be torn down.

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
cdkd destroy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
```

## `--allow-unsupported-properties` (deploy)

### Default: the Cloud Control auto-route

When a CDK template uses a **top-level CFn property** that cdkd's SDK provider
would silently drop on write — AWS adds `CapacityProviderConfig` to
`AWS::Lambda::Function`, CDK adds support, you write it in your CDK code, but
cdkd's Lambda provider does not read it yet — cdkd **routes that resource
through Cloud Control API** instead. Cloud Control forwards the full property
map to AWS verbatim, so the silent drop is closed with no user intervention:
the field reaches AWS.

The routing decision is recorded on the resource's state record as
`provisionedBy: 'cc-api'` and stays sticky for the resource's lifetime.
`cdkd drift`, `cdkd destroy` and everything else route through the same layer
that created the resource, even after cdkd adds first-class SDK support for the
property. `cdkd state show <stack>` displays the `ProvisionedBy:` field so you
can audit which layer owns each resource.

Property coverage is tracked for **Tier 1** (SDK provider) types only. Tier 2
(Cloud Control fallback) types already forward the full property map to AWS, so
the auto-route is a no-op for them.

When the auto-route fires, cdkd logs an info line per affected resource:

```text
[info] MyLambda (AWS::Lambda::Function): routing via Cloud Control API
       (cdkd's SDK Provider does not yet wire CapacityProviderConfig — CC API
        will forward the full property map. Override via
        --allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig.)
```

Two categories never trigger the auto-route:

- **Properties not in the CFn schema** pass through silently. These are usually
  `addPropertyOverride` escape hatches or typos, both of which CloudFormation
  itself tolerates.
- **Read-only properties** (AWS-managed ARNs, IDs, and so on) pass through
  silently. You cannot set them from the template side, so they are no-ops if
  they appear there.

### The override

`--allow-unsupported-properties <entries>` is the **opt-out** from that
auto-route. Each entry is a `<ResourceType>:<PropertyName>` token
(comma-separated and repeatable); the flag pins the resource to the SDK
provider path and **accepts the silent drop** for the named property. A warn
line is logged so the drop is auditable.

```bash
cdkd deploy MyStack --allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig,AWS::Lambda::Function:FunctionScalingConfig
```

Entries are per type-and-property pair, not blanket, so you acknowledge each
drop explicitly. The flag is `deploy`-only: destroy works from the per-resource
physical ID and the state-recorded `provisionedBy` layer, not from the template
properties.

### When to use it

- **You need the SDK provider's fast synchronous-call path** and the dropped
  property is non-essential for your use case — for example a structural CDK
  construct emits a property you do not care about.
- **A Cloud Control side-effect bothers you.** Cloud Control may name a
  resource differently than cdkd's SDK provider would, and you want the SDK
  naming convention to win.
- **You have an existing SDK-managed resource** (`provisionedBy: 'sdk'`) that
  you want to keep on the SDK path after a new property appears in the
  template. Without the flag, the next deploy auto-routes it through Cloud
  Control: the routing decision is re-evaluated per deploy, and only a resource
  whose state already says `'cc-api'` is sticky. A still-SDK resource that
  gains a silent-drop property re-routes.

### When not to use it

- **The dropped property is security-meaningful** — `KmsKeyArn`,
  `MonitoringRoleArn`, `MasterUserSecret`, IAM policy attachments,
  resource-policy fields, encryption settings, TLS configuration. A silent drop
  here is a real-world incident. Without the flag the auto-route sends the
  property to AWS; with the flag you opt back into the drop.
- **You are prototyping** and do not care about routing. The default already
  gets the property to AWS.

### Decision summary

| Situation | Recommended action |
| --- | --- |
| Fresh deploy, template uses a silent-drop property | Default auto-route via Cloud Control — no flag needed |
| Existing Cloud-Control-managed resource, want to stay there | Default routing is sticky — no flag needed |
| Existing SDK-managed resource, new silent-drop property appears | Default re-routes through Cloud Control; use this flag to stay on SDK |
| You explicitly want SDK semantics and accept the drop | This flag |
| The property is security-meaningful | Do not use the flag — let the auto-route close the drop |

### What the flag is NOT

- **NOT** a request for cdkd to start handling the property. The provider is
  unchanged; with the flag the property is silently dropped at write time.
  Without the flag the resource takes the Cloud Control route and the property
  reaches AWS verbatim.
- **NOT** persisted in cdkd state. Every deploy must pass the flag if the
  override is still wanted. The resource's `provisionedBy` state field reflects
  the routing actually used at the last deploy, not the flag.

cdkd is a dev/test tool. The auto-route closes the silent-drop bug class by
default; for production workloads, use the AWS CDK CLI until cdkd's property
coverage matches your needs.

## `--recreate-via-cc-api` (deploy)

`--recreate-via-cc-api <LogicalId>` (repeatable, one flag per resource)
destroys and recreates the named resource via Cloud Control API in this deploy,
so a previously silently-dropped top-level CFn property reaches AWS on the
recreated copy. It is the mid-life counterpart to the auto-route that fresh
deploys get for free.

The argument is a single CloudFormation logical id. There is no comma split —
repeat the flag for more targets. A logical id that does not match CFn's
alphanumeric rule is rejected at parse time, so a typo surfaces immediately
rather than being silently skipped.

```bash
# Recreate a single Lambda (stateless, no extra flag needed)
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes

# Recreate two Lambdas in one deploy (repeat the flag)
cdkd deploy MyStack \
  --recreate-via-cc-api MyLambda \
  --recreate-via-cc-api OtherFn \
  --yes

# Recreate a stateful resource — two flags required, data loss acknowledged
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes
```

### When to use it

- An existing resource is `provisionedBy: 'sdk'` in cdkd state and you want to
  start using a top-level CFn property cdkd's SDK provider does not yet wire —
  adding `CapacityProviderConfig` to an already-deployed Lambda, say. Adding
  the property on the next deploy alone will not reach AWS, because the SDK
  update path drops it silently. The flag forces a destroy-and-recreate cycle
  so the new physical resource lands on Cloud Control and the property reaches
  AWS.

### When not to use it

- **The resource is already `provisionedBy: 'cc-api'`.** The update path
  already routes via Cloud Control, so the recreate is a no-op that would
  produce identical end state at the cost of unnecessary downtime. cdkd refuses
  at pre-flight; drop the flag for that resource.
- **Fresh deploy** — the resource is not yet in cdkd state. The auto-route
  handles fresh silent-drop deploys with no flag.

### Interactive confirmation

Before any resource is destroyed or created, cdkd prints a per-target plan —
logical id, resource type, direction tag (`[SDK → CC]`), and the `stateful`
reason where one applies — and asks:

```text
Continue? (y/N):
```

The default is `N`, because a destroy-and-recreate cycle is irreversible per
resource. One prompt covers the whole stack, and it is shared with
[`--recreate-via-sdk-provider`](#recreate-via-sdk-provider-deploy): naming
targets in both directions produces one plan carrying both direction tags.

- `--yes` / `-y` skips the prompt for non-interactive runs. The plan is
  warn-logged once and the deploy proceeds.
- A non-TTY run **without** `--yes` is rejected with an actionable error rather
  than hanging on a closed stdin.
- Stateful targets — those that reached pre-flight only because
  `--force-stateful-recreation` was passed — get a `**DATA LOSS**` prefix on
  their plan row plus an explicit `DATA: all data in <logical id> will be lost
  (no automatic data migration)` line. That is the third stop-and-think moment
  on top of the two-flag opt-in.

### Cross-stack reference propagation

The recreated resource gets a fresh physical id, so downstream stacks that read
its outputs via `Fn::GetStackOutput` / `Fn::ImportValue` must be re-deployed
before they see the new id. cdkd walks the state bucket at plan time and names
the downstream consumer stacks it finds in the warn block. If that walk fails
to read — a permissions problem, say — cdkd falls back to the generic caveat
without failing the deploy, so an empty consumer list is not proof there are
none. Plan multi-stack recreates from leaf to root.

### Interaction with `--allow-unsupported-properties`

`--recreate-via-cc-api MyLambda` combined with
`--allow-unsupported-properties AWS::Lambda::Function:CapacityProviderConfig`,
on a resource whose template carries `CapacityProviderConfig`, is **ambiguous
intent**:

- Does the user want SDK plus the silent drop (the override path)?
- Does the user want the Cloud Control migration (the recreate path)?

cdkd refuses with a pre-flight error naming the overlap. Pick one strategy per
resource.

### Going back to the SDK provider

Once a resource is `provisionedBy: 'cc-api'` it stays there. A later cdkd
release that wires the property you originally needed does not migrate it back
— sticky state is what stops resources ping-ponging between layers on every
release. Use
[`--recreate-via-sdk-provider`](#recreate-via-sdk-provider-deploy) to move it
back deliberately.

### What `--recreate-via-cc-api` is NOT

- **NOT** a per-stack shortcut. There is no
  `--recreate-via-cc-api-all-with-silent-drops` form — name each target
  explicitly to acknowledge the cost.
- **NOT** persisted in cdkd state. The next deploy without the flag routes the
  recreated resource via Cloud Control anyway (sticky); the flag is only needed
  to trigger the initial destroy and recreate.
- **NOT** compatible with cross-account or cross-region migration. The flag
  operates within the current deploy's environment only.
- **NOT** compatible with Tier 3 (`NON_PROVISIONABLE`) types — Cloud Control
  cannot handle them either, and the Tier 3 rejection fires first.
- **NOT** compatible with multi-region types such as
  `AWS::DynamoDB::GlobalTable`. See
  [Multi-region types are refused outright](#multi-region-types-are-refused-outright).

## `--recreate-via-sdk-provider` (deploy)

`--recreate-via-sdk-provider <LogicalId>` (repeatable, one flag per resource)
is the reverse direction. It destroys and recreates the named resource via
cdkd's SDK provider, so a resource currently sticky on
`provisionedBy: 'cc-api'` flips back to `provisionedBy: 'sdk'`.

It is symmetric to `--recreate-via-cc-api`: same per-resource explicit naming,
same destroy-then-create ordering, same
[stateful-resource guard](#stateful-resource-guard), same multi-region
refusal, and the same shared `Continue? (y/N)` prompt with `**DATA LOSS**` on
stateful rows. The two flags are mutually exclusive per resource — naming the
same logical id in both is refused as ambiguous.

```bash
# Mid-life CC → SDK migration after a release added SDK coverage
# for Lambda's LoggingConfig:
cdkd deploy MyStack --recreate-via-sdk-provider MyLambda --yes

# Multiple targets:
cdkd deploy MyStack \
  --recreate-via-sdk-provider MyLambda \
  --recreate-via-sdk-provider OtherFn \
  --yes
```

### When to use it

- A `provisionedBy: 'cc-api'`-sticky resource — it landed on Cloud Control
  because you originally needed a top-level CFn property cdkd's SDK provider
  did not wire, for example Lambda's `LoggingConfig` — is now eligible for SDK
  routing because a later cdkd release added SDK coverage for that property.
  The flag forces the destroy-and-recreate cycle so the new physical resource
  lands on SDK and gets the SDK provider's performance, diagnostic clarity and
  narrower IAM scope.
- A `provisionedBy: 'cc-api'` resource where you no longer need the Cloud
  Control route — you removed the silent-drop property from the template — and
  want to consolidate routing back to SDK for the same reasons.

### When not to use it

- **The resource is already `provisionedBy: 'sdk'`**, or its state record
  predates the `provisionedBy` field (treated as SDK). The reverse migration is
  a no-op and cdkd refuses with a clear error.
- **The resource type has no SDK provider registered** — a Tier 2,
  Cloud-Control-only type. The destroy and recreate would route via Cloud
  Control again, so cdkd refuses. Registration is checked narrowly: a type that
  is merely *routable* (Cloud Control, custom resource, escape hatch) does not
  qualify.
- **The template still uses a silent-drop property that is not listed in
  `--allow-unsupported-properties`.** The auto-route would send the
  SDK-recreated resource straight back to Cloud Control on the very next
  routing decision, so cdkd refuses as inverse ambiguous intent. Fix it by
  removing the property from the template, or by accepting the drop with
  `--allow-unsupported-properties <Type>:<Prop>`.

### What `--recreate-via-sdk-provider` is NOT

- **NOT** a per-stack shortcut. Per-resource explicit naming only.
- **NOT** the only path to SDK routing. Fresh CREATEs land on SDK whenever an
  SDK provider is registered for the type and the template carries no
  silent-drop property. This flag is for the existing-state Cloud Control → SDK
  migration only.
- **NOT** compatible with `--recreate-via-cc-api` on the same logical id — pick
  one direction per resource.

## `--replace` (deploy)

`--replace` replaces (DELETE + CREATE) a resource whose **in-place update is
rejected because an immutable property changed and AWS exposes no update API
for it**. Some resource types are immutable on AWS: there is no `Update<Thing>`
call, so any property change must publish or register a new physical resource.
Examples are `AWS::Lambda::LayerVersion` content, `AWS::EFS::AccessPoint`,
`AWS::ECS::TaskDefinition`, `AWS::Glue::SecurityConfiguration`, and several
`AWS::ApiGatewayV2::*` identity fields.

For a few of these cdkd has a built-in replacement rule —
`AWS::Lambda::LayerVersion` auto-replaces with no flag. For the rest, cdkd's
diff classifies the change as an in-place UPDATE, the provider's update
hard-rejects with `ResourceUpdateNotSupportedError`, and without this flag the
deploy fails. `--replace` opts into catching that rejection and falling back to
a DELETE + CREATE, the same replacement path the Cloud Control
`UnsupportedActionException` auto-fallback already uses, and matching what
CloudFormation would do.

Unlike `--recreate-via-cc-api` / `--recreate-via-sdk-provider`, which name a
specific logical id and force a routing migration, `--replace` is a stack-wide
opt-in that fires only for resources whose update genuinely hard-rejects. A
resource whose update succeeds in place is unaffected.

```bash
# A Glue SecurityConfiguration's EncryptionConfiguration changed (immutable) —
# fails without the flag, replaces cleanly with it
cdkd deploy MyStack --replace --yes
```

### When to use it

- A deploy failed because an immutable property changed on a type AWS has no
  update API for, and you accept the DELETE + CREATE. This is what
  CloudFormation does for the same change.
- A deploy failed with `NAMED_REPLACEMENT_COLLISION` or
  `NAMED_REPLACEMENT_IDEMPOTENT_CREATE`, and you accept the brief
  unavailability that the delete-first order below implies.

### When not to use it

- **You want to move one resource between routing layers.** That is
  `--recreate-via-cc-api` / `--recreate-via-sdk-provider`, which name a target.
  `--replace` is stack-wide and fires wherever an update hard-rejects.
- **Downstream consumers have not been re-deployed.** A replacement mints a
  fresh physical id, and unlike the recreate flags `--replace` neither prompts
  nor enumerates downstream consumer stacks for you.
- **The target is stateful and you have not settled the data loss.** Adding
  `--force-stateful-recreation` to clear the guard clears it for EVERY target
  in the run, not only the one that failed.

### Same-name replacement: delete-first ordering

cdkd replaces create-first by default — the new resource is created before the
old one is deleted, which is CloudFormation's safe order. That order cannot
work when the resource carries a physical name the old copy still holds. Two
shapes hit this, and both name `--replace` in their error text:

| Failure | What happened | Without `--replace` | With `--replace` |
| --- | --- | --- | --- |
| `NAMED_REPLACEMENT_COLLISION` | The create-first attempt collided with the existing resource's name | Deploy fails, quoting the name's origin and a rename remedy | The old resource is deleted FIRST, then recreated under the same name |
| `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` | The Create API is name-idempotent, so the create returned the OLD resource's physical id instead of a new one — for example `CreateQueue` with an unchanged `QueueName` | Deploy fails rather than deleting the resource it just reported as created | Same delete-first path |

The resource is briefly unavailable while it is deleted and recreated. The
alternative remedy in both messages is to rename the resource so the
create-first order has a free name to take.

`UpdateReplacePolicy: Retain` hard-fails in both shapes **regardless of
`--replace`**: with Retain the old resource keeps the name, so a same-name
replacement can never proceed.

### The stateful guard on this path

`--replace` shares the [stateful-resource guard](#stateful-resource-guard):
when the replacement target is a stateful type, the DELETE + CREATE loses all
its data, so cdkd refuses unless `--force-stateful-recreation` is also passed.
Three details are specific to this path:

- **The guard is evaluated mid-deploy**, at the moment the immutable-update
  rejection is caught — not at pre-flight, as it is for the `--recreate-via-*`
  flags. The error names the resource and the data-loss reason.
- **Every `AWS::S3::Bucket` counts as stateful here**, empty or not. There is
  no opportunity mid-deploy to run the object-count probe the pre-flight path
  uses, so cdkd assumes the bucket has data. Replacing any bucket via
  `--replace` therefore needs `--force-stateful-recreation`.
- **The Cloud Control `UnsupportedActionException` auto-fallback is not
  guarded.** Only the `--replace` opt-in consults the stateful guard; the
  auto-fallback replaces unconditionally, as it always has.

Non-stateful immutable types — LayerVersion, Glue SecurityConfiguration, ECS
TaskDefinition, ApiGatewayV2 sub-resources — replace with `--replace` alone.

### Property-driven replacement and `STATEFUL_REPLACE_BLOCKED`

The stateful guard also covers **property-driven replacement**: a replacement
cdkd detects directly from the diff, because an immutable / createOnly property
changed in the template. Examples are a change to
`AWS::EFS::FileSystem.PerformanceMode`, an `AWS::EC2::Volume`
`AvailabilityZone` move, or an S3 `BucketName` rename. This is a different
trigger from a provider's mid-deploy update rejection, and it fires on a plain
`cdkd deploy` with **no `--replace` flag at all**.

A plain deploy that would DELETE + CREATE a **stateful** resource because of
such a change requires `--force-stateful-recreation` and fails with
`STATEFUL_REPLACE_BLOCKED` without it. The error names the immutable properties
that changed:

```text
MyFileSystem (AWS::EFS::FileSystem) requires replacement (immutable property
changed: PerformanceMode) but it is a stateful resource — destroy loses all data
in the resource. Re-run with --force-stateful-recreation to confirm the data
loss, or change the resource definition to avoid the immutable-property change.
```

Three exemptions apply to this trigger specifically:

- **`UpdateReplacePolicy: Retain` is exempt.** The old resource and its data
  survive the replacement — orphaned rather than deleted — so there is no data
  loss to confirm.
- **`UpdateReplacePolicy: Snapshot` is NOT exempt.** cdkd does take a final
  snapshot on the replacement's delete, but a snapshot is a point-in-time copy,
  not a surviving resource: the live resource is still destroyed and recreated,
  so the consent flag is still required.
- **A target already named by `--recreate-via-cc-api` /
  `--recreate-via-sdk-provider` is exempt**, because those flags ran their own
  pre-flight stateful probe before the deploy started.

As with `--replace`, this mid-deploy check treats every `AWS::S3::Bucket` as
stateful. Non-stateful types still replace freely on a plain `cdkd deploy` with
no flag.

## Stateful-resource guard

Destroying and recreating most resource types loses nothing — an IAM role or a
Lambda function comes back identical. For **data-bearing** types the destroy
loses everything in the resource: rows in a DynamoDB table, objects in an S3
bucket, log lines in a log group, images in an ECR repository. AWS does not
migrate any of it to the replacement.

So cdkd refuses to destroy-and-recreate a stateful resource unless
`--force-stateful-recreation` is passed as a second flag. That two-flag
protection mirrors
[`--remove-protection`](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy)
on destroy.

Four paths consult this guard:

| Path | When the guard runs |
| --- | --- |
| `--recreate-via-cc-api` | Pre-flight, before any resource is touched |
| `--recreate-via-sdk-provider` | Pre-flight, before any resource is touched |
| `--replace` | Mid-deploy, when the immutable-update rejection is caught |
| Property-driven replacement on a plain `cdkd deploy` | Mid-deploy, from the diff |

### Always-stateful types

Destroy loses all data for these, unconditionally.

| Category | Types |
| --- | --- |
| Database | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` |
| Filesystem / blob | `AWS::EFS::FileSystem`, `AWS::FSx::FileSystem`, `AWS::ECR::Repository`, `AWS::EC2::Volume` |
| Streaming | `AWS::Kinesis::Stream` |
| Search | `AWS::Elasticsearch::Domain`, `AWS::OpenSearchService::Domain` |
| Identity / config | `AWS::Cognito::UserPool`, `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter` |
| Metadata catalog | `AWS::Glue::Database`, `AWS::Glue::Table` |
| Edge | `AWS::CloudFront::Distribution` — the URL changes, which breaks consumers, and propagation takes roughly 20 minutes |

### Conditionally stateful types

Two types are only stateful when the resource actually holds data.

| Type | Guard fires when | Guard does not fire when |
| --- | --- | --- |
| `AWS::S3::Bucket` | The bucket has at least one current version, prior version, or delete-marker | The bucket is empty — but see the per-path note below |
| `AWS::Logs::LogGroup` | `RetentionInDays > 0` on the recorded state | Retention is unset or zero, so the log group is ephemeral |

### How S3 buckets are judged, per path

The two guard timings answer the S3 question differently, and the difference is
what decides whether you need `--force-stateful-recreation` for a bucket.

**At pre-flight** (`--recreate-via-cc-api` / `--recreate-via-sdk-provider`)
cdkd issues a single-page `s3:ListObjectVersions(MaxKeys=1)` against each
targeted bucket's recorded physical id, in the stack's deploy region. Empty
buckets pass through; non-empty ones are refused. cdkd uses
`ListObjectVersions` rather than `ListObjectsV2` so the probe's view of "empty"
matches what the destroy-and-recreate cycle would actually wipe — a versioned
bucket whose current keys are all soft-deleted still holds prior versions and
delete-markers.

If the probe itself fails — permission denied, bucket not found mid-flight, a
transient network error — cdkd logs a warning and leaves the target
**un-promoted**, which means the guard does not fire and the recreate proceeds
without `--force-stateful-recreation`. The probe fails open, so treat that
warning as a prompt to decide for yourself: pass
`--force-stateful-recreation` if the bucket might hold data.

**Mid-deploy** (`--replace` and property-driven replacement) there is no
opportunity to run that probe, so cdkd assumes the bucket has data. Every
bucket needs `--force-stateful-recreation` on those paths.

### `--force-stateful-recreation`

The flag is a boolean with **no per-resource granularity**. When set, EVERY
named recreate or replacement target in the run bypasses the stateful guard.
That is deliberate: you are opting into a footgun, and a per-resource form
would imply a precision the flag does not have.

For a CI run on a stateful resource, the full opt-in is three flags:

```bash
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes
```

### Multi-region types are refused outright

`AWS::DynamoDB::GlobalTable` is refused by **both** recreate directions
regardless of `--force-stateful-recreation`. There is no bypass flag: the
destroy-and-recreate cycle across replica regions involves automated backups
and eventual consistency across the replication mesh, and cdkd does not attempt
it. The refusal is distinct from the stateful guard, which gates on data loss
and is bypassable.

## `--strict-getatt` (deploy)

`--strict-getatt` fails the deploy on ANY `Fn::GetAtt` that falls back to the
resource's physical ID because cdkd cannot construct the requested attribute,
and on any stack Output that cannot be resolved.

```bash
cdkd deploy MyStack --strict-getatt
```

### Default behaviour

When a template requests an attribute that is neither captured in the state
record's `attributes` nor constructible by the resolver's per-type mappings,
cdkd falls back to the resource's **physical ID**. What happens next depends on
whether the fallback value is knowably wrong for the attribute's name:

| Attribute name | Fallback value | Result |
| --- | --- | --- |
| Ends in `Arn` | Not `arn:`-shaped | Deploy fails, naming the resource, attribute, and an issue link |
| Ends in `Url` | Not an http(s) URL | Deploy fails, naming the resource, attribute, and an issue link |
| Any other suffix | Any | Warn `Unknown attribute X for resource type Y, returning physical ID` and continue |

The hard-fail rows apply to the resolver's final unknown-type fallback and to
every per-type handler's unknown-attribute default branch. Other suffixes only
warn because an alias or an endpoint is shape-indistinguishable from a plain
name, so hard-failing there would fail correct deploys.

Three further rules round out the default:

- **The same refusals apply inside `Fn::Sub`.** A `${LogicalId.Attribute}`
  placeholder resolves through the same code path, so a reference that
  hard-fails as a resource property hard-fails there too. A variable that
  genuinely does not exist still warns and keeps its `${...}` placeholder, and
  the warning names the actual reason.
- **A summary line counts the fallbacks** so the warnings do not scroll away on
  a green deploy:

  ```text
  2 attribute resolution(s) fell back to the physical ID (potentially wrong values); re-run with --strict-getatt to fail on these
  ```

  Each distinct fallback site is counted once per run — diff-phase resolutions
  are not double-counted against provisioning-phase ones. The count is per
  stack: a nested-stack child's fallbacks are counted by the child's own deploy
  engine and are not aggregated into the parent's summary line.
- **An unresolvable Output is warned about and skipped.** No value is persisted
  or exported, and the deploy still exits 0.

### With the flag

- EVERY unknown-attribute physical-ID fallback is a hard error — any suffix,
  including an ARN-shaped fallback for an `*Arn` attribute.
- An Output resolution failure fails the deploy instead of silently publishing
  nothing, which would otherwise break downstream `Fn::ImportValue` consumers
  with "export not found" long after this deploy exited 0. The failure fires
  AFTER all resource operations succeeded, so cdkd persists the provisioning
  result to state BEFORE failing: created and updated resources are recorded,
  previously persisted outputs are kept, no rollback runs, and a follow-up
  `cdkd deploy` or `cdkd destroy` sees them. Even on a first deploy, nothing
  becomes an invisible orphan.

### When to use it

Use it in CI to guarantee no potentially-wrong `Fn::GetAtt` value ever ships
quietly. Drop it — the default — when a known-benign fallback is acceptable,
for instance a physical ID that genuinely is the attribute value for a type
cdkd has not enriched yet. Nested-stack child deploys inherit the flag from the
parent deploy.

## `--allow-unaddressed` (deploy)

A deploy that finishes without a single resource FAILING can still leave a
resource cdkd was responsible for alive in AWS. That outcome exits `2`,
matching what `cdkd destroy` does for the identical case. Two cases produce it,
and they differ in whether they heal themselves:

| Summary row | Cause | Next `cdkd deploy` retries it? |
| --- | --- | --- |
| `Skipped (not deleted): N` | A resource removed from the template whose provider could not issue the delete — typically a malformed `physicalId` in state | **Yes.** The state record is deliberately KEPT, so the resource is still diffed as a DELETE next run |
| `of which left an orphaned predecessor: N` | A replacement whose new resource was created and whose OLD one could not be deleted | **No.** State now points at the replacement, so the survivor is untracked — delete it by hand |

```bash
cdkd deploy MyStack                       # exit 2 if either row is non-zero
cdkd deploy MyStack --allow-unaddressed   # exit 0 for the same run
```

### What the flag keeps

The flag changes the **exit code**, and with it the run-level error message.
Everything else is emitted unchanged:

- The summary rows above.
- Each resource's own warning, naming its cause and remedy.
- The switched banner.
- The `skipped` figure in `cdkd events`.
- The `RUN_FINISHED` `result: 'FAILED'` record.

So a run that used the flag still says — in its log and in its durable
post-mortem — that a resource survived. The events store records what happened,
not what the operator chose to tolerate.

### What the flag takes away

Beyond the exit code, two things:

- **The `PartialFailureError` message is not raised at all.** That message is
  the only place the run-level remediation text appears ("a skipped DELETE
  keeps its state record… a replacement's survivor is not tracked — delete it
  by hand"), along with the count of stacks that were cancelled and never
  deployed.
- **The banner's closing sentence differs.**

If you set the flag in CI, the per-resource warnings remain your route to the
cause.

### Why it exists

The orphaned-predecessor case has a legitimate not-yet-fixable window. The
commonest instance is an ACM certificate replacement rejected because a
consumer — often a CloudFront distribution in another stack not yet updated —
still references the old certificate. The delete succeeds on its own once
`DescribeCertificate.InUseBy` is empty. Until then a pipeline would be red for
a cause it cannot act on.

Prefer the flag over wrapping the command in a shell exit-code test. `cdkd
deploy` also exits `2` for `MacroExpansionError` (a synth-time macro failure)
and `ResourceUpdateNotSupportedError`, so `cdkd deploy || [ $? -eq 2 ]` would
silence those unrelated real failures. `--allow-unaddressed` is scoped to this
one cause.

## `--no-cfn-fallback` (deploy / diff)

By default, a cross-stack reference that is not found in cdkd state falls back
to CloudFormation, so a cdkd-deployed consumer can reference a producer stack
still managed by CloudFormation (`cdk deploy` or raw CFn):

- `Fn::ImportValue` → CloudFormation `ListExports` in the consumer's region,
  which is CloudFormation's own semantic for the intrinsic.
- `Fn::GetStackOutput` → CloudFormation `DescribeStacks` outputs in the target
  region. Same-account only — the `RoleArn` (cross-account) form never takes
  the fallback.

Three rules govern that fallback:

- **cdkd state wins.** The fallback fires ONLY after a cdkd-state miss, so
  existing cdkd-to-cdkd references are untouched and a name collision resolves
  to the cdkd export.
- **A CloudFormation-sourced resolution is a weak reference.** It is not
  recorded into `state.imports` / `state.outputReads`, so there is no
  destroy-time protection in either direction: deleting the CloudFormation
  producer breaks the consumer's next resolve, not the producer's delete.
- **A lookup failure degrades gracefully.** A missing
  `cloudformation:ListExports` / `cloudformation:DescribeStacks` permission
  logs a warning and surfaces the original not-found error.

```bash
cdkd deploy MyStack --no-cfn-fallback   # cdkd-state-only resolution
cdkd diff MyStack --no-cfn-fallback     # preview with the same semantics
```

Pass the flag when you want cdkd-state-only semantics — IAM kept minimal, or an
export-name typo failing fast instead of accidentally matching an unrelated
CloudFormation export in the account. Nested-stack child deploys inherit the
flag from the parent deploy, and `cdkd diff` honors it in its best-effort
resolvers so preview and apply resolve identically.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The deploy finished and every resource cdkd was responsible for was addressed. |
| `1` | A guard on this page refused the run, or the deploy failed. |
| `2` | A partial outcome: a resource left unaddressed, a macro that failed to expand, or an update rejected as unsupported. |

`--allow-unaddressed` turns the first of those `2` cases back into `0`; the
other two are unaffected by it.

## Related

- [Deploy: waits & concurrency](cli-deploy.md) — concurrency knobs and the wait-semantics table
- [Deploy: tuning](cli-deploy-tuning.md) — timeouts, name prefixing, observed-state capture
- [Destroy flags & guards](cli-destroy.md) — the destroy-side data guards and `--remove-protection`
- [Supported AWS Resource Types](supported-resources.md) — the per-type tier table and property-level coverage
- [Cross-Stack References](cross-stack-references.md) — the full design behind `--no-cfn-fallback`
- [cdkd State Management Specification](state-management.md) — where `provisionedBy` lives in the state record
