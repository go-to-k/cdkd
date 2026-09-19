---
description: Why cdkd destroy and cdkd deploy REFUSE a record whose root resources map a hand edit left unreadable, and why repairing it is not the safe half there
paths:
  - 'src/cli/commands/destroy-runner.ts'
---

# The `resources` root bag at the two gated commands

Sibling containers:
[state-malformed-containers.md](state-malformed-containers.md),
[state-malformed-properties.md](state-malformed-properties.md). Index:
[code-layout.md](code-layout.md).

## THREE call sites, not two

`destroy-runner.ts`, `deploy-engine.ts`, and
`src/provisioning/providers/nested-stack-provider.ts`: that `delete()` counts the
CHILD's bag one call BEFORE handing the record to `runDestroyForStack`, so the
runner's guard could not see a `null` or absent child bag — the bare `TypeError`
fired first. Same helper, so a child's refusal reads identically.

## Three refusal entry points, one predicate

`refuseMalformedState` (`import` / `orphan` / `rollback`),
`refuseMalformedResourcesForDestroy` and `refuseMalformedResourcesForDeploy` all
delegate to `hasReadableResources`, so the VERDICT is singular and only the
MESSAGE varies. The split is not stylistic — neither gated command does what the
shared text describes: a destroy DELETES the record down an empty-stack fast path
rather than saving over it, and a deploy RE-PROVISIONS the whole stack before
that save. An operator told their record "would be replaced with a well-formed
empty one" would not know that running anyway DUPLICATES their stack.

`tests/unit/state/malformed-resources-bag.test.ts` asserts each exported
`refuseMalformed*` lands in exactly ONE class's list (a union count alone
stays green through a re-classification) and that every exported refusal carries
the non-retryable MARKER or is named in `UNMARKED` with a reason.

## Why REFUSE rather than repair

`[]`, a number and a boolean enumerate NO keys — they ARE the repaired-to-`{}`
shape — and each reaches the damaging outcome:

- **destroy**: count `0` → the empty-stack fast path → `deleteState`, no
  confirmation, success reported, every live resource orphaned.
- **deploy**: zero recorded resources → every template resource planned as a
  CREATE.

So repairing launders the record instead of avoiding the harm. A STRING
enumerates one fabricated logical id per character; `null` and an absent field
throw the bare `TypeError` the guards exist to remove.

## Two properties a later edit must not undo

- **The discriminator is the container's SHAPE, never its size.** A legitimately
  empty `{}` and an unreadable `[]` both count zero, and the fast path exists to
  serve the first — so a guard folded into the `resourceCount === 0` test
  separates nothing. Only `isReadableBag` does.
- **The destroy guards TWICE in the runner** (three times counting the nested
  site). The fast path RE-READS the record under the lock, because emptiness must
  be established under the lock rather than inherited from the caller's snapshot
  — so the object that DECIDES is not the one the entry guard cleared. A
  concurrent writer or a hand edit landing between the two reads otherwise leaves
  the re-read unreadable, its count `0`, and `deleteState` running on the very
  line the re-read exists to protect.

## Placement

Both guards sit at the state LOAD, above the first read.

- `destroy-runner.ts`: above `Object.keys(state.resources).length`, which the
  fast path sits immediately below. `regionForState` is hoisted above it so the
  refusal can name the record.
- `deploy-engine.ts`: beside `refuseMalformedOutputs`, above the debug line and
  every later read of the bag. **Not** at `DiffCalculator.calculateDiff`, though
  that is the chokepoint both diff callers share: the engine's load dominates it,
  and `cdkd diff` keeps its repair-and-warn half at its own load, so the preview
  the deploy refusal points at still works.

`refuseMalformedResourcesForDeploy` exists because
`unreadableResourcePropertyBags` returns `[]` for an unreadable ROOT bag, so
`"resources": "abcdef"` reached the deploy diff and enumerated fabricated logical
ids.

## Refusing a cleanup command is not a dead end

Proceeding tears nothing down either — the list of what to delete is exactly what
is unreadable. `[]` / a number / a boolean name no resource at all; a STRING
names one fabricated id per character whose ENTRY is a single character, so
`resourceType` and `physicalId` are both `undefined` and
`ProviderRegistry.getProviderFor` throws before any provider is selected (a
ROUTING failure, not a `provider.delete` rejection). So a forced run deletes
`state.json` and nothing else on the first three shapes, and on a string every
fabricated id fails, `errorCount > 0`, and the record is PRESERVED. The only
outcome worth offering is the record's removal, and `cdkd state orphan` is the
supported command for it — the destroy refusal NAMES it, which the sibling
refusals do not. That pointer's premise is fenced: `stateOrphanCommand` reads
`state.resources` nowhere.

**The remedy is a TEMPLATE, not a substituted command**, and the asymmetry with
the `cdkd state show` line in the same message is the decision: `state orphan`
DELETES a record, `state show` reads one. The `region` handed to the destroy
refusal is `state.region ?? ctx.baseRegion` — record-BODY content — so
substituting it once rendered a pasteable
`cdkd state orphan <stack> --stack-region eu-west-1` for a record stored under
`us-east-1`, aiming a destructive command at a different region's record. Fenced
by a POSITION case (no occurrence of the region at or after the orphan command),
with the region's presence in the message asserted first so the bound is not an
absence test.

**A template is not enough on its own.** The name a reader would type into it
comes from the clause ABOVE, and `safeIdentifier` composes `displaySafe`, which
TRIMS — so a record keyed `"prod-api "` opens as `State for 'prod-api' (...)`,
byte-identical to a HEALTHY sibling, and an operator orphaning "the record the
line above names" would delete the intact one. So the remedy sentence is GATED on
both identifiers rendering EXACTLY (compared against the raw values); when either
does not, the text names no removal target and sends the reader to
`cdkd state list --long`.

`S3StateBackend.getState` now normalizes a region-scoped record's `region` to its
KEY's region and warns on a body that disagreed (`adoptKeyRegion`), so every
`state.region` consumer gets the key's. **The template stays anyway**: a key
segment is bucket-plantable in its own right
(`cdkd/<stack>/<anything>/state.json` lists as a region) and a legacy record still
falls through to `ctx.baseRegion`.

A SECOND refusal sits immediately below the `resources` one and above the count,
and the ordering is load-bearing both ways:
`refuseDivergentRecordRegionForDestroy` reads the bag's SIZE, so it must sit
below the guard that proves the bag can be counted, and it must stay above the
empty-stack fast path. It fires only on divergent AND resource-bearing, because
adopting the key is right for the record's IDENTITY and undecidable for "where
are the resources" — and this runner reads a `*NotFound` as ALREADY DELETED, so
the wrong answer is a stack reported destroyed with every resource left live
elsewhere.
