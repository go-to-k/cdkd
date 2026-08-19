import { describe, it, expect } from 'vite-plus/test';
import {
  createSecretMasker,
  maskSecretsInText,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Issue #1932 item 3. `createSecretMasker` is the provider-facing binding of
// `maskSecretsInText`: the deploy engine / rollback executor hand a provider
// the CAPABILITY so a provider's own `logger.warn` can mask a resolved value
// without ever seeing the secrets bag.
describe('createSecretMasker', () => {
  const PLAINTEXT = 'super-secret-plaintext-value';
  const EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';

  function bag(): RecordedSecretValues {
    return new Map([[PLAINTEXT, EXPR]]);
  }

  it('masks a whole-value match', () => {
    expect(createSecretMasker(bag())(PLAINTEXT)).toBe(SECRET_MASK);
  });

  it('masks an EMBEDDED match, which is the provider-warning shape', () => {
    // A provider interpolates the value into a sentence, so the substring arm
    // is the one that actually runs on this path — a whole-value-only masker
    // would pass this straight through.
    const masked = createSecretMasker(bag())(`EnabledMfas entries "${PLAINTEXT}" (not a list)`);
    expect(masked).toBe(`EnabledMfas entries "${SECRET_MASK}" (not a list)`);
    expect(masked).not.toContain(PLAINTEXT);
  });

  it('leaves text with no secret in it byte-identical', () => {
    const text = 'EnabledMfas entries "SOFTWARE_TOKEN" (not a list)';
    expect(createSecretMasker(bag())(text)).toBe(text);
  });

  it('agrees with maskSecretsInText for the same bag', () => {
    // Pins the binding rather than a re-implementation: if the masker ever
    // stops delegating (e.g. grows its own truncation), this fails.
    const b = bag();
    const text = `a ${PLAINTEXT} b`;
    expect(createSecretMasker(b)(text)).toBe(maskSecretsInText(text, b));
  });

  it('is an identity for an empty bag', () => {
    expect(createSecretMasker(new Map())(PLAINTEXT)).toBe(PLAINTEXT);
  });

  // The bind-time-short-circuit trap, and the ONLY test that holds it up.
  // Every caller today fills its bag BEFORE binding the masker (the rollback
  // arms run `resolveReplayProps` first; the deploy engine resolves before it
  // calls the provider), so adding a `secrets.size === 0` early-out to
  // `createSecretMasker` passes every other test in this repo — measured, not
  // assumed. That makes the invariant an ordering coincidence everywhere else
  // and a real assertion only here.
  it('masks values added to the bag AFTER the masker was built', () => {
    const b: RecordedSecretValues = new Map();
    const mask = createSecretMasker(b);
    expect(mask(PLAINTEXT)).toBe(PLAINTEXT);
    b.set(PLAINTEXT, EXPR);
    expect(mask(PLAINTEXT)).toBe(SECRET_MASK);
  });
});
