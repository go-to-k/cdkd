/**
 * Issue #1111 items 2 + 3 (engine side):
 *
 * - `--strict-getatt` makes an Output resolution failure fail the deploy;
 *   default mode keeps the warn-and-continue behavior (`outputs[key] =
 *   undefined`, dropped from the display outputs).
 * - The engine threads `strictGetAtt` into its resolver, resets the
 *   per-run fallback counter at the start of each deploy, and surfaces the
 *   count as `DeployResult.attributeFallbackCount`.
 *
 * The resolver is mocked (pass-through except a `__boom__` sentinel that
 * throws) so the tests exercise the ENGINE's catch/rethrow + counter
 * plumbing, not the resolver's own guard (covered in
 * intrinsic-getatt-fallback-guard.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// Mutable per-test knobs for the mocked resolver.
const fallbackCountHolder: { value: number } = { value: 0 };
const resetSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockImplementation(() => fallbackCountHolder.value),
    resetPhysicalIdFallbackCount: resetSpy,
    resolve: vi.fn().mockImplementation((value: unknown) => {
      if (value === '__boom__') {
        return Promise.reject(new Error('cannot construct attribute'));
      }
      return Promise.resolve(value);
    }),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - --strict-getatt output failures + fallback counter (#1111)', () => {
  const stackName = 'strict-getatt-stack';

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  };
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

  beforeEach(() => {
    vi.clearAllMocks();
    fallbackCountHolder.value = 0;

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
      getState: vi.fn().mockResolvedValue({ state: makeState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
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
    Resources: {
      ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
    },
    Outputs: {
      Good: { Value: 'ok-value' },
      Bad: { Value: '__boom__' },
    },
  };

  function makeEngine(strictGetAtt?: boolean) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...(strictGetAtt !== undefined && { strictGetAtt }) },
      'us-east-1'
    );
  }

  it('default mode: an unresolvable Output warns and is skipped, deploy succeeds', async () => {
    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve output Bad'));
    // No-change path: a resolution failure keeps the previously persisted
    // outputs (empty here) instead of persisting a partial map — the deploy
    // still exits successfully in default mode.
    expect(result.outputs).toEqual({});
  });

  it('strict mode: an unresolvable Output fails the deploy with an actionable error', async () => {
    const engine = makeEngine(true);
    await expect(engine.deploy(stackName, template)).rejects.toThrow(
      /Failed to resolve output Bad: cannot construct attribute.*--strict-getatt/s
    );
  });

  it('threads strictGetAtt into the resolver constructor', () => {
    makeEngine(true);
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenCalledWith('us-east-1', {
      strictGetAtt: true,
    });
    makeEngine();
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenLastCalledWith('us-east-1', {
      strictGetAtt: false,
    });
  });

  it('resets the fallback counter at deploy start and surfaces it in the result', async () => {
    fallbackCountHolder.value = 3;
    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(result.attributeFallbackCount).toBe(3);
  });

  it('reports zero fallbacks when none occurred', async () => {
    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.attributeFallbackCount).toBe(0);
  });
});
