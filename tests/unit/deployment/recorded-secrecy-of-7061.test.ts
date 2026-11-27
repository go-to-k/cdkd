/**
 * go-to-k/cdkd#7061: `recordedSecrecyOf`, the record-provenance answer for one
 * position of a record's bags. `masked` when the value carries a redaction
 * marker or a provenance field names the position, `unknown` when there is no
 * readable record, `clear` otherwise.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  recordedSecrecyOf,
  type RecordedSecrecySource,
} from '../../../src/deployment/secret-redaction/recorded-secrecy.js';
import { buildReadCurrentStateContext } from '../../../src/deployment/read-current-state-context.js';

const P = (record: RecordedSecrecySource | undefined, key = 'K') =>
  recordedSecrecyOf(record, { field: 'properties', key });
const A = (record: RecordedSecrecySource | undefined, key = 'K') =>
  recordedSecrecyOf(record, { field: 'attributes', key });

describe('recordedSecrecyOf (#7061)', () => {
  it.each<[string, RecordedSecrecySource | undefined]>([
    ['no record', undefined],
    ['a bag that is not an object', { properties: 'x' }],
    ['a bag that is a list', { properties: ['x'] }],
    ['a null bag', { properties: null }],
  ])('is unknown for %s', (_what, record) => {
    expect(P(record)).toBe('unknown');
  });

  it.each<[string, unknown]>([
    ['the mask', '***'],
    ['the mask nested', { a: ['x', '***'] }],
    ['an embedded mask (a redacted piece)', 'arn:***'],
    ['a dynamic reference', 'x-{{resolve:ssm:/p}}'],
    ['a nested dynamic reference', { a: '{{resolve:secretsmanager:s}}' }],
  ])('is masked when the value carries %s', (_what, value) => {
    expect(P({ properties: { K: value } })).toBe('masked');
    expect(A({ attributes: { K: value } })).toBe('masked');
  });

  it.each<[string, RecordedSecrecySource]>([
    ['a NoEcho coordinate at the key', { properties: { K: 'plain' }, noEchoLeaves: [['K']] }],
    ['a NoEcho coordinate under the key', { properties: { K: { a: 'plain' } }, noEchoLeaves: [['K', 'a']] }],
    ['a masked-property fingerprint', { properties: { K: 'plain' }, maskedPropertyFingerprints: { K: 'sha256:00' } }],
  ])('is masked for a plain property when %s names it', (_what, record) => {
    expect(P(record)).toBe('masked');
  });

  it('is masked for a plain attribute its provider declared NoEcho', () => {
    expect(A({ attributes: { K: 'plain' }, noEchoAttributeNames: ['K'] })).toBe('masked');
  });

  it.each<[string, RecordedSecrecySource]>([
    ['a plain value', { properties: { K: 'plain' } }],
    ['a missing key', { properties: {} }],
    ['a NoEcho coordinate of another key', { properties: { K: 'plain' }, noEchoLeaves: [['L']] }],
    ['a fingerprint of another key', { properties: { K: 'plain' }, maskedPropertyFingerprints: { L: 'x' } }],
    ['malformed provenance', { properties: { K: 'plain' }, noEchoLeaves: 'K', maskedPropertyFingerprints: ['K'] }],
    ['an attribute name only (on properties)', { properties: { K: 'plain' }, noEchoAttributeNames: ['K'] }],
  ])('is clear for %s', (_what, record) => {
    expect(P(record)).toBe('clear');
  });

  it('reads attribute provenance only for attributes, and property provenance only for properties', () => {
    expect(A({ attributes: { K: 'plain' }, noEchoLeaves: [['K']], maskedPropertyFingerprints: { K: 'x' } })).toBe('clear');
    expect(A({ attributes: { K: 'plain' }, noEchoAttributeNames: 'K' })).toBe('clear');
  });
});

describe('buildReadCurrentStateContext carries the own record provenance (#7061)', () => {
  const record = (extra: Record<string, unknown>) => ({
    resources: {
      Self: { resourceType: 'AWS::EC2::Instance', physicalId: 'i-1', properties: {}, attributes: {}, ...extra },
    },
  });

  it('hands a provider the own noEchoLeaves and maskedPropertyFingerprints', () => {
    const context = buildReadCurrentStateContext(
      record({ noEchoLeaves: [['UserData']], maskedPropertyFingerprints: { UserData: 'sha256:00' } }) as never,
      'Self'
    );
    expect(context.provenance).toEqual({
      noEchoLeaves: [['UserData']],
      maskedPropertyFingerprints: { UserData: 'sha256:00' },
    });
  });

  it('sets none for a record holding neither', () => {
    expect(buildReadCurrentStateContext(record({}) as never, 'Self')).not.toHaveProperty('provenance');
  });
});
