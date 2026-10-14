/**
 * go-to-k/cdkd#4900: a replacement whose old resource is still used by a
 * dependent this deploy has yet to update (a Lambda Web Function endpoint on
 * a replaced revision) gets its refused delete retried once after the rest
 * of the deploy, as CloudFormation's cleanup phase deletes old resources only
 * after every update.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { getStackRecords } from '../../../src/deployment/stack-records-scope.js';
import { withIndeterminateGuard } from '../../../src/deployment/delete-outcome.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction/log-only.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

// Each line is kept as the real sink prints it: through the masker the bound
// printing bags install.
const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker } = await import('../../../src/utils/log-line-masker.js');
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      const text = String(message);
      printed[level].push(currentLogLineMasker()?.(text) ?? text);
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
const ENDPOINT = 'AWS::Lambda::WebFunctionEndpoint';
const lines = (level: 'info' | 'warn'): string[] => printed[level];

const IN_USE = 'The revision rev-old cannot be deleted because the endpoints [prod] are using it.';

describe('a replaced resource whose delete a dependent refuses is retried after the DAG (#4900)', () => {
  let provider: ResourceProvider;
  /** The revision the endpoint uses, as AWS sees it. */
  let endpointRevision: string;
  let endpointUpdate: () => Promise<void>;
  let retryOutcome: () => Promise<unknown>;
  let deletes: number;
  let events: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    endpointRevision = 'rev-old';
    endpointUpdate = async () => {
      endpointRevision = 'rev-new';
    };
    retryOutcome = async () => undefined;
    deletes = 0;
    events = [];
    provider = {
      create: vi.fn(async () => ({ physicalId: 'rev-new', attributes: {} })),
      update: vi.fn(async (logicalId: string, physicalId: string) => {
        await endpointUpdate();
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        deletes++;
        if (physicalId === endpointRevision) throw new Error(`ConflictException: ${IN_USE}`);
        if (deletes > 1) return retryOutcome();
        return undefined;
      }),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' as const }),
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
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      // The endpoint reads the revision, so it waits for the replacement.
      {
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Endpoint' ? ['Revision'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, eventRecorder: { record: (e: Record<string, unknown>) => events.push(e) } } as never,
      'us-east-1'
    );
  }

  async function deploy(engine = makeEngine()): Promise<{ actualCounts: Record<string, number> }> {
    const template = {
      Resources: {
        Revision: { Type: REVISION, Properties: { FunctionName: 'todo-api', Code: 'v2' } },
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
    )) as { actualCounts: Record<string, number> };
  }

  it('deletes the old revision once the endpoint has moved off it, with no warning', async () => {
    const result = await deploy();

    expect(provider.delete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual(['rev-old', 'rev-old']);
    expect(lines('info').some((l) => l.includes('Could not delete old Revision (rev-old) yet'))).toBe(
      true
    );
    expect(lines('info').some((l) => l.includes('Old Revision (rev-old) deleted'))).toBe(true);
    expect(lines('warn').some((l) => l.includes('Failed to delete old resource'))).toBe(false);
    expect(result.actualCounts['updatePartial']).toBe(0);
  });

  it('retries only AFTER the dependent update, never inline', async () => {
    const order: string[] = [];
    endpointUpdate = async () => {
      order.push('endpoint-update');
      endpointRevision = 'rev-new';
    };
    const del = provider.delete;
    provider.delete = vi.fn(async (...args: Parameters<ResourceProvider['delete']>) => {
      order.push('delete');
      return del(...args);
    }) as unknown as ResourceProvider['delete'];

    await deploy();

    expect(order).toEqual(['delete', 'endpoint-update', 'delete']);
  });

  it('warns as before when the retry fails too', async () => {
    endpointUpdate = async () => {
      // The endpoint keeps the old revision (e.g. another weight still on it).
    };

    await deploy();

    expect(provider.delete).toHaveBeenCalledTimes(2);
    const warned = lines('warn').filter((l) =>
      l.includes('Failed to delete old resource Revision (rev-old)')
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(IN_USE);
  });

  it('does not retry when the deploy fails, and warns for the delete left undone', async () => {
    endpointUpdate = async () => {
      throw new Error('ValidationException: endpoint update rejected');
    };

    await expect(deploy()).rejects.toThrow();

    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(
      lines('warn').some(
        (l) =>
          l.includes('Failed to delete old resource Revision (rev-old)') &&
          l.includes('not retried: the deploy failed first')
      )
    ).toBe(true);
  });

  it('a retry the provider skips makes the row a partial update', async () => {
    retryOutcome = async () => ({ outcome: 'skipped', reason: 'malformed physicalId in state' });

    const result = await deploy();

    expect(result.actualCounts['updatePartial']).toBe(1);
    expect(lines('warn').some((l) => l.includes('while cleaning up the replaced resource'))).toBe(
      true
    );
  });

  it('runs the retry under the stack records, so a delete asking for survivors gets them', async () => {
    let boundAtRetry: unknown;
    const del = provider.delete;
    provider.delete = vi.fn(async (...args: Parameters<ResourceProvider['delete']>) => {
      if (deletes >= 1) boundAtRetry = getStackRecords();
      return del(...args);
    }) as unknown as ResourceProvider['delete'];

    await deploy();

    expect(provider.delete).toHaveBeenCalledTimes(2);
    expect(boundAtRetry).toBeDefined();
  });

  it("masks the row's derived-name registry in every line naming the old resource", async () => {
    // The old revision's id spells a name that came from a secret.
    const engine = makeEngine() as unknown as InstanceType<typeof DeployEngine> & {
      secretNameBagFor: (id: string) => Map<string, string>;
    };
    recordLogOnlyValue(engine.secretNameBagFor('Revision'), 'rev-old');

    await deploy(engine);

    const naming = [...lines('info'), ...lines('warn')].filter((l) => l.includes('old Revision') || l.includes('Old Revision'));
    expect(naming.length).toBeGreaterThanOrEqual(3);
    for (const line of naming) expect(line).not.toContain('rev-old');
  });

  it("masks the registry in the warning for a delete the failed deploy left undone", async () => {
    endpointUpdate = async () => {
      throw new Error('ValidationException: endpoint update rejected');
    };
    const engine = makeEngine() as unknown as InstanceType<typeof DeployEngine> & {
      secretNameBagFor: (id: string) => Map<string, string>;
    };
    recordLogOnlyValue(engine.secretNameBagFor('Revision'), 'rev-old');

    await expect(deploy(engine)).rejects.toThrow();

    const warned = lines('warn').find((l) => l.includes('Failed to delete old resource Revision'));
    expect(warned).toBeDefined();
    expect(warned).not.toContain('rev-old');
  });

  it("records the retried delete's indeterminate guards as the row's events", async () => {
    retryOutcome = async () =>
      withIndeterminateGuard(undefined, { guard: 'cc-delete-region-identity', reason: 'no answer' });

    await deploy();

    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: 'RESOURCE_GUARD_INDETERMINATE',
        logicalId: 'Revision',
        operation: 'DELETE',
        physicalId: 'rev-old',
        guard: 'cc-delete-region-identity',
      })
    );
  });

  it('a skipped retry names the survivor in a RESOURCE_SKIPPED event', async () => {
    retryOutcome = async () => ({ outcome: 'skipped', reason: 'malformed physicalId in state' });

    await deploy();

    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: 'RESOURCE_SKIPPED',
        logicalId: 'Revision',
        operation: 'UPDATE',
        physicalId: 'rev-old',
        provisionedBy: 'cc-api',
      })
    );
  });

  it('a skipped retry on a row already partial does not count it twice', async () => {
    retryOutcome = async () => ({ outcome: 'skipped', reason: 'malformed physicalId in state' });
    const engine = makeEngine();
    const original = (engine as unknown as { provisionResourceBody: (...a: unknown[]) => Promise<unknown> })
      .provisionResourceBody;
    (engine as unknown as { provisionResourceBody: (...a: unknown[]) => Promise<unknown> }).provisionResourceBody =
      async function (this: unknown, ...args: unknown[]) {
        const result = await original.apply(this, args);
        return args[0] === 'Revision' ? { updatePartial: 'another survivor' } : result;
      };
    (engine as unknown as { provisionResourceBody: unknown }).provisionResourceBody = (
      engine as unknown as { provisionResourceBody: (...a: unknown[]) => Promise<unknown> }
    ).provisionResourceBody.bind(engine);

    const result = await deploy(engine);

    expect(provider.delete).toHaveBeenCalledTimes(2);
    expect(result.actualCounts['updatePartial']).toBe(0);
  });

  it('a retry that throws outside the provider call warns and still retries the rest', async () => {
    const engine = makeEngine() as unknown as {
      options: { concurrency: number };
      deferredReplacedDeletes: Map<string, unknown> | undefined;
      retryDeferredReplacedDeletes: (stackName: string, counts: unknown) => Promise<void>;
    };
    engine.options.concurrency = 1;
    const second = vi.fn(async () => undefined);
    const entry = (retry: () => Promise<void>) => ({
      physicalId: 'rev-x',
      resourceType: REVISION,
      provisionedBy: 'cc-api',
      failureMessage: 'in use',
      retry,
    });
    engine.deferredReplacedDeletes = new Map([
      ['First', entry(async () => { throw new Error('unexpected'); })],
      ['Second', entry(second)],
    ]);

    await engine.retryDeferredReplacedDeletes('MyStack', { updated: 2, updatePartial: 0 });

    expect(second).toHaveBeenCalledTimes(1);
    const warned = lines('warn').find((l) => l.includes('Failed to delete old resource First'));
    expect(warned).toContain('the retry failed unexpectedly');
    expect(warned).not.toContain('unexpected:');
  });

  it('a reused engine does not carry a deferred delete into the next deploy', async () => {
    const engine = makeEngine();
    endpointUpdate = async () => {
      throw new Error('ValidationException: endpoint update rejected');
    };
    await expect(deploy(engine)).rejects.toThrow();

    expect(
      (engine as unknown as { deferredReplacedDeletes: unknown }).deferredReplacedDeletes
    ).toBeUndefined();
  });

  it('masks a secret the deferred delete error echoes, in both the deferral and the final warning', async () => {
    const secret = 'hunter2-secret-value';
    provider.delete = vi.fn(async () => {
      throw new Error(`ConflictException for ${secret}`);
    }) as unknown as ResourceProvider['delete'];
    const engine = makeEngine() as unknown as {
      deferredReplacedDeletes: Map<string, unknown> | undefined;
      deleteReplacedAfterCreate: (...args: unknown[]) => Promise<void>;
      warnUnretriedReplacedDeletes: (why: 'failed' | 'interrupted') => void;
    };
    engine.deferredReplacedDeletes = new Map();

    await engine.deleteReplacedAfterCreate(
      'Revision',
      REVISION,
      { physicalId: 'rev-old', resourceType: REVISION, properties: {} },
      provider,
      {},
      undefined,
      undefined,
      new Map([[secret, '{{resolve:secretsmanager:s}}']])
    );
    engine.warnUnretriedReplacedDeletes('failed');

    const deferral = lines('info').find((l) => l.includes('Could not delete old Revision'));
    const warned = lines('warn').find((l) => l.includes('Failed to delete old resource Revision'));
    for (const line of [deferral, warned]) {
      expect(line).toBeDefined();
      expect(line).not.toContain('secret-value');
      expect(line).toContain('***');
    }
  });
});
