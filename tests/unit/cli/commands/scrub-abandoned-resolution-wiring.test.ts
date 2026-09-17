/**
 * `cdkd scrub` OPTS IN to the resolver's per-unit recovery, which is what makes
 * issues go-to-k/cdkd#3181 and go-to-k/cdkd#3218 reach a user at all.
 *
 * The recovery is opt-in by design — a caller that sends its resolved value to
 * AWS must not silently gain a partially-substituted value — so the mechanism
 * alone changes NOTHING in the shipped binary. That is not a hypothetical: the
 * first cut of #3181 landed the resolver half with zero callers passing a bag,
 * and three independent reviewers reported the same thing, that the shipped
 * binary was byte-for-byte unchanged while the changelog claimed a fix. This
 * file is the fence for the half that was missing.
 *
 * Two properties, and they pull in opposite directions:
 *
 *  - scrub LEARNS the needles the recovery makes available (the point: a needle
 *    is the only thing that drives redaction, so a reference abandoned before
 *    the fix left its plaintext in `state.json` after a scrub that reported
 *    success), and
 *  - scrub still COUNTS and WARNS about the abandoned unit, exactly as it did
 *    when the resolve threw (go-to-k/cdkd#3160's counter). Recovery must not
 *    buy the needle by going quiet about the failure — a silent recovery would
 *    let `--dry-run --fail` exit 0 over a reference nobody fetched.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import type { AbandonedResolution } from '../../../../src/deployment/intrinsic-function-resolver.js';

/** Resolvable, and its plaintext is what must end up redacted in state. */
const LIVE_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
const LIVE_PLAINTEXT = 'the-real-resolved-db-password';
/** Unfetchable: the unit the resolver records into the bag instead of throwing. */
const DEAD_EXPR = '{{resolve:ssm-secure:/deleted/param}}';

/**
 * A resolver that RECOVERS: it records the dead reference into the caller's bag
 * and goes on to resolve the live one, which is precisely the behaviour the
 * real resolver has once a bag is passed. When the caller passes NO bag it
 * throws instead — the pre-#3181 contract — so a scrub that quietly stopped
 * opting in fails here rather than going green with fewer needles.
 */
vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../src/deployment/intrinsic-function-resolver.js')
  >()),
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi.fn().mockImplementation((value: unknown, ctx: ResolveCtx) => {
      // Per-case override, for the two verdict cases that need to control the
      // BAG's contents exactly rather than derive it from a leaf walk.
      if (resolveImpl !== undefined) return resolveImpl(value, ctx);
      const dead = (): Error =>
        Object.assign(new Error('Parameter /deleted/param not found.'), {
          name: 'ParameterNotFound',
        });
      let aborted: Error | undefined;
      /**
       * Walks TOKEN BY TOKEN in order, which is the whole point: on the dead
       * token it either aborts the rest of the leaf (no bag — the pre-#3181
       * contract) or records it and CONTINUES, so the live token after it is
       * still fetched and its needle recorded.
       */
      const walkLeaf = (leaf: string): string => {
        let out = '';
        for (const token of leaf.split(/(\{\{resolve:[^}]*\}\})/)) {
          if (aborted !== undefined) return leaf;
          if (token === DEAD_EXPR) {
            if (ctx.abandonedResolutions === undefined) {
              aborted = dead();
              return leaf;
            }
            ctx.abandonedResolutions.push({
              unit: 'token',
              subject: DEAD_EXPR,
              message: 'Parameter /deleted/param not found.',
              error: dead(),
              carriedDynamicReference: true,
              carriedFetchableReference: true,
            });
            out += token;
          } else if (token === LIVE_EXPR) {
            ctx.recordedSecretValues?.set(LIVE_PLAINTEXT, LIVE_EXPR);
            out += LIVE_PLAINTEXT;
          } else {
            out += token;
          }
        }
        return out;
      };
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return v.includes('{{resolve:') ? walkLeaf(v) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
          return out;
        }
        return v;
      };
      const resolved = walk(value);
      return aborted === undefined ? Promise.resolve(resolved) : Promise.reject(aborted);
    }),
  })),
}));

interface ResolveCtx {
  recordedSecretValues?: Map<string, string>;
  abandonedResolutions?: AbandonedResolution[];
}

/**
 * Set by a case to take over `resolve` entirely. `vi.hoisted` because the mock
 * factory above is hoisted and closes over it.
 */
let resolveImpl: ((value: unknown, ctx: ResolveCtx) => Promise<unknown>) | undefined;

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * BOTH references in ONE string leaf, and that is the only shape that tests
 * this. Two separate PROPERTIES would be independent already — go-to-k/cdkd#3196
 * made scrub resolve per property — so a two-property fixture passes whether or
 * not scrub opts in, which is exactly how the first cut of this file fooled its
 * own mutation probe.
 */
const MIXED_LEAF = `${DEAD_EXPR}/${LIVE_EXPR}`;

function stackInfo(): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName: 'MyStack',
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: {
            DBInstanceIdentifier: 'app-db',
            MasterUserPassword: MIXED_LEAF,
          },
        },
      },
    } as CloudFormationTemplate,
  };
}

function stateWithStoredPlaintext(): StackState {
  const db: ResourceState = {
    physicalId: 'app-db',
    resourceType: 'AWS::RDS::DBInstance',
    properties: {
      DBInstanceIdentifier: 'app-db',
      // The disclosure: a legacy record holding the RESOLVED value where the
      // template holds the mixed leaf.
      MasterUserPassword: `${DEAD_EXPR}/${LIVE_PLAINTEXT}`,
    },
  };
  return {
    version: 10,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: { Db: db },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

describe('cdkd scrub opts in to per-unit recovery (go-to-k/cdkd#3181 / go-to-k/cdkd#3218)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveImpl = undefined;
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  async function scrub(): Promise<StackState | undefined> {
    stateBackend.getState.mockResolvedValue({ state: stateWithStoredPlaintext(), etag: 'etag-1' });
    await scrubStack(stackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: logger as never,
    });
    const call = stateBackend.saveState.mock.calls.at(-1);
    return call ? (call[2] as StackState) : undefined;
  }

  it('redacts the reference sitting BESIDE an unfetchable one', async () => {
    const saved = await scrub();

    const stored = String(
      (saved?.resources?.['Db'] as ResourceState | undefined)?.properties?.['MasterUserPassword']
    );
    expect(
      stored,
      'the live reference sits AFTER an unfetchable one in the same leaf, so before scrub opted ' +
        'in to the recovery the token loop aborted, its needle was never recorded, and this ' +
        'stored plaintext survived a scrub that reported success (go-to-k/cdkd#3181).'
    ).not.toContain(LIVE_PLAINTEXT);
    expect(stored).toContain(LIVE_EXPR);
  });

  it('still reports the abandoned unit rather than going quiet about it', async () => {
    await scrub();

    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(
      warned,
      'recovery bought the needle by going SILENT about the reference nobody fetched — so ' +
        '`--dry-run --fail` would exit 0 over it, undoing go-to-k/cdkd#3160.'
    ).toMatch(/scan|abandon|unverifiab/i);
  });

  it('gates on a real fetch failure recorded BEHIND a template-shape one', async () => {
    // The blocker a round-2 security review found in the first cut of this
    // wiring, and the reason the verdict is per ENTRY folded to the most
    // severe rather than read off entry 0.
    //
    // `isTemplateShapeResolutionFailure` decides `warn` (gates nothing) vs
    // `count` (gates `--fail`), and that class fires EN MASSE on healthy
    // stacks — one `Default`-less parameter makes every `{Ref: <param>}`
    // throw. So entry 0 being a shape failure is the COMMON case. Recovery
    // then reaches a genuinely unfetched reference later in the same property,
    // which is the entire finding this feature exists to produce; judging only
    // entry 0 discarded it and printed `No plaintext secrets found`.
    stateBackend.getState.mockResolvedValue({ state: stateWithStoredPlaintext(), etag: 'etag-1' });
    resolveImpl = (value: unknown, ctx: ResolveCtx) => {
      // Only the property carrying the leaf; the loop also visits siblings.
      if (typeof value !== 'string' || !value.includes('{{resolve:')) return Promise.resolve(value);
      ctx.abandonedResolutions?.push(
        // Entry 0: a template-shape failure carrying NO reference of its own.
        {
          unit: 'key',
          subject: 'A',
          message: 'Ref NoSuchThing not found',
          error: new Error('Ref NoSuchThing not found'),
          carriedDynamicReference: false,
          carriedFetchableReference: false,
        },
        // Entry 1: a fetchable reference nobody fetched. This must gate.
        {
          unit: 'token',
          subject: DEAD_EXPR,
          message: 'Parameter /deleted/param not found.',
          error: Object.assign(new Error('Parameter /deleted/param not found.'), {
            name: 'ParameterNotFound',
          }),
          carriedDynamicReference: true,
          carriedFetchableReference: true,
        }
      );
      return Promise.resolve({});
    };

    const res = await scrubStack(
      stackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );

    expect(
      res.unverifiableLeaves,
      'a genuinely unfetched reference recorded AFTER a template-shape failure did not gate, so ' +
        '`cdkd scrub --dry-run --fail` would exit 0 over the plaintext behind it.'
    ).toBe(1);
  });

  it('does NOT gate on an abandoned key that carries no reference of its own', async () => {
    // The opposite direction, and go-to-k/cdkd#3218's own repro: the abandoned
    // unit is a bare `{"Ref": ...}`. Nothing about it is unverifiable — no
    // reference went unfetched — so it must not gate. Judged against the
    // ENCLOSING property it would inherit the live sibling's reference and
    // count, which is why the verdict is unit-scoped.
    stateBackend.getState.mockResolvedValue({ state: stateWithStoredPlaintext(), etag: 'etag-1' });
    resolveImpl = (value: unknown, ctx: ResolveCtx) => {
      // Only the property carrying the leaf; the loop also visits siblings.
      if (typeof value !== 'string' || !value.includes('{{resolve:')) return Promise.resolve(value);
      ctx.abandonedResolutions?.push({
        unit: 'key',
        subject: 'A',
        message: 'Ref NoSuchThing not found',
        error: new Error('Ref NoSuchThing not found'),
        carriedDynamicReference: false,
        carriedFetchableReference: false,
      });
      return Promise.resolve({});
    };

    const res = await scrubStack(
      stackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );

    expect(res.unverifiableLeaves).toBe(0);
  });

  it('opts in on the ORPHAN-record walk too, not only on resource properties', async () => {
    // Measured before this case existed: removing BOTH the orphan and the
    // output-value opt-ins reddened ZERO of 4,180 tests in tests/unit/cli.
    //
    // ISOLATION IS THE WHOLE DIFFICULTY, and the first cut of this case got it
    // wrong: it left the mixed leaf on the TEMPLATE resource, so the resource
    // pass learned the needle first and the orphan walk's own opt-in changed
    // nothing — the probe stayed green. The template is therefore
    // reference-free here, and the orphan record carries BOTH the expression
    // that teaches the needle AND, in a second property, the stored plaintext
    // that only that needle can redact.
    const state = stateWithStoredPlaintext();
    state.resources = {};
    (state as unknown as { orphans: unknown[] }).orphans = [
      {
        logicalId: 'Gone',
        state: {
          physicalId: 'gone-phys',
          resourceType: 'AWS::RDS::DBInstance',
          properties: {
            // The resolve SOURCE: dead reference first, live one behind it.
            ConnectionTemplate: MIXED_LEAF,
            // The DISCLOSURE, redactable only once the live reference above
            // has been fetched and its needle recorded.
            MasterUserPassword: LIVE_PLAINTEXT,
          },
        },
      },
    ];
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });

    await scrubStack(
      { stackName: 'MyStack', template: { Resources: {} } } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );

    const saved = stateBackend.saveState.mock.calls.at(-1)?.[2] as
      | { orphans?: Array<{ state: { properties: Record<string, unknown> } }> }
      | undefined;
    // PREMISE: the orphan record must actually be in the saved state. Without
    // this, `String(undefined)` is "undefined", which contains no plaintext and
    // makes the assertion below pass for the wrong reason -- measured, this is
    // exactly how the first two cuts of this case fooled their own probe.
    // PREMISE, and it is what makes this case falsifiable. Two readings, both
    // meaning the orphan walk did not learn the needle: either nothing was
    // redacted so `recordsChanged` stayed 0 and scrub never called `saveState`
    // at all (measured: this is what removing the opt-in produces), or a record
    // was saved carrying no orphans. Without it `String(undefined)` is
    // "undefined", contains no plaintext, and the assertion below passes for
    // the wrong reason — the `?.`-on-absent-subject trap.
    expect(
      saved?.orphans,
      'no orphan record reached saveState -- with no needle learned there is nothing to redact, ' +
        'so scrub saves nothing.'
    ).toHaveLength(1);
    const stored = String(saved?.orphans?.[0]?.state.properties['MasterUserPassword']);
    expect(
      stored,
      'the orphan record kept its stored plaintext: the orphan walk abandoned at the dead ' +
        'reference and never recorded a needle for the live one behind it. Nothing else in the ' +
        'run resolves this record, so only its own opt-in can learn that needle.'
    ).not.toContain(LIVE_PLAINTEXT);
  });

  it('opts in on the output-VALUE pass too', async () => {
    // The third opted-in pass, and the one the commit message for the orphan
    // case wrongly claimed was already covered — a round-4 review measured that
    // deleting `abandonedResolutions: abandonedOutput` still reddened nothing.
    //
    // Isolated the same way the orphan case is: the template carries NO
    // resources, so no other pass can learn the needle, and the output's Value
    // holds the mixed leaf while `state.outputs` holds the stored plaintext
    // that only that needle can redact.
    const state = stateWithStoredPlaintext();
    state.resources = {};
    state.outputs = { Conn: LIVE_PLAINTEXT };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });

    await scrubStack(
      {
        stackName: 'MyStack',
        template: { Resources: {}, Outputs: { Conn: { Value: MIXED_LEAF } } },
      } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );

    const saved = stateBackend.saveState.mock.calls.at(-1)?.[2] as
      | { outputs?: Record<string, unknown> }
      | undefined;
    // PREMISE first: with no needle learned nothing is redacted, so scrub saves
    // nothing and every `?.` below would short-circuit to a passing assertion.
    expect(
      saved?.outputs,
      'no state reached saveState -- with no needle learned there is nothing to redact.'
    ).toBeDefined();
    // POSITIVE, not just `not.toContain`. With no resources in the template
    // `saveState` runs only when the outputs bag CHANGED, so a
    // `not.toContain` here is implied by the premise above and no mutation can
    // red it — and a FABRICATED rewrite of `Conn` would satisfy it too.
    // Asserting the exact expression is what distinguishes "redacted onto its
    // own reference" from "rewritten to something else".
    expect(
      saved?.outputs?.['Conn'],
      "the output was not redacted onto its own expression: the output-VALUE pass either " +
        'abandoned at the dead reference and never recorded a needle for the live one behind ' +
        'it, or rewrote the key to something the template did not produce.'
    ).toBe(LIVE_EXPR);
  });

  it('WARNS without gating for a unit whose reference could never be fetched', async () => {
    // The `warn` / `silent` boundary, which had only a source-shape pin and no
    // behavioural case anywhere (round-5 review). The two are decided by
    // different questions and confusing them is the go-to-k/cdkd#3178 round-5
    // near-miss: `carriedDynamicReference` alone decides SILENCE, while
    // `carriedFetchableReference` decides whether an abandonment GATES.
    //
    // This unit carried a reference but an unfetchable one — a token still
    // holding an `Fn::Sub` placeholder, which no lookup could have resolved.
    // It must be SAID (so an operator sees the scan was cut short) and must
    // NOT gate `--dry-run --fail` (nothing an operator could fix makes it
    // fetchable, so gating on it reds healthy stacks forever).
    stateBackend.getState.mockResolvedValue({ state: stateWithStoredPlaintext(), etag: 'etag-1' });
    resolveImpl = (value: unknown, ctx: ResolveCtx) => {
      if (typeof value !== 'string' || !value.includes('{{resolve:')) {
        return Promise.resolve(value);
      }
      ctx.abandonedResolutions?.push({
        unit: 'token',
        subject: '{{resolve:ssm-secure:/app/${Unbound}}}',
        message: 'key ${Unbound} not found',
        error: new Error('key ${Unbound} not found'),
        carriedDynamicReference: true,
        carriedFetchableReference: false,
      });
      return Promise.resolve(value);
    };

    const res = await scrubStack(
      stackInfo() as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );

    expect(
      res.unverifiableLeaves,
      'an unfetchable reference GATED the exit code. Nothing an operator can do makes it ' +
        'fetchable, so gating on it reds healthy stacks permanently.'
    ).toBe(0);
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(
      warned,
      'the abandonment went unsaid. It does not gate, but an operator still needs to see that ' +
        'the scan was cut short — silence is reserved for a unit carrying no reference at all.'
    ).toMatch(/scan|abandon|cut short/i);
  });

  it('does not leak a resolved plaintext into the warn or debug lines', async () => {
    await scrub();

    for (const call of [...logger.warn.mock.calls, ...logger.debug.mock.calls]) {
      expect(String(call[0])).not.toContain(LIVE_PLAINTEXT);
    }
  });
});
