/**
 * go-to-k/cdkd#6374: a create-first replacement's delete of the OLD resource
 * waits for the deploy's cleanup phase, as CloudFormation deletes replaced
 * resources only after every other change succeeded. A failed deploy never
 * sends it, journals `oldResourceMaySurvive: 'deferred'`, and the automatic
 * rollback re-adopts the old resource it finds whole. go-to-k/cdkd#6445: a
 * record holding a NoEcho mask, and an `UpdateReplacePolicy: Snapshot` whose
 * delete call takes the snapshot, defer too; the cases that stay inline are in
 * `deploy-engine-replaced-delete-6445.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { supersededResourcesOf } from '../../../src/deployment/superseded-resources.js';
import {
  deleteReplacedAfterCreate,
  retryDeferredReplacedDeletes,
  warnUnretriedReplacedDeletes,
} from '../../../src/deployment/deploy-engine/replacement.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { markCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

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

// Each journal segment the engine writes, as a clone taken before the write.
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

/** A type `canRecordSuperseded` accepts: its delete is deferred. */
const REVISION = 'AWS::Lambda::WebFunctionRevision';
const ENDPOINT = 'AWS::Lambda::WebFunctionEndpoint';

function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('a create-first replacement deletes the old resource in the cleanup phase (go-to-k/cdkd#6374)', () => {
  let provider: ResourceProvider;
  let endpointFails: boolean;
  /** Ids whose delete AWS refuses, with the error it throws. */
  let refuse: Map<string, () => Error>;
  let live: Set<string>;
  let order: string[];
  let journaled: CompletedOperation[][];
  let saved: StackState[];

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    endpointFails = false;
    refuse = new Map();
    live = new Set(['rev-old']);
    order = [];
    journaled = [];
    saved = [];
    provider = {
      create: vi.fn(async () => {
        live.add('rev-new');
        order.push('create rev-new');
        return { physicalId: 'rev-new', attributes: {} };
      }),
      update: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`update ${physicalId}`);
        if (endpointFails) throw new Error('ValidationException: endpoint update rejected');
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`delete ${physicalId}`);
        const refusal = refuse.get(physicalId);
        if (refusal !== undefined) throw refusal();
        live.delete(physicalId);
        return undefined;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? { FunctionName: 'todo-api' } : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
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
        getDirectDependencies: (_d: unknown, id: string) =>
          id === 'Endpoint' || id === 'Orphan' ? ['Revision'] : [],
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback: true, ...options } as never,
      'us-east-1'
    );
    journalTap.push = (ops) => journaled.push(ops as CompletedOperation[]);
    return engine;
  }

  async function deploy(
    opts: {
      engine?: DeployEngine;
      revisionType?: string;
      oldRecord?: Partial<ResourceState>;
      updateReplacePolicy?: string;
      /** go-to-k/cdkd#6621: a CREATE beside Endpoint (a bucket policy). */
      orphanCreate?: boolean;
      /** go-to-k/cdkd#6712: Endpoint is recorded under the old revision's id (a queue policy's shape). */
      endpointHoldsOldId?: boolean;
    } = {}
  ): Promise<{ completedOperations: CompletedOperation[]; state: StackState }> {
    const engine = opts.engine ?? makeEngine();
    const type = opts.revisionType ?? REVISION;
    const template = {
      Resources: {
        Revision: {
          Type: type,
          Properties: { FunctionName: 'todo-api', Code: 'v2' },
          ...(opts.updateReplacePolicy !== undefined && {
            UpdateReplacePolicy: opts.updateReplacePolicy,
          }),
        },
        Endpoint: { Type: ENDPOINT, Properties: { FunctionName: 'todo-api', RevisionId: 'rev-new' } },
        ...(opts.orphanCreate === true && {
          Orphan: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: 'rev-new' } },
        }),
      },
    } as unknown as CloudFormationTemplate;
    const record = (physicalId: string, resourceType: string, properties: Record<string, unknown>) =>
      ({
        physicalId,
        resourceType,
        properties,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      }) as ResourceState;
    const currentState = {
      version: 12,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Revision: {
          ...record('rev-old', type, { FunctionName: 'todo-api', Code: 'v1' }),
          ...opts.oldRecord,
        },
        Endpoint: record(opts.endpointHoldsOldId === true ? 'rev-old' : 'prod', ENDPOINT, {
          FunctionName: 'todo-api',
          RevisionId: 'rev-old',
        }),
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Revision',
        {
          logicalId: 'Revision',
          changeType: 'UPDATE',
          resourceType: type,
          currentProperties: { FunctionName: 'todo-api', Code: 'v1' },
          desiredProperties: { FunctionName: 'todo-api', Code: 'v2' },
          propertyChanges: [{ path: 'Code', oldValue: 'v1', newValue: 'v2', requiresReplacement: true }],
        } as unknown as ResourceChange,
      ],
      [
        'Endpoint',
        {
          logicalId: 'Endpoint',
          changeType: 'UPDATE',
          resourceType: ENDPOINT,
          currentProperties: { FunctionName: 'todo-api', RevisionId: 'rev-old' },
          desiredProperties: { FunctionName: 'todo-api', RevisionId: 'rev-new' },
          propertyChanges: [
            { path: 'RevisionId', oldValue: 'rev-old', newValue: 'rev-new', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ],
      ...(opts.orphanCreate === true
        ? ([
            [
              'Orphan',
              {
                logicalId: 'Orphan',
                changeType: 'CREATE',
                resourceType: 'AWS::S3::BucketPolicy',
                desiredProperties: { Bucket: 'rev-new' },
              } as unknown as ResourceChange,
            ],
          ] as Array<[string, ResourceChange]>)
        : []),
    ]);
    return (await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      opts.orphanCreate === true ? [['Revision'], ['Endpoint', 'Orphan']] : [['Revision'], ['Endpoint']],
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    )) as unknown as { completedOperations: CompletedOperation[]; state: StackState };
  }

  const revisionOp = (ops: CompletedOperation[]): CompletedOperation =>
    ops.find((o) => o.logicalId === 'Revision')!;
  const oldDeletes = (): number =>
    vi.mocked(provider.delete).mock.calls.filter((c) => c[1] === 'rev-old').length;

  it('a successful deploy sends the old delete only after every DAG node, then drops the mark and the record', async () => {
    const engine = makeEngine();
    let markDuringDag: unknown;
    const update = provider.update;
    provider.update = vi.fn(async (...args: Parameters<ResourceProvider['update']>) => {
      markDuringDag = engine.replacementRun.replacedOldMaySurvive.get('Revision');
      return update(...args);
    }) as unknown as ResourceProvider['update'];

    const result = await deploy({ engine });

    // The dependent's update ran first; the old revision's delete after it.
    expect(order.filter((o) => o !== 'save')).toEqual([
      'create rev-new',
      'update prod',
      'delete rev-old',
    ]);
    expect(oldDeletes()).toBe(1);
    expect(live.has('rev-old')).toBe(false);
    // `'deferred'` while the DAG ran; gone from the op once the delete landed.
    expect(markDuringDag).toBe('deferred');
    expect('oldResourceMaySurvive' in revisionOp(result.completedOperations)).toBe(false);
    // The superseded record kept until then is dropped.
    expect(supersededResourcesOf(result.state)).toEqual([]);
    expect(
      printed.info.some((l) =>
        l.includes('Old Revision (rev-old) is deleted after the rest of the deploy succeeds')
      )
    ).toBe(true);
    expect(printed.info.some((l) => l.includes('Deleting the old resource of 1 replaced resource(s)'))).toBe(
      true
    );
    expect(printed.warn).toEqual([]);
  });

  it('records the old revision on the live state at the replaced row save, before any delete (crash safety)', async () => {
    await deploy();

    const rowSave = saved.findIndex((s) => s.resources['Revision']?.physicalId === 'rev-new');
    expect(rowSave).toBeGreaterThanOrEqual(0);
    expect(
      supersededResourcesOf(saved[rowSave]).map((e) => [e.logicalId, e.state.physicalId])
    ).toEqual([['Revision', 'rev-old']]);
    // That save came before the delete was sent.
    const saves = order.map((o, i) => (o === 'save' ? i : -1)).filter((i) => i >= 0);
    expect(saves[rowSave]!).toBeLessThan(order.indexOf('delete rev-old'));
  });

  // go-to-k/cdkd#6621: a global-name type journals the generation it read at
  // the deferral, and the automatic rollback re-adopts only that generation.
  describe('a deferred bucket journals its generation (go-to-k/cdkd#6621)', () => {
    const BUCKET = 'AWS::S3::Bucket';
    const bucketEngine = (o: Record<string, unknown> = {}) =>
      makeEngine({ forceStatefulRecreation: true, ...o });
    let generation: string | undefined;
    let identityReads: string[];
    beforeEach(() => {
      generation = 'us-east-1|2026-11-01T00:00:00.000Z';
      identityReads = [];
      (provider as { replacedSurvivorIdentity?: unknown }).replacedSurvivorIdentity = vi.fn(
        async (physicalId: string) => {
          identityReads.push(physicalId);
          return live.has(physicalId)
            ? { kind: 'owned', identity: generation }
            : { kind: 'gone' };
        }
      );
    });

    it('stamps the read beside the deferred verdict', async () => {
      endpointFails = true;
      await expect(deploy({ engine: bucketEngine(), revisionType: BUCKET })).rejects.toThrow();
      const op = revisionOp(journaled[0]!);
      expect(op.oldResourceMaySurvive).toBe('deferred');
      expect(op.oldResourceIdentity).toBe('us-east-1|2026-11-01T00:00:00.000Z');
      expect(identityReads).toEqual(['rev-old']);
    });

    it('drops the generation with the verdict once the cleanup phase deleted the old bucket', async () => {
      const result = await deploy({ engine: bucketEngine(), revisionType: BUCKET });
      const op = revisionOp(result.completedOperations);
      expect(oldDeletes()).toBe(1);
      expect('oldResourceMaySurvive' in op).toBe(false);
      expect('oldResourceIdentity' in op).toBe(false);
    });

    it('stamps nothing when the read cannot name a generation', async () => {
      endpointFails = true;
      generation = undefined;
      await expect(deploy({ engine: bucketEngine(), revisionType: BUCKET })).rejects.toThrow();
      expect('oldResourceIdentity' in revisionOp(journaled[0]!)).toBe(false);
    });

    it('never reads for a type outside the table', async () => {
      endpointFails = true;
      await expect(deploy()).rejects.toThrow();
      expect('oldResourceIdentity' in revisionOp(journaled[0]!)).toBe(false);
      expect(identityReads).toEqual([]);
    });

    it('the automatic rollback re-adopts the same generation', async () => {
      endpointFails = true;
      const engine = bucketEngine({ noRollback: false });
      await expect(deploy({ engine, revisionType: BUCKET })).rejects.toThrow();
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-new']);
      expect([...live]).toEqual(['rev-old']);
      expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    });

    it('the automatic rollback judges the generation read before its replay began', async () => {
      endpointFails = true;
      generation = 'us-west-2|2026-11-01T00:00:00.000Z';
      const engine = bucketEngine({ noRollback: false });
      // Anything the replay runs once it began (here the probe's own
      // existence read; in AWS a reverted bucket policy) may write the old
      // bucket, which outside us-east-1 moves its date. Only this deploy has
      // one completed op, so the read before the replay is the one before it.
      const update = provider.update;
      let failed = false;
      provider.update = vi.fn(async (...args: Parameters<ResourceProvider['update']>) => {
        try {
          return await update(...args);
        } catch (e) {
          failed = true;
          throw e;
        }
      }) as unknown as ResourceProvider['update'];
      const read = provider.readCurrentState!;
      provider.readCurrentState = vi.fn(
        async (...args: Parameters<NonNullable<ResourceProvider['readCurrentState']>>) => {
          if (failed) generation = 'us-west-2|2026-11-02T00:00:00.000Z';
          return read(...args);
        }
      ) as unknown as ResourceProvider['readCurrentState'];
      await expect(deploy({ engine, revisionType: BUCKET })).rejects.toThrow();
      // The deferral's read, the rollback's snapshot, the probe's confirmation.
      expect(identityReads).toEqual(['rev-old', 'rev-old', 'rev-old']);
      expect([...live]).toEqual(['rev-old']);
    });

    // Review round 2: the FAILED op's revert (here an orphan bucket policy's
    // delete) runs before the completed ops; outside us-east-1 such a write
    // moves the old bucket's date, so the snapshot must precede it too.
    it("the automatic rollback judges the generation read before the failed op's revert wrote it", async () => {
      generation = 'us-west-2|2026-11-01T00:00:00.000Z';
      const engine = bucketEngine({ noRollback: false });
      const create = provider.create;
      provider.create = vi.fn(async (...args: Parameters<ResourceProvider['create']>) => {
        if (args[0] === 'Orphan') {
          throw markCreatedBeforeFailure(
            new Error('MalformedPolicy: policy rejected after create'),
            'Orphan',
            'AWS::S3::BucketPolicy',
            'orphan-pol'
          );
        }
        return create(...args);
      }) as unknown as ResourceProvider['create'];
      const del = provider.delete;
      let orphanDeleted = false;
      provider.delete = vi.fn(async (...args: Parameters<ResourceProvider['delete']>) => {
        if (args[1] === 'orphan-pol') {
          orphanDeleted = true;
          generation = 'us-west-2|2026-11-02T00:00:00.000Z';
          return undefined;
        }
        return del(...args);
      }) as unknown as ResourceProvider['delete'];
      await expect(deploy({ engine, revisionType: BUCKET, orphanCreate: true })).rejects.toThrow();
      expect(orphanDeleted).toBe(true);
      expect([...live]).toEqual(['rev-old']);
      expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    });

    it('the automatic rollback refuses another generation, deleting nothing', async () => {
      endpointFails = true;
      const engine = bucketEngine({ noRollback: false });
      // Re-created between the deferral and the rollback's read.
      const update = provider.update;
      provider.update = vi.fn(async (...args: Parameters<ResourceProvider['update']>) => {
        generation = 'us-east-1|2026-11-02T00:00:00.000Z';
        return update(...args);
      }) as unknown as ResourceProvider['update'];
      await expect(deploy({ engine, revisionType: BUCKET })).rejects.toThrow();
      expect(oldDeletes()).toBe(0);
      expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).not.toContain('rev-new');
      expect(live.has('rev-new')).toBe(true);
    });
  });

  it('a deploy failing after the replacement sends no old delete, journals deferred, and the rollback re-adopts it', async () => {
    endpointFails = true;
    const engine = makeEngine({ noRollback: false });

    await expect(deploy({ engine })).rejects.toThrow();

    expect(oldDeletes()).toBe(0);
    expect(journaled.length).toBeGreaterThanOrEqual(1);
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('deferred');
    // Re-adopted: the new revision is deleted, the old one is alive, and the
    // last save points state back at it.
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-new']);
    expect([...live]).toEqual(['rev-old']);
    expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    // Re-adopted, so no longer awaiting a delete: its superseded entry goes.
    expect(saved.at(-1)!.supersededResources).toBeUndefined();
    expect(
      printed.info.some(
        (l) =>
          l.includes('the old resource of Revision (rev-old) was not deleted yet') &&
          l.includes('re-adopting it')
      )
    ).toBe(true);
    // Nothing went wrong with the old revision: no warning names it.
    expect(printed.warn.some((l) => l.includes('rev-old'))).toBe(false);
  });

  describe('an old id another record holds (go-to-k/cdkd#6712)', () => {
    it('a successful deploy deletes it only after the holder moved, and never records it', async () => {
      const result = await deploy({ endpointHoldsOldId: true });

      expect(order.filter((o) => o !== 'save')).toEqual(['create rev-new', 'update rev-old', 'delete rev-old']);
      expect(saved.every((s) => s.supersededResources === undefined)).toBe(true);
      expect(supersededResourcesOf(result.state)).toEqual([]);
    });

    it('a deploy failing after the replacement sends no old delete, and the rollback re-adopts it', async () => {
      endpointFails = true;
      const engine = makeEngine({ noRollback: false });

      await expect(deploy({ engine, endpointHoldsOldId: true })).rejects.toThrow();

      expect(oldDeletes()).toBe(0);
      expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('deferred');
      expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-new']);
      expect([...live]).toEqual(['rev-old']);
      expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
      expect(saved.every((s) => s.supersededResources === undefined)).toBe(true);
    });
  });

  // The post-rollback save's ETag retry writes the same answer: the re-adopted
  // old revision's superseded entry is absent there too. (In this flow the
  // entry has already left the live record before that save, so this pins the
  // retry's outcome, not its `supersededAfterRollback(..., newResources)` filter.)
  it('the post-rollback ETag retry save also drops the re-adopted entry', async () => {
    endpointFails = true;
    const engine = makeEngine({ noRollback: false });
    const backend = engine.stateBackend as unknown as {
      saveState: (...args: unknown[]) => Promise<string>;
    };
    const save = backend.saveState;
    let rejected = 0;
    // The first save naming rev-old again is the post-rollback one.
    backend.saveState = vi.fn(async (...args: unknown[]) => {
      const state = args[2] as StackState;
      if (rejected === 0 && state.resources['Revision']?.physicalId === 'rev-old') {
        rejected++;
        throw awsError('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
      }
      return save(...args);
    });

    await expect(deploy({ engine })).rejects.toThrow();

    expect(rejected).toBe(1);
    // The forward deploy recorded the entry, so the retry had one to drop.
    expect(
      saved.some((s) => s.supersededResources?.some((e) => e.state.physicalId === 'rev-old'))
    ).toBe(true);
    expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    expect(saved.at(-1)!.supersededResources).toBeUndefined();
  });

  // The delete was never sent, so a read that cannot answer still re-adopts.
  it.each([
    [
      'unreadable (the type has no readCurrentState)',
      (): void => {
        delete (provider as { readCurrentState?: unknown }).readCurrentState;
      },
    ],
    [
      'unknown (the read throws)',
      (): void => {
        provider.readCurrentState = vi.fn(async () => {
          throw new Error('ThrottlingException: Rate exceeded');
        }) as unknown as ResourceProvider['readCurrentState'];
      },
    ],
  ] as const)('a failed deploy re-adopts the deferred old resource when the read is %s', async (_l, arrange) => {
    endpointFails = true;
    arrange();

    await expect(deploy({ engine: makeEngine({ noRollback: false }) })).rejects.toThrow();

    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('deferred');
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-new']);
    expect([...live]).toEqual(['rev-old']);
    expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    expect(printed.info.some((l) => l.includes('was not deleted yet') && l.includes('re-adopting it'))).toBe(
      true
    );
    expect(printed.warn.some((l) => l.includes('rev-old') || l.includes('Cannot reverse'))).toBe(false);
  });

  it('a rollback interrupted during the read still refuses the deferred op (journal kept)', async () => {
    endpointFails = true;
    const engine = makeEngine({ noRollback: false });
    // The user presses Ctrl-C while the rollback's read of the old revision
    // is running; it answers too late. (The forward deploy reads only the new one.)
    let probes = 0;
    provider.readCurrentState = vi.fn(async (physicalId: string) => {
      if (physicalId === 'rev-old') {
        probes++;
        engine.userInterrupted = true;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return live.has(physicalId) ? { FunctionName: 'todo-api' } : RESOURCE_NOT_FOUND;
    }) as unknown as ResourceProvider['readCurrentState'];

    await expect(deploy({ engine })).rejects.toThrow();

    // The rollback's survivor read ran, and was interrupted.
    expect(probes).toBe(1);
    // Neither copy is deleted, and state is not re-pointed at the old one.
    expect(oldDeletes()).toBe(0);
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).not.toContain('rev-new');
    expect([...live].sort()).toEqual(['rev-new', 'rev-old']);
    expect(printed.info.some((l) => l.includes('re-adopting it'))).toBe(false);
    // The existing refusal, unchanged by the deferral.
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Cannot reverse the replacement of Revision') &&
          l.includes('the rollback was interrupted before cdkd could read whether it does')
      )
    ).toBe(true);
  });

  it.each([
    ['kept', () => awsError('AccessDenied', 'not authorized to perform: DeleteRevision')],
    ['unconfirmed', () => new Error('Timed out waiting for the revision to be deleted')],
  ] as const)(
    're-stamps the journaled verdict (%s) when the cleanup-phase delete fails',
    async (verdict, error) => {
      refuse.set('rev-old', error);

      const result = await deploy();

      expect(oldDeletes()).toBe(1);
      expect(order.indexOf('delete rev-old')).toBeGreaterThan(order.indexOf('update prod'));
      expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe(verdict);
      expect(
        printed.warn.some((l) => l.includes('Failed to delete old resource Revision (rev-old)'))
      ).toBe(true);
    }
  );

  // go-to-k/cdkd#6445 case 1, tier (a): a NoEcho mask on a record whose delete
  // reads no NoEcho value defers like any other, and is kept in state.
  it('defers a record holding a NoEcho mask, and records it in state with its mask positions', async () => {
    const result = await deploy({ oldRecord: { noEchoLeaves: [['Code']] } });

    expect(order.filter((o) => o !== 'save')).toEqual([
      'create rev-new',
      'update prod',
      'delete rev-old',
    ]);
    const rowSave = saved.find((s) => s.resources['Revision']?.physicalId === 'rev-new')!;
    const entries = supersededResourcesOf(rowSave);
    expect(entries.map((e) => [e.logicalId, e.state.physicalId])).toEqual([['Revision', 'rev-old']]);
    expect(entries[0]!.state.noEchoLeaves).toEqual([['Code']]);
    // The deferred delete is handed the mask positions, as the inline one was.
    expect(vi.mocked(provider.delete).mock.calls[0]![4]).toHaveProperty('recordedNoEchoLeaves', [['Code']]);
    expect(supersededResourcesOf(result.state)).toEqual([]);
  });

  it('a failed deploy re-adopts a deferred record holding a NoEcho mask (go-to-k/cdkd#6445)', async () => {
    endpointFails = true;

    await expect(
      deploy({ engine: makeEngine({ noRollback: false }), oldRecord: { noEchoLeaves: [['Code']] } })
    ).rejects.toThrow();

    expect(oldDeletes()).toBe(0);
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('deferred');
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-new']);
    expect([...live]).toEqual(['rev-old']);
    expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    expect(saved.at(-1)!.resources['Revision']!.noEchoLeaves).toEqual([['Code']]);
    expect(saved.at(-1)!.supersededResources).toBeUndefined();
  });

  // go-to-k/cdkd#6445 case 1, tier (b): a custom resource holding a NoEcho
  // mask is deferred in memory only, so state lists no superseded entry; the
  // in-process rollback still re-adopts it, even with no read to answer.
  it('a failed deploy re-adopts an in-memory deferred custom resource holding a NoEcho mask, sending it no Delete', async () => {
    endpointFails = true;
    delete (provider as { readCurrentState?: unknown }).readCurrentState;

    await expect(
      deploy({
        engine: makeEngine({ noRollback: false }),
        revisionType: 'Custom::Revision',
        oldRecord: { noEchoLeaves: [['Code']] },
      })
    ).rejects.toThrow();

    expect(oldDeletes()).toBe(0);
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('deferred');
    // Never in state, at any save.
    expect(saved.every((s) => supersededResourcesOf(s).length === 0)).toBe(true);
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-new']);
    expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    expect(printed.info.some((l) => l.includes('was not deleted yet') && l.includes('re-adopting it'))).toBe(
      true
    );
  });

  // go-to-k/cdkd#6445 case 1, tier (b), the nested-stack arm: a nested stack
  // hands its child the NoEcho delete values, so it defers in memory too.
  it('a replaced nested stack holding a NoEcho mask is deferred in memory only, and its delete waits for the cleanup phase', async () => {
    const result = await deploy({
      // A nested stack is stateful: the replacement needs the consent.
      engine: makeEngine({ forceStatefulRecreation: true }),
      revisionType: 'AWS::CloudFormation::Stack',
      oldRecord: { noEchoLeaves: [['Code']] },
    });

    expect(order.filter((o) => o !== 'save')).toEqual([
      'create rev-new',
      'update prod',
      'delete rev-old',
    ]);
    expect(saved.every((s) => supersededResourcesOf(s).length === 0)).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
    expect(supersededResourcesOf(result.state)).toEqual([]);
  });

  // go-to-k/cdkd#6445 case 3: the deferred delete takes the final snapshot.
  it('defers under UpdateReplacePolicy: Snapshot, handing the snapshot identifier to the deferred delete and to state', async () => {
    const DB = 'AWS::RDS::DBInstance';
    await deploy({
      engine: makeEngine({ forceStatefulRecreation: true }),
      revisionType: DB,
      updateReplacePolicy: 'Snapshot',
    });
    expect(order.filter((o) => o !== 'save')).toEqual([
      'create rev-new',
      'update prod',
      'delete rev-old',
    ]);
    const context = vi.mocked(provider.delete).mock.calls[0]![4] as Record<string, unknown>;
    expect(context['finalSnapshotIdentifier']).toEqual(expect.stringContaining('rev-old'));
    expect(context['deletionPolicy']).toBe('Snapshot');
    // Kept in state with the same identifier and policy, for a deploy killed first.
    const rowSave = saved.find((s) => s.resources['Revision']?.physicalId === 'rev-new')!;
    const [entry] = supersededResourcesOf(rowSave);
    expect(entry!.finalSnapshotIdentifier).toBe(context['finalSnapshotIdentifier']);
    expect(entry!.updateReplacePolicy).toBe('Snapshot');

    // Control: --skip-final-snapshot defers too, with no identifier.
    order = [];
    live = new Set(['rev-old']);
    vi.mocked(provider.delete).mockClear();
    await deploy({
      engine: makeEngine({ forceStatefulRecreation: true, skipFinalSnapshot: true }),
      revisionType: DB,
      updateReplacePolicy: 'Snapshot',
    });
    expect(order.filter((o) => o !== 'save')).toEqual([
      'create rev-new',
      'update prod',
      'delete rev-old',
    ]);
    expect(vi.mocked(provider.delete).mock.calls[0]![4]).not.toHaveProperty('finalSnapshotIdentifier');
  });

  it('a failed deploy under UpdateReplacePolicy: Snapshot re-adopts the old instance and takes no snapshot (go-to-k/cdkd#6445)', async () => {
    endpointFails = true;

    await expect(
      deploy({
        engine: makeEngine({ noRollback: false, forceStatefulRecreation: true }),
        revisionType: 'AWS::RDS::DBInstance',
        updateReplacePolicy: 'Snapshot',
      })
    ).rejects.toThrow();

    expect(oldDeletes()).toBe(0);
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('deferred');
    // Only the new copy is deleted: no snapshot of the old one is taken. (The
    // new copy's delete follows its own DeletionPolicy, absent here, which is
    // CloudFormation's Snapshot default for an RDS instance.)
    const deletes = vi.mocked(provider.delete).mock.calls;
    expect(deletes.map((c) => c[1])).toEqual(['rev-new']);
    const snapshotId = (deletes[0]![4] as { finalSnapshotIdentifier?: string }).finalSnapshotIdentifier;
    expect(snapshotId ?? '').not.toContain('rev-old');
    expect([...live]).toEqual(['rev-old']);
    expect(saved.at(-1)!.resources['Revision']!.physicalId).toBe('rev-old');
    expect(saved.at(-1)!.supersededResources).toBeUndefined();
  });

  // The failed deploy's notice for a cleanup-phase delete never sent: an info
  // line, whose remedy reads whether the old record is kept in state.
  // go-to-k/cdkd#6445: one kept in memory only warns, since nothing else
  // tracks it.
  it.each([
    [true, 'cdkd keeps it in state, and the next deploy deletes it'],
    [false, 'it is no longer tracked in state, so delete it manually'],
  ])('an unsent cleanup-phase delete prints an info line while state keeps it, else a warning (kept in state: %s)', (kept, remedy) => {
    const engine = makeEngine();
    const run = engine.replacementRun;
    run.deferredReplacedDeletes = new Map([
      [
        'Revision',
        {
          physicalId: 'rev-old',
          resourceType: REVISION,
          provisionedBy: 'sdk',
          failureMessage: undefined,
          cleanupPhase: true,
          retry: async () => undefined,
        },
      ],
    ]);
    if (kept) {
      run.supersededEntries.set('Revision', {
        logicalId: 'Revision',
        supersededAt: 0,
        state: { physicalId: 'rev-old', resourceType: REVISION, properties: {} },
      });
    }

    warnUnretriedReplacedDeletes(run, engine.replacementDeps(), 'failed');

    const line = `Old Revision (rev-old) was not deleted: the deploy failed first. A rollback of the deploy adopts it again; otherwise ${remedy}`;
    if (kept) {
      expect(printed.info).toContain(`  ${line}`);
      expect(printed.warn).toEqual([]);
    } else {
      expect(printed.warn).toContain(`  ⚠ ${line}`);
      expect(printed.info.some((l) => l.includes(line))).toBe(false);
    }
    expect(run.deferredReplacedDeletes).toBeUndefined();
  });

  // A replacement whose new copy kept the old physical id (a Glue table moved
  // to another database) cannot keep its old record in state as superseded:
  // the row's save drops an entry a same-type record holds. Deleted inline.
  it('deletes inline when the new copy has the old physical id', async () => {
    const engine = makeEngine();
    const run = engine.replacementRun;
    run.deferredReplacedDeletes = new Map();
    const host: Pick<StackState, 'supersededResources'> = {};
    run.supersededHost = host;
    const old: ResourceState = {
      physicalId: 'db|tbl',
      resourceType: 'AWS::Glue::Table',
      properties: { DatabaseName: 'db' },
    } as ResourceState;
    const call = (newHoldsOldIdAndType: boolean) =>
      deleteReplacedAfterCreate(
        run,
        engine.replacementDeps(),
        'Table',
        'AWS::Glue::Table',
        old,
        provider,
        old.properties,
        undefined,
        undefined,
        new Map(),
        'sdk',
        undefined,
        false,
        newHoldsOldIdAndType
      );

    await call(true);
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['db|tbl']);
    expect(run.deferredReplacedDeletes.size).toBe(0);

    // Control: a new id, or an equal id under another type (a Type change),
    // defers it.
    vi.mocked(provider.delete).mockClear();
    await call(false);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(run.deferredReplacedDeletes.has('Table')).toBe(true);
  });

  // The cleanup pass deletes a replaced child before the replaced parent it
  // depended on (an old subnet before its old VPC), as CloudFormation does.
  it.each([1, 4])('the cleanup pass deletes dependents first (concurrency %s)', async (concurrency) => {
    const engine = makeEngine({ concurrency });
    const run = engine.replacementRun;
    const deleted: string[] = [];
    const entry = (physicalId: string, dependencies?: string[]) => ({
      physicalId,
      resourceType: REVISION,
      provisionedBy: 'sdk' as const,
      failureMessage: undefined,
      cleanupPhase: true as const,
      ...(dependencies && { dependencies }),
      retry: async () => {
        await new Promise((r) => setTimeout(r, physicalId === 'vpc-old' ? 0 : 5));
        deleted.push(physicalId);
      },
    });
    run.deferredReplacedDeletes = new Map([
      ['Vpc', entry('vpc-old')],
      ['Subnet', entry('subnet-old', ['Vpc'])],
      ['Route', entry('route-old', ['Subnet', 'Vpc'])],
    ]);
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 0,
      updatePartial: 0,
    });
    expect(deleted).toEqual(['route-old', 'subnet-old', 'vpc-old']);
  });

  it('a Ctrl-C during one wave sends nothing from the next', async () => {
    const engine = makeEngine({ concurrency: 4 });
    const run = engine.replacementRun;
    const deleted: string[] = [];
    run.deferredReplacedDeletes = new Map([
      [
        'Vpc',
        {
          physicalId: 'vpc-old',
          resourceType: REVISION,
          provisionedBy: 'sdk' as const,
          failureMessage: undefined,
          cleanupPhase: true as const,
          retry: async () => {
            deleted.push('vpc-old');
          },
        },
      ],
      [
        'Subnet',
        {
          physicalId: 'subnet-old',
          resourceType: REVISION,
          provisionedBy: 'sdk' as const,
          failureMessage: undefined,
          cleanupPhase: true as const,
          dependencies: ['Vpc'],
          retry: async () => {
            deleted.push('subnet-old');
            (engine as unknown as { interrupted: boolean }).interrupted = true;
          },
        },
      ],
    ]);
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 0,
      updatePartial: 0,
    });
    expect(deleted).toEqual(['subnet-old']);
  });

  it('the cleanup pass still deletes every entry of a dependency cycle', async () => {
    const engine = makeEngine({ concurrency: 4 });
    const run = engine.replacementRun;
    const deleted: string[] = [];
    const entry = (physicalId: string, dependencies: string[]) => ({
      physicalId,
      resourceType: REVISION,
      provisionedBy: 'sdk' as const,
      failureMessage: undefined,
      cleanupPhase: true as const,
      dependencies,
      retry: async () => {
        deleted.push(physicalId);
      },
    });
    run.deferredReplacedDeletes = new Map([
      ['A', entry('a-old', ['B'])],
      ['B', entry('b-old', ['A'])],
    ]);
    await retryDeferredReplacedDeletes(run, engine.replacementDeps(), 'S', {
      updated: 0,
      updatePartial: 0,
    });
    expect(deleted.sort()).toEqual(['a-old', 'b-old']);
  });
});
