import { describe, it, expect } from 'vite-plus/test';
import { classifyWcTrim } from '../../../scripts/check-integ-wc-trim.js';
import { uncountedWcWords } from '../../uncounted-wc-words.js';

/**
 * GROWTH guard for the issue #3213 wc-trim fence
 * (`integ-verify-wc-trim.test.ts`): how the running time of the classifier
 * and of the tree invariant's helper grows with the input, measured against a
 * LINEAR REFERENCE. It guards the complexity class that recurred in review (a
 * per-item `filter`, a backtracking regex, a per-opener scan to the end of the
 * file, a strip over a growing accumulator, a per-`wc` stage re-walk, a
 * per-character frame search). Each finished under vitest's default at the
 * sizes its shape happened to be tested at, so a timeout could not see it.
 *
 * Timing the input at two sizes and bounding the ratio is not stable enough on
 * its own: contention does not scale the two sizes alike. So each case divides
 * its ratio by the ratio of a plainly linear corpus, and measures that corpus
 * INSIDE the same sampling loop, interleaved with its own samples: contention
 * and heap state then weigh on both at the same moments, which is what lets
 * them largely cancel.
 * The reference used to be measured once, early, so it could not cancel a
 * heap state that differed by the time a candidate ran; and these cases used
 * to share a file with some 350 others, whose garbage they were then timed in.
 * Both are why this is its own file.
 *
 * The candidate spread is 4x, not 2x: at 2x a fully quadratic regression scores
 * about 4 / 2 = 2 against a linear 1, and the size constant decides whether it
 * is caught; at 4x it scores about 16 / 4 = 4.
 *
 * WHAT IT DOES AND DOES NOT BUY. It separates a fully quadratic pass from a
 * linear one ON THE SHAPES LISTED BELOW. A growth an order milder (n log n)
 * passes, and only those shapes are measured: a shape one character away can
 * escape it — the classifier had a per-character frame search that the
 * unquoted deep-`${` shape passed and the quoted one, 100x slower, did not
 * measure until it was added. The set is open, not closed. Each generator
 * carries an input the case asserts is reported, so an empty result cannot
 * pass by being fast.
 */
const MAX_RELATIVE_GROWTH = 1.8;

/** This process's CPU time for one call, in milliseconds. */
const cpuMs = (run: () => void) => {
  const started = process.cpuUsage();
  run();
  const spent = process.cpuUsage(started);
  return (spent.user + spent.system) / 1000;
};

/** The candidate spread: `large` is this many times `small`. */
const SPREAD = 4;

/**
 * A corpus with no heredoc and no substitution: only the per-file work every
 * classification does (line starts, the whitespace index) and plain words.
 */
const LINEAR_REFERENCE = (n: number) => `${Array.from({ length: n }, (_, k) => `echo line ${k}`).join('\n')}\n`;
const REFERENCE_N = 8_000;

/**
 * The candidate's growth over the reference's, from interleaved samples: the
 * median of three ratios, each of the best of three runs at each size. A floor
 * on each denominator: a sub-millisecond baseline is noise, not growth.
 */
const relativeGrowth = (measure: (text: string) => void, make: (n: number) => string, n: number): number => {
  const small = make(n);
  const large = make(SPREAD * n);
  const refSmall = LINEAR_REFERENCE(REFERENCE_N);
  const refLarge = LINEAR_REFERENCE(SPREAD * REFERENCE_N);
  measure(small);
  classifyWcTrim(refSmall);
  const ratios = [0, 1, 2].map(() => {
    let a = Infinity;
    let b = Infinity;
    let ra = Infinity;
    let rb = Infinity;
    for (let run = 0; run < 3; run++) {
      a = Math.min(a, cpuMs(() => measure(small)));
      b = Math.min(b, cpuMs(() => measure(large)));
      ra = Math.min(ra, cpuMs(() => classifyWcTrim(refSmall)));
      rb = Math.min(rb, cpuMs(() => classifyWcTrim(refLarge)));
    }
    return b / Math.max(a, 1) / (rb / Math.max(ra, 1));
  });
  return ratios.sort((x, y) => x - y)[1]!;
};

/**
 * The reference's OWN growth, as an exponent over the same spread (1.0 is
 * linear). Dividing by the reference cancels work the two share, so a
 * regression in shared code would cancel itself out; this is what notices
 * that. Its bound sits between a linear run and a quadratic line-index build
 * (this PR's measurement record carries both).
 */
const MAX_REFERENCE_EXPONENT = 1.4;
const referenceExponent = (): number => {
  const small = LINEAR_REFERENCE(REFERENCE_N);
  const large = LINEAR_REFERENCE(SPREAD * REFERENCE_N);
  classifyWcTrim(small);
  const exponents = [0, 1, 2].map(() => {
    let a = Infinity;
    let b = Infinity;
    for (let run = 0; run < 3; run++) {
      a = Math.min(a, cpuMs(() => classifyWcTrim(small)));
      b = Math.min(b, cpuMs(() => classifyWcTrim(large)));
    }
    return Math.log(b / Math.max(a, 1)) / Math.log(SPREAD);
  });
  return exponents.sort((x, y) => x - y)[1]!;
};

describe('classifyWcTrim grows about linearly (issue #3213)', () => {
  // Every generator opens with an untrimmed `wc` on line 1, which the case
  // asserts is reported: a classifier that returns nothing is fast, not right.
  const SENTINEL = 'wc -l </dev/null\n';
  it.each([
    ['unterminated openers packed bytes apart', (n: number) => SENTINEL + '$(<<Z\n'.repeat(n), 8_000, () => 1],
    [
      'nested unterminated openers inside a terminated outer body',
      (n: number) => `${SENTINEL}cat <<E\n${'$(cat <<Z\n'.repeat(n)}E\n`,
      8_000,
      () => 1,
    ],
    ['openers whose comments end in a backslash', (n: number) => SENTINEL + '$(<<Z # \\\n'.repeat(n), 16_000, () => 1],
    [
      'deeply nested parameter expansions',
      (n: number) => `${SENTINEL}echo ${'${X:-'.repeat(n)}${'x'.repeat(n)}${'}'.repeat(n)}\n`,
      8_000,
      () => 1,
    ],
    [
      // One character from the previous shape: the quote pushes a frame the
      // classifier once searched past per character.
      'deeply nested parameter expansions around a double-quoted word',
      (n: number) => `${SENTINEL}echo ${'${X:-'.repeat(n)}"${'x'.repeat(n)}"${'}'.repeat(n)}\n`,
      8_000,
      () => 1,
    ],
    [
      'many wc stages whose arguments hold a shift',
      (n: number) => `${SENTINEL}${Array.from({ length: n }, () => "wc -l $((1<<2)) </dev/null |\ntr -d ' '").join('\n')}\n`,
      2_000,
      () => 1,
    ],
    [
      // Stages nest, so re-walking each one from its `wc` was quadratic.
      'wc stages nested in one another',
      (n: number) => `${SENTINEL}${'wc $('.repeat(n)}${')'.repeat(n)}\n`,
      16_000,
      (n: number) => n + 1,
    ],
    [
      // A duplication target read by a backtracking pattern rescanned the run.
      'a duplication target reached through many line continuations',
      (n: number) => `${SENTINEL}wc -l >&1${'\\\n'.repeat(n)}file | tr -d ' '\n`,
      16_000,
      () => 2,
    ],
    [
      // No other case is `<<-` at all, which is why the strip over a growing
      // accumulator had nowhere to fail.
      'a long <<- delimiter reached through continued lines',
      (n: number) => {
        const delimiter = 'D'.repeat(n);
        const body = Array.from({ length: Math.ceil(n / 2) }, () => '\tx\\').join('\n');
        return `${SENTINEL}cat <<-${delimiter} # \\\n${body}\n\t${delimiter}\n`;
      },
      48_000,
      () => 1,
    ],
  ])('on %s', (_label, make, n, violations) => {
    const c = classifyWcTrim(make(n));
    expect(c.violations[0]?.line).toBe(1);
    expect(c.violations).toHaveLength(violations(n));
    expect(relativeGrowth(classifyWcTrim, make, n)).toBeLessThan(MAX_RELATIVE_GROWTH);
  }, 120_000);

  it('on the reference corpus the other cases divide by', () => {
    // Without this, a regression in code the reference SHARES cancels itself
    // out of every ratio above.
    expect(referenceExponent()).toBeLessThan(MAX_REFERENCE_EXPONENT);
  }, 120_000);
});

describe('the tree invariant\'s helper grows about linearly (issue #3213)', () => {
  // The first recurrence of the super-linear class lived in THIS helper. Each
  // generator carries one uncounted `wc` on line 1, asserted, so an empty
  // result cannot pass.
  const UNCOUNTED = "eval 'wc -l'\n";
  it.each([
    [
      'many commented lines',
      (n: number) => `${UNCOUNTED}${Array.from({ length: n }, (_, k) => `# line ${k}: count with wc -l and trim it`).join('\n')}\n`,
    ],
    [
      'many counted invocations',
      (n: number) => `${UNCOUNTED}${Array.from({ length: n }, () => "wc -l </dev/null | tr -d ' '").join('\n')}\n`,
    ],
    // A leading character class in the word regex once backtracked across a
    // long line.
    ['one long line of path-like text', (n: number) => `${UNCOUNTED}echo ${'=a/'.repeat(2 * n)}\n`],
    [
      'many data heredoc bodies',
      (n: number) => `${UNCOUNTED}${Array.from({ length: n }, () => "cat <<'EOF'\nrun wc -l here\nEOF").join('\n')}\n`,
    ],
  ])('on %s', (_label, make) => {
    expect(uncountedWcWords(make(16_000))).toEqual([1]);
    expect(relativeGrowth((text) => void uncountedWcWords(text), make, 16_000)).toBeLessThan(MAX_RELATIVE_GROWTH);
  }, 120_000);
});
