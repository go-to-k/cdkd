import { describe, it, expect } from 'vite-plus/test';
import {
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  carryLogOnlyValues,
  carryLogOnlyValuesCarriedBy,
  createSecretMasker,
  hasMaskableValues,
  maskRecordedSecretsInText,
  maskSecretsInError,
  maskSecretsInText,
  mergeResolvedPairs,
  recordLogOnlyValue,
  redactSecretsForState,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// go-to-k/cdkd#1998: the LOG-ONLY needle class. A `NoEcho: true` template
// parameter's value must not be PRINTED, and (maintainer decision) must not be
// rewritten in anything cdkd PERSISTS. So it lives in a side set of the pass's
// bag, read by the printing maskers and by nothing that persists.
const NOECHO = 'noecho-parameter-value-7c1d';
const DYNREF_PLAINTEXT = 'resolved-dynamic-ref-value';
const DYNREF_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password::}}';

function logOnlyBag(...values: string[]): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map();
  for (const value of values) recordLogOnlyValue(bag, value);
  return bag;
}

describe('the printing maskers read the log-only needles (go-to-k/cdkd#1998)', () => {
  it('maskSecretsInText masks a log-only value whole and embedded, with no map entry', () => {
    const bag = logOnlyBag(NOECHO);
    expect(bag.size).toBe(0);
    expect(maskSecretsInText(NOECHO, bag)).toBe(SECRET_MASK);
    expect(maskSecretsInText(`Value '${NOECHO}' failed`, bag)).toBe(`Value '${SECRET_MASK}' failed`);
    expect(maskSecretsInText('unrelated text', bag)).toBe('unrelated text');
  });

  it('keeps the module floor: a short value is masked whole, never as a substring', () => {
    const short = 'x'.repeat(MIN_NEEDLE_LENGTH - 1);
    const bag = logOnlyBag(short);
    expect(maskSecretsInText(short, bag)).toBe(SECRET_MASK);
    expect(maskSecretsInText(`a ${short} b`, bag)).toBe(`a ${short} b`);
    const atFloor = 'y'.repeat(MIN_NEEDLE_LENGTH);
    expect(maskSecretsInText(`a ${atFloor} b`, logOnlyBag(atFloor))).toBe(`a ${SECRET_MASK} b`);
  });

  it('refuses the empty string, which would mask every empty text', () => {
    const bag = logOnlyBag('');
    expect(hasMaskableValues(bag)).toBe(false);
    expect(maskSecretsInText('', bag)).toBe('');
  });

  it('matches the longer needle first across the two classes', () => {
    // The log-only value CONTAINS the recorded one: masked as the recorded one
    // alone, its prefix and suffix would print.
    const bag: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
    recordLogOnlyValue(bag, `pre-${DYNREF_PLAINTEXT}-post`);
    expect(maskSecretsInText(`x pre-${DYNREF_PLAINTEXT}-post y`, bag)).toBe(`x ${SECRET_MASK} y`);
  });

  it('maskRecordedSecretsInText, the DETECTOR form, ignores the log-only needles', () => {
    const bag: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
    recordLogOnlyValue(bag, NOECHO);
    expect(maskRecordedSecretsInText(`${NOECHO} ${DYNREF_PLAINTEXT}`, bag)).toBe(
      `${NOECHO} ${SECRET_MASK}`
    );
    expect(maskRecordedSecretsInText(NOECHO, bag)).toBe(NOECHO);
  });

  it('maskSecretsInError masks every link with a bag holding ONLY log-only needles', () => {
    const inner = new Error(`AWS said '${NOECHO}' is invalid`);
    const outer = new Error('create failed', { cause: inner });
    const masked = maskSecretsInError(outer, logOnlyBag(NOECHO));
    expect(masked).not.toBe(outer);
    const cause = (masked as { cause?: unknown }).cause as Error;
    expect(cause.message).toBe(`AWS said '${SECRET_MASK}' is invalid`);
    expect(cause.stack ?? '').not.toContain(NOECHO);
  });

  it('createSecretMasker reads needles recorded AFTER it was bound', () => {
    const bag: RecordedSecretValues = new Map();
    const mask = createSecretMasker(bag);
    expect(mask(`warn: ${NOECHO}`)).toBe(`warn: ${NOECHO}`);
    recordLogOnlyValue(bag, NOECHO);
    expect(mask(`warn: ${NOECHO}`)).toBe(`warn: ${SECRET_MASK}`);
  });
});

describe('nothing that persists reads the log-only needles (go-to-k/cdkd#1998)', () => {
  it('redactSecretsForState leaves a log-only value in place, whole and embedded', () => {
    // A map ENTRY too, so the walk runs past the empty-map short-circuit.
    const bag = logOnlyBag(NOECHO);
    bag.set(DYNREF_PLAINTEXT, DYNREF_EXPR);
    const properties = { Value: NOECHO, Embedded: `prefix-${NOECHO}`, List: [NOECHO] };
    expect(redactSecretsForState(properties, bag)).toEqual(properties);
    expect(
      redactSecretsForState(properties, bag, { Value: { Ref: 'P' }, Embedded: 'x', List: ['y'] })
    ).toEqual(properties);
  });

  it('redacts a recorded secret exactly as without the side set', () => {
    const withSide: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
    recordLogOnlyValue(withSide, NOECHO);
    const without: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
    const properties = { A: DYNREF_PLAINTEXT, B: `${NOECHO}:${DYNREF_PLAINTEXT}`, C: NOECHO };
    expect(JSON.stringify(redactSecretsForState(properties, withSide))).toBe(
      JSON.stringify(redactSecretsForState(properties, without))
    );
  });

  it('scrubResourceRecord leaves a log-only value in place in every field', () => {
    const record = {
      physicalId: 'p',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Value: NOECHO },
      attributes: { Value: NOECHO },
      observedProperties: { Value: NOECHO },
    };
    expect(JSON.stringify(scrubResourceRecord(record, logOnlyBag(NOECHO)))).toBe(
      JSON.stringify(record)
    );
  });
});

describe('the side set survives the bag copies that mask (go-to-k/cdkd#1998)', () => {
  it('hasMaskableValues answers for a bag holding only log-only needles', () => {
    expect(hasMaskableValues(undefined)).toBe(false);
    expect(hasMaskableValues(new Map())).toBe(false);
    expect(hasMaskableValues(new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]))).toBe(true);
    expect(hasMaskableValues(logOnlyBag(NOECHO))).toBe(true);
  });

  it('carryLogOnlyValues copies every needle, and a plain Map copy does not', () => {
    const from = logOnlyBag(NOECHO, 'second-noecho-value');
    expect(maskSecretsInText(NOECHO, new Map(from))).toBe(NOECHO);
    const to: RecordedSecretValues = new Map();
    carryLogOnlyValues(from, to);
    expect(maskSecretsInText(`${NOECHO} second-noecho-value`, to)).toBe(
      `${SECRET_MASK} ${SECRET_MASK}`
    );
    expect(to.size).toBe(0);
  });

  it('carryLogOnlyValuesCarriedBy copies only the needles the value carries', () => {
    const other = 'another-noecho-value';
    const from = logOnlyBag(NOECHO, other, 'abc');
    const to: RecordedSecretValues = new Map();
    // Equal, embedded at or above the floor, and a list element: carried.
    carryLogOnlyValuesCarriedBy(from, to, ['x', `host/${NOECHO}`]);
    // A short needle only when WHOLE.
    carryLogOnlyValuesCarriedBy(from, to, 'xabcx');
    expect(maskSecretsInText(NOECHO, to)).toBe(SECRET_MASK);
    expect(maskSecretsInText(other, to)).toBe(other);
    expect(maskSecretsInText('abc', to)).toBe('abc');
    carryLogOnlyValuesCarriedBy(from, to, 'abc');
    expect(maskSecretsInText('abc', to)).toBe(SECRET_MASK);
    expect(to.size).toBe(0);
  });

  it('mergeResolvedPairs does NOT carry them: its one masking-free caller is the outputs bag', () => {
    // Pinned so a change here is a decision: `outputSecrets` feeds only
    // `redactSecretsForState`, which never reads the side set.
    const from = logOnlyBag(NOECHO);
    const to: RecordedSecretValues = new Map();
    mergeResolvedPairs(from, to);
    expect(hasMaskableValues(to)).toBe(false);
  });
});
