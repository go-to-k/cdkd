---
title: "Provisioning Layers"
description: "How cdkd decides whether a resource is managed by a hand-written SDK provider or the Cloud Control API, when that decision changes, and which flag to reach for."
---

# Provisioning Layers

cdkd provisions every resource through one of two layers:

| Layer | `provisionedBy` | What it is |
| --- | --- | --- |
| **SDK provider** | `sdk` | A hand-written provider calling the service's own AWS SDK client directly. Fast, with service-specific error handling and a narrow IAM surface — but it only covers the properties someone wired. |
| **Cloud Control API** | `cc-api` | AWS's generic resource API. Covers every property in the CloudFormation resource schema, for far more types than cdkd has SDK providers for, but each call is slower. |

The hybrid is deliberate: the SDK provider is the fast path, and Cloud Control
is the fallback that keeps cdkd correct for everything the fast path does not
reach. Which types have which is in
[Supported Resources](supported-resources.md).

You mostly do not have to think about this. It becomes visible in three
situations — a deploy that is slower than you expect, a `cdkd diff` annotation
you did not ask for, and a property you set that does not show up in AWS — and
each has a different answer.

## How cdkd picks

The layer is decided per resource, per deploy, in this order:

1. **A resource already recorded `cc-api` normally stays there.** This is the
   *sticky* rule. Without it, every release that added an SDK provider would
   drag existing resources back across the boundary, and moving a resource
   between layers used to mean destroying and recreating it.
2. **Otherwise, if a hand-written SDK provider exists for the type, cdkd checks
   the template's properties against it.** If the SDK provider covers all of
   them, the resource goes to the SDK provider.
3. **If the template carries a top-level property the SDK provider would
   silently drop, cdkd routes the resource through Cloud Control instead**, so
   the property actually reaches AWS. This is the *auto-route*, and it is on by
   default because a silently dropped property is a bug class, not a
   convenience. It applies to an **already-deployed** resource too, not only a
   fresh one: the decision is re-made every deploy. Where the type's SDK-stored
   physical id is also a valid Cloud Control identifier — true per type, not in
   general — that write is an update in place, with the physical id preserved
   and nothing recreated. It holds after an
   [`--allow-unsupported-properties`](cli-deploy-safety.md#the-override) deploy
   too: cdkd records only what the SDK provider sent, so dropping the flag makes
   the property a genuine addition and the auto-route delivers it — except for a
   create-only property, which cdkd keeps in the record because applying one to
   a live resource needs a replacement
   ([the override](cli-deploy-safety.md#the-override) lists the exceptions).
   Measured on a live resource by
   [`tests/integration/sdk-to-cc-autoroute/`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/sdk-to-cc-autoroute/).
4. **If no SDK provider exists for the type**, Cloud Control handles it.

Step 3 is what makes the choice look surprising: adding one property to a
template can change which layer manages the resource. `cdkd diff` says so
before it happens, annotating the resource `[via CC API: <property>]`.

## Seeing which layer a resource is on

```bash
cdkd state show MyStack

# MyTopic
#   Type: AWS::SNS::Topic
#   PhysicalID: arn:aws:sns:us-east-1:123456789012:MyTopic
#   ProvisionedBy: cc-api
```

`ProvisionedBy: (sdk, legacy default)` means the record predates the field and
is treated as SDK-managed. It is not pinned — routing is re-decided from
scratch for such a resource.

## Coming back from Cloud Control

The sticky rule has narrow, per-type exemptions, and they are the reason a
resource can move back to the SDK provider **without being destroyed and
recreated**. Every exempt type has been verified to satisfy one hard
requirement: the SDK provider addresses the resource by the *same* physical id
Cloud Control stored, so the move costs no churn.

Exempt types differ in why they were admitted, and that decides how automatic
the move is:

- **Cloud Control cannot manage the type correctly.** Staying pinned keeps a
  live bug alive, so the move is unconditional and cannot be declined.
- **Cloud Control works and is merely slower**, and cdkd has since gained full
  property coverage for the type. The move happens on the next deploy that
  changes the resource, provided neither the template's properties nor the
  recorded ones carry anything the SDK provider would drop. It **can** be
  declined for a single deploy.

Either way it is an **update in place**: the physical id is preserved, so
references to the resource and any out-of-band configuration attached to it
survive. `cdkd diff` shows it first:

```
  [~] MyTopic (AWS::SNS::Topic) [returning to SDK provider]
```

and `cdkd deploy` names it as it happens:

```
MyTopic (AWS::SNS::Topic): returning to the SDK provider — cdkd now covers every property this resource uses. The physical id is preserved; pass --pin-cc-api MyTopic to decline this for a deploy.
```

Which types are exempt changes as coverage lands, so the list is not restated
here — it is `STICKY_CC_MIGRATION_EXEMPT` in
[`src/provisioning/provider-registry.ts`](https://github.com/go-to-k/cdkd/blob/main/src/provisioning/provider-registry.ts),
and the rule it implements is in
[State Management](state-management.md#version-7-adds-provisionedby-v7-writers).

For a type that is **not** exempt, the move is still available, but it destroys
and recreates the resource — see the table below.

## Choosing a flag

| You want | Situation | Do this |
| --- | --- | --- |
| A property the SDK provider drops to reach AWS | The resource is not in cdkd state yet | Nothing — the fresh deploy auto-routes it through Cloud Control |
| The same, on a resource already deployed | `ProvisionedBy: sdk` | Usually nothing — the routing decision is re-made every deploy, so the next one auto-routes the resource through Cloud Control, normally as an in-place update. [`--recreate-via-cc-api`](cli-deploy-safety.md#recreate-via-cc-api-deploy) is for the narrower case where that update cannot deliver the property |
| To keep SDK semantics and accept the dropped property instead | Either | [`--allow-unsupported-properties <Type>:<Prop>`](cli-deploy-safety.md#allow-unsupported-properties-deploy) |
| To move a resource back to the SDK provider | `ProvisionedBy: cc-api`, type not exempt from the sticky rule | [`--recreate-via-sdk-provider <LogicalId>`](cli-deploy-safety.md#recreate-via-sdk-provider-deploy) — destroys and recreates |
| The same, without destroying anything | `ProvisionedBy: cc-api`, type exempt because cdkd now covers it | Nothing — the next deploy that changes the resource moves it in place |
| To decline that automatic move for one deploy | Same as above | [`--pin-cc-api <LogicalId>`](cli-deploy-safety.md#pin-cc-api-deploy) |

Two things the shape of that table follows from:

- **The two `--recreate-via-*` flags destroy and recreate the resource.** They
  change which layer *created* it, not merely which one handles the next update.
  Both are per-resource — no bulk form, so the cost is acknowledged for each
  target — both refuse a stateful type unless
  [`--force-stateful-recreation`](cli-deploy-safety.md#force-stateful-recreation)
  is also passed, and both prompt before doing anything.
- **`--pin-cc-api` destroys nothing.** It declines a routing change for one
  deploy and is not stored anywhere, so it fits "I disagree with this deploy's
  routing", not a standing preference. It has no effect on a type exempt because
  Cloud Control cannot manage it — honouring the pin there would hold the
  resource on the handler that cannot address it.

Each flag's full behaviour, guards and refusals are in
[Deploy: safety & compatibility flags](cli-deploy-safety.md).

## Related

- [Deploy: safety & compatibility flags](cli-deploy-safety.md) — the flags above, in full
- [State Management](state-management.md#version-7-adds-provisionedby-v7-writers) — how `provisionedBy` is stored and migrated
- [Supported Resources](supported-resources.md) — which types have an SDK provider
- [Troubleshooting](troubleshooting.md#deployment-is-slow) — the symptom side
