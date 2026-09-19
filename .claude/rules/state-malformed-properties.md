---
description: REFUSE vs REPAIR over an unreadable resource properties map
paths:
  - 'src/analyzer/diff-calculator.ts'
  - 'src/cli/commands/diff-recursive.ts'
---

# The `properties` container

Issue [#3191](https://github.com/go-to-k/cdkd/issues/3191), in
`src/state/malformed-resources-bag.ts` beside
[state-malformed-containers.md](state-malformed-containers.md).

`unreadableResourcePropertyBags` is the ONE predicate.
`refuseMalformedResourceProperties` (`deploy`) and
`refuseMalformedResourcePropertiesForOrphan` (`orphan`) are the write-capable
callers, differing in MESSAGE and SCOPE but never the verdict; read-only is
`repairMalformedResourcePropertiesForReadOnly`. It works per ENTRY, so messages
can NAME damaged records; it SKIPS a non-object entry and returns
`[]` for an unreadable `resources` bag, so its verdict is order-independent of
the other two guards — **a caller owes all three**. An ABSENT map is a DEFECT;
an empty `{}` is healthy.

## Repairing is not the safe half

For `resources` and `outputs`, repairing to empty is merely LOSSY. For
`properties` it is the SAME verdict: a stored string, `[]` or number each
produce a change carrying `requiresReplacement: true`, and `[]` / a number
enumerate no keys — they ARE the repaired-to-`{}` case, which `case 'UPDATE'`
turns into `propertyDrivenReplacement`: a DELETE + CREATE of a live resource.

**`--dry-run` refuses too**, since provisioning is gated BELOW `calculateDiff`;
the refusal TEXT must be true on both arms and cannot claim a deploy would
delete and re-create. `cdkd diff` repairs and warns instead, since it provisions
nothing; its warning must say BOTH halves — the preview is wrong in the
addition/replacement direction, and `cdkd deploy` refuses the record.

The refusal is at `DiffCalculator.calculateDiff`'s ENTRY — the single CHOKEPOINT
both callers share — DOMINATING every `currentResource.properties` read rather
than sitting on the reads. It names NO stack identity: the record's own
`stackName` / `region` are unvalidated and could aim the remedy elsewhere.

`loadStateOrEmpty` (`diff-recursive.ts`) carries the read-only half AFTER the
`resources` bag repair, and `computeStackDiff` runs it a SECOND time after
splicing adopted rollback orphans in, since those come from
`state.orphans[].state`, which it never walks.

`cdkd orphan` runs no diff, and keeps its orphan-set parameter so recovery stays
open
([state-malformed-properties-orphan.md](state-malformed-properties-orphan.md)).
