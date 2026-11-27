/**
 * go-to-k/cdkd#7050 review: `staleLeafInputsVerdict` re-hashes a key with its
 * stale `NoEcho` leaf's parameter kept as written, and that reproduces the
 * input fingerprint the record took while the parameter was `NoEcho`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  maskedInputWalk,
  maskedPropertyFingerprint,
  parameterInputsFor,
  staleLeafInputsVerdict,
  type MaskedInputSources,
} from '../../../src/deployment/masked-property-fingerprints.js';
import { MAX_STALE_REHASHES } from '../../../src/deployment/masked-property-fingerprints/stale-noecho-cover.js';

const KEY_SCHEMA = [
  { AttributeName: { Ref: 'A' }, KeyType: 'HASH' },
  { AttributeName: { 'Fn::Join': ['_', ['{{resolve:ssm-secure:/s}}', { Ref: 'Plain' }]] }, KeyType: 'RANGE' },
];

function sources(aNoEcho: boolean, values: Record<string, unknown>): MaskedInputSources {
  const template = {
    Parameters: {
      A: { Type: 'String', ...(aNoEcho && { NoEcho: true }) },
      Plain: { Type: 'String' },
    },
    Resources: {},
  };
  return {
    template: template as never,
    parameterInput: parameterInputsFor({ template: template as never, values }).parameterInput,
    resolve: () => Promise.reject(new Error('no input node here')),
  };
}

/** The record the deploy wrote while `A` was `NoEcho`. */
async function recordWith(values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const walked = await maskedInputWalk(KEY_SCHEMA, sources(true, values));
  return {
    properties: {
      KeySchema: [
        { AttributeName: '***', KeyType: 'HASH' },
        { AttributeName: '***', KeyType: 'RANGE' },
      ],
    },
    maskedPropertyFingerprints: { KeySchema: maskedPropertyFingerprint(KEY_SCHEMA) },
    maskedPropertyInputFingerprints: { KeySchema: walked!.fingerprint },
    noEchoLeaves: [['KeySchema', 0, 'AttributeName']],
  };
}

const unmoved = (record: unknown, values: Record<string, unknown>): Promise<string> =>
  staleLeafInputsVerdict({
    record,
    key: 'KeySchema',
    templateProps: { KeySchema: KEY_SCHEMA },
    resolvedProps: {
      KeySchema: [
        { AttributeName: values['A'], KeyType: 'HASH' },
        { AttributeName: `secret_${String(values['Plain'])}`, KeyType: 'RANGE' },
      ],
    },
    staleCoordinates: [['KeySchema', 0, 'AttributeName']],
    sources: sources(false, values),
  });

describe('staleLeafInputsVerdict (#7050 review)', () => {
  it('reproduces the fingerprint recorded while the parameter was NoEcho', async () => {
    const values = { A: 'a-1', Plain: 'p-1' };
    const record = await recordWith(values);
    // Today's plain hash differs (A is hashed as its value)...
    const today = await maskedInputWalk(KEY_SCHEMA, sources(false, values));
    expect(today!.fingerprint).not.toBe(
      (record['maskedPropertyInputFingerprints'] as Record<string, string>)['KeySchema']
    );
    // ...the covered re-hash is the recorded one.
    expect(await unmoved(record, values)).toBe('proven');
  });

  it("whatever the stale parameter's value (the readback decides it)", async () => {
    const record = await recordWith({ A: 'a-1', Plain: 'p-1' });
    expect(await unmoved(record, { A: 'a-2', Plain: 'p-1' })).toBe('proven');
  });

  it('a moved non-secret input of the sibling leaf is a move', async () => {
    const record = await recordWith({ A: 'a-1', Plain: 'p-1' });
    expect(await unmoved(record, { A: 'a-1', Plain: 'p-2' })).toBe('moved');
  });

  it('nothing to compare: no recorded input fingerprint, or no parameter at the stale leaf', async () => {
    const record = await recordWith({ A: 'a-1', Plain: 'p-1' });
    const { maskedPropertyInputFingerprints: _dropped, ...older } = record;
    expect(await unmoved(older, { A: 'a-1', Plain: 'p-1' })).toBe('moved');
    expect(
      await staleLeafInputsVerdict({
        record,
        key: 'KeySchema',
        templateProps: { KeySchema: KEY_SCHEMA },
        resolvedProps: { KeySchema: [{ AttributeName: 'x', KeyType: 'HASH' }, {}] },
        staleCoordinates: [['KeySchema', 0, 'KeyType']],
        sources: sources(false, { A: 'a-1', Plain: 'p-1' }),
      })
    ).toBe('moved');
  });

  // A key whose parameters other than the stale one are declared by the shape.
  async function shaped(
    keySchema: unknown,
    noEchoThen: readonly string[],
    plain: readonly string[],
    recordedValues: Record<string, unknown>,
    todayValues: Record<string, unknown>,
    resolvedHash: unknown
  ): Promise<string> {
    const declare = (noEcho: readonly string[]): MaskedInputSources => {
      const template = {
        Parameters: Object.fromEntries(
          [...noEchoThen, ...plain].map((name) => [name, { Type: 'String', ...(noEcho.includes(name) && { NoEcho: true }) }])
        ),
        Resources: {},
      };
      const values = noEcho === noEchoThen ? recordedValues : todayValues;
      return {
        template: template as never,
        parameterInput: parameterInputsFor({ template: template as never, values }).parameterInput,
        resolve: () => Promise.reject(new Error('no input node here')),
      };
    };
    const walked = await maskedInputWalk(keySchema, declare(noEchoThen));
    return staleLeafInputsVerdict({
      record: {
        maskedPropertyFingerprints: { KeySchema: maskedPropertyFingerprint(keySchema) },
        maskedPropertyInputFingerprints: { KeySchema: walked!.fingerprint },
      },
      key: 'KeySchema',
      templateProps: { KeySchema: keySchema },
      resolvedProps: { KeySchema: [{ AttributeName: resolvedHash, KeyType: 'HASH' }, { AttributeName: '***', KeyType: 'RANGE' }] },
      staleCoordinates: [['KeySchema', 0, 'AttributeName']],
      // Today only `B` is still NoEcho.
      sources: declare(noEchoThen.filter((name) => name !== 'A')),
    });
  }

  describe('a plain parameter beside the stale one in its leaf was hashed by its value', () => {
    const SHAPE = [
      { AttributeName: { 'Fn::Join': [':', [{ Ref: 'User' }, { Ref: 'A' }]] }, KeyType: 'HASH' },
      { AttributeName: { Ref: 'B' }, KeyType: 'RANGE' },
    ];
    const then = { A: 'a-1', B: 'b-1', User: 'u-1' };
    it('nothing moved: proven', async () => {
      expect(await shaped(SHAPE, ['A', 'B'], ['User'], then, then, 'u-1:a-1')).toBe('proven');
    });
    it('`User` moved: a move', async () => {
      expect(await shaped(SHAPE, ['A', 'B'], ['User'], then, { ...then, User: 'u-2' }, 'u-2:a-1')).toBe('moved');
    });
  });

  describe('a stale parameter the key also reads outside its stale leaf is never covered', () => {
    // The stale leaf drops all but the first element of `A`; the sibling
    // masked leaf reads `A` whole, and no readback compares it there.
    const SHAPE = [
      { AttributeName: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'A' }] }] }, KeyType: 'HASH' },
      { AttributeName: { 'Fn::Sub': '{{resolve:ssm-secure:${A}}}' }, KeyType: 'RANGE' },
    ];
    it('`A` moved in the part the stale leaf drops: unprovable, never proven unmoved', async () => {
      expect(await shaped(SHAPE, ['A'], [], { A: 'h,t-1' }, { A: 'h,t-2' }, 'h')).toBe('unprovable');
    });
    it('nothing moved: unprovable all the same (no value evidence for `A`), never a move', async () => {
      expect(await shaped(SHAPE, ['A'], [], { A: 'h,t-1' }, { A: 'h,t-1' }, 'h')).toBe('unprovable');
    });
    it('a plain parameter beside it moved: a move, whatever `A` was', async () => {
      const shape = [
        { AttributeName: { 'Fn::Join': [':', [{ Ref: 'User' }, { Ref: 'A' }]] }, KeyType: 'HASH' },
        { AttributeName: { 'Fn::Sub': '{{resolve:ssm-secure:${A}}}' }, KeyType: 'RANGE' },
      ];
      const then = { A: 'a-1', User: 'u-1' };
      expect(await shaped(shape, ['A'], ['User'], then, then, 'u-1:a-1')).toBe('unprovable');
      expect(await shaped(shape, ['A'], ['User'], then, { ...then, User: 'u-2' }, 'u-2:a-1')).toBe('moved');
    });
  });

  describe('a stale leaf reading many parameters: subsets largest first, within the re-hash budget', () => {
    // All NoEcho when recorded but `plain`; only `B` is still NoEcho.
    async function many(
      names: readonly string[],
      plain: readonly string[],
      moved: Record<string, unknown> = {}
    ): Promise<string> {
      const shape = [
        { AttributeName: { 'Fn::Join': [':', names.map((name) => ({ Ref: name }))] }, KeyType: 'HASH' },
        { AttributeName: { Ref: 'B' }, KeyType: 'RANGE' },
      ];
      const then = Object.fromEntries([...names, 'B'].map((name) => [name, `${name.toLowerCase()}-1`]));
      const noEchoThen = [...names.filter((name) => !plain.includes(name)), 'B'];
      const declare = (noEcho: readonly string[], values: Record<string, unknown>): MaskedInputSources => {
        const template = {
          Parameters: Object.fromEntries(
            [...names, 'B'].map((name) => [name, { Type: 'String', ...(noEcho.includes(name) && { NoEcho: true }) }])
          ),
          Resources: {},
        };
        return {
          template: template as never,
          parameterInput: parameterInputsFor({ template: template as never, values }).parameterInput,
          resolve: () => Promise.reject(new Error('no input node here')),
        };
      };
      const walked = await maskedInputWalk(shape, declare(noEchoThen, then));
      const today = { ...then, ...moved };
      return staleLeafInputsVerdict({
        record: {
          maskedPropertyFingerprints: { KeySchema: maskedPropertyFingerprint(shape) },
          maskedPropertyInputFingerprints: { KeySchema: walked!.fingerprint },
        },
        key: 'KeySchema',
        templateProps: { KeySchema: shape },
        resolvedProps: {
          KeySchema: [
            { AttributeName: names.map((name) => today[name]).join(':'), KeyType: 'HASH' },
            { AttributeName: '***', KeyType: 'RANGE' },
          ],
        },
        staleCoordinates: [['KeySchema', 0, 'AttributeName']],
        sources: declare(['B'], today),
      });
    }
    const SEVEN = ['A', 'C', 'D', 'E', 'F', 'G', 'H'];
    const TWELVE = [...SEVEN, 'I', 'J', 'K', 'L', 'M'];
    it('seven, all NoEcho then: the whole set is tried first and proven, whatever the stale values', async () => {
      expect(await many(SEVEN, [])).toBe('proven');
      expect(await many(SEVEN, [], { A: 'a-2' })).toBe('proven');
    });
    it('seven, one plain then: the subset without it is proven; that plain one moved is a move, never unprovable', async () => {
      expect(await many(SEVEN, ['A'])).toBe('proven');
      expect(await many(SEVEN, ['A'], { A: 'a-2' })).toBe('moved');
    });
    it('twelve, two plain then: the matching subset of ten is within the budget', async () => {
      expect(MAX_STALE_REHASHES).toBe(1024);
      expect(await many(TWELVE, ['A', 'C'])).toBe('proven');
      expect(await many(TWELVE, ['A', 'C'], { C: 'c-2' })).toBe('moved');
    });
    it('twelve, five plain then: the matching subset of seven lies past the budget, so a move, never unprovable', async () => {
      expect(await many(TWELVE, ['A', 'C', 'D', 'E', 'F'])).toBe('moved');
    });
  });

  describe('many parameters with some also read outside the stale leaf: the budget spans both phases', () => {
    // The stale leaf joins `inside` and `outside`; the sibling masked leaf
    // reads every `outside` one too. All NoEcho when recorded but `plain`;
    // none is NoEcho today.
    async function spanning(
      inside: readonly string[],
      outside: readonly string[],
      plain: readonly string[],
      moved: Record<string, unknown> = {}
    ): Promise<string> {
      const names = [...inside, ...outside];
      const shape = [
        { AttributeName: { 'Fn::Join': [':', names.map((name) => ({ Ref: name }))] }, KeyType: 'HASH' },
        {
          AttributeName: { 'Fn::Sub': `{{resolve:ssm-secure:${outside.map((name) => `\${${name}}`).join('-')}}}` },
          KeyType: 'RANGE',
        },
      ];
      const then = Object.fromEntries(names.map((name) => [name, `${name.toLowerCase()}-1`]));
      const declare = (noEcho: readonly string[], values: Record<string, unknown>): MaskedInputSources => {
        const template = {
          Parameters: Object.fromEntries(
            names.map((name) => [name, { Type: 'String', ...(noEcho.includes(name) && { NoEcho: true }) }])
          ),
          Resources: {},
        };
        return {
          template: template as never,
          parameterInput: parameterInputsFor({ template: template as never, values }).parameterInput,
          resolve: () => Promise.reject(new Error('no input node here')),
        };
      };
      const walked = await maskedInputWalk(shape, declare(names.filter((name) => !plain.includes(name)), then));
      const today = { ...then, ...moved };
      return staleLeafInputsVerdict({
        record: {
          maskedPropertyFingerprints: { KeySchema: maskedPropertyFingerprint(shape) },
          maskedPropertyInputFingerprints: { KeySchema: walked!.fingerprint },
        },
        key: 'KeySchema',
        templateProps: { KeySchema: shape },
        resolvedProps: {
          KeySchema: [
            { AttributeName: names.map((name) => today[name]).join(':'), KeyType: 'HASH' },
            { AttributeName: '***', KeyType: 'RANGE' },
          ],
        },
        staleCoordinates: [['KeySchema', 0, 'AttributeName']],
        sources: declare([], today),
      });
    }
    const TEN = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    it('ten inside plus one outside, nothing moved: the whole set matches although the inside enumeration fills the budget', async () => {
      expect(await spanning(TEN, ['X'], [])).toBe('unprovable');
    });
    it('one inside plus ten outside, a plain one moved: the outside enumeration exhausts the budget, so a move, never unprovable', async () => {
      expect(await spanning(['User'], TEN, ['User'], { User: 'user-2' })).toBe('moved');
    });
  });
});
