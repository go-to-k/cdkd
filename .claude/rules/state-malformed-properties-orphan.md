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

## The harm is NOT laundering, and the refusal's text must not claim it is

Measured 2026-09-17 through the real rewriter, over an `AWS::S3::Bucket`
record: a stored `"abcdef"` came back `"abcdef"`, a `5` as `5`, a `null` as
`null`, an `[]` as `[]`, and an ABSENT bag stayed absent once `JSON.stringify`
dropped it. Nothing is fabricated and no evidence is replaced — so
`malformedOutputsRefusalMessage`'s "saved back as a well-formed six-key map",
true one container over, is FALSE here. So is
`malformedResourcePropertiesRefusalMessage`'s "a DELETE and re-create of
resources the template did not change", which is a DIFF verdict this command
never computes. Borrowing either is the defect class the module's per-text
split exists to avoid.

What is at stake is the command's own job. `cdkd orphan` exists to leave the
record deployable by rewriting every surviving sibling's `Ref` / `Fn::GetAtt` /
`Fn::Sub` reference to an orphan, and an unreadable map hides whichever it
holds: a scalar bag presents no reference to find, so the `--force`-less hard
fail on unresolvable references can never fire for one. A LIST bag is the one
unreadable shape `rewriteValue` DOES walk — a stored `[{"Ref":"<orphan>"}]`
came back `["<physicalId>"]` with a row in the audit table — so its rewrites
are reported into a container that is still not a map. Either way the command
took a lock, saved, and reported success over a record `cdkd deploy` then
REFUSES and a `cdkd diff` in between previews as a replacement.

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

There is deliberately **no `--force` bypass**, and that is not a contradiction
of the flag's "use a possibly-wrong value rather than stranding me" contract:
forcing would still leave a record `cdkd deploy` refuses, so it buys nothing
the scoped exemption does not already give, at the cost of a lock and a write.

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
