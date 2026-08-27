/**
 * `IntrinsicFunctionResolver` records a nested-stack parent's already-resolved
 * secret into the bag of the resource that ACTUALLY consumed the parameter
 * (issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) /
 * [#2087](https://github.com/go-to-k/cdkd/issues/2087)).
 *
 * A nested child never sees a `{{resolve:` of its own — the parent resolves the
 * `Parameters` block and the child's template spells the consumption as
 * `{Ref: <Param>}` — so without this the child's `recordedSecretValues` is
 * empty and its `state.json` persists the decrypted secret. The FIRST fix
 * pre-seeded every per-resource bag with the parent's map, which restored the
 * redaction and destroyed the scoping: an unrelated resource whose literal
 * merely CONTAINED the plaintext was persisted with the expression spliced in,
 * giving a perpetual UPDATE (#2087).
 *
 * This file drives the REAL resolver, so it fences the matching itself. The
 * per-resource consequence — which bag the pair lands in and what the save
 * choke point then writes — is fenced in
 * `deploy-engine-nested-stack-inherited-secrets.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  recordNestedStackParameterExpressions,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
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

import { getLogger } from '../../../src/utils/logger.js';

// Each assertion below reads the debug lines THIS test emitted, so the shared
// logger mock has to be drained between tests or a later scope-control case
// would see an earlier case's masked line and pass for the wrong reason.
beforeEach(() => {
  vi.clearAllMocks();
});

/** Every `logger.debug` line this pass emitted, joined. */
function debugLines(): string {
  const debug = getLogger().debug as unknown as { mock: { calls: unknown[][] } };
  return debug.mock.calls.map((call) => String(call[0])).join('\n');
}

const SECRET = 'production';
const EXPR = '{{resolve:secretsmanager:prod/app/env:SecretString:stage::}}';
const PARAM = 'referencetoParentStage';

const template: CloudFormationTemplate = {
  Parameters: {
    [PARAM]: { Type: 'String' },
    OtherParam: { Type: 'String' },
    ListParam: { Type: 'CommaDelimitedList' },
  },
  Resources: {},
};

function makeContext(
  parameters: Record<string, unknown>,
  inherited?: Map<string, string>
): ResolverContext & { recordedSecretValues: Map<string, string> } {
  const recordedSecretValues = new Map<string, string>();
  return {
    template,
    resources: {},
    parameters,
    recordedSecretValues,
    ...(inherited && { inheritedSecrets: inherited }),
  } as ResolverContext & { recordedSecretValues: Map<string, string> };
}

describe('IntrinsicFunctionResolver — inherited nested-stack parameter secrets (#1903 / #2087)', () => {
  const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

  it('records the pair when a Ref resolves to exactly the inherited plaintext, and returns the REAL value', async () => {
    const ctx = makeContext({ [PARAM]: SECRET }, new Map([[SECRET, EXPR]]));

    // The provisioning side must keep the plaintext — that is what reaches AWS.
    await expect(resolver.resolve({ Ref: PARAM }, ctx)).resolves.toBe(SECRET);
    expect(ctx.recordedSecretValues.get(SECRET)).toBe(EXPR);
  });

  it('records an EMBEDDED plaintext, which is how an Fn::Sub-built parameter arrives', async () => {
    const embedded = `postgres://app:${SECRET}@db.internal:5432/app`;
    const ctx = makeContext({ [PARAM]: embedded }, new Map([[SECRET, EXPR]]));

    await expect(resolver.resolve({ Ref: PARAM }, ctx)).resolves.toBe(embedded);
    expect(ctx.recordedSecretValues.get(SECRET)).toBe(EXPR);
  });

  /**
   * TWO parent parameters resolving to ONE plaintext (issue
   * [#2291](https://github.com/go-to-k/cdkd/issues/2291) round 2).
   *
   * `inheritedSecrets` is keyed by PLAINTEXT, so the pair has ALREADY collapsed
   * to a single entry by the time the child engine exists and this method used
   * to copy the SURVIVOR's expression into the consuming resource's bag. For a
   * leaf spelled exactly `{Ref: P}` that is invisible — the persist path
   * positions it through the parent's per-parameter association and never reads
   * this bag's VALUE — but every EMBEDDING shape falls to the plaintext-keyed
   * value scan, which reads exactly this bag, while
   * `DeployEngine.redactParametersForDiff` answers PER PARAMETER. The two
   * halves then disagree forever: a perpetual UPDATE.
   *
   * The DISCRIMINATOR is therefore the LOSING parameter — `PAIR_A`, whose
   * expression is NOT the survivor. Asking about `PAIR_B` would pass either way.
   */
  const PAIR_EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:handoff::}}';
  const PAIR_EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:handoff:AWSCURRENT:}}';
  const PAIR_SHARED = 'sh4red-h4ndoff-pl4intext-2291';
  const PAIR_A = 'HandoffSecretA';
  const PAIR_B = 'HandoffSecretB';

  /** The parent bag exactly as a parent pass produces it: collapsed, plus the table. */
  function collidingParentBag(): RecordedSecretValues {
    const parent: RecordedSecretValues = new Map([[PAIR_SHARED, PAIR_EXPR_B]]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PAIR_A]: PAIR_SHARED, [PAIR_B]: PAIR_SHARED } },
      { Parameters: { [PAIR_A]: PAIR_EXPR_A, [PAIR_B]: PAIR_EXPR_B } }
    );
    return parent;
  }

  it('records the LOSING parameter under ITS OWN expression, not the collapsed survivor (#2291)', async () => {
    const parent = collidingParentBag();
    // The measured pre-condition, asserted rather than assumed.
    expect(parent.size).toBe(1);
    expect(parent.get(PAIR_SHARED)).toBe(PAIR_EXPR_B);

    const ctx = makeContext({ [PAIR_A]: PAIR_SHARED, [PAIR_B]: PAIR_SHARED }, parent);
    await expect(resolver.resolve({ Ref: PAIR_A }, ctx)).resolves.toBe(PAIR_SHARED);
    expect(ctx.recordedSecretValues.get(PAIR_SHARED)).toBe(PAIR_EXPR_A);
  });

  it('makes the VALUE SCAN agree with the diff side for an Fn::Sub leaf over the losing parameter (#2291)', async () => {
    // THE REGRESSION THIS FIX EXISTS FOR. `Fn::Sub` is the dominant CDK
    // connection-string shape, `crossStackSourceKey`'s `Fn::Sub` arm refuses a
    // non-dotted placeholder, so this leaf can ONLY be redacted by the value
    // scan — which reads the bag this method fills.
    const parent = collidingParentBag();
    const ctx = makeContext({ [PAIR_A]: PAIR_SHARED, [PAIR_B]: PAIR_SHARED }, parent);

    const resolved = await resolver.resolve(
      { 'Fn::Sub': `postgres://u:\${${PAIR_A}}@host` },
      ctx
    );
    // AWS still gets the real value.
    expect(resolved).toBe(`postgres://u:${PAIR_SHARED}@host`);
    // ...and the needle the value scan will substitute is THIS parameter's own
    // expression, which is what `redactParametersForDiff` computes on the other
    // side. Under the collapse it was `PAIR_EXPR_B` and the two never matched.
    expect(ctx.recordedSecretValues.get(PAIR_SHARED)).toBe(PAIR_EXPR_A);
  });

  it('applies the override ONLY to the pair whose plaintext IS the whole value (#2291)', async () => {
    // THE DISCRIMINATOR for the `plaintext === value` guard on the override.
    // `inheritedSecretsCarriedBy` returns a pair for EVERY inherited plaintext
    // the value carries — the whole-value match AND any substring match at or
    // above `MIN_NEEDLE_LENGTH`. Only the first belongs to THIS parameter; the
    // rest are other parameters' secrets that this value happens to contain.
    // Dropping the guard (`own ?? expression`) hands them all this parameter's
    // expression, which is the collapse this fix exists to remove, one step over.
    //
    // The probe input has to make the two sets DIFFER, so `INNER` is a genuine
    // SUBSTRING of the shared plaintext. A non-overlapping second secret cannot
    // see the defect at all: it never appears in the carried list.
    const INNER = 'h4ndoff-pl4intext';
    const INNER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:inner::}}';
    expect(PAIR_SHARED).toContain(INNER);
    expect(INNER.length).toBeGreaterThanOrEqual(MIN_NEEDLE_LENGTH);

    const parent = collidingParentBag();
    parent.set(INNER, INNER_EXPR);

    const ctx = makeContext({ [PAIR_A]: PAIR_SHARED }, parent);
    await resolver.resolve({ Ref: PAIR_A }, ctx);

    // This parameter's own value takes this parameter's own expression...
    expect(ctx.recordedSecretValues.get(PAIR_SHARED)).toBe(PAIR_EXPR_A);
    // ...and the secret it merely CONTAINS keeps its own.
    expect(ctx.recordedSecretValues.get(INNER)).toBe(INNER_EXPR);
  });

  it('records nothing for a parameter whose value does not carry the plaintext at all', async () => {
    const ctx = makeContext(
      { [PARAM]: SECRET, OtherParam: 'ordinary-public-config' },
      new Map([[SECRET, EXPR]])
    );

    await expect(resolver.resolve({ Ref: 'OtherParam' }, ctx)).resolves.toBe(
      'ordinary-public-config'
    );
    // THE #2087 SCOPE ASSERTION at the resolver level: resolving a DIFFERENT
    // parameter must not drag the pair in. Under the pre-seed design the bag
    // was already populated before any resolution happened, so this could not
    // be expressed at all.
    expect(ctx.recordedSecretValues.size).toBe(0);
  });

  it('records through Fn::Sub and Fn::Join, since both re-enter the same Ref branch', async () => {
    const subCtx = makeContext({ [PARAM]: SECRET }, new Map([[SECRET, EXPR]]));
    await expect(resolver.resolve({ 'Fn::Sub': `stage-\${${PARAM}}` }, subCtx)).resolves.toBe(
      `stage-${SECRET}`
    );
    expect(subCtx.recordedSecretValues.get(SECRET)).toBe(EXPR);

    const joinCtx = makeContext({ [PARAM]: SECRET }, new Map([[SECRET, EXPR]]));
    await expect(
      resolver.resolve({ 'Fn::Join': ['-', ['stage', { Ref: PARAM }]] }, joinCtx)
    ).resolves.toBe(`stage-${SECRET}`);
    expect(joinCtx.recordedSecretValues.get(SECRET)).toBe(EXPR);
  });

  it('scans string ELEMENTS of a CommaDelimitedList parameter', async () => {
    const ctx = makeContext(
      { ListParam: ['alpha', `beta-${SECRET}`, 'gamma'] },
      new Map([[SECRET, EXPR]])
    );

    await expect(resolver.resolve({ Ref: 'ListParam' }, ctx)).resolves.toEqual([
      'alpha',
      `beta-${SECRET}`,
      'gamma',
    ]);
    expect(ctx.recordedSecretValues.get(SECRET)).toBe(EXPR);
  });

  it('applies the MIN_NEEDLE_LENGTH floor to the SUBSTRING arm but not to the WHOLE-VALUE arm', async () => {
    // Mirrors `redactSecretsForState`: a short needle matches half the
    // alphabet's worth of ordinary identifiers as a substring, but a value that
    // IS the secret is the secret at any length. Bound to the exported constant
    // rather than to the literal 4, so a change to it cannot silently desync
    // the recording side from the redaction side.
    const short = 'ab'.repeat(Math.max(1, Math.floor((MIN_NEEDLE_LENGTH - 1) / 2)));
    expect(short.length).toBeLessThan(MIN_NEEDLE_LENGTH);
    const shortExpr = '{{resolve:secretsmanager:prod/app/tiny:SecretString:v::}}';

    const substringCtx = makeContext(
      { [PARAM]: `prefix-${short}-suffix` },
      new Map([[short, shortExpr]])
    );
    await resolver.resolve({ Ref: PARAM }, substringCtx);
    expect(substringCtx.recordedSecretValues.size).toBe(0);

    const wholeCtx = makeContext({ [PARAM]: short }, new Map([[short, shortExpr]]));
    await resolver.resolve({ Ref: PARAM }, wholeCtx);
    expect(wholeCtx.recordedSecretValues.get(short)).toBe(shortExpr);
  });

  it('records nothing at all when no map was inherited (a top-level stack)', async () => {
    const ctx = makeContext({ [PARAM]: SECRET });

    await expect(resolver.resolve({ Ref: PARAM }, ctx)).resolves.toBe(SECRET);
    expect(ctx.recordedSecretValues.size).toBe(0);
  });

  it('MASKS the inherited plaintext on the `Resolved Ref to parameter` debug line', async () => {
    // THE LOG HALF of the disclosure (review round 2). This line runs BEFORE
    // `recordInheritedParameterSecrets` puts the pair in
    // `context.recordedSecretValues`, so masking against that bag alone prints
    // the secret; the fix masks against `context.inheritedSecrets` too.
    // `stringifyParameterForLog` cannot help — it redacts only on the author's
    // `NoEcho`, and a CDK-synthesized nested-stack parameter never carries one.
    const ctx = makeContext({ [PARAM]: SECRET }, new Map([[SECRET, EXPR]]));

    await expect(resolver.resolve({ Ref: PARAM }, ctx)).resolves.toBe(SECRET);

    const lines = debugLines();
    expect(lines).toContain('Resolved Ref to parameter');
    // Non-vacuity: the line really is about this parameter, and it really did
    // print something in the value slot.
    expect(lines).toContain(PARAM);
    expect(lines).toContain(SECRET_MASK);
    expect(lines).not.toContain(SECRET);
  });

  it('leaves an ORDINARY parameter value visible on the same line (masking scope control)', async () => {
    // The discriminator for the assertion above: a fix that simply stopped
    // printing parameter values would pass it and make `--verbose` useless.
    const ctx = makeContext({ OtherParam: 'ordinary-public-config' }, new Map([[SECRET, EXPR]]));

    await expect(resolver.resolve({ Ref: 'OtherParam' }, ctx)).resolves.toBe(
      'ordinary-public-config'
    );

    expect(debugLines()).toContain('ordinary-public-config');
  });
});

describe('IntrinsicFunctionResolver.resolveParameters — the inherited-secret seam (#1903)', () => {
  const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

  function tpl(type: string): CloudFormationTemplate {
    return { Parameters: { [PARAM]: { Type: type } }, Resources: {} };
  }

  it('MASKS the plaintext on the `using user-provided value` debug line', async () => {
    // The SECOND log site. The parent hands the child engine already-decrypted
    // values, so this line printed the secret at `--verbose` on every nested
    // deploy — before any resource had resolved anything.
    await resolver.resolveParameters(tpl('String'), { [PARAM]: SECRET }, {
      inheritedSecrets: new Map([[SECRET, EXPR]]),
    });

    const lines = debugLines();
    expect(lines).toContain('using user-provided value');
    expect(lines).toContain(SECRET_MASK);
    expect(lines).not.toContain(SECRET);
  });

  it('leaves a non-inherited value visible on that line too', async () => {
    await resolver.resolveParameters(tpl('String'), { [PARAM]: 'ordinary-public-config' }, {
      inheritedSecrets: new Map([[SECRET, EXPR]]),
    });
    expect(debugLines()).toContain('ordinary-public-config');
  });

  it('REFUSES a Type: Number parameter fed an inherited secret, naming the parameter', async () => {
    // BLOCKER: `coerceParameterValue` turns this into a JS number, so
    // `recordInheritedParameterSecrets` (strings only) records nothing and
    // `redactSecretsForState` (string leaves only) rewrites nothing — the
    // child's state.json kept the DECRYPTED value verbatim and every
    // `cdkd diff --recursive` reported a change.
    await expect(
      resolver.resolveParameters(tpl('Number'), { [PARAM]: SECRET }, {
        inheritedSecrets: new Map([[SECRET, EXPR]]),
      })
    ).rejects.toThrow(/referencetoParentStage/);
  });

  it('never quotes the secret in the refusal message', async () => {
    // A refusal that prints the value would be the same disclosure by another
    // route. Asserted by INSPECTING the thrown message rather than through a
    // matcher, so the assertion cannot pass by no error being thrown at all.
    let message: string | undefined;
    try {
      await resolver.resolveParameters(tpl('Number'), { [PARAM]: SECRET }, {
        inheritedSecrets: new Map([[SECRET, EXPR]]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBeDefined();
    expect(message).not.toContain(SECRET);
    expect(message).toContain("Type: Number");
  });

  it('refuses List<Number> on the same terms', async () => {
    await expect(
      resolver.resolveParameters(tpl('List<Number>'), { [PARAM]: `1,${SECRET},3` }, {
        inheritedSecrets: new Map([[SECRET, EXPR]]),
      })
    ).rejects.toThrow(/List<Number>/);
  });

  it('does NOT refuse a Number parameter whose value carries no inherited secret', async () => {
    // Scope control #1: an ordinary numeric parameter is untouched, so the
    // refusal cannot be a blanket "no Number parameters under a nested stack".
    await expect(
      resolver.resolveParameters(tpl('Number'), { [PARAM]: '8080' }, {
        inheritedSecrets: new Map([[SECRET, EXPR]]),
      })
    ).resolves.toEqual({ [PARAM]: 8080 });
  });

  it('does NOT refuse a String parameter carrying the secret — that is the path that WORKS', async () => {
    // Scope control #2, and the load-bearing one: `String` is what CDK
    // synthesizes for every nested-stack cross-reference, so a refusal that
    // caught it would break the case the whole issue exists to fix.
    await expect(
      resolver.resolveParameters(tpl('String'), { [PARAM]: SECRET }, {
        inheritedSecrets: new Map([[SECRET, EXPR]]),
      })
    ).resolves.toEqual({ [PARAM]: SECRET });
  });

  it('does NOT refuse CommaDelimitedList — its elements stay strings, which the redactor handles', async () => {
    await expect(
      resolver.resolveParameters(tpl('CommaDelimitedList'), { [PARAM]: `a,${SECRET},c` }, {
        inheritedSecrets: new Map([[SECRET, EXPR]]),
      })
    ).resolves.toEqual({ [PARAM]: ['a', SECRET, 'c'] });
  });

  it('REFUSES a CommaDelimitedList whose secret CONTAINS a comma - the JSON-blob shape', async () => {
    // The security review of this PR found the type-list gate cleared
    // `CommaDelimitedList` as safe, on the reasoning that it "produces an array
    // of strings (both of which the recording scan and the redactor handle)".
    // True only for a comma-FREE secret. A Secrets Manager `SecretString` is
    // most often a JSON blob, and `coerceParameterValue` does
    // `value.split(',')` -- so the plaintext is shredded into FRAGMENTS, no
    // fragment equals or contains the whole needle, nothing is recorded, the
    // redactor is the identity, and the child's state.json keeps the cleartext.
    //
    // The case ABOVE (a comma-free secret between commas) must keep passing:
    // together they pin that the refusal measures the ACTUAL loss rather than
    // banning the type outright.
    const JSON_SECRET = '{"user":"root","pass":"hunter2"}';
    const JSON_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:::}}';
    await expect(
      resolver.resolveParameters(tpl('CommaDelimitedList'), { [PARAM]: JSON_SECRET }, {
        inheritedSecrets: new Map([[JSON_SECRET, JSON_EXPR]]),
      })
    ).rejects.toThrow(/NESTED_STACK_SECRET_PARAMETER_TYPE|declared 'Type: CommaDelimitedList'/);
  });

  it('never quotes the shredded secret in the CommaDelimitedList refusal', async () => {
    const JSON_SECRET = '{"user":"root","pass":"hunter2"}';
    const JSON_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:::}}';
    let message = '';
    try {
      await resolver.resolveParameters(tpl('CommaDelimitedList'), { [PARAM]: JSON_SECRET }, {
        inheritedSecrets: new Map([[JSON_SECRET, JSON_EXPR]]),
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    // Neither the whole plaintext nor either FRAGMENT the split would produce.
    expect(message).not.toContain(JSON_SECRET);
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('"user":"root"');
  });

  it('does NOT refuse a Number parameter when NOTHING was inherited (a top-level stack)', async () => {
    // Scope control #3: the refusal is reachable only from a nested-stack child
    // engine, which is the only caller that passes a bag.
    await expect(
      resolver.resolveParameters(tpl('Number'), { [PARAM]: SECRET })
    ).resolves.toEqual({ [PARAM]: Number(SECRET) });
  });
});
