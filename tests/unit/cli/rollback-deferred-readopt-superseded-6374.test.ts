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
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
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
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
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

const rec = (physicalId: string, properties: Record<string, unknown>) => ({
  physicalId,
  resourceType: TOPIC,
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
    resources: { Topic: rec('topic-new', { TopicName: 'topic-new' }) },
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
              resourceType: TOPIC,
              provisionedBy: 'sdk',
              physicalId: 'topic-new',
              previousState: rec('topic-old', { TopicName: 'topic-old' }),
              oldResourceRetained: false,
              oldResourceMaySurvive: 'deferred',
            },
          ],
        },
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
});
