import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  clearRecordedSecretExpressions,
  TEMPLATE_DERIVED_RULES,
  STATE_SOURCED_READBACK_RULES,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const PLAINTEXT = 'the-resolved-password';

// The shape `JSON.parse` produces and an object literal cannot: an OWN,
// enumerable `__proto__` key. A state document read back from S3 and an SDK
// readback both arrive this way.
function parsedWithProtoKey(pw: string): Record<string, unknown> {
  return JSON.parse(`{"Pw":${JSON.stringify(pw)},"__proto__":{"polluted":true}}`) as Record<
    string,
    unknown
  >;
}

/**
 * Issue [#1943](https://github.com/go-to-k/cdkd/issues/1943) item 2 — a state
 * key literally named `__proto__` must survive every redaction walk AS DATA.
 *
 * `out[k] = ...` on an ordinary object invokes the prototype setter for that
 * key instead of defining an own property, so the key vanishes from the
 * persisted bag and the next deploy reads the property as absent. All three
 * accumulators use a null-prototype object for that reason.
 *
 * The FIX is already on main (the three walks build with `Object.create(null)`).
 * What was missing is a per-walk fence at this module's own level: the value
 * scan has one in `secret-redaction-array-identity.test.ts`, and the other two
 * were covered only jointly, and only through the CLI in
 * `tests/unit/cli/state-refresh-observed.test.ts`.
 *
 * The cases are not INDEPENDENT, and saying so precisely matters more than the
 * tidy claim: WALK 3 runs downstream of WALK 2, so breaking WALK 2's
 * accumulator reds both. What survives is the SIGNATURE — WALK 1 alone, WALK 2
 * + WALK 3, or WALK 3 alone — which is enough to name the accumulator that
 * broke, and it is measured rather than assumed (each mutation was run).
 */
describe('secret-redaction - an own `__proto__` key survives every walk (issue #1943)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('WALK 1 (value scan, no source): keeps the key and redacts its sibling', () => {
    const out = redactSecretsForState(
      parsedWithProtoKey(PLAINTEXT),
      new Map([[PLAINTEXT, EXPR]])
    ) as Record<string, unknown>;

    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: true });
    expect(out['Pw']).toBe(EXPR);
    // NOT `({} as ...)['polluted']`: measured, `out['__proto__'] = {...}` sets
    // THAT object's prototype and never `Object.prototype`, so the global probe
    // cannot go red from any mutation of this module and reads as a fence that
    // is not one. Reading the key off `out` itself CAN: with a normal-object
    // accumulator the walk's result inherits `polluted` from its new prototype.
    expect((out as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('WALK 2 (path pass): keeps the key when the SOURCE positions its sibling', () => {
    // A template source reaches `redactByPath`'s object arm, whose accumulator
    // is a second, independent `Object.create(null)`. `__proto__` is a key the
    // source does not carry, so it takes the value-scan fallback and is written
    // back through THIS accumulator.
    const out = redactSecretsForState(
      parsedWithProtoKey(PLAINTEXT),
      new Map([[PLAINTEXT, EXPR]]),
      { Pw: EXPR },
      TEMPLATE_DERIVED_RULES
    ) as Record<string, unknown>;

    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: true });
    expect(out['Pw']).toBe(EXPR);
    // NOT `({} as ...)['polluted']`: measured, `out['__proto__'] = {...}` sets
    // THAT object's prototype and never `Object.prototype`, so the global probe
    // cannot go red from any mutation of this module and reads as a fence that
    // is not one. Reading the key off `out` itself CAN: with a normal-object
    // accumulator the walk's result inherits `polluted` from its new prototype.
    expect((out as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('WALK 3 (readback refusal): keeps the key when the refusal pass also walks it', () => {
    // `STATE_SOURCED_READBACK_RULES` runs `refuseUncertifiedReadbackPositions`
    // AFTER the path pass, and its object arm has a THIRD accumulator. The
    // source must carry a dynamic reference or that pass returns the bag by
    // identity and this case would prove nothing about its accumulator — which
    // is why the source here is an expression rather than a literal.
    //
    // The secrets map is EMPTY on purpose: this is the issue #1900 shape, where
    // position is the only mechanism and the value scan has no needles at all.
    const out = redactSecretsForState(
      parsedWithProtoKey(PLAINTEXT),
      new Map<string, string>(),
      { Pw: EXPR },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;

    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: true });
    expect(out['Pw']).toBe(EXPR);
    // NOT `({} as ...)['polluted']`: measured, `out['__proto__'] = {...}` sets
    // THAT object's prototype and never `Object.prototype`, so the global probe
    // cannot go red from any mutation of this module and reads as a fence that
    // is not one. Reading the key off `out` itself CAN: with a normal-object
    // accumulator the walk's result inherits `polluted` from its new prototype.
    expect((out as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
