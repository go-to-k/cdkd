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
import { warnUnretriedReplacedDeletes } from '../../../src/deployment/deploy-engine/replacement.js';
import { retryCarriedSupersededResources } from '../../../src/deployment/deploy-engine/superseded-retry.js';
import {
  addSuperseded,
  canRecordSuperseded,
  deleteSupersededEntry,
  holdsSupersededResources,
  isInUseRefusal,
  isSupersededHeld,
  supersededHolderOf,
  retryWhileInUse,
  supersededInUseRetry,
  supersededResourcesOf,
} from '../../../src/deployment/superseded-resources.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction/log-only.js';
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

    // One attempt: an entry still in use must not slow every later deploy.
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(supersededResourcesOf(final).map((e) => e.state.physicalId)).toEqual([OLD_TG]);
    expect(
      printed.warn.some(
        (l) => l.includes(`Failed to delete old resource Tg (${OLD_TG})`) && l.includes('cdkd keeps it in state')
      )
    ).toBe(true);
  });

  it('a re-run that replaces the load balancer waits out the in-use refusal on the recorded target group (D1, integ run 3)', async () => {
    // What the killed run persisted: Tg at generation 2, generation 1 recorded
    // as superseded, the listener still on the OLD load balancer forwarding to
    // generation 1. The re-run replaces the load balancer (its listener moves to
    // the new one); the old listener goes asynchronously with the old load
    // balancer, so generation 1 still refuses its delete for a moment.
    supersededInUseRetry.attempts = 6;
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
    // The listener is replaced (a new one on the new load balancer)...
    vi.mocked(provider.update).mockImplementation(async () => ({
      physicalId: `${LISTENER_ARN}-new`,
      wasReplaced: true,
      attributes: {},
    }));
    // ...and AWS still sees the old one using generation 1 for two attempts.
    let refusals = 2;
    vi.mocked(provider.delete).mockImplementation(async (_l: string, physicalId: string) => {
      if (physicalId === OLD_TG && refusals-- > 0) throw inUse(OLD_TG);
      return undefined;
    });

    const final = await run(state, new Map([['Listener', listenerChange]]));

    expect(vi.mocked(provider.delete).mock.calls.filter((c) => c[1] === OLD_TG)).toHaveLength(3);
    expect(final.supersededResources).toBeUndefined();
    expect(printed.warn.some((l) => l.includes('Failed to delete old resource Tg'))).toBe(false);
  });

  it('never records a deferred delete whose id another record holds', async () => {
    const { state, changes } = replacingDeploy();
    // Another record names the same id (any type): a later run must never
    // delete it.
    state.resources['Other'] = record(OLD_TG, 'AWS::Other::Thing', {});
    supersededInUseRetry.attempts = 1;
    // The listener never moves, so the deploy's own retry fails too.
    vi.mocked(provider.update).mockImplementation(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
      attributes: {},
    }));

    await run(state, changes).catch(() => undefined);

    expect(saved.some((s) => s.supersededResources !== undefined)).toBe(false);
    // Not recorded at all, so the warning does not claim state keeps it.
    const warned = printed.warn.filter((l) => l.includes(`Failed to delete old resource Tg`));
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain('cdkd keeps it in state');
  });

  it('a carried entry another TYPE of record names is not deleted, and the drop warns', async () => {
    const engine = makeEngine();
    const entry: SupersededResourceRecord = {
      logicalId: 'Tg',
      supersededAt: 1,
      state: record(OLD_TG, TG, {}),
    };
    const host = { supersededResources: [entry] } as StackState;

    const changed = await retryCarriedSupersededResources(engine, host, [entry], {
      Other: record(OLD_TG, 'AWS::Other::Thing', {}),
    });

    expect(changed).toBe(true);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(host.supersededResources).toBeUndefined();
    expect(printed.warn.some((l) => l.includes('AWS::Other::Thing record of this stack has the same physical id'))).toBe(true);
    // The persist choke point keeps it until then: only a same-type holder drops it silently.
    expect(
      supersededResourcesOf(
        engine.withParentInfo({
          version: 13,
          stackName: 'MyStack',
          region: 'us-east-1',
          resources: { Other: record(OLD_TG, 'AWS::Other::Thing', {}) },
          supersededResources: [entry],
          outputs: {},
          lastModified: 0,
        } as unknown as StackState)
      )
    ).toHaveLength(1);
  });

  it('prefers a same-type holder, so no other-type warning fires beside it', () => {
    const entry: SupersededResourceRecord = {
      logicalId: 'Tg',
      supersededAt: 1,
      state: record(OLD_TG, TG, {}),
    };
    expect(
      supersededHolderOf(entry, {
        A: record(OLD_TG, 'AWS::Other::Thing', {}),
        B: record(OLD_TG, TG, {}),
      })?.resourceType
    ).toBe(TG);
  });

  it('an entry is held by a record of ANY type naming its id', () => {
    const entry: SupersededResourceRecord = {
      logicalId: 'Tg',
      supersededAt: 1,
      state: record(OLD_TG, TG, {}),
    };
    expect(isSupersededHeld(entry, { X: record(OLD_TG, 'AWS::Other::Thing', {}) })).toBe(true);
    expect(isSupersededHeld(entry, { X: record(NEW_TG, TG, {}) })).toBe(false);
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

  it("masks the OLD record's secret-derived name, judged on its own record", async () => {
    // The old copy's name came from a secret the new copy no longer uses.
    const secretName = 'tg-s3cr3t-v1';
    const engine = makeEngine();
    const old = record(secretName, TG, { Name: '{{resolve:secretsmanager:tg-name}}' });
    const entry: SupersededResourceRecord = { logicalId: 'Tg', supersededAt: 1, state: old };
    const host = { supersededResources: [entry] } as StackState;
    vi.mocked(provider.delete).mockRejectedValueOnce(new Error(`Cannot delete ${secretName}: in use`));

    await retryCarriedSupersededResources(engine, host, [entry], {
      Tg: record(NEW_TG, TG, { Name: 'plain' }),
    });

    const all = [...printed.info, ...printed.warn].join('\n');
    expect(all).toContain('Failed to delete old resource Tg');
    expect(all).not.toContain(secretName);
  });

  it('a deferral left unretried says whether state still tracks it', () => {
    const engine = makeEngine();
    const run = engine.replacementRun;
    const deferred = (physicalId: string) => ({
      physicalId,
      resourceType: TG,
      provisionedBy: undefined,
      failureMessage: 'in use',
      retry: async () => undefined,
    });
    run.deferredReplacedDeletes = new Map([
      ['Tg', deferred(OLD_TG)],
      ['Masked', deferred('masked-id')],
    ]);
    // Only Tg's was recorded (`canRecordSuperseded` refused the masked one).
    run.supersededEntries.set('Tg', { logicalId: 'Tg', supersededAt: 1, state: record(OLD_TG, TG, {}) });

    warnUnretriedReplacedDeletes(run, engine.replacementDeps(), 'failed');

    const tg = printed.warn.find((l) => l.includes(`old resource Tg (${OLD_TG})`));
    const masked = printed.warn.find((l) => l.includes('old resource Masked (masked-id)'));
    expect(tg).toContain('cdkd keeps it in state');
    expect(masked).toContain('no longer tracked in state');
    expect(masked).not.toContain('keeps it in state');
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

  // A Lambda web function revision an endpoint still routes to: the class is
  // ConflictException, which alone also means "not Active yet".
  const conflict = (message: string): Error =>
    new Error('Failed to delete Lambda web function revision Revision: ConflictException.', {
      cause: Object.assign(new Error(message), { name: 'ConflictException' }),
    });
  const revisionInUse = (): Error =>
    conflict('The revision rev-old cannot be deleted because the endpoints [prod] are using it.');

  it("a web function revision's in-use conflict is one; another conflict is not", () => {
    expect(isInUseRefusal(revisionInUse())).toBe(true);
    expect(isInUseRefusal(conflict('Only revisions in Active state can be deployed'))).toBe(false);
    // The message alone, without the class, is not.
    expect(isInUseRefusal(new Error('endpoints [prod] are using it'))).toBe(false);
  });

  it("a revision's retry waits out its in-use conflict; a first success sends once and never waits", async () => {
    const defaults = { ...supersededInUseRetry };
    supersededInUseRetry.delayMs = 0;
    supersededInUseRetry.attempts = 5;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const freed = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(revisionInUse())
        .mockResolvedValueOnce('deleted');
      await expect(retryWhileInUse(freed, () => false)).resolves.toBe('deleted');
      expect(freed).toHaveBeenCalledTimes(2);

      timers.mockClear();
      const first = vi.fn(async () => 'deleted');
      await expect(retryWhileInUse(first, () => false)).resolves.toBe('deleted');
      expect(first).toHaveBeenCalledTimes(1);
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
      Object.assign(supersededInUseRetry, defaults);
    }
  });

  it('records a deferral only where a later run can send the same delete', () => {
    expect(canRecordSuperseded(record(OLD_TG, TG, {}), {})).toBe(true);
    expect(canRecordSuperseded(record('p', 'AWS::IAM::Policy', {}), {})).toBe(false);
    expect(canRecordSuperseded(record('p', 'AWS::IAM::RolePolicy', {}), {})).toBe(false);
    expect(canRecordSuperseded(record(OLD_TG, TG, {}), { inlinePolicyClaimed: () => false })).toBe(
      false
    );
    expect(canRecordSuperseded(record(OLD_TG, TG, {}), { noEchoDeleteValues: new Map() })).toBe(
      false
    );
    expect(
      canRecordSuperseded({ ...record(OLD_TG, TG, {}), noEchoLeaves: [['Secret']] }, {})
    ).toBe(false);
  });

  it('records one entry per resource', () => {
    const host: Pick<StackState, 'supersededResources'> = { supersededResources: [entry] };
    const again = { ...entry, supersededAt: 2 };
    addSuperseded(host, again);
    expect(host.supersededResources).toEqual([again]);
  });

  it("uses only the recorded run's --skip-final-snapshot consent", async () => {
    const del = vi.fn(async (..._args: unknown[]) => undefined);
    const provider = { delete: del } as unknown as ResourceProvider;
    const base = { region: 'us-east-1', maskSecrets: (t: string) => t, stop: () => false };
    await deleteSupersededEntry(entry, { provider, ...base });
    expect(del.mock.calls[0]![4]).not.toHaveProperty('skipFinalSnapshot');
    await deleteSupersededEntry({ ...entry, skipFinalSnapshot: true }, { provider, ...base });
    expect(del.mock.calls[1]![4]).toHaveProperty('skipFinalSnapshot', true);
  });

  it('the in-use wait stops on an interrupt during the wait, sending nothing more', async () => {
    const defaults = { ...supersededInUseRetry };
    supersededInUseRetry.delayMs = 0;
    supersededInUseRetry.attempts = 5;
    try {
      // Not interrupted when the refusal arrives; interrupted during the wait.
      let checks = 0;
      const stop = (): boolean => ++checks > 1;
      const send = vi.fn(async () => {
        throw inUse(OLD_TG);
      });
      await expect(retryWhileInUse(send, stop)).rejects.toThrow('in use');
      expect(send).toHaveBeenCalledTimes(1);

      const always = vi.fn(async () => {
        throw inUse(OLD_TG);
      });
      await expect(retryWhileInUse(always, () => false)).rejects.toThrow('in use');
      expect(always).toHaveBeenCalledTimes(5);

      const other = vi.fn(async () => {
        throw new Error('AccessDenied');
      });
      await expect(retryWhileInUse(other, () => false)).rejects.toThrow('AccessDenied');
      expect(other).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(supersededInUseRetry, defaults);
    }
  });
});
