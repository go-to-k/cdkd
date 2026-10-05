import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  recordSecretExpression,
  clearRecordedSecretExpressions,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_READBACK_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import {
  contradictProvenPublicExpression,
  isProvenPublicExpression,
  recordProvenPublicExpression,
} from '../../../src/deployment/secret-redaction/mask-only.js';

/**
 * Issue [#2036](https://github.com/go-to-k/cdkd/issues/2036): a PUBLIC ssm
 * MIXED leaf on an EMPTY-map readback path keeps the value AWS holds once the
 * bag carries a PROOF that its parameter is public, and is still refused
 * without one.
 *
 * The proof is per BAG INSTANCE (`recordProvenPublicExpression`), never per
 * bare expression: PR #2415 withdrew a process-wide public store because a
 * verdict read where the parameter is a `String` un-redacted a same-named
 * `SecureString` in another region. Every case below that expects a REFUSAL is
 * a way the proof must fail closed.
 */

const PUBLIC = '{{resolve:ssm:/app/public-host}}';
const PUBLIC_B = '{{resolve:ssm:/app/public-port}}';
const SECURE = '{{resolve:ssm:/app/secure-token}}';
const SM = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const PUBLIC_VALUE = 'db.public.example.internal';
const SECRET_VALUE = 'the-real-decrypted-secret-value';

const MIXED_SOURCE = `https://${PUBLIC}/health`;
const MIXED_READBACK = `https://${PUBLIC_VALUE}/health`;

/** An empty bag carrying a proof for each expression given. */
const provenBag = (...expressions: string[]): RecordedSecretValues => {
  const bag: RecordedSecretValues = new Map();
  for (const expression of expressions) recordProvenPublicExpression(bag, expression);
  return bag;
};

const baseline = (
  readback: unknown,
  source: unknown,
  bag: RecordedSecretValues
): Record<string, unknown> =>
  redactSecretsForState(readback, bag, source, STATE_SOURCED_BASELINE_RULES) as Record<
    string,
    unknown
  >;

afterEach(() => {
  clearRecordedSecretExpressions();
});

describe('a PROVEN public ssm mixed leaf on an empty map (issue #2036)', () => {
  it('keeps the value AWS reported when the bag proves its parameter public', () => {
    const out = baseline({ Url: MIXED_READBACK }, { Url: MIXED_SOURCE }, provenBag(PUBLIC));
    expect(out['Url']).toBe(MIXED_READBACK);
  });

  it('keeps it under the plain READBACK constant too (the drift --revert / --accept rows)', () => {
    const out = redactSecretsForState(
      { Url: MIXED_READBACK },
      provenBag(PUBLIC),
      { Url: MIXED_SOURCE },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;
    expect(out['Url']).toBe(MIXED_READBACK);
  });

  it('CONTROL: without a proof the same leaf is still refused (takes the expression)', () => {
    const out = baseline({ Url: MIXED_READBACK }, { Url: MIXED_SOURCE }, new Map());
    expect(out['Url']).toBe(MIXED_SOURCE);
  });

  it('the proof belongs to its BAG: a copy of a proven bag proves nothing', () => {
    const proven = provenBag(PUBLIC);
    const out = baseline({ Url: MIXED_READBACK }, { Url: MIXED_SOURCE }, new Map(proven));
    expect(out['Url']).toBe(MIXED_SOURCE);
  });

  it('a proof for ANOTHER expression does not cover this one', () => {
    const out = baseline({ Url: MIXED_READBACK }, { Url: MIXED_SOURCE }, provenBag(PUBLIC_B));
    expect(out['Url']).toBe(MIXED_SOURCE);
  });

  it('EVERY token must be proven: a secretsmanager token beside a proven one refuses the leaf', () => {
    const source = `${PUBLIC}:${SM}`;
    const readback = `${PUBLIC_VALUE}:${SECRET_VALUE}`;
    const out = baseline({ Conn: readback }, { Conn: source }, provenBag(PUBLIC));
    expect(out['Conn']).toBe(source);
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
  });

  it('EVERY token must be proven: an unproven ssm token beside a proven one refuses the leaf', () => {
    const source = `${PUBLIC}:${SECURE}`;
    const readback = `${PUBLIC_VALUE}:${SECRET_VALUE}`;
    const out = baseline({ Conn: readback }, { Conn: source }, provenBag(PUBLIC));
    expect(out['Conn']).toBe(source);
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
  });

  it('two tokens both proven keep the readback', () => {
    const source = `${PUBLIC}:${PUBLIC_B}`;
    const readback = `${PUBLIC_VALUE}:5432`;
    const out = baseline({ Conn: readback }, { Conn: source }, provenBag(PUBLIC, PUBLIC_B));
    expect(out['Conn']).toBe(readback);
  });

  it('a whole `ssm-secure` token is never a plain-ssm proof subject', () => {
    const source = `x-{{resolve:ssm-secure:/app/public-host}}`;
    const out = baseline(
      { V: `x-${SECRET_VALUE}` },
      { V: source },
      provenBag('{{resolve:ssm-secure:/app/public-host}}')
    );
    expect(out['V']).toBe(source);
  });
});

describe('the proof fails closed', () => {
  it('a contradiction in the same bag voids a proof, in either order', () => {
    const after = provenBag(PUBLIC);
    contradictProvenPublicExpression(after, PUBLIC);
    const before: RecordedSecretValues = new Map();
    contradictProvenPublicExpression(before, PUBLIC);
    recordProvenPublicExpression(before, PUBLIC);
    for (const bag of [after, before]) {
      expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
      expect(baseline({ Url: MIXED_READBACK }, { Url: MIXED_SOURCE }, bag)['Url']).toBe(
        MIXED_SOURCE
      );
    }
  });

  it('a process-wide SECRET verdict for the expression (any scope) voids the proof', () => {
    const bag = provenBag(PUBLIC);
    recordSecretExpression(PUBLIC);
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
    expect(baseline({ Url: MIXED_READBACK }, { Url: MIXED_SOURCE }, bag)['Url']).toBe(MIXED_SOURCE);
  });

  it('a bag that itself resolved the expression as a SECRET voids the proof', () => {
    const bag = provenBag(PUBLIC);
    bag.set(SECRET_VALUE, PUBLIC);
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });
});

describe('the derived value scan still owns a proven leaf (readback-certification mark mode)', () => {
  it('a needle certified ELSEWHERE in the record still reaches a proven-public leaf', () => {
    // `Pw` is a certified whole-token position, so the pass learns
    // `SECRET_VALUE -> SM` and scans the record with it. The proven leaf
    // embeds that plaintext (contrived, but it is the shape that decides
    // whether the leaf is "decided" or left to the scan). Marked DECIDED, the
    // merge would keep it verbatim and persist the secret.
    const source = { Pw: SM, Url: `https://${PUBLIC}/x` };
    const readback = { Pw: SECRET_VALUE, Url: `https://${PUBLIC_VALUE}/${SECRET_VALUE}` };
    const out = baseline(readback, source, provenBag(PUBLIC));
    expect(out['Pw']).toBe(SM);
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
    expect(out['Url']).toBe(`https://${PUBLIC_VALUE}/${SM}`);
  });

  it('a proven-public leaf teaches NO needle: a sibling holding the public value is left alone', () => {
    // Refused, the mixed leaf LEARNS `<public value> -> PUBLIC` and the scan
    // rewrites every other leaf equal to it — Phase 1f3's "blast radius". A
    // proven leaf is not a secret's resolved form, so nothing is learned.
    const source = { Host: `${PUBLIC}:5432` };
    const readback = { Host: `${PUBLIC_VALUE}:5432`, Endpoint: PUBLIC_VALUE };
    const proven = baseline(readback, source, provenBag(PUBLIC));
    expect(proven).toEqual({ Host: `${PUBLIC_VALUE}:5432`, Endpoint: PUBLIC_VALUE });
    // CONTROL: the unproven run learns and propagates, which is what makes the
    // assertion above discriminate.
    const unproven = baseline(readback, source, new Map());
    expect(unproven['Endpoint']).toBe(PUBLIC);
  });
});
