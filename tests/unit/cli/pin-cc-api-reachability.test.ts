import { describe, it, expect } from 'vite-plus/test';
import { analyzePinCcApiReachability } from '../../../src/cli/commands/pin-cc-api-reachability.js';

/**
 * `--pin-cc-api` reachability (issue
 * [#2719](https://github.com/go-to-k/cdkd/issues/2719)).
 *
 * The two shapes are not the same problem and must not be reported the same
 * way: an id in NO stack did nothing at all (error), while an id in SOME
 * stacks is the normal `--all` case (one line, never per non-matching stack).
 * This logic lived inline in `deployCommand` with no test until a review round
 * pointed out that it had been silently moved between log levels once already.
 */
const stack = (stackName: string, ...logicalIds: string[]) => ({ stackName, logicalIds });

describe('analyzePinCcApiReachability', () => {
  it('errors on an id present in no stack', () => {
    const r = analyzePinCcApiReachability(['Ghost'], [stack('A', 'X'), stack('B', 'Y')]);
    expect(r.unmatched).toEqual(['Ghost']);
    expect(r.errorMessage).toContain('present in no stack');
    expect(r.errorMessage).toContain('Ghost');
    // The stack list is what tells a user WHERE to look for the right id.
    expect(r.errorMessage).toContain('A, B');
  });

  it('is silent for an id present in every stack', () => {
    const r = analyzePinCcApiReachability(['X'], [stack('A', 'X'), stack('B', 'X')]);
    expect(r.unmatched).toEqual([]);
    expect(r.partial).toEqual([]);
    expect(r.errorMessage).toBe('');
  });

  it('reports a PARTIAL match once, not once per non-matching stack', () => {
    // The defect this shape exists to avoid: a previous revision emitted a
    // warn per non-matching stack, so one pinned id in a twenty-stack app gave
    // nineteen lines for a run in which nothing was wrong.
    const r = analyzePinCcApiReachability(
      ['X'],
      [stack('A', 'X'), stack('B', 'Y'), stack('C', 'Z'), stack('D', 'W')]
    );
    expect(r.unmatched).toEqual([]);
    expect(r.partial).toHaveLength(1);
    expect(r.partial[0]!.logicalId).toBe('X');
    expect(r.partial[0]!.appliesTo).toEqual(['A']);
    expect(r.partial[0]!.absentFrom).toEqual(['B', 'C', 'D']);
  });

  it('a single-stack deploy still errors on a typo', () => {
    // The run-level check must not become a way for the one-stack case to pass.
    const r = analyzePinCcApiReachability(['Typo'], [stack('Only', 'Real')]);
    expect(r.unmatched).toEqual(['Typo']);
  });

  it('a single-stack deploy reports no partial match', () => {
    // With one stack, "some but not all" is unreachable; a partial entry here
    // would mean the absent-from set was computed against the wrong population.
    const r = analyzePinCcApiReachability(['Real'], [stack('Only', 'Real')]);
    expect(r.partial).toEqual([]);
  });

  it('separates the two shapes when both are present', () => {
    const r = analyzePinCcApiReachability(
      ['X', 'Ghost'],
      [stack('A', 'X'), stack('B', 'Y')]
    );
    expect(r.unmatched).toEqual(['Ghost']);
    expect(r.partial.map((p) => p.logicalId)).toEqual(['X']);
  });

  it('de-duplicates a repeated id so one typo reads as one problem', () => {
    const r = analyzePinCcApiReachability(['Ghost', 'Ghost'], [stack('A', 'X')]);
    expect(r.unmatched).toEqual(['Ghost']);
    expect(r.errorMessage).toContain('named 1 logical id');
  });

  it('reports every unmatched id, not just the first', () => {
    const r = analyzePinCcApiReachability(['G1', 'G2'], [stack('A', 'X')]);
    expect(r.unmatched).toEqual(['G1', 'G2']);
    expect(r.errorMessage).toContain('named 2 logical id');
  });

  it('handles a stack with no resources without treating it as a match', () => {
    const r = analyzePinCcApiReachability(['X'], [stack('A', 'X'), stack('Empty')]);
    expect(r.unmatched).toEqual([]);
    expect(r.partial[0]!.absentFrom).toEqual(['Empty']);
  });
});
