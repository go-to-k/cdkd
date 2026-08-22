/**
 * Issue #2171: `DeployEngine.deploy` called `renderer.start()` AFTER acquiring
 * the stack lock but OUTSIDE the `try` whose `finally` releases it.
 *
 * `start()` writes to stdout, so `cdkd deploy | head` can EPIPE there — and the
 * throw then escaped past the release, stranding the lock for its full 30-minute
 * TTL. Issue #2161 fixed exactly this shape in `destroy-runner.ts`; the two
 * commands had the identical defect and only one of them was repaired, which is
 * why this fence lives next to the one over there rather than being folded into
 * a generic "deploy handles errors" test.
 *
 * The discriminator is `releaseLock`: under the fix a throwing `start()` still
 * releases, and reverting the move (hoisting the call back above the `try`)
 * turns that assertion red.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => renderer,
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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine — renderer.start() cannot strand the lock (issue #2171)', () => {
  const stackName = 'renderer-strand-stack';

  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };
  let mockExportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'ParamA',
            { logicalId: 'ParamA', changeType: 'NO_CHANGE', resourceType: 'AWS::SSM::Parameter' },
          ],
        ])
      ),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn(),
      getProviderFor: vi.fn(),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    mockExportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeState(): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        ParamA: {
          physicalId: 'phys-param-a',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'x' },
          observedProperties: { Value: 'x' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1',
      mockExportIndexStore as never
    );
  }

  it('releases the lock when renderer.start() throws (EPIPE)', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: makeState(), etag: 'etag-old' });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    renderer.start.mockImplementationOnce(() => {
      throw epipe;
    });

    const engine = makeEngine();

    await expect(engine.deploy(stackName, template)).rejects.toThrow('write EPIPE');

    // The lock WAS taken, so leaving it behind is a 30-minute stranded lock.
    expect(mockLockManager.acquireLockWithRetry).toHaveBeenCalled();
    expect(mockLockManager.releaseLock).toHaveBeenCalledWith(stackName, 'us-east-1');
  });

  it('still starts the renderer and releases the lock on the ordinary path', async () => {
    // Non-vacuity: the fence above must not pass merely because the deploy
    // never reaches `start()` in this harness.
    mockStateBackend.getState.mockResolvedValue({ state: makeState(), etag: 'etag-old' });

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(renderer.start).toHaveBeenCalled();
    expect(mockLockManager.releaseLock).toHaveBeenCalledWith(stackName, 'us-east-1');
  });
});
