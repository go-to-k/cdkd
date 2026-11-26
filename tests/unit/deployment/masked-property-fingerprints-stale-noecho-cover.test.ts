/**
 * go-to-k/cdkd#7050 review: `staleLeafInputsUnmoved` re-hashes a key with its
 * stale `NoEcho` leaf's parameter kept as written, and that reproduces the
 * input fingerprint the record took while the parameter was `NoEcho`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  maskedInputWalk,
  maskedPropertyFingerprint,
  parameterInputsFor,
  staleLeafInputsUnmoved,
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

const unmoved = (record: unknown, values: Record<string, unknown>): Promise<boolean> =>
  staleLeafInputsUnmoved({
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

describe('staleLeafInputsUnmoved (#7050 review)', () => {
  it('reproduces the fingerprint recorded while the parameter was NoEcho', async () => {
    const values = { A: 'a-1', Plain: 'p-1' };
    const record = await recordWith(values);
    // Today's plain hash differs (A is hashed as its value)...
    const today = await maskedInputWalk(KEY_SCHEMA, sources(false, values));
    expect(today!.fingerprint).not.toBe(
      (record['maskedPropertyInputFingerprints'] as Record<string, string>)['KeySchema']
    );
    // ...the covered re-hash is the recorded one.
    expect(await unmoved(record, values)).toBe(true);
  });

  it("whatever the stale parameter's value (the readback decides it)", async () => {
    const record = await recordWith({ A: 'a-1', Plain: 'p-1' });
    expect(await unmoved(record, { A: 'a-2', Plain: 'p-1' })).toBe(true);
  });

  it('a moved non-secret input of the sibling leaf is a move', async () => {
    const record = await recordWith({ A: 'a-1', Plain: 'p-1' });
    expect(await unmoved(record, { A: 'a-1', Plain: 'p-2' })).toBe(false);
  });

  it('nothing to compare: no recorded input fingerprint, or no parameter at the stale leaf', async () => {
    const record = await recordWith({ A: 'a-1', Plain: 'p-1' });
    const { maskedPropertyInputFingerprints: _dropped, ...older } = record;
    expect(await unmoved(older, { A: 'a-1', Plain: 'p-1' })).toBe(false);
    expect(
      await staleLeafInputsUnmoved({
        record,
        key: 'KeySchema',
        templateProps: { KeySchema: KEY_SCHEMA },
        resolvedProps: { KeySchema: [{ AttributeName: 'x', KeyType: 'HASH' }, {}] },
        staleCoordinates: [['KeySchema', 0, 'KeyType']],
        sources: sources(false, { A: 'a-1', Plain: 'p-1' }),
      })
    ).toBe(false);
  });
});
