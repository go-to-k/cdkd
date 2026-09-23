import { describe, expect, it } from 'vite-plus/test';
import {
  canonicalizePermissionsBoundary,
  getForcedPermissionsBoundary,
  resolvePermissionsBoundary,
  withAppliedPermissionsBoundary,
  withForcedPermissionsBoundary,
} from '../../../src/provisioning/forced-permissions-boundary.js';

const FORCED = 'arn:aws:iam::123456789012:policy/forced';
const DECLARED = 'arn:aws:iam::123456789012:policy/declared';

describe('getForcedPermissionsBoundary', () => {
  it('is undefined outside any scope, so the template stays in charge', () => {
    expect(getForcedPermissionsBoundary()).toBeUndefined();
  });

  it('does not leak out of its scope', () => {
    withForcedPermissionsBoundary(FORCED, () => {
      expect(getForcedPermissionsBoundary()).toBe(FORCED);
    });
    expect(getForcedPermissionsBoundary()).toBeUndefined();
  });

  it('keeps concurrent scopes independent', async () => {
    const a = withForcedPermissionsBoundary('arn:a', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getForcedPermissionsBoundary();
    });
    const b = withForcedPermissionsBoundary('arn:b', async () => getForcedPermissionsBoundary());
    expect(await Promise.all([a, b])).toEqual(['arn:a', 'arn:b']);
  });
});

describe('resolvePermissionsBoundary', () => {
  it('returns the template value when no scope is active', () => {
    expect(resolvePermissionsBoundary(DECLARED)).toBe(DECLARED);
    expect(resolvePermissionsBoundary(undefined)).toBeUndefined();
  });

  it('overrides a DIFFERENT template value and reports the override', () => {
    const seen: Array<[string, string | undefined]> = [];
    withForcedPermissionsBoundary(FORCED, () => {
      expect(resolvePermissionsBoundary(DECLARED, (f, t) => seen.push([f, t]))).toBe(FORCED);
    });
    expect(seen).toEqual([[FORCED, DECLARED]]);
  });

  it('reports the override when the template declared NONE', () => {
    const seen: Array<[string, string | undefined]> = [];
    withForcedPermissionsBoundary(FORCED, () => {
      expect(resolvePermissionsBoundary(undefined, (f, t) => seen.push([f, t]))).toBe(FORCED);
    });
    expect(seen).toEqual([[FORCED, undefined]]);
  });

  it('does NOT report when the template already agrees', () => {
    const seen: unknown[] = [];
    withForcedPermissionsBoundary(FORCED, () => {
      expect(resolvePermissionsBoundary(FORCED, () => seen.push('called'))).toBe(FORCED);
    });
    expect(seen).toEqual([]);
  });
});

describe('withAppliedPermissionsBoundary', () => {
  it('sets the applied value without mutating the input', () => {
    const input = { RoleName: 'r', PermissionsBoundary: DECLARED };
    expect(withAppliedPermissionsBoundary(input, FORCED)).toEqual({
      RoleName: 'r',
      PermissionsBoundary: FORCED,
    });
    expect(input['PermissionsBoundary']).toBe(DECLARED);
  });

  it('REMOVES the key rather than setting undefined, which no readback can match', () => {
    const out = withAppliedPermissionsBoundary({ RoleName: 'r', PermissionsBoundary: DECLARED }, undefined);
    expect('PermissionsBoundary' in out).toBe(false);
    expect(Object.keys(out)).toEqual(['RoleName']);
  });
});

describe('canonicalizePermissionsBoundary', () => {
  it('is identity outside a scope, preserving pre-flag behavior', () => {
    const input = { RoleName: 'r', PermissionsBoundary: DECLARED };
    expect(canonicalizePermissionsBoundary(input)).toBe(input);
  });

  it('folds the forced value onto the desired side so the diff compares like with like', () => {
    withForcedPermissionsBoundary(FORCED, () => {
      expect(canonicalizePermissionsBoundary({ RoleName: 'r', PermissionsBoundary: DECLARED })).toEqual(
        { RoleName: 'r', PermissionsBoundary: FORCED }
      );
      expect(canonicalizePermissionsBoundary({ RoleName: 'r' })).toEqual({
        RoleName: 'r',
        PermissionsBoundary: FORCED,
      });
    });
  });

  it('returns the SAME object when the desired side already matches, so no needless copy is made', () => {
    const input = { RoleName: 'r', PermissionsBoundary: FORCED };
    withForcedPermissionsBoundary(FORCED, () => {
      expect(canonicalizePermissionsBoundary(input)).toBe(input);
    });
  });
});
