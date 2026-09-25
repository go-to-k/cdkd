---
description: cdkd CFn schema refresh - the fixture PRODUCER under scripts/, its diagnosis and backfill-campaign reconcilers, and the two workflows that run them
paths:
  - 'scripts/refresh-cfn-schemas.mjs'
  - 'scripts/diagnose-schema-refresh.mjs'
  - 'scripts/diagnose-schema-refresh.d.mts'
  - 'scripts/sync-backfill-umbrella.ts'
  - 'scripts/offline-property-evidence.ts'
  - 'scripts/published-sdk-typings.ts'
  - '.github/workflows/cfn-schema-refresh.yml'
  - '.github/workflows/backfill-umbrella-sync.yml'
  - 'tests/unit/scripts/refresh-cfn-schemas-zip.test.ts'
  - 'tests/unit/scripts/cfn-schema-refresh-workflow.test.ts'
  - 'tests/unit/scripts/backfill-umbrella-sync-workflow.test.ts'
  - 'tests/unit/scripts/umbrella-checklist-no-deps.test.ts'
  - 'tests/unit/scripts/sync-backfill-umbrella.test.ts'
  - 'tests/unit/scripts/diagnose-schema-refresh.test.ts'
---

# The CFn schema refresh

Index of every area: [code-layout.md](code-layout.md).

## scripts/refresh-cfn-schemas.mjs

The PRODUCER of `tests/fixtures/cfn-schemas/*.json`, the offline oracle every
coverage critic and the deploy-time SDK-vs-Cloud-Control routing table derive
from. Two capture SOURCES, one fixture shape.

- **Freshness is a correctness property, not hygiene**
  ([#2718](https://github.com/go-to-k/cdkd/issues/2718)):
  `ProviderRegistry.getProviderFor` routes from `property-coverage.generated.ts`,
  built offline from these fixtures with NO runtime `DescribeType`. A top-level
  property AWS publishes after the snapshot is in no fixture, so
  `findSilentDropProperties` returns nothing for it (`property-coverage.ts`
  treats "not in the schema" as a typo or an `addPropertyOverride` escape hatch),
  the resource stays on the SDK provider, and the property is **silently
  dropped** while the deploy reports success.
- **`DescribeType` mode**: `node scripts/refresh-cfn-schemas.mjs
  [type-filter] [--only-missing]`, needs `cloudformation:DescribeType`, rewrites
  every type it captures. The ONLY route for types the public bundle does
  not carry.
- **`--from-zip` mode** (`vp run gen:cfn-schemas-from-zip`): reads AWS's PUBLIC
  `CloudformationSchema.zip` with **no AWS identity at all**, which is what made
  an unattended scheduled job adoptable.
- **`buildFixture` / `serializeFixture` are shared by both sources on purpose.**
  A second capture path formatting one field differently would rewrite every
  fixture the other produced, and that phantom diff is indistinguishable from
  real AWS drift — the signal the zip mode exists to compute.
- **`fixtureDiffersIgnoringDate` is the change signal**, with `generatedAt`
  excluded because the refresh stamps a date on every type it touches. It
  compares the SERIALIZED forms so the predicate cannot disagree with the write,
  ANCHORS the date on one side rather than deleting the key (deleting changes key
  order on one side only, reporting everything as drifted), and treats an absent
  or unparseable committed fixture as drift.
- **Two collapse floors, both aborting with zero writes.** `MIN_ZIP_ENTRIES`
  refuses a truncated-but-parseable bundle; `MAX_MISSING_TYPE_RATIO` refuses an
  entry-naming or layout change. Both guard the same failure: every lookup
  misses, every type takes the legitimate skip path, and the run reports a
  confident ZERO drift. A type genuinely absent is SKIPPED with its fixture left
  byte-identical, **never blanked** — an emptied `properties` would turn every
  provider declaration bogus and destroy silent-drop routing for that type.

## The daily refresh workflow

`.github/workflows/cfn-schema-refresh.yml` hands the residue to a human: a
removed property the evidence cannot settle, or a new nested key.

**That hand-off is NOT signalled by a red check**: GitHub holds a bot-created
PR's workflows at `action_required` on every push, and merging an earlier bot PR
earns no exemption. The signal is the title's decision count and the
`needs-decision` label, produced by the job running the fixture-driven checks
itself before its PR's CI may start. **Not signalled is not unblocked**: with
`ci-ok` as the required status check, a decision-carrying refresh PR is
unmergeable while HELD, and once approved for most of `countDecisions`'s terms,
which also red `check-build-test`.

Two caveats:

- Some terms are read from a refresh-side EXIT CODE (`failedChecks`,
  `nestedKeyUnparsed`), so an environmental failure there counts a decision CI
  never sees, CI running those tasks independently. The others cannot: `removed`
  is a fixture DIFF, and `divergences` / `pendingSdkBump` come from finding
  LINES.
- Some terms are not covered at all. **Derive the covered set from
  `CI_COVERAGE`'s `covers` union and the uncovered one from `UNCOVERED_TERMS`,
  both in the fence, never from a review comment.** `unreadable` (the diagnosis
  could not read a fixture) and `identifierChanges` (a type whose
  `primaryIdentifier` VALUE changed — neither an addition nor a removal) are the
  uncovered ones; the second is uncoverable BY CONSTRUCTION, since its consumer's
  matrix is regenerated in the same run and a check pinning each identifier would
  red on every legitimate AWS change. `removed` holds only through
  `partitionSettledRemovals`, which subtracts every property `bogusTolerated`
  settles — both sides read the tolerance FILE, and the settled half is still
  RENDERED, because subtracting alone made the removal invisible. The coverage
  that holds is EMERGENT, since the two workflows keep their own check lists, so
  `schema-refresh-decision-ci-coverage.test.ts` derives every population.

A refresh PR needing a decision is LABELLED `needs-decision`, titled with the
count and ASSIGNED — only the assignment notifies. The count comes from
`--decision-count-out`, written by the SAME `diagnose-schema-refresh.mjs` run
that renders the body: a second invocation could take a different
`--failed-checks` and mark a PR clean over a report listing several. The marking
is CLEARABLE because `Regenerate` and `Diagnose` also run while a refresh PR is
open, not only on drift.

## The backfill campaign

The refresh job does NOT write the backfill campaign's issue;
`.github/workflows/backfill-umbrella-sync.yml` reconciles it on every `push` to
`main` touching `src/provisioning/property-coverage.generated.ts` — the exact
path filter, since `parseSilentDropByType` reads that file and nothing else.
Driving it from `main` rather than from the refresh RUN is what keeps it
describing a state that exists; that also took `issues: write` off the repo's
only unattended `contents: write` job
([#2774](https://github.com/go-to-k/cdkd/issues/2774)).

- **ONE issue.** `scripts/sync-backfill-umbrella.ts` rewrites a GENERATED BLOCK
  between `<!-- backfill-types:start -->` and `<!-- backfill-types:end -->` in
  the umbrella's body, one `- [ ] ` row per resource type, and everything
  OUTSIDE those markers — the audit provenance a PR closing a slice writes — is
  carried through byte for byte. Its refusals FAIL the run rather than warning:
  each guards a write onto the campaign's only public page.
- The block is DELIMITED rather than the body being rewritten whole, because a
  generated region that can reach human provenance is the only write here that
  could destroy something no run can recompute
  ([#2998](https://github.com/go-to-k/cdkd/issues/2998)).
- One issue, not one per type: a per-type set is indistinguishable from unfixed
  defects in the open-issue count. A PR writes `Refs` and its row disappears on
  its own.
- The `backfill-type` label is LEGACY: nothing generates it, and it stays on each
  slice the one-shot migration (`node scripts/sync-backfill-umbrella.ts
  --close-legacy`, run by hand) closes — that pass skips any labelled issue whose
  body carries no generated marker, since that is something a person filed.
- **The campaign is about ROUTING, not loss**: an unwired property auto-routes
  the whole resource through Cloud Control, which forwards the full map
  ([#614](https://github.com/go-to-k/cdkd/issues/614)), so backfilling restores
  the SDK fast path rather than fixing data loss.

## Settling a removal automatically

**The job settles a removal ITSELF only when two structural facts hold**: the
type's OWN service client declares a member of the name
(`scripts/offline-property-evidence.ts`'s `typedSdkMember`, a TypeScript-AST walk
of `dist-types/models` — NOT the case-insensitive name-presence scan), AND the
provider wires it (`providerWiresProperty`, counting ONLY element accesses by
string literal, so a name appearing solely in a declaration array does not
qualify, and a `.X` property access is deliberately excluded because a drift
read-back spells it identically). A rename candidate on the type escapes the rule
outright: the SDK keeps the old name either way. Both spellings count, because
exact-case-only would escalate every camelCase-modelled service.

Two shapes it must keep excluding: a RESPONSE-only model (reachable from no
operation input) and a `.X` property access as wiring evidence. **Absent wiring
evidence means COULD NOT DETERMINE, never "dead weight"** — table-driven wiring
is invisible to it. `--write-auto-tolerated` runs as its own step BEFORE the
checks so the PR arrives green; `--auto-tolerated` hands the record to the
report, which lists the writes in their own section and leaves them out of the
decision count.

`scripts/published-sdk-typings.ts` downloads a LAGGING client
(`npm pack --ignore-scripts`, model typings only, nothing executed) so
`partitionPendingSdkBump` can re-ask a `definition-member-missing` finding's own
INTERFACE-scoped question at the published version. Resolved ones group into one
BUMP each, still COUNTED — until it lands the value does not reach AWS. A NAME
lookup is the wrong tool and is fenced.

## The changelog fragment

The job writes its own changelog fragment — the only file it commits and then
never rewrites, because an added writable property is a delta the changelog asks
an entry for. `renderChangelogFragment` (`--changelog-out`) states ONLY what the
fixture diff and three parsers settle, plus a third bucket telling neither story
when routing is unknown. The TABLE parsers THROW rather than returning empty,
`parseStickyCcMigrationExempt` also on a PARTIAL read: an unread table reads as
"nothing is exempt", the polarity that ships a false claim. Two ORDERINGS are
load-bearing: rendered at `Diagnose` (the last point the fixtures still differ
from their committed copies), committed after `Publish` (where the PR number
first exists) — hence the `__PR_NUMBER__` / `__CYCLE__` placeholders, and the
date in the HEADLINE because the uniqueness fence keys on it and two cycles can
share one PR.

## Unit tests

`refresh-cfn-schemas-zip.test.ts` (the capture path, its floors, and a deleted
property that must be reported drifted and rewritten, with a byte-identity
CONTROL twin so a report-everything checker cannot pass both);
`cfn-schema-refresh-workflow.test.ts` (workflow invariants, chiefly that the
open-PR guard and the branch construction share one branch prefix — a drift
there lets every cycle open a competing PR); `umbrella-checklist-no-deps.test.ts`
(every render-only mode SPAWNED with no `node_modules`, plus a control restoring
the static import); `backfill-umbrella-sync-workflow.test.ts` and
`sync-backfill-umbrella.test.ts` (trigger exactness, the two-scope permission
grant, and both halves' refusals — no wipe of a live checklist, no missing or
duplicated marker, no write on an unchanged run); and
`schema-refresh-decision-ci-coverage.test.ts`, which owns the CROSS-workflow
relation the others cannot see. NO AWS integ (pure capture + static analysis).
