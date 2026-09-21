---
description: The per-container REFUSE / REPAIR guards over a state record whose resources or outputs bag a hand edit left unreadable
paths:
  - 'src/state/malformed-resources-bag.ts'
---

# Malformed state containers (`src/state/malformed-resources-bag.ts`)

Index of every area: [code-layout.md](code-layout.md). Each function's own JSDoc
is the authority for WHY; what follows is what a later edit must not undo.

## What the module owns

Every guard over a state container a hand edit or a truncation can leave
unreadable — `parseStateBody` validates the root object and the schema version
and nothing inside, so a consumer reaches the bag as an unchecked cast.

| Container | Predicate | Write-capable | Read-only |
| --- | --- | --- | --- |
| `resources` | `hasReadableResources` | `refuseMalformedState` +2 | `repairMalformedResourcesForReadOnly` |
| `outputs` | `hasReadableOutputs` | `refuseMalformedOutputs` + two siblings | `repairMalformedOutputsForReadOnly` |
| `orphans` | `hasReadableOrphans` | `refuseMalformedOrphans` + a destroy sibling | `repairMalformedOrphansForReadOnly` |

**Each container has MORE THAN ONE refusal entry point and ONE predicate.** The split
is about the MESSAGE, never the verdict — all of them delegate to the predicate,
so no two can disagree about whether a record is damaged. A destroy CLEARS the
outputs bag rather than rebuilding it, and a nested child's damage is written
into the PARENT's record, so a shared sentence would state a mechanism that does
not happen at either site. Enumerate them with
`grep -n "^export function refuseMalformed" src/state/malformed-resources-bag.ts`;
`tests/unit/state/malformed-resources-bag.test.ts` derives the same list.

Three sets live with their READERS: the `resources` gate-scoped pair in
[state-malformed-resources-gated.md](state-malformed-resources-gated.md), the
entry-level `properties` set in
[state-malformed-properties.md](state-malformed-properties.md), and the ENTRY
class below.

## The ENTRY class is not a container (go-to-k/cdkd#3018)

`isReadableResourceEntry` / `unreadableResourceEntries` /
`refuseMalformedResourceEntries` / `repairMalformedResourceEntriesForReadOnly`
answer for a ROW of a readable `resources` map — an entry that is not an object,
or carries no `resourceType`. So the enumeration above returns one more function the
per-container table cannot classify, and the partition that owns it is by CLASS
(the spelling `state-malformed-resources-gated.md` uses), not by container.

Its verdict is independent of the BAG guard, which a caller still owes; a
read-only caller taking both drops entries AFTER the bag repair, so an
unreadable bag has no rows to walk. `cdkd diff` also runs the entry predicate
over `orphans[]` before previewing an adoption, with its OWN warning text
(`malformedOrphanRecordsWarning`) because the shared one names `resources`; the
dropped records join the node's `unreadable`, so `--fail` counts them. The
CONTAINER those rows sit in is the table's third row, guarded one level above
them (go-to-k/cdkd#3379): the entry pass runs only once the container is known
to be a list.

## One refusal here is NOT about a container

`refuseDivergentRecordRegionForDestroy` refuses a DESTROY over a record whose
body `region` disagreed with the key it was read from while it still lists
resources — same family, but the subject is a FIELD, so it is outside the table
and outside `hasReadable*`. It lives in this module because every message here
composes `safeIdentifier`, whose privacy is a recorded decision; a separate
module would have to spell the sanitize + cap + `UNRENDERABLE` triple again.

- **The trigger is the CONJUNCTION and a later edit must not widen it**:
  divergent AND resource-bearing. A resource-LESS record is deliberately not
  refused — it is the `cdkd state destroy` recovery path, and refusing it would
  strand exactly the record the recovery commands exist to remove.
- It fails CLOSED on a bag it cannot COUNT: a known divergence plus an unknowable
  count must not resolve to "proceed".
- It carries the EXACT-rendering gate, because it ends on a DELETING command and
  `safeIdentifier` TRIMS: a record keyed `'prod-api '` otherwise opens
  byte-identically to a healthy sibling. **Any message here that names a target
  AND offers a destructive remedy needs both halves: the template, and the gate
  on the clause above it.**

## Two exports here are not guards at all

`producerRecordKey` (a `stack`+`region` RECORD) and `producerCoordinateKey` (a
`stack`+`export-name` COORDINATE) are the ONE encoding anything identifying a
producer-side thing by a string pair goes through — a warned-once `Set`, a
dedupe `Set`, a memoization `Map`. Separate NAMES because the subjects differ
and a call site reading `producerRecordKey(stack, exportName)` would say
something false; ONE private implementation, which is the property the
"one spelling" rule is about.

They live in this module because their callers already import it for the
guards. **What a collision COSTS is per site, not a property of the key**, and
the JSDoc says so after a note claiming otherwise shipped with
go-to-k/cdkd#3308: at the two warned-once sets it drops a warning line, at
`cdkd scrub`'s read memoizer, chain walk and verdict cache it is a wrong ANSWER
that can end a run at `No plaintext secrets found` over surviving plaintext.
So is whether a SEPARATOR was ever injective — it depends on where each half
comes from, and an S3 key segment cannot carry a NUL while an exports-index
string can (go-to-k/cdkd#3323, `docs/design/3323-composite-record-keys.md`).
Derive the call sites with `grep -rn "producerRecordKey(\|producerCoordinateKey(" src/`.

## `isReadableBag` is defined in `src/types/state.ts`, not here

It is only RE-EXPORTED, so no importer moved. It came down when
`importableOutputKeys` needed it: `src/types/**` imports nothing and is imported
by everything, so the reverse edge would invert the layering and pull this
module's `error-handler` / `display-safe` / `lock-contention-message` chain into
the one module the whole codebase depends on. Do not spell the plain-object test
a second time at a call site; enumerate consumers with
`grep -rn "isReadableBag" src/`.

## The two containers are separate calls, deliberately

A record can be malformed in either alone, so a command that reads both makes two
calls and the message names the one that is broken. Collapsing them is wrong in
both directions — a `resources` refusal printed over an intact resource map tells
the operator their stack would be re-created on the next deploy, which does not
hold.

**The ABSENCE rule differs between them.** An absent `resources` bag is a defect.
An absent `outputs` bag is an ORDINARY record cdkd writes on purpose: the
deploy's failure-path saves emit `outputs: currentState.outputs`, which
`JSON.stringify` drops when undefined, and `cdkd scrub` round-trips such a record
rather than materializing `{}` over it. Refusing or warning on it fires on
healthy state. An absent `orphans` container is ordinary for a stronger reason:
a stack that never had a failed deploy has no orphan list at all, so it is the
common case rather than a tolerated one — and the read-only repair leaves an
absent container ABSENT rather than materializing `[]`, which a later write
would then persist.

## Refuse versus repair, and the dispositions that are neither

A command that can WRITE the record refuses; a read-only one repairs and warns.
Two `outputs` sites take neither (calls recorded in
`docs/design/3192-outputs-consumers.md`):

- `importableOutputKeys` / `importableOutputs` FAIL CLOSED silently — a pure
  predicate with no stack identity to put in a message, and throwing there would
  be the bare `TypeError` these guards removed, renamed.
- the `ExportIndexStore` rebuild fails closed and WARNS, naming the producer:
  refusing would take every other producer in the region down over one damaged
  file, and an empty contribution is otherwise indistinguishable from a stack
  that exports nothing.

`cdkd scrub` holds BOTH halves per container: its write gate is
`recordsChanged > 0 && !opts.dryRun`, so under `--dry-run` it provably cannot
persist and repairs instead, carrying the finding out so the run still exits
non-zero. `cdkd rollback` takes NO outputs guard — it reads none, so there is
nothing to launder.

**Three sites do NOT follow the rule mechanically**, and reading it as "does this
file call `saveState`" gets each one wrong:

- `nested-stack-provider.ts` calls no `saveState` and still REFUSES — what it
  returns becomes the parent's `ResourceState.attributes`. Write-capable THROUGH
  A CALLER is the same hazard.
- `destroy-runner.ts` never rebuilds the bag; it DECIDES from it. There the
  read-only repair is the unsafe answer — reading an unreadable bag as empty IS
  the "exports nothing" verdict that skips the strong-reference check.
- the resolver's `Fn::GetStackOutput` arm REFUSES the reference rather than
  failing closed like its `Fn::ImportValue` sibling, because it is the one reader
  that RE-APPLIES. It raises `MalformedProducerRecordRefusalError` (an
  `IntrinsicResolutionRefusalError` SUBCLASS) so `resolveSub` cannot launder it,
  and so `cdkd scrub`'s pre-pass can record an unverifiable finding instead of
  refusing the whole consumer stack.

The two `cdkd local` readers REPAIR and WARN, and the premise is narrower than
"never writes": a `cdkd local` run CAN write the DERIVED exports-index key, which
is separately fail-closed by `hasReadableExportSet`. Nothing on that path can
launder a RECORD, which is what makes repair safe there.

## The fence

`tests/unit/state/malformed-resources-bag.test.ts` enumerates the write-capable
files PER CONTAINER, each with a DOMINANCE anchor — the first expression in that
file which reads the bag — so a guard cannot drift below the read it protects (a
presence-only check stays green through that). It also pins the premise of every
exclusion, so a file that starts reading a container it did not read before fails
instead of quietly joining the wrong side.

## The `exportNames` FIELD takes its own rule

Not a container, so none of the guards above touch it — `importableOutputKeys` in
`src/types/state.ts` owns it.

- A non-array, or an array with **nothing usable in it**, reads as an EMPTY
  export set. **Never as an ABSENT one**: absent means "not known" and falls back
  to the pre-v9 rule where every output key is importable, so routing a corrupt
  field there republishes every plain output name as an export — the shadowing
  schema v9 exists to close.
- `some(isString)`, not `every`: `[]` is the legitimate "exports nothing", and
  `['Real', 0]` still has a name to publish.
- `hasReadableExportSet` answers what the empty list cannot — damaged versus
  genuinely exporting nothing — for the callers that must SAY which: `cdkd diff`
  warns with `malformedExportNamesWarning`, the exports-index rebuild with
  `malformedExportSourceWarning`. Failing closed inside a pure predicate is
  right; a LOUD wrong answer becoming a QUIET one is its own regression, which is
  why the two callers holding the identity say so.
