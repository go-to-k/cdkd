/**
 * go-to-k/cdkd#4705 (C), through the real deploy engine: a deploy's
 * generated-name lookups all start once the plan is known, before the first
 * create (one call per type, whatever the DAG depth); the names are recorded
 * in the create-token ledger before any create is sent; a held name is refused
 * before its provider `create()`; a name this stack's record licenses is
 * created as before; a dry run asks nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { getLogger } from '../../../src/utils/logger.js';
import { DEFAULT_TIMING } from '../../../src/deployment/generated-name-guard.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
  getAccountInfo: vi.fn(async () => ({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const STACK = 'App';
const QUEUE = 'AWS::SQS::Queue';
const urlOf = (name: string) => `https://sqs.us-east-1.amazonaws.com/123456789012/${name}`;

describe('the generated-name guard through the deploy engine (go-to-k/cdkd#4705)', () => {
  let events: string[];

  const cooldown = DEFAULT_TIMING.cooldownMs;
  beforeEach(() => {
    events = [];
    // A held queue is otherwise re-read for 65 s while it may be deleting.
    DEFAULT_TIMING.cooldownMs = 0;
  });
  afterEach(() => {
    DEFAULT_TIMING.cooldownMs = cooldown;
  });

  // Q1 <- Q2 <- Q3: three DAG levels.
  const template: CloudFormationTemplate = {
    Resources: {
      Q1: { Type: QUEUE, Properties: {} },
      Q2: { Type: QUEUE, Properties: {}, DependsOn: ['Q1'] },
      Q3: { Type: QUEUE, Properties: {}, DependsOn: ['Q2'] },
    },
  };
  const create = (logicalId: string): ResourceChange => ({
    logicalId,
    changeType: 'CREATE',
    resourceType: QUEUE,
    desiredProperties: {},
    propertyChanges: [],
  });

  function buildEngine(opts: {
    holders?: Record<string, string>;
    records?: Record<string, ResourceState>;
    dryRun?: boolean;
    retained?: Array<{ logicalId: string; resourceType: string; physicalId: string }>;
    /** Replaces the lookup's answer (after it is recorded in `events`). */
    lookup?: (names: readonly string[]) => Promise<Map<string, string>>;
    refusalRecovery?: Record<string, string>;
    /** Per logical id: a create that throws this error instead. */
    createFails?: Record<string, Error>;
    /** The earlier record versions `loadKeptInHistory` reads. */
    earlierRecords?: Array<{ resources: Record<string, unknown>; writtenAt?: number }>;
    /** Run `--require-approval any-change` with this answer. */
    approve?: () => Promise<boolean>;
  }) {
    const provider = {
      generatedCreateName: vi.fn((_t: string, logicalId: string) => `${STACK}-${logicalId}`),
      lookupNames: vi.fn(async (_t: string, names: readonly string[]) => {
        events.push(`lookup:${names.join(',')}`);
        if (opts.lookup) return opts.lookup(names);
        return new Map(names.flatMap((n) => (opts.holders?.[n] ? [[n, opts.holders[n]!] as const] : [])));
      }),
      create: vi.fn(async (logicalId: string) => {
        events.push(`create:${logicalId}`);
        const fails = opts.createFails?.[logicalId];
        if (fails) throw fails;
        return { physicalId: urlOf(`${STACK}-${logicalId}`), attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const ownState: StackState = {
      version: 1,
      stackName: STACK,
      region: 'us-east-1',
      resources: opts.records ?? {},
      outputs: {},
      lastModified: 1,
    };
    let ledgerDoc: unknown = null;
    const stateBackend = {
      getState: vi.fn(async () => (opts.records ? { state: ownState, etag: 'e0' } : null)),
      saveState: vi.fn().mockResolvedValue('e1'),
      listStacks: vi.fn(async () => []),
      loadRollbackJournal: vi.fn(async () => null),
      loadRetainedResources: vi.fn(async () => opts.retained ?? []),
      loadRetainedRecord: vi.fn(async () => opts.retained ?? null),
      earlierStateResources: vi.fn(async () => opts.earlierRecords ?? []),
      // The event history reader: no index, no runs.
      getRawObject: vi.fn(async () => null),
      listRawKeys: vi.fn(async () => []),
      saveRetainedResources: vi.fn(async () => undefined),
      deleteRollbackJournal: vi.fn(async () => undefined),
      loadCreateTokenLedger: vi.fn(async () => ledgerDoc),
      saveCreateTokenLedger: vi.fn(async (_s: string, _r: string, doc: unknown) => {
        events.push('ledger-write');
        ledgerDoc = JSON.parse(JSON.stringify(doc));
      }),
    };
    const deps: Record<string, string[]> = { Q1: [], Q2: ['Q1'], Q3: ['Q2'] };
    const engine = new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Q1'], ['Q2'], ['Q3']]),
        getDirectDependencies: vi.fn((_dag: unknown, id: string) => deps[id] ?? []),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(
          new Map(['Q1', 'Q2', 'Q3'].map((id) => [id, create(id)]))
        ),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi.fn((changes: Map<string, ResourceChange>, type: string) =>
          [...changes.values()].filter((c) => c.changeType === type)
        ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        getCloudControlProvider: vi.fn(),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        concurrency: 4,
        ...(opts.dryRun && { dryRun: true }),
        ...(opts.refusalRecovery && { refusalRecovery: opts.refusalRecovery }),
        ...(opts.approve && { requireApproval: 'any-change', approveDeployment: opts.approve }),
      },
      'us-east-1'
    );
    const adoptIntents = (): string[] =>
      Object.entries((ledgerDoc as { sent?: Record<string, { base: string }> } | null)?.sent ?? {})
        .filter(([, e]) => e.base.startsWith('adopt-by-name:'))
        .map(([id]) => id)
        .sort();
    return { engine, provider, stateBackend, adoptIntents };
  }

  it('looks every planned name up in ONE call before the first create, and records them before any create', async () => {
    const { engine, provider } = buildEngine({});
    await engine.deploy(STACK, template);
    expect(provider.lookupNames).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe('lookup:App-Q1,App-Q2,App-Q3');
    const firstCreate = events.findIndex((e) => e.startsWith('create:'));
    expect(events.indexOf('ledger-write')).toBeGreaterThan(-1);
    expect(events.indexOf('ledger-write')).toBeLessThan(firstCreate);
    expect(events.filter((e) => e.startsWith('create:'))).toEqual(['create:Q1', 'create:Q2', 'create:Q3']);
  });

  it('refuses a held name before its create() is called (CloudFormation-style "already exists")', async () => {
    const { engine, provider } = buildEngine({ holders: { 'App-Q2': urlOf('App-Q2') } });
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Q2/);
    expect(provider.create.mock.calls.map((c) => c[0])).not.toContain('Q2');
    expect(provider.create.mock.calls.map((c) => c[0])).not.toContain('Q3');
  });

  it('CB-3/CB-10: the refusal names this resource as not created, and its import carries the account flags', async () => {
    const { engine } = buildEngine({
      holders: { 'App-Q1': urlOf('App-Q1') },
      refusalRecovery: { profile: 'dev', stateBucket: 'my-bucket', statePrefix: 'team-a' },
    });
    const error = await engine.deploy(STACK, template).catch((e: unknown) => e);
    const text = [error, (error as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : ''))
      .join('\n');
    const all = `${text}\n${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`;
    expect(all).toMatch(/Q1 was not created/);
    expect(all).not.toMatch(/Nothing was created/);
    expect(all).toMatch(
      /cdkd import App --resource 'Q1=https:\/\/sqs\.us-east-1\.amazonaws\.com\/123456789012\/App-Q1' --profile dev --state-bucket my-bucket --state-prefix team-a/
    );
  });

  it("creates a name this stack's record licenses, as before", async () => {
    const records = {
      Other: { physicalId: urlOf('App-Q2'), resourceType: QUEUE, properties: {} } as ResourceState,
    };
    const { engine, provider } = buildEngine({ holders: { 'App-Q2': urlOf('App-Q2') }, records });
    await engine.deploy(STACK, template).catch(() => undefined);
    expect(provider.create.mock.calls.map((c) => c[0])).toContain('Q2');
  });

  it('takes back what a destroy here kept, then lets retained.json forget it once the record names it', async () => {
    const kept = [
      { logicalId: 'Q2', resourceType: QUEUE, physicalId: urlOf('App-Q2') },
      { logicalId: 'Gone', resourceType: QUEUE, physicalId: urlOf('App-Gone') },
    ];
    const { engine, provider, stateBackend } = buildEngine({
      holders: { 'App-Q2': urlOf('App-Q2') },
      retained: kept,
    });
    await engine.deploy(STACK, template);
    expect(provider.create.mock.calls.map((c) => c[0])).toContain('Q2');
    expect(stateBackend.saveRetainedResources).toHaveBeenCalledWith(STACK, 'us-east-1', [kept[1]]);
  });

  it('a lookup that FAILS refuses every create it was asked about: nothing is created (fail closed)', async () => {
    const { engine, provider } = buildEngine({
      lookup: () => Promise.reject(Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' })),
    });
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Q1/);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('a create WAITS for a slow lookup, and a holder it then reports is refused, never adopted', async () => {
    let answer!: (found: Map<string, string>) => void;
    const { engine, provider } = buildEngine({
      lookup: () => new Promise((resolve) => (answer = resolve)),
    });
    const run = engine.deploy(STACK, template).then(
      () => 'ok',
      (e: unknown) => e
    );
    // Let the engine reach Q1's create and wait there.
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.startsWith('lookup:'))).toBe(true);
    expect(provider.create).not.toHaveBeenCalled();
    answer(new Map([['App-Q1', urlOf('App-Q1')]]));
    const outcome = await run;
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toMatch(/Q1/);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('logs the lookup count at debug (the line the perf harness asserts absent on a NO_CHANGE redeploy)', async () => {
    const { engine } = buildEngine({});
    vi.mocked(getLogger().debug).mockClear();
    await engine.deploy(STACK, template);
    expect(getLogger().debug).toHaveBeenCalledWith('Generated-name check: looking up 3 planned create(s)');
  });

  it('D-4: at the deploy end the SAVED ledger keeps neither a returned (rolled-back) create nor one AWS rejected', async () => {
    // Q1 returns, Q2 is rejected outright (400), Q3 is never admitted.
    const rejected = Object.assign(new Error('InvalidParameterValue'), {
      name: 'InvalidParameterValue',
      $metadata: { httpStatusCode: 400 },
    });
    const { engine, provider, adoptIntents } = buildEngine({ createFails: { Q2: rejected } });
    await expect(engine.deploy(STACK, template)).rejects.toThrow();
    expect(provider.create.mock.calls.map((c) => c[0])).toEqual(['Q1', 'Q2']);
    // The rollback deleted Q1's resource.
    expect(provider.delete).toHaveBeenCalled();
    expect(adoptIntents()).toEqual([]);
  });

  it('D-5: a create that was SENT and never came back (a timeout: unknown outcome) keeps its intent', async () => {
    const timedOut = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    const { engine, adoptIntents } = buildEngine({ createFails: { Q1: timedOut } });
    await expect(engine.deploy(STACK, template)).rejects.toThrow();
    expect(adoptIntents()).toEqual(['Q1']);
  });

  it("D-6: an older cdkd's kept queue (earlier record version, no retained.json) is taken back", async () => {
    const { engine, provider } = buildEngine({
      holders: { 'App-Q2': urlOf('App-Q2') },
      earlierRecords: [
        {
          resources: { Q2: { resourceType: QUEUE, physicalId: urlOf('App-Q2'), deletionPolicy: 'Retain' } },
          writtenAt: 1,
        },
      ],
    });
    await engine.deploy(STACK, template);
    expect(provider.create.mock.calls.map((c) => c[0])).toEqual(['Q1', 'Q2', 'Q3']);
  });

  it('E-1: no prompt -> one lookup for the whole plan; a prompt that ran -> the creates re-read (batched)', async () => {
    const plain = buildEngine({});
    await plain.engine.deploy(STACK, template);
    expect(plain.provider.lookupNames).toHaveBeenCalledTimes(1);
    events = [];
    // The user takes a while to answer: the lookups are decided before it.
    const prompted = buildEngine({
      approve: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return true;
      },
    });
    await prompted.engine.deploy(STACK, template);
    // The plan-time read, then one re-read per DAG wave (Q1, Q2, Q3 are chained).
    expect(prompted.provider.lookupNames).toHaveBeenCalledTimes(4);
  });

  it('a dry run looks nothing up and writes nothing', async () => {
    const { engine, provider, stateBackend } = buildEngine({ dryRun: true });
    await engine.deploy(STACK, template);
    expect(provider.lookupNames).not.toHaveBeenCalled();
    expect(stateBackend.saveCreateTokenLedger).not.toHaveBeenCalled();
  });
});
