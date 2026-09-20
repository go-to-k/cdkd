/**
 * The two readers of `ResourceState.observedBaselineRefusalReason` (issues
 * #3462, #3468). They are the ONLY code in `src/` that reads the field — every
 * other site writes or deletes it — so what they answer for each value IS the
 * compatibility contract between binaries.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  hasReasonlessBaselineRefusal,
  hasUnverifiableParameterRefusal,
} from '../../../src/types/state.js';

describe('observedBaselineRefusalReason readers', () => {
  it("'incomplete-resolution' is neither sticky nor reason-less: a reader that tests only for 'unverifiable-parameter' (a binary that predates the value) clears it on UPDATE, and so does this one", () => {
    const record = {
      observedBaselineRefused: true as const,
      observedBaselineRefusalReason: 'incomplete-resolution' as const,
    };
    expect(hasUnverifiableParameterRefusal(record)).toBe(false);
    expect(hasReasonlessBaselineRefusal(record)).toBe(false);
  });

  it("'unverifiable-parameter' is sticky and not reason-less", () => {
    const record = {
      observedBaselineRefused: true as const,
      observedBaselineRefusalReason: 'unverifiable-parameter' as const,
    };
    expect(hasUnverifiableParameterRefusal(record)).toBe(true);
    expect(hasReasonlessBaselineRefusal(record)).toBe(false);
  });

  it('a marker with no reason is reason-less, and not sticky by itself', () => {
    for (const record of [
      { observedBaselineRefused: true as const },
      { observedBaselineRefused: true as const, observedBaselineRefusalReason: undefined },
    ]) {
      expect(hasReasonlessBaselineRefusal(record)).toBe(true);
      expect(hasUnverifiableParameterRefusal(record)).toBe(false);
    }
  });

  it('a reason this binary does not know (null, a later value) is read as reason-less: fail closed', () => {
    for (const reason of [null, 'a-later-value', '', 0]) {
      const record = {
        observedBaselineRefused: true as const,
        observedBaselineRefusalReason: reason as never,
      };
      expect(hasReasonlessBaselineRefusal(record)).toBe(true);
      expect(hasUnverifiableParameterRefusal(record)).toBe(false);
    }
  });

  it('no marker is no refusal, whatever the reason field holds', () => {
    for (const record of [
      undefined,
      {},
      { observedBaselineRefusalReason: 'unverifiable-parameter' as const },
      { observedBaselineRefusalReason: 'incomplete-resolution' as const },
    ]) {
      expect(hasReasonlessBaselineRefusal(record)).toBe(false);
      expect(hasUnverifiableParameterRefusal(record)).toBe(false);
    }
  });
});
