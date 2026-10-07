/**
 * A nested-stack child's `{Ref: <Param>}` leaf persists exactly what the DIFF
 * side binds for that parameter, including when neither side can CERTIFY it
 * (issue [#2349](https://github.com/go-to-k/cdkd/issues/2349)).
 *
 * Before the fix both sides fell through to a value scan of DIFFERENT bags:
 * the persist side scanned the CHILD resource's bag, whose one slot per
 * plaintext holds whichever parameter's own expression resolved LAST, and
 * `redactParametersForDiff` scanned the PARENT's, whose entry is the collapsed
 * survivor. The next diff then reported a change no deploy could clear.
 *
 * This file drives the REAL resolver (which records the read the persist arm
 * keys on) and the REAL `redactParametersForDiff`; the store-level cases are in
 * `secret-redaction-nested-parameter-list.test.ts`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  inheritNestedStackParameterAssociations,
  recordInheritedParameterRead,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  redactSecretsForState,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactParametersForDiff } from '../../../src/deployment/deploy-engine/masking.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:fallthru::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:fallthru:AWSCURRENT:}}';
const SHARED = 'sh4red-f4llthru-pl4intext-2349';
const EMBEDDED = `postgres://u:${SHARED}@host`;

const PARAM_A = 'ConnA';
const PARAM_B = 'SecretB';

const template: CloudFormationTemplate = {
  Parameters: { [PARAM_A]: { Type: 'String' }, [PARAM_B]: { Type: 'String' } },
  Resources: {},
};

/**
 * The parent pass: `PARAM_A` built with `Fn::Sub` around `EXPR_A` (an
 * EMBEDDING value, which no association can certify), `PARAM_B` passed
 * `EXPR_B` whole. `EXPR_A` resolved LAST, so it is the collapsed survivor
 * the diff side's fall-through reads, while `PARAM_B`'s own association
 * certifies `EXPR_B` -- the value a child slot takes when `PARAM_B` is read
 * last.
 */
function parentBag(): RecordedSecretValues {
  const parent: RecordedSecretValues = new Map([[SHARED, EXPR_A]]);
  recordResolvedPair(parent, EXPR_B, SHARED);
  recordResolvedPair(parent, EXPR_A, SHARED);
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: { [PARAM_A]: EMBEDDED, [PARAM_B]: SHARED } },
    { Parameters: { [PARAM_A]: { 'Fn::Sub': `postgres://u:${EXPR_A}@host` }, [PARAM_B]: EXPR_B } }
  );
  return parent;
}

const PARAMETERS = { [PARAM_A]: EMBEDDED, [PARAM_B]: SHARED };

function makeContext(
  inherited: RecordedSecretValues
): ResolverContext & { recordedSecretValues: Map<string, string> } {
  // As `DeployEngine.buildResolverContext` builds it: a fresh bag carrying the
  // parent's per-parameter associations.
  const recordedSecretValues = new Map<string, string>();
  inheritNestedStackParameterAssociations(recordedSecretValues, inherited);
  return {
    template,
    resources: {},
    parameters: PARAMETERS,
    recordedSecretValues,
    inheritedSecrets: inherited,
  } as ResolverContext & { recordedSecretValues: Map<string, string> };
}

/** The real diff-side binding, on an engine that holds only what it reads. */
function diffBinding(inherited: RecordedSecretValues): Record<string, unknown> {
  const engine = { options: { inheritedSecrets: inherited } } as unknown as DeployEngine;
  return redactParametersForDiff.call(engine, PARAMETERS);
}

describe('nested-stack {Ref} leaf fall-through reads ONE bag on both sides (#2349)', () => {
  const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

  for (const order of [
    [PARAM_A, PARAM_B],
    [PARAM_B, PARAM_A],
  ] as const) {
    it(`persists each leaf as the diff side binds it, with ${order[1]} read last`, async () => {
      const parent = parentBag();
      const ctx = makeContext(parent);
      // Key order is resolution order, so the LAST key decides the child slot.
      const source = { [order[0]]: { Ref: order[0] }, [order[1]]: { Ref: order[1] } };
      const resolved = (await resolver.resolve(source, ctx)) as Record<string, unknown>;
      // AWS gets the real values.
      expect(resolved[PARAM_A]).toBe(EMBEDDED);
      expect(resolved[PARAM_B]).toBe(SHARED);

      const persisted = redactSecretsForState(resolved, ctx.recordedSecretValues, source) as Record<
        string,
        unknown
      >;
      const desired = diffBinding(parent);

      expect(persisted[PARAM_A]).toBe(desired[PARAM_A]);
      expect(persisted[PARAM_B]).toBe(desired[PARAM_B]);
      // Stated outright, so "both sides agree on a wrong answer" cannot pass.
      expect(persisted[PARAM_A]).toBe(`postgres://u:${EXPR_A}@host`);
      expect(persisted[PARAM_B]).toBe(EXPR_B);
      expect(JSON.stringify(persisted)).not.toContain(SHARED);
    });
  }

  it('the integ shape: a TWO-TOKEN connection string beside the whole-value sibling, recorded by the real parent recorder', async () => {
    // What `nested-stack-secret`'s `FallthroughPair` arm deploys. A literal
    // with TWO tokens (user and password) is refused a framed association, so
    // nothing can certify `ConnA`; `SecretB` is a whole token and certifies.
    // The parent resolves `SecretB` FIRST (template key order), so the
    // password's survivor is `EXPR_A`, while the child reads `ConnA` first and
    // `SecretB` last, so its slot holds `EXPR_B`.
    const USER = 'us3r-f4llthru-2349';
    const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:fallthruuser::}}';
    const conn = `postgres://${USER}:${SHARED}@host`;
    // `EXPR_A` resolved after `EXPR_B`, so it is the survivor.
    const parent: RecordedSecretValues = new Map([
      [SHARED, EXPR_A],
      [USER, USER_EXPR],
    ]);
    recordResolvedPair(parent, EXPR_B, SHARED);
    recordResolvedPair(parent, USER_EXPR, USER);
    recordResolvedPair(parent, EXPR_A, SHARED);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_B]: SHARED, [PARAM_A]: conn } },
      { Parameters: { [PARAM_B]: EXPR_B, [PARAM_A]: `postgres://${USER_EXPR}:${EXPR_A}@host` } }
    );
    const params = { [PARAM_A]: conn, [PARAM_B]: SHARED };
    const ctx = makeContext(parent);
    ctx.parameters = params;
    // CDK renders an SSM parameter's properties alphabetically.
    const source = { Description: { Ref: PARAM_A }, Value: { Ref: PARAM_B } };
    const resolved = await resolver.resolve(source, ctx);
    // The premise that makes the arm non-vacuous, on the real recorder.
    expect(ctx.recordedSecretValues.get(SHARED)).toBe(EXPR_B);
    expect(redactSecretsForState(conn, ctx.recordedSecretValues)).toBe(
      `postgres://${USER_EXPR}:${EXPR_B}@host`
    );

    const persisted = redactSecretsForState(resolved, ctx.recordedSecretValues, source) as Record<
      string,
      unknown
    >;
    const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
    const desired = redactParametersForDiff.call(engine, params);
    expect(persisted['Description']).toBe(desired[PARAM_A]);
    expect(persisted['Value']).toBe(desired[PARAM_B]);
    expect(persisted['Description']).toBe(`postgres://${USER_EXPR}:${EXPR_A}@host`);
    expect(persisted['Value']).toBe(EXPR_B);
    expect(JSON.stringify(persisted)).not.toContain(SHARED);
    expect(JSON.stringify(persisted)).not.toContain(USER);
  });

  it('THE DISCRIMINATOR: with PARAM_B read last, the child bag alone answers the sibling expression', async () => {
    // What the pre-#2349 fall-through wrote for the embedding leaf. If this
    // stops holding, the cases above no longer separate the fix from the bug.
    const parent = parentBag();
    const ctx = makeContext(parent);
    await resolver.resolve({ a: { Ref: PARAM_A }, b: { Ref: PARAM_B } }, ctx);
    expect(ctx.recordedSecretValues.get(SHARED)).toBe(EXPR_B);
    expect(redactSecretsForState(EMBEDDED, ctx.recordedSecretValues)).toBe(
      `postgres://u:${EXPR_B}@host`
    );
  });

  it('is the SAME function on both sides', () => {
    const parent = parentBag();
    const desired = diffBinding(parent);
    expect(desired[PARAM_A]).toBe(redactInheritedParameterValue(parent, PARAM_A, EMBEDDED));
    expect(desired[PARAM_B]).toBe(redactInheritedParameterValue(parent, PARAM_B, SHARED));
  });

  it('FAILS CLOSED onto the child-bag scan when the parent-bag answer would leave a child plaintext', async () => {
    // The resource's OWN resolution recorded a plaintext the parameter value
    // also carries but the PARENT never saw. The parent-bag answer leaves it in
    // place; the arm must not persist that.
    const OWN = 'own-child-secret-2349';
    const OWN_EXPR = '{{resolve:secretsmanager:child/own:SecretString:k::}}';
    const parent = parentBag();
    const ctx = makeContext(parent);
    const params = { [PARAM_A]: `postgres://${OWN}:${SHARED}@host` };
    ctx.parameters = params;
    ctx.recordedSecretValues.set(OWN, OWN_EXPR);
    const source = { V: { Ref: PARAM_A } };
    const resolved = await resolver.resolve(source, ctx);

    const persisted = redactSecretsForState(resolved, ctx.recordedSecretValues, source) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(persisted)).not.toContain(OWN);
    expect(JSON.stringify(persisted)).not.toContain(SHARED);
    // The parent-bag answer WOULD have leaked it -- the guard's reason to exist.
    expect(JSON.stringify(redactInheritedParameterValue(parent, PARAM_A, params[PARAM_A]))).toContain(
      OWN
    );
  });

  it('FAILS CLOSED when a PARENT needle overlaps a child-only plaintext, which the answer re-scan cannot see', () => {
    // The parent-bag scan replaces `Y` first and cuts `X` apart, so `A` / `I`
    // would survive in an answer the child bag no longer matches as a whole.
    // The check has to read the ORIGINAL value.
    const X = 'ABCDEFGHI';
    const Y = 'BCDEFGH';
    const X_EXPR = '{{resolve:secretsmanager:child/own:SecretString:x::}}';
    const Y_EXPR = '{{resolve:secretsmanager:parent/y:SecretString:y::}}';
    const value = `xx${X}xx`;
    const parent: RecordedSecretValues = new Map([[Y, Y_EXPR]]);
    const child: RecordedSecretValues = new Map([
      [Y, Y_EXPR],
      [X, X_EXPR],
    ]);
    recordInheritedParameterRead(child, parent, PARAM_A);
    // The premise: the parent-bag answer leaks X's ends and passes a re-scan.
    const parentAnswer = redactInheritedParameterValue(parent, PARAM_A, value);
    expect(parentAnswer).toBe(`xxA${Y_EXPR}Ixx`);
    expect(redactSecretsForState(parentAnswer, child)).toBe(parentAnswer);

    const persisted = redactSecretsForState({ V: value }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(`xx${X_EXPR}xx`);
  });

  it('FAILS CLOSED when the PARENT holds the overlapped plaintext only as MASK-ONLY', () => {
    // The parent HAS the key, but as `SECRET_MASK`, which is no substring
    // needle: its scan replaces the inner `Y` and cuts `X` apart, exactly as
    // when the parent lacks `X`. Key presence is the wrong question.
    const X = 'ABCDEFGHI';
    const Y = 'BCDEFGH';
    const X_EXPR = '{{resolve:secretsmanager:child/own:SecretString:x::}}';
    const Y_EXPR = '{{resolve:secretsmanager:parent/y:SecretString:y::}}';
    const value = `xx${X}xx`;
    const parent: RecordedSecretValues = new Map([
      [X, SECRET_MASK],
      [Y, Y_EXPR],
    ]);
    const child: RecordedSecretValues = new Map([
      [X, X_EXPR],
      [Y, Y_EXPR],
    ]);
    recordInheritedParameterRead(child, parent, PARAM_A);
    // The premise: the parent-bag answer fragments X and passes a re-scan.
    const parentAnswer = redactInheritedParameterValue(parent, PARAM_A, value);
    expect(parentAnswer).toBe(`xxA${Y_EXPR}Ixx`);
    expect(redactSecretsForState(parentAnswer, child)).toBe(parentAnswer);

    const persisted = redactSecretsForState({ V: value }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    // The pre-#2349 child-bag answer, exactly.
    expect(persisted['V']).toBe(redactSecretsForState(value, child));
    expect(persisted['V']).toBe(`xx${X_EXPR}xx`);
  });

  it('FAILS CLOSED on a PARENT needle the child bag lacks, without relying on the carry', () => {
    // Bags built directly: the resolver's carry would put Z into the child
    // bag, and the predicate must not depend on that. The parent scan takes Z
    // first and leaves `EF` of X; the child-bag answer left `AB` of Z.
    const Z = 'ABCD';
    const X = 'CDEF';
    const Z_EXPR = '{{resolve:secretsmanager:parent/z:SecretString:z::}}';
    const X_EXPR = '{{resolve:secretsmanager:parent/x:SecretString:x::}}';
    const value = 'xxABCDEFxx';
    const parent: RecordedSecretValues = new Map([
      [Z, Z_EXPR],
      [X, X_EXPR],
    ]);
    const child: RecordedSecretValues = new Map([[X, X_EXPR]]);
    recordInheritedParameterRead(child, parent, PARAM_A);
    // The premise: the parent-bag answer cuts X and passes the re-scan.
    const parentAnswer = redactInheritedParameterValue(parent, PARAM_A, value);
    expect(parentAnswer).toBe(`xx${Z_EXPR}EFxx`);
    expect(redactSecretsForState(parentAnswer, child)).toBe(parentAnswer);

    const persisted = redactSecretsForState({ V: value }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(redactSecretsForState(value, child));
    expect(persisted['V']).toBe(`xxAB${X_EXPR}xx`);
  });

  it('does NOT decline on a sub-floor PARENT key the child lacks -- the parent scan never takes it as a substring', () => {
    // `q7` is below MIN_NEEDLE_LENGTH, so the parent scan cannot cut anything
    // with it; declining on it would only keep the pre-#2349 perpetual diff.
    const X = 'shared-secret-2349';
    const PIN = 'q7';
    const X_PARENT = '{{resolve:secretsmanager:parent/x:SecretString:x::}}';
    const X_CHILD = '{{resolve:secretsmanager:child/x:SecretString:x::}}';
    const PIN_EXPR = '{{resolve:ssm:/parent/pin}}';
    const value = `xx${X}${PIN}xx`;
    const parent: RecordedSecretValues = new Map([
      [X, X_PARENT],
      [PIN, PIN_EXPR],
    ]);
    const child: RecordedSecretValues = new Map([[X, X_CHILD]]);
    recordInheritedParameterRead(child, parent, PARAM_A);
    // The premise: the parent-bag answer leaves the pin as text (never a needle).
    expect(redactInheritedParameterValue(parent, PARAM_A, value)).toBe(`xx${X_PARENT}${PIN}xx`);

    const persisted = redactSecretsForState({ V: value }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(`xx${X_PARENT}${PIN}xx`);
  });

  it('leaves a {Ref} the resolver recorded no inherited read for on the existing arms', () => {
    // A child bag carrying the parent's pair WITHOUT the read record -- what
    // any non-resolver writer produces. The arm must not fire.
    const parent = parentBag();
    const child: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
    const persisted = redactSecretsForState({ V: EMBEDDED }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(`postgres://u:${EXPR_B}@host`);
    expect(redactInheritedParameterValue(parent, PARAM_A, EMBEDDED)).toBe(
      `postgres://u:${EXPR_A}@host`
    );
  });

  it('answers only the parameter that was read, not every {Ref} in the resource', () => {
    const parent = parentBag();
    const child: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
    recordInheritedParameterRead(child, parent, PARAM_B);
    const persisted = redactSecretsForState({ V: EMBEDDED }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(`postgres://u:${EXPR_B}@host`);
  });

  it('refuses a child bag recorded against TWO parent bags rather than choose one', () => {
    const parent = parentBag();
    const child: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
    recordInheritedParameterRead(child, parent, PARAM_A);
    recordInheritedParameterRead(child, new Map(parent), PARAM_A);
    const persisted = redactSecretsForState({ V: EMBEDDED }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(`postgres://u:${EXPR_B}@host`);
  });

  it('positive control for the two refusals above: the same bag WITH the read answers from the parent', () => {
    const parent = parentBag();
    const child: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
    recordInheritedParameterRead(child, parent, PARAM_A);
    const persisted = redactSecretsForState({ V: EMBEDDED }, child, { V: { Ref: PARAM_A } }) as Record<
      string,
      unknown
    >;
    expect(persisted['V']).toBe(`postgres://u:${EXPR_A}@host`);
  });
});

/**
 * THE FAIL-CLOSED FAMILY, exhaustively (issue #2349, review rounds 1-3). Each
 * round found one more combination where the PARENT-bag answer cut a plaintext
 * the CHILD-bag scan took whole, so this walks every combination instead:
 *
 * - how the CHILD bag holds K: absent, a needle (a real expression), mask-only;
 * - how the PARENT bag holds K: the same three;
 * - with a parent needle Y strictly inside K held by BOTH bags, which is what
 *   cuts K apart;
 * - for three value shapes: K whole, K embedded, K as a list element.
 *
 * THE PROPERTY, per row: the new arm's persisted value is AT LEAST AS
 * REDACTED as the pre-#2349 answer, `redactSecretsForState(value, child)`.
 * Precisely: either the two are EQUAL (the arm declined, or agreed), or every
 * slice of K of length >= 2 that appears in the new answer also appears in the
 * old one. Single characters are excluded because they occur in any expression.
 */
describe('fail-closed family: every child x parent entry class for an overlapped plaintext (#2349)', () => {
  // Y leaves TWO characters of K on each side, so a cut leaves slices the
  // property below can see (a one-character remnant would be invisible).
  const K = 'ABCDEFGHIJ';
  const Y = 'CDEFGH';
  const K_CHILD_EXPR = '{{resolve:secretsmanager:child/k:SecretString:k::}}';
  const K_PARENT_EXPR = '{{resolve:secretsmanager:parent/k:SecretString:k::}}';
  const Y_EXPR = '{{resolve:secretsmanager:parent/y:SecretString:y::}}';
  type EntryClass = 'absent' | 'needle' | 'mask-only';
  const CLASSES: EntryClass[] = ['absent', 'needle', 'mask-only'];
  const SHAPES: Array<[string, unknown]> = [
    ['whole', K],
    ['embedded', `xx${K}xx`],
    ['list', ['public-element', K]],
  ];

  function slicesOf(text: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i++) {
      for (let j = i + 2; j <= text.length; j++) out.push(text.slice(i, j));
    }
    return out;
  }

  function bag(kClass: EntryClass, kExpr: string): RecordedSecretValues {
    const out: RecordedSecretValues = new Map([[Y, Y_EXPR]]);
    if (kClass === 'needle') out.set(K, kExpr);
    if (kClass === 'mask-only') out.set(K, SECRET_MASK);
    return out;
  }

  const rows: Array<[EntryClass, EntryClass, string, unknown]> = [];
  for (const child of CLASSES) {
    for (const parent of CLASSES) {
      for (const [shape, value] of SHAPES) rows.push([child, parent, shape, value]);
    }
  }

  it('walks all 27 rows', () => {
    expect(rows).toHaveLength(27);
  });

  it.each(rows)('child=%s parent=%s value=%s', (childClass, parentClass, _shape, value) => {
    const parentBag = bag(parentClass, K_PARENT_EXPR);
    const childBag = bag(childClass, K_CHILD_EXPR);
    recordInheritedParameterRead(childBag, parentBag, PARAM_A);

    const before = JSON.stringify(redactSecretsForState({ V: value }, childBag));
    const after = JSON.stringify(
      redactSecretsForState({ V: value }, childBag, { V: { Ref: PARAM_A } })
    );
    if (after === before) return;
    const leaked = slicesOf(K).filter((slice) => after.includes(slice) && !before.includes(slice));
    expect(leaked, `new answer ${after} vs pre-#2349 ${before}`).toEqual([]);
  });

  it('POSITIVE CONTROL: the #2349 row itself (both bags hold K as needles) still takes the parent answer', () => {
    // Both bags hold K with DIFFERENT expressions -- the divergence the arm
    // exists to close. A predicate declining here would pass the table above
    // while undoing the fix.
    const parentBag = bag('needle', K_PARENT_EXPR);
    const childBag = bag('needle', K_CHILD_EXPR);
    recordInheritedParameterRead(childBag, parentBag, PARAM_A);
    const persisted = redactSecretsForState({ V: `xx${K}xx` }, childBag, {
      V: { Ref: PARAM_A },
    }) as Record<string, unknown>;
    expect(persisted['V']).toBe(`xx${K_PARENT_EXPR}xx`);
  });
});
