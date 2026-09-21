/**
 * Issue #2743: the value scan spares a recorded plaintext lying inside a
 * complete `{{resolve:...}}` span (issue #1935), so that a plaintext which
 * coincides with a REAL reference's own text is not spliced into it. A span
 * naming a service cdkd does not resolve is not a reference, and sparing it
 * persisted `{{resolve:<plaintext>}}` — what an `Fn::Sub` putting a resolved
 * secret in the SERVICE position assembles — into `state.json`.
 *
 * Two sparing sites, each with its own case in both polarities: the walk's
 * whole-token early-out (the leaf IS the span) and `scanLeaf`'s
 * strictly-inside rule (the span is EMBEDDED in a longer leaf).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  clearRecordedSecretExpressions,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const SENTINEL = 'sentinel-plaintext-2743';
const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const secrets = (): RecordedSecretValues => new Map([[SENTINEL, EXPR]]);

const WHOLE = `{{resolve:${SENTINEL}}}`;
const EMBEDDED = `x-{{resolve:${SENTINEL}}}-y`;
const WITH_TAIL = `x-{{resolve:svc-${SENTINEL}:name}}-y`;

describe('secret-redaction - a span of an unresolvable service is not spared (issue #2743)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('WHOLE-LEAF shape: the plaintext inside the bogus token is replaced by its expression', () => {
    const out = redactSecretsForState({ Leak: WHOLE }, secrets()) as Record<string, unknown>;

    expect(out['Leak']).toBe(`{{resolve:${EXPR}}}`);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('EMBEDDED shape: the same, with the surrounding text untouched', () => {
    const out = redactSecretsForState(
      { A: EMBEDDED, B: WITH_TAIL },
      secrets()
    ) as Record<string, unknown>;

    expect(out['A']).toBe(`x-{{resolve:${EXPR}}}-y`);
    expect(out['B']).toBe(`x-{{resolve:svc-${EXPR}:name}}-y`);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('is IDEMPOTENT under the same map: a second pass changes nothing', () => {
    const bag = { Leak: WHOLE, A: EMBEDDED, B: WITH_TAIL, Nested: [{ C: EMBEDDED }] };
    const once = redactSecretsForState(bag, secrets());
    const twice = redactSecretsForState(once, secrets());

    expect(twice).toEqual(once);
    expect(JSON.stringify(once)).not.toContain(SENTINEL);
  });

  it('stays idempotent when a LATER needle occurs in the reference this rule wrote', () => {
    // The redacted form nests a REAL reference behind an unresolvable opener,
    // and the leftmost span scan reports only the outer span. `password` is
    // both an ordinary JSON key and an ordinary secret value: without the
    // nested-reference scan a second pass spliced it into the reference this
    // module had just written, and again on every pass after that.
    const later: RecordedSecretValues = new Map([
      [SENTINEL, EXPR],
      ['password', '{{resolve:secretsmanager:other:SecretString:k}}'],
    ]);
    const once = redactSecretsForState({ whole: WHOLE, embedded: EMBEDDED }, later);
    const twice = redactSecretsForState(once, later);

    expect(once).toEqual({ whole: `{{resolve:${EXPR}}}`, embedded: `x-{{resolve:${EXPR}}}-y` });
    expect(twice).toEqual(once);
  });

  it('protects a reference behind a stray unresolvable opener only when the pass VOUCHES for it', () => {
    const vouchedRef = '{{resolve:secretsmanager:N:SecretString:password}}';
    const leaf = `{{resolve:foo ${vouchedRef} tail-password`;
    const out = redactSecretsForState(
      { leaf },
      new Map([
        ['password', '{{resolve:ssm:/p}}'],
        ['some-other-plaintext', vouchedRef],
      ])
    ) as Record<string, unknown>;
    expect(out['leaf']).toBe(`{{resolve:foo ${vouchedRef} tail-{{resolve:ssm:/p}}`);

    // Unvouched, the nested token is ordinary text behind an unresolvable
    // opener: it could as well be a plaintext assembled one level deeper, so
    // redacting wins over keeping already-unresolvable text intact.
    const unvouched = redactSecretsForState(
      { leaf },
      new Map([['password', '{{resolve:ssm:/p}}']])
    ) as Record<string, unknown>;
    expect(unvouched['leaf']).toBe(
      '{{resolve:foo {{resolve:secretsmanager:N:SecretString:{{resolve:ssm:/p}}}} tail-{{resolve:ssm:/p}}'
    );
  });

  it('a NESTED resolvable-service token the pass cannot vouch for does not shelter a plaintext', () => {
    // A secret assembled one level deeper, as an older binary persisted it.
    // The nested token is not an expression of this pass's map, so it is not
    // protected, and the plaintext inside it is replaced.
    const out = redactSecretsForState(
      {
        a: `{{resolve:x-{{resolve:ssm:${SENTINEL}}}}}`,
        b: `{{resolve:{{resolve:secretsmanager:${SENTINEL}}}`,
        c: `a {{resolve:bogus:{{resolve:ssm-secure:/p/${SENTINEL}}} b`,
      },
      secrets()
    );

    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('a resolvable opener with no closer of its own does not borrow a later token\'s end', () => {
    const out = redactSecretsForState(
      { a: `{{resolve:ssm:x}y {{resolve:${SENTINEL}}}` },
      new Map([
        [SENTINEL, EXPR],
        // Vouches for the text the borrowed span would cover, so only the
        // `start === 0` guard stands between this leaf and a spared plaintext.
        ['unrelated-value', `{{resolve:ssm:x}y {{resolve:${SENTINEL}}}`],
      ])
    ) as Record<string, unknown>;

    expect(out['a']).toBe(`{{resolve:ssm:x}y {{resolve:${EXPR}}}`);
  });

  it('a near-miss service spelling is NOT a resolvable one', () => {
    // The trailing colon of each prefix is what is pinned: `ssmX` and
    // `secretsmanager<text>` name no service cdkd resolves.
    const out = redactSecretsForState(
      { a: `{{resolve:ssmX-${SENTINEL}}}`, b: `{{resolve:secretsmanager${SENTINEL}}}` },
      secrets()
    );

    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('a plaintext holding a `}` forms no token at all, and is redacted as ordinary text', () => {
    // The resolver's grammar stops at the first `}`, so it sees no token to
    // refuse here; the value scan is the layer that answers for this shape.
    const holed = 'pa}ss-longer';
    const out = redactSecretsForState(
      { a: `{{resolve:${holed}}}` },
      new Map([[holed, EXPR]])
    ) as Record<string, unknown>;

    expect(out['a']).toBe(`{{resolve:${EXPR}}}`);
  });

  it('a WHOLE bogus token is healed under a whole-token SOURCE too, on every rules constant', () => {
    // The path pass keeps a whole-token bag verbatim when the source cannot
    // certify its generation, so that a previous generation's EXPRESSION is
    // not overwritten. A token of an unresolvable service is not an
    // expression; this is the shape `cdkd scrub` meets when the template was
    // corrected to a direct reference before the leaked record was scrubbed.
    for (const rules of [
      TEMPLATE_DERIVED_RULES,
      TEMPLATE_SOURCED_RULES,
      STATE_SOURCED_CROSS_GENERATION_RULES,
    ]) {
      const out = redactSecretsForState({ A: WHOLE }, secrets(), { A: EXPR }, rules);
      expect(out).toEqual({ A: `{{resolve:${EXPR}}}` });
    }
  });

  it('an UNTAINTED look-alike whose text coincides with a LATER-recorded secret is rewritten like any other text', () => {
    // Stated because it is a cost, not a goal: the resolver saw no secret in
    // this token when it passed it (the secret was recorded afterwards), so it
    // was not refused, and the value scan treats its text as ordinary text --
    // the same trade the substring arm makes for `https://admin.example.com`.
    const out = redactSecretsForState(
      { A: `{{resolve:foo:bar-${SENTINEL}}}` },
      secrets()
    ) as Record<string, unknown>;

    expect(out['A']).toBe(`{{resolve:foo:bar-${EXPR}}}`);
  });

  it('KNOWN services keep the #1935 protection, in both shapes', () => {
    // The other polarity of the two cases above: every service cdkd resolves
    // still spares a needle inside its own token text.
    for (const service of ['secretsmanager', 'ssm', 'ssm-secure']) {
      const whole = `{{resolve:${service}:${SENTINEL}/x}}`;
      const embedded = `x-${whole}-y`;
      const out = redactSecretsForState({ whole, embedded }, secrets()) as Record<string, unknown>;

      expect(out['whole']).toBe(whole);
      expect(out['embedded']).toBe(embedded);
    }
  });

  it('GOLDEN: the protected known-service shapes and the mangled legacy leaf are byte-identical to origin/main', () => {
    // The expected strings were PRODUCED by running `origin/main`'s
    // `redactSecretsForState` (9ae4faf30, before this change) over these exact
    // inputs, and pasted here as literals. They are not re-derived from the
    // rule, so a change that moves any of them fails against the old binary's
    // own answer.
    const SM = '{{resolve:secretsmanager:appdb/creds:SecretString:password}}';
    const SSM = '{{resolve:ssm:/app/dbname}}';
    const out = redactSecretsForState(
      {
        mixed: `jdbc://appdb:${SM}@host`,
        whole: SM,
        mangled: `jdbc://${SSM}:{{resolve:secretsmanager:${SSM}/creds:SecretString:password}}@host`,
        mangledWithNeedle: `jdbc://appdb:{{resolve:secretsmanager:${SSM}/appdb:SecretString:password}}@host`,
        ssmSecure: 'x-{{resolve:ssm-secure:/appdb/pw}}-y',
        ssm: 'x-{{resolve:ssm:/appdb/pw}}-y',
      },
      new Map([['appdb', SSM]])
    );

    expect(out).toEqual({
      mixed:
        'jdbc://{{resolve:ssm:/app/dbname}}:{{resolve:secretsmanager:appdb/creds:SecretString:password}}@host',
      whole: '{{resolve:secretsmanager:appdb/creds:SecretString:password}}',
      mangled:
        'jdbc://{{resolve:ssm:/app/dbname}}:{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/creds:SecretString:password}}@host',
      mangledWithNeedle:
        'jdbc://{{resolve:ssm:/app/dbname}}:{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/{{resolve:ssm:/app/dbname}}:SecretString:password}}@host',
      ssmSecure: 'x-{{resolve:ssm-secure:/appdb/pw}}-y',
      ssm: 'x-{{resolve:ssm:/appdb/pw}}-y',
    });
  });

  it('an untainted look-alike token is left exactly as written', () => {
    // No needle occurs in it, so the narrowed rule has nothing to decide:
    // `cdkd drift` reports such a token per leaf and relies on it surviving.
    const leaf = 'a-{{resolve:notaservice:/x}}-b';
    const out = redactSecretsForState(
      { leaf, whole: '{{resolve:notaservice:/x}}' },
      secrets()
    ) as Record<string, unknown>;

    expect(out['leaf']).toBe(leaf);
    expect(out['whole']).toBe('{{resolve:notaservice:/x}}');
  });

  describe('the readers that inherit the rule without being edited', () => {
    it('a record scrub heals every bag of a record an older binary leaked into', () => {
      // `scrubResourceRecord` is what the rollback journal's `previousState`
      // and the engine's failure-path save run; `attributes` and an
      // `observedProperties` key its `properties` lack have no position source
      // and fall to the value scan.
      const scrubbed = scrubResourceRecord(
        {
          properties: { Value: WHOLE },
          observedProperties: { Value: WHOLE, Extra: EMBEDDED },
          attributes: { Echo: EMBEDDED },
        },
        secrets()
      );

      expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL);
      expect(scrubbed.properties['Value']).toBe(`{{resolve:${EXPR}}}`);
      expect(scrubbed.attributes!['Echo']).toBe(`x-{{resolve:${EXPR}}}-y`);
    });

    it("`cdkd scrub`'s unaccounted-output repair heals a leaked `state.outputs` value", () => {
      // `scrub.ts` repairs an output no template position accounts for with
      // `redactSecretsForState(value, secrets)` over the STORED value. That
      // call is reproduced here rather than driven through the command: the
      // behaviour delta is this function's, and the command is not edited.
      expect(redactSecretsForState(WHOLE, secrets())).toBe(`{{resolve:${EXPR}}}`);
      expect(redactSecretsForState([EMBEDDED], secrets())).toEqual([`x-{{resolve:${EXPR}}}-y`]);
    });
  });
});
