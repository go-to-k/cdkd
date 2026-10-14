/**
 * go-to-k/cdkd#4847: the pieces the rollback replay, `cdkd drift` and `cdkd
 * scrub` share to resolve a token in the region its v12 record names.
 */
import { describe, it, expect } from 'vite-plus/test';
import { classifyRecordedSecretRegion } from '../../../src/deployment/secret-region-classification.js';
import {
  keepHeldTokenProvenance,
  recordedOutputReferenceRegions,
  recordedReferenceRegions,
} from '../../../src/deployment/reference-provenance-record.js';
import { withoutSsmSelector } from '../../../src/deployment/intrinsic-resolver/dynamic-ref-lookups.js';
import type { ResourceState } from '../../../src/types/state.js';

const NAME = '{{resolve:secretsmanager:app:SecretString:k::}}';
const WEST_ARN =
  '{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:app-AbCdEf:SecretString:k::}}';

describe('classifyRecordedSecretRegion', () => {
  const recorded = new Map([
    [NAME, 'eu-west-1'],
    [WEST_ARN, 'eu-west-1'],
  ]);

  it('a recorded foreign region: recorded-region, never ambiguous', () => {
    expect(classifyRecordedSecretRegion(NAME, 'us-east-1', ['us-west-2'], recorded)).toEqual({
      kind: 'recorded-region',
      region: 'eu-west-1',
    });
  });

  it("a recorded region equal to the stack's: local", () => {
    expect(
      classifyRecordedSecretRegion(NAME, 'eu-west-1', ['us-west-2'], recorded)
    ).toEqual({ kind: 'local' });
  });

  it('an ARN names its own region, which binds over the recorded one', () => {
    expect(classifyRecordedSecretRegion(WEST_ARN, 'us-east-1', undefined, recorded)).toMatchObject({
      kind: 'named-region',
      region: 'us-west-2',
    });
  });

  it('no recorded region: the replay classifier', () => {
    expect(classifyRecordedSecretRegion(NAME, 'us-east-1', ['us-west-2'], undefined)).toMatchObject({
      kind: 'ambiguous',
    });
  });
});

describe('recorded regions of a record / an output', () => {
  it('only valid regions, and none for a record without the field', () => {
    expect(recordedReferenceRegions({ properties: {} })).toBeUndefined();
    expect(
      recordedReferenceRegions({
        referenceProvenance: { [NAME]: { region: 'eu-west-1' }, [WEST_ARN]: { region: 'EU' } },
      })
    ).toEqual(new Map([[NAME, 'eu-west-1']]));
    expect(
      recordedOutputReferenceRegions(
        { outputReferenceProvenance: { Out: { [NAME]: { region: 'eu-west-1' } } } },
        'Out'
      )
    ).toEqual(new Map([[NAME, 'eu-west-1']]));
    expect(recordedOutputReferenceRegions({ outputs: {} }, 'Out')).toBeUndefined();
  });
});

describe('keepHeldTokenProvenance', () => {
  const record = (field: unknown): ResourceState =>
    ({
      physicalId: 'p',
      resourceType: 'T',
      properties: { A: NAME },
      attributes: {},
      dependencies: [],
      referenceProvenance: field,
    }) as ResourceState;

  it('drops keys for tokens the record no longer holds, by identity otherwise', () => {
    const held = record({ [NAME]: { region: 'eu-west-1' } });
    expect(keepHeldTokenProvenance(held)).toBe(held);
    expect(keepHeldTokenProvenance(record({ [NAME]: {}, [WEST_ARN]: {} })).referenceProvenance).toEqual({
      [NAME]: {},
    });
  });

  it('adds nothing to a record without the field', () => {
    const bare = { physicalId: 'p', resourceType: 'T', properties: { A: NAME } } as ResourceState;
    expect(keepHeldTokenProvenance(bare)).toBe(bare);
  });
});

describe('withoutSsmSelector', () => {
  it.each([
    ['/app/pw', '/app/pw'],
    ['/app/pw:3', '/app/pw'],
    ['/app/pw:label', '/app/pw'],
    ['arn:aws:ssm:us-east-1:1:parameter/app/pw', 'arn:aws:ssm:us-east-1:1:parameter/app/pw'],
    ['arn:aws:ssm:us-east-1:1:parameter/app/pw:7', 'arn:aws:ssm:us-east-1:1:parameter/app/pw'],
  ])('%s -> %s', (input, expected) => {
    expect(withoutSsmSelector(input)).toBe(expected);
  });
});
