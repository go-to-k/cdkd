/**
 * go-to-k/cdkd#7050: the public `ssm` reference fingerprint's record side.
 *
 * - An entry is bound to the key's INPUT fingerprint (its text fingerprint
 *   when the record holds none): an older cdkd rewrites the input field and
 *   carries this one untouched, so V1 stamped, V2 sent by that older cdkd and
 *   the value back at V1 must not read as unmoved.
 * - A token whose value this pass cannot tell (a producer-region guest's read
 *   files no proof) fails closed once, then settles: the stamped `unknown`
 *   marker compares equal, so the key keeps its text and input comparison
 *   instead of moving on every deploy.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  maskedPropertyFingerprint,
  maskedPropertyReferenceFingerprintsOf,
  maskedReferenceFingerprintsFor,
  publicReferencesMoved,
  type PublicReferenceOf,
  type ReferenceInputs,
} from '../../../src/deployment/masked-property-fingerprints.js';

const TOKEN = '{{resolve:ssm:/pub/pg-host}}';
const VALUE = {
  'Fn::Join': ['', ['{{resolve:ssm:/pub/', { Ref: 'Host' }, '}}', '-x']],
};
const FORM = { 'Fn::Join': ['', ['{{resolve:ssm:/pub/', 'pg-host', '}}', '-x']] };
const TEXT = maskedPropertyFingerprint(VALUE);
const input = (half: string): string => `inputs-sha256:${half.repeat(64)}+${TEXT}`;

const known =
  (value: string): PublicReferenceOf =>
  (token) =>
    token === TOKEN ? { value } : undefined;
const unknown: PublicReferenceOf = () => undefined;

function inputsOf(fingerprint: string | undefined, form: unknown = FORM): ReferenceInputs {
  return Object.assign(async () => fingerprint, { form: async () => form });
}

async function recordAt(
  referenceOf: PublicReferenceOf,
  inputFingerprint: string | undefined
): Promise<Record<string, unknown>> {
  const references = await maskedReferenceFingerprintsFor(
    ['Description'],
    { Description: VALUE },
    referenceOf,
    inputsOf(inputFingerprint)
  );
  return {
    properties: { Description: '***' },
    maskedPropertyFingerprints: { Description: TEXT },
    ...(inputFingerprint !== undefined && {
      maskedPropertyInputFingerprints: { Description: inputFingerprint },
    }),
    maskedPropertyReferenceFingerprints: references,
  };
}

describe('public ssm reference fingerprints (#7050)', () => {
  it('an assembled token name is read from the input walk form', async () => {
    const record = await recordAt(known('v1'), input('1'));
    expect(Object.keys(record['maskedPropertyReferenceFingerprints'] as object)).toEqual([
      'Description',
    ]);
    const moved = (value: string) =>
      publicReferencesMoved(record, 'Description', VALUE, known(value), inputsOf(input('1')));
    expect(await moved('v1')).toBe(false);
    expect(await moved('v2')).toBe(true);
  });

  it('an entry is bound to the input fingerprint: an older cdkd rewrite drops it', async () => {
    const record = await recordAt(known('v1'), input('1'));
    expect(maskedPropertyReferenceFingerprintsOf(record).has('Description')).toBe(true);
    // An older cdkd sent V2 and rewrote the input field, carrying ours as is.
    const rewritten = { ...record, maskedPropertyInputFingerprints: { Description: input('2') } };
    expect(maskedPropertyReferenceFingerprintsOf(rewritten).has('Description')).toBe(false);
    // Back at V1: the stale V1 entry must not read as unmoved.
    expect(
      await publicReferencesMoved(
        rewritten,
        'Description',
        VALUE,
        known('v1'),
        inputsOf(input('2'))
      )
    ).toBe(true);
  });

  it('with no input fingerprint the entry is bound to the text fingerprint', async () => {
    const record = await recordAt(known('v1'), undefined);
    expect(maskedPropertyReferenceFingerprintsOf(record).has('Description')).toBe(true);
    const otherText = { ...record, maskedPropertyFingerprints: { Description: 'sha256:' + '0'.repeat(64) } };
    expect(maskedPropertyReferenceFingerprintsOf(otherText).has('Description')).toBe(false);
  });

  it('a value no proof tells (a producer-region guest) settles once stamped', async () => {
    const proven = await recordAt(known('v1'), input('1'));
    // The first deploy that cannot tell the value fails closed...
    expect(
      await publicReferencesMoved(proven, 'Description', VALUE, unknown, inputsOf(input('1')))
    ).toBe(true);
    // ...and the save stamps the marker, so the next ones compare equal.
    const stamped = await recordAt(unknown, input('1'));
    for (let i = 0; i < 2; i++) {
      expect(
        await publicReferencesMoved(stamped, 'Description', VALUE, unknown, inputsOf(input('1')))
      ).toBe(false);
    }
  });

  it('a name that stays assembled (an input kept as written) settles once stamped', async () => {
    const kept = { 'Fn::Join': ['', ['{{resolve:ssm:/pub/', { Ref: 'Host' }, '}}', '-x']] };
    const references = await maskedReferenceFingerprintsFor(
      ['Description'],
      { Description: VALUE },
      known('v1'),
      inputsOf(input('1'), kept)
    );
    const record = {
      properties: { Description: '***' },
      maskedPropertyFingerprints: { Description: TEXT },
      maskedPropertyInputFingerprints: { Description: input('1') },
      maskedPropertyReferenceFingerprints: references,
    };
    expect(Object.keys(references)).toEqual(['Description']);
    expect(
      await publicReferencesMoved(record, 'Description', VALUE, known('v1'), inputsOf(input('1'), kept))
    ).toBe(false);
  });
});
