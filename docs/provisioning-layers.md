---
title: "Provisioning Layers"
description: "How cdkd decides whether a resource is managed by an SDK provider or the Cloud Control API, when that decision changes, and which flag to reach for."
---

# Provisioning Layers

cdkd creates, updates and deletes every resource through one of two layers:

| Layer | `provisionedBy` | What it is | Trade-off |
| --- | --- | --- | --- |
| **SDK provider** | `sdk` | Code in cdkd that calls the service's own AWS SDK client | Fast, but covers only the properties it was written for |
| **Cloud Control API** | `cc-api` | AWS's generic resource API | Covers every property in the type's CloudFormation schema, but each call is slower |

The SDK provider is the fast path. Cloud Control is the fallback for
everything the fast path does not reach. Which types have an SDK provider is
listed in [Supported Resources](supported-resources.md).

You rarely need to think about this. It becomes visible in three situations:

- a deploy is slower than you expected,
- `cdkd diff` shows an annotation such as `[via CC API: <property>]`,
- a property you set does not show up in AWS.

## How cdkd picks

cdkd decides the layer for each resource on every deploy:

```text diagram=guide-provisioning-route
  Already recorded as cc-api in state? ── yes ─▶ stays on Cloud Control
        │ no                                     (a few types are exempt)
        ▼
  Does an SDK provider exist for the type? ─ no ─▶ Cloud Control
        │ yes
        ▼
  Does it cover every top-level property ── no ─▶ Cloud Control (auto-route),
  in the template?                                so the property reaches AWS
        │ yes
        ▼
  SDK provider
```

1. **A resource recorded as `cc-api` stays there.** This is the sticky rule.
   It keeps a new cdkd release that adds an SDK provider from moving your
   existing resources between layers. A resource the deploy replaces is a new
   resource and is routed by the next steps.
2. **If no SDK provider exists for the type**, Cloud Control handles it.
3. **If the template sets a top-level property the SDK provider would drop**,
   cdkd routes the resource through Cloud Control so the property reaches
   AWS. This is the auto-route, and it is on by default.
4. **Otherwise** the SDK provider handles it.

Step 3 is why the layer can change when you add one property to a template.
`cdkd diff` shows it before it happens, by annotating the resource
`[via CC API: <property>]`.

## Seeing which layer a resource is on

```bash
cdkd state show MyStack
```

```text
MyTopic
  Type: AWS::SNS::Topic
  PhysicalID: arn:aws:sns:us-east-1:123456789012:MyTopic
  ProvisionedBy: cc-api
```

`ProvisionedBy: (sdk, legacy default)` means the record was written before
cdkd stored the layer. The resource is treated as SDK-managed and is not
pinned: its layer is decided from scratch on the next deploy.

## Adding a property moves a deployed resource to Cloud Control

The auto-route applies to a resource that is already deployed, because the
decision is made again on every deploy. For most types this is an update in
place: the physical id is preserved and nothing is recreated. That holds
where the id the SDK provider stored is also a valid Cloud Control
identifier, which is true per type and not in general.

To keep the resource on the SDK provider and accept that the property is
dropped, pass [`--prefer-sdk-route <Type>:<Prop>`](cli-deploy-safety.md). If
you drop the flag later, the next deploy delivers the property through the
auto-route.

### Create-only properties need a replacement

A create-only property cannot be applied to a live resource. If an earlier
deploy dropped one under `--prefer-sdk-route`, cdkd remembers that. A later
deploy that no longer covers the property refuses with
`CREATE_ONLY_DROP_NEEDS_REPLACEMENT` until you opt into the replacement with
`--recreate-via-cc-api` or `--replace`. A deploy stops covering it when you
remove the flag, or when another dropped property routes the whole resource
through Cloud Control.

The refusal comes when the deploy reaches that resource. Other resources of
the same deploy may already have changed, and they roll back with it.

This applies only to a property an earlier deploy recorded as dropped. cdkd
takes the create-only properties of an imported resource, and of a record
written by an older cdkd, to be in AWS already.

## Coming back from Cloud Control

The sticky rule has per-type exemptions. An exempt type can move back to the
SDK provider without being destroyed and recreated, because for these types
the SDK provider addresses the resource by the same physical id Cloud Control
stored.

| Why the type is exempt | When it moves | Can you decline |
| --- | --- | --- |
| Cloud Control cannot manage the type correctly | Unconditionally | No |
| Cloud Control works but is slower, and cdkd now covers every property of the type | On the next deploy that changes the resource, if neither the template nor the record carries a property the SDK provider would drop | Yes, for one deploy, with `--pin-cc-api` |

Either way it is an update in place. The physical id is preserved, so
references to the resource and any configuration attached to it outside cdkd
survive. `cdkd diff` shows the move first:

```text
  [~] MyTopic (AWS::SNS::Topic) [returning to SDK provider]
```

and `cdkd deploy` names it as it happens:

```text
MyTopic (AWS::SNS::Topic): returning to the SDK provider — cdkd now covers every property this resource uses. The physical id is preserved; pass --pin-cc-api MyTopic to decline this for a deploy.
```

The set of exempt types grows as cdkd's coverage does, so it is not listed
here. For a type that is not exempt, the move is still possible, but it
destroys and recreates the resource. See the table below.

## Choosing a flag

| You want | Situation | Do this |
| --- | --- | --- |
| A property the SDK provider drops to reach AWS | The resource is not deployed yet | Nothing. The first deploy auto-routes it through Cloud Control. |
| The same, on a deployed resource | `ProvisionedBy: sdk` | Usually nothing. The next deploy auto-routes it, normally as an in-place update. |
| The same, when that in-place update cannot deliver the property | `ProvisionedBy: sdk` | `--recreate-via-cc-api <LogicalId>`: destroys and recreates |
| To stay on the SDK provider and accept the dropped property | Either | `--prefer-sdk-route <Type>:<Prop>` |
| To move a resource back to the SDK provider | `ProvisionedBy: cc-api`, type not exempt | `--recreate-via-sdk-provider <LogicalId>`: destroys and recreates |
| The same, without destroying anything | `ProvisionedBy: cc-api`, type exempt because cdkd now covers it | Nothing. The next deploy that changes the resource moves it in place. |
| To decline that automatic move for one deploy | Same as above | `--pin-cc-api <LogicalId>` |

> [!WARNING]
> `--recreate-via-cc-api` and `--recreate-via-sdk-provider` destroy the
> resource and create a new one. Each names one resource and prompts first.
> Both refuse a stateful type unless you also pass
> `--force-stateful-recreation`, which accepts losing its data.

`--pin-cc-api` destroys nothing. It declines a routing change for one deploy
and is not stored, so it does not express a standing preference. It has no
effect on a type that is exempt because Cloud Control cannot manage it.

Each flag's full behavior, guards and refusals are in
[Deploy: safety & compatibility flags](cli-deploy-safety.md).

## Related

- [Deploy: safety & compatibility flags](cli-deploy-safety.md): the flags
  above, in full
- [State Management](state-management.md): how `provisionedBy` is stored
- [Supported Resources](supported-resources.md): which types have an SDK
  provider
- [Troubleshooting](troubleshooting.md): what to do when a deploy is slow
