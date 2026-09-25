---
description: The per-container REFUSE / REPAIR guards over a state record whose resources or outputs bag, or orphans list, a hand edit left unreadable
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
| `orphans` | `hasReadableOrphans` | `refuseMalformedOrphans` + destroy and `cdkd orphan` siblings | `repairMalformedOrphansForReadOnly` |

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
unreadable bag has no rows to walk. These entries sit in the table's FIRST row,
the `resources` map — not in a list. Since go-to-k/cdkd#3202 every consumer
takes a half: the destroy through `refuseMalformedResourceEntriesForDestroy`,
`cdkd scrub` through its own class around
`malformedScrubResourceEntriesRefusalMessage`, `cdkd import` in SELECTIVE mode
only (whole-stack replaces the map — a recovery route), and the `cdkd local`
loader with two local texts; the sibling claim scan in `orphan-adoption.ts`
asks for a non-empty `physicalId` instead, because a typeless row still claims.

**The `orphans` ROW class is its own, one level under the table's THIRD
container (go-to-k/cdkd#3500).** That container is guarded above the rows, so a row pass runs only once the field is known to be a
list — which is why `unreadableOrphanRecords`, `unpreviewableOrphanRecords` and
`previewableOrphanRecords`, the helpers that ENUMERATE, return `[]` for a
container that is not one. The
predicates themselves answer per RECORD and say nothing about the container. `isReadableOrphanRecord` is the predicate and
`unreadableOrphanRecords` names every row a state fails on — PLUS every row
whose string `logicalId` another row carries (go-to-k/cdkd#3643), the one
LIST-level defect no per-record predicate can see, so never filter a list with
the predicate alone: take `unreadableOrphanRecords` /
`previewableOrphanRecords`. The disposition
splits the way the container's does — `refuseMalformedOrphanRecords` for a
writer, `refuseMalformedOrphanRecordsForDestroy` for the destroy,
`refuseMalformedOrphansForOrphan` for `cdkd orphan` (which answers for the
container in the same call), and `repairMalformedOrphanRecordsForReadOnly` for
`cdkd scrub --dry-run`, which DROPS the row and names it through
`malformedOrphanRecordsWarning`. That warning serves TWO predicates, so its
`alsoRejectsTornMaps` flag is REQUIRED rather than defaulted, and it governs the
CONSEQUENCE clause as well as the diagnosis — what continuing without the row
costs is per command (excluded from the secret scan, versus not previewed for
adoption), and a defaulted flag lets a third caller under-report silently.

**`cdkd diff` takes a NARROWER predicate, and that is deliberate.**
`isPreviewableOrphanRecord` / `unpreviewableOrphanRecords` /
`previewableOrphanRecords` ask only what the
adoption preview dereferences — an object, a string `logicalId`, a readable
`state` with a NON-EMPTY string `physicalId` — and say nothing about that state's
`properties` / `attributes`. The
reason is `properties` alone: `computeStackDiff` repairs and names that map a
second time over the adopted records
([state-malformed-properties.md](state-malformed-properties.md)), and does NOT
touch `attributes`, so a torn `attributes` map is still not REPAIRED or named by
that pass.

**What `cdkd diff` owes for a row it keeps is the DEPLOY's verdict, and that is
not optional**. The writers refuse the whole record over
such a row, so a preview that keeps it and says nothing lets `cdkd diff --fail`
exit 0 and the deploy the operator runs next refuse — the contract `cdkd diff`
states for the adoption preview. `deployRefusesOrphanRowsReason` is that verdict:
`diff-recursive.ts` computes the rows the NARROW predicate accepts and the FULL
one rejects — from the ROWS the preview kept — and then SUBTRACTS
the names the adopted-`properties` arm already reported, because `countBlocking` counts one reason per row
(go-to-k/cdkd#3335). So what this arm
covers is the two cases nothing else does: a torn `attributes` map, and a torn
`properties` map on a row the adoption did NOT take. Subtracting by NAME is
exact because rows sharing an id are DROPPED before the preview
(go-to-k/cdkd#3643) — dropped rather than kept-and-warned, so the preview never
shows one adoption for two rows and `--fail` counts them.

**The REASON is top-level only and the WARNING is not**, and that asymmetry is
load-bearing (go-to-k/cdkd#3641). "Every node" means every node the RUN
REACHES with an adoption preview, which is narrower in two ways: `buildDiffTree` returns before visiting any child unless `recursive`,
so a plain `cdkd diff` warns for the top-level stack only; and
`buildDeletedSubtree` calls `computeStackDiff` with no `previewOrphanAdoption`,
which the whole row block is gated on, so a state-only child being DELETED gets
neither orphan warning — its removal goes
through `NestedStackProvider.delete` → `runDestroyForStack`, which refuses the
row; no message may claim that child is warned for. The reason follows
go-to-k/cdkd#3335's scope decision: the deploy skips an unchanged nested-stack
row, so a reason there would report a refusal over a deploy that succeeds. What
makes that split SAFE is that every class still WARNS at every node; a KEPT row
gets no word from `malformedOrphanRecordsWarning` (DROPPED rows only), so
`malformedOrphanRowsKeptWarning` carries it.
Handing `cdkd diff` the writers' full predicate DROPS such a row instead, which
retires that report rather than tightening it; a case in
`tests/unit/cli/diff-recursive-malformed-orphans.test.ts` reds on exactly that
substitution. **Both row predicates ask for a NON-EMPTY string `physicalId`, which
`isReadableResourceEntry` does NOT** (go-to-k/cdkd#3641): that one stops at
`resourceType` because a `resources` row failing per-resource is reported by its
own command, while an `orphans` row's physical id is the only handle on a
resource cdkd deliberately left LIVE — `cdkd destroy`'s listing is the one notice
before the record is deleted, and `planOrphanAdoption` resolves that id against
AWS and against other stacks' claims. The WRITERS' predicate asks MORE still —
readable `properties` / `attributes` — because
these rows are reached as a whole and a row MISSING its id collapses with every other such row
in `orphansAfterRollback`'s merge map. Do not re-spell the test at a call site: one asking only about `state`
previews an adoption for a row the writers refuse.

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
- **`cdkd rollback` refuses the same record with its OWN message**
  (`refuseDivergentRecordRegionForRollback` in `rollback.ts`,
  go-to-k/cdkd#3370), not this builder — whose opening, consequence and remedy
  speak about a DESTROY. Same conjunction, same code, kind-only; it offers no
  command, so it needs no exactness gate. ONE command-level refusal covers every
  replay arm because every AWS-calling arm needs a current state row.

## Where a pasteable command goes (go-to-k/cdkd#3516)

**A message offering only a READ ends ON it**, `inspectCommand`. Mid-sentence it
sits one space from the next clause and a line-select paste carries that clause
in as arguments, so the fence is `endsWith`, never `toContain`, which passes a buried command.

**A message offering a read AND the destructive template puts one command per
LINE** (`Inspect the record:` / `Drop the record:`). One line cannot do both:
the read must end a line, and the template must be LAST with no substituted
region after it, or the value the prose just said not to trust sits below the
holes the operator fills by hand. Do not collapse them. Fence with a line LIST
(`toEqual`), which `endsWith` cannot express, and take the injected-newline
control from the SAME ARM — the line count differs per arm.

**Naming a target beside that template needs more than faithful rendering**:
exactness keeps a space and a `:`, so an identifier can spell one of these
labels and forge it inside the quoted clause once the terminal wraps. Add
`isPasteableIdent` on BOTH identifiers, in CONJUNCTION with exactness, measured
at the cap the message's own clause RENDERS at. THREE messages carry it: the two
DESTROY refusals via `mayNameTargetWithDestructiveRemedy` (region at 128), and
`divergentRecordRegionRefusalMessage`, which spells its own because it renders a
KEY region at the state-record cap (go-to-k/cdkd#3328).

`dropRecordCommand` is the EXCEPTION and it is open: it SUBSTITUTES rather than
templating and still gates on `rendersExactly` alone — a trade-off, not an
oversight (go-to-k/cdkd#3523 carries why, and the behaviour is pinned). Every
other message here offers a read ONLY and is ungated. Borrowing a gate across
sites is safe only DOWNWARD: a 128-capped gate at a 1152-capped site withholds;
the reverse names a region its own clause renders truncated.

Where a site's two caps DIFFER, fence that operand — the pasteability half needs a row
that is exact yet unpasteable, which no truncation row reaches. Where they are
the SAME, exactness is subsumed and nothing can red on dropping it: unfenceable
rather than unfenced.

That third message still ends on the template, on one line, because its EXACT
arm offers no read; its withhold arm does. Not the shape to copy for a message
offering both. And the per-line shape is a property of the MESSAGE, not of every
surface printing it — two readers flatten it back (go-to-k/cdkd#3518).

## Two exports here are not guards at all

`producerRecordKey` (a `stack`+`region` RECORD) and `producerCoordinateKey` (a
`stack`+`export-name` COORDINATE) are the ONE encoding anything identifying a
producer-side thing by a string pair goes through — a warned-once `Set`, a
dedupe `Set`, a memoization `Map`. Separate NAMES because the subjects differ
and a call site reading `producerRecordKey(stack, exportName)` would say
something false; ONE private implementation, which is the property the
"one spelling" rule is about.

They live in this module because their callers already import it for the
guards. **What a collision COSTS is per site, not a property of the key**: at the two warned-once sets it drops a warning line, at
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

## Each container is its own call, deliberately

A record can be malformed in ONE container alone, so a command that reads several
makes one call each and the message names the one that is broken. Collapsing them
is wrong in both directions — a `resources` refusal printed over an intact
resource map tells the operator their stack would be re-created on the next
deploy, which does not hold.

**The ABSENCE rule differs per container.** An absent `resources` bag is a defect.
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
