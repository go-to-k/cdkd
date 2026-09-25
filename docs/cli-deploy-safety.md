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
cdkd deploy MyStack --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes
cdkd deploy MyStack --replace --yes
cdkd deploy MyStack --strict-getatt          # fail on any guessed Fn::GetAtt value
cdkd deploy MyStack --no-cfn-fallback        # cdkd-state-only cross-stack resolution
```

## Options

| Flag | Applies to | Description |
| --- | --- | --- |
| `--allow-unsupported-types <types>` | deploy, destroy, state destroy | Attempt a resource type cdkd rejects at pre-flight as unsupported. |
| `--prefer-sdk-route <entries>` | deploy | Pin a resource to the SDK provider and accept a silently dropped property, instead of the default Cloud Control auto-route. |
| `--recreate-via-cc-api <LogicalId>` | deploy | Destroy + recreate one resource via Cloud Control API, for a dropped property the auto-route's in-place update cannot deliver. |
| `--recreate-via-sdk-provider <LogicalId>` | deploy | The reverse: destroy + recreate one resource via cdkd's SDK provider. |
| `--pin-cc-api <LogicalId>` | deploy | Decline the automatic return to the SDK provider for one resource, keeping it on Cloud Control for this deploy. |
| `--replace` | deploy | Replace (DELETE + CREATE) a resource whose in-place update AWS has no API for. |
| `--force-stateful-recreation` | deploy | Bypass the [stateful-resource guard](#stateful-resource-guard) for every target in the run. |
| `--strict-getatt` | deploy | Fail on any `Fn::GetAtt` that falls back to a physical ID, and on any unresolvable Output. |
| `--allow-unaddressed` | deploy | Exit 0 instead of 2 when the deploy left a resource alive that it no longer tracks. |
| `--no-cfn-fallback` | deploy, diff | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. |

## Which routing flag, when

Four of the flags above decide **which provisioning layer manages a resource** —
cdkd's hand-written SDK provider or the Cloud Control API. They are easy to
confuse, and the choice usually starts from what you want rather than from a
flag name, so the decision map lives with the concept:
[Provisioning Layers](provisioning-layers.md#choosing-a-flag). This page owns
the per-flag detail each row links to.

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

## `--prefer-sdk-route` (deploy)

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
property. `cdkd state show '<stack>'` displays the `ProvisionedBy:` field so you
can audit which layer owns each resource.

Property coverage is tracked for **Tier 1** (SDK provider) types only. Tier 2
(Cloud Control fallback) types already forward the full property map to AWS, so
the auto-route is a no-op for them.

When the auto-route fires, cdkd logs an info line per affected resource:

```text
[info] MyLambda (AWS::Lambda::Function): routing via Cloud Control API
       (cdkd's SDK Provider does not yet wire CapacityProviderConfig — CC API
        will forward the full property map. Override via
        --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig.)
```

A property missing from cdkd's CFn schema snapshot (one AWS published after
it, a typo, or an `addPropertyOverride` key) triggers the auto-route too.
Cloud Control applies a real property and rejects a misspelled one with
`Model validation failed (#: extraneous key [...] is not permitted)`, as
CloudFormation does.

These stay on the SDK provider, with a warning that names the property:

| Property | Why it does not route |
| --- | --- |
| Read-only (AWS-managed ARNs, IDs, and so on) | No engine sets one. CloudFormation ignores it, and Cloud Control would record it as the resource's identifier. |
| Missing from the snapshot, on a type Cloud Control cannot manage | There is no Cloud Control route for the type. |
| Missing from the snapshot, and unchanged since the resource was deployed on the SDK provider | An existing resource keeps its route. Changing the value routes it. |

### The override

`--prefer-sdk-route <entries>` is the **opt-out** from that
auto-route. Each entry is a `<ResourceType>:<PropertyName>` token
(comma-separated and repeatable); the flag pins the resource to the SDK
provider path and **accepts the silent drop** for the named property. A warn
line is logged so the drop is auditable.

```bash
cdkd deploy MyStack --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig,AWS::Lambda::Function:FunctionScalingConfig
```

Entries are per type-and-property pair, not blanket, so you acknowledge each
drop explicitly. The flag is `deploy`-only: destroy works from the per-resource
physical ID and the state-recorded `provisionedBy` layer, not from the template
properties.

**The state record follows the drop.** A property accepted this way is not
written to the resource's `properties` bag in cdkd state either — state
describes what cdkd sent to AWS, not what the template asked for. Two
consequences worth knowing:

- **Removing the flag is usually enough to close the drop.** The property is
  then a genuine addition against the record, so the deploy re-routes the
  resource through Cloud Control and the value reaches AWS in place. (Older cdkd
  versions recorded the property anyway, and the re-routed update — computed as
  a patch against a record that already claimed the value — sent nothing.) The
  main exception is a create-only property; see below. The narrower one is
  where the re-route happens but cannot land — the physical-id bullet under
  [`--recreate-via-cc-api`](#recreate-via-cc-api-deploy). A type the Cloud
  Control route cannot serve — no Cloud Control handlers, or a provider that
  declines the fallback — is refused at pre-flight instead.
- **`cdkd diff` and `cdkd deploy` disagree about the property, on purpose.**
  `diff` registers no `--prefer-sdk-route`, so it previews the
  flag-less deploy and shows the property as a pending change with the
  `[via CC API: <Prop>]` annotation. Re-running `deploy` WITH the flag reports
  no change for it, because that deploy will not write it.

Three exceptions:

- **A resource carrying a second silent-drop property you did not name.** One
  un-allowed drop routes the whole resource through Cloud Control, which
  forwards the full map — so the property you opted out of reaches AWS anyway
  and is recorded. cdkd warns that your preference had no effect, naming the
  property that overrode it; widening `--prefer-sdk-route` to cover that one
  too is what keeps the resource on its SDK provider.
- **A resource already recorded `provisionedBy: cc-api`.** The routing is
  sticky, so the flag changes nothing: Cloud Control keeps writing the whole
  map.
- **A property CloudFormation marks create-only.** Applying one to a live
  resource requires a replacement, so cdkd does not narrow it out of the record
  — the drop is still accepted and still warned about, but removing the flag
  later does not deliver it. Applying it means recreating the resource, which
  is [`--recreate-via-cc-api`](#recreate-via-cc-api-deploy) — and that flag is
  refused while the same property is still named in
  `--prefer-sdk-route`, so drop the entry in the same run. A
  stateful type also needs
  [`--force-stateful-recreation`](#force-stateful-recreation). A type the Cloud
  Control route cannot serve (no Cloud Control handlers, or a provider that
  declines the fallback) cannot be recreated that way at all, and removing the
  flag makes its deploy refuse at pre-flight; the warn line says so.

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
| Existing Cloud-Control-managed resource, want to stay there | Default routing is sticky — no flag needed, unless the type is exempt from stickiness ([`--pin-cc-api`](#pin-cc-api-deploy)) |
| Existing SDK-managed resource, new silent-drop property appears | Default re-routes through Cloud Control; use this flag to stay on SDK |
| You explicitly want SDK semantics and accept the drop | This flag |
| The property is security-meaningful | Do not use the flag — let the auto-route close the drop |

### What the flag is NOT

- **NOT** a request for cdkd to start handling the property. The provider is
  unchanged; with the flag the property is silently dropped at write time.
  Without the flag the resource takes the Cloud Control route and the property
  reaches AWS verbatim.
- **NOT** free to undo for a **create-only** property. Such a property is
  recorded in cdkd state even though it was never written — deliberately, since
  narrowing it out would turn it into a replacement of an untouched resource —
  so simply dropping the flag later does not deliver it. See
  [the caveat under `--recreate-via-cc-api`](#recreate-via-cc-api-deploy). For
  every other dropped property, dropping the flag usually delivers it: the
  record never claimed it, so the next deploy re-routes and Cloud Control sends
  it. Usually, not always. The auto-routed update still has to be able to
  ADDRESS the resource, and where it cannot it fails at update time — the
  physical-id bullet in that same section. The Cloud Control route also has to
  be able to serve the type at all: with no Cloud Control handlers, or a
  provider that declines the fallback, dropping the flag is refused at
  pre-flight rather than being silently ineffective.
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
recreated copy. Mid-life deploys get the auto-route for free too, so this flag
is for the cases that route cannot serve rather than for reaching Cloud Control
in general — see "When to use it" just below.

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

**First check whether you need it at all.** Adding a silent-drop property to an
already-deployed `provisionedBy: 'sdk'` resource does NOT by itself require
this flag: the routing decision is re-made every deploy, so the next one
auto-routes that resource through Cloud Control. Where the type's SDK-stored
physical id is also a valid Cloud Control identifier — a per-type fact, not a
guarantee; see the second bullet below — the property reaches AWS as an update
in place, with the physical id preserved. Where it is not, that update fails
rather than silently doing nothing. Measured on a live resource by
[`tests/integration/sdk-to-cc-autoroute/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/sdk-to-cc-autoroute/),
which adds `EvaluationWindow` to a deployed `AWS::CloudWatch::Alarm` with no
flag and then asserts: the deploy renders the per-resource verb `updated` and
not `replaced`, the record moved to `'cc-api'`, the physical id is unchanged,
the property reads back from `DescribeAlarms`, and a tag attached out of band
before the redeploy survived. A later phase deliberately recreates the alarm
and checks that tag DIES, so its survival above means something. This section
said the opposite until that run measured it.

**An earlier opt-out deploy no longer defeats this, with one exception.** cdkd
records only what the SDK provider actually sent, so after a
[`--prefer-sdk-route`](#prefer-sdk-route-deploy) deploy a removable drop is
simply absent from the record: the later flag-less deploy sees a genuine
addition, re-routes the resource, and Cloud Control sends the field. The same
`sdk-to-cc-autoroute` fixture measures that pair — its `--prefer-sdk-route`
phase asserts the record does NOT carry `EvaluationWindow`, and the flag-less
phase after it reads the property back off the live alarm.

**The exception is a create-only drop**, and there the old failure survives.
cdkd deliberately leaves such a property IN the record, because removing it
would make the key read as an addition against the template — and an added
create-only property is a REPLACEMENT, so a plain upgrade deploy over an
unchanged template would destroy and recreate a resource nobody touched. The
cost of that choice is stated rather than hidden: the record keeps claiming a
value AWS does not hold, the flag-less deploy diffs it as identical on both
sides, nothing is sent, and the deploy reports success. That residual is a
known defect with its own tracking issue. It is still open because the
alternatives to today's behaviour — refuse the deploy, or classify it as a
replacement — both change what a plain deploy does to a live resource.

Reach for the flag when the auto-routed **update** cannot deliver the property,
which is a narrower case:

- **The property is create-only.** No update on either layer can set it, so the
  resource has to be created again with the property present. The CFn resource
  schema's `createOnlyProperties` is what to check. Whether you need this flag
  depends on what the record holds. If it does NOT already claim the value —
  the ordinary case, where you just added the property — the change reads as an
  addition, and unless one of cdkd's own rules says that property can change in
  place it becomes a
  [property-driven replacement](#property-driven-replacement-and-stateful-replace-blocked),
  so cdkd recreates the resource for you with no flag. (Where cdkd has no rule
  of its own, that verdict is read from the type's CFn schema through
  `cloudformation:DescribeType`; without that permission cdkd warns and
  classifies the change as in-place instead, so that property-driven
  replacement does not happen — and where nothing rejects the in-place update,
  the deploy can report success with the property unapplied.) A stateful type
  is refused until `--force-stateful-recreation`, **unless** it declares
  `UpdateReplacePolicy: Retain` — that is exempt from the consent flag, because
  the old resource is orphaned rather than deleted. The flag is for the case
  where the record DOES claim the value — the `--prefer-sdk-route` sequence
  above — because there the diff finds no difference to act on.
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
fails loudly only when the record does not already claim the property — the
replacement is planned, and for a stateful type without
`UpdateReplacePolicy: Retain` it is refused out loud. In the recorded
create-only case above there is no failure at all, and the output is worse than
silent: pre-flight still prints the routing line promising Cloud Control will
forward the full property map, the diff then finds no change, nothing retracts
the promise, and nothing points at this flag. So that one is a precaution you
do have to take before the fact.

### When not to use it

- **The resource is still `provisionedBy: 'sdk'` and you have only just added
  the property.** Deploy first: the auto-route very likely applies it in place,
  and a recreate you did not need costs downtime. See the paragraph above.

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

### Cross-stack reference propagation

The recreated resource gets a fresh physical id, so downstream stacks that read
its outputs via `Fn::GetStackOutput` / `Fn::ImportValue` must be re-deployed
before they see the new id. cdkd walks the state bucket at plan time and names
the downstream consumer stacks it finds in the warn block. If that walk fails
to read — a permissions problem, say — cdkd falls back to the generic caveat
without failing the deploy, so an empty consumer list is not proof there are
none. Plan multi-stack recreates from leaf to root.

### Interaction with `--prefer-sdk-route`

`--recreate-via-cc-api MyLambda` combined with
`--prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig`,
on a resource whose template carries `CapacityProviderConfig`, is **ambiguous
intent**:

- Does the user want SDK plus the silent drop (the override path)?
- Does the user want the Cloud Control migration (the recreate path)?

cdkd refuses with a pre-flight error naming the overlap. Pick one strategy per
resource.

### Going back to the SDK provider

Once a resource is `provisionedBy: 'cc-api'` it normally stays there. A later
cdkd release that wires the property you originally needed does not by itself
migrate it back — sticky state is what stops resources ping-ponging between
layers on every release. Use
[`--recreate-via-sdk-provider`](#recreate-via-sdk-provider-deploy) to move it
back deliberately.

The exception is a type carrying an `'sdk-coverage'` exemption from the sticky
rule, for which the return happens automatically, in place, and without a
recreate — see [`--pin-cc-api`](#pin-cc-api-deploy) and
[State Management](state-management.md#version-7-adds-provisionedby-v7-writers).
Check which case applies before reaching for the flag; the recreate is
destructive and the automatic return is not.

### Nested stacks

Both flags take a logical id of the stack you are deploying, and cdkd honours a
target only in that stack. Resources that live inside a nested stack
(`AWS::CloudFormation::Stack`) are not addressable:

- A logical id that exists only in a child is not in the parent's synth
  template, so the pre-flight refuses the deploy before any resource is
  touched. The error names the parent's nested stacks so the refusal is not
  mistaken for a typo.
- A logical id the parent and a child both declare — the same construct id in
  both stacks, or an `overrideLogicalId` — recreates the **top-level** resource
  only. The child's same-named resource is left alone. Earlier versions
  recreated the child's copy too, in any deploy that also updated it, with
  neither the pre-flight probe nor the mid-deploy stateful guard having
  examined it.
- The nested stack's own `AWS::CloudFormation::Stack` resource is refused as a
  target. Recreating one would delete the whole child stack — every resource it
  owns, with no per-resource confirmation — and re-create it through a layer
  that does not implement cdkd's nested-stack handling. There is no
  `--force-stateful-recreation` bypass for that refusal.

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
- **NOT** a way to recreate a resource inside a nested stack. See
  [Nested stacks](#nested-stacks).

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
  `--prefer-sdk-route`.** The auto-route would send the
  SDK-recreated resource straight back to Cloud Control on the very next
  routing decision, so cdkd refuses as inverse ambiguous intent. Fix it by
  removing the property from the template, or by accepting the drop with
  `--prefer-sdk-route <Type>:<Prop>`.

### What `--recreate-via-sdk-provider` is NOT

- **NOT** a per-stack shortcut. Per-resource explicit naming only.
- **NOT** the only path to SDK routing. Fresh CREATEs land on SDK whenever an
  SDK provider is registered for the type and the template carries no
  silent-drop property. This flag is for the existing-state Cloud Control → SDK
  migration only.
- **NOT** compatible with `--recreate-via-cc-api` on the same logical id — pick
  one direction per resource.
- **NOT** a way to recreate a resource inside a nested stack — same scope rule
  as its forward twin. See
  [Nested stacks](#nested-stacks).

## `--pin-cc-api` (deploy)

`--pin-cc-api <LogicalId>` (repeatable, one flag per resource) keeps a resource
recorded as `provisionedBy: 'cc-api'` on the Cloud Control route for this
deploy, declining the automatic return to cdkd's SDK provider.

**What it declines.** Once a resource is recorded `'cc-api'` it normally stays
there ([state management](state-management.md) has the full rule). Types whose
Cloud Control routing works but is merely slower can carry an `'sdk-coverage'`
exemption, and a resource of such a type returns to the SDK provider on its
next mutating deploy — provided neither its template properties nor its
recorded ones carry a property cdkd would silently drop. The physical id is
preserved; the resource is updated in place, not replaced.

`cdkd diff` shows the pending change as `[returning to SDK provider]`, so it
is visible before it happens.

**When you would want it.** The flip is conditioned on that resource's own
coverage, so declining it is a judgement about a specific deploy rather than a
standing preference — for example wanting one deploy to go through the same
layer as the last one while investigating something. It is deliberately
per-deploy: pass it again next time, or stop passing it and let the flip
happen.

**It is not a way to keep a broken type on Cloud Control.** A type admitted
because Cloud Control *cannot* manage it (`'cc-broken'`, e.g.
`AWS::Scheduler::Schedule`) ignores the pin — honoring it would re-pin the
resource to the handler that cannot address it, which is the bug the exemption
exists to escape.

It also has no effect on a resource already recorded `'sdk'`, and none on a
fresh resource, which routes by the ordinary matrix.

**A logical id present in no stack of the run is an error, not a no-op.** The
flag produces no output when it works, so a typo would otherwise give you
exactly the routing change you passed it to decline, indistinguishable from
success. The check is run-level rather than per-stack on purpose: under
`--all`, an id that belongs to one stack is legitimately absent from the
others, and failing per-stack would abort the run over a correct invocation.
It is raised before any stack deploys.

`--pin-cc-api X` together with `--recreate-via-sdk-provider X` is refused —
they are opposite requests for the same resource.

Under `--all`, an id that applies to some stacks but not all is reported once,
naming both the stacks it applies to and the ones that do not declare it — so
you can see the flag's reach without a line per non-matching stack.

A resource inside a NESTED child stack cannot be pinned from the parent's
deploy; name it in a deploy of that child. And the pin does not apply to a
REPLACEMENT: when a template change forces a destroy + recreate, the new
resource routes by the ordinary matrix — the stickiness the pin declines exists
to spare an EXISTING resource from churn, and a replacement is not that.

Contrast with the two `--recreate-via-*` flags above: those DESTROY and
recreate to change layer, so they are the heavy option and refuse a stateful
type without `--force-stateful-recreation`. This flag changes nothing about the
resource — only which provider issues its update.

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

A rename through a nested name takes the same path. None of `TableInput.Name`
(`AWS::Glue::Table`), `DatabaseInput.Name` (`AWS::Glue::Database`) or
`ConnectionInput.Name` (`AWS::Glue::Connection`) is create-only, so a change
diffs as an in-place UPDATE, which the provider refuses: `UpdateTable`
addresses a table by its new name, so the update would rewrite a different
table. A table or database is stateful, so its rename also needs
`--force-stateful-recreation`. The replacement deletes the old resource before
it creates the renamed one (unless `UpdateReplacePolicy: Retain` keeps it), so
if a resource with the new name exists, the create fails after the delete.

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

`cdkd rollback` raises `NAMED_REPLACEMENT_COLLISION` too, and neither column
above applies there — `--replace` is a deploy flag. A rollback reversing a
replacement re-creates the old resource, and when the resource the replacement
created declares `UpdateReplacePolicy: Retain`, cdkd will not delete that
pinned copy to free the name. The op fails with the journal kept, so the revert
resumes once you delete the new resource yourself or drop the policy; to leave
that one resource alone and let the rest of the rollback finish, re-run with
`cdkd rollback --orphan '<logicalId>'`. See
[cli-rollback.md](cli-rollback.md#reversing-a-replacement).

The resource is briefly unavailable while it is deleted and recreated. The
alternative remedy in both messages is to rename the resource so the
create-first order has a free name to take.

`UpdateReplacePolicy: Retain` hard-fails in both shapes **regardless of
`--replace`**: with Retain the old resource keeps the name, so a same-name
replacement can never proceed. The same two shapes, and the same two error
codes, are reachable from the update-failure fallback covered below — under
`Retain` that path also creates first, so it inherits the same constraint.

### The stateful guard on this path

`--replace` shares the [stateful-resource guard](#stateful-resource-guard):
when the replacement target is a stateful type, the DELETE + CREATE loses all
its data, so cdkd refuses unless `--force-stateful-recreation` is also passed.
The details that matter here:

- **The guard is evaluated mid-deploy**, at the moment the immutable-update
  rejection is caught — not at pre-flight, as it is for the `--recreate-via-*`
  flags. The error names the resource and the data-loss reason.
- **Every `AWS::S3::Bucket` counts as stateful here**, empty or not, and so
  does every `AWS::Logs::LogGroup` that is not already stateful from its
  recorded retention. There is no opportunity mid-deploy to run the emptiness
  probes the pre-flight path uses, so cdkd assumes both hold data. That applies
  to **both** triggers this section covers, not only the `--replace` opt-in:
  replacing either needs `--force-stateful-recreation` whether you passed
  `--replace` or the Cloud Control auto-fallback took you there on a plain
  `cdkd deploy` — unless the resource declares `UpdateReplacePolicy: Retain`,
  which exempts both triggers because the old resource survives (see below).
- **The Cloud Control `UnsupportedActionException` auto-fallback is guarded on
  the same terms.** That fallback still needs no flag to REACH the replacement
  — when AWS rejects the in-place update because the type has no Cloud Control
  UPDATE handler, cdkd replaces the resource on a plain `cdkd deploy`. But a
  **stateful** target on that path now requires `--force-stateful-recreation`
  too, exactly as the `--replace` opt-in does. Which of the two triggers fired
  no longer decides whether the guard runs: the discriminator used to be the
  provisioning layer a type happens to route through, which cdkd re-decides
  every deploy. The error names the trigger the user actually hit rather than
  `--replace`, which does not gate this path:

  ```text
  MyTable (AWS::DynamoDB::Table) cannot be updated in place by the provisioning
  layer it routes through, so applying this change would DELETE + CREATE it —
  but it is a stateful resource: destroy loses all data in the resource. Re-run
  with --force-stateful-recreation to confirm the data loss, or change the
  resource definition to avoid the update.
  ```

  `UpdateReplacePolicy: Retain` **is** an exemption on both of the triggers
  this section covers, exactly as it is for the property-driven replacement
  described below. Under `Retain` the replacement becomes create-ONLY: cdkd
  leaves the old physical resource in place — orphaned, with its data, and no
  longer tracked in state, so it keeps incurring cost and `cdkd destroy` will
  not remove it; delete it yourself once you no longer need the data — and only
  creates the new one. Nothing is destroyed,
  so there is no data loss for `--force-stateful-recreation` to confirm, and
  the flag is not required. It is also not an override: passing it does **not**
  make cdkd delete a resource the template asked to keep.

  Retaining means the replacement create runs beside the live old resource, so
  it cannot reuse a physical name that resource still holds. Both shapes of
  that collision hard-fail, with the same error codes the property-driven path
  uses (see [Same-name replacement](#same-name-replacement-delete-first-ordering)):

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

  Retaining leaves a resource cdkd no longer tracks, so the replacement reports
  itself as a **partial** update rather than a clean one: the row prints
  `partial (…)`, the run summary counts it under "of which left an orphaned
  predecessor", `cdkd events` records the survivor's physical id, and — **for a
  top-level stack** — the deploy exits 2 unless you pass `--allow-unaddressed`.
  Nothing will retry it — state points at the replacement — so deleting the
  survivor is yours to do.

  **Known limitation — nested stacks.** The exit code covers top-level stacks
  only. A resource retained inside a nested stack still prints its warning and
  its `partial (…)` row, but a child stack's counters do not reach the parent
  run, so the deploy exits `0` with the survivor alive. This is not specific to
  `Retain` — it applies to every unaddressed resource inside a nested stack.
  Until it is fixed, read the per-resource warnings rather than the exit code
  when your app uses nested stacks.

  This path previously deleted the old resource whatever the policy said, and
  its refusal appended a note stating so. Both are gone: a resource explicitly
  marked to survive its replacement is no longer destroyed by the
  update-failure fallback.

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

As with `--replace`, this mid-deploy check treats every `AWS::S3::Bucket` and
every `AWS::Logs::LogGroup` as stateful — neither emptiness probe can run here.
Non-stateful types still replace freely on a plain `cdkd deploy` with no flag.

### Type changes on an existing logical id

Changing a resource's `Type` while keeping its logical id is a replacement too,
and always one: it is never applied as an in-place update, and never skipped as
"no changes" even when the two types declare identical properties. The two
halves of that replacement involve two different types, so cdkd routes each on
its own:

- The **existing resource** is deleted through the provider of the type cdkd
  **recorded** for it, on the provisioning layer it was created through.
  Everything that decides whether that delete may happen evaluates the recorded
  type as well — the stateful guard above, so leaving an `AWS::SSM::Parameter`
  for an `AWS::SNS::Topic` needs `--force-stateful-recreation` and the reverse
  does not, and `UpdateReplacePolicy: Snapshot`.
- The **new resource** is created through the provider of the type the
  **template** declares, with a fresh routing decision.

Two physical ids that happen to be equal across the two types — an SSM parameter
and a log group can share a bare name — are treated as two resources. The
exception is a change between two custom resource types (`Custom::*`,
`AWS::CloudFormation::CustomResource`), whose handler picks the id: there an
equal id is the existing resource, and the replacement is refused with
`NAMED_REPLACEMENT_IDEMPOTENT_CREATE` rather than deleting what it just created
(`--replace` deletes the old resource first instead, as for any name-idempotent
create).
When the new resource's create collides on a name instead, the error says that
the holder may be an unrelated resource of the new type, which `--replace`
cannot free.

`cdkd rollback` and the automatic rollback reverse such a replacement the same
way: the old resource is re-created through its own type's provider and the new
one deleted through its own. A rollback journal written by an older cdkd names
only the new type on the operation, so the old type is read from the previous
resource record the journal also carries. When a journal names no old type at
all, or names two different ones, that one operation is refused with
`ROLLBACK_REPLACEMENT_UNROUTABLE` and the journal is kept; fix forward with
`cdkd deploy`, or pass `--orphan <LogicalId>` to leave the resource as it is and
let the rest of the rollback proceed.

### Type changes into or out of a nested stack (`TYPE_CHANGE_NESTED_STACK`)

One type pair is refused rather than replaced. A nested stack's row owns a whole child stack —
its own state record at `<stack>~<logicalId>` and every resource in it — and a
replacement deletes its old half as a best-effort cleanup step whose failure is
only a warning. For a single resource that strands one resource; for a nested
stack it would strand a child stack under a deploy that reports success.

So a plain `cdkd deploy` (and `cdkd deploy --dry-run`) **refuses**, before any
resource is touched, when a logical id's recorded type and its template type
differ with `AWS::CloudFormation::Stack` on either side:

```text
Refusing to deploy MyStack: a resource changes its Type into or out of AWS::CloudFormation::Stack, which cdkd does not replace in place (issue #2668).
  - Thing: Type changes from AWS::SNS::Topic to AWS::CloudFormation::Stack (the existing AWS::SNS::Topic is arn:aws:sns:us-east-1:111122223333:thing).
    Replacing a single resource BY a nested stack is not supported: ...
```

There is no flag that overrides this refusal. Deploy the change as two changes
instead: give the new resource a **different logical id** (in CDK, rename the
construct) so the old row is deleted through its own type's provider, or remove
the resource in one deploy and add its replacement in the next. A rollback
journal from an older cdkd that recorded such a change is refused per operation
in the same way as an unroutable one above.

`--recreate-via-cc-api` / `--recreate-via-sdk-provider` refuse a nested stack's
own row for the same reason; see [Nested stacks](#nested-stacks).

### Cyclic nested templates are refused

Each nested child template is located through its parent row's
`Metadata['aws:asset:path']`. Right after synthesis, `cdkd deploy` walks every
nested template reachable from each stack it is about to deploy, and refuses
when a path resolves to a template already on the same nesting chain:

```text
SynthesisError: The nested template tree under stack Parent contains a
cycle: Child (/path/to/cdk.out/child.json) -> Loop
(/path/to/cdk.out/child.json). Nested stack Loop (declared in stack
Parent~Child) resolves to a template that is already on that nesting chain,
so its Metadata['aws:asset:path'] closes a cycle. CDK emits an acyclic nested
template tree with relative asset paths, so this indicates the synth output was
hand-modified or generated by a non-CDK toolchain. Refusing to start the
deploy; nothing has been published or provisioned.
```

CDK emits an acyclic tree, so a well-formed `cdk.out` never reaches this. The
refusal covers a hand-modified or non-CDK-generated assembly.

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

The same walk refuses an `aws:asset:path` that resolves **outside** the
directory its template sits in — `path.join` folds `..`, so `../../etc/passwd`
would otherwise be read and deployed as a nested template:

```text
SynthesisError: The nested template tree under stack Parent has nested stack
Child (reached through Child (/path/to/cdk.out/child.json)) with
Metadata['aws:asset:path']=../../etc/passwd which resolves to
/etc/passwd, outside /path/to/cdk.out. CDK emits assembly paths that stay
inside the assembly directory; one that leaves it indicates the synth output
was hand-modified or generated by a non-CDK toolchain. Refusing to start the
deploy; nothing has been published or provisioned.
```

A path that stays inside the directory only until a symbolic link is followed
is refused the same way, naming the link's target — including a link whose
target does not exist yet, since a write follows such a link and creates the
file where it points. Every other assembly-supplied path is held to the same
rule wherever cdkd turns one into a file it reads, publishes or writes:

| Where it comes from | What cdkd would otherwise do with it |
| --- | --- |
| a nested assembly's `directoryName` | read that directory's `manifest.json` |
| a stack's `templateFile` | deploy whatever parses as its template |
| an asset manifest's `file` | read the list of assets to publish |
| a file asset's `source.path` | zip it and upload it to the bucket the manifest names |
| a Docker asset's `source.directory` | send it to the image build as the context |
| a stack's metadata side file | read its annotations |
| a stack name, under `cdkd synth --verbose` | write `<name>.template.json` there |

The asset rows are the reason this matters beyond a misleading error: the
destination bucket is named by the same manifest, so an escaping `source.path`
would upload a file from outside the assembly using your credentials. The last
row is the only one that WRITES.

**The two asset rows are measured against the app's output directory, not the
manifest's own.** A `Stage`'s assets are staged into the app's `cdk.out` while
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
upload it to a bucket that same manifest names, using your credentials. So the
line is worth reading, and it is deliberately rare:

| Value | What cdkd does |
| --- | --- |
| absolute, inside the output directory | accepted, silently — this is where every staged asset is |
| absolute, outside it | accepted, **with a warning** naming the directory and the destination |
| naming the output directory *itself*, by any spelling | accepted, **with a warning** — the whole assembly becomes the asset, and no `cdk synth` emits this |
| relative, escaping the output directory | refused |

"By any spelling" is meant literally: a symbolic link to the output directory,
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

One consequence of measuring against the app's output directory: pointing `-a`
at a Stage SUB-assembly (`cdkd deploy -a cdk.out/assembly-MyStage`) refuses that
Stage's own `../asset.<hash>`, because the assembly you named really does end
where you said it does and the asset really is outside it. Point `-a` at the
app's `cdk.out` and select the stack by its display path
(`cdkd deploy 'MyStage/*'`) instead.

## A pre-synthesized assembly is trusted input

The containment rules above cover the paths in that table and no others. The
rest of an asset manifest is forwarded **as the manifest writes it**, and cdkd
does that deliberately, matching the CDK CLI. What it will not do is stay quiet
about it:

| Manifest value | What cdkd does with it | When it warns |
| --- | --- | --- |
| `source.executable` | **runs it on this machine** — an arbitrary command line | on every command that builds a Docker asset, naming the command |
| `dockerFile`, `dockerBuildContexts`, `dockerBuildSecrets`, `dockerBuildSsh`, `cacheFrom`, `cacheTo` | reads that host path during the image build | when the path is outside the output directory; a path inside the build context is usually left quiet |
| a `dest=` in `dockerOutputs` or a cache option | **writes** to that host path | when the path is outside the output directory, wherever the build context is |
| `dest.bucketName`, the ECR repository | uploads there with your credentials | when the name is neither CDK-bootstrap-shaped nor cdkd-managed, once per name |

The read/write split follows the `dest=` key, not the field: a `cacheFrom`
carrying a `dest=` is a write and a `cacheTo` carrying a `src=` is a read.

**Two of those are worth stating plainly.** Deploying from a pre-synthesized
assembly *does* execute code from it, because a Docker asset may declare
`source.executable` instead of a Dockerfile — so an assembly is not only data.
Every `cdkd local` command that builds such an asset runs it too, and every one
of them prints the line first. And a build secret, an SSH key or a cache
directory is a host path the CloudFormation template never shows, so reading
the template is not enough to know what a deploy will touch.

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

**A refusal raised while reading a `Stage` stops the command, as the same
refusal does at the top level.** Reading a Stage stays tolerant in exactly one
place: when the Stage's own `manifest.json` cannot be read at all — the Stage
was never synthesized — cdkd warns, continues, and the stacks under that Stage
are simply not in the assembly. Because those stacks then cannot be selected,
naming one afterwards reports the Stage rather than answering "no stacks
matching":

```
No stacks matching MyStage/Api found in assembly. Available: TopStack. Stage
MyStage failed to load, so stacks under it are missing from this list rather
than missing from the app: ENOENT reading assembly-MyStage/manifest.json
```

The same sentence is appended when the app has no other stacks to list, and
when you run with no stack argument at all — the case where every stack in the
app lives under the Stage that failed.

A pattern without a `/` matches the physical stack name, which carries no stage
path, so the sentence is then prefixed `Possibly unrelated:` rather than
claimed as the explanation.

Every other refusal under a Stage — an escaping or absent `templateFile`, an
unreadable template, an escaping asset manifest, an absolute `aws:asset:path` —
aborts the run, with the Stage named ahead of the refusal
(`Stage MyStage: Stack MyStage-Api ...`). For a Stage inside a Stage, the
innermost one is named.

Two sibling rows naming the **same** template are fine — that is a shared child,
not a cycle. Only a repeat along one root-to-child path is refused, so the
cycle rule itself never limits nesting depth. A row's `Condition` is not evaluated: a template
that includes itself behind a condition is refused too, as it is by
[`cdkd diff --recursive`](cli-diff.md#cyclic-nested-templates-are-refused).

## Stateful-resource guard

Destroying and recreating most resource types loses nothing — an IAM role or a
Lambda function comes back identical. For **data-bearing** types the destroy
loses everything in the resource: rows in a DynamoDB table, objects in an S3
bucket, log lines in a log group, images in an ECR repository. AWS does not
migrate any of it to the replacement.

So cdkd refuses to destroy-and-recreate a stateful resource unless
`--force-stateful-recreation` is passed. On the paths you reach by asking for a
replacement — `--recreate-via-cc-api`, `--recreate-via-sdk-provider`,
`--replace` — that is a second flag beside the first, mirroring
[`--remove-protection`](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy)
on destroy. On the rest it is the **only** flag: a plain `cdkd deploy` can reach
a replacement on its own, and then this is what it asks for.

Every path that consults this guard:

| Path | When the guard runs |
| --- | --- |
| `--recreate-via-cc-api` | Pre-flight, before any resource is touched |
| `--recreate-via-sdk-provider` | Pre-flight, before any resource is touched |
| `--replace` | Mid-deploy, when the immutable-update rejection is caught |
| Cloud Control `UnsupportedActionException` auto-fallback | Mid-deploy, when AWS rejects the in-place update — no flag needed to reach it |
| Property-driven replacement on a plain `cdkd deploy` | Mid-deploy, from the diff |

### Deletion protection blocks a replacement, and deploy cannot clear it

`--force-stateful-recreation` clears cdkd's own data guard. It does not clear
AWS's: a resource carrying a deletion-protection flag refuses every deletion
operation until the flag is turned off, and a replacement is a delete plus a
create.

`cdkd destroy --remove-protection` exists for that on the destroy side.
**`cdkd deploy` has no `--remove-protection`**, so a deploy-side replacement of a protected
resource fails at the delete, whatever combination of replace flags was passed.
Turn protection off first, then re-run the deploy:

```bash
# CloudWatch Logs — the log group whose LogGroupClass you are changing
aws logs put-log-group-deletion-protection \
  --log-group-identifier /my/log/group --no-deletion-protection-enabled

cdkd deploy MyStack --replace --force-stateful-recreation
```

Clearing the flag from the template in the SAME deploy does not work where cdkd
refuses the change before it applies any property — the `AWS::Logs::LogGroup`
`LogGroupClass` guard is one such refusal. That route takes two deploys: one
that turns protection off with the immutable-property change reverted, then one
that re-applies it with the replace flags.

Six types name this dead end explicitly in their own refusals, each reading its
own protection property and naming the command that turns it off:
`AWS::Logs::LogGroup`, `AWS::ElasticLoadBalancingV2::LoadBalancer`,
`AWS::EMR::Cluster`, `AWS::Cognito::UserPool`, `AWS::DynamoDB::GlobalTable` and
`AWS::AutoScaling::AutoScalingGroup`. Every one of them knows only what cdkd
RECORDED: protection you enabled out of band is in no state record, so such a
resource gets the shorter message and still fails at the delete. The same wall
stands in front of every type in
[`--remove-protection`'s table](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy)
whenever a deploy has to replace one, whether or not its refusal says so.

`AWS::AutoScaling::AutoScalingGroup` is the one whose refusal is narrower than
the type's protection setting, and deliberately: the group's three levels are
`none`, `prevent-force-deletion` and `prevent-all-deletion`, and only the last
blocks a replacement, because the deploy path's delete does not pass
`ForceDelete`. At `prevent-force-deletion` there is nothing to disable.

`AWS::Cognito::UserPool` is the one exception to the two-deploys rule below.
Its refusal fires AFTER `UpdateUserPool` has already applied the template's
`DeletionProtection`, so clearing it in the template DOES take effect in that
same (failed) deploy — the next run with the replace flags then succeeds. Its
refusal reads the desired value first for exactly that reason. Do not
generalize it: every other type above refuses before applying anything.

You are disabling protection on the resource that is about to be **deleted**,
not on the one you end up with: every replacement path re-creates from your
template, so the new resource gets whatever protection flag the template
declares — and none, if the template declares none. There is nothing to restore
afterwards on that path, and correspondingly, if you turn protection back on by
hand you create drift against a template that says otherwise.

Two cases break that, and both are worth checking before you disable anything.

**If the deploy does not complete, the flag stays off — and cdkd will not
notice.** cdkd diffs your template against its state record; both still say
protection is on, so no later `cdkd deploy` ever issues the flip. Only
[`cdkd drift`](cli-drift.md) surfaces it, and `cdkd drift --revert` restores it.
Disable immediately before the deploy, not as a separate earlier step.

**Under `UpdateReplacePolicy: Retain`, do not disable it at all.** A retaining
replacement does not delete the old resource ([above](#replace-deploy)), so
protection was never going to block anything — the disable buys you nothing.
Worse, when the replacement would land on the **same physical name** — the case
for `AWS::Logs::LogGroup`, whose only replacement-triggering property is
`LogGroupName` — the retaining replacement cannot complete either. cdkd refuses
it, with `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` when the create is idempotent and
returns the existing resource's id, or `NAMED_REPLACEMENT_COLLISION` when AWS
rejects the duplicate name outright. You end up with the original resource, its
protection stripped by hand, and the **immutable** change still unapplied — a
mutable property in the same deploy may well have landed. Remove the `Retain`
policy, or revert the immutable change.

### Always-stateful types

Destroy loses all data for these, unconditionally.

| Category | Types |
| --- | --- |
| Database | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::RDS::DBSnapshot`, `AWS::RDS::ClusterSnapshot`, `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::DocDBElastic::Cluster`, `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::NeptuneGraph::Graph`, `AWS::NeptuneGraph::GraphSnapshot`, `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable`, `AWS::DynamoDB::Backup`, `AWS::Cassandra::Table`, `AWS::Lightsail::Database`, `AWS::Timestream::Database`, `AWS::Timestream::Table`, `AWS::Timestream::InfluxDBCluster`, `AWS::Timestream::InfluxDBInstance`, `AWS::ODB::CloudVmCluster`, `AWS::ODB::CloudAutonomousVmCluster` |
| Data warehouse | `AWS::Redshift::Cluster`, `AWS::RedshiftServerless::Namespace`, `AWS::RedshiftServerless::Snapshot` — the namespace owns the databases and a snapshot is a copy of them |
| In-memory data store | `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::ReplicationGroup`, `AWS::ElastiCache::ServerlessCache`, `AWS::MemoryDB::Cluster`, `AWS::MemoryDB::MultiRegionCluster` |
| Filesystem / blob | `AWS::EFS::FileSystem`, `AWS::FSx::FileSystem`, `AWS::FSx::Volume`, `AWS::ECR::Repository`, `AWS::ECR::PublicRepository`, `AWS::EC2::Volume`, `AWS::WorkspacesInstances::Volume`, `AWS::S3Express::DirectoryBucket`, `AWS::Lightsail::Bucket`, `AWS::S3Outposts::Bucket`, `AWS::HealthImaging::Datastore`, `AWS::HealthLake::FHIRDatastore` |
| Table / vector storage | `AWS::S3Tables::TableBucket`, `AWS::S3Tables::Table`, `AWS::S3Vectors::VectorBucket`, `AWS::S3Vectors::Index` — deleting a table bucket or a vector bucket empties it first, with no opt-in; a namespace is not guarded, see below |
| Managed compute with local storage | `AWS::EMR::Cluster` — terminating the cluster destroys the HDFS volumes on its core nodes, and the replacement comes back empty. `AWS::EKS::Cluster` for the same reason one level up: the etcd store behind it holds every Kubernetes object the user created, and nothing in the template describes it. `AWS::SageMaker::Cluster` carries local and tiered storage holding training checkpoints |
| Streaming / messaging | `AWS::Kinesis::Stream`, `AWS::KinesisVideo::Stream`, `AWS::MSK::Cluster`, `AWS::MSK::ServerlessCluster`, `AWS::MSK::Channel`, `AWS::AmazonMQ::Broker`, `AWS::OSIS::Pipeline`, `AWS::Events::Archive` — each retains records on its own storage rather than passing them straight through |
| Search / index / collection | `AWS::Elasticsearch::Domain`, `AWS::OpenSearchService::Domain`, `AWS::OpenSearchServerless::Collection`, `AWS::OpenSearchServerless::Index`, `AWS::OpenSearchServerless::CollectionIndex`, `AWS::Kendra::Index`, `AWS::QBusiness::Index`, `AWS::QBusiness::Application`, `AWS::Rekognition::Collection`, `AWS::Location::GeofenceCollection`, `AWS::Bedrock::KnowledgeBase`, `AWS::Bedrock::DataAutomationLibrary` — the indexed documents, face vectors and geofences are written through the service API, never from the template |
| Analytics pipelines | `AWS::IoTAnalytics::Channel`, `AWS::IoTAnalytics::Datastore`, `AWS::IoTAnalytics::Dataset`, `AWS::CleanRooms::IdMappingTable`, `AWS::CleanRooms::IntermediateTable` |
| Identity / config | `AWS::Cognito::UserPool`, `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter`, `AWS::AppConfig::ConfigurationProfile` — a profile whose location is `hosted` owns its configuration versions |
| Runtime-written stores | `AWS::CloudFront::KeyValueStore`, `AWS::Connect::DataTable` — seeded from the template at most once, then written through the service API |
| Backup vaults | `AWS::Backup::BackupVault`, `AWS::Backup::LogicallyAirGappedBackupVault` — a vault holds the recovery points, the data whose whole purpose is to outlive the resource it was taken from |
| Service domains holding records | `AWS::Cases::Domain`, `AWS::CustomerProfiles::Domain`, `AWS::DataZone::Domain`, `AWS::SageMaker::Domain` — these hold cases, profiles, a catalog and every user's home directory |
| Encryption keys | `AWS::CloudHSM::Cluster` — deleting the cluster destroys the key material inside it, and every ciphertext produced under those keys with it. `AWS::KMS::Key` — the delete schedules the key for deletion, and once the window elapses every ciphertext encrypted under it is unrecoverable, including data in other stacks that merely reference the key. `AWS::KMS::ReplicaKey` is guarded on the same terms, though whether a destroyed replica's ciphertexts survive through another key in its multi-region set is unmeasured, so the guard assumes they do not |
| Source control / artifacts | `AWS::CodeCommit::Repository` — the delete destroys the repository's entire git history. `AWS::CodeArtifact::Repository` holds the packages, and `AWS::CodeArtifact::Domain` is not a mere grouping: it owns the deduplicated asset storage every repository in it references |
| Metadata catalog | `AWS::Glue::Database`, `AWS::Glue::Table` |
| Retained records | `AWS::IoTSiteWise::Workspace` — guarded on an open question: AWS makes encryption at rest required on it, but whether deleting one cascades to the datasets inside is unmeasured. `AWS::AIOps::InvestigationGroup`, `AWS::SES::MailManagerArchive` — both retain content for a configured period. `AWS::Rbin::Rule` joins them on the fail-safe side of an open question: the rule itself is fully template-declared, but what happens to the snapshots and AMIs already sitting in the Recycle Bin under it when it is deleted is unmeasured |
| Edge / identifier immutability | `AWS::CloudFront::Distribution` — the URL changes, which breaks consumers, and propagation takes roughly 20 minutes. `AWS::SMSVOICE::PhoneNumber` and `AWS::SMSVOICE::SenderId` are the same class: a release returns the identifier to the pool, the replacement gets a different one, and the original may be unobtainable |

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
  proposal in neither fails the build. Most of the table above joined this way.

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
when the create collides) fails at that delete instead.

Replacing a type in the table above asks for `--force-stateful-recreation`.
The guard list widens over time and always in that direction; see
[the changelog](changelog-cdkd.md) for when each type joined.

### Conditionally stateful types

These types carry a CONDITION instead of being unconditionally stateful. The
condition is what the guard evaluates; it is not a promise that a type failing
it holds no data.

| Type | Guard fires when | Guard does not fire when |
| --- | --- | --- |
| `AWS::S3::Bucket` | The bucket has at least one current version, prior version, or delete-marker, or the probe page was truncated | The bucket is provably empty — but see the per-path note below |
| `AWS::Logs::LogGroup` | `RetentionInDays > 0` in EITHER of cdkd's two recorded property bags, or the log group has at least one log stream | Neither bag records a positive retention AND the log group has no log streams — but see the per-path note below |

**Retention is not an emptiness signal.** An unset or zero `RetentionInDays`
is CloudWatch Logs' **never expire** setting — the most data-bearing
configuration the type has, and the one cdkd records as `0`. It used to be read
as "nothing to lose", so a never-expiring log group renamed in the template was
destroyed on a plain `cdkd deploy` with no consent flag. An unset retention now
DEFERS instead: at pre-flight the emptiness probe below decides, and mid-deploy,
where no probe can run, the log group counts as stateful.

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

### How the conditional types are judged, per path

The two guard timings answer the emptiness question differently, and the
difference is what decides whether you need `--force-stateful-recreation` for a
bucket or a log group.

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

**Mid-deploy** — `--replace`, property-driven replacement, and the Cloud
Control `UnsupportedActionException` auto-fallback, which a plain `cdkd deploy`
reaches with no flag — there is no opportunity to run either probe, so cdkd
assumes the resource has data. Every bucket and every log group needs
`--force-stateful-recreation` on those paths — a recorded `RetentionInDays > 0`
(in either bag) does not exempt a log group there, it is simply a second reason
the same guard fires. The one exemption on all three is `UpdateReplacePolicy: Retain`: the old
resource survives the replacement, so there is no data loss to confirm and the
flag is not required (and does not override the policy).

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
cdkd first re-reads the resource's attributes from AWS once — a state record
written by an older release, or before AWS assigned the value, can simply lack
one — and uses and records the value when the read supplies it (see
["Cannot resolve" a GetAtt on a resource an older cdkd deployed](troubleshooting.md#cannot-resolve-a-getatt-on-a-resource-an-older-cdkd-deployed)).
Otherwise it falls back to the resource's **physical ID**. What happens next
depends on whether the fallback value is knowably wrong for the attribute's
name:

| Attribute name | Fallback value | Result |
| --- | --- | --- |
| Ends in `Arn` | Not `arn:`-shaped | Deploy fails, naming the resource, attribute, and an issue link |
| Ends in `Url` | Not an http(s) URL | Deploy fails, naming the resource, attribute, and an issue link |
| Any other suffix | Any | Warn `Unknown attribute X for resource type Y, returning physical ID` and continue |

The hard-fail rows apply to the resolver's final unknown-type fallback and to
every per-type handler's unknown-attribute default branch. Other suffixes only
warn because an alias or an endpoint is shape-indistinguishable from a plain
name, so hard-failing there would fail correct deploys.

Four further rules round out the default:

- **An attribute cdkd reads live never falls back to the physical ID.** A
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
  `--no-wait` section of [`cdkd deploy`](cli-deploy.md#what-a-second-deploy-started-too-early-runs-into)
  says what the refusal does in a resource property versus an Output.
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
| `of which left an orphaned predecessor: N` | A replacement the provider performed INSIDE its own `update()` whose old resource it could not retire, or an update-failure replacement where `UpdateReplacePolicy: Retain` said not to delete it | **No.** State now points at the replacement, so the survivor is untracked — delete it by hand |

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
- [Supported Resources](supported-resources.md) — the per-type tier table and property-level coverage
- [Cross-Stack References](cross-stack-references.md) — the full design behind `--no-cfn-fallback`
- [cdkd State Management Specification](state-management.md) — where `provisionedBy` lives in the state record
