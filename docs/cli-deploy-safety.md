---
title: "Deploy: safety & compatibility flags"
description: "What cdkd deploy refuses by default, whether your data is at risk when it does, and the flag that gets each refusal through."
---

# Deploy: safety & compatibility flags

`cdkd deploy` refuses a few things up front instead of failing halfway or
losing data: an unsupported resource type, a replacement that would delete a
database, a name that is already taken. This page says what each refusal means,
which flag gets you through, and what that flag costs. The other deploy flags
are under [Deploy: waits & concurrency](cli-deploy.md) and
[Deploy: tuning](cli-deploy-tuning.md).

```bash
cdkd deploy MyStack --replace --yes                         # replace what AWS cannot update in place
cdkd deploy MyStack --replace --force-stateful-recreation   # same, and accept the data loss
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes    # destroy + recreate one resource via Cloud Control
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh
cdkd deploy MyStack --strict-getatt                         # fail on any guessed Fn::GetAtt value
cdkd deploy --require-approval=destructive                  # ask before replacing or deleting anything
```

## When a deploy is refused

Find the refusal in the first column. In each of them the resource the message
names has not been deleted.

| The deploy says | What it means | Your data | Way through |
| --- | --- | --- | --- |
| `The following resource types are not supported by cdkd` | AWS cannot manage the type through Cloud Control and cdkd has no provider for it | Untouched | [`--allow-unsupported-types`](#allow-unsupported-types-deploy-destroy) |
| `STATEFUL_REPLACE_BLOCKED`, or `requires replacement ... but it is a stateful resource` | A template change replaces a data-bearing resource | Lost if you proceed | [`--force-stateful-recreation`](#force-stateful-recreation), or `UpdateReplacePolicy: Retain` |
| `cannot be updated in place by the provisioning layer` | The update was rejected, the fallback is a replacement, and the resource is data-bearing | Lost if you proceed | [`--force-stateful-recreation`](#force-stateful-recreation) |
| `ResourceUpdateNotSupportedError` | An immutable property changed on a type AWS has no update API for | Lost only for a stateful type | [`--replace`](#replace-deploy) |
| `NAMED_REPLACEMENT_COLLISION`, `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` | The replacement cannot be created while the old resource holds the name | A short outage; lost for a stateful type | [`--replace`](#same-name-replacement-delete-first-ordering), or rename the resource |
| `NAMED_CREATE_COLLISION` | A resource with that explicit name already exists | Untouched | Delete it or [adopt it](#a-create-under-a-name-that-is-already-taken) |
| `CREATE_ONLY_DROP_NEEDS_REPLACEMENT` | A create-only property that `--prefer-sdk-route` kept off AWS now needs a replacement | Lost only for a stateful type | [`--recreate-via-cc-api`](#create-only-drop-needs-replacement) or `--replace` |
| `TYPE_CHANGE_NESTED_STACK` | A logical id changes type into or out of a nested stack | Untouched | No flag: [use a new logical id](#type-changes-into-or-out-of-a-nested-stack-type-change-nested-stack) |
| AWS refuses the delete of a protected resource | Deletion protection is on, and deploy cannot turn it off | Untouched | [Turn protection off](#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it), then re-run |
| Exit `2` with `Skipped (not deleted)` or `orphaned predecessor` | The deploy finished and left a resource alive | Still in AWS | [`--allow-unaddressed`](#allow-unaddressed-deploy) for the exit code |

Most of these are one question: the deploy has to delete a resource and create
a new one, and cdkd will not do that to a data-bearing resource without being
told. The [stateful-resource guard](#stateful-resource-guard) decides it like
this for a replacement that a template change or a rejected update causes:

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

## Options

| Flag | Applies to | Description |
| --- | --- | --- |
| `--allow-unsupported-types <types>` | deploy, destroy, state destroy | Attempt a resource type cdkd rejects at pre-flight as unsupported. |
| `--prefer-sdk-route <entries>` | deploy | Keep a resource on cdkd's SDK provider and accept that the named property is not written to AWS. |
| `--recreate-via-cc-api <LogicalId>` | deploy | Destroy and recreate one resource through Cloud Control API. |
| `--recreate-via-sdk-provider <LogicalId>` | deploy | Destroy and recreate one resource through cdkd's SDK provider. |
| `--pin-cc-api <LogicalId>` | deploy | Keep one resource on Cloud Control for this deploy when it would return to the SDK provider. |
| `--replace` | deploy | Replace (DELETE + CREATE) a resource whose in-place update AWS has no API for. |
| `--force-stateful-recreation` | deploy | Confirm the data loss when any replacement in the run targets a [stateful resource](#stateful-resource-guard). |
| `--strict-getatt` | deploy | Fail on any `Fn::GetAtt` that falls back to a physical ID, and on any unresolvable Output. |
| `--allow-unaddressed` | deploy | Exit 0 instead of 2 when the deploy left a resource alive that it no longer tracks. |
| `--no-cfn-fallback` | deploy, diff | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. |
| `--require-approval <level>` | deploy | Ask before deploying a stack with any change (`any-change`) or a destructive one (`destructive`). Default `never`. |

## Which routing flag, when

Four flags decide which provisioning layer manages a resource: cdkd's SDK
provider or the Cloud Control API. Most deploys need none of them, because cdkd
picks the layer itself.

| You want | Flag | Cost |
| --- | --- | --- |
| A property the SDK provider does not write to reach AWS | None. cdkd routes the resource through Cloud Control | None; updated in place |
| To stay on the SDK provider and go without that property | [`--prefer-sdk-route`](#prefer-sdk-route-deploy) | The property is missing in AWS |
| To move a resource to Cloud Control when the in-place route cannot | [`--recreate-via-cc-api`](#recreate-via-cc-api-deploy) | Destroy and recreate: downtime, and data loss for a stateful type |
| To move a resource back to the SDK provider | [`--recreate-via-sdk-provider`](#recreate-via-sdk-provider-deploy) | Destroy and recreate, as above |
| To hold a resource on Cloud Control for one deploy | [`--pin-cc-api`](#pin-cc-api-deploy) | None; the resource is not touched |

[Provisioning Layers](provisioning-layers.md) explains the two layers and how
cdkd picks between them.

## `--allow-unsupported-types` (deploy + destroy)

cdkd rejects an unsupported resource type at pre-flight, before any resource is
touched. A type is unsupported when AWS reports it as `NON_PROVISIONABLE`
(Cloud Control cannot create, update or delete it) and cdkd has no SDK provider
for it. The error names each type and the re-run command:

```text
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

The flag takes a comma-separated, repeatable list of types and attempts each
through Cloud Control anyway. Pass the same list to `cdkd destroy` or
`cdkd state destroy` to tear the stack down.

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
cdkd destroy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
```

Cloud Control will likely still fail for these types. The flag helps when AWS
has made a type provisionable since cdkd's bundled coverage data was built; the
cdkd release that refreshes that data makes the flag unnecessary.

## `--prefer-sdk-route` (deploy)

### Default: the Cloud Control auto-route

cdkd's SDK providers do not write every CloudFormation property. When your
template sets a top-level property the SDK provider for that type would drop,
cdkd routes that resource through Cloud Control instead, which forwards the
whole property map to AWS. No flag is needed, and cdkd logs one line per
resource:

```text
[info] MyLambda (AWS::Lambda::Function): routing via Cloud Control API
       (cdkd's SDK Provider does not yet wire CapacityProviderConfig — CC API
        will forward the full property map. Override via
        --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig.)
```

The layer is recorded on the resource as `provisionedBy: 'cc-api'` and stays
that way: later deploys, `cdkd drift` and `cdkd destroy` use the layer that
created the resource. `cdkd state show '<stack>'` prints it as `ProvisionedBy:`.

A property that cdkd's schema snapshot does not know (one AWS published later,
a typo, an `addPropertyOverride` key) routes the same way. Cloud Control applies
a real property and rejects a misspelled one with
`Model validation failed (#: extraneous key [...] is not permitted)`, as
CloudFormation does.

These cases stay on the SDK provider, with a warning that names the property:

| Property | Why it does not route |
| --- | --- |
| Read-only (AWS-managed ARNs, IDs, and so on) | No engine sets one. CloudFormation ignores it, and Cloud Control would record it as the resource's identifier. |
| Missing from the snapshot, on a type Cloud Control cannot manage | There is no Cloud Control route for the type. |
| Missing from the snapshot, and unchanged since the resource was deployed on the SDK provider | An existing resource keeps its route. Changing the value routes it. |

The auto-route applies to types that have an SDK provider. A type cdkd already
manages through Cloud Control always sends the full property map.

### The override

`--prefer-sdk-route <entries>` opts out of the auto-route. Each entry is a
`<ResourceType>:<PropertyName>` pair, comma-separated and repeatable. The
resource stays on its SDK provider and the named property is not written to
AWS. cdkd logs a warning for each one.

```bash
cdkd deploy MyStack \
  --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig,AWS::Lambda::Function:FunctionScalingConfig
```

| Use it when | Do not use it when |
| --- | --- |
| The property does not matter to you and you want the SDK provider's faster calls | The property is security-relevant: a KMS key, an IAM or resource policy, encryption or TLS settings |
| Cloud Control would name the resource differently than the SDK provider | You have no preference about routing; the default already gets the property to AWS |
| An SDK-managed resource gained such a property and you want it to stay where it is | |

The flag is not stored. Pass it on every deploy for as long as you want the
override; a deploy without it routes the resource through Cloud Control.

#### What state records, and what `cdkd diff` shows

A property dropped this way is left out of the resource's state record too,
because state describes what cdkd sent to AWS. Two things follow:

- Removing the flag is usually enough to apply the property. The next deploy
  sees an addition, routes the resource through Cloud Control, and updates it
  in place.
- `cdkd diff` has no `--prefer-sdk-route`, so it previews the deploy without
  the flag and shows the property as a pending change marked
  `[via CC API: <Prop>]`. A deploy with the flag reports no change for it.

#### When the flag does not do what you expect

| Case | What happens |
| --- | --- |
| The resource has a second dropped property you did not name | The whole resource routes through Cloud Control, so the property you named reaches AWS anyway. cdkd warns and names the property to add. |
| The resource is already recorded `provisionedBy: cc-api` | The flag changes nothing. Cloud Control keeps writing the whole map. |
| The property is create-only | The drop is accepted, but removing the flag later cannot apply it in place: see [`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`](#create-only-drop-needs-replacement). |
| The type cannot be served by Cloud Control at all | Removing the flag makes the deploy refuse at pre-flight. The warning says so when you first pass the flag. |

## `--recreate-via-cc-api` (deploy)

`--recreate-via-cc-api <LogicalId>` deletes the named resource and creates it
again through Cloud Control API in this deploy. The recreated resource is
recorded `provisionedBy: 'cc-api'` and stays on Cloud Control afterwards.

```bash
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes

# Two resources: repeat the flag (there is no comma-separated form)
cdkd deploy MyStack \
  --recreate-via-cc-api MyLambda \
  --recreate-via-cc-api OtherFn \
  --yes

# A stateful resource also needs the data-loss flag
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes
```

The cost is a delete and a create: the resource is unavailable in between, a
physical id that AWS assigns changes, and a stateful resource loses its data.
An argument that is not a valid CloudFormation logical id is rejected when the
command line is parsed.

The template does not have to change. A named target is recreated even when its
diff is empty, and the deploy counts it as an update. A target the same deploy
deletes (its `Condition` is now false, say) is not recreated, and cdkd warns.

### Check whether you need it

Usually you do not. The routing decision is made again on every deploy, so
adding a dropped property to a resource on the SDK provider routes it through
Cloud Control on the next plain deploy, in place, with the physical id kept.

| Situation | What to do |
| --- | --- |
| You just added the property to an SDK-managed resource | Deploy without the flag. The auto-route applies it in place. |
| The resource is not deployed yet | Deploy without the flag. |
| The resource is already `provisionedBy: 'cc-api'`, or its type has no SDK provider | Drop the flag. cdkd refuses at pre-flight, because the recreate would change nothing. |
| You added a create-only property | Deploy without the flag. cdkd plans the [replacement](#property-driven-replacement-and-stateful-replace-blocked) itself, and asks for `--force-stateful-recreation` on a stateful type. |
| The deploy refused with `CREATE_ONLY_DROP_NEEDS_REPLACEMENT` | Use this flag, or `--replace`. |
| The auto-routed update failed because Cloud Control cannot address the resource by the id the SDK provider stored | Use this flag. |
| A create-only property fed by a `NoEcho` parameter needs a new value, and the deploy warns that it cannot confirm the value | Use this flag. State holds only `***` there ([State Management](state-management.md)). |

Whether a property is create-only is read from the type's CloudFormation schema
through `cloudformation:DescribeType`, where cdkd has no rule of its own.
Without that permission cdkd warns and uses its bundled schema snapshot. For a
type with no bundled schema it treats the change as in place, and where nothing
rejects that update the deploy can report success with the property unapplied.

### `CREATE_ONLY_DROP_NEEDS_REPLACEMENT`

A create-only property can only be set when the resource is created. If an
earlier deploy accepted its drop with `--prefer-sdk-route`, AWS never held the
value, and applying it now means replacing the resource. cdkd refuses to do
that on its own.

The refusal fires when that property is the only thing asking for a
replacement and the template still asks for it unchanged. Two things trigger
it: removing the flag, and adding another dropped property the flag does not
cover (one uncovered property routes the whole resource through Cloud Control).

The refused resource is not touched. Other resources of the same deploy may
already have changed, and they roll back as for any failure. The error names
these remedies:

| Remedy | What it does |
| --- | --- |
| `--recreate-via-cc-api <LogicalId>` | Deletes the resource, then re-creates it through Cloud Control with the property applied |
| `--replace` | Replaces every such resource in the deploy, nested stacks included; creates the new one first, so it collides where the resource holds a unique value other than its name, such as a subnet's CIDR block |
| `--force-stateful-recreation` | Also required for a stateful type |
| `--prefer-sdk-route <Type>:<Prop>,...` | Keeps the resource on its SDK provider and keeps dropping the property |

`--recreate-via-cc-api` is refused while the same property is still named in
`--prefer-sdk-route`, so drop that entry in the same run.

A replacement that something else in the template already requires goes ahead
and applies the property. A template that removes the property does not replace
the resource. `cdkd diff` shows the replacement and warns that the deploy
refuses it; the warning does not change `cdkd diff`'s exit code.

cdkd knows a property was kept off AWS only when the deploy that created the
resource recorded it. An imported resource, or one an older cdkd created with
the flag, is taken to have the value: the deploy reports no change while the
property may still be missing. `--recreate-via-cc-api` applies it there.

### What else the recreate changes

**Resources that reference the target.** When AWS assigns the physical id (a
security group, a REST API), the recreated resource gets a new one. Resources
in the same stack that read it through `Ref` or `Fn::GetAtt` follow it in the
same deploy:

| The reader's referencing property | What happens to the reader |
| --- | --- |
| Can be updated in place | Updated to the new id |
| Is create-only (an `AWS::EC2::Volume`'s `KmsKeyId`) | Replaced, and so are its own create-only readers |
| Is create-only, and the reader is stateful | Refused with `STATEFUL_REPLACE_BLOCKED` before anything is touched, unless `--force-stateful-recreation` is passed or the reader declares `UpdateReplacePolicy: Retain` |

The confirmation prompt lists the readers under "Replaced if the id changes",
with **DATA LOSS** on a stateful one. A target whose physical id is a name
fixed as a literal in the template (a function with an explicit `FunctionName`)
keeps its id, so a reader that only uses `Ref` is left alone. A reader of one
of its attributes is still listed, because an attribute such as a table's
`StreamArn` can change.

The early refusal covers a direct chain of create-only references. A stateful
resource reached another way (through a custom resource, a nested stack's
`Parameters`, or a rejected in-place update) is refused mid-deploy instead,
after the target was recreated. `--force-stateful-recreation` covers it there
too.

**Resources that live inside the target.** Some resources are deleted with
their parent: a Lambda function's permissions, versions and aliases, an SNS
topic's subscriptions, a queue's or bucket's policy, a log group's filters, an
IAM role's inline policies. When the parent is recreated under the same
physical id, cdkd re-creates those children in the same stack too. Managed
policies and group memberships attached to a recreated IAM principal are
detached first and attached again. A Lambda function URL is not handled this
way.

[Deploy safety internals](cli-deploy-safety-internals.md#resources-that-follow-a-recreated-resource)
has the exact rules for both, including what state holds if the deploy fails
between the parent and a child.

### Confirmation prompt

Before anything is destroyed, cdkd prints one row per target (logical id, type,
a direction tag such as `[SDK → CC]`) and asks:

```text
Continue? (y/N):
```

One prompt covers the whole stack and both `--recreate-via-*` flags.

| Run | Behaviour |
| --- | --- |
| `--yes` / `-y` | The plan is logged once as a warning and the deploy proceeds |
| No terminal, no `--yes` | Rejected with an error instead of waiting on a closed stdin |

A stateful target's row carries a `**DATA LOSS**` prefix and the line
`DATA: all data in <logical id> will be lost (no automatic data migration)`.
Under `--force-stateful-recreation` every S3 bucket and log group in the plan
is shown that way, because the emptiness checks are skipped.

A bucket whose emptiness check ran and failed (a missing permission, a rate
limit, a region mismatch) is shown as a third case. It still proceeds, and its
row says cdkd does not know:

```text
  - MyBucket (AWS::S3::Bucket) [SDK → CC] — emptiness NOT established: the live probe failed, so cdkd does not know whether this resource holds data
    UNKNOWN: if MyBucket holds data, the destroy + recreate loses it (no automatic data migration)
```

### Cross-stack reference propagation

Other stacks that read the recreated resource's outputs through
`Fn::GetStackOutput` or `Fn::ImportValue` see the new physical id only after
they are deployed again. cdkd looks through the state bucket at plan time and
names the consumer stacks it finds in the warning. If it cannot read the
bucket it prints a generic caveat instead, so an empty list is not proof there
are none. Recreate from leaf stacks to root.

### Going back to the SDK provider

A resource recorded `provisionedBy: 'cc-api'` normally stays on Cloud Control,
even after a cdkd release adds SDK support for the property that sent it there.
Use [`--recreate-via-sdk-provider`](#recreate-via-sdk-provider-deploy) to move
it back.

Some types return on their own, in place and without a recreate. Check
[`--pin-cc-api`](#pin-cc-api-deploy) for that case before reaching for the
flag: the recreate is destructive and the automatic return is not.

### Nested stacks

Both `--recreate-via-*` flags take a logical id of the stack you are deploying
and act only in that stack.

| Target | Result |
| --- | --- |
| A logical id that exists only in a nested stack | Refused at pre-flight. The error names the parent's nested stacks. |
| A logical id the parent and a child both declare | Only the parent's resource is recreated |
| The nested stack's own `AWS::CloudFormation::Stack` resource | Refused, with no bypass: it would delete the whole child stack |

A resource inside a nested stack cannot be recreated with these flags.

### Limits

| Not possible | Why |
| --- | --- |
| A stack-wide form | Name each target, so each recreate is acknowledged |
| The same resource's property in `--prefer-sdk-route` | The two ask for opposite things; cdkd refuses at pre-flight |
| A type Cloud Control cannot create (`AWS::CodeBuild::Project`, `AWS::IAM::Policy`), or one whose SDK provider opts out of Cloud Control | Refused before anything is touched, with no bypass |
| A type whose Cloud Control handler cannot manage it (`AWS::Scheduler::Schedule`, `AWS::RDS::DBProxyTargetGroup`, `AWS::Lambda::EventInvokeConfig`) | cdkd keeps these on the SDK provider, so the recreate would land on the same route |
| `AWS::DynamoDB::GlobalTable` | [Multi-region types are refused outright](#multi-region-types-are-refused-outright) |
| Another account or region | The flag works within the deploy's own environment |

## `--recreate-via-sdk-provider` (deploy)

`--recreate-via-sdk-provider <LogicalId>` is the reverse direction. It deletes
the named resource and creates it again through cdkd's SDK provider, so a
resource recorded `provisionedBy: 'cc-api'` becomes `provisionedBy: 'sdk'`.

```bash
cdkd deploy MyStack --recreate-via-sdk-provider MyLambda --yes

cdkd deploy MyStack \
  --recreate-via-sdk-provider MyLambda \
  --recreate-via-sdk-provider OtherFn \
  --yes
```

Use it when a resource went to Cloud Control for a property the SDK provider
did not write, and either a later cdkd release added that property or you
removed it from the template. Everything else matches `--recreate-via-cc-api`:
one flag per resource, the same cost, the same
[stateful-resource guard](#stateful-resource-guard), the same shared prompt,
the same [nested-stack scope](#nested-stacks).

cdkd refuses the deploy in these cases:

| Case | Why |
| --- | --- |
| The resource is already `provisionedBy: 'sdk'`, or its record predates the field | Nothing to move |
| The type has no SDK provider | The recreate would land on Cloud Control again |
| The template still has a dropped property not named in `--prefer-sdk-route` | The next deploy would route it straight back. Remove the property or name it in `--prefer-sdk-route`. |
| The same logical id is also in `--recreate-via-cc-api` or `--pin-cc-api` | Opposite requests for one resource |
| The type is `AWS::DynamoDB::GlobalTable` | [Multi-region types are refused outright](#multi-region-types-are-refused-outright) |

A new resource lands on the SDK provider on its own whenever its type has one
and the template has no dropped property. This flag is only for a resource
already on Cloud Control.

## `--pin-cc-api` (deploy)

`--pin-cc-api <LogicalId>` keeps a resource recorded `provisionedBy: 'cc-api'`
on Cloud Control for this deploy. The resource is not touched; the flag only
decides which provider issues its update.

```bash
cdkd deploy MyStack --pin-cc-api MyListener
```

It exists because a few types return to the SDK provider on their own. For
those types Cloud Control works but is slower, so on the next deploy that
changes the resource cdkd moves it back in place, keeping the physical id,
provided neither the template nor the record carries a property the SDK
provider would drop. `cdkd diff` marks the pending move
`[returning to SDK provider]`. The pin declines that move for one deploy, for
example while you are investigating something and want the same layer as last
time.

| Behaviour | Detail |
| --- | --- |
| Per deploy | Pass it again next time, or stop and let the move happen |
| A logical id in no stack of the run | An error, raised before any stack deploys. The flag prints nothing when it works, so a typo must not pass silently. |
| Under `--all` | An id that applies to some stacks is reported once, naming the stacks that have it and those that do not |
| A resource already on the SDK provider, or a new one | No effect |
| A type that left Cloud Control because Cloud Control cannot manage it (`AWS::Scheduler::Schedule`) | The pin is ignored |
| A replacement | The new resource is routed as any new resource is |
| A resource inside a nested stack | Not reachable from the parent; pass the flag in a deploy of that child |
| With `--recreate-via-sdk-provider` on the same id | Refused |

Pinning keeps Cloud Control's behaviour for that deploy, gaps included. For an
`AWS::ElasticLoadBalancingV2::Listener`, a deploy that removes a
`ListenerAttributes` key under the pin leaves that key at its old value. The
SDK provider is the route that resets it.

## `--replace` (deploy)

Some resource types cannot be updated: AWS has no update call for them, so a
property change means a new physical resource. Examples are
`AWS::EFS::AccessPoint`, `AWS::ECS::TaskDefinition`,
`AWS::Glue::SecurityConfiguration` and several `AWS::ApiGatewayV2::*` identity
fields. For these the provider rejects the update with
`ResourceUpdateNotSupportedError` and the deploy fails.

`--replace` turns that failure into a DELETE + CREATE, which is what
CloudFormation does for the same change.

```bash
# A Glue SecurityConfiguration's EncryptionConfiguration changed
cdkd deploy MyStack --replace --yes
```

It is stack-wide and names no resource. It acts only where an update is
rejected; a resource whose update succeeds in place is unaffected.

| Cost | Detail |
| --- | --- |
| A new physical id | Stacks that consume the resource need a redeploy. `--replace` neither prompts nor lists them. |
| Data loss on a stateful type | Refused unless `--force-stateful-recreation` is also passed, and that flag covers every target in the run |
| A short outage on the delete-first path | See [Same-name replacement](#same-name-replacement-delete-first-ordering) |

To move one resource between provisioning layers, use the `--recreate-via-*`
flags instead.

Where cdkd has a replacement rule for the changed property, it replaces the
resource without the flag: `AWS::Lambda::LayerVersion` content is one such
case. See
[property-driven replacement](#property-driven-replacement-and-stateful-replace-blocked).

### Glue renames

Glue names live inside an input block. A rename through one follows
CloudFormation:

| Change | Plan | To apply it |
| --- | --- | --- |
| `TableInput.Name` (`AWS::Glue::Table`) | Replacement | `--force-stateful-recreation` (a table is stateful) |
| `ConnectionInput.Name` (`AWS::Glue::Connection`) | Replacement | nothing extra |
| `DatabaseInput.Name` (`AWS::Glue::Database`) | Update, refused by the provider | `--replace --force-stateful-recreation` |

- A table name that differs only in letter case is the same table (Glue
  lowercases table names), so it updates in place.
- The replacement creates the renamed table first. If another table holds the
  new name, the create fails and nothing is deleted, with or without
  `--replace`. Pick a free name.
- A table replacement that keeps its database, catalog and name collides with
  the old table itself. `--replace` deletes the old table first and re-creates
  it.
- Renaming a database through `DatabaseInput.Name` fails in CloudFormation too.
  cdkd's provider refuses the update before any AWS call, because it would
  leave state naming the old database.
- A `CatalogId` change on a database is refused the same way. An absent
  `CatalogId` and your own account id are the same catalog, so switching
  between those updates in place. On a table or connection `CatalogId` is
  create-only, so a change is a replacement.

### Same-name replacement: delete-first ordering

By default cdkd creates the new resource before deleting the old one, which is
CloudFormation's order. That cannot work when the new resource needs a physical
name the old one still holds. Two failures report it, and both name `--replace`:

| Failure | What happened |
| --- | --- |
| `NAMED_REPLACEMENT_COLLISION` | The create collided with the existing resource's name |
| `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` | The create API is idempotent by name and returned the old resource's id instead of a new one, as `CreateQueue` does for an unchanged `QueueName` |

Without `--replace` the deploy fails and suggests renaming the resource. With
`--replace` cdkd deletes the old resource first and recreates it under the same
name, so the resource is briefly unavailable. Renaming the resource in your CDK
code avoids the outage, because the create-first order then has a free name.

`--replace` does not help in three cases, and in each nothing is deleted:

| Case | Why |
| --- | --- |
| The old resource declares `UpdateReplacePolicy: Retain` | The old resource keeps the name, so a same-name replacement can never proceed |
| The template also changes the name, and another resource holds the new one | Deleting the old resource does not free that name; see below |
| cdkd cannot show that the old resource is what holds the name | See [below](#when-cdkd-cannot-show-the-old-resource-holds-the-name) |

`cdkd rollback` can raise `NAMED_REPLACEMENT_COLLISION` too, and `--replace` is
not a rollback flag. See
[Reversing a replacement](cli-rollback.md#reversing-a-replacement).

#### When the new name belongs to another resource

A replacement that also changes the physical name can collide with a resource
that is not the one being replaced, for example a function renamed to a name
another stack uses. cdkd compares the name the template declares with the name
the old resource holds. When they differ, the deploy fails with
`NAMED_REPLACEMENT_COLLISION` saying the name is held by another resource. Pick
a free name, or delete the resource holding it if it is yours.

The replacements that otherwise delete first (the rejected-update fallback and
the `--recreate-via-*` flags) create first when the names differ. A collision
there also fails with nothing deleted, and so does a name-idempotent create
that returns the resource already holding the new name. Delete that resource
by hand if it is yours.

#### A create under a name that is already taken

Some create APIs do not fail on a taken name. They return or overwrite the
resource that already holds it: SQS queues, SNS topics, Step Functions state
machines, ECS clusters, ELBv2 load balancers and target groups, EventBridge
rules, CloudWatch alarms, log groups and S3 buckets. A create that went through
would record someone else's resource as the stack's, for a later
`cdkd destroy` to delete.

So for those types on cdkd's SDK providers, a create with an explicit name
looks the name up first:

| Deploy step | When the name is taken, or the lookup cannot run |
| --- | --- |
| A plain create | Fails with `NAMED_CREATE_COLLISION`; nothing is created |
| A replacement that changes the name, moves a rule to another bus, or changes `Type` onto one of these types | Fails with `NAMED_REPLACEMENT_COLLISION`; nothing is created or deleted |

`NAMED_CREATE_COLLISION` fires even when the resource is this stack's own, left
by an interrupted deploy or kept under `DeletionPolicy: Retain`: nothing in AWS
tells the two apart. Delete the resource, or adopt it with
[`cdkd import`](import.md), then re-run. The error ends with the
`cdkd import <stack> --resource <logicalId>=<physicalId>` command for the
resource it found. Confirm the resource is yours before running it.

- An S3 bucket gets no command, because the lookup also finds buckets other
  accounts own.
- When the holder is this stack's own resource under another logical id (a
  construct moved or renamed), the error names that id. Give the new resource
  another name, or deploy that id's removal first.
- A log group you declare that something else already created, such as a
  Lambda function's `/aws/lambda/<name>` group, is refused the same way.
- A create under a name cdkd generates is not looked up.
- A load balancer or target group is looked up under the name the create
  sends, which carries the stack-name prefix under
  `--prefix-user-supplied-names`.

#### When cdkd cannot show the old resource holds the name

A collision says a name is taken, and nothing about who holds it. An orphan
from an earlier failed attempt or a resource made outside the stack collides
exactly as the old resource does. So before `--replace` deletes anything, cdkd
checks that the old resource holds the name the create sent, from the name in
state and the old resource's physical id.

When the check fails or cannot decide, the deploy fails with
`NAMED_REPLACEMENT_COLLISION`, nothing is deleted, and the error does not
suggest `--replace`. Remove or rename whatever holds the name if it is yours.
If that is the resource being replaced, delete it by hand. Then re-run.

The per-case rules are in
[Deploy safety internals](cli-deploy-safety-internals.md#how-replace-proves-the-old-resource-holds-the-name).

### The stateful guard on this path

When the resource `--replace` would replace is stateful, the DELETE + CREATE
loses its data, so cdkd refuses unless `--force-stateful-recreation` is also
passed. Three things differ from the `--recreate-via-*` flags:

- The guard runs mid-deploy, when the update is rejected. Other resources may
  already have changed.
- Every `AWS::S3::Bucket` and every `AWS::Logs::LogGroup` counts as stateful
  here, empty or not, because the emptiness checks cannot run mid-deploy.
- A plain `cdkd deploy` reaches the same guard without `--replace`. When Cloud
  Control rejects an update because the type has no update handler
  (`UnsupportedActionException`), cdkd falls back to a replacement on its own,
  and a stateful target is refused on the same terms:

```text
MyTable (AWS::DynamoDB::Table) cannot be updated in place by the provisioning
layer it routes through, so applying this change would DELETE + CREATE it —
but it is a stateful resource: destroy loses all data in the resource. Re-run
with --force-stateful-recreation to confirm the data loss, or change the
resource definition to avoid the update.
```

Types that are not stateful (a layer version, a Glue security configuration, a
task definition) replace with `--replace` alone.

#### Under `UpdateReplacePolicy: Retain`

`Retain` exempts the resource from the guard. cdkd creates the new resource and
leaves the old one in AWS with its data. The flag is not required, and passing
it does not make cdkd delete a resource the template asked to keep.

The old resource is no longer tracked in state. It keeps costing money,
`cdkd destroy` will not remove it, and deleting it is yours to do. The deploy
reports the replacement as partial:

- the row prints `partial (…)`;
- the summary counts it under `of which left an orphaned predecessor` (inside a
  nested stack, `Left an orphaned predecessor in a nested stack`);
- `cdkd events` records the old resource's physical id;
- the deploy exits `2` unless you pass
  [`--allow-unaddressed`](#allow-unaddressed-deploy).

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

### Property-driven replacement and `STATEFUL_REPLACE_BLOCKED`

A property-driven replacement is one cdkd sees in the diff: a create-only
property changed in the template. Examples are an `AWS::EFS::FileSystem`
`PerformanceMode` change, an `AWS::EC2::Volume` `AvailabilityZone` move, or an
S3 `BucketName` rename. A plain `cdkd deploy` performs it with no `--replace`.

When the resource is stateful, the deploy fails with `STATEFUL_REPLACE_BLOCKED`
unless `--force-stateful-recreation` is passed. The error names the properties:

```text
MyFileSystem (AWS::EFS::FileSystem) requires replacement (immutable property
changed: PerformanceMode) but it is a stateful resource — destroy loses all data
in the resource. Re-run with --force-stateful-recreation to confirm the data
loss, or change the resource definition to avoid the immutable-property change.
```

Three exemptions apply to this trigger specifically:

| Case | Guarded? |
| --- | --- |
| `UpdateReplacePolicy: Retain` | No. The old resource and its data stay in AWS, untracked. |
| `UpdateReplacePolicy: Snapshot` | Yes. cdkd takes the final snapshot, but the live resource is still destroyed. |
| A target named by `--recreate-via-cc-api` / `--recreate-via-sdk-provider` | No. Those flags checked it at pre-flight. |

As with `--replace`, every S3 bucket and every log group counts as stateful
here. Types that are not stateful replace freely.

### Type changes on an existing logical id

Changing a resource's `Type` while keeping its logical id is always a
replacement. It is never applied in place and never skipped as "no changes",
even when the two types declare identical properties.

| Half | Handled as |
| --- | --- |
| The existing resource | Deleted through the provider of the type cdkd recorded. The stateful guard and `UpdateReplacePolicy: Snapshot` judge that recorded type. |
| The new resource | Created through the provider of the type the template declares, routed as a new resource |

So leaving an `AWS::SSM::Parameter` for an `AWS::SNS::Topic` needs
`--force-stateful-recreation`, and the reverse does not.

Name collisions follow the rules above, with two differences. A change onto a
type whose create [adopts a taken name](#a-create-under-a-name-that-is-already-taken)
looks the name up even when it is unchanged, and any resource found fails the
deploy. And under `--replace`, cdkd deletes the old resource first only between
two types that share one name space (RDS, DocumentDB and Neptune clusters,
instances and subnet groups; DynamoDB tables and global tables). Any other pair
fails with nothing deleted.

`cdkd rollback` and the automatic rollback reverse a type change through both
types. When a rollback journal cannot name the old type, that one operation is
refused with `ROLLBACK_REPLACEMENT_UNROUTABLE` and the journal is kept. Fix
forward with `cdkd deploy`, or pass `--orphan <LogicalId>` to leave the
resource and let the rest of the rollback proceed.

How two equal physical ids across types are told apart is in
[Deploy safety internals](cli-deploy-safety-internals.md#equal-physical-ids-across-a-type-change).

### Type changes into or out of a nested stack (`TYPE_CHANGE_NESTED_STACK`)

One type pair is refused instead of replaced. A nested stack's row owns a whole
child stack, and a failed cleanup of the old half would strand that child under
a deploy that reports success.

`cdkd deploy` and `cdkd deploy --dry-run` refuse before any resource is touched
when a logical id's recorded type and template type differ with
`AWS::CloudFormation::Stack` on either side:

```text
Refusing to deploy MyStack: a resource changes its Type into or out of AWS::CloudFormation::Stack, which cdkd does not replace in place (issue #2668).
  - Thing: Type changes from AWS::SNS::Topic to AWS::CloudFormation::Stack (the existing AWS::SNS::Topic is arn:aws:sns:us-east-1:111122223333:thing).
```

`cdkd diff` shows the same refusal under
`Blocking (cdkd deploy will refuse):` and exits `3`.

No flag overrides it. Make it two changes: give the new resource a different
logical id (rename the construct), or remove the resource in one deploy and add
its replacement in the next.

## Stateful-resource guard

Destroying and recreating most resources loses nothing: an IAM role or a Lambda
function comes back identical. A **stateful** resource holds data that the
delete destroys and AWS does not copy to the replacement: rows in a DynamoDB
table, objects in a bucket, lines in a log group, images in an ECR repository.

cdkd refuses to destroy and recreate a stateful resource unless
`--force-stateful-recreation` is passed. Every path that consults this guard:

| Path | When the guard runs |
| --- | --- |
| `--recreate-via-cc-api` | Pre-flight, before any resource is touched |
| `--recreate-via-sdk-provider` | Pre-flight, before any resource is touched |
| `--replace` | Mid-deploy, when the immutable-update rejection is caught |
| Cloud Control `UnsupportedActionException` auto-fallback | Mid-deploy, when AWS rejects the in-place update — no flag needed to reach it |
| Property-driven replacement on a plain `cdkd deploy` | Mid-deploy, from the diff |
| A resource a `--recreate-via-*` deploy replaces because it reads a target through a direct chain of create-only properties | After the diff, before any resource is touched (other paths fall to the rows above, mid-deploy) |

The Cloud Control fallback and the property-driven replacement need no other
flag, so a plain `cdkd deploy` can ask for this one.

### `--force-stateful-recreation`

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

Inside a nested stack the flag does two things:

- A stateful resource that a template change or a rejected update replaces is
  replaced instead of refused.
- The delete empties the resource first. A non-empty S3 bucket has its objects
  deleted, and an ECR repository is deleted with its images. Without the flag
  cdkd refuses to delete either while it holds data, unless the resource opted
  in itself (CDK's `autoDeleteObjects`, `emptyOnDelete`, `autoDeleteImages`).

The recreate prompt lists only the `--recreate-via-*` targets of the stack you
deploy, so it does not show replacements inside nested stacks. Check them
first:

```bash
cdkd diff MyStack --recursive
```

The diff shows the replacements a template change drives. A replacement that
follows a rejected in-place update is decided during the deploy and does not
appear there.

### Deletion protection blocks a replacement, and deploy cannot clear it

`--force-stateful-recreation` clears cdkd's guard. It does not clear AWS's: a
resource with deletion protection on refuses every delete, and a replacement
includes a delete. `cdkd destroy` has `--remove-protection` for this.
`cdkd deploy` has no such flag, so no combination of replace flags deletes a
protected resource.

What happens depends on the order the replacement runs in:

| Order | When a deploy uses it | Outcome while protection is on |
| --- | --- | --- |
| Delete first | `--recreate-via-*`, the update-failure fallback (`--replace` or the Cloud Control auto-fallback), and `--replace`'s retry after a name collision or a name-idempotent create | The deploy fails at the delete |
| Create first | A property-driven replacement, and `--recreate-via-*` or the update-failure fallback when the template also renames the resource | The deploy completes, warning that the old resource could not be deleted |

On the create-first order the old resource and its data stay in AWS, no longer
tracked by cdkd. You delete it yourself once protection is off.

Turn protection off immediately before the deploy that replaces the resource,
or after a delete-first failure, then re-run:

```bash
# CloudWatch Logs: the log group whose LogGroupClass you are changing
aws logs put-log-group-deletion-protection \
  --log-group-identifier /my/log/group --no-deletion-protection-enabled

cdkd deploy MyStack --replace --force-stateful-recreation
```

You are turning protection off on the resource that is about to be deleted. The
new resource is created from your template and gets whatever protection the
template declares, so there is nothing to turn back on.

> [!WARNING]
> If the deploy does not complete, protection stays off and no later
> `cdkd deploy` notices: the template and the state record both still say it is
> on. [`cdkd drift`](cli-drift.md) shows it, and `cdkd drift --revert` restores
> it.

**Clearing the flag in the template takes two deploys.** For most types cdkd
refuses the immutable change before it applies any property, so removing the
protection property in the same deploy has no effect. Deploy once with
protection off and the immutable change reverted, then again with the change
and the replace flags. `AWS::Cognito::UserPool` is the exception: its refusal
comes after the update applied `DeletionProtection`, so the failed deploy
already turned it off and the next run succeeds.

**Under `UpdateReplacePolicy: Retain`, do not turn protection off.** A retaining
replacement never deletes the old resource, so protection blocks nothing. When
the replacement would land on the same physical name (the case for an
`AWS::Logs::LogGroup`) it cannot complete either, and fails with
`NAMED_REPLACEMENT_IDEMPOTENT_CREATE` or `NAMED_REPLACEMENT_COLLISION`. You
would end up with the original resource, its protection removed by hand, and
the change still unapplied. Remove the `Retain` policy, or revert the immutable
change.

Some refusals mention protection themselves:

- The guard's refusals add a note when cdkd's records show protection on, for
  any type `cdkd destroy --remove-protection` covers
  ([Destroy flags & guards](cli-destroy.md)). Protection enabled outside cdkd
  after its last read is not in those records, so the note can be missing while
  AWS still refuses the delete.
- Six types name the command that turns protection off: `AWS::Logs::LogGroup`,
  `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::EMR::Cluster`,
  `AWS::Cognito::UserPool`, `AWS::DynamoDB::GlobalTable` and
  `AWS::AutoScaling::AutoScalingGroup`. They point at the console instead when
  the resource's id cannot be printed safely on a command line.

For an Auto Scaling group only the `prevent-all-deletion` level blocks a
replacement. At `prevent-force-deletion` there is nothing to turn off.

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
| Nested stacks | `AWS::CloudFormation::Stack` — replacing a nested stack destroys the whole child stack, every resource it owns, with no per-resource guard. Its `StackName` is immutable, so a `StackName` edit deployed with `--prefer-sdk-route AWS::CloudFormation::Stack:StackName` is a replacement |
| Edge / identifier immutability | `AWS::CloudFront::Distribution` — the URL changes, which breaks consumers, and propagation takes roughly 20 minutes. `AWS::SMSVOICE::PhoneNumber` and `AWS::SMSVOICE::SenderId` are the same class: a release returns the identifier to the pool, the replacement gets a different one, and the original may be unobtainable |

The list only grows; [the changelog](changelog-cdkd.md) records when each type
joined. Where it is not knowable from outside whether a delete destroys data,
the type is guarded.

A few types are deliberately not guarded, as CloudFormation also replaces them
without asking:

- `AWS::EC2::Instance`: its root volume is ephemeral by design. Keep persistent
  data on an `AWS::EC2::Volume`, which is guarded.
- `AWS::SQS::Queue`: a queue's backlog is transient.
- `AWS::KMS::Alias`: deleting an alias removes a pointer, and the key material
  stays.
- `AWS::S3Tables::Namespace`: AWS refuses to delete a namespace that still
  holds a table, so a replacement cannot take a table with it. A create-first
  replacement warns `Failed to delete old resource` and leaves the old
  namespace and its tables in AWS, untracked. A delete-first one fails at the
  delete.

How the list is derived and checked is in
[Deploy safety internals](cli-deploy-safety-internals.md#how-the-stateful-list-is-kept-complete).

### Conditionally stateful types

Two types are judged by a condition instead of always counting as stateful.

| Type | Guard fires when | Guard does not fire when |
| --- | --- | --- |
| `AWS::S3::Bucket` | The bucket has at least one current version, prior version, or delete-marker, or the probe page was truncated | The bucket is provably empty — but see the per-path note below |
| `AWS::Logs::LogGroup` | `RetentionInDays > 0` in EITHER of cdkd's two recorded property bags, or the log group has at least one log stream | Neither bag records a positive retention AND the log group has no log streams — but see the per-path note below |

### How the conditional types are judged, per path

Whether you need `--force-stateful-recreation` for a bucket or a log group
depends on when the guard runs.

| Guard timing | Paths | Bucket or log group counts as stateful |
| --- | --- | --- |
| Pre-flight | `--recreate-via-cc-api`, `--recreate-via-sdk-provider` | When a live check finds data, per the table above |
| Mid-deploy | `--replace`, property-driven replacement, the Cloud Control auto-fallback | Always. No check can run there. |

Mid-deploy, the one exemption is `UpdateReplacePolicy: Retain`: the old
resource stays, so there is no data loss to confirm.

At pre-flight cdkd asks AWS once per target:

| Type | Check | If the check fails |
| --- | --- | --- |
| `AWS::S3::Bucket` | Lists one object version or delete-marker, so soft-deleted objects in a versioned bucket count as data | cdkd warns and lets the recreate proceed without the flag |
| `AWS::Logs::LogGroup` | Lists one log stream. A group with a stream counts as holding data, even when the stream is empty | cdkd warns and treats the group as stateful |

> [!WARNING]
> The bucket check fails open. If cdkd warns that it could not check a bucket
> (a missing `s3:ListBucketVersions` permission, for example), decide for
> yourself whether the bucket holds data before you confirm the recreate.

An answer that the bucket or the log group does not exist counts as empty. A
throttled check is retried up to three times first.

**Log group retention.** An unset or zero `RetentionInDays` means the log group
never expires, so it says nothing about the group being empty: at pre-flight
the stream check decides, and mid-deploy the group counts as stateful. A
positive retention counts wherever cdkd recorded it, including one set outside
cdkd (the console, `aws logs put-retention-policy`) and a string such as
`'30'`.

The exact probe rules, and how `RetentionInDays` values are parsed, are in
[Deploy safety internals](cli-deploy-safety-internals.md#the-emptiness-probes).

### Multi-region types are refused outright

Both `--recreate-via-*` flags refuse `AWS::DynamoDB::GlobalTable`, and
`--force-stateful-recreation` does not change that. A destroy and recreate
across replica regions involves backups and replication that cdkd does not
attempt. There is no bypass.

## `--strict-getatt` (deploy)

`--strict-getatt` fails the deploy on any `Fn::GetAtt` cdkd cannot resolve to
the real attribute, and on any stack Output it cannot resolve. Use it in CI so
a guessed value never ships quietly.

```bash
cdkd deploy MyStack --strict-getatt
```

### Default behaviour

When the state record does not hold a requested attribute and cdkd cannot
construct it, cdkd re-reads the resource from AWS once and uses the value if
the read supplies it. Otherwise it falls back to the resource's **physical
ID**, and what happens next depends on the attribute's name:

| Attribute name | Fallback value | Result |
| --- | --- | --- |
| Ends in `Arn` | Not `arn:`-shaped | Deploy fails, naming the resource, attribute, and an issue link |
| Ends in `Url` | Not an http(s) URL | Deploy fails, naming the resource, attribute, and an issue link |
| Any other suffix | Any | Warn `Unknown attribute X for resource type Y, returning physical ID` and continue |

Other suffixes only warn because an alias or an endpoint cannot be told apart
from a plain name by its shape, so failing there would break correct deploys. A summary line counts the fallbacks,
once per distinct site and per stack (a nested stack counts its own):

```text
2 attribute resolution(s) fell back to the physical ID (potentially wrong values); re-run with --strict-getatt to fail on these
```

Three more rules apply by default:

- **Attributes cdkd reads live never fall back.** These are an EC2 instance's
  `PrivateIp`, `PublicIp`, `PrivateDnsName`, `PublicDnsName` and
  `AvailabilityZone`, a VPC's `DefaultSecurityGroup`, a CloudFront
  distribution's `DomainName` and a security group's `VpcId`. When the value is
  not assigned yet (an instance still `pending` under `--no-wait`) or the read
  fails, cdkd refuses to resolve the reference. The message names the resource,
  the attribute, what was observed and the remedy. An RDS `DBProxy` or
  `DBProxyEndpoint` `VpcId` missing from the record is refused the same way.
  [`cdkd deploy`](cli-deploy.md) describes the effect under `--no-wait`.
- **The same applies inside `Fn::Sub`.** A `${LogicalId.Attribute}` placeholder
  that would fail as a resource property fails there too. A variable that does
  not exist warns and keeps its `${...}` text.
- **An unresolvable Output is warned about and skipped.** No value is stored or
  exported, and the deploy exits 0.

### With the flag

- Every physical-ID fallback is an error, whatever the suffix, including an
  ARN-shaped fallback for an `*Arn` attribute.
- An unresolvable Output fails the deploy. Without the flag it would break
  `Fn::ImportValue` consumers with "export not found" long after this deploy
  exited 0.

The Output failure comes after every resource operation succeeded, so cdkd
saves state first: created and updated resources are recorded, earlier outputs
are kept, and no rollback runs. A follow-up `cdkd deploy` or `cdkd destroy`
sees everything.

Nested stacks inherit the flag from the parent deploy. Leave it off when a
fallback is known to be right, for instance a type whose physical ID is the
attribute value.

## `--allow-unaddressed` (deploy)

A deploy in which no resource failed can still leave a resource alive in AWS
that cdkd was responsible for. That outcome exits `2`, as `cdkd destroy` does
for the same case. `--allow-unaddressed` makes it exit `0`.

```bash
cdkd deploy MyStack                       # exit 2 if any row below is non-zero
cdkd deploy MyStack --allow-unaddressed   # exit 0 for the same run
```

The summary reports the cases on separate rows:

| Summary row | Cause | Next `cdkd deploy` retries it? |
| --- | --- | --- |
| `Skipped (not deleted): N` | A resource removed from the template whose delete cdkd could not issue | Yes. Its state record is kept. |
| `Skipped (not deleted): N` | A resource a failed CREATE made, known only to the rollback journal, that the deploy could not delete | Only when the deploy could not act on it. See below. |
| `of which left an orphaned predecessor: N` | A replacement whose old resource was not deleted: the provider could not retire it, or `UpdateReplacePolicy: Retain` kept it | No. State points at the new resource; delete the old one by hand. |
| `Left an orphaned predecessor in a nested stack: N` | The same, inside a nested stack at any depth | No, as above |

A resource inside a nested stack, at any depth, counts toward the exit code
exactly as one in the stack you deployed. Its skipped DELETE is retried by a
plain re-deploy even when the nested template is unchanged, and every deploy
exits `2` until it lands. The nested stack prints its own warning and
`partial (…)` or `skipped (…)` row, naming the resource. The `Updated:` total
counts only the deployed stack's own resources.

### A DELETE that was skipped

The delete is skipped when the state record's `physicalId` is malformed, or
absent, empty, whitespace or not a string. The row prints
`skipped (state record has no physical id)` and no AWS call is made. A nested
stack's row is exempt unless its record names Cloud Control.

To give up on the delete, remove the resource by hand and drop its record with
the command the warning prints last:

```bash
cdkd state orphan MyStack --stack-region us-east-1 --resource MyQueue
```

> [!CAUTION]
> Never run `cdkd state orphan` on the deployed stack without `--resource`.
> That drops every resource's record, and the next deploy re-creates or
> collides with all of them.

For a nested stack's row the command names the child's own record,
`'<stack>~<logicalId>'`, with no `--resource`. Dropping it untracks everything
the child still holds, so delete those resources first;
`cdkd state show '<stack>~<logicalId>' --show-nested` lists them. When the
child's destroy was interrupted, the warning says to re-run `cdkd deploy`,
which resumes it.

A record with no usable `physicalId` that the template changes is different:
the deploy fails on that resource before anything is sent
(`STATE_RESOURCES_MALFORMED`) and rolls back unless `--no-rollback` is set.
Repair the `physicalId` in `state.json` and re-run. A record the template
leaves unchanged is not touched.

### A resource a failed CREATE left behind

A CREATE that made its resource and then failed is recorded only in the
rollback journal. A later successful deploy deletes it when it can. When the
delete fails, the deploy is interrupted, or a record cannot be read, the
journal entry is kept and the next successful deploy retries.

When a state record may own the resource, or cdkd cannot prove the resource is
the one it made, the deploy warns with the physical id and drops the entry.
Delete the resource by hand if it is not in use. See
[Failed CREATEs that made their resource](cli-rollback.md#failed-creates-that-made-their-resource).

### What the flag changes

Only the exit code and the run-level error. The summary rows, each resource's
own warning, the banner (its closing sentence differs), the `skipped` figure in
`cdkd events` and the `RUN_FINISHED` `result: 'FAILED'` record are still
emitted, so the log still says a resource survived.

With the flag the `PartialFailureError` message is not raised. That message
carries the run-level remediation text and the count of stacks that were
cancelled, so in CI the per-resource warnings become your route to the cause.

### When to use it

Use it for an orphaned predecessor you cannot act on yet. The common case is an
ACM certificate replacement where a consumer in another stack, often a
CloudFront distribution, still uses the old certificate. The delete succeeds
once `DescribeCertificate.InUseBy` is empty, and until then the pipeline would
be red for a cause it cannot act on.

Prefer the flag to a shell test on the exit code. `cdkd deploy` also exits `2`
for `MacroExpansionError` and `ResourceUpdateNotSupportedError`, so
`cdkd deploy || [ $? -eq 2 ]` would hide those failures.

## `--no-cfn-fallback` (deploy / diff)

By default a cross-stack reference that cdkd state does not hold falls back to
CloudFormation. That lets a cdkd-deployed stack consume a stack still managed
by CloudFormation.

| Intrinsic | Fallback lookup |
| --- | --- |
| `Fn::ImportValue` | CloudFormation `ListExports` in the consumer's region |
| `Fn::GetStackOutput` | CloudFormation `DescribeStacks` outputs in the target region; same account only |

```bash
cdkd deploy MyStack --no-cfn-fallback   # resolve from cdkd state only
cdkd diff MyStack --no-cfn-fallback     # preview with the same rule
```

Pass the flag to keep IAM permissions minimal, or to make an export-name typo
fail instead of matching an unrelated CloudFormation export. Nested stacks
inherit it, and `cdkd diff` honours it so preview and deploy resolve alike.

Three rules govern the fallback when it is on:

- **cdkd state wins.** The fallback runs only after cdkd state has no match, so
  a name that exists in both resolves to the cdkd export.
- **The reference is weak.** It is not recorded in state, so nothing protects
  either side at destroy time. Deleting the CloudFormation producer breaks the
  consumer's next deploy.
- **A failed lookup is not fatal by itself.** Without
  `cloudformation:ListExports` or `cloudformation:DescribeStacks`, cdkd warns
  and reports the original not-found error.

[Cross-Stack References](cross-stack-references.md) covers the design.

## `--require-approval` (deploy)

`--require-approval` asks for confirmation before a stack's changes are
deployed, like `cdk deploy --require-approval`. It is also read from
`"requireApproval"` in `cdk.json`; the flag wins.

| Level | Asks when the stack has |
| --- | --- |
| `never` (default) | nothing — cdkd deploys without asking. |
| `any-change` | any change, an Outputs-only one included. |
| `destructive` | a change that replaces, deletes or orphans an existing resource. |

`destructive` uses the classification of
[`cdkd diff --fail-on=destructive`](cli-diff.md), counts a `--recreate-via-*`
target as a replacement, and lists the affected resources before the question:

```console
$ cdkd deploy --require-approval=destructive
...
Destructive changes:
  MyStack: AWS::DynamoDB::Table Table MyTable794EDED1 will be orphaned

Stack MyStack: 0 to create, 1 to update, 1 to delete.
Stack includes destructive updates and "--require-approval" is set to 'destructive'.
Do you wish to deploy these changes? (y/n)
```

| Situation | Behaviour |
| --- | --- |
| Answering no | The stack's deploy fails with nothing changed (exit `1`) |
| `--dry-run` | Never asks |
| No terminal (CI) | The deploy fails instead of asking, unless `--yes` is given |
| A nested stack | Asks for its own changes when the parent reaches it. Declining fails that row and the parent rolls back. |
| Stacks deployed in parallel | Ask one at a time |

Under `any-change`, a parent whose only changes are nested-stack updates does
not ask for them itself. A nested stack's `--resource-timeout` clock stops
while its question is open.

`broadening`, the AWS CDK CLI's default, is not available, because cdkd does
not compute a security diff. The flag refuses it, and a
`"requireApproval": "broadening"` in `cdk.json` is ignored with a warning, so
no approval is asked.

## Checks on the cloud assembly

Right after synthesis, before any macro is expanded, asset published, lock
taken or resource created, `cdkd deploy` checks the assembly's nested templates
and file paths. One malformed stack stops the whole run, `--dry-run` included,
with exit code 1. A CDK-generated `cdk.out` passes all of these; they catch a
hand-modified assembly or one from another tool.

### Cyclic nested templates are refused

Each nested stack's template is located through its parent row's
`Metadata['aws:asset:path']`. cdkd walks every nested template reachable from
each stack in the deploy set, dependencies included, and refuses when a path
resolves to a template already on the same nesting chain:

```text
SynthesisError: The nested template tree under stack Parent contains a
cycle: Child (/path/to/cdk.out/child.json) then Loop
(/path/to/cdk.out/child.json). Nested stack Loop (declared in stack
Parent~Child) resolves to a template that is already on that nesting chain,
so its Metadata['aws:asset:path'] closes a cycle. CDK emits an acyclic nested
template tree with relative asset paths, so this indicates the synth output was
hand-modified or generated by a non-CDK toolchain. Refusing to start the
deploy; nothing has been published or provisioned.
```

- Two sibling rows naming the same template are a shared child and are fine.
  Only a repeat along one root-to-child path is refused.
- A row's `Condition` is not evaluated, so a template that includes itself
  behind a condition is refused too, as by
  [`cdkd diff --recursive`](cli-diff.md).
- An absolute `aws:asset:path` is refused (the message says
  `which is absolute`), because CDK always writes nested templates into the
  output directory.
- A tree nested more than 512 levels deep, or with more than 10,000
  nested-stack rows, is refused.
- A stack outside the deploy set is not checked.

### Paths that leave the assembly directory

The same walk refuses an `aws:asset:path` that resolves outside the directory
its template sits in:

```text
SynthesisError: The nested template tree under stack Parent has nested stack
Child (reached through Child (/path/to/cdk.out/child.json)) with
Metadata['aws:asset:path']=../../etc/passwd which resolves to
/etc/passwd, outside /path/to/cdk.out. CDK emits assembly paths that stay
inside the assembly directory; one that leaves it indicates the synth output
was hand-modified or generated by a non-CDK toolchain. Refusing to start the
deploy; nothing has been published or provisioned.
```

A path that leaves the directory only through a symbolic link is refused the
same way, naming the link's target. Every other path the assembly supplies is
held to the same rule:

| Where it comes from | What cdkd would otherwise do with it |
| --- | --- |
| a nested assembly's `directoryName` | read that directory's `manifest.json` |
| a stack's `templateFile` | deploy whatever parses as its template |
| an asset manifest's `file` | read the list of assets to publish |
| a file asset's `source.path` | zip it and upload it to the bucket the manifest names |
| a Docker asset's `source.directory` | send it to the image build as the context |
| a stack's metadata side file | read its annotations |
| a stack name, under `cdkd synth --verbose` | write `<name>.template.json` there |

The two asset rows are measured against the app's output directory (`cdk.out`),
because a `Stage`'s asset manifest legitimately points up to
`../asset.<hash>`. They treat relative and absolute paths differently:

| `source.path` / `source.directory` | What cdkd does |
| --- | --- |
| absolute, inside the output directory | accepted, silently — this is where every staged asset is |
| absolute, outside it | accepted, **with a warning** naming the directory and the destination |
| naming the output directory *itself*, by any spelling | accepted, **with a warning** — the whole assembly becomes the asset, and no `cdk synth` emits this |
| relative, escaping the output directory | refused |

> [!WARNING]
> An absolute asset path outside the output directory is uploaded. cdkd accepts
> it because `cdk synth --no-staging` produces such paths, and the warning is
> the only protection. An assembly you did not synthesize can name any
> directory your user can read and upload it to a bucket the same manifest
> names, with your credentials.

Pointing `-a` at a Stage sub-assembly (`cdkd deploy -a cdk.out/assembly-MyStage`)
refuses that Stage's own `../asset.<hash>`, since the asset is outside the
directory you named. Point `-a` at the app's `cdk.out` and select the stack by
its display path instead:

```bash
cdkd deploy -a cdk.out 'MyStage/*'
```

The `cdkd local` commands that mount Lambda code (`invoke`, `start-api`,
`start-alb`, `start-cloudfront`) apply the same rule to `aws:asset:path`:
a relative escaping path is refused and an absolute one is accepted with the
warning. [Local Execution](local-emulation.md) lists which other paths are
covered.

### A pre-synthesized assembly is trusted input

Outside the paths above, cdkd uses an asset manifest as written, as the CDK CLI
does. It warns about the values that reach outside the assembly:

| Manifest value | What cdkd does with it | When it warns |
| --- | --- | --- |
| `source.executable` | **runs it on this machine** — an arbitrary command line | on every command that builds a Docker asset, naming the command |
| `dockerFile`, `dockerBuildContexts`, `dockerBuildSecrets`, `dockerBuildSsh`, `cacheFrom`, `cacheTo` | reads that host path during the image build | when the path is outside the output directory; a path inside the build context is usually left quiet |
| a `dest=` in `dockerOutputs` or a cache option | **writes** to that host path | when the path is outside the output directory, wherever the build context is |
| `dest.bucketName`, the ECR repository | uploads there with your credentials | when the name is neither CDK-bootstrap-shaped nor cdkd-managed, once per name |

> [!IMPORTANT]
> Deploying a pre-synthesized assembly can run code from it: a Docker asset may
> declare `source.executable` instead of a Dockerfile. Pointing `-a` at an
> assembly you did not produce is the same decision as running someone else's
> build output. Synthesize it yourself, or read it first.

- Every `cdkd local` command that builds such an asset runs the executable too,
  and prints the warning first.
- Each distinct command is announced once per run; repeats go to `--verbose`.
- A build secret, an SSH key or a cache directory is a host path the template
  never shows, so reading the template does not tell you what a deploy touches.
- The read/write split follows the `dest=` key: a `cacheFrom` carrying a
  `dest=` is a write, and a `cacheTo` carrying a `src=` is a read.
- The destination check looks at the bucket's name only. A bucket named like a
  CDK bootstrap bucket for your account can still belong to someone else.

### A Stage that failed to load stops every command

When a `Stage`'s own `manifest.json` cannot be read (the Stage was never
synthesized, or its directory is gone), cdkd stops, as the AWS CDK CLI does:

```text
Stage MyStage failed to load: ENOENT reading assembly-MyStage/manifest.json.
Every stack under it is missing from the cloud assembly, so cdkd will not act
on the app. Re-synthesize the app so the Stage is written, or point --app at a
complete cloud assembly.
```

This holds whatever you select, including a stack outside the Stage, and for
`cdkd destroy` too. To reach a deployed stack by name without the app, use
`cdkd state destroy '<stack>'`. `cdkd scrub` exits `2`
(`SCRUB_STAGE_LOAD_FAILED`) for it.

Any other refusal under a Stage aborts the run with the innermost Stage named
ahead of it (`Stage MyStage: Stack MyStage-Api ...`).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The deploy finished and every resource cdkd was responsible for was addressed. |
| `1` | A guard on this page refused the run, a `--require-approval` question was declined or could not be asked, or the deploy failed. |
| `2` | A partial outcome: a resource left unaddressed, a macro that failed to expand, or an update rejected as unsupported. |

`--allow-unaddressed` turns the first of those `2` cases back into `0`; the
other two are unaffected by it.

## Related

- [Deploy: waits & concurrency](cli-deploy.md) — concurrency knobs and the wait-semantics table
- [Deploy: tuning](cli-deploy-tuning.md) — timeouts, name prefixing, observed-state capture
- [Destroy flags & guards](cli-destroy.md) — the destroy-side data guards and `--remove-protection`
- [Provisioning Layers](provisioning-layers.md) — the SDK provider and Cloud Control routes
- [Supported Resources](supported-resources.md) — the per-type tier table and property-level coverage
- [Cross-Stack References](cross-stack-references.md) — the full design behind `--no-cfn-fallback`
- [cdkd State Management Specification](state-management.md) — where `provisionedBy` lives in the state record
- [Deploy safety internals](cli-deploy-safety-internals.md) — the exact rules behind the guards on this page
