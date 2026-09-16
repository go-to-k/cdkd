---
description: the rollback executor's reverse-replacement replay-CREATE - what bag reaches create(), the effectiveProperties honouring, and the Cloud Control fallback-name fill
paths:
  - 'src/deployment/rollback-executor.ts'
---

# The reverse-replacement replay-CREATE bag

Pointed at from [layout-deployment.md](layout-deployment.md). Split out under
issue [#3199](https://github.com/go-to-k/cdkd/issues/3199) for the reason
[delete-outcome.md](delete-outcome.md) was: `layout-deployment.md`'s
`src/deployment/**` glob loads it into every session touching any file in that
directory, and the #3199 entry below took `secret-redaction.ts`'s payload over
its 102,000 B cap. The `paths:` glob here is one file, because that is the only
file the content is about.

Both arms live in `replaySingle`'s `reverse-replacement` branch: the create-first
attempt, and the delete-new-first fallback the name-collision catch routes to.

## `effectiveProperties` is honoured (issue [#1682](https://github.com/go-to-k/cdkd/issues/1682))

The bag handed to `create()` is `previousState.properties`, so a returned bag
replaces the record's `properties` wholesale and reporting none keeps the
previous bag. Pre-#1682 the arm's narrow local result type dropped a substituted
bag — do not re-narrow it. Real-AWS net:
`tests/integration/rollback-replay-effective-props/`.

## One thing is ADDED on the way out, and nothing is taken away (issue [#3199](https://github.com/go-to-k/cdkd/issues/3199))

When the ROUTING DECISION is `cc-api`, both replay-CREATE arms run the bag
through `applyDefaultNameForFallback`, so a `FALLBACK_NAME_RULES` name the
recorded bag leaves unset is filled exactly as `preparePropertiesForCcApi` fills
it at the deploy engine's three create sites (`deploy-engine.ts` create,
property-driven replacement create, UPDATE-not-supported replacement create).

Without it the replay was the FOURTH create site and the only one sending no
name, so AWS minted a random physical name and the restored resource silently
stopped matching what the forward path mints for it.

**The reachable shape is wider than "a deploy that added an explicit name."**
The arm is selected by a CHANGED PHYSICAL ID (`isReplacementOp`), so for any
table type whose physical id is NOT its name, an ordinary create-only edit
elsewhere lands here with a nameless recorded bag. From the committed schema
fixtures: `AWS::ElasticLoadBalancingV2::TargetGroup` (id `TargetGroupArn`,
create-only `Port` / `VpcId` / `Protocol` / ...), `AWS::ElasticLoadBalancingV2::LoadBalancer`
(`Scheme` / `Type`) and `AWS::WAFv2::WebACL` (`Scope`). Only for a type whose id
IS its name — the `AWS::Lambda::CapacityProvider` shape — does reaching this arm
require the name itself to change.

A type whose Cloud Control handler REJECTS a nameless create fails the replay
outright instead, which on the delete-new-first arm — where the new resource is
already deleted and `delete stateResources[op.logicalId]` has already run —
leaves the resource absent from AWS AND from state. No such type is in
`FALLBACK_NAME_RULES` today; `AWS::Lambda::CapacityProvider` is the known one and
its entry arrives with go-to-k/cdkd#3182.

Three properties are decisions, not incidental:

- **The gate reads the registry's RETURNED `provisionedBy`, not
  `previousState.provisionedBy`.** The recorded hint is absent on a pre-v7
  record, and the registry routes a type with no SDK provider to Cloud Control
  regardless — so the decision is the only reading that matches what the create
  will actually call.
- **An SDK route is untouched**, because its provider mints the name itself.
  That is the premise `FALLBACK_NAME_RULES` exists to mirror, not a gap.
- **The fill lands ONLY on the bag handed to `create()`, never on
  `resolvedPrevProps`.** That value also feeds
  `recordNestedStackParameterExpressions`, and the record is rebuilt from
  `prevRecord` independently — so the rebuilt record still holds the template's
  properties and the "a recorded bag never holds a generated name" invariant the
  Cloud Control UPDATE path rests on survives. Writing it into the record
  instead would make every later update patch carry a name change.

Both rollback entry points bind `withStackName` — `src/cli/commands/rollback.ts`
for the standalone command, and `deploy-engine.ts` around `doDeploy` for the
in-process automatic rollback — which is what makes the replayed name EQUAL the
forward create's rather than an unprefixed one. That is not incidental either:
`generateResourceName` reads the stack name from an `AsyncLocalStorage` store,
so outside such a scope the same call mints a name that never existed.
`tests/unit/deployment/rollback-executor-replay-fallback-name.test.ts` compares
the two against the real generator rather than a literal, and pins the three
non-firing cases (SDK route, no rule for the type, a recorded bag that already
names the resource).
