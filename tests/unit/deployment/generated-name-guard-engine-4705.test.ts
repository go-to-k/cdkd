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
import { DEFAULT_TIMING, GeneratedNameGuard } from '../../../src/deployment/generated-name-guard.js';
import {
  InterruptedWaitError,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
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
    /** The DAG's levels (default Q1 <- Q2 <- Q3); each depends on the previous level's first. */
    levels?: string[][];
    concurrency?: number;
    /** The CLI's state-loaded gate (the first deploy's registry claim). */
    stateGate?: (stackName: string, state: unknown) => Promise<void>;
    /** More plan rows (a DELETE, say), and the destructive-plan hook. */
    extraChanges?: ResourceChange[];
    onDestructivePlan?: () => Promise<void>;
  }) {
    const levels = opts.levels ?? [['Q1'], ['Q2'], ['Q3']];
    const ids = levels.flat();
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
    const deps: Record<string, string[]> = Object.fromEntries(
      levels.flatMap((level, i) => level.map((id) => [id, i === 0 ? [] : [levels[i - 1]![0]!]]))
    );
    const diffCalculator = {
        calculateDiff: vi.fn().mockResolvedValue(
          new Map([
            ...ids.map((id): [string, ResourceChange] => [id, create(id)]),
            ...(opts.extraChanges ?? []).map((c): [string, ResourceChange] => [c.logicalId, c]),
          ])
        ),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi.fn((changes: Map<string, ResourceChange>, type: string) =>
          [...changes.values()].filter((c) => c.changeType === type)
        ),
    };
    const engine = new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue(levels),
        getDirectDependencies: vi.fn((_dag: unknown, id: string) => deps[id] ?? []),
      } as never,
      diffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        getCloudControlProvider: vi.fn(),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        concurrency: opts.concurrency ?? 4,
        ...(opts.stateGate && { onCurrentStateLoaded: opts.stateGate }),
        ...(opts.onDestructivePlan && { onDestructivePlan: opts.onDestructivePlan }),
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
    return { engine, provider, stateBackend, adoptIntents, diffCalculator };
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

  it('E-1 / P2: no prompt -> one lookup for the whole plan; a prompt that ran -> one batched re-read', async () => {
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
    // P2: the plan-time read, then ONE batched re-read once the prompt is
    // answered -- not one per DAG wave (Q1, Q2, Q3 are chained).
    expect(prompted.provider.lookupNames).toHaveBeenCalledTimes(2);
  });

  describe('review P1-P4: what the check costs, counted', () => {
    const templateOf = (levels: string[][]): CloudFormationTemplate => ({
      Resources: Object.fromEntries(
        levels.flatMap((level, i) =>
          level.map((id) => [
            id,
            { Type: QUEUE, Properties: {}, ...(i > 0 && { DependsOn: [levels[i - 1]![0]!] }) },
          ])
        )
      ),
    });

    it('P1: 250 creates across 3 DAG levels at concurrency 10 -> ONE intent write, then one cleanup write', async () => {
      const levels = [0, 1, 2].map((l) =>
        Array.from({ length: l === 0 ? 84 : 83 }, (_, i) => `Q${l}x${i}`)
      );
      const { engine, provider, stateBackend } = buildEngine({ levels, concurrency: 10 });
      await engine.deploy(STACK, templateOf(levels));
      expect(provider.create).toHaveBeenCalledTimes(250);
      expect(provider.lookupNames).toHaveBeenCalledTimes(1);
      // The intent write before the first create; the success path's cleanup
      // (forget) after the state save. No write per create, none per wave.
      expect(stateBackend.saveCreateTokenLedger).toHaveBeenCalledTimes(2);
      const firstCreate = events.findIndex((e) => e.startsWith('create:'));
      expect(events.indexOf('ledger-write')).toBeLessThan(firstCreate);
      expect(events.filter((e) => e === 'ledger-write')).toHaveLength(2);
    });

    it('P2 / G-5: no prompt -> no re-read, even with every lookup settled before the approval point', async () => {
      // A DELETE makes the plan destructive, and its hook waits: every lookup
      // is decided before the approval point, so a re-read that fired without
      // a prompt would show here (mutation-probed).
      const levels = [['Q1'], ['Q2'], ['Q3']];
      const records = {
        Old: { physicalId: urlOf('App-Old'), resourceType: QUEUE, properties: {} } as ResourceState,
      };
      const { engine, provider } = buildEngine({
        levels,
        records,
        extraChanges: [
          { logicalId: 'Old', changeType: 'DELETE', resourceType: QUEUE, currentProperties: {} } as ResourceChange,
        ],
        onDestructivePlan: async () => {
          await new Promise((r) => setTimeout(r, 20));
        },
      });
      await engine.deploy(STACK, templateOf(levels));
      expect(provider.create).toHaveBeenCalledTimes(3);
      expect(provider.lookupNames).toHaveBeenCalledTimes(1);
    });

    it('H-3: --require-approval with --yes (an approver that asks no one) re-reads nothing', async () => {
      const levels = [['Q1'], ['Q2'], ['Q3']];
      const records = {
        Old: { physicalId: urlOf('App-Old'), resourceType: QUEUE, properties: {} } as ResourceState,
      };
      const lookups = async (approve: () => Promise<boolean>): Promise<number> => {
        const { engine, provider } = buildEngine({
          levels,
          records,
          approve,
          extraChanges: [
            { logicalId: 'Old', changeType: 'DELETE', resourceType: QUEUE, currentProperties: {} } as ResourceChange,
          ],
          // Every lookup is decided before the approval point.
          onDestructivePlan: async () => {
            await new Promise((r) => setTimeout(r, 20));
          },
        });
        await engine.deploy(STACK, templateOf(levels));
        return provider.lookupNames.mock.calls.length;
      };
      await expect(lookups(Object.assign(async () => true, { autoApproves: true as const }))).resolves.toBe(1);
      // A prompt that really asked re-reads them once, batched.
      await expect(lookups(async () => true)).resolves.toBe(2);
    });

    it('H-6: the plan-time asks route quietly; the create routes (and logs) once', async () => {
      const { engine, provider } = buildEngine({ levels: [['Q1']] });
      void provider;
      const registry = (engine as unknown as { providerRegistry: { getProviderFor: ReturnType<typeof vi.fn> } })
        .providerRegistry;
      await engine.deploy(STACK, templateOf([['Q1']]));
      const asks = registry.getProviderFor.mock.calls.map((c) => (c[0] as { quiet?: boolean }).quiet === true);
      expect(asks.filter(Boolean)).toHaveLength(1);
      expect(asks.filter((q) => !q).length).toBeGreaterThan(0);
    });

    it('H-1: two Retain removals cost ONE retained.json read and ONE write, before the final state save', async () => {
      const levels = [['Q1']];
      const kept = (id: string): ResourceState =>
        ({ physicalId: urlOf(`App-${id}`), resourceType: QUEUE, properties: {}, deletionPolicy: 'Retain' }) as ResourceState;
      const { engine, stateBackend } = buildEngine({
        levels,
        records: { K1: kept('K1'), K2: kept('K2') },
        extraChanges: ['K1', 'K2'].map(
          (id) => ({ logicalId: id, changeType: 'DELETE', resourceType: QUEUE, currentProperties: {} }) as ResourceChange
        ),
      });
      await engine.deploy(STACK, templateOf(levels));
      expect(stateBackend.loadRetainedRecord).toHaveBeenCalledTimes(1);
      expect(stateBackend.saveRetainedResources).toHaveBeenCalledTimes(1);
      const written = (stateBackend.saveRetainedResources.mock.calls[0] as unknown as [string, string, Array<{ logicalId: string }>])[2];
      expect(written.map((e) => e.logicalId).sort()).toEqual(['K1', 'K2']);
      const finalSave = Math.max(...stateBackend.saveState.mock.invocationCallOrder);
      expect(stateBackend.saveRetainedResources.mock.invocationCallOrder[0]).toBeLessThan(finalSave);
    });

    it('P4: a first deploy\'s registry claim overlaps the diff, and a refusal still stops it before any lookup or create', async () => {
      let claimDone!: () => void;
      const claim = new Promise<void>((r) => (claimDone = r));
      const order: string[] = [];
      const ok = buildEngine({
        stateGate: async () => {
          order.push('claim-start');
          await claim;
          order.push('claim-end');
        },
      });
      ok.diffCalculator.calculateDiff.mockImplementation(async () => {
        order.push('diff');
        claimDone();
        return new Map(['Q1', 'Q2', 'Q3'].map((id) => [id, create(id)]));
      });
      await ok.engine.deploy(STACK, template);
      expect(order).toEqual(['claim-start', 'diff', 'claim-end']);
      events = [];
      const refused = buildEngine({
        stateGate: async () => {
          throw new Error('Refusing to deploy stack App: it is already recorded under another state prefix');
        },
      });
      await expect(refused.engine.deploy(STACK, template)).rejects.toThrow(/another state prefix/);
      expect(refused.provider.lookupNames).not.toHaveBeenCalled();
      expect(refused.provider.create).not.toHaveBeenCalled();
    });

    it('G-3: a failed intent write refuses the create with the explained, non-retryable GENERATED_NAME_HELD', async () => {
      const levels = [['Q1']];
      const { engine, provider, stateBackend } = buildEngine({ levels });
      stateBackend.saveCreateTokenLedger.mockRejectedValue(new Error('S3 PutObject 500'));
      const error = await engine.deploy(STACK, templateOf(levels)).catch((e: unknown) => e);
      expect(provider.create).not.toHaveBeenCalled();
      const chain: unknown[] = [];
      for (let e: unknown = error; e instanceof Error && chain.length < 6; e = (e as { cause?: unknown }).cause) chain.push(e);
      expect(chain.some((e) => (e as { code?: unknown }).code === 'GENERATED_NAME_HELD')).toBe(true);
      expect(stateBackend.saveCreateTokenLedger).toHaveBeenCalledTimes(1);
    });

    it('H-4: a Ctrl-C during the deletion cooldown is an interrupt, never a GENERATED_NAME_HELD refusal', async () => {
      const levels = [['Q1']];
      const { engine, provider } = buildEngine({ levels });
      const admit = vi
        .spyOn(GeneratedNameGuard.prototype, 'admit')
        .mockResolvedValue({ kind: 'failed', error: new InterruptedWaitError('generated-name deletion cooldown') });
      try {
        const error = await engine.deploy(STACK, templateOf(levels)).catch((e: unknown) => e);
        expect(provider.create).not.toHaveBeenCalled();
        expect(isInterruptedWaitError(error)).toBe(true);
        const chain: unknown[] = [];
        for (let e: unknown = error; e instanceof Error && chain.length < 6; e = (e as { cause?: unknown }).cause) chain.push(e);
        expect(chain.some((e) => (e as { code?: unknown }).code === 'GENERATED_NAME_HELD')).toBe(false);
      } finally {
        admit.mockRestore();
      }
    });

    it('G-6: when the overlap window fails too, the overlapped gate\'s refusal is the error reported', async () => {
      const refused = buildEngine({
        stateGate: async () => {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('Refusing to deploy stack App: it is already recorded under another state prefix');
        },
      });
      refused.diffCalculator.calculateDiff.mockRejectedValue(new Error('read error in the diff'));
      await expect(refused.engine.deploy(STACK, template)).rejects.toThrow(/another state prefix/);
      // A gate that passes leaves the window's own error as it was.
      const passed = buildEngine({ stateGate: async () => undefined });
      passed.diffCalculator.calculateDiff.mockRejectedValue(new Error('read error in the diff'));
      await expect(passed.engine.deploy(STACK, template)).rejects.toThrow(/read error in the diff/);
    });

    it('the exact extra calls of a single first deploy with one adopting create', async () => {
      const levels = [['Q1']];
      const { engine, provider, stateBackend } = buildEngine({ levels });
      await engine.deploy(STACK, templateOf(levels));
      // One lookup; the ledger read once; two ledger writes (the intent, and
      // the success cleanup run beside the post-save writes); no evidence
      // read (nothing held), no retained.json, no history, no re-read.
      expect(provider.lookupNames).toHaveBeenCalledTimes(1);
      expect(stateBackend.loadCreateTokenLedger).toHaveBeenCalledTimes(1);
      expect(stateBackend.saveCreateTokenLedger).toHaveBeenCalledTimes(2);
      expect(stateBackend.loadRetainedRecord).not.toHaveBeenCalled();
      expect(stateBackend.saveRetainedResources).not.toHaveBeenCalled();
      expect(stateBackend.earlierStateResources).not.toHaveBeenCalled();
      expect(stateBackend.getRawObject).not.toHaveBeenCalled();
    });
  });

  it('a dry run looks nothing up and writes nothing', async () => {
    const { engine, provider, stateBackend } = buildEngine({ dryRun: true });
    await engine.deploy(STACK, template);
    expect(provider.lookupNames).not.toHaveBeenCalled();
    expect(stateBackend.saveCreateTokenLedger).not.toHaveBeenCalled();
  });
});
