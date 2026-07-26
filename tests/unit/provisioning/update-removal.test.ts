import { describe, expect, it } from 'vite-plus/test';
import { clearOnUpdateRemoval } from '../../../src/provisioning/update-removal.js';

/**
 * Module-own pins for the shared clear-on-removal resolver (issue #1223,
 * extracted from the per-provider copies of the #1160 fix). The per-provider
 * removal test suites (lambda / ecs / rds / asg) pin the END-TO-END behavior
 * through each update(); this file pins the helper's tri-state contract
 * directly so a semantics change fails here first.
 */
describe('clearOnUpdateRemoval (shared, issue #1160/#1223)', () => {
  it('passes a present value through unchanged', () => {
    expect(clearOnUpdateRemoval(5, 3, 0)).toBe(5);
    expect(clearOnUpdateRemoval('keep', 'old', 'reset')).toBe('keep');
    // Falsy-but-present values are still "present" — never replaced.
    expect(clearOnUpdateRemoval(0, 3, 99)).toBe(0);
    expect(clearOnUpdateRemoval(false, true, true)).toBe(false);
    expect(clearOnUpdateRemoval('', 'old', 'reset')).toBe('');
    expect(clearOnUpdateRemoval<unknown>(null, 'old', 'reset')).toBeNull();
  });

  it('returns the clear value when the field was present before and is now absent', () => {
    expect(clearOnUpdateRemoval(undefined, 3, 0)).toBe(0);
    const clearShape = { MinHealthyPercentage: -1 };
    expect(clearOnUpdateRemoval(undefined, { MinHealthyPercentage: 90 }, clearShape)).toBe(
      clearShape
    );
    // A falsy previous value still counts as "was present".
    expect(clearOnUpdateRemoval(undefined, 0, 300)).toBe(300);
    expect(clearOnUpdateRemoval(undefined, false, true)).toBe(true);
  });

  it('stays absent when the field was never present (no spurious reset)', () => {
    expect(clearOnUpdateRemoval(undefined, undefined, 0)).toBeUndefined();
    expect(clearOnUpdateRemoval(undefined, undefined, { Variables: {} })).toBeUndefined();
  });
});
