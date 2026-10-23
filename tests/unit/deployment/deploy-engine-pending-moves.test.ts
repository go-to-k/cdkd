/**
 * go-to-k/cdkd#5212: `cdkd deploy` refuses a stack whose record says an
 * interrupted `cdkd refactor` is moving resources out of it -- the
 * destination may already hold them, and this deploy would delete each one
 * the template no longer declares. The refusal is a field test on the record
 * the deploy already loaded: no provider call, no save.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

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

const row = () => ({
  resourceType: 'AWS::SSM::Parameter',
  physicalId: 'p',
  properties: { Value: 'x' },
  attributes: {},
  dependencies: [],
});

function makeState(patch: Partial<StackState>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: { Kept: row(), Moving: row() } as never,
    outputs: {},
    lastModified: 0,
    ...patch,
  };
}

// The template no longer declares `Moving`: an ordinary deploy would delete it.
const template: CloudFormationTemplate = {
  Resources: { Kept: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
};

describe('cdkd deploy refuses an unfinished refactor move (go-to-k/cdkd#5212)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let provider: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRefactorMarkerReadsForTest();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
      update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Kept']]),
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
      {},
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  it.each([
    ['a readable pending move', [{ from: 'Moving', toStack: 'D', toRegion: REGION, to: 'Moved', startedAt: 1 }], /Moving -> D\.Moved/],
    ['a pending-moves field it cannot read', 'torn', /a move this binary cannot read/],
  ])('refuses %s before any provider call or save', async (_label, pendingMovesOut, named) => {
    stateBackend.getState.mockResolvedValue({
      state: makeState({ pendingMovesOut: pendingMovesOut as never }),
      etag: 'etag-old',
    });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    expect(err.message).toMatch(named);
    expect(err.message).toContain(`cdkd refactor ${STACK}`);
    for (const fn of Object.values(provider)) expect(fn).not.toHaveBeenCalled();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('CONTROL: the same record with no pending move deploys and deletes the undeclared row', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });
    await expect(makeEngine().deploy(STACK, template)).resolves.toBeDefined();
    expect(provider.delete).toHaveBeenCalled();
  });

  it('refuses a move whose DESTINATION is this stack, found only in the shared refactor marker', async () => {
    // The record itself has no `pendingMovesOut` (this stack never started a
    // move out) -- but the shared marker lists a move INTO this stack from
    // another source, which this stack's own record knows nothing of.
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });
    (stateBackend as unknown as Record<string, unknown>)['refactorMarkerKey'] = () =>
      'cdkd/_refactor/pending.json';
    (stateBackend as unknown as Record<string, unknown>)['getRefactorMarker'] = vi
      .fn()
      .mockResolvedValue({
        body: {
          moves: [
            {
              fromStack: 'Src',
              fromRegion: REGION,
              from: 'X',
              toStack: STACK,
              toRegion: REGION,
              to: 'Moved',
              startedAt: 1,
            },
          ],
        },
        etag: '"e"',
      });

    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe('REFACTOR_UNFINISHED');
    for (const fn of Object.values(provider)) expect(fn).not.toHaveBeenCalled();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // Read once for this stack, beside its state read.
    expect((stateBackend as unknown as { getRefactorMarker: ReturnType<typeof vi.fn> }).getRefactorMarker).toHaveBeenCalledTimes(1);
  });
});
