/**
 * go-to-k/cdkd#6894: `executeDeployment` registers a force-quit flusher while
 * its operations run. A force-quit mid-deploy writes ONE `interrupted` segment
 * holding the operations completed so far plus the in-flight ones as FAILED
 * operations, and the engine's own path then writes no second one. A run that
 * settles on its own leaves nothing registered and makes no extra call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DagExecutor } from '../../../src/deployment/dag-executor.js';
import {
  registeredForceQuitFlushCount,
  startForceQuitFlushes,
} from '../../../src/deployment/force-quit-journal.js';
import { inFlightOperationsAsFailed } from '../../../src/deployment/deploy-engine/execute/force-quit-flush.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { reportCreatedResource } from '../../../src/provisioning/created-resource-sink.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

const captured = vi.hoisted(() => ({
  run: undefined as undefined | { inFlightCreatedSinks: Map<string, unknown> },
}));
vi.mock(
  '../../../src/deployment/deploy-engine/execute/force-quit-flush.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/deployment/deploy-engine/execute/force-quit-flush.js')
      >();
    return {
      ...actual,
      forceQuitFlusher: (...args: Parameters<typeof actual.forceQuitFlusher>) => {
        captured.run = args[0] as never;
        return actual.forceQuitFlusher(...args);
      },
    };
  }
);

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const TYPE = 'AWS::AppSync::Resolver';
const STACK = 'force-quit-journal-test';
const FAST = 'Fast';
const SLOW = 'Slow';

function createChange(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType: TYPE,
    desiredProperties: {},
    propertyChanges: [],
  } as unknown as ResourceChange;
}

function record(logicalId: string): ResourceState {
  return {
    physicalId: `phys-${logicalId}`,
    resourceType: TYPE,
    properties: { Name: logicalId },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
  };
}

const DEPENDENT = 'Dependent';
const OLD = 'Old';
const SECRET = 's3cr3t-plaintext-value-6894-0123456789';
const SECRET_REF = '{{resolve:secretsmanager:ForceQuitSecret}}';

interface Scenario {
  /** CREATE `DEPENDENT`, which depends on SLOW. */
  dependent?: boolean;
  /** DELETE `OLD` (in state), whose delete waits for `releaseDelete`. */
  slowDelete?: boolean;
  /** No pre-deploy state record: a first deploy. */
  firstDeploy?: boolean;
  /** SLOW's provider reports the resource it made before it waits. */
  slowReports?: string;
  /** SLOW's attempted bag carries a resolved secret. */
  slowSecret?: boolean;
  /** Fail output resolution (`--strict-getatt`). */
  failOutputs?: boolean;
}

describe('executeDeployment force-quit flusher (go-to-k/cdkd#6894)', () => {
  let appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  let saveState: ReturnType<typeof vi.fn>;
  let createCalls: string[];
  let releaseSlow: (() => void) | undefined;
  let releaseDelete: (() => void) | undefined;
  let slowFails: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    void startForceQuitFlushes().done; // nothing left over from another case
    createCalls = [];
    releaseSlow = undefined;
    releaseDelete = undefined;
    slowFails = false;
  });

  function buildEngine(scenario: Scenario = {}): DeployEngine {
    // eslint-disable-next-line prefer-const
    let engine: DeployEngine;
    const provider = {
      create: vi.fn().mockImplementation((logicalId: string) => {
        createCalls.push(logicalId);
        if (logicalId !== SLOW) {
          return Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
        }
        if (scenario.slowReports !== undefined) {
          reportCreatedResource(SLOW, TYPE, scenario.slowReports);
        }
        if (scenario.slowSecret) {
          const internals = engine as unknown as {
            secretsRun: { perResourceSecrets: Map<string, Map<string, string>> };
            attemptedResolvedProps: Map<string, Record<string, unknown>>;
          };
          internals.secretsRun.perResourceSecrets.set(SLOW, new Map([[SECRET, SECRET_REF]]));
          internals.attemptedResolvedProps.set(SLOW, { Password: SECRET });
        }
        return new Promise((resolve, reject) => {
          releaseSlow = () =>
            slowFails
              ? reject(new Error('slow create failed'))
              : resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
        });
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation((logicalId: string) =>
        logicalId === OLD
          ? new Promise<void>((resolve) => (releaseDelete = resolve))
          : Promise.resolve(undefined)
      ),
    };
    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: scenario.slowDelete ? { [OLD]: record(OLD) } : {},
      outputs: {},
      lastModified: Date.now(),
    };
    appendRollbackJournalSegment = vi.fn().mockResolvedValue(undefined);
    saveState = vi.fn().mockResolvedValue('etag-1');
    const changes = new Map<string, ResourceChange>(
      scenario.slowDelete
        ? [[OLD, { logicalId: OLD, changeType: 'DELETE', resourceType: TYPE } as never]]
        : [
            [FAST, createChange(FAST)],
            [SLOW, createChange(SLOW)],
            ...(scenario.dependent
              ? ([[DEPENDENT, createChange(DEPENDENT)]] as [string, ResourceChange][])
              : []),
          ]
    );
    engine = new DeployEngine(
      {
        getState: vi
          .fn()
          .mockResolvedValue(scenario.firstDeploy ? null : { state: currentState, etag: 'e0' }),
        saveState,
        stackInstanceIdForFirstWrite: vi
          .fn()
          .mockResolvedValue('00000000-0000-4000-8000-000000000000'),
        listStacks: vi.fn().mockResolvedValue([]),
        appendRollbackJournalSegment,
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
        popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi
          .fn()
          .mockReturnValue(scenario.dependent ? [[FAST, SLOW], [DEPENDENT]] : [[FAST, SLOW]]),
        getDirectDependencies: vi
          .fn()
          .mockImplementation((_dag: unknown, id: string) => (id === DEPENDENT ? [SLOW] : [])),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(changes),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi
          .fn()
          .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
            [...all.values()].filter((c) => c.changeType === type)
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
      { concurrency: 4, noRollback: false },
      'us-east-1'
    );
    return engine;
  }

  const template: CloudFormationTemplate = {
    Resources: {
      [FAST]: { Type: TYPE, Properties: {} },
      [SLOW]: { Type: TYPE, Properties: {} },
      [DEPENDENT]: { Type: TYPE, Properties: {} },
    },
  };

  /** Make output resolution throw, as `--strict-getatt` does on a missing attribute. */
  function failingOutputs(engine: DeployEngine): CloudFormationTemplate {
    (engine as unknown as { options: { strictGetAtt: boolean } }).options.strictGetAtt = true;
    const sentinel = { 'Fn::GetAtt': ['Missing', 'Arn'] };
    const resolver = (engine as unknown as { resolver: { resolve: ReturnType<typeof vi.fn> } })
      .resolver;
    resolver.resolve.mockImplementation((value: unknown) =>
      value === sentinel ? Promise.reject(new Error('unresolvable output')) : Promise.resolve(value)
    );
    return { ...template, Outputs: { Bad: { Value: sentinel } } };
  }

  /** Until FAST completed and SLOW is in flight. */
  async function untilSlowInFlight(firstDeploy = false): Promise<void> {
    await vi.waitFor(() => {
      expect(releaseSlow).toBeDefined();
      // A first deploy saves no per-resource state; FAST's completion is then
      // read from the create calls alone.
      if (!firstDeploy) expect(saveState).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 5));
  }

  function settledFlag(p: Promise<unknown>): () => boolean {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true)
    );
    return () => settled;
  }

  it('a force-quit mid-deploy writes one interrupted segment: completed ops plus the in-flight one as failed', async () => {
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    expect(registeredForceQuitFlushCount()).toBe(1);

    const started = startForceQuitFlushes();
    expect(started.pending).toBe(1);
    expect(await started.done).toEqual([STACK]);

    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const segment = appendRollbackJournalSegment.mock.calls[0]![2];
    expect(segment.reason).toBe('interrupted');
    expect(segment.initialDeploy).toBe(false);
    expect(segment.operations).toEqual([
      expect.objectContaining({ logicalId: FAST, changeType: 'CREATE' }),
    ]);
    expect(segment.failedOperations).toHaveLength(1);
    expect(segment.failedOperations[0]).toMatchObject({ logicalId: SLOW, changeType: 'CREATE' });
    // Nothing is known about what the in-flight CREATE made.
    expect(segment.failedOperations[0].physicalId).toBeUndefined();

    // The in-flight op settles; the engine's own path writes no second segment.
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    expect(registeredForceQuitFlushCount()).toBe(0);
  });

  it('the engine waits for a started flush before it ends the run, so its exit cannot cut the write short', async () => {
    const deploying = buildEngine().deploy(STACK, template);
    const settled = settledFlag(deploying);
    await untilSlowInFlight();
    let finishWrite!: () => void;
    appendRollbackJournalSegment.mockImplementationOnce(
      () => new Promise<void>((r) => (finishWrite = r))
    );
    const started = startForceQuitFlushes();
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    // SLOW completes at once: the engine reaches its takeover while the
    // flush's journal write is still in flight.
    releaseSlow!();
    await new Promise((r) => setTimeout(r, 20));
    expect(settled()).toBe(false);
    finishWrite();
    await started.done;
    await expect(deploying).rejects.toThrow();
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
  });

  it('no duplicate when the in-flight op then FAILS: the failure path journals nothing more', async () => {
    slowFails = true;
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    await startForceQuitFlushes().done;
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
  });

  it('no duplicate when the outputs then fail to resolve: the output-failure path journals nothing more', async () => {
    const engine = buildEngine();
    const deploying = engine.deploy(STACK, failingOutputs(engine));
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    await startForceQuitFlushes().done;
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    expect(appendRollbackJournalSegment).toHaveBeenCalledOnce();
    expect(appendRollbackJournalSegment.mock.calls[0]![2].reason).toBe('interrupted');
  });

  it('a force-quit with no first Ctrl-C (a hang-up) dispatches nothing new', async () => {
    const deploying = buildEngine({ dependent: true }).deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    await startForceQuitFlushes().done;
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    expect(createCalls).not.toContain(DEPENDENT);
  });

  it('an in-flight DELETE is journaled as a failed DELETE carrying its record', async () => {
    const deploying = buildEngine({ slowDelete: true }).deploy(STACK, template);
    deploying.catch(() => undefined);
    await vi.waitFor(() => expect(releaseDelete).toBeDefined());
    await startForceQuitFlushes().done;
    const segment = appendRollbackJournalSegment.mock.calls[0]![2];
    expect(segment.failedOperations).toEqual([
      expect.objectContaining({ logicalId: OLD, changeType: 'DELETE', physicalId: `phys-${OLD}` }),
    ]);
    releaseDelete!();
    await expect(deploying).rejects.toThrow();
  });

  it('an in-flight CREATE whose provider reported its resource is journaled with that id', async () => {
    const deploying = buildEngine({ slowReports: 'phys-made-by-slow' }).deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    await startForceQuitFlushes().done;
    const op = appendRollbackJournalSegment.mock.calls[0]![2].failedOperations[0];
    expect(op).toMatchObject({
      logicalId: SLOW,
      changeType: 'CREATE',
      physicalId: 'phys-made-by-slow',
      physicalIdRecoveredFromError: true,
      provisionedBy: 'sdk',
    });
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
  });

  it("an in-flight op's resolved secret is journaled as its reference, never the plaintext", async () => {
    const deploying = buildEngine({ slowSecret: true }).deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    await startForceQuitFlushes().done;
    const segment = appendRollbackJournalSegment.mock.calls[0]![2];
    const body = JSON.stringify(segment);
    expect(body).not.toContain(SECRET);
    expect(segment.failedOperations[0].attemptedProperties).toBeDefined();
    expect(JSON.stringify(segment.failedOperations[0].attemptedProperties)).toContain(SECRET_REF);
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
  });

  it('a first deploy journals initialDeploy: true', async () => {
    const deploying = buildEngine({ firstDeploy: true }).deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight(true);
    await startForceQuitFlushes().done;
    expect(appendRollbackJournalSegment.mock.calls[0]![2].initialDeploy).toBe(true);
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
  });

  it("a force-quit during the engine's OWN journal write waits for that write", async () => {
    slowFails = true;
    let finishWrite: (() => void) | undefined;
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    appendRollbackJournalSegment.mockImplementationOnce(
      () => new Promise<void>((r) => (finishWrite = r))
    );
    releaseSlow!();
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    // The engine took journaling over, so no flusher is left; its own write
    // is what a force-quit now has to wait for.
    const started = startForceQuitFlushes();
    expect(started.pending).toBe(1);
    const settled = settledFlag(started.done);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled()).toBe(false);
    finishWrite!();
    // The engine's own segment landed, so the force-quit names the stack.
    await expect(started.done).resolves.toEqual([STACK]);
    await expect(deploying).rejects.toThrow();
  });

  it('a settled node leaves no created-resource sink behind', async () => {
    const deploying = buildEngine({ slowReports: 'phys-made-by-slow' }).deploy(STACK, template);
    await untilSlowInFlight();
    // In flight: its sink is there for a force-quit to read.
    expect(captured.run?.inFlightCreatedSinks.has(SLOW)).toBe(true);
    releaseSlow!();
    await deploying;
    expect(captured.run?.inFlightCreatedSinks.size).toBe(0);
  });

  it('the engine journals its own failure and unregisters; a later force-quit finds nothing', async () => {
    slowFails = true;
    const deploying = buildEngine().deploy(STACK, template);
    deploying.catch(() => undefined);
    await untilSlowInFlight();
    releaseSlow!();
    await expect(deploying).rejects.toThrow();
    const writes = appendRollbackJournalSegment.mock.calls.length;
    expect(writes).toBeGreaterThan(0);
    expect(appendRollbackJournalSegment.mock.calls[0]![2].reason).not.toBe('interrupted');
    expect(registeredForceQuitFlushCount()).toBe(0);
    expect(startForceQuitFlushes().pending).toBe(0);
    expect(appendRollbackJournalSegment).toHaveBeenCalledTimes(writes);
  });

  it('an uninterrupted deploy writes no journal and leaves nothing registered', async () => {
    const deploying = buildEngine().deploy(STACK, template);
    await untilSlowInFlight();
    releaseSlow!();
    await deploying;
    expect(appendRollbackJournalSegment).not.toHaveBeenCalled();
    expect(registeredForceQuitFlushCount()).toBe(0);
  });
});

describe('inFlightOperationsAsFailed', () => {
  function change(logicalId: string, changeType: string): ResourceChange {
    return { logicalId, changeType, resourceType: TYPE } as unknown as ResourceChange;
  }

  it('journals running nodes only, with the pre-deploy record for an UPDATE / DELETE and none for a CREATE', () => {
    const executor = new DagExecutor<ResourceChange>();
    const node = (id: string, changeType: string, state: 'running' | 'pending' | 'completed') =>
      executor.add({ id, dependencies: new Set(), state, data: change(id, changeType) });
    node('NewOne', 'CREATE', 'running');
    node('Changed', 'UPDATE', 'running');
    node('Removed', 'DELETE', 'running');
    node('Waiting', 'UPDATE', 'pending');
    node('Done', 'UPDATE', 'running'); // recorded as completed already
    node('Settled', 'UPDATE', 'completed');

    const attempted = { Name: 'new' };
    const ops = inFlightOperationsAsFailed(
      {
        engine: {
          attemptedResolvedProps: new Map([['Changed', attempted]]),
          replacementRun: { oldDeletedBeforeCreate: new Set(['Changed']) },
        } as never,
        currentState: {
          resources: {
            Changed: record('Changed'),
            Removed: record('Removed'),
            Done: record('Done'),
          },
        } as unknown as StackState,
        newResources: {},
        completedOperations: [{ logicalId: 'Done', changeType: 'UPDATE', resourceType: TYPE }],
        failedOperations: [],
      },
      [executor, undefined]
    );

    expect(ops.map((op) => op.logicalId)).toEqual(['NewOne', 'Changed', 'Removed']);
    const [created, updated, deleted] = ops;
    expect(created).toEqual({ logicalId: 'NewOne', changeType: 'CREATE', resourceType: TYPE });
    expect(updated).toMatchObject({
      changeType: 'UPDATE',
      physicalId: 'phys-Changed',
      provisionedBy: 'sdk',
      previousState: record('Changed'),
      attemptedProperties: attempted,
      // Its replacement already deleted the old resource: `--revert-failed`
      // takes the skip-failed-replaced-deleted path, not an update to it.
      oldDeletedBeforeCreate: true,
    });
    expect(deleted).toMatchObject({
      changeType: 'DELETE',
      physicalId: 'phys-Removed',
      previousState: record('Removed'),
    });
    expect(deleted).not.toHaveProperty('attemptedProperties');
  });
});
