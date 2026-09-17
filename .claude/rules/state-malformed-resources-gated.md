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

**The glob names `destroy-runner.ts` alone, deliberately.** The deploy twin is
described below because a destroy lane needs to know it exists, but
`src/deployment/deploy-engine.ts` sits ~200 B under its own payload cap, and
funding a satellite there would mean spending another lane's headroom — which
this corpus's doctrine forbids. A deploy lane gets the same reasoning from
`refuseMalformedResourcesForDeploy`'s JSDoc and from the comment at its call
site, both of which are the authority.

Index of every area: [code-layout.md](code-layout.md).

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

**The destroy guards TWICE.** The fast path RE-READS the record under the lock,
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
  `Object.keys(currentState.resources)` debug line and the twelve reads behind
  it. **Not** at `DiffCalculator.calculateDiff`, although that is the chokepoint
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
delete is exactly what is unreadable. The only thing a forced run does is delete
the record, and `cdkd state orphan <stack> --stack-region <region>` is the
supported command for that, leaving the live resources standing. The destroy
refusal NAMES it, which the four sibling refusals do not.

That pointer is load-bearing, so its premise is fenced rather than assumed:
`stateOrphanCommand` in `src/cli/commands/state.ts` reads `state.resources`
nowhere (it lists S3 keys and deletes), and the fence asserts that over that
function's own body. `docs/cli-destroy.md` was corrected in the same pass — it
told the reader to `aws s3 rm` the key because "no cdkd command will delete it
for you", which was already false.
