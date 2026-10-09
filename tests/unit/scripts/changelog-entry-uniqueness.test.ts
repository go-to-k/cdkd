import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOSE_HEADING, assembleChangelog } from '../../../scripts/assemble-changelog.js';
import { describe, expect, it } from 'vite-plus/test';

/**
 * `docs/changelog-cdkd.md` is a conflict magnet by construction: every lane
 * prepends its entry to the SAME list, so the file conflicts on essentially
 * every rebase whenever more than one lane is open. The natural resolution --
 * "keep both sides" -- is right for two DIFFERENT lanes' entries and wrong for
 * two copies of the SAME lane's entry, which is exactly what a multi-commit
 * branch produces after a rebase replays each commit's version of the line.
 * The superseded text then ships next to its own rewrite, and both sides look
 * like an entry that belongs.
 *
 * That is not a hypothesis. Issue go-to-k/cdkd#1837 filed the shape in August
 * 2026 (two byte-identical adjacent copies of the go-to-k/cdkd#1745 entry) and
 * asked for exactly this check as its durable half. Issue go-to-k/cdkd#1937
 * filed the SAME cluster again -- by then no longer byte-identical, because one
 * copy had been rewritten in place, which is why a `uniq`-style check on whole
 * lines would not have caught it. Measured on `origin/main` at 2026-09-02,
 * before the lane that added this file: EIGHT duplicate clusters, nineteen
 * lines, eleven of them redundant. Between them the two issues named one of the
 * eight.
 *
 * ## Why there are TWO key kinds and not one
 *
 * The two failure modes need different keys, and picking either one alone
 * leaves the other unfenced. This file's first revision keyed on a bolded
 * headline behind a hardcoded check marker, and a test review caught it WITH a
 * live instance on the branch: a `cdkd local invoke-agentcore` entry appeared
 * twice, byte-identical at 4233 bytes, and sailed through. 25 of the file's 509
 * top-level bullets were invisible to that regex -- 17 that carry no bolded
 * headline at all, 6 that open one behind a DIFFERENT marker, and 2 whose bold
 * wraps to the next line -- and the duplicate lived in the first group, where a
 * headline key does not exist. The `uniq`-style check the paragraph above
 * rejects WOULD have caught that one.
 *
 * So every top-level bullet is keyed: by its bolded headline when it has one,
 * by its whole text when it does not. Both kinds are load-bearing, and the
 * KIND-DISTRIBUTION bounds below are what keep them so. They are BOUNDS rather
 * than floors because the realistic regression is small: re-narrowing the
 * marker to the one spelling the first revision hardcoded moves just SIX
 * entries from `headline` to `whole-text` (measured 2026-09-08: 551 -> 545,
 * 20 -> 26), so a floor with any slack passes it -- and the CURRENT floor of
 * 545 lands exactly on it, so it passes by equality rather than by slack. The
 * `whole-text` UPPER bound is what actually catches it, which is why that bound
 * is re-derived whenever these floors are. A count of bullets cannot see it at
 * all: the population and the keyer share one predicate, so they move together.
 *
 * ## Known limits, recorded rather than papered over
 *
 * A duplicate whose surviving copy was reworded inside the KEY escapes. For a
 * headline-keyed entry that means a reworded headline, which is a different
 * entry under any definition a checker can apply. For the 20 whole-text-keyed
 * entries it means ANY rewording at all -- the same "rewritten in place" shape
 * this file cites as the reason a `uniq` check is insufficient, still open one
 * kind over. There is no live instance of either today.
 *
 * A second entry legitimately sharing a headline is a false positive with only
 * one escape hatch, `MERGE_PENDING`, which is documented below as meaning
 * something else. The formulaic `BREAKING (<command>):` headlines are the
 * likeliest source. Nothing has hit it yet; if something does, the row needs a
 * reason of its own rather than being filed under a merge that is not pending.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
/** Assembled in memory -- see assemble-changelog.ts (issue go-to-k/cdkd#2779). */
const assembled = () => assembleChangelog(REPO_ROOT);

/** A top-level changelog entry: a list bullet at column 0. */
const BULLET = '- ';

/**
 * Strips an optional leading status marker. Matched as a run of NON-ASCII
 * characters rather than by listing the markers actually in use: the first
 * revision listed one of them, and the six entries carrying a different one
 * fell out of the fence entirely. A new marker must not silently open a second
 * key space for the same entry.
 */
const MARKER = /^- (?:[^\x00-\x7F]+\s+)?/;

/**
 * Blanks out backtick code spans, preserving LENGTH so an offset computed on
 * the masked string indexes the original. Without this, an entry whose code
 * span contains the bold delimiter has its headline truncated there, which
 * shortens the key and invites false-positive clustering. One live instance:
 * the `src/provisioning/**` glob, whose trailing `**` closes the headline four
 * words early.
 */
function maskCodeSpans(text: string): string {
  return text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

interface Entry {
  readonly line: number;
  readonly kind: 'headline' | 'whole-text';
  readonly key: string;
}

function keyOf(line: number, text: string): Entry | null {
  if (!text.startsWith(BULLET)) return null;
  const rest = text.slice(MARKER.exec(text)![0].length);
  const masked = maskCodeSpans(rest);
  if (masked.startsWith('**')) {
    const end = masked.indexOf('**', 2);
    if (end !== -1) return { line, kind: 'headline', key: rest.slice(2, end) };
  }
  return { line, kind: 'whole-text', key: rest };
}

/**
 * Clusters left for a separate lane because their copies CONTRADICT each other
 * AND each carries detail the other drops, so no deletion is correct: a merge
 * has to keep one copy's facts while discarding its stale claim.
 *
 * EMPTY, and the way the last row emptied is the reason to distrust the next
 * one. "No copy is a superset" is NOT the bar, and all THREE rows that have
 * ever sat here sat on that weaker one. The `cdkd export` trio and the
 * `docker-image-asset` pair were three- and two-step REWRITE CHAINS: their
 * apparent divergence was a superseded `Tests: N new cases` count, a file list
 * the survivor extends, and a claim the survivor RETRACTS (sweeping the pushed
 * image "by digest", which the rewrite changes to "by tag"). A word-set
 * comparison reported all of it as divergence and nobody read the words back.
 *
 * The go-to-k/cdkd#1933 dynamic-reference-cache pair was the third, and its
 * row was the one that had survived review as a GENUINE merge. Its stated
 * rationale -- that the stale copy was "the only one carrying the
 * `--stack-concurrency` race and the `cdkd scrub` detail" -- was wrong twice
 * over. Both copies carried the live-coverage sentence the row said only one
 * had; and the race and the scrub detail were not unique to the stale copy at
 * all, they sat in the very next entry -- go-to-k/cdkd#1957's, one line below
 * it on `origin/main` -- at greater depth, which is precisely where the
 * survivor's "(see the entry above it)" points. What looked like a
 * contradiction needing a merge was a retraction plus a pointer:
 * go-to-k/cdkd#1957 IS closed, so the survivor's claim was the true one and the
 * stale copy asserted nothing the document had lost.
 *
 * So before adding a row here, read the diverging text AND the entries around
 * it: the question is whether the older copy asserts something the DOCUMENT
 * does not, not whether a set difference against its twin is non-empty.
 *
 * The COUNT is part of each row on purpose. An allowlist that only says "this
 * one is known" goes stale silently. Asserting the exact count breaks the test
 * in BOTH directions: a merged copy and an added copy each fail it. While the
 * map is empty the honest-allowlist verdict below is vacuous on DATA and
 * fences only a future row, the same standing this file gives its blindness
 * verdict.
 */
const MERGE_PENDING: ReadonlyMap<string, number> = new Map<string, number>([]);

/**
 * A dated SECTION HEADER is the same conflict site one structural level up, and
 * every verdict above is blind to it: they key `- ` bullets, and a header is not
 * one. Measured on `origin/main` at 2026-09-08, while closing the last entry
 * cluster above: `**Recently Implemented** (2026-08-18):` and `(2026-08-25):`
 * each appeared TWICE among 52 headers, and the 08-25 pair had an 08-24 section
 * wedged between its two halves, so the document's dates ran 25 -> 24 -> 25 ->
 * 23. Both are the "keep both sides" resolution this file exists for, applied to
 * the block that CARRIES the entries rather than to an entry.
 *
 * Two verdicts, because a header can be wrong in two ways that do not imply each
 * other, and each of the two live instances was caught by only one of them: the
 * 08-18 pair was adjacent and correctly ordered (a duplicate, not a misordering)
 * while the 08-25 pair was correctly spelled at each site (a misordering, not a
 * duplicate). A repeated header splits one day's entries into two places a
 * reader has to find; a date that RISES going down a newest-first file means a
 * section landed at the wrong anchor.
 *
 * The same DATE twice is LEGAL and is deliberately not what either verdict
 * keys on: `(2026-07-02, second batch):` and `(2026-07-02):` are one day
 * split on purpose, adjacent and in order. So uniqueness keys the header's
 * whole TEXT, and the ordering verdict rejects only an INCREASE, never an
 * equal date.
 *
 * `[^)]*` is what admits that suffix, and it also admits an impossible date --
 * `(2026-13-45):` matches. Deliberate non-defect: this regex's job is to FIND a
 * heading, not to validate one, and the ordering compare is lexicographic over
 * a fixed-width zero-padded field, which an impossible date does not disturb.
 */
const STRICT_HEADING = /^\*\*Recently Implemented\*\* \((\d{4}-\d{2}-\d{2})[^)]*\):$/;

/**
 * "This line was MEANT to be a heading" -- the population the strict form is
 * measured AGAINST. It must be looser on exactly the axes the strict form is
 * strict about, or the two share a blind spot and `unparsed` can only report a
 * deviation the strict regex was going to catch anyway. Review measured three
 * live escapes from a bare `startsWith('**Recently Implemented**')` predicate:
 * an INDENTED heading, a block-quoted one, and one differing in CASE, each
 * invisible to all four verdicts at once. A second round measured four more --
 * a heading behind a `- ` bullet, a `* ` bullet, a `### ` prefix, and one whose
 * marker carries U+00A0 -- so the leading-noise class was widened rather than
 * patched one spelling at a time. `[>#*-]` is free: with it and without it the
 * loose predicate returns the same 51 lines on this tree, so it adds no false
 * positive, and the NBSP case stays open (a whitespace class cannot see it
 * without also matching inside the marker).
 *
 * THE CLASS IS OPEN, AND WIDENING IT IS CLOSED TO FURTHER ROUNDS. Three review
 * rounds each proposed the next spelling nobody had thought of -- `>`, then
 * `#*-`, then `+`, with ordered-list markers (`1. `) and a U+00A0 inside the
 * phrase still escaping. That is the unbounded-spelling shape, and every
 * widening so far yielded ZERO additional real lines: 51 loose hits before and
 * after each one. The defect this file exists for is a rebase resolving "keep
 * both" on a heading, which produces an exact copy at column 0, so the leading
 * -noise arm is speculative hardening rather than coverage of an observed
 * failure. It stops here, stated as open rather than implied closed.
 *
 * The closed-form answer, if one ever earns its place, is a block-structure
 * parse: `marked` is already a devDependency of this repo and would answer "is
 * this line a paragraph, a list item, or a heading" for every prefix at once.
 * Nothing measured justifies that today -- it would be a parser for a defect
 * class with no live instance.
 *
 * `-` in that class is the one with a real cost, and it is taken deliberately:
 * every entry AROUND a heading opens with `- `, so an entry whose headline
 * genuinely began "Recently Implemented" would be reported as an unparsed
 * heading. None exists (measured), the failure is loud rather than silent, and
 * the remedy is a reword -- against a heading pasted into the bullet list,
 * which is the likeliest way this document acquires one.
 *
 * What keeps a QUOTED heading out is the `^` anchor, not a code-span mask. The
 * first revision ran `maskCodeSpans` here and a probe claimed to cover it; the
 * probe was vacuous and the mask was inert -- 51 loose hits with it and 51
 * without, on this tree. Where it is NOT inert it works the wrong way: blanking
 * a span to spaces can only turn a non-match into a match, so
 * `` `x` **Recently Implemented** (2026-08-18): `` matches WITH the mask and
 * not without it. A mask cannot suppress a false positive here; it can only
 * manufacture one. Measured: 51 hits, every one a real heading.
 */
// IMPORTED from the assembler rather than spelled again. The two used to be
// separate copies of one regex: the assembler REFUSES a fragment this matches,
// and this fence reports one it matches as an unparsed heading, so widening
// only this copy re-opens exactly the case the refusal closes -- the fence reds
// over the assembled document while the fragment anyone could fix goes
// unnamed. One constant, so they cannot disagree.

function looksLikeHeading(text: string): boolean {
  return LOOSE_HEADING.test(text.trimStart().toLowerCase());
}

interface Heading {
  readonly line: number;
  readonly date: string;
  readonly text: string;
}

interface HeadingFindings {
  readonly headings: readonly Heading[];
  /** Lines that LOOK like a heading but did not become one. */
  readonly unparsed: readonly string[];
  readonly repeated: readonly string[];
  readonly rising: readonly string[];
  /**
   * How many lines this call was GIVEN -- not how many it read, which a
   * narrowed collect loop would change while this stayed put. Every other
   * field is relative to the array handed in, so only this one can tell a
   * caller it received less than the whole document, and asserting on the
   * CALLER's own `lines.length` cannot: review measured
   * `analyzeHeadings(lines.slice(0, 1336))`, where the caller's array is still
   * 1521 lines and a floor on it is inert. The collect loop has its own
   * fence -- `unparsed`, via the complement below.
   */
  readonly linesGiven: number;
  /**
   * The line-number key set behind `unparsed`. Returned ONLY so a caller can
   * assert it is keyed by LINE: swapping it to the heading TEXT restores the
   * strict re-derivation this file replaced, and passes every probe and every
   * real-file verdict, so no fixed corpus can express the difference.
   */
  readonly claimed: ReadonlySet<number | string>;
}

/**
 * Pure over the line array, so the verdicts below run against the real
 * changelog AND against the fixed corpora in `HEADING_PROBES`. Splitting it out
 * is what lets the ACCEPT arms be probed at all: against the real file all
 * three of them are exercised by ONE line -- `(2026-07-02, second batch):`, the
 * only repeated date and the only suffixed heading in the document -- so
 * rewording or merging that pair would retire three arms at once with every
 * verdict still green. That is the same single-instance fragility this file
 * rejects an entry-side proxy for above, and it was caught by review rather
 * than by anything here.
 */
function analyzeHeadings(lines: readonly string[]): HeadingFindings {
  const headings: Heading[] = [];
  for (const [i, text] of lines.entries()) {
    const m = STRICT_HEADING.exec(text);
    if (m) headings.push({ line: i + 1, date: m[1]!, text });
  }

  // The COMPLEMENT of `headings` -- NOT a re-test of the strict regex against
  // the lines. Re-deriving let a narrowing of the COLLECT LOOP above go unseen:
  // review measured `lines.slice(0, 1300)` there yielding 47 headings, leaving
  // `unparsed` empty and silently no longer detecting a duplicate below the cut.
  // (47 would now also trip the floor, which was 45 when that was measured; the
  // floor is not what catches it, and `slice(0, 1336)` yields exactly 49.)
  //
  // TWO limits, both found by review AFTER this line was called verified, and
  // both now answered by a RETURNED FIELD rather than by a comment, because a
  // fixed corpus cannot express either:
  //
  //   1. It catches a narrowed collect loop, NOT a narrowed INPUT. Every other
  //      verdict is relative to the `lines` handed in, so truncating the
  //      ARGUMENT leaves them green over a shorter document -- and a floor on
  //      the CALLER's `lines.length` does not help, since that array is still
  //      whole. `linesGiven` is the only thing that can see it.
  //   2. Keying `claimed` on the heading TEXT instead of its LINE restores the
  //      strict re-derivation this replaced. Measured: the two keys give an
  //      IDENTICAL `unparsed` on every input while the collect loop is intact,
  //      because the strict verdict is a function of the text alone -- so the
  //      earlier claim here, that they differ only in the `repeated` case where
  //      both verdicts fire anyway, was wrong in both halves. They diverge only
  //      under a narrowed collect loop cutting between two duplicate texts, and
  //      there `repeated` is 0 as well. `claimed` is returned so the caller can
  //      assert the KEY TYPE, which is a property no input can reveal.
  const claimed = new Set(headings.map((h) => h.line));
  const unparsed = lines.flatMap((text, i) =>
    looksLikeHeading(text) && !claimed.has(i + 1) ? [`L${i + 1}: ${text}`] : []
  );

  const byText = new Map<string, number[]>();
  for (const h of headings) byText.set(h.text, [...(byText.get(h.text) ?? []), h.line]);
  const repeated = [...byText.entries()]
    .filter(([, ls]) => ls.length > 1)
    .map(([text, ls]) => `${ls.map((l) => `L${l}`).join(' / ')}: ${text}`);

  const rising = headings
    .slice(1)
    .flatMap((h, i) =>
      h.date > headings[i]!.date
        ? [`L${headings[i]!.line} ${headings[i]!.date} -> L${h.line} ${h.date}`]
        : []
    );

  return { headings, unparsed, repeated, rising, linesGiven: lines.length, claimed };
}

/**
 * Fixed corpora with known verdicts, analyzed independently of the tree.
 *
 * The REFUSE cases are cheap to re-run by hand against the real changelog; the
 * ACCEPT cases are not, because their fixture can disappear from it. So every
 * accept case names the degradation it kills and expects a CLEAN result -- a
 * verdict firing on one means an arm stopped accepting something the changelog
 * is allowed to do.
 */
const HEADING_PROBES: readonly {
  readonly name: string;
  readonly kills: string;
  readonly lines: readonly string[];
  readonly expect: { headings: number; unparsed: number; repeated: number; rising: number };
}[] = [
  {
    name: 'ACCEPT one day split across two differently-spelled headings',
    kills: 'keying uniqueness on the DATE instead of the whole heading text',
    lines: ['**Recently Implemented** (2026-07-02, second batch):', '**Recently Implemented** (2026-07-02):'],
    expect: { headings: 2, unparsed: 0, repeated: 0, rising: 0 },
  },
  {
    name: 'ACCEPT an equal date is not a rise, with a descending tail still ordered',
    kills: 'relaxing the ordering compare from `>` to `>=`',
    lines: [
      '**Recently Implemented** (2026-08-20, morning):',
      '**Recently Implemented** (2026-08-20):',
      '**Recently Implemented** (2026-08-19):',
    ],
    expect: { headings: 3, unparsed: 0, repeated: 0, rising: 0 },
  },
  {
    name: 'ACCEPT a suffixed heading still parses as one',
    kills: 'tightening `[^)]*` out of the strict regex',
    lines: ['**Recently Implemented** (2026-07-02, second batch):'],
    expect: { headings: 1, unparsed: 0, repeated: 0, rising: 0 },
  },
  {
    name: 'ACCEPT a heading QUOTED mid-sentence is not a heading',
    kills: 'the `^` anchor on the loose predicate -- the only thing keeping the contract prose above, and every entry that quotes a heading, out of `unparsed`',
    lines: ['See `**Recently Implemented** (2026-08-18):` above for the shape.'],
    expect: { headings: 0, unparsed: 0, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a repeated heading',
    kills: 'the uniqueness verdict entirely',
    lines: [
      '**Recently Implemented** (2026-08-18):',
      '- an entry',
      '**Recently Implemented** (2026-08-18):',
    ],
    expect: { headings: 2, unparsed: 0, repeated: 1, rising: 0 },
  },
  {
    name: 'REFUSE a rising date',
    kills: 'the ordering verdict entirely',
    lines: ['**Recently Implemented** (2026-08-24):', '**Recently Implemented** (2026-08-25):'],
    expect: { headings: 2, unparsed: 0, repeated: 0, rising: 1 },
  },
  {
    name: 'REFUSE an INDENTED heading',
    kills: 'the `trimStart()` in `looksLikeHeading` -- the anchor alone rejects an indented line either way',
    lines: ['  **Recently Implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a BLOCK-QUOTED heading',
    kills: 'the `>` character of the loose predicate\'s leading-noise class',
    lines: ['> **Recently Implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a heading pasted in as a `- ` BULLET',
    kills: 'the `-` character of the leading-noise class -- the likeliest real mistake, since every entry around a heading starts that way',
    lines: ['- **Recently Implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a heading pasted in as a `* ` BULLET',
    kills: 'the `*` character of the leading-noise class',
    lines: ['* **Recently Implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a heading pasted in as a `+ ` BULLET',
    kills: "the `+` character of the leading-noise class -- CommonMark's third bullet marker, added with `-` and `*` rather than after the next report",
    lines: ['+ **Recently Implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a heading behind an ATX `### ` prefix',
    kills: 'the `#` character of the leading-noise class',
    lines: ['### **Recently Implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a heading differing only in CASE',
    kills: 'the `toLowerCase()` in `looksLikeHeading` -- measured to red 8 of the cases here, itself included, so this one is nowhere near its sole witness',
    lines: ['**Recently implemented** (2026-08-18):'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
  {
    name: 'REFUSE a heading whose date shape is broken',
    kills: 'the strict regex, leaving the heading outside every verdict',
    lines: ['**Recently Implemented** (2026-08-18:'],
    expect: { headings: 0, unparsed: 1, repeated: 0, rising: 0 },
  },
];

describe('changelog entry uniqueness', () => {
  const lines = assembled().split('\n');
  const bullets = lines.flatMap((text, i) => (text.startsWith(BULLET) ? [{ line: i + 1, text }] : []));
  const entries = bullets.flatMap((b) => {
    const e = keyOf(b.line, b.text);
    return e ? [e] : [];
  });
  const byKey = new Map<string, Entry[]>();
  for (const e of entries) {
    const bucket = byKey.get(e.key);
    if (bucket) bucket.push(e);
    else byKey.set(e.key, [e]);
  }
  const headings = analyzeHeadings(lines);

  it('keys the whole population, by both kinds', () => {
    // Re-measured 2026-09-08: 571 bullets, 551 headline-keyed and 20 whole-text.
    // The floors sit just under those, not at a round number well below them:
    // a loose floor is slack an entry population can silently shrink into, and
    // the previous 450 against 506 left room for 56.
    //
    // Their previous values -- 500 / 485 / 12, taken at 505 / 487 / 18 on
    // 2026-09-02, i.e. about 1% of slack each -- had drifted to 12.4%, 12.0%
    // and 40% as the document grew, which is the same loose-floor state they
    // were introduced to fix. A floor here only ever needs raising: entries
    // are append-only and no pruning policy exists.
    expect(bullets.length).toBeGreaterThanOrEqual(565);
    const kinds = { headline: 0, 'whole-text': 0 };
    for (const e of entries) kinds[e.kind]++;
    // BOTH kinds must stay populated. This is the assertion that fences the
    // keyer, because it is the only one here whose value depends on the DATA:
    // deleting the bold branch takes `headline` to 0 and moves ~396 entries
    // across. NARROWING MARKER to one marker spelling is a different, much
    // smaller mutation -- 6 entries -- which lands headline at exactly this
    // floor and so passes it; the whole-text CAP below is what catches that
    // one. A bullet count sees neither, since the population and the keyer
    // share `BULLET`.
    expect(kinds.headline).toBeGreaterThanOrEqual(545);
    expect(kinds['whole-text']).toBeGreaterThanOrEqual(18);
    // The bound that does the work. Re-narrowing MARKER to one marker spelling
    // pushes the 6 entries carrying the other one out of `headline` and into
    // `whole-text`; nothing else here notices a move that small.
    //
    // 22 against a measured 20, NOT 20: the cap had come to sit EXACTLY on the
    // measurement, so the next lane to add a whole-text entry would have reded
    // CI for writing a legal entry. The regression it exists to catch lands at
    // 26, so two of slack still catches it -- a cap on a growing population has
    // to be re-derived on the same schedule as the floors beside it.
    expect(kinds['whole-text']).toBeLessThanOrEqual(22);
    // Keys must DISCRIMINATE, not merely exist. Deliberately redundant with the
    // duplicate verdict below -- it cannot fail alone -- but it fails naming the
    // KEYER rather than the data, which is the faster diagnosis of the two.
    // The subtrahend is MERGE_PENDING's total copy surplus, so it tracks that
    // map rather than being a literal: it was `- 1` while the go-to-k/cdkd#1933
    // pair was allowlisted, and a row added there must move it again or this
    // fails for a reason that has nothing to do with the keyer.
    const allowedSurplus = [...MERGE_PENDING.values()].reduce((n, copies) => n + copies - 1, 0);
    expect(
      byKey.size,
      'keys stopped discriminating, OR a MERGE_PENDING row does not describe the file -- a row whose key matches ' +
        'no bullet reaches this bare-number assertion before the allowlist verdict that would name it, so check ' +
        'MERGE_PENDING against the changelog before suspecting `keyOf`.'
    ).toBe(bullets.length - allowedSurplus);
    // Only fences a FUTURE narrowing of `keyOf`: `bullets` and `keyOf` share
    // the `BULLET` predicate today, so this is vacuous on data and non-vacuous
    // on source. Stated plainly because the previous revision claimed it made
    // blindness "structurally impossible", which it does not.
    const unkeyed = bullets.filter((b) => keyOf(b.line, b.text) === null).map((b) => `L${b.line}`);
    expect(unkeyed, 'keyOf grew a null arm; the bullets it rejects are now unfenced').toEqual([]);
  });

  it('keeps the code-span mask load-bearing', () => {
    // Deleting `maskCodeSpans` changes exactly one key today, creates no
    // cluster, and is otherwise a silent no-op -- so without this verdict the
    // helper could be removed with every other one still green.
    //
    // Asserted DIRECTLY, by re-keying without the mask and requiring the
    // results to differ, rather than through a proxy for what a truncated key
    // looks like. The obvious proxy -- an odd backtick count -- is both
    // narrower and unsound: its population is a single entry that this very PR
    // halved, so rewording the survivor would retire the verdict silently, and
    // it MISSES a truncation inside a double-backtick span (two of those exist
    // in the file), where the delimiters pair wrongly and the truncated key
    // comes out with EVEN parity.
    const unmasked = bullets.flatMap((b) => {
      const rest = b.text.slice(MARKER.exec(b.text)![0].length);
      if (rest.startsWith('**')) {
        const end = rest.indexOf('**', 2);
        if (end !== -1) return [rest.slice(2, end)];
      }
      return [rest];
    });
    const changed = entries.filter((e, i) => e.key !== unmasked[i]).map((e) => `L${e.line}`);
    expect(
      changed.length,
      'no key depends on maskCodeSpans any more, so removing it would be undetectable here'
    ).toBeGreaterThanOrEqual(1);
  });

  it('carries each entry once', () => {
    const offenders = [...byKey.entries()]
      .filter(([key, es]) => es.length > 1 && !MERGE_PENDING.has(key))
      .map(([key, es]) => `${es.map((e) => `L${e.line}`).join(' / ')} [${es[0]!.kind}]: ${key.slice(0, 100)}`);
    expect(
      offenders,
      'A rebase resolved "keep both" on an entry that a later commit had already rewritten. ' +
        'Read the diverging text before concluding there is no superset: a superseded count, a ' +
        'shorter file list, or a claim the rewrite RETRACTS all read as divergence to a word-set ' +
        'comparison, and of the three clusters that have ever looked unmergeable that way, two were plain ' +
        'rewrite chains and the third was a retraction plus a pointer to the entry beside it. ' +
        'Delete the superseded copies. Only when the copies genuinely contradict each other does a ' +
        'row belong in MERGE_PENDING, with a matching checklist row on go-to-k/cdkd#1837.'
    ).toEqual([]);
  });

  it('keeps the merge-pending allowlist honest', () => {
    const stale = [...MERGE_PENDING.entries()]
      .map(([key, expected]) => ({ key, expected, actual: byKey.get(key)?.length ?? 0 }))
      .filter((r) => r.actual !== r.expected)
      .map((r) => `expected ${r.expected} copies, found ${r.actual}: ${r.key.slice(0, 100)}`);
    expect(
      stale,
      'MERGE_PENDING no longer describes the file. If a cluster was merged, delete its row ' +
        '(and tick it off on go-to-k/cdkd#1837); if a copy was added, that is the bug this file exists to catch.'
    ).toEqual([]);
  });

  it('reads every dated section heading', () => {
    // Measured 2026-09-08 at this lane's HEAD -- 52 on `origin/main`, minus the
    // two duplicates deleted here, plus this lane's own 2026-09-08 section: 51.
    //
    // 49 is derived from what can legitimately MOVE the count, not from a
    // percentage: +1 when a batch opens a new day, -1 per duplicate-heading
    // merge (this lane did two at once, the largest drop on record), and -1 if
    // a whole day is ever deleted. There is no pruning policy, so the count
    // only grows over time. A slack of 2 is exactly that largest observed drop.
    // A percentage is the wrong comparison here anyway, on a population two
    // orders of magnitude smaller than the bullet one, where a single
    // legitimate edit is 2% by itself. (The round-2 revision of this paragraph
    // justified 49 by calling the bullet floors "1% and 0.4%" -- figures that
    // were already stale by roughly 10x when it wrote them. Re-derived below.)
    //
    // Its first revision said 50 and 45 -- a count taken before this lane added
    // its own section, and a floor argued from those percentages. Both were
    // review findings, and the count was stale by the time it shipped.
    expect(headings.headings.length).toBeGreaterThanOrEqual(49);
    // `analyzeHeadings` is relative to the array it is HANDED, so a truncated
    // argument leaves the three heading verdicts green over a shorter document
    // -- measured: `analyzeHeadings(lines.slice(0, 1336))` reports 49 headings
    // and nothing else, with 185 lines and 2 headings unread. (At a deeper cut
    // the count floor above does fire; 1336 is calibrated to clear it, which is
    // what makes it the interesting attack.)
    //
    // The floor is on `linesGiven`, NOT on the caller's `lines.length`. Round 2
    // asserted the latter and its own cited attack walked straight past it: the
    // caller's array is still 1521 lines when the ARGUMENT is the truncated
    // one. Measured inert, and left in place it invites a future reader to
    // delete the date arm below as redundant.
    expect(
      headings.linesGiven,
      'the changelog got shorter than any pruning policy allows, or analyzeHeadings was handed a slice of it'
    ).toBeGreaterThanOrEqual(1500);
    // Independent of the floor in BOTH directions, measured: dropping 30 tail
    // lines that carry no heading reds the floor and not the date; slicing to
    // 1336 and padding with 200 blank lines reds the date and not the floor.
    //
    // Bound, measured rather than assumed: the two together are defeatable by
    // SYNTHESIZING a heading -- pad the truncated slice back over the floor and
    // append a `(2026-05-31):` line, and the count, the floor, the date and
    // `claimed` all pass with two real headings unread. It takes fabricating
    // input, which no slice or filter refactor does, so it is a bound on what
    // these fences prove rather than a hole to close.
    //
    // The file is newest-first, so its LAST heading is its oldest, and the tail
    // is settled history no lane rewrites. Anything that drops the tail -- a
    // slice, a filter, a partial read -- moves this date FORWARD, so the fence
    // is a CEILING rather than an equality: pinning the exact date would also
    // red on a backfilled section legitimately dated before it, which is a
    // non-defect, and the message would then read backwards. Spelled
    // numerically because `toBeLessThanOrEqual` rejects strings outright.
    const oldest = Number((headings.headings.at(-1)?.date ?? '9999-99-99').replaceAll('-', ''));
    expect(
      oldest,
      'the oldest section heading moved FORWARD, so the tail of the document was not read'
    ).toBeLessThanOrEqual(20_260_531);
    // Keyed by LINE, and nothing about the data can show that -- see limit 2 on
    // `analyzeHeadings`. A text-keyed `claimed` is the strict re-derivation this
    // file replaced and is green on every input and every probe.
    expect(
      [...headings.claimed].map((k) => typeof k),
      '`claimed` is no longer keyed by line number, which silently restores the strict re-derivation'
    ).toEqual(headings.headings.map(() => 'number'));
    // A line that LOOKS like a heading but did not become one is a heading
    // outside every verdict below. That is the shape that let 25 of 509 bullets
    // escape the first revision of the entry keyer, one level up. The FLOOR is
    // not redundant with this: a wholesale rename of the marker takes both the
    // strict and the loose predicate to zero, leaving this empty and the
    // uniqueness and ordering verdicts vacuously green -- probed, and the only
    // collapse the floor catches alone.
    expect(
      headings.unparsed,
      'a line that reads as a section heading but does not parse as one is fenced by no verdict here'
    ).toEqual([]);
  });

  it('carries each dated section heading once', () => {
    expect(
      headings.repeated,
      'A rebase resolved "keep both" on a SECTION HEADING, so one day\'s entries are split across two places a ' +
        'reader has to find. Merge the sections and delete the second heading. A split that is DELIBERATE is fine ' +
        'and needs no exemption -- distinguish it in the heading text the way "(2026-07-02, second batch)" does, ' +
        'which this verdict accepts because it keys the whole text rather than the date.'
    ).toEqual([]);
  });

  it('keeps the section dates non-rising', () => {
    expect(
      headings.rising,
      'The changelog is newest-first, so a date that RISES going down the file means a section landed at the ' +
        'wrong anchor -- on the live instance this fenced, the other half of a duplicated 2026-08-25 heading sat ' +
        'below a 2026-08-24 section. MOVE the misplaced entries under the section that already carries their ' +
        'date; do not re-date them, and do not reorder a section to make the dates fit.'
    ).toEqual([]);
  });

  it('probes its own heading verdicts against fixed corpora', () => {
    // Independent of the changelog, which is the whole point: against the real
    // file all three ACCEPT arms rest on the single `(2026-07-02, second
    // batch):` pair, so rewording it would retire them with every verdict
    // above still green.
    const actual = HEADING_PROBES.map((p) => {
      const f = analyzeHeadings(p.lines);
      return {
        name: p.name,
        headings: f.headings.length,
        unparsed: f.unparsed.length,
        repeated: f.repeated.length,
        rising: f.rising.length,
      };
    });
    expect(
      actual,
      'A heading verdict stopped agreeing with a fixed corpus whose answer is known. An ACCEPT case that now ' +
        'fires means an arm stopped accepting something the changelog is allowed to do; a REFUSE case that went ' +
        'quiet means the arm it names has degraded. Each case records the degradation it kills in its `kills` ' +
        'field -- documentation, not an assertion, so read it against what the case actually exercises. ' +
        'NEVER resolve a failure here by editing a case\'s `expect`: that is the one edit that greens a red ' +
        'probe while removing the only thing watching the arm. Fix the analyzer, or delete the case and say why.'
    ).toEqual(HEADING_PROBES.map((p) => ({ name: p.name, ...p.expect })));
    // Both polarities must stay represented: a corpus set that drifted to
    // accept-only could not catch a verdict degrading to "return nothing", and
    // the reverse for a refuse-only set. These are what make the corpus itself
    // non-deletable -- with HEADING_PROBES emptied, the `toEqual` above is
    // `[]` vs `[]` and passes, so these two are its only witnesses. Both sit
    // EXACTLY at the current split, so removing any case trips one of them;
    // re-derive them in the same edit that adds or removes a case.
    const refusing = HEADING_PROBES.filter((p) => p.expect.unparsed + p.expect.repeated + p.expect.rising > 0);
    expect(refusing.length).toBeGreaterThanOrEqual(10);
    expect(HEADING_PROBES.length - refusing.length).toBeGreaterThanOrEqual(4);
  });
});
