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
// UPDATED BY THE #1904 FIX. The collision is REAL and unfixable by value alone,
// so the two-argument form below still collapses — that is now a documented
// BOUND rather than a defect, and the second block proves the supported form
// resolves it. Do not "simplify" by deleting either half: the pair is what
// records that position, not a better value map, is what fixes this.
describe('secret-redaction - value-key collision (issue #1904, value-only bound)', () => {
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

    // No plaintext survives — the SECURITY property holds either way...
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
    // ...but PLAIN is rewritten to the STAGED expression. Without a position
    // source there is nothing that could distinguish them, which is why the fix
    // supplies one rather than trying to key the map differently.
    expect(redacted.Variables['PLAIN']).toBe(EXPR_STAGED);
    expect(redacted.Variables['STAGED']).toBe(EXPR_STAGED);
  });

  it('resolves the collision when the SOURCE bag supplies position (#1904 fix)', () => {
    const map: RecordedSecretValues = new Map();
    map.set(SHARED, EXPR_PLAIN);
    map.set(SHARED, EXPR_STAGED);

    // The source is the unresolved template bag the deploy engine now captures.
    const source = { Variables: { PLAIN: EXPR_PLAIN, STAGED: EXPR_STAGED } };
    const redacted = redactSecretsForState(
      { Variables: { PLAIN: SHARED, STAGED: SHARED } },
      map,
      source
    ) as { Variables: Record<string, string> };

    // Each site keeps ITS OWN expression, so the next diff compares
    // expression-vs-expression per leaf and reports no change.
    expect(redacted.Variables['PLAIN']).toBe(EXPR_PLAIN);
    expect(redacted.Variables['STAGED']).toBe(EXPR_STAGED);
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
  });

  it('redacts with NO secrets map at all when the source carries the expression (#1900)', () => {
    // The unchanged-resource case: never resolved this deploy, so there is no
    // per-resource secrets map — but the record's own properties still hold the
    // expression, and a live readback echoing the plaintext must not overwrite it.
    const observed = { Variables: { PLAIN: SHARED } };
    const source = { Variables: { PLAIN: EXPR_PLAIN } };

    const redacted = redactSecretsForState(observed, new Map(), source, 'aws-readback') as {
      Variables: Record<string, string>;
    };

    expect(redacted.Variables['PLAIN']).toBe(EXPR_PLAIN);
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
  });

  // BLOCKER from review: the path pass first matched ANY `{{resolve:` string, so
  // a PUBLIC ssm reference — which issue #1901 deliberately keeps RESOLVED in
  // state — was rewritten back to its expression. The diff resolves the desired
  // side for a String parameter, so state-as-expression vs desired-as-value is a
  // change on EVERY deploy: a perpetual UPDATE, i.e. the exact failure #1901
  // exists to prevent, reintroduced by the #1904 fix.
  it('does NOT persist a PUBLIC ssm expression the resolver never recorded (#1901)', () => {
    const PUBLIC_EXPR = '{{resolve:ssm:/app/public-host}}';
    const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PLAIN]]);

    const redacted = redactSecretsForState(
      { Host: 'db.example.com', Password: SHARED },
      secrets,
      { Host: PUBLIC_EXPR, Password: EXPR_PLAIN }
    ) as Record<string, string>;

    // Public config stays RESOLVED...
    expect(redacted['Host']).toBe('db.example.com');
    // ...while the recorded secret beside it is still redacted.
    expect(redacted['Password']).toBe(EXPR_PLAIN);
  });

  // BLOCKER from review: `observedProperties` is an AWS readback and AWS does
  // not preserve list order (the reason drift-normalize.ts exists). Descending
  // arrays positionally there wrote the expression onto the WRONG element and
  // left the real secret in plaintext.
  it('does NOT map arrays positionally for an AWS readback (#1900 ordering)', () => {
    const source = {
      Env: [
        { Name: 'SECRET', Value: EXPR_PLAIN },
        { Name: 'PLAIN', Value: 'public' },
      ],
    };
    // AWS returned the list REVERSED, and echoed the secret's plaintext.
    const observed = {
      Env: [
        { Name: 'PLAIN', Value: 'public' },
        { Name: 'SECRET', Value: SHARED },
      ],
    };
    const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_PLAIN]]);

    const redacted = redactSecretsForState(observed, secrets, source, 'aws-readback') as {
      Env: Array<Record<string, string>>;
    };

    // The value scan handled it: the secret is redacted where it actually is...
    expect(redacted.Env[1]!['Value']).toBe(EXPR_PLAIN);
    // ...and the unrelated public element was NOT overwritten with an expression.
    expect(redacted.Env[0]!['Value']).toBe('public');
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
  });

  it('still value-scans a subtree the source cannot position (embedded Fn::Sub)', () => {
    // The source leaf is an intrinsic OBJECT, so position cannot answer; the
    // value scan must still find the secret embedded in the joined result.
    const map: RecordedSecretValues = new Map([[SHARED, EXPR_PLAIN]]);
    const redacted = redactSecretsForState(
      { Url: `pw=${SHARED}/db` },
      map,
      { Url: { 'Fn::Sub': `pw=${EXPR_PLAIN}/db` } }
    ) as { Url: string };

    expect(redacted.Url).toBe(`pw=${EXPR_PLAIN}/db`);
  });
});
