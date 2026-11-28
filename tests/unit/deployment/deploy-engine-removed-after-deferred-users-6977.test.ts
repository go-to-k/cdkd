/**
 * go-to-k/cdkd#6977: a replaced resource whose old copy still uses a resource
 * removed from the template (an old Lambda alias pointing at the removed old
 * version, after a function rename) has that old copy deleted BEFORE the
 * removed resource, as CloudFormation's cleanup phase deletes both in one
 * dependency order. Before, the removal was deleted first, AWS refused it
 * while the old copy still used it, and the deploy kept its record and
 * exited 2.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { supersededResourcesOf } from '../../../src/deployment/superseded-resources.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { NestedCleanupQueue } from '../../../src/deployment/nested-cleanup-scope.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
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

/** Types `canRecordSuperseded` accepts, so their old copies are deferred. */
const ALIAS = 'AWS::Lambda::WebFunctionRevision';
const VERSION = 'AWS::Lambda::Version';

function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const record = (
  physicalId: string,
  resourceType: string,
  dependencies: string[] = []
): ResourceState =>
  ({
    physicalId,
    resourceType,
    properties: { Name: physicalId },
    attributes: {},
    dependencies,
    provisionedBy: 'sdk',
  }) as ResourceState;

const replaceChange = (logicalId: string): ResourceChange =>
  ({
    logicalId,
    changeType: 'UPDATE',
    resourceType: ALIAS,
    currentProperties: { Name: `${logicalId}-old` },
    desiredProperties: { Name: `${logicalId}-new` },
    propertyChanges: [
      { path: 'Name', oldValue: `${logicalId}-old`, newValue: `${logicalId}-new`, requiresReplacement: true },
    ],
  }) as unknown as ResourceChange;

const deleteChange = (logicalId: string, resourceType: string): ResourceChange =>
  ({
    logicalId,
    changeType: 'DELETE',
    resourceType,
    currentProperties: {},
  }) as unknown as ResourceChange;

describe('an old copy using a removed resource is deleted before it (go-to-k/cdkd#6977)', () => {
  let provider: ResourceProvider;
  let live: Set<string>;
  /** physical id -> the ids whose liveness makes AWS refuse its delete. */
  let usedBy: Map<string, string[]>;
  let order: string[];
  /** physical id -> the error its delete throws. */
  let failDelete: Map<string, () => Error>;
  let journaled: CompletedOperation[][];
  /** The deployed stack's name; a nested child's is `<parent>~<logicalId>`. */
  let stackName: string;
  /** String attributes recorded on each replaced old copy, and returned by every create. */
  let oldAttributes: Record<string, string>;
  let createAttributes: Record<string, string>;
  let listStacksCalls: number;

  beforeEach(() => {
    stackName = 'MyStack';
    oldAttributes = {};
    createAttributes = {};
    listStacksCalls = 0;
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    live = new Set();
    usedBy = new Map();
    order = [];
    failDelete = new Map();
    journaled = [];
    journalTap.push = (ops) => journaled.push(ops as CompletedOperation[]);
    provider = {
      create: vi.fn(async (logicalId: string) => {
        const physicalId = `${logicalId}-new`;
        live.add(physicalId);
        order.push(`create ${physicalId}`);
        return { physicalId, attributes: { ...createAttributes } };
      }),
      update: vi.fn(async (_logicalId: string, physicalId: string) => ({
        physicalId,
        wasReplaced: false,
        attributes: {},
      })),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`delete ${physicalId}`);
        const failure = failDelete.get(physicalId);
        if (failure !== undefined) throw failure();
        const user = (usedBy.get(physicalId) ?? []).find((id) => live.has(id));
        if (user !== undefined) {
          throw awsError(
            'ResourceConflictException',
            `Unable to delete ${physicalId}: ${user} still references it`
          );
        }
        live.delete(physicalId);
        return undefined;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? { Name: physicalId } : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  /**
   * `consumers`: a producer with a same-run consumer (go-to-k/cdkd#7012), whose
   * stacks' records the state backend serves (`unreadable` throws). `run` names
   * the run's consumers (`consumerStacks`, default every stack in `states`).
   */
  function makeEngine(
    templateDeps: Record<string, string[]>,
    consumers?: {
      states: Record<string, StackState | 'unreadable'>;
      nested?: true;
      run?: string[];
    }
  ): DeployEngine {
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
        getState: vi.fn(async (stackName: string) => {
          const state = consumers?.states[stackName];
          if (state === 'unreadable') throw new Error('AccessDenied');
          return state === undefined ? null : { state, etag: 'e' };
        }),
        listStacks: vi.fn(async () => {
          listStacksCalls++;
          return Object.keys(consumers?.states ?? {}).map((stackName) => ({
            stackName,
            region: 'us-east-1',
          }));
        }),
        saveState: vi.fn(async () => 'etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) => templateDeps[id] ?? [],
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      {
        concurrency: 4,
        noRollback: true,
        ...(consumers !== undefined && { consumerCleanupQueue: new NestedCleanupQueue() }),
        ...(consumers !== undefined && {
          consumerStacks: (consumers.run ?? Object.keys(consumers.states)).map((name) => ({
            stackName: name,
            region: 'us-east-1',
          })),
        }),
        ...(consumers?.nested === true && {
          parentStackInfo: { parentStack: 'MyStack', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
        }),
      } as never,
      'us-east-1'
    );
  }

  /**
   * `replaced` are replaced create-first (old copy `<id>-old`, deferred);
   * `removed` are removed from the template. Records carry `recordDeps`.
   */
  async function deploy(opts: {
    replaced: string[];
    removed: Array<[string, string]>;
    recordDeps: Record<string, string[]>;
    templateDeps?: Record<string, string[]>;
    levels: string[][];
    /** Old copies an earlier deploy kept (`supersededResources`). */
    carried?: SupersededResourceRecord[];
  }): Promise<{ state: StackState; actualCounts: Record<string, number> }> {
    return deployOn(makeEngine(opts.templateDeps ?? {}), opts);
  }

  async function deployOn(
    engine: DeployEngine,
    opts: Parameters<typeof deploy>[0]
  ): Promise<{ state: StackState; actualCounts: Record<string, number> }> {
    const resources: Record<string, ResourceState> = {};
    for (const id of opts.replaced) {
      resources[id] = { ...record(`${id}-old`, ALIAS, opts.recordDeps[id]), attributes: { ...oldAttributes } };
      live.add(`${id}-old`);
    }
    for (const [id, type] of opts.removed) {
      resources[id] = record(`${id}-old`, type, opts.recordDeps[id]);
      live.add(`${id}-old`);
    }
    const template = {
      Resources: Object.fromEntries(
        opts.replaced.map((id) => [id, { Type: ALIAS, Properties: { Name: `${id}-new` } }])
      ),
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 12,
      stackName,
      region: 'us-east-1',
      resources,
      outputs: {},
      ...(opts.carried !== undefined && { supersededResources: opts.carried }),
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      ...opts.replaced.map((id) => [id, replaceChange(id)] as [string, ResourceChange]),
      ...opts.removed.map(([id, type]) => [id, deleteChange(id, type)] as [string, ResourceChange]),
    ]);
    return (await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      opts.levels,
      stackName,
      template,
      undefined,
      undefined,
      'etag-0'
    )) as unknown as { state: StackState; actualCounts: Record<string, number> };
  }

  const at = (entry: string): number => {
    const index = order.indexOf(entry);
    expect(index, `${entry} in ${order.join(', ')}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('deletes the old alias before the removed old version it points at, and the deploy completes', async () => {
    usedBy.set('OldVersion-old', ['Alias-old']);

    const result = await deploy({
      replaced: ['Alias'],
      removed: [['OldVersion', VERSION]],
      recordDeps: { Alias: ['OldVersion'] },
      levels: [['Alias']],
    });

    expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
    expect(vi.mocked(provider.delete).mock.calls.filter((c) => c[1] === 'Alias-old')).toHaveLength(
      1
    );
    expect(live.has('Alias-old')).toBe(false);
    expect(live.has('OldVersion-old')).toBe(false);
    expect(result.state.resources['OldVersion']).toBeUndefined();
    expect(result.state.resources['Alias']?.physicalId).toBe('Alias-new');
    expect(supersededResourcesOf(result.state)).toEqual([]);
    expect(printed.warn).toEqual([]);
    expect(printed.info.join('\n')).toContain(
      'Deleting the old resource of 1 replaced resource(s) first: they use a resource removed from the template'
    );
  });

  it('also deletes first, dependents first, an old copy using one taken there', async () => {
    usedBy.set('OldVersion-old', ['Alias-old']);
    usedBy.set('Alias-old', ['Url-old']);

    const result = await deploy({
      replaced: ['Alias', 'Url'],
      removed: [['OldVersion', VERSION]],
      recordDeps: { Alias: ['OldVersion'], Url: ['Alias'] },
      templateDeps: { Url: ['Alias'] },
      levels: [['Alias'], ['Url']],
    });

    expect(at('delete Url-old')).toBeLessThan(at('delete Alias-old'));
    expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
    expect(result.state.resources['OldVersion']).toBeUndefined();
    expect(supersededResourcesOf(result.state)).toEqual([]);
    expect(printed.warn).toEqual([]);
  });

  it('leaves an old copy no removed resource uses to the cleanup phase, after the removals', async () => {
    usedBy.set('OldVersion-old', ['Alias-old']);

    await deploy({
      replaced: ['Alias', 'Other'],
      removed: [['OldVersion', VERSION]],
      recordDeps: { Alias: ['OldVersion'] },
      levels: [['Alias', 'Other']],
    });

    expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
    expect(at('delete OldVersion-old')).toBeLessThan(at('delete Other-old'));
    expect(printed.warn).toEqual([]);
  });

  it('takes nothing first when a removed resource itself uses one of those old copies', async () => {
    // Removed `Perm` uses the old alias, which uses removed `OldVersion`: no
    // two-pass order deletes all three correctly, so the order stays as it was.
    await deploy({
      replaced: ['Alias'],
      removed: [
        ['OldVersion', VERSION],
        ['Perm', 'AWS::Lambda::Permission'],
      ],
      recordDeps: { Alias: ['OldVersion'], Perm: ['Alias'] },
      levels: [['Alias']],
    });

    expect(at('delete Perm-old')).toBeLessThan(at('delete Alias-old'));
    expect(at('delete OldVersion-old')).toBeLessThan(at('delete Alias-old'));
    expect(printed.info.join('\n')).not.toContain('replaced resource(s) first');
  });

  it('a removal interrupted after them journals the old copy as deleted, so a rollback re-creates it', async () => {
    usedBy.set('OldVersion-old', ['Alias-old']);
    failDelete.set('OldVersion-old', () => new InterruptedWaitError('Delete of OldVersion'));
    const engine = makeEngine({});

    await expect(
      deployOn(engine, {
        replaced: ['Alias'],
        removed: [['OldVersion', VERSION]],
        recordDeps: { Alias: ['OldVersion'] },
        levels: [['Alias']],
      })
    ).rejects.toThrow();

    expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
    expect(live.has('Alias-old')).toBe(false);
    const op = journaled.flat().find((o) => o.logicalId === 'Alias');
    expect(op?.changeType).toBe('UPDATE');
    // Gone, not 'deferred': the rollback re-creates the old alias rather than
    // re-adopting a deleted id.
    expect(op?.oldResourceMaySurvive).toBeUndefined();
    expect(op?.oldResourceIdentity).toBeUndefined();
  });

  describe('a producer whose cleanup waits for the run consumers (go-to-k/cdkd#7204)', () => {
    const consumer = (leaf: string, sourceStack = 'MyStack'): StackState =>
      ({
        version: 12,
        stackName: 'Consumer',
        region: 'us-east-1',
        resources: {
          Integration: {
            physicalId: 'integ-1',
            resourceType: 'AWS::ApiGatewayV2::Integration',
            properties: { IntegrationUri: leaf },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        imports: [{ sourceStack, sourceRegion: 'us-east-1', exportName: 'AliasArn' }],
        lastModified: 0,
      }) as unknown as StackState;

    const shape = {
      replaced: ['Alias'],
      removed: [['OldVersion', VERSION]] as Array<[string, string]>,
      recordDeps: { Alias: ['OldVersion'] },
      levels: [['Alias']],
    };

    it('takes nothing first while a consumer names the old copy: the old copy waits, the removal is kept', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);

      const result = await deployOn(
        makeEngine({}, { states: { Consumer: consumer('Alias-old') } }),
        shape
      );

      expect(order).not.toContain('delete Alias-old');
      // The removal is kept without its delete being sent.
      expect(order).not.toContain('delete OldVersion-old');
      expect(result.actualCounts['deleteSkipped']).toBe(1);
      expect(printed.warn.join('\n')).toContain(
        'OldVersion (AWS::Lambda::Version) was removed from the template, but the old Alias still uses it and waits for the stacks importing this stack\'s outputs'
      );
      // Only the run's consumers are read.
      expect(listStacksCalls).toBe(0);
      expect(live.has('Alias-old')).toBe(true);
      expect(live.has('OldVersion-old')).toBe(true);
      expect(result.state.resources['OldVersion']?.physicalId).toBe('OldVersion-old');
      expect(supersededResourcesOf(result.state).map((e) => e.state.physicalId)).toEqual([
        'Alias-old',
      ]);
      const info = printed.info.join('\n');
      expect(info).not.toContain('replaced resource(s) first');
      expect(info).toContain(
        "Consumer (importing this stack's outputs) still uses an old copy of a replaced resource"
      );
    });

    it('takes nothing first when a consumer record cannot be read', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);

      const result = await deployOn(
        makeEngine({}, { states: { Consumer: 'unreadable' } }),
        shape
      );

      expect(order).not.toContain('delete Alias-old');
      expect(order).not.toContain('delete OldVersion-old');
      expect(result.state.resources['OldVersion']?.physicalId).toBe('OldVersion-old');
      const info = printed.info.join('\n');
      expect(info).not.toContain('replaced resource(s) first');
      expect(info).toContain('Consumer (its state could not be read)');
    });

    it('a nested child of such a producer asks the consumers of its top-level stack', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);
      stackName = 'MyStack~Child';

      const result = await deployOn(
        makeEngine({}, { states: { Consumer: consumer('Alias-old') }, nested: true }),
        shape
      );

      // Not first, and the removal it uses is kept unsent. (With no root
      // engine on this test's stack, the child runs its own cleanup pass.)
      expect(order).not.toContain('delete OldVersion-old');
      expect(order).toContain('delete Alias-old');
      expect(result.state.resources['OldVersion']?.physicalId).toBe('OldVersion-old');
      expect(printed.info.join('\n')).toContain(
        "Consumer (importing this stack's outputs) still uses an old copy of a replaced resource"
      );
    });

    it('a value the new copy shares with the old one names no old copy', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);
      oldAttributes = { VpcId: 'vpc-0123456789' };
      createAttributes = { VpcId: 'vpc-0123456789' };

      await deployOn(
        makeEngine({}, { states: { Consumer: consumer('vpc-0123456789') } }),
        shape
      );

      expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
    });

    it('still deletes first when no consumer names the old copy', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);

      const result = await deployOn(
        makeEngine(
          {},
          {
            states: {
              Consumer: consumer('Alias-new'),
              // Names the old copy but imports from another stack.
              Unrelated: consumer('Alias-old', 'OtherStack'),
            },
          }
        ),
        shape
      );

      expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
      expect(result.state.resources['OldVersion']).toBeUndefined();
      expect(printed.info.join('\n')).toContain('replaced resource(s) first');
    });
    it('reads only the run consumers, not every stack in the bucket', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);

      await deployOn(
        makeEngine(
          {},
          {
            // `Outside` imports this stack and names the old copy, but is not
            // in the run: the export guard owns it.
            states: { Consumer: consumer('Alias-new'), Outside: consumer('Alias-old') },
            run: ['Consumer'],
          }
        ),
        shape
      );

      expect(at('delete Alias-old')).toBeLessThan(at('delete OldVersion-old'));
      expect(listStacksCalls).toBe(0);
    });

    it('keeps unsent the removal an old copy an earlier deploy kept for a consumer still uses', async () => {
      usedBy.set('OldVersion-old', ['Alias-old']);
      live.add('Alias-old');
      const kept: SupersededResourceRecord = {
        logicalId: 'Alias',
        supersededAt: 1,
        heldForConsumers: true,
        state: record('Alias-old', ALIAS, ['OldVersion']),
      };

      const result = await deployOn(
        makeEngine({}, { states: { Consumer: consumer('Alias-old') } }),
        { replaced: [], removed: [['OldVersion', VERSION]], recordDeps: {}, levels: [], carried: [kept] }
      );

      expect(order).not.toContain('delete OldVersion-old');
      expect(order).not.toContain('delete Alias-old');
      expect(result.state.resources['OldVersion']?.physicalId).toBe('OldVersion-old');
      expect(result.actualCounts['deleteSkipped']).toBe(1);
      expect(printed.warn.join('\n')).toContain('but the old Alias still uses it and waits');
    });
  });
});
