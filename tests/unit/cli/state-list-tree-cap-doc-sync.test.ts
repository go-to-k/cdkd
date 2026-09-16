import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { MAX_STACK_TREE_DEPTH } from '../../../src/cli/commands/state-list-tree.js';

/**
 * `docs/cli-state.md` states the `cdkd state list --tree` depth cap as a bare
 * number, twice — it is a user-facing page and a reader cannot import a
 * constant. So the number is a COPY, and changing
 * {@link MAX_STACK_TREE_DEPTH} would leave the page quietly wrong about what
 * the binary does (issue #3155).
 *
 * It asserts a FLOOR on the count as well as the value, sized to the corpus as
 * it stands: the page states the cap exactly twice today, so deleting either
 * sentence takes the count below the floor and reds. That guarantee holds only
 * while the page carries exactly two — add a third correct sentence and a
 * later deletion passes — the same kind of caveat the paragraph below makes
 * about the named population.
 *
 * Its population is NAMED, not derived, which is the one place it is weaker
 * than `tests/unit/state/custom-resource-response-prefix-sync.test.ts` — that
 * one lists its files from git precisely so a copy landing elsewhere cannot
 * escape. A restatement of the cap on another page would drift unfenced here.
 * Correct for the corpus as it stands (`cli-state.md` is the only page stating
 * it), and the thing to widen if a second page ever does.
 */
describe('state list --tree depth cap: docs match the constant', () => {
  const docPath = join(process.cwd(), 'docs', 'cli-state.md');
  const doc = readFileSync(docPath, 'utf-8');

  it('names the live cap value in every sentence that states a depth', () => {
    // Every "<n> levels" in the page, wherever it sits — deliberately not
    // anchored to the two sentences that carry it today, so a THIRD one added
    // later with a stale number is caught too.
    //
    // CloudFormation's own nested-stack limit is named on this page as well,
    // and is NOT filtered out: the page spells it in words ("five levels"), so
    // it does not match. Should someone rewrite it as a numeral, this fence
    // fires — a fence going off on a doc edit is the outcome to want here,
    // over a filter that would also hide a genuine cap of 5.
    const stated = [...doc.matchAll(/(\d+) levels/g)].map((m) => Number(m[1]));
    // A FLOOR, not an exact list: a third sentence stating the cap correctly is
    // a legitimate doc edit, and pinning the array would red on it. The floor
    // still catches the deletion that pinning was chosen for, since dropping
    // either of today's two sentences takes the count below it.
    expect(stated.length).toBeGreaterThanOrEqual(2);
    // The offending values, not a boolean: a failure should print what the page
    // actually says.
    expect(stated.filter((v) => v !== MAX_STACK_TREE_DEPTH)).toEqual([]);
  });
});
