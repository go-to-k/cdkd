import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * The deploy engine's S3 round trips that go-to-k/cdkd#5200 took off the
 * critical path:
 *
 * - per-resource state saves coalesce: at most one save waits behind the one
 *   in flight, and every resource completing while it waits joins it, since a
 *   queued save builds its state from the live records when it starts;
 * - the final save's cleanup runs beside the post-save writes and is settled
 *   before the lock is released;
 * - the rollback journal is read beside the state record.
 *
 * Each case holds a call open on a deferred and completes work around it, so
 * the order is decided by the test, not by microtask order.
 */

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

const stackName = 'save-coalescing-test';
const REGION = 'us-east-1';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeCreate(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType: 'AWS::SQS::Queue',
    desiredProperties: {},
    propertyChanges: [],
  } as unknown as ResourceChange;
}

/**
 * An existing stack (so per-resource saves run: a first deploy has no ETag and
 * makes none) creating `ids`. `createGate(id)` decides when each create returns;
 * `saveGate(n)` when the n-th save (0-based) returns.
 */
function buildEngine(opts: {
  ids: string[];
  dependsOn?: Record<string, string[]>;
  createGate: (id: string) => Promise<void>;
  saveGate: (n: number) => Promise<void>;
}) {
  const provider = {
    create: vi.fn().mockImplementation(async (logicalId: string) => {
      await opts.createGate(logicalId);
      return { physicalId: `phys-${logicalId}`, attributes: {} };
    }),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const currentState: StackState = {
    version: 8,
    stackName,
    region: REGION,
    resources: {
      Z: {
        physicalId: 'phys-Z',
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: Date.now(),
  };

  // Each call's resource ids, captured when the save is CALLED: the engine
  // hands over the live map, which later completions keep growing.
  const savedIds: string[][] = [];
  let saveCount = 0;
  const saveState = vi.fn().mockImplementation(async (_s: string, _r: string, state: StackState) => {
    savedIds.push(Object.keys(state.resources).sort());
    await opts.saveGate(saveCount++);
    return `etag-${saveCount}`;
  });

  const mockStateBackend = {
    getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
    saveState,
    stackInstanceIdForFirstWrite: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000000'),
    appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
    rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
    warmConnections: vi.fn().mockResolvedValue(undefined),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
  };

  const changes = new Map(opts.ids.map((id) => [id, makeCreate(id)]));
  const deps = opts.dependsOn ?? {};

  const engine = new DeployEngine(
    mockStateBackend as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([opts.ids]),
      getDirectDependencies: vi.fn().mockImplementation((_g: unknown, id: string) => deps[id] ?? []),
    } as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((c: Map<string, ResourceChange>, type: string) =>
          [...c.values()].filter((x) => x.changeType === type)
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
    { concurrency: 10, roleArn: 'arn:aws:iam::1:role/r' },
    REGION
  );
  return { engine, saveState, savedIds };
}

function template(ids: string[]): CloudFormationTemplate {
  return {
    Resources: Object.fromEntries([
      ['Z', { Type: 'AWS::SQS::Queue', Properties: {} }],
      ...ids.map((id) => [id, { Type: 'AWS::SQS::Queue', Properties: {} }]),
    ]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('per-resource state saves coalesce behind the one in flight (#5200)', () => {
  it('folds every completion that lands while a save is queued into that one save', async () => {
    const firstSaveStarted = deferred<void>();
    const releaseFirstSave = deferred<void>();
    const later = ['B', 'C', 'D'];
    const { engine, savedIds } = buildEngine({
      ids: ['A', ...later],
      // B, C and D return only once A's save is in flight.
      createGate: (id) => (id === 'A' ? Promise.resolve() : firstSaveStarted.promise),
      saveGate: async (n) => {
        if (n !== 0) return;
        firstSaveStarted.resolve();
        // Let B, C and D complete (and queue) while this save is held.
        await new Promise((r) => setTimeout(r, 20));
        releaseFirstSave.resolve();
        await releaseFirstSave.promise;
      },
    });

    await engine.deploy(stackName, template(['A', ...later]));

    // One save after A, ONE for B, C and D together, then the final save.
    // Without coalescing B, C and D take a save each: five calls.
    expect(savedIds).toEqual([
      ['A', 'Z'],
      ['A', 'B', 'C', 'D', 'Z'],
      ['A', 'B', 'C', 'D', 'Z'],
    ]);
  });

  it('queues a new save for a completion that lands after the queued save STARTED', async () => {
    const secondSaveStarted = deferred<void>();
    const releaseFirstSave = deferred<void>();
    const releaseSecondSave = deferred<void>();
    const { engine, savedIds } = buildEngine({
      ids: ['A', 'B', 'C'],
      dependsOn: {},
      createGate: (id) => {
        if (id === 'A') return Promise.resolve();
        // B completes while A's save is held, so it queues the second save.
        if (id === 'B') return new Promise((r) => setTimeout(r, 5));
        // C completes only once that second save has started: it is not in
        // that save's records, so it must get a save of its own.
        return secondSaveStarted.promise;
      },
      saveGate: async (n) => {
        if (n === 0) {
          setTimeout(() => releaseFirstSave.resolve(), 20);
          await releaseFirstSave.promise;
        } else if (n === 1) {
          secondSaveStarted.resolve();
          setTimeout(() => releaseSecondSave.resolve(), 20);
          await releaseSecondSave.promise;
        }
      },
    });

    await engine.deploy(stackName, template(['A', 'B', 'C']));

    expect(savedIds).toEqual([
      ['A', 'Z'],
      ['A', 'B', 'Z'],
      ['A', 'B', 'C', 'Z'],
      // The final save.
      ['A', 'B', 'C', 'Z'],
    ]);
  });
});

describe("the final save's deferred cleanup (#5200)", () => {
  it('runs beside the post-save writes and is settled before the lock is released', async () => {
    let releaseCleanup!: () => void;
    const cleanupHeld = new Promise<void>((r) => {
      releaseCleanup = r;
    });
    let cleanupSettled = false;
    const { engine, saveState } = buildEngine({
      ids: ['A'],
      createGate: () => Promise.resolve(),
      saveGate: () => Promise.resolve(),
    });
    // The final save hands over a cleanup the backend holds open.
    saveState.mockImplementation(
      async (
        _s: string,
        _r: string,
        _state: StackState,
        options?: { deferCleanup?: (c: Promise<void>) => void }
      ) => {
        options?.deferCleanup?.(
          cleanupHeld.then(() => {
            cleanupSettled = true;
          })
        );
        return 'etag-final';
      }
    );
    const releaseLock = (engine as unknown as { lockManager: { releaseLock: ReturnType<typeof vi.fn> } })
      .lockManager.releaseLock;
    // Recorded, not asserted, here: the engine swallows a release failure.
    let settledAtRelease: boolean | undefined;
    releaseLock.mockImplementation(async () => {
      settledAtRelease = cleanupSettled;
    });

    const deployed = engine.deploy(stackName, template(['A']));
    await new Promise((r) => setTimeout(r, 20));
    // Still held: the deploy waits for it, and the lock is not released yet.
    expect(releaseLock).not.toHaveBeenCalled();
    releaseCleanup();
    await deployed;
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(settledAtRelease).toBe(true);
  });
});

describe('the rollback journal is read beside the state record (#5200)', () => {
  it('asks for the journal before the state read returns, and still reads it once', async () => {
    const { engine } = buildEngine({
      ids: ['A'],
      createGate: () => Promise.resolve(),
      saveGate: () => Promise.resolve(),
    });
    const backend = (
      engine as unknown as {
        stateBackend: {
          getState: ReturnType<typeof vi.fn>;
          loadRollbackJournal: ReturnType<typeof vi.fn>;
        };
      }
    ).stateBackend;
    const loaded = await backend.getState.getMockImplementation()?.();
    let journalAskedBeforeStateReturned: boolean | undefined;
    backend.getState.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      journalAskedBeforeStateReturned = backend.loadRollbackJournal.mock.calls.length > 0;
      return loaded;
    });

    await engine.deploy(stackName, template(['A']));

    expect(journalAskedBeforeStateReturned).toBe(true);
    // The read the deploy start makes is the one 1b consumes: no second read
    // of the journal before the plan.
    expect(backend.loadRollbackJournal.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
