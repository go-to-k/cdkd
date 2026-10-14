import { describe, it, expect } from 'vite-plus/test';
import { declaredEmptyProperties } from '../../../src/cli/commands/drift.js';

/**
 * go-to-k/cdkd#4884: `cdkd drift --revert` tells a provider which top-level
 * properties the record's TEMPLATE side declares empty, by NAME only: an SSM
 * parameter's readback `Policies: []` may stand for a failed read at capture,
 * and only a template declaring none licenses clearing the live policies.
 */
describe('declaredEmptyProperties (go-to-k/cdkd#4884)', () => {
  const policy = { Type: 'Expiration', Version: '1.0', Attributes: { Timestamp: 'x' } };

  it.each([
    ["'[]'", '[]'],
    ["' [ ] '", ' [ ] '],
    ["''", ''],
    ["'{}'", '{}'],
    ['[]', []],
    ['{}', {}],
  ])('a declared %s is empty', (_l, value) => {
    expect(declaredEmptyProperties({ Name: '/p', Policies: value }).has('Policies')).toBe(true);
  });

  it.each([
    ['a JSON policy list', JSON.stringify([policy])],
    ['a policy list', [policy]],
    ['an unparsable string', '['],
    ['the NoEcho mask', '***'],
    ['a dynamic reference', '{{resolve:ssm:/p}}'],
    ['a number', 7],
    ['null', null],
    ['an intrinsic object', { 'Fn::Join': ['', []] }],
  ])('a declared %s is not empty', (_l, value) => {
    expect(declaredEmptyProperties({ Policies: value }).has('Policies')).toBe(false);
  });

  it('an undeclared key is not in the set, and no value is carried', () => {
    const set = declaredEmptyProperties({ Name: '/p', Value: '***', Description: '' });
    expect([...set]).toEqual(['Description']);
  });

  it.each([undefined, null, 'x', ['Policies']])('a non-object record (%s) declares nothing', (v) => {
    expect(declaredEmptyProperties(v).size).toBe(0);
  });
});
