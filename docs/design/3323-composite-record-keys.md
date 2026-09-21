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
| `state.ts` `loadLocksForTree` node index | `(stack, region)` | One node's lock shown for another |
| `state-list-tree.ts` `buildStackTree` | `(stack, region)` | A node re-parented onto another's children |
| `rollback.ts` `findJournalCandidates` | `(stack, region)` | A journal-bearing stack missing from the candidates |

**The last three were found by a review round, not by the first sweep.** That
sweep grepped one of the two source spellings of a NUL and concluded the
population was five. The three above spell it the other way, in files the issue
never named. The fence now sweeps the whole tree for BOTH spellings and
requires every hit to be either a helper call or an explicitly listed
exemption, so a one-spelling sweep cannot be the last word again. The remainder
it surfaced, which is not this class, is
[#3496](https://github.com/go-to-k/cdkd/issues/3496).

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
stack name is not an S3 key segment.

**The route is NOT the exports index, and an earlier revision of this document
said it was.** That revision traced
`ExportIndexStore.loadPersisted → recordImport → scrub`, which cannot happen:
**`cdkd scrub` deliberately supplies no `exportIndex`** — stated at
`src/cli/commands/scrub.ts` where the resolver context is built, and again at
`src/deployment/intrinsic-function-resolver.ts:8770`. Scrub takes the state-scan
arm instead, whose `refStack` is a `listStacks` key segment and therefore
NUL-free. The error is the same one this document is about: a route asserted
from a module's exports rather than traced to the caller that actually runs it.

The real route is the consumer's own TEMPLATE, and it needs strictly less than
the index one did:

```
Fn::GetStackOutput   args['StackName'] -> resolveValue(...)
  src/deployment/intrinsic-function-resolver.ts  — gated only on
  `typeof stackName === 'string' && stackName !== ''`
  -> recordOutputRead(context, stackName, region, outputName)
scrub.ts  read.sourceStack -> backend.getState(producer.stack, producer.region)
```

A CDK-synthesized template is JSON, and a JSON string literal may contain an
escaped NUL. The coordinate sites are reachable the same way and additionally
through `exportName`, which `StateImportEntry`'s JSDoc records as REDACTED on
the way into state, so it may hold any string at all.

### What that route does and does not buy, per site

Stated because the three `scrub.ts` sites are NOT equally exploitable, and a
single "reachable" verdict over all three would be the same over-claim the
paragraph above corrects.

The **two coordinate sites** — the chain walk's visited set and the verdict
cache — are reachable outright. Their halves are looked up in in-memory template
and export-owner maps; no S3 key is built from them, so nothing constrains the
characters. A collision skips a hop or serves the wrong verdict, and the walk's
`no` verdict is what lets scrub proceed over an unscrubbed producer.

The **read memoizer** is reachable too — and a "this one was fail-closed"
argument stood here for one round before a review refuted it. It is written out
rather than deleted, because the way it failed is the third instance of this
document's own thesis.

The argument was: a colliding pair must have the same NUL count in the composed
key; a NUL-free pair yields exactly one; so any pair colliding with a REAL
`(stack, region)` must carry a NUL in some half; **that half goes into an S3
key**, which S3 will not serve; so both members fail their read and the shared
promise is a shared failure.

The arithmetic is sound. **The bolded premise is false.** `tryGetLegacy` builds
`getLegacyStateKey(stackName)` — `{prefix}/{stackName}/state.json` — and the
REGION never enters that key at all. It is compared against the record BODY's
`state.region`, and that gate is `if (state.region && state.region !== region)`,
so it short-circuits on a falsy region and a region-less legacy record is served
to ANY region. `s3-state-backend.ts` says so itself: *"`tryGetLegacy` hands this
record to ANY region."*

So `("Evil", "us-east-1<NUL>ap-northeast-1")` reads SUCCESSFULLY through
`cdkd/Evil/state.json`, and collides with
`("Evil<NUL>us-east-1", "ap-northeast-1")`, whose stack half comes from the
consumer's template. The memo is first-write-wins, so the successful promise is
served to the other query. A wrong answer, not a shared failure.

And the claim leaned on a THIRD unmeasured S3 behaviour besides: it needs the
new-key `GetObject` to answer `NoSuchKey` rather than throw, which the probe
never measured — it measured `PutObject`. A document whose whole subject is
that this question was asked twice and answered wrongly both times should not
have rested on asking it a third time.

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
