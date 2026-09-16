---
title: "Design: refuse versus repair, per consumer of a non-object outputs bag"
unlisted: true
---

# Design: refuse versus repair, per consumer of a non-object `outputs` bag

Tracking issue:
[#3192](https://github.com/go-to-k/cdkd/issues/3192). Status: **Shipped**, with
a named residual in §4.

`StackState` is read out of an unchecked cast — `parseStateBody` validates the
root object and the schema version and nothing inside — so a hand-edited or
truncated record reaches every consumer with `outputs` holding a string, a
list, a number, a boolean or `null`. `Object.entries` walks a string or a list
as readily as a map, so either fabricates entries.

The membership tests are not a backstop, and it is worth being exact because a
later reader could take one for a guard already in place. `in` throws on a
string, a number and `null` — but ANSWERS on a list (`0 in [1,2]` is `true`) —
and `Object.hasOwn` throws on nothing at all (`Object.hasOwn('abcdef', '0')`
is `true`). Only the plain-object test catches every shape.

Issue [#3018](https://github.com/go-to-k/cdkd/issues/3018) settled the rule for
the `resources` bag: a command that can WRITE state refuses, a read-only one
repairs and warns. That rule does not decide this class on its own, because
three consumers here are none of those — a pure predicate, a best-effort shared
index, and a read of somebody ELSE's record. This page records the call made at
each site and why.

## 1. The rule, and the two sites it does not decide

| Disposition | When it applies | Why |
| --- | --- | --- |
| **REFUSE** | The command rebuilds or carries the bag and then saves the record | Saving replaces the only signal the record is damaged with a legitimate-looking one, permanently — and the next deploy republishes the fabricated keys into the shared exports index |
| **REPAIR + WARN** | The command provably cannot write | Reading the bag as empty keeps the command usable; the warning is what stops "no rows" reading as "the record holds none" |
| **FAIL CLOSED, silently** | A pure predicate with no stack identity and no writer | It cannot name a record in a message, and throwing would be the bare `TypeError` renamed |
| **FAIL CLOSED, warning** | A best-effort shared artifact rebuilt from many records | Refusing over one record would take every other record's consumers down with it |
| **NO VERDICT, warning** | A read of ANOTHER stack's record, made to classify it | Refusing would strand the scrubbed stack's own plaintext over a record the user may not own; staying silent would trade a loud wrong answer for a quiet one (§6) |

## 2. Per-site decisions

| Site | Command | Disposition |
| --- | --- | --- |
| `rewriteResourceReferences`, guarded at the `cdkd orphan` load | `cdkd orphan` | REFUSE |
| The outputs redaction passes, guarded at the `cdkd scrub` load | `cdkd scrub` | REFUSE on a real run; REPAIR + report under `--dry-run` |
| The carried bag in the saved state literal, guarded at the `cdkd import` load | `cdkd import` | REFUSE |
| `importableOutputKeys` / `importableOutputs` | shared predicate | FAIL CLOSED, silently |
| The exports-index rebuild | any command that touches the index | FAIL CLOSED, warning |
| `storedProducerValue`, the cross-stack pre-pass's read of a FOREIGN producer | `cdkd scrub` | NO VERDICT + warning (§6) |
| `loadStateOrEmpty` | `cdkd diff` | REPAIR + WARN (shipped with #3189) |
| The render entry | `cdkd state show` / `state resources` | REPAIR + WARN (shipped with [#3187](https://github.com/go-to-k/cdkd/issues/3187)) |

Two notes on the table.

**`cdkd scrub`'s split is decidable rather than a judgement.** Its write gate
is `recordsChanged > 0 && !opts.dryRun`, so under `--dry-run` it provably
cannot persist, and refusing there would remove the one audit a user reaches
for precisely because the record is broken. The finding is carried out to the
caller so the run still exits non-zero — otherwise every outputs-side counter
is legitimately zero and `--dry-run --fail`, the documented CI gate, reports a
clean run over a bag it replaced with `{}`.

**`cdkd rollback` takes no guard, and that is a decision.**
`grep -n outputs src/cli/commands/rollback.ts` returns nothing: it spreads
`...baseState`, carrying the field by value, so there is nothing to launder. A
guard there would be unfalsifiable, and an unfalsifiable guard fences nothing.
A source fence pins the premise, so the file joins the refusing set
automatically if it ever starts reading the bag.

## 3. `exportNames` is a list, so it takes its own rule

The tenth site of the class is the `exportNames` FIELD rather than a bag.
`importableOutputKeys` filtered it unconditionally and threw a bare
`TypeError` on a hand-edited non-array.

A corrupt set is read as an EMPTY set, never as an UNKNOWN one. Absent means
"not known" and falls back to the pre-v9 rule where every output key is
importable, so routing a corrupt field there would publish every plain output
name as an export — exactly the shadowing schema v9 exists to close. A
non-string element is dropped for the same reason: key lookup coerces rather
than throwing, so `exportNames: [0]` against a bag holding a `"0"` key would
otherwise publish it.

The guard sits in `importableOutputKeys` rather than at each load, and that is
consistent with the placement rule rather than an exception to it. That rule
exists because every flow dereferences the `outputs` CONTAINER a line before
the walk, so a per-walk guard is inert. `exportNames` has the opposite shape:
`importableOutputKeys` is the only reader that dereferences it at all —
`exportNamesCarriedFrom` beside it tests `=== undefined` and copies — so
guarding there dominates every consumer.

## 4. Residual: the consumers in a real-AWS gate scope

These sites read the bag without going through the predicate above, and each
lives in a file whose edit pulls a real-AWS integration gate into the change:

| Site | Gate its file is in |
| --- | --- |
| The nested-stack provider's child-outputs read | `integ-destroy` |
| The intrinsic resolver's `Fn::GetStackOutput` arm | `integ-broad` |
| The local-command loader's `Fn::GetStackOutput` `in` test | `integ-local` |
| The local state provider's coercion walk | `integ-local` |
| The deploy engine's persisted-outputs carry | `integ-destroy` and `integ-broad` |
| `cdkd state destroy`'s strong-reference check | `integ-destroy` and `integ-broad` |

Their `Fn::ImportValue` halves are already covered for free, because those go
through `importableOutputKeys`. Every row is tracked by
[#3207](https://github.com/go-to-k/cdkd/issues/3207), which names each site and
the gate it drags, so they can be taken when a session is free to spend the
runs. That issue is the count-bearing list; this table is a summary of it.

The resolver's `Fn::GetStackOutput` row was NOT in go-to-k/cdkd#3192's own site
list, and the reason is worth keeping: that list came from a grep filtered to
lines carrying `Object.(entries|keys|values)`, and this site reads the bag
into a local variable one line earlier. `Object.hasOwn('abcdef', '0')` is true,
so it resolves a fabricated cross-stack value into a consumer's template — and
it is also the route by which a damaged producer record reaches `cdkd scrub`'s
own classifier (§6).

## 5. A non-string export set is damaged, not "exports nothing"

`exportNames: [0]` over a bag holding a `"0"` key is readable by every
structural test — it is an array — while `importableOutputKeys` drops the `0`
as a non-string and answers `[]`. Read as "exports nothing", the exports-index
rebuild drops that producer with no warning: the same silent
contribute-nothing shape §1's fourth disposition exists to close, one level
down.

This was nearly written off on the argument that closing it means making
"readable" mean "yields at least one KEY", which would fire on the legitimate
`exportNames: []`. That argument is wrong, because a narrower predicate
exists: **a non-empty set is damaged when NOTHING in it is usable.**

```
hasReadableExportSet: exportNames.length === 0 || exportNames.some(isString)
```

`some`, not `every`, is what keeps two legitimate shapes quiet — `[]`, the v9
way of saying a stack exports nothing, and `['Real', 0]`, which still has a
name to publish. A string name merely ABSENT from the bag stays readable too;
that is the ordinary "an alias whose value did not resolve publishes nothing".

One residual is accepted and bounded: a PARTIALLY non-string set publishes its
usable names and says nothing about the dropped ones. Warning there would mean
reporting a record damaged while still publishing from it, which is a worse
signal than silence.

## 6. A seventh site, found by review rather than by the grep

`cdkd scrub`'s cross-stack pre-pass re-reads a PRODUCER's record to classify
its stored value (`storedProducerValue`). That bag belongs to another stack, so
the load guard of §2 never covers it, and the classifier asked
`producer.key in outputs` — a bare `TypeError` on a string, escaping the
`try` that only wraps the fetch.

It takes a THIRD disposition, different from every row in §1: **no verdict,
plus a warning.** Refusing would strand the scrubbed stack's own plaintext over
a record the user may not even own; staying silent would trade a loud wrong
answer for a quiet one. So the classifier returns "cannot classify" and the
damaged producer is named, while an ABSENT bag — or one that simply lacks the
key, an ordinary stale-index shape — stays unmentioned.

Its reachability is the part worth recording. It is unreachable by
`Fn::ImportValue`, because `importableOutputKeys` fails closed so the read
never succeeds. It IS reachable by `Fn::GetStackOutput`, which consults no such
predicate: a producer whose bag is the string `'abcdef'` and whose template
declares an output named `'0'` resolves, records the read, and enters the
classifier. An earlier revision of the test file asserted the opposite and
shipped no case; three reviewers converged on the error, and one measured the
raw `TypeError` escaping. The case now exists and reds without the guard.
