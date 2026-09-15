import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import {
  clearRecordedSecretExpressions,
  inheritedParameterExpression,
  markSameGenerationBag,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  recordSecretExpression,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * A NUMBER or BOOLEAN `Fn::Join` part is literal text to the three readers of
 * the intrinsic parser (issue #3055).
 *
 * The resolver joins every part as `String(part)` once `resolveValue` has
 * returned a number or boolean unchanged, so `8080` contributes `8080`. The
 * parser read only a STRING part as literal and made a number or boolean an
 * unknowable part, which cost:
 *
 * - the SKELETON arm: it wildcarded the position, so two recorded references
 *   that differ only there both matched, the uniqueness rule refused, and the
 *   leaf fell to the value scan -- which writes the collapsed map's SURVIVOR,
 *   the wrong reference for this leaf;
 * - the FRAME arm: it rendered a placeholder, so the frame (the `port` +
 *   `8080` prefix below) no longer equalled the leaf's text around the middle,
 *   the arm refused, and a 1-3 character middle stayed in plaintext;
 * - the NESTED-STACK parameter recorder: `frameSpellingOf` carries a framed
 *   parameter only when the frame arm rewrote it, so it carried nothing. Its
 *   case below pins that DOWNSTREAM effect of the frame arm's reading; the
 *   recorder's own rendering of a part outside the token does not decide it.
 *
 * A synth probe (aws-cdk-lib in this repo) found no L2 construct emitting such a
 * part: a TypeScript number interpolated, or `Token.asString(8080)`, is folded
 * into the literal string before the template is written. A non-string part
 * reaches a template through a hand-written `Lazy.any` inside `Fn.join` or a
 * raw template, which is why these cases are unit-only.
 */

describe('a number or boolean Fn::Join part is literal text to the intrinsic parser (#3055)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  describe('the SKELETON arm', () => {
    const tokenFor = (id: string): string => `{{resolve:secretsmanager:${id}:SecretString:pw}}`;
    const PLAINTEXT = 'shared-pw-3055';

    /**
     * References that differ ONLY in the secret id, collapsed onto one
     * plaintext: the map holds the LAST one, so a value scan hands every leaf
     * that survivor. Each reference is a recorded secret EXPRESSION (the
     * skeleton arm's candidate list) but NO pass-local pair is recorded -- a
     * pair would let the frame arm answer the same whole-token leaf once the
     * skeleton arm refuses, and the case would stop isolating the skeleton
     * reader. The shape is real: the expression store is process-wide, so a
     * reference an earlier pass pinned carries no pair in this pass's bag.
     */
    function collapsed(...ids: string[]): RecordedSecretValues {
      const secrets: RecordedSecretValues = new Map();
      for (const id of ids) {
        secrets.set(PLAINTEXT, tokenFor(id));
        recordSecretExpression(tokenFor(id));
      }
      return secrets;
    }

    function persistedPassword(secrets: RecordedSecretValues, part: unknown): unknown {
      const source = {
        Password: { 'Fn::Join': ['', ['{{resolve:secretsmanager:', part, ':SecretString:pw}}']] },
      };
      return (redactSecretsForState({ Password: PLAINTEXT }, secrets, source) as Record<string, unknown>)[
        'Password'
      ];
    }

    for (const [label, part, own, survivor] of [
      ['a number part', 8080, '8080', '9090'],
      ['a boolean part', true, 'true', 'false'],
      ['the same number as a string part (control: unchanged by the fix)', '8080', '8080', '9090'],
    ] as const) {
      it(`positions the leaf on the ONE candidate that spells ${label}, not the collapsed map's survivor`, () => {
        const secrets = collapsed(own, survivor);
        // Premise: the survivor is the OTHER reference, so the value scan's
        // answer is distinguishable from the positioned one.
        expect(secrets.get(PLAINTEXT)).toBe(tokenFor(survivor));
        expect(redactSecretsForState(PLAINTEXT, secrets)).toBe(tokenFor(survivor));
        // Premise: the pass recorded NO pair for the leaf's own reference, so the
        // frame arm (which needs one) cannot answer and the skeleton arm alone
        // decides the leaf. Read through the embedded-span arm, which writes a
        // literal leaf's own token only with that pair and otherwise leaves the
        // value scan's survivor.
        expect(
          redactSecretsForState(markSameGenerationBag({ L: `x:${PLAINTEXT}` }), secrets, {
            L: `x:${tokenFor(own)}`,
          })
        ).toEqual({ L: `x:${tokenFor(survivor)}` });

        expect(persistedPassword(secrets, part)).toBe(tokenFor(own));
      });
    }

    it('keeps a null part unknowable: it matches EVERY candidate, including one spelling `null`, so the leaf falls to the value scan', () => {
      // A reference spells `null` at the position. Read as the literal text
      // `null` the part would match it ALONE and position the leaf on it;
      // unknowable, it matches all three and the uniqueness rule refuses.
      const secrets = collapsed('null', '8080', '9090');
      expect(secrets.get(PLAINTEXT)).toBe(tokenFor('9090'));

      expect(persistedPassword(secrets, null)).toBe(tokenFor('9090'));
    });

    it('REFUSES a number delimiter, so the leaf falls to the value scan: the refusal is a decision the parser records, pinned here', () => {
      const secrets = collapsed('8080', '9090');
      const parts = ['{{resolve:secretsmanager:', ':SecretString:pw}}'];
      // Premise: read as `String(8080)`, the delimiter would spell the 8080
      // reference exactly, so a relaxed guard would position the leaf there.
      expect(parts.join(String(8080))).toBe(tokenFor('8080'));
      const source = { Password: { 'Fn::Join': [8080, parts] } };

      const persisted = redactSecretsForState({ Password: PLAINTEXT }, secrets, source) as Record<string, unknown>;

      expect(persisted['Password']).toBe(tokenFor('9090'));
    });

    /**
     * The residual `joinPartLiteralText`'s docstring states, measured. The
     * leaf's OWN reference is a PUBLIC ssm parameter (`/pub/8080` through the
     * `Prefix` Ref), stored resolved and so never recorded, whose value
     * coincides with two recorded SecureStrings. With the port as a wildcard
     * both candidates match, the arm refuses, and the value scan writes the
     * map's survivor -- a wrong reference already. With the port as the literal
     * `8080` ONE candidate matches, and the arm writes it: still not the
     * leaf's own reference. Bounded, since condition 1 already required the
     * leaf to be a recorded plaintext, but not narrowed by this change.
     */
    for (const [label, port, written] of [
      ['the port as a wildcard (the reading before #3055)', { Ref: 'Port' }, '{{resolve:ssm:/sec/9090}}'],
      ['the port as the literal number 8080', 8080, '{{resolve:ssm:/sec/8080}}'],
    ] as const) {
      it(`writes a reference other than a public leaf's own with ${label}`, () => {
        const secrets: RecordedSecretValues = new Map();
        for (const token of ['{{resolve:ssm:/sec/8080}}', '{{resolve:ssm:/sec/9090}}']) {
          secrets.set(PLAINTEXT, token);
          recordSecretExpression(token);
        }
        expect(secrets.get(PLAINTEXT)).toBe('{{resolve:ssm:/sec/9090}}');
        const source = {
          Password: { 'Fn::Join': ['', ['{{resolve:ssm:', { Ref: 'Prefix' }, '/', port, '}}']] },
        };

        const persisted = redactSecretsForState({ Password: PLAINTEXT }, secrets, source) as Record<
          string,
          unknown
        >;

        // `toBe(written)` is the whole claim: the leaf's own `/pub/8080` is in
        // no store, the bag or the source (redaction never resolves the
        // `Prefix` Ref), so no implementation could write it and a
        // `not.toBe` against it would measure nothing (issue #3143). What
        // lets the wrong reference through is asserted above: the map's
        // survivor is `/sec/9090`, so condition 3 has no plaintext of
        // `/sec/8080`'s own to refuse it by.
        expect(persisted['Password']).toBe(written);
      });
    }
  });

  describe('the FRAME arm', () => {
    const TOKEN = '{{resolve:secretsmanager:prod/db:SecretString:pin}}';
    const PIN = 'q7';

    function resolvedAlone(): RecordedSecretValues {
      const secrets: RecordedSecretValues = new Map([[PIN, TOKEN]]);
      recordResolvedPair(secrets, TOKEN, PIN);
      return secrets;
    }

    // `0` and `false` are the falsy members of the accepted domain: a
    // truthiness test in place of the type test would drop exactly these.
    for (const [label, part, text] of [
      ['a number part', 8080, '8080'],
      ['a zero part', 0, '0'],
      ['a boolean part', true, 'true'],
      ['a false part', false, 'false'],
    ] as const) {
      it(`writes a 1-3 character middle as its token when ${label} sits in the frame`, () => {
        const secrets = resolvedAlone();
        const leaf = `port${text}:${PIN}`;
        // Premise: the value scan leaves a sub-floor middle alone, so only the
        // frame arm can write the token.
        expect(redactSecretsForState(leaf, secrets)).toBe(leaf);

        const bag = markSameGenerationBag({ Dsn: leaf });
        const source = { Dsn: { 'Fn::Join': ['', ['port', part, `:${TOKEN}`]] } };

        expect(redactSecretsForState(bag, secrets, source)).toEqual({ Dsn: `port${text}:${TOKEN}` });
      });
    }

    // Each leaf is the text `String(part)` would give, so reading the part as
    // that text would position it: the refusal is the part staying unknowable.
    for (const [label, part, text] of [
      ['null', null, 'null'],
      ['an array', ['8080'], '8080'],
      ['a plain object', {}, '[object Object]'],
    ] as const) {
      it(`still refuses a frame whose part is ${label}, keeping the middle in plaintext`, () => {
        const secrets = resolvedAlone();
        const leaf = `port${text}:${PIN}`;
        const bag = markSameGenerationBag({ Dsn: leaf });
        const source = { Dsn: { 'Fn::Join': ['', ['port', part, `:${TOKEN}`]] } };
        expect(redactSecretsForState(bag, secrets, source)).toEqual({ Dsn: leaf });
      });
    }
  });

  describe('the NESTED-STACK parameter recorder, which reads the frame arm through frameSpellingOf', () => {
    const TOKEN = '{{resolve:secretsmanager:prod/db:SecretString:pin}}';
    const PIN = 'q7';
    const NESTED = 'AWS::CloudFormation::Stack';

    it('carries a framed parameter whose frame holds a number part to the child as a whole-value entry', () => {
      const parent: RecordedSecretValues = new Map([[PIN, TOKEN]]);
      recordResolvedPair(parent, TOKEN, PIN);
      const value = `port8080:${PIN}`;
      // Premise: the value scan is silent on the framed value, so only the
      // carry can give the child an entry for it.
      expect(redactSecretsForState(value, parent)).toBe(value);
      const resolved = { Parameters: { Pin: value } };
      const source = { Parameters: { Pin: { 'Fn::Join': ['', ['port', 8080, `:${TOKEN}`]] } } };

      recordNestedStackParameterExpressions(parent, NESTED, resolved, source);

      expect(parent.get(value)).toBe(`port8080:${TOKEN}`);
      expect(inheritedParameterExpression(parent, 'Pin', value)).toBe(`port8080:${TOKEN}`);
    });

    it('records nothing for a null part in the same frame', () => {
      const parent: RecordedSecretValues = new Map([[PIN, TOKEN]]);
      recordResolvedPair(parent, TOKEN, PIN);
      const value = `portnull:${PIN}`;
      const source = { Parameters: { Pin: { 'Fn::Join': ['', ['port', null, `:${TOKEN}`]] } } };

      recordNestedStackParameterExpressions(parent, NESTED, { Parameters: { Pin: value } }, source);

      expect(parent.has(value)).toBe(false);
      expect(parent.size).toBe(1);
      expect(inheritedParameterExpression(parent, 'Pin', value)).toBeUndefined();
    });
  });
});
