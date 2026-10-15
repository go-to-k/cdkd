/**
 * go-to-k/cdkd#2631: a replacement whose cleanup delete of the OLD resource
 * is not confirmed (it fails — inline or after #4900's deferred retry —, the
 * provider skips it, or a failed final snapshot blocks it) journals
 * `oldResourceMaySurvive: true`, and the rollback reads AWS for the old
 * resource before re-creating it. A confirmed delete journals nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { markDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
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

const REVISION = 'AWS::Lambda::WebFunctionRevision';

/** An AWS SDK-shaped error: its `name` is the service's error code. */
function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
const ENDPOINT = 'AWS::Lambda::WebFunctionEndpoint';

describe('a replacement whose old-resource delete is unconfirmed (#2631)', () => {
  let provider: ResourceProvider;
  /** The revision the endpoint uses, as AWS sees it; its delete is refused. */
  let endpointRevision: string;
  let endpointFails: boolean;
  let deleteOutcome: (physicalId: string) => Promise<unknown>;
  /** What the refused delete of the revision the endpoint uses throws. */
  let refusal: () => Error;
  /** Revisions alive in AWS. */
  let live: Set<string>;
  let journaled: CompletedOperation[][];

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    endpointRevision = 'rev-old';
    endpointFails = false;
    deleteOutcome = async () => undefined;
    refusal = () => awsError('ConflictException', 'in use');
    live = new Set(['rev-old']);
    journaled = [];
    provider = {
      create: vi.fn(async () => {
        live.add('rev-new');
        return { physicalId: 'rev-new', attributes: {} };
      }),
      update: vi.fn(async (_logicalId: string, physicalId: string) => {
        if (endpointFails) throw new Error('ValidationException: endpoint update rejected');
        endpointRevision = 'rev-new';
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        if (physicalId === endpointRevision) throw refusal();
        const outcome = await deleteOutcome(physicalId);
        if (outcome === undefined) live.delete(physicalId);
        return outcome;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? { FunctionName: 'todo-api' } : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(noRollback: boolean): InstanceType<typeof DeployEngine> {
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
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Endpoint' ? ['Revision'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback } as never,
      'us-east-1'
    );
    const write = (
      engine as unknown as { writeRollbackJournalSegment: (...args: unknown[]) => Promise<unknown> }
    ).writeRollbackJournalSegment.bind(engine);
    (
      engine as unknown as { writeRollbackJournalSegment: (...args: unknown[]) => Promise<unknown> }
    ).writeRollbackJournalSegment = async (...args: unknown[]) => {
      journaled.push(structuredClone(args[1] as CompletedOperation[]));
      return write(...args);
    };
    return engine;
  }

  async function deploy(
    opts: { noRollback?: boolean; updateReplacePolicy?: string; engine?: DeployEngine } = {}
  ): Promise<{ completedOperations: CompletedOperation[]; state: StackState }> {
    const engine = opts.engine ?? makeEngine(opts.noRollback ?? true);
    const template = {
      Resources: {
        Revision: {
          Type: REVISION,
          Properties: { FunctionName: 'todo-api', Code: 'v2' },
          ...(opts.updateReplacePolicy !== undefined && {
            UpdateReplacePolicy: opts.updateReplacePolicy,
          }),
        },
        Endpoint: {
          Type: ENDPOINT,
          Properties: { FunctionName: 'todo-api', RevisionId: 'rev-new' },
        },
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
        Revision: record('rev-old', REVISION, { FunctionName: 'todo-api', Code: 'v1' }),
        Endpoint: record('prod', ENDPOINT, { FunctionName: 'todo-api', RevisionId: 'rev-old' }),
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
          resourceType: REVISION,
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
    ]);
    return (await (
      engine as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> }
    ).executeDeployment(
      template,
      currentState,
      changes,
      {},
      [['Revision'], ['Endpoint']],
      'MyStack',
      template
    )) as { completedOperations: CompletedOperation[]; state: StackState };
  }

  const revisionOp = (ops: CompletedOperation[]): CompletedOperation =>
    ops.find((o) => o.logicalId === 'Revision')!;

  it('journals nothing when the delete succeeds inline', async () => {
    endpointRevision = 'none';
    const result = await deploy();
    const op = revisionOp(result.completedOperations);
    expect(op.oldResourceRetained).toBe(false);
    expect('oldResourceMaySurvive' in op).toBe(false);
  });

  const oldDeletes = (): number =>
    vi.mocked(provider.delete).mock.calls.filter((c) => c[1] === 'rev-old').length;

  it('marks the op unconfirmed when the delete fails and the deploy fails before the retry', async () => {
    endpointFails = true;
    await expect(deploy()).rejects.toThrow();
    expect(oldDeletes()).toBe(1);
    expect(journaled).toHaveLength(1);
    const op = revisionOp(journaled[0]!);
    expect(op.oldResourceRetained).toBe(false);
    expect(op.oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('marks the op kept when AWS refused the delete outright', async () => {
    endpointFails = true;
    refusal = () => awsError('AccessDenied', 'not authorized to perform: DeletePolicy');
    await expect(deploy()).rejects.toThrow();
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('kept');
  });

  it('reads the refusal off the cause chain of a provider wrapper', async () => {
    endpointFails = true;
    refusal = () =>
      Object.assign(new Error('Failed to delete IAM managed policy Revision: denied'), {
        cause: awsError('AccessDenied', 'denied'),
      });
    await expect(deploy()).rejects.toThrow();
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('kept');
  });

  it('marks the op unconfirmed when the refused delete had already stripped the old resource (#4946)', async () => {
    endpointFails = true;
    refusal = () =>
      markDeleteStarted(
        Object.assign(new Error('Failed to delete IAM managed policy Revision: denied'), {
          cause: awsError('AccessDenied', 'not authorized to perform: DeletePolicy'),
        })
      );
    await expect(deploy()).rejects.toThrow();
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('a deferred retry whose refused delete stripped the old resource turns a kept mark unconfirmed (#4946)', async () => {
    provider.update = vi.fn(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    // The first attempt is refused before any strip; the retry strips, then is refused.
    let attempts = 0;
    refusal = () => {
      const error = awsError('AccessDenied', 'denied');
      return ++attempts === 1 ? error : markDeleteStarted(error);
    };
    const result = await deploy();
    expect(oldDeletes()).toBe(2);
    expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('marks the op when the deferred retry fails too, after running it', async () => {
    // The endpoint update lands, but the old revision stays refused.
    provider.update = vi.fn(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    const result = await deploy();
    expect(oldDeletes()).toBe(2);
    expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('drops the mark when the deferred retry deletes the old revision', async () => {
    const result = await deploy();
    expect(oldDeletes()).toBe(2);
    expect(live.has('rev-old')).toBe(false);
    // An eventually consistent read could still see it: nothing may re-adopt.
    expect('oldResourceMaySurvive' in revisionOp(result.completedOperations)).toBe(false);
  });

  it('drops a kept mark too when the retry deletes it', async () => {
    let attempt = 0;
    refusal = () => awsError('DependencyViolation', 'in use by a network interface');
    provider.delete = vi.fn(async (...args: Parameters<ResourceProvider['delete']>) => {
      if (args[1] === 'rev-old' && ++attempt === 1) throw refusal();
      live.delete(args[1]);
      return undefined;
    }) as unknown as ResourceProvider['delete'];
    const result = await deploy();
    expect(oldDeletes()).toBe(2);
    expect('oldResourceMaySurvive' in revisionOp(result.completedOperations)).toBe(false);
  });

  it('drops the mark from the journaled op when the retry pass throws after deleting it', async () => {
    provider.update = vi.fn(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    refusal = () => awsError('AccessDenied', 'denied');
    const engine = makeEngine(true);
    const host = engine as unknown as {
      replacedOldMaySurvive: Map<string, string>;
      retryDeferredReplacedDeletes: () => Promise<void>;
    };
    host.retryDeferredReplacedDeletes = async () => {
      // This retry deleted it; a later entry's pass then threw.
      host.replacedOldMaySurvive.delete('Revision');
      throw new Error('retry pass failed');
    };
    await expect(deploy({ engine })).rejects.toThrow();
    expect('oldResourceMaySurvive' in revisionOp(journaled[0]!)).toBe(false);
  });

  it('re-stamps the journaled op when the retry fails differently than the first attempt', async () => {
    provider.update = vi.fn(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    let attempt = 0;
    refusal = () =>
      ++attempt === 1
        ? awsError('AccessDenied', 'denied')
        : new Error('Timed out waiting for the revision to be deleted');
    const result = await deploy();
    expect(oldDeletes()).toBe(2);
    expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('re-stamps the journaled op even when the retry pass throws', async () => {
    provider.update = vi.fn(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    refusal = () => awsError('AccessDenied', 'denied');
    const engine = makeEngine(true);
    const host = engine as unknown as {
      replacedOldMaySurvive: Map<string, string>;
      retryDeferredReplacedDeletes: () => Promise<void>;
    };
    // The retry ran (and found the delete unconfirmed), then its pass threw.
    host.retryDeferredReplacedDeletes = async () => {
      host.replacedOldMaySurvive.set('Revision', 'unconfirmed');
      throw new Error('retry pass failed');
    };
    await expect(deploy({ engine })).rejects.toThrow();
    expect(revisionOp(journaled[0]!).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('a retry refused outright never upgrades an earlier unconfirmed verdict', async () => {
    provider.update = vi.fn(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    let attempt = 0;
    refusal = () =>
      ++attempt === 1 ? new Error('Timed out waiting') : awsError('AccessDenied', 'denied');
    const result = await deploy();
    expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('marks the op unconfirmed when the delete returns a skip', async () => {
    endpointRevision = 'none';
    deleteOutcome = async () => ({ outcome: 'skipped', reason: 'malformed physicalId in state' });
    const result = await deploy();
    expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('marks the op kept when a failed final snapshot blocks the delete', async () => {
    endpointRevision = 'none';
    const engine = makeEngine(true);
    (
      engine as unknown as { prepareFinalSnapshotForDelete: () => Promise<never> }
    ).prepareFinalSnapshotForDelete = async () => {
      throw new Error('SnapshotQuotaExceeded');
    };
    const result = await deploy({ engine, updateReplacePolicy: 'Snapshot' });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(revisionOp(result.completedOperations).oldResourceMaySurvive).toBe('kept');
  });

  it('a reused engine does not carry the mark into the next deploy', async () => {
    const engine = makeEngine(true);
    endpointFails = true;
    await expect(deploy({ engine })).rejects.toThrow();
    const marks = () =>
      (engine as unknown as { replacedOldMaySurvive: Map<string, string> }).replacedOldMaySurvive;
    expect([...marks().keys()]).toEqual(['Revision']);
    // `deploy()` resets its per-run bags before its first await; the state
    // read failing right after is enough to observe it.
    const backend = (engine as unknown as { stateBackend: { getState: ReturnType<typeof vi.fn> } })
      .stateBackend;
    backend.getState.mockRejectedValue(new Error('stop here'));
    await expect(engine.deploy('MyStack', { Resources: {} } as never)).rejects.toThrow();
    expect(marks().size).toBe(0);
  });

  it('the automatic rollback re-adopts an old revision AWS refused to delete', async () => {
    endpointFails = true;
    refusal = () => awsError('AccessDenied', 'denied');
    await expect(deploy({ noRollback: false })).rejects.toThrow();

    // One create (the forward one), none from the rollback.
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.readCurrentState).toHaveBeenCalledWith(
      'rev-old',
      'Revision',
      REVISION,
      expect.anything()
    );
    // The new revision is deleted; the old one is alive and in no duplicate.
    expect([...live]).toEqual(['rev-old']);
    expect(
      printed.warn.some(
        (l) => l.includes('the old resource of Revision') && l.includes('re-adopted instead of re-created')
      )
    ).toBe(true);
  });

  it('the automatic rollback refuses an alive old revision whose delete may still be running', async () => {
    endpointFails = true;
    await expect(deploy({ noRollback: false })).rejects.toThrow();

    expect(provider.create).toHaveBeenCalledTimes(1);
    // Neither revision is deleted: the new one stays, state is not re-pointed.
    expect([...live].sort()).toEqual(['rev-new', 'rev-old']);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Cannot reverse the replacement of Revision') &&
          l.includes('its failed delete may have been accepted and still be running, or only partly ran')
      )
    ).toBe(true);
  });

  it('the automatic rollback refuses an alive old revision its refused delete had stripped (#4946)', async () => {
    endpointFails = true;
    refusal = () => markDeleteStarted(awsError('AccessDenied', 'denied'));
    await expect(deploy({ noRollback: false })).rejects.toThrow();

    expect(provider.create).toHaveBeenCalledTimes(1);
    // Not re-adopted: the new revision stays and state is not re-pointed.
    expect([...live].sort()).toEqual(['rev-new', 'rev-old']);
    expect(printed.warn.some((l) => l.includes('re-adopted instead of re-created'))).toBe(false);
    expect(
      printed.warn.some(
        (l) =>
          l.includes('Cannot reverse the replacement of Revision') &&
          l.includes('or only partly ran') &&
          // A refused delete is not running: the step is a delete by hand.
          l.includes('if its delete was refused, delete it by hand, then re-run')
      )
    ).toBe(true);
  });

  it('the automatic rollback re-creates the old revision when AWS reports it gone', async () => {
    endpointFails = true;
    // The delete failed in cdkd's eyes but went through in AWS.
    provider.delete = vi.fn(async (_l: string, physicalId: string) => {
      live.delete(physicalId);
      if (physicalId === 'rev-old') throw new Error('ConflictException: in use');
      return undefined;
    }) as unknown as ResourceProvider['delete'];
    let creates = 0;
    vi.mocked(provider.create).mockImplementation(async () => {
      // The forward create, then the rollback's re-create of the old one.
      const id = ++creates === 1 ? 'rev-new' : 'rev-old-2';
      live.add(id);
      return { physicalId: id, attributes: {} };
    });
    await expect(deploy({ noRollback: false })).rejects.toThrow();

    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(printed.info.some((l) => l.includes('is gone — re-creating it'))).toBe(true);
  });
});
