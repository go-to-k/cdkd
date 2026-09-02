import { describe, it, expect } from 'vite-plus/test';
import {
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  carriesSecretMask,
  clearRecoverableMaskedOutputs,
  maskSecretsInText,
  recordMaskOnlyValue,
  recordMaskOnlyValuesIn,
  recordRecoverableMaskedOutput,
  recoverMaskedOutput,
  redactSecretsForState,
  scrubResourceRecord,
  wholeStringLeavesOf,
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
      expect(secrets.get(NOECHO)).toBeUndefined();
      expect(redactSecretsForState({ Value: '' }, secrets)).toEqual({ Value: '' });
    });

    it('does NOT demote an EXPRESSION already recorded for the same plaintext', () => {
      // An expression is strictly better than a mask: it is re-resolvable, it
      // survives `drift --revert` and the rollback replay, and it reaches the
      // substring arm. A later mask-only registration must not take that away.
      const secrets: RecordedSecretValues = new Map([[DYNREF_PLAINTEXT, DYNREF_EXPR]]);
      recordMaskOnlyValue(secrets, DYNREF_PLAINTEXT);

      expect(secrets.get(DYNREF_PLAINTEXT)).toBe(DYNREF_EXPR);
      expect(redactSecretsForState({ Value: DYNREF_PLAINTEXT }, secrets)).toEqual({
        Value: DYNREF_EXPR,
      });
    });

    it('stops being mask-only once the resolver records a real expression for it', () => {
      // `isMaskOnlyPlaintext` reads the MAP, and the sentinel value IS the
      // marker, so an entry the resolver later overwrites with a real
      // expression earns the substring arm back on the next walk.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, DYNREF_PLAINTEXT);
      expect(secrets.get(DYNREF_PLAINTEXT)).toBe(SECRET_MASK);

      secrets.set(DYNREF_PLAINTEXT, DYNREF_EXPR);
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

  describe('the needle FLOOR — a mask-only needle has no position behind it', () => {
    // Review finding (issue #2274 round 2). The whole-value arm substitutes at
    // ANY length, and an expression-bearing pair can afford that because it
    // came from a POSITION cdkd resolved. A mask-only pair is a bare plaintext,
    // so a short one masks every leaf equal to it — unrecoverably, since there
    // is no expression to re-resolve, and on every later run, because the mask
    // then trips the deploy refusal, the rollback refusal and the export
    // blocker.
    it('refuses a plaintext below MIN_NEEDLE_LENGTH', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Count: '7', Ok: 'yes', Empty: '' }, secrets);

      expect(secrets.size).toBe(0);
      // The discriminator: UNRELATED properties whose whole value equals one of
      // those are left alone. Before the floor each became `***` and stayed
      // that way, on every later run, with nothing able to recover it.
      expect(redactSecretsForState({ Retries: '7', Enabled: 'yes', Note: '' }, secrets)).toEqual({
        Retries: '7',
        Enabled: 'yes',
        Note: '',
      });
    });

    it('still records a value AT the floor, so the bound is not off by one', () => {
      const atFloor = 'a'.repeat(MIN_NEEDLE_LENGTH);
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValue(secrets, atFloor);

      expect(secrets.get(atFloor)).toBe(SECRET_MASK);
    });

    it('STATES the residual: a 4-character Data value is still a needle', () => {
      // `MIN_NEEDLE_LENGTH` is 4, so `Data: { Ready: "true" }` clears it and a
      // property whose whole value is `"true"` IS masked. That bound is the
      // module's own — shared with the substring arm so the two cannot
      // disagree about what is too short to distinguish — rather than one this
      // channel invented, and the remedy is a handler contract: do not declare
      // `NoEcho` over a response whose `Data` mixes a secret with short
      // non-secret members. Asserted so the bound is a recorded decision
      // instead of a surprise.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ Ready: 'true' }, secrets);

      expect(secrets.get('true')).toBe(SECRET_MASK);
    });
  });

  describe('the EXCLUDED set — cdkd never masks its own inputs back at itself', () => {
    // Review finding (issue #2274 round 2), the security half. A handler
    // echoing `event.ResourceProperties` into its `Data` — what the CDK
    // `Provider` samples encourage — makes `Data.FunctionArn` equal the
    // resource's own `ServiceToken`. Registering that rewrites
    // `properties.ServiceToken` to `***` in the very record
    // `CustomResourceProvider.delete` reads it back from, where the mask is a
    // TRUTHY STRING that passes both of that method's guards.
    const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:111122223333:function:CrHandler';

    it('skips a leaf the resource own properties already carry', () => {
      const ownProperties = { ServiceToken: SERVICE_TOKEN, Seed: 'integ-seed' };
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(
        { FunctionArn: SERVICE_TOKEN, Token: NOECHO },
        secrets,
        wholeStringLeavesOf(ownProperties)
      );

      // The genuinely handler-generated value IS a needle...
      expect(secrets.get(NOECHO)).toBe(SECRET_MASK);
      // ...and the echoed input is NOT, so the record keeps an addressable
      // ServiceToken. This is the assertion that reds when the exclusion is
      // dropped.
      expect(secrets.get(SERVICE_TOKEN)).toBeUndefined();
      expect(scrubResourceRecord({ properties: ownProperties }, secrets).properties).toEqual(
        ownProperties
      );
    });

    it('masks everything when no exclusion set is supplied', () => {
      // The negative twin: the exclusion is opt-in per call site, so a caller
      // that passes nothing keeps the pre-fix behaviour. Without this the case
      // above could pass by `recordMaskOnlyValuesIn` simply never recording an
      // ARN-shaped value.
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn({ FunctionArn: SERVICE_TOKEN }, secrets);

      expect(secrets.get(SERVICE_TOKEN)).toBe(SECRET_MASK);
    });
  });

  describe('the two walks agree about DEPTH', () => {
    // Review finding (issue #2274 round 2). The walk that WRITES the mask
    // (`redactSecretsForState`) is unbounded, so a depth cap on the
    // recognition side made a mask deeper than the cap persist while reading
    // as clean — after which the rollback replay, the export blocker and
    // `noteAttributeSecrecy` all missed it and `***` could ship to AWS.
    const DEEP = 14;
    function nest(leaf: unknown): unknown {
      let node: unknown = leaf;
      for (let i = 0; i < DEEP; i++) node = { down: node };
      return node;
    }

    it('recognises a mask nested deeper than the retired 10-level cap', () => {
      expect(carriesSecretMask(nest(SECRET_MASK))).toBe(true);
    });

    it('records a needle nested that deep, so the mask gets there in the first place', () => {
      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(nest(NOECHO), secrets);

      expect(secrets.get(NOECHO)).toBe(SECRET_MASK);
      expect(carriesSecretMask(redactSecretsForState(nest(NOECHO), secrets))).toBe(true);
    });

    it('terminates on a self-referential structure', () => {
      // What the depth cap was reaching for. A visited-set answers it without
      // capping depth; without either, both walks recurse forever.
      const cyclic: Record<string, unknown> = { Token: NOECHO };
      cyclic['self'] = cyclic;

      const secrets: RecordedSecretValues = new Map();
      recordMaskOnlyValuesIn(cyclic, secrets);
      expect(secrets.get(NOECHO)).toBe(SECRET_MASK);

      const cyclicMask: Record<string, unknown> = { Value: SECRET_MASK };
      cyclicMask['self'] = cyclicMask;
      expect(carriesSecretMask(cyclicMask)).toBe(true);
    });
  });

  describe('the IN-RUN recovery store', () => {
    // Issue #2274 round 2, blocker 3. Every cross-stack route reads the
    // PRODUCER's persisted outputs, so a masked output would refuse a consumer
    // template that deployed before this feature. The store is what makes the
    // same-run case work, and its KEY is what keeps it from becoming the
    // process-wide plaintext store PR #2415 had to withdraw.
    it('answers for the exact coordinate and for nothing else', () => {
      clearRecoverableMaskedOutputs();
      recordRecoverableMaskedOutput('Producer', 'us-east-1', 'Token', NOECHO);

      expect(recoverMaskedOutput('Producer', 'us-east-1', 'Token')).toBe(NOECHO);
      // A different stack, region or output key gets NOTHING — this is the
      // assertion that separates a coordinate-keyed store from a value-keyed
      // one, which would answer for all three.
      expect(recoverMaskedOutput('OtherStack', 'us-east-1', 'Token')).toBeUndefined();
      expect(recoverMaskedOutput('Producer', 'eu-west-1', 'Token')).toBeUndefined();
      expect(recoverMaskedOutput('Producer', 'us-east-1', 'Other')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });

    it('cannot be forged by a stack name carrying the separator', () => {
      clearRecoverableMaskedOutputs();
      recordRecoverableMaskedOutput('A', 'B', 'C', NOECHO);
      // Any printable separator could be spelled inside a real stack name;
      // NUL cannot. Both spellings below would collide under a `:` or `/`.
      expect(recoverMaskedOutput('A:B', 'C', 'D')).toBeUndefined();
      expect(recoverMaskedOutput('A/B/C', '', '')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });

    it('forgets everything on clear, so a plaintext does not outlive the run', () => {
      recordRecoverableMaskedOutput('Producer', 'us-east-1', 'Token', NOECHO);
      clearRecoverableMaskedOutputs();
      expect(recoverMaskedOutput('Producer', 'us-east-1', 'Token')).toBeUndefined();
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
