---
description: Why `cdkd orphan` refuses an unreadable per-resource `properties` map, and why that refusal is scoped to the records its save keeps rather than to the whole record
paths:
  - 'src/cli/commands/orphan.ts'
---

# `cdkd orphan` and the `properties` container (issue [#3318](https://github.com/go-to-k/cdkd/issues/3318))

The THIRD reader of the per-ENTRY `properties` container, split out of
[state-malformed-properties.md](state-malformed-properties.md) because that
file's two sections are both about `DiffCalculator.calculateDiff` and this
command never reaches it. The predicate, the absent-is-a-defect rule, and the
"repairing is the SAME verdict, not the lossy-but-safe one" measurement all
live there and are not repeated.

Index of every area: [code-layout.md](code-layout.md).

## What was wrong

`rewriteResourceReferences` passes each surviving record's bag through
`rewriteValue`, whose first line returns a non-object VERBATIM, and re-assigns
the result through a bare cast. `refuseMalformedState` above it answers a
question about the record ROOT only, and `unreadableResourcePropertyBags`
deliberately returns `[]` for a record whose root bag is unreadable — so the
per-entry container was unguarded on a path that SAVES.

**The harm is NOT the laundering the module's other write-capable refusals
describe**, so neither of their texts is true here and neither may be borrowed —
the per-shape measurement and what IS at stake instead (the command's own job:
an unreadable map hides whichever references to the orphan it holds) are in
`malformedOrphanResourcePropertiesRefusalMessage`'s JSDoc, which
`state-malformed-containers.md` makes the authority for WHY. Read it before
rewording that text.

## SCOPED to the survivors, which is what keeps the recovery path open

`refuseMalformedResourcePropertiesForOrphan` takes the ORPHAN SET and subtracts
it before deciding, so it never names a record this run is deleting. Two
reasons, and the second is the one a later edit must not undo:

- the save cannot persist a record it is removing, so such a bag is outside the
  harm the guard exists to stop; and
- `cdkd orphan <the damaged resource>` is the per-resource way OUT of a torn
  record — it removes the entry and leaves a record the next deploy accepts.
  A record-wide refusal would close the one command that repairs this.

That answers the constraint [#3202](https://github.com/go-to-k/cdkd/issues/3202)
records — a refusal must not break a RECOVERY path — STRUCTURALLY rather than
with a flag. Contrast `malformedDestroyResourcesRefusalMessage`, which has to
point at a different COMMAND for its way out, because a destroy keeps every
record it reads.

**The exemption is CONDITIONAL, and the message must never state it
otherwise.** `orphanLogicalIds` is built from `buildCdkPathIndex(template)` —
the SYNTHESIZED `aws:cdk:path` index — so a logical id the CDK app no longer
declares cannot enter the orphan set for ANY invocation, and the exemption
cannot reach it. The first revision of the refusal nonetheless told the
operator to "orphan the damaged record ITSELF" unconditionally, an instruction
that dies on `Construct path '...' not found in template`; the security review
of #3318 called it the misstating-the-remedy class. The text now leads with the
two TEMPLATE-FREE ways out — hand repair, and `cdkd state orphan <stack>` —
and states the condition on the third. Do not simplify that back into one
sentence.

For such a record `cdkd orphan` is genuinely unusable until it is repaired or
dropped, exactly as `cdkd deploy` is
([#3191](https://github.com/go-to-k/cdkd/issues/3191)). A state-keyed escape
(`--orphan-logical-id`) was considered in the same review and DECLINED: a new
mutating CLI surface whose only job is to route around a record the operator
must repair or drop anyway, where `cdkd state orphan` already does it.

There is deliberately **no `--force` bypass** either, and that is not a
contradiction of the flag's "use a possibly-wrong value rather than stranding
me" contract: forcing would still leave a record `cdkd deploy` refuses, so it
buys nothing the scoped exemption does not already give, at the cost of a
write.

**It scans `state.resources` ONLY, and the save keeps more.**
`rewriteResourceReferences` spreads `carriedState`, so `state.orphans[]` —
rollback-orphaned records each holding a whole `ResourceState`
([#2934](https://github.com/go-to-k/cdkd/issues/2934)) — rides through
uninspected, and a torn bag parked there is still saved. That gap is
[#3344](https://github.com/go-to-k/cdkd/issues/3344), filed rather than folded
in because an entry there has no construct path, so the third remedy above is
meaningless for it. The sibling `attributes` container on the same loop is
[#3345](https://github.com/go-to-k/cdkd/issues/3345).

## Placement, and the `--dry-run` arm

At the LOAD, beside the other two container guards and above
`rewriteResourceReferences` — the rule
`repairMalformedResourcesForReadOnly`'s note records. The orphan set is
resolved from the synthesized template before the state is loaded, so nothing
forces the call lower. It refuses under `--dry-run` too (the guard sits far
above the `if (options.dryRun)` return), for the reason the deploy half of the
container already records: a plausible rewrite audit table followed by a
refusal the moment the flag comes off is the worst arm of all.

Fenced for DOMINANCE, the orphan-set threading, and the CALLER-supplied
identity in `tests/unit/state/malformed-resources-bag.test.ts`; per-shape and
recovery-path behaviour in `tests/unit/cli/orphan.test.ts`.
