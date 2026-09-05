import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

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

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * Issue #1238: a name-idempotent Create API (SQS CreateQueue with an
 * unchanged QueueName) does not collide on the create-first replacement
 * attempt — it silently returns the OLD resource's physicalId as the "new"
 * one. Pre-fix, the delete-old step then destroyed that very resource while
 * the deploy reported success and state kept pointing at it. The guard must
 * fail the resource loudly (old resource + state record intact) without
 * --replace, hard-fail under UpdateReplacePolicy: Retain, and fall back to
 * delete-first + re-create under --replace.
 */
describe('DeployEngine — same-name replacement with a name-idempotent Create API (issue #1238)', () => {
  let callOrder: string[];
  let provider: ResourceProvider;
  /** physicalIds returned by successive create() calls (last one repeats). */
  let createIds: string[];

  const TYPE = 'AWS::SQS::Queue'; // the type observed live (not in STATEFUL_TYPES)
  const OLD_URL = 'https://sqs.us-east-1.amazonaws.com/111122223333/my-queue.fifo';

  beforeEach(() => {
    callOrder = [];
    createIds = [OLD_URL];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        const physicalId = createIds.length > 1 ? createIds.shift()! : createIds[0]!;
        return { physicalId, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(
    opts: { replace?: boolean; recreateViaCcApi?: boolean } = {}
  ): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        ...(opts.replace !== undefined && { replace: opts.replace }),
        ...(opts.recreateViaCcApi && {
          recreateTargets: {
            stackName: 'MyStack',
            viaCcApi: new Set(['Queue']),
            viaSdkProvider: new Set<string>(),
          },
        }),
      },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    { retain = false }: { retain?: boolean } = {}
  ): Promise<Record<string, StateRecord>> {
    const change: ResourceChange = {
      logicalId: 'Queue',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { QueueName: 'my-queue.fifo', FifoQueue: true, ContentBasedDeduplication: true },
      desiredProperties: { QueueName: 'my-queue.fifo', FifoQueue: true },
      propertyChanges: [
        {
          path: 'ContentBasedDeduplication',
          oldValue: true,
          newValue: undefined,
          requiresReplacement: true,
        },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      Queue: {
        physicalId: OLD_URL,
        resourceType: TYPE,
        properties: { QueueName: 'my-queue.fifo', FifoQueue: true, ContentBasedDeduplication: true },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Queue: {
          Type: TYPE,
          Properties: { QueueName: 'my-queue.fifo', FifoQueue: true },
          ...(retain && { UpdateReplacePolicy: 'Retain' }),
        },
      },
    };
    const provisionResource = (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource.bind(engine);
    await provisionResource('Queue', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  it('fails loudly when the create-first attempt returns the OLD physicalId — no delete issued', async () => {
    // Name-idempotent Create: returns the old queue URL as the "new" id.
    createIds = [OLD_URL];

    const err = await invokeProvision(makeEngine()).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string; code?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/name-idempotent/);
    expect(err!.cause?.message).toMatch(/EXISTING resource/);
    expect(err!.cause?.message).toMatch(/cdkd deploy --replace/);
    expect((err!.cause as { code?: string })?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    // The delete-old step must NOT have run — the old resource stays live.
    expect(provider.delete).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['create']);
  });

  it('preserves the old state record verbatim when the guard fires', async () => {
    createIds = [OLD_URL];
    const engine = makeEngine();

    // Inline copy of invokeProvision so we can inspect the SAME map.
    const change: ResourceChange = {
      logicalId: 'Queue',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { QueueName: 'my-queue.fifo', ContentBasedDeduplication: true },
      desiredProperties: { QueueName: 'my-queue.fifo' },
      propertyChanges: [
        {
          path: 'ContentBasedDeduplication',
          oldValue: true,
          newValue: undefined,
          requiresReplacement: true,
        },
      ],
    };
    const record: StateRecord = {
      physicalId: OLD_URL,
      resourceType: TYPE,
      properties: { QueueName: 'my-queue.fifo', ContentBasedDeduplication: true },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    };
    const stateResources: Record<string, StateRecord> = { Queue: record };
    const before = JSON.parse(JSON.stringify(record));
    const template: CloudFormationTemplate = {
      Resources: { Queue: { Type: TYPE, Properties: { QueueName: 'my-queue.fifo' } } },
    };
    const provisionResource = (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource.bind(engine);

    await expect(
      provisionResource('Queue', change, stateResources, 'MyStack', template)
    ).rejects.toThrow();

    // State still records the old, live resource — untouched.
    expect(stateResources['Queue']).toEqual(before);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('keeps the normal replacement behavior when the create returns a DIFFERENT physicalId', async () => {
    const NEW_URL = 'https://sqs.us-east-1.amazonaws.com/111122223333/my-queue-v2.fifo';
    createIds = [NEW_URL];

    const stateResources = await invokeProvision(makeEngine());

    // Create-first succeeded with a genuinely new resource → old deleted.
    expect(callOrder).toEqual(['create', 'delete']);
    expect(provider.delete).toHaveBeenCalledWith(
      'Queue',
      OLD_URL,
      TYPE,
      expect.objectContaining({ QueueName: 'my-queue.fifo' }),
      { expectedRegion: 'us-east-1', forceDataDelete: false }
    );
    expect(stateResources['Queue']!.physicalId).toBe(NEW_URL);
  });

  it('hard-fails the same-id outcome under UpdateReplacePolicy: Retain (even with --replace)', async () => {
    createIds = [OLD_URL];

    const err = await invokeProvision(makeEngine({ replace: true }), { retain: true }).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string; code?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/name-idempotent/);
    expect(err!.cause?.message).toMatch(/UpdateReplacePolicy: Retain pins that resource/);
    expect((err!.cause as { code?: string })?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['create']);
  });

  it('falls back to delete-first + re-create under --replace on the same-id outcome', async () => {
    // Both creates return the same URL (SQS: the URL is name-derived) —
    // the SECOND same-id result is legitimate because the old resource was
    // deleted in between.
    createIds = [OLD_URL];

    const stateResources = await invokeProvision(makeEngine({ replace: true }));

    expect(callOrder).toEqual(['create', 'delete', 'create']);
    expect(provider.delete).toHaveBeenCalledWith(
      'Queue',
      OLD_URL,
      TYPE,
      expect.objectContaining({ QueueName: 'my-queue.fifo' }),
      { expectedRegion: 'us-east-1', forceDataDelete: false }
    );
    // State reflects the re-created resource with the NEW properties.
    expect(stateResources['Queue']!.physicalId).toBe(OLD_URL);
    expect(stateResources['Queue']!.properties).toEqual({
      QueueName: 'my-queue.fifo',
      FifoQueue: true,
    });
  });

  it('hard-fails a --recreate-via-cc-api recreate under Retain that re-adopts the existing resource', async () => {
    // recreate-flagged + UpdateReplacePolicy: Retain skips the destroy, so a
    // name-idempotent Create silently returns the old resource — the guard
    // must fire before the state bookkeeping re-adopts it.
    createIds = [OLD_URL];

    const err = await invokeProvision(makeEngine({ recreateViaCcApi: true }), {
      retain: true,
    }).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string; code?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/name-idempotent/);
    expect(err!.cause?.message).toMatch(/never destroyed/);
    expect((err!.cause as { code?: string })?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['create']);
  });
});
