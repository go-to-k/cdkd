---
title: "`cdkd diff` / `cdkd scrub` over rollback-orphan records — Design"
unlisted: true
---

# `cdkd diff` and `cdkd scrub` over rollback-orphan records

Issue [#2943](https://github.com/go-to-k/cdkd/issues/2943). Both decisions
below were the maintainer's; this file records what was decided and the
evidence, so the next change to either command does not re-litigate them from
the code alone.

## 1. `cdkd diff` renders the whole preview, then reports the refusal

`cdkd deploy` runs a pre-pass over `StackState.orphans`, splices each verified
record back into state, and THROWS when a record is refused. The obvious parity
move is for `cdkd diff` to do the same thing, and it is wrong.

Three outcomes, not two:

| record | `cdkd deploy` | `cdkd diff` renders |
| --- | --- | --- |
| adoptable | UPDATE | `[~]` with `[adopted from a rollback orphan]` |
| not adoptable, no conflict | CREATE | `[+]` — accurate, that is what deploy attempts |
| sibling-claimed (refusal (d)) | refuses; the deploy fails | listed under `Blocking`, exit 3 |

An earlier draft of this design said `cdkd diff` should "preview the adoption,
never refuse", leaving an unverifiable record shown as a plain create. That is
false for the third row: a sibling-claimed record is not *unverifiable*, it is
verified to belong to someone else, and the deploy will not create it. The
maintainer caught this — the question "does diff tolerate another stack's
property?" is what separated the rows.

So the asymmetry with `deploy` is about ORDER, not tolerance. `deploy` stops at
the refusal because there is nothing left for it to do; `diff` runs the
pre-pass to completion, renders everything it learned, and reports the refusal
last. A preview that dies before printing cannot be used to decide anything,
which is the entire purpose of the command.

### Why exit 3

`1` is `--fail`'s "a change was detected". A refusal is not a change, and
merging them means a CI job gating on drift reports the same code for "there is
work to do" and "the work cannot begin". `2` is this CLI's partial-failure
family, documented as "work completed, re-running typically resolves it"; a
refusal is the opposite, since re-running changes nothing until a person
resolves the ownership conflict. `3` was unused.

### Why the header is not gated on `nodeHasChanges`

A refusal today always arrives beside a change — refusal (d) fires only for a
record the template still declares, which the diff reports as a create. The
renderer still prints the block when `blocking` is non-empty and nothing
changed. Relying on that coincidence would make it load-bearing, and a refusal
nobody prints is the one outcome the section exists to prevent.

## 2. `cdkd scrub` derives needles per record, UNIONED with the run's

`scrub` learns which plaintexts to hunt for by re-resolving the template. An
orphan's logical id may be gone from the template — removing the failing
resource from the CDK app is the ordinary way to reach that state — so for
those records there is nothing to re-resolve.

Two candidate sources were considered, and the framing that presented them as
alternatives was wrong. They catch disjoint failures:

| the record holds | own-expression derivation | run-wide needle set |
| --- | --- | --- |
| a `{{resolve:...}}` expression, logical id absent from the template | yes | no |
| PLAINTEXT the write side failed to replace | **no** — no token to derive from | yes, when a live resource or output references the same secret |

The second row is the case `scrub` exists for. The write side redacts
`orphans[*].state` today and
`tests/integration/retain-orphan-secret` proves it against real AWS — but the
first implementation of that redaction keyed on the LIVE resource map, and an
orphan is by definition absent from it, so the needles came out empty and the
plaintext was persisted with the whole unit suite green. `scrub` is what
recovers a state file written in such a window, and an own-expression-only
derivation would not have found it.

So the needles are the union. Each half has a probe that reds only its own
case (`tests/unit/cli/commands/scrub.test.ts`).

### The residual

A record that is BOTH absent from the template AND holding plaintext matches
neither source: nothing in the run knows that plaintext. This is stated in
`docs/cli-scrub.md` rather than left implied by a clean verdict, because a
verdict that over-claims is the failure mode
[#2133](https://github.com/go-to-k/cdkd/issues/2133) was filed for.

### Why `resolveCrossStackReads` is not armed on the orphan pass

The resource loop arms it because the record exists and the deploy may have
persisted an imported plaintext into it. A persisted bag, though, is
post-resolution: an `Fn::ImportValue` node became a value before it was ever
written, and the only unresolved leaves are the dynamic references redaction
put back, which the resolve handles. If that reasoning is ever wrong the cost
is a missed needle, not a wrong rewrite, and the union is the backstop.

## 3. One sibling scan, not two

`readSiblingPhysicalIds` was a private `DeployEngine` method; it is now
`makeSiblingClaimReader` in `src/deployment/orphan-adoption.ts`. The two
commands must agree on which records they refuse, or the preview stops
predicting the deploy — which is the defect this issue is about. A second
implementation is how they would drift apart.
