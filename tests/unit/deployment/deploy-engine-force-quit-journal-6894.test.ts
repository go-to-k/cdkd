/**
 * go-to-k/cdkd#6894: `executeDeployment` registers a force-quit flusher while
 * its operations run. A force-quit mid-deploy writes ONE `interrupted` segment
 * holding the operations completed so far plus the in-flight ones as FAILED
 * operations, and the engine's own path then writes no second one. A run that
 * settles on its own leaves nothing registered and makes no extra call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DagExecutor } from '../../../src/deployment/dag-executor.js';
import {
  registeredForceQuitFlushCount,
  startForceQuitFlushes,
} from '../../../src/deployment/force-quit-journal.js';
import { inFlightOperationsAsFailed } from '../../../src/deployment/deploy-engine/execute/force-quit-flush.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const TYPE = 'AWS::AppSync::Resolver';
const STACK = 'force-quit-journal-test';
const FAST = 'Fast';
const SLOW = 'Slow';

function createChange(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType: TYPE,
    desiredProperties: {},
    propertyChanges: [],
  } as unknown as ResourceChange;
}

function record(logicalId: string): ResourceState {
  return {
    physicalId: `phys-${logicalId}`,
    resourceType: TYPE,
    properties: { Name: logicalId },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
  };
}

describe('executeDeployment force-quit flusher (go-to-k/cdkd#6894)', () => {
  let appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  let saveState: ReturnType<typeof vi.fn>;
  let releaseSlow: (() => void) | undefined;
  let slowFails: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    void startForceQuitFlushes().done; // nothing left over from another case
    releaseSlow = undefined;
    slowFails = false;
  });

  /** Two CREATEs with no dependency: FAST returns at once, SLOW waits for `releaseSlow`. */
  function buildEngine(): DeployEngine {
    const provider = {
      create: vi.fn().mockImplementation((logicalId: string) => {
        if (logicalId !== SLOW) {
          return Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
        }
        return new Promise((resolve, reject) => {
          releaseSlow = () =>
            slowFails
              ? reject(new Error('slow create failed'))
              : resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
        });
      }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };
    appendRollbackJournalSegment = vi.fn().mockResolvedValue(undefined);
    saveState = vi.fn().mockResolvedValue('etag-1');
    const changes = new Map<string, ResourceChange>([
      [FAST, createChange(FAST)],
      [SLOW, createChange(SLOW)],
    ]);
    return new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
        saveState,
        appendRollbackJournalSegment,
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
        popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([[FAST, SLOW]]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(changes),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi
          .fn()
          .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
            [...all.values()].filter((c) => c.changeType === type)
          ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        getCloudControlProvider: vi.fn(),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { concurrency: 4, noRollback: false },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: {
      [FAST]: { Type: TYPE, Properties: {} },
      [SLOW]: { Type: TYPE, Properties: {} },
    },
  };

  /** Until FAST is saved and SLOW is in flight. */
  async function untilSlowInFlight(): Promise<void> {
    await vi.waitFor(() => {
      expect(releaseSlow).toBeDefined();
      expect(saveState).toHaveBeenCalled();
    });
  }

  it('a force-quit mid-deploy writes one interrupted segment: completed ops plus the in-flight one as failed', async () => {
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    expect(registeredForceQuitFlushCount()).toBe(1);

    const started = startForceQuitFlushes();
    expect(started.pending).toBe(1);
    expect(await started.done).toEqual([STACK]);

    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const segment = appendRollbackJournalSegment.mock.calls[0]![2];
    expect(segment.reason).toBe('interrupted');
    expect(segment.initialDeploy).toBe(false);
    expect(segment.operations).toEqual([
      expect.objectContaining({ logicalId: FAST, changeType: 'CREATE' }),
    ]);
    expect(segment.failedOperations).toHaveLength(1);
    expect(segment.failedOperations[0]).toMatchObject({ logicalId: SLOW, changeType: 'CREATE' });
    // Nothing is known about what the in-flight CREATE made.
    expect(segment.failedOperations[0].physicalId).toBeUndefined();

    // The in-flight op settles; the engine's own path writes no second segment.
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    expect(registeredForceQuitFlushCount()).toBe(0);
  });

  it('no duplicate when the in-flight op then FAILS: the failure path journals nothing more', async () => {
    slowFails = true;
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    await startForceQuitFlushes().done;
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
  });

  it('the engine journals its own failure and unregisters; a later force-quit finds nothing', async () => {
    slowFails = true;
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    const writes = appendRollbackJournalSegment.mock.calls.length;
    expect(writes).toBeGreaterThan(0);
    expect(appendRollbackJournalSegment.mock.calls[0]![2].reason).not.toBe('interrupted');
    expect(registeredForceQuitFlushCount()).toBe(0);
    expect(startForceQuitFlushes().pending).toBe(0);
    expect(appendRollbackJournalSegment).toHaveBeenCalledTimes(writes);
  });

  it('an uninterrupted deploy writes no journal and leaves nothing registered', async () => {
    const deploying = buildEngine().deploy(STACK, template);
    await untilSlowInFlight();
    releaseSlow!();
    await deploying;
    expect(appendRollbackJournalSegment).not.toHaveBeenCalled();
    expect(registeredForceQuitFlushCount()).toBe(0);
  });
});

describe('inFlightOperationsAsFailed', () => {
  function change(logicalId: string, changeType: string): ResourceChange {
    return { logicalId, changeType, resourceType: TYPE } as unknown as ResourceChange;
  }

  it('journals running nodes only, with the pre-deploy record for an UPDATE / DELETE and none for a CREATE', () => {
    const executor = new DagExecutor<ResourceChange>();
    const node = (id: string, changeType: string, state: 'running' | 'pending' | 'completed') =>
      executor.add({ id, dependencies: new Set(), state, data: change(id, changeType) });
    node('NewOne', 'CREATE', 'running');
    node('Changed', 'UPDATE', 'running');
    node('Removed', 'DELETE', 'running');
    node('Waiting', 'UPDATE', 'pending');
    node('Done', 'UPDATE', 'running'); // recorded as completed already
    node('Settled', 'UPDATE', 'completed');

    const attempted = { Name: 'new' };
    const ops = inFlightOperationsAsFailed(
      {
        engine: { attemptedResolvedProps: new Map([['Changed', attempted]]) } as never,
        currentState: {
          resources: {
            Changed: record('Changed'),
            Removed: record('Removed'),
            Done: record('Done'),
          },
        } as unknown as StackState,
        newResources: {},
        completedOperations: [{ logicalId: 'Done', changeType: 'UPDATE', resourceType: TYPE }],
        failedOperations: [],
      },
      [executor, undefined]
    );

    expect(ops.map((op) => op.logicalId)).toEqual(['NewOne', 'Changed', 'Removed']);
    const [created, updated, deleted] = ops;
    expect(created).toEqual({ logicalId: 'NewOne', changeType: 'CREATE', resourceType: TYPE });
    expect(updated).toMatchObject({
      changeType: 'UPDATE',
      physicalId: 'phys-Changed',
      provisionedBy: 'sdk',
      previousState: record('Changed'),
      attemptedProperties: attempted,
    });
    expect(deleted).toMatchObject({
      changeType: 'DELETE',
      physicalId: 'phys-Removed',
      previousState: record('Removed'),
    });
    expect(deleted).not.toHaveProperty('attemptedProperties');
  });
});
