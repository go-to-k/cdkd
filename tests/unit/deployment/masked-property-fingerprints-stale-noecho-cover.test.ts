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
    resolvedHash: unknown,
    macVerdict?: () => Promise<'confirmed' | 'changed' | 'none'>
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
      ...(macVerdict !== undefined && { macVerdict }),
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
    it("the record's value MACs of `A` decide: confirmed is proven, changed is a move", async () => {
      const then = { A: 'h,t-1' };
      expect(await shaped(SHAPE, ['A'], [], then, then, 'h', async () => 'confirmed')).toBe('proven');
      expect(await shaped(SHAPE, ['A'], [], then, then, 'h', async () => 'changed')).toBe('moved');
      expect(await shaped(SHAPE, ['A'], [], then, then, 'h', async () => 'none')).toBe('unprovable');
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

  describe('a stale leaf reading more parameters than the subset cap', () => {
    // Seven parameters, all NoEcho when recorded; only `B` is still NoEcho.
    const NAMES = ['A', 'C', 'D', 'E', 'F', 'G', 'H'];
    const SHAPE = [
      { AttributeName: { 'Fn::Join': [':', NAMES.map((name) => ({ Ref: name }))] }, KeyType: 'HASH' },
      { AttributeName: { Ref: 'B' }, KeyType: 'RANGE' },
    ];
    const then = Object.fromEntries([...NAMES, 'B'].map((name) => [name, `${name.toLowerCase()}-1`]));
    const resolvedHash = NAMES.map((name) => then[name]).join(':');
    async function cap(todayValues: Record<string, unknown>, plain: readonly string[] = []): Promise<string> {
      const noEchoThen = [...NAMES.filter((name) => !plain.includes(name)), 'B'];
      const declare = (noEcho: readonly string[], values: Record<string, unknown>): MaskedInputSources => {
        const template = {
          Parameters: Object.fromEntries(
            [...NAMES, 'B'].map((name) => [name, { Type: 'String', ...(noEcho.includes(name) && { NoEcho: true }) }])
          ),
          Resources: {},
        };
        return {
          template: template as never,
          parameterInput: parameterInputsFor({ template: template as never, values }).parameterInput,
          resolve: () => Promise.reject(new Error('no input node here')),
        };
      };
      const walked = await maskedInputWalk(SHAPE, declare(noEchoThen, then));
      return staleLeafInputsVerdict({
        record: {
          maskedPropertyFingerprints: { KeySchema: maskedPropertyFingerprint(SHAPE) },
          maskedPropertyInputFingerprints: { KeySchema: walked!.fingerprint },
        },
        key: 'KeySchema',
        templateProps: { KeySchema: SHAPE },
        resolvedProps: { KeySchema: [{ AttributeName: resolvedHash, KeyType: 'HASH' }, { AttributeName: '***', KeyType: 'RANGE' }] },
        staleCoordinates: [['KeySchema', 0, 'AttributeName']],
        sources: declare(['B'], todayValues),
      });
    }
    it('all of them NoEcho then, nothing else moved: the whole set is tried first and proven', async () => {
      expect(await cap(then)).toBe('proven');
      expect(await cap({ ...then, A: 'a-2' })).toBe('proven');
    });
    it('one of them plain then: no subset is enumerated past the cap, so unprovable, never a move', async () => {
      expect(await cap(then, ['A'])).toBe('unprovable');
    });
  });
});
