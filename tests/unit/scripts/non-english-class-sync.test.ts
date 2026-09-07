import { describe, expect, it } from 'vite-plus/test';
import { NON_ENGLISH_RE as BODY_RE } from '../../../scripts/check-gh-body-english.js';
import { NON_ENGLISH_RE as DIFF_RE } from '../../../scripts/check-pr-non-english-text.js';

/**
 * The two non-English checks split by SUBJECT, not by rule: `check-pr-non-english-text`
 * scans the PR DIFF, `check-gh-body-english` scans a body PUBLISHED to GitHub. They
 * replaced two hooks (`non-english-text-gate.sh` / `gh-body-english-gate.sh`) whose
 * character class was kept identical BY HAND, and `.claude/rules/hooks.md` recorded
 * that as a property someone had to maintain.
 *
 * go-to-k/cdkd#2717 carried the same hand-maintenance across the port and asserted
 * it in a COMMENT: one file claimed to be "a single source so the sibling body-side
 * check cannot drift" while the sibling held its own independent literal, and the
 * other admitted the two were "compared by eye". A comment is not a fence — review
 * of that PR caught the contradiction, nothing mechanical would have.
 *
 * Sharing one exported constant was considered and rejected: the two scripts are
 * separate entry points run by different workflows, and `scripts/gh-subject.ts`
 * already shows a shared module is available — but importing one check's module
 * into the other couples their startup and their failure modes for one regex. A
 * fence gives the same guarantee and keeps them independent.
 *
 * Drift here is SILENT and one-directional in the dangerous sense: whichever class
 * loses a range stops blocking text the other still blocks, and the gap shows up
 * only as a PR that should have been refused and was not.
 */
describe('the two non-English character classes cannot drift apart', () => {
  it('are the same pattern, flags included', () => {
    expect(DIFF_RE.source).toBe(BODY_RE.source);
    expect(DIFF_RE.flags).toBe(BODY_RE.flags);
  });

  it('still cover every writing system the retired hooks did', () => {
    // Named rather than derived: deriving the expectation from the constant is
    // what let the comment-level claim go unchecked. One boundary code point per
    // range, both ends, so a narrowed range fails rather than a deleted one only.
    const boundaries: ReadonlyArray<readonly [string, number, number]> = [
      ['CJK punctuation', 0x3000, 0x303f],
      ['hiragana', 0x3040, 0x309f],
      ['katakana', 0x30a0, 0x30ff],
      ['CJK ideographs', 0x4e00, 0x9fff],
      ['hangul syllables', 0xac00, 0xd7af],
    ];
    for (const [name, lo, hi] of boundaries) {
      for (const cp of [lo, hi]) {
        const ch = String.fromCodePoint(cp);
        expect(DIFF_RE.test(ch), `${name} U+${cp.toString(16)} must be blocked (diff side)`).toBe(
          true,
        );
        expect(BODY_RE.test(ch), `${name} U+${cp.toString(16)} must be blocked (body side)`).toBe(
          true,
        );
      }
    }
  });

  it('still pass typography, which is NOT a writing system', () => {
    // The retired hooks let these through deliberately; a class widened to catch
    // "anything non-ASCII" would block ordinary English prose in this repo's docs.
    for (const ch of ['—', '’', '“', '─', '→', 'é']) {
      expect(DIFF_RE.test(ch), `U+${ch.codePointAt(0)!.toString(16)} must pass (diff side)`).toBe(
        false,
      );
      expect(BODY_RE.test(ch), `U+${ch.codePointAt(0)!.toString(16)} must pass (body side)`).toBe(
        false,
      );
    }
  });
});
