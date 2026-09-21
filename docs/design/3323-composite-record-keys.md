---
title: "Five composite keys identified a producer by joining two halves with a NUL — Design"
unlisted: true
---

# Composite record keys: why encoding, and why five sites (issue #3323)

## The correction this carries

When [#3308](https://github.com/go-to-k/cdkd/issues/3308) shipped, both the
helper's JSDoc and the changelog stated a bound:

> The consequence of a collision is one dropped warning LINE, never a wrong
> resolution.

That is true of the two warned-once sets it was written for — both records are
read as empty, and both reads still miss. It is **false** at three of the five
sites fixed here, and the sentence has been removed rather than narrowed,
because it reads as a licence to leave a separator in place at a site nobody has
re-checked.

## The five sites and what a collision costs at each

| Site | Key | Cost of a collision |
| --- | --- | --- |
| `scrub.ts` `memoizeCrossStackStateReads` | `(stack, region)` | Record X's state served for a query about record Y |
| `scrub.ts` chain-walk `seen` seed + hop dedupe | `(stack, export)` | A hop is SKIPPED; the walk reports no secret expression over a producer that publishes one |
| `scrub.ts` verdict cache | `(stack, export)` | One coordinate's verdict served for another |
| `s3-state-backend.ts` `listStacks`, new-key arm | `(stack, region)` | A record missing from the listing |
| `s3-state-backend.ts` `listStacks`, legacy arm | `(stack, region)` | Same |

The first three all feed `cdkd scrub`'s cross-stack pre-pass, which decides
whether a producer still holds a plaintext secret. Each can end a run at
`No plaintext secrets found` over surviving plaintext — the false-clean class
[#2133](https://github.com/go-to-k/cdkd/issues/2133) exists to prevent.

## Provenance is what decides reachability, and it is PER SITE

This is the part the issue as filed got wrong, and so did the probe comment on
it. Reachability was settled from whether the SEPARATOR is storable, without
asking where each HALF comes from. Both conclusions that followed were wrong.

**`listStacks` was never exploitable.** Both halves are segments of an S3 key
split on `/`, and the probe run on this issue measured that `PutObject` refuses
a NUL-bearing key outright. So the LEFT half cannot contain a NUL, the first NUL
in the composed string is therefore always the separator, and the split is
unique. The probe comment claimed a planted ESC or CR restores the collision; it
does not — the separator is a NUL, so a control character elsewhere in a segment
changes nothing about where the split falls. The legacy arm does take its region
from a record BODY, which can carry a NUL, but that is the RIGHT half.

It is still fixed. Injectivity there rests on an external invariant about what
S3 will accept, which this code does not state, does not test, and would not
notice losing.

**`scrub.ts` is exploitable, with the exact pair the issue was filed with.** Its
stack name is not an S3 key segment. The route:

```
ExportIndexStore.loadPersisted   src/state/export-index-store.ts
  JSON.parse(body) -> entries.set(name, entry)   <- entry is a bare cast
IntrinsicFunctionResolver        src/deployment/intrinsic-function-resolver.ts
  recordImport(context, exportName, entry.producerStack, entry.producerRegion)
scrub.ts  imported.sourceStack -> backend.getState(producer.stack, ...)
```

`_index/<region>/exports.json` is a JSON document whose string values are
unvalidated, and a JSON string literal may contain an escaped NUL. The
coordinate sites are reachable the same way, and additionally through
`exportName`, which `StateImportEntry`'s JSDoc records as REDACTED on the way
into state — so it may hold any string at all.

## Why two exported names over one implementation

`producerRecordKey(stack, region)` identifies a RECORD;
`producerCoordinateKey(stack, exportOrOutputName)` identifies a COORDINATE. A
call site reading `producerRecordKey(stack, exportName)` would say something
false, so the names are separate. The encoding is spelled once, in a private
`injectivePairKey`, which is the property the "ONE spelling" rule is actually
about: two names over one implementation cannot drift, two implementations can.

## What was examined and deliberately NOT changed

`crossStackSourceKey` in `src/deployment/secret-redaction.ts` joins with a
separator over attacker-influenced strings and is the same SHAPE. It is left
alone because its contract differs: it already states that the key is **not
unique per producer**, and safety there comes from SCOPE (a `WeakMap` keyed by
the pass's own bag) plus POISONING — a key recorded against a different
(expression, plaintext) pair is poisoned rather than overwritten, so a collision
degrades to a refusal, not to a wrong value. That is a fail-closed compensating
control the five sites above did not have; each of them asserted uniqueness it
did not hold.

## What the fences do and do not cover

The per-file count replaces a `toContain('producerRecordKey(')` per file. That
shape goes green the moment ONE key in a file uses the helper, however many
separators remain beside it — the same per-FILE shape that let three raw reads
ship green on [#3331](https://github.com/go-to-k/cdkd/issues/3331), and
`s3-state-backend.ts` builds two keys in sibling branches of one loop.

The source-text NUL fence is scoped to the NUL spellings, and that is a LIMIT
rather than an oversight: `s3-state-backend.ts` legitimately joins
interpolations with `/` and `:` to build S3 keys and ARNs, so a pattern wide
enough to catch `${a}:${b}` as a record key reddens on healthy code. The helper's
own injectivity case covers that direction — it fails for every separator
spelling including `:`.

Each behavioural case is paired with a guard-the-guard case asserting that the
planted pair really does collide under a separator. Without it, an assertion
that two things stay APART is satisfied by any two distinct inputs.
