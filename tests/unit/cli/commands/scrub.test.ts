import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import { DynamicReferenceRegionAmbiguousError } from '../../../../src/utils/error-handler.js';

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

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';
// A SecureString ssm parameter is the SECOND secret class the resolver
// classifies (issue #1901). Its expression is spelled `{{resolve:ssm:...}}` —
// identical to a PUBLIC String parameter's — which is the whole point of the
// case below: scrub must rewrite whatever the resolver recorded, and must not
// re-derive secret-ness from the spelling.
const SECURE_PLAINTEXT = 'decrypted-securestring-value';
const SECURE_EXPR = '{{resolve:ssm:/prod/db/password}}';
// A SECOND expression for the SAME secret — its `:AWSCURRENT` version stage.
// It resolves to SECRET_PLAINTEXT too, so the value-keyed map collapses the
// pair and only the template can say which leaf held which (issue #1910).
const SECRET_EXPR_STAGED = '{{resolve:secretsmanager:my-secret:SecretString:password:AWSCURRENT}}';
// A secret that exists ONLY in an orphan record — no live resource or output
// references it, so nothing but the orphan pass can record it.
const ORPHAN_PLAINTEXT = 'orphan-only-secret-plaintext';
const THROW_AFTER_RECORDING_EXPR = '{{resolve:secretsmanager:orphan-secret:SecretString}}';

// Mock resolver: resolving a value equal to SECRET_EXPR records the secret and
// returns the plaintext (as the real resolver does). This lets scrubStack learn
// the plaintext->expression map without a live AWS GetSecretValue.
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
          if (v === SECURE_EXPR) {
            ctx.recordedSecretValues?.set(SECURE_PLAINTEXT, SECURE_EXPR);
            return SECURE_PLAINTEXT;
          }
          // Records, THEN throws with the plaintext in the message. This is
          // the shape the resource loop's comment describes for
          // `pinCrossRegionSecrets`: it can fail after having recorded a
          // foreign plaintext, and the error then reaches the boundary.
          if (v === THROW_AFTER_RECORDING_EXPR) {
            ctx.recordedSecretValues?.set(ORPHAN_PLAINTEXT, THROW_AFTER_RECORDING_EXPR);
            // The orphan loop's catch SWALLOWS an ordinary error, so an
            // ordinary one would make the case below vacuous. This is the
            // class the loop deliberately rethrows, which is what carries the
            // message out to the masking boundary.
            throw new DynamicReferenceRegionAmbiguousError(
              `region ambiguous while handling ${ORPHAN_PLAINTEXT}`
            );
          }
          if (v === SECRET_EXPR_STAGED) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR_STAGED);
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
    // The TEMPLATE carries the {{resolve:...}} expression (what marks the secret).
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { SECRET: SECRET_EXPR, PUBLIC: 'ok' } } },
        },
      },
      Outputs: { LeakedOut: { Value: SECRET_EXPR } },
    },
  };
}

// State written by an OLD binary: it holds the resolved PLAINTEXT (the bug).
function makeLeakyState(): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: {
      Fn: {
        physicalId: 'my-fn',
        resourceType: 'AWS::Lambda::Function',
        properties: { Environment: { Variables: { SECRET: SECRET_PLAINTEXT, PUBLIC: 'ok' } } },
      },
    },
    outputs: { LeakedOut: SECRET_PLAINTEXT },
    lastModified: 0,
  };
}

describe('cdkd scrub - scrubStack', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: makeLeakyState(), etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('rewrites leaked plaintext in properties AND outputs to the {{resolve:...}} expression', async () => {
    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    expect(res.secretsFound).toBeGreaterThanOrEqual(1);
    expect(res.recordsChanged).toBeGreaterThan(0);
    expect(lockManager.acquireLockWithRetry).toHaveBeenCalled();
    expect(lockManager.releaseLock).toHaveBeenCalled();

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const env = (saved.resources['Fn']!.properties['Environment'] as Record<string, unknown>)[
      'Variables'
    ] as Record<string, unknown>;
    expect(env['SECRET']).toBe(SECRET_EXPR);
    expect(env['PUBLIC']).toBe('ok'); // non-secret untouched
    expect(saved.outputs['LeakedOut']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    // Saved under the optimistic lock etag.
    expect(stateBackend.saveState.mock.calls.at(-1)![3]).toEqual({ expectedEtag: 'etag-1' });
  });

  it('DROPS the skipped-outputs record it was handed (issue #2740)', async () => {
    // The flat rule: every writer that rebuilds state outside a deploy drops
    // the record. Replacing a plaintext with its expression is not
    // monotonically less resolvable — an ordinary resource `GetAtt` returns
    // the stored string verbatim, so an output that splits that string can
    // start resolving once its shape changes — which is one of three
    // per-writer safety arguments that were each wrong in review.
    const leaky = makeLeakyState();
    leaky.skippedOutputs = { Broken: 'digest-recorded-by-the-last-deploy' };
    stateBackend.getState.mockResolvedValue({ state: leaky, etag: 'etag-1' });

    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    expect(res.recordsChanged).toBeGreaterThan(0);
    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    // The scrub itself still happened — the drop is targeted, not a rebuild.
    expect(saved.outputs['LeakedOut']).toBe(SECRET_EXPR);
    expect('skippedOutputs' in saved).toBe(false);
  });

  it('dry-run reports the secret but does NOT save or lock', async () => {
    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: true,
      logger,
    });

    expect(res.secretsFound).toBeGreaterThanOrEqual(1);
    expect(res.recordsChanged).toBeGreaterThan(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
  });

  it('reports nothing to scrub when state is already clean (holds the expression)', async () => {
    const clean = makeLeakyState();
    (
      (clean.resources['Fn']!.properties['Environment'] as Record<string, unknown>)[
        'Variables'
      ] as Record<string, unknown>
    )['SECRET'] = SECRET_EXPR;
    clean.outputs['LeakedOut'] = SECRET_EXPR;
    stateBackend.getState.mockResolvedValue({ state: clean, etag: 'etag-1' });

    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    expect(res.recordsChanged).toBe(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  // Issue (#1902) scope item 3: scrub and the deploy-time redaction must always
  // cover the SAME set of sensitive values, from ONE source of truth. That
  // source is the resolver's classification — scrub reads the very
  // `recordedSecretValues` bag the resolver fills, so it inherits every class
  // the deploy path redacts without a second list to keep in sync.
  //
  // This pins the half that is scrub's own: it rewrites whatever was RECORDED
  // and never re-derives secret-ness from the expression's spelling. A scrub
  // that filtered on a `{{resolve:secretsmanager:` prefix would pass every other
  // test in this file and fail here — and would silently not cover the
  // SecureString class (#1901), whose spelling is indistinguishable from a
  // public String parameter's.
  it('rewrites a recorded SecureString ssm value too — no filtering by spelling', async () => {
    const info = makeStackInfo();
    const vars = (
      info.template.Resources!['Fn']!.Properties!['Environment'] as Record<string, unknown>
    )['Variables'] as Record<string, unknown>;
    vars['SECURE'] = SECURE_EXPR;

    const leaky = makeLeakyState();
    const stateVars = (
      leaky.resources['Fn']!.properties['Environment'] as Record<string, unknown>
    )['Variables'] as Record<string, unknown>;
    stateVars['SECURE'] = SECURE_PLAINTEXT;
    stateBackend.getState.mockResolvedValue({ state: leaky, etag: 'etag-1' });

    await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const env = (saved.resources['Fn']!.properties['Environment'] as Record<string, unknown>)[
      'Variables'
    ] as Record<string, unknown>;
    expect(env['SECURE']).toBe(SECURE_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECURE_PLAINTEXT);
    // The secretsmanager class and the untouched public value still behave as
    // before, so this is an ADDITION to scrub's coverage rather than a swap.
    expect(env['SECRET']).toBe(SECRET_EXPR);
    expect(env['PUBLIC']).toBe('ok');
  });

  // Issue #1910: `cdkd scrub` had the synthesized template in hand and passed
  // no position source, so it could bake the WRONG expression into state while
  // reporting the stack cleaned.
  it('keeps each leaf on ITS OWN expression when two references share a value', async () => {
    const stackInfo = {
      stackName: 'MyStack',
      displayName: 'MyStack',
      artifactId: 'MyStack',
      dependencyNames: [],
      template: {
        Resources: {
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Environment: { Variables: { PLAIN: SECRET_EXPR, STAGED: SECRET_EXPR_STAGED } },
            },
          },
        },
        Outputs: { PlainOut: { Value: SECRET_EXPR }, StagedOut: { Value: SECRET_EXPR_STAGED } },
      },
    };
    stateBackend.getState.mockResolvedValue({
      state: {
        version: 8,
        region: 'us-east-1',
        stackName: 'MyStack',
        resources: {
          Fn: {
            physicalId: 'my-fn',
            resourceType: 'AWS::Lambda::Function',
            properties: {
              Environment: { Variables: { PLAIN: SECRET_PLAINTEXT, STAGED: SECRET_PLAINTEXT } },
            },
          },
        },
        outputs: { PlainOut: SECRET_PLAINTEXT, StagedOut: SECRET_PLAINTEXT },
        lastModified: 0,
      } satisfies StackState,
      etag: 'etag-1',
    });

    await scrubStack(stackInfo as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const env = (saved.resources['Fn']!.properties['Environment'] as Record<string, unknown>)[
      'Variables'
    ] as Record<string, string>;
    expect(env['PLAIN']).toBe(SECRET_EXPR);
    expect(env['STAGED']).toBe(SECRET_EXPR_STAGED);
    expect(saved.outputs['PlainOut']).toBe(SECRET_EXPR);
    expect(saved.outputs['StagedOut']).toBe(SECRET_EXPR_STAGED);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });

  it('returns zero when no state exists for the stack', async () => {
    stateBackend.getState.mockResolvedValue(null);
    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });
    expect(res).toEqual({
      recordsChanged: 0,
      secretsFound: 0,
      secretBearingKeys: 0,
      unverifiableReads: 0,
      // Issue #2667 review: an export name is an outputs-bag KEY, so every
      // message naming one is masked through the stack's own secrets bag
      // rather than merely control-stripped. The field is REQUIRED so no
      // caller can print a raw name by forgetting it — which is why it is
      // present even on the no-state arm, bound to an empty bag.
      exportNameDisplay: expect.any(Function),
    });
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });
});

/**
 * Rollback-orphan records (issue go-to-k/cdkd#2943).
 *
 * `scrub` walked `resources` and `outputs` only, so its
 * `No plaintext secrets found` verdict was silent about `orphans[*].state` —
 * a whole `ResourceState`, `properties` and `attributes` included.
 *
 * The write side redacts that field today, proven against real AWS by
 * `tests/integration/retain-orphan-secret`. These cases are the READ-side
 * backstop for the one situation `scrub` exists for: the write side was wrong
 * or absent. That is not hypothetical — the first implementation of the
 * redaction keyed on the LIVE resource map, and an orphan is by definition
 * absent from that map, so its needles came out empty and the plaintext was
 * persisted with the whole unit suite green.
 */
describe('cdkd scrub - orphan records (go-to-k/cdkd#2943)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  /** A record whose logical id is GONE from the template — the hard case. */
  const orphanHolding = (value: unknown) => ({
    logicalId: 'RemovedFromTemplate',
    orphanedAt: 1,
    state: {
      physicalId: 'MyStack-RemovedFromTemplate',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Value: value },
    },
  });

  const stateWithOrphan = (value: unknown, resources: StackState['resources'] = {}): StackState => ({
    version: 9,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources,
    outputs: {},
    orphans: [orphanHolding(value)],
    lastModified: 0,
  });

  const emptyTemplateStack = () => ({
    stackName: 'MyStack',
    template: { Resources: {}, Outputs: {} } as CloudFormationTemplate,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
  });

  it('derives a needle from the RECORD when the template has no entry for it', async () => {
    // The record still holds an EXPRESSION, so resolving the record's own bag
    // records the pair. The template is EMPTY — the user removed the failing
    // resource from their CDK app, which is the ordinary way to reach this
    // state — so the resources pass learns nothing and cannot help.
    stateBackend.getState.mockResolvedValue({
      state: stateWithOrphan(SECRET_EXPR),
      etag: 'etag-1',
    });

    const result = await scrubStack(
      emptyTemplateStack() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );

    // A needle existed at all — without the per-record derivation `totalSecrets`
    // is 0 and scrub returns early, printing a clean verdict over the record.
    expect(result.secretsFound).toBeGreaterThan(0);
  });

  it('WRITES BACK the scrubbed records instead of carrying the originals', async () => {
    stateBackend.getState.mockResolvedValue({
      state: stateWithOrphan(SECRET_PLAINTEXT, {
        // A live resource still references the same secret, so the resources
        // pass learns the needle. This is the UNION half: the record holds
        // PLAINTEXT and therefore yields no needle of its own.
        Fn: {
          physicalId: 'my-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { SECRET: SECRET_PLAINTEXT } } },
        },
      }),
      etag: 'etag-1',
    });

    await scrubStack(
      {
        stackName: 'MyStack',
        template: {
          Resources: {
            Fn: {
              Type: 'AWS::Lambda::Function',
              Properties: { Environment: { Variables: { SECRET: SECRET_EXPR } } },
            },
          },
          Outputs: {},
        } as CloudFormationTemplate,
      } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );

    expect(stateBackend.saveState).toHaveBeenCalled();
    const written = stateBackend.saveState.mock.calls[0]![2] as StackState;
    // Before this change `orphans` rode the `...carriedState` spread untouched,
    // so a scrubbed record was computed and then thrown away.
    expect(written.orphans![0]!.state.properties['Value']).toBe(SECRET_EXPR);
  });

  it('does not GIVE a record-free state an orphans key', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeLeakyState(), etag: 'etag-1' });

    await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    const written = stateBackend.saveState.mock.calls[0]![2] as StackState;
    // The no-schema-bump argument for `orphans` depends on a stack that never
    // orphaned anything never gaining the key — scrubbing must not be the
    // thing that adds it.
    expect('orphans' in written).toBe(false);
  });
});

describe('cdkd scrub - orphan needles reach the masking boundary (go-to-k/cdkd#2943)', () => {
  it('masks an orphan-only plaintext in an error escaping scrubStack', async () => {
    // The record's resolution records the plaintext and THEN fails. Nothing
    // else in the run knows that value: the template is empty, so neither the
    // resources pass nor the outputs pass has a needle for it.
    //
    // Before the fix the boundary masked against
    // `allRecordedSecrets(outputSecrets, perResourceSecrets)` — two bags that
    // cannot contain it — so the plaintext rendered into the error the CLI
    // prints, cause chain included. A security reviewer found this, and the
    // comment beside the orphan map claimed the opposite was true.
    const stateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 9,
          region: 'us-east-1',
          stackName: 'MyStack',
          resources: {},
          outputs: {},
          orphans: [
            {
              logicalId: 'Gone',
              orphanedAt: 1,
              state: {
                physicalId: 'MyStack-Gone',
                resourceType: 'AWS::SSM::Parameter',
                properties: { Value: THROW_AFTER_RECORDING_EXPR },
              },
            },
          ],
          lastModified: 0,
        } as StackState,
        etag: 'etag-1',
      }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    const caught = await scrubStack(
      { stackName: 'MyStack', template: { Resources: {}, Outputs: {} } as CloudFormationTemplate } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    ).then(
      () => null,
      (err: unknown) => err
    );

    // UNCONDITIONAL. An `if (caught !== null)` guard here would make the case
    // pass when nothing throws, which is how a negative assertion becomes
    // unfalsifiable by construction — and the swallowing catch in the orphan
    // loop means "nothing throws" is the DEFAULT, so the guard would have hidden
    // a dead test.
    expect(caught).not.toBeNull();
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object))).not.toContain(
      ORPHAN_PLAINTEXT
    );
    // ...and the masked form really is there, so the case cannot pass because
    // the message went missing entirely.
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object))).toContain(
      'region ambiguous'
    );
  });
});
