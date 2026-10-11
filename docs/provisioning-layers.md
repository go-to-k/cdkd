---
title: "Provisioning Layers"
description: "How cdkd decides whether a resource is managed by an SDK provider or the Cloud Control API, when that decision changes, and which flag to reach for."
---

# Provisioning Layers

cdkd creates, updates and deletes every resource in one of two ways, called
provisioning layers:

- An **SDK provider** is code inside cdkd, written for one resource type,
  that calls that service's API directly. It is fast, but it handles only the
  properties it was written for.
- The **Cloud Control API** is AWS's generic API for managing resources. It
  handles every property in the type's CloudFormation schema, but each call
  is slower.

cdkd uses the SDK provider where it can and Cloud Control for everything
else. [Supported Resources](supported-resources.md) lists which types have an
SDK provider.

cdkd chooses the layer for you, so most of the time you can ignore it. This
page is for the three situations where the layer shows:

- a deploy is slower than you expected,
- `cdkd diff` marks a resource with `[via CC API: <property>]`,
- a property you set does not appear in AWS.

## How cdkd picks

On every deploy, cdkd asks three questions about each resource:

```text diagram=guide-provisioning-route
  Already recorded as cc-api in state? ── yes ─▶ stays on Cloud Control
        │ no                                     (a few types move back)
        ▼
  Does an SDK provider exist for the type? ─ no ─▶ Cloud Control
        │ yes
        ▼
  Does it handle every top-level property ─ no ─▶ Cloud Control,
  in the template?                                so the property reaches AWS
        │ yes
        ▼
  SDK provider
```

1. **Is the resource already on Cloud Control?** cdkd records the layer of
   every resource in state, its record of what it deployed. A resource
   recorded as `cc-api` stays on Cloud Control, with the exceptions described
   under [Moving back to the SDK provider](#moving-back-to-the-sdk-provider).
2. **Does cdkd have an SDK provider for the type?** If not, the resource goes
   through Cloud Control.
3. **Does the SDK provider handle every top-level property the template
   sets?** If the provider would leave one out, cdkd sends the resource
   through Cloud Control, so that the property reaches AWS.

When all three answers allow it, the SDK provider handles the resource.

A resource that the deploy replaces counts as a new resource. Question 1 does
not apply to it, and cdkd chooses its layer from questions 2 and 3.

## Example: one new property changes the layer

Suppose `HttpApi` is deployed through its SDK provider, and you then set a
property that the provider does not handle. `cdkd diff` shows what the next
deploy will do:

```text
  [~] HttpApi (AWS::ApiGatewayV2::Api) [via CC API: Body]
```

The annotation says that the resource will go through Cloud Control because
of the `Body` property. You do not have to do anything. The next
`cdkd deploy` updates the resource through Cloud Control, and the property
reaches AWS.

For most types this is an update in place: the resource keeps its physical
ID and nothing is recreated. Whether that works depends on the type, because
the ID that the SDK provider stored must also be an identifier Cloud Control
accepts.

## See which layer a resource is on

```bash
cdkd state show MyStack
```

```text
MyTopic
  Type: AWS::SNS::Topic
  PhysicalID: arn:aws:sns:us-east-1:123456789012:MyTopic
  ProvisionedBy: cc-api
```

`ProvisionedBy` is `sdk` or `cc-api`. A third value,
`(sdk, legacy default)`, appears on a resource deployed by a cdkd version
that did not record the layer yet. cdkd treats such a resource as managed by
the SDK provider, and chooses its layer afresh on the next deploy.

## Keep a resource on the SDK provider: `--prefer-sdk-route`

If you would rather keep the faster SDK provider and do without the property,
name the type and the property:

```bash
cdkd deploy MyStack --prefer-sdk-route AWS::ApiGatewayV2::Api:Body
```

The resource stays on the SDK provider, and the property is not sent to AWS.
The flag applies to the deploy you pass it to. On a later deploy without the
flag, cdkd sends the resource through Cloud Control and the property reaches
AWS.

## Moving back to the SDK provider

A resource on Cloud Control stays there. This is deliberate: when a new cdkd
release adds an SDK provider for a type, your existing resources of that type
do not change layer underneath you.

Some types are exceptions and do move back on their own. For these types the
SDK provider finds the resource by the same physical ID that Cloud Control
stored, so the move is an update in place. Nothing is destroyed, references
to the resource keep working, and configuration attached to the resource
outside cdkd survives.

There are two kinds of exception:

- **Cloud Control cannot manage the type correctly.** The resource moves to
  the SDK provider unconditionally, and you cannot decline.
- **Cloud Control works but is slower, and cdkd now handles every property
  of the type.** The resource moves on the next deploy that changes it,
  provided that neither the template nor state holds a property the SDK
  provider would leave out. You can decline for one deploy with
  `--pin-cc-api`.

`cdkd diff` shows the move before it happens:

```text
  [~] MyTopic (AWS::SNS::Topic) [returning to SDK provider]
```

`cdkd deploy` names it as it happens:

```text
MyTopic (AWS::SNS::Topic): returning to the SDK provider — cdkd now covers every property this resource uses. The physical id is preserved; pass --pin-cc-api MyTopic to decline this for a deploy.
```

The set of types that move back grows with cdkd's coverage, so this page
does not list them. A resource of any other type can still move back, but
only by being destroyed and recreated, as the next section describes.

## Move a resource by recreating it

Two flags move one resource to the other layer by destroying it and creating
it again:

```bash
# SDK provider -> Cloud Control
cdkd deploy MyStack --recreate-via-cc-api MyFunction

# Cloud Control -> SDK provider
cdkd deploy MyStack --recreate-via-sdk-provider MyFunction
```

Use `--recreate-via-cc-api` when a property needs Cloud Control and the
update in place cannot deliver it. Use `--recreate-via-sdk-provider` to bring
a resource back when its type does not move back on its own.

> [!WARNING]
> Both flags destroy the resource and create a new one. Each names one
> resource and asks for confirmation first. Both refuse a stateful type
> unless you also pass `--force-stateful-recreation`, which accepts losing
> its data.

## Which flag to use

| You want | Do this |
| --- | --- |
| A property the SDK provider leaves out to reach AWS | Nothing; cdkd uses Cloud Control |
| The same, when the update in place cannot deliver it | `--recreate-via-cc-api <LogicalId>` |
| To stay on the SDK provider without the property | `--prefer-sdk-route <Type>:<Prop>` |
| To move a resource back to the SDK provider | Nothing, if its type moves back on its own |
| The same, for any other type | `--recreate-via-sdk-provider <LogicalId>` |
| To decline an automatic move back, for one deploy | `--pin-cc-api <LogicalId>` |

`--pin-cc-api` destroys nothing. It declines the move for one deploy and is
not stored, so it does not set a lasting preference. It has no effect on a
type that moves back because Cloud Control cannot manage it.

[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) documents each
flag in full, with its guards and refusals.

## Edge cases

### A create-only property that an earlier deploy left out

A create-only property can be set only when a resource is created. Suppose an
earlier deploy left one out because you passed `--prefer-sdk-route`. cdkd
remembers that. If a later deploy would send the property, cdkd cannot apply
it to the live resource, so the deploy is refused with
`CREATE_ONLY_DROP_NEEDS_REPLACEMENT`.

A later deploy would send the property in two cases: you removed the flag, or
another property that the SDK provider leaves out moved the whole resource to
Cloud Control.

To proceed, opt into replacing the resource with `--recreate-via-cc-api` or
`--replace`.

The refusal comes when the deploy reaches that resource. Other resources in
the same deploy may already have changed by then, and they are rolled back
together with it.

The refusal applies only to a property that an earlier deploy recorded as
left out. For an imported resource, and for a resource whose state was
written by an older cdkd, cdkd assumes the create-only properties are already
in AWS.

## Related

- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): the flags
  above, in full
- [State Management](state-management.md): how the layer is stored in state
- [Supported Resources](supported-resources.md): which types have an SDK
  provider
- [Troubleshooting](troubleshooting.md): what to do when a deploy is slow
