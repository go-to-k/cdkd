import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * entries from `headline` to `whole-text` (487 -> 481, 18 -> 24), so a floor
 * with any slack passes it -- a review round measured exactly that against a
 * `headline >= 450` floor and found it green. The `whole-text` UPPER bound is
 * what actually catches it. A count of bullets cannot: the population and the
 * keyer share one predicate, so they shrink together.
 *
 * ## Known limits, recorded rather than papered over
 *
 * A duplicate whose surviving copy was reworded inside the KEY escapes. For a
 * headline-keyed entry that means a reworded headline, which is a different
 * entry under any definition a checker can apply. For the 18 whole-text-keyed
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
const CHANGELOG = join(REPO_ROOT, 'docs', 'changelog-cdkd.md');

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
 * has to keep one copy's facts while discarding its stale claim. The one row
 * here says go-to-k/cdkd#1957 is "Still open" in one copy and "now closed too"
 * in the other -- go-to-k/cdkd#1957 IS closed, so that half is settled, but the
 * stale copy is also the only one carrying the `--stack-concurrency` race and
 * the `cdkd scrub` detail. Recorded as a checklist row on go-to-k/cdkd#1837.
 *
 * "No copy is a superset" is NOT the bar, and two rows sat here on that weaker
 * one before review removed them. The `cdkd export` trio and the
 * `docker-image-asset` pair were three- and two-step REWRITE CHAINS: their
 * apparent divergence was a superseded `Tests: N new cases` count, a file list
 * the survivor extends, and a claim the survivor RETRACTS (sweeping the pushed
 * image "by digest", which the rewrite changes to "by tag"). A word-set
 * comparison reported all of it as divergence and nobody read the words back.
 * Both are deleted. Before adding a row here, read the diverging text: the
 * question is whether the older copy asserts something the survivor does not,
 * not whether a set difference is non-empty.
 *
 * The COUNT is part of each row on purpose. An allowlist that only says "this
 * one is known" goes stale silently. Asserting the exact count breaks the test
 * in BOTH directions: a merged copy and an added copy each fail it.
 */
const MERGE_PENDING: ReadonlyMap<string, number> = new Map([
  [
    "The resolved dynamic-reference cache can no longer carry one region's secret into another region's resource, nor make a later stack's secret scan come up empty (issue [#1933](https://github.com/go-to-k/cdkd/issues/1933), PARTIAL — see below)",
    2,
  ],
]);

describe('changelog entry uniqueness', () => {
  const lines = readFileSync(CHANGELOG, 'utf-8').split('\n');
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

  it('keys the whole population, by both kinds', () => {
    // Measured 2026-09-02: 505 bullets, 487 headline-keyed and 18 whole-text.
    // The floors sit just under those, not at a round number well below them:
    // a loose floor is slack an entry population can silently shrink into, and
    // the previous 450 against 506 left room for 56.
    expect(bullets.length).toBeGreaterThanOrEqual(500);
    const kinds = { headline: 0, 'whole-text': 0 };
    for (const e of entries) kinds[e.kind]++;
    // BOTH kinds must stay populated. This is the assertion that fences the
    // keyer, because it is the only one here whose value depends on the DATA:
    // deleting the bold branch takes `headline` to 0, and narrowing MARKER back
    // to a single marker spelling moves ~400 entries across. A bullet count
    // cannot see either, since the population and the keyer share `BULLET`.
    expect(kinds.headline).toBeGreaterThanOrEqual(485);
    expect(kinds['whole-text']).toBeGreaterThanOrEqual(12);
    // The bound that does the work. Re-narrowing MARKER to one marker spelling
    // pushes the 6 entries carrying the other one out of `headline` and into
    // `whole-text`; nothing else here notices a move that small.
    expect(kinds['whole-text']).toBeLessThanOrEqual(20);
    // Keys must DISCRIMINATE, not merely exist. Deliberately redundant with the
    // duplicate verdict below -- it cannot fail alone -- but it fails naming the
    // KEYER rather than the data, which is the faster diagnosis of the two.
    expect(byKey.size).toBe(bullets.length - 1);
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
        'comparison, and three clusters that looked unmergeable that way were plain rewrite chains. ' +
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
});
