import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { StackState } from '../../../src/types/state.js';
import type {
  DeploymentEvent,
  DeploymentEventRecorder,
} from '../../../src/types/deployment-events.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// Live renderer is a no-op in tests (it self-disables on non-TTY, but mock it
// to avoid any stdout writes and keep the test fast / deterministic).
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (fn: () => void) => fn(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

/** Collecting recorder that captures every event the runner emits. */
class CollectingRecorder implements DeploymentEventRecorder {
  events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  record(event: Omit<DeploymentEvent, 'timestamp'>): void {
    this.events.push(event);
  }
}

describe('runDestroyForStack - #808 deployment events', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeContext(opts: {
    provider: { delete: ReturnType<typeof vi.fn> };
    recorder: DeploymentEventRecorder;
  }) {
    const stateBackend = {
      deleteState: vi.fn().mockResolvedValue(undefined),
      // No outputs -> needsStrongRefCheck is false, scanActiveConsumers skipped.
    } as unknown as S3StateBackend;
    const lockManager = {
      acquireLock: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as LockManager;
    const providerRegistry = {
      getProviderFor: vi
        .fn()
        .mockReturnValue({ provider: opts.provider, provisionedBy: 'sdk' }),
    } as unknown as ProviderRegistry;
    const baseAwsClients = {} as unknown as AwsClients;

    return {
      stateBackend,
      lockManager,
      providerRegistry,
      baseAwsClients,
      baseRegion: 'us-east-1',
      stateBucket: 'state-bucket',
      skipConfirmation: true,
      eventRecorder: opts.recorder,
    };
  }

  function makeState(resources: StackState['resources']): StackState {
    return {
      version: 7,
      stackName: 'S',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    };
  }

  it('emits RESOURCE_STARTED + RESOURCE_SUCCEEDED on a successful delete', async () => {
    const recorder = new CollectingRecorder();
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const state = makeState({
      Bucket: {
        physicalId: 'phys-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_SUCCEEDED']);
    const succeeded = recorder.events.find((e) => e.eventType === 'RESOURCE_SUCCEEDED')!;
    expect(succeeded.operation).toBe('DELETE');
    expect(succeeded.logicalId).toBe('Bucket');
    expect(succeeded.resourceType).toBe('AWS::S3::Bucket');
    expect(succeeded.physicalId).toBe('phys-bucket');
    expect(succeeded.provisionedBy).toBe('sdk');
    expect(typeof succeeded.durationMs).toBe('number');
  });

  it('emits RESOURCE_FAILED with error metadata when a delete fails', async () => {
    const recorder = new CollectingRecorder();
    const awsErr = new Error('delete blew up') as Error & {
      $metadata?: { requestId?: string };
      Code?: string;
    };
    awsErr.name = 'AccessDeniedException';
    awsErr.$metadata = { requestId: 'req-del-1' };
    awsErr.Code = 'AccessDeniedException';
    // Provider opts out of outer retry (disableOuterRetry) so the failure is
    // emitted after a single attempt — keeps the test off real timers.
    const provider = {
      delete: vi.fn().mockRejectedValue(awsErr),
      disableOuterRetry: true,
    };
    const state = makeState({
      Q: {
        physicalId: 'phys-q',
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.errorCount).toBe(1);
    expect(result.deletedCount).toBe(0);

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_FAILED']);
    const failed = recorder.events.find((e) => e.eventType === 'RESOURCE_FAILED')!;
    expect(failed.operation).toBe('DELETE');
    expect(failed.logicalId).toBe('Q');
    expect(failed.error?.awsErrorCode).toBe('AccessDeniedException');
    expect(failed.error?.requestId).toBe('req-del-1');
    expect(typeof failed.durationMs).toBe('number');
  });

  it('emits RESOURCE_RETAINED (no delete call) for a DeletionPolicy: Retain resource', async () => {
    const recorder = new CollectingRecorder();
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const state = makeState({
      Table: {
        physicalId: 'phys-table',
        resourceType: 'AWS::DynamoDB::Table',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
        deletionPolicy: 'Retain',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.retainedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    // The AWS resource is kept — provider.delete is never called.
    expect(provider.delete).not.toHaveBeenCalled();

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_RETAINED']);
    const retained = recorder.events[0]!;
    expect(retained.operation).toBe('DELETE');
    expect(retained.logicalId).toBe('Table');
    expect(retained.resourceType).toBe('AWS::DynamoDB::Table');
    expect(retained.provisionedBy).toBe('sdk');
  });

  it('treats an already-gone resource as a successful delete (RESOURCE_SUCCEEDED)', async () => {
    const recorder = new CollectingRecorder();
    const provider = {
      delete: vi.fn().mockRejectedValue(new Error('Bucket does not exist')),
      disableOuterRetry: true,
    };
    const state = makeState({
      Bucket: {
        physicalId: 'phys-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_SUCCEEDED']);
  });

  it('is a no-op when no recorder is supplied (back-compat)', async () => {
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeContext({ provider, recorder: new CollectingRecorder() });
    // Strip the recorder entirely.
    const { eventRecorder: _omit, ...ctxNoRecorder } = ctx;
    const state = makeState({
      Bucket: {
        physicalId: 'phys-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    const result = await runDestroyForStack('S', state, ctxNoRecorder);
    expect(result.deletedCount).toBe(1);
  });
});
