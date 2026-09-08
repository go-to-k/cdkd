import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleChangelog } from '../../../scripts/assemble-changelog.js';
import { describe, expect, it } from 'vite-plus/test';

/**
 * The rule deciding WHETHER a change writes a changelog entry lives in four
 * places, and none of them can execute it:
 *
 *   a. `changelog.d/_header.md` -- the "WHEN an entry is required" section,
 *      the long form with the measurement behind it, and the source of truth.
 *   b. `CLAUDE.md` -- the "Recently Implemented" paragraph, read by every
 *      session whether or not it opens the changelog.
 *   c. `.claude/skills/check-docs/SKILL.md` -- the step that asks the question
 *      at the moment a lane is about to write one.
 *   d. `.claude/skills/work-issues/references/ship.md` -- the rebase section,
 *      where "does this lane have an entry" decides whether the conflict
 *      procedure below it applies at all.
 *
 * Why a fence rather than the "keep in sync" comment the copies could carry:
 * this repo has measured that comment failing. `cross-cutting-list-sync.test.ts`
 * exists because two lists asking to be kept in sync were both out of sync when
 * someone finally checked, and go-to-k/cdkd#2779's own analysis names the
 * instruction sweep -- not the rule -- as where option B's effort actually
 * goes. A rule stated in four voices drifts into four rules.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the four copies still
 * MENTION the same things: the in-scope trigger, the out-of-scope population
 * and what happens to it, and the on-the-line exception. Mentioning is the
 * honest verb -- a copy REWRITTEN to say the opposite passes, measured: swap
 * CLAUDE.md's paragraph for "Every change writes one, including one with no
 * user-visible behavior delta ... Agent instructions, tests, CI, hooks and
 * behavior-describing docs DO write an entry" and every concept is still
 * present. A substring fence cannot see polarity, and pinning sentences
 * instead would red on every legitimate rephrase and be deleted within a
 * month. The bound is accepted; over-claiming it is not, which is why the
 * failure message names DELETION rather than reversal as what it catches.
 *
 * It does NOT prove any of them is right, and it cannot prove a lane obeyed
 * the rule -- nothing here reads a diff. That gap is deliberate and recorded in the
 * changelog's own section: a missing bullet harms nobody at the moment of the
 * merge and is repaired by an edit, which is below this repo's bar for a
 * blocking gate (go-to-k/cdkd#2717's stopping rule for the guard layer).
 *
 * Matching is per-CONCEPT rather than per-sentence so an author may rephrase
 * freely; what that costs is stated above and not repeated here.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

interface Copy {
  readonly label: string;
  readonly path: string;
  /** Restrict the search to the region that states the rule, when the file is large. */
  readonly section?: { readonly from: string; readonly to?: string };
}

const COPIES: readonly Copy[] = [
  {
    label: 'changelog contract (source of truth)',
    path: 'changelog.d/_header.md',
    section: { from: '## WHEN an entry is required', to: '## What a SECTION HEADING must be' },
  },
  {
    label: 'CLAUDE.md',
    path: 'CLAUDE.md',
    section: { from: '**Recently Implemented**', to: '## Dependencies' },
  },
  {
    label: '/check-docs',
    path: '.claude/skills/check-docs/SKILL.md',
    section: { from: '- Check CLAUDE.md\'s "Known Limitations"' },
  },
  {
    label: 'ship.md rebase section',
    path: '.claude/skills/work-issues/references/ship.md',
    // The `to` anchor was 'After resolving' until issue go-to-k/cdkd#2779
    // option A deleted the changelog conflict machinery that phrase headed.
    // The region ran to EOF at 17,770 characters and the CEILING added one
    // round earlier caught it -- which is the whole reason that half exists.
    section: { from: '**Does this lane write a changelog entry at all?**', to: '**FLATTEN BEFORE YOU REBASE' },
  },
];

/**
 * The concepts the rule turns on. Each is a set of alternative spellings; a
 * copy satisfies the concept when it carries ANY of them, case-insensitively.
 *
 * The out-of-scope PAIR -- naming that population, and saying it writes
 * nothing -- is why this is not a single keyword match: a copy could name the
 * trigger and silently drop the exemption, the direction that RESTORES the old
 * every-PR-writes-one behaviour while still reading like the rule.
 */
const CONCEPTS: readonly { readonly name: string; readonly anySpelling: readonly string[] }[] = [
  { name: 'the user-visible-delta trigger', anySpelling: ['user-visible behavior delta', 'user-visible behaviour delta'] },
  { name: 'the shipped-binary test', anySpelling: ['shipped binary', 'shipped artifact'] },
  { name: 'the src/** in-scope population', anySpelling: ['`src/**`'] },
  { name: 'the out-of-scope population', anySpelling: ['agent instruction', 'agent-tooling', 'agent instructions'] },
  {
    // The OUT half stated as an ASSERTION rather than as a list of nouns.
    // Naming the population is not the same as saying what happens to it: a
    // copy could keep the noun list while reversing the verb.
    name: 'that the out-of-scope population writes NOTHING',
    anySpelling: ['writes no entry', 'write no entry', 'writes none', 'write none', 'needs no bullet'],
  },
  { name: 'the scripts/** on-the-line exception', anySpelling: ['`scripts/**`'] },
];

/**
 * TWO concepts were REMOVED from the list above after review measured them
 * INERT, and the removal is recorded rather than done quietly because a
 * concept that cannot fail is decoration that reads like coverage.
 *
 * `docs/design/` -- "where the un-written reasoning goes" -- passes on THREE
 * of the four pre-rule copies on `origin/main`, satisfied by the older
 * go-to-k/cdkd#2552 sentence about where an over-long entry's OVERFLOW goes.
 * Same path, different claim.
 *
 * `2779` -- "the issue that decided it" -- survives the realistic drift rather
 * than catching it: deleting the rule sentences from CLAUDE.md while leaving
 * the trailing "(issues ..., go-to-k/cdkd#2779)" provenance line still passes,
 * and CLAUDE.md is the copy under standing length pressure.
 *
 * The writes-NOTHING concept above replaces both, and it discriminates:
 * measured, no pre-rule copy carries any of its spellings and every post-rule
 * copy carries one.
 */
const REMOVED_AS_INERT = ['docs/design/', '2779'] as const;

function sectionOf(copy: Copy): string {
  const text = readFileSync(join(REPO_ROOT, copy.path), 'utf-8');
  if (!copy.section) return text;
  const start = text.indexOf(copy.section.from);
  expect(start, `${copy.label}: the section anchor "${copy.section.from}" is gone from ${copy.path}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  if (!copy.section.to) return rest;
  const end = rest.indexOf(copy.section.to);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Collapses every run of whitespace to one space. LOAD-BEARING, not tidiness:
 * these are 80-column Markdown files, so a multi-word concept lands across a
 * line break as often as not, and the first revision of this fence reported
 * `ship.md` as missing "user-visible behavior delta" while the file said
 * exactly that with a newline between the second and third word. Un-normalized,
 * the fence fails on correct copies and is deleted within a month.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

describe('changelog entry-policy sync', () => {
  const sections = COPIES.map((c) => ({ copy: c, text: flatten(sectionOf(c)) }));

  // Evaluated ONCE, here, so both the coverage verdict and the rule verdict
  // read the same walk. Counting `evaluated` rather than `COPIES.length *
  // CONCEPTS.length` is the difference between watching the DATA and watching
  // the LOOP: an array-length assertion is satisfied while the loop iterates
  // `CONCEPTS.slice(0, 0)`, which is exactly the collapse it was added for.
  const missing: string[] = [];
  let evaluated = 0;
  for (const { copy, text } of sections) {
    for (const concept of CONCEPTS) {
      evaluated++;
      if (!concept.anySpelling.some((s) => text.includes(flatten(s)))) {
        missing.push(`${copy.label} (${copy.path}) no longer states ${concept.name}`);
      }
    }
  }

  it('evaluates the whole (copy x concept) product', () => {
    // `missing` below is a nested-loop product over two arrays, so emptying
    // EITHER leaves it `[]` and the verdict green having checked nothing --
    // the collapse the sibling sync fences guard with a floor
    // (`cross-cutting-list-sync.test.ts`'s assertFloor,
    // `security-surface-list-sync.test.ts`'s MIN_PATHS) and this file shipped
    // without. Exact counts, not floors: both lists are hand-written and small,
    // so a change to either is deliberate and should say so here.
    expect(COPIES.length, 'a copy was added or dropped without updating this count').toBe(4);
    expect(CONCEPTS.length, 'a concept was added or dropped without updating this count').toBe(6);
    expect(
      evaluated,
      'the (copy x concept) walk did not evaluate every pair. With both list lengths pinned two lines up, ' +
        'this means the LOOP was narrowed rather than the lists'
    ).toBe(COPIES.length * CONCEPTS.length);
    // And the two retired concepts stay retired by NAME, so re-adding one as
    // load-bearing has to confront the measurement that removed it.
    expect(
      CONCEPTS.flatMap((c) => c.anySpelling).filter((s) => (REMOVED_AS_INERT as readonly string[]).includes(s)),
      'a concept measured INERT was re-added -- read the note above REMOVED_AS_INERT before restoring it'
    ).toEqual([]);
  });

  it('bounds every rule region from both sides', () => {
    // A MISSING `from` anchor never reaches here: `sectionOf` asserts on it and
    // runs in the describe callback, so that drift is a COLLECTION error naming
    // the anchor. (An earlier revision of this comment claimed the missing
    // anchor "slices an EMPTY region" and that this verdict caught it; it does
    // not, and the real behaviour is louder.) What reaches here is an anchor
    // that still matches but now bounds the WRONG span.
    //
    // All figures below are the metric the assertion USES -- flattened and
    // trimmed, not raw bytes. An earlier revision quoted raw `wc -c` numbers
    // beside a flattened comparison, so re-deriving them reintroduced a skew.
    // Measured: check-docs 1210, CLAUDE.md 1477, ship.md 2032,
    // changelog 4174.
    //
    // FLOOR 900. Its job is a `from` anchor that moved, which leaves a region
    // far smaller than any of those. It is NOT tight against the minimum on
    // purpose: check-docs' region is a single bullet at the end of its file, so
    // trimming ~100 characters of prose is routine, and a floor at 1100 would
    // red it while blaming the anchor. (The first revision used 200, which
    // review measured as proving nothing: with the whole rule deleted the two
    // surviving regions still come to 684 and 732.)
    //
    // CEILING 8000, the half that was missing entirely. A `to` anchor that
    // stops matching does not fail -- `sectionOf` silently returns the rest of
    // the FILE. Measured: renaming CLAUDE.md's `## Dependencies` takes its
    // region from 1,477 to 39,172, where concepts are then satisfied by
    // unrelated CLAUDE.md prose. So the ceiling only has to sit between the
    // largest real region and a run-on, and it is placed nearer the run-on
    // deliberately: the changelog region is the long form and grew 773 in one
    // commit of this very lane, so a ceiling close to 3392 would red the
    // source-of-truth copy for being written.
    const LOW = 900;
    const HIGH = 8000;
    const misbounded = sections
      .filter((s) => s.text.trim().length < LOW || s.text.trim().length > HIGH)
      .map((s) => `${s.copy.label} (${s.copy.path}): ${s.text.trim().length} chars`);
    expect(
      misbounded,
      `a rule region fell outside ${LOW}..${HIGH} flattened characters. Too short means the \`from\` anchor ` +
        'moved; too long means the `to` anchor stopped matching and the region ran on into unrelated text, ' +
        'where concepts are satisfied by prose that is not this rule. If a region legitimately grew, raise ' +
        'HIGH and re-derive the measurements in the comment above -- they are flattened lengths, not bytes.'
    ).toEqual([]);
  });

  it('states the same rule in every copy', () => {
    expect(
      missing,
      'A copy stopped MENTIONING part of the entry-required rule. Every one must still name: a ' +
        'user-visible behavior delta as the trigger, the SHIPPED BINARY as the test, `src/**` as in ' +
        'scope, agent tooling as OUT, that the OUT population writes NOTHING, and a `scripts/**` ' +
        'generator feeding the deploy path as the exception that is IN. This catches DELETION, which is ' +
        'the realistic drift as these files are trimmed; it cannot catch a copy REWRITTEN to say the ' +
        'opposite, because a rewrite keeps the tokens (see the header). Restore the missing part in the ' +
        'copy named, or -- if the rule itself changed -- change all four and this list together.'
    ).toEqual([]);
  });

  it('keeps the contract sections free of column-0 bullets', () => {
    // Both changelog fences treat a line starting with "- " at column 0 as an
    // ENTRY. A bulleted list inside a contract section would therefore become
    // phantom entries: keyed by the uniqueness check and inflating its
    // population floors. NOT counted by the size cap, which filters on a
    // resolved date and so exempts anything above the first dated heading --
    // that exemption is why `changelog-entry-size.test.ts` carries its own
    // `undated` verdict, and stating it wrongly here would send the next
    // author to the wrong fence.
    //
    // Scope bound: this scans only ABOVE the first dated heading, so a contract
    // section appended at the BOTTOM of the file would escape it. Nothing does
    // that today (measured: no `## ` heading below the first dated one), and
    // the size test's own orphan verdict plus the uniqueness check cover that
    // region.
    const changelog = assembleChangelog(REPO_ROOT).split('\n');
    const firstEntryHeading = changelog.findIndex((l) => l.startsWith('**Recently Implemented** ('));
    expect(firstEntryHeading, 'no dated heading found -- the file shape changed').toBeGreaterThan(0);
    const preamble = changelog.slice(0, firstEntryHeading);
    // The boundary is over-large loudly (a whole-file slice surfaces every
    // entry as an offender) but under-small SILENTLY: a slice that stopped
    // short would scan fewer contract sections and still report []. So pin
    // what the region must CONTAIN rather than only where it ends.
    const headings = preamble.filter((l) => l.startsWith('## '));
    expect(
      headings,
      'the contract sections above the first dated heading are not the expected ones, in order. FEWER means ' +
        'the scanned region stops short and one section goes unscanned; MORE means a section was added ' +
        'and should be listed here so it is covered too'
    ).toEqual([
      '## What ONE entry may carry (issue [#2552](https://github.com/go-to-k/cdkd/issues/2552))',
      '## WHEN an entry is required (issue [#2779](https://github.com/go-to-k/cdkd/issues/2779))',
      '## WHERE an entry goes (issue [#2779](https://github.com/go-to-k/cdkd/issues/2779))',
      '## What a SECTION HEADING must be (issue [#1837](https://github.com/go-to-k/cdkd/issues/1837))',
    ]);
    const offenders = preamble
      .flatMap((text, i) => (text.startsWith('- ') ? [`L${i + 1}: ${text.slice(0, 80)}`] : []));
    expect(
      offenders,
      'a contract section above the first dated heading uses a column-0 "- " bullet, which both changelog ' +
        'fences will read as a changelog ENTRY. Rewrite it as prose, or indent the list.'
    ).toEqual([]);
  });
});
