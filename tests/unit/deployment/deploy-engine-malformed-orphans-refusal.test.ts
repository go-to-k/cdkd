/**
 * Issue go-to-k/cdkd#3379, deploy half — the `orphans` CONTAINER, not the
 * `resources` bag its sibling `deploy-engine-malformed-resources-refusal.test.ts`
 * covers and not the per-entry `properties` map covered one file over.
 *
 * The engine's adoption pass reads the container on a bare `?? []` and then
 * ASSIGNS `currentState.orphans` from what it read, so this is a WRITER: an
 * unreadable container is rewritten rather than reported. The guard sits beside
 * the `resources` refusal at the engine's state load, which is AFTER the lock —
 * so the guarantee the case drives is "before any resource operation", and a
 * refusal that stranded the lock would break the refusal's own sentence.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import {
  STATE_RESOURCES_MALFORMED,
  repairMalformedResourcesForReadOnly,
} from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

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
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

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

const STACK = 'malformed-resources-stack';
const REGION = 'us-east-1';


describe('DeployEngine refuses an unreadable orphans container (go-to-k/cdkd#3379)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let exportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };
  let provisioned: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    provisioned = [];
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    exportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  const dagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue([['ParamA']]),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };

  function makeProviderRegistry() {
    const provider = {
      create: vi.fn().mockImplementation(() => {
        provisioned.push('create');
        return Promise.resolve({ physicalId: 'p' });
      }),
      update: vi.fn().mockImplementation(() => {
        provisioned.push('update');
        return Promise.resolve({ physicalId: 'p' });
      }),
      delete: vi.fn().mockImplementation(() => {
        provisioned.push('delete');
        return Promise.resolve();
      }),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
    return {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      reportSilentDropDecisions: vi.fn(),
      getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
    };
  }

  function makeState(orphans: unknown): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {},
      outputs: {},
      orphans: orphans as StackState['orphans'],
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      new DiffCalculator(),
      makeProviderRegistry() as never,
      {},
      REGION,
      exportIndexStore as never
    );
  }

  const MALFORMED: Array<[string, unknown]> = [
    ['a number container', 5],
    ['a plain object container', {}],
    ['an object carrying length', { length: 1 }],
    ['a string container', 'abc'],
    ['a null container', null],
  ];

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label}, provisioning nothing and writing nothing`, async () => {
      stateBackend.getState.mockResolvedValue({ state: makeState(orphans), etag: 'etag-old' });
      const err = (await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e)) as CdkdError;

      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      // The CONTAINER by name: the `resources` bag here is a perfectly readable
      // `{}`, so a refusal naming it would be the wrong text.
      expect(err.message).toContain("'orphans'");
      expect(
        provisioned,
        'the deploy called a provider before refusing, so the guarantee is not "before any ' +
          'resource operation"'
      ).toEqual([]);
      expect(
        stateBackend.saveState,
        'the deploy wrote the record before refusing, so the adoption pass laundered the ' +
          'damaged container'
      ).not.toHaveBeenCalled();
      // The lock IS held by this point, so the refusal must not strand it.
      expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  it('marks the refusal non-retryable — a nested child deploy runs inside a withRetry', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState('abc'), etag: 'etag-old' });
    const err = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('CONTROL: a readable or absent container deploys, so the guard is not a blanket refusal', async () => {
    for (const orphans of [[], undefined]) {
      vi.clearAllMocks();
      provisioned = [];
      stateBackend.getState.mockResolvedValue({ state: makeState(orphans), etag: 'etag-old' });
      const err = await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e);
      const message = err instanceof CdkdError ? err.message : '';
      expect(message).not.toContain("'orphans'");
      expect(provisioned, 'the control deployed nothing, so it proves nothing').toEqual(['create']);
    }
  });
});
