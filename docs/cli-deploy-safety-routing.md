---
title: "cdkd deploy: provisioning route flags"
description: "How cdkd deploy chooses between its SDK providers and Cloud Control API for each resource, and the flags that change the choice."
---

# cdkd deploy: provisioning route flags

cdkd creates and updates each resource through one of two routes. An **SDK
provider** is cdkd's own code for one resource type, and it is the faster
route. **Cloud Control API** is AWS's generic resource API. cdkd chooses the
route for each resource by itself, so most deploys need none of the flags on
this page.

```bash
# cdkd picks every route
cdkd deploy MyStack
cdkd deploy MyStack \
  --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig

# hold one resource on Cloud Control
cdkd deploy MyStack --pin-cc-api MyListener
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh
```

This page is part of
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md).
[Provisioning Layers](provisioning-layers.md) explains the two routes in
depth.

## Which flag, when

| You want | Flag | Cost |
| --- | --- | --- |
| A property the SDK provider does not write to reach AWS | None | None; updated in place |
| To stay on the SDK provider without that property | [`--prefer-sdk-route`](#prefer-sdk-route-deploy) | The property is missing in AWS |
| To hold a resource on Cloud Control for one deploy | [`--pin-cc-api`](#pin-cc-api-deploy) | None; the resource is not touched |
| To move a resource to the other route | [`--recreate-via-cc-api` / `--recreate-via-sdk-provider`](cli-deploy-safety-recreate.md) | Destroy and recreate |
| To try a type cdkd reports as unsupported | [`--allow-unsupported-types`](#allow-unsupported-types-deploy-destroy) | Cloud Control will likely fail |

## How cdkd picks a route

A resource whose type has an SDK provider uses it, unless your template sets a
property that provider does not write. In that case cdkd sends the resource
through Cloud Control instead, because Cloud Control forwards the whole
property map to AWS. You pass no flag, and the deploy logs one line for the
resource:

```text
[info] MyLambda (AWS::Lambda::Function): routing via Cloud Control API
       (cdkd's SDK Provider does not yet wire CapacityProviderConfig — CC API
        will forward the full property map. Override via
        --prefer-sdk-route AWS::Lambda::Function:CapacityProviderConfig.)
```

```text diagram=safety-route-choice
A resource is about to be created or updated
        |
        v
Does its type have an SDK provider? ------------- no --> Cloud Control
        | yes
        v
Is it already recorded on Cloud Control? -------- yes -> Cloud Control
        | no
        v
Does the template set a property the
SDK provider does not write? -------------------- no --> SDK provider
        | yes
        v
Is every such property named in
--prefer-sdk-route? ----------------------------- no --> Cloud Control
        | yes
        v
SDK provider; the named properties are not written to AWS
```

cdkd records the route with the resource in its state, as `provisionedBy`.
`cdkd state show '<stack>'` prints it as `ProvisionedBy:`. A resource recorded
on Cloud Control stays there: later deploys, `cdkd drift` and `cdkd destroy`
use the route that created it. A few types are the exception and return to
the SDK provider by themselves, which [`--pin-cc-api`](#pin-cc-api-deploy)
describes. A resource recorded on the SDK provider is judged again on every
deploy, so adding such a property later moves it to Cloud Control in place,
with its physical ID kept.

A type with no SDK provider always goes through Cloud Control, and every
property in the template is sent.

### Properties that do not change the route

Three kinds of property leave the resource on its SDK provider. cdkd warns and
names the property in each case.

- A read-only property, such as an ARN or an ID that AWS assigns. No engine
  sets one. CloudFormation ignores it, and Cloud Control would record it as
  the resource's identifier.
- A property cdkd's bundled schema does not know, on a type Cloud Control
  cannot manage. There is no Cloud Control route for that type.
- A property cdkd's bundled schema does not know, whose value has not changed
  since the resource was deployed on the SDK provider. An existing resource
  keeps its route, and changing the value moves it.

A property the bundled schema does not know also covers a property AWS
published later, a typo, and an `addPropertyOverride` key. On any other
resource it moves the resource to Cloud Control like a known one. Cloud
Control then applies a real property and rejects a misspelled one with
`Model validation failed (#: extraneous key [...] is not permitted)`, as
CloudFormation does.

## `--prefer-sdk-route` (deploy)

`--prefer-sdk-route` keeps a resource on its SDK provider when cdkd would
otherwise move it to Cloud Control. The price is that the property you name is
not written to AWS.

```bash
CAPACITY=AWS::Lambda::Function:CapacityProviderConfig
SCALING=AWS::Lambda::Function:FunctionScalingConfig
cdkd deploy MyStack --prefer-sdk-route "$CAPACITY,$SCALING"
```

Each entry is a `<ResourceType>:<PropertyName>` pair. Separate entries with
commas or repeat the flag. cdkd logs a warning for each property it leaves
out.

Use the flag when:

- the property does not matter to you and you want the SDK provider's faster
  calls;
- Cloud Control would name the resource differently than the SDK provider;
- a resource on the SDK provider gained such a property and you want the
  resource to stay where it is.

Do not use it for a security-relevant property: a KMS key, an IAM or resource
policy, encryption or TLS settings. If you have no preference about the
route, leave the flag off, because the default already gets the property to
AWS.

cdkd does not store the flag. Pass it on every deploy for as long as you want
the override. A deploy without it moves the resource to Cloud Control.

### What state records, and what `cdkd diff` shows

State describes what cdkd sent to AWS, so a property left out this way is
left out of the resource's state record too. Two things follow.

Removing the flag is usually enough to apply the property. The next deploy
sees the property as an addition, moves the resource to Cloud Control, and
updates it in place.

`cdkd diff` has no `--prefer-sdk-route`, so it previews the deploy without the
flag. It shows the property as a pending change marked `[via CC API: <Prop>]`.
A deploy that passes the flag reports no change for that property.

### When the flag does not do what you expect

In the first two cases below the property you named reaches AWS after all,
and cdkd warns that `--prefer-sdk-route had no effect` for it.

- **The resource has a second such property that you did not name.** One
  uncovered property moves the whole resource to Cloud Control, which writes
  every property. The warning names the entry to add.
- **The resource is already recorded on Cloud Control.** The flag changes
  nothing, and Cloud Control keeps writing every property. Moving the resource
  back is a destroy and recreate: see
  [`--recreate-via-sdk-provider`](cli-deploy-safety-recreate.md#recreate-via-sdk-provider-deploy).
- **The property is create-only**, which means AWS accepts it only when the
  resource is created. cdkd accepts the flag, but removing it later cannot
  apply the property in place. See
  [`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`](cli-deploy-safety-recreate.md#create-only-drop-needs-replacement).
- **Cloud Control cannot manage the type at all.** Removing the flag later
  makes the deploy refuse before it touches anything. The warning says so when
  you first pass the flag.

## `--pin-cc-api` (deploy)

`--pin-cc-api <LogicalId>` keeps a resource that is recorded on Cloud Control
on Cloud Control for this deploy. The resource itself is not touched. The flag
only decides which route issues its update.

```bash
cdkd deploy MyStack --pin-cc-api MyListener
```

The flag exists because a few types return to the SDK provider by themselves.
For those types Cloud Control works but is slower. On the next deploy that
changes such a resource, cdkd moves it back in place and keeps its physical
ID, provided neither the template nor the state record carries a property the
SDK provider does not write. `cdkd diff` marks the pending move
`[returning to SDK provider]`.

The pin declines that move for one deploy. You might want that while you
investigate a problem and need the same route as last time. Pass the flag
again on the next deploy, or stop passing it and let the move happen.

> [!NOTE]
> Pinning keeps Cloud Control's behaviour for that deploy, gaps included. For
> an `AWS::ElasticLoadBalancingV2::Listener`, a deploy that removes a
> `ListenerAttributes` key under the pin leaves the key at its old value. The
> SDK provider is the route that resets it.

### Edge cases

- **A logical ID that no stack in the run has** is an error, raised before any
  stack deploys. The flag prints nothing when it works, so a typo would
  otherwise pass unnoticed.
- **Under `--all`**, an ID that only some stacks have is reported once. The
  message names the stacks that have it and the stacks that do not.
- **A resource already on the SDK provider, or a new resource**: the flag has
  no effect.
- **A type that left Cloud Control because Cloud Control cannot manage it**,
  such as `AWS::Scheduler::Schedule`: the pin is ignored.
- **A resource that the deploy replaces**: the new resource gets its route
  like any new resource.
- **A resource inside a nested stack** cannot be reached from the parent. Pass
  the flag in a deploy of that child stack.
- **The same ID in `--recreate-via-sdk-provider`** is refused, because the two
  flags ask for opposite things.

## `--allow-unsupported-types` (deploy + destroy)

cdkd refuses an unsupported resource type before it touches any resource. A
type is unsupported when AWS reports it as `NON_PROVISIONABLE`, which means
Cloud Control cannot create, update or delete it, and cdkd has no SDK provider
for it. The error names each type and the command to re-run:

```text
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

`--allow-unsupported-types` takes a list of types and attempts each one
through Cloud Control anyway. Separate the types with commas or repeat the
flag. Pass the same list to `cdkd destroy` or `cdkd state destroy` when you
tear the stack down.

```bash
cdkd deploy MyStack \
  --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
cdkd destroy MyStack \
  --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
```

Cloud Control will likely still fail for these types. The flag helps when AWS
has made a type provisionable since cdkd's bundled coverage data was built.
The cdkd release that refreshes that data makes the flag unnecessary.

## Related

- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): what each
  refusal means, and the stateful-resource guard
- [cdkd deploy: recreating a resource on the other route](cli-deploy-safety-recreate.md):
  `--recreate-via-cc-api` and `--recreate-via-sdk-provider`
- [Provisioning Layers](provisioning-layers.md): the two routes in depth
- [Supported Resources](supported-resources.md): which types have an SDK
  provider, and property-level coverage
- [cdkd State Management Specification](state-management.md): where
  `provisionedBy` lives in the state record
