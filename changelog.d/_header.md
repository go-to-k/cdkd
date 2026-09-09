---
title: "cdkd changelog (extracted from CLAUDE.md)"
unlisted: true
---

# cdkd changelog (extracted from CLAUDE.md)

Detailed per-PR notes split out from the project's main [CLAUDE.md](https://github.com/go-to-k/cdkd/blob/main/CLAUDE.md)
so that file fits within Claude Code's recommended ≤200-line CLAUDE.md size
([official memory docs](https://code.claude.com/docs/ja/memory#cdb6dffa-claude.md-files)).

Each entry below describes a shipped change — the file at the top of the entry,
the public-facing surface that changed, the user-visible behavior delta, the
tests added, and (where present) the issue / PR number that drove it. Pre-PR
behavior is described in the past tense and post-PR behavior in the present
tense, so a reader reconstructing the history of any subsystem can read
top-to-bottom by date and see when each capability landed.

The CLAUDE.md `## Known Limitations` section retains the load-bearing summary
("NOT recommended for production use"); the per-PR detail moved here.

## What ONE entry may carry (issue [#2552](https://github.com/go-to-k/cdkd/issues/2552))

An entry is capped at **2000 characters**, counted over the bullet and every
continuation line under it, and enforced by
`tests/unit/scripts/changelog-entry-size.test.ts`. In a fragment the count is
the **whole file** as it reads, trailing whitespace stripped — so a blank line
*between* two prose lines counts, where the assembled document's own check
skips it, and a `---` at column 0 counts along with everything below it, where
that check stops at the rule. The two agree unless you pad or park a `---`
mid-entry. The entry keeps the
user-visible behavior delta, the changed files, the issue / PR numbers, and the
residual's issue number — roughly the headline plus the file list plus a few
sentences of mechanism.

Everything past that **moves rather than disappears**: a design decision to
`docs/design/<issue>-<slug>.md` (the directory already holds documents of that
shape, and `.claude/rules/` bullets already close with
`Design: docs/design/<n>-<slug>.md`), and a mechanism to the doc comment on the
module or test that implements it — where it sits next to the thing it
describes and moves when that thing does. The entry links to it.

The cap exists because prose here asserts implementation detail that no fence
can verify, and it drifts: a sentence describing an integration fixture's
premise guard has nothing checking it still matches that fixture, and one such
sentence needed its own follow-up PR ([#2549](https://github.com/go-to-k/cdkd/pull/2549)).
Editing this file also costs a full unit-suite run, since `docs/**` is a
`check` gate input — and moving the rationale does **not** reduce that: both
redirect targets, `docs/**` and `tests/**`, are in the same `check` scope. What
shrinks is the number of implementation facts one entry asserts with nothing
verifying them. Narrowing `.markgate.yml`'s scope is a separate question.
There is deliberately no per-entry opt-out.

**Every fragment you write is capped, whatever date its filename carries.** A
fragment under `changelog.d/entries/` is new by construction, so the date in
its name is a sort key for the assembler and never evidence about when the
entry was written. There is no allowlist of exempted entries and no date that
buys an exemption.

The cap is still **forward-only**, but the forward-only part now applies only
to the ARCHIVE: everything in `changelog.d/_archive.md` was written under no
cap, is already correct, and rewriting it buys nothing, so entries under a
heading dated before **2026-09-05** stay exempt *there*.

That exemption is reachable, and saying otherwise would be papering over it:
`_archive.md` is an ordinary tracked file the assembler reads on its own path,
so a bullet appended to it under a pre-cutoff heading bypasses the fragment cap
entirely. Nothing fences that. "No lane edits the archive again" is a
convention, not a mechanism — what the fragment cap buys is that the *ordinary*
way to write an entry is capped.

Until issue [#2859](https://github.com/go-to-k/cdkd/issues/2859) the cap keyed
on the heading date alone, which meant a fragment named with a pre-cutoff date
shipped uncapped. That was survivable only because issue
[#2813](https://github.com/go-to-k/cdkd/issues/2813) happened to refuse any
fragment dated inside the archive's span; fixing #2813 would have widened the
uncapped window by about three months, so the cap moved to the fragment itself.

The cutoff is the day *after* the cap landed, not the day of. A same-day cutoff
races every other lane merging that day: while this was in review, two
unrelated PRs merged the same afternoon and added 3,001- and 1,854-character
entries under the same heading. A same-day cutoff would have turned `main` red
for entries written before the rule existed, or forced a grandfathering list
that grows by whoever merges next — an opt-out reachable by being late.

## WHEN an entry is required (issue [#2779](https://github.com/go-to-k/cdkd/issues/2779))

The section above caps what one entry may carry. This one decides whether a
change writes one at all, and it NARROWS the population: a change with no
user-visible behavior delta needs no bullet.

The test is what the SHIPPED ARTIFACT does — the binary a user runs. A change
that alters it writes an entry; a change to how this repository is developed,
reviewed, or checked does not. In practice that means `src/**`, plus anything
that feeds data the runtime reads. Agent instructions under `.claude/**`, the
unit and integration suites, the CI workflows, the hooks, and documentation
edits that describe behavior rather than change it are all out.

One case sits on the line and is IN, deliberately: a `scripts/**` generator
whose output the deploy path consumes. The refreshed CloudFormation schemas
decide SDK-versus-Cloud-Control routing at deploy time, so a change there can
silently drop a property from a user's stack — a behavior delta that happens
to be produced by a build-time script.

That clause is a BACKSTOP rather than a common case, and saying so is better
than letting the next reader over-estimate it: such a generator commits its
output under `src/**` and CI fails on drift, so a PR that really changes what
the deploy path reads is already IN by the ordinary trigger. What the clause
catches is the split landing — a generator edit whose regenerated output
arrives in a later PR.

**On the `src/**` side this is codification; on the other side it is a real
narrowing.** Measured over the 40 merged PRs ending at
[#2787](https://github.com/go-to-k/cdkd/pull/2787), ordered by merge time: 20
wrote an entry, and 9 of the 10 touching `src/**` did — the one exception
being a comment-only edit. That half the rule only writes down.

The other 30 are where it bites. Eleven of them wrote an entry and nineteen
did not, along no line anyone could name: retiring nine PreToolUse gates wrote
none while pinning one environment flag wrote one, and both change how every
future session behaves. Under this rule **all eleven of those flip to no
entry**. Six touch `scripts/**` and none of the six feeds the deploy path —
they are CI checkers, coverage-matrix generators and a schema-refresh
REPORTER, not the schema refresh itself — so the exception above does not
rescue them; the remaining five are hooks, tests and docs. That is over a
quarter of the window changing behavior, not a formality.

The window is named by its BOUNDARY PR rather than by a date on purpose: these
figures were first published as "the 40 most recently merged as of 2026-09-08"
and were invalidated within the hour by two same-day merges, which a date
stamp cannot express. Re-derive by walking merged PRs from that boundary.

The rate is also window-dependent, so treat any of it as a reading rather than
a constant: over 120 merged PRs from the same boundary the `src/**` side holds
at 87.8% while the non-`src` entry rate falls from 36.7% to 19.0%.

Two consequences worth stating, since neither is obvious from the rule. An
entry is not a record of effort — a large agent-tooling PR correctly writes
nothing, and that is not a demotion. And the entry a change does not write
still has somewhere to go: the reasoning belongs in the commit message, a
design note under `docs/design/`, or the doc comment of the module it
describes, all of which outlive a bullet.

Enforced only by review. A CI check could require an entry from a `src/**`
diff, and deliberately is not added: a missing bullet harms nobody at the
moment of the merge and is repaired by an edit, which is below this repo's bar
for a blocking gate. What IS fenced is that the four copies of this rule agree
(`tests/unit/scripts/changelog-entry-policy-sync.test.ts`).

Note for anyone editing THIS section: a line starting with `- ` at column 0
reads as a changelog ENTRY to the uniqueness fence, which would key it and
count it toward that fence's population floors. (The size cap does not see it —
it resolves each entry's date and so exempts everything above the first dated
heading.) The contract sections are written as prose on purpose.

## WHERE an entry goes (issue [#2779](https://github.com/go-to-k/cdkd/issues/2779))

You are reading an ASSEMBLED document. It is built by `vp run gen:changelog`
from `changelog.d/` and is gitignored — never edit it, and never commit it.

An entry is one file, `changelog.d/entries/<YYYY-MM-DD>-<issue>-<slug>.md`,
containing the bullet and nothing else. The issue number in the path is what
makes two lanes structurally unable to choose the same file, which is the
whole point: every lane used to append to one anchor at the top of one list,
and that anchor is what conflicted on nearly every parallel-lane rebase.

**Do not write a dated heading into a fragment.** The assembler emits one per
DATE, grouping the entries that share it, and splices a date the archive
already heads underneath that heading rather than opening a second one. That
is what makes the duplicate-heading defect above structurally impossible
rather than merely fenced: no lane writes a heading, so no merge resolution
can duplicate one. `assemble-changelog.test.ts` refuses a fragment carrying
one.

Everything written before the migration lives in `changelog.d/_archive.md` as
a single file. Splitting settled history into hundreds of fragments would have
produced a diff nobody could review, in which a mis-split is indistinguishable
from a correct one, to make uniform something no lane will edit again.

## What a SECTION HEADING must be (issue [#1837](https://github.com/go-to-k/cdkd/issues/1837))

Entries are grouped under `**Recently Implemented** (YYYY-MM-DD):` headings.
`tests/unit/scripts/changelog-entry-uniqueness.test.ts` requires that every
line which READS as one is spelled exactly that way — at column 0, in that
case, with a `YYYY-MM-DD` date — that no heading text repeats, and that the
dates never rise as you read down the file.

They exist because a rebase resolving "keep both sides" duplicates a heading as
readily as it duplicates an entry, and the entry verdicts in that file cannot
see it — they key `- ` bullets, and a heading is not one. Measured on `main` at
2026-09-08, before the fence: the 2026-08-18 and 2026-08-25 headings each
appeared twice among 52, and the 08-25 pair had an 08-24 section wedged between
its halves, so the dates ran 25 → 24 → 25 → 23.

Splitting one day deliberately is fine and needs no exemption — distinguish the
headings the way `(2026-07-02, second batch):` does. Uniqueness keys the whole
heading text, and the ordering verdict rejects only a rising date, never an
equal one.

---
