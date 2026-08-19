/**
 * `provisionResource`-level coverage of the partial-UPDATE branch (issue
 * [#1819](https://github.com/go-to-k/cdkd/issues/1819)), the UPDATE-side twin
 * of `deploy-engine-delete-skipped.test.ts`.
 *
 * The distinction these cases exist to pin, because getting it wrong is the
 * easy mistake: a `'partial'` update is NOT a skipped row. The resource WAS
 * updated, so it still counts as an operation that happened and still gets
 * `RESOURCE_SUCCEEDED`. The `RESOURCE_SKIPPED` emitted alongside it names the
 * SURVIVOR the update failed to retire — the only reading under which that
 * event's documented invariant ("the resource this row names was not
 * destroyed") stays true. Issue #1922 originally proposed emitting only the
 * skip, for the row, which would have put the events store at odds with its
 * own contract.
 *
 * Every case carries the clean-update control, so none can pass vacuously:
 * `updatePartial: 1` only means something next to an `updated: 1` that stays
 * out of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

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

const TYPE = 'AWS::AppSync::Resolver';
const PARTIAL_REASON = 'old certificate arn:aws:acm:us-east-1:1:certificate/old is still in use';

type CountsBag = {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  deleteSkipped: number;
  updatePartial: number;
};

const freshCounts = (): CountsBag => ({
  created: 0,
  updated: 0,
  deleted: 0,
  skipped: 0,
  deleteSkipped: 0,
  updatePartial: 0,
});

describe('DeployEngine — a provider-reported partial update (#1819)', () => {
  let provider: ResourceProvider;
  let events: DeploymentEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'old-pid', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(recordEvents = false): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as unknown as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as unknown as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as unknown as never,
      registry as unknown as never,
      recordEvents
        ? {
            eventRecorder: {
              runId: 'run-1',
              record: (event: Omit<DeploymentEvent, 'timestamp'>) =>
                events.push(event as DeploymentEvent),
            },
          }
        : {},
      'us-east-1'
    );
  }

  async function inPlaceUpdate(
    engine: InstanceType<typeof DeployEngine>,
    counts: CountsBag
  ): Promise<void> {
    const change: ResourceChange = {
      logicalId: 'MyResource',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Mode: 'a' },
      desiredProperties: { Mode: 'b' },
      propertyChanges: [
        { path: 'Mode', oldValue: 'a', newValue: 'b', requiresReplacement: false },
      ],
    };
    const template: CloudFormationTemplate = {
      Resources: { MyResource: { Type: TYPE, Properties: { Mode: 'b' } } },
    };
    await (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate,
          parameterValues?: Record<string, unknown>,
          conditions?: Record<string, boolean>,
          counts?: CountsBag
        ) => Promise<unknown>;
      }
    ).provisionResource.bind(engine)(
      'MyResource',
      change,
      {
        MyResource: {
          physicalId: 'old-pid',
          resourceType: TYPE,
          properties: { Mode: 'a' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      },
      'MyStack',
      template,
      undefined,
      undefined,
      counts
    );
  }

  const partialResult = {
    physicalId: 'old-pid',
    wasReplaced: false,
    outcome: 'partial',
    reason: PARTIAL_REASON,
  };

  it('counts a partial apart from a clean update', async () => {
    provider.update = vi.fn().mockResolvedValue(partialResult);
    const counts = freshCounts();
    await inPlaceUpdate(makeEngine(), counts);

    expect(counts.updatePartial).toBe(1);
    // NOT also a clean update: the summary must distinguish a run that
    // orphaned something from one that did not.
    expect(counts.updated).toBe(0);
    // NOT folded into the delete-side counter, whose meaning is different.
    expect(counts.deleteSkipped).toBe(0);
  });

  it('counts a clean update as updated, with no partial', async () => {
    const counts = freshCounts();
    await inPlaceUpdate(makeEngine(), counts);

    expect(counts.updated).toBe(1);
    expect(counts.updatePartial).toBe(0);
  });

  it('emits RESOURCE_SUCCEEDED for the row AND RESOURCE_SKIPPED for the survivor', async () => {
    provider.update = vi.fn().mockResolvedValue(partialResult);
    await inPlaceUpdate(makeEngine(true), freshCounts());

    const types = events.map((e) => e.eventType);
    // The row's resource really was updated — suppressing this the way a
    // skipped DELETE does would under-report the run in the other direction.
    expect(types).toContain('RESOURCE_SUCCEEDED');
    expect(types).toContain('RESOURCE_SKIPPED');

    // The reason is the whole point of the durable record: it carries the
    // identity of the resource that survived, which state no longer holds.
    const skip = events.find((e) => e.eventType === 'RESOURCE_SKIPPED');
    expect(skip?.reason).toBe(PARTIAL_REASON);
    // ...and the id rides as a FIELD, which is the half the integ structurally
    // cannot check: `cdkd events` does not render `physicalId`, so its grep
    // matches the reason text and would pass with this deleted. It must be the
    // OLD id -- the state record now points at the replacement.
    expect((skip as { physicalId?: string } | undefined)?.physicalId).toBe('old-pid');
  });

  it('emits no RESOURCE_SKIPPED for a clean update', async () => {
    await inPlaceUpdate(makeEngine(true), freshCounts());
    expect(events.map((e) => e.eventType)).not.toContain('RESOURCE_SKIPPED');
  });

  it('reports the reason on the status line instead of a bare "updated"', async () => {
    provider.update = vi.fn().mockResolvedValue(partialResult);
    await inPlaceUpdate(makeEngine(), freshCounts());

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('partial (');
    expect(warned).toContain(PARTIAL_REASON);
    // Not the destroy path's word for its own rows: this row was not skipped,
    // and saying so would contradict RESOURCE_SKIPPED's invariant.
    expect(warned).not.toContain('skipped (');
  });
});
