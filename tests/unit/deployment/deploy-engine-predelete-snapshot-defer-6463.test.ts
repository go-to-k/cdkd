/**
 * go-to-k/cdkd#6463: under `UpdateReplacePolicy: Snapshot` (without
 * `--skip-final-snapshot`), a create-first replacement of a type snapshotted
 * BEFORE its delete (`AWS::EC2::Volume`, `AWS::Redshift::Cluster`,
 * `AWS::ElastiCache::ReplicationGroup`) defers the old copy's delete to the
 * cleanup phase, and the snapshot moves into that deferred delete: none is
 * taken before the create, the cleanup phase snapshots and then deletes, the
 * recorded `supersededResources` entry lets a later run take the same
 * snapshot first, and a failed deploy's rollback re-adopts the old copy with
 * no snapshot taken. A delete-first replacement still snapshots first.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { retryCarriedSupersededResources } from '../../../src/deployment/deploy-engine/superseded-retry.js';
import {
  createFirstThenDeleteOld,
  deleteReplacedAfterCreate,
  replaceDeleteFirstAndRecreate,
  retryDeferredReplacedDeletes,
} from '../../../src/deployment/deploy-engine/replacement.js';
import {
  deleteSupersededEntry,
  supersededResourcesOf,
} from '../../../src/deployment/superseded-resources.js';
import { secretNameBagFor } from '../../../src/deployment/deploy-engine/masking.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction/log-only.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor.js';
import type {
  ResourceChange,
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
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

const GLOBAL_CLIENTS = vi.hoisted(() => ({ which: 'global' }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => GLOBAL_CLIENTS,
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

/** Every AWS-side step, in order: `create`, `update`, `snapshot`, `delete`. */
const order = vi.hoisted(() => [] as string[]);
const snapshotFails = vi.hoisted(() => ({ ids: new Set<string>() }));
const snapshot = vi.hoisted(() =>
  vi.fn(
    async (
      _type: string,
      physicalId: string,
      _logicalId: string,
      _clients: unknown,
      _logger?: unknown,
      _options?: unknown
    ) => {
    order.push(`snapshot ${physicalId}`);
    if (snapshotFails.ids.has(physicalId)) throw new Error('SnapshotQuotaExceeded: too many');
    return `snap-of-${physicalId}`;
    }
  )
);
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPreDeleteFinalSnapshot: snapshot,
}));

const journalTap = vi.hoisted(() => ({ push: (_ops: unknown): void => {} }));
vi.mock('../../../src/deployment/deploy-engine/rollback.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/deploy-engine/rollback.js')>();
  return {
    ...actual,
    writeRollbackJournalSegment: vi.fn(
      async (...args: Parameters<typeof actual.writeRollbackJournalSegment>) => {
        journalTap.push(structuredClone(args[2]));
        return actual.writeRollbackJournalSegment(...args);
      }
    ),
  };
});

const VOLUME = 'AWS::EC2::Volume';
const PRE_DELETE_TYPES = [
  ['AWS::EC2::Volume'],
  ['AWS::Redshift::Cluster'],
  ['AWS::ElastiCache::ReplicationGroup'],
] as const;
const ATTACHMENT = 'AWS::EC2::VolumeAttachment';

let provider: ResourceProvider;
let live: Set<string>;
let attachmentFails: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  printed.info.length = 0;
  printed.warn.length = 0;
  order.length = 0;
  snapshotFails.ids = new Set();
  attachmentFails = false;
  live = new Set(['vol-old']);
  provider = {
    create: vi.fn(async () => {
      live.add('vol-new');
      order.push('create vol-new');
      return { physicalId: 'vol-new', attributes: {} };
    }),
    update: vi.fn(async (_logicalId: string, physicalId: string) => {
      order.push(`update ${physicalId}`);
      if (attachmentFails) throw new Error('ValidationException: attachment update rejected');
      return { physicalId, wasReplaced: false, attributes: {} };
    }),
    delete: vi.fn(async (_logicalId: string, physicalId: string) => {
      order.push(`delete ${physicalId}`);
      live.delete(physicalId);
      return undefined;
    }),
    readCurrentState: vi.fn(async (physicalId: string) =>
      live.has(physicalId) ? { Size: 1 } : RESOURCE_NOT_FOUND
    ),
    getAttribute: vi.fn(),
    disableOuterRetry: true,
  } as unknown as ResourceProvider;
});

const steps = (): string[] => order.filter((o) => o !== 'save');
const deleteContexts = (id: string): Record<string, unknown>[] =>
  vi
    .mocked(provider.delete)
    .mock.calls.filter((c) => c[1] === id)
    .map((c) => c[4] as unknown as Record<string, unknown>);

describe('a deploy replacing a pre-delete-snapshot type under UpdateReplacePolicy: Snapshot (go-to-k/cdkd#6463)', () => {
  let journaled: CompletedOperation[][];
  let saved: StackState[];

  beforeEach(() => {
    journaled = [];
    saved = [];
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const engine = new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn(async (_stack: string, _region: string, state: StackState) => {
          saved.push(structuredClone(state));
          order.push('save');
          return 'etag';
        }),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Attachment' ? ['Vol'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback: true, forceStatefulRecreation: true, ...options } as never,
      'us-east-1'
    );
    journalTap.push = (ops) => journaled.push(ops as CompletedOperation[]);
    return engine;
  }

  async function deploy(
    engine: DeployEngine,
    /** `null`: no `UpdateReplacePolicy` on the template. */
    updateReplacePolicy: string | null = 'Snapshot'
  ): Promise<{ completedOperations: CompletedOperation[]; state: StackState }> {
    const template = {
      Resources: {
        Vol: {
          Type: VOLUME,
          Properties: { AvailabilityZone: 'us-east-1b', Size: 1 },
          ...(updateReplacePolicy !== null && { UpdateReplacePolicy: updateReplacePolicy }),
        },
        Attachment: { Type: ATTACHMENT, Properties: { VolumeId: 'vol-new' } },
      },
    } as unknown as CloudFormationTemplate;
    const record = (physicalId: string, resourceType: string, properties: Record<string, unknown>) =>
      ({
        physicalId,
        resourceType,
        properties,
        attributes: {},
        dependencies: [],
        provisionedBy: 'cc-api',
      }) as ResourceState;
    const currentState = {
      version: 12,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Vol: record('vol-old', VOLUME, { AvailabilityZone: 'us-east-1a', Size: 1 }),
        Attachment: record('att', ATTACHMENT, { VolumeId: 'vol-old' }),
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Vol',
        {
          logicalId: 'Vol',
          changeType: 'UPDATE',
          resourceType: VOLUME,
          currentProperties: { AvailabilityZone: 'us-east-1a', Size: 1 },
          desiredProperties: { AvailabilityZone: 'us-east-1b', Size: 1 },
          propertyChanges: [
            {
              path: 'AvailabilityZone',
              oldValue: 'us-east-1a',
              newValue: 'us-east-1b',
              requiresReplacement: true,
            },
          ],
        } as unknown as ResourceChange,
      ],
      [
        'Attachment',
        {
          logicalId: 'Attachment',
          changeType: 'UPDATE',
          resourceType: ATTACHMENT,
          currentProperties: { VolumeId: 'vol-old' },
          desiredProperties: { VolumeId: 'vol-new' },
          propertyChanges: [
            { path: 'VolumeId', oldValue: 'vol-old', newValue: 'vol-new', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ],
    ]);
    return (await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      [['Vol'], ['Attachment']],
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    )) as unknown as { completedOperations: CompletedOperation[]; state: StackState };
  }

  it('takes no snapshot before the create; the cleanup phase snapshots the old volume once, then deletes it', async () => {
    const pinned = { which: 'pinned' };
    const result = await deploy(makeEngine({ finalSnapshotClients: pinned }));

    expect(steps()).toEqual(['create vol-new', 'update att', 'snapshot vol-old', 'delete vol-old']);
    expect(snapshot).toHaveBeenCalledTimes(1);
    // The engine's region-pinned clients, never the process-global ones.
    expect(snapshot.mock.calls[0]![3]).toBe(pinned);
    // The delete itself carries no identifier: a Cloud Control delete refuses one.
    expect(deleteContexts('vol-old')[0]).not.toHaveProperty('finalSnapshotIdentifier');
    expect(deleteContexts('vol-old')[0]!['deletionPolicy']).toBe('Snapshot');
    // Kept in state at the row's save, marking the snapshot as still owed.
    const rowSave = saved.find((s) => s.resources['Vol']?.physicalId === 'vol-new')!;
    const [entry] = supersededResourcesOf(rowSave);
    expect(entry!.state.physicalId).toBe('vol-old');
    expect(entry!.updateReplacePolicy).toBe('Snapshot');
    expect(entry!.finalSnapshotIdentifier).toEqual(expect.stringContaining('vol-old'));
    expect(entry).not.toHaveProperty('skipFinalSnapshot');
    expect(supersededResourcesOf(result.state)).toEqual([]);
  });

  it('a failed deploy re-adopts the old volume whole and takes no snapshot of it', async () => {
    attachmentFails = true;

    await expect(deploy(makeEngine({ noRollback: false }))).rejects.toThrow();

    expect(snapshot).not.toHaveBeenCalled();
    expect(deleteContexts('vol-old')).toEqual([]);
    const volOp = journaled[0]!.find((o) => o.logicalId === 'Vol')!;
    expect(volOp.oldResourceMaySurvive).toBe('deferred');
    // Only the new copy is deleted, plainly: the rollback's delete of a
    // pre-delete-snapshot type's new copy takes no snapshot
    // (`rollbackFinalSnapshotId`, rollback-executor/messages.ts).
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['vol-new']);
    expect(deleteContexts('vol-new')[0]).not.toHaveProperty('finalSnapshotIdentifier');
    expect([...live]).toEqual(['vol-old']);
    expect(saved.at(-1)!.resources['Vol']!.physicalId).toBe('vol-old');
    expect(saved.at(-1)!.supersededResources).toBeUndefined();
  });

  it('--skip-final-snapshot is unchanged: deferred, no snapshot anywhere, no identifier', async () => {
    await deploy(makeEngine({ skipFinalSnapshot: true }));

    expect(steps()).toEqual(['create vol-new', 'update att', 'delete vol-old']);
    expect(snapshot).not.toHaveBeenCalled();
    expect(deleteContexts('vol-old')[0]).not.toHaveProperty('finalSnapshotIdentifier');
    expect(deleteContexts('vol-old')[0]!['skipFinalSnapshot']).toBe(true);
    const rowSave = saved.find((s) => s.resources['Vol']?.physicalId === 'vol-new')!;
    const [entry] = supersededResourcesOf(rowSave);
    expect(entry).not.toHaveProperty('finalSnapshotIdentifier');
    expect(entry!.skipFinalSnapshot).toBe(true);
  });

  it('UpdateReplacePolicy absent: deferred with no snapshot, as before', async () => {
    await deploy(makeEngine(), null);

    expect(steps()).toEqual(['create vol-new', 'update att', 'delete vol-old']);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('the deferred delete of a pre-delete-snapshot type (go-to-k/cdkd#6463)', () => {
  function inDeploy(options: Record<string, unknown> = {}) {
    const engine = new DeployEngine(
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      { concurrency: 1, ...options } as never,
      'us-east-1'
    );
    const run = engine.replacementRun;
    run.deferredReplacedDeletes = new Map();
    const host: Pick<StackState, 'supersededResources'> = {};
    run.supersededHost = host;
    return { engine, run, host };
  }

  const MARK = 'vol-old-final-20261117-000000';

  function replaceDelete(
    engine: DeployEngine,
    old: ResourceState,
    /** `null`: no owed-snapshot mark. */
    mark: string | null = MARK,
    newHoldsOldIdAndType = false
  ): Promise<void> {
    return deleteReplacedAfterCreate(
      engine.replacementRun,
      engine.replacementDeps(),
      'Vol',
      old.resourceType,
      old,
      provider,
      old.properties,
      mark ?? undefined,
      'Snapshot',
      new Map(),
      'cc-api',
      undefined,
      false,
      newHoldsOldIdAndType
    );
  }

  const oldOf = (type: string): ResourceState =>
    ({ physicalId: 'vol-old', resourceType: type, properties: {} }) as unknown as ResourceState;

  it.each(PRE_DELETE_TYPES)(
    '%s: an owed snapshot defers the delete, and the cleanup phase snapshots before it deletes',
    async (type) => {
      const { engine, run, host } = inDeploy();

      await replaceDelete(engine, oldOf(type));

      expect(snapshot).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(run.replacedOldMaySurvive.get('Vol')).toBe('deferred');
      expect(host.supersededResources?.[0]).toMatchObject({
        finalSnapshotIdentifier: MARK,
        updateReplacePolicy: 'Snapshot',
      });

      await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
        updated: 1,
        updatePartial: 0,
      });

      expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old']);
      expect(snapshot.mock.calls[0]![0]).toBe(type);
      expect(deleteContexts('vol-old')[0]).not.toHaveProperty('finalSnapshotIdentifier');
      expect(supersededResourcesOf(host)).toEqual([]);
    }
  );

  it('a failed snapshot in the cleanup phase sends no delete and keeps the entry for a later run', async () => {
    const { engine, run, host } = inDeploy();
    snapshotFails.ids.add('vol-old');

    await replaceDelete(engine, oldOf(VOLUME));
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });

    expect(steps()).toEqual(['snapshot vol-old']);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(supersededResourcesOf(host).map((e) => e.state.physicalId)).toEqual(['vol-old']);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Final snapshot for old Vol (vol-old) failed: SnapshotQuotaExceeded') &&
          l.includes('cdkd keeps it in state')
      )
    ).toBe(true);
  });

  it('an old id another record holds defers in memory; the cleanup phase snapshots first, then deletes (go-to-k/cdkd#6712)', async () => {
    const { engine, run, host } = inDeploy();
    const old = oldOf(VOLUME);
    engine.deployStateResources = {
      Vol: old,
      Other: { physicalId: 'vol-old', resourceType: VOLUME, properties: {} } as ResourceState,
    };

    await replaceDelete(engine, old);

    expect(steps()).toEqual([]);
    expect(run.deferredReplacedDeletes!.has('Vol')).toBe(true);
    expect(host.supersededResources).toBeUndefined();

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });

    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old']);
    expect(host.supersededResources).toBeUndefined();
    expect(deleteContexts('vol-old')[0]).not.toHaveProperty('finalSnapshotIdentifier');
  });

  it('a held old id whose cleanup snapshot fails names the other record, not an untracked copy', async () => {
    const { engine, run } = inDeploy();
    const old = oldOf(VOLUME);
    engine.deployStateResources = {
      Vol: old,
      Other: { physicalId: 'vol-old', resourceType: VOLUME, properties: {} } as ResourceState,
    };
    snapshotFails.ids.add('vol-old');

    await replaceDelete(engine, old);
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });

    expect(provider.delete).not.toHaveBeenCalled();
    const line = printed.warn.find((l) => l.includes('Final snapshot for old Vol'))!;
    expect(line).toContain('Another resource of this stack records the same physical id.');
    expect(line).not.toContain('no longer tracked');
  });

  it('an inline delete whose snapshot fails sends no delete and marks the old copy kept', async () => {
    const { engine, run } = inDeploy();
    snapshotFails.ids.add('vol-old');

    await replaceDelete(engine, oldOf(VOLUME), MARK, true);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(run.replacedOldMaySurvive.get('Vol')).toBe('kept');
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Final snapshot for old Vol (vol-old) failed') &&
          l.includes('it is no longer tracked in state')
      )
    ).toBe(true);
  });

  it('an inline delete that fails after its snapshot is recorded as no longer owing one', async () => {
    const { engine, run, host } = inDeploy();
    vi.mocked(provider.delete).mockImplementationOnce(async () => {
      order.push('delete vol-old (refused)');
      throw new Error('VolumeInUse: attached');
    });

    // An equal new id and type deletes inline (go-to-k/cdkd#6374).
    await replaceDelete(engine, oldOf(VOLUME), MARK, true);

    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old (refused)']);
    const [entry] = supersededResourcesOf(host);
    expect(entry!.state.physicalId).toBe('vol-old');
    expect(entry).not.toHaveProperty('finalSnapshotIdentifier');

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });
    // The retry sends the delete with no second snapshot.
    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old (refused)', 'delete vol-old']);
  });

  type SnapshotOptions = {
    refuseUnsnapshottableState?: boolean;
    reuseStartedAtOrAfter?: number;
    stop?: () => boolean;
  };
  const optionsOf = (call = 0): SnapshotOptions =>
    snapshot.mock.calls[call]![5] as SnapshotOptions;

  it('asks the snapshot to refuse an unsnapshottable old copy, reuse only one since the deferral, and stop on Ctrl-C', async () => {
    const { engine, run, host } = inDeploy();

    await replaceDelete(engine, oldOf('AWS::Redshift::Cluster'));
    // A deferral recorded well before this cleanup pass.
    const deferredAt = Date.now() - 60_000;
    run.supersededEntries.get('Vol')!.supersededAt = deferredAt;
    expect(supersededResourcesOf(host)[0]!.supersededAt).toBe(deferredAt);
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });

    const options = optionsOf();
    expect(options.refuseUnsnapshottableState).toBe(true);
    expect(options.reuseStartedAtOrAfter).toBe(deferredAt);
    expect(options.stop!()).toBe(false);
    engine.interrupted = true;
    expect(options.stop!()).toBe(true);
  });

  it("an in-memory deferral's cleanup snapshot reuses only one started by this attempt (go-to-k/cdkd#6712)", async () => {
    const { engine, run } = inDeploy();
    const old = oldOf(VOLUME);
    engine.deployStateResources = {
      Vol: old,
      Other: { physicalId: 'vol-old', resourceType: VOLUME, properties: {} } as ResourceState,
    };

    await replaceDelete(engine, old);
    const before = Date.now();
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', { updated: 1, updatePartial: 0 });

    // No superseded entry carries a deferral time, so the bound is this attempt's start.
    const bound = optionsOf().reuseStartedAtOrAfter!;
    expect(bound).toBeGreaterThanOrEqual(before);
    expect(bound).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['held', true, 'Another resource of this stack records the same physical id.'],
    ['untracked', false, 'Delete it manually once you have a snapshot; it is no longer tracked in state.'],
  ] as const)(
    'an interrupted retry with no kept entry names who tracks the old copy (%s)',
    async (_label, held, remedy) => {
      const { engine, run } = inDeploy();
      const old = oldOf(VOLUME);
      engine.deployStateResources = {
        Vol: old,
        ...(held && {
          Other: { physicalId: 'vol-old', resourceType: VOLUME, properties: {} } as ResourceState,
        }),
      };
      engine.interrupted = true;

      await deleteReplacedAfterCreate(
        run,
        engine.replacementDeps(),
        'Vol',
        VOLUME,
        old,
        provider,
        {},
        MARK,
        'Snapshot',
        new Map(),
        'cc-api',
        undefined,
        true
      );

      expect(snapshot).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      const line = printed.warn.find((l) => l.includes('was interrupted before its final snapshot'))!;
      expect(line.endsWith(remedy)).toBe(true);
    }
  );

  it('a cleanup delete failing after its snapshot keeps the entry with no owed snapshot left', async () => {
    const { engine, run, host } = inDeploy();
    vi.mocked(provider.delete).mockImplementationOnce(async () => {
      order.push('delete vol-old (refused)');
      throw new Error('InvalidParameterValue: still attached');
    });

    await replaceDelete(engine, oldOf('AWS::Redshift::Cluster'));
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });

    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old (refused)']);
    const [entry] = supersededResourcesOf(host);
    expect(entry!.state.physicalId).toBe('vol-old');
    expect(entry).not.toHaveProperty('finalSnapshotIdentifier');
    expect(entry!.updateReplacePolicy).toBe('Snapshot');
    expect(printed.warn.some((l) => l.includes('cdkd keeps it in state'))).toBe(true);
  });

  it('an interrupted cleanup pass starts no snapshot and keeps the owed entry', async () => {
    const { engine, run, host } = inDeploy();
    await replaceDelete(engine, oldOf(VOLUME));
    const retry = run.deferredReplacedDeletes!.get('Vol')!.retry;
    engine.interrupted = true;

    await retry();

    expect(snapshot).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(supersededResourcesOf(host)[0]!.finalSnapshotIdentifier).toBe(MARK);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Old Vol (vol-old) was not deleted: the deploy was interrupted before its final snapshot') &&
          l.includes('cdkd keeps it in state')
      )
    ).toBe(true);
  });

  it('a failed cleanup snapshot leaves the old copy marked deferred', async () => {
    const { engine, run } = inDeploy();
    snapshotFails.ids.add('vol-old');

    await replaceDelete(engine, oldOf(VOLUME));
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });

    expect(run.replacedOldMaySurvive.get('Vol')).toBe('deferred');
  });

  it.each([
    ['inline', true],
    ['in the cleanup phase', false],
  ] as const)('masks a secret in a failed snapshot warning (%s)', async (_label, inline) => {
    const { engine, run } = inDeploy();
    const secrets = new Map<string, string>();
    recordLogOnlyValue(secrets, 's3cr3t-6463');
    snapshot.mockImplementationOnce(async () => {
      throw new Error('AccessDenied: role/deployer/s3cr3t-6463 is not authorized');
    });

    await deleteReplacedAfterCreate(
      run,
      engine.replacementDeps(),
      'Vol',
      VOLUME,
      oldOf(VOLUME),
      provider,
      {},
      MARK,
      'Snapshot',
      secrets,
      'cc-api',
      undefined,
      false,
      inline
    );
    if (!inline) {
      await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
        updated: 1,
        updatePartial: 0,
      });
    }

    const line = printed.warn.find((l) => l.includes('Final snapshot for old Vol'));
    expect(line).toContain('is not authorized');
    expect(line).not.toContain('s3cr3t-6463');
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('with no owed mark (a caller that took the snapshot already) the delete stays inline', async () => {
    const { engine, run } = inDeploy();

    await replaceDelete(engine, oldOf(VOLUME), null);

    expect(steps()).toEqual(['delete vol-old']);
    expect(run.deferredReplacedDeletes!.size).toBe(0);
  });
});

describe('a later run deletes a recorded pre-delete-snapshot entry (go-to-k/cdkd#6463)', () => {
  const clients = { which: 'stack-region' };
  const logger = { info: vi.fn(), debug: vi.fn() };

  const entryOf = (
    type: string,
    extra: Partial<SupersededResourceRecord> = {}
  ): SupersededResourceRecord => ({
    logicalId: 'Vol',
    supersededAt: 1,
    state: { physicalId: 'vol-old', resourceType: type, properties: {}, attributes: {} },
    updateReplacePolicy: 'Snapshot',
    finalSnapshotIdentifier: 'vol-old-final-20261117-000000',
    ...extra,
  });

  const send = (entry: SupersededResourceRecord, withSnapshotInput = true) =>
    deleteSupersededEntry(entry, {
      provider,
      region: 'us-east-1',
      maskSecrets: (t) => t,
      stop: () => false,
      once: true,
      ...(withSnapshotInput && { preDeleteSnapshot: { clients: clients as never, logger } }),
    });

  it.each(PRE_DELETE_TYPES)('%s: takes the snapshot from the entry, then deletes', async (type) => {
    const outcome = await send(entryOf(type));

    expect(outcome).toEqual({ kind: 'deleted' });
    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old']);
    expect(snapshot.mock.calls[0]!.slice(0, 4)).toEqual([type, 'vol-old', 'Vol', clients]);
    expect(deleteContexts('vol-old')[0]).not.toHaveProperty('finalSnapshotIdentifier');
    expect(deleteContexts('vol-old')[0]!['deletionPolicy']).toBe('Snapshot');
  });

  it('asks the snapshot to refuse an unsnapshottable copy', async () => {
    await send(entryOf('AWS::ElastiCache::ReplicationGroup'));

    const options = snapshot.mock.calls[0]![5] as {
      refuseUnsnapshottableState?: boolean;
      reuseStartedAtOrAfter?: number;
      stop?: () => boolean;
    };
    expect(options.refuseUnsnapshottableState).toBe(true);
    // The entry's `supersededAt`: a snapshot started since the deferral.
    expect(options.reuseStartedAtOrAfter).toBe(1);
    expect(options.stop!()).toBe(false);
  });

  it('an entry with no readable supersededAt reuses only a snapshot this attempt started', async () => {
    const before = Date.now();
    await send(entryOf(VOLUME, { supersededAt: Number.NaN }));
    const bound = (snapshot.mock.calls[0]![5] as { reuseStartedAtOrAfter?: number })
      .reuseStartedAtOrAfter!;
    expect(bound).toBeGreaterThanOrEqual(before);
    expect(bound).toBeLessThanOrEqual(Date.now());
  });

  it("threads the run's stop into the snapshot wait", async () => {
    let stopped = false;
    await deleteSupersededEntry(entryOf(VOLUME), {
      provider,
      region: 'us-east-1',
      maskSecrets: (t) => t,
      stop: () => stopped,
      once: true,
      preDeleteSnapshot: { clients: clients as never, logger },
    });
    const stop = (snapshot.mock.calls[0]![5] as { stop?: () => boolean }).stop!;
    expect(stop()).toBe(false);
    stopped = true;
    expect(stop()).toBe(true);
  });

  it('a stopped run starts no snapshot and fails the entry, unsent', async () => {
    const outcome = await deleteSupersededEntry(entryOf(VOLUME), {
      provider,
      region: 'us-east-1',
      maskSecrets: (t) => t,
      stop: () => true,
      once: true,
      preDeleteSnapshot: { clients: clients as never, logger },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({ message: expect.stringContaining('interrupted') }),
    });
    expect(outcome).not.toHaveProperty('replacement');
    expect(snapshot).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('a delete failing after the snapshot hands back the entry with no owed snapshot', async () => {
    vi.mocked(provider.delete).mockRejectedValueOnce(new Error('InvalidClusterState: busy'));

    const outcome = await send(entryOf('AWS::Redshift::Cluster'));

    expect(outcome.kind).toBe('failed');
    const replacement = (outcome as { replacement?: SupersededResourceRecord }).replacement;
    expect(replacement).toBeDefined();
    expect(replacement).not.toHaveProperty('finalSnapshotIdentifier');
    expect(replacement!.updateReplacePolicy).toBe('Snapshot');
    expect(replacement!.state.physicalId).toBe('vol-old');
  });

  it('a failed delete of an entry that owed no snapshot hands back no replacement', async () => {
    vi.mocked(provider.delete).mockRejectedValueOnce(new Error('busy'));

    const outcome = await send(entryOf(VOLUME, { finalSnapshotIdentifier: undefined }));

    expect(outcome).not.toHaveProperty('replacement');
  });

  it('a failed snapshot fails the entry, unsent', async () => {
    snapshotFails.ids.add('vol-old');

    const outcome = await send(entryOf(VOLUME));

    expect(outcome.kind).toBe('failed');
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('without the snapshot input it fails, unsent, rather than delete unsnapshotted', async () => {
    const outcome = await send(entryOf(VOLUME), false);

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({
        code: 'FINAL_SNAPSHOT_FAILED',
        message: expect.stringContaining('The resource was NOT deleted'),
      }),
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['an entry recorded after its snapshot (no mark)', { finalSnapshotIdentifier: undefined }],
    ['an entry recorded under --skip-final-snapshot', { skipFinalSnapshot: true as const }],
  ])('%s takes no snapshot', async (_label, extra) => {
    await send(entryOf(VOLUME, extra));

    expect(snapshot).not.toHaveBeenCalled();
    expect(steps()).toEqual(['delete vol-old']);
    // The mark (kept here under the skip consent) never reaches the delete:
    // a Cloud Control delete refuses a final-snapshot identifier.
    expect(deleteContexts('vol-old')[0]).not.toHaveProperty('finalSnapshotIdentifier');
  });

  it('an atomic type still hands its identifier to the delete, with no pre-delete snapshot', async () => {
    await send(entryOf('AWS::RDS::DBInstance'));

    expect(snapshot).not.toHaveBeenCalled();
    expect(deleteContexts('vol-old')[0]!['finalSnapshotIdentifier']).toBe(
      'vol-old-final-20261117-000000'
    );
  });

  it("the next deploy's superseded retry snapshots with the engine's pinned clients first", async () => {
    const pinned = { which: 'pinned' };
    const engine = new DeployEngine(
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
      } as unknown as never,
      { concurrency: 1, finalSnapshotClients: pinned } as never,
      'us-east-1'
    );
    const entry = entryOf(VOLUME);
    const host: Pick<StackState, 'supersededResources'> = { supersededResources: [entry] };

    const changed = await retryCarriedSupersededResources(engine, host, [entry], {});

    expect(changed).toBe(true);
    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old']);
    expect(snapshot.mock.calls[0]![3]).toBe(pinned);
    expect(supersededResourcesOf(host)).toEqual([]);
  });

  it('a next deploy whose delete fails after the snapshot keeps the entry owing none, so the one after takes no second', async () => {
    const engine = new DeployEngine(
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
      } as unknown as never,
      { concurrency: 1 } as never,
      'us-east-1'
    );
    vi.mocked(provider.delete).mockRejectedValueOnce(new Error('InvalidClusterState: busy'));
    const entry = entryOf('AWS::Redshift::Cluster');
    const host: Pick<StackState, 'supersededResources'> = { supersededResources: [entry] };

    expect(await retryCarriedSupersededResources(engine, host, [entry], {})).toBe(true);
    const [kept] = supersededResourcesOf(host);
    expect(kept).not.toHaveProperty('finalSnapshotIdentifier');
    expect(kept!.state.physicalId).toBe('vol-old');

    await retryCarriedSupersededResources(engine, host, [kept!], {});
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(supersededResourcesOf(host)).toEqual([]);
  });

  it("routes the next deploy's snapshot lines through the row's name bag", async () => {
    const engine = new DeployEngine(
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
      } as unknown as never,
      { concurrency: 1 } as never,
      'us-east-1'
    );
    recordLogOnlyValue(secretNameBagFor(engine.secretsRun, 'Vol'), 's3cr3t-6463');
    snapshot.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as { info(m: string): void }).info('Creating final snapshot for s3cr3t-6463-vol');
      return 'snap-1';
    });
    const entry = entryOf(VOLUME);

    await retryCarriedSupersededResources(engine, { supersededResources: [entry] }, [entry], {});

    expect(printed.info).toContain('Creating final snapshot for ***-vol');
    expect(printed.info.join('\n')).not.toContain('s3cr3t-6463');
  });

  it('a failed snapshot on the next deploy keeps the entry, warned', async () => {
    snapshotFails.ids.add('vol-old');
    const engine = new DeployEngine(
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
      } as unknown as never,
      { concurrency: 1 } as never,
      'us-east-1'
    );
    const entry = entryOf(VOLUME);
    const host: Pick<StackState, 'supersededResources'> = { supersededResources: [entry] };

    await retryCarriedSupersededResources(engine, host, [entry], {});

    expect(provider.delete).not.toHaveBeenCalled();
    expect(snapshot.mock.calls[0]![3]).toBe(GLOBAL_CLIENTS);
    expect(host.supersededResources).toEqual([entry]);
    expect(printed.warn.some((l) => l.includes('cdkd keeps it in state'))).toBe(true);
  });
});

describe('the name-change create-first takes no snapshot before its create (go-to-k/cdkd#6463)', () => {
  it('defers the delete with the snapshot owed, and the cleanup phase takes it', async () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { concurrency: 1, forceStatefulRecreation: true } as never,
      'us-east-1'
    );
    const run = engine.replacementRun;
    run.deferredReplacedDeletes = new Map();
    const host: Pick<StackState, 'supersededResources'> = {};
    run.supersededHost = host;
    const deps = {
      ...engine.replacementDeps(),
      guardedReplacementCreate: (_input: unknown, fn: () => Promise<unknown>) => fn(),
      withRetry: (fn: () => Promise<unknown>) => fn(),
    };
    const old = {
      physicalId: 'vol-old',
      resourceType: VOLUME,
      properties: {},
      attributes: {},
    } as unknown as ResourceState;

    await createFirstThenDeleteOld(run, deps as never, {
      logicalId: 'Vol',
      resourceType: VOLUME,
      oldResourceType: VOLUME,
      currentResource: old,
      createProvider: provider,
      createProps: {},
      deleteProvider: provider,
      deleteProvisionedBy: 'cc-api',
      deleteProperties: {},
      secrets: new Map(),
      change: {} as never,
      equalIdIsSameResource: true,
      snapshotPolicy: 'Snapshot',
      deletePolicy: 'Snapshot',
      trigger: 'test',
      stackName: 'MyStack',
      createdVia: 'cc-api',
      resolvedProps: {},
    });

    expect(steps()).toEqual(['create vol-new']);
    expect(supersededResourcesOf(host)[0]!.finalSnapshotIdentifier).toEqual(
      expect.stringContaining('vol-old')
    );

    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });
    expect(steps()).toEqual(['create vol-new', 'snapshot vol-old', 'delete vol-old']);
  });
});

describe('a delete-first replacement is unchanged (go-to-k/cdkd#6463)', () => {
  it('still snapshots, then deletes, before the create, inside a deploy', async () => {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getProviderFor: vi.fn() } as never,
      { concurrency: 1, forceStatefulRecreation: true, replace: true } as never,
      'us-east-1'
    );
    engine.replacementRun.deferredReplacedDeletes = new Map();
    await replaceDeleteFirstAndRecreate(
      engine.replacementRun,
      engine.replacementDeps(),
      'Vol',
      VOLUME,
      VOLUME,
      { physicalId: 'vol-old', resourceType: VOLUME, properties: {}, attributes: {} },
      provider,
      provider,
      {},
      new Map(),
      'Snapshot',
      'cc-api',
      undefined
    );

    expect(steps()).toEqual(['snapshot vol-old', 'delete vol-old', 'create vol-new']);
    expect(engine.replacementRun.deferredReplacedDeletes.size).toBe(0);
  });
});
