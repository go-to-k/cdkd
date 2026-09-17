---
description: The per-container REFUSE / REPAIR guards over a state record whose resources or outputs bag a hand edit left unreadable
paths:
  - 'src/state/malformed-resources-bag.ts'
---

# Malformed state containers (`src/state/malformed-resources-bag.ts`)

Split out of [layout-state-types.md](layout-state-types.md) under issue
[#3192](https://github.com/go-to-k/cdkd/issues/3192), whose detail pushed
`src/types/state.ts` over its `rule-file-payload` budget. That file's entry
keeps a one-line pointer here.

Index of every area: [code-layout.md](code-layout.md).

## What the module owns

Every guard over a state container a hand edit or a truncation can leave
unreadable — `parseStateBody` validates the root object and the schema version
and nothing inside, so a consumer reaches the bag as an unchecked cast.

Two per-container triples, plus every message text:

| Container | Predicate | Write-capable | Read-only |
| --- | --- | --- | --- |
| `resources` (issue [#3018](https://github.com/go-to-k/cdkd/issues/3018)) | `hasReadableResources` | `refuseMalformedState` | `repairMalformedResourcesForReadOnly` |
| `outputs` (issues [#3189](https://github.com/go-to-k/cdkd/issues/3189), [#3192](https://github.com/go-to-k/cdkd/issues/3192), [#3207](https://github.com/go-to-k/cdkd/issues/3207)) | `hasReadableOutputs` | `refuseMalformedOutputs` + two siblings | `repairMalformedOutputsForReadOnly` |

**The `outputs` container has THREE refusal entry points, one predicate.**
Issue #3207 added `refuseMalformedOutputsForDestroy` and
`refuseMalformedNestedChildOutputs` beside `refuseMalformedOutputs`, and the
split is about the MESSAGE, never the verdict: all three delegate to
`hasReadableOutputs`, so no two can disagree about whether a record is damaged.
A destroy CLEARS the bag rather than rebuilding it, and a nested child's damage
is written into the PARENT's record — the shared sentence would state a
mechanism that does not happen at either site. Enumerate them with
`grep -n "^export function refuseMalformed.*Outputs" src/state/malformed-resources-bag.ts`;
`tests/unit/state/malformed-resources-bag.test.ts` derives the same list and
fails when this one goes stale.

A THIRD triple, over each ENTRY's `properties` map (#3191), lives with its
readers: [state-malformed-properties.md](state-malformed-properties.md).

Each function's own JSDoc is the authority for WHY; what follows is what a
later edit must not undo.

## `isReadableBag` is defined in `src/types/state.ts`, not here

It is only RE-EXPORTED from this module, so no importer moved. It came down
when `importableOutputKeys` needed it: `src/types/**` imports nothing and is
imported by everything, so the reverse edge would invert the layering AND pull
this module's `error-handler` / `display-safe` / `lock-contention-message`
chain into the one module the whole codebase depends on. Same move, same
reason, as `DEFAULT_STATE_PREFIX` in `src/state/state-prefix.ts`.

Do not spell the plain-object test a second time at any call site. Enumerate
the consumers with `grep -rn "isReadableBag" src/` — four successive
enumerations written by reasoning came out incomplete.

## The two containers are separate calls, deliberately

A record can be malformed in either alone, so a command that reads both makes
two calls and the message names the one that is actually broken. Collapsing
them into one condition is the obvious simplification and is wrong in both
directions: a `resources` refusal printed over an intact resource map tells
the operator their stack would be re-created on the next deploy, which does
not hold.

**The ABSENCE rule differs between them.** An absent `resources` bag is a
defect. An absent `outputs` bag is an ORDINARY record cdkd writes on purpose —
the deploy's failure-path saves emit `outputs: currentState.outputs`, which
`JSON.stringify` drops when it is undefined, and `cdkd scrub` round-trips such
a record rather than materializing `{}` over it. Refusing or warning on it
fires on healthy state.

## Refuse versus repair, and the two dispositions that are neither

A command that can WRITE the record refuses; a read-only one repairs and
warns. Two sites in the `outputs` class take neither, and the calls are
recorded in `docs/design/3192-outputs-consumers.md`:

- `importableOutputKeys` / `importableOutputs` (`src/types/state.ts`) FAIL
  CLOSED silently — a pure predicate with no stack identity to put in a
  message, and throwing there would be the bare `TypeError` #3018 removed,
  renamed.
- the `ExportIndexStore` rebuild fails closed and WARNS, naming the producer.
  Refusing would take every other producer in the region down over one damaged
  file, and an empty contribution is otherwise indistinguishable from a stack
  that exports nothing.

`cdkd scrub` holds BOTH halves for each container: its write gate is
`recordsChanged > 0 && !opts.dryRun`, so under `--dry-run` it provably cannot
persist and repairs instead — carrying the finding out to its caller so the
run still exits non-zero.

`cdkd rollback` takes NO outputs guard, and that is a decision rather than a
gap: `grep -n outputs src/cli/commands/rollback.ts` returns nothing, so there
is nothing to launder.

**Three sites decided by issue
[#3207](https://github.com/go-to-k/cdkd/issues/3207) do NOT follow the rule
mechanically**, and reading it as "does this file call `saveState`" gets each
one wrong. `docs/design/3192-outputs-consumers.md` §4 is the authority:

- `nested-stack-provider.ts` calls no `saveState` and still REFUSES — what it
  returns becomes the parent's `ResourceState.attributes`, persisted by the
  parent's deploy. Write-capable THROUGH A CALLER is the same hazard.
- `destroy-runner.ts` never rebuilds the bag either; it DECIDES from it. There
  the read-only repair is the unsafe answer, not the lossy one — reading an
  unreadable bag as empty IS the "exports nothing" verdict that skips the
  strong-reference check.
- the resolver's `Fn::GetStackOutput` arm REFUSES the reference rather than
  failing closed like its `Fn::ImportValue` sibling, because it is the one
  reader in the class that RE-APPLIES. It raises
  `MalformedProducerRecordRefusalError` (an `IntrinsicResolutionRefusalError`
  SUBCLASS) so `resolveSub` cannot launder it AND so `cdkd scrub`'s pre-pass
  can record an unverifiable finding instead of refusing the whole consumer
  stack over a record its owner may not be able to repair.

The two `cdkd local` readers REPAIR and WARN, and the premise is narrower than
"never writes": a `cdkd local` run CAN write the DERIVED exports-index key,
which is separately fail-closed by `hasReadableExportSet`. Nothing on that path
can launder a RECORD, which is what makes repair safe there.

## The fence

`tests/unit/state/malformed-resources-bag.test.ts` carries a source fence
enumerating the write-capable files PER CONTAINER, each with a DOMINANCE
anchor — the first expression in that file which reads the bag — so a guard
cannot drift below the read it protects. That is the round-1 defect of #3018
and a presence-only check stays green through it. It also pins the premise of
every exclusion, so a file that starts reading a container it did not read
before fails the fence instead of quietly joining the wrong side.

## The `exportNames` FIELD takes its own rule

Not a container, so none of the guards above touch it — `importableOutputKeys`
in `src/types/state.ts` owns it, and that function's JSDoc is the authority.
Recorded here because a lane reading this file is in the class:

- A non-array, or an array with **nothing usable in it**, reads as an EMPTY
  export set. Never as an ABSENT one: absent means "not known" and falls back
  to the pre-v9 rule where every output key is importable, so routing a corrupt
  field there republishes every plain output name as an export — the shadowing
  schema v9 exists to close (issue
  [#2193](https://github.com/go-to-k/cdkd/issues/2193)).
- `some(isString)`, not `every`: `[]` is the legitimate "exports nothing", and
  `['Real', 0]` still has a name to publish.
- `hasReadableExportSet` answers the question the empty list cannot — damaged
  versus genuinely exporting nothing — for the callers that must SAY which.
  `cdkd diff` warns with `malformedExportNamesWarning`; the exports-index
  rebuild warns with `malformedExportSourceWarning`.

Failing closed inside a pure predicate is right — it serves five commands and
holds no stack identity — but a LOUD wrong answer becoming a QUIET one is its
own regression, which is why the two callers that DO hold the identity say so.
