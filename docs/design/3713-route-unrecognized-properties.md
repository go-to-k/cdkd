---
title: "Routing a property absent from the CFn schema snapshot — Design"
unlisted: true
---

# Routing a property absent from the CFn schema snapshot — Design

Tracking: [#3713](https://github.com/go-to-k/cdkd/issues/3713)
Status: **Accepted — implemented.**

cdkd chooses between an SDK provider and Cloud Control from a table built
offline from `tests/fixtures/cfn-schemas/*.json`. A top-level template key
absent from that snapshot (an *unrecognized* key) is either a property AWS
published after the snapshot, a typo, or an `addPropertyOverride` escape hatch.
Such a key used to stay on the SDK route, so a newly published property never
reached AWS until the daily schema-refresh PR merged. The deploy still reported
success, with a warn as the only signal.

It now routes the resource through Cloud Control, the way a known silent drop
does. This page records why, what stays excluded, and what must not change.

## Decision

| Question | Decision |
| --- | --- |
| Does an unrecognized key route to Cloud Control? | Yes, unless one of the exclusions below applies. |
| Is the lookup done at runtime (`DescribeType`)? | No. It is a set lookup on the generated table: speed is cdkd's first priority. |
| Does it change an existing deployment? | No. A key the state record already holds with a deep-equal value keeps the resource on its route. |
| Do the state / diff narrowings see unrecognized keys? | No. They stay schema-known only. |
| Does the daily refresh job stay? | Yes. It still feeds the SDK backfill list and keeps the read-only, create-only and nested-required data current. It no longer gates whether a new property reaches AWS. |

## Why the old rule no longer held

| Old premise | Finding |
| --- | --- |
| "CloudFormation tolerates unknown keys" (#608). | False. `AWS::SNS::Topic` and `AWS::SQS::Queue` with `FooBarTypo` both fail `PROPERTY_VALIDATION: Unsupported property [FooBarTypo]` (us-east-1, 2026-09-25). All 1795 public registry schemas declare top-level `additionalProperties: false`. |
| "A typo would pin the resource to `cc-api`" (#2719 rationale). | Does not happen. `provisionedBy` is written only after a successful provider call, and Cloud Control rejects the key, so no record flips. |
| "CDK emits keys the snapshot lacks." | Not observed: 0 unrecognized keys across the 99 SDK-route resources of 15 synthesized integ templates. L1 constructs are generated from the same registry schema. |

## Exclusions

Each exclusion is derivable offline, so the predicate stays a table lookup.

| Excluded | Why |
| --- | --- |
| A read-only key | CloudFormation **ignores** one: `AWS::SNS::Topic` with `TopicArn` set reaches `CREATE_COMPLETE`. Cloud Control does not refuse one either, but trusts it: `CreateResource` for `AWS::SNS::Topic` with a bogus `TopicArn` succeeded, created the real topic under its generated ARN, and reported the BOGUS value as the `Identifier`. cdkd would record that as the physical id and later update or delete the wrong ARN, orphaning the real topic. The generator emits the schema's `readOnlyProperties` for this. |
| `Ref` / `Fn::*` keys | Intrinsic keys, not property names. |
| A key in `--prefer-sdk-route` | The user chose the drop. |
| A type whose SDK provider declares `disableCcApiFallback`, or `NON_PROVISIONABLE` | There is no Cloud Control route. Routing would make `getProviderFor` refuse a template it deploys today. |
| A `'cc-broken'` sticky-CC exemption (`AWS::Scheduler::Schedule`) | Its Cloud Control handler cannot manage the type: a schedule in a custom group fails UPDATE with NotFound, so routing a real new property would break a deploy that works today. |
| A key the state record holds unchanged (compared as JSON, so a prototype or key-order difference is not a change; a recorded `{{resolve:...}}` secret cannot be compared and counts as unchanged) | Zero regression for existing deployments. Without it, an unrelated update would flip an SDK resource to Cloud Control, failing on a typo or on a type whose SDK physical id is not Cloud Control's identifier. Changing or adding the key is what routes. |

The generator folds the last two rows into `ccRouteUnavailable`, reading
`disableCcApiFallback` from provider source and the `'cc-broken'` entries from
`STICKY_CC_MIGRATION_EXEMPT`; a unit test binds it to the runtime flag and
table in both directions.

What stays on the SDK route is still warned about, naming which of the three
reasons applies (read-only, unroutable type, unchanged since an SDK-route
deploy).

## Invariants

- **One routing predicate.** `findActionableSilentDrops` returns schema-known
  drops plus `findRoutableUnrecognizedProperties`. `getProviderFor`, the plan
  annotation, `cdkd diff`, the recreate validators and the pre-flight log all
  read it, so none can disagree with the route.
- **Every existing-resource caller threads the record's bag** as the baseline
  (`previousProperties` / `recordedProperties`): the update dispatch, both
  replacement creates and the replacement progress label, the stale-attribute
  heal read, the pre-flight report, the no-change skip, the diff narrowing,
  the recreate validators and the diff annotation. A caller that omits it gets
  presence semantics, which is correct only for a new physical resource.
- **A value that cannot be compared** is a recorded `{{resolve:...}}` secret
  (counted as unchanged) or a RAW template value holding an intrinsic. The raw
  case reaches only callers that read the raw bag, and each picks its side
  (`unresolvedAs`): the pre-flight report, `cdkd diff` and the progress label
  count it as unchanged, so they never announce a route the resolved decision
  may not take, and the pre-flight warn says the route is decided once the
  value resolves; the recreate validators (both the `--recreate-via-cc-api`
  overlap check and the `--recreate-via-sdk-provider` round-trip check) count it
  as changed, so they refuse rather than let the resolved dispatch route. Routing
  itself compares resolved bags.
- **The sticky-escape (`wouldReturnToSdkProvider`) uses presence**, never the
  baseline, so an unrecognized key always keeps a `cc-api` resource on Cloud
  Control.
- **The narrowings stay fixture-only.** Removing an unrecognized key from an SDK
  record would make it read as an addition next deploy. Its create-only status
  is unknown offline, so that could classify as a replacement, and it would also
  erase the baseline above. `findAcceptedSilentDrops` returns `[]` when an
  unrecognized key routes, which keeps it the complement of the routing
  predicate.

## Behavior change a user can see

A fresh resource carrying a misspelled key, or a new `addPropertyOverride` key
AWS does not accept, now fails at Cloud Control with `Unsupported property`
instead of deploying with the key silently dropped. This is CloudFormation's
behavior. `--prefer-sdk-route <Type>:<Prop>` restores the drop.
