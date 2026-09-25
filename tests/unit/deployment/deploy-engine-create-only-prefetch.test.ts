/**
 * Part of #1180 (deploy-overhead reduction). doDeploy fires a fire-and-forget
 * prefetch of each distinct template resource type's create-only property paths
 * (`prefetchCreateOnlyPropertyPaths`, backed by cloudformation:DescribeType,
 * ~0.8s cold per type, module-cached for the deploy lifetime) at the very start
 * of the deploy — in parallel with the lock acquisition + state read — so that
 * the later diff's per-resource create-only lookups hit a warm cache instead of
 * paying the round-trip inline on the critical path.
 *
 * These tests pin the WIRING of that prefetch: the types it is handed (each
 * distinct type once, no schema-less type), and that the deploy does not wait
 * on it. The prefetch's own cap, priority and no-unhandled-rejection
 * guarantees (issue #3718) are pinned in
 * `tests/unit/provisioning/create-only-properties.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const prefetchCreateOnlyPropertyPaths = vi.fn<(types: Iterable<string>) => void>();
const prefetchCancel = vi.fn();

vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    prefetchCreateOnlyPropertyPaths: (types: Iterable<string>) => {
      prefetchCreateOnlyPropertyPaths([...types]);
      return { cancel: prefetchCancel };
    },
    createOnlyChangeRequiresReplacement: vi.fn().mockReturnValue(false),
  };
});

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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

describe('DeployEngine - create-only DescribeType prefetch (#1180)', () => {
  const stackName = 'prefetch-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
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

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi
        .fn()
        .mockImplementation((logicalId: string) =>
          Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
        ),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['A', 'B', 'C']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: {
      A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'a' } },
      B: { Type: 'AWS::SQS::Queue', Properties: {} },
      // Duplicate type — must NOT trigger a second prefetch for AWS::SSM::Parameter.
      C: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'c' } },
    },
  };

  function makeCreateDiff(): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>(
      Object.entries(template.Resources).map(([id, res]) => [
        id,
        {
          logicalId: id,
          changeType: 'CREATE',
          resourceType: res.Type,
          desiredProperties: res.Properties,
        },
      ])
    );
  }

  const prefetchedTypes = (): string[] =>
    prefetchCreateOnlyPropertyPaths.mock.calls.flatMap(([types]) => [...types]);

  it('prefetches once per DISTINCT resource type', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(makeCreateDiff());

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    // Two distinct types (AWS::SSM::Parameter appears twice), one prefetch call.
    expect(prefetchCreateOnlyPropertyPaths).toHaveBeenCalledTimes(1);
    expect(prefetchedTypes().sort()).toEqual(['AWS::SQS::Queue', 'AWS::SSM::Parameter']);
  });

  it('never prefetches schema-less types (AWS::CDK::Metadata / custom resources)', async () => {
    // `AWS::CDK::Metadata` is the CDK construct-tree sentinel present in EVERY
    // synthesized template, and custom resources have no registry schema
    // either, so DescribeType can only fail for them. Before the exclusion,
    // every deploy burned a guaranteed-to-fail API call on the sentinel AND
    // printed a "Grant cloudformation:DescribeType ..." warning naming a
    // pseudo-resource the user cannot act on.
    const withMetadata: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'a' } },
        CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v2:xxx' } },
        Custom: { Type: 'Custom::MyThing', Properties: { ServiceToken: 'arn:aws:lambda:::fn' } },
        Generic: {
          Type: 'AWS::CloudFormation::CustomResource',
          Properties: { ServiceToken: 'arn:aws:lambda:::fn' },
        },
      },
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'A',
          {
            logicalId: 'A',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: { Value: 'a' },
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['A']]);

    const engine = makeEngine();
    await engine.deploy(stackName, withMetadata);

    expect(prefetchedTypes()).toEqual(['AWS::SSM::Parameter']);
  });

  it('starts the prefetch BEFORE the lock, and does not wait on it', async () => {
    // Latency-hiding only works if the lookups overlap the lock + state read.
    const order: string[] = [];
    prefetchCreateOnlyPropertyPaths.mockImplementation(() => {
      order.push('prefetch');
    });
    mockLockManager.acquireLockWithRetry.mockImplementation(() => {
      order.push('lock');
      return Promise.resolve(true);
    });
    mockDiffCalculator.calculateDiff.mockResolvedValue(makeCreateDiff());

    const engine = makeEngine();
    await expect(engine.deploy(stackName, template)).resolves.toBeDefined();
    expect(order.slice(0, 2)).toEqual(['prefetch', 'lock']);
  });

  it('cancels its prefetch once the diff is computed, before any resource is provisioned (issue #3718)', async () => {
    // The diff is the prefetch's only consumer; an unneeded background lookup
    // must neither spend the quota the deploy's own lookups need nor hold the
    // process open after the deploy.
    const order: string[] = [];
    prefetchCancel.mockImplementation(() => order.push('cancel'));
    mockDiffCalculator.calculateDiff.mockImplementation(() => {
      order.push('diff');
      return Promise.resolve(makeCreateDiff());
    });
    mockProvider.create.mockImplementation((logicalId: string) => {
      order.push('create');
      return Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
    });

    await makeEngine().deploy(stackName, template);

    expect(order.indexOf('cancel')).toBe(order.indexOf('diff') + 1);
    expect(order.indexOf('cancel')).toBeLessThan(order.indexOf('create'));
  });

  it('cancels its prefetch when the deploy FAILS before the diff (issue #3718)', async () => {
    mockLockManager.acquireLockWithRetry.mockRejectedValue(new Error('lock boom'));

    await expect(makeEngine().deploy(stackName, template)).rejects.toThrow();

    expect(prefetchCreateOnlyPropertyPaths).toHaveBeenCalledTimes(1);
    expect(prefetchCancel).toHaveBeenCalled();
  });
});
