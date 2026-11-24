/**
 * go-to-k/cdkd#6374: a `cdkd rollback` that re-adopts a create-first
 * replacement's old resource (its delete deferred to the cleanup phase the
 * failed deploy never reached) drops that resource's `supersededResources`
 * entry, or a later deploy would delete the stack's live resource.
 * Driven through the real command and executor.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { readAtKeyRegion } from '../_state-read-double.js';

const logger = vi.hoisted(() => {
  const l: Record<string, unknown> = {};
  Object.assign(l, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  });
  return l;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => logger }));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  readCurrentState: vi.fn(),
  replacedSurvivorIdentity: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    getProvider: () => provider,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
const recorded = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({
    record: (e: Record<string, unknown>) => recorded.events.push(e),
    finalize: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_c: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  // go-to-k/cdkd#5064 phase 2: a replay binds the record's name generation.
  withNameGeneration: (_binding: unknown, fn: () => unknown) => fn(),
  isNameGeneration: (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  stackInstanceNameSuffix: () => '000000000000',
  withStackScope: (_name: string, fn: () => unknown) => fn(),
  withSkipPrefix: (_skip: boolean, fn: () => unknown) => fn(),
  getCurrentSkipPrefix: () => true,
  explicitNamePropertyFor: () => undefined,
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';
const STACK = 'S';
const TOPIC = 'AWS::SNS::Topic';

let resourceType = TOPIC;
let extraOp: Record<string, unknown> = {};
/** Ops completed AFTER the Topic op (so replayed before it), and their records. */
let laterOps: Array<Record<string, unknown>> = [];
let laterRecords: Record<string, unknown> = {};
/** A NEWER segment's ops (a later failed deploy), replayed before the Topic's segment. */
let newerSegmentOps: Array<Record<string, unknown>> = [];
const rec = (physicalId: string, properties: Record<string, unknown>) => ({
  physicalId,
  resourceType,
  properties,
  attributes: {},
  dependencies: [],
  provisionedBy: 'sdk' as const,
});

let saves: StackState[];

function install(opts: { superseded?: boolean } = {}): void {
  const record: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: {
      Topic: rec('topic-new', { TopicName: 'topic-new' }),
      ...laterRecords,
    } as StackState['resources'],
    outputs: {},
    // The failed deploy's row save recorded the old topic, its delete
    // waiting for the cleanup phase the deploy never reached.
    ...(opts.superseded !== false && {
      supersededResources: [
        { logicalId: 'Topic', supersededAt: 1, state: rec('topic-old', { TopicName: 'topic-old' }) },
      ],
    }),
    lastModified: 1,
  };
  const backend = {
    getRegistryMarker: vi.fn().mockResolvedValue(null),
    claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
    lockUnderPrefix: vi.fn().mockResolvedValue(false),
    listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
    recordUnderPrefix: vi.fn().mockResolvedValue('absent'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: STACK,
      region: REGION,
      segments: [
        {
          operations: [
            {
              logicalId: 'Topic',
              changeType: 'UPDATE',
              resourceType,
              provisionedBy: 'sdk',
              physicalId: 'topic-new',
              previousState: rec('topic-old', { TopicName: 'topic-old' }),
              oldResourceRetained: false,
              oldResourceMaySurvive: 'deferred',
              ...extraOp,
            },
            ...laterOps,
          ],
        },
        ...(newerSegmentOps.length > 0 ? [{ operations: newerSegmentOps }] : []),
      ],
    }),
    saveState: vi.fn(async (_s: string, _r: string, state: StackState) => {
      saves.push(structuredClone(state));
      return 'etag-2';
    }),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: { ...backend, prefix: 'cdkd' },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

describe('cdkd rollback re-adopts a deferred old resource and drops its superseded entry (#6374)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saves = [];
    resourceType = TOPIC;
    extraOp = {};
    laterOps = [];
    laterRecords = {};
    newerSegmentOps = [];
    provider.readCurrentState.mockResolvedValue({ TopicName: 'topic-old' });
    provider.delete.mockResolvedValue(undefined);
  });

  it('points state back at the old topic, deletes the new one, and leaves no superseded entry', async () => {
    install();
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
    } as unknown as Parameters<typeof rollbackCommand>[1]);

    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['topic-new']);
    expect(provider.create).not.toHaveBeenCalled();
    const last = saves.at(-1)!;
    expect(last.resources['Topic']!.physicalId).toBe('topic-old');
    expect(last.supersededResources).toBeUndefined();
  });

  // go-to-k/cdkd#6399: a later deploy's cleanup deleted the old topic and
  // dropped its entry; an unanswered read must not re-adopt a deleted id.
  it('refuses the re-adopt on an unanswered read once state no longer lists the old topic', async () => {
    install({ superseded: false });
    provider.readCurrentState.mockRejectedValue(new Error('ThrottlingException: Rate exceeded'));
    await expect(
      rollbackCommand(STACK, {
        yes: true,
        stateBucket: 'b',
        region: REGION,
      } as unknown as Parameters<typeof rollbackCommand>[1])
    ).rejects.toThrow();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(saves.every((st) => st.resources['Topic']!.physicalId === 'topic-new')).toBe(true);
  });

  it('re-adopts on an unanswered read while state still lists the old topic', async () => {
    install();
    provider.readCurrentState.mockRejectedValue(new Error('ThrottlingException: Rate exceeded'));
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
    } as unknown as Parameters<typeof rollbackCommand>[1]);
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['topic-new']);
    expect(saves.at(-1)!.resources['Topic']!.physicalId).toBe('topic-old');
  });

  // go-to-k/cdkd#6621: a bucket's holder is read before the replay applies
  // any op, so a write during the replay (moving its CreationDate outside
  // us-east-1) cannot make the stack's own bucket look like another.
  // go-to-k/cdkd#6621: a bucket's holder is read before the replay applies
  // any op. An op completed after the bucket's is replayed BEFORE it, and its
  // write (a bucket policy put back) moves the old bucket's CreationDate
  // outside us-east-1; the stack's own bucket must still be re-adopted.
  it('judges a deferred bucket by the read taken before a preceding op wrote it', async () => {
    resourceType = 'AWS::S3::Bucket';
    const D1 = 'us-west-2|2026-11-01T00:00:00.000Z';
    extraOp = { oldResourceIdentity: D1 };
    const POLICY = 'AWS::S3::BucketPolicy';
    const policy = (v: number) => ({
      physicalId: 'pol',
      resourceType: POLICY,
      properties: { Bucket: 'topic-old', PolicyDocument: { Version: String(v) } },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
    });
    laterRecords = { Policy: policy(2) };
    laterOps = [
      {
        logicalId: 'Policy',
        changeType: 'UPDATE',
        resourceType: POLICY,
        provisionedBy: 'sdk',
        physicalId: 'pol',
        properties: policy(2).properties,
        previousState: policy(1),
      },
    ];
    install();
    let generation = D1;
    const order: string[] = [];
    provider.replacedSurvivorIdentity.mockImplementation(async () => {
      order.push('holder read');
      return { kind: 'owned', identity: generation };
    });
    provider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      order.push(`update ${logicalId}`);
      generation = 'us-west-2|2026-11-02T00:00:00.000Z';
      return { physicalId, wasReplaced: false, attributes: {} };
    });
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
    } as unknown as Parameters<typeof rollbackCommand>[1]);
    // The snapshot, the preceding write, then the probe's confirmation read.
    expect(order).toEqual(['holder read', 'update Policy', 'holder read']);
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['topic-new']);
    expect(saves.at(-1)!.resources['Topic']!.physicalId).toBe('topic-old');
  });

  // Review round 2: a NEWER segment replays first, and its revert can write
  // an OLDER segment's old bucket; every segment's buckets are read before
  // the first segment replays, so a per-segment read would see the moved date.
  it("judges an older segment's deferred bucket by the read taken before a newer segment wrote it", async () => {
    resourceType = 'AWS::S3::Bucket';
    const D1 = 'us-west-2|2026-11-01T00:00:00.000Z';
    extraOp = { oldResourceIdentity: D1 };
    const POLICY = 'AWS::S3::BucketPolicy';
    const policy = (v: number) => ({
      physicalId: 'pol',
      resourceType: POLICY,
      properties: { Bucket: 'topic-old', PolicyDocument: { Version: String(v) } },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
    });
    laterRecords = { Policy: policy(2) };
    newerSegmentOps = [
      {
        logicalId: 'Policy',
        changeType: 'UPDATE',
        resourceType: POLICY,
        provisionedBy: 'sdk',
        physicalId: 'pol',
        properties: policy(2).properties,
        previousState: policy(1),
      },
    ];
    install();
    let generation = D1;
    const order: string[] = [];
    provider.replacedSurvivorIdentity.mockImplementation(async () => {
      order.push('holder read');
      return { kind: 'owned', identity: generation };
    });
    provider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      order.push(`update ${logicalId}`);
      generation = 'us-west-2|2026-11-02T00:00:00.000Z';
      return { physicalId, wasReplaced: false, attributes: {} };
    });
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
    } as unknown as Parameters<typeof rollbackCommand>[1]);
    expect(order).toEqual(['holder read', 'update Policy', 'holder read']);
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['topic-new']);
    expect(saves.at(-1)!.resources['Topic']!.physicalId).toBe('topic-old');
  });
});
