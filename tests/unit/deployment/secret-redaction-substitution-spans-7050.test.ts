/**
 * go-to-k/cdkd#7050: `positionBySubstitutionSpans` against hand-written
 * resolution records, for the refusals and spellings the resolver-driven
 * invariant cannot single out.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  recordIntrinsicLeafResolution,
  recordResolvedPair,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { positionBySubstitutionSpans } from '../../../src/deployment/secret-redaction/redact-path/substitution-spans.js';
import { TEMPLATE_DERIVED_RULES } from '../../../src/deployment/secret-redaction/rules.js';
import { redactForState } from '../../../src/deployment/secret-redaction.js';

const U = '{{resolve:secretsmanager:db:SecretString:username::}}';
const V = '{{resolve:secretsmanager:db2:SecretString:username::}}';

function bag(pairs: Array<[string, string]>): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  for (const [token, plaintext] of pairs) {
    secrets.set(plaintext, token);
    recordResolvedPair(secrets, token, plaintext);
  }
  return secrets;
}

const position = (value: string, source: object, secrets: RecordedSecretValues): unknown =>
  positionBySubstitutionSpans(value, source, secrets, TEMPLATE_DERIVED_RULES, (text) =>
    redactForState(text, { provenance: 'value-scan', secrets })
  );

describe('positionBySubstitutionSpans (#7050)', () => {
  it('places the token by its span, and masks the leaf where a parameter holds its text', () => {
    const secrets = bag([[U, 'pg']]);
    const source = { 'Fn::Join': ['', ['tt:', U, { Ref: 'Alias' }]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `tt:${U}pg`,
      output: 'tt:pgpg',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: true,
    });
    // No token is written into a gap on the strength of its bytes (#7050).
    expect(position('tt:pgpg', source, secrets)).toBe(SECRET_MASK);
  });

  it('masks a sub-floor secret INSIDE a parameter gap, and keeps template text that spells it', () => {
    const secrets = bag([[U, 'pg']]);
    const source = { 'Fn::Join': ['', ['pg-', U, { Ref: 'Alias' }]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `pg-${U}apgb`,
      output: 'pg-pgapgb',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: true,
    });
    // `apgb` is the parameter's and holds the secret's text: masked.
    expect(position('pg-pgapgb', source, secrets)).toBe(SECRET_MASK);
    // Template text that spells it is the template's own (#7037).
    const kept = { 'Fn::Join': ['', ['pg-', U, { Ref: 'Other' }]] };
    recordIntrinsicLeafResolution(secrets, kept, {
      input: `pg-${U}qqq`,
      output: 'pg-pgqqq',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: true,
    });
    expect(position('pg-pgqqq', kept, secrets)).toBe(`pg-${U}qqq`);
  });

  it("redacts a PUBLIC token's value like a gap: a secret's text in it never stays (security review)", () => {
    const LONG = '{{resolve:ssm:/app/long}}';
    const PUB = '{{resolve:ssm:/app/publong}}';
    const secrets = bag([[LONG, 'rootpw']]);
    const source = { 'Fn::Join': ['', [LONG, '@', PUB]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `${LONG}@${PUB}`,
      output: 'rootpw@rootpw-host',
      substitutions: [
        { token: LONG, value: 'rootpw', secret: true },
        { token: PUB, value: 'rootpw-host', secret: false },
      ],
      complete: true,
    });
    expect(position('rootpw@rootpw-host', source, secrets)).toBe(SECRET_MASK);
    // ...and the leaf's own sub-floor secret inside a public value.
    const PIN = '{{resolve:ssm:/app/pin}}';
    const pins = bag([[PIN, 'q7']]);
    const pinned = { 'Fn::Join': ['', [PUB, '/', PIN]] };
    recordIntrinsicLeafResolution(pins, pinned, {
      input: `${PUB}/${PIN}`,
      output: 'xq7y/q7',
      substitutions: [
        { token: PUB, value: 'xq7y', secret: false },
        { token: PIN, value: 'q7', secret: true },
      ],
      complete: true,
    });
    expect(position('xq7y/q7', pinned, pins)).toBe(SECRET_MASK);
  });

  it('masks the leaf where a gap holds or equals ANOTHER secret (security review)', () => {
    const PIN = '{{resolve:ssm:/app/pin}}';
    const X9 = '{{resolve:ssm:/app/x9}}';
    const LONG = '{{resolve:ssm:/app/long}}';
    const secrets = bag([
      [PIN, 'q7'],
      [X9, 'x9'],
      [LONG, 'rootpw'],
    ]);
    // The gap IS another secret's whole value.
    const whole = { 'Fn::Join': ['', [PIN, '@', { Ref: 'Sep' }]] };
    recordIntrinsicLeafResolution(secrets, whole, {
      input: `${PIN}@x9`,
      output: 'q7@x9',
      substitutions: [{ token: PIN, value: 'q7', secret: true }],
      complete: true,
    });
    expect(position('q7@x9', whole, secrets)).toBe(SECRET_MASK);
    // The gap holds the own secret's text AND another 4+ character secret.
    const mixed = { 'Fn::Join': ['', [PIN, '@', { Ref: 'Other' }]] };
    recordIntrinsicLeafResolution(secrets, mixed, {
      input: `${PIN}@q7-rootpw`,
      output: 'q7@q7-rootpw',
      substitutions: [{ token: PIN, value: 'q7', secret: true }],
      complete: true,
    });
    expect(position('q7@q7-rootpw', mixed, secrets)).toBe(SECRET_MASK);
  });

  it("keeps a public value's own `***`, and masks only where the scan wrote one", () => {
    const secrets = bag([[U, 'pg']]);
    const source = { 'Fn::Join': ['', ['tt:', U, { Ref: 'P' }]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `tt:${U}a***b`,
      output: 'tt:pga***b',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: true,
    });
    expect(position('tt:pga***b', source, secrets)).toBe(`tt:${U}a***b`);
  });

  it('refuses a record whose replay does not reproduce its output', () => {
    const secrets = bag([[U, 'pg']]);
    const source = { 'Fn::Join': ['', ['tt:', U, { Ref: 'Alias' }]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `tt:${U}x`,
      output: 'tt:pgx',
      // Not what the output holds at the token's place.
      substitutions: [{ token: U, value: 'pgg', secret: true }],
      complete: true,
    });
    expect(position('tt:pgx', source, secrets)).toBeUndefined();
  });

  it('refuses a token replaced two ways, and an incomplete record', () => {
    const secrets = bag([[U, 'pg']]);
    const twice = { 'Fn::Join': ['', [U, { Ref: 'A' }]] };
    recordIntrinsicLeafResolution(secrets, twice, {
      input: `${U}x`,
      output: 'pgx',
      substitutions: [
        { token: U, value: 'pg', secret: true },
        { token: U, value: 'qq', secret: true },
      ],
      complete: true,
    });
    expect(position('pgx', twice, secrets)).toBeUndefined();
    const partial = { 'Fn::Join': ['', [U, { Ref: 'B' }]] };
    recordIntrinsicLeafResolution(secrets, partial, {
      input: `${U}x`,
      output: 'pgx',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: false,
    });
    expect(position('pgx', partial, secrets)).toBeUndefined();
  });

  it('masks the leaf where a gap holds text two references resolved to', () => {
    // Which reference the gap holds is not known: the map's survivor would
    // send the wrong one's value on a replay.
    const secrets = bag([
      [U, 'pg'],
      [V, 'pg'],
    ]);
    const source = { 'Fn::Join': ['', ['tt:', U, { Ref: 'Alias' }]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `tt:${U}pg`,
      output: 'tt:pgpg',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: true,
    });
    expect(position('tt:pgpg', source, secrets)).toBe(SECRET_MASK);
  });

  it('keeps a public token as resolved, and stays out of a leaf with no secret token', () => {
    const PUBLIC = '{{resolve:ssm:/app/region}}';
    const secrets = bag([[U, 'pg']]);
    const source = { 'Fn::Join': ['', [PUBLIC, '/', U]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `${PUBLIC}/${U}`,
      output: 'eu/pg',
      substitutions: [
        { token: PUBLIC, value: 'eu', secret: false },
        { token: U, value: 'pg', secret: true },
      ],
      complete: true,
    });
    expect(position('eu/pg', source, secrets)).toBe(`eu/${U}`);
    const onlyPublic = { 'Fn::Join': ['', [PUBLIC, '/x']] };
    recordIntrinsicLeafResolution(secrets, onlyPublic, {
      input: `${PUBLIC}/x`,
      output: 'eu/x',
      substitutions: [{ token: PUBLIC, value: 'eu', secret: false }],
      complete: true,
    });
    expect(position('eu/x', onlyPublic, secrets)).toBeUndefined();
  });

  it('keeps a reader copy of a secret-named id inside a gap (#4810)', async () => {
    const { recordPhysicalNameCopy } = await import('../../../src/deployment/secret-redaction.js');
    const secrets = bag([[U, 'pg']]);
    recordPhysicalNameCopy(secrets, 'q-pg');
    const source = { 'Fn::Join': ['', [U, '@', { Ref: 'Queue' }]] };
    recordIntrinsicLeafResolution(secrets, source, {
      input: `${U}@q-pg`,
      output: 'pg@q-pg',
      substitutions: [{ token: U, value: 'pg', secret: true }],
      complete: true,
    });
    expect(position('pg@q-pg', source, secrets)).toBe(`${U}@q-pg`);
  });
});
