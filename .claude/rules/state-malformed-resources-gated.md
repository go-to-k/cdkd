---
description: Why cdkd destroy and cdkd deploy REFUSE a record whose root resources map a hand edit left unreadable, and why repairing it is not the safe half there
paths:
  - 'src/cli/commands/destroy-runner.ts'
---

# The `resources` root bag at the two gated commands (issue [#3161](https://github.com/go-to-k/cdkd/issues/3161))

Split out of
[state-malformed-containers.md](state-malformed-containers.md) for the reason
[state-malformed-properties.md](state-malformed-properties.md) was: its reader
is the file above rather than the module that defines the guards, and that
file's `paths:` glob had no headroom left under its payload cap. That file keeps
a one-line pointer here.

**The glob names `destroy-runner.ts` alone, deliberately.** The other two sites
are described below because a destroy lane needs to know they exist, but
`deploy-engine.ts` sits ~200 B under its own payload cap and the provider's
rules are near theirs — funding a satellite at either would spend another
lane's headroom, which this corpus's doctrine forbids. Those lanes get the same
reasoning from each guard's JSDoc and the comment at its call site.

Index of every area: [code-layout.md](code-layout.md).

## THREE call sites, not two

Besides `destroy-runner.ts` and `deploy-engine.ts`, a third sits in
`src/provisioning/providers/nested-stack-provider.ts`: `delete()` counts the
CHILD's bag one call BEFORE handing the record to `runDestroyForStack`, so the
runner's guard could not see a `null` or absent child bag — the bare
`TypeError` fired first. Same helper, so a child's refusal reads identically.

## Three refusal entry points, one predicate

`refuseMalformedState` (`import` / `orphan` / `rollback`),
`refuseMalformedResourcesForDestroy` and `refuseMalformedResourcesForDeploy`
all delegate to `hasReadableResources`, so the VERDICT is singular; only the
MESSAGE varies. The split is not stylistic — neither gated command does what
the shared text describes. A destroy DELETES the record down an empty-stack
fast path rather than saving over it, and a deploy RE-PROVISIONS the whole
stack before the save that text names. An operator told their record "would be
replaced with a well-formed empty one" would not know that running anyway
duplicates their stack.

`tests/unit/state/malformed-resources-bag.test.ts` enumerates every
`export function refuseMalformed*` in the module and asserts each lands in
exactly ONE container's list. A union COUNT alone stays green through a
re-classification, so the partitions are asserted separately and the leftover
set is asserted empty.

A SECOND partition there covers the non-retryable MARKER: every exported
refusal is marked, or named in `UNMARKED` with a reason. `refuseMalformedState`
is the sole entry (its callers raise it outside any `withRetry`); the fence
exists because `refuseMalformedOutputs` shipped unmarked beside three marked
siblings and nothing said so.

All three call sites carry a DOMINANCE case. The nested one is its own rather
than a `REFUSE` row, because that loop's premise assertion is `saveState(` and
this file writes none — write-capable THROUGH its caller, the relationship the
`outputs` half already fences for it.

## The measurement that settles refuse-versus-repair

`[]`, a number and a boolean enumerate NO keys — they ARE the repaired-to-`{}`
shape — and each reaches the damaging outcome on both commands. Driven in-suite
rather than argued:

- **destroy**: count `0` → the empty-stack fast path → `deleteState`, no
  confirmation, success reported, every live resource orphaned. The
  `{}` control case in `destroy-runner-malformed-resources.test.ts` IS that
  measurement — it takes the same path.
- **deploy**: zero recorded resources → every template resource planned as a
  `CREATE`. `deploy-engine-malformed-resources-refusal.test.ts`'s readable-empty
  case measures `provisioned === ['create']`.

So repairing launders the record instead of avoiding the harm, the same finding
`.claude/rules/state-malformed-properties.md` records one container down. A
string enumerates one fabricated logical id per character; `null` and an absent
field throw the bare `TypeError` #3018 exists to remove.

## Two properties a later edit must not undo

**The discriminator is the container's SHAPE, never its size.** A legitimately
empty `{}` and an unreadable `[]` both count zero, and the fast path exists to
serve the first — so a guard folded into the `resourceCount === 0` test
separates nothing. Only `isReadableBag` does.

**The destroy guards TWICE in the runner** (three times counting the nested
site above). The fast path RE-READS the record under the lock,
because emptiness has to be established under the lock rather than inherited
from the caller's snapshot — so the object that DECIDES is not the one the entry
guard cleared. A concurrent writer or a hand edit landing between the two reads
leaves the re-read unreadable, its count `0`, `stillEmpty` true, and
`deleteState` running on the very line the re-read exists to protect.

## Placement

Both guards sit at the state LOAD, above the first read.

- `destroy-runner.ts`: above `Object.keys(state.resources).length`, which the
  fast path sits immediately below. `regionForState` was hoisted above it so the
  refusal can name the record.
- `deploy-engine.ts`: beside `refuseMalformedOutputs`, above the
  `Object.keys(currentState.resources)` debug line and every read of the bag
  behind it (measured 2026-09-17 over comment-stripped source: FIVE between the
  guard and `calculateDiff`, TEN over the rest of `doDeploy`. Seventeen is the
  count to end of FILE and spans other methods — re-derive rather than trusting
  any of the three). **Not** at `DiffCalculator.calculateDiff`, although that is the chokepoint
  both diff callers share: the engine's load dominates it, and `cdkd diff` keeps
  its repair-and-warn half at its own load, so the preview the deploy refusal
  points at still works.

`refuseMalformedResourcesForDeploy` closes the gap
[#3317](https://github.com/go-to-k/cdkd/pull/3317)'s review named and left:
`unreadableResourcePropertyBags` returns `[]` for an unreadable ROOT bag, so
`"resources": "abcdef"` reached the deploy diff and enumerated two fabricated
logical ids.

## Refusing a cleanup command is not a dead end

The objection #3161 raises against refusing `cdkd destroy` at all — that it
leaves the user no supported way to tear the stack down — does not survive the
measurement: proceeding tears nothing down either, since the list of what to
delete is exactly what is unreadable — and that is per-shape rather than a
slogan. `[]` / a number / a boolean name no resource at all; a STRING names one
fabricated logical id per character whose ENTRY is a single character, so
`resourceType` and `physicalId` are both `undefined` and
`ProviderRegistry.getProviderFor` throws before any provider is selected — no
AWS delete is issued and no live resource can be addressed. Measured
2026-09-17 against the real registry: a bare `Cannot read properties of
undefined (reading 'startsWith')` out of the `isCustomResource` test, which is
a ROUTING failure and not the `provider.delete` rejection an earlier revision
of this file asserted. So a forced run deletes `state.json` and nothing else on
the first three shapes, and on a string every fabricated id fails,
`errorCount > 0`, and the record is PRESERVED. The only outcome
worth offering is the record's removal, and `cdkd state orphan` is the
supported command for it, leaving the live resources standing. The destroy
refusal NAMES it, which the sibling refusals do not.

That pointer is load-bearing, so its premise is fenced rather than assumed:
`stateOrphanCommand` in `src/cli/commands/state.ts` reads `state.resources`
nowhere (it lists S3 keys and deletes), and the fence asserts that over that
function's own body. `docs/cli-destroy.md` was corrected in the same pass — it
told the reader to `aws s3 rm` the key because "no cdkd command will delete it
for you", which was already false.

**The remedy is a TEMPLATE, not a substituted command, and the asymmetry with
the `cdkd state show` line in the same message is the decision.** `state
orphan` DELETES a record; `state show` reads one. The `region` the destroy
refusal is handed is `state.region ?? ctx.baseRegion`, and `state.region` is
record-BODY content `getState` does not check against the key it loaded from —
measured 2026-09-17 against the shipped binary, a record planted at
`.../us-east-1/state.json` carrying `"region": "eu-west-1"` rendered a
pasteable `cdkd state orphan <stack> --stack-region eu-west-1`, aiming a
destructive command at a different region's record for the same stack. That is
`stackClause`'s misdirection class one field over. Substituting into the
read-only `state show` remedy is `malformedStateDetail`'s pre-existing
behaviour and is left alone; what a later edit must not do is make the
destructive one pasteable again. Fenced by a POSITION case (no occurrence of
the region at or after the orphan command), with the region's presence in the
message asserted first so the bound is not an absence test.

**A template is not enough on its own**, and this is the half a later edit is
most likely to drop. The name a reader would type into it comes from the clause
ABOVE, and `safeIdentifier` composes `displaySafe`, which TRIMS — so a record
keyed `"prod-api "` opens the message as `State for 'prod-api' (...)`,
byte-identical to a HEALTHY sibling. An operator orphaning "the record the line
above names" would delete the intact one. So the remedy sentence is GATED on
both identifiers rendering EXACTLY (compared against the raw values); when
either does not, the text names no removal target at all and sends the reader
to `cdkd state list --long`. Same call `buildForceUnlockCommand` makes when a
value would render misleadingly.

The divergence itself — the runner also LOCKS, SAVES and DELETES against the
body region, and reports `✓ State deleted` when nothing is there — is
go-to-k/cdkd#3328, not this rule.
