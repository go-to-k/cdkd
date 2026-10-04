import { describe, it, expect } from 'vite-plus/test';
import {
  backfillMaskedPropertyFingerprints,
  markWrittenFromDeployedTemplate,
  maskedPropertyFingerprint,
  maskedPropertyFingerprintsFor,
  maskedPropertyFingerprintsOf,
  movedMaskedProperties,
  withMaskedPropertyFingerprints,
} from '../../../src/deployment/masked-property-fingerprints.js';
import type { ResourceState } from '../../../src/types/state.js';

/** go-to-k/cdkd#4451: the helpers behind `ResourceState.maskedPropertyFingerprints`. */
const SCRIPT = { 'Fn::Base64': { 'Fn::Join': ['', ['pw=', '{{resolve:ssm-secure:/app/pw}}']] } };
const EDITED = { 'Fn::Base64': { 'Fn::Join': ['', ['echo B\npw=', '{{resolve:ssm-secure:/app/pw}}']] } };

const record = (extra: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: 'p',
  resourceType: 'AWS::SSM::Parameter',
  properties: { Name: '/app/ud', Value: '***' },
  ...extra,
});

describe('maskedPropertyFingerprint', () => {
  it('is key-order free and sha256-prefixed', () => {
    const a = maskedPropertyFingerprint({ x: 1, y: [{ b: 2, a: 1 }] });
    const b = maskedPropertyFingerprint({ y: [{ a: 1, b: 2 }], x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('moves with any edit to the expression, including a retarget of the reference', () => {
    const retarget = {
      'Fn::Base64': { 'Fn::Join': ['', ['pw=', '{{resolve:ssm-secure:/app/other}}']] },
    };
    const seen = new Set([SCRIPT, EDITED, retarget].map((v) => maskedPropertyFingerprint(v)));
    expect(seen.size).toBe(3);
  });

  it('reads an undefined member as absent, as the serialized template does', () => {
    expect(maskedPropertyFingerprint({ a: 1, b: undefined })).toBe(
      maskedPropertyFingerprint({ a: 1 })
    );
  });
});

describe('maskedPropertyFingerprintsFor', () => {
  it('fingerprints only the properties the record holds masked, from the TEMPLATE value', () => {
    expect(
      maskedPropertyFingerprintsFor(
        { Name: '/app/ud', Value: '***', Tags: [{ Key: 'k', Value: '***' }] },
        { Name: '/app/ud', Value: SCRIPT, Tags: [{ Key: 'k', Value: { Ref: 'P' } }] }
      )
    ).toEqual({
      Value: maskedPropertyFingerprint(SCRIPT),
      Tags: maskedPropertyFingerprint([{ Key: 'k', Value: { Ref: 'P' } }]),
    });
  });

  it('is undefined when nothing is masked, so the record carries no field', () => {
    expect(maskedPropertyFingerprintsFor({ Name: '/app/ud' }, { Name: '/app/ud' })).toBeUndefined();
  });

  it('keeps a template-controlled `__proto__` property an own key', () => {
    const recorded = JSON.parse('{"__proto__": "***"}') as Record<string, unknown>;
    const template = JSON.parse('{"__proto__": {"Ref": "X"}}') as Record<string, unknown>;
    const out = maskedPropertyFingerprintsFor(recorded, template)!;
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('maskedPropertyFingerprintsOf', () => {
  it('reads an absent or malformed field, or entry, as no fingerprint', () => {
    expect(maskedPropertyFingerprintsOf(record()).size).toBe(0);
    for (const bad of [null, 'x', 5, ['sha256:x']]) {
      expect(
        maskedPropertyFingerprintsOf({ ...record(), maskedPropertyFingerprints: bad }).size
      ).toBe(0);
    }
    expect([
      ...maskedPropertyFingerprintsOf({
        ...record(),
        maskedPropertyFingerprints: { Value: 'sha256:a', Bad: 7 },
      }),
    ]).toEqual([['Value', 'sha256:a']]);
  });
});

describe('movedMaskedProperties', () => {
  const stamped = record({ maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(SCRIPT) } });

  it('names a masked property whose template expression moved', () => {
    expect(movedMaskedProperties(stamped, { Name: '/app/ud', Value: EDITED })).toEqual(['Value']);
  });

  it('is empty for the unchanged expression (a rotated secret moves nothing)', () => {
    expect(movedMaskedProperties(stamped, { Name: '/app/ud', Value: SCRIPT })).toEqual([]);
  });

  it('is empty for a record without the field: the pre-#4451 comparison', () => {
    expect(movedMaskedProperties(record(), { Name: '/app/ud', Value: EDITED })).toEqual([]);
  });

  it('leaves a removed property, or one no longer masked, to the ordinary comparison', () => {
    expect(movedMaskedProperties(stamped, { Name: '/app/ud' })).toEqual([]);
    expect(
      movedMaskedProperties(
        { ...stamped, properties: { Name: '/app/ud', Value: 'plain' } },
        { Name: '/app/ud', Value: EDITED }
      )
    ).toEqual([]);
  });
});

describe('withMaskedPropertyFingerprints', () => {
  const template = { Name: '/app/ud', Value: EDITED };

  it('rebuilds the field only for a bag this deploy wrote', () => {
    const previous = record({
      maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(SCRIPT) },
    });
    const written = markWrittenFromDeployedTemplate({ Name: '/app/ud', Value: 'encoded' });
    expect(withMaskedPropertyFingerprints(previous, written, template)).toEqual({
      ...previous,
      maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(EDITED) },
    });
    // A bag it did not write (a failed update keeps the previous one) keeps
    // the previous fingerprint.
    expect(withMaskedPropertyFingerprints(previous, { ...written }, template)).toBe(previous);
    // So does a record not resolved this deploy.
    expect(withMaskedPropertyFingerprints(previous, written, undefined)).toBe(previous);
  });

  it('clears the field when the written record holds nothing masked', () => {
    const previous = {
      ...record({ maskedPropertyFingerprints: { Value: 'sha256:old' } }),
      properties: { Name: '/app/ud', Value: 'plain' },
    };
    const written = markWrittenFromDeployedTemplate({ Name: '/app/ud', Value: 'plain' });
    const out = withMaskedPropertyFingerprints(previous, written, { Name: '/app/ud', Value: 'plain' });
    expect(Object.hasOwn(out, 'maskedPropertyFingerprints')).toBe(false);
  });
});

describe('backfillMaskedPropertyFingerprints', () => {
  const template = {
    Resources: {
      R: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/app/ud', Value: SCRIPT } },
      Other: { Type: 'AWS::SNS::Topic', Properties: { TopicName: '***' } },
    },
  };

  it('stamps a field-less record from today\'s template and counts it', () => {
    const resources: Record<string, ResourceState> = { R: record() };
    const before = resources['R'];
    expect(backfillMaskedPropertyFingerprints(resources, template)).toBe(1);
    expect(resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: maskedPropertyFingerprint(SCRIPT),
    });
    // The record object is replaced, not mutated.
    expect(before!.maskedPropertyFingerprints).toBeUndefined();
  });

  it('leaves a record that has the field, malformed included', () => {
    for (const field of [{ Value: 'sha256:x' }, 'garbage']) {
      const resources = {
        R: { ...record(), maskedPropertyFingerprints: field } as unknown as ResourceState,
      };
      expect(backfillMaskedPropertyFingerprints(resources, template)).toBe(0);
      expect(resources.R.maskedPropertyFingerprints).toBe(field);
    }
  });

  it('skips a record the template drops, retypes, or that holds nothing masked', () => {
    const resources: Record<string, ResourceState> = {
      Gone: record(),
      Other: record(), // template type is SNS::Topic, record type SSM::Parameter
      Plain: { ...record(), properties: { Name: 'x' } },
    };
    expect(
      backfillMaskedPropertyFingerprints(resources, {
        Resources: { ...template.Resources, Plain: template.Resources.R },
      })
    ).toBe(0);
    expect(backfillMaskedPropertyFingerprints(resources, undefined)).toBe(0);
  });
});
