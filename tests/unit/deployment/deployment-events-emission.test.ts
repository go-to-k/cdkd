import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

/** Collecting recorder that captures the events emitted by the engine. */
class CollectingRecorder implements DeploymentEventRecorder {
  events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  record(event: Omit<DeploymentEvent, 'timestamp'>): void {
    this.events.push(event);
  }
}

describe('DeployEngine - #808 deployment events', () => {
  const stackName = 'events-test';

  function makeChange(logicalId: string, type: string): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: type,
      desiredProperties: { Secret: 'super-secret-value' },
      propertyChanges: [],
    };
  }

  beforeEach(() => vi.clearAllMocks());

  function buildEngine(opts: {
    changes: Map<string, ResourceChange>;
    deps: Record<string, string[]>;
    failOn?: Set<string>;
    /** Logical ids whose rollback `delete()` should throw (exercise ROLLBACK_RESOURCE_FAILED). */
    failDeleteOn?: Set<string>;
    recorder?: DeploymentEventRecorder;
  }) {
    const mockProvider = {
      create: vi.fn().mockImplementation((logicalId: string) => {
        if (opts.failOn?.has(logicalId)) {
          const err = new Error(`create failed: ${logicalId}`) as Error & {
            $metadata?: { requestId?: string };
            Code?: string;
          };
          err.name = 'AccessDeniedException';
          err.$metadata = { requestId: 'req-xyz' };
          err.Code = 'AccessDeniedException';
          return Promise.reject(err);
        }
        return Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} });
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockImplementation((logicalId: string) => {
        if (opts.failDeleteOn?.has(logicalId)) {
          return Promise.reject(new Error(`rollback delete failed: ${logicalId}`));
        }
        return Promise.resolve(undefined);
      }),
      getMinResourceTimeoutMs: vi.fn().mockReturnValue(0),
    };

    const currentState: StackState = {
      version: 1,
      stackName,
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };

    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'etag-0' }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([Object.keys(opts.deps)]),
      getDirectDependencies: vi.fn((_dag: unknown, id: string) => opts.deps[id] ?? []),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(opts.changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          [...changes.values()].filter((c) => c.changeType === type)
        ),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 1, ...(opts.recorder && { eventRecorder: opts.recorder }) },
      'us-east-1'
    );
  }

  it('emits ordered RESOURCE_STARTED/SUCCEEDED events with no resource properties', async () => {
    const recorder = new CollectingRecorder();
    const changes = new Map<string, ResourceChange>([['A', makeChange('A', 'AWS::S3::Bucket')]]);
    const engine = buildEngine({ changes, deps: { A: [] }, recorder });
    await engine.deploy(stackName, { Resources: { A: { Type: 'AWS::S3::Bucket', Properties: {} } } });

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_SUCCEEDED']);
    const succeeded = recorder.events.find((e) => e.eventType === 'RESOURCE_SUCCEEDED')!;
    expect(succeeded.logicalId).toBe('A');
    expect(succeeded.resourceType).toBe('AWS::S3::Bucket');
    expect(succeeded.physicalId).toBe('phys-A');
    expect(typeof succeeded.durationMs).toBe('number');
    // SECURITY: events never carry resource properties.
    expect(JSON.stringify(recorder.events)).not.toContain('super-secret-value');
  });

  it('emits RESOURCE_FAILED with AWS error metadata + rollback events on failure', async () => {
    const recorder = new CollectingRecorder();
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A', 'AWS::S3::Bucket')],
      ['B', makeChange('B', 'AWS::S3::Bucket')],
    ]);
    // A succeeds, B fails -> A rolled back, B fails.
    const engine = buildEngine({
      changes,
      deps: { A: [], B: ['A'] },
      failOn: new Set(['B']),
      recorder,
    });
    await expect(
      engine.deploy(stackName, {
        Resources: {
          A: { Type: 'AWS::S3::Bucket', Properties: {} },
          B: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      })
    ).rejects.toThrow(/Failed to create resource B/);

    const failed = recorder.events.find((e) => e.eventType === 'RESOURCE_FAILED');
    expect(failed).toBeDefined();
    expect(failed!.logicalId).toBe('B');
    expect(failed!.error?.name).toBe('AccessDeniedException');
    expect(failed!.error?.awsErrorCode).toBe('AccessDeniedException');
    expect(failed!.error?.requestId).toBe('req-xyz');

    // Rollback of the successful sibling A is recorded.
    const types = recorder.events.map((e) => e.eventType);
    expect(types).toContain('ROLLBACK_STARTED');
    expect(types).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    expect(types).toContain('ROLLBACK_FINISHED');
    const rolled = recorder.events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')!;
    expect(rolled.logicalId).toBe('A');
  });

  it('emits ROLLBACK_RESOURCE_FAILED when a rollback step itself throws', async () => {
    const recorder = new CollectingRecorder();
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A', 'AWS::S3::Bucket')],
      ['B', makeChange('B', 'AWS::S3::Bucket')],
    ]);
    // A succeeds; B fails -> rollback A (CREATE) by delete, which ALSO throws.
    const engine = buildEngine({
      changes,
      deps: { A: [], B: ['A'] },
      failOn: new Set(['B']),
      failDeleteOn: new Set(['A']),
      recorder,
    });
    await expect(
      engine.deploy(stackName, {
        Resources: {
          A: { Type: 'AWS::S3::Bucket', Properties: {} },
          B: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      })
    ).rejects.toThrow(/Failed to create resource B/);

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toContain('ROLLBACK_STARTED');
    expect(types).toContain('ROLLBACK_RESOURCE_FAILED');
    expect(types).toContain('ROLLBACK_FINISHED');
    // The successful sibling A's rollback delete threw -> FAILED, not SUCCEEDED.
    expect(types).not.toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    const rollbackFailed = recorder.events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')!;
    expect(rollbackFailed.logicalId).toBe('A');
    expect(rollbackFailed.operation).toBe('CREATE');
    expect(rollbackFailed.error?.message).toMatch(/rollback delete failed: A/);
  });

  it('is a no-op when no recorder is supplied (back-compat)', async () => {
    const changes = new Map<string, ResourceChange>([['A', makeChange('A', 'AWS::S3::Bucket')]]);
    const engine = buildEngine({ changes, deps: { A: [] } });
    // Should deploy without throwing and without any recorder wired.
    const result = await engine.deploy(stackName, {
      Resources: { A: { Type: 'AWS::S3::Bucket', Properties: {} } },
    });
    expect(result.created).toBe(1);
  });

  it('never lets a throwing recorder break the deploy (best-effort)', async () => {
    const throwingRecorder: DeploymentEventRecorder = {
      record: () => {
        throw new Error('recorder blew up');
      },
    };
    const changes = new Map<string, ResourceChange>([['A', makeChange('A', 'AWS::S3::Bucket')]]);
    const engine = buildEngine({ changes, deps: { A: [] }, recorder: throwingRecorder });
    const result = await engine.deploy(stackName, {
      Resources: { A: { Type: 'AWS::S3::Bucket', Properties: {} } },
    });
    expect(result.created).toBe(1);
  });
});
