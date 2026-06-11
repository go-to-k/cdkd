import { describe, it, expect } from 'vite-plus/test';
import {
  canonicalizeIdArraysDeep,
  canonicalizeTagListsDeep,
} from '../../../src/analyzer/drift-normalize.js';

describe('canonicalizeTagListsDeep', () => {
  it('sorts a tag list by Key so a reorder canonicalizes equal', () => {
    const a = [
      { Key: 'env', Value: 'prod' },
      { Key: 'team', Value: 'core' },
    ];
    const b = [
      { Key: 'team', Value: 'core' },
      { Key: 'env', Value: 'prod' },
    ];
    expect(canonicalizeTagListsDeep(a)).toEqual(canonicalizeTagListsDeep(b));
  });

  it('breaks Key ties deterministically by stringified entry', () => {
    const a = [
      { Key: 'k', Value: 'b' },
      { Key: 'k', Value: 'a' },
    ];
    const b = [
      { Key: 'k', Value: 'a' },
      { Key: 'k', Value: 'b' },
    ];
    expect(canonicalizeTagListsDeep(a)).toEqual(canonicalizeTagListsDeep(b));
  });

  it('recurses into nested objects carrying tag lists', () => {
    const a = { Spec: { Tags: [{ Key: 'b', Value: '2' }, { Key: 'a', Value: '1' }] } };
    const b = { Spec: { Tags: [{ Key: 'a', Value: '1' }, { Key: 'b', Value: '2' }] } };
    expect(canonicalizeTagListsDeep(a)).toEqual(canonicalizeTagListsDeep(b));
  });

  it('leaves a non-tag object array order untouched', () => {
    const arr = [{ Name: 'b' }, { Name: 'a' }];
    expect(canonicalizeTagListsDeep(arr)).toEqual([{ Name: 'b' }, { Name: 'a' }]);
  });

  it('leaves a plain scalar array untouched', () => {
    const arr = ['z', 'a', 'm'];
    expect(canonicalizeTagListsDeep(arr)).toEqual(['z', 'a', 'm']);
  });

  it('passes scalars through unchanged', () => {
    expect(canonicalizeTagListsDeep('x')).toBe('x');
    expect(canonicalizeTagListsDeep(42)).toBe(42);
    expect(canonicalizeTagListsDeep(null)).toBe(null);
    expect(canonicalizeTagListsDeep(undefined)).toBe(undefined);
  });
});

describe('canonicalizeIdArraysDeep', () => {
  it('sorts an id-like array (subnet-*) so a reorder canonicalizes equal', () => {
    const a = ['subnet-0abc123def', 'subnet-0fed321cba'];
    const b = ['subnet-0fed321cba', 'subnet-0abc123def'];
    expect(canonicalizeIdArraysDeep(a)).toEqual([
      'subnet-0abc123def',
      'subnet-0fed321cba',
    ]);
    expect(canonicalizeIdArraysDeep(a)).toEqual(canonicalizeIdArraysDeep(b));
  });

  it('does NOT sort when an element has a non-hex suffix (not id-like)', () => {
    // ID_RE requires a hex-only suffix after the dash; 'subnet-9xyz...'
    // contains non-hex chars so the array is left in original order.
    const arr = ['subnet-0abc123def', 'subnet-9xyz987abc'];
    expect(canonicalizeIdArraysDeep(arr)).toEqual([
      'subnet-0abc123def',
      'subnet-9xyz987abc',
    ]);
  });

  it('sorts an ARN array', () => {
    const a = ['arn:aws:iam::111:role/b', 'arn:aws:iam::111:role/a'];
    const b = ['arn:aws:iam::111:role/a', 'arn:aws:iam::111:role/b'];
    expect(canonicalizeIdArraysDeep(a)).toEqual([
      'arn:aws:iam::111:role/a',
      'arn:aws:iam::111:role/b',
    ]);
    expect(canonicalizeIdArraysDeep(a)).toEqual(canonicalizeIdArraysDeep(b));
  });

  it('recurses into nested objects carrying id arrays', () => {
    const a = { VpcConfig: { SubnetIds: ['subnet-bbb222', 'subnet-aaa111'] } };
    const b = { VpcConfig: { SubnetIds: ['subnet-aaa111', 'subnet-bbb222'] } };
    expect(canonicalizeIdArraysDeep(a)).toEqual(canonicalizeIdArraysDeep(b));
  });

  it('leaves a plain non-id scalar array order untouched', () => {
    const arr = ['us-east-1a', 'us-east-1b', 'us-east-1c'];
    expect(canonicalizeIdArraysDeep(arr)).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c']);
  });

  it('does not sort a single-element id array', () => {
    expect(canonicalizeIdArraysDeep(['subnet-aaa111'])).toEqual(['subnet-aaa111']);
  });

  it('does not sort a mixed id/non-id array', () => {
    const arr = ['subnet-aaa111', 'not-an-id'];
    expect(canonicalizeIdArraysDeep(arr)).toEqual(['subnet-aaa111', 'not-an-id']);
  });

  it('passes scalars through unchanged', () => {
    expect(canonicalizeIdArraysDeep('subnet-aaa111')).toBe('subnet-aaa111');
    expect(canonicalizeIdArraysDeep(7)).toBe(7);
    expect(canonicalizeIdArraysDeep(null)).toBe(null);
  });
});
