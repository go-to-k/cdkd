import { describe, it, expect } from 'vite-plus/test';
import {
  updatePartialMessage,
  updatePartialReason,
} from '../../../src/deployment/update-outcome.js';

describe('updatePartialReason (issue #1819)', () => {
  it('returns the reason for a partial update', () => {
    expect(
      updatePartialReason({
        physicalId: 'new-arn',
        wasReplaced: true,
        outcome: 'partial',
        reason: 'old certificate old-arn is still in use',
      })
    ).toBe('old certificate old-arn is still in use');
  });

  it('returns undefined for an explicit clean update', () => {
    expect(
      updatePartialReason({ physicalId: 'arn', wasReplaced: false, outcome: 'updated' })
    ).toBeUndefined();
  });

  // The back-compat arm: ~80 providers return a bare result with no outcome,
  // and every one of them must keep reading as a clean update.
  it('returns undefined when the provider omits the outcome entirely', () => {
    expect(updatePartialReason({ physicalId: 'arn', wasReplaced: false })).toBeUndefined();
  });

  it('returns undefined for an absent result', () => {
    expect(updatePartialReason(undefined)).toBeUndefined();
  });

  // `reason` is required by the discriminated union, so only an untyped
  // producer can reach this. It must NOT fall back to undefined: that would
  // silently restore the pre-#1819 behavior at the one site that exists to
  // end it.
  it('never returns undefined for something that said partial', () => {
    const untyped = { physicalId: 'arn', wasReplaced: true, outcome: 'partial' } as unknown as {
      physicalId: string;
      wasReplaced: boolean;
      outcome: 'partial';
      reason: string;
    };
    const reason = updatePartialReason(untyped);
    expect(reason).toBeDefined();
    expect(reason).toContain('without a reason');
  });
});

describe('updatePartialMessage', () => {
  it('renders the destroy-path shape without claiming the row was skipped', () => {
    const line = updatePartialMessage('old certificate arn:x is still in use');
    expect(line).toBe('partial (old certificate arn:x is still in use)');
    // The row's own resource WAS updated; calling it `skipped` would
    // contradict RESOURCE_SKIPPED's documented invariant.
    expect(line).not.toContain('skipped');
  });
});
