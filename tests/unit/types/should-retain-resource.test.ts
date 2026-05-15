import { describe, it, expect } from 'vite-plus/test';
import { shouldRetainResource } from '../../../src/types/state.js';

describe('shouldRetainResource', () => {
  it('returns true for Retain', () => {
    expect(shouldRetainResource('Retain')).toBe(true);
  });

  it('returns true for RetainExceptOnCreate', () => {
    expect(shouldRetainResource('RetainExceptOnCreate')).toBe(true);
  });

  it('returns false for Delete', () => {
    expect(shouldRetainResource('Delete')).toBe(false);
  });

  it('returns false for Snapshot — cdkd does not yet implement snapshot semantics, so delete continues', () => {
    expect(shouldRetainResource('Snapshot')).toBe(false);
  });

  it('returns false for undefined (no policy recorded — pre-v5 state behavior)', () => {
    expect(shouldRetainResource(undefined)).toBe(false);
  });
});
