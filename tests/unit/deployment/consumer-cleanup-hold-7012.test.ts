/**
 * go-to-k/cdkd#7012: a ROOT engine given a `consumerCleanupQueue` (a producer
 * whose outputs a later stack of the same `cdkd deploy` run imports) queues
 * its cleanup phase there instead of deleting its replaced resources' old
 * copies at the end of its own deploy. The CLI runs the queue once every
 * consumer deployed, or abandons it, keeping each old copy recorded in the
 * producer's state, when one did not: a consumer that rolls back to the old
 * imported values then still names a live resource.
 *
 * Harness shared with nested-cleanup-at-root-6398.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { deployWithoutChanges } from '../../../src/deployment/deploy-engine/deploy-flow/no-change.js';
import {
  NestedCleanupQueue,
  withNestedCleanupQueue,
} from '../../../src/deployment/nested-cleanup-scope.js';
import { supersededResourcesOf } from '../../../src/deployment/superseded-resources.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor.js';
import type {
  ResourceChange,
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({
  info: [] as string[],
  warn: [] as string[],
  /** An info line containing this throws, to make a pass throw at a seam. */
  throwOn: undefined as string | undefined,
}));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      if (printed.throwOn !== undefined && String(message).includes(printed.throwOn)) {
        throw new Error('cleanup pass threw');
      }
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
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

// go-to-k/cdkd#6463: a carried entry's owed pre-delete snapshot.
const preDeleteSnapshot = vi.hoisted(() => vi.fn(async () => 'snap-1'));
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPreDeleteFinalSnapshot: preDeleteSnapshot,
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

// Each journal segment the engine writes: its reason (5th argument).
const journaled = vi.hoisted(() => ({ reasons: [] as unknown[] }));
vi.mock('../../../src/deployment/deploy-engine/rollback.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/deploy-engine/rollback.js')>();
  return {
    ...actual,
    writeRollbackJournalSegment: vi.fn(
      async (...args: Parameters<typeof actual.writeRollbackJournalSegment>) => {
        journaled.reasons.push(args[4]);
        return actual.writeRollbackJournalSegment(...args);
      }
    ),
  };
});

// go-to-k/cdkd#6398 review: wrapped, so a test can make the root's output pass throw.
vi.mock('../../../src/deployment/deploy-engine/outputs.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/deploy-engine/outputs.js')>();
  return {
    ...actual,
    resolveOutputs: vi.fn(async (...args: Parameters<typeof actual.resolveOutputs>) => {
      return actual.resolveOutputs(...args);
    }),
  };
});

/** A type `canRecordSuperseded` accepts: its delete is deferred. */
const REVISION = 'AWS::Lambda::WebFunctionRevision';
const ENDPOINT = 'AWS::Lambda::WebFunctionEndpoint';
const NESTED = 'AWS::Test::NestedRow';

const ROOT = 'Root';
const CHILD = 'Root~Child';
const GRANDCHILD = 'Root~Child~Grand';

type Stored = { state: StackState; etag: string };

describe('a producer holds its cleanup phase for its in-run consumers (go-to-k/cdkd#7012)', () => {
  let provider: ResourceProvider;
  let live: Set<string>;
  let order: string[];
  /** The state backend's objects, by stack name. */
  let store: Map<string, Stored>;
  let saves: { stack: string; state: StackState; expectedEtag: string | undefined }[];
  let locks: string[];
  /** Logical ids whose update throws. */
  let failing: Set<string>;
  /** A nested row's update runs this child deploy. */
  let nestedRuns: Map<string, () => Promise<unknown>>;
  /** Physical ids whose delete AWS refuses. */
  let refuse: Set<string>;
  /** Physical ids whose delete the provider skips (the old resource survives). */
  let skip: Set<string>;
  /** Stacks whose lock cannot be taken. */
  let lockFails: Set<string>;
  /** Stacks whose state read throws. */
  let readFails: Set<string>;
  /** Decides whether a conditional save is refused as an ETag conflict. */
  let refuseSave: (stack: string, expectedEtag: string | undefined) => boolean;
  let etagSeq: number;

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    printed.throwOn = undefined;
    journaled.reasons.length = 0;
    live = new Set();
    order = [];
    store = new Map();
    saves = [];
    locks = [];
    failing = new Set();
    nestedRuns = new Map();
    refuse = new Set();
    skip = new Set();
    lockFails = new Set();
    readFails = new Set();
    refuseSave = () => false;
    etagSeq = 0;
    provider = {
      create: vi.fn(async (logicalId: string) => {
        const physicalId = `${logicalId}-new`;
        live.add(physicalId);
        order.push(`create ${physicalId}`);
        return { physicalId, attributes: {} };
      }),
      update: vi.fn(async (logicalId: string, physicalId: string) => {
        const nested = nestedRuns.get(logicalId);
        if (nested !== undefined) await nested();
        order.push(`update ${physicalId}`);
        if (failing.has(logicalId)) throw new Error('ValidationException: update rejected');
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`delete ${physicalId}`);
        if (refuse.has(physicalId)) throw new Error('ResourceInUseException: still in use');
        if (skip.has(physicalId)) return { outcome: 'skipped', reason: 'the handler kept it' };
        live.delete(physicalId);
        return undefined;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? { FunctionName: 'f' } : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(
    prefix: string,
    parent?: { parentStack: string; parentLogicalId: string },
    consumerCleanupQueue?: NestedCleanupQueue
  ): DeployEngine {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const backend = {
      getState: vi.fn(async (stack: string) => {
        if (readFails.has(stack)) throw new Error('AccessDenied: s3:GetObject');
        const held = store.get(stack);
        return held === undefined ? null : structuredClone(held);
      }),
      saveState: vi.fn(
        async (
          stack: string,
          _region: string,
          state: StackState,
          options?: { expectedEtag?: string }
        ) => {
          if (refuseSave(stack, options?.expectedEtag)) {
            const conflict = new Error('At least one of the pre-conditions you specified did not hold');
            conflict.name = 'PreconditionFailed';
            saves.push({ stack, state: structuredClone(state), expectedEtag: options?.expectedEtag });
            throw Object.assign(new Error('State has been modified by another process.'), {
              name: 'StateError',
              cause: conflict,
            });
          }
          const etag = `e${++etagSeq}`;
          store.set(stack, { state: structuredClone(state), etag });
          saves.push({ stack, state: structuredClone(state), expectedEtag: options?.expectedEtag });
          return etag;
        }
      ),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      // go-to-k/cdkd#7017: the consumer scan of a held entry.
      listStacks: vi.fn(async () =>
        [...store.keys()].map((stackName) => ({ stackName, region: 'us-east-1' }))
      ),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn(async (stack: string) => {
        if (lockFails.has(stack)) throw new Error('LockError: held by another deploy');
        locks.push(`lock ${stack}`);
      }),
      releaseLock: vi.fn(async (stack: string) => {
        locks.push(`release ${stack}`);
      }),
    };
    return new DeployEngine(
      backend as unknown as never,
      lockManager as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) =>
          id === `${prefix}End` ? [`${prefix}Rev`, `${prefix}Nest`] : [],
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      {
        concurrency: 4,
        noRollback: true,
        ...(parent !== undefined && {
          parentStackInfo: { ...parent, parentRegion: 'us-east-1' },
        }),
        ...(consumerCleanupQueue !== undefined && { consumerCleanupQueue }),
      } as never,
      'us-east-1'
    );
  }

  const record = (physicalId: string, resourceType: string, properties: Record<string, unknown>) =>
    ({
      physicalId,
      resourceType,
      properties,
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    }) as ResourceState;

  /**
   * One stack: `<p>Rev` replaced create-first, `<p>End` moved onto the new
   * one, and (with `nested`) a `<p>Nest` row whose update runs a child deploy.
   */
  async function deployStack(
    engine: DeployEngine,
    stackName: string,
    prefix: string,
    opts: {
      nested?: boolean;
      superseded?: SupersededResourceRecord[];
      /** Template outputs, and the previous record's. */
      outputs?: Record<string, unknown>;
      previousOutputs?: Record<string, unknown>;
      /** Records beside the stack's own, unchanged by the deploy. */
      extraRecords?: Record<string, ResourceState>;
    } = {}
  ): Promise<{
    completedOperations: CompletedOperation[];
    state: StackState;
    actualCounts: { updatePartial: number; nestedUpdatePartial: number };
  }> {
    const rev = `${prefix}Rev`;
    const end = `${prefix}End`;
    const nest = `${prefix}Nest`;
    live.add(`${rev}-old`);
    const resources: Record<string, unknown> = {
      [rev]: { Type: REVISION, Properties: { FunctionName: 'f', Code: 'v2' } },
      [end]: { Type: ENDPOINT, Properties: { FunctionName: 'f', RevisionId: `${rev}-new` } },
    };
    const records: Record<string, ResourceState> = {
      [rev]: record(`${rev}-old`, REVISION, { FunctionName: 'f', Code: 'v1' }),
      [end]: record(`${end}-id`, ENDPOINT, { FunctionName: 'f', RevisionId: `${rev}-old` }),
      ...opts.extraRecords,
    };
    const changes = new Map<string, ResourceChange>([
      [
        rev,
        {
          logicalId: rev,
          changeType: 'UPDATE',
          resourceType: REVISION,
          currentProperties: { FunctionName: 'f', Code: 'v1' },
          desiredProperties: { FunctionName: 'f', Code: 'v2' },
          propertyChanges: [{ path: 'Code', oldValue: 'v1', newValue: 'v2', requiresReplacement: true }],
        } as unknown as ResourceChange,
      ],
      [
        end,
        {
          logicalId: end,
          changeType: 'UPDATE',
          resourceType: ENDPOINT,
          currentProperties: { FunctionName: 'f', RevisionId: `${rev}-old` },
          desiredProperties: { FunctionName: 'f', RevisionId: `${rev}-new` },
          propertyChanges: [
            {
              path: 'RevisionId',
              oldValue: `${rev}-old`,
              newValue: `${rev}-new`,
              requiresReplacement: false,
            },
          ],
        } as unknown as ResourceChange,
      ],
    ]);
    if (opts.nested === true) {
      resources[nest] = { Type: NESTED, Properties: { Version: '2' } };
      records[nest] = record(`${nest}-id`, NESTED, { Version: '1' });
      changes.set(nest, {
        logicalId: nest,
        changeType: 'UPDATE',
        resourceType: NESTED,
        currentProperties: { Version: '1' },
        desiredProperties: { Version: '2' },
        propertyChanges: [{ path: 'Version', oldValue: '1', newValue: '2', requiresReplacement: false }],
      } as unknown as ResourceChange);
    }
    const template = {
      Resources: resources,
      ...(opts.outputs !== undefined && { Outputs: opts.outputs }),
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 12,
      stackName,
      region: 'us-east-1',
      resources: records,
      outputs: opts.previousOutputs ?? {},
      ...(opts.superseded !== undefined && { supersededResources: opts.superseded }),
      lastModified: 0,
    } as unknown as StackState;
    store.set(stackName, { state: structuredClone(currentState), etag: 'etag-0' });
    const result = (await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      [[rev, ...(opts.nested === true ? [nest] : [])], [end]],
      stackName,
      template,
      undefined,
      undefined,
      'etag-0'
    )) as unknown as {
      completedOperations: CompletedOperation[];
      state: StackState;
      actualCounts: { updatePartial: number; nestedUpdatePartial: number };
    };
    // As `deploy-flow.ts`'s final save, which writes the returned state.
    await engine.stateBackend.saveState(stackName, 'us-east-1', engine.withParentInfo(result.state));
    return result;
  }

  const deletesOf = (physicalId: string): number =>
    vi.mocked(provider.delete).mock.calls.filter((c) => c[1] === physicalId).length;
  const childEngine = (): DeployEngine =>
    makeEngine('C', { parentStack: ROOT, parentLogicalId: 'RNest' });

  const PRODUCER = 'Producer';
  const listed = (stack: string): string[] =>
    supersededResourcesOf(store.get(stack)!.state).map((e) => e.state.physicalId);
  const silent = { info: vi.fn(), warn: vi.fn() };

  it('without a consumer queue a root deletes the old copy at the end of its own deploy, as before', async () => {
    await deployStack(makeEngine('R'), PRODUCER, 'R');

    expect(deletesOf('RRev-old')).toBe(1);
    expect(listed(PRODUCER)).toEqual([]);
    expect(locks).toEqual([]);
  });

  it('with a consumer queue the old copy outlives the deploy, recorded in the saved state', async () => {
    const queue = new NestedCleanupQueue();

    await deployStack(makeEngine('R', undefined, queue), PRODUCER, 'R');

    expect(deletesOf('RRev-old')).toBe(0);
    expect(live.has('RRev-old')).toBe(true);
    expect(queue.size).toBe(1);
    // Saved before any consumer starts: a Ctrl-C or force-quit from here on
    // leaves the old copy tracked, for the next deploy to delete.
    expect(listed(PRODUCER)).toEqual(['RRev-old']);
  });

  it('every consumer deployed: the queue deletes the old copy and drops it from the state', async () => {
    const queue = new NestedCleanupQueue();
    await deployStack(makeEngine('R', undefined, queue), PRODUCER, 'R');
    locks.length = 0;

    const outcome = await queue.runAll({ interrupted: () => false }, silent);

    expect(deletesOf('RRev-old')).toBe(1);
    expect(live.has('RRev-old')).toBe(false);
    expect(listed(PRODUCER)).toEqual([]);
    // Under the producer's lock, taken again for the pass.
    expect(locks).toEqual([`lock ${PRODUCER}`, `release ${PRODUCER}`]);
    expect(outcome).toEqual({ updatePartial: 0, nestedUpdatePartial: 0 });
    expect(silent.info).toHaveBeenCalledWith(
      expect.stringContaining(`Deleting the replaced resources of stack ${PRODUCER}`)
    );
  });

  it('a consumer did not deploy: abandoning keeps the old copy, recorded, and says so', async () => {
    const queue = new NestedCleanupQueue();
    await deployStack(makeEngine('R', undefined, queue), PRODUCER, 'R');

    queue.abandon('consumer-failed');
    await queue.runAll({ interrupted: () => false }, silent);

    expect(deletesOf('RRev-old')).toBe(0);
    expect(live.has('RRev-old')).toBe(true);
    expect(listed(PRODUCER)).toEqual(['RRev-old']);
    expect(
      printed.info.some(
        (l) =>
          l.includes('Old RRev (RRev-old) was not deleted') &&
          l.includes('a stack of this run that imports its outputs did not deploy') &&
          l.includes('cdkd keeps it in state, and the next deploy deletes it')
      )
    ).toBe(true);
    expect(printed.warn).toEqual([]);
  });

  it('an old copy deferred only in memory is held too, and named for a manual delete on abandon', async () => {
    const queue = new NestedCleanupQueue();
    // Another record holds the old id: the deferral is never recorded in state.
    await deployStack(makeEngine('R', undefined, queue), PRODUCER, 'R', {
      extraRecords: { Twin: record('RRev-old', ENDPOINT, { FunctionName: 'twin' }) },
    });
    expect(deletesOf('RRev-old')).toBe(0);
    expect(listed(PRODUCER)).toEqual([]);
    expect(queue.size).toBe(1);

    queue.abandon('consumer-failed');

    expect(deletesOf('RRev-old')).toBe(0);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Old RRev (RRev-old) was not deleted') &&
          l.includes('a stack of this run that imports its outputs did not deploy') &&
          l.includes('It is no longer tracked in state, so delete it manually')
      )
    ).toBe(true);
  });

  it('a producer that replaced nothing and carries nothing queues nothing (no lock, no read)', async () => {
    const queue = new NestedCleanupQueue();
    const engine = makeEngine('R', undefined, queue);
    // Only the endpoint changes: no replacement, so nothing is deferred.
    const template = {
      Resources: { REnd: { Type: ENDPOINT, Properties: { FunctionName: 'g' } } },
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 12,
      stackName: PRODUCER,
      region: 'us-east-1',
      resources: { REnd: record('REnd-id', ENDPOINT, { FunctionName: 'f' }) },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'REnd',
        {
          logicalId: 'REnd',
          changeType: 'UPDATE',
          resourceType: ENDPOINT,
          currentProperties: { FunctionName: 'f' },
          desiredProperties: { FunctionName: 'g' },
          propertyChanges: [
            { path: 'FunctionName', oldValue: 'f', newValue: 'g', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ],
    ]);
    await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      [['REnd']],
      PRODUCER,
      template,
      undefined,
      undefined,
      'etag-0'
    );

    expect(queue.size).toBe(0);
    expect(locks).toEqual([]);
    expect(vi.mocked(engine.stateBackend.getState)).not.toHaveBeenCalled();
  });

  it("a held producer's nested children wait with it, and run before its own pass", async () => {
    const queue = new NestedCleanupQueue();
    const root = makeEngine('R', undefined, queue);
    const child = childEngine();
    nestedRuns.set('RNest', () => deployStack(child, CHILD, 'C'));

    await deployStack(root, ROOT, 'R', { nested: true });

    expect(deletesOf('CRev-old')).toBe(0);
    expect(deletesOf('RRev-old')).toBe(0);
    expect(queue.size).toBe(2);

    const outcome = await queue.runAll({ interrupted: () => false }, silent);

    expect(order.indexOf('delete CRev-old')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('delete CRev-old')).toBeLessThan(order.indexOf('delete RRev-old'));
    expect(outcome).toEqual({ updatePartial: 0, nestedUpdatePartial: 0 });
  });

  it("a child's own engine ignores an inherited consumer queue and still queues at its root", async () => {
    const held = new NestedCleanupQueue();
    const child = makeEngine('C', { parentStack: ROOT, parentLogicalId: 'RNest' }, held);
    const rootQueue = new NestedCleanupQueue();

    await withNestedCleanupQueue(rootQueue, () => deployStack(child, CHILD, 'C'));

    expect(held.size).toBe(0);
    expect(rootQueue.size).toBe(1);
  });

  // go-to-k/cdkd#7017: the kept copy waits for the consumer on a later deploy
  // of the producer alone, too.
  const consumerNaming = (physicalId: string): Stored => ({
    state: {
      version: 12,
      stackName: 'Consumer',
      region: 'us-east-1',
      resources: {
        Fn: record('fn', ENDPOINT, { Environment: { Variables: { QURL: physicalId } } }),
      },
      outputs: {},
      imports: [{ sourceStack: PRODUCER, sourceRegion: 'us-east-1', exportName: 'X' }],
      lastModified: 0,
    } as unknown as StackState,
    etag: 'c-0',
  });
  const marked = (physicalId: string): SupersededResourceRecord => ({
    logicalId: 'Old',
    supersededAt: 1,
    state: record(physicalId, REVISION, { FunctionName: physicalId }),
    heldForConsumers: true,
  });

  it('a held producer saves its entries marked as held for consumers', async () => {
    await deployStack(makeEngine('R', undefined, new NestedCleanupQueue()), PRODUCER, 'R');
    expect(
      supersededResourcesOf(store.get(PRODUCER)!.state).map((e) => e.heldForConsumers)
    ).toEqual([true]);
  });

  it('a later deploy of the producer alone keeps a marked entry the consumer still names', async () => {
    live.add('kept-old');
    store.set('Consumer', consumerNaming('kept-old'));
    await deployStack(makeEngine('R'), PRODUCER, 'R', { superseded: [marked('kept-old')] });

    expect(deletesOf('kept-old')).toBe(0);
    expect(listed(PRODUCER)).toContain('kept-old');
    expect(
      printed.info.some((l) =>
        l.includes("Consumer (importing this stack's outputs) still uses it")
      )
    ).toBe(true);
    // This deploy's own replaced copy is unaffected.
    expect(deletesOf('RRev-old')).toBe(1);
  });

  it('once the consumer moved off it, the next deploy deletes the marked entry', async () => {
    live.add('kept-old');
    store.set('Consumer', consumerNaming('kept-new'));
    await deployStack(makeEngine('R'), PRODUCER, 'R', { superseded: [marked('kept-old')] });

    expect(deletesOf('kept-old')).toBe(1);
    expect(listed(PRODUCER)).not.toContain('kept-old');
  });

  it('a no-change deploy of a held producer saves the mark on its carried entries', async () => {
    const queue = new NestedCleanupQueue();
    const engine = makeEngine('R', undefined, queue);
    live.add('carried-old');
    const carried: SupersededResourceRecord = {
      logicalId: 'Old',
      supersededAt: 1,
      state: record('carried-old', REVISION, { FunctionName: 'carried-old' }),
    };
    const currentState = {
      version: 12,
      stackName: PRODUCER,
      region: 'us-east-1',
      resources: {},
      outputs: {},
      supersededResources: [carried],
      lastModified: 0,
    } as unknown as StackState;
    store.set(PRODUCER, { state: structuredClone(currentState), etag: 'etag-0' });
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    await deployWithoutChanges(engine, {
      stackName: PRODUCER,
      template,
      currentState,
      currentEtag: 'etag-0',
      effectiveTemplate: template,
      outputsDigestSource: template,
      parameterValues: {},
      conditions: {},
      conditionVerdicts: undefined,
      migrationPending: false,
      maskedFingerprintsBackfilled: false,
      orphansChanged: false,
      terminationProtectionChanged: false,
      ssmNamesHealed: false,
      nestedSsmNamesMarked: false,
      resolveStackInstanceId: async () => {},
      startProvenanceCapture: () => {},
      startTime: 0,
      clock: { lap: () => {} },
    } as unknown as Parameters<typeof deployWithoutChanges>[1]);

    expect(queue.size).toBe(1);
    expect(deletesOf('carried-old')).toBe(0);
    expect(
      supersededResourcesOf(store.get(PRODUCER)!.state).map((e) => e.heldForConsumers)
    ).toEqual([true]);
  });
});
