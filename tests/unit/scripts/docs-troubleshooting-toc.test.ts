import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { oxSlug, stripFences } from '../../ox-slug.js';

/**
 * Fences the hand-maintained `## Contents` index at the top of
 * `docs/troubleshooting.md` against the headings it indexes.
 *
 * WHY THE PAGE CARRIES ONE AT ALL. The published site renders an
 * `<aside class="toc">`, but the theme's own stylesheet declares it
 * `display: none` and re-enables it only inside `@media (min-width: 1440px)`
 * (measured in the built `ox-content-core-*.css`). Below that width — every
 * phone, and a 1280 or 1366 laptop — the page shipped with NO navigation of
 * its own, which on a guide this many headings deep means scrolling to find out
 * whether your symptom is covered at all. `vite.docs.config.ts` lowers the
 * breakpoint to 1280px, and this in-page index covers what is still below it.
 * (No heading COUNT is quoted: it drifts with every entry added, and the
 * anti-vacuity floor below is what actually holds the claim up.)
 *
 * WHY A TEST RATHER THAN A GENERATOR. The index changes only when a heading is
 * added, removed or renamed, so a generator + a CI staleness guard would be
 * more machinery than the input churn justifies. What must not happen is the
 * index rotting silently, which is what this asserts. The failure prints the
 * exact expected block, so fixing it is a paste.
 *
 * The slug function is the SHARED `tests/ox-slug.ts`, never a local copy: a
 * second hand-written slugger would agree with the first until one is
 * corrected, and the stale one would then generate links the other blesses.
 * `docs-site-links.test.ts` proves those anchors RESOLVE; this test is about
 * COVERAGE (every heading present, in document order), so the two are not
 * redundant.
 */
const ROOT = join(import.meta.dirname, '../../..');
const PAGE = join(ROOT, 'docs/troubleshooting.md');

/** H2/H3 headings in document order, skipping fenced code and the index itself. */
function headings(src: string): Array<{ depth: number; text: string }> {
  const out: Array<{ depth: number; text: string }> = [];
  for (const line of stripFences(src).split('\n')) {
    const m = /^(#{2,3}) (.+)$/.exec(line);
    if (!m) continue;
    const text = m[2]!.trim();
    if (text === 'Contents') continue;
    out.push({ depth: m[1]!.length, text });
  }
  return out;
}

/**
 * A heading's INDEX LABEL. Inline markdown links are flattened to their text:
 * a link inside a list-item label would nest brackets and break the markdown,
 * and `oxSlug` already flattens the same construct on the slug side, so
 * leaving the label raw would let the two halves of one entry disagree. No
 * heading needs it today — it is here so that the first one to carry a link
 * does not produce a broken entry that this fence then blesses.
 */
const label = (heading: string): string => heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

function expectedBlock(src: string): string {
  const lines = headings(src).map(
    ({ depth, text }) => `${depth === 2 ? '- ' : '  - '}[${label(text)}](#${oxSlug(text)})`
  );
  return ['## Contents', '', ...lines].join('\n');
}

describe('docs/troubleshooting.md contents index', () => {
  const src = readFileSync(PAGE, 'utf8');

  it('has a Contents index', () => {
    expect(src).toContain('\n## Contents\n');
  });

  it('lists every H2 and H3 in document order, with resolvable slugs', () => {
    const start = src.indexOf('## Contents');
    expect(start).toBeGreaterThan(-1);
    // The block runs to the first blank line followed by the next `## `.
    const rest = src.slice(start);
    const end = rest.search(/\n## (?!Contents)/);
    const actual = rest.slice(0, end === -1 ? undefined : end).trimEnd();

    const expected = expectedBlock(src);
    if (actual !== expected) {
      // Printed so the fix is a paste rather than a hand-reconstruction.
      console.error(`\nExpected Contents block:\n\n${expected}\n`);
    }
    expect(actual).toBe(expected);
  });

  it('is not vacuous — the page really does carry many headings', () => {
    // Anti-vacuity floor: a page trimmed to a handful of headings no longer
    // needs an index, and this test passing on one would say nothing.
    expect(headings(src).length).toBeGreaterThanOrEqual(30);
  });
});
