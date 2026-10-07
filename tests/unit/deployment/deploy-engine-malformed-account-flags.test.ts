/**
 * Issue go-to-k/cdkd#4159, the deploy engine half: each malformed-record
 * refusal at `DeployEngine`'s state load prints its `cdkd state show` pointer
 * with the run's account flags, taken from `DeployEngineOptions.refusalRecovery`
 * — so a pasted command reads the bucket the deploy read. With no context the
 * command is the unqualified one.
 *
 * `DiffCalculator.calculateDiff`'s own two refusals take the same context as a
 * trailing argument. The engine's load dominates them on a deploy, so they are
 * driven directly.
 *
 * The builders' handling of the context (holes, reasons, the paste harness) is
 * pinned in `tests/unit/state/malformed-account-flags.test.ts`; this file pins
 * that each engine site HANDS it over.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../../src/state/lock-contention-message.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

/** `calculateDiff`'s `refusalRecovery` position (a NoEcho comparison follows it, go-to-k/cdkd#4043). */
const REFUSAL_RECOVERY_ARG = 9;

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'S';
const REGION = 'us-east-1';
const RECOVERY: LockRecoveryContext = {
  profile: 'prod',
  stateBucket: 'my-bucket',
  statePrefix: 'team-a',
};
const FLAGS = '--profile prod --state-bucket my-bucket --state-prefix team-a';
const SHOW = `cdkd state show ${STACK} --stack-region ${REGION} --json`;

const row = (extra: Record<string, unknown> = {}) => ({
  resourceType: 'AWS::SSM::Parameter',
  physicalId: 'p',
  properties: { Value: 'x' },
  attributes: {},
  dependencies: [],
  ...extra,
});

/** One record per load refusal, each malformed in exactly the container it names. */
const LOAD_REFUSALS: Array<[string, Partial<StackState>]> = [
  ['the outputs bag (refuseMalformedOutputs)', { outputs: 'abc' as never }],
  ['the resources bag (refuseMalformedResourcesForDeploy)', { resources: 5 as never }],
  ['a resource row (refuseMalformedResourceEntriesForDeploy)', { resources: { R: null } as never }],
  [
    "a row's properties map (refuseMalformedResourceProperties)",
    { resources: { R: row({ properties: 'x' }) } as never },
  ],
  ['the orphans container (refuseMalformedOrphans)', { orphans: 'x' as never }],
  ['an orphan row (refuseMalformedOrphanRecords)', { orphans: [null] as never }],
];

function makeState(patch: Partial<StackState>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: { R: row() } as never,
    outputs: {},
    lastModified: 0,
    ...patch,
  };
}

const template: CloudFormationTemplate = {
  Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
};

describe('DeployEngine load refusals carry DeployEngineOptions.refusalRecovery (go-to-k/cdkd#4159)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
  });

  function makeEngine(refusalRecovery?: LockRecoveryContext): DeployEngine {
    const provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
      update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['R']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        reportSilentDropDecisions: vi.fn(),
        getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
      } as never,
      { ...(refusalRecovery && { refusalRecovery }) },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  async function refusal(
    patch: Partial<StackState>,
    refusalRecovery?: LockRecoveryContext
  ): Promise<CdkdError> {
    stateBackend.getState.mockResolvedValue({ state: makeState(patch), etag: 'etag-old' });
    const err = (await makeEngine(refusalRecovery)
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    return err;
  }

  for (const [label, patch] of LOAD_REFUSALS) {
    it(`${label}: the inspect command carries the account flags`, async () => {
      const err = await refusal(patch, RECOVERY);
      expect(err.message).toContain(`${SHOW} ${FLAGS}`);
    });

    it(`${label}: CONTROL — with no context the command carries no account flag`, async () => {
      const err = await refusal(patch);
      expect(err.message).toContain(SHOW);
      expect(err.message).not.toContain('--state-bucket');
      expect(err.message).not.toContain('--profile');
    });
  }

  it('the healthy record deploys: the cases above refuse over their defect, not the harness', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });
    // The load refusals dominate `calculateDiff`'s own, so its hand-over is
    // pinned on the call's argument.
    const spy = vi.spyOn(DiffCalculator.prototype, 'calculateDiff');
    await expect(makeEngine(RECOVERY).deploy(STACK, template)).resolves.toBeDefined();
    expect(spy.mock.calls.at(-1)?.[REFUSAL_RECOVERY_ARG]).toBe(RECOVERY);
    spy.mockRestore();
  });
});

describe("DiffCalculator.calculateDiff's refusals take the same context (go-to-k/cdkd#4159)", () => {
  // No identity rides here (the record's own fields are untrusted), so the
  // command is the template; the account flags are trusted and DO ride.
  const TEMPLATE_SHOW = `cdkd state show '<stack>' --stack-region '<region>' --json`;
  const CASES: Array<[string, Partial<StackState>]> = [
    ['a resource row', { resources: { R: null } as never }],
    ["a row's properties map", { resources: { R: row({ properties: 'x' }) } as never }],
  ];

  const diff = (patch: Partial<StackState>, rec?: LockRecoveryContext): Promise<unknown> =>
    new DiffCalculator()
      .calculateDiff(
        makeState(patch),
        template,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        rec
      )
      .catch((e: unknown) => e);

  for (const [label, patch] of CASES) {
    it(`${label}: both polarities`, async () => {
      const flagged = (await diff(patch, RECOVERY)) as CdkdError;
      expect(flagged).toBeInstanceOf(CdkdError);
      expect(flagged.message).toContain(`${TEMPLATE_SHOW} ${FLAGS}`);
      const bare = (await diff(patch)) as CdkdError;
      expect(bare).toBeInstanceOf(CdkdError);
      expect(bare.message).toContain(TEMPLATE_SHOW);
      expect(bare.message).not.toContain('--state-bucket');
    });
  }
});
