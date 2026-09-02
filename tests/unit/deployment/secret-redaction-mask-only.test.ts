import { describe, it, expect } from 'vite-plus/test';
import {
  SECRET_MASK,
  carriesSecretMask,
  hasMaskOnlyValues,
  maskSecretsInText,
  recordMaskOnlyValue,
  recordMaskOnlyValuesIn,
  redactSecretsForState,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Issue #2274: the MASK-ONLY needle class. A Lambda-backed custom resource's
// handler can declare its response `Data` sensitive with `NoEcho: true`; the
// value is HANDLER-GENERATED, so there is no `{{resolve:...}}` expression to
// rewrite it onto and the mask itself is what gets persisted.
//
// Every case here fences one of the two invariants the design rests on:
//   (A) nothing plaintext survives in a bag that gets PERSISTED, and
//   (B) a mask is only ever written WHOLE, so every downstream consumer can
//       still recognise it (that is what `drift --revert` and the rollback
//       replay refuse on).
const NOECHO = 'handler-generated-secret-9f2a';
const DYNREF_PLAINTEXT = 'resolved-dynamic-ref-value';
const DYNREF_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password::}}';

describe('mask-only redaction channel (issue #2274)', () => {
  describe('recordMaskOnlyValue', () => {
    it('persists SECRET_MASK in place of a whole-leaf match', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(redactSecretsForState({ Value: NOECHO }, secrets)).toEqual({ Value: SECRET_MASK });
    });

    it('refuses the empty string, so an empty leaf is never masked', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, '');

      expect(secrets.size).toBe(0);
      expect(hasMaskOnlyValues(secrets)).toBe(false);
      expect(redactSecretsForState({ Value: '' }, secrets)).toEqual({ Value: '' });
    });

    it('does NOT demote an EXPRESSION already recorded for the same plaintext', () => {
      // An expression is strictly better than a mask: it is re-resolvable, it
      // survives `drift --revert` and the rollback replay, and it reaches the
      // substring arm. A later mask-only registration must not take that away.
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordMaskOnlyValue(secrets, DYNREF_PLAINTEXT);

      expect(secrets.get(DYNREF_PLAINTEXT)).toBe(DYNREF_EXPR);
      expect(hasMaskOnlyValues(secrets)).toBe(false);
      expect(redactSecretsForState({ Value: DYNREF_PLAINTEXT }, secrets)).toEqual({
        Value: DYNREF_EXPR,
      });
    });

    it('stops being mask-only once the resolver records a real expression for it', () => {
      // `isMaskOnlyPlaintext` re-checks the MAP value, not just the side table,
      // because the resolver writes the map directly.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, DYNREF_PLAINTEXT);
      expect(hasMaskOnlyValues(secrets)).toBe(true);

      secrets.set(DYNREF_PLAINTEXT, DYNREF_EXPR);
      expect(hasMaskOnlyValues(secrets)).toBe(false);
      // ...and the substring arm is handed back: the plaintext embedded in a
      // longer leaf is rewritten onto its expression again.
      expect(redactSecretsForState({ Url: `https://${DYNREF_PLAINTEXT}/x` }, secrets)).toEqual({
        Url: `https://${DYNREF_EXPR}/x`,
      });
    });
  });

  describe('the persist path takes a mask-only leaf WHOLE and never as a substring', () => {
    it('leaves an EMBEDDED occurrence alone in a persisted bag', () => {
      // Invariant (B). An inline `***` cannot be told apart from a literal
      // `***` a user wrote, so no consumer could recognise it and
      // `drift --revert` / `resolveReplayProps` would push the corrupted
      // string to AWS. The residual (an embedded NoEcho value keeps its
      // plaintext in state) is documented and tracked separately.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(redactSecretsForState({ Url: `https://${NOECHO}/x` }, secrets)).toEqual({
        Url: `https://${NOECHO}/x`,
      });
    });

    it('still substring-scans an EXPRESSION-bearing needle in the same bag', () => {
      // The narrowing is scoped to the mask class alone: a bag holding both
      // kinds must lose none of the dynamic-reference behaviour.
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordMaskOnlyValue(secrets, NOECHO);

      expect(
        redactSecretsForState(
          { Mixed: `user:${DYNREF_PLAINTEXT}@host`, Whole: NOECHO, Embedded: `x-${NOECHO}-y` },
          secrets
        )
      ).toEqual({
        Mixed: `user:${DYNREF_EXPR}@host`,
        Whole: SECRET_MASK,
        Embedded: `x-${NOECHO}-y`,
      });
    });
  });

  describe('maskSecretsInText participates FULLY, including the substring arm', () => {
    it('masks an embedded mask-only value in log / error text', () => {
      // A log line, an error message and an event are read back by nobody as a
      // VALUE, so a partial mask costs nothing there and closes an embedded
      // disclosure the persist path deliberately leaves.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, NOECHO);

      expect(maskSecretsInText(`failed writing ${NOECHO} to /p`, secrets)).toBe(
        `failed writing ${SECRET_MASK} to /p`
      );
      expect(maskSecretsInText(NOECHO, secrets)).toBe(SECRET_MASK);
    });
  });

  describe('recordMaskOnlyValuesIn', () => {
    it('registers every STRING leaf of a Data bag, at any nesting', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(
        { Token: NOECHO, Nested: { Inner: 'inner-secret-value' }, List: ['list-secret-value'] },
        secrets
      );

      expect(
        redactSecretsForState(
          { a: NOECHO, b: 'inner-secret-value', c: ['list-secret-value'] },
          secrets
        )
      ).toEqual({ a: SECRET_MASK, b: SECRET_MASK, c: [SECRET_MASK] });
    });

    it('skips non-string leaves — there is nothing to key a number or boolean on', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Count: 3, Flag: true, Nothing: null }, secrets);

      expect(secrets.size).toBe(0);
    });
  });

  describe('carriesSecretMask', () => {
    it('recognises a WHOLE-leaf mask at any nesting, and nothing else', () => {
      expect(carriesSecretMask(SECRET_MASK)).toBe(true);
      expect(carriesSecretMask({ a: { b: [SECRET_MASK] } })).toBe(true);
      expect(carriesSecretMask({ a: 'ordinary' })).toBe(false);
      // Containment is deliberately NOT a match: an inline `***` is either a
      // user's own literal or text this module never wrote.
      expect(carriesSecretMask({ a: `prefix-${SECRET_MASK}` })).toBe(false);
    });
  });

  describe('scrubResourceRecord — the persist choke point', () => {
    it('masks the custom resource own ATTRIBUTES and a dependent resolved PROPERTIES', () => {
      // Invariant (A): the plaintext must not reach state.json by ANY route.
      // The two bags are scrubbed with DIFFERENT per-resource maps, exactly as
      // `perResourceSecrets` is keyed by logical id — which is why the deploy
      // engine registers the needles in the DEPENDENT's bag too.
      const crSecrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Secret: NOECHO }, crSecrets);
      const cr = scrubResourceRecord(
        { properties: { ServiceToken: 'arn:aws:lambda:...' }, attributes: { Secret: NOECHO } },
        crSecrets
      );
      expect(cr.attributes).toEqual({ Secret: SECRET_MASK });

      const dependentSecrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(dependentSecrets, NOECHO);
      const dependent = scrubResourceRecord(
        { properties: { Name: '/p', Value: NOECHO }, observedProperties: { Value: NOECHO } },
        dependentSecrets,
        { Name: '/p', Value: { 'Fn::GetAtt': ['Cr', 'Secret'] } }
      );
      expect(dependent.properties).toEqual({ Name: '/p', Value: SECRET_MASK });
      expect(dependent.observedProperties).toEqual({ Value: SECRET_MASK });
      expect(JSON.stringify(dependent)).not.toContain(NOECHO);
    });

    it('leaves a NON-NoEcho custom resource attribute in cleartext (the negative case)', () => {
      // The existing `custom-resource-getatt-data` integ requires exactly this:
      // a handler that sets no `NoEcho` must keep resolving and persisting in
      // the clear.
      const secrets: RecordedSecretValues = new Map();
      const record = scrubResourceRecord(
        { properties: {}, attributes: { ComputedValue: 'computed-integ' } },
        secrets
      );
      expect(record.attributes).toEqual({ ComputedValue: 'computed-integ' });
    });
  });
});
