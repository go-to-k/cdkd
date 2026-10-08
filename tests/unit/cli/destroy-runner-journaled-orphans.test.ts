import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#4584: `deleteState` sweeps the rollback journal, the only
// record of a resource a failed CREATE made before it failed. `cdkd destroy`
// deletes such a resource (per its journaled DeletionPolicy) before the
// sweep, first in the run, and a stack holding one never takes the
// unconfirmed empty-stack fast path.

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

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

const readlineQuestion = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: readlineQuestion, close: vi.fn() }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';
const IDENTITY_TYPES = new Set([
  'AWS::Kinesis::Stream',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::DocDB::DBCluster',
  'AWS::DocDB::DBInstance',
]);

const orphanOp = {
  logicalId: 'O',
  changeType: 'CREATE',
  resourceType: 'AWS::Kinesis::Stream',
  physicalId: 'orphan-stream',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  // go-to-k/cdkd#4658: the token its CREATE journaled, which the live read
  // below matches, so the destroy may delete it.
  createdResourceIdentity: 'created-token',
  attemptedProperties: {},
};

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-r',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies: [],
    ...extra,
  };
}

function makeState(
  resources: Record<string, ResourceState>,
  orphans?: StackState['orphans']
): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    ...(orphans && { orphans }),
    lastModified: 1,
  };
}

function journalOf(failedOperations: unknown[]) {
  return {
    journalVersion: 1,
    stackName: 'TestStack',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        skipPrefix: false,
        operations: [],
        failedOperations,
      },
    ],
  };
}

describe('runDestroyForStack: proven failed-CREATE orphans in the journal (go-to-k/cdkd#4584)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const mockLoadJournal = vi.fn();
  const mockDropFailed = vi.fn();
  const mockResourceIdentity = vi.fn();
  const mockListStacks = vi.fn();
  const mockGetState = vi.fn();

  function makeCtx() {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        getState: mockGetState,
        loadRollbackJournal: mockLoadJournal,
        dropRollbackJournalFailedOperations: mockDropFailed,
        listStacks: mockListStacks,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        // Real-shaped: only the types whose provider implements it read a
        // creation identity (go-to-k/cdkd#4658).
        getProviderFor: ({ resourceType }: { resourceType: string }) => ({
          provider: IDENTITY_TYPES.has(resourceType)
            ? { delete: mockProviderDelete, resourceIdentity: mockResourceIdentity }
            : { delete: mockProviderDelete },
          provisionedBy: 'sdk',
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };
  }

  const deleted = (): unknown[] => mockProviderDelete.mock.calls.map((c) => c[1]);
  const info = (): string => infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const warn = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset().mockResolvedValue(undefined);
    mockLoadJournal.mockReset().mockResolvedValue(null);
    mockDropFailed.mockReset().mockResolvedValue(0);
    mockResourceIdentity.mockReset().mockResolvedValue('created-token');
    mockListStacks.mockReset().mockResolvedValue([]);
    mockGetState.mockReset().mockResolvedValue(null);
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  it("deletes it BEFORE the stack's own resources, lists it, then deletes the state", async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['orphan-stream', 'phys-r']);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledOnce();
    // Control: nothing left in AWS, so the ✓ line, with no skip.
    // eslint-disable-next-line no-control-regex
    expect(info()).toMatch(/Stack TestStack destroyed(\x1b\[[0-9;]*m)? \(/);
    expect(info()).not.toContain('resources left in AWS');
    expect(info()).toContain('recorded only in the rollback journal');
    expect(info()).toMatch(/- O \(AWS::Kinesis::Stream\) {2}orphan-stream/);
  });

  // The fast path deletes state.json with no confirmation and no delete loop.
  it('takes the main path, not the empty-stack fast path, for a resource-less record', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    const result = await runDestroyForStack('TestStack', makeState({}), makeCtx());
    expect(result.skippedEmpty).toBe(false);
    expect(deleted()).toEqual(['orphan-stream']);
    expect(mockDeleteState).toHaveBeenCalledOnce();
  });

  it('still takes the fast path when the journal holds no proven orphan', async () => {
    mockLoadJournal.mockResolvedValue(
      journalOf([{ logicalId: 'X', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue' }])
    );
    const result = await runDestroyForStack('TestStack', makeState({}), makeCtx());
    expect(result.skippedEmpty).toBe(true);
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });

  it('preserves the state (and so the journal) when the delete fails', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'O' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
    );
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('prints no account sentence when no drop line is printed (go-to-k/cdkd#4648 review)', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'O' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
    );
    await runDestroyForStack('TestStack', makeState({ R: res() }), {
      ...makeCtx(),
      profile: 'my profile',
    });
    // The journaled failure withholds the drop, so no command line carries the
    // hole and no sentence may point at one.
    expect(warn()).not.toMatch(/^Drop the record with:/m);
    expect(warn()).not.toContain("value this run was given");
  });

  it('keeps it in AWS under a journaled Retain, and still destroys the stack', async () => {
    mockLoadJournal.mockResolvedValue(
      journalOf([{ ...structuredClone(orphanOp), deletionPolicy: 'Retain' }])
    );
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledOnce();
    // It was acted on, not missed: listed, then kept by the policy.
    expect(info()).toMatch(/- O \(AWS::Kinesis::Stream\) {2}orphan-stream/);
    expect(info()).toMatch(/leaving partially-created O \(AWS::Kinesis::Stream\) in AWS \(DeletionPolicy: Retain\)/);
  });

  // A rollback-orphan record holding its id may own the resource now.
  it('warns about and keeps one a rollback-orphan record supersedes', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    const result = await runDestroyForStack(
      'TestStack',
      makeState({ R: res() }, [
        {
          logicalId: 'Renamed',
          orphanedAt: 2,
          state: res({ physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' }),
        },
      ]),
      makeCtx()
    );
    expect(deleted()).toEqual(['phys-r']);
    expect(result.errorCount).toBe(0);
    // Left in AWS unaddressed: counted, so the destroy exits 2 (go-to-k/cdkd#4658).
    expect(result.skippedCount).toBe(1);
    expect(warn()).toContain('a later deploy or rollback may own a resource under that id now');
  });

  // go-to-k/cdkd#4658: the user deleted the orphan by hand and recreated a
  // stream under its name; the destroy keeps it, as a warned skip.
  it('keeps one whose live identity is not the journaled one, and counts it as a skip (exit 2)', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockResourceIdentity.mockResolvedValue('recreated-token');
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(mockResourceIdentity).toHaveBeenCalledWith('orphan-stream', 'AWS::Kinesis::Stream', {
      expectedRegion: REGION,
    });
    expect(deleted()).toEqual(['phys-r']);
    expect(result.errorCount).toBe(0);
    // Unaddressed: the destroy must not report success over it (exit 2), but
    // no state row held it, so the state goes.
    expect(result.skippedCount).toBe(1);
    expect(mockDeleteState).toHaveBeenCalledOnce();
    expect(warn()).toContain('1 resource(s) a failed deploy created were left in AWS');
    expect(warn()).toContain('Skipping failed CREATE of O');
    expect(warn()).toContain('orphan-stream');
    expect(warn()).toContain('its name was reused');
  });

  // go-to-k/cdkd#4658: an SQS queue's provider records no creation identity,
  // so nothing proves the queue under the name is the one the deploy made.
  it('keeps a name-keyed orphan whose type records no identity, and counts it as a skip', async () => {
    mockLoadJournal.mockResolvedValue(
      journalOf([
        {
          logicalId: 'Q',
          changeType: 'CREATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/orders',
          provisionedBy: 'sdk',
          physicalIdRecoveredFromError: true,
          attemptedProperties: { QueueName: 'orders' },
        },
      ])
    );
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(mockResourceIdentity).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(mockDeleteState).toHaveBeenCalledOnce();
    // The run exits 2: its summary is the ⚠ line with the skip, never ✓.
    expect(info()).toMatch(/⚠.*Stack TestStack destroyed, with resources left in AWS.*skipped/);
    // eslint-disable-next-line no-control-regex
    expect(info()).not.toMatch(/Stack TestStack destroyed(\x1b\[[0-9;]*m)? \(/);
    expect(warn()).toContain('Skipping failed CREATE of Q');
    expect(warn()).toContain('https://sqs.us-east-1.amazonaws.com/123456789012/orders');
    expect(warn()).toContain('if it is not in use, delete it by hand');
  });

  // Token journaled, live read unanswered: kept in the journal for a re-run.
  it('keeps the state and the journal when the live identity read gives no answer', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockResourceIdentity.mockResolvedValue(undefined);
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).not.toContain('orphan-stream');
    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(warn()).toContain('removes only that record and leaves the resource in AWS');
    expect(warn()).toContain('--drop-failed O');
  });

  // go-to-k/cdkd#4696: a later `cdkd import` adopted it into stack B.
  it("keeps one another stack's record holds, and counts it as a skip", async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockListStacks.mockResolvedValue([
      { stackName: 'TestStack', region: REGION },
      { stackName: 'B', region: REGION },
    ]);
    mockGetState.mockImplementation(async (name: string) =>
      name === 'B'
        ? {
            state: {
              ...makeState({
                Imported: res({ physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' }),
              }),
              stackName: 'B',
            },
          }
        : null
    );
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(mockResourceIdentity).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(warn()).toContain('the state record of stack B (us-east-1) holds a resource');
    expect(warn()).toContain('orphan-stream');
    // Another stack owns it now: never "delete it by hand".
    expect(warn()).toContain('it now belongs to that stack');
    expect(warn()).not.toContain('delete it by hand');
    expect(mockDeleteState).toHaveBeenCalledOnce();
  });

  // A record the scan cannot read is no verdict: the orphan's entry, and so
  // the state and its journal, are kept for a re-run.
  it('keeps the state and the journal when the holder scan cannot read a record', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockListStacks.mockResolvedValue([
      { stackName: 'TestStack', region: REGION },
      { stackName: 'B', region: REGION },
    ]);
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'B') throw new Error('AccessDenied');
      return null;
    });
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).not.toContain('orphan-stream');
    expect(mockResourceIdentity).not.toHaveBeenCalled();
    expect(result.errorCount).toBeGreaterThan(0);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(warn()).toContain('leaves open whether another stack holds it');
    expect(warn()).toContain('--drop-failed O');
  });

  // State tracks that very resource under its logical id: the destroy's own
  // delete owns it, never a second one from the journal.
  it('leaves one state tracks to the delete loop', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    await runDestroyForStack(
      'TestStack',
      makeState({ O: res({ physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' }) }),
      makeCtx()
    );
    expect(deleted()).toEqual(['orphan-stream']);
  });

  it('leaves alone an op of a logical id `cdkd import` adopted', async () => {
    const journal = journalOf([structuredClone(orphanOp)]);
    (journal.segments[0] as Record<string, unknown>)['importedResources'] = [
      { logicalId: 'O', physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' },
    ];
    mockLoadJournal.mockResolvedValue(journal);
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(info()).not.toContain('recorded only in the rollback journal');
    expect(info()).not.toMatch(/- O \(AWS::Kinesis::Stream\)/);
  });

  // A record whose body region diverged from its key's: the delete would go to
  // the key's region, read not-found as done, and sweep the only record.
  it('refuses a resource-less divergent record whose journal holds one, before any delete', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    const thrown = await runDestroyForStack('TestStack', makeState({}), {
      ...makeCtx(),
      divergentBodyRegion: 'eu-west-1',
    }).catch((e: unknown) => e);
    expect((thrown as { code?: string }).code).toBe('STATE_REGION_DIVERGED');
    expect((thrown as Error).message).toContain(
      'its rollback journal holds 1 failed create whose resource the destroy would delete'
    );
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('still lets a resource-less divergent record with no journaled orphan through', async () => {
    const result = await runDestroyForStack('TestStack', makeState({}), {
      ...makeCtx(),
      divergentBodyRegion: 'eu-west-1',
    });
    expect(result.skippedEmpty).toBe(true);
  });

  // The fast path re-reads under the lock; a failed deploy landing in that
  // window journals an orphan the state sweep would drop.
  it('refuses the fast path when the journal gained one under the lock', async () => {
    mockLoadJournal
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(journalOf([structuredClone(orphanOp)]));
    const ctx = makeCtx();
    (ctx.stateBackend as unknown as { getState: ReturnType<typeof vi.fn> }).getState.mockResolvedValue({
      state: makeState({}),
      etag: 'e',
    });
    await expect(runDestroyForStack('TestStack', makeState({}), ctx)).rejects.toThrow(
      /its rollback journal now records 1 resource\(s\) a failed deploy created/
    );
    expect(mockLoadJournal).toHaveBeenCalledTimes(2);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  // `cdkd rollback` runs the supersede pass over every segment; a newer
  // nested pending-parent segment's completed CREATE of the type may own it.
  it('lets a newer nested pending-parent segment supersede it', async () => {
    const journal = journalOf([structuredClone(orphanOp)]);
    journal.segments.push({
      timestamp: 2,
      reason: 'nested-pending-parent',
      initialDeploy: false,
      skipPrefix: false,
      operations: [
        { logicalId: 'O', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'orphan-stream' },
      ] as never,
      failedOperations: [],
    });
    mockLoadJournal.mockResolvedValue(journal);
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(warn()).toContain('a later deploy or rollback may own a resource under that id now');
  });

  // A Ctrl-C during the journaled deletes stops before the next one, and the
  // state (with the journal) is kept for the re-run.
  it('stops at a first Ctrl-C between journaled deletes', async () => {
    const handlers: Array<() => void> = [];
    const realOn = process.on.bind(process);
    const realRemove = process.removeListener.bind(process);
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, h: () => void) =>
      event === 'SIGINT' ? (handlers.push(h), process) : realOn(event as never, h as never)) as never);
    const rmSpy = vi.spyOn(process, 'removeListener').mockImplementation(((event: string, h: () => void) =>
      event === 'SIGINT' ? process : realRemove(event as never, h as never)) as never);
    try {
      mockLoadJournal.mockResolvedValue(
        journalOf([
          { ...structuredClone(orphanOp), logicalId: 'P', physicalId: 'second-stream' },
          structuredClone(orphanOp),
        ])
      );
      mockProviderDelete.mockImplementation(async () => {
        handlers.forEach((h) => h());
      });
      const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
      // Replayed newest-first: the second op is never reached.
      expect(deleted()).toEqual(['orphan-stream']);
      expect(result.interrupted).toBe(true);
      expect(mockDeleteState).not.toHaveBeenCalled();
    } finally {
      onSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it('warns once over an unreadable journal on the fast path, and still when only the re-read fails', async () => {
    mockLoadJournal.mockRejectedValue(new Error('malformed journal'));
    await runDestroyForStack('TestStack', makeState({}), makeCtx());
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("Could not read the stack's rollback journal"))).toHaveLength(1);
    warnSpy.mockReset();
    mockLoadJournal.mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('torn journal'));
    await runDestroyForStack('TestStack', makeState({}), makeCtx());
    expect(warn()).toContain("Could not read the stack's rollback journal (torn journal)");
  });

  // DeletionPolicy: Snapshot on an SDK route the delete call snapshots
  // atomically: the identifier reaches the provider unless the opt-out is set.
  it.each([
    [false, 'final snapshot requested'],
    [true, '--skip-final-snapshot honoured'],
  ] as const)('deletes a journaled Snapshot orphan (skipFinalSnapshot=%s: %s)', async (skip, _label) => {
    mockLoadJournal.mockResolvedValue(
      journalOf([
        {
          ...structuredClone(orphanOp),
          resourceType: 'AWS::RDS::DBInstance',
          physicalId: 'orphan-db',
          deletionPolicy: 'Snapshot',
        },
      ])
    );
    const result = await runDestroyForStack('TestStack', makeState({}), {
      ...makeCtx(),
      ...(skip && { skipFinalSnapshot: true }),
    });
    expect(result.errorCount).toBe(0);
    const call = mockProviderDelete.mock.calls.find((c) => c[1] === 'orphan-db')!;
    const deleteCtx = call[4] as { finalSnapshotIdentifier?: string; skipFinalSnapshot?: boolean };
    if (skip) {
      expect(deleteCtx.finalSnapshotIdentifier).toBeUndefined();
      expect(deleteCtx.skipFinalSnapshot).toBe(true);
    } else {
      expect(deleteCtx.finalSnapshotIdentifier).toMatch(/orphan-db/);
      expect(deleteCtx.skipFinalSnapshot).toBeUndefined();
    }
  });

  // A pre-delete-snapshot type snapshots through the destroy's own clients.
  it("takes a pre-delete snapshot through the destroy's clients before deleting", async () => {
    const ec2Send = vi.fn().mockRejectedValue(new Error('SentinelCreateSnapshot'));
    mockLoadJournal.mockResolvedValue(
      journalOf([
        {
          ...structuredClone(orphanOp),
          resourceType: 'AWS::EC2::Volume',
          physicalId: 'vol-0abc',
          deletionPolicy: 'Snapshot',
        },
      ])
    );
    // A synthetic proven orphan: EC2's provider journals none today, so the
    // fixture gives it an identity to reach the snapshot arm past the
    // go-to-k/cdkd#4658 check.
    const result = await runDestroyForStack('TestStack', makeState({}), {
      ...makeCtx(),
      providerRegistry: {
        getProviderFor: () => ({
          provider: { delete: mockProviderDelete, resourceIdentity: mockResourceIdentity },
          provisionedBy: 'sdk',
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: { ec2: { send: ec2Send } } as unknown as AwsClients,
    });
    expect(ec2Send).toHaveBeenCalled();
    // The snapshot failed, so nothing was deleted and the record stays.
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  // Mirrors `cdkd rollback`'s per-op strip, so a re-run after a later failure
  // does not re-send the delete.
  it('strips the settled entry from the journal, matching it by segment and op', async () => {
    const journal = journalOf([
      structuredClone(orphanOp),
      { logicalId: 'X', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', physicalId: 'q' },
    ]);
    mockLoadJournal.mockResolvedValue(journal);
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'R' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
    );
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(mockDropFailed).toHaveBeenCalledOnce();
    const drop = mockDropFailed.mock.calls[0]![2] as (op: unknown, seg: unknown) => boolean;
    const fresh = structuredClone(journal.segments[0]!);
    expect(drop(fresh.failedOperations[0], fresh)).toBe(true);
    expect(drop(fresh.failedOperations[1], fresh)).toBe(false);
    expect(drop(fresh.failedOperations[0], { ...fresh, timestamp: 99 })).toBe(false);
  });

  // go-to-k/cdkd#4604: a destroy that fails after settling a replacement
  // orphan strips its failed UPDATE with it, so a later `--revert-failed`
  // never force-reverts the resource the replacement never wrote to.
  it("strips a replacement orphan's failed UPDATE with it, never updating the old resource", async () => {
    const update = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'phys-r',
      previousState: res(),
      attemptedProperties: { Name: 'new' },
    };
    // An SSM parameter journals no creation identity (go-to-k/cdkd#4658):
    // the orphan is kept, a warned skip, and still settled with its UPDATE.
    const { createdResourceIdentity: _noToken, ...noToken } = structuredClone(orphanOp);
    const orphan = {
      ...noToken,
      logicalId: 'R',
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'phys-new',
      replacedPhysicalId: 'phys-r',
      replacedResourceType: 'AWS::SSM::Parameter',
    };
    const journal = journalOf([update, orphan]);
    mockLoadJournal.mockResolvedValue(journal);
    // The stack's own delete of R fails: the destroy keeps the state.
    mockProviderDelete.mockImplementation((_l: string, physicalId: string) =>
      physicalId === 'phys-r' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
    );
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(mockDropFailed).toHaveBeenCalledOnce();
    const drop = mockDropFailed.mock.calls[0]![2] as (op: unknown, seg: unknown) => boolean;
    const fresh = structuredClone(journal.segments[0]!);
    expect(drop(fresh.failedOperations[0], fresh)).toBe(true);
    expect(drop(fresh.failedOperations[1], fresh)).toBe(true);
  });

  // go-to-k/cdkd#4604: a delete-first replacement's UPDATE is warned about in
  // the destroy's own terms, never a later deploy's.
  it('warns about a delete-first replacement in the destroy\'s terms', async () => {
    const update = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'phys-r',
      previousState: res(),
      replacementOrphaned: 'delete-first',
    };
    // An SSM parameter journals no identity: the orphan is kept (go-to-k/cdkd#4658).
    const { createdResourceIdentity: _noToken, ...noToken } = structuredClone(orphanOp);
    const orphan = {
      ...noToken,
      logicalId: 'R',
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'phys-new',
      replacedPhysicalId: 'phys-r',
      replacedResourceType: 'AWS::SSM::Parameter',
      replacedResourceDeleted: true,
    };
    mockLoadJournal.mockResolvedValue(journalOf([update, orphan]));
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    // The kept orphan counts; its companion UPDATE's skip (nothing to revert)
    // is not one more resource left in AWS.
    expect(result.skippedCount).toBe(1);
    expect(warn()).toContain('the destroy drops its record');
    expect(warn()).not.toContain('a deploy whose template still replaces it');
  });

  // A failed journaled delete: never the `cdkd state orphan` hint, which would
  // delete the journal, the resource's only record.
  it('reports a failed journaled delete apart, without the state-orphan hint', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'O' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
    );
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(result.errorCount).toBe(1);
    expect(warn()).toContain('1 of them recorded only in the rollback journal');
    expect(warn()).toContain("Do not drop this stack's state record");
    expect(warn()).not.toContain("'cdkd rollback'");
    expect(warn()).not.toContain('cdkd state orphan');
    expect(mockDropFailed).not.toHaveBeenCalled();
  });

  it('keeps the state-orphan hint for an ordinary failure', async () => {
    mockProviderDelete.mockRejectedValue(new Error('AccessDenied'));
    await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(warn()).toContain('cdkd state orphan');
  });

  // The main path re-reads under the lock, as the fast path does.
  it('refuses when the journal changed between the prompt and the lock, deleting nothing', async () => {
    mockLoadJournal
      .mockResolvedValueOnce(journalOf([structuredClone(orphanOp)]))
      .mockResolvedValueOnce(
        journalOf([
          structuredClone(orphanOp),
          { ...structuredClone(orphanOp), logicalId: 'P', physicalId: 'second-stream' },
        ])
      );
    await expect(
      runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx())
    ).rejects.toThrow(/recorded 1 resource\(s\) a failed deploy created when this run started and 2 now/);
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  // A demoted entry is warned about, never deleted, so it reaches no AWS
  // delete and does not trip the divergent-region refusal.
  it('lets a divergent record through when its only journaled entry is superseded', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    const result = await runDestroyForStack(
      'TestStack',
      makeState({}, [
        {
          logicalId: 'Renamed',
          orphanedAt: 2,
          state: res({ physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' }),
        },
      ]),
      { ...makeCtx(), divergentBodyRegion: 'eu-west-1' }
    );
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
  });

  // Newest segment first, as `cdkd rollback` replays them; each in its own
  // segment's prefix scope.
  it('replays segments newest first, skipping a pending-parent segment with failed ops', async () => {
    const journal = journalOf([{ ...structuredClone(orphanOp), logicalId: 'Old', physicalId: 'old-stream' }]);
    journal.segments.push(
      {
        timestamp: 2,
        reason: 'nested-pending-parent',
        initialDeploy: false,
        skipPrefix: false,
        operations: [],
        failedOperations: [{ ...structuredClone(orphanOp), logicalId: 'Pend', physicalId: 'pend-stream' }],
      },
      {
        timestamp: 3,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        skipPrefix: true,
        operations: [],
        failedOperations: [{ ...structuredClone(orphanOp), logicalId: 'New', physicalId: 'new-stream' }],
      }
    );
    mockLoadJournal.mockResolvedValue(journal);
    const { getCurrentSkipPrefix } = await import('../../../src/provisioning/resource-name.js');
    const scopes: boolean[] = [];
    mockProviderDelete.mockImplementation(async () => {
      scopes.push(getCurrentSkipPrefix());
    });
    await runDestroyForStack('TestStack', makeState({}), makeCtx());
    expect(deleted()).toEqual(['new-stream', 'old-stream']);
    expect(scopes).toEqual([true, false]);
  });

  // The y/N question counts what is deleted: a stack holding only journaled
  // resources must not read "delete all 0 resources".
  it('counts the journaled resources in the confirmation prompt', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    readlineQuestion.mockReset().mockResolvedValue('y');
    try {
      mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
      await runDestroyForStack('TestStack', makeState({}), { ...makeCtx(), skipConfirmation: false });
      expect(String(readlineQuestion.mock.calls[0]![0])).toContain(
        'delete all 0 resources and 1 recorded only in its rollback journal?'
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  // A journaled failure and an ordinary skip together: the skip's remedy must
  // not offer to drop THIS stack's record, which deletes the journal.
  it('offers no state-orphan command for the stack when a journaled delete failed beside a skip', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'O'
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({ outcome: 'skipped', reason: 'bad id' })
    );
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(result.errorCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(warn()).toContain('cdkd state show');
    expect(warn()).not.toContain('cdkd state orphan');
    expect(warn()).not.toContain("'cdkd rollback'");
  });

  it('refuses a same-size journal that now records different resources', async () => {
    mockLoadJournal
      .mockResolvedValueOnce(journalOf([structuredClone(orphanOp)]))
      .mockResolvedValueOnce(journalOf([{ ...structuredClone(orphanOp), physicalId: 'other-stream' }]));
    await expect(runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx())).rejects.toThrow(
      /recorded 1 resource\(s\) a failed deploy created when this run started and 1 now, not the same ones/
    );
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('says so when the journal turned unreadable under the lock', async () => {
    mockLoadJournal
      .mockResolvedValueOnce(journalOf([structuredClone(orphanOp)]))
      .mockRejectedValueOnce(new Error('torn journal'));
    await expect(runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx())).rejects.toThrow(
      /was readable when this run started and cannot be read now/
    );
    expect(mockProviderDelete).not.toHaveBeenCalled();
  });

  it('warns and carries on when the strip fails', async () => {
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    mockDropFailed.mockRejectedValue(new Error('SlowDown'));
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(warn()).toContain('Failed to strip the deleted journal entries');
    expect(deleted()).toEqual(['orphan-stream', 'phys-r']);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledOnce();
  });

  // A destroy run frames its own events; the journaled deletes add their
  // per-resource rollback events but no ROLLBACK_STARTED / ROLLBACK_FINISHED.
  it('records no rollback envelope in a destroy run', async () => {
    const events: Array<{ eventType: string }> = [];
    mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
    await runDestroyForStack('TestStack', makeState({}), {
      ...makeCtx(),
      eventRecorder: { record: (e: { eventType: string }) => events.push(e), finalize: vi.fn() } as never,
    });
    expect(mockProviderDelete).toHaveBeenCalled();
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.eventType === 'ROLLBACK_STARTED' || e.eventType === 'ROLLBACK_FINISHED')).toEqual([]);
  });

  it('counts the journaled resources in the --remove-protection prompt too', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    readlineQuestion.mockReset().mockResolvedValue('y');
    try {
      mockLoadJournal.mockResolvedValue(journalOf([structuredClone(orphanOp)]));
      await runDestroyForStack('TestStack', makeState({}), {
        ...makeCtx(),
        skipConfirmation: false,
        removeProtection: true,
      });
      expect(String(readlineQuestion.mock.calls[0]![0])).toContain(
        'About to destroy 0 resources and 1 recorded only in its rollback journal from stack'
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('warns and proceeds as before over a journal it cannot read', async () => {
    mockLoadJournal.mockRejectedValue(new Error('malformed journal'));
    const result = await runDestroyForStack('TestStack', makeState({ R: res() }), makeCtx());
    expect(deleted()).toEqual(['phys-r']);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledOnce();
    expect(warn()).toContain("Could not read the stack's rollback journal (malformed journal)");
  });
});
