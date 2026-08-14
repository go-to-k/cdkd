import { describe, it, expect } from 'vite-plus/test';
import {
  redactSecretsForState,
  maskSecretsInText,
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
