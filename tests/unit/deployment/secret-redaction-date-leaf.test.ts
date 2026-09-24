import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  clearRecordedSecretExpressions,
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_DERIVED_RULES,
} from '../../../src/deployment/secret-redaction.js';

/**
 * Issue [#2427](https://github.com/go-to-k/cdkd/issues/2427) — the VALUE scan
 * rebuilt every object it walked, and `Object.entries(new Date())` is `[]`, so a
 * `Date` an AWS SDK readback carries (`LastModified`, `CreationDate`) came back
 * as `{}` whenever the secrets map was POPULATED. `observedProperties` is the
 * drift baseline, so the `{}` was a permanent phantom drift and a value
 * `cdkd drift --revert` could push.
 *
 * The map is populated in every case below on purpose: with an empty map and
 * no source the scan returns the bag by identity, which would pass pre-fix.
 */
const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const PLAINTEXT = 'hunter2secret-resolved';
const ISO = '2026-01-01T00:00:00.000Z';

function secrets(): Map<string, string> {
  return new Map([[PLAINTEXT, EXPR]]);
}

describe('redactSecretsForState keeps a readback Date (issue #2427)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('no source: the Date survives by identity beside a redacted leaf', () => {
    const when = new Date(ISO);
    const out = redactSecretsForState({ Password: PLAINTEXT, LastModified: when }, secrets());
    // The control: the scan really ran over this bag.
    expect(out.Password).toBe(EXPR);
    expect(out.LastModified).toBe(when);
    expect(JSON.stringify(out)).toBe(`{"Password":${JSON.stringify(EXPR)},"LastModified":"${ISO}"}`);
  });

  // One case per exported rules constant, each with a source bag, so the
  // position passes run and hand the Date's key (absent from the source) to the
  // value scan — the route the populated-map callers take.
  const RULE_SETS: ReadonlyArray<readonly [string, PathSourceRules]> = [
    ['TEMPLATE_DERIVED_RULES', TEMPLATE_DERIVED_RULES],
    ['TEMPLATE_SOURCED_RULES', TEMPLATE_SOURCED_RULES],
    ['STATE_SOURCED_READBACK_RULES', STATE_SOURCED_READBACK_RULES],
    ['STATE_SOURCED_BASELINE_RULES', STATE_SOURCED_BASELINE_RULES],
    ['STATE_SOURCED_CROSS_GENERATION_RULES', STATE_SOURCED_CROSS_GENERATION_RULES],
    ['STATE_DERIVED_RULES', STATE_DERIVED_RULES],
  ];
  it.each(RULE_SETS)('%s: a Date at a key the source lacks survives by identity', (_n, rules) => {
    const when = new Date(ISO);
    const out = redactSecretsForState(
      { Password: PLAINTEXT, LastModified: when },
      secrets(),
      { Password: EXPR },
      rules
    );
    expect(out.Password).toBe(EXPR);
    expect(out.LastModified).toBe(when);
  });

  it.each(RULE_SETS)(
    '%s: a Date where the SOURCE also holds a value (the divergence arm) survives',
    (_n, rules) => {
      // The source's persisted ISO string against the readback's Date: the
      // shapes diverge, so the path pass falls to the value scan at the leaf.
      const when = new Date(ISO);
      const out = redactSecretsForState(
        { Password: PLAINTEXT, LastModified: when },
        secrets(),
        { Password: EXPR, LastModified: ISO },
        rules
      );
      expect(out.Password).toBe(EXPR);
      expect(out.LastModified).toBe(when);
    }
  );

  it('a Date nested inside an array and an object survives', () => {
    const a = new Date(ISO);
    const b = new Date('2026-02-02T00:00:00.000Z');
    const out = redactSecretsForState(
      { Items: [{ At: a, Pw: PLAINTEXT }], Meta: { Created: b } },
      secrets()
    );
    expect(out.Items[0]!.At).toBe(a);
    expect(out.Items[0]!.Pw).toBe(EXPR);
    expect(out.Meta.Created).toBe(b);
  });

  it('a Date whose ISO form IS a recorded plaintext takes the whole-value arm like its string form', () => {
    // PR #3586 review: an identity return skipped the string arms, so a
    // recorded plaintext spelled as a timestamp persisted in the clear through
    // `Date.prototype.toJSON`, while the same value as a STRING was replaced.
    const map = new Map([[ISO, EXPR]]);
    const out = redactSecretsForState(
      { V: new Date(ISO), S: ISO },
      map,
      { V: EXPR, S: EXPR },
      TEMPLATE_SOURCED_RULES
    );
    expect(out.S).toBe(EXPR);
    expect(out.V).toBe(EXPR);
    expect(JSON.stringify(out)).not.toContain(ISO);
    // No source: the value scan alone.
    expect(redactSecretsForState({ V: new Date(ISO) }, map).V).toBe(EXPR);
  });

  it('an Invalid Date is kept and persists as null', () => {
    const bad = new Date(Number.NaN);
    const out = redactSecretsForState({ Password: PLAINTEXT, X: bad }, secrets());
    expect(out.X).toBe(bad);
    expect(JSON.stringify(out)).toBe(`{"Password":${JSON.stringify(EXPR)},"X":null}`);
  });

  it('scrubResourceRecord (the persist choke point) keeps an observed Date', () => {
    const when = new Date(ISO);
    const record = {
      properties: { Password: EXPR },
      observedProperties: { Password: PLAINTEXT, LastModified: when },
    };
    const out = scrubResourceRecord(record, secrets());
    const observed = out.observedProperties as Record<string, unknown>;
    expect(observed['Password']).toBe(EXPR);
    expect(observed['LastModified']).toBe(when);
  });
});

describe('the value scan still rebuilds every other non-plain object (issue #2427 scope)', () => {
  it('a class instance holding the plaintext in an own field is still redacted', () => {
    // Why the fix is Date-only: `JSON.stringify` persists a class instance's
    // OWN enumerable fields, so returning one by identity would persist the
    // plaintext the rebuild redacts.
    class Holder {
      constructor(public readonly Value: string) {}
    }
    const out = redactSecretsForState({ Obj: new Holder(PLAINTEXT) }, secrets());
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
    expect((out.Obj as unknown as Record<string, unknown>)['Value']).toBe(EXPR);
  });

  it('a Date SUBCLASS is rebuilt, so a prototype toJSON it overrides is not honoured', () => {
    class LeakyDate extends Date {
      override toJSON(): string {
        return PLAINTEXT;
      }
    }
    const out = redactSecretsForState({ When: new LeakyDate(ISO) }, secrets());
    expect(out.When).not.toBeInstanceOf(Date);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  // The three shapes below carry `Date.prototype` yet do not persist as a
  // timestamp, so an identity return would hand `JSON.stringify` something
  // other than what the fix vouches for (PR #3586 review).
  it('a Date with an own NON-enumerable toJSON is rebuilt, not persisted through it', () => {
    const d = new Date(ISO);
    Object.defineProperty(d, 'toJSON', { value: () => PLAINTEXT, enumerable: false });
    const out = redactSecretsForState({ When: d }, secrets());
    expect(out.When).not.toBe(d);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('a key-less Proxy whose traps answer Date.prototype and a toJSON is rebuilt (brand check)', () => {
    // Own keys: none (the target is empty), so only the brand check refuses it;
    // `JSON.stringify` would call the trapped `toJSON` on an identity return.
    const p = new Proxy(
      {},
      {
        getPrototypeOf: () => Date.prototype,
        get: (_t, key) => (key === 'toJSON' ? () => PLAINTEXT : undefined),
      }
    ) as unknown as Date;
    const out = redactSecretsForState({ When: p }, secrets());
    expect(out.When).not.toBe(p);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('a key-less Object.create(Date.prototype) is rebuilt, not handed to a persist that throws', () => {
    // No `[[DateValue]]`: `Date.prototype.toJSON` would throw at the state save.
    const fake = Object.create(Date.prototype) as Date;
    const out = redactSecretsForState({ When: fake }, secrets());
    expect(out.When).not.toBe(fake);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
