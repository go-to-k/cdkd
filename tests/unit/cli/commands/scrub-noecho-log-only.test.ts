import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import { DynamicReferenceRegionAmbiguousError } from '../../../../src/utils/error-handler.js';
import {
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../../src/deployment/secret-redaction.js';

// go-to-k/cdkd#1998, the SCRUB half. A LOG-ONLY needle (a `NoEcho` parameter's
// value) is keyed by the bag INSTANCE, so every copy scrub makes of a bag
// before it masks — the error boundary's union, the parent's inherited bag,
// the Export.Name view — must carry it, or the printed text keeps the value.

const warnLines = vi.hoisted(() => [] as string[]);
const NOECHO = 'hunter2-noecho-password';
const RESOURCE_THROWS = '__record_then_throw_ambiguous__';
const NAME_THROWS = '__record_then_throw_name__';
const NAME_THROWS_AMBIGUOUS = '__record_then_throw_name_ambiguous__';
const RECORD_OK = '__record_then_resolve__';
const DYN_EXPR = '{{resolve:secretsmanager:app:SecretString:k::}}';
const DYN_PLAINTEXT = 'resolved-dynamic-secret';

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

// The resolver records the value as a LOG-ONLY needle (what a `Ref` to a
// `NoEcho` parameter does) and then fails quoting it.
vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/deployment/intrinsic-function-resolver.js')>();
  const { recordLogOnlyValue: record } = await import(
    '../../../../src/deployment/secret-redaction.js'
  );
  return {
    ...actual,
    IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
      resolveParameters: vi.fn().mockResolvedValue({}),
      evaluateConditions: vi.fn().mockResolvedValue({}),
      resolve: vi
        .fn()
        .mockImplementation((value: unknown, ctx: { recordedSecretValues?: RecordedSecretValues }) => {
          const walk = (v: unknown): unknown => {
            if (v === RESOURCE_THROWS) {
              if (ctx.recordedSecretValues) record(ctx.recordedSecretValues, NOECHO);
              throw new DynamicReferenceRegionAmbiguousError(`region ambiguous near ${NOECHO}`);
            }
            if (v === NAME_THROWS_AMBIGUOUS) {
              if (ctx.recordedSecretValues) record(ctx.recordedSecretValues, NOECHO);
              throw new DynamicReferenceRegionAmbiguousError(`export ${NOECHO} is ambiguous`);
            }
            if (v === DYN_EXPR) {
              ctx.recordedSecretValues?.set(DYN_PLAINTEXT, DYN_EXPR);
              return DYN_PLAINTEXT;
            }
            if (v === RECORD_OK) {
              if (ctx.recordedSecretValues) record(ctx.recordedSecretValues, NOECHO);
              return NOECHO;
            }
            if (v === NAME_THROWS) {
              if (ctx.recordedSecretValues) record(ctx.recordedSecretValues, NOECHO);
              throw new Error(`the export name ${NOECHO} is unresolvable`);
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
  };
});

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: (...args: unknown[]) => warnLines.push(args.map(String).join(' ')),
  error: vi.fn(),
} as never;

function backends(state: StackState): { stateBackend: unknown; lockManager: unknown } {
  return {
    stateBackend: {
      getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      // Read when a record has an undeclared output key to DROP
      // (go-to-k/cdkd#4120): no other stack reads it.
      listStacks: vi.fn().mockResolvedValue([]),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function stateOf(resources: StackState['resources'], outputs: StackState['outputs'] = {}): StackState {
  return { version: 9, region: 'us-east-1', stackName: 'MyStack', resources, outputs, lastModified: 0 };
}

async function caughtFrom(run: Promise<unknown>): Promise<string> {
  const caught = await run.then(
    () => null,
    (err: unknown) => err
  );
  expect(caught).not.toBeNull();
  return JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
}

beforeEach(() => {
  warnLines.length = 0;
});

describe('cdkd scrub - log-only needles cross the bag copies (go-to-k/cdkd#1998)', () => {
  it('the error boundary masks a needle a resource pass recorded', async () => {
    const template = {
      Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Value: RESOURCE_THROWS } } },
      Outputs: {},
    } as unknown as CloudFormationTemplate;
    const { stateBackend, lockManager } = backends(
      stateOf({ P: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { Value: 'x' } } })
    );
    const text = await caughtFrom(
      scrubStack(
        { stackName: 'MyStack', template } as never,
        'us-east-1',
        stateBackend as never,
        lockManager as never,
        { dryRun: false, logger }
      )
    );
    expect(text).toContain('region ambiguous');
    expect(text).not.toContain(NOECHO);
  });

  it('the error boundary masks a needle the OUTPUTS pass recorded', async () => {
    const template = {
      Resources: {},
      Outputs: { Out: { Value: RESOURCE_THROWS } },
    } as unknown as CloudFormationTemplate;
    const { stateBackend, lockManager } = backends(stateOf({}, { Out: 'v' }));
    const text = await caughtFrom(
      scrubStack(
        { stackName: 'MyStack', template } as never,
        'us-east-1',
        stateBackend as never,
        lockManager as never,
        { dryRun: false, logger }
      )
    );
    expect(text).toContain('region ambiguous');
    expect(text).not.toContain(NOECHO);
  });

  it("a nested child masks with a parent bag holding ONLY log-only needles", async () => {
    // The child's own resolution records nothing and fails quoting the
    // value, so only the parent's inherited bag can mask it.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const template = {
      Resources: {
        P: { Type: 'AWS::SSM::Parameter', Properties: { Value: '__plain_then_throw__' } },
      },
      Outputs: {},
    } as unknown as CloudFormationTemplate;
    const { stateBackend, lockManager } = backends(
      stateOf({ P: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { Value: 'x' } } })
    );
    const { IntrinsicFunctionResolver } = await import(
      '../../../../src/deployment/intrinsic-function-resolver.js'
    );
    vi.mocked(IntrinsicFunctionResolver).mockImplementationOnce(
      () =>
        ({
          resolveParameters: vi.fn().mockResolvedValue({}),
          evaluateConditions: vi.fn().mockResolvedValue({}),
          resolve: vi.fn().mockRejectedValue(
            new DynamicReferenceRegionAmbiguousError(`region ambiguous near ${NOECHO}`)
          ),
        }) as never
    );
    const text = await caughtFrom(
      scrubStack(
        { stackName: 'MyStack~Child', template } as never,
        'us-east-1',
        stateBackend as never,
        lockManager as never,
        {
          dryRun: false,
          logger,
          nestedChild: {
            logicalId: 'Child',
            stackName: 'MyStack~Child',
            input: { parameters: {}, inheritedSecrets: inherited },
          },
        } as never
      )
    );
    expect(text).toContain('region ambiguous');
    expect(text).not.toContain(NOECHO);
  });

  it('the Export.Name warning masks a needle the name view recorded', async () => {
    const template = {
      Resources: {},
      Outputs: { Out: { Value: 'v', Export: { Name: { 'Fn::Join': ['', [NAME_THROWS]] } } } },
    } as unknown as CloudFormationTemplate;
    const { stateBackend, lockManager } = backends(stateOf({}, { Out: 'v' }));
    await scrubStack(
      { stackName: 'MyStack', template } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );
    const lines = warnLines.join('\n');
    expect(lines).toContain('unresolvable');
    expect(lines).not.toContain(NOECHO);
  });

  it('the error boundary masks a needle an Export.Name resolution recorded before it RETHREW', async () => {
    // The re-thrown region refusal leaves the name block at once, so only a
    // side set SHARED at the view's creation reaches the boundary.
    const template = {
      Resources: {},
      Outputs: {
        Out: { Value: 'v', Export: { Name: { 'Fn::Join': ['', [NAME_THROWS_AMBIGUOUS]] } } },
      },
    } as unknown as CloudFormationTemplate;
    const { stateBackend, lockManager } = backends(stateOf({}, { Out: 'v' }));
    const text = await caughtFrom(
      scrubStack(
        { stackName: 'MyStack', template } as never,
        'us-east-1',
        stateBackend as never,
        lockManager as never,
        { dryRun: false, logger }
      )
    );
    expect(text).toContain('is ambiguous');
    expect(text).not.toContain(NOECHO);
  });
});

describe('cdkd scrub - log-only needles change nothing scrub WRITES (go-to-k/cdkd#1998)', () => {
  it('leaves a record holding the value byte-identical: no save, whatever the needles', async () => {
    const template = {
      // `Tier` records a real map entry: with none, scrub returns before it
      // builds the union at all, and the case would read nothing.
      Resources: {
        P: { Type: 'AWS::SSM::Parameter', Properties: { Value: RECORD_OK, Tier: DYN_EXPR } },
      },
      // An `Export.Name` the record holds no key for: every export alias is
      // then NOT reproduced, so the undeclared keys below may be a live alias
      // and are KEPT rather than dropped (go-to-k/cdkd#4120) — which keeps them
      // in reach of the union this case is about.
      Outputs: { Out: { Value: RECORD_OK, Export: { Name: 'Out-export' } } },
    } as unknown as CloudFormationTemplate;
    const state = stateOf(
      {
        P: {
          physicalId: 'p',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: NOECHO, Tier: DYN_EXPR },
        },
      },
      // `Stale` is a key today's template does not declare: scrub repairs it
      // by VALUE against the cross-resource union, the one reader of that
      // union that writes.
      { Out: NOECHO, Stale: NOECHO, StaleEmbedded: `stale-${NOECHO}` }
    );
    const before = JSON.stringify(state);
    const { stateBackend, lockManager } = backends(state);
    await scrubStack(
      { stackName: 'MyStack', template } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger }
    );
    const save = (stateBackend as { saveState: ReturnType<typeof vi.fn> }).saveState;
    for (const call of save.mock.calls) {
      expect(JSON.stringify(call[2])).toBe(before);
    }
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("cdkd scrub - the export-index repair lines' name display masks a log-only needle (go-to-k/cdkd#4049)", () => {
  // `exportNameDisplay` feeds only the printed index-repair lines; the
  // secret-bearing KEY scan (`--dry-run --fail`) is a separate, map-only call.
  it.each([
    ['with a recorded map entry', { Value: RECORD_OK, Tier: DYN_EXPR }],
    ['with log-only needles only', { Value: RECORD_OK }],
  ])('masks a NoEcho-bearing export name %s', async (_label, props) => {
    const template = {
      Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: props } },
      Outputs: { Out: { Value: RECORD_OK } },
    } as unknown as CloudFormationTemplate;
    const state = stateOf(
      { P: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { ...props } } },
      // A KEY carrying the value: the map-only key scan must still not count it.
      { Out: NOECHO, [`exp-${NOECHO}`]: 'v' }
    );
    // Recorded as NOT an export, so a scrub that drops the undeclared key
    // does not also WITHHOLD its alias-shaped name (go-to-k/cdkd#4120) and the
    // masking under test stays observable.
    state.exportNames = [];
    const { stateBackend, lockManager } = backends(state);
    const result = (await scrubStack(
      { stackName: 'MyStack', template } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: true, logger }
    )) as { exportNameDisplay: (name: string) => unknown; secretBearingKeys: number };
    expect(result.exportNameDisplay(`exp-${NOECHO}`)).toEqual({
      kind: 'masked',
      text: 'exp-***',
    });
    expect(result.exportNameDisplay('plain-export')).toEqual({ kind: 'safe', text: 'plain-export' });
    expect(result.secretBearingKeys).toBe(0);
  });
});
