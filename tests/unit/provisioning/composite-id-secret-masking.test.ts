/**
 * Issue #2176 — the composite-id refusal quotes the offending segment VALUE.
 *
 * A segment is read straight off the `properties` bag, which is RESOLVED by the
 * time a provider sees it, so a `{{resolve:secretsmanager:...}}` segment is
 * plaintext at this point. The refusal reaches a durable sink on the throwing
 * arm (`deployments/{runId}.jsonl`, which outlives `cdkd destroy`) and the
 * terminal on the `onRefusal` arm.
 *
 * `compositeIdSeparatorRefusal` is ONE root cause with 22 call sites across
 * eight providers, which is why the masking lives here rather than at each
 * caller.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  compositeIdSeparatorRefusal,
  packCompositeId,
} from '../../../src/provisioning/composite-id.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

/** A value carrying the separator, so the refusal actually fires. */
const OFFENDING = 'tok|en-with-separator';

function bag(...values: string[]): RecordedSecretValues {
  return new Map(
    values.map((v) => [v, { reference: `{{resolve:secretsmanager:${v}}}` }])
  ) as unknown as RecordedSecretValues;
}

describe('compositeIdSeparatorRefusal masking (issue #2176)', () => {
  it('masks the quoted segment value when a masker is supplied', () => {
    const mask = createSecretMasker(bag(OFFENDING));
    const refusal = compositeIdSeparatorRefusal(
      'AWS::S3Tables::Table',
      'Table',
      [{ name: 'TableName', value: OFFENDING }],
      mask
    );

    expect(refusal).toBeDefined();
    expect(refusal).not.toContain(OFFENDING);
    // The POSITIVE marker: "the plaintext is absent" alone is equally true of a
    // refusal that never fired, or one that dropped the segment entirely.
    expect(refusal).toContain(`TableName '${SECRET_MASK}'`);
    // The segment NAME is a cdkd-authored field label, never template data.
    expect(refusal).toContain('TableName');
  });

  it('leaves the value alone when no masker is supplied — the back-compatible default', () => {
    const refusal = compositeIdSeparatorRefusal('AWS::S3Tables::Table', 'Table', [
      { name: 'TableName', value: OFFENDING },
    ]);
    expect(refusal).toContain(`TableName '${OFFENDING}'`);
  });

  it('leaves a NON-secret segment alone even with a masker — negative control', () => {
    // Without this, a masker that blanked everything it saw would pass the
    // first case just as well.
    const mask = createSecretMasker(bag('some-unrelated-secret'));
    const refusal = compositeIdSeparatorRefusal(
      'AWS::S3Tables::Table',
      'Table',
      [{ name: 'TableName', value: OFFENDING }],
      mask
    );
    expect(refusal).toContain(`TableName '${OFFENDING}'`);
  });

  it('masks a sub-MIN_NEEDLE_LENGTH secret, which masking the finished message cannot', () => {
    // The value is masked RAW, so it reaches `maskSecretsInText`'s WHOLE-VALUE
    // arm (no length floor) rather than the substring arm's 4-character floor.
    const short = 'a|b';
    const mask = createSecretMasker(bag(short));
    const refusal = compositeIdSeparatorRefusal(
      'AWS::S3Tables::Table',
      'Table',
      [{ name: 'TableName', value: short }],
      mask
    );
    expect(refusal).toContain(`TableName '${SECRET_MASK}'`);

    // The proof that this is not free: masking the ASSEMBLED sentence leaves it.
    const unmasked = compositeIdSeparatorRefusal('AWS::S3Tables::Table', 'Table', [
      { name: 'TableName', value: short },
    ]);
    expect(mask(unmasked as string)).toContain(`'${short}'`);
  });

  it('packCompositeId forwards the masker to the THROWN arm (the durable sink)', () => {
    const mask = createSecretMasker(bag(OFFENDING));
    try {
      packCompositeId('AWS::S3Tables::Table', 'Table', [{ name: 'TableName', value: OFFENDING }], {
        maskSecrets: mask,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(OFFENDING);
      expect(message).toContain(`TableName '${SECRET_MASK}'`);
    }
  });

  it('packCompositeId forwards the masker to the onRefusal arm (the terminal)', () => {
    const mask = createSecretMasker(bag(OFFENDING));
    const onRefusal = vi.fn();

    const packed = packCompositeId(
      'AWS::S3Tables::Table',
      'Table',
      [{ name: 'TableName', value: OFFENDING }],
      { onRefusal, maskSecrets: mask }
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    const message = onRefusal.mock.calls[0]?.[0] as string;
    expect(message).not.toContain(OFFENDING);
    expect(message).toContain(`TableName '${SECRET_MASK}'`);

    // The PACKED id is deliberately unchanged — masking is about the message,
    // and a masked physical id would address the wrong resource.
    expect(packed).toBe(OFFENDING);
  });
});
