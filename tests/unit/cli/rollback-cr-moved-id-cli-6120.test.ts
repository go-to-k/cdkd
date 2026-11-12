/**
 * go-to-k/cdkd#6120: `cdkd rollback --revert-failed` runs ONE cleanup queue
 * per segment, so an id the failed op's revert `update()` moved off (a custom
 * resource's handler answered a new id) is deleted only after the segment's
 * completed ops are reverted too, and is kept in `supersededResources` across
 * every save until then. Driven through the real command and executor.
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
const CR = 'Custom::Thing';
const TOPIC = 'AWS::SNS::Topic';

const rec = (physicalId: string, resourceType: string, properties: Record<string, unknown>) => ({
  physicalId,
  resourceType,
  properties,
  attributes: {},
  dependencies: [],
  provisionedBy: 'sdk' as const,
});

const TOPIC_OP = {
  logicalId: 'Topic',
  changeType: 'UPDATE',
  resourceType: TOPIC,
  provisionedBy: 'sdk',
  physicalId: 'topic',
  previousState: rec('topic', TOPIC, { DisplayName: 'v1' }),
  wasReplaced: false,
};
const RES_FAILED = {
  logicalId: 'Res',
  changeType: 'UPDATE',
  resourceType: CR,
  provisionedBy: 'sdk',
  physicalId: 'name-1',
  previousState: rec('name-1', CR, { Name: 'old' }),
};

let calls: string[];
let saves: StackState[];

function install(): void {
  const record: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: {
      Res: rec('name-1', CR, { Name: 'new' }),
      Topic: rec('topic', TOPIC, { DisplayName: 'v2' }),
    },
    outputs: {},
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
          operations: [structuredClone(TOPIC_OP)],
          failedOperations: [structuredClone(RES_FAILED)],
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

describe('cdkd rollback --revert-failed deletes a moved-off id after the segment (#6120)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    saves = [];
    provider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      calls.push(`update ${logicalId} ${physicalId}`);
      return logicalId === 'Res'
        ? { physicalId: 'name-9', wasReplaced: true, oldPhysicalIdLeftForCleanup: true, attributes: {} }
        : { physicalId, wasReplaced: false };
    });
    provider.delete.mockImplementation(async (logicalId: string, physicalId: string) => {
      calls.push(`delete ${logicalId} ${physicalId}`);
    });
  });

  it('sends the Delete after the completed ops, keeping the id in state until then', async () => {
    install();
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
      revertFailed: true,
    } as unknown as Parameters<typeof rollbackCommand>[1]);
    expect(calls).toEqual(['update Res name-1', 'update Topic topic', 'delete Res name-1']);
    const ids = saves.map((s) => (s.supersededResources ?? []).map((e) => e.state.physicalId));
    // The save right after the failed op's revert already holds it.
    expect(saves[0]?.resources['Res']?.physicalId).toBe('name-9');
    expect(ids[0]).toEqual(['name-1']);
    expect(ids.at(-1)).toEqual([]);
    expect(saves.at(-1)?.resources['Res']?.physicalId).toBe('name-9');
  });
});
