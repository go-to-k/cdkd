---
title: "A stale attribute map is healed on a `Fn::GetAtt` miss — Design"
unlisted: true
---

# A stale attribute map is healed on a `Fn::GetAtt` miss

Issue [#1852](https://github.com/go-to-k/cdkd/issues/1852), including its
checklist row for go-to-k/cdkd#3077.

## The defect

A state record's `attributes` map is written by the provider's `create()` /
`update()`. The deploy engine skips a resource whose resolved properties equal
the record with no provider call at all, so the map is re-written only when one
of the resource's OWN properties changes. Three kinds of record therefore stay
wrong for as long as the resource is left alone:

- a record written before its provider recorded an attribute —
  `AWS::SSM::Parameter.Arn` and `AWS::RDS::DBSubnetGroup.DBSubnetGroupArn`
  (issue #1824 fixed new deploys only);
- a record written while AWS had not assigned the value yet — an RDS / DocDB /
  Neptune `DBInstance` created under `--no-wait`, whose post-create describe ran
  while the instance was `creating` and recorded no `Endpoint.Address` /
  `Endpoint.Port` (go-to-k/cdkd#3077);
- a record holding a pre-#1681 PLACEHOLDER ARN for an `AWS::AppSync::*` child
  (issue #1727).

`Fn::GetAtt` reads the cached map and nothing else, so adding
`new CfnOutput(this, 'ParamArn', { value: param.attrArn })` — which changes no
resource property — hit the resolver's `*Arn` shape refusal on every deploy. The
refusal said "attributes are not enriched for this resource type ... file an
issue", which is false for a type that IS enriched; the #1727 refusal said
"deploy the stack again so the resource's next update heals the record", which a
deploy that updates nothing never does.

## Decision: heal lazily, on a miss, through the provider's `import()`

The heal runs only when a resolution is about to take the resolver's physical-id
fallback (`guardedPhysicalIdFallback`: a refusal for an `*Arn` / `*Url` name or
under `--strict-getatt`, a warn-and-return otherwise) or is about to refuse a
placeholder ARN. Nothing else costs an AWS call: a cached attribute, and every
per-type arm that constructs or live-reads its answer, returns exactly as before.

### The read primitive

`provider.import({ knownPhysicalId, properties: <record.properties>, ... })`,
the primitive `orphan-adoption.ts` already verifies a record with.

- It is READ-ONLY by contract ("verify the resource exists and fetch attributes,
  do NOT search").
- It returns the map `create()` records, so a healed record looks like a fresh
  one. Both types issue #1852 names already return their ARN from it.
- It is routed by `ProviderRegistry.getProviderFor({ resourceType, properties,
  provisionedBy })` from the RECORD, so a Cloud-Control-routed record is read
  through Cloud Control (whose `import()` narrows the result to the type's
  read-only attributes), with the region-pinned clients the engine already uses.

`getAttribute()` was the alternative. About half the providers implement it and
neither named type does. `readCurrentState()` returns PROPERTIES, not attributes.

The `DBInstance` row needed one provider change: `importDBInstance` in the RDS,
DocDB and Neptune providers returned `attributes: {}`. It now returns
`definedAttributes({ 'Endpoint.Address', 'Endpoint.Port', Arn })` from the
describe it already issued — the same map `create()` records. A side effect is
that `cdkd import` of a `DBInstance` records those attributes too.

### Where it hooks in

- **Resolver** (`intrinsic-function-resolver.ts`). `resolveGetAtt` calls
  `constructWithStaleRecordHeal` instead of `constructGuardedAttribute`:
  1. PROBE — construct under a derived context carrying
     `staleAttributeHeal: { phase: 'probe' }`. `guardedPhysicalIdFallback` raises
     an internal `StaleAttributeMissSignal` under that phase instead of deciding.
  2. HEAL — only on the signal: ask `context.attributeHealer`. A value for the
     attribute (flat key, then a dot-path walk for the Cloud Control nested
     shape, own keys only) is served.
  3. SETTLE — otherwise construct again under `{ phase: 'settled', outcome }`;
     the fallback decides exactly as it always has and words its refusal from
     the outcome.

  The phase rides a DERIVED context because one resolver instance serves every
  concurrently resolving resource of a stack. The signal cannot escape: only the
  wrapper builds a probe context, and it catches the signal on the same `await`.
  No `guardedPhysicalIdFallback` call site sits inside a `try` of its own.
- **Engine** (`deploy-engine.ts`). `buildResolverContext` sets `attributeHealer`
  on EVERY context — the deploy-internal diff pass, both provisioning arms and
  the outputs pass read the same stale record, and whichever asks first pays.
- **No other command supplies a healer.** `cdkd diff`, `cdkd drift`, `cdkd
  export`, `cdkd import`, `cdkd scrub` and the rollback replay keep the
  pre-#1852 resolution, issue no read, and write nothing. Their refusal now
  points at `cdkd deploy` as the command that heals.

### Eligibility

A record is re-read only while it is still the one this deploy LOADED: present
in the pre-deploy state, same physical id, and the same `attributes` OBJECT. The
gate runs on every ask, AHEAD of the memo, and again at the persist merge: the
memo key survives an in-place UPDATE, so a read the diff pass took must reach
neither a resolution made after the update nor the rewritten record.
Once a provider has (re)written a record this run, a missing attribute is the
provider's answer, not staleness — this keeps a `--no-wait` `DBInstance` created
THIS run on today's warn-and-fallback. The reference compare (rather than record
identity) admits the metadata-only arm, which re-spreads a record without a
provider call. Custom resources and nested stacks are excluded: their
attributes are handler `Data` / child outputs, not an AWS read-back.

### Single flight, bounds, failure

`DeployEngine.attributeHeals` is a per-deploy `Map<logicalId + physicalId,
Promise<outcome>>` on the ENGINE instance (one engine per stack; nothing
module-global). Holding the promise makes concurrent misses share one read;
never deleting an entry bounds it to ONE read per record per deploy, success or
failure, with no retry. The healer never throws. Outcomes:

| outcome | meaning | resolver |
| --- | --- | --- |
| `read` | the read succeeded | serve the attribute, else fall back as "not enriched" plus "cdkd re-read ... reports none" |
| `not-found` | `import()` answered `null` | fall back; refusal says the resource is gone from AWS |
| `failed` | the read threw, or the provider answered for a different physical id | fall back; refusal says the record is stale, that cdkd tried, the error CLASS and HTTP status, and the remedy |
| `not-attempted` | ineligible record / no `import()` | the pre-#1852 message, unchanged |

A failed read never fails a deploy that would have passed: the non-`*Arn`
warn-and-return arm still returns the physical id, and an Output's refusal is
still caught per output. AWS's own error text stays behind `--verbose`
(`describeFailureObserved`) because a denied read quotes the caller's account,
role and session. All refusals stay `markNonRetryable`: the outcome is memoized
for the deploy, so no retry inside it can change the verdict.

### Persistence

The read-back is kept in `DeployEngine.healedAttributes` and merged at
`redactStateForPersist` — the choke point every `saveState` of the engine passes
through — BEFORE `scrubResourceRecord`, so a healed value takes the same
redaction pass as a provider-recorded one. Consequences:

- it survives every exit path that saves (success, a failed resource, a failed
  output, the no-change path, which gained a `healedAttributesPending` trigger);
- `--dry-run` saves nothing, so it persists nothing and the next deploy re-heals;
- the merge ADDS keys the record does not hold and never rewrites a recorded
  one. The single exception is a recorded value `isStalePlaceholderArnAttribute`
  declares unusable — the same predicate the #1727 refusal uses;
- a key whose value carries `SECRET_MASK` is dropped from the read-back and never
  served. `CloudControlProvider.import` masks every leaf it cannot certify as a
  read-only attribute (all of them when `DescribeType` is denied) on the premise
  that a masked read is refused downstream; served, it would be re-applied to
  AWS as the literal mask. The engine drops it, the resolver refuses it again,
  and a served value still passes through `noteAttributeSecrecy`. The scrub at
  the choke point has no needles for an unchanged record, so these three layers
  — not the scrub — are what keep a sensitive value out;
- `undefined`, `null` and `''` are never merged or served (empty-to-absent): the
  resolver serves any stored value, so a cached empty endpoint would shadow
  every later heal;
- only `attributes` is touched, and only while the record's physical id and type
  still match what was read (a replacement or Type change this run drops it).

### The #1727 decision

`rejectPlaceholderArnAttribute` had the same no-change gap, so the heal covers
it: the placeholder is healed from the re-read when that yields a usable ARN,
and the remedy sentence is replaced by one worded from the heal outcome. `Ref`
on those types keeps its existing degrade-to-compound-id behaviour (it never
threw, and it reads through a synchronous path).

## Sibling sites swept

Every site that answers a resolution from `resource.attributes` cache-only:

| site | classification |
| --- | --- |
| `resolveGetAtt` flat / nested read → `guardedPhysicalIdFallback` (all per-type `default:` arms + final fallback) | healed |
| `resolveGetAtt` → `rejectPlaceholderArnAttribute` | healed |
| Stack Outputs / `Fn::Sub` / `Fn::Join` over a `Fn::GetAtt` | healed (same path) |
| `Ref` via `refStateLookupFromResource` (`cfnRefValueFromPhysicalId`) | left — degrades, never refuses; synchronous |
| `AWS::RDS::DBProxy` / `DBProxyEndpoint` `VpcId` refusal | healed — raises the same miss signal; both providers' `import()` report `VpcId` |
| `refuseUnservedAttribute` arms (EC2 instance, CloudFront, security group) | not applicable — already live-read |
| nested stack `Outputs.*` refusal | not applicable — child outputs, excluded by type |
| cross-stack producers (`Fn::ImportValue`, `Fn::GetStackOutput`, exports index) | not applicable — they read `state.outputs`, which the healed deploy writes |
| `cdkd diff` / `drift` / `export` / `import` / `scrub` / `local` resolver contexts | left — no healer; read-only commands, and `diff-recursive.ts` / `drift.ts` / `export.ts` are held by an open PR |

## Verification

Unit: `stale-attribute-heal.test.ts` (resolver + leaf helpers),
`deploy-engine-stale-attribute-heal.test.ts` (routing incl. `cc-api`, single
flight, merge rules, failure degradation, dry-run both polarities, a failing
deploy still persisting the heal), `dbinstance-import-endpoint-attributes.test.ts`.
Real AWS: `tests/integration/stale-attribute-heal`.
