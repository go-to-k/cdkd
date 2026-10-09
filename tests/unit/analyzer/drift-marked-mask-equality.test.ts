import { describe, it, expect } from 'vite-plus/test';
import { equalModuloMarkedMask } from '../../../src/analyzer/drift-calculator.js';

/**
 * go-to-k/cdkd#4043 Phase C: at a marked coordinate the masked state matches
 * the live value; at a strict ANCESTOR of one (a list masked whole because no
 * identity field paired it) only the masked leaves are opaque.
 */
const MASK = '***';

function predicates(marked: (string | number)[][]) {
  const same = (a: readonly (string | number)[], b: readonly (string | number)[], n: number) =>
    a.slice(0, n).every((s, i) => String(s) === String(b[i]));
  const isWithinMarked = (c: readonly (string | number)[]) =>
    marked.some((leaf) => leaf.length <= c.length && same(leaf, c, leaf.length));
  const isMarked = (c: readonly (string | number)[]) =>
    isWithinMarked(c) || marked.some((leaf) => leaf.length > c.length && same(c, leaf, c.length));
  return { isMarked, isWithinMarked };
}

function equal(state: unknown, aws: unknown, coordinate: string[], marked: (string | number)[][]) {
  const { isMarked, isWithinMarked } = predicates(marked);
  return equalModuloMarkedMask(state, aws, MASK, coordinate, isMarked, isWithinMarked);
}

describe('equalModuloMarkedMask at a marked coordinate and at an ancestor (#4043)', () => {
  it('AT a marked list coordinate, a wholly masked value matches any present live value', () => {
    const state = [{ Key: MASK, Value: null, N: MASK, Extra: [] }];
    expect(equal(state, 7741, ['Tags'], [['Tags']])).toBe(true);
    expect(equal(state, [{ Key: 'k', Value: 3 }], ['Tags'], [['Tags']])).toBe(true);
  });

  it('at an ANCESTOR, a list whose shape is unchanged matches', () => {
    expect(
      equal([{ Name: MASK, Extra: null }], [{ Name: 'sec', Extra: null }], ['Tags'], [['Tags', 0, 'Name']])
    ).toBe(true);
  });

  it('at an ANCESTOR, an element added to a public sibling list is still drift', () => {
    expect(
      equal([{ Name: MASK, Tags: [] }], [{ Name: 'sec', Tags: ['added'] }], ['L'], [['L', 0, 'Name']])
    ).toBe(false);
  });

  it('at an ANCESTOR, a public null that became a value is still drift', () => {
    expect(equal([MASK, null], ['sec', 'added'], ['L'], [['L', 0]])).toBe(false);
  });

  it('at an ANCESTOR, a list that grew is still drift', () => {
    expect(equal([MASK], ['sec', 'more'], ['L'], [['L', 0]])).toBe(false);
  });

  it('a container holding no mask is compared as is', () => {
    expect(equal(['a', 'b'], ['a', 'c'], ['L'], [['L', 0]])).toBe(false);
  });
});
