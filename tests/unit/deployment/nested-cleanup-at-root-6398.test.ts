/**
 * go-to-k/cdkd#6398: a nested child's cleanup phase (the deferred deletes of
 * the resources its update replaced, and the superseded entries an earlier
 * deploy left) waits for the ROOT deploy's success, as CloudFormation runs a
 * nested stack's cleanup at the end of the whole stack tree's update. A
 * sibling child or the parent may still reference the child's old resource
 * while the parent's DAG runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { deployWithoutChanges } from '../../../src/deployment/deploy-engine/deploy-flow/no-change.js';
import {
  PERSIST_DROPPED_ATTEMPTS,
  queueNestedCleanup,
} from '../../../src/deployment/deploy-engine/nested-cleanup.js';
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

describe('a nested child cleanup phase runs at the root (go-to-k/cdkd#6398)', () => {
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
    parent?: { parentStack: string; parentLogicalId: string }
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

  it('a child engine queues its cleanup instead of deleting, and the queue deletes it later', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();

    const result = await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));

    // Not sent while the parent's DAG may still use it.
    expect(deletesOf('CRev-old')).toBe(0);
    expect(live.has('CRev-old')).toBe(true);
    // The journal keeps the `'deferred'` verdict a parent rollback re-adopts on.
    expect(
      result.completedOperations.find((o) => o.logicalId === 'CRev')!.oldResourceMaySurvive
    ).toBe('deferred');
    // The child's saved state still lists the old resource.
    expect(
      supersededResourcesOf(store.get(CHILD)!.state).map((e) => e.state.physicalId)
    ).toEqual(['CRev-old']);
    expect(printed.info.some((l) => l.includes('Deleting the old resource of'))).toBe(false);

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(1);
    expect(live.has('CRev-old')).toBe(false);
  });

  // A child that replaced nothing and carries nothing queues no entry, so the
  // root pays no lock round-trip or state read for it (everyday speed).
  it('a child with nothing to delete queues no entry', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    child.replacementRun.deferredReplacedDeletes = new Map();
    const pass = vi.fn(async () => undefined);
    const queued = withNestedCleanupQueue(queue, () =>
      queueNestedCleanup(child, CHILD, {}, pass)
    );
    expect(queued).toBe(false);
    const info = vi.fn();
    await queue.runAll({ interrupted: () => false }, { info, warn: vi.fn() });
    expect(info).not.toHaveBeenCalled();
    expect(pass).not.toHaveBeenCalled();
  });

  it('without a root queue a child runs its cleanup itself, as before', async () => {
    await deployStack(childEngine(), CHILD, 'C');

    expect(deletesOf('CRev-old')).toBe(1);
    expect(order.indexOf('delete CRev-old')).toBeGreaterThan(order.indexOf('update CEnd-id'));
  });

  it('the root runs the queued child deletes after its own DAG, before its own cleanup', async () => {
    const root = makeEngine('R');
    const child = childEngine();
    nestedRuns.set('RNest', () => deployStack(child, CHILD, 'C'));

    await deployStack(root, ROOT, 'R', { nested: true });

    const at = (step: string): number => order.indexOf(step);
    expect(deletesOf('CRev-old')).toBe(1);
    // Every update of the tree, the root's last one included, came first.
    expect(at('delete CRev-old')).toBeGreaterThan(at('update REnd-id'));
    expect(at('delete CRev-old')).toBeGreaterThan(at('update CEnd-id'));
    // The child's first (dependents first across the stack boundary), then the root's own.
    expect(deletesOf('RRev-old')).toBe(1);
    expect(at('delete CRev-old')).toBeLessThan(at('delete RRev-old'));
    // Under the child's lock, taken again for the pass.
    expect(locks).toEqual([`lock ${CHILD}`, `release ${CHILD}`]);
    // The root's line names the child stack.
    const named = printed.info.findIndex((l) =>
      l.includes(`Deleting the replaced resources of nested stack ${CHILD}`)
    );
    expect(named).toBeGreaterThanOrEqual(0);
    expect(printed.warn).toEqual([]);
  });

  it('a root that fails after the child ran sends none of the child deletes', async () => {
    const root = makeEngine('R');
    const child = childEngine();
    nestedRuns.set('RNest', () => deployStack(child, CHILD, 'C'));
    failing.add('REnd');

    await expect(deployStack(root, ROOT, 'R', { nested: true })).rejects.toThrow();

    expect(order).toContain('update CEnd-id');
    expect(deletesOf('CRev-old')).toBe(0);
    expect(deletesOf('RRev-old')).toBe(0);
    expect(locks).toEqual([]);
    // The child's state still lists the old resource, for the rollback.
    expect(
      supersededResourcesOf(store.get(CHILD)!.state).map((e) => e.state.physicalId)
    ).toEqual(['CRev-old']);
    expect(
      printed.info.some(
        (l) =>
          l.includes('Old CRev (CRev-old) was not deleted: the deploy failed first') &&
          l.includes('A rollback of the deploy adopts it again')
      )
    ).toBe(true);
  });

  it("a child's own failure is unaffected: nothing is queued for the root", async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    failing.add('CEnd');

    await expect(
      withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'))
    ).rejects.toThrow();
    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(0);
    expect(locks).toEqual([]);
  });

  it("the child's persisted state drops exactly the entries the pass deleted", async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    const carried = (logicalId: string, physicalId: string): SupersededResourceRecord => ({
      logicalId,
      supersededAt: 1,
      state: record(physicalId, REVISION, { FunctionName: physicalId }),
    });
    live.add('gone-old');
    live.add('stuck-old');
    refuse.add('stuck-old');

    await withNestedCleanupQueue(queue, () =>
      deployStack(child, CHILD, 'C', {
        superseded: [carried('Gone', 'gone-old'), carried('Stuck', 'stuck-old')],
      })
    );
    // Neither the deferred nor the carried deletes were sent by the child.
    expect(deletesOf('gone-old')).toBe(0);
    const before = store.get(CHILD)!;
    expect(supersededResourcesOf(before.state).map((e) => e.state.physicalId).sort()).toEqual([
      'CRev-old',
      'gone-old',
      'stuck-old',
    ]);
    // A field the pass never touches must survive the write-back as read.
    store.set(CHILD, {
      ...before,
      state: { ...before.state, outputs: { Marker: 'written-after-the-child' } },
    });
    const savesBefore = saves.length;

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(1);
    expect(deletesOf('gone-old')).toBe(1);
    expect(deletesOf('stuck-old')).toBeGreaterThanOrEqual(1);
    const written = saves.slice(savesBefore);
    expect(written).toHaveLength(1);
    expect(written[0]!.stack).toBe(CHILD);
    // Conditional on the fresh read's ETag.
    expect(written[0]!.expectedEtag).toBe(before.etag);
    expect(supersededResourcesOf(written[0]!.state).map((e) => e.state.physicalId)).toEqual([
      'stuck-old',
    ]);
    expect(written[0]!.state.outputs).toEqual({ Marker: 'written-after-the-child' });
    expect(written[0]!.state.resources['CRev']!.physicalId).toBe('CRev-new');
  });

  // go-to-k/cdkd#6463: a carried entry owing a pre-delete snapshot, whose
  // delete fails after the snapshot, stays listed and owes none.
  it("keeps a child's entry whose snapshot was taken before its delete failed, owing none", async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    live.add('vol-old');
    refuse.add('vol-old');

    await withNestedCleanupQueue(queue, () =>
      deployStack(child, CHILD, 'C', {
        superseded: [
          {
            logicalId: 'Vol',
            supersededAt: 1,
            state: record('vol-old', 'AWS::EC2::Volume', {}),
            updateReplacePolicy: 'Snapshot',
            finalSnapshotIdentifier: 'vol-old-final-20261117-000000',
          },
        ],
      })
    );
    const savesBefore = saves.length;

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(preDeleteSnapshot).toHaveBeenCalledTimes(1);
    expect(deletesOf('vol-old')).toBeGreaterThanOrEqual(1);
    const written = saves.slice(savesBefore);
    expect(written).toHaveLength(1);
    const [kept] = supersededResourcesOf(written[0]!.state);
    expect(kept!.state.physicalId).toBe('vol-old');
    expect(kept).not.toHaveProperty('finalSnapshotIdentifier');
    expect(kept!.updateReplacePolicy).toBe('Snapshot');
  });

  it('an entry no longer listed in the persisted child state is not deleted', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();

    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    // Something took the old resource back after the child saved.
    const held = store.get(CHILD)!;
    const { supersededResources: _dropped, ...rest } = held.state;
    store.set(CHILD, { ...held, state: rest as StackState });
    const savesBefore = saves.length;

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(0);
    expect(saves.length).toBe(savesBefore);
  });

  it('an entry a persisted child record holds again is not deleted', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();

    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    // The entry is still listed, but a record names its physical id again.
    const held = store.get(CHILD)!;
    held.state.resources['CRev'] = { ...held.state.resources['CRev']!, physicalId: 'CRev-old' };

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(0);
  });

  // go-to-k/cdkd#6445: an in-memory deferral (a custom resource needing this
  // run's NoEcho values) has no superseded entry; the queued pass still refuses
  // an id a re-read child record names.
  it.each([
    [true, 0],
    [false, 1],
  ])(
    'an in-memory deferral is not deleted while a re-read child record names its id (held: %s)',
    async (held, deletes) => {
      const child = childEngine();
      const queue = new NestedCleanupQueue();

      await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
      // Shape it as an in-memory deferral: no superseded entry anywhere.
      child.replacementRun.supersededEntries.delete('CRev');
      const stored = store.get(CHILD)!;
      const { supersededResources: _dropped, ...rest } = stored.state;
      store.set(CHILD, { ...stored, state: rest as StackState });
      if (held) {
        store.get(CHILD)!.state.resources['Other'] = record('CRev-old', REVISION, {});
      }

      await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

      expect(deletesOf('CRev-old')).toBe(deletes);
      expect(
        printed.warn.some(
          (l) => l.includes('Old CRev of nested stack') && l.includes('names its physical id again')
        )
      ).toBe(held);
    }
  );

  // go-to-k/cdkd#6712: a record of ANOTHER type naming the same string (a
  // queue policy recorded under the queue URL, a role and a function both
  // named `foo`) does not hold the old copy: it is still deleted.
  it('an in-memory deferral whose id a re-read record of another type names is still deleted', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();

    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    child.replacementRun.supersededEntries.delete('CRev');
    const stored = store.get(CHILD)!;
    const { supersededResources: _dropped, ...rest } = stored.state;
    store.set(CHILD, { ...stored, state: rest as StackState });
    store.get(CHILD)!.state.resources['Policy'] = record('CRev-old', 'AWS::SQS::QueuePolicy', {});

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(1);
    expect(printed.warn.some((l) => l.includes('names its physical id again'))).toBe(false);
  });

  it('a carried entry no longer listed in the persisted child state is not deleted', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    live.add('gone-old');

    await withNestedCleanupQueue(queue, () =>
      deployStack(child, CHILD, 'C', {
        superseded: [
          {
            logicalId: 'Gone',
            supersededAt: 1,
            state: record('gone-old', REVISION, { FunctionName: 'gone-old' }),
          },
        ],
      })
    );
    const held = store.get(CHILD)!;
    held.state.supersededResources = supersededResourcesOf(held.state).filter(
      (e) => e.logicalId !== 'Gone'
    );

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('gone-old')).toBe(0);
    // The one still listed is deleted as usual.
    expect(deletesOf('CRev-old')).toBe(1);
  });

  it('a grandchild reaches the root through its parent child', async () => {
    const root = makeEngine('R');
    const child = makeEngine('C', { parentStack: ROOT, parentLogicalId: 'RNest' });
    const grand = makeEngine('G', { parentStack: CHILD, parentLogicalId: 'CNest' });
    nestedRuns.set('RNest', () => deployStack(child, CHILD, 'C', { nested: true }));
    nestedRuns.set('CNest', () => deployStack(grand, GRANDCHILD, 'G'));

    await deployStack(root, ROOT, 'R', { nested: true });

    const at = (step: string): number => order.indexOf(step);
    expect(deletesOf('GRev-old')).toBe(1);
    expect(at('delete GRev-old')).toBeGreaterThan(at('update REnd-id'));
    expect(at('delete GRev-old')).toBeLessThan(at('delete RRev-old'));
    expect(at('delete CRev-old')).toBeLessThan(at('delete RRev-old'));
    expect(at('delete CRev-old')).toBeGreaterThan(at('update REnd-id'));
    // Children in completion order: the grandchild finished first.
    expect(at('delete GRev-old')).toBeLessThan(at('delete CRev-old'));
  });

  it.each([
    ['with a root queue, waits for the root', true],
    ['without one, deletes at once as before', false],
  ] as const)('an unchanged nested child, %s, for a carried entry', async (_l, withQueue) => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    const entry: SupersededResourceRecord = {
      logicalId: 'Gone',
      supersededAt: 1,
      state: record('gone-old', REVISION, { FunctionName: 'gone-old' }),
    };
    live.add('gone-old');
    const currentState = {
      version: 12,
      stackName: CHILD,
      region: 'us-east-1',
      resources: {},
      outputs: {},
      exportNames: [],
      supersededResources: [entry],
      lastModified: 0,
    } as unknown as StackState;
    store.set(CHILD, { state: structuredClone(currentState), etag: 'etag-0' });
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const run = (): Promise<unknown> =>
      deployWithoutChanges(child, {
        stackName: CHILD,
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

    if (!withQueue) {
      await run();
      expect(deletesOf('gone-old')).toBe(1);
      return;
    }
    await withNestedCleanupQueue(queue, run);
    expect(deletesOf('gone-old')).toBe(0);
    const savesBefore = saves.length;

    await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('gone-old')).toBe(1);
    const written = saves.slice(savesBefore);
    expect(written.map((s) => s.stack)).toEqual([CHILD]);
    expect(written[0]!.state.supersededResources).toBeUndefined();
  });

  it("a child pass whose delete is skipped counts in the root's summary", async () => {
    const root = makeEngine('R');
    const child = childEngine();
    nestedRuns.set('RNest', () => deployStack(child, CHILD, 'C'));
    skip.add('CRev-old');

    const result = await deployStack(root, ROOT, 'R', { nested: true });

    expect(deletesOf('CRev-old')).toBe(1);
    expect(result.actualCounts.updatePartial).toBe(1);
    expect(result.actualCounts.nestedUpdatePartial).toBe(1);
  });

  it.each([
    ['the child lock cannot be taken', (): void => void lockFails.add(CHILD), 'Could not lock nested stack'],
    ['the child state cannot be read', (): void => void readFails.add(CHILD), 'Could not read the state of nested stack'],
  ] as const)('when %s, no delete or write is sent and the entry counts partial', async (_l, arrange, line) => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    const savesBefore = saves.length;
    arrange();

    const outcome = await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(0);
    expect(saves.length).toBe(savesBefore);
    expect(outcome.updatePartial).toBe(1);
    expect(printed.warn.some((l) => l.includes(line))).toBe(true);
    // The per-resource line says what was left, and that state keeps it.
    expect(
      printed.warn.some(
        (l) =>
          l.includes("Old CRev (CRev-old) was not deleted: its nested stack's cleanup could not run") &&
          l.includes('cdkd keeps it in state')
      )
    ).toBe(true);
  });

  it('a child record gone by the cleanup counts its entries partial', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    store.delete(CHILD);

    const outcome = await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(0);
    expect(outcome.updatePartial).toBe(1);
  });

  it('a queued pass that throws is reported and counted through its fail path', async () => {
    const queue = new NestedCleanupQueue();
    const fail = vi.fn(() => ({ updatePartial: 2 }));
    queue.enqueue({
      stackName: CHILD,
      run: async () => {
        throw new Error('boom');
      },
      abandon: vi.fn(),
      fail,
    });
    const warn = vi.fn();

    const outcome = await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(outcome.updatePartial).toBe(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`The cleanup of nested stack ${CHILD} failed`);
  });

  it('an ETag conflict on the write-back re-reads and writes again', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    const before = store.get(CHILD)!;
    let refused = 0;
    // Another writer moved the record once, between the read and the write.
    refuseSave = (stack, expectedEtag) => {
      if (stack !== CHILD || expectedEtag !== before.etag || refused > 0) return false;
      refused++;
      store.set(CHILD, { state: structuredClone(before.state), etag: 'moved' });
      return true;
    };
    const savesBefore = saves.length;

    const outcome = await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    const written = saves.slice(savesBefore);
    expect(written.map((w) => w.expectedEtag)).toEqual([before.etag, 'moved']);
    expect(supersededResourcesOf(store.get(CHILD)!.state)).toEqual([]);
    expect(outcome.updatePartial).toBe(0);
    expect(printed.warn).toEqual([]);
  });

  it('an ETag conflict on every write-back warns with the ids and counts them partial', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));
    const savesBefore = saves.length;
    refuseSave = (stack) => stack === CHILD;

    const outcome = await queue.runAll({ interrupted: () => false }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(1);
    expect(saves.slice(savesBefore)).toHaveLength(PERSIST_DROPPED_ATTEMPTS);
    expect(outcome.updatePartial).toBe(1);
    expect(
      printed.warn.some(
        (l) => l.includes(`the state of nested stack ${CHILD}`) && l.includes('CRev (CRev-old)')
      )
    ).toBe(true);
  });

  it('a root whose outputs fail sends none of the cleanup deletes', async () => {
    const root = makeEngine('R');
    const child = childEngine();
    nestedRuns.set('RNest', () => deployStack(child, CHILD, 'C'));
    // Only the root's own output pass fails: the child's ran inside the DAG.
    let rootOutputs = false;
    const update = provider.update;
    provider.update = vi.fn(async (...args: Parameters<ResourceProvider['update']>) => {
      const out = await update(...args);
      if (args[0] === 'REnd') rootOutputs = true;
      return out;
    }) as unknown as ResourceProvider['update'];
    const { resolveOutputs } = await import('../../../src/deployment/deploy-engine/outputs.js');
    const real = vi.mocked(resolveOutputs).getMockImplementation()!;
    vi.mocked(resolveOutputs).mockImplementation(async (...args) => {
      if (rootOutputs) throw new Error('Output Url could not be resolved');
      return real(...args);
    });

    try {
      await expect(deployStack(root, ROOT, 'R', { nested: true })).rejects.toThrow(
        'Output Url could not be resolved'
      );
    } finally {
      vi.mocked(resolveOutputs).mockImplementation(real);
    }

    expect(order).toContain('update CEnd-id');
    expect(deletesOf('CRev-old')).toBe(0);
    expect(deletesOf('RRev-old')).toBe(0);
    expect(locks).toEqual([]);
    expect(
      printed.info.some((l) => l.includes('Old CRev (CRev-old) was not deleted: the deploy failed first'))
    ).toBe(true);
  });

  it("a cleanup pass that throws persists this deploy's resolved outputs and journals the deploy", async () => {
    const root = makeEngine('R');
    // The pass throws at its first line, after the outputs resolved.
    printed.throwOn = 'Deleting the old resource of';

    await expect(
      deployStack(root, ROOT, 'R', {
        outputs: { Url: { Value: 'https://new.example' } },
        previousOutputs: { Url: 'https://old.example', Gone: 'stale' },
      })
    ).rejects.toThrow('cleanup pass threw');

    const last = saves.filter((w) => w.stack === ROOT).at(-1)!;
    expect(last.state.outputs).toEqual({ Url: 'https://new.example' });
    expect(last.state.exportNames).toEqual([]);
    expect(last.state.resources['RRev']!.physicalId).toBe('RRev-new');
    expect(journaled.reasons).toEqual(['no-rollback-failure']);
  });

  it('an interrupted root runs no queued child cleanup', async () => {
    const child = childEngine();
    const queue = new NestedCleanupQueue();
    await withNestedCleanupQueue(queue, () => deployStack(child, CHILD, 'C'));

    await queue.runAll({ interrupted: () => true }, { info: vi.fn(), warn: vi.fn() });

    expect(deletesOf('CRev-old')).toBe(0);
    expect(locks).toEqual([]);
    expect(printed.info.some((l) => l.includes('the deploy was interrupted'))).toBe(true);
  });
});
