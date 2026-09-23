/**
 * `globMatches` replaced the `*` -> `.*` RegExp expansion that
 * `stackMatchesPattern` and the failed-Stage attribution each built by hand
 * (go-to-k/cdkd#3508). Three properties are pinned here:
 *
 * - on every pattern the old expansion read correctly (no regex
 *   metacharacter besides `*`), the answer is UNCHANGED — a differential walk
 *   over an enumerated space against a transcription of the old code;
 * - every other character is LITERAL, including the ones the old expansion
 *   read as regex syntax;
 * - a pattern that backtracked exponentially under the old expansion runs no
 *   RegExp at all — asserted by `withoutRegExp`, not by a clock (its header
 *   says why).
 */
import { describe, it, expect } from 'vite-plus/test';

import { globMatches } from '../../../src/utils/glob-match.js';
import { PATHOLOGICAL_PATTERN, REGEXP_REFUSED, withoutRegExp } from '../_without-regexp.js';

/** The pre-#3508 expansion, verbatim, used only as the differential oracle. */
function oldExpansion(pattern: string, subject: string): boolean {
  if (pattern.includes('*')) {
    return new RegExp('^' + pattern.replace(/\*/g, '.*') + '$').test(subject);
  }
  return subject === pattern;
}

function allStrings(alphabet: readonly string[], maxLength: number): string[] {
  const out = [''];
  let frontier = [''];
  for (let length = 1; length <= maxLength; length++) {
    frontier = frontier.flatMap((prefix) => alphabet.map((c) => prefix + c));
    out.push(...frontier);
  }
  return out;
}

describe('globMatches', () => {
  it('agrees with the old expansion on every metacharacter-free pattern in the space', () => {
    // `-` and `/` are the separators real stack names and display paths carry.
    const patterns = allStrings(['a', 'b', '-', '*'], 5);
    const subjects = allStrings(['a', 'b', '-', '/'], 5);
    let matched = 0;
    let refused = 0;
    const disagreements: string[] = [];
    for (const pattern of patterns) {
      for (const subject of subjects) {
        const expected = oldExpansion(pattern, subject);
        if (globMatches(pattern, subject) !== expected) {
          disagreements.push(`${JSON.stringify(pattern)} vs ${JSON.stringify(subject)}`);
        }
        if (expected) matched++;
        else refused++;
      }
    }
    expect(disagreements).toEqual([]);
    // Floors per verdict: a walk that silently produced only one answer, or
    // enumerated nothing, would otherwise pass. Literals, not derived counts.
    expect(patterns.length).toBe(1365);
    expect(subjects.length).toBe(1365);
    expect(matched).toBeGreaterThan(10_000);
    expect(refused).toBeGreaterThan(1_000_000);
  });

  it.each([
    // [pattern, subject the old expansion READ AS REGEX, literal subject]
    ['My.Stage*', 'MyXStage1', 'My.Stage1'],
    ['My?Stage*', 'MStage1', 'My?Stage1'],
    ['A+*', 'AAA', 'A+x'],
    ['[AB]*', 'A1', '[AB]1'],
    ['A|B*', 'A', 'A|Bx'],
    ['a{2}*', 'aa', 'a{2}x'],
    ['a\\*', 'a..', 'a\\zz'],
    ['*\\d', 'x5', 'x\\d'],
  ])('treats every character but `*` as literal: %s', (pattern, regexReading, literal) => {
    // Each row's FIRST subject is one the old expansion matched, so the row
    // discriminates rather than restating the literal answer.
    expect(oldExpansion(pattern, regexReading)).toBe(true);
    expect(globMatches(pattern, regexReading)).toBe(false);
    expect(globMatches(pattern, literal)).toBe(true);
  });

  it('matches a pattern the old expansion could not even compile, instead of throwing', () => {
    expect(() => oldExpansion('My(Stage*', 'My(Stage1')).toThrow(SyntaxError);
    expect(globMatches('My(Stage*', 'My(Stage1')).toBe(true);
    expect(globMatches('My(Stage*', 'MyStage1')).toBe(false);
  });

  it('lets `*` cross a line terminator, which the old `.` did not', () => {
    expect(oldExpansion('a*b', 'a\nb')).toBe(false);
    expect(globMatches('a*b', 'a\nb')).toBe(true);
  });

  it('keeps head and tail from overlapping, and treats a star-free pattern as equality', () => {
    expect(globMatches('a*a', 'a')).toBe(false);
    expect(globMatches('a*a', 'aa')).toBe(true);
    expect(globMatches('ab*ba', 'aba')).toBe(false);
    expect(globMatches('**', '')).toBe(true);
    expect(globMatches('MyStack', 'MyStack')).toBe(true);
    expect(globMatches('MyStack', 'MyStackX')).toBe(false);
  });

  it('answers the old catastrophic-backtracking shape without executing any RegExp', () => {
    // 3000 characters: the old expansion needed about a minute at 60.
    const subject = 'a'.repeat(3000);
    const miss = withoutRegExp(() => globMatches(PATHOLOGICAL_PATTERN, subject));
    expect(miss.value).toBe(false);
    expect(miss.regexCalls).toBe(0);

    const hit = withoutRegExp(() => globMatches(PATHOLOGICAL_PATTERN, subject + 'b'));
    expect(hit.value).toBe(true);
    expect(hit.regexCalls).toBe(0);
  });

  it('the RegExp refusal is live: compiling a pattern throws under it', () => {
    // Guards the guard: if the spies stopped intercepting, the case above
    // would pass for a matcher that still built a RegExp.
    expect(() => withoutRegExp(() => oldExpansion('a*', 'ab'))).toThrow(REGEXP_REFUSED);
  });
});
