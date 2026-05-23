import { describe, expect, it } from 'vite-plus/test';
import { pickRefLogicalId } from '../../../src/local/intrinsic-utils.js';

describe('pickRefLogicalId', () => {
  it('returns the logical id when given a {Ref: <string>} intrinsic', () => {
    expect(pickRefLogicalId({ Ref: 'MyResource' })).toBe('MyResource');
  });

  it('returns null when Ref value is not a string', () => {
    expect(pickRefLogicalId({ Ref: 123 })).toBeNull();
    expect(pickRefLogicalId({ Ref: { nested: 'object' } })).toBeNull();
    expect(pickRefLogicalId({ Ref: null })).toBeNull();
  });

  it('returns null for non-Ref intrinsics', () => {
    expect(pickRefLogicalId({ 'Fn::GetAtt': ['Foo', 'Arn'] })).toBeNull();
    expect(pickRefLogicalId({ 'Fn::Sub': '${MyRef}' })).toBeNull();
  });

  it('returns null for primitives, arrays, and nullish values', () => {
    expect(pickRefLogicalId(null)).toBeNull();
    expect(pickRefLogicalId(undefined)).toBeNull();
    expect(pickRefLogicalId('literal-string')).toBeNull();
    expect(pickRefLogicalId(42)).toBeNull();
    expect(pickRefLogicalId([{ Ref: 'X' }])).toBeNull();
  });
});
