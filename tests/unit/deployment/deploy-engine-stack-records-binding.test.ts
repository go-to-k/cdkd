/**
 * go-to-k/cdkd#4492: the deploy engine binds the stack's records around every
 * resource's provider call, so a provider whose AWS object two records of the
 * stack can share (a `SecurityGroupIngress` rule) can tell whether another
 * record holds it. Observed from INSIDE the provider call, the seam
 * `EC2Provider` reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { awaitInFlightSibling, getStackRecords } from '../../../src/deployment/stack-records-scope.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    // Resolves a `Fn::GetAtt` to 3306, as a cluster's `Endpoint.Port` does, so a
    // test can tell the RESOLVED bag from the template's.
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(resolveGetAtt(value))),
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

function resolveGetAtt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveGetAtt);
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'Fn::GetAtt')) return 3306;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveGetAtt(v)]));
}

const TYPE = 'AWS::EC2::SecurityGroupIngress';
const RULE = { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 };

const record = (deletionPolicy?: ResourceState['deletionPolicy']): ResourceState =>
  ({
    physicalId: 'sg-1|tcp|3306|3306',
    resourceType: TYPE,
    properties: { ...RULE },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...(deletionPolicy && { deletionPolicy }),
  }) as ResourceState;

describe('the deploy engine binds the stack records around each provider call (#4492)', () => {
  /** What each provider call saw, by logical id. */
  let seen: Record<string, { live: string[]; survivors: string[] } | undefined>;
  let provider: ResourceProvider;

  const observe = (logicalId: string): void => {
    const view = getStackRecords();
    seen[logicalId] = view && {
      live: [...view.live()].map(([id]) => id).sort(),
      survivors: [...view.survivors()].map(([id]) => id).sort(),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seen = {};
    provider = {
      create: vi.fn(async (logicalId: string) => {
        observe(logicalId);
        return { physicalId: `pid-${logicalId}`, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(async (logicalId: string) => {
        observe(logicalId);
      }),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
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
        getState: vi.fn(),
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
      } as unknown as never,
      {} as unknown as never,
      { getDirectDependencies: vi.fn().mockReturnValue([]) } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4 },
      'us-east-1'
    );
  }

  it('a CREATE sees the live records; DELETEs see as survivors only what the DELETE phase keeps or retains', async () => {
    const template = {
      Resources: {
        Kept: { Type: TYPE, Properties: { ...RULE } },
        Created: { Type: TYPE, Properties: { ...RULE } },
      },
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 10,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: { Kept: record(), Gone: record(), AlsoGone: record(), Retained: record('Retain') },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      ['Kept', { logicalId: 'Kept', changeType: 'NO_CHANGE', resourceType: TYPE } as ResourceChange],
      [
        'Created',
        {
          logicalId: 'Created',
          changeType: 'CREATE',
          resourceType: TYPE,
          desiredProperties: { ...RULE },
        } as unknown as ResourceChange,
      ],
      ['Gone', { logicalId: 'Gone', changeType: 'DELETE', resourceType: TYPE } as ResourceChange],
      ['AlsoGone', { logicalId: 'AlsoGone', changeType: 'DELETE', resourceType: TYPE } as ResourceChange],
      ['Retained', { logicalId: 'Retained', changeType: 'DELETE', resourceType: TYPE } as ResourceChange],
    ]);
    const engine = makeEngine();

    await (
      engine as unknown as {
        executeDeployment: (...args: unknown[]) => Promise<unknown>;
      }
    ).executeDeployment(template, currentState, changes, {}, [['Kept', 'Created']], 'MyStack', template);

    expect(seen['Created']).toEqual({
      live: ['AlsoGone', 'Gone', 'Kept', 'Retained'],
      survivors: ['Kept', 'Retained'],
    });
    // Neither concurrent delete counts the other as a survivor; the retained
    // record does, and so does the rule this deploy created.
    expect(seen['Gone']?.survivors).toEqual(['Created', 'Kept', 'Retained']);
    expect(seen['AlsoGone']?.survivors).toEqual(['Created', 'Kept', 'Retained']);
    expect(provider.delete).toHaveBeenCalledTimes(2);
  });

  it('a record whose UPDATE is in flight is in neither view, and joins both once it completes', async () => {
    let createdObserved!: () => void;
    const createDone = new Promise<void>((resolve) => {
      createdObserved = resolve;
    });
    provider.create = vi.fn(async (logicalId: string) => {
      observe(logicalId);
      createdObserved();
      return { physicalId: `pid-${logicalId}`, attributes: {} };
    }) as unknown as ResourceProvider['create'];
    provider.update = vi.fn(async (logicalId: string) => {
      // Hold the update open until the concurrent CREATE has looked.
      await createDone;
      return { physicalId: `pid-${logicalId}`, wasReplaced: false, attributes: {} };
    }) as unknown as ResourceProvider['update'];
    const template = {
      Resources: {
        Updating: { Type: TYPE, Properties: { ...RULE, Description: 'new' } },
        Created: { Type: TYPE, Properties: { ...RULE } },
      },
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 10,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: { Updating: record(), Gone: record() },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Updating',
        {
          logicalId: 'Updating',
          changeType: 'UPDATE',
          resourceType: TYPE,
          currentProperties: { ...RULE },
          desiredProperties: { ...RULE, Description: 'new' },
          propertyChanges: [{ path: 'Description', oldValue: undefined, newValue: 'new', requiresReplacement: false }],
        } as unknown as ResourceChange,
      ],
      [
        'Created',
        { logicalId: 'Created', changeType: 'CREATE', resourceType: TYPE, desiredProperties: { ...RULE } } as unknown as ResourceChange,
      ],
      ['Gone', { logicalId: 'Gone', changeType: 'DELETE', resourceType: TYPE } as ResourceChange],
    ]);

    await (
      makeEngine() as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> }
    ).executeDeployment(template, currentState, changes, {}, [['Updating', 'Created']], 'MyStack', template);

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(seen['Created']).toEqual({ live: ['Gone'], survivors: [] });
    expect(seen['Gone']?.survivors).toEqual(['Created', 'Updating']);
  });

  it('a record whose UPDATE has not been dispatched yet stays in both views', async () => {
    provider.update = vi.fn(async (logicalId: string) => ({
      physicalId: `pid-${logicalId}`,
      wasReplaced: false,
      attributes: {},
    })) as unknown as ResourceProvider['update'];
    const template = {
      Resources: {
        Pending: { Type: TYPE, Properties: { ...RULE, Description: 'new' } },
        Created: { Type: TYPE, Properties: { ...RULE } },
      },
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 10,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: { Pending: record() },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Pending',
        {
          logicalId: 'Pending',
          changeType: 'UPDATE',
          resourceType: TYPE,
          currentProperties: { ...RULE },
          desiredProperties: { ...RULE, Description: 'new' },
          propertyChanges: [{ path: 'Description', oldValue: undefined, newValue: 'new', requiresReplacement: false }],
        } as unknown as ResourceChange,
      ],
      [
        'Created',
        { logicalId: 'Created', changeType: 'CREATE', resourceType: TYPE, desiredProperties: { ...RULE } } as unknown as ResourceChange,
      ],
    ]);
    const engine = makeEngine();
    // `Pending` waits on `Created`, so it is not dispatched while `Created` runs.
    (engine as unknown as { dagBuilder: { getDirectDependencies: (d: unknown, id: string) => string[] } }).dagBuilder = {
      getDirectDependencies: (_d: unknown, id: string) => (id === 'Pending' ? ['Created'] : []),
    };

    await (engine as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> }).executeDeployment(
      template,
      currentState,
      changes,
      {},
      [['Created'], ['Pending']],
      'MyStack',
      template
    );

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(seen['Created']).toEqual({ live: ['Pending'], survivors: ['Pending'] });
  });

  it('exposes each create in flight with its resolved properties, settling true once its record is live', async () => {
    let bLooked!: () => void;
    const bHasLooked = new Promise<void>((resolve) => {
      bLooked = resolve;
    });
    const observed: Record<string, unknown> = {};
    provider.create = vi.fn(async (logicalId: string) => {
      if (logicalId === 'A') {
        // A holds until B has seen it in flight.
        await bHasLooked;
        return { physicalId: 'pid-A', attributes: {} };
      }
      const view = getStackRecords()!;
      const twin = [...view.inFlight!()].find((w) => w.logicalId === 'A')!;
      observed['props'] = twin.properties();
      observed['type'] = twin.resourceType;
      bLooked();
      // Through the engine-bound view: it must carry the waiting set, or the
      // wait answers `undefined` without waiting.
      observed['settled'] = await awaitInFlightSibling(view, 'B', twin);
      observed['liveAfter'] = [...view.live()].map(([id]) => id).sort();
      observed['inFlightAfter'] = [...view.inFlight!()].map((w) => w.logicalId);
      return { physicalId: 'pid-B', attributes: {} };
    }) as unknown as ResourceProvider['create'];
    const template = {
      Resources: {
        A: { Type: TYPE, Properties: { ...RULE, Description: 'a' } },
        B: { Type: TYPE, Properties: { ...RULE, Description: 'b' } },
      },
    } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 10,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    // A's port is the template's intrinsic; the in-flight bag must be resolved.
    (template.Resources!['A']!.Properties as Record<string, unknown>)['FromPort'] = {
      'Fn::GetAtt': ['Cluster', 'Endpoint.Port'],
    };
    const create = (id: string, d: string) =>
      [id, { logicalId: id, changeType: 'CREATE', resourceType: TYPE, desiredProperties: { ...RULE, Description: d } }] as [
        string,
        ResourceChange,
      ];
    const changes = new Map<string, ResourceChange>([create('A', 'a'), create('B', 'b')]);
    changes.get('A')!.desiredProperties!['FromPort'] = { 'Fn::GetAtt': ['Cluster', 'Endpoint.Port'] };

    await (makeEngine() as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> }).executeDeployment(
      template,
      currentState,
      changes,
      {},
      [['A', 'B']],
      'MyStack',
      template
    );

    expect(observed).toEqual({
      props: { ...RULE, Description: 'a' },
      type: TYPE,
      settled: true,
      liveAfter: ['A'],
      inFlightAfter: ['B'],
    });
  });

  it('an in-flight UPDATE twin is in live() by the time it settles true', async () => {
    let bLooked!: () => void;
    const bHasLooked = new Promise<void>((resolve) => {
      bLooked = resolve;
    });
    const observed: Record<string, unknown> = {};
    provider.update = vi.fn(async (logicalId: string) => {
      await bHasLooked;
      return { physicalId: `pid-${logicalId}`, wasReplaced: false, attributes: {} };
    }) as unknown as ResourceProvider['update'];
    provider.create = vi.fn(async (logicalId: string) => {
      const view = getStackRecords()!;
      const twin = [...view.inFlight!()].find((w) => w.logicalId === 'A')!;
      observed['liveBefore'] = [...view.live()].map(([id]) => id);
      bLooked();
      observed['settled'] = await twin.settled;
      observed['liveAfter'] = [...view.live()].map(([id]) => id).sort();
      return { physicalId: `pid-${logicalId}`, attributes: {} };
    }) as unknown as ResourceProvider['create'];
    const template = {
      Resources: {
        A: { Type: TYPE, Properties: { ...RULE, Description: 'new' } },
        B: { Type: TYPE, Properties: { ...RULE } },
      },
    } as unknown as CloudFormationTemplate;
    const changes = new Map<string, ResourceChange>([
      [
        'A',
        {
          logicalId: 'A',
          changeType: 'UPDATE',
          resourceType: TYPE,
          currentProperties: { ...RULE },
          desiredProperties: { ...RULE, Description: 'new' },
          propertyChanges: [{ path: 'Description', oldValue: undefined, newValue: 'new', requiresReplacement: false }],
        } as unknown as ResourceChange,
      ],
      ['B', { logicalId: 'B', changeType: 'CREATE', resourceType: TYPE, desiredProperties: { ...RULE } } as unknown as ResourceChange],
    ]);

    await (makeEngine() as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> }).executeDeployment(
      template,
      { version: 10, stackName: 'MyStack', region: 'us-east-1', resources: { A: record() }, outputs: {}, lastModified: 0 },
      changes,
      {},
      [['A', 'B']],
      'MyStack',
      template
    );

    // Hidden while its update is in flight, visible once it settles.
    expect(observed).toEqual({ liveBefore: [], settled: true, liveAfter: ['A'] });
  });

  it('a failed create settles false', async () => {
    let settledTo: boolean | undefined;
    let aStarted!: () => void;
    const aIsRunning = new Promise<void>((resolve) => {
      aStarted = resolve;
    });
    provider.create = vi.fn(async (logicalId: string) => {
      if (logicalId === 'A') {
        aStarted();
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('boom');
      }
      await aIsRunning;
      const twin = [...getStackRecords()!.inFlight!()].find((w) => w.logicalId === 'A')!;
      settledTo = await twin.settled;
      return { physicalId: 'pid-B', attributes: {} };
    }) as unknown as ResourceProvider['create'];
    const template = {
      Resources: { A: { Type: TYPE, Properties: { ...RULE } }, B: { Type: TYPE, Properties: { ...RULE } } },
    } as unknown as CloudFormationTemplate;
    const changes = new Map<string, ResourceChange>(
      ['A', 'B'].map((id) => [
        id,
        { logicalId: id, changeType: 'CREATE', resourceType: TYPE, desiredProperties: { ...RULE } } as unknown as ResourceChange,
      ])
    );

    await (makeEngine() as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> })
      .executeDeployment(
        template,
        { version: 10, stackName: 'MyStack', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 0 },
        changes,
        {},
        [['A', 'B']],
        'MyStack',
        template
      )
      .catch(() => undefined);

    expect(settledTo).toBe(false);
  });

  it('nothing is bound for a provider call outside a deploy', async () => {
    const engine = makeEngine();
    await (
      engine as unknown as {
        provisionResource: (
          id: string,
          c: ResourceChange,
          s: Record<string, ResourceState>,
          stack: string,
          t: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource(
      'Created',
      { logicalId: 'Created', changeType: 'CREATE', resourceType: TYPE, desiredProperties: { ...RULE } } as unknown as ResourceChange,
      {},
      'MyStack',
      { Resources: { Created: { Type: TYPE, Properties: { ...RULE } } } } as unknown as CloudFormationTemplate
    );

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(seen['Created']).toBeUndefined();
  });
});
