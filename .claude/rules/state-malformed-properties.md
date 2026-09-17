---
description: The REFUSE / REPAIR split over a resource record whose own properties map a hand edit left unreadable, and why repairing it is not the safe half here
paths:
  - 'src/analyzer/diff-calculator.ts'
  - 'src/cli/commands/diff-recursive.ts'
---

# The `properties` container (issue [#3191](https://github.com/go-to-k/cdkd/issues/3191))

The third per-container triple in `src/state/malformed-resources-bag.ts`, split
out of [state-malformed-containers.md](state-malformed-containers.md) because
its readers are the two files above rather than the module that defines it —
and that file's `paths:` glob had ~300 B of headroom left under its payload cap.

| Predicate | Write-capable | Read-only |
| --- | --- | --- |
| `unreadableResourcePropertyBags` | `refuseMalformedResourceProperties` | `repairMalformedResourcePropertiesForReadOnly` |

## It is one level DOWN, and its predicate returns IDS

Per ENTRY, not on the record root, so the message can name which resource
records are damaged. It SKIPS an entry that is not a readable object and
returns `[]` for an unreadable `resources` bag, which makes its verdict
order-independent with respect to the other two guards — a caller owes all
three, and taking only this one leaves the root unchecked.

An ABSENT `properties` map is a defect, unlike an absent `outputs` bag, and the
asymmetry is measurable rather than stylistic: every writer in `src/` assigns an
object there (`cdkd import` spells it `Properties ?? {}`) and `JSON.stringify`
never drops a `{}`, so nothing cdkd writes can produce one. An empty `{}` is
healthy — a resource can legitimately declare no properties.

## Repairing is NOT the lossy-but-safe half here — do not "simplify" it into one

For `resources` and `outputs`, repairing to empty is merely LOSSY: an empty map
is a different, safer verdict than a fabricated one. For `properties` it is the
SAME verdict.

Measured through the real `DiffCalculator` on #3191, against an
`AWS::S3::Bucket` declaring `BucketName`: a stored `"abcdef"`, a stored `[]` and
a stored `5` each produced a property change carrying
`requiresReplacement: true`. `[]` and `5` enumerate no keys — they ARE the
repaired-to-`{}` case — so a repair reproduces the data loss rather than
avoiding it. `DeployEngine`'s `case 'UPDATE'` arm turns that flag into
`propertyDrivenReplacement`, i.e. a DELETE + CREATE of the live bucket.

Only the refusal closes it. The cost is stated rather than argued away: a
deploy over ONE torn record aborts the whole run, and that is the right trade
against replacing a resource nobody asked to replace.

**`cdkd deploy --dry-run` refuses too, and that is decided rather than
incidental.** Provisioning is gated BELOW `calculateDiff`, so a dry run reaches
the guard. The "a preview beats an abort" argument does not transfer to it,
because `cdkd diff` already satisfies that argument one command over: a user
who wants the repaired preview has it, with the warning. Repairing here would
need a mode threaded into the shared chokepoint whose whole value is that both
callers reach it unconditionally, and it would create the worst arm of all — a
plausible `--dry-run` plan followed by a refusal the moment the flag comes off.
The refusal's TEXT has to be true on both arms; the first revision asserted "it
would DELETE and re-create resources", which a dry run would not.

`cdkd diff` still repairs and warns, and the WRITE is what makes the difference
rather than the shape — it provisions nothing, so it cannot launder the
evidence, and a preview of the rest of the stack beats an abort. Its warning
has to say BOTH halves: the preview is wrong in the addition/replacement
direction, and `cdkd deploy` refuses the same record. A silent repair would be
its own defect, since an empty map is indistinguishable from a resource that
genuinely declares nothing.

## Where the guard sits

At `DiffCalculator.calculateDiff`'s ENTRY — the point `currentState` enters the
analyzer — dominating all five `currentResource.properties` reads and the
comparison they feed, and not on the five reads themselves, which is the inert
shape #3018's first cut shipped.

It is the single CHOKEPOINT both callers share (`grep -rn '\.calculateDiff('
src/` returns exactly two), which is the whole argument. An earlier revision of
this section rejected a guard at the engine's own state load as "below the same
reads"; that was simply false — the engine loads at `deploy-engine.ts:2801`,
above `calculateDiff` and above all five reads. What is true is that a
caller-side guard has to be repeated per caller and is silently skipped by the
next one.

NO IDENTITY is passed with the refusal, and that is a decision: the only stack
name and region in reach are fields of the record being declared malformed, and
`parseStateBody` validates neither, so a planted one would aim the pasteable
remedy at a different, healthy stack. `stackClause`'s doc is the authority.

`loadStateOrEmpty` in `src/cli/commands/diff-recursive.ts` carries the read-only
half, AFTER the `resources` bag repair: an unreadable bag has no entries to
walk. `computeStackDiff` runs it a SECOND time after splicing adopted rollback
orphans in — those records come from `state.orphans[].state`, a container the
load never walks, and an unrepaired one aborted `cdkd diff` with the deploy's
refusal.

Both are fenced for DOMINANCE, not presence, in
`tests/unit/state/malformed-resources-bag.test.ts`, alongside an assertion that
the write-side file holds no read-only repair helper.
