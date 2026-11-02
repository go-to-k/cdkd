import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

// go-to-k/cdkd#5670: a delete that failed was only counted, and the reverse
// level loop went on to delete the resources the failed one depends on --
// stranding it (an ECS gateway lost its infrastructure role). The runner now
// keeps every TRANSITIVE dependency of a resource whose delete failed, in AWS
// and in state, and still deletes everything unrelated, as CloudFormation's
// DELETE_FAILED does.

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
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

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { ResourceTimeoutError } from '../../../src/utils/error-handler.js';

const REGION = 'us-east-1';

function res(dependencies: string[], extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies,
    ...extra,
  };
}

let lastMadeState: StackState | undefined;
function makeState(resources: Record<string, ResourceState>): StackState {
  const state: StackState = {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
  lastMadeState = state;
  return state;
}

/**
 * `Failing` depends on `Dep`, which depends on `Deeper` (the chain the fix
 * must keep). `Unrelated2` depends on `Unrelated1`; `Unrelated1` sits on the
 * LAST deletion level, after the failure, so it discriminates "keep only the
 * dependencies" from "stop at the failing level".
 */
function chainState(failingExtra: Partial<ResourceState> = {}, depExtra: Partial<ResourceState> = {}) {
  return makeState({
    Deeper: res([]),
    Dep: res(['Deeper'], depExtra),
    Failing: res(['Dep'], { resourceType: 'AWS::S3::Bucket', ...failingExtra }),
    Unrelated1: res([]),
    Unrelated2: res(['Unrelated1']),
  });
}

describe('runDestroyForStack keeps the dependencies of a resource whose delete failed (#5670)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const recorded: DeploymentEvent[] = [];

  function makeCtx() {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        getState: vi.fn(async () => (lastMadeState ? { state: lastMadeState, etag: 'e' } : null)),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        // Single attempt per delete: keeps the failing case off real timers.
        getProviderFor: () => ({
          provider: { delete: mockProviderDelete, disableOuterRetry: true },
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      eventRecorder: {
        record: (event: DeploymentEvent) => {
          recorded.push(event);
        },
        finalize: vi.fn(),
      },
    };
  }

  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
  const text = (spy: typeof infoSpy): string =>
    spy.mock.calls.map((c) => stripAnsi(String(c[0]))).join('\n');
  const deleteAttempts = (): string[] => mockProviderDelete.mock.calls.map((c) => String(c[0]));
  const lastSavedIds = (): string[] =>
    Object.keys((mockSaveState.mock.calls.at(-1)![2] as StackState).resources).sort();

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    recorded.length = 0;
  });

  it('a FAILED delete keeps its transitive dependencies and still deletes unrelated resources', async () => {
    mockProviderDelete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Failing') throw new Error('The bucket you tried to delete is not empty');
      return undefined;
    });

    const result = await runDestroyForStack('TestStack', chainState(), makeCtx());

    // The bug: Dep and Deeper were deleted after Failing's delete failed.
    expect(deleteAttempts()).not.toContain('Dep');
    expect(deleteAttempts()).not.toContain('Deeper');
    // Option (a), CloudFormation's behaviour: the unrelated chain is deleted,
    // Unrelated1 on the last level included.
    expect(deleteAttempts()).toEqual(expect.arrayContaining(['Unrelated1', 'Unrelated2']));
    expect(result.errorCount).toBe(1);
    expect(result.blockedCount).toBe(2);
    expect(result.deletedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    // State preserved with the failed resource AND its dependencies, so a
    // re-run can retry them.
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(lastSavedIds()).toEqual(['Deeper', 'Dep', 'Failing']);
  });

  it('a delete that TIMED OUT keeps its dependencies too (its own error arm)', async () => {
    mockProviderDelete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Failing') {
        throw new ResourceTimeoutError(logicalId, 'AWS::S3::Bucket', REGION, 5, 'DELETE', 5);
      }
      return undefined;
    });

    const result = await runDestroyForStack('TestStack', chainState(), makeCtx());

    expect(deleteAttempts()).not.toContain('Dep');
    expect(deleteAttempts()).not.toContain('Deeper');
    expect(result.errorCount).toBe(1);
    expect(result.blockedCount).toBe(2);
    expect(lastSavedIds()).toEqual(['Deeper', 'Dep', 'Failing']);
  });

  it('names each blocked resource and its blocker, and counts them in the summary', async () => {
    mockProviderDelete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Failing') throw new Error('boom');
      return undefined;
    });

    await runDestroyForStack('TestStack', chainState(), makeCtx());

    const info = text(infoSpy);
    expect(info).toContain('Dep (AWS::SSM::Parameter) not deleted (Failing depends on it and its delete failed)');
    // Transitive: Deeper is blocked by the same failure, not by Dep.
    expect(info).toContain('Deeper (AWS::SSM::Parameter) not deleted (Failing depends on it and its delete failed)');
    const warn = text(warnSpy);
    expect(warn).toMatch(/2 resource\(s\) not deleted because the delete of a resource that depends on them failed/);
    expect(warn).toMatch(/partially destroyed \(2 deleted, 2 blocked, 1 errors\)/);

    const skippedEvents = recorded.filter((e) => e.eventType === 'RESOURCE_SKIPPED');
    expect(skippedEvents.map((e) => e.logicalId).sort()).toEqual(['Deeper', 'Dep']);
    expect(skippedEvents.every((e) => e.reason === 'Failing depends on it and its delete failed')).toBe(
      true
    );
  });

  it('a SKIPPED delete does not block: its dependencies are still deleted, as the deploy engine does', async () => {
    mockProviderDelete.mockImplementation(async (logicalId: string) =>
      logicalId === 'Failing' ? { outcome: 'skipped', reason: 'handler refused' } : undefined
    );

    const result = await runDestroyForStack('TestStack', chainState(), makeCtx());

    expect(deleteAttempts().sort()).toEqual(['Deeper', 'Dep', 'Failing', 'Unrelated1', 'Unrelated2']);
    expect(result.skippedCount).toBe(1);
    expect(result.blockedCount).toBe(0);
    expect(lastSavedIds()).toEqual(['Failing']);
  });

  it('a blocked dependency with DeletionPolicy: Retain keeps its record rather than being retained', async () => {
    mockProviderDelete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Failing') throw new Error('boom');
      return undefined;
    });

    const result = await runDestroyForStack(
      'TestStack',
      chainState({}, { deletionPolicy: 'Retain' }),
      makeCtx()
    );

    expect(result.retainedCount).toBe(0);
    expect(result.blockedCount).toBe(2);
    expect(lastSavedIds()).toEqual(['Deeper', 'Dep', 'Failing']);
  });

  it('does not block over a TYPE-PAIR ordering edge the failed resource never referenced', async () => {
    // The type-pair rule orders every Events::Rule before every Events::EventBus,
    // so `Bus` sits on the level after `Rule` -- but `Rule` never referenced it,
    // and CloudFormation would delete it.
    mockProviderDelete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Rule') throw new Error('boom');
      return undefined;
    });

    const result = await runDestroyForStack(
      'TestStack',
      makeState({
        Bus: res([], { resourceType: 'AWS::Events::EventBus' }),
        Rule: res([], { resourceType: 'AWS::Events::Rule' }),
      }),
      makeCtx()
    );

    expect(deleteAttempts()).toEqual(['Rule', 'Bus']);
    expect(result.blockedCount).toBe(0);
    expect(lastSavedIds()).toEqual(['Rule']);
  });

  it('blocks over a PER-RESOURCE implicit edge (a composite alarm keeps the alarm its rule names)', async () => {
    mockProviderDelete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Composite') throw new Error('boom');
      return undefined;
    });

    const result = await runDestroyForStack(
      'TestStack',
      makeState({
        Metric: res([], {
          resourceType: 'AWS::CloudWatch::Alarm',
          physicalId: 'metric-alarm',
          properties: { AlarmName: 'metric-alarm' },
        }),
        Composite: res([], {
          resourceType: 'AWS::CloudWatch::CompositeAlarm',
          physicalId: 'composite-alarm',
          properties: { AlarmRule: 'ALARM("metric-alarm")' },
        }),
      }),
      makeCtx()
    );

    expect(deleteAttempts()).toEqual(['Composite']);
    expect(result.blockedCount).toBe(1);
    expect(lastSavedIds()).toEqual(['Composite', 'Metric']);
  });

  it('blocks nothing when every delete succeeds', async () => {
    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', chainState(), makeCtx());

    expect(deleteAttempts().sort()).toEqual(['Deeper', 'Dep', 'Failing', 'Unrelated1', 'Unrelated2']);
    expect(result.blockedCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalled();
    expect(text(warnSpy)).not.toContain('blocked');
  });
});
