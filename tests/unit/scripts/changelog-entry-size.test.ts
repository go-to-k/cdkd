import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * `docs/changelog-cdkd.md` caps what ONE entry may carry. Issue
 * go-to-k/cdkd#2552 filed the shape and this file is its durable half.
 *
 * ## What the cap is for
 *
 * The file is not a release log -- release-please owns `CHANGELOG.md`, and it
 * can only emit a commit subject. This one is the per-PR DESIGN RECORD that
 * used to live in CLAUDE.md, and its entries are load-bearing: a future session
 * reads them to avoid re-litigating a settled decision or reintroducing a fixed
 * bug. That value is exactly why they grew. Measured on `origin/main` at
 * 2026-09-04, before the lane that added this file: 523 entries, 2,363,928
 * characters, median 3,452 and p90 8,999, the longest 19,548 characters on ONE
 * line and a different entry spanning 165 lines. A bullet routinely carried the
 * pre-PR behavior, the shape of the fix and why THAT shape, the cases the fix
 * refuses, the residual, and what an integ fixture's premise guards assert --
 * all inline.
 *
 * Two costs come from the PLACEMENT, not from the content:
 *
 * 1. `docs/**` is a `check` gate input, so a one-line changelog correction pays
 *    the full unit suite. PR go-to-k/cdkd#2549 was exactly that: a two-sentence
 *    factual correction to one bullet.
 * 2. The prose asserts implementation detail that nothing can verify. The two
 *    sibling fences on this file check for duplicate entries
 *    (`changelog-entry-uniqueness.test.ts`) and for ledger citations
 *    (`changelog-ledger-citation.test.ts`); neither can check that a sentence
 *    describing a fixture's premise guard still matches that fixture. The
 *    merge-gate review on go-to-k/cdkd#2511 found the go-to-k/cdkd#2485 entry
 *    naming only one of its two live arms, and the correction needed its own
 *    follow-up PR. That failure mode scales with the number of implementation
 *    details a bullet asserts, which is what this cap bounds.
 *
 * Only cost 2 is addressed. Moving the rationale does NOT make an edit cheaper:
 * both destinations, `docs/**` and `tests/**`, sit in the same `check` scope.
 * Narrowing `.markgate.yml` is a separate question, deliberately out of scope.
 *
 * The rationale does not get deleted -- it MOVES, to wherever it can be checked
 * or at least sits next to what it describes: `docs/design/<issue>-<slug>.md`
 * for a design decision (the directory already exists, every numbered file in
 * it carries that shape, and `.claude/rules/` bullets already end with
 * `Design: docs/design/<n>-<slug>.md`), or the module's or test's own doc
 * comment for a mechanism.
 *
 * ## Why the limit is 2000 and not the median
 *
 * Calibrated against a real entry rewritten to the intended shape rather than
 * against the existing distribution, because the distribution is the thing
 * being changed. The go-to-k/cdkd#2485 entry -- behavior delta, five-path file
 * list with two named live arms, the mechanism in three sentences, the
 * residual's issue number, and a rationale link -- comes to 1,388 characters
 * written out. 2000 is that with room, and it is a number a reviewer can hold
 * in their head. 72 of the 523 entries on `main` already sit under it, so the
 * shape is demonstrably writable and not a target invented here.
 *
 * There is deliberately NO per-entry escape hatch, and no allowlist of
 * exempted entries. An opt-out on a limit whose whole purpose is to redirect
 * prose becomes the default spelling within a few PRs, and the redirect target
 * already exists for any entry that genuinely needs more room.
 *
 * ## Why a date cutoff, and why it is the day AFTER this landed
 *
 * Forward-only: the entries written before this cap are already written and
 * already correct, and splitting them buys nothing. The obvious way to express
 * that is a baseline listing what is grandfathered -- and a baseline over a
 * file that gains an entry per PR is maintenance that goes stale silently. The
 * date on the `**Recently Implemented** (YYYY-MM-DD)` heading an entry sits
 * under is already in the file, already attached to every entry, and needs
 * nothing from anyone.
 *
 * The cutoff is the day AFTER this landed, and that is not a rounding choice.
 * A cutoff of the landing DAY races every other lane merging that day: measured
 * while this PR was open, two unrelated PRs merged the same afternoon and added
 * 3,001- and 1,854-character entries under the same heading. A same-day cutoff
 * would have gone red on main for entries written before the rule existed, or
 * forced a grandfathering list that grows by whoever merges next -- an opt-out
 * reachable by being late. One day later, the partition is decided by the
 * calendar rather than by merge order.
 *
 * The price is that on the day this lands the cap selects NOTHING from the real
 * file, so the verdict over `docs/changelog-cdkd.md` is vacuously green until
 * the first entry is written under a later heading. That is paid for
 * explicitly: `selects over-limit entries and only those` runs the SAME parser
 * and the SAME predicate over a synthetic document, so the selection logic is
 * proven live on the day it ships rather than the day it first bites.
 *
 * ## Known limits, recorded rather than papered over
 *
 * An entry MISDATED under a pre-cutoff heading escapes the cap. Nothing here
 * can see that: a checker cannot distinguish an entry filed under an old date
 * from a genuinely old one, and the file's headings are not globally ordered
 * anyway -- 2026-08-24 is followed by 2026-08-25, and three dates repeat -- so a
 * monotonicity assertion would fail on the real file rather than catch the
 * evasion. What IS asserted is the one direction with a structural answer: the
 * FIRST heading carries the maximum date, so an older heading cannot be
 * inserted above the newest one to shelter a new entry beneath it.
 *
 * Aggregate prose parked in heading QUALIFIERS is another. Each heading may
 * carry 30 characters after its date, and `gives every section at least one
 * entry` only forces a token bullet beneath each one -- three characters per
 * thirty. Measured by the round-5 review: 160 stuffed headings carry 4,800
 * characters past every verdict. It is fenced by nothing here because the shape
 * is grotesque on sight -- 160 date sections nobody wrote entries for -- and any
 * bound tight enough to catch it would fire on a legitimate run of small
 * sections.
 *
 * The prose ABOVE the first heading -- this file's own header, 3,432 characters
 * today -- is outside the conservation scan by construction: it is not an entry
 * and has no date, so the cap has nothing to say about it. It is reviewed like
 * any other document.
 *
 * Writing one change as TWO bullets is the same class and is deliberately not
 * fenced either. At column 0 a second `- ` is a second list item under any
 * definition Markdown or a checker has; "one logical entry" exists only in the
 * author's head, and every date section already carries several bullets. Both
 * evasions cost the author more than writing the entry properly, which is the
 * bar a cap like this can actually hold.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CHANGELOG = join(REPO_ROOT, 'docs', 'changelog-cdkd.md');

/** Maximum characters in ONE entry, including its continuation lines. */
const LIMIT = 2000;

/**
 * Entries under a heading dated on or after this are capped. See the header for
 * why it is the day after this landed and not the landing day itself.
 */
const CUTOFF = '2026-09-05';

/**
 * The files that STATE the limit in prose. The number is restated in each, and
 * nothing but this list makes them agree -- the drift shape
 * `cross-cutting-list-sync.test.ts` exists for, one file over.
 */
const PROSE_COPIES = [
  { path: 'CLAUDE.md', headerOnly: false },
  // Searched only ABOVE the first entry. The file is append-only and this
  // change's own entry quotes the phrase, so a whole-file `includes` would stay
  // green forever no matter what the CONTRACT section said.
  { path: join('docs', 'changelog-cdkd.md'), headerOnly: true },
  { path: join('.claude', 'skills', 'check-docs', 'SKILL.md'), headerOnly: false },
] as const;

/** A top-level changelog entry opens with a list bullet at column 0. */
const BULLET = '- ';

/**
 * The date on a section heading. The optional `, <qualifier>` group accepts the
 * one variant spelling in the file -- `**Recently Implemented** (2026-07-02, second
 * batch):` -- which a `\)`-anchored form silently swallowed as a continuation
 * line, leaving the entries under it attributed to the PREVIOUS heading's date.
 * Harmless there (pre-cutoff, and the misattribution ran toward a NEWER date,
 * so those entries would have been capped rather than exempted), but it made
 * the "every entry has a date" claim broader than the regex. `HEADING_PREFIX`
 * fences the two against each other so a third spelling fails loudly.
 *
 * BOUNDED AT BOTH ENDS, and both bounds are load-bearing rather than tidy.
 * This one regex has now leaked prose twice, each time in a place the previous
 * fix did not reach, and each hole was found by the review round of the fix
 * before it:
 *
 * - Unanchored at the END, `**Recently Implemented** (2026-09-04): <4,000
 *   characters of prose>` was excluded from the conservation verdict AND fed to
 *   the date parser as a heading, so the prose was measured by nothing.
 * - Anchored at the end but with an unbounded `[^)]*` INTERIOR,
 *   `**Recently Implemented** (2026-09-06 NOTE: <4,000 characters with no
 *   closing paren>):` did exactly the same thing -- and `HEADING_PREFIX` cannot
 *   catch it, because the line IS a `HEADING` match.
 *
 * So the interior accepts only what the file actually contains: an optional
 * short `, <qualifier>` after the date. Verified against all 49 headings -- it
 * matches every one and rejects both evasions. The lesson is the one the
 * conservation verdict was written for: a pattern that decides what to SKIP has
 * to be exact, because everything it skips is measured by nothing.
 */
const HEADING = /^\*\*Recently Implemented\*\* \((\d{4}-\d{2}-\d{2})(?:, [^)]{1,30})?\):\s*$/;

/**
 * Anything that OPENS like a heading, used only to check that `HEADING`
 * understands all of them. Deliberately loose: a line this matches and
 * `HEADING` does not is either a new date spelling or prose hiding behind a
 * heading prefix, and both must fail loudly rather than be skipped.
 */
const HEADING_PREFIX = /^\*\*Recently Implemented\*\*/;

/**
 * The longest line the conservation verdict is allowed to SKIP.
 *
 * What actually closes the class is `HEADING`'s bounded interior and end
 * anchor plus `RULE`'s whole-line form: between them a skipped line can carry
 * at most a 30-character qualifier, and a rule carries nothing at all. Three
 * review rounds each found the same bug one spelling over -- `--- <prose>`,
 * then `**Recently Implemented** (date): <prose>`, then
 * `**Recently Implemented** (date NOTE: <prose>):` -- and each fix tightened
 * the pattern that decides what to skip.
 *
 * This bound is the backstop for the FOURTH spelling: it applies to whatever
 * `isSkipped` grows into, so a future skip predicate widened without thought is
 * still capped. It is deliberately NOT the primary defence, and against today's
 * patterns it is close to unfalsifiable -- a `HEADING` maxes out near 70
 * characters. An earlier revision of this comment claimed it closed the class
 * on its own, which review disproved by parking 4,800 characters of prose in
 * the 30-character qualifiers of 160 heading lines, every one under the bound.
 * That channel is only made more expensive -- not closed -- by
 * `gives every section at least one entry` below; see "Known limits".
 */
const MAX_SKIPPED_LINE = 200;

/**
 * A horizontal rule, WHOLE-LINE. `startsWith('---')` excluded `--- <4,000
 * characters>` from the conservation verdict -- the sibling of the heading hole
 * above, from the same review. All nine rules in the file are bare.
 */
const RULE = /^-{3,}\s*$/;

/**
 * The ONE definition of what the conservation verdict skips. Both the orphan
 * scan and the length bound read it, so a third pattern added here is bounded
 * automatically -- the hand-copied pair these two filters used to carry is the
 * drift shape `cross-cutting-list-sync.test.ts` exists for.
 */
function isSkipped(line: string): boolean {
  return HEADING.test(line) || RULE.test(line);
}

interface Entry {
  readonly line: number;
  readonly date: string | null;
  readonly text: string;
}

interface Parsed {
  readonly entries: Entry[];
  /** 1-based line numbers that ended up inside SOME entry's measured text. */
  readonly consumed: ReadonlySet<number>;
}

/**
 * Splits the document into ENTRIES rather than lines. An entry is a column-0
 * bullet plus every line under it until the next column-0 bullet, the next date
 * heading, or a `---` rule -- which is what makes the limit un-gameable by
 * line-wrapping: 34 entries in the file already carry indented continuation
 * lines or nested sub-bullets, and the most-wrapped one spans 165 lines.
 * Measuring the LINE would price those at a fraction of what they are.
 *
 * Blank lines are skipped rather than appended, so whitespace between an entry
 * and the next heading does not count against it.
 */
function parseEntries(text: string): Parsed {
  const lines = text.split('\n');
  const entries: Entry[] = [];
  const consumed = new Set<number>();
  let current: { line: number; date: string | null; parts: string[] } | null = null;
  let date: string | null = null;
  const flush = () => {
    if (current) entries.push({ line: current.line, date: current.date, text: current.parts.join('\n') });
    current = null;
  };
  for (const [i, raw] of lines.entries()) {
    const heading = HEADING.exec(raw);
    if (heading) {
      flush();
      date = heading[1]!;
      continue;
    }
    if (raw.startsWith(BULLET)) {
      flush();
      current = { line: i + 1, date, parts: [raw] };
      consumed.add(i + 1);
      continue;
    }
    if (!current) continue;
    if (RULE.test(raw)) {
      flush();
      continue;
    }
    if (raw.trim() === '') continue;
    current.parts.push(raw);
    consumed.add(i + 1);
  }
  flush();
  return { entries, consumed };
}

/**
 * THE predicate. Both the real-file verdict and the synthetic one call this, so
 * the synthetic case proves the path that actually runs -- a mirrored copy
 * would only prove itself.
 */
function overLimit(parsed: Parsed): Entry[] {
  return parsed.entries.filter((e) => e.date !== null && e.date >= CUTOFF).filter((e) => e.text.length > LIMIT);
}

const CAP_ADVICE =
  `A docs/changelog-cdkd.md entry exceeds ${LIMIT} characters (line numbers are in that file). ` +
  'The entry keeps the user-visible behavior delta, the changed files, the issue / PR numbers, and the ' +
  "residual's issue number. Everything else moves: a design decision to docs/design/<issue>-<slug>.md, a " +
  'mechanism to the doc comment on the module or test that implements it, and the entry links to it. ' +
  'This is not a formatting nit -- prose in this file asserts implementation detail that no fence can ' +
  'verify, and it drifts (go-to-k/cdkd#2549). There is no per-entry opt-out on purpose.';

describe('changelog entry size', () => {
  const source = readFileSync(CHANGELOG, 'utf-8');
  const lines = source.split('\n');
  const parsed = parseEntries(source);
  const entries = parsed.entries;

  it('attributes every entry to a dated heading', () => {
    // The cutoff can only partition the population if every entry HAS a date.
    // An entry parsed before the first heading would fall out of the capped set
    // with nothing recording that it is exempt.
    //
    // Measured 2026-09-04: 524 entries on this branch. The floor sits just under
    // it rather than at a round number well below, for the reason the sibling
    // fence gives: slack is room a population can shrink into unnoticed. It is
    // not EXACT because go-to-k/cdkd#1837's outstanding duplicate-cluster merge
    // legitimately deletes entries.
    expect(entries.length).toBeGreaterThanOrEqual(520);
    const undated = entries.filter((e) => e.date === null).map((e) => `L${e.line}`);
    expect(undated, 'an entry sits above the first dated heading and is exempt by accident').toEqual([]);

    // Recount independently of the parser. Deleting the final `flush()` drops
    // the LAST entry in the file, which the floor above cannot see and no other
    // verdict here reads.
    const bulletLines = lines.filter((l) => l.startsWith(BULLET)).length;
    expect(entries.length, 'parseEntries lost or fused a bullet').toBe(bulletLines);

    // Every heading must be UNDERSTOOD, not merely most of them. A spelling
    // HEADING does not match is swallowed as a continuation line, and the
    // entries beneath it inherit a neighbouring date -- silently.
    const headingLines = lines.filter((l) => HEADING_PREFIX.test(l));
    const unparsed = headingLines.filter((l) => !HEADING.test(l));
    expect(
      unparsed,
      'a line opens like a section heading but HEADING does not match it -- a new date spelling, or prose ' +
        'hiding behind a heading prefix'
    ).toEqual([]);

    // The newest section is at the TOP. The one half of the misdating hazard a
    // checker can answer (see the header's "Known limits"): without it, an older
    // heading inserted ABOVE the newest one shelters a new over-limit entry with
    // everything else green. A global monotonicity assertion is NOT available --
    // 2026-08-24 is followed by 2026-08-25, and three dates repeat.
    const dates = headingLines.map((l) => HEADING.exec(l)![1]!);
    const newest = [...dates].sort().at(-1)!;
    expect(dates[0], 'the first section is not the newest; an older heading was inserted above it').toBe(newest);
  });

  it('keeps the multi-line parse load-bearing', () => {
    // Without this, `parseEntries` could be narrowed back to one-line-per-entry
    // and every other verdict here would stay green -- the cap would then be
    // gameable by pressing return, the specific hole go-to-k/cdkd#2552 asked
    // the fence to close.
    //
    // Asserted by requiring real entries to span multiple lines, rather than by
    // a proxy for what a wrapped entry looks like. Measured 2026-09-04: 34 wrap,
    // the most-wrapped across 165 lines. (That is NOT the longest entry: the
    // 19,548-character one is a single line. Conflating the two extremes is the
    // exact drift this file exists to bound, and an earlier revision of this
    // comment did it.)
    const wrapped = entries.filter((e) => e.text.includes('\n'));
    expect(
      wrapped.length,
      'no entry spans multiple lines any more, so a one-line-per-entry parser would be indistinguishable here'
    ).toBeGreaterThanOrEqual(30);

    // Fences the `---` flush arm. Vacuous on the DATA -- no entry carries such a
    // line today -- and non-vacuous on the SOURCE: deleting that arm makes
    // entries absorb the horizontal rule below them, so the size they report
    // stops being their own. Stated plainly, the way the sibling fence states
    // its own source-only verdict, rather than dressed up as a data check.
    // Uses the SAME whole-line RULE the parser terminates on. A prefix test
    // here would flag a legitimate continuation line beginning `--- ` -- which
    // the parser correctly keeps inside the entry -- and fail with the wrong
    // diagnosis.
    const swallowedRules = entries
      .filter((e) => e.text.split('\n').some((l) => RULE.test(l)))
      .map((e) => `L${e.line}`);
    expect(swallowedRules, 'an entry absorbed a horizontal rule; the --- flush arm is gone').toEqual([]);
  });

  it('measures every line of every entry', () => {
    // THE hole this verdict exists for: `---` ENDS an entry, so a bullet
    // followed by a rule and then 4,000 characters of prose measures as the
    // bullet alone. Measured on a copy before this verdict existed: 48
    // characters reported, zero offenders. That is a one-line opt-out on a cap
    // whose whole design says there is none, and it is reachable BY ACCIDENT --
    // `---` under a paragraph is ordinary Markdown, and six legitimate batch
    // separators already sit in the file.
    //
    // The `swallowedRules` verdict above does NOT catch it: with the flush arm
    // present the entry's text never contains the rule, so that assertion is
    // green on exactly the shape that evades the cap. It fences the ARM; this
    // fences the DATA.
    //
    // Stated as conservation rather than as a list of bad shapes, because
    // enumerating them is how the next spelling gets missed (a fenced code block
    // would be the second -- none exist in the file today).
    const firstHeading = lines.findIndex((l) => HEADING_PREFIX.test(l));
    expect(firstHeading, 'no section heading at all -- the whole file parsed as preamble').toBeGreaterThan(-1);
    const orphans = lines
      .map((l, i) => ({ l, n: i + 1 }))
      // `firstHeading` is 0-based and `n` is 1-based, so `n > firstHeading`
      // starts AT the heading line, which the `isSkipped` filter then drops.
      // The boundary is load-bearing for the length bound rather than for the
      // orphan scan: `n > firstHeading + 1` would exempt the first heading from
      // `bulky` while leaving `orphans` unchanged.
      .filter(({ n }) => n > firstHeading)
      .filter(({ l }) => l.trim() !== '')
      .filter(({ l }) => !isSkipped(l))
      .filter(({ n }) => !parsed.consumed.has(n))
      .map(({ l, n }) => `L${n}: ${l.slice(0, 80)}`);
    // Nothing SKIPPED may be long. Without this the verdict is only as good as
    // the two patterns above, and those have admitted prose three times.
    const bulky = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ n }) => n > firstHeading)
      .filter(({ l }) => isSkipped(l))
      .filter(({ l }) => l.length > MAX_SKIPPED_LINE)
      .map(({ l, n }) => `L${n}: ${l.length} chars: ${l.slice(0, 80)}...`);
    expect(
      bulky,
      `A line this verdict SKIPS is longer than ${MAX_SKIPPED_LINE} characters. A heading or a rule is ` +
        'short by nature (the longest in this file is 52), so a long one is prose wearing a heading or ' +
        'rule as a costume -- the shape three review rounds each found one spelling of. Either the line ' +
        'is really an entry, in which case make it one, or a skip pattern has grown too permissive.'
    ).toEqual([]);

    expect(
      orphans,
      'These lines sit below a section heading but belong to no entry, so their length is counted ' +
        'against nothing. The usual cause is a `---` in the middle of an entry, which ENDS it -- move ' +
        'the text above the rule or drop the rule. A cap that stops counting partway through an entry ' +
        'is not a cap.'
    ).toEqual([]);
  });

  it('gives every section at least one entry', () => {
    // RAISES THE COST of the aggregate channel; it does not close it. Review
    // parked 4,800 characters in the 30-character qualifiers of 160 heading
    // lines with every verdict green, and adding a three-character token bullet
    // under each one -- all this verdict forces -- leaves that intact.
    // Kept because a heading that introduces nothing is a real defect in its own
    // right, and because the residual is now recorded in "Known limits" rather
    // than mistaken for a closure. Measured 2026-09-04: 49 sections, each
    // carrying between 1 and 51 entries.
    const sections: { line: number; count: number }[] = [];
    for (const [i, l] of lines.entries()) {
      if (HEADING.test(l)) sections.push({ line: i + 1, count: 0 });
      else if (l.startsWith(BULLET) && sections.length > 0) sections[sections.length - 1]!.count++;
    }
    const empty = sections.filter((s) => s.count === 0).map((s) => `L${s.line}`);
    expect(empty, 'a section heading introduces no entry -- prose parked in heading qualifiers looks like this').toEqual(
      []
    );
    expect(sections.length, 'no sections parsed at all').toBeGreaterThanOrEqual(45);
  });

  it('pins the limit, and keeps the prose copies agreeing with it', () => {
    // Nothing else bounds LIMIT from both sides: the verdict over the real file
    // is empty today, so LIMIT could be set to anything at all with every other
    // assertion green. Pinned outright.
    expect(LIMIT).toBe(2000);
    // Pinned for the same reason: no verdict here bounds it from above, so it
    // could be raised to anything with the file green.
    expect(MAX_SKIPPED_LINE).toBe(200);
    // And the number is RESTATED in prose three times. Nothing but this makes
    // them agree; it is the drift shape cross-cutting-list-sync.test.ts exists
    // for, one file over.
    const missing = PROSE_COPIES.filter(({ path, headerOnly }) => {
      const full = existsSync(join(REPO_ROOT, path)) ? readFileSync(join(REPO_ROOT, path), 'utf-8') : '';
      const cut = full.split('\n').findIndex((l) => HEADING_PREFIX.test(l));
      const haystack = headerOnly && cut > -1 ? full.split('\n').slice(0, cut).join('\n') : full;
      return !haystack.includes(`${LIMIT} characters`);
    }).map(({ path }) => path);
    expect(
      missing,
      `these files no longer state "${LIMIT} characters" where the contract lives; the cap and its ` +
        'documentation disagree (a missing file reports here too, rather than throwing)'
    ).toEqual([]);
  });

  it('selects over-limit entries and only those', () => {
    // The liveness proof, and the ONLY verdict here that is non-vacuous on the
    // day this lands: the real file has no post-cutoff entry yet, so the verdict
    // below it selects an empty set and would stay green with the predicate
    // deleted. This runs the SAME `parseEntries` and the SAME `overLimit` over a
    // document built for the purpose. A mirrored predicate would only prove
    // itself, which is why `overLimit` is extracted rather than inlined twice.
    const long = 'x'.repeat(LIMIT + 1);
    const wrappedLong = ['- **Wrapped**', ...Array.from({ length: 40 }, () => `  ${'y'.repeat(60)}`)].join('\n');
    // Exactly at the limit, so `> LIMIT` cannot be loosened to `>=`.
    const exactly = `- ${'e'.repeat(LIMIT - 2)}`;
    const doc = [
      '**Recently Implemented** (2026-09-06):',
      `- **After the cutoff** ${long}`,
      '',
      // ON the cutoff, not merely after it. With only later dates here,
      // `>= CUTOFF` could be narrowed to `> CUTOFF` -- exempting 2026-09-05,
      // the first day the cap binds and the exact date CLAUDE.md and the
      // changelog header promise. With only THIS date, it could be narrowed to
      // `=== CUTOFF`, which exempts every real future entry and makes the cap
      // permanently inert. Both dates are present so neither mutation lives.
      '**Recently Implemented** (2026-09-05):',
      `- **On the cutoff** ${long}`,
      '- **Under the limit** short enough.',
      exactly,
      wrappedLong,
      '',
      '**Recently Implemented** (2026-09-04):',
      `- **Pre-cutoff, over the limit** ${long}`,
      '',
      // Fences the HEADING arm's `flush()`, which nothing on the real file can
      // reach: every heading there is preceded by a blank line and followed by a
      // bullet, so deleting the arm reparses the file byte-identically. Here the
      // short post-cutoff entry is followed by a HEADING and then by prose that
      // is not a bullet. With the arm present the entry ends at the heading and
      // the prose belongs to no entry, so nothing is flagged; delete the arm and
      // the entry absorbs the prose, crosses the limit, and shows up below.
      '**Recently Implemented** (2026-09-06):',
      '- **Stops at the next heading** short.',
      '',
      '**Recently Implemented** (2026-09-04):',
      long,
      '- **Trailing bullet** ends it.',
      '',
      // Exactly one over, so `> LIMIT` cannot be shifted to `> LIMIT + 1`.
      '**Recently Implemented** (2026-09-06):',
      `- **Just over** ${'j'.repeat(LIMIT + 1 - '- **Just over** '.length)}`,
      '',
    ].join('\n');
    // Labelled by the bolded headline, so a wrapped entry reads as one name and
    // the expectation does not depend on a character offset.
    const flagged = overLimit(parseEntries(doc)).map((e) => /\*\*(.+?)\*\*/.exec(e.text)?.[1] ?? e.text.slice(0, 20));

    // Selected: the entries over the limit on BOTH sides of the cutoff date,
    // and the entry that only exceeds it once its continuation lines are counted
    // -- the line-wrapping evasion. NOT selected: the short one, the one sitting
    // exactly ON the limit, nor the pre-cutoff one however long, which is what
    // "forward-only" has to mean.
    expect(flagged).toEqual(['After the cutoff', 'On the cutoff', 'Wrapped', 'Just over']);
  });

  it('caps entries dated on or after the cutoff', () => {
    const offenders = overLimit(parsed).map(
      (e) => `L${e.line}: ${e.text.length} chars (limit ${LIMIT}): ${e.text.slice(2, 90)}...`
    );
    expect(offenders, CAP_ADVICE).toEqual([]);
  });

  it('holds the entry this change added to its own rule', () => {
    // The cap's first example, pinned. Not an exemption list in reverse: it is
    // the one entry whose compliance this change is answerable for, and without
    // it nothing on the real file exercises the limit until the next PR writes
    // an entry.
    // Keyed on the issue anchor as well as the phrase: a LATER entry restating
    // the rule (raising the cap, a go-to-k/cdkd#2552 residual) would otherwise
    // make this two and fail saying the entry is "gone", the opposite
    // diagnosis. Every match is held to the limit, so a second one is checked
    // rather than mistaken for an error.
    const own = entries.filter(
      (e) => e.text.includes(`entries are capped at ${LIMIT} characters`) && e.text.includes('issues/2552')
    );
    expect(own.length, 'the entry this change added is gone or was reworded past recognition').toBeGreaterThanOrEqual(
      1
    );
    const over = own.filter((e) => e.text.length > LIMIT).map((e) => `L${e.line}: ${e.text.length} chars`);
    expect(over, 'the entry announcing the cap must itself meet it').toEqual([]);
  });
});
