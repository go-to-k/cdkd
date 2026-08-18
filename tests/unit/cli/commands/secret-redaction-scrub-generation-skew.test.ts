import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// The DEPLOYED reference, which is what state holds.
const EXPR_PREV = '{{resolve:secretsmanager:app/db:SecretString:password:AWSPREVIOUS}}';
// The reference the user has just edited in and has NOT deployed yet.
const EXPR_CURR = '{{resolve:secretsmanager:app/db:SecretString:password:AWSCURRENT}}';
const PLAINTEXT = 'super-secret-plaintext-value';

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === EXPR_CURR) {
            ctx.recordedSecretValues?.set(PLAINTEXT, EXPR_CURR);
            return PLAINTEXT;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
            return out;
          }
          return v;
        };
        return Promise.resolve(walk(value));
      }),
  })),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function makeStackInfo(): {
  stackName: string;
  displayName: string;
  artifactId: string;
  template: CloudFormationTemplate;
  dependencyNames: string[];
} {
  return {
    stackName: 'MyStack',
    displayName: 'MyStack',
    artifactId: 'MyStack',
    dependencyNames: [],
    template: {
      Resources: {
        // Already redacted, but onto the PREVIOUSLY deployed reference.
        Clean: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { SECRET: EXPR_CURR } } },
        },
        // Written by an old binary: genuinely holds the plaintext.
        Leaky: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: { Variables: { SECRET: EXPR_CURR } },
            // A LIST whose elements carry no identity field, so only positional
            // descent could walk it — and positional descent is exactly what a
            // persisted state bag walked against today's template must not do.
            Args: [EXPR_CURR, 'literal'],
          },
        },
      },
      Outputs: {
        Exposed: { Value: EXPR_CURR },
        // A LIST-valued output. The template side is an `Fn::GetAtt` because
        // CloudFormation requires an Output `Value` to be a string or an
        // intrinsic — it is never a literal array — while `state.outputs` is
        // NOT coerced to string, so the persisted side really is a JSON array.
        // That asymmetry is the whole shape, and an earlier draft of this
        // fixture used an array on BOTH sides, which CloudFormation cannot
        // produce.
        ExposedList: { Value: { 'Fn::GetAtt': ['Leaky', 'Things'] } },
      },
    },
  };
}

function envOf(state: StackState, logicalId: string): Record<string, unknown> {
  const props = state.resources[logicalId]!.properties;
  return (props['Environment'] as Record<string, unknown>)['Variables'] as Record<string, unknown>;
}

/**
 * Issue #1917, from the CALLER that must NOT change — `cdkd scrub`.
 *
 * The module-level matrix pins what each `PathSourceRules` constant does; this
 * pins which one `scrub.ts` actually passes. They are different failures: the
 * fix can be undone either by flipping a flag on a constant or by handing this
 * command the neighbouring constant, which agrees with the right one on both
 * older flags and differs only on the one that matters here.
 */
describe('cdkd scrub - generation skew between state and template (issue #1917)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  function makeState(): StackState {
    return {
      version: 8,
      region: 'us-east-1',
      stackName: 'MyStack',
      resources: {
        Clean: {
          physicalId: 'clean-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { SECRET: EXPR_PREV } } },
        },
        Leaky: {
          physicalId: 'leaky-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: {
            Environment: { Variables: { SECRET: PLAINTEXT } },
            // State holds the same two values in the OTHER order — which a
            // persisted bag legitimately can, since it was written by an older
            // pass rather than produced by resolving today's template.
            Args: ['literal', PLAINTEXT],
          },
          // The drift baseline still holds the DEPLOYED reference while the
          // template has moved on. Scrub repositions `properties` onto
          // EXPR_CURR first, so by the time the observed walk runs, the
          // "record's own properties" it falls back to are a generation ahead
          // of this bag.
          observedProperties: { Environment: { Variables: { SECRET: EXPR_PREV } } },
        },
      },
      outputs: { Exposed: EXPR_PREV, ExposedList: ['literal', PLAINTEXT] },
      lastModified: 0,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: makeState(), etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('leaves an undeployed-template skew alone while still scrubbing the real leak', async () => {
    await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;

    // The skewed record holds no plaintext, so scrub must not touch it.
    // Rewriting it onto EXPR_CURR would make the next deploy compare
    // expression-vs-expression, see NO_CHANGE, and never push the edited
    // reference to AWS.
    expect(envOf(saved, 'Clean')['SECRET']).toBe(EXPR_PREV);
    // Same argument for outputs, which take the same bag/source generations.
    expect(saved.outputs['Exposed']).toBe(EXPR_PREV);
    // ...and the record that really did leak is still cleaned, so the
    // assertions above are not passing because scrub did nothing at all.
    expect(envOf(saved, 'Leaky')['SECRET']).toBe(EXPR_CURR);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
  });

  // Pins `descendArrays: false` on this walk, which nothing else here would
  // notice: a persisted state bag and today's template can hold the same list
  // in different ORDERS, so descending it by index rewrites element 0 — a plain
  // LITERAL — into the secret's expression, and leaves the real plaintext at
  // element 1 to be caught only by the value scan. Both halves of the expected
  // array matter: the literal must survive AND the plaintext must go.
  it('does not walk a list-valued property POSITIONALLY against the template', async () => {
    await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Leaky']!.properties['Args']).toEqual(['literal', EXPR_CURR]);
  });

  // `outputs` reaches `redactSecretsForState` through its OWN call site, with
  // its own source bag, so it needs its own case even though `properties` is
  // covered above. A list-valued output is redacted element-wise by the VALUE
  // scan: the template side is an intrinsic OBJECT, so the array arm is never
  // reached and no positional or keyed descent is involved at all.
  //
  // Deliberately NOT a fence on which rules constant this call site passes.
  // `TEMPLATE_DERIVED_RULES` and `TEMPLATE_SOURCED_RULES` differ only on
  // `descendArrays`, and that flag cannot fire against an intrinsic source —
  // measured byte-identical across every shape a CloudFormation Output can
  // take. A fixture that DID discriminate them would have to put a literal
  // array on the template side, which is not a template CloudFormation accepts.
  it('redacts a list-valued OUTPUT element-wise', async () => {
    await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs['ExposedList']).toEqual(['literal', EXPR_CURR]);
    expect(JSON.stringify(saved.outputs)).not.toContain(PLAINTEXT);
  });

  // The same rule one field over, and it is a SEPARATE binding: the observed
  // walk's rules are DERIVED inside `scrubResourceRecord` from whether a source
  // bag was passed, and that derivation is right for every caller except this
  // one. Scrub has already moved `properties` to another generation by then, so
  // it must override — otherwise the drift baseline is rewritten onto a
  // reference the stack may never have deployed, and `cdkd drift --revert`
  // pushes that to AWS.
  it('leaves an observed BASELINE expression alone when the template has moved on', async () => {
    await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const observed = saved.resources['Leaky']!.observedProperties!;
    const vars = (observed['Environment'] as Record<string, unknown>)['Variables'] as Record<
      string,
      unknown
    >;
    expect(vars['SECRET']).toBe(EXPR_PREV);
  });

  // ...and the half that must keep working, or the fix above would be a
  // regression rather than a correction: a legacy PLAINTEXT baseline is still
  // cleaned. That is what the retained `trustAnyExpression` buys, and it is why
  // scrub does not simply pass the template-sourced constant here.
  it('still cleans a legacy PLAINTEXT observed baseline', async () => {
    const state = makeState();
    state.resources['Leaky']!.observedProperties = {
      Environment: { Variables: { SECRET: PLAINTEXT } },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });

    await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const observed = saved.resources['Leaky']!.observedProperties!;
    const vars = (observed['Environment'] as Record<string, unknown>)['Variables'] as Record<
      string,
      unknown
    >;
    expect(vars['SECRET']).toBe(EXPR_CURR);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
  });

  it('reports no change when the ONLY difference is the undeployed skew', async () => {
    const state = makeState();
    // Bring every OTHER field to what a clean scrub would leave, so the skew is
    // genuinely the only difference. Without this the list fields added for the
    // positional-descent cases above would carry plaintext and the count would
    // be non-zero for a reason this case is not about.
    (
      (state.resources['Leaky']!.properties['Environment'] as Record<string, unknown>)[
        'Variables'
      ] as Record<string, unknown>
    )['SECRET'] = EXPR_PREV;
    state.resources['Leaky']!.properties['Args'] = ['literal', EXPR_CURR];
    state.resources['Leaky']!.observedProperties = {
      Environment: { Variables: { SECRET: EXPR_PREV } },
    };
    state.outputs['ExposedList'] = ['literal', EXPR_CURR];
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });

    const res = await scrubStack(
      makeStackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );

    // A `--dry-run --fail` CI gate reads this count as "plaintext found".
    expect(res.recordsChanged).toBe(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });
});
