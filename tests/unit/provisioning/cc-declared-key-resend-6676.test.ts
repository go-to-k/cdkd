import { describe, it, expect } from 'vite-plus/test';
import { withDeclaredKeysResent } from '../../../src/provisioning/cc-declared-key-resend.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const CHANGE: JsonPatchOp = { op: 'replace', path: '/Description', value: 'new' };

describe('withDeclaredKeysResent (go-to-k/cdkd#6676)', () => {
  it('adds every declared key the patch has no op on, in declaration order', () => {
    expect(
      withDeclaredKeysResent(
        [CHANGE],
        { Name: 'n', Description: 'new', Tags: [{ Key: 'k', Value: 'v' }] },
        new Set()
      )
    ).toEqual([
      CHANGE,
      { op: 'add', path: '/Name', value: 'n' },
      { op: 'add', path: '/Tags', value: [{ Key: 'k', Value: 'v' }] },
    ]);
  });

  it('leaves an excluded key and a key the patch already has an op on alone', () => {
    const patch: JsonPatchOp[] = [CHANGE, { op: 'remove', path: '/Policy' }];
    expect(
      withDeclaredKeysResent(patch, { Name: 'n', Description: 'new', Policy: 'p' }, new Set(['Name']))
    ).toBe(patch);
  });

  it('escapes a key as RFC 6901 spells it', () => {
    expect(withDeclaredKeysResent([CHANGE], { 'a/b~c': 1 }, new Set())).toEqual([
      CHANGE,
      { op: 'add', path: '/a~1b~0c', value: 1 },
    ]);
  });

  it('adds nothing to an empty patch or when the exclusions are unknown', () => {
    const empty: JsonPatchOp[] = [];
    expect(withDeclaredKeysResent(empty, { Name: 'n' }, new Set())).toBe(empty);
    const patch: JsonPatchOp[] = [CHANGE];
    expect(withDeclaredKeysResent(patch, { Name: 'n' }, undefined)).toBe(patch);
  });
});
