import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

/**
 * `cdkd scrub`'s OUTPUTS redaction must not descend a list-valued output
 * POSITIONALLY (issue [#2099](https://github.com/go-to-k/cdkd/issues/2099)).
 *
 * The bag is a PERSISTED `state.outputs`; the source is TODAY's template. That
 * is a cross-GENERATION pair, so equal length is the only thing connecting a
 * stored element to a template element — and `redactByPath` returns a
 * known-secret source leaf VERBATIM, so under `TEMPLATE_DERIVED_RULES`
 * (`descendArrays: true`) a stored literal at index `i` is rewritten to today's
 * expression at index `i`. `state.outputs` is re-applied to consumer stacks by
 * the exports index and by `Fn::ImportValue`, so that fabricated reference is
 * shipped onward as a literal token — the #1934 BREAK class.
 *
 * The call site used to pass the default on the premise that the array arm was
 * unreachable, "because CloudFormation requires an Output `Value` to be a string
 * or an intrinsic object". CloudFormation does; cdkd does not enforce it
 * (`TemplateOutput.Value` is typed `unknown`, `StackState.outputs` is not
 * string-coerced, and the resolver walks an array elementwise), which is what
 * this suite pins.
 */

vi.mock('../../../../src/utils/logger.js', () => {
  const fake = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';
/**
 * A PREVIOUS generation's element, at the index today's template holds the
 * secret reference at. It is not the plaintext of anything this run recorded,
 * so the value scan can never rewrite it — only a positional descent can, which
 * is exactly the mechanism under test.
 */
const STALE_LIST_ELEMENT = 'arn:aws:sqs:us-east-1:111122223333:previous-generation-queue';

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === SECRET_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR);
            return SECRET_PLAINTEXT;
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

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

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
      Resources: {},
      Outputs: {
        // A scalar secret-bearing output, so `outputSecrets` is non-empty and
        // the positioned pass actually runs at all.
        LeakedOut: { Value: SECRET_EXPR },
        // TODAY's list-valued output. CDK does not emit this shape; an escape
        // hatch, a hand-written template or an imported one does, and cdkd
        // accepts it.
        ListOut: { Value: ['public-first', SECRET_EXPR] },
      },
    },
  };
}

/** State written by a PREVIOUS generation of the same template. */
function makePreviousGenerationState(): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: {},
    outputs: {
      LeakedOut: SECRET_PLAINTEXT,
      ListOut: ['public-first', STALE_LIST_ELEMENT],
    },
    lastModified: 0,
  };
}

describe('cdkd scrub outputs: no positional array descent across generations (issue #2099)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi
        .fn()
        .mockResolvedValue({ state: makePreviousGenerationState(), etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('a previous-generation list-valued output does NOT take the source leaf positionally', async () => {
    const res = await scrubStack(
      makeStackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );

    // The scalar output IS scrubbed — the pass still does its job, so a green
    // result here cannot come from the redaction being skipped entirely.
    expect(res.recordsChanged).toBe(1);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs['LeakedOut']).toBe(SECRET_EXPR);

    // THE assertion: the stale element keeps its stored value. Under
    // `TEMPLATE_DERIVED_RULES` the arrays pair by index and index 1 is
    // rewritten to today's expression — a reference this stack's state never
    // held, republished verbatim to every consumer by the exports index.
    expect(saved.outputs['ListOut']).toEqual(['public-first', STALE_LIST_ELEMENT]);
  });

  it('the list output is left byte-identical when nothing else in the stack changes', async () => {
    // Same shape with the scalar leak already repaired: the whole outputs bag
    // must then be untouched, so the positional descent has no cover from a
    // sibling key's legitimate rewrite.
    const state = makePreviousGenerationState();
    state.outputs['LeakedOut'] = SECRET_EXPR;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });

    const res = await scrubStack(
      makeStackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );

    expect(res.recordsChanged).toBe(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a whole-value plaintext match in a list element is still repaired by the VALUE scan', async () => {
    // The capability the swap KEEPS: `descendArrays: false` refuses the
    // positional pairing and falls through to the VALUE SCAN, which still
    // rewrites any element whose stored value IS a recorded plaintext. Without
    // this case the two above would pass just as well if array elements were
    // dropped from the outputs redaction altogether.
    //
    // What it does NOT fence, stated because an earlier version of this comment
    // claimed the whole outputs pass: the POSITION SOURCE argument. Replacing it
    // with `undefined` leaves all three cases in this file GREEN — the value
    // scan needs no source, and the two above assert what the source would NOT
    // have changed. That mutation is caught by `scrub.test.ts`'s pre-existing
    // positioned-outputs case, not from here.
    const state = makePreviousGenerationState();
    state.outputs['ListOut'] = ['public-first', SECRET_PLAINTEXT];
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });

    await scrubStack(
      makeStackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );

    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs['ListOut']).toEqual(['public-first', SECRET_EXPR]);
  });
});
