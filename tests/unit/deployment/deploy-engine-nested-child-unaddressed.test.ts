/**
 * A nested child's unaddressed resources reach the PARENT engine's counters
 * (issue https://github.com/go-to-k/cdkd/issues/1989).
 *
 * `NestedStackProvider` reports the child `DeployResult`'s `deleteSkipped` /
 * `updatePartial` into a per-row slot on the nested-stack context;
 * `provisionResource` binds that slot around each row and adds what landed in
 * it to `ProvisionCounts`, which become the parent's `DeployResult`, summary
 * rows, `RunCounts.skipped` and exit code. Before the fix the child result was
 * discarded and every case below counted zero.
 *
 * The provider here is a fake that writes the slot the way the real one does,
 * so the engine side is exercised alone; the provider side is fenced in
 * `tests/unit/provisioning/nested-stack-provider.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  type NestedChildUnaddressed,
  type NestedStackProviderContext,
  getCurrentNestedStackContext,
  withNestedStackContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

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

const STACK_TYPE = 'AWS::CloudFormation::Stack';

type Counts = {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  deleteSkipped: number;
  updatePartial: number;
};

function freshCounts(): Counts {
  return { created: 0, updated: 0, deleted: 0, skipped: 0, deleteSkipped: 0, updatePartial: 0 };
}

/** Write the current row's slot the way `NestedStackProvider.runChildDeploy` does. */
function reportChild(counts: NestedChildUnaddressed): void {
  const slot = getCurrentNestedStackContext()?.childUnaddressed;
  if (slot) slot.last = counts;
}

function makeContext(): NestedStackProviderContext {
  return {
    stateBackend: {} as NestedStackProviderContext['stateBackend'],
    lockManager: {} as NestedStackProviderContext['lockManager'],
    providerRegistry: {} as NestedStackProviderContext['providerRegistry'],
    parentStackName: 'Parent',
    parentRegion: 'us-east-1',
    accountId: '123456789012',
    awsClients: {} as NestedStackProviderContext['awsClients'],
    stateBucket: 'cdkd-state-test',
  };
}

describe('DeployEngine — a nested child left resources unaddressed (#1989)', () => {
  let provider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'arn:child', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'arn:child', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
      } as unknown as never,
      {} as unknown as never,
      { getDirectDependencies: vi.fn().mockReturnValue([]) } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      {},
      'us-east-1'
    );
  }

  function provision(
    engine: InstanceType<typeof DeployEngine>,
    logicalId: string,
    change: ResourceChange,
    stateResources: Record<string, unknown>,
    counts: Counts
  ): Promise<unknown> {
    const template: CloudFormationTemplate = {
      Resources: { [logicalId]: { Type: change.resourceType, Properties: {} } },
    };
    return (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate,
          parameterValues?: Record<string, unknown>,
          conditions?: Record<string, boolean>,
          counts?: Counts
        ) => Promise<unknown>;
      }
    ).provisionResource.call(
      engine,
      logicalId,
      change,
      stateResources,
      'Parent',
      template,
      undefined,
      undefined,
      counts
    );
  }

  function createChange(logicalId = 'Child'): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: STACK_TYPE,
      desiredProperties: {},
    };
  }

  it('CREATE: the child counters are added to the parent counts beside the row itself', async () => {
    vi.mocked(provider.create).mockImplementation(async () => {
      reportChild({ deleteSkipped: 2, updatePartial: 1 });
      return { physicalId: 'arn:child', attributes: {} };
    });
    const counts = freshCounts();

    await withNestedStackContext(makeContext(), () =>
      provision(makeEngine(), 'Child', createChange(), {}, counts)
    );

    expect(counts).toEqual({ ...freshCounts(), created: 1, deleteSkipped: 2, updatePartial: 1 });
  });

  it('UPDATE: the child counters are added to the parent counts beside the row itself', async () => {
    vi.mocked(provider.update).mockImplementation(async () => {
      reportChild({ deleteSkipped: 1, updatePartial: 0 });
      return { physicalId: 'arn:child', wasReplaced: false };
    });
    const counts = freshCounts();
    const change: ResourceChange = {
      logicalId: 'Child',
      changeType: 'UPDATE',
      resourceType: STACK_TYPE,
      currentProperties: { Parameters: { A: '1' } },
      desiredProperties: { Parameters: { A: '2' } },
      propertyChanges: [
        { path: 'Parameters', oldValue: { A: '1' }, newValue: { A: '2' }, requiresReplacement: false },
      ],
    };
    const state = {
      Child: {
        physicalId: 'arn:child',
        resourceType: STACK_TYPE,
        properties: { Parameters: { A: '1' } },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };

    await withNestedStackContext(makeContext(), () =>
      provision(makeEngine(), 'Child', change, state, counts)
    );

    expect(counts.updated).toBe(1);
    expect(counts.deleteSkipped).toBe(1);
    expect(counts.updatePartial).toBe(0);
  });

  it('a row that FAILS after its child reported adds nothing', async () => {
    vi.mocked(provider.create).mockImplementation(async () => {
      reportChild({ deleteSkipped: 4, updatePartial: 4 });
      throw new Error('reading child outputs failed');
    });
    const counts = freshCounts();

    await expect(
      withNestedStackContext(makeContext(), () =>
        provision(makeEngine(), 'Child', createChange(), {}, counts)
      )
    ).rejects.toThrow(/Failed to create resource Child/);

    expect(counts).toEqual(freshCounts());
  });

  it('each row gets its own slot, even while sibling rows provision CONCURRENTLY', async () => {
    // Interleaved on purpose: ChildA is inside its body when ChildB binds its
    // slot and reports, and only then does ChildA report. A slot bound by
    // mutating the shared context (rather than a fresh ALS scope per row)
    // would hand ChildA ChildB's slot here, so ChildA's report would land in
    // ChildB's count and ChildA's would stay empty.
    let bReported!: () => void;
    const bReportedP = new Promise<void>((resolve) => (bReported = resolve));
    let aReported!: () => void;
    const aReportedP = new Promise<void>((resolve) => (aReported = resolve));
    vi.mocked(provider.create).mockImplementation(async (logicalId: string) => {
      if (logicalId === 'ChildA') {
        await bReportedP;
        reportChild({ deleteSkipped: 3, updatePartial: 0 });
        aReported();
        return { physicalId: 'arn:a', attributes: {} };
      }
      reportChild({ deleteSkipped: 0, updatePartial: 5 });
      bReported();
      await aReportedP;
      return { physicalId: 'arn:b', attributes: {} };
    });
    const countsA = freshCounts();
    const countsB = freshCounts();
    const engine = makeEngine();

    await withNestedStackContext(makeContext(), () =>
      Promise.all([
        provision(engine, 'ChildA', createChange('ChildA'), {}, countsA),
        provision(engine, 'ChildB', createChange('ChildB'), {}, countsB),
      ])
    );

    expect(countsA).toEqual({ ...freshCounts(), created: 1, deleteSkipped: 3 });
    expect(countsB).toEqual({ ...freshCounts(), created: 1, updatePartial: 5 });
  });

  it('recursion: a grandchild reaches the top through the child, counted exactly once', async () => {
    // Parent row -> child engine provisions its own nested row -> the
    // grandchild reports into the CHILD row's slot, the child engine counts
    // it, and the child's total is what reaches the parent's slot, just as
    // `runChildDeploy` reports the child's DeployResult.
    const childEngine = makeEngine();
    const childCounts = freshCounts();
    vi.mocked(provider.create)
      .mockImplementationOnce(async () => {
        // Parent row's create: runs the child "deploy" in a child context
        // without the parent's slot (as `runChildDeploy` builds it).
        const parentCtx = getCurrentNestedStackContext()!;
        await withNestedStackContext(
          { ...parentCtx, parentStackName: 'Parent~Child', childUnaddressed: undefined },
          () => provision(childEngine, 'Grandchild', createChange('Grandchild'), {}, childCounts)
        );
        reportChild({
          deleteSkipped: childCounts.deleteSkipped,
          updatePartial: childCounts.updatePartial,
        });
        return { physicalId: 'arn:child', attributes: {} };
      })
      .mockImplementationOnce(async () => {
        // Grandchild row's create: its own child left one of each.
        reportChild({ deleteSkipped: 1, updatePartial: 1 });
        return { physicalId: 'arn:grandchild', attributes: {} };
      });
    const counts = freshCounts();

    await withNestedStackContext(makeContext(), () =>
      provision(makeEngine(), 'Child', createChange(), {}, counts)
    );

    expect(childCounts).toEqual({ ...freshCounts(), created: 1, deleteSkipped: 1, updatePartial: 1 });
    expect(counts).toEqual({ ...freshCounts(), created: 1, deleteSkipped: 1, updatePartial: 1 });
  });

  it('outside any nested-stack context the row provisions and counts as before', async () => {
    const counts = freshCounts();

    await provision(makeEngine(), 'Child', createChange(), {}, counts);

    expect(getCurrentNestedStackContext()).toBeUndefined();
    expect(counts).toEqual({ ...freshCounts(), created: 1 });
  });
});
