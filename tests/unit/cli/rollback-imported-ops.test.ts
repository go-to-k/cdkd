/**
 * go-to-k/cdkd#4523: a journal segment kept from a failed deploy holds a
 * completed CREATE of an explicitly named resource; the user re-creates the
 * name by hand and `cdkd import`s it under the same logical id. The record's
 * physical id equals the op's, so the replay classified `delete` and removed
 * the resource the user had just adopted. The import now marks the id on the
 * segment (`importedLogicalIds`), and `cdkd rollback` leaves the segment's ops
 * of that id alone. Driven through the real command and the real executor.
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
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
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
/** The explicit name: the physical id the deploy recorded AND the import adopted. */
const NAME = 'my-topic';

const topicRecord = (displayName: string) => ({
  physicalId: NAME,
  resourceType: TOPIC,
  properties: { TopicName: NAME, DisplayName: displayName },
  attributes: {},
  provisionedBy: 'sdk' as const,
});

/** The completed CREATE the failed deploy journaled. */
const createOp = {
  logicalId: 'Topic',
  changeType: 'CREATE',
  resourceType: TOPIC,
  physicalId: NAME,
  properties: topicRecord('deployed').properties,
  provisionedBy: 'sdk',
};

let backend: Record<string, ReturnType<typeof vi.fn>>;

function install(resources: StackState['resources'], segments: Record<string, unknown>[]): void {
  const record: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: structuredClone(resources),
    outputs: {},
    lastModified: 1,
  };
  backend = {
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: STACK,
      region: REGION,
      segments: structuredClone(segments),
    }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: backend,
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

const opts = (revertFailed?: boolean) =>
  ({
    yes: true,
    stateBucket: 'b',
    region: REGION,
    ...(revertFailed && { revertFailed: true }),
  }) as unknown as Parameters<typeof rollbackCommand>[1];

const infoLines = (): string[] =>
  (logger['info'] as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

describe('cdkd rollback leaves a resource cdkd import adopted after the deploy alone (go-to-k/cdkd#4523)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.delete.mockResolvedValue(undefined);
    provider.update.mockResolvedValue({ physicalId: NAME, wasReplaced: false });
  });

  it('a completed CREATE of an imported id is not replayed as a delete', async () => {
    install({ Topic: topicRecord('imported') }, [
      { operations: [createOp], importedLogicalIds: ['Topic'] },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.delete).not.toHaveBeenCalled();
    // Nothing replayed, so the imported record is never rewritten or removed.
    expect(backend['saveState']).not.toHaveBeenCalled();
    expect(backend['deleteState']).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('Topic') && l.includes('adopted by cdkd import'))).toBe(
      true
    );
    // The segment is still consumed: nothing in it is left to replay.
    expect(backend['popRollbackJournalSegment']).toHaveBeenCalledTimes(1);
  });

  it('control: the same segment WITHOUT the mark deletes the resource (the pre-fix replay)', async () => {
    install({ Topic: topicRecord('imported') }, [{ operations: [createOp] }]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe(NAME);
  });

  it('a later, unmarked segment of the same id is still reverted; only the marked one is left alone', async () => {
    // Older segment: the pre-import CREATE, marked. Newer segment: a deploy
    // AFTER the import changed the topic in place, then failed. Its revert
    // must run; the older CREATE must not delete what is left.
    install({ Topic: topicRecord('changed-after-import') }, [
      { operations: [createOp], importedLogicalIds: ['Topic'] },
      {
        operations: [
          {
            logicalId: 'Topic',
            changeType: 'UPDATE',
            resourceType: TOPIC,
            physicalId: NAME,
            properties: topicRecord('changed-after-import').properties,
            previousResourceType: TOPIC,
            previousState: topicRecord('imported'),
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
    // The revert restores the IMPORTED properties.
    expect(provider.update.mock.calls[0]![3]).toEqual(topicRecord('imported').properties);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(backend['popRollbackJournalSegment']).toHaveBeenCalledTimes(2);
  });

  it('--revert-failed: a failed CREATE of an imported id is not deleted, and stays in the journal', async () => {
    const failedCreate = {
      logicalId: 'Topic',
      changeType: 'CREATE',
      resourceType: TOPIC,
      physicalId: NAME,
      attemptedProperties: topicRecord('deployed').properties,
      provisionedBy: 'sdk',
    };
    install({ Topic: topicRecord('imported') }, [
      { operations: [], failedOperations: [failedCreate], importedLogicalIds: ['Topic'] },
    ]);

    const thrown = await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(backend['setRollbackJournalFailedOperations']).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('adopted by cdkd import'))).toBe(true);
  });

  it('control: --revert-failed deletes the same failed CREATE without the mark', async () => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [],
        failedOperations: [
          {
            logicalId: 'Topic',
            changeType: 'CREATE',
            resourceType: TOPIC,
            physicalId: NAME,
            attemptedProperties: topicRecord('deployed').properties,
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.delete).toHaveBeenCalledTimes(1);
  });
});
