/**
 * go-to-k/cdkd#5111: a replacement whose old resource's delete is refused
 * "in use" (the old target group a listener still points at) defers the
 * delete to the end of the deploy (#4900). The deferral used to live in
 * memory only, while the row's save already recorded the NEW resource: a
 * deploy killed before its cleanup left the old target group in AWS with no
 * record, and nothing ever deleted it. The old resource is now recorded in
 * `StackState.supersededResources` by that same save, and every later deploy
 * retries it at its cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { retryCarriedSupersededResources } from '../../../src/deployment/deploy-engine/superseded-retry.js';
import {
  holdsSupersededResources,
  isInUseRefusal,
  supersededInUseRetry,
  supersededResourcesOf,
} from '../../../src/deployment/superseded-resources.js';
import { recordCanOwnResources } from '../../../src/state/cross-prefix-stack-scan.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import {
  type ResourceChange,
  type ResourceState,
  type StackState,
  type SupersededResourceRecord,
  stackInstanceIdCarriedFrom,
} from '../../../src/types/state.js';

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

const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const OLD_TG = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/Tg-gen1/aaa';
const NEW_TG = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/Tg-gen2/bbb';
const LISTENER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/Alb/1/2';

/** ELBv2's refusal, shaped as the SDK raises it. */
function inUse(arn: string): Error {
  const error = new Error(
    `Target group '${arn}' is currently in use by a listener or a rule`
  );
  error.name = 'ResourceInUseException';
  return error;
}

function record(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): ResourceState {
  return { physicalId, resourceType, properties, attributes: {}, dependencies: [] };
}

describe('a replaced resource whose delete is refused in use stays recorded (#5111)', () => {
  let provider: ResourceProvider;
  /** The target group the listener forwards to, as AWS sees it. */
  let listenerTarget: string;
  let saved: StackState[];
  let saveState: ReturnType<typeof vi.fn>;
  const retryDefaults = { ...supersededInUseRetry };

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    listenerTarget = OLD_TG;
    saved = [];
    supersededInUseRetry.delayMs = 0;
    saveState = vi.fn(async (_stack: string, _region: string, state: StackState) => {
      saved.push(structuredClone(state));
      return 'etag';
    });
    provider = {
      create: vi.fn(async () => ({ physicalId: NEW_TG, attributes: {} })),
      update: vi.fn(async (_logicalId: string, physicalId: string, _type: string, props) => {
        listenerTarget = (props as { DefaultActions: string }).DefaultActions;
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        if (physicalId === listenerTarget) throw inUse(physicalId);
        return undefined;
      }),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  afterEach(() => {
    Object.assign(supersededInUseRetry, retryDefaults);
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
        saveState,
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Listener' ? ['Tg'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4 } as never,
      'us-east-1'
    );
  }

  const template = {
    Resources: {
      Tg: { Type: TG, Properties: { Port: 9090 } },
      Listener: { Type: LISTENER, Properties: { DefaultActions: NEW_TG } },
    },
  } as unknown as CloudFormationTemplate;

  const listenerChange: ResourceChange = {
    logicalId: 'Listener',
    changeType: 'UPDATE',
    resourceType: LISTENER,
    currentProperties: { DefaultActions: OLD_TG },
    desiredProperties: { DefaultActions: NEW_TG },
    propertyChanges: [
      { path: 'DefaultActions', oldValue: OLD_TG, newValue: NEW_TG, requiresReplacement: false },
    ],
  } as unknown as ResourceChange;

  async function run(
    currentState: StackState,
    changes: Map<string, ResourceChange>,
    engine = makeEngine()
  ): Promise<StackState> {
    const levels = [['Tg'], ['Listener']].filter((level) => changes.has(level[0]!));
    const result = await executeDeployment(
      engine,
      template,
      currentState,
      changes,
      {} as never,
      levels,
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    );
    // What the deploy's final save persists.
    return engine.withParentInfo(result.state);
  }

  /** The deploy that replaces Tg (Port 8080 -> 9090) and re-points the listener. */
  function replacingDeploy(): { state: StackState; changes: Map<string, ResourceChange> } {
    const state = {
      version: 13,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Tg: record(OLD_TG, TG, { Port: 8080 }),
        Listener: record(LISTENER_ARN, LISTENER, { DefaultActions: OLD_TG }),
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Tg',
        {
          logicalId: 'Tg',
          changeType: 'UPDATE',
          resourceType: TG,
          currentProperties: { Port: 8080 },
          desiredProperties: { Port: 9090 },
          propertyChanges: [{ path: 'Port', oldValue: 8080, newValue: 9090, requiresReplacement: true }],
        } as unknown as ResourceChange,
      ],
      ['Listener', listenerChange],
    ]);
    return { state, changes };
  }

  it("records the old target group in the SAME save that records the new one", async () => {
    const { state, changes } = replacingDeploy();

    const final = await run(state, changes);

    // The save a kill right after the Tg row would leave behind.
    const afterTgRow = saved.find((s) => s.resources['Tg']?.physicalId === NEW_TG);
    expect(afterTgRow).toBeDefined();
    expect(supersededResourcesOf(afterTgRow).map((e) => [e.logicalId, e.state.physicalId])).toEqual(
      [['Tg', OLD_TG]]
    );
    // The deploy's own cleanup then deleted it, and the final save drops it.
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual([OLD_TG, OLD_TG]);
    expect(final.supersededResources).toBeUndefined();
  });

  it('a re-run after a kill before the cleanup deletes the recorded target group (the D1 sequence)', async () => {
    // What the killed run persisted: Tg at its new copy, the listener not yet
    // moved (AWS still forwards to the old one), and the old one recorded.
    const { state, changes } = replacingDeploy();
    await run(state, changes, makeEngine()).catch(() => undefined);
    const killedAt = saved.find((s) => s.resources['Tg']?.physicalId === NEW_TG)!;
    expect(killedAt.resources['Listener']!.properties['DefaultActions']).toBe(OLD_TG);
    listenerTarget = OLD_TG;
    vi.mocked(provider.delete).mockClear();
    saved = [];

    // The re-run: only the listener differs from the record.
    const order: string[] = [];
    const del = provider.delete;
    provider.delete = vi.fn(async (...args: Parameters<ResourceProvider['delete']>) => {
      order.push(`delete ${args[1] === OLD_TG ? 'old' : 'other'} (listener on ${listenerTarget === OLD_TG ? 'old' : 'new'})`);
      return del(...args);
    }) as unknown as ResourceProvider['delete'];
    const final = await run(structuredClone(killedAt), new Map([['Listener', listenerChange]]));

    expect(order).toEqual(['delete old (listener on new)']);
    expect(final.supersededResources).toBeUndefined();
    expect(printed.info.some((l) => l.includes(`Old Tg (${OLD_TG}) deleted`))).toBe(true);
  });

  it('keeps the record, and says how it will be removed, when the delete is still refused', async () => {
    supersededInUseRetry.attempts = 3;
    const { state, changes } = replacingDeploy();
    // The listener never moves off the old target group.
    vi.mocked(provider.update).mockImplementation(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    }));

    const final = await run(state, changes);

    // One in-DAG attempt, then the cleanup's three.
    expect(vi.mocked(provider.delete).mock.calls.map((c) => c[1])).toEqual([
      OLD_TG,
      OLD_TG,
      OLD_TG,
      OLD_TG,
    ]);
    expect(supersededResourcesOf(final).map((e) => e.state.physicalId)).toEqual([OLD_TG]);
    const warned = printed.warn.filter((l) => l.includes(`Failed to delete old resource Tg (${OLD_TG})`));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('cdkd keeps it in state');
    expect(warned[0]).toContain('cdkd destroy');
  });

  it('a later deploy still refused keeps the record and warns', async () => {
    supersededInUseRetry.attempts = 2;
    const entry: SupersededResourceRecord = {
      logicalId: 'Tg',
      supersededAt: 1,
      state: record(OLD_TG, TG, { Port: 8080 }),
    };
    const state = {
      version: 13,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Tg: record(NEW_TG, TG, { Port: 9090 }),
        Listener: record(LISTENER_ARN, LISTENER, { DefaultActions: OLD_TG }),
      },
      supersededResources: [entry],
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    // The listener update is a no-op in AWS here: still on the old one.
    vi.mocked(provider.update).mockImplementation(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    }));

    const final = await run(state, new Map([['Listener', listenerChange]]));

    expect(provider.delete).toHaveBeenCalledTimes(2);
    expect(supersededResourcesOf(final).map((e) => e.state.physicalId)).toEqual([OLD_TG]);
    expect(
      printed.warn.some(
        (l) => l.includes(`Failed to delete old resource Tg (${OLD_TG})`) && l.includes('cdkd keeps it in state')
      )
    ).toBe(true);
  });

  it('drops, without deleting, an entry a record holds again (a rollback took it back)', async () => {
    const engine = makeEngine();
    const held: SupersededResourceRecord = {
      logicalId: 'Tg',
      supersededAt: 1,
      state: record(OLD_TG, TG, { Port: 8080 }),
    };
    const host: StackState = {
      version: 13,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: { Tg: record(OLD_TG, TG, { Port: 8080 }) },
      supersededResources: [held],
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;

    const changed = await retryCarriedSupersededResources(engine, host, [held], host.resources);

    expect(changed).toBe(true);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(host.supersededResources).toBeUndefined();
    // ...and the persist choke point never writes one either.
    expect(
      engine.withParentInfo({ ...host, supersededResources: [held] }).supersededResources
    ).toBeUndefined();
  });

  it('the persist choke point keeps an entry no record holds', () => {
    const engine = makeEngine();
    const entry: SupersededResourceRecord = {
      logicalId: 'Tg',
      supersededAt: 1,
      state: record(OLD_TG, TG, { Port: 8080 }),
    };
    const persisted = engine.withParentInfo({
      version: 13,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: { Tg: record(NEW_TG, TG, { Port: 9090 }) },
      supersededResources: [entry],
      outputs: {},
      lastModified: 0,
    } as unknown as StackState);

    expect(supersededResourcesOf(persisted).map((e) => e.state.physicalId)).toEqual([OLD_TG]);
  });
});

describe('the supersededResources field travels with the record (#5111)', () => {
  const entry: SupersededResourceRecord = {
    logicalId: 'Tg',
    supersededAt: 1,
    state: record(OLD_TG, TG, {}),
  };

  it('every field-enumerating writer carries it', () => {
    expect(stackInstanceIdCarriedFrom({ supersededResources: [entry] })).toEqual({
      supersededResources: [entry],
    });
    expect(stackInstanceIdCarriedFrom({})).toEqual({});
  });

  it('a record holding one is not empty', () => {
    expect(recordCanOwnResources({ resources: {}, supersededResources: [entry] }, null)).toBe(true);
    expect(recordCanOwnResources({ resources: {}, supersededResources: 'x' }, null)).toBe(true);
    expect(recordCanOwnResources({ resources: {}, supersededResources: [] }, null)).toBe(false);
    expect(holdsSupersededResources({ supersededResources: [entry] })).toBe(true);
    expect(holdsSupersededResources({})).toBe(false);
  });

  it('reads only well-formed entries', () => {
    expect(
      supersededResourcesOf({
        supersededResources: [entry, { logicalId: 'X' }, null] as unknown as SupersededResourceRecord[],
      })
    ).toEqual([entry]);
    expect(supersededResourcesOf({ supersededResources: 'x' as never })).toEqual([]);
  });

  it('an in-use refusal is recognised through a wrapping error, nothing else is', () => {
    expect(isInUseRefusal(inUse(OLD_TG))).toBe(true);
    expect(isInUseRefusal(new Error('wrapped', { cause: inUse(OLD_TG) }))).toBe(true);
    expect(isInUseRefusal(new Error('ConflictException: in use'))).toBe(false);
  });
});
