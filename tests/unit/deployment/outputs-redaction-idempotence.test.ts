/**
 * `R(R(bag))` vs `R(bag)` for the stack-OUTPUTS redaction (issue
 * [#2667](https://github.com/go-to-k/cdkd/issues/2667)).
 *
 * WHY THIS EQUALITY IS LOAD-BEARING. Two bags derived from one `resolveOutputs`
 * pass are persisted to two different objects. `state.json` goes through
 * `withParentInfo` -> `redactStateForPersist` -> `redactOutputs`, on top of a
 * bag `resolveOutputs` had already redacted once; the exports index write takes
 * `importableOutputs(newState)` without that second pass. So the index holds
 * `R(outputs)` and the state record holds `R(R(outputs))`.
 *
 * `cdkd scrub`'s exports-index repair converges an entry to the value the state
 * record holds under the same name, on the ground that a redeploy and
 * `ExportIndexStore.rebuild()` both write that value. Where `R` is not
 * idempotent, those two are different strings for the same output, and the
 * convergence would write a value no deploy produces.
 *
 * `R` here is spelled exactly as `DeployEngine.redactOutputs` spells it —
 * `redactSecretsForState(bag, outputSecrets, outputsTemplateSource,
 * TEMPLATE_SOURCED_RULES)`. The second describe covers the ANCHOR arm, which
 * that constant cannot reach (`refuseUncertifiedReadbackPositions` is gated on
 * `isReadbackProjectedFromState`, false for `TEMPLATE_SOURCED_RULES`), through
 * the constant that does reach it.
 *
 * A FAILURE HERE IS NOT A BUG IN THE SCRUB REPAIR. It is a divergence on the
 * DEPLOY side — its index write should consume the same bag `saveState`
 * writes — and it gets its own issue with the failing case as the evidence.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  redactSecretsForState,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';
const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECOND_EXPR = '{{resolve:ssm:/prod/db/token}}';
const SECOND_PLAINTEXT = 'decrypted-securestring-value';

/** The bag `DeployEngine.redactOutputs` is built from, in its own spelling. */
function outputsSecrets(): RecordedSecretValues {
  return new Map([
    [SECRET_PLAINTEXT, SECRET_EXPR],
    [SECOND_PLAINTEXT, SECOND_EXPR],
  ]);
}

/** `R` — the outputs redaction, applied exactly as the deploy path applies it. */
function R(bag: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  return redactSecretsForState(bag, outputsSecrets(), source, TEMPLATE_SOURCED_RULES);
}

describe('the stack-outputs redaction is idempotent (issue #2667 item 4)', () => {
  it('a WHOLE-VALUE secret leaf: the second pass returns the first pass output unchanged', () => {
    const source = { Password: SECRET_EXPR };
    const bag = { Password: SECRET_PLAINTEXT };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once).toEqual({ Password: SECRET_EXPR });
    expect(twice).toEqual(once);
  });

  it('an EMBEDDED secret leaf, where the second pass sees a complete token in the bag', () => {
    // The shape the token guard (#1935) exists for: after one pass the leaf
    // holds a `{{resolve:...}}` span, and a second pass must not splice a
    // needle into it.
    const source = { DbUrl: { 'Fn::Join': ['', ['postgres://u:', SECRET_EXPR, '@h']] } };
    const bag = { DbUrl: `postgres://u:${SECRET_PLAINTEXT}@h` };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once['DbUrl']).toBe(`postgres://u:${SECRET_EXPR}@h`);
    expect(twice).toEqual(once);
  });

  it('the KEYED ARRAY arm: elements paired by an identity field, both passes', () => {
    // `redactByPath`'s keyed descent runs whatever `descendArrays` says, so it
    // is reachable from `TEMPLATE_SOURCED_RULES` — and a list-valued Output is
    // reachable too (`TemplateOutput.Value` is `unknown` and `state.outputs` is
    // not string-coerced).
    const source = {
      Vars: [
        { Name: 'PUBLIC', Value: 'ok' },
        { Name: 'SECRET', Value: SECRET_EXPR },
        { Name: 'TOKEN', Value: SECOND_EXPR },
      ],
    };
    const bag = {
      Vars: [
        { Name: 'PUBLIC', Value: 'ok' },
        { Name: 'SECRET', Value: SECRET_PLAINTEXT },
        { Name: 'TOKEN', Value: SECOND_PLAINTEXT },
      ],
    };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once['Vars']).toEqual([
      { Name: 'PUBLIC', Value: 'ok' },
      { Name: 'SECRET', Value: SECRET_EXPR },
      { Name: 'TOKEN', Value: SECOND_EXPR },
    ]);
    expect(twice).toEqual(once);
  });

  it('the KEYED ARRAY arm with the elements REORDERED between the two passes', () => {
    // Keying is order-independent by construction; asserted because the
    // convergence rule compares the index bag against the state bag, and those
    // two are produced by separate walks over the same source.
    const source = {
      Vars: [
        { Name: 'SECRET', Value: SECRET_EXPR },
        { Name: 'PUBLIC', Value: 'ok' },
      ],
    };
    const bag = {
      Vars: [
        { Name: 'PUBLIC', Value: 'ok' },
        { Name: 'SECRET', Value: SECRET_PLAINTEXT },
      ],
    };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once['Vars']).toEqual([
      { Name: 'PUBLIC', Value: 'ok' },
      { Name: 'SECRET', Value: SECRET_EXPR },
    ]);
    expect(twice).toEqual(once);
  });

  it('an UNKEYED array, which this constant refuses to descend, on both passes', () => {
    // `descendArrays: false` and no identity field, so position certifies
    // nothing and the leaves take the value scan. Both passes must agree; the
    // second one sees a bag of complete tokens.
    const source = { List: [SECRET_EXPR, 'plain', SECOND_EXPR] };
    const bag = { List: [SECRET_PLAINTEXT, 'plain', SECOND_PLAINTEXT] };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once['List']).toEqual([SECRET_EXPR, 'plain', SECOND_EXPR]);
    expect(twice).toEqual(once);
  });

  it('a NESTED array under an object key, both passes', () => {
    const source = { Nested: { Inner: [{ Key: 'a', Value: SECRET_EXPR }] } };
    const bag = { Nested: { Inner: [{ Key: 'a', Value: SECRET_PLAINTEXT }] } };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once).toEqual({ Nested: { Inner: [{ Key: 'a', Value: SECRET_EXPR }] } });
    expect(twice).toEqual(once);
  });

  it('a leaf ALREADY holding a token before the first pass survives both', () => {
    // The state a re-run over already-scrubbed records arrives in. Pinned
    // because the convergence rule reads exactly this bag.
    const source = { Password: SECRET_EXPR };
    const bag = { Password: SECRET_EXPR };

    const once = R(bag, source);
    const twice = R(once, source);

    expect(once).toEqual({ Password: SECRET_EXPR });
    expect(twice).toEqual(once);
  });
});

describe('the ANCHOR arm is idempotent too (issue #2667 item 4)', () => {
  /**
   * `unkeyedArrayPairsByAnchors` is reached only through
   * `refuseUncertifiedReadbackPositions`, which `redactSecretsForState` gates
   * on `isReadbackProjectedFromState(rules)` — true for
   * `STATE_SOURCED_READBACK_RULES` and false for the outputs constant above.
   * The empty secrets map is that path's own construction: the arm exists
   * BECAUSE the value scan has no needles there.
   */
  function A(bag: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    return redactSecretsForState(
      bag,
      new Map<string, string>(),
      source,
      STATE_SOURCED_READBACK_RULES
    );
  }

  it('a MIXED leaf this arm does not certify keeps its value across both passes', () => {
    // The embedded-span positioning (`positionByEmbeddedSpan`) is gated on
    // PASS-LOCAL evidence the resolver records beside the map; a map built by
    // hand carries none, so this leaf is NOT rewritten. Asserted POSITIVELY
    // rather than as `twice === once` alone: that equality is satisfied by the
    // arm doing nothing, which is exactly what happens here, so without the
    // first expectation the case would report an idempotence it never tested.
    const source = {
      Items: [
        { Url: 'https://public.example.com', Tag: 'first' },
        { Url: { 'Fn::Join': ['', ['postgres://u:', SECRET_EXPR, '@h']] }, Tag: 'second' },
      ],
    };
    const bag = {
      Items: [
        { Url: 'https://public.example.com', Tag: 'first' },
        { Url: `postgres://u:${SECRET_PLAINTEXT}@h`, Tag: 'second' },
      ],
    };

    const once = A(bag, source);
    const twice = A(once, source);

    expect(once['Items']).toEqual([
      { Url: 'https://public.example.com', Tag: 'first' },
      { Url: `postgres://u:${SECRET_PLAINTEXT}@h`, Tag: 'second' },
    ]);
    expect(twice).toEqual(once);
  });

  it('a WHOLE-TOKEN leaf inside an unkeyed array, both passes', () => {
    const source = {
      Items: [
        { Value: 'anchor-literal', Tag: 'first' },
        { Value: SECRET_EXPR, Tag: 'second' },
      ],
    };
    const bag = {
      Items: [
        { Value: 'anchor-literal', Tag: 'first' },
        { Value: SECRET_PLAINTEXT, Tag: 'second' },
      ],
    };

    const once = A(bag, source);
    const twice = A(once, source);

    expect(once['Items']).toEqual([
      { Value: 'anchor-literal', Tag: 'first' },
      { Value: SECRET_EXPR, Tag: 'second' },
    ]);
    expect(twice).toEqual(once);
  });

  it('a REORDERED array, which the anchor pass refuses, is stable across both passes', () => {
    // The refusal direction: the anchors no longer line up, so the array keeps
    // what it holds. A refusal that moved something on the second pass would be
    // the divergence this file is looking for.
    const source = {
      Items: [{ Value: SECRET_EXPR }, { Value: 'anchor-literal' }],
    };
    const bag = {
      Items: [{ Value: 'anchor-literal' }, { Value: SECRET_PLAINTEXT }],
    };

    const once = A(bag, source);
    const twice = A(once, source);

    expect(once['Items']).toEqual([{ Value: 'anchor-literal' }, { Value: SECRET_PLAINTEXT }]);
    expect(twice).toEqual(once);
  });
});
