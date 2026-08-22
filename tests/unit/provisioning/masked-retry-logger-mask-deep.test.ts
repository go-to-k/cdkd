/**
 * Issue #2176 — the shared pre-stringify secret walk.
 *
 * `maskDeep` was three hand-rolled copies (`elbv2-provider.ts`,
 * `cognito-provider.ts`, `sns-topic-provider.ts`) before this issue converged
 * them. The copies encode a security contract, and the third had already
 * DIVERGED — it carried no depth cap — so this suite pins the behaviour the
 * shared one now owes all three.
 *
 * Each case asserts the POSITIVE marker (the mask token is present) as well as
 * the negative (the plaintext is gone). "The plaintext is absent" alone is a
 * confluence point: it is equally true of a walk that dropped the value, threw,
 * or returned an empty structure.
 */
import { describe, expect, it } from 'vite-plus/test';

import { MASK_WALK_MAX_DEPTH, maskDeep } from '../../../src/provisioning/masked-retry-logger.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(
    values.map((v) => [v, { reference: `{{resolve:secretsmanager:${v}}}` }])
  ) as unknown as RecordedSecretValues;
}

describe('maskDeep (issue #2176)', () => {
  it('masks a JSON-DOCUMENT secret that message-level masking cannot reach', () => {
    // The whole reason the walk runs BEFORE `JSON.stringify`: stringify escapes
    // `"` and `\`, so the plaintext no longer OCCURS in the finished line and a
    // mask applied afterwards is inert. This is every Secrets Manager JSON
    // document, i.e. the commonest real secret shape.
    const secret = '{"user":"admin","pw":"hunter2"}';
    const mask = createSecretMasker(bagOf(secret));

    const messageLevel = mask(`got ${JSON.stringify(secret)}`);
    expect(messageLevel, 'the pre-fix shape must still leak, or this suite proves nothing').toContain(
      'hunter2'
    );

    const walked = `got ${JSON.stringify(maskDeep(secret, mask))}`;
    expect(walked).not.toContain('hunter2');
    expect(walked).toBe(`got ${JSON.stringify(SECRET_MASK)}`);
  });

  it('masks a sub-MIN_NEEDLE_LENGTH secret by reaching the whole-value arm', () => {
    // A finished message is longer than the value inside it, so it can only
    // reach the SUBSTRING arm, which ignores needles under 4 characters. The
    // walk hands the masker each RAW leaf, which has no floor.
    const secret = 'abc';
    const mask = createSecretMasker(bagOf(secret));

    expect(mask(`Value '${secret}' at 'pin' failed`)).toContain("'abc'");
    expect(maskDeep(secret, mask)).toBe(SECRET_MASK);
  });

  it('masks string leaves nested in arrays and objects, and masks KEYS too', () => {
    const leaf = 'leaf-secret-value';
    const key = 'key-secret-value';
    const mask = createSecretMasker(bagOf(leaf, key));

    const walked = maskDeep({ [key]: ['plain', { deeper: leaf }] }, mask) as Record<
      string,
      unknown
    >;

    expect(Object.keys(walked)).toEqual([SECRET_MASK]);
    const [first, second] = walked[SECRET_MASK] as [unknown, Record<string, unknown>];
    // Negative control: a non-secret leaf is untouched, so the walk is masking
    // the recorded values rather than blanking everything it sees.
    expect(first).toBe('plain');
    expect(second['deeper']).toBe(SECRET_MASK);
  });

  it('leaves non-string scalars alone', () => {
    const mask = createSecretMasker(bagOf('s3cret'));
    expect(maskDeep(42, mask)).toBe(42);
    expect(maskDeep(true, mask)).toBe(true);
    expect(maskDeep(null, mask)).toBe(null);
    expect(maskDeep(undefined, mask)).toBe(undefined);
  });

  it('terminates on a SELF-REFERENTIAL bag instead of overflowing the stack', () => {
    // The divergence the convergence fixed: `sns-topic-provider.ts`'s private
    // copy had no depth cap, so this input recursed until the stack blew.
    const mask = createSecretMasker(bagOf('s3cret'));
    const cyclic: Record<string, unknown> = { name: 's3cret' };
    cyclic['self'] = cyclic;

    const walked = maskDeep(cyclic, mask) as Record<string, unknown>;
    expect(walked['name']).toBe(SECRET_MASK);
  });

  it('stops DESCENDING at the depth cap, but masks a string leaf at any depth', () => {
    // Pins the ordering inside the walk, which is easy to get backwards: the
    // `typeof value === 'string'` check runs BEFORE the depth test, so a scalar
    // is masked however deep it sits. The cap bounds only the descent into
    // CONTAINERS — which is what makes a self-referential bag terminate.
    const secret = 'too-deep-secret';
    const mask = createSecretMasker(bagOf(secret));

    const nest = (levels: number): unknown => {
      let v: unknown = secret;
      for (let i = 0; i < levels; i++) v = { nested: v };
      return v;
    };

    // The leaf sits AT the cap: still a string, so still masked.
    expect(JSON.stringify(maskDeep(nest(MASK_WALK_MAX_DEPTH), mask))).not.toContain(secret);

    // One level deeper the walk meets an OBJECT at the cap and returns it whole,
    // so the leaf inside it is never visited. This is the accepted bound, pinned
    // rather than claimed unreachable.
    expect(JSON.stringify(maskDeep(nest(MASK_WALK_MAX_DEPTH + 1), mask))).toContain(secret);
  });

  it('is idempotent, which is what lets a provider mask the value AND the message', () => {
    const secret = 'idempotence-probe-secret';
    const mask = createSecretMasker(bagOf(secret));
    const once = maskDeep({ a: secret }, mask);
    expect(maskDeep(once, mask)).toEqual(once);
  });
});
