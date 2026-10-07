import { describe, expect, it } from 'vite-plus/test';
import {
  SECRET_MASK,
  canonicalCoordinates,
  maskAtCoordinates,
  maskReadbackAtCoordinates,
  maskWholeValue,
  noEchoComparison,
  noEchoOutputsComparison,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  PREVIOUS_NOECHO_VALUE,
  readsNoEchoSource,
  witnessNormalize,
  type NoEchoPositionSources,
  recordPassedNoEchoParameters,
  passedNoEchoParametersOf,
} from '../../../src/deployment/secret-redaction.js';

/**
 * The positional arm of NoEcho redaction (go-to-k/cdkd#4043 Phase B): which
 * leaves a `NoEcho` parameter (or a declared `NoEcho` attribute) served, read
 * off the template bag, and the migration witness.
 */
const P: NoEchoPositionSources = { parameters: new Set(['Token', 'Port', 'List']) };

describe('readsNoEchoSource', () => {
  it('sees a Ref, an Fn::Sub variable, and an operand of any intrinsic', () => {
    expect(readsNoEchoSource({ Ref: 'Token' }, P)).toBe(true);
    expect(readsNoEchoSource({ Ref: 'Other' }, P)).toBe(false);
    expect(readsNoEchoSource({ 'Fn::Sub': 'x-${Token}' }, P)).toBe(true);
    expect(readsNoEchoSource({ 'Fn::Sub': 'x-${!Token}' }, P)).toBe(false);
    expect(readsNoEchoSource({ 'Fn::Sub': ['x-${Token}', { Token: 'lit' }] }, P)).toBe(false);
    expect(readsNoEchoSource({ 'Fn::Sub': ['x-${V}', { V: { Ref: 'Token' } }] }, P)).toBe(true);
    expect(readsNoEchoSource({ 'Fn::Join': ['', ['a', { Ref: 'Token' }]] }, P)).toBe(true);
    // A plain string outside Fn::Sub references nothing.
    expect(readsNoEchoSource('${Token}', P)).toBe(false);
  });

  it('reads only the selected Fn::If branch when the verdict is known (review B5)', () => {
    const node = { 'Fn::If': ['C', { Ref: 'Token' }, 'plain'] };
    expect(readsNoEchoSource(node, { ...P, conditions: { C: false } })).toBe(false);
    expect(readsNoEchoSource(node, { ...P, conditions: { C: true } })).toBe(true);
    // Unknown verdict: both branches.
    expect(readsNoEchoSource(node, P)).toBe(true);
  });
});

describe('noEchoCoordinatesOf', () => {
  it('positions a Ref, an embedding Fn::Sub, a Number and a list, and leaves a same-valued literal alone', () => {
    const template = {
      A: { Ref: 'Token' },
      B: { 'Fn::Sub': 'prefix-${Token}' },
      C: { Ref: 'Port' },
      D: { Ref: 'List' },
      E: 'abc',
      F: { Nested: [{ Name: 'n', Value: { Ref: 'Token' } }] },
    };
    const resolved = {
      A: 'abc',
      B: 'prefix-abc',
      C: 8080,
      D: ['x', 'y'],
      E: 'abc',
      F: { Nested: [{ Name: 'n', Value: 'abc' }] },
    };
    expect(canonicalCoordinates(noEchoCoordinatesOf(template, resolved, P))).toEqual([
      ['A'],
      ['B'],
      ['C'],
      ['D'],
      ['F', 'Nested', 0, 'Value'],
    ]);
  });

  it('opens a known Fn::If and a literal Fn::Select, positioning only the selected operand', () => {
    const template = {
      If: { 'Fn::If': ['C', { Ref: 'Token' }, { Ref: 'Other' }] },
      Sel: { 'Fn::Select': [1, ['lit', { Ref: 'Token' }]] },
      SelOther: { 'Fn::Select': [0, ['lit', { Ref: 'Token' }]] },
    };
    const resolved = { If: 'other', Sel: 'abc', SelOther: 'lit' };
    expect(noEchoCoordinatesOf(template, resolved, { ...P, conditions: { C: false } })).toEqual([
      ['Sel'],
    ]);
    expect(
      canonicalCoordinates(
        noEchoCoordinatesOf(template, { ...resolved, If: 'abc' }, { ...P, conditions: { C: true } })
      )
    ).toEqual([['If'], ['Sel']]);
  });

  it('positions a declared NoEcho attribute only where the leaf IS its Fn::GetAtt', () => {
    const sources: NoEchoPositionSources = {
      parameters: new Set(),
      attributeIsNoEcho: (id, attribute) => id === 'Cr' && attribute === 'Secret',
    };
    const template = {
      Bare: { 'Fn::GetAtt': ['Cr', 'Secret'] },
      Dotted: { 'Fn::GetAtt': 'Cr.Secret' },
      Joined: { 'Fn::Join': ['/', [{ 'Fn::GetAtt': ['Cr', 'Secret'] }, 'x']] },
      Other: { 'Fn::GetAtt': ['Cr', 'Arn'] },
    };
    const resolved = { Bare: 7, Dotted: 'abc', Joined: 'abc/x', Other: 'arn' };
    expect(canonicalCoordinates(noEchoCoordinatesOf(template, resolved, sources))).toEqual([
      ['Bare'],
      ['Dotted'],
    ]);
  });

  it('positions the whole list when an AWS::NoValue element dropped out', () => {
    const template = { L: ['a', { Ref: 'Token' }, { 'Fn::If': ['C', 'b', { Ref: 'AWS::NoValue' }] }] };
    expect(noEchoCoordinatesOf(template, { L: ['a', 'abc'] }, P)).toEqual([['L']]);
  });

  it('skips a leaf the resolution dropped', () => {
    expect(noEchoCoordinatesOf({ A: { Ref: 'Token' } }, {}, P)).toEqual([]);
  });
});

describe('masking', () => {
  it('maskWholeValue keeps shape and masks every scalar', () => {
    expect(maskWholeValue('abc')).toBe(SECRET_MASK);
    expect(maskWholeValue(42)).toBe(SECRET_MASK);
    expect(maskWholeValue(['a', 1])).toEqual([SECRET_MASK, SECRET_MASK]);
    expect(maskWholeValue({ k: true })).toEqual({ k: SECRET_MASK });
    expect(maskWholeValue(null)).toBe(null);
  });

  it('maskAtCoordinates copies only the touched path and never mutates', () => {
    const bag = { A: { B: ['x', 'y'] }, C: { D: 1 } };
    const out = maskAtCoordinates(bag, [['A', 'B', 1]]);
    expect(out).toEqual({ A: { B: ['x', SECRET_MASK] }, C: { D: 1 } });
    expect(bag.A.B[1]).toBe('y');
    expect(out.C).toBe(bag.C);
  });

  it('maskReadbackAtCoordinates finds a reordered element by its identity field, never by bare index (review B4)', () => {
    const properties = { Env: [{ Name: 'A', Value: 'one' }, { Name: 'B', Value: 'secret' }] };
    const readback = { Env: [{ Name: 'B', Value: 'secret' }, { Name: 'A', Value: 'one' }] };
    expect(maskReadbackAtCoordinates(readback, properties, [['Env', 1, 'Value']])).toEqual({
      Env: [{ Name: 'B', Value: SECRET_MASK }, { Name: 'A', Value: 'one' }],
    });
  });

  it('masks the WHOLE readback list when no identity field pairs the two lists', () => {
    const properties = { L: ['one', 'secret'] };
    const readback = { L: ['secret', 'one'] };
    expect(maskReadbackAtCoordinates(readback, properties, [['L', 1]])).toEqual({
      L: [SECRET_MASK, SECRET_MASK],
    });
  });
});

describe('noEchoLeavesOf', () => {
  it('reads a well-formed field and treats a malformed one as absent', () => {
    expect(noEchoLeavesOf({ noEchoLeaves: [['A'], ['B', 0]] })).toEqual([['A'], ['B', 0]]);
    expect(noEchoLeavesOf({})).toBeUndefined();
    expect(noEchoLeavesOf({ noEchoLeaves: ['A'] })).toBeUndefined();
    expect(noEchoLeavesOf({ noEchoLeaves: [[{}]] })).toBeUndefined();
  });
});

describe('witnessNormalize (the migration witness, review B2)', () => {
  it('confirms an equal stored plaintext and keeps a different one', () => {
    const stored = { A: 'old-token', B: 'same', C: 'lit' };
    const today = { A: 'new-token', B: 'same', C: 'lit' };
    const v11 = { A: SECRET_MASK, B: SECRET_MASK, C: 'lit' };
    const result = witnessNormalize(stored, today, v11);
    expect(result.current).toEqual({ A: 'old-token', B: SECRET_MASK, C: 'lit' });
    expect(result.confirmed).toEqual([['B']]);
    expect(result.differing).toEqual([['A']]);
  });

  it('is no witness where the record already holds the mask or nothing', () => {
    const result = witnessNormalize({ A: SECRET_MASK }, { A: 'x', B: 'y' }, {
      A: SECRET_MASK,
      B: SECRET_MASK,
    });
    expect(result.current).toEqual({ A: SECRET_MASK });
    expect(result.confirmed).toEqual([]);
    expect(result.differing).toEqual([]);
  });

  it('compares a number and a list element-wise', () => {
    const result = witnessNormalize(
      { N: 8080, L: ['a', 'b'] },
      { N: 8080, L: ['a', 'c'] },
      { N: SECRET_MASK, L: [SECRET_MASK, SECRET_MASK] }
    );
    expect(result.current).toEqual({ N: SECRET_MASK, L: [SECRET_MASK, 'b'] });
    expect(result.confirmed).toEqual([['N'], ['L', 0]]);
    expect(result.differing).toEqual([['L', 1]]);
  });
});

describe('noEchoComparison', () => {
  const compare = noEchoComparison({
    sources: { parameters: new Set(['Token']) },
    values: { Token: 'tok-1234' },
    minNeedleLength: 4,
  });

  it('masks the desired side as the persist side writes it, and confirms a pre-v11 witness', () => {
    const out = compare({
      templateProperties: { Value: { Ref: 'Token' }, Desc: 'has tok-1234 inside', Other: 'x' },
      desired: { Value: 'tok-1234', Desc: 'has tok-1234 inside', Other: 'x' },
      current: { Value: 'tok-1234', Desc: 'has tok-1234 inside', Other: 'x' },
      record: {},
    });
    expect(out).toEqual({
      desired: { Value: SECRET_MASK, Desc: SECRET_MASK, Other: 'x' },
      current: { Value: SECRET_MASK, Desc: SECRET_MASK, Other: 'x' },
    });
  });

  it('shows a placeholder, never the old plaintext, for a witness that differs', () => {
    const out = compare({
      templateProperties: { Value: { Ref: 'Token' } },
      desired: { Value: 'tok-1234' },
      current: { Value: 'old-value' },
      record: {},
    });
    expect(out?.current).toEqual({ Value: PREVIOUS_NOECHO_VALUE });
    expect(out?.desired).toEqual({ Value: SECRET_MASK });
  });

  it('leaves a v11 record as recorded and compares mask with mask', () => {
    const out = compare({
      templateProperties: { Value: { Ref: 'Token' } },
      desired: { Value: 'tok-1234' },
      current: { Value: SECRET_MASK },
      record: { noEchoLeaves: [['Value']] },
    });
    expect(out).toEqual({ desired: { Value: SECRET_MASK }, current: { Value: SECRET_MASK } });
  });

  it('returns nothing for a resource reading no NoEcho source', () => {
    expect(
      compare({
        templateProperties: { Value: 'lit' },
        desired: { Value: 'lit' },
        current: { Value: 'lit' },
        record: {},
      })
    ).toBeUndefined();
  });
});

describe('noEchoOutputsComparison', () => {
  it('masks an export ALIAS key holding the value of a masked output', () => {
    const compare = noEchoOutputsComparison(
      { Out: { Ref: 'Token' }, Plain: 'x' },
      { parameters: new Set(['Token']) }
    );
    const out = compare(
      { Out: SECRET_MASK, 'exp-alias': SECRET_MASK, Plain: 'x' },
      { Out: 'tok-1234', 'exp-alias': 'tok-1234', Plain: 'x' }
    );
    expect(out.desired).toEqual({ Out: SECRET_MASK, 'exp-alias': SECRET_MASK, Plain: 'x' });
    expect(out.current).toEqual({ Out: SECRET_MASK, 'exp-alias': SECRET_MASK, Plain: 'x' });
  });

  it('masks an output served by a bare GetAtt of a declared NoEcho attribute', () => {
    const compare = noEchoOutputsComparison(
      { Out: { 'Fn::GetAtt': ['Cr', 'Secret'] } },
      {
        parameters: new Set(),
        attributeIsNoEcho: (id, attribute) => id === 'Cr' && attribute === 'Secret',
      }
    );
    const out = compare({ Out: SECRET_MASK }, { Out: 'handler-made-1' });
    expect(out.desired).toEqual({ Out: SECRET_MASK });
    expect(out.masked).toEqual(['Out']);
  });
});

describe('recordPassedNoEchoParameters (review round 9/10)', () => {
  it('records the row keys that read a NoEcho source, and clears the entry on a later empty recording', () => {
    const bag = new Map<string, string>();
    const sources = { parameters: new Set(['Pw']) };
    recordPassedNoEchoParameters(bag, { A: { Ref: 'Pw' }, B: { Ref: 'Plain' } }, sources);
    expect([...(passedNoEchoParametersOf(bag) ?? [])]).toEqual(['A']);
    recordPassedNoEchoParameters(bag, { B: { Ref: 'Plain' } }, sources);
    expect(passedNoEchoParametersOf(bag)).toBeUndefined();
  });
});
