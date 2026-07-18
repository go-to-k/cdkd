import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Logger silenced — keep test output clean.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Guard for the in-place-update attribute invariant (surfaced live by the
 * FSx integ, PR #1063): when a provider's `update()` returns NO
 * `attributes`, the deploy engine must carry the previously-stored
 * (create-time) attributes forward — an in-place update never invalidates
 * them, and dropping them degrades every later `Fn::GetAtt` on the
 * resource to the physical-id fallback (the FSx stack's `LustreMountName`
 * output regressed to the file-system id).
 *
 * Three pinned behaviors:
 *  1. update result WITHOUT attributes + in-place → previous attributes kept
 *  2. update result WITH attributes → the fresh set wins verbatim
 *  3. replaced resource (wasReplaced: true) without attributes → attributes
 *     absent (the old resource's attributes must NOT leak onto its
 *     replacement)
 */
describe('DeployEngine - in-place update carries previous attributes forward', () => {
  const stackName = 'update-attr-carry-stack';
  const PREV_ATTRS = {
    DNSName: 'fs-1.fsx.us-east-1.amazonaws.com',
    LustreMountName: 'abcdef',
  };

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
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

  const priorState: StackState = {
    version: 8,
    stackName,
    region: 'us-east-1',
    resources: {
      MyResource: {
        physicalId: 'fs-1',
        resourceType: 'AWS::FSx::FileSystem',
        properties: { StorageCapacity: 1200 },
        attributes: { ...PREV_ATTRS },
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['MyResource']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) => {
          return Array.from(changes.values()).filter((c) => c.changeType === type);
        }),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: structuredClone(priorState),
        etag: 'etag-1',
      }),
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

  function updateChange(): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'MyResource',
        {
          logicalId: 'MyResource',
          changeType: 'UPDATE',
          resourceType: 'AWS::FSx::FileSystem',
          desiredProperties: { StorageCapacity: 2400 },
          currentProperties: { StorageCapacity: 1200 },
        },
      ],
    ]);
  }

  const template: CloudFormationTemplate = {
    Resources: {
      MyResource: {
        Type: 'AWS::FSx::FileSystem',
        Properties: { StorageCapacity: 2400 },
      },
    },
  };

  function savedRecord() {
    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    return savedState.resources['MyResource']!;
  }

  it('keeps the create-time attributes when update() returns none (in place)', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(updateChange());
    mockProvider.update.mockResolvedValue({ physicalId: 'fs-1', wasReplaced: false });

    const result = await makeEngine().deploy(stackName, template);
    expect(result.updated).toBe(1);
    expect(savedRecord().attributes).toEqual(PREV_ATTRS);
  });

  it('prefers the update result attributes when the provider returns a fresh set', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(updateChange());
    mockProvider.update.mockResolvedValue({
      physicalId: 'fs-1',
      wasReplaced: false,
      attributes: { DNSName: 'fs-1.new.example.com' },
    });

    await makeEngine().deploy(stackName, template);
    expect(savedRecord().attributes).toEqual({ DNSName: 'fs-1.new.example.com' });
  });

  it('does NOT carry the old attributes onto a replacement without attributes', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(updateChange());
    mockProvider.update.mockResolvedValue({ physicalId: 'fs-2', wasReplaced: true });

    await makeEngine().deploy(stackName, template);
    const record = savedRecord();
    expect(record.physicalId).toBe('fs-2');
    expect(record.attributes).toBeUndefined();
  });
});
