import { describe, it, expect } from 'vite-plus/test';
import {
  redactSecretsForState,
  maskSecretsInText,
  scrubResourceRecord,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

function secrets(pairs: Array<[string, string]>): RecordedSecretValues {
  return new Map(pairs);
}

describe('secret-redaction', () => {
  describe('redactSecretsForState', () => {
    it('returns the input by identity when there are no secrets', () => {
      const bag = { a: 1, b: 'x' };
      expect(redactSecretsForState(bag, new Map())).toBe(bag);
    });

    it('replaces a whole-value secret leaf with its {{resolve:...}} expression', () => {
      const bag = { ClientSecret: 'super-secret-plaintext' };
      const out = redactSecretsForState(bag, secrets([['super-secret-plaintext', EXPR]]));
      expect(out).toEqual({ ClientSecret: EXPR });
    });

    it('replaces an embedded secret substring in a joined string', () => {
      const bag = { Url: 'https://user:super-secret-plaintext@host/db' };
      const out = redactSecretsForState(bag, secrets([['super-secret-plaintext', EXPR]]));
      expect(out).toEqual({ Url: `https://user:${EXPR}@host/db` });
    });

    it('redacts secrets nested in arrays and sub-objects', () => {
      const bag = {
        ProviderDetails: { client_secret: 'super-secret-plaintext', client_id: 'public-id' },
        List: ['ok', 'super-secret-plaintext'],
      };
      const out = redactSecretsForState(bag, secrets([['super-secret-plaintext', EXPR]]));
      expect(out).toEqual({
        ProviderDetails: { client_secret: EXPR, client_id: 'public-id' },
        List: ['ok', EXPR],
      });
    });

    it('does not scan for a below-threshold secret as a substring but still masks a whole-value match', () => {
      // A 1-char secret must not mangle unrelated strings, but the leaf that IS
      // exactly that value is still redacted.
      const bag = { Field: '0', Other: 'a value with 0 inside it' };
      const out = redactSecretsForState(bag, secrets([['0', EXPR]]));
      expect(out).toEqual({ Field: EXPR, Other: 'a value with 0 inside it' });
    });

    it('leaves non-secret values untouched', () => {
      const bag = { a: 'public', n: 42, b: true, nil: null };
      const out = redactSecretsForState(bag, secrets([['super-secret-plaintext', EXPR]]));
      expect(out).toEqual(bag);
    });

    it('handles regex-special characters in the secret value literally', () => {
      const secret = 'a.b*c(d)+e';
      const bag = { S: `prefix-${secret}-suffix` };
      const out = redactSecretsForState(bag, secrets([[secret, EXPR]]));
      expect(out).toEqual({ S: `prefix-${EXPR}-suffix` });
    });

    it('never treats an empty-string secret as a needle (would corrupt every empty leaf)', () => {
      const bag = { A: '', B: 'x', C: { D: '' } };
      const out = redactSecretsForState(bag, secrets([['', EXPR]]));
      expect(out).toEqual({ A: '', B: 'x', C: { D: '' } });
    });

    it('prefers the longest match when secrets overlap', () => {
      const bag = { S: 'abcdef' };
      const out = redactSecretsForState(
        bag,
        secrets([
          ['abc', '{{resolve:secretsmanager:short}}'],
          ['abcdef', '{{resolve:secretsmanager:long}}'],
        ])
      );
      expect(out).toEqual({ S: '{{resolve:secretsmanager:long}}' });
    });
  });

  describe('scrubResourceRecord', () => {
    it('returns the record by identity when there are no secrets', () => {
      const rec = { properties: { a: 'x' } };
      expect(scrubResourceRecord(rec, new Map())).toBe(rec);
    });

    it('redacts secrets across properties, attributes and observedProperties', () => {
      const rec = {
        physicalId: 'pid',
        resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
        properties: { ProviderDetails: { client_secret: 'super-secret-plaintext' } },
        attributes: { ProviderDetails: { client_secret: 'super-secret-plaintext' } },
        observedProperties: { ProviderDetails: { client_secret: 'super-secret-plaintext' } },
      };
      const out = scrubResourceRecord(rec, secrets([['super-secret-plaintext', EXPR]]));
      expect(out.properties).toEqual({ ProviderDetails: { client_secret: EXPR } });
      expect(out.attributes).toEqual({ ProviderDetails: { client_secret: EXPR } });
      expect(out.observedProperties).toEqual({ ProviderDetails: { client_secret: EXPR } });
      // physicalId / resourceType are preserved.
      expect(out.physicalId).toBe('pid');
      expect(out.resourceType).toBe('AWS::Cognito::UserPoolIdentityProvider');
    });

    it('leaves optional fields absent when the record has none', () => {
      const rec = { properties: { ClientSecret: 'super-secret-plaintext' } };
      const out = scrubResourceRecord(rec, secrets([['super-secret-plaintext', EXPR]]));
      expect(out.properties).toEqual({ ClientSecret: EXPR });
      expect('attributes' in out).toBe(false);
      expect('observedProperties' in out).toBe(false);
    });
  });

  describe('maskSecretsInText', () => {
    it('returns text unchanged when there are no secrets', () => {
      expect(maskSecretsInText('anything', new Map())).toBe('anything');
    });

    it('masks a whole-value secret', () => {
      expect(maskSecretsInText('super-secret-plaintext', secrets([['super-secret-plaintext', EXPR]]))).toBe(
        SECRET_MASK
      );
    });

    it('masks an embedded secret substring', () => {
      const out = maskSecretsInText(
        'Resolved Fn::Sub: pw=super-secret-plaintext done',
        secrets([['super-secret-plaintext', EXPR]])
      );
      expect(out).toBe(`Resolved Fn::Sub: pw=${SECRET_MASK} done`);
      expect(out).not.toContain('super-secret-plaintext');
    });
  });
});

// CHARACTERIZATION TEST for issue #1904 — pins a KNOWN DEFECT, not desired
// behavior. `RecordedSecretValues` is keyed by the resolved PLAINTEXT, so two
// different expressions resolving to the same value collapse to one entry
// (last write wins) and BOTH sites are rewritten to the survivor. The
// consequence is a permanent spurious UPDATE: the template still carries each
// site's own expression, while state carries the survivor's.
//
// This exists because the `secrets-dynamic-ref` fixture used to trip the
// collision incidentally and no longer does (its version-stage reference was
// pointed at a different JSON key so the fixture's `diff --fail` guard could
// test what it is meant to test), which left the defect completely unfenced.
//
// WHEN #1904 IS FIXED THIS TEST WILL FAIL. That is intended: the fix should
// replace it with the inverted assertion — each site keeps ITS OWN expression.
// Do not "repair" it by loosening the assertion.
describe('secret-redaction - value-key collision (issue #1904, known defect)', () => {
  const EXPR_PLAIN = '{{resolve:secretsmanager:s:SecretString:password}}';
  const EXPR_STAGED = '{{resolve:secretsmanager:s:SecretString:password:AWSCURRENT}}';
  const SHARED = 'one-and-the-same-secret';

  it('collapses two expressions sharing one resolved value onto the last-recorded one', () => {
    // Insertion order mirrors a resolution pass over an env map declaring the
    // plain reference first and the staged one second.
    const map: RecordedSecretValues = new Map();
    map.set(SHARED, EXPR_PLAIN);
    map.set(SHARED, EXPR_STAGED);
    expect(map.size).toBe(1); // <- the collapse itself

    const redacted = redactSecretsForState(
      { Variables: { PLAIN: SHARED, STAGED: SHARED } },
      map
    ) as { Variables: Record<string, string> };

    // No plaintext survives — the SECURITY property still holds...
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
    // ...but PLAIN is rewritten to the STAGED expression, which is the defect:
    // the next diff compares this against the template's EXPR_PLAIN forever.
    expect(redacted.Variables['PLAIN']).toBe(EXPR_STAGED);
    expect(redacted.Variables['STAGED']).toBe(EXPR_STAGED);
  });
});
